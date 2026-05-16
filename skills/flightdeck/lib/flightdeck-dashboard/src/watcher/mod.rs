use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::thread;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use notify_debouncer_full::{new_debouncer, DebouncedEvent};
use thiserror::Error;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherEvent {
    Reload,
}

#[derive(Debug, Error)]
pub enum WatcherError {
    #[error("state path {0} has no parent directory")]
    MissingParent(PathBuf),
    #[error("watcher failed to initialize: {0}")]
    Init(String),
    #[error("watcher thread did not report initialization: {0}")]
    InitChannel(String),
}

#[derive(Debug)]
pub struct StateWatcher {
    stop_tx: Option<std_mpsc::Sender<()>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl StateWatcher {
    /// Watches the live state file and archive directory.
    ///
    /// Atomic writes replace the live file inode, so this watches the live
    /// file's parent directory and filters debounced path events down to the
    /// exact state file or sibling `*.json.archive` files.
    pub fn spawn(
        live_path: PathBuf,
        archive_dir: PathBuf,
        tx: mpsc::UnboundedSender<WatcherEvent>,
        debounce: Duration,
    ) -> Result<Self, WatcherError> {
        let watch_dir = live_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| WatcherError::MissingParent(live_path.clone()))?;
        let (stop_tx, stop_rx) = std_mpsc::channel();
        let (init_tx, init_rx) = std_mpsc::channel();
        let handle = thread::Builder::new()
            .name("flightdeck-state-watcher".to_owned())
            .spawn(move || {
                run_thread(
                    live_path,
                    archive_dir,
                    watch_dir,
                    tx,
                    debounce,
                    stop_rx,
                    init_tx,
                )
            })
            .map_err(|error| WatcherError::Init(error.to_string()))?;

        match init_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => Ok(Self {
                stop_tx: Some(stop_tx),
                handle: Some(handle),
            }),
            Ok(Err(error)) => {
                request_stop(&stop_tx);
                join_watcher_thread(handle);
                Err(WatcherError::Init(error))
            }
            Err(error) => {
                request_stop(&stop_tx);
                join_watcher_thread(handle);
                Err(WatcherError::InitChannel(error.to_string()))
            }
        }
    }
}

impl Drop for StateWatcher {
    fn drop(&mut self) {
        if let Some(stop_tx) = self.stop_tx.take() {
            request_stop(&stop_tx);
        }
        if let Some(handle) = self.handle.take() {
            join_watcher_thread(handle);
        }
    }
}

fn request_stop(stop_tx: &std_mpsc::Sender<()>) {
    if stop_tx.send(()).is_err() {
        tracing::debug!("state watcher stop receiver already closed");
    }
}

fn join_watcher_thread(handle: thread::JoinHandle<()>) {
    if handle.join().is_err() {
        tracing::warn!("state watcher thread panicked during shutdown");
    }
}

fn send_init_result(init_tx: &std_mpsc::Sender<Result<(), String>>, result: Result<(), String>) {
    if init_tx.send(result).is_err() {
        tracing::debug!("state watcher init receiver already closed");
    }
}

fn run_thread(
    live_path: PathBuf,
    archive_dir: PathBuf,
    watch_dir: PathBuf,
    tx: mpsc::UnboundedSender<WatcherEvent>,
    debounce: Duration,
    stop_rx: std_mpsc::Receiver<()>,
    init_tx: std_mpsc::Sender<Result<(), String>>,
) {
    let (event_tx, event_rx) = std_mpsc::channel();
    let mut debouncer = match new_debouncer(debounce, None, event_tx) {
        Ok(debouncer) => debouncer,
        Err(error) => {
            send_init_result(&init_tx, Err(error.to_string()));
            return;
        }
    };

    if let Err(error) = debouncer
        .watcher()
        .watch(&watch_dir, RecursiveMode::NonRecursive)
    {
        send_init_result(&init_tx, Err(error.to_string()));
        return;
    }
    if archive_dir != watch_dir {
        if let Err(error) = debouncer
            .watcher()
            .watch(&archive_dir, RecursiveMode::NonRecursive)
        {
            send_init_result(&init_tx, Err(error.to_string()));
            return;
        }
    }
    send_init_result(&init_tx, Ok(()));

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match event_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(events)) => {
                if events
                    .iter()
                    .any(|event| event_matches(event, &live_path, &archive_dir))
                    && tx.send(WatcherEvent::Reload).is_err()
                {
                    break;
                }
            }
            Ok(Err(errors)) => {
                for error in errors {
                    tracing::warn!(%error, "state watcher event error");
                }
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn event_matches(event: &DebouncedEvent, live_path: &Path, archive_dir: &Path) -> bool {
    event.event.paths.iter().any(|path| {
        path == live_path
            || is_archive_path(path, archive_dir)
            || is_activity_path(path, live_path, archive_dir)
    })
}

fn is_activity_path(path: &Path, live_path: &Path, archive_dir: &Path) -> bool {
    let Some(session) = state_session_name(live_path) else {
        return false;
    };
    let live_name = format!("flightdeck-activity-{session}.jsonl");
    let archive_prefix = format!("flightdeck-activity-{session}-");
    path.starts_with(archive_dir)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name == live_name
                    || (name.starts_with(&archive_prefix) && name.ends_with(".jsonl.archive"))
            })
}

fn state_session_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    name.strip_prefix("flightdeck-state-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .map(str::to_owned)
}

fn is_archive_path(path: &Path, archive_dir: &Path) -> bool {
    path.starts_with(archive_dir)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".json.archive"))
}
