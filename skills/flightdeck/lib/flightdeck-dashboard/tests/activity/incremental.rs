use std::fs::OpenOptions;
use std::io::Write;

use flightdeck_dashboard::activity::{ActivitySource, JsonlActivitySource};

fn row(id: usize) -> String {
    format!(
        r#"{{"schema_version":1,"id":"evt-{id}","ts":"2026-05-15T10:00:{id:02}Z","session_id":"S","source":"flightdeck","type":"entry.state_changed","severity":"info","importance":"normal","summary":"event {id}"}}"#
    )
}

#[test]
fn reads_appended_bytes_incrementally() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("flightdeck-activity-S.jsonl");
    let first = (0..10).map(row).collect::<Vec<_>>().join("\n");
    std::fs::write(&path, format!("{first}\n")).expect("write initial");

    let mut source = JsonlActivitySource::new(dir.path(), "S");
    let initial = source.poll();
    let first_offset = source.offset();
    assert_eq!(initial.len(), 10);
    assert!(first_offset > 0);

    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open append");
    for id in 10..15 {
        writeln!(file, "{}", row(id)).expect("append row");
    }

    let next = source.poll();
    assert_eq!(next.len(), 15);
    assert!(source.offset() > first_offset);
    assert_eq!(source.last_id().as_deref(), Some("evt-14"));
}
