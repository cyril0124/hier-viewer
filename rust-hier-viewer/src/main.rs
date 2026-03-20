mod cli;
mod html;
mod input;
mod launcher;
mod model;
mod viewer;
mod wizard;

use std::fs;
use std::io::IsTerminal;
use std::path::Path;
use std::process;

use cli::parse_args;
use html::{render_chart_js, render_data_json, render_html, render_three_core_js, render_three_js};
use input::load_input_data;
use launcher::{FileIndex, PatternMode, StartupSelection, run_hier_viewer_export};
use viewer::build_viewer_data;

const INDEX_HTML_NAME: &str = "index.html";
const VIEWER_DATA_NAME: &str = "viewer-data.json";
const VIEWER_CHART_NAME: &str = "viewer-chart.js";
const VIEWER_THREE_NAME: &str = "viewer-three.module.js";
const VIEWER_THREE_CORE_NAME: &str = "three.core.js";

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut config = parse_args(std::env::args().skip(1))?;
    let interactive_terminal = std::io::stdin().is_terminal();
    if config.input_path.is_none()
        && !has_source_inputs(&config)
        && interactive_terminal
        && config.no_wizard
    {
        return Err(
            "--no-wizard was set but no --input/--rtl-path/--filelist was provided".to_string(),
        );
    }

    let needs_export_selection =
        config.input_path.is_none() && (interactive_terminal || has_source_inputs(&config));
    let startup_selection = if needs_export_selection {
        let file_index = FileIndex::build()?;
        if has_source_inputs(&config) {
            let selection = StartupSelection {
                output_dir: config
                    .output_path
                    .clone()
                    .ok_or_else(|| "--output <dir> is required when using --rtl-path/--filelist".to_string())?,
                title: config.title.clone(),
                source_args_tokens: file_index.build_source_args(
                    &config.rtl_paths,
                    PatternMode::Wildcard,
                    &config.filelists,
                )?,
                extra_args_tokens: config.extra_args_tokens.clone(),
                install_pyslang: config.install_pyslang,
                rebuild_sqlite: config.rebuild_sqlite,
            };
            Some(selection)
        } else if !config.no_wizard {
            let mut selection = wizard::run_startup_wizard(&config, &file_index)?;
            selection.install_pyslang = config.install_pyslang;
            selection.rebuild_sqlite = config.rebuild_sqlite;
            config.output_path = Some(selection.output_dir.clone());
            config.title = selection.title.clone();
            Some(selection)
        } else {
            None
        }
    } else {
        None
    };

    let output_dir = config
        .output_path
        .clone()
        .ok_or_else(|| "--output <dir> is required in bundle mode".to_string())?;
    if matches!(
        Path::new(&output_dir)
            .extension()
            .and_then(|ext| ext.to_str()),
        Some("html" | "htm")
    ) {
        return Err(format!(
            "bundle mode requires an output directory, not an HTML file path: '{}'",
            output_dir
        ));
    }

    eprintln!("Loading hierarchy input...");
    let input_data = match startup_selection.as_ref() {
        Some(selection) => {
            let export = run_hier_viewer_export(selection)?;
            let result = load_input_data(Some(&export.sqlite_path));
            if export.temporary {
                let _ = fs::remove_file(&export.sqlite_path);
            }
            result?
        }
        None => load_input_data(config.input_path.as_deref())?,
    };
    eprintln!("Building viewer model...");
    let data = build_viewer_data(input_data, &config)?;
    eprintln!("Rendering HTML bundle assets...");
    let html = render_html(&data);
    let data_json = render_data_json(&data);
    let chart_js = render_chart_js();
    let three_js = render_three_js();
    let three_core_js = render_three_core_js();
    eprintln!("Writing bundle files into '{}'...", output_dir);
    write_bundle(&output_dir, &html, &data_json, chart_js, three_js, three_core_js)?;
    eprintln!("Bundle generation finished.");

    Ok(())
}

fn has_source_inputs(config: &model::Config) -> bool {
    !config.rtl_paths.is_empty() || !config.filelists.is_empty()
}

fn write_bundle(
    output_dir: &str,
    index_html: &str,
    data_json: &str,
    chart_js: &str,
    three_js: &str,
    three_core_js: &str,
) -> Result<(), String> {
    let output_dir = Path::new(output_dir);
    fs::create_dir_all(output_dir).map_err(|err| {
        format!(
            "failed to create output directory '{}': {err}",
            output_dir.display()
        )
    })?;

    let index_path = output_dir.join(INDEX_HTML_NAME);
    fs::write(&index_path, index_html).map_err(|err| {
        format!(
            "failed to write bundle index '{}': {err}",
            index_path.display()
        )
    })?;

    let data_path = output_dir.join(VIEWER_DATA_NAME);
    fs::write(&data_path, data_json).map_err(|err| {
        format!(
            "failed to write viewer data '{}': {err}",
            data_path.display()
        )
    })?;

    let chart_path = output_dir.join(VIEWER_CHART_NAME);
    fs::write(&chart_path, chart_js).map_err(|err| {
        format!(
            "failed to write chart asset '{}': {err}",
            chart_path.display()
        )
    })?;

    let three_path = output_dir.join(VIEWER_THREE_NAME);
    fs::write(&three_path, three_js).map_err(|err| {
        format!(
            "failed to write Three.js asset '{}': {err}",
            three_path.display()
        )
    })?;

    let three_core_path = output_dir.join(VIEWER_THREE_CORE_NAME);
    fs::write(&three_core_path, three_core_js).map_err(|err| {
        format!(
            "failed to write Three.js core asset '{}': {err}",
            three_core_path.display()
        )
    })?;

    Ok(())
}
