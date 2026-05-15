use crate::app::model::{EffectKind, Model, MotionLevel};
use crate::state::schema::TrackedSession;

const BRAILLE_FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

#[must_use]
pub fn spinner(model: &Model, session: &TrackedSession) -> &'static str {
    if model.motion == MotionLevel::Off || !session.is_transient() {
        return " ";
    }
    let idx = (model.animate_frame as usize) % BRAILLE_FRAMES.len();
    BRAILLE_FRAMES[idx]
}

#[must_use]
pub fn tab_switch_hint(model: &Model) -> &'static str {
    if !model.motion.allows_rich_motion() {
        return "";
    }
    if model
        .active_effects
        .iter()
        .any(|effect| matches!(effect.kind, EffectKind::TabSwitchForward))
    {
        "slide→fade"
    } else if model
        .active_effects
        .iter()
        .any(|effect| matches!(effect.kind, EffectKind::TabSwitchBackward))
    {
        "slide←fade"
    } else {
        ""
    }
}

#[must_use]
pub fn help_alpha_label(model: &Model) -> &'static str {
    if !model.motion.allows_rich_motion() {
        return "static";
    }
    if model
        .active_effects
        .iter()
        .any(|effect| matches!(effect.kind, EffectKind::HelpOverlay))
    {
        "crossfade"
    } else {
        "settled"
    }
}
