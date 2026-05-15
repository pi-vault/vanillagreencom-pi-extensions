use futures::future::BoxFuture;

use super::msg::Msg;

pub enum Cmd {
    Render,
    ReloadDemo(String),
    LogAction(String),
    Spawn(BoxFuture<'static, Msg>),
}
