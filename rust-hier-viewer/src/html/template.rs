use crate::model::ViewerData;

const TEMPLATE: &str = include_str!("template.html");

pub(crate) fn render_html(data: &ViewerData) -> String {
    TEMPLATE.replace("__TITLE__", &html_escape(&data.title))
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
