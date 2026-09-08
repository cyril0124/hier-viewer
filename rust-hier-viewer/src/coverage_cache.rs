use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::hash::{Hash, Hasher};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::coverage_bundle::resolve_output_path;
use crate::coverage_import::{
    URG_REPORT_ARGS, find_urg_executable, generate_urg_report, report_files, timeout_duration,
};
use crate::interrupt::CancellationGuard;
use crate::logging::info;

const CACHE_VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
struct CacheRecord {
    version: u32,
    input_signature: u64,
    tool_signature: u64,
    report_signature: u64,
    generation: String,
}

pub(crate) fn prepare_vdb(
    input: &Path,
    output: &Path,
    rebuild: bool,
    timeout_minutes: u64,
) -> Result<PathBuf, String> {
    let input = fs::canonicalize(input).map_err(|err| format!("cannot open VDB: {err}"))?;
    if !input.is_dir() {
        return Err("VDB input must be a directory".to_string());
    }
    let output = resolve_output_path(output)?;
    if output.starts_with(&input) {
        return Err("coverage output must be outside the input VDB directory".to_string());
    }
    let executable =
        find_urg_executable().ok_or("CLI VDB conversion requires Linux and urg on PATH")?;
    let executable =
        fs::canonicalize(executable).map_err(|err| format!("cannot resolve urg: {err}"))?;
    let timeout = timeout_duration(timeout_minutes).map_err(|err| err.message)?;
    let cancellation = CancellationGuard::install()?;
    cached_report(
        &input,
        &output,
        &executable,
        rebuild,
        timeout,
        cancellation.signal(),
    )
}

fn check_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("VDB conversion was cancelled".to_string());
    }
    Ok(())
}

// An OS lock is released on exit or crash. Keep the lock file itself: deleting it
// could let new callers lock a different inode while an older caller still works.
fn lock_entry(path: &Path, cancel: &AtomicBool) -> Result<File, String> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|err| format!("cannot open coverage cache lock: {err}"))?;
    let mut waiting_logged = false;
    loop {
        check_cancelled(cancel)?;
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(TryLockError::WouldBlock) => {
                if !waiting_logged {
                    info(
                        "coverage",
                        "Waiting for another VDB conversion using this cache...",
                    );
                    waiting_logged = true;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("cannot lock coverage cache: {error}")),
        }
    }
}

// Metadata avoids rereading potentially huge VDB payloads. Include every path,
// file size/timestamp and symlink target, following linked files and directories.
// Directory timestamps are excluded: transient tool lock files may change them.
fn tree_signature(root: &Path, cancel: &AtomicBool) -> Result<u64, String> {
    let mut hasher = DefaultHasher::new();
    for entry in WalkDir::new(root).follow_links(true).sort_by_file_name() {
        check_cancelled(cancel)?;
        let entry = entry.map_err(|err| format!("cannot inspect coverage cache input: {err}"))?;
        entry
            .path()
            .strip_prefix(root)
            .map_err(|err| err.to_string())?
            .hash(&mut hasher);
        let link_metadata = fs::symlink_metadata(entry.path()).map_err(|err| err.to_string())?;
        if link_metadata.file_type().is_symlink() {
            fs::read_link(entry.path())
                .map_err(|err| err.to_string())?
                .hash(&mut hasher);
            fs::canonicalize(entry.path())
                .map_err(|err| err.to_string())?
                .hash(&mut hasher);
        }
        let metadata = fs::metadata(entry.path()).map_err(|err| err.to_string())?;
        metadata.is_dir().hash(&mut hasher);
        if metadata.is_file() {
            metadata.len().hash(&mut hasher);
            metadata
                .modified()
                .map_err(|err| err.to_string())?
                .hash(&mut hasher);
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                metadata.ctime().hash(&mut hasher);
                metadata.ctime_nsec().hash(&mut hasher);
                metadata.dev().hash(&mut hasher);
                metadata.ino().hash(&mut hasher);
            }
        } else if !metadata.is_dir() {
            return Err(format!(
                "unsupported coverage file type: '{}'",
                entry.path().display()
            ));
        }
    }
    Ok(hasher.finish())
}

fn tool_signature(executable: &Path, cancel: &AtomicBool) -> Result<u64, String> {
    let mut hasher = DefaultHasher::new();
    executable.hash(&mut hasher);
    URG_REPORT_ARGS.hash(&mut hasher);
    tree_signature(executable, cancel)?.hash(&mut hasher);
    Ok(hasher.finish())
}

fn reusable_report(
    entry: &Path,
    input_signature: u64,
    tool_signature: u64,
    cancel: &AtomicBool,
) -> Result<Option<PathBuf>, String> {
    let bytes = match fs::read(entry.join("current.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("cannot read coverage cache: {error}")),
    };
    let Ok(record) = serde_json::from_slice::<CacheRecord>(&bytes) else {
        return Ok(None);
    };
    if record.version != CACHE_VERSION
        || record.input_signature != input_signature
        || record.tool_signature != tool_signature
    {
        return Ok(None);
    }
    let mut components = Path::new(&record.generation).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Ok(None);
    }
    let Ok(report) = fs::canonicalize(entry.join(record.generation).join("report")) else {
        return Ok(None);
    };
    if !report.starts_with(entry) {
        return Ok(None);
    }
    match tree_signature(&report, cancel) {
        Ok(signature) if signature == record.report_signature => Ok(Some(report)),
        _ => {
            check_cancelled(cancel)?;
            Ok(None)
        }
    }
}

fn cached_report(
    input: &Path,
    output: &Path,
    executable: &Path,
    rebuild: bool,
    timeout: Option<Duration>,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let mut key = DefaultHasher::new();
    input.hash(&mut key);
    let entry = output
        .join(".hier-viewer-cache/coverage")
        .join(format!("{:016x}", key.finish()));
    let entry = resolve_output_path(&entry)?;
    if entry.starts_with(input) {
        return Err("coverage cache must be outside the input VDB directory".to_string());
    }
    fs::create_dir_all(&entry).map_err(|err| format!("cannot create coverage cache: {err}"))?;
    let entry = fs::canonicalize(entry).map_err(|err| err.to_string())?;
    let _lock = lock_entry(&entry.join("cache.lock"), cancel)?;

    // Read fingerprints after acquiring the lock: a previous caller may have
    // completed the conversion, or the input may have changed while we waited.
    let input_signature = tree_signature(input, cancel)?;
    let tool_signature_before = tool_signature(executable, cancel)?;
    if !rebuild
        && let Some(report) =
            reusable_report(&entry, input_signature, tool_signature_before, cancel)?
    {
        info("coverage", "VDB cache hit; reusing URG report.");
        return Ok(report);
    }
    info(
        "coverage",
        if rebuild {
            "Forced VDB conversion with URG..."
        } else {
            "VDB cache miss; converting with URG..."
        },
    );
    let (report, generation) = generate_urg_report(
        executable,
        input,
        timeout,
        cancel,
        &AtomicI32::new(0),
        Some(&entry),
    )?;
    report_files(&report).map_err(|err| err.message)?;
    if fs::metadata(report.join("session.xml"))
        .map_err(|err| err.to_string())?
        .len()
        == 0
    {
        return Err("URG generated an empty session.xml; cache was not updated".to_string());
    }
    if tree_signature(input, cancel)? != input_signature
        || tool_signature(executable, cancel)? != tool_signature_before
    {
        return Err("VDB or URG changed during conversion; cache was not updated. Retry with stable inputs.".to_string());
    }
    let record = CacheRecord {
        version: CACHE_VERSION,
        input_signature,
        tool_signature: tool_signature_before,
        report_signature: tree_signature(&report, cancel)?,
        generation: generation
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("invalid coverage cache generation name")?
            .to_string(),
    };

    // Publish only a finished immutable report. Readers of an older generation
    // remain valid even when a forced rebuild replaces the current pointer.
    let mut manifest = tempfile::NamedTempFile::new_in(&entry).map_err(|err| err.to_string())?;
    serde_json::to_writer(&mut manifest, &record).map_err(|err| err.to_string())?;
    manifest.flush().map_err(|err| err.to_string())?;
    check_cancelled(cancel)?;
    manifest
        .persist(entry.join("current.json"))
        .map_err(|err| format!("cannot publish coverage cache: {err}"))?;
    let _ = generation.keep();
    info("coverage", "VDB report cached.");
    Ok(report)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Barrier;

    struct Fixture {
        workspace: tempfile::TempDir,
        input: PathBuf,
        output: PathBuf,
        executable: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let workspace = tempfile::tempdir().unwrap();
            let input = workspace.path().join("input.vdb");
            let output = workspace.path().join("viewer");
            let executable = workspace.path().join("urg");
            fs::create_dir(&input).unwrap();
            fs::write(input.join("data"), "first").unwrap();
            fs::write(&executable, "#!/bin/sh\nset -eu\nprintf x >> \"$2/../calls\"\nif [ -f \"$2/../fail\" ]; then exit 1; fi\nif [ -f \"$2/../slow\" ]; then sleep 1; fi\nif [ -f \"$2/../change\" ]; then printf changed-during-conversion > \"$2/data\"; fi\nmkdir -p \"$4\"\nprintf '<session/>' > \"$4/session.xml\"\n").unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            Self {
                workspace,
                input,
                output,
                executable,
            }
        }

        fn load(&self, rebuild: bool) -> Result<PathBuf, String> {
            cached_report(
                &self.input,
                &self.output,
                &self.executable,
                rebuild,
                Some(Duration::from_secs(5)),
                &AtomicBool::new(false),
            )
        }

        fn calls(&self) -> usize {
            fs::read(self.workspace.path().join("calls"))
                .unwrap_or_default()
                .len()
        }
    }

    #[test]
    fn cache_reuses_and_invalidates_inputs_reports_and_tools() {
        let fixture = Fixture::new();
        let first = fixture.load(false).unwrap();
        assert_eq!(fixture.load(false).unwrap(), first);
        assert_eq!(fixture.calls(), 1);
        fs::write(fixture.input.join("data"), "longer changed input").unwrap();
        fixture.load(false).unwrap();
        fs::write(fixture.input.join("added"), "new file").unwrap();
        fixture.load(false).unwrap();
        fs::remove_file(fixture.input.join("added")).unwrap();
        fixture.load(false).unwrap();
        let forced = fixture.load(true).unwrap();
        assert_eq!(fixture.calls(), 5);
        assert!(
            first.join("session.xml").exists(),
            "Published generations remain immutable"
        );
        fs::write(forced.join("session.xml"), "").unwrap();
        fixture.load(false).unwrap();
        assert_eq!(fixture.calls(), 6);
        let mut tool = OpenOptions::new()
            .append(true)
            .open(&fixture.executable)
            .unwrap();
        writeln!(tool, "# changed executable").unwrap();
        drop(tool);
        fixture.load(false).unwrap();
        assert_eq!(fixture.calls(), 7);
    }

    #[test]
    fn failed_or_unstable_conversions_do_not_replace_the_cache() {
        let fixture = Fixture::new();
        let first = fixture.load(false).unwrap();
        let pointer = first
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("current.json");
        let original = fs::read(&pointer).unwrap();
        fs::write(fixture.workspace.path().join("fail"), "").unwrap();
        assert!(fixture.load(true).unwrap_err().contains("URG exited"));
        assert_eq!(fs::read(&pointer).unwrap(), original);
        fs::remove_file(fixture.workspace.path().join("fail")).unwrap();
        assert_eq!(fixture.load(false).unwrap(), first);
        assert_eq!(fixture.calls(), 2);
        fs::write(fixture.workspace.path().join("change"), "").unwrap();
        assert!(
            fixture
                .load(true)
                .unwrap_err()
                .contains("changed during conversion")
        );
        assert_eq!(fs::read(&pointer).unwrap(), original);
        fs::remove_file(fixture.workspace.path().join("change")).unwrap();
        assert_ne!(fixture.load(false).unwrap(), first);
        assert_eq!(fixture.calls(), 4);
    }

    #[test]
    fn refuses_a_cache_directory_redirected_into_the_vdb() {
        let fixture = Fixture::new();
        fs::create_dir(&fixture.output).unwrap();
        std::os::unix::fs::symlink(&fixture.input, fixture.output.join(".hier-viewer-cache"))
            .unwrap();
        assert!(
            fixture
                .load(false)
                .unwrap_err()
                .contains("outside the input VDB")
        );
        assert!(!fixture.input.join("coverage").exists());
        assert_eq!(fixture.calls(), 0);
    }

    #[test]
    fn concurrent_callers_share_one_conversion() {
        let fixture = Fixture::new();
        fs::write(fixture.workspace.path().join("slow"), "").unwrap();
        let barrier = Barrier::new(4);
        let reports = thread::scope(|scope| {
            let workers: Vec<_> = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        fixture.load(false).unwrap()
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        assert!(reports.iter().all(|report| report == &reports[0]));
        assert_eq!(fixture.calls(), 1);
    }

    #[test]
    fn linked_inputs_and_cancellation_are_observed() {
        let fixture = Fixture::new();
        let external = fixture.workspace.path().join("external");
        fs::write(&external, "original").unwrap();
        std::os::unix::fs::symlink(&external, fixture.input.join("linked")).unwrap();
        fixture.load(false).unwrap();
        fs::write(external, "updated external input").unwrap();
        fixture.load(false).unwrap();
        assert_eq!(fixture.calls(), 2);
        assert!(
            cached_report(
                &fixture.input,
                &fixture.output,
                &fixture.executable,
                true,
                None,
                &AtomicBool::new(true)
            )
            .unwrap_err()
            .contains("cancelled")
        );
        assert_eq!(fixture.calls(), 2);
        fs::write(fixture.workspace.path().join("slow"), "").unwrap();
        assert!(
            cached_report(
                &fixture.input,
                &fixture.output,
                &fixture.executable,
                true,
                Some(Duration::from_millis(20)),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .contains("timed out")
        );
        assert_eq!(fixture.calls(), 3);
        fixture.load(false).unwrap();
        assert_eq!(
            fixture.calls(),
            3,
            "Timeout leaves the previous valid cache usable"
        );
    }
}
