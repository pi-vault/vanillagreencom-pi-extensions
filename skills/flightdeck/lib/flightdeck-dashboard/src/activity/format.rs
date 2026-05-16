use super::{ActivityEvent, Severity};

#[must_use]
pub fn event_chip(event_type: &str) -> &'static str {
    let prefix = event_type.split('.').next().unwrap_or(event_type);
    match prefix {
        "agent" => "agent",
        "bg" | "background" | "pi-bg-task" => "bg",
        "question" | "prompt" => "question",
        "decision" => "decision",
        "pr" | "github" => "pr",
        "linear" => "linear",
        "daemon" => "daemon",
        "session" | "entry" => "session",
        _ if event_type == "decision.recorded" => "decision",
        _ => "session",
    }
}

#[must_use]
pub fn event_chip_for(event: &ActivityEvent) -> &'static str {
    event_chip(event.event_type.as_str())
}

#[must_use]
pub fn severity_label(severity: Severity) -> &'static str {
    severity.label()
}
