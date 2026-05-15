use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MasterState {
    pub session_id: String,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub terminated: bool,
    pub terminated_at: Option<DateTime<Utc>>,
    pub owner: Option<OwnerBlock>,
    #[serde(default)]
    pub entries: HashMap<String, TrackedEntry>,
    #[serde(default)]
    pub merge_queue: Vec<String>,
    #[serde(default)]
    pub conflict_graph: ConflictGraph,
    pub paused_for_user: Option<PauseInfo>,
    pub master_archive_error: Option<String>,
    pub summary_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OwnerBlock {
    pub harness: Option<String>,
    pub pane_id: Option<String>,
    pub pane_target: Option<String>,
    pub cwd: Option<PathBuf>,
    pub pid: Option<u32>,
    pub pi_session_id: Option<String>,
    pub pi_bridge_socket: Option<String>,
    pub discovery_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TrackedEntry {
    pub id: String,
    pub title: Option<String>,
    pub kind: String,
    pub state: Option<String>,
    pub substate: Option<String>,
    pub harness: Option<String>,
    pub cwd: Option<PathBuf>,
    pub window: Option<String>,
    pub pane_target: Option<String>,
    pub pane_id: Option<String>,
    pub launch: Option<LaunchInfo>,
    pub adapter: Option<AdapterMetadata>,
    pub domain: Option<DomainBlock>,
    pub last_capture_hash: Option<String>,
    pub last_response_at: Option<DateTime<Utc>>,
    pub spawned_at: Option<DateTime<Utc>>,
    pub last_polled_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub decisions_log: Vec<DecisionEntry>,
    pub unknown_since: Option<DateTime<Utc>>,
    pub merge_commit: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct LaunchInfo {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cmd: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct AdapterMetadata {
    pub pi_bridge_pid: Option<u32>,
    pub pi_bridge_socket: Option<String>,
    pub pi_session_id: Option<String>,
    pub oc_url: Option<String>,
    pub oc_session_id: Option<String>,
    pub oc_port: Option<u16>,
    pub cc_url: Option<String>,
    pub cc_session_uuid: Option<String>,
    pub cc_transcript: Option<String>,
    pub cc_port: Option<u16>,
    pub cx_ws: Option<String>,
    pub cx_thread_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct DomainBlock {
    pub issue: Option<TrackedIssueDomain>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TrackedIssueDomain {
    pub id: String,
    pub worktree: Option<PathBuf>,
    pub pr_number: Option<u32>,
    pub scope_files_declared: Option<u32>,
    pub scope_files_actual: Option<u32>,
    pub orchestration_started: Option<bool>,
    pub merge_commit: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DecisionEntry {
    pub ts: DateTime<Utc>,
    pub prompt_tag: String,
    pub answer: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ConflictGraph {
    #[serde(default)]
    pub edges: Vec<Vec<String>>,
    pub computed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PauseInfo {
    pub entry_id: Option<String>,
    pub issue_id: Option<String>,
    pub reason: String,
    pub prompt_text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DashboardSnapshot {
    pub session_id: String,
    pub project_root: PathBuf,
    pub started_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub terminated: bool,
    pub terminated_at: Option<DateTime<Utc>>,
    pub master_state_path: PathBuf,
    pub master_archive_error: Option<String>,
    pub owner: Option<OwnerBlock>,
    pub daemon: DaemonStatus,
    pub counts: KindCounts,
    pub sessions: Vec<TrackedSession>,
    pub merge_queue: Vec<String>,
    pub conflict_graph: ConflictGraph,
    pub paused_for_user: Option<PauseInfo>,
    pub recent_events: VecDeque<Event>,
    pub conversations: Vec<ConversationStream>,
    pub summary_path: Option<PathBuf>,
}

impl DashboardSnapshot {
    #[must_use]
    pub fn from_master_state(state: MasterState, now: DateTime<Utc>) -> Self {
        let mut sessions: Vec<TrackedSession> = state
            .entries
            .into_iter()
            .map(|(key, entry)| TrackedSession::from_entry(key, entry))
            .collect();
        sessions.sort_by(|left, right| left.id.cmp(&right.id));
        let counts = KindCounts::from_sessions(&sessions);
        Self {
            session_id: state.session_id,
            project_root: PathBuf::from("."),
            started_at: state.started_at,
            updated_at: state.updated_at.unwrap_or(now),
            terminated: state.terminated,
            terminated_at: state.terminated_at,
            master_state_path: PathBuf::from("<demo-fixture>"),
            master_archive_error: state.master_archive_error,
            owner: state.owner,
            daemon: DaemonStatus::unknown(),
            counts,
            sessions,
            merge_queue: state.merge_queue,
            conflict_graph: state.conflict_graph,
            paused_for_user: state.paused_for_user,
            recent_events: VecDeque::with_capacity(0),
            conversations: Vec::new(),
            summary_path: state.summary_path,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DaemonStatus {
    pub label: String,
    pub healthy: Option<bool>,
    pub pid: Option<u32>,
    pub last_heartbeat_at: Option<DateTime<Utc>>,
}

impl DaemonStatus {
    #[must_use]
    pub fn unknown() -> Self {
        Self {
            label: String::from("daemon: unknown"),
            healthy: None,
            pid: None,
            last_heartbeat_at: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct KindCounts {
    pub total: usize,
    pub adhoc: usize,
    pub issue: usize,
    pub workflow: usize,
    pub by_state: BTreeMap<String, usize>,
}

impl KindCounts {
    #[must_use]
    pub fn from_sessions(sessions: &[TrackedSession]) -> Self {
        let mut counts = Self::default();
        counts.total = sessions.len();
        for session in sessions {
            match session.kind.as_str() {
                "adhoc" => counts.adhoc += 1,
                "issue" => counts.issue += 1,
                "workflow" => counts.workflow += 1,
                _ => {}
            }
            *counts.by_state.entry(session.state.clone()).or_insert(0) += 1;
        }
        counts
    }
}

#[derive(Debug, Clone)]
pub struct TrackedSession {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub state: String,
    pub substate: Option<String>,
    pub harness: Option<String>,
    pub window: Option<String>,
    pub pane_target: Option<String>,
    pub pane_id: Option<String>,
    pub cwd: Option<PathBuf>,
    pub launch: LaunchInfo,
    pub adapter: AdapterMetadata,
    pub domain: Option<DomainBlock>,
    pub last_response_at: Option<DateTime<Utc>>,
    pub spawned_at: Option<DateTime<Utc>>,
    pub last_polled_at: Option<DateTime<Utc>>,
    pub decisions_log: Vec<DecisionEntry>,
}

impl TrackedSession {
    #[must_use]
    pub fn from_entry(key: String, entry: TrackedEntry) -> Self {
        let id = if entry.id.trim().is_empty() {
            key
        } else {
            entry.id
        };
        let title = entry.title.unwrap_or_else(|| id.clone());
        Self {
            id,
            title,
            kind: entry.kind,
            state: entry.state.unwrap_or_else(|| String::from("waiting")),
            substate: entry.substate,
            harness: entry.harness,
            window: entry.window,
            pane_target: entry.pane_target,
            pane_id: entry.pane_id,
            cwd: entry.cwd,
            launch: entry.launch.unwrap_or_default(),
            adapter: entry.adapter.unwrap_or_default(),
            domain: entry.domain,
            last_response_at: entry.last_response_at,
            spawned_at: entry.spawned_at,
            last_polled_at: entry.last_polled_at,
            decisions_log: entry.decisions_log,
        }
    }

    #[must_use]
    pub fn kind_badge(&self) -> &'static str {
        match self.kind.as_str() {
            "adhoc" => "AH",
            "issue" => "ISS",
            "workflow" => "WF",
            _ => "??",
        }
    }

    #[must_use]
    pub fn is_transient(&self) -> bool {
        matches!(self.state.as_str(), "waiting" | "prompting" | "submitting")
    }

    #[must_use]
    pub fn issue(&self) -> Option<&TrackedIssueDomain> {
        self.domain
            .as_ref()
            .and_then(|domain| domain.issue.as_ref())
    }

    #[must_use]
    pub fn latest_decision(&self) -> Option<&DecisionEntry> {
        self.decisions_log.iter().max_by_key(|entry| entry.ts)
    }
}

#[derive(Debug, Clone)]
pub struct Event {
    pub ts: DateTime<Utc>,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct ConversationStream {
    pub entry_id: String,
    pub excerpt: String,
}
