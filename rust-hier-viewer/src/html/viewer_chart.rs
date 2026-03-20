const VIEWER_CHART_SCRIPT: &str = include_str!("viewer_chart.js");

pub(crate) fn render_chart_js() -> &'static str {
    VIEWER_CHART_SCRIPT
}
