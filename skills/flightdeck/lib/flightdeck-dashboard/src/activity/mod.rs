pub mod format;
pub mod jsonl;

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use jsonl::{JsonlActivitySource, MAX_EVENTS_IN_MEMORY};

const ACTIVITY_SCHEMA_VERSION: u8 = 1;

pub trait ActivitySource {
    fn poll(&mut self) -> Vec<ActivityEvent>;
    fn last_id(&self) -> Option<String>;
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ActivityEvent {
    #[serde(deserialize_with = "deserialize_schema_version")]
    pub schema_version: u8,
    pub id: String,
    pub ts: DateTime<Utc>,
    pub session_id: Option<String>,
    pub source: String,
    pub entry_id: Option<String>,
    pub entry_title: Option<String>,
    pub entry_kind: Option<String>,
    pub pane_id: Option<String>,
    pub harness: Option<String>,
    #[serde(rename = "type")]
    pub event_type: ActivityType,
    pub severity: Severity,
    pub importance: Importance,
    pub summary: String,
    pub body: Option<String>,
    #[serde(default)]
    pub links: Vec<ActivityLink>,
    pub refs: Option<ActivityRefs>,
    pub details: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    pub noisy: bool,
}

fn deserialize_schema_version<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let version = u8::deserialize(deserializer)?;
    if version == ACTIVITY_SCHEMA_VERSION {
        Ok(version)
    } else {
        Err(serde::de::Error::custom(format!(
            "unsupported activity schema_version {version}; expected {ACTIVITY_SCHEMA_VERSION}"
        )))
    }
}

impl ActivityEvent {
    #[must_use]
    pub fn session_label(&self) -> &str {
        self.entry_id
            .as_deref()
            .or(self.session_id.as_deref())
            .unwrap_or("—")
    }

    #[must_use]
    pub fn searchable_text(&self) -> String {
        let mut text = format!(
            "{} {} {} {} {}",
            self.session_label(),
            self.event_type.as_str(),
            self.severity.as_str(),
            self.importance.as_str(),
            self.summary
        );
        if let Some(body) = &self.body {
            text.push(' ');
            text.push_str(body);
        }
        if let Some(refs) = &self.refs {
            text.push(' ');
            text.push_str(&serde_json::to_string(refs).unwrap_or_default());
        }
        text
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ActivityType(String);

impl ActivityType {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Debug,
    Info,
    Success,
    Warning,
    Error,
}

impl Severity {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Success => "success",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Debug => "DBG",
            Self::Info => "info",
            Self::Success => "ok",
            Self::Warning => "warn",
            Self::Error => "ERR",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Importance {
    Critical,
    Important,
    Normal,
    Noisy,
}

impl Importance {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::Important => "important",
            Self::Normal => "normal",
            Self::Noisy => "noisy",
        }
    }

    #[must_use]
    pub const fn visible_by_default(self) -> bool {
        matches!(self, Self::Critical | Self::Important | Self::Normal)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ActivityLink {
    pub label: String,
    pub url: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ActivityRefs {
    pub task_id: Option<String>,
    pub agent: Option<String>,
    pub bg_task_id: Option<String>,
    pub question_id: Option<String>,
    pub pr_number: Option<u32>,
    pub issue_id: Option<String>,
    pub linear_id: Option<String>,
    pub commit: Option<String>,
    pub check_name: Option<String>,
}
