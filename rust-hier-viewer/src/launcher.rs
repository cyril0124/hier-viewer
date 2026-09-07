use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::UNIX_EPOCH;

use fuzzy_matcher::FuzzyMatcher;
use fuzzy_matcher::skim::SkimMatcherV2;
use globset::{Glob, GlobSetBuilder};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use shell_words::split as shell_split;
use walkdir::{DirEntry, WalkDir};

use crate::logging::{color_env_value, info, warn};

const RTL_EXTENSIONS: &[&str] = &["sv", "svh", "v", "vh"];
const MAX_SUGGESTIONS: usize = 18;
const EXPORTER_BINARY_NAME: &str = if cfg!(windows) {
    "slang-hier-exporter.exe"
} else {
    "slang-hier-exporter"
};
const EMBEDDED_EXPORTER_DIR_ENV: &str = "HIER_VIEWER_EMBEDDED_EXPORTER_DIR";
const EMBEDDED_EXPORTER_BYTES: &[u8] = include_bytes!(env!("HIER_VIEWER_EMBEDDED_EXPORTER_PATH"));
const EMBEDDED_EXPORTER_HASH: &str = env!("HIER_VIEWER_EMBEDDED_EXPORTER_HASH");
static EMBEDDED_EXPORTER_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PatternMode {
    Literal,
    Wildcard,
    Regex,
}

impl PatternMode {
    pub(crate) fn label(self) -> &'static str {
        match self {
            PatternMode::Literal => "Literal",
            PatternMode::Wildcard => "Wildcard",
            PatternMode::Regex => "Regex",
        }
    }

    pub(crate) fn example(self) -> &'static str {
        match self {
            PatternMode::Literal => "examples: rtl/top.sv ; rtl/core",
            PatternMode::Wildcard => "examples: rtl/**/*.sv ; tb/*.v",
            PatternMode::Regex => "examples: ^rtl/.+\\.sv$ ; (^|/)top\\.sv$",
        }
    }

    pub(crate) fn next(self) -> Self {
        match self {
            PatternMode::Literal => PatternMode::Wildcard,
            PatternMode::Wildcard => PatternMode::Regex,
            PatternMode::Regex => PatternMode::Literal,
        }
    }

    pub(crate) fn prev(self) -> Self {
        match self {
            PatternMode::Literal => PatternMode::Regex,
            PatternMode::Wildcard => PatternMode::Literal,
            PatternMode::Regex => PatternMode::Wildcard,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct StartupSelection {
    pub(crate) output_dir: String,
    pub(crate) title: Option<String>,
    pub(crate) source_args_tokens: Vec<String>,
    pub(crate) extra_args_tokens: Vec<String>,
    pub(crate) rebuild_sqlite: bool,
}

#[derive(Debug)]
pub(crate) struct ExportResult {
    pub(crate) sqlite_path: String,
    pub(crate) temporary: bool,
}

#[derive(Clone, Debug)]
struct HierarchyExporter {
    path: PathBuf,
    cache_fingerprint: String,
    source: &'static str,
}

#[derive(Clone, Debug)]
pub(crate) struct FileIndex {
    cwd: PathBuf,
    home_dir: Option<PathBuf>,
    rtl_files_relative: Vec<String>,
    rtl_files_absolute: Vec<String>,
}

impl FileIndex {
    pub(crate) fn for_inputs(rtl_paths: &[String]) -> Result<Self, String> {
        let cwd = env::current_dir()
            .map_err(|err| format!("failed to determine current directory: {err}"))?;
        Self::for_inputs_at(cwd, rtl_paths)
    }

    fn for_inputs_at(cwd: PathBuf, rtl_paths: &[String]) -> Result<Self, String> {
        let patterns = if rtl_paths.iter().any(|path| !path.trim().is_empty()) {
            normalize_patterns(rtl_paths)?
        } else {
            Vec::new()
        };
        if patterns.iter().any(|pattern| {
            contains_glob_meta(pattern) && !pattern.starts_with('/') && !pattern.starts_with('~')
        }) {
            return Self::build_at(cwd);
        }
        Ok(Self {
            cwd,
            home_dir: home_dir(),
            rtl_files_relative: Vec::new(),
            rtl_files_absolute: Vec::new(),
        })
    }

    pub(crate) fn build() -> Result<Self, String> {
        let cwd = env::current_dir()
            .map_err(|err| format!("failed to determine current directory: {err}"))?;
        Self::build_at(cwd)
    }

    fn build_at(cwd: PathBuf) -> Result<Self, String> {
        let mut rtl_files_relative = Vec::new();
        let mut rtl_files_absolute = Vec::new();
        let walker = WalkDir::new(&cwd)
            .follow_links(false)
            .into_iter()
            .filter_entry(should_visit);

        for entry in walker {
            let entry = entry.map_err(|err| format!("failed to scan filesystem: {err}"))?;
            if !entry.file_type().is_file() {
                continue;
            }
            if !is_rtl_file(entry.path()) {
                continue;
            }
            let relative = entry.path().strip_prefix(&cwd).map_err(|err| {
                format!(
                    "failed to relativize path '{}': {err}",
                    entry.path().display()
                )
            })?;
            rtl_files_relative.push(path_to_unix_string(relative));
            rtl_files_absolute.push(path_to_unix_string(entry.path()));
        }

        rtl_files_relative.sort();
        rtl_files_absolute.sort();
        Ok(Self {
            cwd,
            home_dir: home_dir(),
            rtl_files_relative,
            rtl_files_absolute,
        })
    }

    pub(crate) fn suggestions(&self, raw_patterns: &str, mode: PatternMode) -> Vec<String> {
        let token = last_pattern_token(raw_patterns);
        let candidates = self.suggestion_candidates(&token);
        let display_candidates = self.display_candidates(candidates, &token);
        if token.is_empty() {
            return display_candidates
                .into_iter()
                .take(MAX_SUGGESTIONS)
                .collect();
        }

        let matched = match mode {
            PatternMode::Literal => {
                let mut suggestions = path_completion_suggestions(
                    &self.cwd,
                    self.home_dir.as_deref(),
                    &token,
                    PathCompletionKind::RtlOnly,
                );
                extend_unique(
                    &mut suggestions,
                    fuzzy_suggestions(&display_candidates, &token),
                );
                suggestions
            }
            PatternMode::Wildcard => {
                let mut suggestions = path_completion_suggestions(
                    &self.cwd,
                    self.home_dir.as_deref(),
                    &token,
                    PathCompletionKind::RtlOnly,
                );
                if let Ok(glob_set) = build_glob_matcher(&[token.as_str()]) {
                    extend_unique(
                        &mut suggestions,
                        display_candidates
                            .iter()
                            .filter(|path| glob_set.is_match(path))
                            .cloned()
                            .collect::<Vec<_>>(),
                    );
                }
                let fuzzy_token = wildcard_fuzzy_token(&token);
                if !fuzzy_token.is_empty() {
                    extend_unique(
                        &mut suggestions,
                        fuzzy_suggestions(&display_candidates, &fuzzy_token),
                    );
                }
                suggestions
            }
            PatternMode::Regex => match Regex::new(&token) {
                Ok(regex) => display_candidates
                    .iter()
                    .filter(|path| regex.is_match(path))
                    .cloned()
                    .collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            },
        };

        matched.into_iter().take(MAX_SUGGESTIONS).collect()
    }

    pub(crate) fn resolve_patterns(
        &self,
        raw_patterns: &[String],
        mode: PatternMode,
    ) -> Result<Vec<String>, String> {
        let patterns = normalize_patterns(raw_patterns)?;
        let mut files = BTreeSet::new();

        match mode {
            PatternMode::Literal => {
                for pattern in patterns {
                    resolve_literal_pattern_into(
                        &mut files,
                        &self.cwd,
                        self.home_dir.as_deref(),
                        &pattern,
                    )?;
                }
            }
            PatternMode::Wildcard => {
                let mut relative_patterns = Vec::new();
                let mut absolute_patterns = Vec::new();
                for pattern in patterns {
                    if !contains_glob_meta(&pattern) {
                        let path =
                            resolve_literal_path(&self.cwd, self.home_dir.as_deref(), &pattern);
                        if path.exists() {
                            resolve_literal_pattern_into(
                                &mut files,
                                &self.cwd,
                                self.home_dir.as_deref(),
                                &pattern,
                            )?;
                            continue;
                        }
                    }
                    if pattern.starts_with('/') || pattern.starts_with('~') {
                        absolute_patterns.push(
                            expand_home_token(&pattern, self.home_dir.as_deref())
                                .unwrap_or(pattern),
                        );
                    } else {
                        relative_patterns.push(pattern);
                    }
                }

                if !relative_patterns.is_empty() {
                    let glob_set = build_glob_matcher(
                        &relative_patterns
                            .iter()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                    )?;
                    for relative in &self.rtl_files_relative {
                        if glob_set.is_match(relative) {
                            files.insert(path_to_unix_string(self.cwd.join(relative)));
                        }
                    }
                }

                if !absolute_patterns.is_empty() {
                    for pattern in absolute_patterns {
                        resolve_absolute_glob_pattern_into(&mut files, &pattern)?;
                    }
                }
            }
            PatternMode::Regex => {
                let regexes = patterns
                    .iter()
                    .map(|pattern| {
                        Regex::new(pattern)
                            .map_err(|err| format!("invalid regex '{}': {err}", pattern))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let candidates = if patterns.iter().any(|pattern| pattern.starts_with('/')) {
                    &self.rtl_files_absolute
                } else {
                    &self.rtl_files_relative
                };
                for path in candidates {
                    if regexes.iter().any(|regex| regex.is_match(path)) {
                        let absolute = if path.starts_with('/') {
                            path.clone()
                        } else {
                            path_to_unix_string(self.cwd.join(path))
                        };
                        files.insert(absolute);
                    }
                }
            }
        }

        if files.is_empty() {
            return Err("no RTL files matched the current path input".to_string());
        }

        Ok(files.into_iter().collect())
    }

    pub(crate) fn file_count(&self) -> usize {
        self.rtl_files_relative.len()
    }

    pub(crate) fn filelist_suggestions(&self, token: &str) -> Vec<String> {
        path_completion_suggestions(
            &self.cwd,
            self.home_dir.as_deref(),
            token,
            PathCompletionKind::AnyFile,
        )
        .into_iter()
        .take(MAX_SUGGESTIONS)
        .collect()
    }

    pub(crate) fn build_source_args(
        &self,
        rtl_paths: &[String],
        mode: PatternMode,
        filelists: &[String],
    ) -> Result<Vec<String>, String> {
        let resolved_files = if rtl_paths.iter().any(|path| !path.trim().is_empty()) {
            self.resolve_patterns(rtl_paths, mode)?
        } else {
            Vec::new()
        };
        let resolved_filelists = self.resolve_filelists(filelists)?;
        let mut source_args_tokens =
            Vec::with_capacity(resolved_filelists.len() * 2 + resolved_files.len());
        for filelist in resolved_filelists {
            source_args_tokens.push("-f".to_string());
            source_args_tokens.push(filelist);
        }
        source_args_tokens.extend(resolved_files);
        Ok(source_args_tokens)
    }

    fn suggestion_candidates(&self, token: &str) -> &[String] {
        if token.starts_with('/') || token.starts_with('~') {
            &self.rtl_files_absolute
        } else {
            &self.rtl_files_relative
        }
    }

    fn display_candidates(&self, candidates: &[String], token: &str) -> Vec<String> {
        if token.starts_with('~') {
            candidates
                .iter()
                .map(|path| tilde_display(path, self.home_dir.as_deref()))
                .collect()
        } else {
            candidates.to_vec()
        }
    }

    fn resolve_filelists(&self, filelists: &[String]) -> Result<Vec<String>, String> {
        if !filelists.iter().any(|filelist| !filelist.trim().is_empty()) {
            return Ok(Vec::new());
        }
        let mut resolved = Vec::new();
        for filelist in normalize_patterns(filelists)? {
            let path = resolve_literal_path(&self.cwd, self.home_dir.as_deref(), &filelist);
            if !path.is_file() {
                return Err(format!("filelist '{}' does not exist as a file", filelist));
            }
            resolved.push(path_to_unix_string(path));
        }
        Ok(resolved)
    }
}

pub(crate) fn parse_extra_args(raw: &str) -> Result<Vec<String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    shell_split(trimmed).map_err(|err| format!("failed to parse extra flags: {err}"))
}

pub(crate) fn run_hier_viewer_export(selection: &StartupSelection) -> Result<ExportResult, String> {
    let exporter = locate_hierarchy_exporter()?;
    info(
        "launcher",
        format!(
            "Using hierarchy exporter '{}' [{}]",
            exporter.path.display(),
            exporter.source
        ),
    );
    let cache_dir = sqlite_cache_dir(&selection.output_dir);
    fs::create_dir_all(&cache_dir).map_err(|err| {
        format!(
            "failed to create sqlite cache directory '{}': {err}",
            cache_dir.display()
        )
    })?;
    let cache_key = compute_sqlite_cache_key(selection, &exporter)?;
    let export_path = cache_dir.join(format!("{cache_key}.sqlite"));
    if export_path.is_file()
        && !selection.rebuild_sqlite
        && cached_dependencies_match(&export_path)?
    {
        info(
            "launcher",
            format!(
                "Reusing cached sqlite export '{}'. Building HTML bundle...",
                export_path.display()
            ),
        );
        return Ok(ExportResult {
            sqlite_path: path_to_unix_string(&export_path),
            temporary: false,
        });
    }

    let temp_export_path = export_path.with_extension("sqlite.tmp");
    let rebuild_reason = sqlite_rebuild_reason(&cache_dir, &export_path, selection.rebuild_sqlite)?;
    info(
        "launcher",
        format!(
            "{} {} --sqlite with {} source arguments (reason: {})...",
            if selection.rebuild_sqlite {
                "Force rebuilding"
            } else {
                "Running"
            },
            exporter.path.display(),
            selection.source_args_tokens.len(),
            rebuild_reason
        ),
    );
    let mut command = Command::new(&exporter.path);
    command.arg("--sqlite");
    command.arg("-o");
    command.arg(&temp_export_path);
    command.args(&selection.extra_args_tokens);
    command.args(&selection.source_args_tokens);
    command.env("HIER_VIEWER_LOG_COLOR", color_env_value());
    command.stdout(Stdio::null());
    command.stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|err| {
        format!(
            "failed to run hierarchy exporter '{}': {err}",
            exporter.path.display()
        )
    })?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture exporter stderr".to_string())?;
    let stderr_handle = thread::spawn(move || -> Result<String, String> {
        let mut collected = String::new();
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = line.map_err(|err| format!("failed to read exporter stderr: {err}"))?;
            if line.starts_with('[') || line.starts_with('\u{1b}') {
                eprintln!("{line}");
            } else if !line.trim().is_empty() {
                warn("slang-hier-exporter", &line);
            }
            collected.push_str(&line);
            collected.push('\n');
        }
        Ok(collected)
    });

    let status = child
        .wait()
        .map_err(|err| format!("failed to wait for hierarchy exporter: {err}"))?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| "stderr forwarding thread panicked".to_string())??;

    if !status.success() {
        let _ = fs::remove_file(&temp_export_path);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("hierarchy exporter exited with status {}", status)
        } else {
            format!("hierarchy exporter failed: {detail}")
        });
    }

    store_dependency_signature(&temp_export_path)?;

    if export_path.exists() {
        fs::remove_file(&export_path).map_err(|err| {
            format!(
                "failed to replace cached sqlite '{}': {err}",
                export_path.display()
            )
        })?;
    }
    fs::rename(&temp_export_path, &export_path).or_else(|rename_err| {
        fs::copy(&temp_export_path, &export_path)
            .map_err(|copy_err| {
                format!(
                    "failed to finalize sqlite cache '{}': rename error: {rename_err}; copy error: {copy_err}",
                    export_path.display()
                )
            })
            .map(|_| ())
    })?;
    let _ = fs::remove_file(&temp_export_path);
    info(
        "launcher",
        format!(
            "Hierarchy exporter finished, sqlite cached at '{}'. Building HTML bundle...",
            export_path.display()
        ),
    );
    Ok(ExportResult {
        sqlite_path: path_to_unix_string(&export_path),
        temporary: false,
    })
}

fn source_dependency_signature(db: &Connection) -> Result<Option<String>, String> {
    let mut statement = db
        .prepare("SELECT path FROM source_dependencies ORDER BY path")
        .map_err(|err| format!("failed to query source dependencies: {err}"))?;
    let paths = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("failed to read source dependencies: {err}"))?;
    let mut hasher = StableHasher::default();
    for path in paths {
        let path = path.map_err(|err| format!("failed to read source dependency path: {err}"))?;
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                info(
                    "launcher",
                    format!("cache miss: source dependency '{path}' was deleted"),
                );
                return Ok(None);
            }
            Err(err) => return Err(format!("failed to stat source dependency '{path}': {err}")),
        };
        write_metadata_fingerprint(&mut hasher, Path::new(&path), &metadata)?;
    }
    Ok(Some(hasher.finish_hex()))
}

fn store_dependency_signature(path: &Path) -> Result<(), String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|err| format!("failed to open exported sqlite '{}': {err}", path.display()))?;
    let signature = source_dependency_signature(&db)?.ok_or_else(|| {
        "source dependency disappeared while finalizing sqlite export".to_string()
    })?;
    db.execute_batch("CREATE TABLE cache_metadata (dependency_signature TEXT NOT NULL)")
        .map_err(|err| format!("failed to create sqlite cache metadata: {err}"))?;
    db.execute("INSERT INTO cache_metadata VALUES (?1)", [&signature])
        .map_err(|err| format!("failed to store sqlite dependency signature: {err}"))?;
    Ok(())
}

fn cached_dependencies_match(path: &Path) -> Result<bool, String> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| format!("failed to open cached sqlite '{}': {err}", path.display()))?;
    let stored: String = db
        .query_row(
            "SELECT dependency_signature FROM cache_metadata",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("failed to read sqlite dependency signature: {err}"))?;
    let Some(current) = source_dependency_signature(&db)? else {
        return Ok(false);
    };
    if current != stored {
        info(
            "launcher",
            "cache miss: source dependency fingerprint changed",
        );
        return Ok(false);
    }
    Ok(true)
}

fn sqlite_cache_dir(output_dir: &str) -> PathBuf {
    Path::new(output_dir).join(".hier-viewer-cache")
}

fn locate_hierarchy_exporter() -> Result<HierarchyExporter, String> {
    let embedded = ensure_embedded_hierarchy_exporter()?;
    if embedded.is_file() {
        return Ok(HierarchyExporter {
            path: embedded,
            cache_fingerprint: format!("embedded:{EMBEDDED_EXPORTER_HASH}"),
            source: "embedded",
        });
    }

    if let Ok(cwd) = env::current_dir() {
        let local = cwd.join(EXPORTER_BINARY_NAME);
        if local.is_file() {
            return external_hierarchy_exporter(local, "cwd");
        }
    }

    if let Some(path_binary) = find_binary_in_path(EXPORTER_BINARY_NAME)
        && path_binary.is_file()
    {
        return external_hierarchy_exporter(path_binary, "PATH");
    }

    Err(format!(
        "could not locate or materialize '{}'",
        EXPORTER_BINARY_NAME
    ))
}

fn external_hierarchy_exporter(
    path: PathBuf,
    source: &'static str,
) -> Result<HierarchyExporter, String> {
    let cache_fingerprint = external_exporter_fingerprint(&path)?;
    Ok(HierarchyExporter {
        path,
        cache_fingerprint,
        source,
    })
}

fn external_exporter_fingerprint(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path)
        .map_err(|err| format!("failed to stat exporter '{}': {err}", path.display()))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok());
    Ok(format!(
        "external:{}:{}:{}:{}",
        path_to_unix_string(path),
        metadata.len(),
        modified.map(|value| value.as_secs()).unwrap_or(0),
        modified.map(|value| value.subsec_nanos()).unwrap_or(0)
    ))
}

fn ensure_embedded_hierarchy_exporter() -> Result<PathBuf, String> {
    if let Some(path) = EMBEDDED_EXPORTER_PATH.get() {
        return Ok(path.clone());
    }

    let path = embedded_exporter_target_path();
    materialize_embedded_hierarchy_exporter(&path)?;
    let _ = EMBEDDED_EXPORTER_PATH.set(path.clone());
    Ok(path)
}

fn embedded_exporter_target_path() -> PathBuf {
    embedded_exporter_base_dir().join(format!("{EMBEDDED_EXPORTER_HASH}-{EXPORTER_BINARY_NAME}"))
}

fn embedded_exporter_base_dir() -> PathBuf {
    if let Some(path) = non_empty_env_path(EMBEDDED_EXPORTER_DIR_ENV) {
        return path;
    }
    if let Some(path) = non_empty_env_path("XDG_RUNTIME_DIR") {
        return path.join("hier-viewer").join("embedded-exporter");
    }
    if let Some(path) = non_empty_env_path("XDG_CACHE_HOME") {
        return path.join("hier-viewer").join("embedded-exporter");
    }
    if let Some(path) = non_empty_env_path("HOME") {
        return path
            .join(".cache")
            .join("hier-viewer")
            .join("embedded-exporter");
    }
    #[cfg(unix)]
    {
        env::temp_dir()
            .join(format!("hier-viewer-uid{}", current_effective_uid()))
            .join("embedded-exporter")
    }
    #[cfg(not(unix))]
    {
        env::temp_dir()
            .join("hier-viewer")
            .join("embedded-exporter")
    }
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    let value = env::var_os(name)?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

fn materialize_embedded_hierarchy_exporter(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::metadata(path)
        && metadata.len() == EMBEDDED_EXPORTER_BYTES.len() as u64
    {
        ensure_executable_permissions(path)?;
        return Ok(());
    }

    let parent = path.parent().ok_or_else(|| {
        format!(
            "failed to derive parent directory for embedded exporter '{}'",
            path.display()
        )
    })?;
    ensure_embedded_exporter_directory(parent)?;

    let temp_path = parent.join(format!(
        ".{}-{}.tmp",
        EXPORTER_BINARY_NAME,
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|err| {
            format!(
                "failed to create temporary embedded exporter '{}': {err}",
                temp_path.display()
            )
        })?;
    file.write_all(EMBEDDED_EXPORTER_BYTES).map_err(|err| {
        format!(
            "failed to write embedded exporter '{}': {err}",
            temp_path.display()
        )
    })?;
    file.flush().map_err(|err| {
        format!(
            "failed to flush embedded exporter '{}': {err}",
            temp_path.display()
        )
    })?;
    ensure_executable_permissions(&temp_path)?;
    fs::rename(&temp_path, path).or_else(|rename_err| {
        if path.is_file() {
            Ok(())
        } else {
            Err(format!(
                "failed to place embedded exporter '{}' (temp '{}'): {rename_err}",
                path.display(),
                temp_path.display()
            ))
        }
    })?;
    ensure_executable_permissions(path)?;
    info(
        "launcher",
        format!("Using embedded slang-hier-exporter at '{}'", path.display()),
    );
    Ok(())
}

fn ensure_embedded_exporter_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|err| {
        format!(
            "failed to create embedded exporter directory '{}': {err}",
            path.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let metadata = fs::metadata(path)
            .map_err(|err| format!("failed to stat directory '{}': {err}", path.display()))?;
        if metadata.uid() != current_effective_uid() {
            return Err(format!(
                "embedded exporter directory '{}' is owned by uid {} instead of current uid {}",
                path.display(),
                metadata.uid(),
                current_effective_uid()
            ));
        }
        let current_mode = metadata.permissions().mode() & 0o777;
        if current_mode != 0o700 {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(path, permissions).map_err(|err| {
                format!(
                    "failed to mark embedded exporter directory '{}' private: {err}",
                    path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn ensure_executable_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let metadata = fs::metadata(path)
            .map_err(|err| format!("failed to stat '{}': {err}", path.display()))?;
        let current_mode = metadata.permissions().mode() & 0o777;
        if current_mode & 0o111 != 0 {
            return Ok(());
        }
        if metadata.uid() != current_effective_uid() {
            return Err(format!(
                "embedded exporter '{}' is not executable and is owned by uid {} instead of current uid {}",
                path.display(),
                metadata.uid(),
                current_effective_uid()
            ));
        }
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).map_err(|err| {
            format!(
                "failed to mark embedded exporter '{}' executable: {err}",
                path.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(unix)]
fn current_effective_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and returns the caller's effective uid.
    unsafe { libc::geteuid() }
}

fn find_binary_in_path(binary_name: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(binary_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn sqlite_rebuild_reason(
    cache_dir: &Path,
    export_path: &Path,
    force_rebuild: bool,
) -> Result<String, String> {
    if force_rebuild {
        return Ok("--rebuild-sqlite was specified".to_string());
    }
    if export_path.exists() {
        return Ok("cached sqlite is being refreshed".to_string());
    }

    let mut cached_sqlite_count = 0usize;
    let entries = fs::read_dir(cache_dir).map_err(|err| {
        format!(
            "failed to scan sqlite cache directory '{}': {err}",
            cache_dir.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|err| {
            format!(
                "failed to inspect sqlite cache directory '{}': {err}",
                cache_dir.display()
            )
        })?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("sqlite"))
        {
            cached_sqlite_count += 1;
        }
    }

    if cached_sqlite_count == 0 {
        Ok("no cached sqlite export exists in this output directory yet".to_string())
    } else {
        Ok(
            "cache miss: source files, filelists, extra flags, or slang-hier-exporter fingerprint changed"
                .to_string(),
        )
    }
}

fn compute_sqlite_cache_key(
    selection: &StartupSelection,
    exporter: &HierarchyExporter,
) -> Result<String, String> {
    let mut hasher = StableHasher::default();
    let cwd = env::current_dir()
        .map_err(|err| format!("failed to determine current directory: {err}"))?;
    let home = home_dir();
    let mut fingerprinted_command_files = BTreeSet::new();
    let mut previous_was_filelist = false;

    hasher.write_str("slang-hier-exporter-sqlite-cache-v2");
    hasher.write_str(&exporter.cache_fingerprint);
    for token in &selection.extra_args_tokens {
        hasher.write_str("arg");
        hasher.write_str(token);
    }
    for token in &selection.source_args_tokens {
        hasher.write_str("src");
        hasher.write_str(token);
        if previous_was_filelist {
            fingerprint_command_file(
                &mut hasher,
                Path::new(token),
                CommandFilePathMode::WorkingDirectory,
                &cwd,
                home.as_deref(),
                &mut fingerprinted_command_files,
            )?;
            previous_was_filelist = false;
            continue;
        }
        if token == "-f" {
            previous_was_filelist = true;
            continue;
        }

        let path = Path::new(token);
        if path.exists() {
            write_path_fingerprint(&mut hasher, path)?;
        }
    }
    Ok(hasher.finish_hex())
}

fn write_path_fingerprint(hasher: &mut StableHasher, path: &Path) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|err| format!("failed to stat '{}': {err}", path.display()))?;
    write_metadata_fingerprint(hasher, path, &metadata)
}

fn write_metadata_fingerprint(
    hasher: &mut StableHasher,
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), String> {
    hasher.write_str(&path_to_unix_string(path));
    hasher.write_u64(metadata.len());
    let modified = metadata
        .modified()
        .map_err(|err| {
            format!(
                "failed to read modification time for '{}': {err}",
                path.display()
            )
        })?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    hasher.write_u64(modified.as_secs());
    hasher.write_u32(modified.subsec_nanos());
    Ok(())
}

#[derive(Clone, Copy)]
enum CommandFilePathMode {
    WorkingDirectory,
    CommandFileDirectory,
}

fn fingerprint_command_file(
    hasher: &mut StableHasher,
    path: &Path,
    mode: CommandFilePathMode,
    cwd: &Path,
    home_dir: Option<&Path>,
    visited: &mut BTreeSet<String>,
) -> Result<(), String> {
    let command_file =
        resolve_command_file_token(cwd, mode, cwd, home_dir, &path_to_unix_string(path));
    let key = path_to_unix_string(&command_file);
    if !visited.insert(key.clone()) {
        hasher.write_str("command-file-cycle");
        hasher.write_str(&key);
        return Ok(());
    }

    let metadata = fs::metadata(&command_file).map_err(|err| {
        format!(
            "failed to stat command file '{}': {err}",
            command_file.display()
        )
    })?;
    hasher.write_str("command-file");
    hasher.write_str(&key);
    hasher.write_u64(metadata.len());
    let bytes = fs::read(&command_file).map_err(|err| {
        format!(
            "failed to read command file '{}': {err}",
            command_file.display()
        )
    })?;
    hasher.write(&bytes);

    let text = String::from_utf8_lossy(&bytes);
    let command_dir = command_file.parent().unwrap_or(cwd);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
            continue;
        }
        let tokens = shell_split(trimmed).unwrap_or_else(|_| vec![trimmed.to_string()]);
        let mut index = 0usize;
        while index < tokens.len() {
            let token = tokens[index].trim();
            if token.is_empty() {
                index += 1;
                continue;
            }
            if token == "-f" || token == "-F" {
                let nested_mode = if token == "-F" {
                    CommandFilePathMode::CommandFileDirectory
                } else {
                    CommandFilePathMode::WorkingDirectory
                };
                if let Some(next) = tokens.get(index + 1) {
                    fingerprint_command_file(
                        hasher,
                        Path::new(next),
                        nested_mode,
                        command_dir,
                        home_dir,
                        visited,
                    )?;
                    index += 2;
                    continue;
                }
                hasher.write_str("dangling-command-file-flag");
                hasher.write_str(token);
                index += 1;
                continue;
            }
            if let Some(rest) = token.strip_prefix("+incdir+") {
                for include_dir in rest.split('+').filter(|value| !value.is_empty()) {
                    fingerprint_resolved_path(
                        hasher,
                        &resolve_command_file_token(command_dir, mode, cwd, home_dir, include_dir),
                    )?;
                }
                index += 1;
                continue;
            }
            if token.starts_with('-') || token.starts_with('+') {
                index += 1;
                continue;
            }
            fingerprint_resolved_path(
                hasher,
                &resolve_command_file_token(command_dir, mode, cwd, home_dir, token),
            )?;
            index += 1;
        }
    }

    Ok(())
}

fn fingerprint_resolved_path(hasher: &mut StableHasher, path: &Path) -> Result<(), String> {
    hasher.write_str("resolved-path");
    hasher.write_str(&path_to_unix_string(path));
    if path.exists() {
        write_path_fingerprint(hasher, path)?;
    } else {
        hasher.write_str("missing");
    }
    Ok(())
}

fn resolve_command_file_token(
    base_dir: &Path,
    mode: CommandFilePathMode,
    cwd: &Path,
    home_dir: Option<&Path>,
    token: &str,
) -> PathBuf {
    let base = match mode {
        CommandFilePathMode::WorkingDirectory => cwd,
        CommandFilePathMode::CommandFileDirectory => base_dir,
    };
    resolve_literal_path(base, home_dir, token)
}

#[derive(Default)]
struct StableHasher {
    state: u64,
}

impl StableHasher {
    fn write_str(&mut self, value: &str) {
        value.hash(self);
        0xff_u8.hash(self);
    }

    fn write_u64(&mut self, value: u64) {
        value.hash(self);
    }

    fn write_u32(&mut self, value: u32) {
        value.hash(self);
    }

    fn finish_hex(&self) -> String {
        format!("{:016x}", self.state)
    }
}

impl Hasher for StableHasher {
    fn finish(&self) -> u64 {
        self.state
    }

    fn write(&mut self, bytes: &[u8]) {
        let mut hash = if self.state == 0 {
            0xcbf29ce484222325
        } else {
            self.state
        };
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        self.state = hash;
    }
}

fn normalize_patterns(raw_patterns: &[String]) -> Result<Vec<String>, String> {
    let patterns = raw_patterns
        .iter()
        .map(|pattern| pattern.trim())
        .filter(|pattern| !pattern.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    if patterns.is_empty() {
        return Err("at least one RTL path pattern is required".to_string());
    }

    Ok(patterns)
}

fn build_glob_matcher(patterns: &[&str]) -> Result<globset::GlobSet, String> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = Glob::new(pattern)
            .map_err(|err| format!("invalid wildcard pattern '{}': {err}", pattern))?;
        builder.add(glob);
    }
    builder
        .build()
        .map_err(|err| format!("failed to build wildcard matcher: {err}"))
}

fn should_visit(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    !matches!(
        name.as_ref(),
        ".git" | ".hg" | ".svn" | "target" | ".hier-viewer-sources"
    )
}

fn is_rtl_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| RTL_EXTENSIONS.contains(&ext))
        .unwrap_or(false)
}

fn last_pattern_token(raw_patterns: &str) -> String {
    raw_patterns
        .rsplit(';')
        .next()
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn path_to_unix_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

#[derive(Clone, Copy)]
enum PathCompletionKind {
    RtlOnly,
    AnyFile,
}

fn path_completion_suggestions(
    cwd: &Path,
    home_dir: Option<&Path>,
    token: &str,
    kind: PathCompletionKind,
) -> Vec<String> {
    let (scan_dir, prefix, path_style) = completion_context(cwd, home_dir, token);
    let Ok(entries) = fs::read_dir(&scan_dir) else {
        return Vec::new();
    };

    let matcher = SkimMatcherV2::default().smart_case();
    let mut scored = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        let is_file_match = match kind {
            PathCompletionKind::RtlOnly => is_rtl_file(&path),
            PathCompletionKind::AnyFile => path.is_file(),
        };
        if !is_dir && !is_file_match {
            continue;
        }

        let candidate = match path_style {
            PathStyle::Absolute => path_to_unix_string(&path),
            PathStyle::Relative => path
                .strip_prefix(cwd)
                .map(path_to_unix_string)
                .unwrap_or_else(|_| path_to_unix_string(&path)),
            PathStyle::HomeTilde => tilde_display(&path_to_unix_string(&path), home_dir),
        };
        let display = if is_dir {
            format!("{candidate}/")
        } else {
            candidate
        };

        let rank = literal_rank(&display, token);
        let score = if prefix.is_empty() {
            Some(0)
        } else {
            matcher
                .fuzzy_match(&name, &prefix)
                .or_else(|| matcher.fuzzy_match(&display, token))
        };
        if let Some(score) = score {
            scored.push((rank, -score, display));
        }
    }

    scored.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.len().cmp(&right.2.len()))
            .then_with(|| left.2.cmp(&right.2))
    });
    scored.into_iter().map(|(_, _, display)| display).collect()
}

#[derive(Clone, Copy)]
enum PathStyle {
    Relative,
    Absolute,
    HomeTilde,
}

fn completion_context(
    cwd: &Path,
    home_dir: Option<&Path>,
    token: &str,
) -> (PathBuf, String, PathStyle) {
    let normalized = token.replace('\\', "/");
    let path_style = if normalized.starts_with("~/") || normalized == "~" {
        PathStyle::HomeTilde
    } else if normalized.starts_with('/') {
        PathStyle::Absolute
    } else {
        PathStyle::Relative
    };
    let resolved = expand_home_token(&normalized, home_dir).unwrap_or_else(|| normalized.clone());
    let path = Path::new(&resolved);
    if normalized.ends_with('/') {
        let base = match path_style {
            PathStyle::Absolute | PathStyle::HomeTilde => PathBuf::from(path),
            PathStyle::Relative => cwd.join(path),
        };
        return (base, String::new(), path_style);
    }

    let prefix = path
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("")
        .to_string();
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let scan_dir = match path_style {
        PathStyle::Absolute | PathStyle::HomeTilde => {
            if parent.as_os_str().is_empty() {
                PathBuf::from("/")
            } else {
                PathBuf::from(parent)
            }
        }
        PathStyle::Relative => {
            if parent.as_os_str().is_empty() {
                cwd.to_path_buf()
            } else {
                cwd.join(parent)
            }
        }
    };
    (scan_dir, prefix, path_style)
}

fn fuzzy_suggestions(paths: &[String], token: &str) -> Vec<String> {
    let matcher = SkimMatcherV2::default().smart_case();
    let mut scored = paths
        .iter()
        .filter_map(|path| {
            matcher
                .fuzzy_match(path, token)
                .map(|score| (score, literal_rank(path, token), path.clone()))
        })
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.len().cmp(&right.2.len()))
            .then_with(|| left.2.cmp(&right.2))
    });

    scored.into_iter().map(|(_, _, path)| path).collect()
}

fn literal_rank(path: &str, token: &str) -> u8 {
    if path == token {
        0
    } else if path.starts_with(token) {
        1
    } else if path.contains(token) {
        2
    } else {
        3
    }
}

fn contains_glob_meta(pattern: &str) -> bool {
    pattern.contains('*')
        || pattern.contains('?')
        || pattern.contains('[')
        || pattern.contains(']')
        || pattern.contains('{')
        || pattern.contains('}')
}

fn extend_unique(target: &mut Vec<String>, values: Vec<String>) {
    for value in values {
        if !target.contains(&value) {
            target.push(value);
        }
    }
}

fn wildcard_fuzzy_token(token: &str) -> String {
    token
        .chars()
        .filter(|ch| !matches!(ch, '*' | '?' | '[' | ']' | '{' | '}' | '!'))
        .collect::<String>()
        .trim()
        .to_string()
}

fn resolve_literal_pattern_into(
    files: &mut BTreeSet<String>,
    cwd: &Path,
    home_dir: Option<&Path>,
    pattern: &str,
) -> Result<(), String> {
    let path = resolve_literal_path(cwd, home_dir, pattern);
    if path.is_file() {
        if !is_rtl_file(&path) {
            return Err(format!(
                "literal path '{}' is not an RTL file (.sv/.svh/.v/.vh)",
                pattern
            ));
        }
        files.insert(path_to_unix_string(&path));
        return Ok(());
    }
    if path.is_dir() {
        for child in WalkDir::new(&path) {
            let child =
                child.map_err(|err| format!("failed to scan '{}': {err}", path.display()))?;
            if !child.file_type().is_file() || !is_rtl_file(child.path()) {
                continue;
            }
            files.insert(path_to_unix_string(child.path()));
        }
        return Ok(());
    }
    Err(format!(
        "literal path '{}' does not exist as a file or directory",
        pattern
    ))
}

fn resolve_absolute_glob_pattern_into(
    files: &mut BTreeSet<String>,
    pattern: &str,
) -> Result<(), String> {
    let glob_set = build_glob_matcher(&[pattern])?;
    let search_root = absolute_glob_search_root(pattern);
    if !search_root.exists() {
        return Ok(());
    }

    for entry in WalkDir::new(&search_root) {
        let entry =
            entry.map_err(|err| format!("failed to scan '{}': {err}", search_root.display()))?;
        if !entry.file_type().is_file() || !is_rtl_file(entry.path()) {
            continue;
        }
        let absolute = path_to_unix_string(entry.path());
        if glob_set.is_match(&absolute) {
            files.insert(absolute);
        }
    }

    Ok(())
}

fn absolute_glob_search_root(pattern: &str) -> PathBuf {
    let normalized = pattern.replace('\\', "/");
    let mut root = String::new();
    for (index, segment) in normalized.split('/').enumerate() {
        if index == 0 && segment.is_empty() {
            root.push('/');
            continue;
        }
        if contains_glob_meta(segment) {
            break;
        }
        if !root.ends_with('/') && !root.is_empty() {
            root.push('/');
        }
        root.push_str(segment);
    }

    if root.is_empty() {
        PathBuf::from("/")
    } else {
        PathBuf::from(root)
    }
}

fn resolve_literal_path(cwd: &Path, home_dir: Option<&Path>, pattern: &str) -> PathBuf {
    if let Some(expanded) = expand_home_token(pattern, home_dir) {
        return PathBuf::from(expanded);
    }
    cwd.join(pattern)
}

fn expand_home_token(token: &str, home_dir: Option<&Path>) -> Option<String> {
    let home_dir = home_dir?;
    if token == "~" {
        return Some(path_to_unix_string(home_dir));
    }
    token
        .strip_prefix("~/")
        .map(|suffix| path_to_unix_string(home_dir.join(suffix)))
}

fn tilde_display(path: &str, home_dir: Option<&Path>) -> String {
    let Some(home_dir) = home_dir else {
        return path.to_string();
    };
    let home = path_to_unix_string(home_dir);
    if path == home {
        "~".to_string()
    } else if let Some(suffix) = path.strip_prefix(&(home.clone() + "/")) {
        format!("~/{}", suffix)
    } else {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_test_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let dir = env::temp_dir().join(format!(
            "hier-viewer-launcher-tests-{}-{}-{}",
            name,
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn cached_dependencies_detect_modified_and_deleted_headers() {
        let temp_dir = temp_test_dir("cache-dependencies");
        let header = temp_dir.join("defs.svh");
        let sqlite = temp_dir.join("hier.sqlite");
        fs::write(&header, "`define WIDTH 8\n").expect("write header");
        {
            let db = Connection::open(&sqlite).expect("open sqlite");
            db.execute_batch("CREATE TABLE source_dependencies (path TEXT PRIMARY KEY)")
                .expect("create dependencies");
            db.execute(
                "INSERT INTO source_dependencies VALUES (?1)",
                [path_to_unix_string(&header)],
            )
            .expect("insert header dependency");
        }
        store_dependency_signature(&sqlite).expect("store signature");
        assert!(cached_dependencies_match(&sqlite).expect("unchanged dependency"));
        fs::write(&header, "`define WIDTH 128\n").expect("modify header");
        assert!(!cached_dependencies_match(&sqlite).expect("modified dependency"));
        fs::remove_file(&header).expect("delete header");
        assert!(!cached_dependencies_match(&sqlite).expect("deleted dependency"));
        fs::remove_dir_all(temp_dir).expect("remove temp test dir");
    }

    #[test]
    fn dependency_sql_errors_are_not_cache_misses() {
        let temp_dir = temp_test_dir("cache-invalid-schema");
        let sqlite = temp_dir.join("hier.sqlite");
        let db = Connection::open(&sqlite).expect("open sqlite");
        assert!(
            store_dependency_signature(&sqlite)
                .unwrap_err()
                .contains("source_dependencies")
        );
        db.execute_batch("CREATE TABLE source_dependencies (path TEXT PRIMARY KEY)")
            .expect("create dependencies");
        assert!(
            cached_dependencies_match(&sqlite)
                .unwrap_err()
                .contains("dependency signature")
        );
        drop(db);
        fs::remove_dir_all(temp_dir).expect("remove temp test dir");
    }

    #[cfg(unix)]
    #[test]
    fn dependency_io_errors_are_not_cache_misses() {
        let temp_dir = temp_test_dir("cache-io-error");
        let header = temp_dir.join("defs.svh");
        std::os::unix::fs::symlink(&header, &header).expect("create symlink loop");
        let db = Connection::open_in_memory().expect("open sqlite");
        db.execute_batch("CREATE TABLE source_dependencies (path TEXT PRIMARY KEY)")
            .expect("create dependencies");
        db.execute(
            "INSERT INTO source_dependencies VALUES (?1)",
            [path_to_unix_string(&header)],
        )
        .expect("insert dependency");
        assert!(
            source_dependency_signature(&db)
                .unwrap_err()
                .contains("failed to stat")
        );
        fs::remove_dir_all(temp_dir).expect("remove temp test dir");
    }

    #[test]
    fn explicit_inputs_do_not_index_unrelated_workspace_files() {
        let temp_dir = temp_test_dir("targeted-inputs");
        fs::create_dir_all(temp_dir.join("rtl/nested")).expect("create rtl dir");
        fs::create_dir(temp_dir.join("unrelated")).expect("create unrelated dir");
        let source = temp_dir.join("rtl/nested/top.sv");
        fs::write(&source, "module top; endmodule").expect("write source");
        fs::write(
            temp_dir.join("unrelated/unused.sv"),
            "module unused; endmodule",
        )
        .expect("write unrelated source");
        let expected = vec![path_to_unix_string(&source)];
        for pattern in [
            "  rtl/nested/top.sv  ".to_string(),
            "rtl".to_string(),
            path_to_unix_string(&source),
            path_to_unix_string(temp_dir.join("rtl/**/*.sv")),
        ] {
            let patterns = vec![pattern];
            let index =
                FileIndex::for_inputs_at(temp_dir.clone(), &patterns).expect("create index");
            assert_eq!(index.file_count(), 0);
            assert!(index.rtl_files_absolute.is_empty());
            assert_eq!(
                index
                    .resolve_patterns(&patterns, PatternMode::Wildcard)
                    .unwrap(),
                expected
            );
        }
        let filelist = temp_dir.join("files.f");
        fs::write(&filelist, "rtl/nested/top.sv\n").expect("write filelist");
        let index = FileIndex::for_inputs_at(temp_dir.clone(), &[]).expect("empty inputs");
        assert_eq!(index.file_count(), 0);
        assert_eq!(
            index
                .build_source_args(&[], PatternMode::Wildcard, &["files.f".to_string()])
                .unwrap(),
            vec!["-f".to_string(), path_to_unix_string(filelist)]
        );
        fs::remove_dir_all(temp_dir).expect("remove temp test dir");
    }

    #[test]
    fn relative_globs_keep_complete_workspace_index() {
        let temp_dir = temp_test_dir("relative-globs");
        fs::create_dir_all(temp_dir.join("rtl/nested")).expect("create rtl dir");
        let sources = [
            temp_dir.join("top.sv"),
            temp_dir.join("rtl/nested/child.sv"),
        ];
        for source in &sources {
            fs::write(source, "module test; endmodule").expect("write source");
        }
        let patterns = vec!["  **/*.sv  ".to_string()];
        let index = FileIndex::for_inputs_at(temp_dir.clone(), &patterns).expect("create index");
        assert_eq!(index.file_count(), sources.len());
        let mut expected = sources.iter().map(path_to_unix_string).collect::<Vec<_>>();
        expected.sort();
        assert_eq!(
            index
                .resolve_patterns(&patterns, PatternMode::Wildcard)
                .unwrap(),
            expected
        );
        fs::remove_dir_all(temp_dir).expect("remove temp test dir");
    }

    #[test]
    fn cache_key_changes_when_filelist_referenced_source_disappears() {
        let temp_dir = temp_test_dir("filelist-missing-source");
        let source_path = temp_dir.join("top.sv");
        let filelist_path = temp_dir.join("files.f");
        fs::write(&source_path, "module top; endmodule\n").expect("write source");
        fs::write(
            &filelist_path,
            format!("{}\n", path_to_unix_string(&source_path)),
        )
        .expect("write filelist");

        let selection = StartupSelection {
            output_dir: path_to_unix_string(&temp_dir),
            title: None,
            source_args_tokens: vec!["-f".to_string(), path_to_unix_string(&filelist_path)],
            extra_args_tokens: Vec::new(),
            rebuild_sqlite: false,
        };
        let exporter = HierarchyExporter {
            path: temp_dir.join("dummy-exporter"),
            cache_fingerprint: "dummy-exporter".to_string(),
            source: "test",
        };

        let before = compute_sqlite_cache_key(&selection, &exporter).expect("compute key before");
        fs::remove_file(&source_path).expect("remove source");
        let after = compute_sqlite_cache_key(&selection, &exporter).expect("compute key after");

        assert_ne!(before, after);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn filelist_options_are_validated_by_the_exporter() {
        let temp_dir = temp_test_dir("filelist-options");
        let source_path = temp_dir.join("top.sv");
        let filelist_path = temp_dir.join("files.f");
        fs::write(&source_path, "module top; logic data; endmodule\n").expect("write source");
        fs::write(
            &filelist_path,
            format!("--top top\n{} // source file\n", path_to_unix_string(&source_path)),
        )
        .expect("write filelist");
        let selection = StartupSelection {
            output_dir: path_to_unix_string(temp_dir.join("out")),
            title: None,
            source_args_tokens: vec!["-f".to_string(), path_to_unix_string(&filelist_path)],
            extra_args_tokens: Vec::new(),
            rebuild_sqlite: false,
        };
        let export = run_hier_viewer_export(&selection).expect("export valid filelist options");
        assert!(Path::new(&export.sqlite_path).is_file());
        let cached = run_hier_viewer_export(&selection).expect("reuse valid export");
        assert_eq!(cached.sqlite_path, export.sqlite_path);

        fs::remove_file(&source_path).expect("remove source");
        let error = run_hier_viewer_export(&selection).expect_err("missing source must fail");
        assert!(error.contains("hierarchy exporter failed"), "{error}");
        assert!(error.contains("top.sv"), "{error}");
        fs::remove_dir_all(&temp_dir).expect("remove test directory");
    }
}
