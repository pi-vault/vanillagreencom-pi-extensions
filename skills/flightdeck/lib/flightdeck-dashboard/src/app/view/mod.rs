pub mod activity;
pub mod conversations;
pub mod costs;
pub mod daemon;
pub mod decisions;
pub mod fx;
pub mod merges;
pub mod modals;
pub mod overview;
pub mod popup;

use chrono::{DateTime, Utc};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, Paragraph, Tabs};
use ratatui::Frame;

use crate::app::command::SnapshotSource;
use crate::app::hitmap::{ClickAction, HitMap};
use crate::app::model::{Model, Tab};
use crate::app::theme::Palette;
use crate::cost::{format_cost, format_summary};
use crate::state::snapshot::Staleness;

const HEADER_COMPACT_WIDTH: u16 = 200;

pub fn render(frame: &mut Frame<'_>, model: &Model) {
    let mut hitmap = HitMap::default();
    render_with_hitmap(frame, model, &mut hitmap);
}

pub fn render_with_hitmap(frame: &mut Frame<'_>, model: &Model, hitmap: &mut HitMap) {
    hitmap.clear();
    let theme = model.palette();
    let area = frame.area();
    render_frame_background(frame, area, theme);
    let pause_height = u16::from(model.snapshot.paused_for_user.is_some());
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(pause_height),
            Constraint::Length(3),
            Constraint::Min(3),
            Constraint::Length(2),
        ])
        .split(area);

    render_status(frame, chunks[0], model, theme, hitmap);
    render_pause_banner(frame, chunks[1], model, theme, hitmap);
    render_tabs(frame, chunks[2], model, theme, hitmap);
    render_body(frame, chunks[3], model, theme, hitmap);
    render_footer(frame, chunks[4], model, theme, hitmap);

    match model.modal {
        crate::app::model::ModalState::Help => {
            modals::render_help(frame, area, model, theme, hitmap)
        }
        crate::app::model::ModalState::ThemePicker => {
            modals::render_theme_picker(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::DecisionDetail => {
            modals::render_decision_detail(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::SessionDetail => {
            modals::render_session_detail(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::EventDetail => {
            modals::render_event_detail(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::ActivityFilter => {
            modals::render_activity_filter(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::FilterInput => {
            modals::render_filter_input(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::ConfirmAction => {
            modals::render_confirm(frame, area, model, theme, hitmap);
        }
        crate::app::model::ModalState::None => {}
    }
}

fn render_frame_background(frame: &mut Frame<'_>, area: Rect, theme: &Palette) {
    if !theme.paints_outer_background() {
        return;
    }
    frame.render_widget(Clear, area);
    frame.render_widget(Block::default().style(theme.outer()), area);
}

fn render_status(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let snapshot = &model.snapshot;
    let compact = area.width < HEADER_COMPACT_WIDTH;
    let owner = owner_label(model, compact);
    let elapsed = snapshot
        .started_at
        .map(|started| human_duration(started, model.now))
        .unwrap_or_else(|| String::from("unknown"));
    let daemon = daemon_label(model, compact).to_owned();
    let kind_counts = kind_counts_label(model);
    let staleness = staleness_label(snapshot.staleness(model.now));
    let cost_chip = if compact {
        format!(
            "{}/{}T",
            format_cost(model.cost_totals.grand.cost_usd),
            model.cost_totals.grand.turns
        )
    } else {
        format_summary(&model.cost_totals.grand)
    };
    let theme_chip = format!("{} ▾", model.theme.as_str());

    let mut spans = vec![
        Span::styled(" Flightdeck ", theme.title()),
        Span::raw("  "),
        Span::styled("session ", theme.status_label()),
        Span::raw(snapshot.session_id.as_str()),
        Span::raw("  ·  "),
        Span::raw(owner),
        Span::raw("  ·  "),
        Span::styled(daemon.as_str().to_owned(), theme.muted()),
        Span::raw("  ·  "),
        Span::styled("uptime ", theme.status_label()),
        Span::raw(elapsed),
        Span::raw("  ·  "),
        Span::styled(kind_counts, theme.info()),
        Span::raw("  ·  "),
        Span::styled(staleness, theme.muted()),
    ];
    if snapshot.terminated {
        spans.push(Span::raw("  "));
        spans.push(Span::styled("✔ session complete", theme.ok()));
    }
    if model.is_observer() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled("observer", theme.warning()));
    }
    spans.push(Span::raw("  "));
    spans.push(Span::styled(cost_chip.clone(), theme.info()));
    if model.cost_totals.unhealthy_sources > 0 {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            format!(
                "{} cost source unhealthy",
                model.cost_totals.unhealthy_sources
            ),
            theme.warning(),
        ));
    }
    if let Some(status) = &model.status_message {
        spans.push(Span::raw("  "));
        let style = if status.success {
            theme.ok()
        } else {
            theme.warning()
        };
        spans.push(Span::styled(status.message.clone(), style));
    }
    if let Some(error) = &model.error {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(format!("ERR {error}"), theme.error()));
    }

    let inner_x = area.x.saturating_add(1);
    let inner_y = area.y.saturating_add(1);
    if let Some(daemon_x) = header_chip_x(&spans, &daemon) {
        hitmap.push(
            Rect::new(
                inner_x.saturating_add(daemon_x),
                inner_y,
                daemon.len() as u16,
                1,
            ),
            ClickAction::SelectTab(Tab::Daemon),
            1,
        );
    }
    if let Some(cost_x) = header_chip_x(&spans, &cost_chip) {
        hitmap.push(
            Rect::new(
                inner_x.saturating_add(cost_x),
                inner_y,
                cost_chip.len() as u16,
                1,
            ),
            ClickAction::SelectTab(Tab::Costs),
            1,
        );
    }
    let theme_width = u16::try_from(theme_chip.chars().count()).unwrap_or(u16::MAX);
    let theme_rect = Rect::new(
        area.x
            .saturating_add(area.width.saturating_sub(theme_width.saturating_add(2))),
        inner_y,
        theme_width.min(area.width),
        1,
    );
    hitmap.push(theme_rect, ClickAction::OpenThemePicker, 1);

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active())
        .style(theme.panel())
        .title(Span::styled(" Flightdeck ", theme.title()));
    let status_area = block.inner(area);
    let status_width = theme_rect
        .x
        .saturating_sub(status_area.x)
        .saturating_sub(1)
        .min(status_area.width);
    let status_rect = Rect::new(status_area.x, status_area.y, status_width, 1);
    frame.render_widget(block, area);
    if status_rect.width > 0 {
        frame.render_widget(
            Paragraph::new(Line::from(spans)).style(theme.status()),
            status_rect,
        );
    }
    frame.render_widget(
        Paragraph::new(Span::styled(theme_chip, theme.header())).style(theme.status()),
        theme_rect,
    );
}

fn render_pause_banner(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    if area.height == 0 {
        return;
    }
    let Some(pause) = &model.snapshot.paused_for_user else {
        return;
    };
    let entry_id = pause.entry_id.as_deref().unwrap_or("unknown-entry");
    let mut text = format!(" PAUSED FOR USER · {entry_id} · {}", pause.reason);
    if let Some(prompt) = pause
        .prompt_text
        .as_deref()
        .filter(|prompt| !prompt.is_empty())
    {
        text.push_str(" · ");
        text.push_str(&trim_for_header(prompt, 96));
    }
    hitmap.push(area, ClickAction::JumpToPaused, 1);
    frame.render_widget(Paragraph::new(text).style(theme.pause()), area);
}

fn render_tabs(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let labels = model
        .tabs_enabled
        .iter()
        .map(|tab| Line::from(Span::raw(model.tab_label(*tab))))
        .collect::<Vec<_>>();
    let fx_hint = fx::tab_switch_hint(model);
    let title = if fx_hint.is_empty() {
        String::from(" tabs ")
    } else {
        format!(" tabs {fx_hint} ")
    };
    let mut x = area.x.saturating_add(2);
    let y = area.y.saturating_add(1);
    for tab in &model.tabs_enabled {
        let width = u16::try_from(model.tab_label(*tab).chars().count()).unwrap_or(u16::MAX);
        hitmap.push(Rect::new(x, y, width, 1), ClickAction::SelectTab(*tab), 0);
        x = x.saturating_add(width.saturating_add(3));
    }
    let tabs = Tabs::new(labels)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(theme.border())
                .style(theme.panel())
                .title(Span::styled(title, theme.muted())),
        )
        .select(model.selected_tab_position())
        .style(theme.tab_inactive())
        .highlight_style(theme.tab_active());
    frame.render_widget(tabs, area);
}

fn render_body(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    match model.current_tab {
        Tab::Overview => overview::render(frame, area, model, theme, hitmap),
        Tab::Activity => activity::render(frame, area, model, theme, hitmap),
        Tab::Conversations => conversations::render(frame, area, model, theme, hitmap),
        Tab::Merges => merges::render(frame, area, model, theme, hitmap),
        Tab::Decisions => decisions::render(frame, area, model, theme, hitmap),
        Tab::Costs => costs::render(frame, area, model, theme, hitmap),
        Tab::Daemon => daemon::render(frame, area, model, theme, hitmap),
    }
}

fn render_footer(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    let text = if model.ui.filter_open {
        let prefix = if model.feed_filter.error.is_some() {
            " regex invalid > "
        } else {
            " filter > "
        };
        push_footer_target(hitmap, area, 1, "/ filter", ClickAction::OpenFilter);
        Line::from(vec![
            Span::styled(prefix, theme.filter()),
            Span::styled(model.feed_filter.input.clone(), theme.filter()),
        ])
    } else {
        let noisy = if model.ui.hide_noise {
            "noise: hidden"
        } else {
            "noise: shown"
        };
        let filter = if model.feed_filter.pattern.is_empty() {
            "filter: off".to_owned()
        } else {
            format!("filter: {}", model.feed_filter.pattern)
        };
        let left =
            " ↹ tabs   j/k or ↑/↓ select   ⏎ detail   f filters   n noise   s session   d decisions   e export   ? help   q quit";
        push_footer_target(
            hitmap,
            area,
            1,
            "↹ tabs",
            ClickAction::SelectTab(model.next_tab()),
        );
        push_footer_target(hitmap, area, 32, "⏎ detail", ClickAction::OpenDetail);
        push_footer_target(
            hitmap,
            area,
            43,
            "f filters",
            ClickAction::OpenActivityFilter,
        );
        push_footer_target(hitmap, area, 55, "n noise", ClickAction::ToggleNoiseFilter);
        push_footer_target(hitmap, area, 91, "e export", ClickAction::ActivityExport);
        push_footer_target(hitmap, area, 102, "? help", ClickAction::OpenHelp);
        push_footer_target(hitmap, area, 111, "q quit", ClickAction::Quit);
        let right = format!("{noisy}  ·  {filter}");
        let padding = area
            .width
            .saturating_sub((left.chars().count() + right.chars().count()) as u16)
            .max(1) as usize;
        let line = format!("{left}{}{right}", " ".repeat(padding));
        let right_x = area
            .width
            .saturating_sub(right.chars().count() as u16)
            .saturating_add(area.x);
        push_rect_target(
            hitmap,
            Rect::new(right_x, area.y, noisy.chars().count() as u16, area.height),
            ClickAction::ToggleNoiseFilter,
        );
        let filter_x = right_x.saturating_add(noisy.chars().count() as u16 + 5);
        push_rect_target(
            hitmap,
            Rect::new(filter_x, area.y, filter.chars().count() as u16, area.height),
            ClickAction::OpenFilter,
        );
        Line::from(Span::styled(line, theme.footer()))
    };
    let mut paragraph = Paragraph::new(text).style(theme.footer());
    if model.ui.filter_open && model.feed_filter.error.is_some() {
        paragraph = paragraph.block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(theme.error()),
        );
    }
    frame.render_widget(paragraph, area);
}

fn kind_counts_label(model: &Model) -> String {
    let counts = &model.snapshot.counts;
    format!(
        "Adhoc {} · Issue {} · Workflow {}",
        counts.adhoc, counts.issue, counts.workflow
    )
}

fn staleness_label(staleness: Staleness) -> String {
    match staleness {
        Staleness::Fresh => String::from("fresh"),
        Staleness::WarnAfter(age) => format!("{} old", duration_label(age)),
        Staleness::StaleAfter(age) => format!("{} old · stale", duration_label(age)),
    }
}

fn header_chip_x(spans: &[Span<'_>], needle: &str) -> Option<u16> {
    let mut offset = 0usize;
    for span in spans {
        let value = span.content.as_ref();
        if value == needle {
            return u16::try_from(offset).ok();
        }
        offset = offset.saturating_add(value.chars().count());
    }
    None
}

fn push_footer_target(
    hitmap: &mut HitMap,
    area: Rect,
    column_offset: u16,
    label: &str,
    action: ClickAction,
) {
    let rect = Rect::new(
        area.x.saturating_add(column_offset),
        area.y,
        u16::try_from(label.chars().count()).unwrap_or(u16::MAX),
        area.height,
    );
    push_rect_target(hitmap, rect, action);
}

fn push_rect_target(hitmap: &mut HitMap, rect: Rect, action: ClickAction) {
    hitmap.push(rect, action, 1);
}

fn daemon_label(model: &Model, compact: bool) -> &str {
    let label = if matches!(model.snapshot_source, SnapshotSource::Socket(_))
        || model.snapshot.daemon.label != "daemon: unknown"
    {
        model.snapshot.daemon.label.as_str()
    } else {
        "daemon: file-mode"
    };
    if compact {
        match label.strip_prefix("daemon: ").unwrap_or(label) {
            "file-mode" => "file",
            compact_label => compact_label,
        }
    } else {
        label
    }
}

fn owner_label(model: &Model, compact: bool) -> String {
    let Some(owner) = &model.snapshot.owner else {
        return String::from("unknown");
    };
    let harness = owner.harness.as_deref().unwrap_or("unknown");
    if compact {
        return format!("Master {harness}");
    }
    let cwd = owner
        .cwd
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| String::from("cwd?"));
    format!("Master {harness} at {cwd}")
}

fn trim_for_header(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let trimmed = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{trimmed}…")
    } else {
        trimmed
    }
}

fn duration_label(duration: std::time::Duration) -> String {
    let seconds = duration.as_secs();
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if hours > 0 {
        format!("{hours}h{minutes:02}m")
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        format!("{seconds}s")
    }
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
