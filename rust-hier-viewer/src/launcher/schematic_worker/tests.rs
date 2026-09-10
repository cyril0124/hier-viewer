use super::*;
use std::sync::Arc;

fn mock(script: &str) -> SchematicWorker {
    let directory = tempfile::tempdir().unwrap();
    let diagnostics = tempfile::tempfile().unwrap();
    let mut child = Command::new("sh")
        .args(["-c", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(diagnostics.try_clone().unwrap())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut worker = SchematicWorker {
        child,
        replies: Some(receiver),
        reader: Some(reader),
        diagnostics,
        database: directory.path().join("scope.sqlite"),
        _directory: directory,
    };
    worker
        .wait_for(READY, &AtomicBool::new(false), Duration::from_secs(2))
        .unwrap();
    worker
}

#[test]
fn one_worker_handles_multiple_requests_and_rejects_line_injection() {
    let mut worker = mock(
        "printf 'HIER_SCHEMATIC_READY\\n'; while IFS= read -r scope; do printf 'HIER_SCHEMATIC_OK\\n'; done",
    );
    let stop = AtomicBool::new(false);
    let pid = worker.child.id();
    assert!(worker.export("top\nother", &stop).is_err());
    assert!(worker.export("top", &stop).is_ok());
    assert!(worker.export("top.child", &stop).is_ok());
    assert_eq!(worker.child.id(), pid);
    assert!(worker.child.try_wait().unwrap().is_none());
    let directory = worker._directory.path().to_path_buf();
    drop(worker);
    assert!(!directory.exists());
}

#[test]
fn scope_failures_include_worker_diagnostics() {
    let mut worker = mock(
        "printf 'HIER_SCHEMATIC_READY\\n'; read -r scope; printf 'test scope missing\\n' >&2; printf 'HIER_SCHEMATIC_ERROR\\n'",
    );
    let error = worker.export("top", &AtomicBool::new(false)).unwrap_err();
    assert!(error.contains("test scope missing"), "{error}");
}

#[test]
fn cancellation_interrupts_a_blocked_worker_reply() {
    let mut worker = mock("printf 'HIER_SCHEMATIC_READY\\n'; read -r scope; read -r pending");
    let stop = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&stop);
    let cancellation = thread::spawn(move || {
        thread::sleep(Duration::from_millis(25));
        signal.store(true, Ordering::Release);
    });
    let error = worker.export("top", &stop).unwrap_err();
    cancellation.join().unwrap();
    assert!(error.contains("cancelled"), "{error}");
}

#[test]
fn reply_timeout_and_child_exit_are_errors() {
    let mut worker = mock("printf 'HIER_SCHEMATIC_READY\\n'; read -r pending");
    let error = worker
        .wait_for(COMPLETE, &AtomicBool::new(false), Duration::from_millis(20))
        .unwrap_err();
    assert!(error.contains("timeout"), "{error}");
    drop(worker);
    let mut exited = mock("printf 'HIER_SCHEMATIC_READY\\n'");
    assert!(exited.export("top", &AtomicBool::new(false)).is_err());
}
