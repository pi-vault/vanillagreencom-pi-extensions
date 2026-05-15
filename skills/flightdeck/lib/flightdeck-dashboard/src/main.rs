use std::io::{self, IsTerminal, Stdout};
use std::time::Duration;

use clap::Parser;
use color_eyre::eyre::Result;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use flightdeck_dashboard::app::effects;
use flightdeck_dashboard::app::model::{utc_now, Model, MotionLevel};
use flightdeck_dashboard::app::{update, view};
use flightdeck_dashboard::cli::{Cli, Command};
use flightdeck_dashboard::fixtures;
use flightdeck_dashboard::util::logging;
use futures::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use tokio::sync::mpsc;
use tokio::time::MissedTickBehavior;

const ANIMATION_TICK_MS: u64 = 80;
const CLOCK_TICK_MS: u64 = 1_000;

#[tokio::main]
async fn main() -> Result<()> {
    color_eyre::install()?;
    let _log_guard = logging::init_file_logging()?;
    let cli = Cli::parse();
    match cli.command {
        Command::Tui(args) => run_tui(args.demo_name()).await,
        Command::Daemon(_) => not_implemented("daemon"),
        Command::Status(_) => not_implemented("status"),
        Command::Supervise(_) => not_implemented("supervise"),
        Command::Launch(_) => not_implemented("launch"),
    }
}

async fn run_tui(demo_name: &str) -> Result<()> {
    let snapshot = fixtures::load_demo_snapshot(demo_name, utc_now())?;
    let mut model = Model::new(snapshot, demo_name, MotionLevel::from_env(), utc_now);
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        tracing::info!(
            demo = demo_name,
            "non-terminal dashboard smoke render skipped"
        );
        return Ok(());
    }

    let mut terminal = setup_terminal()?;
    let run_result = run_app_loop(&mut terminal, &mut model).await;
    let restore_result = restore_terminal(&mut terminal);
    match (run_result, restore_result) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

async fn run_app_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    model: &mut Model,
) -> Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut events = EventStream::new();
    let mut anim = tokio::time::interval(Duration::from_millis(ANIMATION_TICK_MS));
    anim.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut clock = tokio::time::interval(Duration::from_millis(CLOCK_TICK_MS));
    clock.set_missed_tick_behavior(MissedTickBehavior::Skip);

    terminal.draw(|frame| view::render(frame, model))?;
    loop {
        tokio::select! {
            biased;
            Some(msg) = rx.recv() => {
                let commands = update(model, msg);
                effects::run_commands(commands, &tx, model.clock).await;
            }
            maybe_event = events.next() => {
                if let Some(msg) = event_to_msg(maybe_event) {
                    let commands = update(model, msg);
                    effects::run_commands(commands, &tx, model.clock).await;
                }
            }
            _ = anim.tick(), if model.has_active_effects() => {
                let commands = update(model, flightdeck_dashboard::app::msg::Msg::AnimateTick);
                effects::run_commands(commands, &tx, model.clock).await;
            }
            _ = clock.tick() => {
                let commands = update(model, flightdeck_dashboard::app::msg::Msg::Tick);
                effects::run_commands(commands, &tx, model.clock).await;
            }
            _ = tokio::signal::ctrl_c() => {
                let commands = update(model, flightdeck_dashboard::app::msg::Msg::Quit);
                effects::run_commands(commands, &tx, model.clock).await;
            }
        }
        terminal.draw(|frame| view::render(frame, model))?;
        if model.quit_requested {
            break;
        }
    }
    Ok(())
}

fn event_to_msg(
    event: Option<std::io::Result<Event>>,
) -> Option<flightdeck_dashboard::app::msg::Msg> {
    match event {
        Some(Ok(Event::Key(key))) if key.kind == KeyEventKind::Press => {
            Some(flightdeck_dashboard::app::msg::Msg::KeyPressed(key))
        }
        Some(Ok(Event::Resize(width, height))) => {
            Some(flightdeck_dashboard::app::msg::Msg::Resize(width, height))
        }
        Some(Ok(_)) | None => None,
        Some(Err(error)) => Some(flightdeck_dashboard::app::msg::Msg::Error(
            error.to_string(),
        )),
    }
}

fn setup_terminal() -> Result<Terminal<CrosstermBackend<Stdout>>> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;
    Ok(terminal)
}

fn restore_terminal(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;
    Ok(())
}

fn not_implemented(command: &str) -> Result<()> {
    eprintln!("flightdeck-dashboard {command}: not yet implemented");
    std::process::exit(2);
}
