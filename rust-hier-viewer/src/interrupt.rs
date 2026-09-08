use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

static HANDLER: OnceLock<Result<(), String>> = OnceLock::new();
static ACTIVE: AtomicBool = AtomicBool::new(false);
static CANCELLED: AtomicBool = AtomicBool::new(false);

// CLI conversion and preview run sequentially but must share one Ctrl-C handler.
// Outside these cancellable phases, preserve normal command termination behavior.
pub(crate) struct CancellationGuard;

impl CancellationGuard {
    pub(crate) fn install() -> Result<Self, String> {
        HANDLER
            .get_or_init(|| {
                ctrlc::set_handler(|| {
                    if ACTIVE.load(Ordering::Acquire) {
                        CANCELLED.store(true, Ordering::Release);
                    } else {
                        std::process::exit(130);
                    }
                })
                .map_err(|err| format!("failed to install Ctrl-C handler: {err}"))
            })
            .clone()?;
        CANCELLED.store(false, Ordering::Release);
        ACTIVE.store(true, Ordering::Release);
        Ok(Self)
    }

    pub(crate) fn signal(&self) -> &AtomicBool {
        &CANCELLED
    }
}

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}
