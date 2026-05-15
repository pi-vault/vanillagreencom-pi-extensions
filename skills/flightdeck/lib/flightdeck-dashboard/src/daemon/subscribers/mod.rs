pub mod claude;
pub mod codex;
pub mod opencode;
pub mod pi;
pub mod tmux_fallback;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use thiserror::Error;
use tokio::sync::broadcast;

use crate::daemon::state::SharedState;
use crate::daemon::wake::WakeAppender;
use crate::state::snapshot::{DashboardSnapshot, TrackedSession};

use super::lifecycle::RuntimePaths;

#[derive(Debug, Error)]
pub enum SubscriberError {
    #[error("subscriber spawn failed: {0}")]
    Spawn(String),
}

pub trait Subscriber {
    fn spawn(ctx: SubscriberContext) -> Result<SubscriberHandle, SubscriberError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubscriberConfig {
    pub pane_id: String,
    pub harness: String,
    pub entry_kind: String,
    pub pi_pid: Option<u32>,
    pub pi_session_id: Option<String>,
    pub pi_socket: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SubscriberContext {
    pub config: SubscriberConfig,
    pub paths: RuntimePaths,
    pub wake: WakeAppender,
}

#[derive(Debug)]
pub struct SubscriberHandle {
    join: tokio::task::JoinHandle<()>,
}

impl SubscriberHandle {
    #[must_use]
    pub fn new(join: tokio::task::JoinHandle<()>) -> Self {
        Self { join }
    }

    #[must_use]
    pub fn completed(_label: &'static str) -> Self {
        Self::new(tokio::spawn(async {}))
    }

    pub fn abort(&self) {
        self.join.abort();
    }

    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.join.is_finished()
    }
}

impl Drop for SubscriberHandle {
    fn drop(&mut self) {
        self.join.abort();
    }
}

#[derive(Debug)]
pub struct SubscriberRuntime {
    join: tokio::task::JoinHandle<()>,
}

impl SubscriberRuntime {
    #[must_use]
    pub fn spawn(paths: RuntimePaths, shared: Arc<SharedState>) -> Self {
        let join = tokio::spawn(async move {
            let wake = WakeAppender::new(&paths.state_dir, &paths.session_key);
            let mut rx = shared.snapshots.subscribe();
            let mut active = ActiveSubscribers::default();
            let snapshot = shared.snapshot.read().await.clone();
            active.reconcile(snapshot, &paths, &wake);
            loop {
                match rx.recv().await {
                    Ok(snapshot) => active.reconcile(snapshot, &paths, &wake),
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let snapshot = shared.snapshot.read().await.clone();
                        active.reconcile(snapshot, &paths, &wake);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        Self { join }
    }
}

impl Drop for SubscriberRuntime {
    fn drop(&mut self) {
        self.join.abort();
    }
}

#[derive(Default)]
struct ActiveSubscribers {
    handles: HashMap<String, ActiveSubscriber>,
    warned_non_pi: HashSet<String>,
    warned_skips: HashSet<String>,
}

struct ActiveSubscriber {
    signature: SubscriberConfig,
    handle: SubscriberHandle,
}

impl ActiveSubscribers {
    fn reconcile(
        &mut self,
        snapshot: DashboardSnapshot,
        paths: &RuntimePaths,
        wake: &WakeAppender,
    ) {
        let desired = desired_subscribers(&snapshot);
        let desired_keys = desired
            .iter()
            .map(|config| config.pane_id.clone())
            .collect::<HashSet<_>>();
        self.handles.retain(|pane_id, active| {
            if desired_keys.contains(pane_id) {
                true
            } else {
                active.handle.abort();
                false
            }
        });

        for config in desired {
            if let Some(active) = self.handles.get(&config.pane_id) {
                if active.signature == config && !active.handle.is_finished() {
                    continue;
                }
                active.handle.abort();
            }
            match spawn_for_config(
                config.clone(),
                paths,
                wake,
                &mut self.warned_non_pi,
                &mut self.warned_skips,
            ) {
                Some(handle) => {
                    self.handles.insert(
                        config.pane_id.clone(),
                        ActiveSubscriber {
                            signature: config,
                            handle,
                        },
                    );
                }
                None => {
                    self.handles.remove(&config.pane_id);
                }
            }
        }
    }
}

fn desired_subscribers(snapshot: &DashboardSnapshot) -> Vec<SubscriberConfig> {
    snapshot
        .sessions
        .iter()
        .filter_map(config_from_session)
        .collect()
}

fn config_from_session(session: &TrackedSession) -> Option<SubscriberConfig> {
    let pane_id = session.pane_id.clone()?;
    let harness = session
        .harness
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if harness.is_empty() {
        return None;
    }
    Some(SubscriberConfig {
        pane_id,
        harness,
        entry_kind: session.kind.as_str().to_owned(),
        pi_pid: session.adapter.pi_bridge_pid,
        pi_session_id: session.adapter.pi_session_id.clone(),
        pi_socket: session.adapter.pi_bridge_socket.clone(),
    })
}

fn spawn_for_config(
    config: SubscriberConfig,
    paths: &RuntimePaths,
    wake: &WakeAppender,
    warned_non_pi: &mut HashSet<String>,
    warned_skips: &mut HashSet<String>,
) -> Option<SubscriberHandle> {
    let context = SubscriberContext {
        config: config.clone(),
        paths: paths.clone(),
        wake: wake.clone(),
    };
    match config.harness.as_str() {
        "pi" => match pi::PiSubscriber::spawn(context) {
            Ok(handle) => Some(handle),
            Err(error) => {
                let key = format!("{}:{error}", config.pane_id);
                if warned_skips.insert(key) {
                    tracing::warn!(pane_id = %config.pane_id, %error, "pi subscriber skipped");
                }
                None
            }
        },
        "claude" | "claude-code" => warn_stub("claude", config, warned_non_pi),
        "opencode" => warn_stub("opencode", config, warned_non_pi),
        "codex" => warn_stub("codex", config, warned_non_pi),
        "tmux" | "shell" | "tmux-fallback" => warn_stub("tmux_fallback", config, warned_non_pi),
        other => {
            let key = format!("{}:{other}", config.pane_id);
            if warned_non_pi.insert(key) {
                tracing::warn!(pane_id = %config.pane_id, harness = other, "subscriber harness not implemented");
            }
            None
        }
    }
}

fn warn_stub(
    label: &'static str,
    config: SubscriberConfig,
    warned_non_pi: &mut HashSet<String>,
) -> Option<SubscriberHandle> {
    let key = format!("{}:{label}", config.pane_id);
    if warned_non_pi.insert(key) {
        tracing::warn!(pane_id = %config.pane_id, harness = %config.harness, "subscriber harness stubbed");
    }
    let handle = match label {
        "claude" => claude::not_yet_implemented(),
        "opencode" => opencode::not_yet_implemented(),
        "codex" => codex::not_yet_implemented(),
        _ => tmux_fallback::not_yet_implemented(),
    };
    Some(handle)
}

#[must_use]
pub fn subscriber_pid_file(
    state_dir: &std::path::Path,
    session_key: &str,
    pane_id: &str,
) -> PathBuf {
    let pane_id = pane_id.trim_start_matches('%');
    state_dir.join(format!("fd-pi-subscriber-{session_key}-{pane_id}.pid"))
}
