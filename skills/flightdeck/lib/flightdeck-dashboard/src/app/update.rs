use super::command::Cmd;
use super::keymap::{self, Action};
use super::model::{EffectKind, ModalState, Model};
use super::msg::Msg;

const PAGE_STEP: usize = 10;
const TAB_SWITCH_FRAMES: u64 = 3;
const HELP_FADE_FRAMES: u64 = 3;
const ERROR_FLASH_FRAMES: u64 = 4;
const SELECTION_HALO_FRAMES: u64 = 2;

pub fn update(model: &mut Model, msg: Msg) -> Vec<Cmd> {
    match msg {
        Msg::Tick => vec![Cmd::Render],
        Msg::AnimateTick => {
            model.animate_frame = model.animate_frame.saturating_add(1);
            model.prune_effects();
            vec![Cmd::Render]
        }
        Msg::KeyPressed(key) => handle_key(model, &key),
        Msg::Resize(_, _) => vec![Cmd::Render],
        Msg::SnapshotUpdated(snapshot) => {
            model.snapshot = snapshot;
            model.clamp_selection();
            vec![Cmd::Render]
        }
        Msg::Error(error) => {
            model.error = Some(error);
            model.push_effect(EffectKind::ErrorFlash, ERROR_FLASH_FRAMES);
            vec![Cmd::Render]
        }
        Msg::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
    }
}

fn handle_key(model: &mut Model, key: &crossterm::event::KeyEvent) -> Vec<Cmd> {
    let Some(action) = keymap::action_for(key) else {
        return Vec::new();
    };

    if model.show_help
        && !matches!(
            action,
            Action::ToggleHelp | Action::Quit | Action::CloseModal
        )
    {
        return Vec::new();
    }

    match action {
        Action::NextTab => {
            model.current_tab = model.current_tab.next();
            model.push_effect(EffectKind::TabSwitchForward, TAB_SWITCH_FRAMES);
            vec![Cmd::Render]
        }
        Action::PreviousTab => {
            model.current_tab = model.current_tab.previous();
            model.push_effect(EffectKind::TabSwitchBackward, TAB_SWITCH_FRAMES);
            vec![Cmd::Render]
        }
        Action::MoveDown => {
            move_selection(model, 1);
            vec![Cmd::Render]
        }
        Action::MoveUp => {
            move_selection(model, -1);
            vec![Cmd::Render]
        }
        Action::PageDown => {
            move_selection(model, PAGE_STEP as isize);
            vec![Cmd::Render]
        }
        Action::PageUp => {
            move_selection(model, -(PAGE_STEP as isize));
            vec![Cmd::Render]
        }
        Action::First => {
            model.set_selected_index(0);
            model.push_effect(EffectKind::SelectionHalo, SELECTION_HALO_FRAMES);
            vec![Cmd::Render]
        }
        Action::Last => {
            model.set_selected_index(model.max_selection_index());
            model.push_effect(EffectKind::SelectionHalo, SELECTION_HALO_FRAMES);
            vec![Cmd::Render]
        }
        Action::OpenDetail => vec![Cmd::LogAction(format!(
            "detail requested for tab={} row={}",
            model.current_tab.label(),
            model.selected_index()
        ))],
        Action::OpenFilter => {
            model.ui.filter_open = true;
            vec![
                Cmd::LogAction(String::from("filter input opened")),
                Cmd::Render,
            ]
        }
        Action::Reload => vec![Cmd::ReloadDemo(model.demo_fixture.clone())],
        Action::ToggleCompact => {
            model.ui.compact = !model.ui.compact;
            vec![Cmd::Render]
        }
        Action::ToggleHelp => {
            model.show_help = !model.show_help;
            model.modal = if model.show_help {
                ModalState::Help
            } else {
                ModalState::None
            };
            model.push_effect(EffectKind::HelpOverlay, HELP_FADE_FRAMES);
            vec![Cmd::Render]
        }
        Action::Quit => {
            model.quit_requested = true;
            vec![Cmd::Render]
        }
        Action::CloseModal => {
            model.show_help = false;
            model.modal = ModalState::None;
            model.ui.filter_open = false;
            vec![Cmd::Render]
        }
    }
}

fn move_selection(model: &mut Model, delta: isize) {
    let current = model.selected_index();
    let next = current
        .saturating_add_signed(delta)
        .min(model.max_selection_index());
    model.set_selected_index(next);
    model.push_effect(EffectKind::SelectionHalo, SELECTION_HALO_FRAMES);
}
