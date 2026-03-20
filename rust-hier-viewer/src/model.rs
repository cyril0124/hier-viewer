#[derive(Clone, Debug)]
pub(crate) struct DefinitionSignalStat {
    pub(crate) signal_name: String,
    pub(crate) signal_kind: String,
    pub(crate) signal_count: usize,
    pub(crate) total_bits: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct AnalysisDefinition {
    pub(crate) definition_key: usize,
    pub(crate) signal_stats: Vec<DefinitionSignalStat>,
}

#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub(crate) path: String,
    pub(crate) module: String,
    pub(crate) definition_key: Option<usize>,
    pub(crate) file_path: Option<String>,
    pub(crate) source_href: Option<String>,
    pub(crate) definition_file_path: Option<String>,
    pub(crate) definition_source_href: Option<String>,
    pub(crate) line: Option<usize>,
    pub(crate) column: Option<usize>,
    pub(crate) end_line: Option<usize>,
    pub(crate) end_column: Option<usize>,
    pub(crate) definition_line: Option<usize>,
    pub(crate) definition_column: Option<usize>,
    pub(crate) definition_end_line: Option<usize>,
    pub(crate) definition_end_column: Option<usize>,
    pub(crate) module_port_count: usize,
    pub(crate) module_logic_count: usize,
    pub(crate) module_reg_count: usize,
    pub(crate) module_wire_count: usize,
    pub(crate) module_variable_count: usize,
    pub(crate) module_net_count: usize,
    pub(crate) module_signal_count: usize,
    pub(crate) module_variable_bits: usize,
    pub(crate) module_net_bits: usize,
    pub(crate) module_signal_bits: usize,
    pub(crate) module_internal_signal_count: usize,
    pub(crate) module_gen_signal_count: usize,
    pub(crate) snippet_start_line: Option<usize>,
    pub(crate) snippet_end_line: Option<usize>,
    pub(crate) snippet_text: Option<String>,
    pub(crate) definition_snippet_start_line: Option<usize>,
    pub(crate) definition_snippet_end_line: Option<usize>,
    pub(crate) definition_snippet_text: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct Node {
    pub(crate) id: usize,
    pub(crate) name: String,
    pub(crate) module: String,
    pub(crate) path: String,
    pub(crate) definition_key: Option<usize>,
    pub(crate) parent: Option<usize>,
    pub(crate) children: Vec<usize>,
    pub(crate) depth: usize,
    pub(crate) subtree_instances: usize,
    pub(crate) subtree_leaves: usize,
    pub(crate) subtree_signal_count: usize,
    pub(crate) subtree_internal_signal_count: usize,
    pub(crate) subtree_gen_signal_count: usize,
    pub(crate) subtree_variable_bits: usize,
    pub(crate) subtree_net_bits: usize,
    pub(crate) subtree_signal_bits: usize,
    pub(crate) module_port_count: usize,
    pub(crate) module_logic_count: usize,
    pub(crate) module_reg_count: usize,
    pub(crate) module_wire_count: usize,
    pub(crate) module_variable_count: usize,
    pub(crate) module_net_count: usize,
    pub(crate) module_signal_count: usize,
    pub(crate) module_variable_bits: usize,
    pub(crate) module_net_bits: usize,
    pub(crate) module_signal_bits: usize,
    pub(crate) module_internal_signal_count: usize,
    pub(crate) module_gen_signal_count: usize,
    pub(crate) file_path: Option<String>,
    pub(crate) source_href: Option<String>,
    pub(crate) definition_file_path: Option<String>,
    pub(crate) definition_source_href: Option<String>,
    pub(crate) line: Option<usize>,
    pub(crate) column: Option<usize>,
    pub(crate) end_line: Option<usize>,
    pub(crate) end_column: Option<usize>,
    pub(crate) definition_line: Option<usize>,
    pub(crate) definition_column: Option<usize>,
    pub(crate) definition_end_line: Option<usize>,
    pub(crate) definition_end_column: Option<usize>,
    pub(crate) snippet_start_line: Option<usize>,
    pub(crate) snippet_end_line: Option<usize>,
    pub(crate) snippet_text: Option<String>,
    pub(crate) definition_snippet_start_line: Option<usize>,
    pub(crate) definition_snippet_end_line: Option<usize>,
    pub(crate) definition_snippet_text: Option<String>,
}

#[derive(Debug)]
pub(crate) struct InputData {
    pub(crate) entries: Vec<Entry>,
    pub(crate) analysis_definitions: Vec<AnalysisDefinition>,
}

#[derive(Debug)]
pub(crate) struct ViewerData {
    pub(crate) title: String,
    pub(crate) built_at_unix_ms: u64,
    pub(crate) debug_ui_labels: bool,
    pub(crate) nodes: Vec<Node>,
    pub(crate) root_id: usize,
    pub(crate) default_metric: &'static str,
    pub(crate) analysis_definitions: Vec<AnalysisDefinition>,
}

#[derive(Debug)]
pub(crate) struct Config {
    pub(crate) input_path: Option<String>,
    pub(crate) output_path: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) no_wizard: bool,
    pub(crate) install_pyslang: bool,
    pub(crate) rebuild_sqlite: bool,
    pub(crate) rtl_paths: Vec<String>,
    pub(crate) filelists: Vec<String>,
    pub(crate) extra_args_tokens: Vec<String>,
    pub(crate) initial_metric: &'static str,
    pub(crate) exclude_wildcards: Vec<String>,
    pub(crate) exclude_regexes: Vec<String>,
    pub(crate) debug: bool,
}
