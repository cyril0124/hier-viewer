use std::env;
use std::io::{self, IsTerminal};
use std::sync::OnceLock;

use time::macros::format_description;
use time::{OffsetDateTime, UtcOffset};

const TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");

#[derive(Clone, Copy)]
pub(crate) enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            LogLevel::Info => "INFO ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
        }
    }

    fn color_code(self) -> &'static str {
        match self {
            LogLevel::Info => "\x1b[36m",
            LogLevel::Warn => "\x1b[33m",
            LogLevel::Error => "\x1b[31m",
        }
    }
}

pub(crate) fn info(target: &str, message: impl AsRef<str>) {
    emit(LogLevel::Info, target, message.as_ref());
}

pub(crate) fn warn(target: &str, message: impl AsRef<str>) {
    emit(LogLevel::Warn, target, message.as_ref());
}

pub(crate) fn error(target: &str, message: impl AsRef<str>) {
    emit(LogLevel::Error, target, message.as_ref());
}

pub(crate) fn color_env_value() -> &'static str {
    if supports_color() {
        "always"
    } else {
        "never"
    }
}

fn emit(level: LogLevel, target: &str, message: &str) {
    if supports_color() {
        eprintln!(
            "\x1b[90m[{}]\x1b[0m {}[{}]\x1b[0m \x1b[35m[{}]\x1b[0m {}",
            timestamp_string(),
            level.color_code(),
            level.label(),
            target,
            message
        );
    } else {
        eprintln!(
            "[{}] [{}] [{}] {}",
            timestamp_string(),
            level.label(),
            target,
            message
        );
    }
}

fn timestamp_string() -> String {
    let now = local_now();
    now.format(TIMESTAMP_FORMAT)
        .unwrap_or_else(|_| "0000-00-00 00:00:00".to_string())
}

fn local_now() -> OffsetDateTime {
    let now_utc = OffsetDateTime::now_utc();
    match UtcOffset::current_local_offset() {
        Ok(offset) => now_utc.to_offset(offset),
        Err(_) => now_utc,
    }
}

fn supports_color() -> bool {
    static VALUE: OnceLock<bool> = OnceLock::new();
    *VALUE.get_or_init(detect_color_support)
}

fn detect_color_support() -> bool {
    if let Some(mode) = env::var_os("HIER_VIEWER_LOG_COLOR") {
        let mode = mode.to_string_lossy();
        if mode.eq_ignore_ascii_case("always") {
            return true;
        }
        if mode.eq_ignore_ascii_case("never") {
            return false;
        }
    }

    if env::var_os("NO_COLOR").is_some() {
        return false;
    }

    if let Some(value) = env::var_os("CLICOLOR_FORCE") {
        let value = value.to_string_lossy();
        if value != "0" {
            return true;
        }
    }
    if let Some(value) = env::var_os("FORCE_COLOR") {
        let value = value.to_string_lossy();
        if !value.is_empty() && value != "0" {
            return true;
        }
    }
    if let Some(value) = env::var_os("CLICOLOR") {
        let value = value.to_string_lossy();
        if value == "0" {
            return false;
        }
    }
    if let Some(value) = env::var_os("TERM")
        && value.to_string_lossy().eq_ignore_ascii_case("dumb")
    {
        return false;
    }

    io::stderr().is_terminal()
}
