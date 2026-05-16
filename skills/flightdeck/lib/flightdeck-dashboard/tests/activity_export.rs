use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use flightdeck_dashboard::actions::export_activity_markdown;
use tokio::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

struct EnvGuard {
    saved: Vec<(&'static str, Option<OsString>)>,
}

impl EnvGuard {
    fn capture(keys: &[&'static str]) -> Self {
        let saved = keys.iter().map(|key| (*key, env::var_os(key))).collect();
        Self { saved }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            if let Some(value) = value {
                env::set_var(*key, value);
            } else {
                env::remove_var(*key);
            }
        }
    }
}

#[tokio::test]
async fn export_without_tmux_returns_written_path() {
    let _lock = ENV_LOCK.lock().await;
    let _guard = EnvGuard::capture(&["TMUX", "VISUAL", "EDITOR", "PATH"]);
    env::remove_var("TMUX");
    env::set_var("EDITOR", "definitely-not-used");
    env::set_var("PATH", "/dev/null");

    let dir = tempfile::tempdir().expect("tempdir");
    let state_path = dir.path().join("flightdeck-state-S.json");

    let message = export_activity_markdown("S", &state_path, Vec::new())
        .await
        .expect("export succeeds");

    assert!(message.starts_with("Activity exported: "));
    assert!(message.contains(&dir.path().display().to_string()));
    assert!(!message.contains("editor launch failed"));
    assert_eq!(exported_files(dir.path()).len(), 1);
}

#[tokio::test]
async fn export_survives_tmux_editor_launch_failure() {
    let _lock = ENV_LOCK.lock().await;
    let _guard = EnvGuard::capture(&["TMUX", "VISUAL", "EDITOR", "PATH"]);
    env::set_var("TMUX", "/tmp/flightdeck-dashboard-test-tmux");
    env::remove_var("VISUAL");
    env::set_var("EDITOR", "nano");
    env::set_var("PATH", "/dev/null");

    let dir = tempfile::tempdir().expect("tempdir");
    let state_path = dir.path().join("flightdeck-state-S.json");

    let message = export_activity_markdown("S", &state_path, Vec::new())
        .await
        .expect("export succeeds despite launch failure");

    assert!(message.starts_with("Activity exported: "));
    assert!(message.contains(&dir.path().display().to_string()));
    assert!(message.contains("(editor launch failed: "));
    assert_eq!(exported_files(dir.path()).len(), 1);
}

#[tokio::test]
async fn export_write_failure_returns_path_context() {
    let _lock = ENV_LOCK.lock().await;
    let _guard = EnvGuard::capture(&["TMUX", "VISUAL", "EDITOR", "PATH"]);
    env::remove_var("TMUX");

    let dir = tempfile::tempdir().expect("tempdir");
    let not_a_dir = dir.path().join("not-a-dir");
    fs::write(&not_a_dir, "blocks directory creation").expect("write blocking file");
    let state_path = not_a_dir.join("flightdeck-state-S.json");

    let error = export_activity_markdown("S", &state_path, Vec::new())
        .await
        .expect_err("export fails");

    assert!(error.contains("failed to create activity export directory"));
    assert!(error.contains(&not_a_dir.display().to_string()));
}

fn exported_files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .expect("read export dir")
        .map(|entry| entry.expect("read entry").path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("flightdeck-activity-view-S-"))
        })
        .collect()
}
