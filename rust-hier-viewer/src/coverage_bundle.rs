use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tempfile::TempDir;

use crate::coverage_import::report_files;
use crate::model::{CoverageConfig, CoverageInput};

pub(crate) struct BundledCoverage {
    directory: PathBuf,
    temporary: Option<TempDir>,
    manifest_url: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct FileMetadataSignature {
    length: u64,
    modified_seconds: u64,
    modified_nanoseconds: u32,
    #[cfg(unix)]
    ctime_seconds: i64,
    #[cfg(unix)]
    ctime_nanoseconds: i64,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct CopiedFile {
    name: String,
    signature: FileMetadataSignature,
}

#[derive(Deserialize)]
struct ExistingManifest {
    source_signature: Option<u64>,
    name: String,
    root: Option<String>,
    files: Vec<String>,
    copied_files: Vec<CopiedFile>,
}

struct SignatureHasher {
    value: u64,
}

impl SignatureHasher {
    fn new() -> Self {
        Self {
            value: 0xcbf29ce484222325,
        }
    }

    fn bytes(&mut self, bytes: &[u8]) {
        self.value ^= bytes.len() as u64;
        self.value = self.value.wrapping_mul(0x100000001b3);
        for byte in bytes {
            self.value ^= u64::from(*byte);
            self.value = self.value.wrapping_mul(0x100000001b3);
        }
    }

    fn string(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    fn finish(self) -> u64 {
        self.value
    }
}

fn file_metadata_signature(path: &Path) -> Result<FileMetadataSignature, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("cannot inspect coverage file '{}': {err}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "coverage file '{}' is not a regular file",
            path.display()
        ));
    }
    let modified = metadata
        .modified()
        .map_err(|err| format!("cannot inspect coverage file '{}': {err}", path.display()))?
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("cannot inspect coverage file '{}': {err}", path.display()))?;
    Ok(FileMetadataSignature {
        length: metadata.len(),
        modified_seconds: modified.as_secs(),
        modified_nanoseconds: modified.subsec_nanos(),
        #[cfg(unix)]
        ctime_seconds: {
            use std::os::unix::fs::MetadataExt;
            metadata.ctime()
        },
        #[cfg(unix)]
        ctime_nanoseconds: {
            use std::os::unix::fs::MetadataExt;
            metadata.ctime_nsec()
        },
        #[cfg(unix)]
        device: {
            use std::os::unix::fs::MetadataExt;
            metadata.dev()
        },
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
    })
}

fn canonical_source_file(root: &Path, file: &str) -> Result<PathBuf, String> {
    let path = root.join(file);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|err| format!("cannot inspect coverage file '{file}': {err}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "coverage file '{file}' is not a regular file inside the report directory"
        ));
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|err| format!("cannot open coverage file '{file}': {err}"))?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "coverage file escaped the report directory: {file}"
        ));
    }
    let canonical_metadata = fs::symlink_metadata(&canonical)
        .map_err(|err| format!("cannot inspect coverage file '{file}': {err}"))?;
    if !canonical_metadata.file_type().is_file() {
        return Err(format!(
            "coverage file '{file}' is not a regular file inside the report directory"
        ));
    }
    Ok(canonical)
}

fn selected_report_files(root: &Path) -> Result<Vec<String>, String> {
    let mut files = report_files(root).map_err(|err| err.message)?;
    files.retain(|file| {
        matches!(
            Path::new(file).extension().and_then(|ext| ext.to_str()),
            Some("xml" | "html")
        )
    });
    if !files.iter().any(|file| file == "session.xml") {
        return Err(
            "coverage report requires a regular session.xml file, not a symlink".to_string(),
        );
    }
    for file in &files {
        if file.contains(['\\', ':']) {
            return Err(format!("unsupported coverage report file name: {file}"));
        }
    }
    Ok(files)
}

fn report_signature(root: &Path, files: &[String], root_hint: Option<&str>) -> Result<u64, String> {
    let mut hasher = SignatureHasher::new();
    hasher.string(&root.to_string_lossy());
    match root_hint {
        Some(root_hint) => {
            hasher.bytes(&[1]);
            hasher.string(root_hint);
        }
        None => hasher.bytes(&[0]),
    }
    hasher.u64(files.len() as u64);
    for file in files {
        hasher.string(file);
        let source = canonical_source_file(root, file)?;
        hasher.string(&source.to_string_lossy());
        let metadata = file_metadata_signature(&source)?;
        hasher.u64(metadata.length);
        hasher.u64(metadata.modified_seconds);
        hasher.u64(u64::from(metadata.modified_nanoseconds));
        #[cfg(unix)]
        {
            hasher.u64(metadata.ctime_seconds as u64);
            hasher.u64(metadata.ctime_nanoseconds as u64);
            hasher.u64(metadata.device);
            hasher.u64(metadata.inode);
        }
    }
    Ok(hasher.finish())
}

fn regular_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_file())
}

fn valid_destination_file(bundle: &Path, file: &str) -> bool {
    let mut components = Path::new(file).components().peekable();
    let mut current = bundle.to_path_buf();
    while let Some(component) = components.next() {
        current.push(component.as_os_str());
        if components.peek().is_none() {
            return regular_file(&current);
        }
        if !regular_directory(&current) {
            return false;
        }
    }
    false
}

fn existing_bundle(
    path: &Path,
    name: &str,
    root_hint: Option<&str>,
    files: &[String],
    source_signature: u64,
) -> bool {
    if !regular_directory(path) || !regular_file(&path.join("manifest.json")) {
        return false;
    }
    let Ok(bytes) = fs::read(path.join("manifest.json")) else {
        return false;
    };
    let Ok(existing) = serde_json::from_slice::<ExistingManifest>(&bytes) else {
        return false;
    };
    if existing.source_signature != Some(source_signature)
        || existing.name != name
        || existing.root.as_deref() != root_hint
        || existing.files != files
        || existing.copied_files.len() != files.len()
    {
        return false;
    }
    existing
        .copied_files
        .iter()
        .zip(files)
        .all(|(copied, file)| {
            copied.name == *file
                && valid_destination_file(path, file)
                && file_metadata_signature(&path.join(file))
                    .is_ok_and(|signature| signature == copied.signature)
        })
}

#[derive(Serialize)]
struct Manifest<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<&'a str>,
    files: &'a [String],
    source_signature: u64,
    copied_files: &'a [CopiedFile],
}

impl BundledCoverage {
    // Keep successful copies in their random TempDir path. Reuse is based on
    // manifest validation, so publishing never needs a rename or overwrite.
    pub(crate) fn prepare(config: &CoverageConfig, output: &Path) -> Result<Self, String> {
        let report_path = match &config.input {
            CoverageInput::Report(path) => PathBuf::from(path),
            CoverageInput::Vdb(path) => crate::coverage_cache::prepare_vdb(
                Path::new(path),
                output,
                config.rebuild,
                config.timeout_minutes,
            )?,
        };
        let report_root = fs::canonicalize(&report_path).map_err(|err| {
            format!(
                "cannot open coverage report '{}': {err}",
                report_path.display()
            )
        })?;
        let files = selected_report_files(&report_root)?;

        // Check before creating directories: output inside the input report would
        // change that report and could recursively copy earlier output bundles.
        let output = resolve_output_path(output)?;
        if output.starts_with(&report_root) {
            return Err("coverage output must be outside the input report directory".to_string());
        }
        fs::create_dir_all(&output)
            .map_err(|err| format!("cannot create coverage output directory: {err}"))?;
        let input_path = match &config.input {
            CoverageInput::Report(_) => report_root.as_path(),
            CoverageInput::Vdb(path) => Path::new(path),
        };
        let name = input_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("coverage report");
        let source_signature = report_signature(&report_root, &files, config.root.as_deref())?;

        let entries = fs::read_dir(&output)
            .map_err(|err| format!("cannot scan coverage output directory: {err}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|err| format!("cannot scan coverage output directory: {err}"))?;
            let path = entry.path();
            if !entry
                .file_name()
                .to_str()
                .is_some_and(|file_name| file_name.starts_with("coverage-"))
            {
                continue;
            }
            if existing_bundle(
                &path,
                name,
                config.root.as_deref(),
                &files,
                source_signature,
            ) {
                let directory_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("bundled coverage directory name is not UTF-8")?
                    .to_string();
                return Ok(Self {
                    directory: path,
                    temporary: None,
                    manifest_url: format!("./{directory_name}/manifest.json"),
                });
            }
        }

        let temporary = tempfile::Builder::new()
            .prefix("coverage-")
            .tempdir_in(&output)
            .map_err(|err| format!("cannot create bundled coverage directory: {err}"))?;
        let directory = temporary.path().to_path_buf();
        for file in &files {
            let source = canonical_source_file(&report_root, file)?;
            let destination = directory.join(file);
            fs::create_dir_all(destination.parent().expect("report file has a parent"))
                .map_err(|err| format!("cannot create coverage subdirectory: {err}"))?;
            fs::copy(&source, &destination)
                .map_err(|err| format!("cannot copy coverage file '{file}': {err}"))?;
        }

        let copied_files = files
            .iter()
            .map(|file| {
                Ok(CopiedFile {
                    name: file.clone(),
                    signature: file_metadata_signature(&directory.join(file))?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let final_files = selected_report_files(&report_root)?;
        let final_signature = report_signature(&report_root, &final_files, config.root.as_deref())?;
        if final_files != files || final_signature != source_signature {
            return Err("coverage report changed while it was being copied".to_string());
        }

        let manifest = Manifest {
            name,
            root: config.root.as_deref(),
            files: &files,
            source_signature,
            copied_files: &copied_files,
        };
        let json = serde_json::to_vec(&manifest)
            .map_err(|err| format!("cannot encode coverage manifest: {err}"))?;
        fs::write(directory.join("manifest.json"), json)
            .map_err(|err| format!("cannot write coverage manifest: {err}"))?;
        let directory_name = directory
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("bundled coverage directory name is not UTF-8")?
            .to_string();
        Ok(Self {
            directory,
            temporary: Some(temporary),
            manifest_url: format!("./{directory_name}/manifest.json"),
        })
    }

    pub(crate) fn manifest_url(&self) -> &str {
        &self.manifest_url
    }

    pub(crate) fn persist(mut self) {
        let directory_is_regular = regular_directory(&self.directory);
        if let Some(temporary) = self.temporary.take() {
            if !directory_is_regular {
                return;
            }
            debug_assert_eq!(temporary.path(), self.directory);
            let _ = temporary.keep();
        } else {
            debug_assert!(directory_is_regular);
        }
    }
}

// Resolve existing symlink ancestors and lexical '..' before creating missing
// output directories, so an alias cannot bypass the input/output overlap check.
pub(crate) fn resolve_output_path(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path)
        .map_err(|err| format!("cannot resolve output directory: {err}"))?;
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            component => {
                resolved.push(component.as_os_str());
                if resolved.exists() {
                    resolved = fs::canonicalize(&resolved)
                        .map_err(|err| format!("cannot resolve output directory: {err}"))?;
                }
            }
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (TempDir, CoverageConfig) {
        let report = tempfile::tempdir().unwrap();
        fs::write(report.path().join("session.xml"), "<session/>").unwrap();
        fs::create_dir(report.path().join("pages")).unwrap();
        fs::write(report.path().join("pages/detail page.html"), "report text").unwrap();
        fs::write(report.path().join("ignored.bin"), "not needed").unwrap();
        let config = CoverageConfig {
            input: CoverageInput::Report(report.path().to_str().unwrap().to_string()),
            root: Some("tb.dut".to_string()),
            rebuild: false,
            timeout_minutes: 60,
        };
        (report, config)
    }

    fn persisted_bundle(config: &CoverageConfig, output: &TempDir) -> (PathBuf, String) {
        let bundle = BundledCoverage::prepare(config, output.path()).unwrap();
        let directory = bundle.directory.clone();
        let url = bundle.manifest_url().to_owned();
        bundle.persist();
        (directory, url)
    }

    #[test]
    fn reuses_immutable_bundle_without_copying() {
        let (_report, config) = fixture();
        let output = tempfile::tempdir().unwrap();
        let (directory, url) = persisted_bundle(&config, &output);
        let copied_signature = file_metadata_signature(&directory.join("session.xml")).unwrap();

        let reused = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert_eq!(reused.directory, directory);
        assert_eq!(reused.manifest_url(), url);
        assert_eq!(
            file_metadata_signature(&directory.join("session.xml")).unwrap(),
            copied_signature
        );
        assert!(directory.join("manifest.json").exists());
    }

    #[test]
    fn source_changes_create_new_bundle_and_keep_old_copy() {
        let (report, config) = fixture();
        let output = tempfile::tempdir().unwrap();
        let (original, _) = persisted_bundle(&config, &output);

        fs::write(
            report.path().join("pages/detail page.html"),
            "changed report",
        )
        .unwrap();
        let modified = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert_ne!(modified.directory, original);
        assert_eq!(
            fs::read(original.join("pages/detail page.html")).unwrap(),
            b"report text"
        );
        modified.persist();

        fs::remove_file(report.path().join("pages/detail page.html")).unwrap();
        let deleted = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert_ne!(deleted.directory, original);
        assert_ne!(deleted.directory, output.path());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(deleted.directory.join("manifest.json")).unwrap()
            )
            .unwrap()["files"],
            serde_json::json!(["session.xml"])
        );
        drop(deleted);

        fs::write(report.path().join("pages/new.html"), "new report").unwrap();
        let added = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert!(added.directory.join("pages/new.html").exists());
    }

    #[test]
    fn root_changes_create_new_bundle() {
        let (_report, config) = fixture();
        let output = tempfile::tempdir().unwrap();
        let (original, _) = persisted_bundle(&config, &output);
        let mut changed = config;
        changed.root = Some("tb.other".to_string());
        let bundle = BundledCoverage::prepare(&changed, output.path()).unwrap();
        assert_ne!(bundle.directory, original);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(bundle.directory.join("manifest.json")).unwrap()
            )
            .unwrap()["root"],
            "tb.other"
        );
    }

    #[test]
    fn corrupted_or_removed_output_is_not_reused() {
        let (_report, config) = fixture();
        let output = tempfile::tempdir().unwrap();
        let (original, _) = persisted_bundle(&config, &output);

        fs::write(original.join("session.xml"), "corrupted").unwrap();
        let corrupted = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert_ne!(corrupted.directory, original);
        corrupted.persist();

        fs::remove_dir_all(&original).unwrap();
        let removed = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert_ne!(removed.directory, original);
    }

    #[test]
    fn failed_preparation_does_not_leave_partial_copy() {
        let (report, config) = fixture();
        let output = tempfile::tempdir().unwrap();
        fs::remove_file(report.path().join("session.xml")).unwrap();
        assert!(BundledCoverage::prepare(&config, output.path()).is_err());
        let entries = fs::read_dir(output.path())
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn refuses_to_create_output_inside_the_report() {
        let (report, config) = fixture();
        let output = report.path().join("new/nested");
        assert!(BundledCoverage::prepare(&config, &output).is_err());
        assert!(!report.path().join("new").exists());
    }

    #[cfg(unix)]
    #[test]
    fn cached_directory_and_files_must_not_be_symlinks() {
        let (report, config) = fixture();
        let output = tempfile::tempdir().unwrap();
        let (original, _) = persisted_bundle(&config, &output);

        fs::remove_file(original.join("session.xml")).unwrap();
        std::os::unix::fs::symlink(
            report.path().join("session.xml"),
            original.join("session.xml"),
        )
        .unwrap();
        let file_link = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert_ne!(file_link.directory, original);
        file_link.persist();

        let directory_link = output.path().join("coverage-directory-link");
        std::os::unix::fs::symlink(&original, &directory_link).unwrap();
        let directory_link_result = BundledCoverage::prepare(&config, output.path()).unwrap();
        assert_ne!(directory_link_result.directory, directory_link);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_output_aliases_and_external_session_symlinks() {
        let (report, config) = fixture();
        let aliases = tempfile::tempdir().unwrap();
        let alias = aliases.path().join("report-alias");
        std::os::unix::fs::symlink(report.path(), &alias).unwrap();
        assert!(BundledCoverage::prepare(&config, &alias.join("new")).is_err());
        assert!(!report.path().join("new").exists());

        fs::remove_file(report.path().join("session.xml")).unwrap();
        let external = aliases.path().join("outside.xml");
        fs::write(&external, "<session/>").unwrap();
        std::os::unix::fs::symlink(external, report.path().join("session.xml")).unwrap();
        assert!(BundledCoverage::prepare(&config, aliases.path()).is_err());
    }
}
