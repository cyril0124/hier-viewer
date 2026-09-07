const VIEWER_COVERAGE_SCRIPT: &str = include_str!("generated/viewer-coverage.js");

pub(crate) fn render_coverage_js() -> &'static str {
    VIEWER_COVERAGE_SCRIPT
}
