use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rayon::prelude::*;
use regex::Regex;

use crate::model::{Config, Entry, InputData, Node, ViewerData};

const SOURCE_CONTEXT_LINES: usize = 2;
const MAX_SOURCE_SNIPPET_LINES: usize = 24;
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
    } = input_data;
    let mut entries = filter_entries(entries, config)?;
    attach_source_snippets(&mut entries)?;
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
        snippet_start_line: None,
        snippet_end_line: None,
        snippet_text: None,
        definition_snippet_start_line: None,
        definition_snippet_end_line: None,
        definition_snippet_text: None,
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
                        node.snippet_start_line = entry.snippet_start_line;
                        node.snippet_end_line = entry.snippet_end_line;
                        node.snippet_text = entry.snippet_text.clone();
                        node.definition_snippet_start_line = entry.definition_snippet_start_line;
                        node.definition_snippet_end_line = entry.definition_snippet_end_line;
                        node.definition_snippet_text = entry.definition_snippet_text.clone();
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
                        snippet_start_line: if is_leaf {
                            entry.snippet_start_line
                        } else {
                            None
                        },
                        snippet_end_line: if is_leaf {
                            entry.snippet_end_line
                        } else {
                            None
                        },
                        snippet_text: if is_leaf {
                            entry.snippet_text.clone()
                        } else {
                            None
                        },
                        definition_snippet_start_line: if is_leaf {
                            entry.definition_snippet_start_line
                        } else {
                            None
                        },
                        definition_snippet_end_line: if is_leaf {
                            entry.definition_snippet_end_line
                        } else {
                            None
                        },
                        definition_snippet_text: if is_leaf {
                            entry.definition_snippet_text.clone()
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
            default_metric: config.initial_metric,
            analysis_definitions,
        });
    }

    fill_missing_modules(&mut nodes);
    prefer_definition_source_for_leaf_nodes(&mut nodes);
    compute_stats(&mut nodes, 0);

    let root_id = if nodes[0].children.len() == 1 {
        nodes[0].children[0]
    } else {
        0
    };

    let title = config
        .title
        .clone()
        .or_else(|| derive_default_title(&nodes, root_id, config.input_path.as_deref()))
        .unwrap_or_else(|| "Hierarchy Viewer".to_string());

    Ok(ViewerData {
        title,
        built_at_unix_ms,
        debug_ui_labels: config.debug,
        nodes,
        root_id,
        default_metric: config.initial_metric,
        analysis_definitions,
    })
}

fn filter_entries(entries: Vec<Entry>, config: &Config) -> Result<Vec<Entry>, String> {
    if config.exclude_wildcards.is_empty() && config.exclude_regexes.is_empty() {
        return Ok(entries);
    }

    let regexes = compile_regexes(&config.exclude_regexes)?;
    let mut entries = entries;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let mut excluded_prefixes: Vec<String> = Vec::new();
    let mut filtered = Vec::new();

    for entry in entries {
        if excluded_prefixes
            .iter()
            .any(|prefix| is_same_or_descendant_path(&entry.path, prefix))
        {
            continue;
        }

        if should_exclude_entry(&entry, &config.exclude_wildcards, &regexes) {
            excluded_prefixes.push(entry.path);
            continue;
        }

        filtered.push(entry);
    }

    Ok(filtered)
}

fn attach_source_snippets(entries: &mut [Entry]) -> Result<(), String> {
    let file_paths = collect_unique_source_paths(entries);
    let file_cache = preload_source_files(&file_paths);
    for entry in entries.iter_mut() {
        populate_source_snippet(
            entry.file_path.as_ref(),
            entry.line,
            entry.end_line,
            &mut entry.snippet_start_line,
            &mut entry.snippet_end_line,
            &mut entry.snippet_text,
            &file_cache,
        );
        populate_source_snippet(
            entry.definition_file_path.as_ref(),
            entry.definition_line,
            entry.definition_end_line,
            &mut entry.definition_snippet_start_line,
            &mut entry.definition_snippet_end_line,
            &mut entry.definition_snippet_text,
            &file_cache,
        );
    }
    Ok(())
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

fn preload_source_files(file_paths: &[String]) -> HashMap<String, Option<Vec<String>>> {
    file_paths
        .par_iter()
        .map(|path| {
            let cached = fs::read_to_string(path)
                .ok()
                .map(|text| text.split('\n').map(str::to_string).collect::<Vec<_>>());
            (path.clone(), cached)
        })
        .collect()
}

fn preload_source_hrefs(
    file_paths: &[String],
    output_dir: &Path,
    materialized_root: &Path,
) -> Result<HashMap<String, Option<String>>, String> {
    let results = file_paths
        .par_iter()
        .map(|path| {
            let href = materialize_source_href(path, output_dir, materialized_root)?;
            Ok::<(String, Option<String>), String>((path.clone(), href))
        })
        .collect::<Vec<_>>();

    let mut cache = HashMap::with_capacity(results.len());
    for result in results {
        let (path, href) = result?;
        cache.insert(path, href);
    }
    Ok(cache)
}

fn populate_source_snippet(
    path: Option<&String>,
    line: Option<usize>,
    end_line: Option<usize>,
    snippet_start_line: &mut Option<usize>,
    snippet_end_line: &mut Option<usize>,
    snippet_text: &mut Option<String>,
    file_cache: &HashMap<String, Option<Vec<String>>>,
) {
    let Some(path) = path else {
        return;
    };
    let Some(line) = line else {
        return;
    };

    let Some(lines) = file_cache.get(path) else {
        return;
    };
    let Some(lines) = lines.as_ref() else {
        return;
    };

    if lines.is_empty() {
        return;
    }

    let focus_start = line.clamp(1, lines.len());
    let focus_end = end_line
        .unwrap_or(focus_start)
        .clamp(focus_start, lines.len());
    let start_line = focus_start.saturating_sub(SOURCE_CONTEXT_LINES).max(1);
    let mut end_line = (focus_end + SOURCE_CONTEXT_LINES).min(lines.len());
    let max_end_line = (start_line + MAX_SOURCE_SNIPPET_LINES - 1).min(lines.len());
    if end_line > max_end_line {
        end_line = max_end_line;
    }

    *snippet_start_line = Some(start_line);
    *snippet_end_line = Some(end_line);
    *snippet_text = Some(lines[start_line - 1..end_line].join("\n"));
}

fn cached_source_href(
    file_path: Option<&str>,
    href_cache: &HashMap<String, Option<String>>,
) -> Option<String> {
    file_path.and_then(|path| href_cache.get(path).cloned().flatten())
}

fn materialize_source_href(
    file_path: &str,
    output_dir: &Path,
    materialized_root: &Path,
) -> Result<Option<String>, String> {
    let source_path = resolve_path(file_path)?;
    let href = materialize_source_file(output_dir, materialized_root, &source_path)?;
    Ok(href)
}

fn materialize_source_file(
    output_dir: &Path,
    materialized_root: &Path,
    source_path: &Path,
) -> Result<Option<String>, String> {
    let relative_inside_bundle = source_bundle_relative_path(output_dir, source_path);
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

fn source_bundle_relative_path(output_dir: &Path, source_path: &Path) -> PathBuf {
    let output_components: Vec<Component<'_>> = output_dir.components().collect();
    let source_components: Vec<Component<'_>> = source_path.components().collect();
    let common_len = output_components
        .iter()
        .zip(source_components.iter())
        .take_while(|(left, right)| left == right)
        .count();

    let mut relative = PathBuf::new();
    for component in &source_components[common_len..] {
        match component {
            Component::Normal(value) => relative.push(value),
            Component::CurDir => {}
            Component::ParentDir => relative.push("__parent__"),
            Component::RootDir => {}
            Component::Prefix(prefix) => relative.push(prefix.as_os_str()),
        }
    }

    if relative.as_os_str().is_empty() {
        PathBuf::from("source")
    } else {
        relative
    }
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
                href.push_str(&value.to_string_lossy());
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

fn compile_regexes(patterns: &[String]) -> Result<Vec<Regex>, String> {
    patterns
        .iter()
        .map(|pattern| {
            Regex::new(pattern)
                .map_err(|err| format!("invalid --exclude-regex pattern '{}': {err}", pattern))
        })
        .collect()
}

fn should_exclude_entry(entry: &Entry, wildcards: &[String], regexes: &[Regex]) -> bool {
    wildcards.iter().any(|pattern| {
        wildcard_match(pattern, &entry.path) || wildcard_match(pattern, &entry.module)
    }) || regexes
        .iter()
        .any(|regex| regex.is_match(&entry.path) || regex.is_match(&entry.module))
}

fn is_same_or_descendant_path(path: &str, prefix: &str) -> bool {
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes().get(prefix.len()) == Some(&b'.'))
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern_chars: Vec<char> = pattern.chars().collect();
    let text_chars: Vec<char> = text.chars().collect();
    let mut dp = vec![vec![false; text_chars.len() + 1]; pattern_chars.len() + 1];
    dp[0][0] = true;

    for i in 0..pattern_chars.len() {
        match pattern_chars[i] {
            '*' => {
                for j in 0..=text_chars.len() {
                    if dp[i][j] {
                        dp[i + 1][j] = true;
                        if j < text_chars.len() {
                            dp[i][j + 1] = true;
                        }
                    }
                }
            }
            '?' => {
                for j in 0..text_chars.len() {
                    if dp[i][j] {
                        dp[i + 1][j + 1] = true;
                    }
                }
            }
            ch => {
                for j in 0..text_chars.len() {
                    if dp[i][j] && text_chars[j] == ch {
                        dp[i + 1][j + 1] = true;
                    }
                }
            }
        }
    }

    dp[pattern_chars.len()][text_chars.len()]
}

fn fill_missing_modules(nodes: &mut [Node]) {
    for node in nodes.iter_mut().skip(1) {
        if node.module.is_empty() {
            node.module = "(unknown)".to_string();
        }
    }
}

fn prefer_definition_source_for_leaf_nodes(nodes: &mut [Node]) {
    for node in nodes.iter_mut().skip(1) {
        if !node.children.is_empty() {
            continue;
        }
        if node.definition_file_path.is_none() {
            continue;
        }

        node.file_path = node.definition_file_path.clone();
        node.source_href = node.definition_source_href.clone();
        node.line = node.definition_line;
        node.column = node.definition_column;
        node.end_line = node.definition_end_line;
        node.end_column = node.definition_end_column;
        node.snippet_start_line = node.definition_snippet_start_line;
        node.snippet_end_line = node.definition_snippet_end_line;
        node.snippet_text = node.definition_snippet_text.clone();
    }
}

fn compute_stats(
    nodes: &mut [Node],
    node_id: usize,
) -> (usize, usize, usize, usize, usize, usize, usize, usize) {
    let children = nodes[node_id].children.clone();
    if children.is_empty() {
        nodes[node_id].subtree_instances = 1;
        nodes[node_id].subtree_leaves = 1;
        nodes[node_id].subtree_signal_count = nodes[node_id].module_signal_count;
        nodes[node_id].subtree_internal_signal_count = nodes[node_id].module_internal_signal_count;
        nodes[node_id].subtree_gen_signal_count = nodes[node_id].module_gen_signal_count;
        nodes[node_id].subtree_variable_bits = nodes[node_id].module_variable_bits;
        nodes[node_id].subtree_net_bits = nodes[node_id].module_net_bits;
        nodes[node_id].subtree_signal_bits = nodes[node_id].module_signal_bits;
        return (
            1,
            1,
            nodes[node_id].subtree_signal_count,
            nodes[node_id].subtree_internal_signal_count,
            nodes[node_id].subtree_gen_signal_count,
            nodes[node_id].subtree_variable_bits,
            nodes[node_id].subtree_net_bits,
            nodes[node_id].subtree_signal_bits,
        );
    }

    let mut subtree_instances = 1usize;
    let mut subtree_leaves = 0usize;
    let mut subtree_signal_count = nodes[node_id].module_signal_count;
    let mut subtree_internal_signal_count = nodes[node_id].module_internal_signal_count;
    let mut subtree_gen_signal_count = nodes[node_id].module_gen_signal_count;
    let mut subtree_variable_bits = nodes[node_id].module_variable_bits;
    let mut subtree_net_bits = nodes[node_id].module_net_bits;
    let mut subtree_signal_bits = nodes[node_id].module_signal_bits;
    for child_id in children {
        let (
            child_instances,
            child_leaves,
            child_signal_count,
            child_internal_signal_count,
            child_gen_signal_count,
            child_variable_bits,
            child_net_bits,
            child_signal_bits,
        ) =
            compute_stats(nodes, child_id);
        subtree_instances += child_instances;
        subtree_leaves += child_leaves;
        subtree_signal_count += child_signal_count;
        subtree_internal_signal_count += child_internal_signal_count;
        subtree_gen_signal_count += child_gen_signal_count;
        subtree_variable_bits += child_variable_bits;
        subtree_net_bits += child_net_bits;
        subtree_signal_bits += child_signal_bits;
    }

    nodes[node_id].subtree_instances = subtree_instances;
    nodes[node_id].subtree_leaves = subtree_leaves;
    nodes[node_id].subtree_signal_count = subtree_signal_count;
    nodes[node_id].subtree_internal_signal_count = subtree_internal_signal_count;
    nodes[node_id].subtree_gen_signal_count = subtree_gen_signal_count;
    nodes[node_id].subtree_variable_bits = subtree_variable_bits;
    nodes[node_id].subtree_net_bits = subtree_net_bits;
    nodes[node_id].subtree_signal_bits = subtree_signal_bits;
    (
        subtree_instances,
        subtree_leaves,
        subtree_signal_count,
        subtree_internal_signal_count,
        subtree_gen_signal_count,
        subtree_variable_bits,
        subtree_net_bits,
        subtree_signal_bits,
    )
}

fn derive_default_title(nodes: &[Node], root_id: usize, input_path: Option<&str>) -> Option<String> {
    if root_id != 0 {
        let root = &nodes[root_id];
        if !root.module.trim().is_empty() {
            return Some(format!("{} Hierarchy", root.module.trim()));
        }
        if !root.name.trim().is_empty() {
            return Some(format!("{} Hierarchy", root.name.trim()));
        }
    }

    input_path.and_then(derive_title_from_path)
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
