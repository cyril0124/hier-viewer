//! A single Slang compilation shared by all uncached scopes in a preview.
//! The child owns the C++ AST; only a small selected-scope DB crosses the process boundary.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::{StartupSelection, locate_hierarchy_exporter};

const READY: &str = "HIER_SCHEMATIC_READY";
const COMPLETE: &str = "HIER_SCHEMATIC_OK";
const FAILED: &str = "HIER_SCHEMATIC_ERROR";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

#[cfg(all(test, unix))]
mod tests;

pub(crate) struct SchematicWorker {
    child: Child,
    replies: Option<Receiver<std::io::Result<String>>>,
    reader: Option<JoinHandle<()>>,
    diagnostics: File,
    database: PathBuf,
    // Destroy the child and its readers before removing its output directory.
    _directory: tempfile::TempDir,
}

impl SchematicWorker {
    /// Parse and elaborate RTL once. Cancellation, startup failure and timeout
    /// all reap the child and remove its temporary output through Drop.
    pub(crate) fn start(
        selection: &StartupSelection,
        cwd: &Path,
        hierarchy: &Path,
        stop: &AtomicBool,
    ) -> Result<Self, String> {
        let exporter = locate_hierarchy_exporter()?;
        let directory = tempfile::tempdir().map_err(|err| err.to_string())?;
        let database = directory.path().join("scope.sqlite");
        let diagnostics = tempfile::tempfile().map_err(|err| err.to_string())?;
        let child = Command::new(&exporter.path)
            .current_dir(cwd)
            .args(["--sqlite", "--schematic-worker"])
            .arg(hierarchy)
            .arg("-o")
            .arg(&database)
            .args(&selection.extra_args_tokens)
            .args(&selection.source_args_tokens)
            .env("HIER_VIEWER_LOG_COLOR", "never")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(diagnostics.try_clone().map_err(|err| err.to_string())?)
            .spawn()
            .map_err(|err| format!("failed to start persistent Slang worker: {err}"))?;
        let mut worker = Self {
            child,
            replies: None,
            reader: None,
            diagnostics,
            database,
            _directory: directory,
        };
        let stdout = worker
            .child
            .stdout
            .take()
            .ok_or("Slang worker stdout is unavailable")?;
        let (sender, receiver) = mpsc::channel();
        worker.replies = Some(receiver);
        worker.reader = Some(thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let failed = line.is_err();
                if sender.send(line).is_err() || failed {
                    break;
                }
            }
        }));
        let started = Instant::now();
        worker.wait_for(READY, stop, REQUEST_TIMEOUT)?;
        crate::logging::info(
            "schematic",
            format!(
                "Slang worker ready in {:.2}s (pid {}); keeping the elaborated design for later scopes.",
                started.elapsed().as_secs_f64(),
                worker.child.id(),
            ),
        );
        Ok(worker)
    }

    /// Overwrite the worker-owned DB with exactly one scope. The caller must
    /// finish reading it before requesting another scope. Errors require dropping
    /// this worker, so a partial reply can never be mistaken for a later result.
    pub(crate) fn export(&mut self, scope: &str, stop: &AtomicBool) -> Result<&Path, String> {
        if scope.is_empty() || scope.contains(['\n', '\r', '\0']) {
            return Err("invalid scope path for the Slang worker".into());
        }
        if stop.load(Ordering::Acquire) {
            return Err("Schematic build cancelled.".into());
        }
        let input = self
            .child
            .stdin
            .as_mut()
            .ok_or("Slang worker input is closed")?;
        writeln!(input, "{scope}")
            .and_then(|()| input.flush())
            .map_err(|err| format!("cannot send scope to Slang worker: {err}"))?;
        self.wait_for(COMPLETE, stop, REQUEST_TIMEOUT)?;
        Ok(&self.database)
    }

    fn wait_for(
        &mut self,
        expected: &str,
        stop: &AtomicBool,
        timeout: Duration,
    ) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if stop.load(Ordering::Acquire) {
                return Err("Schematic build cancelled.".into());
            }
            if started.elapsed() >= timeout {
                return Err("Slang worker exceeded its request timeout.".into());
            }
            match self
                .replies
                .as_ref()
                .ok_or("Slang worker output is closed")?
                .recv_timeout(
                    Duration::from_millis(100).min(timeout.saturating_sub(started.elapsed())),
                ) {
                Ok(Ok(line)) if line == expected => return Ok(()),
                Ok(Ok(line)) if line == FAILED => {
                    return Err(self.failure_detail("Slang scope generation failed"));
                }
                Ok(Ok(line)) if line.starts_with("HIER_SCHEMATIC_") => {
                    return Err(format!("unexpected Slang worker reply: {line}"));
                }
                // Slang may print design-unit information before READY.
                Ok(Ok(_)) | Err(RecvTimeoutError::Timeout) => {}
                Ok(Err(err)) => return Err(format!("cannot read Slang worker output: {err}")),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(self.failure_detail("Slang worker exited before replying"));
                }
            }
        }
    }

    fn failure_detail(&mut self, context: &str) -> String {
        let tail = (|| -> std::io::Result<Vec<u8>> {
            let length = self.diagnostics.metadata()?.len();
            self.diagnostics
                .seek(SeekFrom::Start(length.saturating_sub(8192)))?;
            let mut bytes = Vec::new();
            self.diagnostics.read_to_end(&mut bytes)?;
            Ok(bytes)
        })();
        match tail {
            Ok(bytes) => format!("{context}: {}", String::from_utf8_lossy(&bytes).trim()),
            Err(err) => format!("{context}; could not read diagnostics: {err}"),
        }
    }
}

impl Drop for SchematicWorker {
    fn drop(&mut self) {
        self.replies.take();
        self.child.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
