const VIEWER_CHART_SCRIPT: &str = include_str!("generated/viewer-chart.js");

pub(crate) fn render_chart_js() -> &'static str {
    VIEWER_CHART_SCRIPT
}
