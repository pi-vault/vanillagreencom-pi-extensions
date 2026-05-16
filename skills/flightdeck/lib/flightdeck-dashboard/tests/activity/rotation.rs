use std::fs;

use flightdeck_dashboard::activity::{ActivitySource, JsonlActivitySource};

fn row(id: usize, summary: &str) -> String {
    format!(
        r#"{{"schema_version":1,"id":"evt-{id}","ts":"2026-05-15T10:00:{:02}Z","session_id":"S","source":"flightdeck","type":"entry.state_changed","severity":"info","importance":"normal","summary":"{summary}"}}"#,
        id % 60
    )
}

#[test]
fn detects_same_path_rotation_when_new_file_is_not_shorter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("flightdeck-activity-S.jsonl");
    let initial = (0..5)
        .map(|id| row(id, "initial event"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, format!("{initial}\n")).expect("write initial");

    let mut source = JsonlActivitySource::new(dir.path(), "S");
    let initial_events = source.poll();
    let initial_offset = source.offset();
    assert_eq!(initial_events.len(), 5);
    assert!(initial_offset > 0);

    fs::rename(&path, dir.path().join("flightdeck-activity-S.jsonl.bak"))
        .expect("rotate live file");
    let padding = "fresh event after same-path rotation ".repeat(16);
    let fresh = (100..105)
        .map(|id| row(id, &padding))
        .collect::<Vec<_>>()
        .join("\n");
    let fresh = format!("{fresh}\n");
    assert!(fresh.len() as u64 >= initial_offset);
    fs::write(&path, fresh).expect("write replacement");

    let rotated_events = source.poll();
    assert_eq!(rotated_events.len(), 5);
    assert_eq!(rotated_events[0].id, "evt-100");
    assert_eq!(rotated_events[4].id, "evt-104");
    assert_eq!(source.last_id().as_deref(), Some("evt-104"));
}
