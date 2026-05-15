use chrono::{DateTime, Utc};
use thiserror::Error;

use crate::state::schema::DashboardSnapshot;
use crate::state::tracked_entries::{self, StateError};

const EMPTY: &str = include_str!("fixtures/empty.json");
const ONE_ADHOC: &str = include_str!("fixtures/one-adhoc.json");
const ONE_ISSUE: &str = include_str!("fixtures/one-issue.json");
const MIXED: &str = include_str!("fixtures/mixed.json");
const TERMINATED: &str = include_str!("fixtures/terminated.json");
const PAUSED: &str = include_str!("fixtures/paused.json");

#[derive(Debug, Error)]
pub enum FixtureError {
    #[error("unknown demo fixture {0:?}; available: empty, one-adhoc, one-issue, mixed, terminated, paused")]
    UnknownFixture(String),
    #[error(transparent)]
    State(#[from] StateError),
}

#[must_use]
pub fn available() -> &'static [&'static str] {
    &[
        "empty",
        "one-adhoc",
        "one-issue",
        "mixed",
        "terminated",
        "paused",
    ]
}

pub fn fixture_source(name: &str) -> Result<&'static str, FixtureError> {
    match name {
        "empty" => Ok(EMPTY),
        "one-adhoc" => Ok(ONE_ADHOC),
        "one-issue" => Ok(ONE_ISSUE),
        "mixed" => Ok(MIXED),
        "terminated" => Ok(TERMINATED),
        "paused" => Ok(PAUSED),
        other => Err(FixtureError::UnknownFixture(other.to_owned())),
    }
}

pub fn load_demo_snapshot(
    name: &str,
    now: DateTime<Utc>,
) -> Result<DashboardSnapshot, FixtureError> {
    let source = fixture_source(name)?;
    tracked_entries::snapshot_from_str(source, now).map_err(FixtureError::State)
}
