use ratatui::style::{Color, Modifier, Style};

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub frame: Style,
    pub title: Style,
    pub muted: Style,
    pub status: Style,
    pub status_label: Style,
    pub border: Style,
    pub border_active: Style,
    pub tab_active: Style,
    pub tab_inactive: Style,
    pub selection: Style,
    pub header: Style,
    pub footer: Style,
    pub pause: Style,
    pub error: Style,
    pub ok: Style,
    pub warning: Style,
    pub info: Style,
    pub filter: Style,
}

impl Theme {
    #[must_use]
    pub fn dark() -> Self {
        Self {
            frame: Style::default().fg(Color::Gray).bg(Color::Reset),
            title: Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
            muted: Style::default().fg(Color::DarkGray),
            status: Style::default().fg(Color::White).bg(Color::Black),
            status_label: Style::default()
                .fg(Color::LightCyan)
                .add_modifier(Modifier::BOLD),
            border: Style::default().fg(Color::DarkGray),
            border_active: Style::default().fg(Color::Cyan),
            tab_active: Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
            tab_inactive: Style::default().fg(Color::Gray),
            selection: Style::default()
                .fg(Color::Black)
                .bg(Color::LightCyan)
                .add_modifier(Modifier::BOLD),
            header: Style::default()
                .fg(Color::LightBlue)
                .add_modifier(Modifier::BOLD),
            footer: Style::default().fg(Color::DarkGray),
            pause: Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
            error: Style::default()
                .fg(Color::White)
                .bg(Color::Red)
                .add_modifier(Modifier::BOLD),
            ok: Style::default().fg(Color::Green),
            warning: Style::default().fg(Color::Yellow),
            info: Style::default().fg(Color::LightBlue),
            filter: Style::default().fg(Color::Black).bg(Color::Yellow),
        }
    }

    #[must_use]
    pub fn kind_badge(self, kind: &str) -> Style {
        match kind {
            "adhoc" => Style::default()
                .fg(Color::Black)
                .bg(Color::LightBlue)
                .add_modifier(Modifier::BOLD),
            "issue" => Style::default()
                .fg(Color::Black)
                .bg(Color::Magenta)
                .add_modifier(Modifier::BOLD),
            "workflow" => Style::default()
                .fg(Color::Black)
                .bg(Color::LightGreen)
                .add_modifier(Modifier::BOLD),
            _ => self.muted,
        }
    }

    #[must_use]
    pub fn state(self, state: &str) -> Style {
        match state {
            "complete" | "merged" => self.ok,
            "ready" => Style::default().fg(Color::LightGreen),
            "waiting" | "submitting" => self.info,
            "prompting" | "merge-ready" => self.warning,
            "cancelled" | "aborted" => Style::default().fg(Color::LightYellow),
            "dead" => self.error,
            _ => self.muted,
        }
    }
}
