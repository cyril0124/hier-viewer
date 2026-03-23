use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::logging::{info, warn};

pub(crate) const DEFAULT_PREVIEW_HOST: &str = "127.0.0.1";
pub(crate) const DEFAULT_PREVIEW_PORT: u16 = 8000;

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
                "Preview is listening on all interfaces. Replace {} with your server IP or use SSH port forwarding if you are accessing it remotely.",
                server.viewer_host_display
            ),
        );
    }
    info("preview", "Press Ctrl-C to stop the local preview server.");
    maybe_open_browser(&url, interactive_terminal);
    server.serve_forever()
}

struct PreviewServer {
    root_dir: PathBuf,
    listener: TcpListener,
    port: u16,
    bind_host_display: String,
    viewer_host_display: String,
    should_print_remote_hint: bool,
}

impl PreviewServer {
    fn bind(root_dir: PathBuf, requested_host: &str, start_port: u16) -> Result<Self, String> {
        let bind_ip = parse_bind_ip(requested_host)?;
        let bind_host_display = requested_host.to_string();
        let viewer_host_display = viewer_host_display(requested_host, bind_ip);
        let should_print_remote_hint = bind_ip.is_unspecified();
        for port in start_port..=u16::MAX {
            match TcpListener::bind(SocketAddr::new(bind_ip, port)) {
                Ok(listener) => {
                    return Ok(Self {
                        root_dir,
                        listener,
                        port,
                        bind_host_display: bind_host_display.clone(),
                        viewer_host_display: viewer_host_display.clone(),
                        should_print_remote_hint,
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => continue,
                Err(err) => {
                    return Err(format!(
                        "failed to bind preview server to {}:{}: {err}",
                        bind_host_display, port
                    ));
                }
            }
        }
        Err(format!(
            "failed to bind preview server: no free port available in {}-65535",
            start_port
        ))
    }

    fn viewer_url(&self) -> String {
        format!("http://{}:{}/index.html", self.viewer_host_display, self.port)
    }

    fn serve_forever(self) -> Result<(), String> {
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => {
                    let root_dir = self.root_dir.clone();
                    thread::spawn(move || {
                        if let Err(err) = handle_connection(stream, &root_dir) {
                            warn("preview", err);
                        }
                    });
                }
                Err(err) => {
                    return Err(format!("preview server accept failed: {err}"));
                }
            }
        }
        Ok(())
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
        IpAddr::V6(ip) => format!("[{}]", ip),
    }
}

fn handle_connection(mut stream: TcpStream, root_dir: &Path) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|err| format!("failed to set preview socket timeout: {err}"))?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|err| format!("failed to clone preview socket: {err}"))?,
    );
    let mut request_line = String::new();
    let bytes_read = reader
        .read_line(&mut request_line)
        .map_err(|err| format!("failed to read preview request line: {err}"))?;
    if bytes_read == 0 || request_line.trim().is_empty() {
        return Ok(());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let _version = parts.next().unwrap_or_default();

    loop {
        let mut header_line = String::new();
        let read = reader
            .read_line(&mut header_line)
            .map_err(|err| format!("failed to read preview request header: {err}"))?;
        if read == 0 || header_line == "\r\n" {
            break;
        }
    }

    match method {
        "GET" | "HEAD" => {
            let path = match resolve_request_path(root_dir, target) {
                Ok(path) => path,
                Err(status) => {
                    return write_text_response(
                        &mut stream,
                        method == "HEAD",
                        status,
                        "text/plain; charset=utf-8",
                        status.reason.as_bytes(),
                    )
                    .map_err(|err| format!("failed to write preview error response: {err}"));
                }
            };

            let canonical_path = match fs::canonicalize(&path) {
                Ok(canonical_path) => canonical_path,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    return write_text_response(
                        &mut stream,
                        method == "HEAD",
                        Status::not_found(),
                        "text/plain; charset=utf-8",
                        b"Not Found",
                    )
                    .map_err(|err| format!("failed to write preview not-found response: {err}"));
                }
                Err(err) => {
                    return write_text_response(
                        &mut stream,
                        method == "HEAD",
                        Status::internal_server_error(),
                        "text/plain; charset=utf-8",
                        format!("Internal Server Error: {err}").as_bytes(),
                    )
                    .map_err(|io_err| {
                        format!("failed to write preview internal-error response: {io_err}")
                    });
                }
            };
            if !canonical_path.starts_with(root_dir) {
                return write_text_response(
                    &mut stream,
                    method == "HEAD",
                    Status::forbidden(),
                    "text/plain; charset=utf-8",
                    b"Forbidden",
                )
                .map_err(|err| format!("failed to write preview forbidden response: {err}"));
            }

            let metadata = match fs::metadata(&canonical_path) {
                Ok(metadata) if metadata.is_file() => metadata,
                Ok(_) => {
                    return write_text_response(
                        &mut stream,
                        method == "HEAD",
                        Status::not_found(),
                        "text/plain; charset=utf-8",
                        b"Not Found",
                    )
                    .map_err(|err| format!("failed to write preview not-found response: {err}"));
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    return write_text_response(
                        &mut stream,
                        method == "HEAD",
                        Status::not_found(),
                        "text/plain; charset=utf-8",
                        b"Not Found",
                    )
                    .map_err(|err| format!("failed to write preview not-found response: {err}"));
                }
                Err(err) => {
                    return write_text_response(
                        &mut stream,
                        method == "HEAD",
                        Status::internal_server_error(),
                        "text/plain; charset=utf-8",
                        format!("Internal Server Error: {err}").as_bytes(),
                    )
                    .map_err(|io_err| {
                        format!("failed to write preview internal-error response: {io_err}")
                    });
                }
            };

            let content_type = content_type_for_path(&path);
            let content_length = metadata.len();
            write_response_headers(
                &mut stream,
                Status::ok(),
                content_type,
                content_length,
            )
            .map_err(|err| format!("failed to write preview response headers: {err}"))?;

            if method != "HEAD" {
                let mut file = fs::File::open(&canonical_path).map_err(|err| {
                    format!(
                        "failed to open preview file '{}': {err}",
                        canonical_path.display()
                    )
                })?;
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    let read = file
                        .read(&mut buffer)
                        .map_err(|err| {
                            format!("failed to read '{}': {err}", canonical_path.display())
                        })?;
                    if read == 0 {
                        break;
                    }
                    stream
                        .write_all(&buffer[..read])
                        .map_err(|err| format!("failed to write preview file body: {err}"))?;
                }
            }
            stream
                .flush()
                .map_err(|err| format!("failed to flush preview response: {err}"))?;
            Ok(())
        }
        _ => write_text_response(
            &mut stream,
            false,
            Status::method_not_allowed(),
            "text/plain; charset=utf-8",
            b"Method Not Allowed",
        )
        .map_err(|err| format!("failed to write preview method-not-allowed response: {err}")),
    }
}

fn resolve_request_path(root_dir: &Path, target: &str) -> Result<PathBuf, Status> {
    let raw_path = target
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(target)
        .split_once('#')
        .map(|(path, _)| path)
        .unwrap_or(target);
    if raw_path.is_empty() || !raw_path.starts_with('/') {
        return Err(Status::bad_request());
    }
    if raw_path == "/" {
        return Ok(root_dir.join("index.html"));
    }

    let mut relative = PathBuf::new();
    for raw_segment in raw_path.trim_start_matches('/').split('/') {
        if raw_segment.is_empty() || raw_segment == "." {
            continue;
        }
        let segment = percent_decode_segment(raw_segment).map_err(|_| Status::bad_request())?;
        if segment == ".." {
            return Err(Status::forbidden());
        }
        if segment.contains('/') || segment.contains('\\') {
            return Err(Status::bad_request());
        }
        relative.push(segment);
    }

    if relative.as_os_str().is_empty() {
        return Ok(root_dir.join("index.html"));
    }

    Ok(root_dir.join(relative))
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

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("bin") => "application/octet-stream",
        Some("sv") | Some("svh") | Some("v") | Some("vh") => "text/plain; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn write_text_response(
    stream: &mut TcpStream,
    head_only: bool,
    status: Status,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write_response_headers(stream, status, content_type, body.len() as u64)?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn write_response_headers(
    stream: &mut TcpStream,
    status: Status,
    content_type: &str,
    content_length: u64,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status.code, status.reason, content_type, content_length
    )
}

fn maybe_open_browser(url: &str, interactive_terminal: bool) {
    if !interactive_terminal {
        info("preview", format!("Preview URL: {}", url));
        return;
    }
    if std::env::var_os("SSH_CONNECTION").is_some()
        || std::env::var_os("SSH_CLIENT").is_some()
        || std::env::var_os("SSH_TTY").is_some()
    {
        info(
            "preview",
            format!("Preview URL: {} (browser auto-open skipped in SSH session)", url),
        );
        return;
    }

    match browser_command(url) {
        Some(mut command) => match command.spawn() {
            Ok(_) => info("preview", format!("Opened browser for {}", url)),
            Err(err) => {
                warn(
                    "preview",
                    format!("Failed to auto-open browser: {err}. Preview URL: {}", url),
                );
            }
        },
        None => {
            info(
                "preview",
                format!(
                    "Preview URL: {} (browser auto-open skipped: no supported opener found)",
                    url
                ),
            );
        }
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
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none()
        {
            return None;
        }
        let mut command = Command::new("xdg-open");
        command.arg(url);
        return Some(command);
    }

    #[allow(unreachable_code)]
    None
}

#[derive(Clone, Copy, Debug)]
struct Status {
    code: u16,
    reason: &'static str,
}

impl Status {
    const fn ok() -> Self {
        Self {
            code: 200,
            reason: "OK",
        }
    }

    const fn bad_request() -> Self {
        Self {
            code: 400,
            reason: "Bad Request",
        }
    }

    const fn forbidden() -> Self {
        Self {
            code: 403,
            reason: "Forbidden",
        }
    }

    const fn not_found() -> Self {
        Self {
            code: 404,
            reason: "Not Found",
        }
    }

    const fn method_not_allowed() -> Self {
        Self {
            code: 405,
            reason: "Method Not Allowed",
        }
    }

    const fn internal_server_error() -> Self {
        Self {
            code: 500,
            reason: "Internal Server Error",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Status, parse_bind_ip, percent_decode_segment, resolve_request_path, viewer_host_display,
    };
    use std::path::Path;

    #[test]
    fn percent_decode_path_segment() {
        assert_eq!(
            percent_decode_segment("foo%20bar.sv").expect("percent decode should succeed"),
            "foo bar.sv"
        );
        assert_eq!(
            percent_decode_segment("%E4%BD%A0%E5%A5%BD.sv")
                .expect("utf8 percent decode should succeed"),
            "你好.sv"
        );
    }

    #[test]
    fn reject_invalid_percent_encoding() {
        assert!(percent_decode_segment("%ZZ").is_err());
        assert!(percent_decode_segment("%2").is_err());
    }

    #[test]
    fn resolve_root_and_reject_parent_traversal() {
        let root = Path::new("/tmp/hier-viewer-preview-root");
        assert_eq!(
            resolve_request_path(root, "/").expect("root path should resolve"),
            root.join("index.html")
        );
        let status = resolve_request_path(root, "/../secret").expect_err("parent traversal must fail");
        assert_eq!(status.code, Status::forbidden().code);
    }

    #[test]
    fn parse_preview_host_and_rewrite_unspecified_for_viewer_url() {
        let localhost = parse_bind_ip("localhost").expect("localhost should parse");
        assert_eq!(viewer_host_display("localhost", localhost), "localhost");

        let any = parse_bind_ip("0.0.0.0").expect("ipv4 any should parse");
        assert_eq!(viewer_host_display("0.0.0.0", any), "127.0.0.1");

        let v6_any = parse_bind_ip("::").expect("ipv6 any should parse");
        assert_eq!(viewer_host_display("::", v6_any), "[::1]");
    }
}
