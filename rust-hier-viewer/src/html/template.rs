use crate::model::ViewerData;

const TEMPLATE: &str = include_str!("template.html");
const TEMPLATE_STYLES: &str = include_str!("template_styles.css");
const TEMPLATE_BODY: &str = include_str!("template_body.html");
const TEMPLATE_APP: &str = include_str!("generated/viewer-app.js");

pub(crate) fn render_html(data: &ViewerData, coverage_manifest: Option<&str>) -> String {
    let escaped_title = html_escape(&data.title);
    let styles = trim_single_trailing_newline(TEMPLATE_STYLES);
    let body = trim_single_trailing_newline(TEMPLATE_BODY);
    let app = trim_single_trailing_newline(TEMPLATE_APP);
    let mut html = TEMPLATE
        .replace("__TITLE__", &escaped_title)
        .replace("__INLINE_STYLES__", styles)
        .replace("__BODY_CONTENT__", body)
        .replace("__APP_SCRIPT__", app);
    if let Some(manifest) = coverage_manifest {
        html = html.replacen(
            "<body ",
            &format!(
                "<body data-coverage-manifest=\"{}\" ",
                html_escape(manifest)
            ),
            1,
        );
    }
    html
}

fn html_escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn trim_single_trailing_newline(text: &str) -> &str {
    text.strip_suffix('\n').unwrap_or(text)
}
