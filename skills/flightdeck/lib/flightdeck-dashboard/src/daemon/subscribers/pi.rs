use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::daemon::wake::{apply_domain_guard, is_canonical_tag, WakeAppender, WakeEvent};

use super::{
    subscriber_pid_file, Subscriber, SubscriberContext, SubscriberError, SubscriberHandle,
};

const BG_TASK_CUSTOM_TYPE: &str = "vstack-background-tasks:event";
const BG_TASK_EXIT_TYPE: &str = "exit";
const SUBAGENT_COMPLETION_CUSTOM_TYPE: &str = "subagent-completion";
const INITIAL_RESTART_BACKOFF: Duration = Duration::from_millis(200);
const MAX_RESTART_BACKOFF: Duration = Duration::from_secs(2);
const TEXT_EXCERPT_BYTES: usize = 1024;

#[derive(Debug)]
pub struct PiSubscriber;

impl Subscriber for PiSubscriber {
    fn spawn(ctx: SubscriberContext) -> Result<SubscriberHandle, SubscriberError> {
        let config = PiConfig::from_context(ctx)?;
        let pid_file = subscriber_pid_file(
            &config.paths.state_dir,
            &config.paths.session_key,
            &config.pane_id,
        );
        let join = tokio::spawn(async move {
            if let Err(error) = std::fs::write(&pid_file, std::process::id().to_string()) {
                tracing::debug!(path = %pid_file.display(), %error, "failed to write pi subscriber pid marker");
            }
            run_with_restart(config).await;
            if let Err(error) = std::fs::remove_file(&pid_file) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::debug!(path = %pid_file.display(), %error, "failed to remove pi subscriber pid marker");
                }
            }
        });
        Ok(SubscriberHandle::new(join))
    }
}

#[derive(Debug, Clone)]
struct PiConfig {
    pane_id: String,
    entry_kind: String,
    bridge_bin: PathBuf,
    target: PiTarget,
    paths: crate::daemon::lifecycle::RuntimePaths,
    wake: WakeAppender,
}

impl PiConfig {
    fn from_context(ctx: SubscriberContext) -> Result<Self, SubscriberError> {
        if ctx
            .config
            .pi_session_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        {
            return Err(SubscriberError::Spawn(
                "missing adapter.pi_session_id".to_owned(),
            ));
        }
        let target = if let Some(socket) = ctx
            .config
            .pi_socket
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            PiTarget::Socket(socket.to_owned())
        } else {
            return Err(SubscriberError::Spawn(
                "missing adapter.pi_bridge_socket".to_owned(),
            ));
        };
        let bridge_bin = resolve_bridge_bin().ok_or_else(|| {
            SubscriberError::Spawn("pi-bridge binary not found (PI_BRIDGE_BIN/PATH)".to_owned())
        })?;
        Ok(Self {
            pane_id: ctx.config.pane_id,
            entry_kind: ctx.config.entry_kind,
            bridge_bin,
            target,
            paths: ctx.paths,
            wake: ctx.wake,
        })
    }
}

#[derive(Debug, Clone)]
enum PiTarget {
    Socket(String),
}

impl PiTarget {
    fn args(&self) -> [&str; 2] {
        match self {
            Self::Socket(socket) => ["--socket", socket.as_str()],
        }
    }
}

#[derive(Debug)]
struct PiStreamState {
    seen_qids: HashSet<String>,
    last_hash: Option<String>,
    compact_seen: bool,
    last_parse_error: Option<String>,
}

impl PiStreamState {
    fn new() -> Self {
        Self {
            seen_qids: HashSet::new(),
            last_hash: None,
            compact_seen: false,
            last_parse_error: None,
        }
    }

    fn set_last_hash(&mut self, hash: String) -> bool {
        if self.last_hash.as_deref() == Some(hash.as_str()) {
            return false;
        }
        self.last_hash = Some(hash);
        true
    }
}

#[derive(Debug)]
enum BridgeEvent {
    Hello(Value),
    Question { request_id: String, payload: Value },
    BgTaskExit { task: Value, hash: String },
    AssistantText { text: String, hash: String },
    EmptyAfterCompact { hash: String, details: Value },
    Ignored,
}

async fn run_with_restart(config: PiConfig) {
    let mut backoff = INITIAL_RESTART_BACKOFF;
    loop {
        let mut state = PiStreamState::new();
        match run_stream_once(&config, &mut state).await {
            Ok(()) => tracing::warn!(pane_id = %config.pane_id, "pi subscriber stream exited"),
            Err(error) => {
                tracing::warn!(pane_id = %config.pane_id, %error, "pi subscriber stream failed")
            }
        }
        tracing::warn!(pane_id = %config.pane_id, delay_ms = backoff.as_millis(), "pi subscriber restarting");
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_RESTART_BACKOFF);
    }
}

async fn run_stream_once(
    config: &PiConfig,
    state: &mut PiStreamState,
) -> Result<(), std::io::Error> {
    let target = config.target.args();
    let mut child = Command::new(&config.bridge_bin)
        .arg("stream")
        .arg(target[0])
        .arg(target[1])
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let Some(stdout) = child.stdout.take() else {
        return Err(std::io::Error::other("pi-bridge stream stdout unavailable"));
    };
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        handle_line(config, state, &line).await;
    }
    let status = child.wait().await?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "pi-bridge stream exited with {status}"
        )));
    }
    Ok(())
}

async fn handle_line(config: &PiConfig, state: &mut PiStreamState, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    let value = match serde_json::from_str::<Value>(line) {
        Ok(value) => {
            state.last_parse_error = None;
            value
        }
        Err(error) => {
            warn_parse_transition(state, format!("{:?}", error.classify()), line);
            return;
        }
    };
    match classify_bridge_event(&value, state) {
        BridgeEvent::Hello(value) => emit_open_questions(config, state, &value).await,
        BridgeEvent::Question {
            request_id,
            payload,
        } => emit_question(config, state, request_id, payload).await,
        BridgeEvent::BgTaskExit { task, hash } => {
            emit_wake(
                config,
                WakeEvent::bg_task_exit(config.pane_id.clone(), task, hash),
            )
            .await;
        }
        BridgeEvent::AssistantText { text, hash } => {
            let raw_tag = classify_text(&text);
            let guarded_tag = apply_domain_guard(&raw_tag, &config.entry_kind);
            if is_canonical_tag(&guarded_tag) {
                emit_wake(
                    config,
                    WakeEvent::assistant_text(
                        config.pane_id.clone(),
                        truncate_excerpt(text),
                        guarded_tag,
                        hash,
                    ),
                )
                .await;
            }
        }
        BridgeEvent::EmptyAfterCompact { hash, details } => {
            emit_wake(
                config,
                WakeEvent::empty_after_compact(config.pane_id.clone(), hash, details),
            )
            .await;
        }
        BridgeEvent::Ignored => {}
    }
}

fn classify_bridge_event(value: &Value, state: &mut PiStreamState) -> BridgeEvent {
    if value.get("type").and_then(Value::as_str) == Some("bridge_hello") {
        return BridgeEvent::Hello(value.clone());
    }
    if !is_event(value) {
        return BridgeEvent::Ignored;
    }
    match value
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "session_compact" => {
            state.compact_seen = true;
            BridgeEvent::Ignored
        }
        "agent_end" if state.compact_seen && agent_end_content_empty(value) => {
            state.compact_seen = false;
            let hash = sha12("compact-then-empty");
            let details = json!({
                "event_type": "empty-after-compact",
                "reason": "compact-then-empty",
                "source": "pi-bridge-stream"
            });
            BridgeEvent::EmptyAfterCompact { hash, details }
        }
        "question" if question_opened(value) => question_event(value),
        "message_end" => message_end_event(value, state),
        _ => BridgeEvent::Ignored,
    }
}

fn message_end_event(value: &Value, state: &mut PiStreamState) -> BridgeEvent {
    let message = value.pointer("/data/message").unwrap_or(&Value::Null);
    let custom_type = message
        .get("customType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if custom_type == BG_TASK_CUSTOM_TYPE
        && message
            .pointer("/details/eventType")
            .and_then(Value::as_str)
            == Some(BG_TASK_EXIT_TYPE)
    {
        let details = message.get("details").cloned().unwrap_or_else(|| json!({}));
        let task = details.get("task").cloned().unwrap_or_else(|| json!({}));
        let task_id = task.get("id").and_then(Value::as_str).unwrap_or_default();
        let status = task
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let exit_code = task
            .get("exitCode")
            .map(Value::to_string)
            .unwrap_or_else(|| "null".to_owned());
        let hash = sha12(&format!("{task_id}|{status}|{exit_code}"));
        if !state.set_last_hash(hash.clone()) {
            return BridgeEvent::Ignored;
        }
        return BridgeEvent::BgTaskExit { task, hash };
    }
    if custom_type == SUBAGENT_COMPLETION_CUSTOM_TYPE {
        return BridgeEvent::Ignored;
    }
    if message.get("role").and_then(Value::as_str) == Some("assistant")
        && !message
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
    {
        let Some(text) = message_text(message) else {
            return BridgeEvent::Ignored;
        };
        let hash = sha12(&text);
        if !state.set_last_hash(hash.clone()) {
            return BridgeEvent::Ignored;
        }
        return BridgeEvent::AssistantText { text, hash };
    }
    BridgeEvent::Ignored
}

async fn emit_open_questions(config: &PiConfig, state: &mut PiStreamState, value: &Value) {
    let Some(questions) = value
        .pointer("/data/questions")
        .or_else(|| value.pointer("/questions"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for question in questions {
        let request_id = question
            .get("requestId")
            .or_else(|| question.pointer("/request/id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if request_id.is_empty() || !state.seen_qids.insert(request_id.to_owned()) {
            continue;
        }
        let payload = question
            .get("request")
            .cloned()
            .unwrap_or_else(|| question.clone());
        let hash = sha12(request_id);
        emit_wake(
            config,
            WakeEvent::pi_question(config.pane_id.clone(), request_id.to_owned(), payload, hash),
        )
        .await;
    }
}

async fn emit_question(
    config: &PiConfig,
    state: &mut PiStreamState,
    request_id: String,
    payload: Value,
) {
    if !state.seen_qids.insert(request_id.clone()) {
        return;
    }
    let hash = sha12(&request_id);
    emit_wake(
        config,
        WakeEvent::pi_question(config.pane_id.clone(), request_id, payload, hash),
    )
    .await;
}

async fn emit_wake(config: &PiConfig, event: WakeEvent) {
    let tag = event.classifier_tag.clone();
    match config.wake.append_event(event) {
        Ok(true) => {
            tracing::info!(pane_id = %config.pane_id, classifier_tag = %tag, "pi wake event appended")
        }
        Ok(false) => {
            tracing::debug!(pane_id = %config.pane_id, classifier_tag = %tag, "pi wake event deduped")
        }
        Err(error) => {
            tracing::warn!(pane_id = %config.pane_id, classifier_tag = %tag, %error, "pi wake event append failed")
        }
    }
}

fn question_event(value: &Value) -> BridgeEvent {
    let request_id = value
        .pointer("/data/requestId")
        .or_else(|| value.pointer("/data/request/id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if request_id.is_empty() {
        return BridgeEvent::Ignored;
    }
    let payload = value
        .pointer("/data/request")
        .cloned()
        .unwrap_or_else(|| value.get("data").cloned().unwrap_or(Value::Null));
    BridgeEvent::Question {
        request_id: request_id.to_owned(),
        payload,
    }
}

fn is_event(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("event")
}

fn question_opened(value: &Value) -> bool {
    value.pointer("/data/action").and_then(Value::as_str) == Some("opened")
}

fn agent_end_content_empty(value: &Value) -> bool {
    let content = value
        .pointer("/data/content")
        .or_else(|| value.pointer("/data/message/content"));
    matches!(content, Some(Value::Array(items)) if items.is_empty())
}

fn message_text(message: &Value) -> Option<String> {
    match message.get("content")? {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn classify_text(text: &str) -> String {
    if let Some(classifier) = std::env::var_os("FD_CLASSIFIER")
        .or_else(|| std::env::var_os("FLIGHTDECK_CLASSIFIER"))
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        if let Ok(output) = std::process::Command::new(classifier)
            .arg("--no-footer-gate")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                if let Some(mut stdin) = child.stdin.take() {
                    use std::io::Write as _;
                    stdin.write_all(text.as_bytes())?;
                }
                child.wait_with_output()
            })
        {
            if output.status.success() {
                let tag = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !tag.is_empty() {
                    return tag;
                }
            }
        }
    }
    fallback_classify_text(text)
}

fn fallback_classify_text(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if lower.contains("terminal-state") || lower.contains("please end the session") {
        return "terminal-state-reached".to_owned();
    }
    if lower.contains("force push")
        || lower.contains("force-push")
        || lower.contains("--force-with-lease")
    {
        return "force-push-prompt".to_owned();
    }
    if lower.contains("merge now")
        || lower.contains("merge-ready")
        || lower.contains("ready to merge")
    {
        return "merge-now".to_owned();
    }
    if lower.contains("cleanup")
        || lower.contains("delete worktree")
        || lower.contains("keep worktree")
    {
        return "cleanup-prompt".to_owned();
    }
    if lower.contains("rebase") && lower.contains("conflict") {
        return "rebase-multi-choice".to_owned();
    }
    if text.contains("[1]") && text.contains("[2]") {
        return "generic-multi-choice".to_owned();
    }
    if (lower.contains("allow") && lower.contains('?'))
        || lower.contains("permission to run")
        || lower.contains("approve this command")
    {
        return "bash-permission-prompt".to_owned();
    }
    "rendering".to_owned()
}

fn truncate_excerpt(text: String) -> String {
    if text.len() <= TEXT_EXCERPT_BYTES {
        return text;
    }
    let mut end = TEXT_EXCERPT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn sha12(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    format!("{:02x}", digest[0])
        + &digest[1..]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()[..10]
}

fn warn_parse_transition(state: &mut PiStreamState, kind: String, line: &str) {
    if state.last_parse_error.as_deref() == Some(kind.as_str()) {
        return;
    }
    state.last_parse_error = Some(kind.clone());
    let excerpt = line.chars().take(160).collect::<String>();
    tracing::warn!(error_kind = %kind, excerpt = %excerpt, "malformed pi-bridge stream line");
}

fn resolve_bridge_bin() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PI_BRIDGE_BIN").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }
    let output = std::process::Command::new("bash")
        .args(["-lc", "command -v pi-bridge"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!path.is_empty()).then(|| PathBuf::from(path))
}
