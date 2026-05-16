use std::path::{Path, PathBuf};

use chrono::Utc;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::activity::ActivityEvent;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteAction {
    PruneStaleEntry { entry_id: String },
    FocusWindow { pane_target: String },
}

impl WriteAction {
    #[must_use]
    pub fn success_message(&self) -> String {
        match self {
            Self::PruneStaleEntry { entry_id } => format!("Pruned {entry_id}"),
            Self::FocusWindow { pane_target } => format!("Focused {pane_target}"),
        }
    }
}

pub async fn export_activity_markdown(
    session_id: &str,
    master_state_path: &Path,
    events: Vec<ActivityEvent>,
) -> Result<String, String> {
    let dir = master_state_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("tmp"));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| error.to_string())?;
    let ts = Utc::now().format("%Y-%m-%dT%H%M%SZ");
    let filename = format!(
        "flightdeck-activity-view-{}-{ts}.md",
        sanitize_filename(session_id)
    );
    let path = dir.join(filename);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|error| error.to_string())?;
    file.write_all(format_activity_markdown(session_id, &events).as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    file.flush().await.map_err(|error| error.to_string())?;

    if std::env::var_os("TMUX").is_some() {
        if let Some(editor) = std::env::var_os("VISUAL").or_else(|| std::env::var_os("EDITOR")) {
            let editor = editor.to_string_lossy();
            let command = format!(
                "{} {}",
                shell_quote(&editor),
                shell_quote(&path.display().to_string())
            );
            let output = Command::new("tmux")
                .args(["new-window", "-n", "fd-activity", &command])
                .output()
                .await
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Err(if stderr.is_empty() {
                    format!(
                        "activity exported to {} but tmux editor launch failed",
                        path.display()
                    )
                } else {
                    stderr
                });
            }
            return Ok(format!("Activity exported and opened: {}", path.display()));
        }
    }
    Ok(format!("Activity exported: {}", path.display()))
}

pub async fn run(action: WriteAction) -> Result<String, String> {
    let success = action.success_message();
    let output = match &action {
        WriteAction::PruneStaleEntry { entry_id } => {
            let mut command = Command::new(pane_registry_bin());
            command.args(["remove", entry_id]);
            command.output().await
        }
        WriteAction::FocusWindow { pane_target } => {
            let mut command = Command::new("tmux");
            command.args(["select-window", "-t", pane_target]);
            command.output().await
        }
    }
    .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(success);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

#[must_use]
pub fn pane_registry_args(entry_id: &str) -> Vec<String> {
    vec![String::from("remove"), entry_id.to_owned()]
}

#[must_use]
pub fn focus_args(pane_target: &str) -> Vec<String> {
    vec![
        String::from("select-window"),
        String::from("-t"),
        pane_target.to_owned(),
    ]
}

fn format_activity_markdown(session_id: &str, events: &[ActivityEvent]) -> String {
    let mut out = format!("# Flightdeck activity — {session_id}\n\n");
    if events.is_empty() {
        out.push_str("No activity events matched the current filters.\n");
        return out;
    }
    for event in events {
        out.push_str(&format!(
            "## {} · {} · {}\n\n",
            event.ts.to_rfc3339(),
            event.session_label(),
            event.event_type.as_str()
        ));
        out.push_str(&format!("- Severity: {}\n", event.severity.as_str()));
        out.push_str(&format!("- Importance: {}\n", event.importance.as_str()));
        out.push_str(&format!("- Summary: {}\n", event.summary));
        if let Some(body) = &event.body {
            out.push_str(&format!("\n{body}\n"));
        }
        let json = serde_json::to_string_pretty(event).unwrap_or_else(|_| String::from("{}"));
        out.push_str("\n```json\n");
        out.push_str(&json);
        out.push_str("\n```\n\n");
    }
    out
}

fn sanitize_filename(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    if cleaned.is_empty() {
        String::from("session")
    } else {
        cleaned
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn pane_registry_bin() -> PathBuf {
    std::env::var("FLIGHTDECK_SKILL_DIR")
        .ok()
        .map(|skill_dir| PathBuf::from(skill_dir).join("scripts/pane-registry"))
        .unwrap_or_else(|| PathBuf::from("pane-registry"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_stale_entry_builds_registry_remove_args() {
        assert_eq!(pane_registry_args("HT-9000"), ["remove", "HT-9000"]);
    }

    #[test]
    fn focus_window_builds_tmux_select_args() {
        assert_eq!(focus_args("VS:3.1"), ["select-window", "-t", "VS:3.1"]);
    }
}
