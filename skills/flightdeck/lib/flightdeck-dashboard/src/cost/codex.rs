use crate::state::snapshot::TrackedSession;

use super::{CostError, CostMetrics, CostSource};

#[derive(Debug, Default, Clone, Copy)]
pub struct CodexSource;

impl CostSource for CodexSource {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn supports(&self, entry: &TrackedSession) -> bool {
        entry
            .harness
            .as_deref()
            .is_some_and(|harness| harness == "codex")
            || entry.adapter.cx_ws.is_some()
            || entry.adapter.cx_thread_id.is_some()
    }

    fn poll(&mut self, _entry: &TrackedSession) -> Result<CostMetrics, CostError> {
        Err(CostError::Unavailable(String::from(
            "codex usage not yet supported",
        )))
    }
}
