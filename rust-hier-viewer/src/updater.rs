use std::env;
use std::fs;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use reqwest::StatusCode;
use reqwest::blocking::Client;
use serde::Deserialize;
use tar::Archive;

use crate::logging::{
    info, stderr_is_terminal, supports_color_output, supports_unicode_output, warn,
};
use crate::model::UpdateConfig;

const UPDATE_TARGET: &str = "update";
const RELEASES_API_BASE: &str = "https://api.github.com/repos/cyril0124/hier-viewer/releases";
const STAGE_TOTAL: usize = 5;
const DOWNLOAD_BUFFER_SIZE: usize = 256 * 1024;
const DOWNLOAD_LOG_STEP_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct SemanticVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

pub(crate) fn run_update(config: &UpdateConfig) -> Result<(), String> {
    let current_exe =
        env::current_exe().map_err(|err| format!("failed to locate current executable: {err}"))?;
    if looks_like_cargo_target_binary(&current_exe) {
        return Err(format!(
            "refusing to self-update Cargo target binary '{}'; install and run a release binary instead",
            current_exe.display()
        ));
    }

    let current_exe_name = current_binary_name();
    if current_exe
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        != current_exe_name
    {
        warn(
            UPDATE_TARGET,
            format!(
                "current executable name is '{}', but release assets expect '{}'",
                current_exe.display(),
                current_exe_name
            ),
        );
    }

    let mut progress = ProgressReporter::new();
    let client = build_http_client()?;
    let current_version = parse_semantic_version(env!("CARGO_PKG_VERSION"))?;

    progress.begin_stage(
        1,
        STAGE_TOTAL,
        StageKind::CheckingRelease,
        "Checking release metadata",
    );
    let release = fetch_release(&client, config.target_tag.as_deref())?;
    let requested_tag = config.target_tag.as_deref().unwrap_or(&release.tag_name);
    let target_version = parse_semantic_version(requested_tag.trim_start_matches('v'))?;
    progress.finish_stage(format!("Resolved release {}", release.tag_name));

    if config.target_tag.is_none() && target_version <= current_version {
        progress.finish_success(format!(
            "Already up to date at v{}.{}.{}",
            current_version.major, current_version.minor, current_version.patch
        ));
        return Ok(());
    }

    progress.begin_stage(
        2,
        STAGE_TOTAL,
        StageKind::ResolvingAsset,
        "Resolving platform asset",
    );
    let asset_candidates = release_asset_candidates(&release.tag_name)?;
    let asset = release
        .assets
        .iter()
        .find(|asset| {
            asset_candidates
                .iter()
                .any(|candidate| candidate == &asset.name)
        })
        .ok_or_else(|| {
            format!(
                "release '{}' does not contain any supported asset for this platform: {}",
                release.tag_name,
                asset_candidates.join(", ")
            )
        })?;
    progress.finish_stage(format!(
        "Selected asset '{}' ({})",
        asset.name,
        format_bytes(asset.size)
    ));

    let workspace = prepare_update_workspace(&current_exe)?;
    let archive_path = workspace.join(&asset.name);
    let extracted_binary_path = workspace.join(current_exe_name);

    progress.begin_stage(
        3,
        STAGE_TOTAL,
        StageKind::Downloading,
        "Downloading release archive",
    );
    download_asset(&client, asset, &archive_path, &mut progress)?;
    progress.finish_stage(format!("Downloaded '{}'", asset.name));

    progress.begin_stage(
        4,
        STAGE_TOTAL,
        StageKind::Extracting,
        "Extracting executable",
    );
    extract_binary(&archive_path, &extracted_binary_path)?;
    progress.finish_stage(format!(
        "Extracted staged binary '{}'",
        extracted_binary_path.display()
    ));

    progress.begin_stage(
        5,
        STAGE_TOTAL,
        StageKind::ReplacingBinary,
        "Replacing current binary",
    );
    info(
        UPDATE_TARGET,
        format!(
            "Installing '{}' from release {}",
            current_exe.display(),
            release.tag_name
        ),
    );
    self_replace::self_replace(&extracted_binary_path)
        .map_err(|err| format!("failed to replace current executable: {err}"))?;
    progress.finish_stage(format!("Installed {}", release.tag_name));

    if let Err(err) = fs::remove_dir_all(&workspace) {
        warn(
            UPDATE_TARGET,
            format!(
                "updated successfully, but failed to remove temporary update workspace '{}': {err}",
                workspace.display()
            ),
        );
    }

    progress.finish_success(format!(
        "Updated to {}. Re-run `hier-viewer --help` or your usual viewer command to continue.",
        release.tag_name
    ));
    Ok(())
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(format!("hier-viewer/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("failed to create HTTP client: {err}"))
}

fn fetch_release(client: &Client, requested_tag: Option<&str>) -> Result<GitHubRelease, String> {
    let endpoint = match requested_tag {
        Some(tag) => format!("{RELEASES_API_BASE}/tags/{tag}"),
        None => format!("{RELEASES_API_BASE}/latest"),
    };
    info(
        UPDATE_TARGET,
        format!("Querying GitHub release metadata: {endpoint}"),
    );

    let response = client
        .get(&endpoint)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|err| format!("failed to query GitHub Releases API '{}': {err}", endpoint))?;
    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        return Err(match requested_tag {
            Some(tag) => format!("release tag '{}' was not found on GitHub", tag),
            None => "failed to resolve the latest GitHub release".to_string(),
        });
    }
    let release = response
        .error_for_status()
        .map_err(|err| {
            format!(
                "GitHub Releases API request failed for '{}': {err}",
                endpoint
            )
        })?
        .json::<GitHubRelease>()
        .map_err(|err| format!("failed to decode GitHub release metadata: {err}"))?;

    if requested_tag.is_none() && release.prerelease {
        return Err(format!(
            "expected latest stable release, but GitHub returned prerelease '{}'",
            release.tag_name
        ));
    }
    Ok(release)
}

fn prepare_update_workspace(current_exe: &Path) -> Result<PathBuf, String> {
    let exe_dir = current_exe.parent().ok_or_else(|| {
        format!(
            "failed to determine executable directory for '{}'",
            current_exe.display()
        )
    })?;
    let pid = std::process::id();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("failed to determine current time: {err}"))?
        .as_millis();

    for attempt in 0..32u32 {
        let workspace = exe_dir.join(format!(
            ".hier-viewer-update-{pid}-{timestamp}-{}",
            attempt + 1
        ));
        match fs::create_dir(&workspace) {
            Ok(()) => {
                info(
                    UPDATE_TARGET,
                    format!("Using update workspace '{}'", workspace.display()),
                );
                return Ok(workspace);
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(format!(
                    "failed to create update workspace in '{}': {err}. Check that the executable directory is writable.",
                    exe_dir.display()
                ));
            }
        }
    }

    Err(format!(
        "failed to allocate a unique update workspace in '{}'",
        exe_dir.display()
    ))
}

fn download_asset(
    client: &Client,
    asset: &GitHubAsset,
    archive_path: &Path,
    progress: &mut ProgressReporter,
) -> Result<(), String> {
    info(
        UPDATE_TARGET,
        format!(
            "Downloading '{}' from '{}'",
            asset.name, asset.browser_download_url
        ),
    );
    let mut response = client
        .get(&asset.browser_download_url)
        .send()
        .map_err(|err| {
            format!(
                "failed to start download from '{}': {err}",
                asset.browser_download_url
            )
        })?
        .error_for_status()
        .map_err(|err| {
            format!(
                "download request failed for '{}': {err}",
                asset.browser_download_url
            )
        })?;

    let total_bytes = response
        .content_length()
        .filter(|value| *value > 0)
        .or_else(|| (asset.size > 0).then_some(asset.size));
    let mut file = File::create(archive_path).map_err(|err| {
        format!(
            "failed to create downloaded archive '{}': {err}",
            archive_path.display()
        )
    })?;

    let mut buffer = vec![0u8; DOWNLOAD_BUFFER_SIZE];
    let mut downloaded_bytes = 0u64;
    let mut last_logged_bytes = 0u64;
    let started_at = Instant::now();

    loop {
        let bytes_read = response
            .read(&mut buffer)
            .map_err(|err| format!("failed while downloading '{}': {err}", asset.name))?;
        if bytes_read == 0 {
            break;
        }
        file.write_all(&buffer[..bytes_read]).map_err(|err| {
            format!(
                "failed to write downloaded archive '{}': {err}",
                archive_path.display()
            )
        })?;
        downloaded_bytes += bytes_read as u64;
        progress.update_download(downloaded_bytes, total_bytes, started_at.elapsed());

        if !progress.interactive()
            && downloaded_bytes.saturating_sub(last_logged_bytes) >= DOWNLOAD_LOG_STEP_BYTES
        {
            last_logged_bytes = downloaded_bytes;
            info(
                UPDATE_TARGET,
                format!(
                    "Downloaded {}{}",
                    format_bytes(downloaded_bytes),
                    total_bytes
                        .map(|total| format!(" / {}", format_bytes(total)))
                        .unwrap_or_default()
                ),
            );
        }
    }

    file.flush().map_err(|err| {
        format!(
            "failed to flush downloaded archive '{}': {err}",
            archive_path.display()
        )
    })?;
    progress.update_download(downloaded_bytes, total_bytes, started_at.elapsed());
    Ok(())
}

fn extract_binary(archive_path: &Path, extracted_binary_path: &Path) -> Result<(), String> {
    let file_name = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid archive path '{}'", archive_path.display()))?;
    if file_name.ends_with(".tar.gz") {
        extract_from_tar_gz(archive_path, extracted_binary_path)?;
    } else if file_name.ends_with(".zip") {
        extract_from_zip(archive_path, extracted_binary_path)?;
    } else {
        fs::copy(archive_path, extracted_binary_path).map_err(|err| {
            format!(
                "failed to stage downloaded binary '{}' to '{}': {err}",
                archive_path.display(),
                extracted_binary_path.display()
            )
        })?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(extracted_binary_path, permissions).map_err(|err| {
            format!(
                "failed to mark extracted binary '{}' executable: {err}",
                extracted_binary_path.display()
            )
        })?;
    }

    Ok(())
}

fn extract_from_tar_gz(archive_path: &Path, extracted_binary_path: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path)
        .map_err(|err| format!("failed to open archive '{}': {err}", archive_path.display()))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    let binary_name = current_binary_name();

    for entry in archive.entries().map_err(|err| {
        format!(
            "failed to enumerate tar entries in '{}': {err}",
            archive_path.display()
        )
    })? {
        let mut entry = entry.map_err(|err| {
            format!(
                "failed to read tar entry in '{}': {err}",
                archive_path.display()
            )
        })?;
        let entry_path = entry.path().map_err(|err| {
            format!(
                "failed to read tar entry path in '{}': {err}",
                archive_path.display()
            )
        })?;
        let matches_binary = entry_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == binary_name);
        if !matches_binary {
            continue;
        }
        entry.unpack(extracted_binary_path).map_err(|err| {
            format!(
                "failed to extract '{}' from '{}': {err}",
                binary_name,
                archive_path.display()
            )
        })?;
        return Ok(());
    }

    Err(format!(
        "release archive '{}' does not contain '{}'",
        archive_path.display(),
        binary_name
    ))
}

fn extract_from_zip(archive_path: &Path, extracted_binary_path: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path)
        .map_err(|err| format!("failed to open archive '{}': {err}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|err| format!("failed to open zip '{}': {err}", archive_path.display()))?;
    let binary_name = current_binary_name();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|err| {
            format!(
                "failed to read zip entry {} in '{}': {err}",
                index,
                archive_path.display()
            )
        })?;
        let matches_binary = entry.enclosed_name().is_some_and(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value == binary_name)
        });
        if !matches_binary {
            continue;
        }
        let mut output = File::create(extracted_binary_path).map_err(|err| {
            format!(
                "failed to create extracted binary '{}': {err}",
                extracted_binary_path.display()
            )
        })?;
        io::copy(&mut entry, &mut output).map_err(|err| {
            format!(
                "failed to extract '{}' from '{}': {err}",
                binary_name,
                archive_path.display()
            )
        })?;
        output.flush().map_err(|err| {
            format!(
                "failed to flush extracted binary '{}': {err}",
                extracted_binary_path.display()
            )
        })?;
        return Ok(());
    }

    Err(format!(
        "release archive '{}' does not contain '{}'",
        archive_path.display(),
        binary_name
    ))
}

fn current_binary_name() -> &'static str {
    if cfg!(windows) {
        "hier-viewer.exe"
    } else {
        "hier-viewer"
    }
}

fn release_asset_candidates(tag: &str) -> Result<Vec<String>, String> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => Ok(vec![
            format!("hier-viewer-{tag}-x86_64-unknown-linux-gnu.tar.gz"),
            format!("hier-viewer-{tag}-x86_64-unknown-linux-gnu"),
        ]),
        ("macos", "x86_64") => Ok(vec![
            format!("hier-viewer-{tag}-x86_64-apple-darwin.tar.gz"),
            format!("hier-viewer-{tag}-x86_64-apple-darwin"),
        ]),
        ("macos", "aarch64") => Ok(vec![
            format!("hier-viewer-{tag}-aarch64-apple-darwin.tar.gz"),
            format!("hier-viewer-{tag}-aarch64-apple-darwin"),
        ]),
        ("windows", "x86_64") => Ok(vec![
            format!("hier-viewer-{tag}-x86_64-pc-windows-msvc.zip"),
            format!("hier-viewer-{tag}-x86_64-pc-windows-msvc.exe"),
        ]),
        (os, arch) => Err(format!(
            "self-update is not supported on '{}-{}' because no matching release asset is published",
            arch, os
        )),
    }
}

fn parse_semantic_version(raw: &str) -> Result<SemanticVersion, String> {
    let normalized = raw.trim().trim_start_matches('v');
    let mut segments = normalized.split('.');
    let major = segments
        .next()
        .ok_or_else(|| format!("invalid version '{raw}'"))?
        .parse::<u64>()
        .map_err(|_| format!("invalid version '{raw}'"))?;
    let minor = segments
        .next()
        .ok_or_else(|| format!("invalid version '{raw}'"))?
        .parse::<u64>()
        .map_err(|_| format!("invalid version '{raw}'"))?;
    let patch = segments
        .next()
        .ok_or_else(|| format!("invalid version '{raw}'"))?
        .parse::<u64>()
        .map_err(|_| format!("invalid version '{raw}'"))?;
    if segments.next().is_some() {
        return Err(format!("invalid version '{raw}'"));
    }
    Ok(SemanticVersion {
        major,
        minor,
        patch,
    })
}

fn looks_like_cargo_target_binary(executable: &Path) -> bool {
    let ancestors = executable
        .ancestors()
        .filter_map(|path| path.file_name().and_then(|value| value.to_str()))
        .collect::<Vec<_>>();

    ancestors
        .windows(2)
        .any(|window| window[1] == "target" && matches!(window[0], "debug" | "release"))
        || ancestors.windows(3).any(|window| {
            window[2] == "target" && matches!(window[1], "debug" | "release") && window[0] == "deps"
        })
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit_index = 0usize;
    while value >= 1024.0 && unit_index + 1 < UNITS.len() {
        value /= 1024.0;
        unit_index += 1;
    }
    if unit_index == 0 {
        format!("{bytes} {}", UNITS[unit_index])
    } else {
        format!("{value:.1} {}", UNITS[unit_index])
    }
}

fn format_rate(bytes_per_second: f64) -> String {
    if bytes_per_second <= 0.0 {
        return "0 B/s".to_string();
    }
    format!("{}/s", format_bytes(bytes_per_second.round() as u64))
}

fn format_stage_bar(fraction: f64, width: usize, unicode: bool) -> String {
    let clamped = fraction.clamp(0.0, 1.0);
    let filled = (clamped * width as f64).round() as usize;
    let filled = filled.min(width);
    let empty = width.saturating_sub(filled);
    if unicode {
        format!("{}{}", "█".repeat(filled), "░".repeat(empty))
    } else {
        format!("{}{}", "#".repeat(filled), "-".repeat(empty))
    }
}

fn terminal_prefix(kind: StageKind, unicode: bool) -> &'static str {
    match (kind, unicode) {
        (StageKind::CheckingRelease, true) => "🔎",
        (StageKind::ResolvingAsset, true) => "📦",
        (StageKind::Downloading, true) => "⬇️ ",
        (StageKind::Extracting, true) => "📂",
        (StageKind::ReplacingBinary, true) => "🔁",
        (StageKind::Finished, true) => "✅",
        (StageKind::CheckingRelease, false) => "[check]",
        (StageKind::ResolvingAsset, false) => "[asset]",
        (StageKind::Downloading, false) => "[down]",
        (StageKind::Extracting, false) => "[xtrct]",
        (StageKind::ReplacingBinary, false) => "[swap]",
        (StageKind::Finished, false) => "[done]",
    }
}

fn style(text: &str, color_code: &str, enabled: bool) -> String {
    if enabled {
        format!("{color_code}{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

#[derive(Clone, Copy, Debug)]
enum StageKind {
    CheckingRelease,
    ResolvingAsset,
    Downloading,
    Extracting,
    ReplacingBinary,
    Finished,
}

struct ProgressReporter {
    interactive: bool,
    color: bool,
    unicode: bool,
    current_stage: usize,
    total_stages: usize,
    current_kind: StageKind,
    current_label: String,
    last_render_at: Instant,
}

impl ProgressReporter {
    fn new() -> Self {
        Self {
            interactive: stderr_is_terminal(),
            color: supports_color_output(),
            unicode: supports_unicode_output(),
            current_stage: 0,
            total_stages: 0,
            current_kind: StageKind::CheckingRelease,
            current_label: String::new(),
            last_render_at: Instant::now() - Duration::from_secs(1),
        }
    }

    fn interactive(&self) -> bool {
        self.interactive
    }

    fn begin_stage(
        &mut self,
        current_stage: usize,
        total_stages: usize,
        kind: StageKind,
        label: &str,
    ) {
        self.current_stage = current_stage;
        self.total_stages = total_stages;
        self.current_kind = kind;
        self.current_label.clear();
        self.current_label.push_str(label);

        if self.interactive {
            self.render_line(0.0, None);
        } else {
            info(
                UPDATE_TARGET,
                format!("[{current_stage}/{total_stages}] {label}"),
            );
        }
    }

    fn update_download(
        &mut self,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
        elapsed: Duration,
    ) {
        if !self.interactive {
            return;
        }
        let now = Instant::now();
        if now.duration_since(self.last_render_at) < Duration::from_millis(80) {
            return;
        }
        self.last_render_at = now;

        let fraction = total_bytes
            .filter(|value| *value > 0)
            .map(|total| downloaded_bytes as f64 / total as f64)
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        let rate = downloaded_bytes as f64 / elapsed.as_secs_f64().max(0.001);
        let detail = match total_bytes {
            Some(total) if total > 0 => format!(
                "{:>5.1}% {} / {} {}",
                fraction * 100.0,
                format_bytes(downloaded_bytes),
                format_bytes(total),
                format_rate(rate)
            ),
            _ => format!("{} {}", format_bytes(downloaded_bytes), format_rate(rate)),
        };
        self.render_line(fraction, Some(&detail));
    }

    fn finish_stage(&mut self, message: String) {
        self.clear_progress_line();
        info(UPDATE_TARGET, message);
    }

    fn finish_success(&mut self, message: String) {
        if self.interactive {
            self.current_stage = self.total_stages;
            self.current_kind = StageKind::Finished;
            self.current_label = message.clone();
            self.render_line(1.0, None);
            eprintln!();
        }
        info(UPDATE_TARGET, message);
    }

    fn clear_progress_line(&self) {
        if self.interactive {
            eprint!("\r\x1b[2K");
            let _ = io::stderr().flush();
        }
    }

    fn render_line(&self, stage_fraction: f64, detail: Option<&str>) {
        let overall_fraction = ((self.current_stage.saturating_sub(1)) as f64 + stage_fraction)
            / self.total_stages.max(1) as f64;
        let prefix = terminal_prefix(self.current_kind, self.unicode);
        let stage_counter = style(
            &format!("[{}/{}]", self.current_stage, self.total_stages),
            "\x1b[90m",
            self.color,
        );
        let progress_bar = style(
            &format!("[{}]", format_stage_bar(overall_fraction, 18, self.unicode)),
            "\x1b[36m",
            self.color,
        );
        let label = style(&self.current_label, "\x1b[35m", self.color);
        let extra = detail.unwrap_or_default();
        eprint!("\r\x1b[2K{prefix} {stage_counter} {progress_bar} {label}");
        if !extra.is_empty() {
            eprint!(" {}", style(extra, "\x1b[33m", self.color));
        }
        let _ = io::stderr().flush();
    }
}

#[cfg(test)]
mod tests {
    use super::{looks_like_cargo_target_binary, parse_semantic_version, release_asset_candidates};
    use std::path::Path;

    #[test]
    fn parses_versions() {
        let version = parse_semantic_version("v1.2.3").expect("version should parse");
        assert_eq!(version.major, 1);
        assert_eq!(version.minor, 2);
        assert_eq!(version.patch, 3);
        assert!(parse_semantic_version("1.2").is_err());
    }

    #[test]
    fn detects_cargo_target_paths() {
        assert!(looks_like_cargo_target_binary(Path::new(
            "/tmp/hier-viewer/target/debug/hier-viewer"
        )));
        assert!(looks_like_cargo_target_binary(Path::new(
            "/tmp/hier-viewer/target/release/deps/hier_viewer-abcd"
        )));
        assert!(!looks_like_cargo_target_binary(Path::new(
            "/usr/local/bin/hier-viewer"
        )));
    }

    #[test]
    fn resolves_supported_asset_candidates() {
        let asset_names = release_asset_candidates("v1.0.0");
        match (std::env::consts::OS, std::env::consts::ARCH, asset_names) {
            ("linux", "x86_64", Ok(value)) => {
                assert_eq!(
                    value,
                    vec![
                        "hier-viewer-v1.0.0-x86_64-unknown-linux-gnu.tar.gz".to_string(),
                        "hier-viewer-v1.0.0-x86_64-unknown-linux-gnu".to_string()
                    ]
                )
            }
            ("macos", "x86_64", Ok(value)) => {
                assert_eq!(
                    value,
                    vec![
                        "hier-viewer-v1.0.0-x86_64-apple-darwin.tar.gz".to_string(),
                        "hier-viewer-v1.0.0-x86_64-apple-darwin".to_string()
                    ]
                )
            }
            ("macos", "aarch64", Ok(value)) => {
                assert_eq!(
                    value,
                    vec![
                        "hier-viewer-v1.0.0-aarch64-apple-darwin.tar.gz".to_string(),
                        "hier-viewer-v1.0.0-aarch64-apple-darwin".to_string()
                    ]
                )
            }
            ("windows", "x86_64", Ok(value)) => {
                assert_eq!(
                    value,
                    vec![
                        "hier-viewer-v1.0.0-x86_64-pc-windows-msvc.zip".to_string(),
                        "hier-viewer-v1.0.0-x86_64-pc-windows-msvc.exe".to_string()
                    ]
                )
            }
            (_, _, Err(_)) => {}
            (os, arch, outcome) => {
                panic!("unexpected asset mapping outcome for {arch}-{os}: {outcome:?}")
            }
        }
    }
}
