use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::iter::Peekable;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use tempfile::TempDir;

use crate::model::Node;

mod cache;
pub(crate) use cache::load_schematic_cached;

#[cfg(test)]
mod tests;

const TABLES: [&str; 6] = [
    "schematic_metadata",
    "schematic_scopes",
    "schematic_nodes",
    "schematic_ports",
    "schematic_nets",
    "schematic_endpoints",
];

#[derive(Debug)]
enum SchematicDirectory {
    Temporary(TempDir),
    Persistent(PathBuf),
}

impl SchematicDirectory {
    fn path(&self) -> &Path {
        match self {
            Self::Temporary(directory) => directory.path(),
            Self::Persistent(path) => path,
        }
    }
}

/// Graphs are serialized while the input DB is alive. Only one scope's rows are
/// retained in memory, and completed scope files may be reused by later bundle
/// generations when the SQLite input remains unchanged.
#[derive(Debug)]
pub(crate) struct SchematicInput {
    directory: SchematicDirectory,
    scopes: HashMap<String, usize>,
}

#[derive(Debug)]
pub(crate) struct SchematicData {
    directory: SchematicDirectory,
    paths: Vec<String>,
    scope_files: Vec<Option<usize>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Graph {
    version: u32,
    scope_path: String,
    nodes: Vec<GraphNode>,
    nets: Vec<Net>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphNode {
    id: String,
    kind: String,
    label: String,
    instance_path: Option<String>,
    detail: String,
    ports: Vec<Port>,
}

#[derive(Serialize)]
struct Port {
    id: String,
    name: String,
    direction: String,
    width: u64,
    ordinal: u64,
}

#[derive(Serialize)]
struct Net {
    id: String,
    name: String,
    width: u64,
    status: String,
    endpoints: Vec<Endpoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    node_id: String,
    port_id: String,
    role: String,
}

fn corrupt(error: impl std::fmt::Display) -> String {
    format!("schematic data CORRUPTION: {error}")
}

pub(crate) fn load_schematic(connection: &Connection) -> Result<Option<SchematicInput>, String> {
    load_schematic_in(connection, None)
}

fn load_schematic_in(
    connection: &Connection,
    staging: Option<TempDir>,
) -> Result<Option<SchematicInput>, String> {
    let present = TABLES
        .iter()
        .map(|table| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get::<_, bool>(0),
            )
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(corrupt)?;
    if present.iter().all(|exists| !exists) {
        return Ok(None);
    }
    if let Some(index) = present.iter().position(|exists| !exists) {
        return Err(corrupt(format!("missing table {}", TABLES[index])));
    }

    let started = Instant::now();
    crate::logging::info("schematic", "Validating schema and metadata...");
    validate_schema(connection)?;
    validate_metadata(connection)?;
    let instance_paths = connection
        .prepare("SELECT path FROM instances")
        .map_err(corrupt)?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(corrupt)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(corrupt)?;
    crate::logging::info(
        "schematic",
        format!(
            "Schema and metadata validated; loaded {} instance paths in {:.2}s. Scanning scopes...",
            instance_paths.len(),
            started.elapsed().as_secs_f64()
        ),
    );
    // Databases without scope indexes may spill their one-time sorts to disk.
    connection
        .execute_batch("PRAGMA temp_store = FILE")
        .map_err(corrupt)?;
    let directory = match staging {
        Some(directory) => directory,
        None => tempfile::tempdir()
            .map_err(|err| format!("failed to create schematic staging directory: {err}"))?,
    };
    let mut scopes = HashMap::new();

    // Each table is scanned once in scope order. In particular endpoints have
    // no required index, so querying them separately for every scope is costly.
    let mut scopes_stmt = connection
        .prepare("SELECT path FROM schematic_scopes ORDER BY path")
        .map_err(corrupt)?;
    let scope_rows = scopes_stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(corrupt)?;
    let mut nodes_stmt = connection
        .prepare("SELECT scope_path, id, kind, label, instance_path, detail FROM schematic_nodes ORDER BY scope_path, id")
        .map_err(corrupt)?;
    let mut nodes = nodes_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                GraphNode {
                    id: row.get(1)?,
                    kind: row.get(2)?,
                    label: row.get(3)?,
                    instance_path: row.get(4)?,
                    detail: row.get(5)?,
                    ports: Vec::new(),
                },
            ))
        })
        .map_err(corrupt)?
        .peekable();
    let mut ports_stmt = connection
        .prepare("SELECT scope_path, node_id, id, name, direction, width, ordinal FROM schematic_ports ORDER BY scope_path")
        .map_err(corrupt)?;
    let mut ports = ports_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, String>(1)?,
                    Port {
                        id: row.get(2)?,
                        name: row.get(3)?,
                        direction: row.get(4)?,
                        width: row.get(5)?,
                        ordinal: row.get(6)?,
                    },
                ),
            ))
        })
        .map_err(corrupt)?
        .peekable();
    let mut nets_stmt = connection
        .prepare("SELECT scope_path, id, name, width, status FROM schematic_nets ORDER BY scope_path, id")
        .map_err(corrupt)?;
    let mut nets = nets_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Net {
                    id: row.get(1)?,
                    name: row.get(2)?,
                    width: row.get(3)?,
                    status: row.get(4)?,
                    endpoints: Vec::new(),
                },
            ))
        })
        .map_err(corrupt)?
        .peekable();
    let mut endpoints_stmt = connection
        .prepare("SELECT scope_path, net_id, node_id, port_id, role FROM schematic_endpoints ORDER BY scope_path")
        .map_err(corrupt)?;
    let mut endpoints = endpoints_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, String>(1)?,
                    Endpoint {
                        node_id: row.get(2)?,
                        port_id: row.get(3)?,
                        role: row.get(4)?,
                    },
                ),
            ))
        })
        .map_err(corrupt)?
        .peekable();

    let mut last_progress = Instant::now();
    let mut staging_time = Duration::ZERO;
    for scope in scope_rows {
        let scope = scope.map_err(corrupt)?;
        if scope.is_empty() {
            return Err(corrupt("invalid value in schematic_scopes"));
        }
        let scope_started = Instant::now();
        let report_progress = scopes.len().is_multiple_of(256);
        if report_progress {
            crate::logging::info(
                "schematic",
                format!("Scanning scope {}: '{scope}'", scopes.len() + 1),
            );
        }
        let mut graph = Graph {
            version: 1,
            scope_path: scope.clone(),
            nodes: Vec::new(),
            nets: Vec::new(),
        };
        let mut node_ids = HashMap::new();
        consume_scope(&mut nodes, &scope, |node| {
            if node.id.is_empty()
                || !matches!(
                    node.kind.as_str(),
                    "module" | "boundary" | "expr" | "constant" | "unresolved"
                )
                || node.instance_path.as_ref().is_some_and(String::is_empty)
            {
                return Err(corrupt("invalid value in schematic_nodes"));
            }
            if node
                .instance_path
                .as_ref()
                .is_some_and(|path| !instance_paths.contains(path))
            {
                return Err(corrupt("node instance_path is absent from the hierarchy"));
            }
            node_ids.insert(node.id.clone(), graph.nodes.len());
            graph.nodes.push(node);
            Ok(())
        })?;
        consume_scope(&mut ports, &scope, |(node_id, port)| {
            if port.id.is_empty()
                || !matches!(
                    port.direction.as_str(),
                    "input" | "output" | "inout" | "ref" | "unknown"
                )
                || port.width > MAX_JS_INTEGER
                || port.ordinal > MAX_JS_INTEGER
            {
                return Err(corrupt("invalid value in schematic_ports"));
            }
            let Some(&index) = node_ids.get(&node_id) else {
                return Err(corrupt(format!(
                    "scope '{scope}': port '{}' references missing node '{node_id}'",
                    port.id
                )));
            };
            graph.nodes[index].ports.push(port);
            Ok(())
        })?;
        for node in &mut graph.nodes {
            node.ports.sort_unstable_by(|left, right| {
                left.ordinal
                    .cmp(&right.ordinal)
                    .then_with(|| left.id.cmp(&right.id))
            });
        }
        let port_ids: HashSet<_> = graph
            .nodes
            .iter()
            .enumerate()
            .flat_map(|(index, node)| node.ports.iter().map(move |port| (index, port.id.as_str())))
            .collect();
        let mut net_ids = HashMap::new();
        consume_scope(&mut nets, &scope, |net| {
            if net.id.is_empty()
                || net.width > MAX_JS_INTEGER
                || !matches!(
                    net.status.as_str(),
                    "resolved" | "multi-driver" | "bidirectional" | "unresolved"
                )
            {
                return Err(corrupt("invalid value in schematic_nets"));
            }
            net_ids.insert(net.id.clone(), graph.nets.len());
            graph.nets.push(net);
            Ok(())
        })?;
        consume_scope(&mut endpoints, &scope, |(net_id, endpoint)| {
            if !matches!(
                endpoint.role.as_str(),
                "driver" | "sink" | "bidirectional" | "unknown"
            ) {
                return Err(corrupt("invalid value in schematic_endpoints"));
            }
            let Some(&net_index) = net_ids.get(&net_id) else {
                return Err(corrupt(format!(
                    "scope '{scope}': endpoint references missing net '{net_id}'"
                )));
            };
            let has_port = node_ids
                .get(&endpoint.node_id)
                .is_some_and(|&index| port_ids.contains(&(index, endpoint.port_id.as_str())));
            if !has_port {
                return Err(corrupt(format!(
                    "scope '{scope}': endpoint references missing port '{}.{}'",
                    endpoint.node_id, endpoint.port_id
                )));
            }
            graph.nets[net_index].endpoints.push(endpoint);
            Ok(())
        })?;
        // The exporter index orders by scope only. Sort within each net so
        // duplicate checks and JSON ordering do not require a design-wide sort.
        for net in &mut graph.nets {
            net.endpoints.sort_unstable_by(|left, right| {
                (&left.node_id, &left.port_id, &left.role).cmp(&(
                    &right.node_id,
                    &right.port_id,
                    &right.role,
                ))
            });
            if net.endpoints.windows(2).any(|pair| {
                pair[0].node_id == pair[1].node_id
                    && pair[0].port_id == pair[1].port_id
                    && pair[0].role == pair[1].role
            }) {
                return Err(corrupt(format!(
                    "scope '{scope}': duplicate endpoint on net '{}'",
                    net.id
                )));
            }
        }
        let index = scopes.len();
        let report_progress = report_progress || last_progress.elapsed() >= Duration::from_secs(5);
        if report_progress {
            crate::logging::info(
                "schematic",
                format!(
                    "Scanned scope '{}': {} nodes, {} nets in {:.2}s; staging JSON...",
                    scope,
                    graph.nodes.len(),
                    graph.nets.len(),
                    scope_started.elapsed().as_secs_f64()
                ),
            );
        }
        let staging_started = Instant::now();
        write_graph(&directory.path().join(format!("{index}.json")), &graph)?;
        staging_time += staging_started.elapsed();
        scopes.insert(scope, index);
        if report_progress {
            crate::logging::info(
                "schematic",
                format!(
                    "Staged {} scopes in {:.2}s total; JSON staging {:.2}s",
                    scopes.len(),
                    started.elapsed().as_secs_f64(),
                    staging_time.as_secs_f64()
                ),
            );
            last_progress = Instant::now();
        }
    }
    reject_remaining_rows(&mut nodes)?;
    reject_remaining_rows(&mut ports)?;
    reject_remaining_rows(&mut nets)?;
    reject_remaining_rows(&mut endpoints)?;
    if instance_paths.iter().any(|path| !scopes.contains_key(path)) {
        return Err(corrupt("hierarchy instance is missing its schematic scope"));
    }
    crate::logging::info(
        "schematic",
        format!(
            "Finished scanning and staging {} scopes in {:.2}s; JSON staging {:.2}s",
            scopes.len(),
            started.elapsed().as_secs_f64(),
            staging_time.as_secs_f64()
        ),
    );
    Ok(Some(SchematicInput {
        directory: SchematicDirectory::Temporary(directory),
        scopes,
    }))
}

fn consume_scope<T>(
    rows: &mut Peekable<impl Iterator<Item = rusqlite::Result<(String, T)>>>,
    scope: &str,
    mut consume: impl FnMut(T) -> Result<(), String>,
) -> Result<(), String> {
    loop {
        match rows.peek() {
            Some(Ok((path, _))) if path == scope => {}
            Some(Ok((path, _))) if path.as_str() < scope => {
                return Err(corrupt(format!("unknown scope reference '{path}'")));
            }
            Some(Err(err)) => return Err(corrupt(err)),
            _ => return Ok(()),
        }
        let (_, value) = rows.next().expect("peeked row").map_err(corrupt)?;
        consume(value)?;
    }
}

fn reject_remaining_rows<T>(
    rows: &mut impl Iterator<Item = rusqlite::Result<(String, T)>>,
) -> Result<(), String> {
    if let Some(row) = rows.next() {
        let (path, _) = row.map_err(corrupt)?;
        return Err(corrupt(format!("unknown scope reference '{path}'")));
    }
    Ok(())
}

fn validate_schema(connection: &Connection) -> Result<(), String> {
    // Primary keys provide scope ordering and reject duplicate identities,
    // even when malformed tables are empty.
    type Column = (&'static str, &'static str, i64);
    let schemas: [(&str, &[Column]); 6] = [
        ("schematic_metadata", &[("version", "INTEGER", 0)]),
        ("schematic_scopes", &[("path", "TEXT", 1)]),
        (
            "schematic_nodes",
            &[
                ("scope_path", "TEXT", 1),
                ("id", "TEXT", 2),
                ("kind", "TEXT", 0),
                ("label", "TEXT", 0),
                ("instance_path", "TEXT", 0),
                ("detail", "TEXT", 0),
            ],
        ),
        (
            "schematic_ports",
            &[
                ("scope_path", "TEXT", 1),
                ("node_id", "TEXT", 2),
                ("id", "TEXT", 3),
                ("name", "TEXT", 0),
                ("direction", "TEXT", 0),
                ("width", "INTEGER", 0),
                ("ordinal", "INTEGER", 0),
            ],
        ),
        (
            "schematic_nets",
            &[
                ("scope_path", "TEXT", 1),
                ("id", "TEXT", 2),
                ("name", "TEXT", 0),
                ("width", "INTEGER", 0),
                ("status", "TEXT", 0),
            ],
        ),
        (
            "schematic_endpoints",
            &[
                ("scope_path", "TEXT", 0),
                ("net_id", "TEXT", 0),
                ("node_id", "TEXT", 0),
                ("port_id", "TEXT", 0),
                ("role", "TEXT", 0),
            ],
        ),
    ];
    for (table, columns) in schemas {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(corrupt)?;
        let actual = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    (row.get::<_, String>(2)?, row.get::<_, i64>(5)?),
                ))
            })
            .map_err(corrupt)?
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(corrupt)?;
        for &(name, sql_type, key_position) in columns {
            if !actual.get(name).is_some_and(|(actual_type, actual_key)| {
                actual_type.eq_ignore_ascii_case(sql_type) && *actual_key == key_position
            }) {
                return Err(corrupt(format!("invalid or missing column {table}.{name}")));
            }
        }
    }
    Ok(())
}

// Zero denotes a non-bitstream or unknown width in slang. Typed row reads
// reject negative or fractional integers; also reject inexact JavaScript values.
const MAX_JS_INTEGER: u64 = 9_007_199_254_740_991;

fn validate_metadata(connection: &Connection) -> Result<(), String> {
    let valid_version = connection.query_row(
        "SELECT COUNT(*) = 1 AND COALESCE(MIN(typeof(version) = 'integer' AND version = 1), 0) FROM schematic_metadata",
        [],
        |row| row.get::<_, bool>(0),
    ).map_err(corrupt)?;
    if !valid_version {
        return Err(corrupt(
            "schematic_metadata must contain exactly one row with version 1",
        ));
    }
    Ok(())
}

impl SchematicInput {
    pub(crate) fn bind(
        self,
        path_to_id: &HashMap<String, usize>,
        node_count: usize,
    ) -> Result<SchematicData, String> {
        let mut paths = vec![String::new(); node_count];
        for (path, &id) in path_to_id {
            paths[id].clone_from(path);
        }
        let SchematicInput { directory, scopes } = self;
        let mut scope_files = vec![None; node_count];
        for (path, index) in scopes {
            let Some(&id) = path_to_id.get(&path) else {
                return Err(corrupt(format!(
                    "scope '{path}' is absent from the hierarchy"
                )));
            };
            scope_files[id] = Some(index);
        }
        Ok(SchematicData {
            directory,
            paths,
            scope_files,
        })
    }
}

impl SchematicData {
    pub(crate) fn write_bundle(&self, output_dir: &Path, nodes: &[Node]) -> Result<(), String> {
        let directory = output_dir.join("schematic");
        fs::create_dir_all(&directory)
            .map_err(|err| format!("failed to create schematic directory: {err}"))?;
        for (id, node) in nodes.iter().enumerate() {
            let path = directory.join(format!("{id}.json"));
            if let Some(index) = self.scope_files[id] {
                let source = self.directory.path().join(format!("{index}.json"));
                fs::copy(&source, &path).map_err(|err| {
                    format!(
                        "failed to write schematic scope '{}': {err}",
                        path.display()
                    )
                })?;
                continue;
            }
            // Forest and generated hierarchy containers have no exported nets.
            // Show their known children without implying electrical connections.
            let graph = Graph {
                version: 1,
                scope_path: self.paths[id].clone(),
                nodes: node
                    .children
                    .iter()
                    .map(|&child_id| {
                        let child = &nodes[child_id];
                        GraphNode {
                            id: format!("hierarchy:{child_id}"),
                            kind: "module".to_string(),
                            label: child.name.clone(),
                            instance_path: Some(self.paths[child_id].clone()),
                            detail: child.module.clone(),
                            ports: Vec::new(),
                        }
                    })
                    .collect(),
                nets: Vec::new(),
            };
            write_graph(&path, &graph)?;
        }
        Ok(())
    }
}

fn write_graph(path: &Path, graph: &Graph) -> Result<(), String> {
    let file = File::create(path).map_err(|err| {
        format!(
            "failed to create schematic JSON '{}': {err}",
            path.display()
        )
    })?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, graph).map_err(|err| {
        format!(
            "failed to serialize schematic JSON '{}': {err}",
            path.display()
        )
    })?;
    writer
        .flush()
        .map_err(|err| format!("failed to flush schematic JSON '{}': {err}", path.display()))
}
