#![allow(dead_code)]

mod agent;
mod commands;
mod config;
mod frontmatter;
mod harness;
mod hook;
mod installer;
mod mapping;
mod pi_extension;
mod project_config;
#[cfg(test)]
mod test_util;
mod resolve;
mod skill;
mod tui;

use anyhow::Result;
use clap::{Parser, Subcommand};

const REPO: &str = "vanillagreencom/vstack";
const GIT_HASH: &str = env!("VSTACK_GIT_HASH");

fn const_format() -> &'static str {
    use std::sync::OnceLock;
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| format!("{} ({})", env!("CARGO_PKG_VERSION"), GIT_HASH))
}

#[derive(Parser)]
#[command(
    name = "vstack",
    version = const_format(),
    about = "Skills, agents, hooks. Cross-harness."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    // Top-level flags that map to `add` when no subcommand given
    /// Source: GitHub repo (owner/repo) or local path
    source: Option<String>,

    /// Install to user-level directory instead of project
    #[arg(short, long)]
    global: bool,

    /// Target specific harnesses (comma-separated): claude,cursor,opencode,codex,pi
    #[arg(long, value_delimiter = ',')]
    harness: Option<Vec<String>>,

    /// Install specific agents by name (comma-separated)
    #[arg(short, long, value_delimiter = ',')]
    agent: Option<Vec<String>>,

    /// Install specific skills by name (comma-separated)
    #[arg(short, long, value_delimiter = ',')]
    skill: Option<Vec<String>>,

    /// Install specific hooks by name (comma-separated)
    #[arg(long, value_delimiter = ',')]
    hook: Option<Vec<String>>,

    /// Install specific Pi extensions by name (comma-separated)
    #[arg(long, value_delimiter = ',', visible_alias = "pi-package")]
    pi_extension: Option<Vec<String>>,

    /// Copy files instead of symlinking
    #[arg(long)]
    copy: bool,

    /// Skip confirmation prompts
    #[arg(short, long)]
    yes: bool,

    /// Install all items to all harnesses
    #[arg(long)]
    all: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Install skills, agents, and hooks
    Add {
        source: Option<String>,
        #[arg(short, long)]
        global: bool,
        /// Target specific harnesses (comma-separated): claude,cursor,opencode,codex,pi
        #[arg(long, value_delimiter = ',')]
        harness: Option<Vec<String>>,
        /// Install specific agents by name (comma-separated)
        #[arg(short, long, value_delimiter = ',')]
        agent: Option<Vec<String>>,
        /// Install specific skills by name (comma-separated)
        #[arg(short, long, value_delimiter = ',')]
        skill: Option<Vec<String>>,
        /// Install specific hooks by name (comma-separated)
        #[arg(long, value_delimiter = ',')]
        hook: Option<Vec<String>>,
        /// Install specific Pi extensions by name (comma-separated)
        #[arg(long, value_delimiter = ',', visible_alias = "pi-package")]
        pi_extension: Option<Vec<String>>,
        #[arg(long)]
        copy: bool,
        #[arg(short, long)]
        yes: bool,
        #[arg(long)]
        all: bool,
    },

    /// Remove installed skills and/or agents
    Remove {
        names: Vec<String>,
        #[arg(short, long)]
        global: bool,
    },

    /// List installed skills and agents
    #[command(alias = "ls")]
    List {
        #[arg(short, long)]
        global: bool,
        /// Filter listing by harness id (claude, cursor, opencode, codex, pi)
        #[arg(long)]
        harness: Option<String>,
    },

    /// Check installation status
    Check,

    /// Update vstack to the latest version
    Update {
        /// Force reinstall even if version matches
        #[arg(short, long)]
        force: bool,
    },

    /// Reinstall all locked items (agents, skills, hooks, Pi packages) from
    /// current source. Use after editing source files to push changes to the
    /// install scope. Also re-applies vstack.toml customizations to agents.
    Refresh {
        #[arg(short, long)]
        global: bool,
    },

    /// Update installed Pi extensions from their source repos and npm.
    /// Walks the per-scope source index plus settings.json npm: entries,
    /// reports stale packages, and (without --check) reinstalls them.
    UpdatePi {
        /// Show plan only; do not modify anything.
        #[arg(short, long)]
        check: bool,
        /// Restrict to one scope: all (default), global, project.
        #[arg(long)]
        scope: Option<String>,
    },

    /// Scaffold a new skill or agent template
    Init { name: Option<String> },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Add {
            source,
            global,
            harness,
            agent,
            skill,
            hook,
            pi_extension,
            copy,
            yes,
            all,
        }) => commands::add::run(
            source,
            global,
            harness,
            agent,
            skill,
            hook,
            pi_extension,
            copy,
            yes,
            all,
        ),
        Some(Commands::Remove { names, global }) => commands::remove::run(&names, global),
        Some(Commands::List { global, harness }) => commands::list::run(global, harness.as_deref()),
        Some(Commands::Check) => commands::check::run(),
        Some(Commands::Update { force }) => commands::update::run(force),
        Some(Commands::Refresh { global }) => commands::refresh::run(global),
        Some(Commands::UpdatePi { check, scope }) => commands::update_pi::run(check, scope),
        Some(Commands::Init { name }) => commands::init::run(name.as_deref()),
        // No subcommand → default to add
        None => commands::add::run(
            cli.source,
            cli.global,
            cli.harness,
            cli.agent,
            cli.skill,
            cli.hook,
            cli.pi_extension,
            cli.copy,
            cli.yes,
            cli.all,
        ),
    }
}
