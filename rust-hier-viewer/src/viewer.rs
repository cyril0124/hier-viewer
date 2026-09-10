use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rayon::prelude::*;

use crate::model::{Config, Entry, InputData, Node, ViewerData};

const DEFAULT_METRIC: &str = "instances";
const MATERIALIZED_SOURCE_DIR: &str = ".hier-viewer-sources";

pub(crate) fn build_viewer_data(
    input_data: InputData,
    config: &Config,
) -> Result<ViewerData, String> {
    let built_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("failed to capture build time: {err}"))?
        .as_millis() as u64;
    let InputData {
        entries,
        analysis_definitions,
        schematic,
    } = input_data;
    let mut entries = entries;
    attach_source_hrefs(&mut entries, config)?;

    let mut nodes = Vec::new();
    nodes.push(Node {
        name: "(root)".to_string(),
        module: "(forest)".to_string(),
        definition_key: None,
        parent: None,
        children: Vec::new(),
        subtree_instances: 0,
        subtree_leaves: 0,
        subtree_signal_count: 0,
        subtree_internal_signal_count: 0,
        subtree_gen_signal_count: 0,
        subtree_variable_bits: 0,
        subtree_net_bits: 0,
        subtree_signal_bits: 0,
        module_port_count: 0,
        module_logic_count: 0,
        module_reg_count: 0,
        module_wire_count: 0,
        module_variable_count: 0,
        module_net_count: 0,
        module_signal_count: 0,
        module_variable_bits: 0,
        module_net_bits: 0,
        module_signal_bits: 0,
        module_internal_signal_count: 0,
        module_gen_signal_count: 0,
        file_path: None,
        source_href: None,
        definition_file_path: None,
        definition_source_href: None,
        line: None,
        column: None,
        end_line: None,
        end_column: None,
        definition_line: None,
        definition_column: None,
        definition_end_line: None,
        definition_end_column: None,
    });

    let mut path_to_id: HashMap<String, usize> = HashMap::new();
    let mut sorted_entries = entries;
    sorted_entries.sort_by(|a, b| a.path.cmp(&b.path));

    for entry in sorted_entries {
        let mut parent_id = 0usize;
        let mut prefix = String::new();
        let segments: Vec<&str> = entry
            .path
            .split('.')
            .filter(|part| !part.is_empty())
            .collect();
        if segments.is_empty() {
            continue;
        }

        for (index, segment) in segments.iter().enumerate() {
            if index > 0 {
                prefix.push('.');
            }
            prefix.push_str(segment);

            let is_leaf = index + 1 == segments.len();
            let node_id = match path_to_id.get(&prefix).copied() {
                Some(id) => {
                    if is_leaf {
                        let node = &mut nodes[id];
                        if !node.module.is_empty() && node.module != entry.module {
                            return Err(format!(
                                "conflicting module names for '{}': '{}' vs '{}'",
                                entry.path, node.module, entry.module
                            ));
                        }
                        node.module = entry.module.clone();
                        node.definition_key = entry.definition_key;
                        node.file_path = entry.file_path.clone();
                        node.source_href = entry.source_href.clone();
                        node.definition_file_path = entry.definition_file_path.clone();
                        node.definition_source_href = entry.definition_source_href.clone();
                        node.line = entry.line;
                        node.column = entry.column;
                        node.end_line = entry.end_line;
                        node.end_column = entry.end_column;
                        node.definition_line = entry.definition_line;
                        node.definition_column = entry.definition_column;
                        node.definition_end_line = entry.definition_end_line;
                        node.definition_end_column = entry.definition_end_column;
                        node.module_port_count = entry.module_port_count;
                        node.module_logic_count = entry.module_logic_count;
                        node.module_reg_count = entry.module_reg_count;
                        node.module_wire_count = entry.module_wire_count;
                        node.module_variable_count = entry.module_variable_count;
                        node.module_net_count = entry.module_net_count;
                        node.module_signal_count = entry.module_signal_count;
                        node.module_variable_bits = entry.module_variable_bits;
                        node.module_net_bits = entry.module_net_bits;
                        node.module_signal_bits = entry.module_signal_bits;
                        node.module_internal_signal_count = entry.module_internal_signal_count;
                        node.module_gen_signal_count = entry.module_gen_signal_count;
                    }
                    id
                }
                None => {
                    let id = nodes.len();
                    nodes.push(Node {
                        name: (*segment).to_string(),
                        module: if is_leaf {
                            entry.module.clone()
                        } else {
                            String::new()
                        },
                        definition_key: if is_leaf { entry.definition_key } else { None },
                        parent: Some(parent_id),
                        children: Vec::new(),
                        subtree_instances: 0,
                        subtree_leaves: 0,
                        subtree_signal_count: 0,
                        subtree_internal_signal_count: 0,
                        subtree_gen_signal_count: 0,
                        subtree_variable_bits: 0,
                        subtree_net_bits: 0,
                        subtree_signal_bits: 0,
                        module_port_count: if is_leaf { entry.module_port_count } else { 0 },
                        module_logic_count: if is_leaf { entry.module_logic_count } else { 0 },
                        module_reg_count: if is_leaf { entry.module_reg_count } else { 0 },
                        module_wire_count: if is_leaf { entry.module_wire_count } else { 0 },
                        module_variable_count: if is_leaf {
                            entry.module_variable_count
                        } else {
                            0
                        },
                        module_net_count: if is_leaf { entry.module_net_count } else { 0 },
                        module_signal_count: if is_leaf {
                            entry.module_signal_count
                        } else {
                            0
                        },
                        module_variable_bits: if is_leaf {
                            entry.module_variable_bits
                        } else {
                            0
                        },
                        module_net_bits: if is_leaf { entry.module_net_bits } else { 0 },
                        module_signal_bits: if is_leaf { entry.module_signal_bits } else { 0 },
                        module_internal_signal_count: if is_leaf {
                            entry.module_internal_signal_count
                        } else {
                            0
                        },
                        module_gen_signal_count: if is_leaf {
                            entry.module_gen_signal_count
                        } else {
                            0
                        },
                        file_path: if is_leaf {
                            entry.file_path.clone()
                        } else {
                            None
                        },
                        source_href: if is_leaf {
                            entry.source_href.clone()
                        } else {
                            None
                        },
                        definition_file_path: if is_leaf {
                            entry.definition_file_path.clone()
                        } else {
                            None
                        },
                        definition_source_href: if is_leaf {
                            entry.definition_source_href.clone()
                        } else {
                            None
                        },
                        line: if is_leaf { entry.line } else { None },
                        column: if is_leaf { entry.column } else { None },
                        end_line: if is_leaf { entry.end_line } else { None },
                        end_column: if is_leaf { entry.end_column } else { None },
                        definition_line: if is_leaf { entry.definition_line } else { None },
                        definition_column: if is_leaf {
                            entry.definition_column
                        } else {
                            None
                        },
                        definition_end_line: if is_leaf {
                            entry.definition_end_line
                        } else {
                            None
                        },
                        definition_end_column: if is_leaf {
                            entry.definition_end_column
                        } else {
                            None
                        },
                    });
                    nodes[parent_id].children.push(id);
                    path_to_id.insert(prefix.clone(), id);
                    id
                }
            };

            parent_id = node_id;
        }
    }

    let schematic = schematic
        .map(|input| input.bind(&path_to_id, nodes.len()))
        .transpose()?;

    if nodes[0].children.is_empty() {
        let title = config
            .title
            .clone()
            .unwrap_or_else(|| "Hierarchy Viewer".to_string());
        return Ok(ViewerData {
            title,
            built_at_unix_ms,
            debug_ui_labels: config.debug,
            nodes,
            root_id: 0,
            default_metric: DEFAULT_METRIC,
            analysis_definitions,
            schematic,
            schematic_on_demand: false,
        });
    }

    fill_missing_modules(&mut nodes);
    compute_stats(&mut nodes);

    let root_id = if nodes[0].children.len() == 1 {
        nodes[0].children[0]
    } else {
        0
    };

    let title = config
        .title
        .clone()
        .or_else(|| derive_default_title(&nodes, root_id, config.db_path.as_deref()))
        .unwrap_or_else(|| "Hierarchy Viewer".to_string());

    Ok(ViewerData {
        title,
        built_at_unix_ms,
        debug_ui_labels: config.debug,
        nodes,
        root_id,
        default_metric: DEFAULT_METRIC,
        analysis_definitions,
        schematic,
        schematic_on_demand: false,
    })
}

fn attach_source_hrefs(entries: &mut [Entry], config: &Config) -> Result<(), String> {
    let Some(output_path) = config.output_path.as_deref() else {
        return Ok(());
    };

    let output_dir = resolve_output_dir(output_path)?;
    let materialized_root = output_dir.join(MATERIALIZED_SOURCE_DIR);
    let file_paths = collect_unique_source_paths(entries);
    let href_cache = preload_source_hrefs(&file_paths, &output_dir, &materialized_root)?;
    for entry in entries.iter_mut() {
        entry.source_href = cached_source_href(entry.file_path.as_deref(), &href_cache);
        entry.definition_source_href =
            cached_source_href(entry.definition_file_path.as_deref(), &href_cache);
    }

    Ok(())
}

fn collect_unique_source_paths(entries: &[Entry]) -> Vec<String> {
    let mut unique = HashSet::new();
    let mut paths = Vec::new();
    for entry in entries {
        for path in [&entry.file_path, &entry.definition_file_path]
            .into_iter()
            .flatten()
        {
            if unique.insert(path.clone()) {
                paths.push(path.clone());
            }
        }
    }
    paths
}

fn preload_source_hrefs(
    file_paths: &[String],
    output_dir: &Path,
    materialized_root: &Path,
) -> Result<HashMap<String, Option<String>>, String> {
    // Resolve aliases before parallel copying so each destination has one writer.
    let mut source_paths: HashMap<PathBuf, Vec<&String>> = HashMap::new();
    for path in file_paths {
        source_paths
            .entry(resolve_path(path)?)
            .or_default()
            .push(path);
    }
    let results = source_paths
        .par_iter()
        .map(|(source_path, aliases)| {
            let href = materialize_source_file(output_dir, materialized_root, source_path)?;
            Ok::<_, String>((aliases, href))
        })
        .collect::<Vec<_>>();

    let mut cache = HashMap::with_capacity(file_paths.len());
    for result in results {
        let (aliases, href) = result?;
        for path in aliases {
            cache.insert((*path).clone(), href.clone());
        }
    }
    Ok(cache)
}

fn cached_source_href(
    file_path: Option<&str>,
    href_cache: &HashMap<String, Option<String>>,
) -> Option<String> {
    file_path.and_then(|path| href_cache.get(path).cloned().flatten())
}

fn materialize_source_file(
    output_dir: &Path,
    materialized_root: &Path,
    source_path: &Path,
) -> Result<Option<String>, String> {
    let relative_inside_bundle = source_bundle_relative_path(source_path);
    let target_path = materialized_root.join(&relative_inside_bundle);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create source bundle directory '{}': {err}",
                parent.display()
            )
        })?;
    }
    fs::copy(source_path, &target_path).map_err(|err| {
        format!(
            "failed to copy source file '{}' into '{}': {err}",
            source_path.display(),
            target_path.display()
        )
    })?;

    let href_path = make_relative_path(output_dir, &target_path);
    Ok(path_to_href(&href_path))
}

fn source_bundle_relative_path(source_path: &Path) -> PathBuf {
    let mut relative = PathBuf::new();
    for component in source_path.components() {
        match component {
            Component::Normal(value) => relative.push(value),
            Component::RootDir => {}
            Component::Prefix(prefix) => {
                // Hex preserves the entire prefix without separators or illegal filename bytes.
                let mut encoded = String::from("prefix-");
                for byte in prefix.as_os_str().as_encoded_bytes() {
                    const HEX: &[u8; 16] = b"0123456789abcdef";
                    encoded.push(HEX[(byte >> 4) as usize] as char);
                    encoded.push(HEX[(byte & 15) as usize] as char);
                }
                relative.push(encoded);
            }
            Component::CurDir | Component::ParentDir => {
                unreachable!("source paths must be normalized before bundling")
            }
        }
    }
    relative
}

fn resolve_output_dir(output_path: &str) -> Result<PathBuf, String> {
    resolve_path(output_path)
}

fn resolve_path(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|err| format!("failed to determine current directory: {err}"))?
            .join(path)
    };
    Ok(normalize_path(&absolute))
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn make_relative_path(base_dir: &Path, target_path: &Path) -> PathBuf {
    let base_components: Vec<Component<'_>> = base_dir.components().collect();
    let target_components: Vec<Component<'_>> = target_path.components().collect();

    let common_len = base_components
        .iter()
        .zip(target_components.iter())
        .take_while(|(left, right)| left == right)
        .count();

    let mut relative = PathBuf::new();
    for component in &base_components[common_len..] {
        if matches!(component, Component::Normal(_)) {
            relative.push("..");
        }
    }
    for component in &target_components[common_len..] {
        relative.push(component.as_os_str());
    }

    if relative.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        relative
    }
}

fn path_to_href(path: &Path) -> Option<String> {
    let mut href = String::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                if !href.is_empty() {
                    href.push('/');
                }
                for byte in value.to_string_lossy().bytes() {
                    if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                        href.push(byte as char);
                    } else {
                        const HEX: &[u8; 16] = b"0123456789ABCDEF";
                        href.push('%');
                        href.push(HEX[(byte >> 4) as usize] as char);
                        href.push(HEX[(byte & 15) as usize] as char);
                    }
                }
            }
            Component::ParentDir => {
                if !href.is_empty() {
                    href.push('/');
                }
                href.push_str("..");
            }
            Component::CurDir => {
                if href.is_empty() {
                    href.push('.');
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    if href.is_empty() { None } else { Some(href) }
}

fn fill_missing_modules(nodes: &mut [Node]) {
    for node in nodes.iter_mut().skip(1) {
        if node.module.is_empty() {
            node.module = "(unknown)".to_string();
        }
    }
}

fn compute_stats(nodes: &mut [Node]) {
    for node in nodes.iter_mut() {
        node.subtree_instances = 1;
        node.subtree_leaves = usize::from(node.children.is_empty());
        node.subtree_signal_count = node.module_signal_count;
        node.subtree_internal_signal_count = node.module_internal_signal_count;
        node.subtree_gen_signal_count = node.module_gen_signal_count;
        node.subtree_variable_bits = node.module_variable_bits;
        node.subtree_net_bits = node.module_net_bits;
        node.subtree_signal_bits = node.module_signal_bits;
    }

    // Construction assigns every parent a lower ID, so descendants are complete first.
    for node_id in (0..nodes.len()).rev() {
        let Some(parent_id) = nodes[node_id].parent else {
            continue;
        };
        let (ancestors, descendants) = nodes.split_at_mut(node_id);
        let parent = &mut ancestors[parent_id];
        let node = &descendants[0];
        parent.subtree_instances += node.subtree_instances;
        parent.subtree_leaves += node.subtree_leaves;
        parent.subtree_signal_count += node.subtree_signal_count;
        parent.subtree_internal_signal_count += node.subtree_internal_signal_count;
        parent.subtree_gen_signal_count += node.subtree_gen_signal_count;
        parent.subtree_variable_bits += node.subtree_variable_bits;
        parent.subtree_net_bits += node.subtree_net_bits;
        parent.subtree_signal_bits += node.subtree_signal_bits;
    }
}

fn derive_default_title(nodes: &[Node], root_id: usize, db_path: Option<&str>) -> Option<String> {
    if root_id != 0 {
        let root = &nodes[root_id];
        if !root.module.trim().is_empty() {
            return Some(format!("{} Hierarchy", root.module.trim()));
        }
        if !root.name.trim().is_empty() {
            return Some(format!("{} Hierarchy", root.name.trim()));
        }
    }

    db_path.and_then(derive_title_from_path)
}

fn derive_title_from_path(path: &str) -> Option<String> {
    let path = Path::new(path);
    if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
        let trimmed = stem.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let file_name = path.file_name()?.to_string_lossy();
    let trimmed = file_name.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_node(parent: Option<usize>) -> Node {
        Node {
            name: String::new(),
            module: String::new(),
            definition_key: None,
            parent,
            children: Vec::new(),
            subtree_instances: 0,
            subtree_leaves: 0,
            subtree_signal_count: 0,
            subtree_internal_signal_count: 0,
            subtree_gen_signal_count: 0,
            subtree_variable_bits: 0,
            subtree_net_bits: 0,
            subtree_signal_bits: 0,
            module_port_count: 0,
            module_logic_count: 0,
            module_reg_count: 0,
            module_wire_count: 0,
            module_variable_count: 0,
            module_net_count: 0,
            module_signal_count: 0,
            module_variable_bits: 0,
            module_net_bits: 0,
            module_signal_bits: 0,
            module_internal_signal_count: 0,
            module_gen_signal_count: 0,
            file_path: None,
            source_href: None,
            definition_file_path: None,
            definition_source_href: None,
            line: None,
            column: None,
            end_line: None,
            end_column: None,
            definition_line: None,
            definition_column: None,
            definition_end_line: None,
            definition_end_column: None,
        }
    }

    fn stats(node: &Node) -> [usize; 8] {
        [
            node.subtree_instances,
            node.subtree_leaves,
            node.subtree_signal_count,
            node.subtree_internal_signal_count,
            node.subtree_gen_signal_count,
            node.subtree_variable_bits,
            node.subtree_net_bits,
            node.subtree_signal_bits,
        ]
    }

    #[test]
    fn empty_input_keeps_virtual_root_statistics_zero() {
        compute_stats(&mut []);
        let config = Config {
            db_path: None,
            output_path: None,
            title: None,
            no_wizard: true,
            rebuild_sqlite: false,
            schematic: false,
            preview: false,
            preview_host: String::new(),
            preview_port: 0,
            rtl_inputs: Vec::new(),
            filelists: Vec::new(),
            extra_args_tokens: Vec::new(),
            debug: false,
            coverage: None,
        };
        let data = build_viewer_data(
            InputData {
                entries: Vec::new(),
                analysis_definitions: Vec::new(),
                schematic: None,
            },
            &config,
        )
        .expect("build empty viewer");
        assert_eq!(data.root_id, 0);
        assert_eq!(data.nodes.len(), 1);
        assert_eq!(stats(&data.nodes[0]), [0; 8]);
    }

    #[test]
    fn stats_accumulate_wide_tree_and_multiple_roots() {
        const WIDTH: usize = 4096;
        let mut nodes = Vec::with_capacity(WIDTH + 3);
        nodes.push(test_node(None));
        for node_id in 1..WIDTH + 3 {
            let parent_id = if node_id <= 2 { 0 } else { 1 };
            nodes.push(Node {
                module_signal_count: 5,
                module_internal_signal_count: 2,
                module_gen_signal_count: 3,
                module_variable_bits: 7,
                module_net_bits: 11,
                module_signal_bits: 18,
                ..test_node(Some(parent_id))
            });
            nodes[parent_id].children.push(node_id);
        }
        for _ in 0..2 {
            compute_stats(&mut nodes);
            let count = WIDTH + 2;
            assert_eq!(
                stats(&nodes[0]),
                [
                    count + 1,
                    WIDTH + 1,
                    count * 5,
                    count * 2,
                    count * 3,
                    count * 7,
                    count * 11,
                    count * 18
                ]
            );
            let count = WIDTH + 1;
            assert_eq!(
                stats(&nodes[1]),
                [
                    count,
                    WIDTH,
                    count * 5,
                    count * 2,
                    count * 3,
                    count * 7,
                    count * 11,
                    count * 18
                ]
            );
            for node in &nodes[2..] {
                assert_eq!(stats(node), [1, 1, 5, 2, 3, 7, 11, 18]);
            }
        }
    }

    #[test]
    fn stats_handle_one_hundred_thousand_node_chain_without_recursion() {
        const DEPTH: usize = 100_000;
        let mut nodes = Vec::with_capacity(DEPTH + 1);
        nodes.push(test_node(None));
        for node_id in 1..=DEPTH {
            nodes.push(Node {
                module_signal_count: 5,
                module_internal_signal_count: 2,
                module_gen_signal_count: 3,
                module_variable_bits: 7,
                module_net_bits: 11,
                module_signal_bits: 18,
                ..test_node(Some(node_id - 1))
            });
            nodes[node_id - 1].children.push(node_id);
        }
        compute_stats(&mut nodes);
        assert_eq!(
            stats(&nodes[0]),
            [
                DEPTH + 1,
                1,
                DEPTH * 5,
                DEPTH * 2,
                DEPTH * 3,
                DEPTH * 7,
                DEPTH * 11,
                DEPTH * 18
            ]
        );
        for (node_id, node) in nodes.iter().enumerate().skip(1) {
            let count = DEPTH - node_id + 1;
            assert_eq!(
                stats(node),
                [
                    count,
                    1,
                    count * 5,
                    count * 2,
                    count * 3,
                    count * 7,
                    count * 11,
                    count * 18
                ]
            );
        }
    }

    #[test]
    fn source_bundle_preserves_distinct_files_and_resolves_aliases() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let temp_dir = env::temp_dir().join(format!(
            "hier-viewer-source-tests-{}-{unique}",
            std::process::id()
        ));
        let rtl_dir = temp_dir.join("work/rtl");
        let output_dir = rtl_dir.join("out");
        fs::create_dir_all(&output_dir).expect("create test directories");
        let source_a = temp_dir.join("work/a.sv");
        let source_b = rtl_dir.join("a.sv");
        let source_alias = rtl_dir.join("../rtl/./a.sv");
        fs::write(&source_a, "module first; endmodule\n").expect("write first source");
        fs::write(&source_b, "module second; endmodule\n").expect("write second source");
        let paths = [source_a, source_b, source_alias]
            .map(|path| path.to_str().expect("UTF-8 source path").to_string());
        let bundle_root = output_dir.join(MATERIALIZED_SOURCE_DIR);
        let hrefs = preload_source_hrefs(&paths, &output_dir, &bundle_root)
            .expect("materialize distinct sources");
        let first_href = hrefs[&paths[0]].as_ref().expect("first source href");
        let second_href = hrefs[&paths[1]].as_ref().expect("second source href");
        assert_ne!(first_href, second_href);
        assert_eq!(hrefs[&paths[1]], hrefs[&paths[2]]);
        assert_eq!(
            fs::read_to_string(output_dir.join(first_href)).expect("read first bundled source"),
            "module first; endmodule\n"
        );
        assert_eq!(
            fs::read_to_string(output_dir.join(second_href)).expect("read second bundled source"),
            "module second; endmodule\n"
        );
        fs::remove_dir_all(temp_dir).expect("remove source test directory");
    }

    #[test]
    fn source_hrefs_encode_url_delimiters_and_utf8() {
        assert_eq!(
            path_to_href(Path::new("dir #1/rtl%20/top?.sv")).as_deref(),
            Some("dir%20%231/rtl%2520/top%3F.sv")
        );
        assert_eq!(
            path_to_href(Path::new("\u{8bbe}\u{8ba1}/top.sv")).as_deref(),
            Some("%E8%AE%BE%E8%AE%A1/top.sv")
        );
    }

    #[cfg(unix)]
    #[test]
    fn source_bundle_keeps_all_normal_components() {
        assert_eq!(
            source_bundle_relative_path(Path::new("/work/rtl/a.sv")),
            Path::new("work/rtl/a.sv")
        );
    }

    #[cfg(windows)]
    #[test]
    fn source_bundle_encodes_windows_prefixes_without_collisions() {
        let paths = [
            r"C:\work\a.sv",
            r"D:\work\a.sv",
            r"\\server-a\share\work\a.sv",
            r"\\server\a-share\work\a.sv",
            r"\\?\C:\work\a.sv",
            r"\\?\UNC\server-a\share\work\a.sv",
        ];
        let bundled: HashSet<_> = paths
            .iter()
            .map(|path| source_bundle_relative_path(Path::new(path)))
            .collect();
        assert_eq!(bundled.len(), paths.len());
        for path in bundled {
            assert!(
                path.components()
                    .all(|part| matches!(part, Component::Normal(_)))
            );
            let prefix = path.components().next().expect("encoded prefix");
            let prefix = prefix.as_os_str().to_str().expect("ASCII prefix");
            assert!(prefix.starts_with("prefix-"));
            assert!(prefix[7..].bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
        assert_eq!(
            source_bundle_relative_path(Path::new(paths[0])),
            Path::new(r"prefix-433a\work\a.sv")
        );
    }
}
