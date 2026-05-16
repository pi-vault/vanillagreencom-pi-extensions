//! Legacy daemon event sources retained for daemon diagnostics.
//!
//! The user-facing Activity tab reads structured `flightdeck-activity-<session>.jsonl`
//! sidecars through `crate::activity`; these sources continue to feed daemon
//! health panels and compatibility tests.

use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

use crate::state::snapshot::{ActivitySource, Event, EventImportance};
use crate::util::paths::{
    self, fd_events_file, fd_log_file, fd_wake_events_log, resolve_session_key, PathsError,
};

const TAIL_POLL_MS: u64 = 250;
const TAIL_MAX_BYTES: usize = 256 * 1024;
const TAIL_MAX_RECORD: usize = 1024 * 1024;

pub trait EventSource: Send + 'static {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event>;
}

#[derive(Debug, Clone)]
pub struct JsonlEventSource {
    path: PathBuf,
    default_source: ActivitySource,
}

impl JsonlEventSource {
    #[must_use]
    pub fn new(path: PathBuf, default_source: ActivitySource) -> Self {
        Self {
            path,
            default_source,
        }
    }
}

impl EventSource for JsonlEventSource {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        let default_source = self.default_source;
        subscribe_tail(self.path.clone(), move |text, warn| {
            parse_jsonl_str(text, default_source, warn)
        })
    }
}

#[derive(Debug, Clone)]
pub struct DaemonTextLogSource {
    path: PathBuf,
}

impl DaemonTextLogSource {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl EventSource for DaemonTextLogSource {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        subscribe_tail(self.path.clone(), parse_daemon_text_log_str)
    }
}

pub struct CompositeSource {
    sources: Vec<Box<dyn EventSource>>,
}

impl CompositeSource {
    #[must_use]
    pub fn new(sources: Vec<Box<dyn EventSource>>) -> Self {
        Self { sources }
    }
}

impl EventSource for CompositeSource {
    fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded_channel();
        for source in &self.sources {
            let mut source_rx = source.subscribe();
            let tx = tx.clone();
            tokio::spawn(async move {
                while let Some(event) = source_rx.recv().await {
                    if tx.send(event).is_err() {
                        break;
                    }
                }
            });
        }
        rx
    }
}

/// Build the default Phase 3 activity sources for a session.
///
/// File names intentionally mirror `skills/flightdeck/lib/flightdeck-core/src/paths/daemon.ts`:
/// `fd-daemon-<sN>.log`, `fd-wake-events-<sN>.log`, and
/// `fd-daemon-events-<sN>.jsonl`.
pub fn default_sources(session_input: &str) -> Result<CompositeSource, PathsError> {
    let state_dir = paths::fd_resolve_state_dir();
    default_sources_in(&state_dir, session_input)
}

pub fn default_sources_in(
    state_dir: &Path,
    session_input: &str,
) -> Result<CompositeSource, PathsError> {
    let session_key = resolve_session_key(session_input)?;
    Ok(CompositeSource::new(vec![
        Box::new(JsonlEventSource::new(
            fd_wake_events_log(state_dir, &session_key),
            ActivitySource::Wake,
        )),
        Box::new(DaemonTextLogSource::new(fd_log_file(
            state_dir,
            &session_key,
        ))),
        Box::new(JsonlEventSource::new(
            fd_events_file(state_dir, &session_key),
            ActivitySource::Daemon,
        )),
    ]))
}

#[must_use]
pub fn daemon_state_dir() -> PathBuf {
    paths::fd_resolve_state_dir()
}

pub fn parse_jsonl_str(
    text: &str,
    default_source: ActivitySource,
    warn: &mut dyn FnMut(&str),
) -> Vec<Event> {
    text.lines()
        .enumerate()
        .filter_map(|(idx, line)| {
            parse_jsonl_line(line, default_source).unwrap_or_else(|error| {
                let message = format!(
                    "Warning: invalid activity JSONL line {}: {error}; skipping.",
                    idx + 1
                );
                tracing::warn!(message = %message, "activity parse warning");
                warn(&message);
                None
            })
        })
        .collect()
}

pub fn parse_daemon_text_log_str(text: &str, warn: &mut dyn FnMut(&str)) -> Vec<Event> {
    let mut warned = false;
    text.lines()
        .enumerate()
        .filter_map(|(idx, line)| match parse_daemon_text_line(line) {
            Ok(event) => event,
            Err(error) => {
                if !warned {
                    let message = format!(
                        "Warning: invalid daemon log line {}: {error}; skipping.",
                        idx + 1
                    );
                    tracing::warn!(message = %message, "daemon log parse warning");
                    warn(&message);
                    warned = true;
                }
                None
            }
        })
        .collect()
}

fn subscribe_tail<F>(path: PathBuf, mut parser: F) -> mpsc::UnboundedReceiver<Event>
where
    F: FnMut(&str, &mut dyn FnMut(&str)) -> Vec<Event> + Send + 'static,
{
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut cursor = TailCursor::default();
        let mut last_error_kind = None;
        let mut tick = tokio::time::interval(Duration::from_millis(TAIL_POLL_MS));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            match read_tail_chunk(&path, &mut cursor).await {
                Ok(bytes) => {
                    last_error_kind = None;
                    for event in cursor.push_chunk(&path, &bytes) {
                        if tx.send(event).is_err() {
                            return;
                        }
                    }
                    let records = cursor.take_complete_records();
                    if records.is_empty() {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&records);
                    for event in parser(&text, &mut |_| {}) {
                        if tx.send(event).is_err() {
                            return;
                        }
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    cursor.reset();
                    last_error_kind = None;
                }
                Err(error) => {
                    cursor.reset();
                    if let Some(event) = tail_read_error_event(&path, &error, &mut last_error_kind)
                    {
                        if tx.send(event).is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });
    rx
}

#[derive(Debug, Default)]
struct TailCursor {
    offset: u64,
    identity: Option<FileIdentity>,
    rotation_warned: bool,
    pending: Vec<u8>,
    complete: Vec<u8>,
    discarding_oversize_record: bool,
}

impl TailCursor {
    fn reset(&mut self) {
        self.offset = 0;
        self.identity = None;
        self.rotation_warned = false;
        self.pending.clear();
        self.complete.clear();
        self.discarding_oversize_record = false;
    }

    fn push_chunk(&mut self, path: &Path, bytes: &[u8]) -> Vec<Event> {
        self.complete.clear();
        if bytes.is_empty() {
            return Vec::new();
        }
        let mut errors = Vec::new();
        let start = self.consume_oversize_prefix(bytes);
        self.pending.extend_from_slice(&bytes[start..]);
        if let Some(newline) = self.pending.iter().rposition(|byte| *byte == b'\n') {
            self.complete.extend_from_slice(&self.pending[..=newline]);
            let remainder = self.pending[newline + 1..].to_vec();
            self.pending = remainder;
        }
        if self.pending.len() > TAIL_MAX_RECORD {
            self.pending.clear();
            self.discarding_oversize_record = true;
            errors.push(tail_record_too_large_event(path));
        }
        errors
    }

    fn consume_oversize_prefix(&mut self, bytes: &[u8]) -> usize {
        if !self.discarding_oversize_record {
            return 0;
        }
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(newline) => {
                self.discarding_oversize_record = false;
                newline + 1
            }
            None => bytes.len(),
        }
    }

    fn take_complete_records(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.complete)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    len: u64,
}

impl FileIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
            len: metadata.len(),
        }
    }

    const fn rotated_from(self, previous: Self, offset: u64) -> bool {
        self.dev != previous.dev || self.ino != previous.ino || self.len < offset
    }
}

async fn read_tail_chunk(path: &Path, cursor: &mut TailCursor) -> Result<Vec<u8>, io::Error> {
    let metadata = tokio::fs::metadata(path).await?;
    let identity = FileIdentity::from_metadata(&metadata);
    if cursor
        .identity
        .is_some_and(|previous| identity.rotated_from(previous, cursor.offset))
    {
        cursor.offset = 0;
        if !cursor.rotation_warned {
            cursor.rotation_warned = true;
            tracing::warn!(path = %path.display(), "activity source rotation detected; tail offset reset");
        }
    }
    cursor.identity = Some(identity);

    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(cursor.offset)).await?;
    let mut bytes = vec![0_u8; TAIL_MAX_BYTES];
    let read = file.read(&mut bytes).await?;
    bytes.truncate(read);
    cursor.offset = cursor.offset.saturating_add(read as u64);
    Ok(bytes)
}

fn tail_record_too_large_event(path: &Path) -> Event {
    tracing::warn!(path = %path.display(), max_bytes = TAIL_MAX_RECORD, "activity source record too large; truncating");
    Event::new(
        Utc::now(),
        ActivitySource::Error,
        EventImportance::Important,
        format!(
            "activity source record too large; truncating: {} (max {} bytes)",
            path.display(),
            TAIL_MAX_RECORD
        ),
    )
}

pub fn tail_read_error_event(
    path: &Path,
    error: &io::Error,
    last_error_kind: &mut Option<io::ErrorKind>,
) -> Option<Event> {
    let kind = error.kind();
    if *last_error_kind == Some(kind) {
        return None;
    }
    *last_error_kind = Some(kind);
    tracing::warn!(path = %path.display(), error = %error, "activity source read failed");
    Some(Event::new(
        Utc::now(),
        ActivitySource::Error,
        EventImportance::Important,
        format!("activity source read failed: {} ({error})", path.display()),
    ))
}

fn parse_jsonl_line(line: &str, default_source: ActivitySource) -> Result<Option<Event>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value = serde_json::from_str::<Value>(trimmed).map_err(|error| error.to_string())?;
    let Value::Object(object) = value else {
        return Err("event root is not an object".to_owned());
    };
    let ts = object
        .get("ts")
        .or_else(|| object.get("timestamp"))
        .and_then(Value::as_str)
        .and_then(parse_ts)
        .unwrap_or_else(Utc::now);
    let source = object
        .get("source")
        .or_else(|| object.get("kind"))
        .and_then(Value::as_str)
        .and_then(parse_source)
        .unwrap_or(default_source);
    let importance = object
        .get("importance")
        .or_else(|| object.get("level"))
        .and_then(Value::as_str)
        .map(parse_importance)
        .unwrap_or_else(|| default_importance(source));
    let message = object
        .get("message")
        .or_else(|| object.get("msg"))
        .or_else(|| object.get("text"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            object
                .get("tag")
                .and_then(Value::as_str)
                .map(|tag| format!("tag={tag}"))
        })
        .unwrap_or_else(|| compact_json(&Value::Object(object.clone())));
    Ok(Some(Event::new(ts, source, importance, message)))
}

fn parse_daemon_text_line(line: &str) -> Result<Option<Event>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let (ts_raw, rest) = trimmed
        .split_once(char::is_whitespace)
        .ok_or_else(|| "missing timestamp separator".to_owned())?;
    let ts = parse_ts(ts_raw).ok_or_else(|| "invalid timestamp".to_owned())?;
    let rest = rest.trim_start();
    let tag_start = rest.find('[').ok_or_else(|| "missing [tag]".to_owned())?;
    let tag_end = rest[tag_start + 1..]
        .find(']')
        .map(|idx| tag_start + 1 + idx)
        .ok_or_else(|| "missing closing ]".to_owned())?;
    let tag = &rest[tag_start + 1..tag_end];
    let body = rest[tag_end + 1..].trim();
    let message = if tag.is_empty() {
        body.to_owned()
    } else {
        format!("[{tag}] {body}")
    };
    Ok(Some(Event::new(
        ts,
        ActivitySource::Daemon,
        daemon_text_importance(tag, body),
        message,
    )))
}

fn parse_ts(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

fn parse_source(value: &str) -> Option<ActivitySource> {
    match value.to_ascii_lowercase().as_str() {
        "daemon" => Some(ActivitySource::Daemon),
        "wake" | "wakeup" => Some(ActivitySource::Wake),
        "prompt" => Some(ActivitySource::Prompt),
        "state" => Some(ActivitySource::State),
        "decision" => Some(ActivitySource::Decision),
        "err" | "error" => Some(ActivitySource::Error),
        _ => None,
    }
}

fn parse_importance(value: &str) -> EventImportance {
    match value.to_ascii_lowercase().as_str() {
        "important" | "high" | "error" | "err" => EventImportance::Important,
        "medium" | "warn" | "warning" => EventImportance::Medium,
        _ => EventImportance::Low,
    }
}

fn daemon_text_importance(tag: &str, body: &str) -> EventImportance {
    let tag = tag.to_ascii_lowercase();
    let body = body.to_ascii_lowercase();
    if tag.contains("heartbeat") || body.contains("heartbeat") {
        EventImportance::Low
    } else if tag.contains("error")
        || tag.contains("err")
        || body.contains(" error")
        || body.contains("failed")
    {
        EventImportance::Important
    } else if tag.contains("warn")
        || tag.contains("wake")
        || body.contains("warn")
        || body.contains("wake")
    {
        EventImportance::Medium
    } else {
        EventImportance::Low
    }
}

const fn default_importance(source: ActivitySource) -> EventImportance {
    match source {
        ActivitySource::Error | ActivitySource::Prompt | ActivitySource::Decision => {
            EventImportance::Important
        }
        ActivitySource::Wake | ActivitySource::State => EventImportance::Medium,
        ActivitySource::Daemon => EventImportance::Low,
    }
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "activity event".to_owned())
}
