use crate::state::snapshot::TrackedSession;

use super::{CostError, CostMetrics, CostSource};

#[derive(Debug, Default, Clone, Copy)]
pub struct PiSource;

impl CostSource for PiSource {
    fn name(&self) -> &'static str {
        "pi"
    }

    fn supports(&self, entry: &TrackedSession) -> bool {
        entry
            .harness
            .as_deref()
            .is_some_and(|harness| harness == "pi")
            || entry.adapter.pi_session_id.is_some()
            || entry.adapter.pi_bridge_pid.is_some()
    }

    fn poll(&mut self, entry: &TrackedSession) -> Result<CostMetrics, CostError> {
        let detail =
            if entry.adapter.pi_session_id.is_none() && entry.adapter.pi_bridge_pid.is_none() {
                "pi session metadata missing"
            } else {
                "pi transcript source unavailable outside Pi bridge"
            };
        Err(CostError::Unavailable(detail.to_owned()))
    }
}
