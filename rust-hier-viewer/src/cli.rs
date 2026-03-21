use std::process;

use crate::model::Config;

pub(crate) fn parse_args<I>(args: I) -> Result<Config, String>
where
    I: IntoIterator<Item = String>,
{
    let mut input_path = None;
    let mut output_path = None;
    let mut title = None;
    let mut no_wizard = false;
    let mut rebuild_sqlite = false;
    let mut rtl_paths = Vec::new();
    let mut filelists = Vec::new();
    let mut extra_args_tokens = Vec::new();
    let mut initial_metric = "instances";
    let mut exclude_wildcards = Vec::new();
    let mut exclude_regexes = Vec::new();
    let mut debug = false;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-i" | "--input" => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} requires a file path"))?;
                input_path = Some(value);
            }
            "-o" | "--output" => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} requires a file path"))?;
                output_path = Some(value);
            }
            "-t" | "--title" => {
                let value = iter
                    .next()
                    .ok_or_else(|| format!("{arg} requires a title string"))?;
                title = Some(value);
            }
            "--rtl-path" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--rtl-path requires a path".to_string())?;
                rtl_paths.push(value);
            }
            "--filelist" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--filelist requires a file path".to_string())?;
                filelists.push(value);
            }
            "--no-wizard" => {
                no_wizard = true;
            }
            "--rebuild-sqlite" => {
                rebuild_sqlite = true;
            }
            "--debug" => {
                debug = true;
            }
            "--" => {
                extra_args_tokens.extend(iter);
                break;
            }
            "--exclude-wildcard" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--exclude-wildcard requires a pattern".to_string())?;
                exclude_wildcards.push(value);
            }
            "--exclude-regex" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--exclude-regex requires a pattern".to_string())?;
                exclude_regexes.push(value);
            }
            "--metric" => {
                let value = iter.next().ok_or_else(|| {
                    "--metric requires 'instances', 'leaves', or 'weighted_signals' ('signals' is still accepted as a legacy alias)"
                        .to_string()
                })?;
                match value.as_str() {
                    "instances" | "leaves" | "signals" | "weighted_signals" => {
                        initial_metric = match value.as_str() {
                            "leaves" => "leaves",
                            "signals" => "signals",
                            "weighted_signals" => "weighted_signals",
                            _ => "instances",
                        }
                    }
                    _ => {
                        return Err(format!(
                            "unsupported metric '{value}', expected 'instances', 'leaves', or 'weighted_signals' ('signals' is still accepted as a legacy alias)"
                        ));
                    }
                }
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
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }

    Ok(Config {
        input_path,
        output_path,
        title,
        no_wizard,
        rebuild_sqlite,
        rtl_paths,
        filelists,
        extra_args_tokens,
        initial_metric,
        exclude_wildcards,
        exclude_regexes,
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

fn print_help() {
    println!(
        "\
rust-hier-viewer

Generate a static hierarchy viewer bundle from RTL sources or prebuilt hierarchy exports.
The input can be the legacy plain format, the CSV format from `slang-hier-exporter --csv`, or the sqlite format from `slang-hier-exporter --sqlite`.
If `--input` is omitted on an interactive terminal, a ratatui startup wizard opens and lets you pick RTL paths plus extra compiler flags before `slang-hier-exporter --sqlite` is launched internally.

Usage:
  rust-hier-viewer [OPTIONS]

Options:
  -i, --input <file>       Read plain / CSV / sqlite hierarchy input from a file
                           (default: stdin when piped, otherwise open startup wizard)
      --rtl-path <path>    Add an RTL source path directly; repeatable
      --filelist <file>    Add a filelist for slang-hier-exporter -f; repeatable
      -- <args...>         Pass remaining args directly to slang / slang-hier-exporter
                           Examples: `-I inc`, `-D FOO=1`, `+incdir+/rtl/inc`, `--top top_mod`
      --no-wizard          Never open the startup wizard; require explicit inputs instead
      --rebuild-sqlite    Ignore cached sqlite exports and force rerun slang-hier-exporter
  -o, --output <dir>       Write bundle files into a directory (required)
  -t, --title <text>       Override page title
      --metric <name>      Initial metric: instances | leaves | weighted_signals
                           ('signals' is still accepted as a legacy alias; it maps to weighted_signals with Var=1 and Net=1)
      --exclude-wildcard <pattern>
                           Exclude matching hierarchy paths or module names; repeatable
      --exclude-regex <pattern>
                           Exclude matching hierarchy paths or module names; repeatable
      --debug              Enable viewer debug overlays such as UI element labels
  -h, --help               Show this help
"
    );
}
