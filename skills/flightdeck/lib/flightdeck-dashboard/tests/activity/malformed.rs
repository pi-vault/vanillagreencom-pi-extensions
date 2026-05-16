use std::fs;

use flightdeck_dashboard::activity::{ActivitySource, JsonlActivitySource};

#[test]
fn malformed_jsonl_lines_are_skipped_and_counted() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("flightdeck-activity-S.jsonl");
    fs::write(
        &path,
        concat!(
            "not json\n",
            "{\"schema_version\":1,\"id\":\"ok-1\",\"ts\":\"2026-05-15T10:00:00Z\",\"session_id\":\"S\",\"source\":\"flightdeck\",\"type\":\"session.started\",\"severity\":\"info\",\"importance\":\"normal\",\"summary\":\"started\"}\n",
            "{\"schema_version\":1,\"id\":\"bad-severity\",\"ts\":\"2026-05-15T10:00:01Z\",\"source\":\"flightdeck\",\"type\":\"session.started\",\"severity\":\"bad\",\"importance\":\"normal\",\"summary\":\"bad\"}\n",
            "{\"schema_version\":1,\"id\":\"ok-2\",\"ts\":\"2026-05-15T10:00:02Z\",\"session_id\":\"S\",\"source\":\"flightdeck\",\"type\":\"daemon.started\",\"severity\":\"success\",\"importance\":\"important\",\"summary\":\"daemon\"}\n",
        ),
    )
    .expect("write fixture");

    let mut source = JsonlActivitySource::new(dir.path(), "S");
    let events = source.poll();

    assert_eq!(events.len(), 2);
    assert_eq!(source.malformed_lines(), 2);
    assert_eq!(events[0].id, "ok-1");
    assert_eq!(events[1].id, "ok-2");
}
