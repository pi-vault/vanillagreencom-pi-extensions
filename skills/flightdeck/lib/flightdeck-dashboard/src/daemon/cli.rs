use std::path::Path;
use std::time::{Duration, Instant};

use color_eyre::eyre::{eyre, Result};
use serde_json::json;
use tokio::sync::broadcast;

use crate::cli::{DaemonAction, DaemonArgs, DaemonStartArgs, DaemonTailSource, SuperviseArgs};
use crate::daemon::busy::{self, BusyPaths};
use crate::daemon::client::DaemonClient;
use crate::daemon::lifecycle::{
    self, append_log, pid_alive, read_pid, remove_pid, remove_socket, stop_pid, write_pid,
    DaemonLock, RuntimePaths,
};
use crate::daemon::socket;
use crate::daemon::state::{self, DaemonSnapshotSource};
use crate::daemon::subscribers::SubscriberRuntime;
use crate::state::tracked_entries::{self, SessionResolution};
use crate::util::paths::{
    dashboard_socket_file, fd_resolve_state_dir, fd_session_key_from_id, resolve_session_key,
};

const STOP_GRACE: Duration = Duration::from_secs(5);

pub async fn run_daemon(args: DaemonArgs) -> Result<()> {
    match args.action {
        DaemonAction::Start(start) => start_daemon(start).await,
        DaemonAction::Stop(args) => stop_daemon(args.session.as_deref()).await,
        DaemonAction::Status(args) => print_status(args.session.as_deref()).await,
        DaemonAction::Health(args) => print_health(args.session.as_deref()).await,
        DaemonAction::Events(args) => drain_events(args.session.as_deref(), false).await,
        DaemonAction::Ack(args) => drain_events(args.session.as_deref(), true).await,
        DaemonAction::Tail(args) => tail(args.session.as_deref(), args.source).await,
    }
}

pub async fn run_supervise(args: SuperviseArgs) -> Result<()> {
    start_daemon(DaemonStartArgs {
        detach: true,
        session: args.session,
        state_file: None,
    })
    .await
}

async fn start_daemon(args: DaemonStartArgs) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let source = resolve_source(args.session.as_deref(), args.state_file.as_deref())?;
    let session_key = resolve_runtime_session_key(args.session.as_deref(), &source)?;
    let paths = RuntimePaths::new(state_dir, session_key);
    if args.detach {
        let child_args = detached_args(&args);
        lifecycle::spawn_detached(&child_args, &paths.log)?;
        println!(
            "dashboard daemon detach requested session={} socket={}",
            paths.session_key,
            paths.socket.display()
        );
        return Ok(());
    }

    run_foreground(source, paths).await
}

async fn run_foreground(source: DaemonSnapshotSource, paths: RuntimePaths) -> Result<()> {
    let _lock = match DaemonLock::acquire(&paths.state_dir, &paths.session_key) {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error}");
            return Err(error.into());
        }
    };
    write_pid(&paths)?;
    remove_socket(&paths);
    append_log(&paths.log, "dashboard daemon starting");
    let state_runtime = state::start_state_runtime(source, paths.clone()).await?;
    let _subscriber_runtime = if rust_wake_enabled() {
        append_log(&paths.log, "dashboard daemon rust wake side active");
        Some(SubscriberRuntime::spawn(
            paths.clone(),
            state_runtime.shared.clone(),
        ))
    } else {
        append_log(
            &paths.log,
            "dashboard daemon rust wake side inactive gate=FLIGHTDECK_DAEMON_RUST",
        );
        None
    };
    let (shutdown_signal_tx, shutdown_signal_rx) = tokio::sync::oneshot::channel();
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(4);
    let socket_path = paths.socket.clone();
    let socket_task = tokio::spawn(socket::serve(
        socket_path,
        state_runtime.shared.clone(),
        std::time::Instant::now(),
        shutdown_signal_rx,
        shutdown_tx.clone(),
    ));

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            append_log(&paths.log, "dashboard daemon shutdown signal=ctrl_c");
        }
        _ = shutdown_rx.recv() => {
            append_log(&paths.log, "dashboard daemon shutdown method=rpc");
        }
    }
    if shutdown_signal_tx.send(()).is_err() {
        tracing::debug!("daemon socket task already stopped");
    }
    socket_task.await??;
    remove_socket(&paths);
    remove_pid(&paths);
    append_log(&paths.log, "dashboard daemon stopped");
    Ok(())
}

async fn stop_daemon(session: Option<&str>) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    let socket = dashboard_socket_file(&state_dir, &session_key);
    let mut shutdown_sent = false;
    if socket.exists() {
        if let Ok(mut client) = DaemonClient::connect(&socket).await {
            match client.shutdown().await {
                Ok(()) => {
                    shutdown_sent = true;
                    wait_for_path_removed(&socket, STOP_GRACE);
                }
                Err(error) => {
                    tracing::debug!(%error, "daemon rpc shutdown failed; falling back to pid signal");
                }
            }
        }
    }
    if !shutdown_sent {
        if let Some(pid) = read_pid(&state_dir, &session_key) {
            if pid_alive(pid) {
                stop_pid(pid, STOP_GRACE)?;
            }
        }
    }
    let paths = RuntimePaths::new(state_dir, session_key);
    remove_pid(&paths);
    remove_socket(&paths);
    Ok(())
}

async fn print_status(session: Option<&str>) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    let pid = read_pid(&state_dir, &session_key).filter(|pid| pid_alive(*pid));
    let socket = dashboard_socket_file(&state_dir, &session_key);
    let status = json!({
        "session": session_key,
        "running": pid.is_some(),
        "pid": pid,
        "socket": socket.exists().then_some(socket),
        "uptime_secs": null,
    });
    println!("{}", serde_json::to_string(&status)?);
    Ok(())
}

async fn print_health(session: Option<&str>) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    let pid = read_pid(&state_dir, &session_key).filter(|pid| pid_alive(*pid));
    println!(
        "dashboard daemon {} pid={}",
        if pid.is_some() { "running" } else { "stopped" },
        pid.map(|pid| pid.to_string())
            .unwrap_or_else(|| "-".to_owned())
    );
    let log = RuntimePaths::new(state_dir, session_key).log;
    if let Ok(text) = std::fs::read_to_string(log) {
        for line in text
            .lines()
            .rev()
            .take(5)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            println!("{line}");
        }
    }
    Ok(())
}

async fn drain_events(session: Option<&str>, clear_pending: bool) -> Result<()> {
    let state_dir = fd_resolve_state_dir();
    let session_key = resolve_session_key_or_passthrough(session)?;
    let paths = BusyPaths::new(&state_dir, &session_key);
    let body = busy::with_session_lock(&paths, || busy::drain_events(&paths, clear_pending))?;
    print!("{body}");
    Ok(())
}

async fn tail(session: Option<&str>, source: DaemonTailSource) -> Result<()> {
    match source {
        DaemonTailSource::State => {
            let state_dir = fd_resolve_state_dir();
            let session_key = resolve_session_key_or_passthrough(session)?;
            let socket = dashboard_socket_file(&state_dir, &session_key);
            let mut client = DaemonClient::connect(&socket).await?;
            let mut rx = client.subscribe_snapshots().await?;
            while let Some(snapshot) = rx.recv().await {
                println!("{}", serde_json::to_string(&snapshot)?);
            }
        }
        DaemonTailSource::Events | DaemonTailSource::Wake => {
            return Err(eyre!(
                "tail source {:?} is not wired until subscriber absorption",
                source
            ));
        }
    }
    Ok(())
}

fn rust_wake_enabled() -> bool {
    std::env::var("FLIGHTDECK_DAEMON_RUST").is_ok_and(|value| value == "1")
}

fn wait_for_path_removed(path: &Path, grace: Duration) {
    let start = Instant::now();
    while path.exists() && start.elapsed() < grace {
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn resolve_source(
    session: Option<&str>,
    state_file: Option<&Path>,
) -> Result<DaemonSnapshotSource> {
    if let Some(path) = state_file {
        let session = session
            .map(str::to_owned)
            .unwrap_or_else(|| tracked_entries::session_id_from_state_path(path));
        return Ok(DaemonSnapshotSource::File {
            path: path.to_path_buf(),
            session,
        });
    }
    let resolution = tracked_entries::resolve_session_state(session)?;
    Ok(DaemonSnapshotSource::Session(resolution))
}

fn resolve_runtime_session_key(
    session: Option<&str>,
    source: &DaemonSnapshotSource,
) -> Result<String> {
    if let Some(session) = session {
        return Ok(resolve_session_key(session)?);
    }
    match source {
        DaemonSnapshotSource::Session(SessionResolution { session, .. }) => {
            resolve_session_key(session).map_err(Into::into)
        }
        DaemonSnapshotSource::File { session, .. } => Ok(file_session_key(session)),
    }
}

fn resolve_session_key_or_passthrough(session: Option<&str>) -> Result<String> {
    let Some(session) = session else {
        return Err(eyre!("--session required"));
    };
    resolve_session_key(session).map_err(Into::into)
}

fn file_session_key(session: &str) -> String {
    if session.starts_with('s') && session[1..].chars().all(|ch| ch.is_ascii_digit()) {
        session.to_owned()
    } else if session.starts_with('$') {
        fd_session_key_from_id(session)
    } else {
        session.to_owned()
    }
}

fn detached_args(args: &DaemonStartArgs) -> Vec<String> {
    let mut out = vec!["daemon".to_owned(), "start".to_owned()];
    if let Some(session) = &args.session {
        out.push("--session".to_owned());
        out.push(session.clone());
    }
    if let Some(state_file) = &args.state_file {
        out.push("--state-file".to_owned());
        out.push(state_file.display().to_string());
    }
    out
}
