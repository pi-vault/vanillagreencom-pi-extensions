use chrono::{DateTime, Utc};
use thiserror::Error;

use crate::activity::ActivityEvent;
use crate::state::snapshot::DashboardSnapshot;
use crate::state::tracked_entries::{self, StateError};

const EMPTY: &str = include_str!("fixtures/empty.json");
const ONE_ADHOC: &str = include_str!("fixtures/one-adhoc.json");
const ONE_ISSUE: &str = include_str!("fixtures/one-issue.json");
const MIXED: &str = include_str!("fixtures/mixed.json");
const TERMINATED: &str = include_str!("fixtures/terminated.json");
const PAUSED: &str = include_str!("fixtures/paused.json");
const OBSERVER: &str = include_str!("fixtures/observer.json");
const CONVERSATIONS: &str = include_str!("fixtures/conversations.json");
const NO_ISSUE: &str = include_str!("fixtures/no-issue.json");
const DECISIONS: &str = include_str!("fixtures/decisions.json");
const ACTIVITY_MIXED: &str = include_str!("fixtures/activity-mixed.jsonl");

#[derive(Debug, Error)]
pub enum FixtureError {
    #[error("unknown demo fixture {0:?}; available: empty, one-adhoc, one-issue, mixed, terminated, paused, observer, conversations, no-issue, decisions")]
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
        "observer",
        "conversations",
        "no-issue",
        "decisions",
    ]
}

pub fn canonical_name(name: &str) -> Result<&'static str, FixtureError> {
    match name {
        "empty" => Ok("empty"),
        "one-adhoc" => Ok("one-adhoc"),
        "one-issue" => Ok("one-issue"),
        "mixed" => Ok("mixed"),
        "terminated" => Ok("terminated"),
        "paused" => Ok("paused"),
        "observer" => Ok("observer"),
        "conversations" => Ok("conversations"),
        "no-issue" => Ok("no-issue"),
        "decisions" => Ok("decisions"),
        other => Err(FixtureError::UnknownFixture(other.to_owned())),
    }
}

pub fn fixture_source(name: &str) -> Result<&'static str, FixtureError> {
    match canonical_name(name)? {
        "empty" => Ok(EMPTY),
        "one-adhoc" => Ok(ONE_ADHOC),
        "one-issue" => Ok(ONE_ISSUE),
        "mixed" => Ok(MIXED),
        "terminated" => Ok(TERMINATED),
        "paused" => Ok(PAUSED),
        "observer" => Ok(OBSERVER),
        "conversations" => Ok(CONVERSATIONS),
        "no-issue" => Ok(NO_ISSUE),
        "decisions" => Ok(DECISIONS),
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

pub fn load_demo_activity(name: &str) -> Result<Vec<ActivityEvent>, FixtureError> {
    let jsonl = match canonical_name(name)? {
        "mixed" => ACTIVITY_MIXED,
        _ => "",
    };
    Ok(jsonl
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<ActivityEvent>(line).ok())
        .collect())
}
