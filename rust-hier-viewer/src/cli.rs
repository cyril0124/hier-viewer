use std::process;

use crate::model::Config;
use crate::preview::{DEFAULT_PREVIEW_HOST, DEFAULT_PREVIEW_PORT};

pub(crate) fn parse_args<I>(args: I) -> Result<Config, String>
where
    I: IntoIterator<Item = String>,
{
    let mut db_path = None;
    let mut output_path = None;
    let mut title = None;
    let mut no_wizard = false;
    let mut rebuild_sqlite = false;
    let mut preview = false;
    let mut preview_host = DEFAULT_PREVIEW_HOST.to_string();
    let mut preview_port = DEFAULT_PREVIEW_PORT;
    let mut rtl_inputs = Vec::new();
    let mut filelists = Vec::new();
    let mut extra_args_tokens = Vec::new();
    let mut debug = false;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--db" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--db requires a sqlite file path".to_string())?;
                db_path = Some(value);
            }
            "-o" | "--output" => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} requires a directory path"))?;
                output_path = Some(value);
            }
            "-t" | "--title" => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} requires a title string"))?;
                title = Some(value);
            }
            "-f" | "--filelist" => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} requires a file path"))?;
                filelists.push(value);
            }
            "--no-wizard" => {
                no_wizard = true;
            }
            "-r" | "--rebuild-sqlite" => {
                rebuild_sqlite = true;
            }
            "--preview" => {
                preview = true;
            }
            "--preview-host" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--preview-host requires a host or IP address".to_string())?;
                preview_host = parse_preview_host(&value)?;
            }
            "--preview-port" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--preview-port requires a port number".to_string())?;
                preview_port = parse_preview_port(&value)?;
            }
            "--debug" => {
                debug = true;
            }
            "--" => {
                extra_args_tokens.extend(iter);
                break;
            }
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            _ if compiler_arg_requires_value(&arg) => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} requires a value"))?;
                extra_args_tokens.push(arg);
                extra_args_tokens.push(value);
            }
            _ if is_passthrough_compiler_arg(&arg) => {
                extra_args_tokens.push(arg);
            }
            _ if arg.starts_with('-') => return Err(format!("unknown argument: {arg}")),
            _ => rtl_inputs.push(arg),
        }
    }

    if db_path.is_some() && (!rtl_inputs.is_empty() || !filelists.is_empty()) {
        return Err("--db cannot be combined with RTL positional inputs or --filelist".to_string());
    }
    if db_path.is_some() && rebuild_sqlite {
        return Err("--rebuild-sqlite only applies when building sqlite from RTL inputs".to_string());
    }
    if db_path.is_some() && !extra_args_tokens.is_empty() {
        return Err("--db cannot be combined with compiler passthrough arguments after '--'".to_string());
    }
    if !preview && preview_port != DEFAULT_PREVIEW_PORT {
        return Err("--preview-port only applies when --preview is enabled".to_string());
    }
    if !preview && preview_host != DEFAULT_PREVIEW_HOST {
        return Err("--preview-host only applies when --preview is enabled".to_string());
    }

    Ok(Config {
        db_path,
        output_path,
        title,
        no_wizard,
        rebuild_sqlite,
        preview,
        preview_host,
        preview_port,
        rtl_inputs,
        filelists,
        extra_args_tokens,
        debug,
    })
}

fn is_passthrough_compiler_arg(arg: &str) -> bool {
    arg.starts_with("+")
        || arg == "--top"
        || arg.starts_with("--top=")
        || arg.starts_with("-I")
        || arg.starts_with("-D")
        || arg.starts_with("-U")
}

fn compiler_arg_requires_value(arg: &str) -> bool {
    matches!(arg, "--top" | "-I" | "-D" | "-U")
}

fn parse_preview_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| format!("invalid --preview-port '{}': expected 1-65535", value))?;
    if port == 0 {
        return Err("--preview-port must be in the range 1-65535".to_string());
    }
    Ok(port)
}

fn parse_preview_host(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("--preview-host cannot be empty".to_string());
    }
    if trimmed.eq_ignore_ascii_case("localhost") {
        return Ok("localhost".to_string());
    }
    trimmed
        .parse::<std::net::IpAddr>()
        .map_err(|_| {
            format!(
                "invalid --preview-host '{}': expected localhost or an IPv4/IPv6 address",
                value
            )
        })
        .map(|_| trimmed.to_string())
}

fn print_help() {
    println!(
        "\
hier-viewer

Generate a static hierarchy viewer bundle from RTL sources or from a prebuilt sqlite hierarchy DB.
If no RTL paths, filelists, or `--db` are provided on an interactive terminal, a ratatui startup wizard opens and lets you pick RTL paths plus extra compiler flags before `slang-hier-exporter --sqlite` is launched internally.

Usage:
  hier-viewer [OPTIONS] [rtl ...]

Arguments:
  [rtl ...]                RTL source paths or wildcard patterns to resolve in the current workspace

Options:
      --db <file>          Read a prebuilt sqlite hierarchy DB
  -f, --filelist <file>    Add a filelist for slang-hier-exporter -f; repeatable
      -- <args...>         Pass remaining args directly to slang / slang-hier-exporter
                           Examples: `-I inc`, `-D FOO=1`, `+incdir+rtl/include`, `--top top_mod`
      --no-wizard          Never open the startup wizard; require explicit `--db`, RTL inputs, or filelists instead
  -r, --rebuild-sqlite     Ignore cached sqlite exports and force rerun slang-hier-exporter
      --preview            After bundle generation, start a built-in local preview server and print the viewer URL
      --preview-host <h>   Bind host for --preview (default: 127.0.0.1; use 0.0.0.0 for remote access)
      --preview-port <n>   Preferred starting port for --preview (default: 8000; auto-increments if occupied)
  -o, --output <dir>       Write bundle files into a directory (required)
  -t, --title <text>       Override page title
      --debug              Enable viewer debug overlays such as UI element labels
  -h, --help               Show this help
"
    );
}
