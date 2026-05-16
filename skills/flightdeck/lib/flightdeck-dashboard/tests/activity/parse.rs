use std::fs;

use flightdeck_dashboard::activity::{ActivitySource, Importance, JsonlActivitySource, Severity};

fn event(id: usize, event_type: &str, severity: &str, importance: &str) -> String {
    format!(
        r#"{{"schema_version":1,"id":"evt-{id}","ts":"2026-05-15T10:00:{id:02}Z","session_id":"S","source":"flightdeck","entry_id":"E{id}","entry_title":"Entry {id}","entry_kind":"adhoc","pane_id":"%{id}","harness":"pi","type":"{event_type}","severity":"{severity}","importance":"{importance}","summary":"event {id}","refs":{{"issue_id":"ISS-{id}","pr_number":{id}}},"details":{{"sequence":{id}}}}}"#
    )
}

#[test]
fn parses_fixture_jsonl_with_mixed_types() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("flightdeck-activity-S.jsonl");
    let rows = [
        event(1, "agent.started", "info", "normal"),
        event(2, "pi-bg-task.exit", "error", "important"),
        event(3, "question.opened", "warning", "critical"),
        event(4, "decision.recorded", "success", "important"),
        event(5, "pr.checks_passed", "success", "normal"),
        event(6, "linear.issue_created", "info", "normal"),
        event(7, "daemon.started", "debug", "noisy"),
        event(8, "session.started", "info", "normal"),
    ];
    fs::write(&path, format!("{}\n", rows.join("\n"))).expect("write fixture");

    let mut source = JsonlActivitySource::new(dir.path(), "S");
    let events = source.poll();

    assert_eq!(events.len(), 8);
    assert_eq!(events[0].event_type.as_str(), "agent.started");
    assert_eq!(events[1].severity, Severity::Error);
    assert_eq!(events[2].importance, Importance::Critical);
    assert_eq!(events[6].severity, Severity::Debug);
    assert_eq!(source.last_id().as_deref(), Some("evt-8"));
}
