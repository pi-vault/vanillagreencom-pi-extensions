use ratatui::layout::Rect;
use ratatui::Frame;

use crate::app::model::{Model, Tab};
use crate::app::theme::Theme;

pub fn render(frame: &mut Frame<'_>, area: Rect, _model: &Model, theme: Theme) {
    super::render_placeholder(frame, area, Tab::Merges.placeholder(), theme);
}
