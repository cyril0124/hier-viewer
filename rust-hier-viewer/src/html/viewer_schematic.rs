const VIEWER_SCHEMATIC_SCRIPT: &str = include_str!("generated/viewer-schematic.js");
const VIEWER_SCHEMATIC_WORKER_SCRIPT: &str = include_str!("generated/viewer-schematic-worker.js");

pub(crate) fn render_schematic_js() -> &'static str {
    VIEWER_SCHEMATIC_SCRIPT
}

pub(crate) fn render_schematic_worker_js() -> &'static str {
    VIEWER_SCHEMATIC_WORKER_SCRIPT
}
