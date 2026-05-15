use chrono::{DateTime, Utc};
use serde_json::Value;
use thiserror::Error;

use super::schema::{DashboardSnapshot, MasterState};

#[derive(Debug, Error)]
pub enum StateError {
    #[error("failed to parse master state JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error(
        "pre-purge state contains .issues but no .entries; run flightdeck-session to archive it"
    )]
    PrePurgeState,
}

pub fn parse_master_state(raw: &str) -> Result<MasterState, StateError> {
    let value: Value = serde_json::from_str(raw)?;
    let has_entries = value.get("entries").is_some_and(Value::is_object);
    let has_issues = value.get("issues").is_some_and(Value::is_object);
    if !has_entries && has_issues {
        return Err(StateError::PrePurgeState);
    }
    serde_json::from_value(value).map_err(StateError::Parse)
}

pub fn snapshot_from_str(raw: &str, now: DateTime<Utc>) -> Result<DashboardSnapshot, StateError> {
    parse_master_state(raw).map(|state| DashboardSnapshot::from_master_state(state, now))
}
