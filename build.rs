use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use time::macros::format_description;
use time::{OffsetDateTime, UtcOffset};

const TIMESTAMP_FORMAT: &[time::format_description::FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");

const COLOR_RESET: &str = "\x1b[0m";
const COLOR_TIMESTAMP: &str = "\x1b[90m";
const COLOR_COMPONENT: &str = "\x1b[35m";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    emit_rerun_for_dir(Path::new("cpp-hier-exporter"));
    println!("cargo:rerun-if-env-changed=HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR");
    println!("cargo:rerun-if-env-changed=HIER_VIEWER_EXPORTER_FULLY_STATIC");
    println!("cargo:rerun-if-env-changed=HIER_VIEWER_LOG_COLOR");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is not set"));
    let build_dir = out_dir.join("cpp-hier-exporter-build");
    let source_dir = PathBuf::from("cpp-hier-exporter");

    fs::create_dir_all(&build_dir).expect("failed to create cpp exporter build dir");

    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let build_type = if profile.eq_ignore_ascii_case("release") {
        "Release"
    } else {
        "RelWithDebInfo"
    };

    let mut configure = Command::new("cmake");
    configure
        .arg("-S")
        .arg(&source_dir)
        .arg("-B")
        .arg(&build_dir)
        .arg("-G")
        .arg("Ninja")
        .arg(format!("-DCMAKE_BUILD_TYPE={build_type}"));

    if let Ok(value) = env::var("HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR")
        && !value.trim().is_empty()
    {
        configure.arg(format!("-DHIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR={value}"));
    }

    let fully_static = env::var("HIER_VIEWER_EXPORTER_FULLY_STATIC")
        .map(|value| !matches!(value.trim(), "0" | "false" | "False" | "FALSE"))
        .unwrap_or(true);
    configure.arg(format!(
        "-DHIER_VIEWER_EXPORTER_FULLY_STATIC={}",
        if fully_static { "ON" } else { "OFF" }
    ));

    let slang_source_desc = env::var("HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            "FetchContent(https://github.com/MikePopoloski/slang.git @ 168f65f)".to_string()
        });

    emit_build_log("INFO ", format!(
        "configuring slang-hier-exporter: build_type={build_type}, static={}, slang_source={}",
        if fully_static { "ON" } else { "OFF" },
        slang_source_desc
    ));
    let configure_started = Instant::now();
    run_command(configure, "failed to configure C++ slang exporter");
    emit_build_log("INFO ", format!(
        "configured slang-hier-exporter in {:.1}s",
        configure_started.elapsed().as_secs_f64()
    ));

    let mut build = Command::new("cmake");
    build
        .arg("--build")
        .arg(&build_dir)
        .arg("--target")
        .arg("slang-hier-exporter");
    emit_build_log("INFO ", "building slang-hier-exporter with cmake --build".to_string());
    let build_started = Instant::now();
    run_command(build, "failed to build C++ slang exporter");
    emit_build_log("INFO ", format!(
        "built slang-hier-exporter in {:.1}s",
        build_started.elapsed().as_secs_f64()
    ));

    let built_binary = build_dir.join("out").join("bin").join("slang-hier-exporter");
    if !built_binary.is_file() {
        panic!(
            "C++ slang exporter was built but '{}' does not exist",
            built_binary.display()
        );
    }

    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("failed to derive target profile directory")
        .to_path_buf();
    let sibling_binary = profile_dir.join("slang-hier-exporter");
    emit_build_log("INFO ", format!(
        "copying slang-hier-exporter to '{}'",
        sibling_binary.display()
    ));
    fs::copy(&built_binary, &sibling_binary).unwrap_or_else(|err| {
        panic!(
            "failed to copy C++ slang exporter from '{}' to '{}': {err}",
            built_binary.display(),
            sibling_binary.display()
        )
    });

    println!(
        "cargo:rustc-env=HIER_VIEWER_EXPORTER_BUILD_PATH={}",
        sibling_binary.display()
    );
    emit_build_log("INFO ", format!(
        "slang-hier-exporter is ready at '{}'",
        sibling_binary.display()
    ));
}

fn emit_rerun_for_dir(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                emit_rerun_for_dir(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn run_command(mut command: Command, context: &str) {
    let status = command.status().unwrap_or_else(|err| {
        emit_build_log("ERROR", format!("{context}: {err}"));
        panic!("{context}: {err}");
    });
    if !status.success() {
        emit_build_log("ERROR", format!("{context}: exited with status {status}"));
        panic!("{context}: exited with status {status}");
    }
}

fn emit_build_log(level: &str, message: String) {
    let timestamp = timestamp_string();
    let component = "build.rs";
    let rendered = if supports_color() {
        format!(
            "{COLOR_TIMESTAMP}[{timestamp}]{COLOR_RESET} {}[{level}]{COLOR_RESET} {COLOR_COMPONENT}[{component}]{COLOR_RESET} {message}",
            level_color(level)
        )
    } else {
        format!("[{timestamp}] [{level}] [{component}] {message}")
    };
    eprintln!("{rendered}");
}

fn timestamp_string() -> String {
    let now_utc = OffsetDateTime::now_utc();
    let now = match UtcOffset::current_local_offset() {
        Ok(offset) => now_utc.to_offset(offset),
        Err(_) => now_utc,
    };
    now.format(TIMESTAMP_FORMAT)
        .unwrap_or_else(|_| "0000-00-00 00:00:00".to_string())
}

fn level_color(level: &str) -> &'static str {
    match level {
        "INFO " => "\x1b[36m",
        "WARN " => "\x1b[33m",
        "ERROR" => "\x1b[31m",
        _ => "\x1b[36m",
    }
}

fn supports_color() -> bool {
    if let Ok(mode) = env::var("HIER_VIEWER_LOG_COLOR") {
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
    if let Ok(value) = env::var("CLICOLOR_FORCE")
        && value != "0"
    {
        return true;
    }
    if let Ok(value) = env::var("FORCE_COLOR")
        && !value.is_empty()
        && value != "0"
    {
        return true;
    }
    if let Ok(value) = env::var("CLICOLOR")
        && value == "0"
    {
        return false;
    }
    if let Ok(value) = env::var("CARGO_TERM_COLOR") {
        if value.eq_ignore_ascii_case("always") {
            return true;
        }
        if value.eq_ignore_ascii_case("never") {
            return false;
        }
    }
    if let Ok(value) = env::var("TERM")
        && value.eq_ignore_ascii_case("dumb")
    {
        return false;
    }
    true
}
