use std::fs;

use flightdeck_dashboard::activity::{ActivitySource, JsonlActivitySource};

fn row(id: &str, summary: &str) -> String {
    format!(
        r#"{{"schema_version":1,"id":"{id}","ts":"2026-05-15T10:00:00Z","session_id":"S","source":"flightdeck","type":"session.started","severity":"info","importance":"normal","summary":"{summary}"}}"#
    )
}

#[test]
fn falls_back_to_archive_then_switches_to_live() {
    let dir = tempfile::tempdir().expect("tempdir");
    let older = dir
        .path()
        .join("flightdeck-activity-S-2026-05-15T090000Z.jsonl.archive");
    let newer = dir
        .path()
        .join("flightdeck-activity-S-2026-05-15T100000Z.jsonl.archive");
    fs::write(&older, format!("{}\n", row("old", "old archive"))).expect("write older");
    fs::write(&newer, format!("{}\n", row("new", "new archive"))).expect("write newer");

    let mut source = JsonlActivitySource::new(dir.path(), "S");
    let archived = source.poll();
    assert_eq!(archived.len(), 1);
    assert_eq!(archived[0].id, "new");
    assert!(source.active_path().is_some_and(|path| path == newer));

    let live = dir.path().join("flightdeck-activity-S.jsonl");
    fs::write(&live, format!("{}\n", row("live", "live sidecar"))).expect("write live");
    let events = source.poll();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].id, "live");
    assert!(source.active_path().is_some_and(|path| path == live));
}
