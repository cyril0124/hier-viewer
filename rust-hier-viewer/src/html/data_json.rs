use std::collections::HashMap;

use crate::model::ViewerData;

const CORE_MAGIC: &[u8; 4] = b"HVC1";
const ANALYSIS_MAGIC: &[u8; 4] = b"HVA1";
const BUNDLE_VERSION: u32 = 1;

const META_CORE_FILE: &str = "viewer-core.bin";
const META_ANALYSIS_FILE: &str = "viewer-analysis.bin";

pub(crate) fn render_meta_json(data: &ViewerData) -> String {
    let mut json = String::new();
    json.push('{');
    push_json_field(&mut json, "formatVersion", &BUNDLE_VERSION.to_string(), false);
    push_json_field(&mut json, "title", &json_string(&data.title), true);
    push_json_field(
        &mut json,
        "builtAtUnixMs",
        &data.built_at_unix_ms.to_string(),
        true,
    );
    push_json_field(
        &mut json,
        "debugUiLabels",
        if data.debug_ui_labels { "true" } else { "false" },
        true,
    );
    push_json_field(&mut json, "rootId", &data.root_id.to_string(), true);
    push_json_field(
        &mut json,
        "defaultMetric",
        &json_string(data.default_metric),
        true,
    );
    push_json_field(&mut json, "nodeCount", &data.nodes.len().to_string(), true);
    push_json_field(&mut json, "coreFile", &json_string(META_CORE_FILE), true);
    if data.analysis_definitions.is_empty() {
        push_json_field(&mut json, "analysisFile", "null", true);
    } else {
        push_json_field(
            &mut json,
            "analysisFile",
            &json_string(META_ANALYSIS_FILE),
            true,
        );
        push_json_field(
            &mut json,
            "analysisDefinitionCount",
            &data.analysis_definitions.len().to_string(),
            true,
        );
    }
    json.push('}');
    json
}

pub(crate) fn render_core_bin(data: &ViewerData) -> Result<Vec<u8>, String> {
    let mut pool = StringPool::default();
    for node in &data.nodes {
        pool.intern(&node.name);
        pool.intern(&node.module);
        pool.intern_optional(node.file_path.as_deref());
        pool.intern_optional(node.source_href.as_deref());
        pool.intern_optional(node.definition_file_path.as_deref());
        pool.intern_optional(node.definition_source_href.as_deref());
    }

    let mut bytes = Vec::new();
    write_header(&mut bytes, CORE_MAGIC);
    pool.write(&mut bytes)?;
    push_len_u32(&mut bytes, data.nodes.len(), "node count")?;

    for node in &data.nodes {
        push_u32(&mut bytes, pool.lookup(&node.name)?);
    }
    for node in &data.nodes {
        push_u32(&mut bytes, pool.lookup(&node.module)?);
    }
    for node in &data.nodes {
        push_optional_u64_from_usize(&mut bytes, node.definition_key, "definition key")?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.parent, "parent id")?;
    }
    for node in &data.nodes {
        push_u32_from_usize(&mut bytes, node.subtree_instances, "subtree_instances")?;
    }
    for node in &data.nodes {
        push_u32_from_usize(&mut bytes, node.subtree_leaves, "subtree_leaves")?;
    }
    for node in &data.nodes {
        push_u32_from_usize(&mut bytes, node.subtree_signal_count, "subtree_signal_count")?;
    }
    for node in &data.nodes {
        push_u32_from_usize(
            &mut bytes,
            node.subtree_internal_signal_count,
            "subtree_internal_signal_count",
        )?;
    }
    for node in &data.nodes {
        push_u64_from_usize(&mut bytes, node.subtree_variable_bits, "subtree_variable_bits")?;
    }
    for node in &data.nodes {
        push_u64_from_usize(&mut bytes, node.subtree_net_bits, "subtree_net_bits")?;
    }
    for node in &data.nodes {
        push_u32_from_usize(&mut bytes, node.module_variable_count, "module_variable_count")?;
    }
    for node in &data.nodes {
        push_u32_from_usize(&mut bytes, node.module_net_count, "module_net_count")?;
    }
    for node in &data.nodes {
        push_u64_from_usize(&mut bytes, node.module_variable_bits, "module_variable_bits")?;
    }
    for node in &data.nodes {
        push_u64_from_usize(&mut bytes, node.module_net_bits, "module_net_bits")?;
    }
    for node in &data.nodes {
        push_u32_from_usize(
            &mut bytes,
            node.module_internal_signal_count,
            "module_internal_signal_count",
        )?;
    }
    for node in &data.nodes {
        push_optional_string_id(&mut bytes, &pool, node.file_path.as_deref())?;
    }
    for node in &data.nodes {
        push_optional_string_id(&mut bytes, &pool, node.source_href.as_deref())?;
    }
    for node in &data.nodes {
        push_optional_string_id(&mut bytes, &pool, node.definition_file_path.as_deref())?;
    }
    for node in &data.nodes {
        push_optional_string_id(&mut bytes, &pool, node.definition_source_href.as_deref())?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.line, "line")?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.column, "column")?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.end_line, "end_line")?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.end_column, "end_column")?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.definition_line, "definition_line")?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.definition_column, "definition_column")?;
    }
    for node in &data.nodes {
        push_optional_u32(&mut bytes, node.definition_end_line, "definition_end_line")?;
    }
    for node in &data.nodes {
        push_optional_u32(
            &mut bytes,
            node.definition_end_column,
            "definition_end_column",
        )?;
    }

    Ok(bytes)
}

pub(crate) fn render_analysis_bin(data: &ViewerData) -> Result<Option<Vec<u8>>, String> {
    if data.analysis_definitions.is_empty() {
        return Ok(None);
    }

    let mut pool = StringPool::default();
    for definition in &data.analysis_definitions {
        for stat in &definition.signal_stats {
            pool.intern(&stat.signal_name);
            pool.intern(&stat.signal_kind);
        }
    }

    let mut bytes = Vec::new();
    write_header(&mut bytes, ANALYSIS_MAGIC);
    pool.write(&mut bytes)?;
    push_len_u32(
        &mut bytes,
        data.analysis_definitions.len(),
        "analysis definition count",
    )?;

    for definition in &data.analysis_definitions {
        push_u64_from_usize(&mut bytes, definition.definition_key, "definition_key")?;
        push_len_u32(
            &mut bytes,
            definition.signal_stats.len(),
            "signal stat count per definition",
        )?;
        for stat in &definition.signal_stats {
            push_u32(&mut bytes, pool.lookup(&stat.signal_name)?);
            push_u32(&mut bytes, pool.lookup(&stat.signal_kind)?);
            push_u32_from_usize(&mut bytes, stat.signal_count, "signal_count")?;
            push_u64_from_usize(&mut bytes, stat.total_bits, "total_bits")?;
        }
    }

    Ok(Some(bytes))
}

fn write_header(bytes: &mut Vec<u8>, magic: &[u8; 4]) {
    bytes.extend_from_slice(magic);
    push_u32(bytes, BUNDLE_VERSION);
}

fn push_optional_string_id(
    bytes: &mut Vec<u8>,
    pool: &StringPool,
    value: Option<&str>,
) -> Result<(), String> {
    match value {
        Some(text) => {
            push_u32(bytes, pool.lookup(text)?);
            Ok(())
        }
        None => {
            push_u32(bytes, u32::MAX);
            Ok(())
        }
    }
}

fn push_len_u32(bytes: &mut Vec<u8>, value: usize, label: &str) -> Result<(), String> {
    let converted = u32::try_from(value)
        .map_err(|_| format!("{label} exceeds u32 range: {value}"))?;
    push_u32(bytes, converted);
    Ok(())
}

fn push_optional_u32(
    bytes: &mut Vec<u8>,
    value: Option<usize>,
    label: &str,
) -> Result<(), String> {
    match value {
        Some(raw) => push_u32_from_usize(bytes, raw, label),
        None => {
            push_u32(bytes, u32::MAX);
            Ok(())
        }
    }
}

fn push_optional_u64_from_usize(
    bytes: &mut Vec<u8>,
    value: Option<usize>,
    label: &str,
) -> Result<(), String> {
    match value {
        Some(raw) => push_u64_from_usize(bytes, raw, label),
        None => {
            push_u64(bytes, u64::MAX);
            Ok(())
        }
    }
}

fn push_u32_from_usize(bytes: &mut Vec<u8>, value: usize, label: &str) -> Result<(), String> {
    let converted =
        u32::try_from(value).map_err(|_| format!("{label} exceeds u32 range: {value}"))?;
    push_u32(bytes, converted);
    Ok(())
}

fn push_u64_from_usize(bytes: &mut Vec<u8>, value: usize, _label: &str) -> Result<(), String> {
    let converted = u64::try_from(value)
        .map_err(|_| format!("value exceeds u64 range: {value}"))?;
    push_u64(bytes, converted);
    Ok(())
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_json_field(buffer: &mut String, key: &str, value: &str, leading_comma: bool) {
    if leading_comma {
        buffer.push(',');
    }
    buffer.push('"');
    buffer.push_str(key);
    buffer.push_str("\":");
    buffer.push_str(value);
}

fn json_string(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len() + 2);
    escaped.push('"');
    for ch in text.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0C}' => escaped.push_str("\\f"),
            '<' => escaped.push_str("\\u003C"),
            '>' => escaped.push_str("\\u003E"),
            '&' => escaped.push_str("\\u0026"),
            ch if ch <= '\u{1F}' => {
                escaped.push_str(&format!("\\u{:04X}", ch as u32));
            }
            _ => escaped.push(ch),
        }
    }
    escaped.push('"');
    escaped
}

#[derive(Default)]
struct StringPool {
    ids: HashMap<String, u32>,
    values: Vec<String>,
}

impl StringPool {
    fn intern(&mut self, value: &str) -> u32 {
        if let Some(id) = self.ids.get(value) {
            return *id;
        }
        let id = self.values.len() as u32;
        self.values.push(value.to_string());
        self.ids.insert(value.to_string(), id);
        id
    }

    fn intern_optional(&mut self, value: Option<&str>) {
        if let Some(text) = value {
            self.intern(text);
        }
    }

    fn lookup(&self, value: &str) -> Result<u32, String> {
        self.ids
            .get(value)
            .copied()
            .ok_or_else(|| format!("string pool lookup missed value '{value}'"))
    }

    fn write(&self, bytes: &mut Vec<u8>) -> Result<(), String> {
        push_len_u32(bytes, self.values.len(), "string pool size")?;
        for value in &self.values {
            let raw = value.as_bytes();
            push_len_u32(bytes, raw.len(), "string byte length")?;
            bytes.extend_from_slice(raw);
        }
        Ok(())
    }
}
