use flightdeck_dashboard::activity::{ActivityEvent, ActivityType, Importance, Severity};
use flightdeck_dashboard::app::model::{ActivityFilter, FeedFilter};

fn event(id: &str, event_type: &str, severity: Severity, importance: Importance) -> ActivityEvent {
    ActivityEvent {
        schema_version: 1,
        id: id.to_owned(),
        ts: chrono::DateTime::parse_from_rfc3339("2026-05-15T10:00:00Z")
            .expect("valid ts")
            .with_timezone(&chrono::Utc),
        session_id: Some(String::from("S")),
        source: String::from("flightdeck"),
        entry_id: Some(String::from("E1")),
        entry_title: Some(String::from("Entry")),
        entry_kind: Some(String::from("adhoc")),
        pane_id: Some(String::from("%1")),
        harness: Some(String::from("pi")),
        event_type: ActivityType::new(event_type),
        severity,
        importance,
        summary: format!("summary {id}"),
        body: None,
        links: Vec::new(),
        refs: None,
        details: None,
        noisy: importance == Importance::Noisy,
    }
}

#[test]
fn filters_by_type_severity_importance_and_session() {
    let info = event("info", "daemon.started", Severity::Info, Importance::Normal);
    let decision = event(
        "decision",
        "decision.recorded",
        Severity::Warning,
        Importance::Important,
    );
    let noisy = event(
        "noisy",
        "agent.heartbeat",
        Severity::Debug,
        Importance::Noisy,
    );
    let text_filter = FeedFilter::new();
    let mut filter = ActivityFilter::new();

    assert!(filter.matches(&info, true, &text_filter));
    assert!(filter.matches(&decision, true, &text_filter));
    assert!(!filter.matches(&noisy, true, &text_filter));
    assert!(filter.matches(&noisy, false, &text_filter));

    filter.toggle_type("decision");
    assert!(!filter.matches(&decision, false, &text_filter));
    assert!(filter.matches(&info, false, &text_filter));

    filter.severity =
        flightdeck_dashboard::app::model::ActivitySeverityFilter::Exact(Severity::Warning);
    assert!(!filter.matches(&info, false, &text_filter));
    filter.toggle_type("decision");
    assert!(filter.matches(&decision, false, &text_filter));

    filter.session = Some(String::from("other"));
    assert!(!filter.matches(&decision, false, &text_filter));
}
