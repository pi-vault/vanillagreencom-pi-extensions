use ratatui::layout::{Alignment, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::hitmap::{ClickAction, HitMap, ScrollSource};
use crate::app::model::{Model, Tab};
use crate::app::theme::Palette;
use crate::app::view::overview::truncate_end;
use crate::cost::{format_compact, format_cost, format_summary, format_tokens, HarnessTotal};

const SESSION_COL_WIDTH: u16 = 14;
const HARNESS_COL_WIDTH: u16 = 10;
const COST_COL_WIDTH: u16 = 12;

pub fn render(
    frame: &mut Frame<'_>,
    area: Rect,
    model: &Model,
    theme: &Palette,
    hitmap: &mut HitMap,
) {
    hitmap.push(area, ClickAction::ScrollDown(ScrollSource::Costs), 0);
    let totals = &model.cost_totals;
    let mut lines = vec![
        Line::from(Span::styled("Session total", theme.header())),
        Line::from(format!(
            "  {}  ·  {} turns  ·  in {} / out {}  ·  cache write {} / read {}",
            format_cost(totals.grand.cost_usd),
            totals.grand.turns,
            format_tokens(totals.grand.input_tokens),
            format_tokens(totals.grand.output_tokens),
            format_tokens(totals.grand.cache_creation_tokens),
            format_tokens(totals.grand.cache_read_tokens)
        )),
        Line::from(""),
        Line::from(Span::styled("By harness", theme.header())),
    ];
    if totals.by_harness.is_empty() {
        lines.push(Line::from(Span::styled(
            "  no cost source data yet",
            theme.muted(),
        )));
    } else {
        let mut rows = totals.by_harness.iter().collect::<Vec<_>>();
        rows.sort_by(|left, right| left.0.cmp(right.0));
        for (harness, total) in rows {
            lines.push(Line::from(harness_line(harness, total)));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled("By session", theme.header())));
    if model.snapshot.sessions.is_empty() {
        lines.push(Line::from(Span::styled(
            "  no tracked sessions",
            theme.muted(),
        )));
    } else {
        for (idx, session) in model.snapshot.sessions.iter().enumerate() {
            hitmap.push(
                Rect::new(
                    area.x.saturating_add(1),
                    area.y
                        .saturating_add(7 + totals.by_harness.len() as u16 + idx as u16),
                    area.width.saturating_sub(2),
                    1,
                ),
                ClickAction::SelectCostRow(idx),
                0,
            );
            let metrics = model.cost_for_entry(&session.id);
            let cost = metrics.map_or_else(|| String::from("—"), format_compact);
            let usage = metrics.map_or_else(
                || String::from("no cost source"),
                |metrics| {
                    if let Some(error) = &metrics.source_error {
                        format!("error: {error}")
                    } else {
                        format!(
                            "in {} / out {}",
                            format_tokens(metrics.input_tokens),
                            format_tokens(metrics.output_tokens)
                        )
                    }
                },
            );
            let style = if idx == model.selected_index() && model.current_tab == Tab::Costs {
                model.selection_style()
            } else {
                theme.frame()
            };
            let id_cell = pad_or_truncate(&session.id, SESSION_COL_WIDTH);
            let harness_cell = pad_or_truncate(
                session.harness.as_deref().unwrap_or("unknown"),
                HARNESS_COL_WIDTH,
            );
            let cost_cell = pad_or_truncate(&cost, COST_COL_WIDTH);
            lines.push(Line::from(vec![
                Span::styled(format!("  {id_cell}"), style),
                Span::styled(harness_cell, style),
                Span::styled(cost_cell, style),
                Span::styled(usage, style),
            ]));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(format!(
        "Pricing source: {}",
        totals.pricing_source
    )));
    if let Some(last_polled) = totals.last_polled {
        lines.push(Line::from(format!(
            "Last polled: {}",
            last_polled.format("%H:%M:%S")
        )));
    }
    if totals.unhealthy_sources > 0 {
        lines.push(Line::from(Span::styled(
            format!("{} cost source unhealthy", totals.unhealthy_sources),
            theme.warning(),
        )));
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme.border_active())
        .style(theme.panel())
        .title(Span::styled(" Costs ", theme.title()));
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .alignment(Alignment::Left)
            .wrap(Wrap { trim: true }),
        area,
    );
}

fn harness_line(harness: &str, total: &HarnessTotal) -> String {
    format!(
        "  {:<10} {:>2} session{}   {}",
        harness,
        total.sessions,
        if total.sessions == 1 { " " } else { "s" },
        format_summary(&total.metrics)
    )
}

fn pad_or_truncate(value: &str, width: u16) -> String {
    let truncated = truncate_end(value, width);
    let pad = (width as usize).saturating_sub(truncated.chars().count());
    let mut out = truncated;
    out.extend(std::iter::repeat(' ').take(pad));
    out.push(' ');
    out
}
