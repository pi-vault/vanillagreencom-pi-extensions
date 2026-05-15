pub mod conversations;
pub mod daemon;
pub mod decisions;
pub mod fx;
pub mod live_feed;
pub mod merges;
pub mod modals;
pub mod overview;

use chrono::{DateTime, Utc};
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Tabs};
use ratatui::Frame;

use crate::app::model::{Model, Tab};
use crate::app::theme::Theme;

pub fn render(frame: &mut Frame<'_>, model: &Model) {
    let theme = Theme::dark();
    let area = frame.area();
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(3),
            Constraint::Length(2),
        ])
        .split(area);

    render_status(frame, chunks[0], model, theme);
    render_tabs(frame, chunks[1], model, theme);
    render_body(frame, chunks[2], model, theme);
    render_footer(frame, chunks[3], model, theme);

    if model.show_help {
        modals::render_help(frame, area, model, theme);
    }
}

fn render_status(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let snapshot = &model.snapshot;
    let owner = owner_label(model);
    let elapsed = snapshot
        .started_at
        .map(|started| human_duration(started, model.now()))
        .unwrap_or_else(|| String::from("unknown"));
    let state_counts = snapshot
        .counts
        .by_state
        .iter()
        .map(|(state, count)| format!("{state}:{count}"))
        .collect::<Vec<_>>()
        .join(" ");

    let mut spans = vec![
        Span::styled(" Flightdeck ", theme.title),
        Span::raw(" "),
        Span::styled("session ", theme.status_label),
        Span::raw(snapshot.session_id.as_str()),
        Span::raw("  "),
        Span::styled("owner ", theme.status_label),
        Span::raw(owner),
        Span::raw("  "),
        Span::styled(snapshot.daemon.label.as_str(), theme.muted),
        Span::raw("  "),
        Span::styled("elapsed ", theme.status_label),
        Span::raw(elapsed),
        Span::raw("  "),
        Span::styled(
            format!(
                "AH:{} ISS:{} WF:{}",
                snapshot.counts.adhoc, snapshot.counts.issue, snapshot.counts.workflow
            ),
            theme.info,
        ),
    ];
    if !state_counts.is_empty() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(state_counts, theme.muted));
    }
    if snapshot.terminated {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(" ✔ session complete ", theme.ok));
    }
    if snapshot.paused_for_user.is_some() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(" PAUSED FOR USER ", theme.pause));
    }
    if let Some(error) = &model.error {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(format!(" ERR {error} "), theme.error));
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active)
        .title(Span::styled(" flightdeck-dashboard ", theme.title));
    frame.render_widget(
        Paragraph::new(Line::from(spans))
            .block(block)
            .style(theme.status),
        area,
    );
}

fn render_tabs(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let labels = model
        .tabs_enabled
        .iter()
        .map(|tab| Line::from(Span::raw(tab.label())))
        .collect::<Vec<_>>();
    let fx_hint = fx::tab_switch_hint(model);
    let title = if fx_hint.is_empty() {
        String::from(" tabs ")
    } else {
        format!(" tabs {fx_hint} ")
    };
    let tabs = Tabs::new(labels)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(theme.border)
                .title(Span::styled(title, theme.muted)),
        )
        .select(model.current_tab.index())
        .style(theme.tab_inactive)
        .highlight_style(theme.tab_active);
    frame.render_widget(tabs, area);
}

fn render_body(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    match model.current_tab {
        Tab::Overview => overview::render(frame, area, model, theme),
        Tab::LiveFeed => live_feed::render(frame, area, model, theme),
        Tab::Conversations => conversations::render(frame, area, model, theme),
        Tab::Merges => merges::render(frame, area, model, theme),
        Tab::Decisions => decisions::render(frame, area, model, theme),
        Tab::Daemon => daemon::render(frame, area, model, theme),
    }
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, model: &Model, theme: Theme) {
    let text = if model.ui.filter_open {
        Line::from(vec![
            Span::styled(" > ", theme.filter),
            Span::styled(
                "filter input open — filtering lands in Phase 3",
                theme.filter,
            ),
        ])
    } else {
        Line::from(vec![Span::styled(
            " Tab/Shift+Tab tabs  j/k select  r reload  Alt+M compact  ? help  q quit ",
            theme.footer,
        )])
    };
    frame.render_widget(Paragraph::new(text).style(theme.footer), area);
}

pub(super) fn render_placeholder(
    frame: &mut Frame<'_>,
    area: Rect,
    label: &'static str,
    theme: Theme,
) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border)
        .title(Span::styled(" scaffold ", theme.muted));
    let paragraph = Paragraph::new(label)
        .block(block)
        .style(theme.muted)
        .alignment(Alignment::Center);
    frame.render_widget(paragraph, area);
}

fn owner_label(model: &Model) -> String {
    let Some(owner) = &model.snapshot.owner else {
        return String::from("unknown");
    };
    let harness = owner.harness.as_deref().unwrap_or("unknown");
    let pane = owner.pane_id.as_deref().unwrap_or("no-pane");
    let cwd = owner
        .cwd
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| String::from("cwd?"));
    format!("{harness} · {pane} · {cwd}")
}

pub(super) fn human_duration(start: DateTime<Utc>, end: DateTime<Utc>) -> String {
    let duration = end.signed_duration_since(start);
    let seconds = duration.num_seconds().max(0);
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if hours > 0 {
        format!("{hours}h{minutes:02}m")
    } else {
        format!("{minutes}m")
    }
}
