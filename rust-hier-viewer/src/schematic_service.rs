//! Local, on-demand schematic builds. The browser selects a viewer node ID;
//! compiler arguments and source paths come only from the saved bundle recipe.

use std::collections::HashSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::coverage_import::ServiceError;
use crate::launcher::{self, StartupSelection};
use crate::model::Node;

const RECIPE_PATH: &str = ".hier-viewer-cache/schematic-recipe.json";

#[cfg(test)]
mod tests;

#[derive(Serialize, Deserialize)]
struct Scope {
    path: String,
    name: String,
    module: String,
    children: Vec<usize>,
    electrical: bool,
}

#[derive(Serialize, Deserialize)]
struct RtlSource {
    selection: StartupSelection,
    cwd: PathBuf,
    fingerprint: String,
}

#[derive(Serialize, Deserialize)]
struct Recipe {
    version: u32,
    database: PathBuf,
    database_stamp: String,
    rtl: Option<RtlSource>,
    scopes: Vec<Scope>,
}

fn database_stamp(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|err| format!("cannot inspect source DB: {err}"))?;
    let modified = metadata
        .modified()
        .map_err(|err| err.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?;
    Ok(format!(
        "{}:{}:{}",
        metadata.len(),
        modified.as_secs(),
        modified.subsec_nanos()
    ))
}

fn open_database(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|err| {
        format!(
            "cannot open schematic source DB '{}': {err}",
            path.display()
        )
    })
}

/// Save enough context for `serve` to resume builds without retaining the
/// elaborator or large viewer structures. Static exports remove stale recipes.
pub(crate) fn prepare(
    output: &Path,
    database: &Path,
    selection: Option<&StartupSelection>,
    nodes: &[Node],
    prebuild: bool,
) -> Result<bool, String> {
    let path = output.join(RECIPE_PATH);
    if prebuild {
        remove_recipe(&path)?;
        return Ok(false);
    }
    let database = fs::canonicalize(database).map_err(|err| err.to_string())?;
    let connection = open_database(&database)?;
    let graph_tables: usize = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('schematic_metadata','schematic_scopes','schematic_nodes','schematic_ports','schematic_nets','schematic_endpoints')",
        [], |row| row.get(0),
    ).map_err(|err| err.to_string())?;
    if graph_tables != 0 && graph_tables != 6 {
        return Err("schematic data CORRUPTION: incomplete schematic schema".into());
    }
    if selection.is_none() && graph_tables == 0 {
        remove_recipe(&path)?;
        return Ok(false);
    }
    let electrical = connection
        .prepare("SELECT path FROM instances")
        .map_err(|err| err.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|err| err.to_string())?;
    let rtl = selection
        .map(|selection| {
            let cwd = std::env::current_dir().map_err(|err| err.to_string())?;
            Ok::<_, String>(RtlSource {
                fingerprint: launcher::schematic_export_fingerprint(selection, &cwd)?,
                selection: selection.clone(),
                cwd,
            })
        })
        .transpose()?;
    let mut scopes: Vec<Scope> = Vec::with_capacity(nodes.len());
    for node in nodes {
        let path = match node.parent {
            None => String::new(),
            Some(0) => node.name.clone(),
            Some(parent) => format!("{}.{}", scopes[parent].path, node.name),
        };
        scopes.push(Scope {
            electrical: electrical.contains(&path),
            path,
            name: node.name.clone(),
            module: node.module.clone(),
            children: node.children.clone(),
        });
    }
    let recipe = Recipe {
        version: 1,
        database_stamp: database_stamp(&database)?,
        database,
        rtl,
        scopes,
    };
    fs::create_dir_all(path.parent().expect("recipe has parent")).map_err(|err| err.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().expect("recipe has parent"))
        .map_err(|err| err.to_string())?;
    serde_json::to_writer(&mut file, &recipe).map_err(|err| err.to_string())?;
    file.persist(&path).map_err(|err| err.to_string())?;
    Ok(true)
}

fn remove_recipe(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("cannot remove stale schematic recipe: {err}")),
    }
}

impl Recipe {
    fn validate_sources(&self) -> Result<(), String> {
        if database_stamp(&self.database)? != self.database_stamp {
            return Err(
                "Hierarchy DB changed. Regenerate this bundle before opening Schematic.".into(),
            );
        }
        if let Some(rtl) = &self.rtl
            && (launcher::schematic_export_fingerprint(&rtl.selection, &rtl.cwd)?
                != rtl.fingerprint
                || !launcher::cached_dependencies_match(&self.database)?)
        {
            return Err(
                "RTL inputs or exporter changed. Regenerate this bundle before opening Schematic."
                    .into(),
            );
        }
        Ok(())
    }

    fn build(
        &self,
        id: usize,
        directory: &Path,
        stop: &AtomicBool,
        compiler: &Mutex<Option<launcher::SchematicWorker>>,
    ) -> Result<(), String> {
        self.validate_sources()?;
        let scope = &self.scopes[id];
        fs::create_dir_all(directory).map_err(|err| err.to_string())?;
        let temporary = tempfile::tempdir_in(directory).map_err(|err| err.to_string())?;
        let json_path = temporary.path().join("scope.json");
        if scope.electrical {
            if let Some(rtl) = &self.rtl {
                let mut compiler = compiler.lock().map_err(|_| "Slang worker state poisoned")?;
                if compiler.is_none() {
                    *compiler = Some(launcher::SchematicWorker::start(
                        &rtl.selection,
                        &rtl.cwd,
                        &self.database,
                        stop,
                    )?);
                }
                let result = (|| {
                    let database = compiler
                        .as_mut()
                        .expect("started compiler")
                        .export(&scope.path, stop)?;
                    let connection = open_database(database)?;
                    crate::schematic::write_scope_from_db(&connection, &scope.path, &json_path)
                })();
                if result.is_err() {
                    compiler.take();
                }
                result?;
            } else {
                let connection = open_database(&self.database)?;
                crate::schematic::write_scope_from_db(&connection, &scope.path, &json_path)?;
            }
        } else {
            // Synthetic forest / generate containers only show known children;
            // they must not acquire inferred electrical connections.
            let children: Vec<_> = scope
                .children
                .iter()
                .map(|&child| {
                    let node = &self.scopes[child];
                    serde_json::json!({
                        "id": format!("hierarchy:{child}"), "kind": "module",
                        "label": node.name, "instancePath": node.path,
                        "detail": node.module, "ports": [],
                    })
                })
                .collect();
            let graph =
                serde_json::json!({"version":1,"scopePath":scope.path,"nodes":children,"nets":[]});
            serde_json::to_writer(
                fs::File::create(&json_path).map_err(|err| err.to_string())?,
                &graph,
            )
            .map_err(|err| err.to_string())?;
        }
        // Never publish a graph from a changed input or an interrupted job.
        self.validate_sources()?;
        if stop.load(Ordering::Acquire) {
            return Err("Schematic build cancelled.".into());
        }
        fs::rename(&json_path, directory.join(format!("{id}.json"))).map_err(|err| err.to_string())
    }
}

#[derive(Default)]
struct BuildState {
    active: Option<usize>,
    failure: Option<(usize, String)>,
}

#[derive(Serialize)]
pub(crate) struct ScopeResponse {
    state: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

pub(crate) struct SchematicService {
    recipe: Option<Recipe>,
    directory: PathBuf,
    state: Mutex<BuildState>,
    worker: Mutex<Option<JoinHandle<()>>>,
    compiler: Mutex<Option<launcher::SchematicWorker>>,
    stop: AtomicBool,
}

fn service_error(status: u16, message: impl Into<String>) -> ServiceError {
    ServiceError {
        status,
        message: message.into(),
    }
}

impl SchematicService {
    pub(crate) fn new(root: &Path) -> Result<Arc<Self>, String> {
        let recipe_path = root.join(RECIPE_PATH);
        let bytes = match fs::read(&recipe_path) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(format!("cannot read schematic recipe: {err}")),
        };
        let recipe: Option<Recipe> = bytes
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|err| format!("invalid schematic recipe: {err}"))?;
        if let Some(recipe) = &recipe
            && (recipe.version != 1
                || recipe
                    .scopes
                    .iter()
                    .any(|scope| scope.children.iter().any(|&id| id >= recipe.scopes.len())))
        {
            return Err("invalid schematic recipe version or node references".into());
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut hasher);
        let directory = root
            .join(".hier-viewer-cache/schematic-lazy")
            .join(format!("{:016x}", hasher.finish()));
        Ok(Arc::new(Self {
            recipe,
            directory,
            state: Mutex::new(BuildState::default()),
            worker: Mutex::new(None),
            compiler: Mutex::new(None),
            stop: AtomicBool::new(false),
        }))
    }

    fn recipe_for(&self, id: usize) -> Result<&Recipe, ServiceError> {
        self.recipe.as_ref().filter(|recipe| id < recipe.scopes.len())
            .ok_or_else(|| service_error(404, "No on-demand schematic source for this scope. Regenerate from RTL or use --schematic."))
    }

    fn validate_recipe(&self, recipe: &Recipe) -> Result<(), ServiceError> {
        recipe.validate_sources().map_err(|error| {
            // An idle compilation for changed sources is no longer useful.
            // An active build validates again before publishing and drops it on failure.
            if let Ok(mut compiler) = self.compiler.try_lock() {
                compiler.take();
            }
            service_error(409, error)
        })
    }

    pub(crate) fn request(
        self: &Arc<Self>,
        id: usize,
    ) -> Result<(u16, ScopeResponse), ServiceError> {
        let recipe = self.recipe_for(id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| service_error(500, "schematic worker state poisoned"))?;
        if self.stop.load(Ordering::Acquire) {
            return Err(service_error(503, "Schematic service is stopping."));
        }
        if self.directory.join(format!("{id}.json")).is_file() {
            self.validate_recipe(recipe)?;
            return Ok((
                200,
                ScopeResponse {
                    state: "ready",
                    message: "Connections ready.",
                    url: Some(format!("./api/schematic/scopes/{id}")),
                },
            ));
        }
        if let Some(active) = state.active {
            return Ok((
                202,
                ScopeResponse {
                    state: if active == id { "building" } else { "busy" },
                    message: if active == id {
                        "Generating connections for this scope."
                    } else {
                        "Waiting for the current scope build to finish."
                    },
                    url: None,
                },
            ));
        }
        if state
            .failure
            .as_ref()
            .is_some_and(|(failed, _)| *failed == id)
        {
            let (_, error) = state.failure.take().expect("checked failure");
            return Err(service_error(422, error));
        }
        self.validate_recipe(recipe)?;
        state.active = Some(id);
        let service = Arc::clone(self);
        let handle = thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                service.recipe.as_ref().expect("validated recipe").build(
                    id,
                    &service.directory,
                    &service.stop,
                    &service.compiler,
                )
            }))
            .unwrap_or_else(|_| Err("Schematic worker panicked.".into()));
            if result.is_err()
                && let Ok(mut compiler) = service.compiler.lock()
            {
                compiler.take();
            }
            if let Ok(mut state) = service.state.lock() {
                state.active = None;
                if let Err(err) = result {
                    state.failure = Some((id, err));
                }
            }
        });
        drop(state);
        if let Ok(mut worker) = self.worker.lock() {
            if self.stop.load(Ordering::Acquire) {
                let _ = handle.join();
            } else if let Some(previous) = worker.replace(handle) {
                let _ = previous.join();
            }
        }
        Ok((
            202,
            ScopeResponse {
                state: "building",
                message: "Generating connections for this scope.",
                url: None,
            },
        ))
    }

    pub(crate) fn scope_file(&self, id: usize) -> Result<PathBuf, ServiceError> {
        self.validate_recipe(self.recipe_for(id)?)?;
        let path = self.directory.join(format!("{id}.json"));
        if !path.is_file() {
            return Err(service_error(404, "Scope has not been generated."));
        }
        Ok(path)
    }

    pub(crate) fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock()
            && let Some(handle) = worker.take()
        {
            let _ = handle.join();
        }
        if let Ok(mut compiler) = self.compiler.lock() {
            compiler.take();
        }
    }
}
