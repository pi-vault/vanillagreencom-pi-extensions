use std::path::PathBuf;

use color_eyre::eyre::{Context, Result};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::fmt::writer::BoxMakeWriter;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

pub fn init_file_logging() -> Result<WorkerGuard> {
    let log_dir = log_dir()?;
    std::fs::create_dir_all(&log_dir)
        .wrap_err_with(|| format!("failed to create log directory {}", log_dir.display()))?;
    let appender = tracing_appender::rolling::daily(log_dir, "flightdeck-dashboard.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("flightdeck_dashboard=info,flightdeck_dashboard::app=info")
    });
    let subscriber = tracing_subscriber::registry().with(filter).with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(BoxMakeWriter::new(writer)),
    );
    if tracing::subscriber::set_global_default(subscriber).is_err() {
        tracing::debug!("tracing subscriber already initialized");
    }
    Ok(guard)
}

fn log_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("FD_STATE_DIR") {
        return Ok(PathBuf::from(dir));
    }
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        return Ok(PathBuf::from(dir).join("flightdeck"));
    }
    Ok(std::env::temp_dir().join(format!("flightdeck-{}", current_uid())))
}

fn current_uid() -> String {
    std::env::var("UID").unwrap_or_else(|_| String::from("unknown"))
}
