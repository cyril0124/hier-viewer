use crate::model::ViewerData;

pub(crate) fn render_data_json(data: &ViewerData) -> String {
    build_data_json(data)
}

fn build_data_json(data: &ViewerData) -> String {
    let mut json = String::new();
    json.push('{');
    push_json_field(&mut json, "title", &json_string(&data.title), false);
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
    json.push_str(",\"analysisDefinitions\":[");
    for (index, definition) in data.analysis_definitions.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('{');
        push_json_field(
            &mut json,
            "definitionKey",
            &definition.definition_key.to_string(),
            false,
        );
        json.push_str(",\"signalStats\":[");
        for (stat_index, stat) in definition.signal_stats.iter().enumerate() {
            if stat_index > 0 {
                json.push(',');
            }
            json.push('{');
            push_json_field(&mut json, "signalName", &json_string(&stat.signal_name), false);
            push_json_field(&mut json, "signalKind", &json_string(&stat.signal_kind), true);
            push_json_field(&mut json, "signalCount", &stat.signal_count.to_string(), true);
            push_json_field(&mut json, "totalBits", &stat.total_bits.to_string(), true);
            json.push('}');
        }
        json.push_str("]}");
    }
    json.push(']');
    json.push_str(",\"nodes\":[");
    for (index, node) in data.nodes.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push('{');
        push_json_field(&mut json, "id", &node.id.to_string(), false);
        push_json_field(&mut json, "name", &json_string(&node.name), true);
        push_json_field(&mut json, "module", &json_string(&node.module), true);
        push_json_field(&mut json, "path", &json_string(&node.path), true);
        match node.definition_key {
            Some(definition_key) => {
                push_json_field(&mut json, "definitionKey", &definition_key.to_string(), true)
            }
            None => push_json_field(&mut json, "definitionKey", "null", true),
        }
        match node.parent {
            Some(parent) => push_json_field(&mut json, "parent", &parent.to_string(), true),
            None => push_json_field(&mut json, "parent", "null", true),
        }
        push_json_field(&mut json, "depth", &node.depth.to_string(), true);
        push_json_field(
            &mut json,
            "subtreeInstances",
            &node.subtree_instances.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "subtreeLeaves",
            &node.subtree_leaves.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "subtreeSignalCount",
            &node.subtree_signal_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "subtreeInternalSignalCount",
            &node.subtree_internal_signal_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "subtreeGenSignalCount",
            &node.subtree_gen_signal_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "subtreeVariableBits",
            &node.subtree_variable_bits.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "subtreeNetBits",
            &node.subtree_net_bits.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "subtreeSignalBits",
            &node.subtree_signal_bits.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "modulePortCount",
            &node.module_port_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleLogicCount",
            &node.module_logic_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleRegCount",
            &node.module_reg_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleWireCount",
            &node.module_wire_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleVariableCount",
            &node.module_variable_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleNetCount",
            &node.module_net_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleSignalCount",
            &node.module_signal_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleVariableBits",
            &node.module_variable_bits.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleNetBits",
            &node.module_net_bits.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleSignalBits",
            &node.module_signal_bits.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleInternalSignalCount",
            &node.module_internal_signal_count.to_string(),
            true,
        );
        push_json_field(
            &mut json,
            "moduleGenSignalCount",
            &node.module_gen_signal_count.to_string(),
            true,
        );
        match node.file_path.as_ref() {
            Some(file_path) => {
                push_json_field(&mut json, "filePath", &json_string(file_path), true)
            }
            None => push_json_field(&mut json, "filePath", "null", true),
        }
        match node.source_href.as_ref() {
            Some(source_href) => {
                push_json_field(&mut json, "sourceHref", &json_string(source_href), true)
            }
            None => push_json_field(&mut json, "sourceHref", "null", true),
        }
        match node.definition_file_path.as_ref() {
            Some(file_path) => {
                push_json_field(&mut json, "definitionFilePath", &json_string(file_path), true)
            }
            None => push_json_field(&mut json, "definitionFilePath", "null", true),
        }
        match node.definition_source_href.as_ref() {
            Some(source_href) => {
                push_json_field(
                    &mut json,
                    "definitionSourceHref",
                    &json_string(source_href),
                    true,
                )
            }
            None => push_json_field(&mut json, "definitionSourceHref", "null", true),
        }
        match node.line {
            Some(line) => push_json_field(&mut json, "line", &line.to_string(), true),
            None => push_json_field(&mut json, "line", "null", true),
        }
        match node.column {
            Some(column) => push_json_field(&mut json, "column", &column.to_string(), true),
            None => push_json_field(&mut json, "column", "null", true),
        }
        match node.end_line {
            Some(end_line) => push_json_field(&mut json, "endLine", &end_line.to_string(), true),
            None => push_json_field(&mut json, "endLine", "null", true),
        }
        match node.end_column {
            Some(end_column) => {
                push_json_field(&mut json, "endColumn", &end_column.to_string(), true)
            }
            None => push_json_field(&mut json, "endColumn", "null", true),
        }
        match node.definition_line {
            Some(line) => push_json_field(&mut json, "definitionLine", &line.to_string(), true),
            None => push_json_field(&mut json, "definitionLine", "null", true),
        }
        match node.definition_column {
            Some(column) => {
                push_json_field(&mut json, "definitionColumn", &column.to_string(), true)
            }
            None => push_json_field(&mut json, "definitionColumn", "null", true),
        }
        match node.definition_end_line {
            Some(end_line) => {
                push_json_field(&mut json, "definitionEndLine", &end_line.to_string(), true)
            }
            None => push_json_field(&mut json, "definitionEndLine", "null", true),
        }
        match node.definition_end_column {
            Some(end_column) => {
                push_json_field(&mut json, "definitionEndColumn", &end_column.to_string(), true)
            }
            None => push_json_field(&mut json, "definitionEndColumn", "null", true),
        }
        json.push_str(",\"children\":[");
        for (child_index, child_id) in node.children.iter().enumerate() {
            if child_index > 0 {
                json.push(',');
            }
            json.push_str(&child_id.to_string());
        }
        json.push_str("]}");
    }
    json.push_str("]}");
    json
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
