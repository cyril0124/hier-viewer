use std::fs::{self, File};
use std::io::{self, Read};

use csv::StringRecord;
use rusqlite::Connection;

use crate::logging::info;
use crate::model::{AnalysisDefinition, DefinitionSignalStat, Entry, InputData};

const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

pub(crate) fn load_input_data(path: Option<&str>) -> Result<InputData, String> {
    match path {
        Some(path) if is_sqlite_file(path)? => parse_sqlite_input(path),
        Some(path) => {
            let input = fs::read_to_string(path)
                .map_err(|err| format!("failed to read input file '{}': {err}", path))?;
            parse_text_input(&input)
        }
        None => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .map_err(|err| format!("failed to read stdin: {err}"))?;
            parse_text_input(&input)
        }
    }
}

fn is_sqlite_file(path: &str) -> Result<bool, String> {
    let mut file =
        File::open(path).map_err(|err| format!("failed to read input file '{}': {err}", path))?;
    let mut header = [0u8; SQLITE_HEADER.len()];
    let bytes_read = file
        .read(&mut header)
        .map_err(|err| format!("failed to read input file '{}': {err}", path))?;
    Ok(bytes_read == SQLITE_HEADER.len() && header == SQLITE_HEADER)
}

fn parse_text_input(input: &str) -> Result<InputData, String> {
    Ok(InputData {
        entries: parse_text_entries(input)?,
        analysis_definitions: Vec::new(),
    })
}

fn parse_text_entries(input: &str) -> Result<Vec<Entry>, String> {
    let first_non_empty = input
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");

    if first_non_empty.eq_ignore_ascii_case("path,module,file_path,line,column,end_line,end_column")
        || first_non_empty.starts_with("path,module,")
    {
        parse_csv_entries(input)
    } else {
        parse_plain_entries(input)
    }
}

fn parse_plain_entries(input: &str) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();

    for (idx, raw_line) in input.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line == "(empty hierarchy)" {
            continue;
        }

        let Some(start) = line.rfind(" <") else {
            return Err(format!(
                "line {} is not in '<hierpath> <module>' format: {}",
                idx + 1,
                raw_line
            ));
        };
        if !line.ends_with('>') {
            return Err(format!(
                "line {} is missing the closing '>': {}",
                idx + 1,
                raw_line
            ));
        }

        let path = line[..start].trim();
        let module = line[start + 2..line.len() - 1].trim();
        if path.is_empty() || module.is_empty() {
            return Err(format!(
                "line {} must contain both hierarchy path and module name: {}",
                idx + 1,
                raw_line
            ));
        }

        entries.push(Entry {
            path: path.to_string(),
            module: module.to_string(),
            definition_key: None,
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
            snippet_start_line: None,
            snippet_end_line: None,
            snippet_text: None,
            definition_snippet_start_line: None,
            definition_snippet_end_line: None,
            definition_snippet_text: None,
        });
    }

    Ok(entries)
}

fn parse_csv_entries(input: &str) -> Result<Vec<Entry>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(input.as_bytes());

    let headers = reader
        .headers()
        .map_err(|err| format!("failed to read CSV header: {err}"))?
        .clone();

    let path_index = header_index(&headers, "path")?;
    let module_index = header_index(&headers, "module")?;
    let file_path_index = headers.iter().position(|name| name == "file_path");
    let line_index = headers.iter().position(|name| name == "line");
    let column_index = headers.iter().position(|name| name == "column");
    let end_line_index = headers.iter().position(|name| name == "end_line");
    let end_column_index = headers.iter().position(|name| name == "end_column");
    let definition_file_path_index = headers.iter().position(|name| name == "definition_file_path");
    let definition_line_index = headers.iter().position(|name| name == "definition_line");
    let definition_column_index = headers.iter().position(|name| name == "definition_column");
    let definition_end_line_index = headers.iter().position(|name| name == "definition_end_line");
    let definition_end_column_index = headers.iter().position(|name| name == "definition_end_column");
    let module_port_count_index = headers.iter().position(|name| name == "module_port_count");
    let module_logic_count_index = headers.iter().position(|name| name == "module_logic_count");
    let module_reg_count_index = headers.iter().position(|name| name == "module_reg_count");
    let module_wire_count_index = headers.iter().position(|name| name == "module_wire_count");
    let module_variable_count_index = headers.iter().position(|name| name == "module_variable_count");
    let module_net_count_index = headers.iter().position(|name| name == "module_net_count");
    let module_signal_count_index = headers.iter().position(|name| name == "module_signal_count");
    let module_variable_bits_index = headers.iter().position(|name| name == "module_variable_bits");
    let module_net_bits_index = headers.iter().position(|name| name == "module_net_bits");
    let module_signal_bits_index = headers.iter().position(|name| name == "module_signal_bits");
    let module_internal_signal_count_index =
        headers.iter().position(|name| name == "module_internal_signal_count");
    let module_gen_signal_count_index =
        headers.iter().position(|name| name == "module_gen_signal_count");

    let mut entries = Vec::new();
    for (row_index, record) in reader.records().enumerate() {
        let record =
            record.map_err(|err| format!("failed to parse CSV row {}: {err}", row_index + 2))?;
        let path = required_csv_field(&record, path_index, "path", row_index + 2)?;
        let module = required_csv_field(&record, module_index, "module", row_index + 2)?;
        entries.push(Entry {
            path: path.to_string(),
            module: module.to_string(),
            definition_key: None,
            file_path: optional_csv_field(&record, file_path_index),
            source_href: None,
            definition_file_path: optional_csv_field(&record, definition_file_path_index),
            definition_source_href: None,
            line: parse_optional_usize(optional_csv_field(&record, line_index).as_deref(), "line", row_index + 2)?,
            column: parse_optional_usize(optional_csv_field(&record, column_index).as_deref(), "column", row_index + 2)?,
            end_line: parse_optional_usize(optional_csv_field(&record, end_line_index).as_deref(), "end_line", row_index + 2)?,
            end_column: parse_optional_usize(optional_csv_field(&record, end_column_index).as_deref(), "end_column", row_index + 2)?,
            definition_line: parse_optional_usize(optional_csv_field(&record, definition_line_index).as_deref(), "definition_line", row_index + 2)?,
            definition_column: parse_optional_usize(optional_csv_field(&record, definition_column_index).as_deref(), "definition_column", row_index + 2)?,
            definition_end_line: parse_optional_usize(optional_csv_field(&record, definition_end_line_index).as_deref(), "definition_end_line", row_index + 2)?,
            definition_end_column: parse_optional_usize(optional_csv_field(&record, definition_end_column_index).as_deref(), "definition_end_column", row_index + 2)?,
            module_port_count: parse_optional_usize(optional_csv_field(&record, module_port_count_index).as_deref(), "module_port_count", row_index + 2)?.unwrap_or(0),
            module_logic_count: parse_optional_usize(optional_csv_field(&record, module_logic_count_index).as_deref(), "module_logic_count", row_index + 2)?.unwrap_or(0),
            module_reg_count: parse_optional_usize(optional_csv_field(&record, module_reg_count_index).as_deref(), "module_reg_count", row_index + 2)?.unwrap_or(0),
            module_wire_count: parse_optional_usize(optional_csv_field(&record, module_wire_count_index).as_deref(), "module_wire_count", row_index + 2)?.unwrap_or(0),
            module_variable_count: parse_optional_usize(optional_csv_field(&record, module_variable_count_index).as_deref(), "module_variable_count", row_index + 2)?.unwrap_or(0),
            module_net_count: parse_optional_usize(optional_csv_field(&record, module_net_count_index).as_deref(), "module_net_count", row_index + 2)?.unwrap_or(0),
            module_signal_count: parse_optional_usize(optional_csv_field(&record, module_signal_count_index).as_deref(), "module_signal_count", row_index + 2)?.unwrap_or(0),
            module_variable_bits: parse_optional_usize(optional_csv_field(&record, module_variable_bits_index).as_deref(), "module_variable_bits", row_index + 2)?.unwrap_or(0),
            module_net_bits: parse_optional_usize(optional_csv_field(&record, module_net_bits_index).as_deref(), "module_net_bits", row_index + 2)?.unwrap_or(0),
            module_signal_bits: parse_optional_usize(optional_csv_field(&record, module_signal_bits_index).as_deref(), "module_signal_bits", row_index + 2)?.unwrap_or(0),
            module_internal_signal_count: parse_optional_usize(optional_csv_field(&record, module_internal_signal_count_index).as_deref(), "module_internal_signal_count", row_index + 2)?.unwrap_or(0),
            module_gen_signal_count: parse_optional_usize(optional_csv_field(&record, module_gen_signal_count_index).as_deref(), "module_gen_signal_count", row_index + 2)?.unwrap_or(0),
            snippet_start_line: None,
            snippet_end_line: None,
            snippet_text: None,
            definition_snippet_start_line: None,
            definition_snippet_end_line: None,
            definition_snippet_text: None,
        });
    }

    Ok(entries)
}

fn parse_sqlite_input(path: &str) -> Result<InputData, String> {
    let connection = Connection::open(path)
        .map_err(|err| format!("failed to open sqlite input '{}': {err}", path))?;

    let mut entries = Vec::new();
    let mut stmt = connection
        .prepare(
            "
            SELECT
                path, module, definition_key, file_path, line, column,
                end_line, end_column, definition_file_path, definition_line,
                definition_column, definition_end_line, definition_end_column,
                module_port_count, module_logic_count, module_reg_count,
                module_wire_count, module_variable_count, module_net_count,
                module_signal_count, module_variable_bits, module_net_bits,
                module_signal_bits, module_internal_signal_count, module_gen_signal_count
            FROM instances
            ORDER BY path
            ",
        )
        .map_err(|err| format!("failed to prepare sqlite instance query: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Entry {
                path: row.get::<_, String>(0)?,
                module: row.get::<_, String>(1)?,
                definition_key: row
                    .get::<_, Option<i64>>(2)?
                    .and_then(|value| usize::try_from(value).ok()),
                file_path: normalize_string(row.get::<_, String>(3)?),
                source_href: None,
                line: to_usize_opt(row.get::<_, Option<i64>>(4)?),
                column: to_usize_opt(row.get::<_, Option<i64>>(5)?),
                end_line: to_usize_opt(row.get::<_, Option<i64>>(6)?),
                end_column: to_usize_opt(row.get::<_, Option<i64>>(7)?),
                definition_file_path: normalize_string(row.get::<_, String>(8)?),
                definition_source_href: None,
                definition_line: to_usize_opt(row.get::<_, Option<i64>>(9)?),
                definition_column: to_usize_opt(row.get::<_, Option<i64>>(10)?),
                definition_end_line: to_usize_opt(row.get::<_, Option<i64>>(11)?),
                definition_end_column: to_usize_opt(row.get::<_, Option<i64>>(12)?),
                module_port_count: to_usize(row.get::<_, i64>(13)?)?,
                module_logic_count: to_usize(row.get::<_, i64>(14)?)?,
                module_reg_count: to_usize(row.get::<_, i64>(15)?)?,
                module_wire_count: to_usize(row.get::<_, i64>(16)?)?,
                module_variable_count: to_usize(row.get::<_, i64>(17)?)?,
                module_net_count: to_usize(row.get::<_, i64>(18)?)?,
                module_signal_count: to_usize(row.get::<_, i64>(19)?)?,
                module_variable_bits: to_usize(row.get::<_, i64>(20)?)?,
                module_net_bits: to_usize(row.get::<_, i64>(21)?)?,
                module_signal_bits: to_usize(row.get::<_, i64>(22)?)?,
                module_internal_signal_count: to_usize(row.get::<_, i64>(23)?)?,
                module_gen_signal_count: to_usize(row.get::<_, i64>(24)?)?,
                snippet_start_line: None,
                snippet_end_line: None,
                snippet_text: None,
                definition_snippet_start_line: None,
                definition_snippet_end_line: None,
                definition_snippet_text: None,
            })
        })
        .map_err(|err| format!("failed to query sqlite instances: {err}"))?;

    for row in rows {
        entries.push(row.map_err(|err| format!("failed to read sqlite instance row: {err}"))?);
    }

    let mut analysis_definitions = Vec::new();
    if sqlite_table_exists(&connection, "definition_signal_stats")? {
        let mut stats_stmt = connection
            .prepare(
                "
                SELECT definition_key, signal_name, signal_kind, signal_count, total_bits
                FROM definition_signal_stats
                ORDER BY definition_key, signal_name, signal_kind
                ",
            )
            .map_err(|err| format!("failed to prepare sqlite signal stats query: {err}"))?;
        let stat_rows = stats_stmt
            .query_map([], |row| {
                Ok((
                    to_usize(row.get::<_, i64>(0)?)?,
                    DefinitionSignalStat {
                        signal_name: row.get::<_, String>(1)?,
                        signal_kind: row.get::<_, String>(2)?,
                        signal_count: to_usize(row.get::<_, i64>(3)?)?,
                        total_bits: to_usize(row.get::<_, i64>(4)?)?,
                    },
                ))
            })
            .map_err(|err| format!("failed to query sqlite signal stats: {err}"))?;

        let mut current_key = None;
        let mut current_stats = Vec::new();
        for row in stat_rows {
            let (definition_key, signal_stat) =
                row.map_err(|err| format!("failed to read sqlite signal stat row: {err}"))?;
            if current_key != Some(definition_key) {
                if let Some(prev_key) = current_key.take() {
                    analysis_definitions.push(AnalysisDefinition {
                        definition_key: prev_key,
                        signal_stats: std::mem::take(&mut current_stats),
                    });
                }
                current_key = Some(definition_key);
            }
            current_stats.push(signal_stat);
        }
        if let Some(definition_key) = current_key {
            analysis_definitions.push(AnalysisDefinition {
                definition_key,
                signal_stats: current_stats,
            });
        }
    }

    info(
        "input",
        format!(
            "Loaded sqlite input: {} instances, {} analysis definition entries.",
            entries.len(),
            analysis_definitions.len()
        ),
    );

    Ok(InputData {
        entries,
        analysis_definitions,
    })
}

fn sqlite_table_exists(connection: &Connection, table_name: &str) -> Result<bool, String> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table_name],
            |row| row.get(0),
        )
        .map_err(|err| format!("failed to inspect sqlite schema: {err}"))?;
    Ok(count > 0)
}

fn normalize_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn to_usize(value: i64) -> Result<usize, rusqlite::Error> {
    usize::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn to_usize_opt(value: Option<i64>) -> Option<usize> {
    value.and_then(|raw| usize::try_from(raw).ok())
}

fn header_index(headers: &StringRecord, name: &str) -> Result<usize, String> {
    headers
        .iter()
        .position(|header| header == name)
        .ok_or_else(|| format!("CSV is missing required '{name}' column"))
}

fn required_csv_field<'a>(
    record: &'a StringRecord,
    index: usize,
    field_name: &str,
    row_number: usize,
) -> Result<&'a str, String> {
    let value = record
        .get(index)
        .map(str::trim)
        .ok_or_else(|| format!("CSV row {row_number} is missing '{field_name}'"))?;
    if value.is_empty() {
        return Err(format!("CSV row {row_number} has empty '{field_name}'"));
    }
    Ok(value)
}

fn optional_csv_field(record: &StringRecord, index: Option<usize>) -> Option<String> {
    let value = record.get(index?).map(str::trim)?;
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_optional_usize(
    value: Option<&str>,
    field_name: &str,
    row_number: usize,
) -> Result<Option<usize>, String> {
    match value {
        Some(raw) => raw
            .parse::<usize>()
            .map(Some)
            .map_err(|err| format!("CSV row {row_number} has invalid {field_name} '{raw}': {err}")),
        None => Ok(None),
    }
}
