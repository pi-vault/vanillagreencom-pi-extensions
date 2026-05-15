use tokio::sync::mpsc;

use crate::app::model::Clock;
use crate::fixtures;

use super::command::Cmd;
use super::msg::Msg;

pub async fn run_commands(commands: Vec<Cmd>, tx: &mpsc::UnboundedSender<Msg>, clock: Clock) {
    for command in commands {
        match command {
            Cmd::Render => {}
            Cmd::ReloadDemo(name) => {
                let msg = match fixtures::load_demo_snapshot(&name, clock()) {
                    Ok(snapshot) => Msg::SnapshotUpdated(snapshot),
                    Err(error) => Msg::Error(error.to_string()),
                };
                send_msg(tx, msg);
            }
            Cmd::LogAction(action) => tracing::info!(action = %action, "dashboard action"),
            Cmd::Spawn(future) => {
                let msg = future.await;
                send_msg(tx, msg);
            }
        }
    }
}

fn send_msg(tx: &mpsc::UnboundedSender<Msg>, msg: Msg) {
    if tx.send(msg).is_err() {
        tracing::debug!("dashboard message receiver dropped");
    }
}
