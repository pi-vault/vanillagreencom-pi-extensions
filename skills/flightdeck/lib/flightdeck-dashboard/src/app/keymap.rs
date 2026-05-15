use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    NextTab,
    PreviousTab,
    MoveDown,
    MoveUp,
    PageDown,
    PageUp,
    First,
    Last,
    OpenDetail,
    OpenFilter,
    Reload,
    ToggleCompact,
    ToggleHelp,
    Quit,
    CloseModal,
}

#[derive(Debug, Clone, Copy)]
pub struct KeyBinding {
    pub keys: &'static str,
    pub description: &'static str,
    pub action: Action,
}

pub const BINDINGS: &[KeyBinding] = &[
    KeyBinding {
        keys: "Tab",
        description: "Next tab",
        action: Action::NextTab,
    },
    KeyBinding {
        keys: "Shift+Tab",
        description: "Previous tab",
        action: Action::PreviousTab,
    },
    KeyBinding {
        keys: "j / Down",
        description: "Move selection down",
        action: Action::MoveDown,
    },
    KeyBinding {
        keys: "k / Up",
        description: "Move selection up",
        action: Action::MoveUp,
    },
    KeyBinding {
        keys: "=",
        description: "Page down",
        action: Action::PageDown,
    },
    KeyBinding {
        keys: "-",
        description: "Page up",
        action: Action::PageUp,
    },
    KeyBinding {
        keys: "Home",
        description: "First row",
        action: Action::First,
    },
    KeyBinding {
        keys: "End",
        description: "Last row",
        action: Action::Last,
    },
    KeyBinding {
        keys: "Enter",
        description: "Open detail (placeholder)",
        action: Action::OpenDetail,
    },
    KeyBinding {
        keys: "/",
        description: "Open filter input (placeholder)",
        action: Action::OpenFilter,
    },
    KeyBinding {
        keys: "r",
        description: "Force snapshot reload",
        action: Action::Reload,
    },
    KeyBinding {
        keys: "Alt+M",
        description: "Toggle compact layout",
        action: Action::ToggleCompact,
    },
    KeyBinding {
        keys: "?",
        description: "Toggle help overlay",
        action: Action::ToggleHelp,
    },
    KeyBinding {
        keys: "q / Ctrl+C",
        description: "Quit",
        action: Action::Quit,
    },
];

#[must_use]
pub fn action_for(key: &KeyEvent) -> Option<Action> {
    match key.code {
        KeyCode::Tab => Some(Action::NextTab),
        KeyCode::BackTab => Some(Action::PreviousTab),
        KeyCode::Down | KeyCode::Char('j') => Some(Action::MoveDown),
        KeyCode::Up | KeyCode::Char('k') => Some(Action::MoveUp),
        KeyCode::Char('=') => Some(Action::PageDown),
        KeyCode::Char('-') => Some(Action::PageUp),
        KeyCode::Home => Some(Action::First),
        KeyCode::End => Some(Action::Last),
        KeyCode::Enter => Some(Action::OpenDetail),
        KeyCode::Char('/') => Some(Action::OpenFilter),
        KeyCode::Char('r') => Some(Action::Reload),
        KeyCode::Char('m') | KeyCode::Char('M') if key.modifiers.contains(KeyModifiers::ALT) => {
            Some(Action::ToggleCompact)
        }
        KeyCode::Char('?') => Some(Action::ToggleHelp),
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => Some(Action::Quit),
        KeyCode::Char('q') => Some(Action::Quit),
        KeyCode::Esc => Some(Action::CloseModal),
        _ => None,
    }
}
