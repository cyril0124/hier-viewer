use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use walkdir::WalkDir;

const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilitiesResponse {
    pub(crate) available: bool,
    pub(crate) vdb_available: bool,
    pub(crate) token: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum JobState {
    Running,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) files: Vec<String>,
    pub(crate) base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) report_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct JobResponse {
    pub(crate) id: String,
    pub(crate) state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) report: Option<ReportInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportRequest {
    pub(crate) kind: ImportKind,
    pub(crate) path: String,
    #[serde(default = "default_timeout_minutes")]
    pub(crate) timeout_minutes: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ImportKind {
    Vdb,
    Report,
}

const fn default_timeout_minutes() -> u64 {
    60
}

#[derive(Debug)]
pub(crate) struct ServiceError {
    pub(crate) status: u16,
    pub(crate) message: String,
}

impl ServiceError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: 409,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: 404,
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            message: message.into(),
        }
    }
}

struct JobRecord {
    response: JobResponse,
    cancel: Arc<AtomicBool>,
    process_group: Arc<AtomicI32>,
}

struct ReportRecord {
    root: PathBuf,
    _generated_dir: Option<TempDir>,
}

#[derive(Default)]
struct ServiceState {
    jobs: HashMap<String, JobRecord>,
    reports: HashMap<String, ReportRecord>,
    running_urg: Option<String>,
}

pub(crate) struct CoverageService {
    token: String,
    urg_executable: Option<PathBuf>,
    state: Mutex<ServiceState>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    stopping: AtomicBool,
}

impl CoverageService {
    pub(crate) fn new() -> Result<Arc<Self>, String> {
        Self::with_executable(find_urg_executable())
    }

    fn with_executable(urg_executable: Option<PathBuf>) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            token: random_id(32)?,
            urg_executable,
            state: Mutex::new(ServiceState::default()),
            workers: Mutex::new(Vec::new()),
            stopping: AtomicBool::new(false),
        }))
    }

    pub(crate) fn capabilities(&self) -> CapabilitiesResponse {
        CapabilitiesResponse {
            available: true,
            vdb_available: self.urg_executable.is_some(),
            token: self.token.clone(),
        }
    }

    pub(crate) fn token_matches(&self, candidate: Option<&str>) -> bool {
        candidate.is_some_and(|value| constant_time_eq(value.as_bytes(), self.token.as_bytes()))
    }

    pub(crate) fn import(
        self: &Arc<Self>,
        request: ImportRequest,
    ) -> Result<(u16, JobResponse), ServiceError> {
        if self.stopping.load(Ordering::Acquire) {
            return Err(ServiceError::conflict("coverage service is shutting down"));
        }
        if request.path.trim().is_empty() {
            return Err(ServiceError::bad_request("path must not be empty"));
        }
        match request.kind {
            ImportKind::Report => self
                .import_report(Path::new(&request.path))
                .map(|job| (200, job)),
            ImportKind::Vdb => self
                .import_vdb(Path::new(&request.path), request.timeout_minutes)
                .map(|job| (202, job)),
        }
    }

    fn import_report(&self, input: &Path) -> Result<JobResponse, ServiceError> {
        let root = canonical_directory(input, "report directory")?;
        let id = random_id(16).map_err(ServiceError::internal)?;
        let report = inspect_report(&root, &id, None)?;
        let response = JobResponse {
            id: id.clone(),
            state: JobState::Ready,
            error: None,
            report: Some(report),
        };
        let record = JobRecord {
            response: response.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            process_group: Arc::new(AtomicI32::new(0)),
        };
        let mut state = self.state.lock().expect("coverage state poisoned");
        if self.stopping.load(Ordering::Acquire) {
            return Err(ServiceError::conflict("coverage service is shutting down"));
        }
        state.reports.insert(
            id.clone(),
            ReportRecord {
                root,
                _generated_dir: None,
            },
        );
        state.jobs.insert(id, record);
        Ok(response)
    }

    fn import_vdb(
        self: &Arc<Self>,
        input: &Path,
        timeout_minutes: u64,
    ) -> Result<JobResponse, ServiceError> {
        let executable = self.urg_executable.clone().ok_or_else(|| {
            ServiceError::bad_request("VDB import is unavailable because urg was not found")
        })?;
        let input = canonical_directory(input, "VDB directory")?;
        let timeout = timeout_duration(timeout_minutes)?;
        let id = random_id(16).map_err(ServiceError::internal)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let process_group = Arc::new(AtomicI32::new(0));
        let response = JobResponse {
            id: id.clone(),
            state: JobState::Running,
            error: None,
            report: None,
        };

        let service = Arc::clone(self);
        let job_id = id.clone();
        {
            let mut state = self.state.lock().expect("coverage state poisoned");
            if self.stopping.load(Ordering::Acquire) {
                return Err(ServiceError::conflict("coverage service is shutting down"));
            }
            if state.running_urg.is_some() {
                return Err(ServiceError::conflict(
                    "another VDB import is already running",
                ));
            }
            state.running_urg = Some(id.clone());
            state.jobs.insert(
                id.clone(),
                JobRecord {
                    response: response.clone(),
                    cancel: Arc::clone(&cancel),
                    process_group: Arc::clone(&process_group),
                },
            );
            let worker = thread::spawn(move || {
                service.run_urg_job(job_id, executable, input, timeout, cancel, process_group);
            });
            self.workers
                .lock()
                .expect("coverage worker list poisoned")
                .push(worker);
        }
        Ok(response)
    }

    pub(crate) fn job(&self, id: &str) -> Result<JobResponse, ServiceError> {
        self.state
            .lock()
            .expect("coverage state poisoned")
            .jobs
            .get(id)
            .map(|job| job.response.clone())
            .ok_or_else(|| ServiceError::not_found("coverage job was not found"))
    }

    pub(crate) fn cancel_or_release(&self, id: &str) -> Result<JobResponse, ServiceError> {
        let (process_group, response, report) = {
            let mut state = self.state.lock().expect("coverage state poisoned");
            let job = state
                .jobs
                .get_mut(id)
                .ok_or_else(|| ServiceError::not_found("coverage job was not found"))?;
            job.cancel.store(true, Ordering::Release);
            job.response.state = JobState::Cancelled;
            job.response.error = None;
            job.response.report = None;
            let process_group = job.process_group.load(Ordering::Acquire);
            let response = job.response.clone();
            let report = state.reports.remove(id);
            (process_group, response, report)
        };
        terminate_process_group(process_group);
        drop(report);
        Ok(response)
    }

    pub(crate) fn report_root(&self, id: &str) -> Option<PathBuf> {
        self.state
            .lock()
            .expect("coverage state poisoned")
            .reports
            .get(id)
            .map(|report| report.root.clone())
    }

    pub(crate) fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        let process_groups = {
            let mut state = self.state.lock().expect("coverage state poisoned");
            state
                .jobs
                .values_mut()
                .filter_map(|job| {
                    if job.response.state == JobState::Running {
                        job.cancel.store(true, Ordering::Release);
                        job.response.state = JobState::Cancelled;
                        Some(job.process_group.load(Ordering::Acquire))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
        };
        for process_group in process_groups {
            terminate_process_group(process_group);
        }
        let workers =
            std::mem::take(&mut *self.workers.lock().expect("coverage worker list poisoned"));
        for worker in workers {
            let _ = worker.join();
        }
        let mut state = self.state.lock().expect("coverage state poisoned");
        state.reports.clear();
        state.running_urg = None;
    }

    fn run_urg_job(
        &self,
        id: String,
        executable: PathBuf,
        input: PathBuf,
        timeout: Option<Duration>,
        cancel: Arc<AtomicBool>,
        process_group: Arc<AtomicI32>,
    ) {
        let result = self.execute_urg(&id, &executable, &input, timeout, &cancel, &process_group);
        let mut state = self.state.lock().expect("coverage state poisoned");
        if state.running_urg.as_deref() == Some(&id) {
            state.running_urg = None;
        }
        let cancelled = cancel.load(Ordering::Acquire) || self.stopping.load(Ordering::Acquire);
        match result {
            Ok((root, generated_dir, report)) if !cancelled => {
                state.reports.insert(
                    id.clone(),
                    ReportRecord {
                        root,
                        _generated_dir: Some(generated_dir),
                    },
                );
                if let Some(job) = state.jobs.get_mut(&id) {
                    job.response.state = JobState::Ready;
                    job.response.report = Some(report);
                }
            }
            Ok(_) if cancelled => {
                if let Some(job) = state.jobs.get_mut(&id) {
                    job.response.state = JobState::Cancelled;
                    job.response.error = None;
                    job.response.report = None;
                }
            }
            Err(error) => {
                if let Some(job) = state.jobs.get_mut(&id) {
                    if cancelled {
                        job.response.state = JobState::Cancelled;
                        job.response.error = None;
                    } else {
                        job.response.state = JobState::Failed;
                        job.response.error = Some(error);
                    }
                }
            }
            Ok(_) => unreachable!(),
        }
    }

    fn execute_urg(
        &self,
        id: &str,
        executable: &Path,
        input: &Path,
        timeout: Option<Duration>,
        cancel: &AtomicBool,
        process_group: &AtomicI32,
    ) -> Result<(PathBuf, TempDir, ReportInfo), String> {
        let generated_dir = tempfile::Builder::new()
            .prefix("hier-viewer-urg-")
            .tempdir()
            .map_err(|err| format!("failed to create URG working directory: {err}"))?;
        let report_path = generated_dir.path().join("report");
        let mut command = Command::new(executable);
        command
            .args(["-dir"])
            .arg(input)
            .args(["-report"])
            .arg(&report_path)
            .args([
                "-format",
                "both",
                "-show",
                "fullhier",
                "-show",
                "ratios",
                "-xml_verbose",
                "-metric",
                "line+cond+branch+tgl+assert",
            ])
            .current_dir(generated_dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);

        if cancel.load(Ordering::Acquire) {
            return Err("URG import was cancelled before launch".to_string());
        }
        let started = Instant::now();
        let mut child = command
            .spawn()
            .map_err(|err| format!("failed to start '{}': {err}", executable.display()))?;
        let pid = child.id() as i32;
        process_group.store(pid, Ordering::Release);
        if cancel.load(Ordering::Acquire) {
            terminate_process_group(pid);
        }

        let stdout = child.stdout.take().map(drain_output);
        let stderr = child.stderr.take().map(drain_output);
        let mut timed_out = false;
        let status = wait_for_child(&mut child, started, timeout, cancel, &mut timed_out);
        // A launcher can exit before descendants close their inherited output pipes.
        terminate_process_group(pid);
        if status.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        process_group.store(0, Ordering::Release);
        let stdout = join_output(stdout);
        let stderr = join_output(stderr);
        let status = status?;

        if cancel.load(Ordering::Acquire) {
            return Err("URG import was cancelled".to_string());
        }
        if timed_out {
            return Err(format!(
                "URG import timed out{}",
                output_detail(&stdout, &stderr)
            ));
        }
        if !status.success() {
            return Err(format!(
                "URG exited with status {}{}",
                status,
                output_detail(&stdout, &stderr)
            ));
        }

        let root =
            canonical_directory(&report_path, "generated URG report").map_err(|err| err.message)?;
        let report = inspect_report(&root, id, input.file_name().and_then(|name| name.to_str()))
            .map_err(|err| err.message)?;
        Ok((root, generated_dir, report))
    }
}

fn wait_for_child(
    child: &mut Child,
    started: Instant,
    timeout: Option<Duration>,
    cancel: &AtomicBool,
    timed_out: &mut bool,
) -> Result<std::process::ExitStatus, String> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(err) => return Err(format!("failed waiting for URG: {err}")),
        }
        if cancel.load(Ordering::Acquire) {
            terminate_process_group(child.id() as i32);
            return child
                .wait()
                .map_err(|err| format!("failed to reap cancelled URG process: {err}"));
        }
        if timeout.is_some_and(|limit| started.elapsed() >= limit) {
            *timed_out = true;
            terminate_process_group(child.id() as i32);
            return child
                .wait()
                .map_err(|err| format!("failed to reap timed-out URG process: {err}"));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn inspect_report(
    root: &Path,
    id: &str,
    preferred_name: Option<&str>,
) -> Result<ReportInfo, ServiceError> {
    let files = report_files(root)?;
    let dashboard = root.join("dashboard.html");
    let report_url = fs::canonicalize(&dashboard)
        .ok()
        .filter(|path| path.starts_with(root) && path.is_file())
        .map(|_| format!("/coverage-reports/{id}/dashboard.html"));
    let name = preferred_name
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            root.file_name()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "coverage report".to_string());

    Ok(ReportInfo {
        id: id.to_string(),
        name,
        files,
        base_url: format!("/api/coverage/files/{id}/"),
        report_url,
    })
}

// The caller supplies a canonical directory. Do not follow report symlinks.
pub(crate) fn report_files(root: &Path) -> Result<Vec<String>, ServiceError> {
    let session = root.join("session.xml");
    let session = fs::canonicalize(&session).map_err(|err| {
        ServiceError::bad_request(format!("report has no readable session.xml: {err}"))
    })?;
    if !session.starts_with(root) || !session.is_file() {
        return Err(ServiceError::bad_request(
            "report session.xml must be a regular file inside the report directory",
        ));
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|err| {
            ServiceError::bad_request(format!("failed to inspect report directory: {err}"))
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(root).map_err(|_| {
            ServiceError::bad_request("report contains a file outside its directory")
        })?;
        let relative = relative
            .to_str()
            .ok_or_else(|| ServiceError::bad_request("report contains a non-UTF-8 file name"))?;
        files.push(relative.replace(std::path::MAIN_SEPARATOR, "/"));
    }
    files.sort_unstable();
    if files.is_empty() {
        return Err(ServiceError::bad_request(
            "report directory contains no files",
        ));
    }

    Ok(files)
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, ServiceError> {
    let canonical = fs::canonicalize(path).map_err(|err| {
        ServiceError::bad_request(format!(
            "failed to open {label} '{}': {err}",
            path.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(ServiceError::bad_request(format!(
            "{label} '{}' is not a directory",
            path.display()
        )));
    }
    Ok(canonical)
}

fn timeout_duration(minutes: u64) -> Result<Option<Duration>, ServiceError> {
    if minutes == 0 {
        return Ok(None);
    }
    let seconds = minutes
        .checked_mul(60)
        .ok_or_else(|| ServiceError::bad_request("timeoutMinutes is too large"))?;
    let duration = Duration::from_secs(seconds);
    Instant::now()
        .checked_add(duration)
        .ok_or_else(|| ServiceError::bad_request("timeoutMinutes is too large"))?;
    Ok(Some(duration))
}

fn random_id(byte_count: usize) -> Result<String, String> {
    let mut bytes = vec![0u8; byte_count];
    getrandom::fill(&mut bytes).map_err(|err| format!("secure random generation failed: {err}"))?;
    let mut encoded = String::with_capacity(byte_count * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(target_os = "linux")]
fn find_urg_executable() -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join("urg"))
        .find(|candidate| {
            fs::metadata(candidate).is_ok_and(|metadata| {
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            })
        })
}

#[cfg(not(target_os = "linux"))]
fn find_urg_executable() -> Option<PathBuf> {
    None
}

#[cfg(target_os = "linux")]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(target_os = "linux"))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(target_os = "linux")]
fn terminate_process_group(process_group: i32) {
    if process_group > 0 {
        unsafe {
            libc::kill(-process_group, libc::SIGKILL);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn terminate_process_group(_process_group: i32) {}

fn drain_output(mut reader: impl Read + Send + 'static) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut output = Vec::with_capacity(OUTPUT_LIMIT);
        let mut chunk = [0u8; 8192];
        loop {
            let read = match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            if read >= OUTPUT_LIMIT {
                output.clear();
                output.extend_from_slice(&chunk[read - OUTPUT_LIMIT..read]);
                continue;
            }
            let overflow = output
                .len()
                .saturating_add(read)
                .saturating_sub(OUTPUT_LIMIT);
            if overflow > 0 {
                output.drain(..overflow);
            }
            output.extend_from_slice(&chunk[..read]);
        }
        output
    })
}

fn join_output(handle: Option<JoinHandle<Vec<u8>>>) -> Vec<u8> {
    handle
        .and_then(|thread| thread.join().ok())
        .unwrap_or_default()
}

fn output_detail(stdout: &[u8], stderr: &[u8]) -> String {
    let selected = if stderr.is_empty() { stdout } else { stderr };
    let text = String::from_utf8_lossy(selected);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!(": {trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::{CoverageService, ImportKind, ImportRequest, JobState, timeout_duration};
    use std::fs;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    #[cfg(target_os = "linux")]
    use std::sync::atomic::{AtomicBool, AtomicI32};
    #[cfg(target_os = "linux")]
    use std::thread;
    #[cfg(target_os = "linux")]
    use std::time::{Duration, Instant};

    fn report_fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("create report fixture");
        fs::write(directory.path().join("session.xml"), "<session/>").expect("write session.xml");
        fs::write(directory.path().join(".hidden.xml"), "<hidden/>").expect("write hidden file");
        fs::write(directory.path().join("dashboard.html"), "report").expect("write dashboard");
        directory
    }

    #[test]
    fn report_import_lists_hidden_files_without_modifying_input() {
        let report = report_fixture();
        let service = CoverageService::with_executable(None).expect("create service");
        let (_, job) = service
            .import(ImportRequest {
                kind: ImportKind::Report,
                path: report.path().display().to_string(),
                timeout_minutes: 60,
            })
            .expect("import report");
        let imported = job.report.expect("ready report");
        assert_eq!(job.state, JobState::Ready);
        assert!(imported.files.iter().any(|file| file == ".hidden.xml"));
        assert!(report.path().join("session.xml").exists());
        service
            .cancel_or_release(&job.id)
            .expect("release imported report");
        assert!(report.path().join("session.xml").exists());
    }

    #[test]
    fn rejects_report_without_session_xml() {
        let directory = tempfile::tempdir().expect("create directory");
        let service = CoverageService::with_executable(None).expect("create service");
        let error = service
            .import(ImportRequest {
                kind: ImportKind::Report,
                path: directory.path().display().to_string(),
                timeout_minutes: 60,
            })
            .expect_err("invalid report must fail");
        assert_eq!(error.status, 400);
    }

    #[test]
    fn zero_timeout_is_unlimited_and_overflow_is_rejected() {
        assert_eq!(timeout_duration(0).expect("zero is unlimited"), None);
        assert!(timeout_duration(u64::MAX).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cancellation_kills_stub_process_group() {
        let fixture = report_fixture();
        let stub_dir = tempfile::tempdir().expect("create stub directory");
        let stub = stub_dir.path().join("urg-stub");
        fs::write(
            &stub,
            format!(
                "#!/bin/sh\ntrap '' TERM\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = \"-report\" ]; then shift; out=$1; fi\n  shift\ndone\nmkdir -p \"$out\"\ncp '{}' \"$out/session.xml\"\n(sleep 30) &\nwait\n",
                fixture.path().join("session.xml").display()
            ),
        )
        .expect("write stub");
        let mut permissions = fs::metadata(&stub).expect("stub metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&stub, permissions).expect("make stub executable");

        let service = CoverageService::with_executable(Some(stub)).expect("create service");
        let (_, job) = service
            .import(ImportRequest {
                kind: ImportKind::Vdb,
                path: fixture.path().display().to_string(),
                timeout_minutes: 0,
            })
            .expect("start VDB import");
        let deadline = Instant::now() + Duration::from_secs(2);
        while service
            .state
            .lock()
            .expect("coverage state")
            .jobs
            .get(&job.id)
            .expect("job")
            .process_group
            .load(std::sync::atomic::Ordering::Acquire)
            == 0
        {
            assert!(Instant::now() < deadline, "stub process did not start");
            thread::sleep(Duration::from_millis(10));
        }
        let cancelled = service
            .cancel_or_release(&job.id)
            .expect("cancel running job");
        assert_eq!(cancelled.state, JobState::Cancelled);
        service.shutdown();
        assert_eq!(
            service.job(&job.id).expect("cancelled job remains").state,
            JobState::Cancelled
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn short_internal_timeout_kills_stub_process_group() {
        let input = tempfile::tempdir().expect("create VDB fixture");
        let stub_dir = tempfile::tempdir().expect("create stub directory");
        let stub = stub_dir.path().join("urg-timeout-stub");
        fs::write(&stub, "#!/bin/sh\n(sleep 30) &\nwait\n").expect("write timeout stub");
        let mut permissions = fs::metadata(&stub).expect("stub metadata").permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&stub, permissions).expect("make stub executable");
        let service = CoverageService::with_executable(Some(stub.clone())).expect("create service");
        let started = Instant::now();
        let error = service
            .execute_urg(
                "0123456789abcdef0123456789abcdef",
                &stub,
                input.path(),
                Some(Duration::from_millis(50)),
                &AtomicBool::new(false),
                &AtomicI32::new(0),
            )
            .expect_err("stub must time out");
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn exited_launcher_cannot_leave_output_readers_blocked() {
        let input = tempfile::tempdir().expect("create input");
        let stub = input.path().join("urg-stub");
        fs::write(&stub, "#!/bin/sh\n(sleep 30) &\nexit 0\n").expect("write stub");
        fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).expect("executable stub");
        let service = CoverageService::with_executable(Some(stub.clone())).expect("service");
        let started = Instant::now();
        let result = service.execute_urg(
            "0123456789abcdef0123456789abcdef",
            &stub,
            input.path(),
            None,
            &AtomicBool::new(false),
            &AtomicI32::new(0),
        );
        assert!(
            result.is_err(),
            "stub deliberately does not generate a report"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn imported_user_report_remains_on_release() {
        let report = report_fixture();
        let service = CoverageService::with_executable(None).expect("create service");
        let (_, job) = service
            .import(ImportRequest {
                kind: ImportKind::Report,
                path: report.path().display().to_string(),
                timeout_minutes: 60,
            })
            .expect("import report");
        let root = service.report_root(&job.id).expect("registered root");
        assert_eq!(
            root,
            fs::canonicalize(report.path()).expect("canonical report")
        );
        service.cancel_or_release(&job.id).expect("release report");
        assert!(Path::new(&root).exists(), "user report must remain");
    }
}
