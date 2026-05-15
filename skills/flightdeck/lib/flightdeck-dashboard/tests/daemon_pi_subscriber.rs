use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration as StdDuration;

use flightdeck_dashboard::daemon::client::DaemonClient;
use serde_json::Value;
use tokio::time::{sleep, Duration, Instant};

const SESSION: &str = "s505";
const PANE_ID: &str = "%18";

#[tokio::test]
async fn pi_subscriber_appends_bg_task_exit_wake() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  echo '{"type":"bridge_hello"}'
  echo '{"type":"event","event":"message_end","data":{"message":{"customType":"vstack-background-tasks:event","details":{"eventType":"exit","task":{"id":"bg-3","status":"failed","exitCode":null,"command":"echo hi","outputBytes":89}}}}}'
  exit 0
fi
exit 0
"#,
    )?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon(bin, temp.path(), SESSION, &state_file, &bridge, &[]).await?;

    let rows = wait_for_wake_rows(temp.path(), 1).await?;
    let row = rows
        .iter()
        .find(|row| row.get("classifier_tag").and_then(Value::as_str) == Some("pi-bg-task-exit"))
        .ok_or("pi-bg-task-exit row missing")?;
    assert_eq!(row["pane_id"], PANE_ID);
    assert_eq!(row["harness"], "pi");
    assert_eq!(row["event_type"], "bg-task-exit");
    assert_eq!(row["task"]["id"], "bg-3");
    assert_eq!(row["task"]["status"], "failed");
    assert!(row["hash"].as_str().is_some_and(|hash| hash.len() == 12));

    daemon.stop();
    Ok(())
}

#[tokio::test]
async fn pi_subscriber_domain_guard_blocks_issue_only_tags() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "adhoc")?;
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  echo '{"type":"event","event":"message_end","data":{"message":{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Ready to merge now"}]}}}'
  echo '{"type":"event","event":"message_end","data":{"message":{"customType":"vstack-background-tasks:event","details":{"eventType":"exit","task":{"id":"bg-4","status":"completed","exitCode":0,"command":"true","outputBytes":7}}}}}'
  exit 0
fi
exit 0
"#,
    )?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon(bin, temp.path(), SESSION, &state_file, &bridge, &[]).await?;

    let rows = wait_for_wake_rows(temp.path(), 2).await?;
    let tags = rows
        .iter()
        .filter_map(|row| row.get("classifier_tag").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(tags.contains(&"domain-mismatch"));
    assert!(tags.contains(&"pi-bg-task-exit"));
    assert!(!tags.contains(&"merge-now"));

    daemon.stop();
    Ok(())
}

#[tokio::test]
async fn rust_wake_side_default_gate_off() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let count_file = temp.path().join("bridge-count");
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  printf '1\n' > "${FD_FAKE_COUNT:?}"
  echo '{"type":"bridge_hello"}'
  exit 0
fi
exit 0
"#,
    )?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon_with_gate(
        bin,
        temp.path(),
        SESSION,
        &state_file,
        &bridge,
        false,
        &[("FD_FAKE_COUNT", count_file.as_path())],
    )
    .await?;

    let log = std::fs::read_to_string(temp.path().join(format!("dashboard-{SESSION}.log")))?;
    assert!(log.contains("rust wake side inactive"));
    assert!(!count_file.exists());

    daemon.stop();
    Ok(())
}

#[tokio::test]
async fn pi_subscriber_restarts_after_bridge_exit() -> Result<(), Box<dyn Error>> {
    let temp = tempfile::tempdir()?;
    let state_file = temp.path().join("flightdeck-state-s505.json");
    write_state(&state_file, "issue")?;
    let count_file = temp.path().join("bridge-count");
    let bridge = write_fake_bridge(
        temp.path(),
        r#"
if [[ "$1" == "stream" ]]; then
  count_file="${FD_FAKE_COUNT:?}"
  count=0
  if [[ -f "$count_file" ]]; then count=$(cat "$count_file"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$count_file"
  echo '{"type":"bridge_hello"}'
  exit 1
fi
exit 0
"#,
    )?;

    let bin = dashboard_bin();
    let mut daemon = spawn_daemon(
        bin,
        temp.path(),
        SESSION,
        &state_file,
        &bridge,
        &[("FD_FAKE_COUNT", count_file.as_path())],
    )
    .await?;

    wait_for_count(&count_file, 2).await?;
    daemon.stop();
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

    fn stop(&mut self) {
        match Command::new(self.bin)
            .args(["daemon", "stop", "--session", self.session.as_str()])
            .env("FD_STATE_DIR", &self.state_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(_) => {}
            Err(error) => eprintln!("failed to stop daemon: {error}"),
        }
        self.wait_for_exit();
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
        self.stop();
    }
}

async fn spawn_daemon(
    bin: &'static str,
    state_dir: &Path,
    session: &str,
    state_file: &Path,
    bridge: &Path,
    extra_env: &[(&str, &Path)],
) -> Result<DaemonGuard, Box<dyn Error>> {
    spawn_daemon_with_gate(bin, state_dir, session, state_file, bridge, true, extra_env).await
}

async fn spawn_daemon_with_gate(
    bin: &'static str,
    state_dir: &Path,
    session: &str,
    state_file: &Path,
    bridge: &Path,
    gate: bool,
    extra_env: &[(&str, &Path)],
) -> Result<DaemonGuard, Box<dyn Error>> {
    let mut command = Command::new(bin);
    command
        .args([
            "daemon",
            "start",
            "--session",
            session,
            "--state-file",
            state_file.to_str().ok_or("state path must be utf-8")?,
        ])
        .env("FD_STATE_DIR", state_dir)
        .env("PI_BRIDGE_BIN", bridge)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if gate {
        command.env("FLIGHTDECK_DAEMON_RUST", "1");
    }
    for (key, value) in extra_env {
        command.env(key, value);
    }
    let child = command.spawn()?;
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

async fn wait_for_wake_rows(
    state_dir: &Path,
    min_rows: usize,
) -> Result<Vec<Value>, Box<dyn Error>> {
    let path = state_dir.join(format!("fd-wake-events-{SESSION}.log"));
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(body) = std::fs::read_to_string(&path) {
            let rows = body
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(serde_json::from_str::<Value>)
                .collect::<Result<Vec<_>, _>>()?;
            if rows.len() >= min_rows {
                return Ok(rows);
            }
        }
        if Instant::now() >= deadline {
            return Err(format!("timed out waiting for wake rows in {}", path.display()).into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_for_count(path: &Path, min_count: u32) -> Result<(), Box<dyn Error>> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let count = std::fs::read_to_string(path)
            .ok()
            .and_then(|body| body.trim().parse::<u32>().ok())
            .unwrap_or_default();
        if count >= min_count {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("timed out waiting for bridge restart count {min_count}").into());
        }
        sleep(Duration::from_millis(50)).await;
    }
}

fn write_state(path: &Path, kind: &str) -> Result<(), Box<dyn Error>> {
    let json = format!(
        r#"{{
  "session_id": "{SESSION}",
  "updated_at": "2026-05-15T00:00:00Z",
  "entries": {{
    "agent-1": {{
      "id": "agent-1",
      "title": "Pi agent",
      "kind": "{kind}",
      "state": "waiting",
      "harness": "pi",
      "pane_id": "{PANE_ID}",
      "adapter": {{
        "pi_bridge_pid": 12345,
        "pi_bridge_socket": "/tmp/fake-pi-bridge.sock",
        "pi_session_id": "pi-session-test"
      }}
    }}
  }}
}}"#
    );
    std::fs::write(path, json)?;
    Ok(())
}

fn write_fake_bridge(dir: &Path, body: &str) -> Result<PathBuf, Box<dyn Error>> {
    let path = dir.join("pi-bridge");
    std::fs::write(
        &path,
        format!("#!/usr/bin/env bash\nset -euo pipefail\n{body}\n"),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms)?;
    }
    Ok(path)
}

fn dashboard_bin() -> &'static str {
    env!("CARGO_BIN_EXE_flightdeck-dashboard")
}
