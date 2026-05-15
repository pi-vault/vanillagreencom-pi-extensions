use crossterm::event::KeyEvent;

use crate::state::schema::DashboardSnapshot;

#[derive(Debug)]
pub enum Msg {
    Tick,
    AnimateTick,
    KeyPressed(KeyEvent),
    Resize(u16, u16),
    SnapshotUpdated(DashboardSnapshot),
    Error(String),
    Quit,
}
