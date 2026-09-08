use std::process;

use crate::model::{AppCommand, Config, CoverageConfig, CoverageInput, ServeConfig, UpdateConfig};
use crate::preview::{DEFAULT_PREVIEW_HOST, DEFAULT_PREVIEW_PORT};

pub(crate) fn parse_args<I>(args: I) -> Result<AppCommand, String>
where
    I: IntoIterator<Item = String>,
{
    let mut iter = args.into_iter();
    let Some(first_arg) = iter.next() else {
        return parse_generate_args(Vec::<String>::new()).map(AppCommand::Generate);
    };

    match first_arg.as_str() {
        "-h" | "--help" => {
            print_help();
            process::exit(0);
        }
        "serve" => parse_serve_args(iter).map(AppCommand::Serve),
        "update" => parse_update_args(iter).map(AppCommand::Update),
        _ => {
            let mut forwarded_args = vec![first_arg];
            forwarded_args.extend(iter);
            parse_generate_args(forwarded_args).map(AppCommand::Generate)
        }
    }
}

fn parse_generate_args<I>(args: I) -> Result<Config, String>
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
    let mut coverage_report = None;
    let mut coverage_root = None;
    let mut coverage_vdb = None;
    let mut rebuild_coverage = false;
    let mut coverage_timeout = None;

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
            "--coverage-report" => {
                coverage_report = Some(
                    iter.next()
                        .ok_or("--coverage-report requires a report directory")?,
                );
            }
            "--coverage-vdb" => {
                coverage_vdb = Some(
                    iter.next()
                        .ok_or("--coverage-vdb requires a VDB directory")?,
                );
            }
            "--rebuild-coverage" => rebuild_coverage = true,
            "--coverage-timeout" => {
                let value = iter.next().ok_or("--coverage-timeout requires minutes")?;
                let minutes = value
                    .parse::<u64>()
                    .map_err(|_| "--coverage-timeout requires nonnegative integer minutes")?;
                crate::coverage_import::timeout_duration(minutes).map_err(|err| err.message)?;
                coverage_timeout = Some(minutes);
            }
            "--coverage-root" => {
                let root = iter
                    .next()
                    .ok_or("--coverage-root requires an instance path")?;
                let root = root.trim();
                if root.is_empty() {
                    return Err("--coverage-root must not be empty".to_string());
                }
                coverage_root = Some(root.to_string());
            }
            "--debug" => {
                debug = true;
            }
            "--" => {
                extra_args_tokens.extend(iter);
                break;
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
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            _ if arg.starts_with('-') => return Err(format!("unknown argument: {arg}")),
            _ => rtl_inputs.push(arg),
        }
    }

    if db_path.is_some() && (!rtl_inputs.is_empty() || !filelists.is_empty()) {
        return Err("--db cannot be combined with RTL positional inputs or --filelist".to_string());
    }
    if db_path.is_some() && rebuild_sqlite {
        return Err(
            "--rebuild-sqlite only applies when building sqlite from RTL inputs".to_string(),
        );
    }
    if db_path.is_some() && !extra_args_tokens.is_empty() {
        return Err(
            "--db cannot be combined with compiler passthrough arguments after '--'".to_string(),
        );
    }
    if !preview && preview_port != DEFAULT_PREVIEW_PORT {
        return Err("--preview-port only applies when --preview is enabled".to_string());
    }
    if !preview && preview_host != DEFAULT_PREVIEW_HOST {
        return Err("--preview-host only applies when --preview is enabled".to_string());
    }

    if (rebuild_coverage || coverage_timeout.is_some()) && coverage_vdb.is_none() {
        return Err("--rebuild-coverage and --coverage-timeout require --coverage-vdb".to_string());
    }
    let coverage_input = match (coverage_report, coverage_vdb) {
        (Some(report), None) => Some(CoverageInput::Report(report)),
        (None, Some(vdb)) => Some(CoverageInput::Vdb(vdb)),
        (None, None) => None,
        _ => return Err("--coverage-report and --coverage-vdb are mutually exclusive".to_string()),
    };
    if coverage_root.is_some() && coverage_input.is_none() {
        return Err("--coverage-root requires --coverage-report or --coverage-vdb".to_string());
    }
    let coverage = coverage_input.map(|input| CoverageConfig {
        input,
        root: coverage_root,
        rebuild: rebuild_coverage,
        timeout_minutes: coverage_timeout.unwrap_or(60),
    });

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
        coverage,
    })
}

fn parse_serve_args<I>(args: I) -> Result<ServeConfig, String>
where
    I: IntoIterator<Item = String>,
{
    let mut output_path = None;
    let mut host = DEFAULT_PREVIEW_HOST.to_string();
    let mut port = DEFAULT_PREVIEW_PORT;
    let mut iter = args.into_iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--host" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--host requires a host or IP address".to_string())?;
                host = parse_preview_host(&value)?;
            }
            "--port" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--port requires a port number".to_string())?;
                port = parse_preview_port(&value)?;
            }
            "-h" | "--help" => {
                print_serve_help();
                process::exit(0);
            }
            _ if arg.starts_with('-') => return Err(format!("unknown serve argument: {arg}")),
            _ if output_path.is_none() => output_path = Some(arg),
            _ => return Err(format!("unexpected serve argument: {arg}")),
        }
    }

    Ok(ServeConfig {
        output_path: output_path
            .ok_or_else(|| "serve requires an output directory path".to_string())?,
        host,
        port,
    })
}

fn parse_update_args<I>(args: I) -> Result<UpdateConfig, String>
where
    I: IntoIterator<Item = String>,
{
    let mut target_tag = None;
    let mut iter = args.into_iter();

    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--to" => {
                let value = iter
                    .next()
                    .ok_or_else(|| "--to requires a release tag like v1.0.0".to_string())?;
                target_tag = Some(normalize_requested_tag(&value)?);
            }
            "-h" | "--help" => {
                print_update_help();
                process::exit(0);
            }
            _ => return Err(format!("unknown update argument: {arg}")),
        }
    }

    Ok(UpdateConfig { target_tag })
}

fn normalize_requested_tag(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("--to cannot be empty".to_string());
    }
    if trimmed.starts_with('v') {
        return Ok(trimmed.to_string());
    }
    if trimmed
        .split('.')
        .all(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit()))
    {
        return Ok(format!("v{trimmed}"));
    }
    Err(format!(
        "invalid --to value '{trimmed}': expected a release tag like v1.0.0"
    ))
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
  hier-viewer serve <output-dir> [--host <IP>] [--port <N>]
  hier-viewer update [--to <tag>]

Commands:
  serve                  Open an existing bundle through the built-in server
  update                 Download and install the latest released binary in place

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
      --coverage-report <dir>  Bundle a URG report for automatic coverage loading
      --coverage-vdb <dir>     Convert a VDB with URG, reusing cached reports when unchanged
      --rebuild-coverage       Force VDB report conversion; requires --coverage-vdb
      --coverage-timeout <min> URG conversion timeout in minutes (default: 60; 0 = unlimited)
      --coverage-root <path>   Optional report instance root; auto-select a unique hierarchy match by default
      --debug              Enable viewer debug overlays such as UI element labels
  -h, --help               Show this help

Update Options:
      --to <tag>           Install a specific GitHub release tag such as `v1.0.0`
"
    );
}

fn print_serve_help() {
    println!(
        "\
hier-viewer serve

Open an existing hierarchy viewer bundle through the built-in server.
Coverage import APIs are available only when bound to a loopback address.

Usage:
  hier-viewer serve <output-dir> [--host <IP>] [--port <N>]

Options:
      --host <IP>          Bind host (default: 127.0.0.1; use 0.0.0.0 for remote static access)
      --port <N>           Preferred starting port (default: 8000; auto-increments if occupied)
  -h, --help               Show this help
"
    );
}

fn print_update_help() {
    println!(
        "\
hier-viewer update

Download and install the latest released hier-viewer binary in place.

Usage:
  hier-viewer update [--to <tag>]

Options:
      --to <tag>           Install a specific GitHub release tag such as `v1.0.0`
  -h, --help               Show this help
"
    );
}

#[cfg(test)]
mod tests {
    use super::{normalize_requested_tag, parse_args};
    use crate::model::AppCommand;

    #[test]
    fn parses_update_subcommand() {
        let command = parse_args(vec![
            "update".to_string(),
            "--to".to_string(),
            "1.2.3".to_string(),
        ])
        .expect("update command should parse");
        match command {
            AppCommand::Update(config) => assert_eq!(config.target_tag.as_deref(), Some("v1.2.3")),
            AppCommand::Generate(_) | AppCommand::Serve(_) => panic!("expected update command"),
        }
    }

    #[test]
    fn coverage_root_is_optional_but_requires_coverage_input() {
        for args in [
            vec!["--coverage-root", "tb.dut"],
            vec!["--coverage-report", "report", "--coverage-root", " "],
            vec!["--coverage-report"],
            vec!["--coverage-root"],
        ] {
            assert!(parse_args(args.into_iter().map(str::to_string)).is_err());
        }
        let command = parse_args(
            [
                "--db",
                "design.db",
                "--output",
                "out",
                "--coverage-report",
                "urg report",
                "--coverage-root",
                " tb.dut ",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .expect("parse coverage arguments");
        let AppCommand::Generate(config) = command else {
            panic!("expected generation")
        };
        let coverage = config.coverage.expect("coverage configuration");
        assert!(
            matches!(coverage.input, crate::model::CoverageInput::Report(ref path) if path == "urg report")
        );
        assert_eq!(coverage.root.as_deref(), Some("tb.dut"));

        let command = parse_args(
            ["--coverage-report", "report"]
                .into_iter()
                .map(str::to_string),
        )
        .expect("report without explicit root");
        let AppCommand::Generate(config) = command else {
            panic!("expected generation")
        };
        assert!(config.coverage.unwrap().root.is_none());
    }

    #[test]
    fn parses_vdb_cache_options_and_rejects_incompatible_inputs() {
        let command = parse_args(
            [
                "--coverage-vdb",
                "merged.vdb",
                "--rebuild-coverage",
                "--coverage-timeout",
                "0",
            ]
            .into_iter()
            .map(str::to_string),
        )
        .unwrap();
        let AppCommand::Generate(config) = command else {
            panic!("expected generation")
        };
        let coverage = config.coverage.unwrap();
        assert!(
            matches!(coverage.input, crate::model::CoverageInput::Vdb(ref path) if path == "merged.vdb")
        );
        assert!(coverage.rebuild);
        assert_eq!(coverage.timeout_minutes, 0);
        assert!(coverage.root.is_none());
        for args in [
            vec!["--coverage-report", "report", "--coverage-vdb", "vdb"],
            vec!["--rebuild-coverage"],
            vec!["--coverage-timeout", "5"],
            vec!["--coverage-vdb", "vdb", "--coverage-timeout", "-1"],
            vec!["--coverage-vdb"],
        ] {
            assert!(parse_args(args.into_iter().map(str::to_string)).is_err());
        }
    }

    #[test]
    fn parses_serve_subcommand() {
        let command = parse_args(vec![
            "serve".to_string(),
            "bundle".to_string(),
            "--host".to_string(),
            "::1".to_string(),
            "--port".to_string(),
            "9000".to_string(),
        ])
        .expect("serve command should parse");
        match command {
            AppCommand::Serve(config) => {
                assert_eq!(config.output_path, "bundle");
                assert_eq!(config.host, "::1");
                assert_eq!(config.port, 9000);
            }
            AppCommand::Generate(_) | AppCommand::Update(_) => panic!("expected serve command"),
        }
    }

    #[test]
    fn normalizes_requested_tag() {
        assert_eq!(
            normalize_requested_tag("1.0.0").expect("numeric version should normalize"),
            "v1.0.0"
        );
        assert_eq!(
            normalize_requested_tag("v2.3.4").expect("v-prefixed version should pass through"),
            "v2.3.4"
        );
        assert!(normalize_requested_tag("feature").is_err());
    }
}
