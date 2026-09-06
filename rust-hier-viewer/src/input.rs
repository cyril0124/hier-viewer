use std::fs::File;
use std::io::Read;

use rusqlite::Connection;

use crate::logging::info;
use crate::model::{AnalysisDefinition, DefinitionSignalStat, Entry, InputData};

const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

pub(crate) fn load_input_data(path: &str) -> Result<InputData, String> {
    if !is_sqlite_file(path)? {
        return Err(format!(
            "input '{}' is not a sqlite hierarchy DB; use --db for prebuilt sqlite or pass RTL inputs to build one",
            path
        ));
    }
    parse_sqlite_input(path)
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
