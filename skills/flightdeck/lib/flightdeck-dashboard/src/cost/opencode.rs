use crate::state::snapshot::TrackedSession;

use super::{CostError, CostMetrics, CostSource};

#[derive(Debug, Default, Clone, Copy)]
pub struct OpenCodeSource;

impl CostSource for OpenCodeSource {
    fn name(&self) -> &'static str {
        "opencode"
    }

    fn supports(&self, entry: &TrackedSession) -> bool {
        entry
            .harness
            .as_deref()
            .is_some_and(|harness| harness == "opencode")
            || entry.adapter.oc_url.is_some()
            || entry.adapter.oc_session_id.is_some()
    }

    fn poll(&mut self, entry: &TrackedSession) -> Result<CostMetrics, CostError> {
        if entry.adapter.oc_url.is_none() || entry.adapter.oc_session_id.is_none() {
            return Err(CostError::Unavailable(String::from(
                "opencode session metadata missing",
            )));
        }
        Err(CostError::Unavailable(String::from(
            "opencode usage HTTP source unavailable",
        )))
    }
}
