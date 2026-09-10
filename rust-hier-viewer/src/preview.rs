use std::fs;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::coverage_import::{CoverageService, ImportRequest, ServiceError};
use crate::interrupt::CancellationGuard;
use crate::logging::{info, warn};
use crate::schematic_service::SchematicService;

pub(crate) const DEFAULT_PREVIEW_HOST: &str = "127.0.0.1";
pub(crate) const DEFAULT_PREVIEW_PORT: u16 = 8000;
const MAX_JSON_BODY: usize = 64 * 1024;
const REPORT_CSP: &str = "sandbox allow-scripts";

pub(crate) fn serve_output_dir(
    output_dir: &str,
    requested_host: &str,
    requested_port: u16,
    interactive_terminal: bool,
) -> Result<(), String> {
    let root_dir = fs::canonicalize(output_dir).map_err(|err| {
        format!(
            "failed to resolve preview output directory '{}': {err}",
            output_dir
        )
    })?;
    if !root_dir.is_dir() {
        return Err(format!(
            "preview output path '{}' is not a directory",
            root_dir.display()
        ));
    }
    let server = PreviewServer::bind(root_dir, requested_host, requested_port)?;
    let url = server.viewer_url();
    info(
        "preview",
        format!(
            "Serving '{}' on {}:{} at {}",
            server.root_dir.display(),
            server.bind_host_display,
            server.port,
            url
        ),
    );
    if server.should_print_remote_hint {
        info(
            "preview",
            format!(
                "Preview is listening on all interfaces. Coverage import APIs are disabled; on-demand Schematic remains available. Replace {} with your server IP or use SSH port forwarding.",
                server.viewer_host_display
            ),
        );
    }
    info("preview", "Press Ctrl-C to stop the preview server.");
    maybe_open_browser(&url, interactive_terminal);
    server.serve_forever()
}

struct PreviewServer {
    root_dir: PathBuf,
    server: Arc<Server>,
    coverage: Arc<CoverageService>,
    schematic: Arc<SchematicService>,
    port: u16,
    bind_host_display: String,
    viewer_host_display: String,
    should_print_remote_hint: bool,
    coverage_enabled: bool,
}

impl PreviewServer {
    fn bind(root_dir: PathBuf, requested_host: &str, start_port: u16) -> Result<Self, String> {
        let bind_ip = parse_bind_ip(requested_host)?;
        let bind_host_display = requested_host.to_string();
        let viewer_host_display = viewer_host_display(requested_host, bind_ip);
        let should_print_remote_hint = bind_ip.is_unspecified();
        let coverage_enabled = bind_ip.is_loopback();
        for port in start_port..=u16::MAX {
            match TcpListener::bind(SocketAddr::new(bind_ip, port)) {
                Ok(listener) => {
                    // Accepted sockets inherit this option for low-latency keep-alive responses.
                    socket2::SockRef::from(&listener)
                        .set_tcp_nodelay(true)
                        .map_err(|err| format!("failed to configure preview TCP socket: {err}"))?;
                    let server = Server::from_listener(listener, None)
                        .map_err(|err| format!("failed to initialize preview server: {err}"))?;
                    let schematic = SchematicService::new(&root_dir)?;
                    return Ok(Self {
                        root_dir,
                        server: Arc::new(server),
                        coverage: CoverageService::new()?,
                        schematic,
                        port,
                        bind_host_display,
                        viewer_host_display,
                        should_print_remote_hint,
                        coverage_enabled,
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => continue,
                Err(err) => {
                    return Err(format!(
                        "failed to bind preview server to {bind_host_display}:{port}: {err}"
                    ));
                }
            }
        }
        Err(format!(
            "failed to bind preview server: no free port available in {start_port}-65535"
        ))
    }

    fn viewer_url(&self) -> String {
        format!(
            "http://{}:{}/index.html",
            self.viewer_host_display, self.port
        )
    }

    fn serve_forever(self) -> Result<(), String> {
        let cancellation = CancellationGuard::install()?;
        let result = self.serve_until(cancellation.signal());
        self.coverage.shutdown();
        self.schematic.shutdown();
        result
    }

    fn serve_until(&self, stop: &AtomicBool) -> Result<(), String> {
        while !stop.load(Ordering::Acquire) {
            match self.server.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => {
                    let root_dir = self.root_dir.clone();
                    let coverage = Arc::clone(&self.coverage);
                    let coverage_enabled = self.coverage_enabled;
                    let schematic = Arc::clone(&self.schematic);
                    thread::spawn(move || {
                        if let Err(err) = handle_request(
                            request,
                            &root_dir,
                            coverage,
                            coverage_enabled,
                            schematic,
                        ) {
                            warn("preview", err);
                        }
                    });
                }
                Ok(None) => {}
                Err(err) => return Err(format!("preview server accept failed: {err}")),
            }
        }
        Ok(())
    }
}

impl Drop for PreviewServer {
    fn drop(&mut self) {
        self.coverage.shutdown();
        self.schematic.shutdown();
    }
}

fn handle_request(
    request: Request,
    root_dir: &Path,
    coverage: Arc<CoverageService>,
    coverage_enabled: bool,
    schematic: Arc<SchematicService>,
) -> Result<(), String> {
    let path = request
        .url()
        .split(['?', '#'])
        .next()
        .unwrap_or(request.url())
        .to_string();

    if path.starts_with("/api/schematic/") {
        return handle_schematic_api(request, &path, &schematic);
    }
    if path.starts_with("/api/coverage/") {
        if !coverage_enabled {
            return respond_error(request, 404, "Not Found");
        }
        return handle_coverage_api(request, &path, coverage);
    }
    if let Some(rest) = path.strip_prefix("/coverage-reports/") {
        if !coverage_enabled {
            return respond_error(request, 404, "Not Found");
        }
        return serve_registered_report(request, rest, &coverage);
    }
    serve_static(request, root_dir, &path, false)
}

fn handle_schematic_api(
    request: Request,
    path: &str,
    schematic: &Arc<SchematicService>,
) -> Result<(), String> {
    // Unlike coverage import, this API accepts only an existing viewer ID, not
    // arbitrary local paths. It also supports remote previews on a bound host.
    if header_value(&request, "Sec-Fetch-Site").is_some_and(|site| site == "cross-site") {
        return respond_error(request, 403, "Cross-site schematic requests are disabled");
    }
    if let Some(origin) = header_value(&request, "Origin") {
        let authority = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"));
        if authority != header_value(&request, "Host") {
            return respond_error(
                request,
                403,
                "Schematic requests must use the viewer origin",
            );
        }
    }
    let Some(raw_id) = path.strip_prefix("/api/schematic/scopes/") else {
        return respond_error(request, 404, "Not Found");
    };
    let Ok(id) = raw_id.parse::<usize>() else {
        return respond_error(request, 404, "Invalid schematic scope ID");
    };
    match request.method() {
        Method::Post => {
            if header_value(&request, "X-Hier-Schematic") != Some("1") {
                return respond_error(request, 403, "Missing schematic request header");
            }
            match schematic.request(id) {
                Ok((status, value)) => respond_json(request, status, &value),
                Err(error) => respond_service_error(request, error),
            }
        }
        Method::Get | Method::Head => match schematic.scope_file(id) {
            Ok(path) => {
                let root = path.parent().expect("scope cache has parent");
                serve_static(request, root, &format!("{id}.json"), false)
            }
            Err(error) => respond_service_error(request, error),
        },
        _ => respond_error(request, 405, "Method Not Allowed"),
    }
}

fn handle_coverage_api(
    mut request: Request,
    path: &str,
    coverage: Arc<CoverageService>,
) -> Result<(), String> {
    if let Err(error) = validate_request_origin(&request) {
        return respond_service_error(request, error);
    }
    if path == "/api/coverage/capabilities" {
        if request.method() != &Method::Get {
            return respond_error(request, 405, "Method Not Allowed");
        }
        return respond_json(request, 200, &coverage.capabilities());
    }

    if let Err(error) = validate_api_token(&request, &coverage) {
        return respond_service_error(request, error);
    }

    if path == "/api/coverage/import" {
        if request.method() != &Method::Post {
            return respond_error(request, 405, "Method Not Allowed");
        }
        let import_request = match read_json_body::<ImportRequest>(&mut request) {
            Ok(value) => value,
            Err(error) => return respond_service_error(request, error),
        };
        return match coverage.import(import_request) {
            Ok((status, job)) => respond_json(request, status, &job),
            Err(error) => respond_service_error(request, error),
        };
    }

    if let Some(id) = path.strip_prefix("/api/coverage/jobs/") {
        if !valid_id(id) {
            return respond_error(request, 404, "Not Found");
        }
        return match request.method() {
            Method::Get => match coverage.job(id) {
                Ok(job) => respond_json(request, 200, &job),
                Err(error) => respond_service_error(request, error),
            },
            Method::Delete => match coverage.cancel_or_release(id) {
                Ok(job) => respond_json(request, 200, &job),
                Err(error) => respond_service_error(request, error),
            },
            _ => respond_error(request, 405, "Method Not Allowed"),
        };
    }

    if let Some(rest) = path.strip_prefix("/api/coverage/files/") {
        if request.method() != &Method::Get && request.method() != &Method::Head {
            return respond_error(request, 405, "Method Not Allowed");
        }
        let Some((id, relative)) = rest.split_once('/') else {
            return respond_error(request, 404, "Not Found");
        };
        if !valid_id(id) || relative.is_empty() {
            return respond_error(request, 404, "Not Found");
        }
        let Some(root) = coverage.report_root(id) else {
            return respond_error(request, 404, "Not Found");
        };
        return serve_static(request, &root, relative, false);
    }

    respond_error(request, 404, "Not Found")
}

fn validate_api_token(request: &Request, coverage: &CoverageService) -> Result<(), ServiceError> {
    if !coverage.token_matches(header_value(request, "X-Hier-Token")) {
        return Err(forbidden("missing or invalid coverage token"));
    }
    Ok(())
}

fn validate_request_origin(request: &Request) -> Result<(), ServiceError> {
    if request.url().len() > 8192
        || request.headers().len() > 100
        || request
            .headers()
            .iter()
            .map(|header| header.value.len())
            .sum::<usize>()
            > 32 * 1024
    {
        return Err(ServiceError {
            status: 413,
            message: "request headers are too large".to_string(),
        });
    }
    let host =
        header_value(request, "Host").ok_or_else(|| forbidden("missing or invalid Host header"))?;
    if !valid_loopback_host(host) {
        return Err(forbidden("missing or invalid Host header"));
    }
    if let Some(origin) = header_value(request, "Origin")
        && origin != format!("http://{host}")
    {
        return Err(forbidden("cross-origin coverage request rejected"));
    }
    if header_value(request, "Sec-Fetch-Site")
        .is_some_and(|value| value.eq_ignore_ascii_case("cross-site"))
    {
        return Err(forbidden("cross-site coverage request rejected"));
    }
    Ok(())
}

fn forbidden(message: impl Into<String>) -> ServiceError {
    ServiceError {
        status: 403,
        message: message.into(),
    }
}

fn read_json_body<T: serde::de::DeserializeOwned>(
    request: &mut Request,
) -> Result<T, ServiceError> {
    let content_type = header_value(request, "Content-Type").unwrap_or_default();
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(ServiceError {
            status: 415,
            message: "Content-Type must be application/json".to_string(),
        });
    }
    if request
        .body_length()
        .is_some_and(|length| length > MAX_JSON_BODY)
    {
        return Err(ServiceError {
            status: 413,
            message: "request body is too large".to_string(),
        });
    }
    let mut body = Vec::with_capacity(request.body_length().unwrap_or(0).min(MAX_JSON_BODY));
    request
        .as_reader()
        .take((MAX_JSON_BODY + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|err| ServiceError {
            status: 400,
            message: format!("failed to read request body: {err}"),
        })?;
    if body.len() > MAX_JSON_BODY {
        return Err(ServiceError {
            status: 413,
            message: "request body is too large".to_string(),
        });
    }
    serde_json::from_slice(&body).map_err(|_| ServiceError {
        status: 400,
        message: "request body must match the coverage import schema".to_string(),
    })
}

fn serve_registered_report(
    request: Request,
    rest: &str,
    coverage: &CoverageService,
) -> Result<(), String> {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        return respond_error(request, 405, "Method Not Allowed");
    }
    let Some((id, relative)) = rest.split_once('/') else {
        return respond_error(request, 404, "Not Found");
    };
    if !valid_id(id) || relative.is_empty() {
        return respond_error(request, 404, "Not Found");
    }
    let Some(root) = coverage.report_root(id) else {
        return respond_error(request, 404, "Not Found");
    };
    serve_static(request, &root, relative, true)
}

fn serve_static(
    request: Request,
    root_dir: &Path,
    raw_path: &str,
    sandbox_report: bool,
) -> Result<(), String> {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        return respond_error(request, 405, "Method Not Allowed");
    }
    let relative = if raw_path == "/" || raw_path.is_empty() {
        PathBuf::from("index.html")
    } else {
        match decode_relative_path(raw_path.trim_start_matches('/')) {
            Ok(path) => path,
            Err(status) => return respond_error(request, status, status_text(status)),
        }
    };
    if relative
        .components()
        .any(|part| part.as_os_str() == ".hier-viewer-cache")
    {
        return respond_error(request, 403, "Forbidden");
    }
    let candidate = root_dir.join(relative);
    let canonical = match fs::canonicalize(&candidate) {
        Ok(path) => path,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return respond_error(request, 404, "Not Found");
        }
        Err(err) => return respond_error(request, 500, &format!("Internal Server Error: {err}")),
    };
    if !canonical.starts_with(root_dir) {
        return respond_error(request, 403, "Forbidden");
    }
    let metadata = match fs::metadata(&canonical) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return respond_error(request, 404, "Not Found"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return respond_error(request, 404, "Not Found");
        }
        Err(err) => return respond_error(request, 500, &format!("Internal Server Error: {err}")),
    };
    let file = match fs::File::open(&canonical) {
        Ok(file) => file,
        Err(err) => return respond_error(request, 500, &format!("Internal Server Error: {err}")),
    };
    let mut headers = common_headers(content_type_for_path(&canonical));
    if sandbox_report {
        headers.push(header("Content-Security-Policy", REPORT_CSP));
        headers.push(header("Referrer-Policy", "no-referrer"));
    }
    let response = Response::new(
        StatusCode(200),
        headers,
        file,
        Some(metadata.len() as usize),
        None,
    )
    .with_chunked_threshold(usize::MAX);
    request
        .respond(response)
        .map_err(|err| format!("failed to send file response: {err}"))
}

fn decode_relative_path(raw: &str) -> Result<PathBuf, u16> {
    if raw.is_empty() {
        return Err(404);
    }
    let mut relative = PathBuf::new();
    for raw_segment in raw.split('/') {
        if raw_segment.is_empty() {
            return Err(400);
        }
        let segment = percent_decode_segment(raw_segment).map_err(|_| 400u16)?;
        if segment == "." || segment == ".." {
            return Err(403);
        }
        if segment.contains(['/', '\\', '\0']) {
            return Err(400);
        }
        relative.push(segment);
    }
    Ok(relative)
}

fn percent_decode_segment(segment: &str) -> Result<String, ()> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err(());
                }
                let high = hex_value(bytes[index + 1]).ok_or(())?;
                let low = hex_value(bytes[index + 2]).ok_or(())?;
                decoded.push((high << 4) | low);
                index += 3;
            }
            value => {
                decoded.push(value);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn parse_bind_ip(value: &str) -> Result<IpAddr, String> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("localhost") {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    trimmed.parse::<IpAddr>().map_err(|_| {
        format!(
            "invalid preview host '{}': expected localhost or an IPv4/IPv6 address",
            value
        )
    })
}

fn viewer_host_display(requested_host: &str, bind_ip: IpAddr) -> String {
    if requested_host.eq_ignore_ascii_case("localhost") {
        return "localhost".to_string();
    }
    match bind_ip {
        IpAddr::V4(ip) if ip.is_unspecified() => Ipv4Addr::LOCALHOST.to_string(),
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) if ip.is_unspecified() => format!("[{}]", Ipv6Addr::LOCALHOST),
        IpAddr::V6(ip) => format!("[{ip}]"),
    }
}

fn valid_loopback_host(host: &str) -> bool {
    let Some((name, host_port)) = host.rsplit_once(':') else {
        return false;
    };
    // SSH forwarding can use a different browser-facing port.
    if !host_port.parse::<u16>().is_ok_and(|port| port > 0) {
        return false;
    }
    name.eq_ignore_ascii_case("localhost")
        || name
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn header_value<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("xml") => "application/xml; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt" | "sv" | "svh" | "v" | "vh") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn common_headers(content_type: &str) -> Vec<Header> {
    vec![
        header("Content-Type", content_type),
        header("Cache-Control", "no-store"),
        header("X-Content-Type-Options", "nosniff"),
    ]
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid static HTTP header")
}

fn respond_json<T: Serialize>(request: Request, status: u16, value: &T) -> Result<(), String> {
    let body = serde_json::to_vec(value)
        .map_err(|err| format!("failed to serialize JSON response: {err}"))?;
    let response = Response::from_data(body)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    request
        .respond(response)
        .map_err(|err| format!("failed to send JSON response: {err}"))
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
}

fn respond_service_error(request: Request, error: ServiceError) -> Result<(), String> {
    respond_json(
        request,
        error.status,
        &ErrorResponse {
            error: &error.message,
        },
    )
}

fn respond_error(request: Request, status: u16, message: &str) -> Result<(), String> {
    let response = Response::from_string(message)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", "text/plain; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    request
        .respond(response)
        .map_err(|err| format!("failed to send error response: {err}"))
}

const fn status_text(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    }
}

fn maybe_open_browser(url: &str, interactive_terminal: bool) {
    if !interactive_terminal {
        info("preview", format!("Preview URL: {url}"));
        return;
    }
    if std::env::var_os("SSH_CONNECTION").is_some()
        || std::env::var_os("SSH_CLIENT").is_some()
        || std::env::var_os("SSH_TTY").is_some()
    {
        info(
            "preview",
            format!("Preview URL: {url} (browser auto-open skipped in SSH session)"),
        );
        return;
    }

    match browser_command(url) {
        Some(mut command) => match command.spawn() {
            Ok(_) => info("preview", format!("Opened browser for {url}")),
            Err(err) => warn(
                "preview",
                format!("Failed to auto-open browser: {err}. Preview URL: {url}"),
            ),
        },
        None => info(
            "preview",
            format!("Preview URL: {url} (browser auto-open skipped: no supported opener found)"),
        ),
    }
}

fn browser_command(url: &str) -> Option<Command> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(url);
        return Some(command);
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        return Some(command);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return None;
        }
        let mut command = Command::new("xdg-open");
        command.arg(url);
        return Some(command);
    }

    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::{
        PreviewServer, decode_relative_path, parse_bind_ip, percent_decode_segment,
        viewer_host_display,
    };
    use reqwest::blocking::Client;
    use serde_json::Value;
    use std::fs;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    struct TestServer {
        base_url: String,
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn start(root: &std::path::Path, host: &str) -> Self {
            let server = PreviewServer::bind(
                fs::canonicalize(root).expect("canonical test root"),
                host,
                24000,
            )
            .expect("bind test server");
            let base_url = format!("http://127.0.0.1:{}", server.port);
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop);
            let thread = thread::spawn(move || {
                server
                    .serve_until(&thread_stop)
                    .expect("test server should run");
                server.coverage.shutdown();
            });
            thread::sleep(Duration::from_millis(20));
            Self {
                base_url,
                stop,
                thread: Some(thread),
            }
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                thread.join().expect("join test server");
            }
        }
    }

    fn bundle_fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("create bundle fixture");
        fs::write(directory.path().join("index.html"), "bundle-index").expect("write bundle index");
        directory
    }

    fn report_fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("create report fixture");
        fs::write(directory.path().join("session.xml"), "<session/>").expect("write session");
        fs::write(directory.path().join("dashboard.html"), "report-dashboard")
            .expect("write dashboard");
        directory
    }

    #[test]
    fn occupied_port_auto_increments() {
        let bundle = bundle_fixture();
        let occupied = TcpListener::bind("127.0.0.1:0").expect("bind occupied port");
        let port = occupied.local_addr().expect("occupied address").port();
        if port == u16::MAX {
            return;
        }
        let server = PreviewServer::bind(
            fs::canonicalize(bundle.path()).expect("canonical bundle"),
            "127.0.0.1",
            port,
        )
        .expect("bind incremented port");
        assert!(server.port > port);
        server.coverage.shutdown();
    }

    #[test]
    fn static_server_streams_get_and_head() {
        let bundle = bundle_fixture();
        let server = TestServer::start(bundle.path(), "127.0.0.1");
        let client = Client::new();
        let response = client
            .get(format!("{}/", server.base_url))
            .send()
            .expect("GET bundle");
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().expect("read body"), "bundle-index");
        let response = client
            .head(format!("{}/index.html", server.base_url))
            .send()
            .expect("HEAD bundle");
        assert_eq!(response.status(), 200);
        assert_eq!(
            response
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .expect("HEAD content length"),
            "12"
        );
        assert!(response.bytes().expect("read HEAD body").is_empty());
    }

    #[test]
    fn large_assets_keep_content_length_for_preallocated_browser_loading() {
        let bundle = bundle_fixture();
        let bytes = vec![42u8; 128 * 1024];
        fs::write(bundle.path().join("viewer-core.bin"), &bytes).expect("large asset");
        let server = TestServer::start(bundle.path(), "127.0.0.1");
        let client = Client::new();
        let url = format!("{}/viewer-core.bin", server.base_url);
        for method in [reqwest::Method::GET, reqwest::Method::HEAD] {
            let head = method == reqwest::Method::HEAD;
            let response = client
                .request(method, &url)
                .send()
                .expect("large asset response");
            assert_eq!(
                response
                    .headers()
                    .get(reqwest::header::CONTENT_LENGTH)
                    .expect("content length"),
                bytes.len().to_string().as_str()
            );
            assert!(
                !response
                    .headers()
                    .contains_key(reqwest::header::TRANSFER_ENCODING)
            );
            let body = response.bytes().expect("asset body");
            if head {
                assert!(body.is_empty());
            } else {
                assert_eq!(body.as_ref(), bytes.as_slice());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn static_server_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let bundle = bundle_fixture();
        let outside = tempfile::NamedTempFile::new().expect("create outside file");
        fs::write(outside.path(), "secret").expect("write outside file");
        symlink(outside.path(), bundle.path().join("escape.txt")).expect("create escaping link");
        let server = TestServer::start(bundle.path(), "127.0.0.1");
        let response = Client::new()
            .get(format!("{}/escape.txt", server.base_url))
            .send()
            .expect("GET escaping symlink");
        assert_eq!(response.status(), 403);
    }

    #[test]
    fn coverage_api_requires_token_and_same_origin() {
        let bundle = bundle_fixture();
        let report = report_fixture();
        let server = TestServer::start(bundle.path(), "127.0.0.1");
        let client = Client::new();
        let capabilities: Value = client
            .get(format!("{}/api/coverage/capabilities", server.base_url))
            .send()
            .expect("get capabilities")
            .json()
            .expect("parse capabilities");
        let token = capabilities["token"].as_str().expect("token");

        let endpoint = format!("{}/api/coverage/import", server.base_url);
        let capability_url = format!("{}/api/coverage/capabilities", server.base_url);
        for (name, value) in [
            ("Host", "attacker.example"),
            ("Origin", "http://attacker.example"),
            ("Sec-Fetch-Site", "cross-site"),
        ] {
            assert_eq!(
                client
                    .get(&capability_url)
                    .header(name, value)
                    .send()
                    .expect("request unsafe capabilities")
                    .status(),
                403
            );
        }
        let forwarded = client
            .get(&capability_url)
            .header("Host", "127.0.0.1:18000")
            .header("Origin", "http://127.0.0.1:18000")
            .send()
            .expect("forwarded loopback capabilities");
        assert_eq!(forwarded.status(), 200);
        assert_eq!(
            client
                .post(&endpoint)
                .json(&serde_json::json!({
                    "kind": "report",
                    "path": report.path(),
                    "timeoutMinutes": 60
                }))
                .send()
                .expect("unauthorized import")
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&endpoint)
                .header("Host", "attacker.example")
                .header("X-Hier-Token", token)
                .header("Origin", "http://attacker.example")
                .json(&serde_json::json!({
                    "kind": "report",
                    "path": report.path(),
                    "timeoutMinutes": 60
                }))
                .send()
                .expect("forged Host import")
                .status(),
            403
        );
        assert_eq!(
            client
                .post(&endpoint)
                .header("X-Hier-Token", token)
                .header("Origin", "http://attacker.example")
                .json(&serde_json::json!({
                    "kind": "report",
                    "path": report.path(),
                    "timeoutMinutes": 60
                }))
                .send()
                .expect("cross-origin import")
                .status(),
            403
        );
        let imported: Value = client
            .post(endpoint)
            .header("X-Hier-Token", token)
            .header("Origin", &server.base_url)
            .json(&serde_json::json!({
                "kind": "report",
                "path": report.path(),
                "timeoutMinutes": 60
            }))
            .send()
            .expect("authorized import")
            .json()
            .expect("parse import response");
        assert_eq!(imported["state"], "ready");
        let report_url = imported["report"]["reportUrl"]
            .as_str()
            .expect("report URL");
        let response = client
            .get(format!("{}{report_url}", server.base_url))
            .send()
            .expect("get report dashboard");
        assert_eq!(response.status(), 200);
        assert_eq!(
            response
                .headers()
                .get("content-security-policy")
                .expect("report CSP"),
            "sandbox allow-scripts"
        );
        let report_id = imported["report"]["id"].as_str().expect("report ID");
        let response = client
            .get(format!(
                "{}/api/coverage/files/{report_id}/session.xml",
                server.base_url
            ))
            .header("X-Hier-Token", token)
            .send()
            .expect("get report XML");
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().expect("read report XML"), "<session/>");
    }

    #[test]
    fn oversized_or_invalid_import_body_is_rejected() {
        let bundle = bundle_fixture();
        let server = TestServer::start(bundle.path(), "127.0.0.1");
        let client = Client::new();
        let capabilities: Value = client
            .get(format!("{}/api/coverage/capabilities", server.base_url))
            .send()
            .expect("get capabilities")
            .json()
            .expect("parse capabilities");
        let token = capabilities["token"].as_str().expect("token");
        let endpoint = format!("{}/api/coverage/import", server.base_url);
        let response = client
            .post(&endpoint)
            .header("X-Hier-Token", token)
            .header("Origin", &server.base_url)
            .header("Content-Type", "application/json")
            .body(vec![b'x'; 64 * 1024 + 1])
            .send()
            .expect("send oversized body");
        assert_eq!(response.status(), 413);
        let response = client
            .post(endpoint)
            .header("X-Hier-Token", token)
            .header("Origin", &server.base_url)
            .header("Content-Type", "application/json")
            .body(r#"{"kind":"report","path":"/tmp","extra":true}"#)
            .send()
            .expect("send invalid body");
        assert_eq!(response.status(), 400);
    }

    #[test]
    fn remote_binding_keeps_static_files_and_disables_coverage() {
        let bundle = bundle_fixture();
        let server = TestServer::start(bundle.path(), "0.0.0.0");
        let client = Client::new();
        assert_eq!(
            client
                .get(format!("{}/index.html", server.base_url))
                .send()
                .expect("get static file")
                .status(),
            200
        );
        assert_eq!(
            client
                .get(format!("{}/api/coverage/capabilities", server.base_url))
                .send()
                .expect("get disabled API")
                .status(),
            404
        );
    }

    #[test]
    fn percent_decode_and_reject_path_traversal() {
        assert_eq!(
            percent_decode_segment("foo%20bar.sv").expect("decode path"),
            "foo bar.sv"
        );
        assert!(percent_decode_segment("%ZZ").is_err());
        assert!(decode_relative_path("%2e%2e/secret").is_err());
        assert!(decode_relative_path("safe/%2fetc").is_err());
        assert!(decode_relative_path("safe/%5cetc").is_err());
    }

    #[test]
    fn parse_preview_host_and_rewrite_unspecified_for_viewer_url() {
        let localhost = parse_bind_ip("localhost").expect("parse localhost");
        assert_eq!(viewer_host_display("localhost", localhost), "localhost");
        let any = parse_bind_ip("0.0.0.0").expect("parse IPv4 any");
        assert_eq!(viewer_host_display("0.0.0.0", any), "127.0.0.1");
        let v6_any = parse_bind_ip("::").expect("parse IPv6 any");
        assert_eq!(viewer_host_display("::", v6_any), "[::1]");
    }
}
