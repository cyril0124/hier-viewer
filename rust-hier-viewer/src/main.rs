mod cli;
mod coverage_bundle;
mod coverage_cache;
mod coverage_import;
mod html;
mod input;
mod interrupt;
mod launcher;
mod logging;
mod model;
mod preview;
mod schematic;
mod schematic_service;
mod updater;
mod viewer;
mod wizard;

use std::fs;
use std::io::IsTerminal;
use std::path::Path;
use std::process;

use cli::parse_args;
use coverage_bundle::BundledCoverage;
use html::{
    render_analysis_bin, render_chart_js, render_core_bin, render_coverage_js, render_html,
    render_meta_json, render_schematic_js, render_schematic_worker_js, render_three_core_js,
    render_three_js,
};
use input::load_input_data;
use launcher::{FileIndex, PatternMode, StartupSelection, run_hier_viewer_export};
use logging::{error, info};
use model::{AppCommand, Config, Node};
use preview::serve_output_dir;
use schematic::SchematicData;
use updater::run_update;
use viewer::build_viewer_data;

const INDEX_HTML_NAME: &str = "index.html";
const VIEWER_META_NAME: &str = "viewer-meta.json";
const VIEWER_CORE_NAME: &str = "viewer-core.bin";
const VIEWER_ANALYSIS_NAME: &str = "viewer-analysis.bin";
const VIEWER_CHART_NAME: &str = "viewer-chart.js";
const VIEWER_COVERAGE_NAME: &str = "viewer-coverage.js";
const VIEWER_SCHEMATIC_NAME: &str = "viewer-schematic.js";
const VIEWER_SCHEMATIC_WORKER_NAME: &str = "viewer-schematic-worker.js";
const VIEWER_THREE_NAME: &str = "viewer-three.module.js";
const VIEWER_THREE_CORE_NAME: &str = "three.core.js";

struct BundleAssets<'a> {
    index_html: &'a str,
    meta_json: &'a str,
    core_bin: &'a [u8],
    analysis_bin: Option<&'a [u8]>,
    chart_js: &'a str,
    coverage_js: &'a str,
    schematic_js: &'a str,
    schematic_worker_js: &'a str,
    schematic: Option<&'a SchematicData>,
    nodes: &'a [Node],
    three_js: &'a str,
    three_core_js: &'a str,
}

fn main() {
    if let Err(err) = run() {
        error("hier-viewer", err);
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match parse_args(std::env::args().skip(1))? {
        AppCommand::Generate(config) => run_generate(config),
        AppCommand::Serve(config) => serve_output_dir(
            &config.output_path,
            &config.host,
            config.port,
            std::io::stdin().is_terminal(),
        ),
        AppCommand::Update(config) => run_update(&config),
    }
}

fn run_generate(mut config: Config) -> Result<(), String> {
    let interactive_terminal = std::io::stdin().is_terminal();
    if config.db_path.is_none()
        && !has_source_inputs(&config)
        && interactive_terminal
        && config.no_wizard
    {
        return Err(
            "--no-wizard was set but no --db, RTL positional input, or --filelist was provided"
                .to_string(),
        );
    }
    if config.db_path.is_none() && !has_source_inputs(&config) && !interactive_terminal {
        return Err(
            "no input source was provided; pass RTL positional inputs, --filelist, or --db"
                .to_string(),
        );
    }

    let needs_export_selection =
        config.db_path.is_none() && (interactive_terminal || has_source_inputs(&config));
    let mut startup_selection = if needs_export_selection {
        if has_source_inputs(&config) {
            let file_index = FileIndex::for_inputs(&config.rtl_inputs)?;
            let selection = StartupSelection {
                output_dir: config.output_path.clone().ok_or_else(|| {
                    "--output <dir> is required when using RTL positional inputs or --filelist"
                        .to_string()
                })?,
                title: config.title.clone(),
                source_args_tokens: file_index.build_source_args(
                    &config.rtl_inputs,
                    PatternMode::Wildcard,
                    &config.filelists,
                )?,
                extra_args_tokens: config.extra_args_tokens.clone(),
                rebuild_sqlite: config.rebuild_sqlite,
            };
            Some(selection)
        } else if !config.no_wizard {
            let file_index = FileIndex::build()?;
            let mut selection = wizard::run_startup_wizard(&config, &file_index)?;
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

    if config.schematic
        && let Some(selection) = startup_selection.as_mut()
    {
        selection.extra_args_tokens.push("--schematic".to_string());
    }

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

    let coverage = config
        .coverage
        .as_ref()
        .map(|coverage| BundledCoverage::prepare(coverage, Path::new(&output_dir)))
        .transpose()?;

    info("hier-viewer", "Loading hierarchy input...");
    let (sqlite_path, temporary) = match startup_selection.as_ref() {
        Some(selection) => {
            let export = run_hier_viewer_export(selection)?;
            (export.sqlite_path, export.temporary)
        }
        None => (
            config
                .db_path
                .clone()
                .ok_or_else(|| "missing --db path".to_string())?,
            false,
        ),
    };
    let input_data = load_input_data(&sqlite_path, config.schematic)?;
    info("hier-viewer", "Building viewer model...");
    let mut data = build_viewer_data(input_data, &config)?;
    if config.schematic && data.schematic.is_none() {
        return Err("--schematic requires connectivity data. Regenerate the input from RTL with --schematic.".into());
    }
    data.schematic_on_demand = schematic_service::prepare(
        Path::new(&output_dir),
        Path::new(&sqlite_path),
        startup_selection.as_ref(),
        &data.nodes,
        config.schematic,
    )?;
    if temporary {
        let _ = fs::remove_file(&sqlite_path);
    }
    info("hier-viewer", "Rendering HTML bundle assets...");
    let html = render_html(&data, coverage.as_ref().map(BundledCoverage::manifest_url));
    let meta_json = render_meta_json(&data);
    let core_bin = render_core_bin(&data)?;
    let analysis_bin = render_analysis_bin(&data)?;
    let chart_js = render_chart_js();
    let three_js = render_three_js();
    let three_core_js = render_three_core_js();
    info(
        "hier-viewer",
        format!("Writing bundle files into '{}'", output_dir),
    );
    let assets = BundleAssets {
        index_html: &html,
        meta_json: &meta_json,
        core_bin: &core_bin,
        analysis_bin: analysis_bin.as_deref(),
        chart_js,
        coverage_js: render_coverage_js(),
        schematic_js: render_schematic_js(),
        schematic_worker_js: render_schematic_worker_js(),
        schematic: data.schematic.as_ref(),
        nodes: &data.nodes,
        three_js,
        three_core_js,
    };
    write_bundle(&output_dir, &assets)?;
    // Release staged schematic JSON before entering a long-lived preview server.
    drop(data);
    if let Some(coverage) = coverage {
        info(
            "hier-viewer",
            format!(
                "Bundled coverage: {} (mapped when the page loads)",
                coverage.manifest_url()
            ),
        );
        coverage.persist();
    }
    info("hier-viewer", "Bundle generation finished.");
    if config.preview {
        serve_output_dir(
            &output_dir,
            &config.preview_host,
            config.preview_port,
            interactive_terminal,
        )?;
    } else {
        let entry_path = Path::new(&output_dir).join(INDEX_HTML_NAME);
        info(
            "hier-viewer",
            format!(
                "Bundle entry point: '{}'. Re-run with --preview for built-in local serving.",
                entry_path.display()
            ),
        );
    }

    Ok(())
}

fn has_source_inputs(config: &model::Config) -> bool {
    !config.rtl_inputs.is_empty() || !config.filelists.is_empty()
}

fn write_bundle(output_dir: &str, assets: &BundleAssets<'_>) -> Result<(), String> {
    let output_dir = Path::new(output_dir);
    fs::create_dir_all(output_dir).map_err(|err| {
        format!(
            "failed to create output directory '{}': {err}",
            output_dir.display()
        )
    })?;

    let index_path = output_dir.join(INDEX_HTML_NAME);
    fs::write(&index_path, assets.index_html).map_err(|err| {
        format!(
            "failed to write bundle index '{}': {err}",
            index_path.display()
        )
    })?;

    let meta_path = output_dir.join(VIEWER_META_NAME);
    fs::write(&meta_path, assets.meta_json).map_err(|err| {
        format!(
            "failed to write viewer metadata '{}': {err}",
            meta_path.display()
        )
    })?;

    let core_path = output_dir.join(VIEWER_CORE_NAME);
    fs::write(&core_path, assets.core_bin).map_err(|err| {
        format!(
            "failed to write viewer core '{}': {err}",
            core_path.display()
        )
    })?;

    let analysis_path = output_dir.join(VIEWER_ANALYSIS_NAME);
    if let Some(binary) = assets.analysis_bin {
        fs::write(&analysis_path, binary).map_err(|err| {
            format!(
                "failed to write viewer analysis '{}': {err}",
                analysis_path.display()
            )
        })?;
    } else if analysis_path.exists() {
        let _ = fs::remove_file(&analysis_path);
    }

    let chart_path = output_dir.join(VIEWER_CHART_NAME);
    fs::write(&chart_path, assets.chart_js).map_err(|err| {
        format!(
            "failed to write chart asset '{}': {err}",
            chart_path.display()
        )
    })?;

    let coverage_path = output_dir.join(VIEWER_COVERAGE_NAME);
    fs::write(&coverage_path, assets.coverage_js).map_err(|err| {
        format!(
            "failed to write viewer coverage '{}': {err}",
            coverage_path.display()
        )
    })?;

    for (name, script) in [
        (VIEWER_SCHEMATIC_NAME, assets.schematic_js),
        (VIEWER_SCHEMATIC_WORKER_NAME, assets.schematic_worker_js),
    ] {
        let path = output_dir.join(name);
        fs::write(&path, script).map_err(|err| {
            format!(
                "failed to write schematic asset '{}': {err}",
                path.display()
            )
        })?;
    }
    if let Some(schematic) = assets.schematic {
        schematic.write_bundle(output_dir, assets.nodes)?;
    }

    let three_path = output_dir.join(VIEWER_THREE_NAME);
    fs::write(&three_path, assets.three_js).map_err(|err| {
        format!(
            "failed to write Three.js asset '{}': {err}",
            three_path.display()
        )
    })?;

    let three_core_path = output_dir.join(VIEWER_THREE_CORE_NAME);
    fs::write(&three_core_path, assets.three_core_js).map_err(|err| {
        format!(
            "failed to write Three.js core asset '{}': {err}",
            three_core_path.display()
        )
    })?;

    Ok(())
}
