use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration as StdDuration;

use flightdeck_dashboard::daemon::client::DaemonClient;
use flightdeck_dashboard::daemon::rpc::FRAME_TOO_LARGE;
use flightdeck_dashboard::state::snapshot::DashboardSnapshot;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout, Duration, Instant};

const SESSION: &str = "s404";

#[tokio::test]
async fn daemon_status_lifecycle_and_double_start() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s404.json");
    write_state(&state_file, "initial", "2026-05-15T00:00:00Z")?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon(bin, temp.path(), SESSION, &state_file).await?;

    let status = daemon_command(bin, temp.path(), ["daemon", "status", "--session", SESSION])?;
    assert!(status.status.success(), "status command failed");
    let json: Value = serde_json::from_slice(&status.stdout)?;
    assert_eq!(json["running"], true);
    assert!(json["pid"].as_u64().is_some());
    assert!(json["socket"].as_str().is_some());

    let double_start = daemon_command(
        bin,
        temp.path(),
        [
            "daemon",
            "start",
            "--session",
            SESSION,
            "--state-file",
            state_file.to_str().ok_or("state path must be utf-8")?,
        ],
    )?;
    assert!(!double_start.status.success(), "double-start should fail");

    let stop = daemon_command(bin, temp.path(), ["daemon", "stop", "--session", SESSION])?;
    assert!(stop.status.success(), "stop command failed");
    daemon.wait_for_exit();

    let stopped = daemon_command(bin, temp.path(), ["daemon", "status", "--session", SESSION])?;
    assert!(stopped.status.success(), "status after stop failed");
    let json: Value = serde_json::from_slice(&stopped.stdout)?;
    assert_eq!(json["running"], false);
    assert!(json["pid"].is_null());
    assert!(json["socket"].is_null());

    Ok(())
}

#[tokio::test]
async fn daemon_rejects_oversized_frame_without_unbounded_read() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s404.json");
    write_state(&state_file, "initial", "2026-05-15T00:00:00Z")?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon(bin, temp.path(), SESSION, &state_file).await?;
    let socket = daemon.socket();
    let mut stream = UnixStream::connect(&socket).await?;
    let oversized = vec![b'X'; 2 * 1024 * 1024];
    let _ = timeout(Duration::from_secs(1), stream.write_all(&oversized)).await;

    let mut line = String::new();
    let mut reader = BufReader::new(stream);
    let read = timeout(Duration::from_secs(1), reader.read_line(&mut line)).await??;
    if read > 0 {
        let value: Value = serde_json::from_str(&line)?;
        assert_eq!(value["error"]["code"], FRAME_TOO_LARGE);
    }

    let stop = daemon_command(bin, temp.path(), ["daemon", "stop", "--session", SESSION])?;
    assert!(stop.status.success(), "stop command failed");
    daemon.wait_for_exit();

    Ok(())
}

#[tokio::test]
async fn daemon_snapshot_subscription_updates_two_clients() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s404.json");
    write_state(&state_file, "initial", "2026-05-15T00:00:00Z")?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon(bin, temp.path(), SESSION, &state_file).await?;
    let socket = daemon.socket();

    let mut client_one = DaemonClient::connect(&socket).await?;
    let mut rx_one = client_one.subscribe_snapshots().await?;
    let mut client_two = DaemonClient::connect(&socket).await?;
    let mut rx_two = client_two.subscribe_snapshots().await?;

    recv_title(&mut rx_one, "initial").await?;
    recv_title(&mut rx_two, "initial").await?;

    write_state(&state_file, "updated", "2026-05-15T00:00:01Z")?;

    let one = recv_title(&mut rx_one, "updated").await?;
    let two = recv_title(&mut rx_two, "updated").await?;
    assert_eq!(first_title(&one), Some("updated"));
    assert_eq!(first_title(&two), Some("updated"));

    let stop = daemon_command(bin, temp.path(), ["daemon", "stop", "--session", SESSION])?;
    assert!(stop.status.success(), "stop command failed");
    daemon.wait_for_exit();

    Ok(())
}

struct DaemonGuard {
    child: Child,
    bin: &'static str,
    state_dir: PathBuf,
    session: String,
}

impl DaemonGuard {
    fn socket(&self) -> PathBuf {
        self.state_dir
            .join(format!("dashboard-{}.sock", self.session))
    }

    fn wait_for_exit(&mut self) {
        for _ in 0..50 {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(StdDuration::from_millis(100)),
                Err(error) => {
                    eprintln!("failed to poll daemon child: {error}");
                    return;
                }
            }
        }
        if let Err(error) = self.child.kill() {
            eprintln!("failed to kill daemon child: {error}");
        }
        if let Err(error) = self.child.wait() {
            eprintln!("failed to wait daemon child: {error}");
        }
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        match Command::new(self.bin)
            .args(["daemon", "stop", "--session", self.session.as_str()])
            .env("FD_STATE_DIR", &self.state_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(_) => {}
            Err(error) => eprintln!("failed to stop daemon in drop: {error}"),
        }
        self.wait_for_exit();
    }
}

async fn spawn_daemon(
    bin: &'static str,
    state_dir: &Path,
    session: &str,
    state_file: &Path,
) -> Result<DaemonGuard, Box<dyn Error>> {
    let child = Command::new(bin)
        .args([
            "daemon",
            "start",
            "--session",
            session,
            "--state-file",
            state_file.to_str().ok_or("state path must be utf-8")?,
        ])
        .env("FD_STATE_DIR", state_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let guard = DaemonGuard {
        child,
        bin,
        state_dir: state_dir.to_path_buf(),
        session: session.to_owned(),
    };
    wait_for_socket(&guard.socket()).await?;
    Ok(guard)
}

async fn wait_for_socket(socket: &Path) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if socket.exists() && DaemonClient::connect(socket).await.is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("daemon socket did not become ready: {}", socket.display()).into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn recv_title(
    rx: &mut mpsc::UnboundedReceiver<DashboardSnapshot>,
    expected: &str,
) -> Result<DashboardSnapshot, Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for snapshot title {expected:?}").into());
        }
        let remaining = deadline.saturating_duration_since(now);
        match timeout(remaining, rx.recv()).await {
            Ok(Some(snapshot)) if first_title(&snapshot) == Some(expected) => return Ok(snapshot),
            Ok(Some(_)) => {}
            Ok(None) => return Err("snapshot stream closed".into()),
            Err(_) => {
                return Err(format!("timed out waiting for snapshot title {expected:?}").into())
            }
        }
    }
}

fn first_title(snapshot: &DashboardSnapshot) -> Option<&str> {
    snapshot
        .sessions
        .first()
        .map(|session| session.title.as_str())
}

fn write_state(path: &Path, title: &str, updated_at: &str) -> Result<(), Box<dyn Error>> {
    let json = format!(
        r#"{{
  "session_id": "{SESSION}",
  "updated_at": "{updated_at}",
  "entries": {{
    "agent-1": {{
      "id": "agent-1",
      "title": "{title}",
      "state": "waiting"
    }}
  }}
}}"#
    );
    std::fs::write(path, json)?;
    Ok(())
}

fn daemon_command<const N: usize>(
    bin: &str,
    state_dir: &Path,
    args: [&str; N],
) -> Result<std::process::Output, Box<dyn Error>> {
    Ok(Command::new(bin)
        .args(args)
        .env("FD_STATE_DIR", state_dir)
        .output()?)
}

fn dashboard_bin() -> &'static str {
    env!("CARGO_BIN_EXE_flightdeck-dashboard")
}
