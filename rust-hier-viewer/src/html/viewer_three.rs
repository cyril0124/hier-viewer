const VIEWER_THREE_MODULE: &str = include_str!("vendor/three.module.js");
const VIEWER_THREE_CORE: &str = include_str!("vendor/three.core.js");

pub(crate) fn render_three_js() -> &'static str {
    VIEWER_THREE_MODULE
}

pub(crate) fn render_three_core_js() -> &'static str {
    VIEWER_THREE_CORE
}
