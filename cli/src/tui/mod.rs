mod multiselect;
mod render;

pub use multiselect::{ItemGroup, RepoOption, SelectItem, Tab, TabbedSelect};

#[derive(PartialEq)]
pub enum SummaryAction {
    Exit,
    InstallMore,
}

pub struct SummaryData {
    pub agents: Vec<String>,
    pub skills: Vec<String>,
    pub hooks: Vec<(String, String)>,
    pub updated: Vec<String>,
    pub harnesses: Vec<String>,
    pub notes: Vec<String>,
    pub method: String,
    pub scope: String,
}

use crate::agent::Agent;
use crate::config::InstallMethod;
use crate::harness::Harness;
use crate::hook::Hook;
use crate::skill::{self, Skill};
use anyhow::Result;
use crossterm::ExecutableCommand;
use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind, MouseEventKind,
};
use crossterm::terminal::{self, EnterAlternateScreen, LeaveAlternateScreen};
use ratatui::prelude::*;
use std::collections::{HashMap, HashSet};
use std::io;

pub struct DiscoveredItems {
    pub agents: Vec<Agent>,
    pub skills: Vec<Skill>,
    pub hooks: Vec<Hook>,
}

pub struct InstallSelections {
    pub agents: Vec<Agent>,
    pub skills: Vec<Skill>,
    pub hooks: Vec<Hook>,
    pub harnesses: Vec<Harness>,
    pub skipped_harnesses: Vec<String>,
    pub global: bool,
    pub method: InstallMethod,
    pub update_cli: bool,
}

pub struct SourceSelectorData {
    pub current_label: String,
    pub options: Vec<RepoOption>,
}

pub enum InstallFlowResult {
    Cancelled,
    Install(InstallSelections),
    SwitchSource(String),
}

pub fn run_install_flow(
    items: DiscoveredItems,
    source_selector: &SourceSelectorData,
) -> Result<InstallFlowResult> {
    if items.agents.is_empty() && items.skills.is_empty() && items.hooks.is_empty() {
        eprintln!("No agents, skills, or hooks found.");
        return Ok(InstallFlowResult::Cancelled);
    }

    let dep_graph = skill::build_dependency_graph(&items.skills);
    let dep_display = build_dep_display(&items.skills, &dep_graph);

    // Load installed state from lock files
    let installed = load_installed_state();
    let has_installed_items = !installed.is_empty();
    let installed_names: std::collections::HashSet<String> = installed.keys().cloned().collect();

    let prev_harnesses: std::collections::HashSet<String> = installed
        .values()
        .flat_map(|info| &info.harnesses)
        .cloned()
        .collect();
    let has_previous = !prev_harnesses.is_empty();

    // Build step 1 once (preserved across back navigation)
    let tabs = build_item_tabs(&items, &dep_display, &installed);
    let step_labels = ["Packages", "Scope", "Harnesses", "Method"];
    let mut step1_select = TabbedSelect::new("Select packages to install", tabs, true)
        .with_step("1/4")
        .with_step_labels(&step_labels)
        .allow_empty_confirm(has_installed_items)
        .with_source_selector(
            source_selector.current_label.clone(),
            source_selector.options.clone(),
        );

    let (
        selected_agents,
        selected_skills,
        selected_hooks,
        update_cli,
        harnesses,
        skipped_harnesses,
        global,
        method,
    ) = 'steps: loop {
        // ── Step 1: Select items (tabbed) ──────────────────────────
        match run_tabbed_select(&mut step1_select, Some((&items.skills, &dep_graph)))? {
            SelectResult::Cancelled => return Ok(InstallFlowResult::Cancelled),
            SelectResult::Back => continue 'steps, // step 1 has no previous — stay
            SelectResult::SwitchSource(source) => {
                return Ok(InstallFlowResult::SwitchSource(source));
            }
            SelectResult::JumpToStep(1) => continue 'steps,
            SelectResult::JumpToStep(_) | SelectResult::Confirmed => {}
        }

        let update_cli = step1_select
            .all_selected()
            .iter()
            .any(|(_, label)| *label == "vstack (cli)");

        let all_selected: Vec<(&str, &str)> = step1_select
            .all_selected()
            .into_iter()
            .filter(|(tab, _)| *tab != "Installed" && !tab.starts_with("Updates"))
            .collect();

        let selected_agents: Vec<Agent> = items
            .agents
            .iter()
            .filter(|a| all_selected.iter().any(|(_, label)| *label == a.name))
            .cloned()
            .collect();

        let selected_skill_names: HashSet<&str> = all_selected
            .iter()
            .filter(|(tab, _)| *tab == "Skills")
            .map(|(_, label)| *label)
            .collect();

        let selected_skills: Vec<Skill> = items
            .skills
            .iter()
            .filter(|s| selected_skill_names.contains(s.name.as_str()))
            .cloned()
            .collect();

        let selected_hooks: Vec<Hook> = items
            .hooks
            .iter()
            .filter(|h| all_selected.iter().any(|(_, label)| *label == h.name))
            .cloned()
            .collect();

        let no_new_selection = selected_agents.is_empty()
            && selected_skills.is_empty()
            && selected_hooks.is_empty()
            && !update_cli;

        let (selected_agents, selected_skills, selected_hooks) =
            if no_new_selection && has_installed_items {
                (
                    items
                        .agents
                        .iter()
                        .filter(|a| installed_names.contains(&a.name))
                        .cloned()
                        .collect(),
                    items
                        .skills
                        .iter()
                        .filter(|s| installed_names.contains(&s.name))
                        .cloned()
                        .collect(),
                    items
                        .hooks
                        .iter()
                        .filter(|h| installed_names.contains(&h.name))
                        .cloned()
                        .collect(),
                )
            } else {
                (selected_agents, selected_skills, selected_hooks)
            };

        if selected_agents.is_empty()
            && selected_skills.is_empty()
            && selected_hooks.is_empty()
            && !update_cli
        {
            return Ok(InstallFlowResult::Cancelled);
        }

        // ── Steps 2, 3 & 4 inner loop ──────────────────────────────
        let (global, harnesses, skipped_harnesses, method) = 'scope_step: loop {
            let scope_tabs = vec![Tab {
                name: "Scope".into(),
                groups: vec![ItemGroup {
                    label: String::new(),
                    items: vec![
                        SelectItem {
                            label: "Project".into(),
                            description: "Install into this repo's harness directories".into(),
                            selected: true,
                            tag: None,
                            suffix: Some("default".into()),
                            locked: false,
                            installed: false,
                            installed_scope: None,
                            outdated: false,
                        },
                        SelectItem {
                            label: "Global".into(),
                            description: "Install into user-level harness directories".into(),
                            selected: false,
                            tag: None,
                            suffix: Some("user".into()),
                            locked: false,
                            installed: false,
                            installed_scope: None,
                            outdated: false,
                        },
                    ],
                }],
            }];

            let mut scope_select = TabbedSelect::new("Install scope", scope_tabs, false)
                .with_step("2/4")
                .with_step_labels(&step_labels)
                .with_source_selector(
                    source_selector.current_label.clone(),
                    source_selector.options.clone(),
                );

            match run_tabbed_select(&mut scope_select, None)? {
                SelectResult::Cancelled => return Ok(InstallFlowResult::Cancelled),
                SelectResult::Back => continue 'steps,
                SelectResult::SwitchSource(source) => {
                    return Ok(InstallFlowResult::SwitchSource(source));
                }
                SelectResult::JumpToStep(1) => continue 'steps,
                SelectResult::JumpToStep(2) => continue 'scope_step,
                SelectResult::JumpToStep(3) | SelectResult::JumpToStep(4) => {}
                SelectResult::JumpToStep(_) => continue 'scope_step,
                SelectResult::Confirmed => {}
            }

            let global = scope_select
                .all_selected()
                .iter()
                .any(|(_, label)| *label == "Global");

            let harness_tabs = vec![Tab {
                name: "Harnesses".into(),
                groups: vec![ItemGroup {
                    label: String::new(),
                    items: Harness::ALL
                        .iter()
                        .map(|h| {
                            let detected = h.is_detected();
                            let previously_used = prev_harnesses.contains(h.id());
                            let disabled = global && !h.supports_global_scope();
                            let pre_selected = if disabled {
                                false
                            } else if has_previous {
                                previously_used
                            } else {
                                detected
                            };
                            let mut suffix_parts = Vec::new();
                            if !h.supports_global_scope() {
                                if global {
                                    suffix_parts.push("disabled in global scope".to_string());
                                } else {
                                    suffix_parts.push("project-only".to_string());
                                }
                            }
                            if previously_used {
                                suffix_parts.push("in use".to_string());
                            } else if detected {
                                suffix_parts.push("detected".to_string());
                            }
                            let suffix = if suffix_parts.is_empty() {
                                None
                            } else {
                                Some(suffix_parts.join(" · "))
                            };
                            SelectItem {
                                label: h.name().to_string(),
                                description: format!("Install to {}", h.id()),
                                selected: pre_selected,
                                tag: None,
                                suffix,
                                locked: disabled,
                                installed: false,
                                installed_scope: None,
                                outdated: false,
                            }
                        })
                        .collect(),
                }],
            }];

            let mut harness_select = TabbedSelect::new("Select harnesses", harness_tabs, true)
                .with_step("3/4")
                .with_step_labels(&step_labels)
                .with_source_selector(
                    source_selector.current_label.clone(),
                    source_selector.options.clone(),
                );

            let (harnesses, method) = 'harness_step: loop {
                match run_tabbed_select(&mut harness_select, None)? {
                    SelectResult::Cancelled => return Ok(InstallFlowResult::Cancelled),
                    SelectResult::Back => continue 'scope_step,
                    SelectResult::SwitchSource(source) => {
                        return Ok(InstallFlowResult::SwitchSource(source));
                    }
                    SelectResult::JumpToStep(1) => continue 'steps,
                    SelectResult::JumpToStep(2) => continue 'scope_step,
                    SelectResult::JumpToStep(3) => continue 'harness_step,
                    SelectResult::JumpToStep(4) => {}
                    SelectResult::JumpToStep(_) => continue 'harness_step,
                    SelectResult::Confirmed => {}
                }

                let harness_selected = harness_select.all_selected();
                let harnesses: Vec<Harness> = harness_selected
                    .iter()
                    .filter_map(|(_, label)| {
                        Harness::from_id(&label.to_lowercase().replace(' ', "-"))
                    })
                    .collect();

                if harnesses.is_empty() {
                    harness_select.flash_message =
                        Some("Select at least one harness to continue".into());
                    continue 'harness_step;
                }

            // ── Step 4: Install method ─────────────────────────────
            let mut summary_lines = vec![
                format!("- Scope: {}", if global { "Global" } else { "Project" }),
                format!(
                    "- Harnesses: {}",
                    harnesses
                        .iter()
                        .map(|h| h.name())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ];
            if global {
                for harness in &harnesses {
                    for path in harness.summary_paths(true) {
                        summary_lines.push(format!(
                            "- {} path: {}",
                            harness.name(),
                            crate::config::display_path(&path)
                        ));
                    }
                }
            }
            if !selected_agents.is_empty() {
                summary_lines.push(format!(
                    "- Agents: {}",
                    selected_agents
                        .iter()
                        .map(|a| a.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if !selected_skills.is_empty() {
                summary_lines.push(format!(
                    "- Skills: {}",
                    selected_skills
                        .iter()
                        .map(|s| s.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if !selected_hooks.is_empty() {
                summary_lines.push(format!(
                    "- Hooks: {}",
                    selected_hooks
                        .iter()
                        .map(|h| h.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }

            let method_tabs = vec![Tab {
                name: "Method".into(),
                groups: vec![ItemGroup {
                    label: String::new(),
                    items: vec![
                        SelectItem {
                            label: "Symlink".into(),
                            description: "Single source of truth — recommended".into(),
                            selected: true,
                            tag: None,
                            suffix: Some("recommended".into()),
                            locked: false,
                            installed: false,
                            installed_scope: None,
                            outdated: false,
                        },
                        SelectItem {
                            label: "Copy".into(),
                            description: "Duplicate files to each harness directory".into(),
                            selected: false,
                            tag: None,
                            suffix: None,
                            locked: false,
                            installed: false,
                            installed_scope: None,
                            outdated: false,
                        },
                    ],
                }],
            }];

            let mut select = TabbedSelect::new("Installation method", method_tabs, false)
                .with_step("4/4")
                .with_step_labels(&step_labels)
                .with_source_selector(
                    source_selector.current_label.clone(),
                    source_selector.options.clone(),
                );
            select = select.with_confirm_summary(summary_lines.join("\n"));

            match run_tabbed_select(&mut select, None)? {
                SelectResult::Cancelled => return Ok(InstallFlowResult::Cancelled),
                SelectResult::Back => continue 'harness_step, // back to step 3
                SelectResult::SwitchSource(source) => {
                    return Ok(InstallFlowResult::SwitchSource(source));
                }
                SelectResult::JumpToStep(1) => continue 'steps,
                SelectResult::JumpToStep(2) => continue 'scope_step,
                SelectResult::JumpToStep(3) => continue 'harness_step,
                SelectResult::JumpToStep(4) => continue,
                SelectResult::JumpToStep(_) => continue 'harness_step,
                SelectResult::Confirmed => {
                    let method_selected = select.all_selected();
                    let method = if method_selected.iter().any(|(_, l)| *l == "Copy") {
                        InstallMethod::Copy
                    } else {
                        InstallMethod::Symlink
                    };
                    break 'harness_step (harnesses, method);
                }
            }
            }; // end harness_step

            break 'scope_step (global, harnesses, Vec::new(), method);
        }; // end scope_step

        break 'steps (
            selected_agents,
            selected_skills,
            selected_hooks,
            update_cli,
            harnesses,
            skipped_harnesses,
            global,
            method,
        );
    };

    Ok(InstallFlowResult::Install(InstallSelections {
        agents: selected_agents,
        skills: selected_skills,
        hooks: selected_hooks,
        harnesses,
        skipped_harnesses,
        global,
        method,
        update_cli,
    }))
}

/// Build tabs for the item selection step
struct InstalledInfo {
    scope: String,
    harnesses: Vec<String>,
    kind: Option<crate::config::ItemKind>,
    installed_at: String,
}

type InstalledState = HashMap<String, InstalledInfo>;
type DependencyContext<'a> = (&'a [Skill], &'a HashMap<String, Vec<String>>);

fn load_installed_state() -> InstalledState {
    let mut state = InstalledState::new();

    // Project lock file
    let project_lock = crate::config::lock_file_path(false);
    if let Ok(lock) = crate::config::LockFile::load(&project_lock) {
        for (name, entry) in &lock.entries {
            state.insert(
                name.clone(),
                InstalledInfo {
                    scope: "project".into(),
                    harnesses: entry.harnesses.clone(),
                    kind: Some(entry.kind),
                    installed_at: entry.installed_at.clone(),
                },
            );
        }
    }

    // Global lock file
    let global_lock = crate::config::lock_file_path(true);
    if let Ok(lock) = crate::config::LockFile::load(&global_lock) {
        for (name, entry) in &lock.entries {
            state
                .entry(name.clone())
                .and_modify(|info| {
                    info.scope = format!("{}+global", info.scope);
                    // Keep the earlier installed_at (more conservative for staleness)
                    if entry.installed_at < info.installed_at {
                        info.installed_at = entry.installed_at.clone();
                    }
                    for h in &entry.harnesses {
                        if !info.harnesses.contains(h) {
                            info.harnesses.push(h.clone());
                        }
                    }
                })
                .or_insert(InstalledInfo {
                    scope: "global".into(),
                    harnesses: entry.harnesses.clone(),
                    kind: Some(entry.kind),
                    installed_at: entry.installed_at.clone(),
                });
        }
    }

    state
}

/// Parse an ISO 8601 timestamp (e.g. "2026-03-31T18:07:36Z") into a SystemTime.
pub fn parse_installed_at(ts: &str) -> Option<std::time::SystemTime> {
    // Quick parse: YYYY-MM-DDTHH:MM:SSZ → seconds since epoch via manual calendar math.
    // Falls back to None on any malformed input.
    let b = ts.as_bytes();
    if b.len() < 20 || b[19] != b'Z' {
        return None;
    }
    let year: u64 = ts[0..4].parse().ok()?;
    let mon: u64 = ts[5..7].parse().ok()?;
    let day: u64 = ts[8..10].parse().ok()?;
    let hour: u64 = ts[11..13].parse().ok()?;
    let min: u64 = ts[14..16].parse().ok()?;
    let sec: u64 = ts[17..19].parse().ok()?;

    // Days from year
    let mut days = 0u64;
    for y in 1970..year {
        days += if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 366 } else { 365 };
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 0..(mon.saturating_sub(1) as usize) {
        days += month_days[m] as u64;
    }
    days += day.saturating_sub(1);

    let total_secs = days * 86400 + hour * 3600 + min * 60 + sec;
    // Add 1 second to compensate for sub-second truncation in now_iso().
    // Files written in the same second as installed_at will have sub-second
    // mtime precision (e.g. T.270s) that appears newer than the whole-second
    // installed_at (T.000s).  The 1s buffer prevents false "outdated" flags.
    Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(total_secs + 1))
}

/// Check if any file under `dir` has been modified after `since`.
pub fn dir_modified_after(dir: &std::path::Path, since: std::time::SystemTime) -> bool {
    for entry in walkdir::WalkDir::new(dir).min_depth(1) {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(meta) = entry.metadata()
            && let Ok(mtime) = meta.modified()
            && mtime > since
        {
            return true;
        }
    }
    false
}

/// Check if a single file has been modified after `since`.
pub fn file_modified_after(path: &std::path::Path, since: std::time::SystemTime) -> bool {
    path.metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .is_some_and(|mtime| mtime > since)
}

/// Check if a skill's source directory was modified after install.
fn is_skill_outdated(source_dir: &std::path::Path, info: &InstalledInfo) -> bool {
    let Some(installed_at) = parse_installed_at(&info.installed_at) else {
        return false;
    };
    dir_modified_after(source_dir, installed_at)
}

/// Check if a hook's source file was modified after install.
fn is_hook_outdated(source_path: &std::path::Path, info: &InstalledInfo) -> bool {
    let Some(installed_at) = parse_installed_at(&info.installed_at) else {
        return false;
    };
    file_modified_after(source_path, installed_at)
}

/// Check if an agent's source file was modified after install.
fn is_agent_outdated(source_path: &std::path::Path, info: &InstalledInfo) -> bool {
    let Some(installed_at) = parse_installed_at(&info.installed_at) else {
        return false;
    };
    file_modified_after(source_path, installed_at)
}

fn installed_scope_label(scope: &str) -> String {
    match scope {
        "project+global" => "both".into(),
        other => other.to_string(),
    }
}

fn build_item_tabs(
    items: &DiscoveredItems,
    dep_display: &HashMap<String, String>,
    installed: &InstalledState,
) -> Vec<Tab> {
    let mut tabs = Vec::new();

    // Derive source repo vstack.toml and project vstack.toml paths.
    // Changes to either affect agent generation (skill/hook assignments,
    // guidance, instructions), so agents should be flagged as outdated.
    let source_config = items
        .agents
        .first()
        .map(|a| a.source_path.parent().and_then(|p| p.parent()))
        .flatten()
        .or_else(|| {
            items
                .skills
                .first()
                .map(|s| s.source_dir.parent().and_then(|p| p.parent()))
                .flatten()
        })
        .map(|root| root.join("vstack.toml"));
    let project_config_path = crate::config::project_root().join("vstack.toml");

    // ── Agents tab ───────────────────────────────────────────────────
    if !items.agents.is_empty() {
        let mut engineers = Vec::new();
        let mut reviewers = Vec::new();
        let mut managers = Vec::new();

        for a in &items.agents {
            let installed_info = installed.get(&a.name);
            let is_installed = installed_info.is_some();
            let agent_outdated = installed_info.is_some_and(|info| {
                if is_agent_outdated(&a.source_path, info) {
                    return true;
                }
                let Some(installed_at) = parse_installed_at(&info.installed_at) else {
                    return false;
                };
                if let Some(ref cfg) = source_config {
                    if file_modified_after(cfg, installed_at) {
                        return true;
                    }
                }
                file_modified_after(&project_config_path, installed_at)
            });
            let item = SelectItem {
                label: a.name.clone(),
                description: a.description.clone(),
                selected: false,
                tag: None,
                suffix: None,
                locked: false,
                installed: is_installed,
                installed_scope: installed_info.map(|info| installed_scope_label(&info.scope)),
                outdated: agent_outdated,
            };
            match a.role {
                crate::agent::AgentRole::Engineer => engineers.push(item),
                crate::agent::AgentRole::Reviewer => reviewers.push(item),
                crate::agent::AgentRole::Manager => managers.push(item),
            }
        }

        let mut groups = Vec::new();
        if !engineers.is_empty() {
            groups.push(ItemGroup {
                label: "Engineers".into(),
                items: engineers,
            });
        }
        if !reviewers.is_empty() {
            groups.push(ItemGroup {
                label: "Reviewers".into(),
                items: reviewers,
            });
        }
        if !managers.is_empty() {
            groups.push(ItemGroup {
                label: "Managers".into(),
                items: managers,
            });
        }

        tabs.push(Tab {
            name: "Agents".into(),
            groups,
        });
    }

    // ── Skills tab ───────────────────────────────────────────────────
    if !items.skills.is_empty() {
        let mut rust = Vec::new();
        let mut perf = Vec::new();
        let mut ui = Vec::new();
        let mut workflow = Vec::new();

        for s in &items.skills {
            let installed_info = installed.get(&s.name);
            let is_installed = installed_info.is_some();
            let item = SelectItem {
                label: s.name.clone(),
                description: s.description.clone(),
                selected: false,
                tag: None,
                suffix: dep_display.get(&s.name).cloned(),
                locked: false,
                installed: is_installed,
                installed_scope: installed_info.map(|info| installed_scope_label(&info.scope)),
                outdated: installed_info.is_some_and(|info| {
                    if is_skill_outdated(&s.source_dir, info) {
                        return true;
                    }
                    // Project vstack.toml can inject skill-instructions into SKILL.md
                    let Some(installed_at) = parse_installed_at(&info.installed_at) else {
                        return false;
                    };
                    file_modified_after(&project_config_path, installed_at)
                }),
            };

            if s.name.starts_with("rust-") {
                rust.push(item);
            } else if s.name.starts_with("perf-") {
                perf.push(item);
            } else if matches!(
                s.name.as_str(),
                "iced-rs" | "price-handling" | "trading-design"
            ) {
                ui.push(item);
            } else {
                workflow.push(item);
            }
        }

        let mut groups = Vec::new();
        if !rust.is_empty() {
            groups.push(ItemGroup {
                label: "Rust".into(),
                items: rust,
            });
        }
        if !perf.is_empty() {
            groups.push(ItemGroup {
                label: "Performance".into(),
                items: perf,
            });
        }
        if !ui.is_empty() {
            groups.push(ItemGroup {
                label: "UI / Domain".into(),
                items: ui,
            });
        }
        if !workflow.is_empty() {
            groups.push(ItemGroup {
                label: "Workflow".into(),
                items: workflow,
            });
        }

        tabs.push(Tab {
            name: "Skills".into(),
            groups,
        });
    }

    // ── Hooks tab ────────────────────────────────────────────────────
    if !items.hooks.is_empty() {
        let items_list: Vec<SelectItem> = items
            .hooks
            .iter()
            .map(|h| {
                let installed_info = installed.get(&h.name);
                let is_installed = installed_info.is_some();
                SelectItem {
                    label: h.name.clone(),
                    description: h.description.clone(),
                    selected: false,
                    tag: None,
                    suffix: Some(h.event.clone()),
                    locked: false,
                    installed: is_installed,
                    installed_scope: installed_info.map(|info| installed_scope_label(&info.scope)),
                    outdated: installed_info
                        .is_some_and(|info| is_hook_outdated(&h.source_path, info)),
                }
            })
            .collect();

        tabs.push(Tab {
            name: "Hooks".into(),
            groups: vec![ItemGroup {
                label: String::new(),
                items: items_list,
            }],
        });
    }

    // ── Installed tab ─────────────────────────────────────────
    if !installed.is_empty() {
        let mut project_agents = Vec::new();
        let mut project_skills = Vec::new();
        let mut project_hooks = Vec::new();
        let mut global_agents = Vec::new();
        let mut global_skills = Vec::new();
        let mut global_hooks = Vec::new();
        let mut both_agents = Vec::new();
        let mut both_skills = Vec::new();
        let mut both_hooks = Vec::new();

        let mut sorted: Vec<_> = installed.iter().collect();
        sorted.sort_by_key(|(name, _)| (*name).clone());

        for (name, info) in sorted {
            let h = info.harnesses.join(", ");
            let installed_scope = installed_scope_label(&info.scope);
            let item = SelectItem {
                label: name.clone(),
                description: format!("[{h}]"),
                selected: false,
                tag: None,
                suffix: None,
                locked: false,
                installed: true,
                installed_scope: Some(installed_scope.clone()),
                outdated: false,
            };
            match (installed_scope.as_str(), info.kind) {
                ("project", Some(crate::config::ItemKind::Agent)) => project_agents.push(item),
                ("project", Some(crate::config::ItemKind::Hook)) => project_hooks.push(item),
                ("project", _) => project_skills.push(item),
                ("global", Some(crate::config::ItemKind::Agent)) => global_agents.push(item),
                ("global", Some(crate::config::ItemKind::Hook)) => global_hooks.push(item),
                ("global", _) => global_skills.push(item),
                ("both", Some(crate::config::ItemKind::Agent)) => both_agents.push(item),
                ("both", Some(crate::config::ItemKind::Hook)) => both_hooks.push(item),
                ("both", _) => both_skills.push(item),
                (_, Some(crate::config::ItemKind::Agent)) => project_agents.push(item),
                (_, Some(crate::config::ItemKind::Hook)) => project_hooks.push(item),
                _ => project_skills.push(item),
            }
        }

        let mut groups = Vec::new();
        if !project_agents.is_empty() {
            groups.push(ItemGroup {
                label: "Project / Agents".into(),
                items: project_agents,
            });
        }
        if !project_skills.is_empty() {
            groups.push(ItemGroup {
                label: "Project / Skills".into(),
                items: project_skills,
            });
        }
        if !project_hooks.is_empty() {
            groups.push(ItemGroup {
                label: "Project / Hooks".into(),
                items: project_hooks,
            });
        }
        if !global_agents.is_empty() {
            groups.push(ItemGroup {
                label: "Global / Agents".into(),
                items: global_agents,
            });
        }
        if !global_skills.is_empty() {
            groups.push(ItemGroup {
                label: "Global / Skills".into(),
                items: global_skills,
            });
        }
        if !global_hooks.is_empty() {
            groups.push(ItemGroup {
                label: "Global / Hooks".into(),
                items: global_hooks,
            });
        }
        if !both_agents.is_empty() {
            groups.push(ItemGroup {
                label: "Both / Agents".into(),
                items: both_agents,
            });
        }
        if !both_skills.is_empty() {
            groups.push(ItemGroup {
                label: "Both / Skills".into(),
                items: both_skills,
            });
        }
        if !both_hooks.is_empty() {
            groups.push(ItemGroup {
                label: "Both / Hooks".into(),
                items: both_hooks,
            });
        }

        if !groups.is_empty() {
            tabs.push(Tab {
                name: "Installed".into(),
                groups,
            });
        }
    }

    // ── Updates tab ───────────────────────────────────────────
    // Collect outdated items from the tabs we just built
    let mut update_items: Vec<SelectItem> = Vec::new();

    for tab in &tabs {
        if tab.name == "Installed" {
            continue;
        }
        for group in &tab.groups {
            for item in &group.items {
                if item.outdated {
                    update_items.push(SelectItem {
                        label: item.label.clone(),
                        description: item.description.clone(),
                        selected: false,
                        tag: None,
                        suffix: item.suffix.clone(),
                        locked: false,
                        installed: true,
                        installed_scope: item.installed_scope.clone(),
                        outdated: true,
                    });
                }
            }
        }
    }

    // Check for CLI binary update
    let cli_update = check_for_update();
    if let Some(ref info) = cli_update {
        update_items.push(SelectItem {
            label: "vstack (cli)".into(),
            description: format!("Binary update: {info}"),
            selected: false,
            tag: None,
            suffix: Some("binary".into()),
            locked: false,
            installed: true,
            installed_scope: Some("global".into()),
            outdated: true,
        });
    }

    if !update_items.is_empty() {
        // Split into content updates and CLI update
        let content_items: Vec<SelectItem> = update_items
            .iter()
            .filter(|i| i.label != "vstack (cli)")
            .cloned()
            .collect();
        let cli_items: Vec<SelectItem> = update_items
            .into_iter()
            .filter(|i| i.label == "vstack (cli)")
            .collect();

        let mut groups = Vec::new();
        if !content_items.is_empty() {
            groups.push(ItemGroup {
                label: "Content".into(),
                items: content_items,
            });
        }
        if !cli_items.is_empty() {
            groups.push(ItemGroup {
                label: "CLI".into(),
                items: cli_items,
            });
        }

        let count: usize = groups.iter().map(|g| g.items.len()).sum();
        tabs.insert(
            0,
            Tab {
                name: format!("Updates ({count})"),
                groups,
            },
        );
    }

    tabs
}

/// Check for CLI binary update (quick, non-blocking)
fn check_for_update() -> Option<String> {
    let local = env!("CARGO_PKG_VERSION");
    let remote = crate::commands::update::get_remote_version_with_timeout(
        std::time::Duration::from_millis(1500),
    )?;
    if remote != local {
        Some(format!("{} → {}", local, remote))
    } else {
        None
    }
}

fn build_dep_display(
    skills: &[Skill],
    graph: &HashMap<String, Vec<String>>,
) -> HashMap<String, String> {
    let mut display = HashMap::new();

    for skill in skills {
        let mut parts = Vec::new();

        if let Some(deps) = graph.get(&skill.name) {
            parts.push(format!("requires: {}", deps.join(", ")));
        }

        let optional: Vec<_> = skill
            .resolved_deps
            .iter()
            .filter(|d| d.optional)
            .map(|d| d.name.as_str())
            .collect();
        if !optional.is_empty() {
            parts.push(format!("optional: {}", optional.join(", ")));
        }

        if !parts.is_empty() {
            display.insert(skill.name.clone(), parts.join(" | "));
        }
    }

    display
}

#[derive(PartialEq)]
enum SelectResult {
    Confirmed,
    Cancelled,
    Back,
    JumpToStep(usize),
    SwitchSource(String),
}

fn current_step(select: &TabbedSelect) -> Option<usize> {
    let (cur, _) = select.step_position()?;
    Some(cur)
}

fn is_final_step(select: &TabbedSelect) -> bool {
    matches!(select.step_position(), Some((cur, tot)) if cur == tot)
}

fn try_confirm_select(select: &mut TabbedSelect) -> Result<Option<SelectResult>> {
    if is_final_step(select)
        && select.confirm_dialog.is_none()
        && let Some(summary) = select.confirm_summary.clone()
    {
        let method = select
            .all_selected()
            .into_iter()
            .find(|(tab, _)| *tab == "Method")
            .map(|(_, label)| label.to_string())
            .unwrap_or_else(|| "Symlink".into());
        select.confirm_dialog = Some((
            format!("{summary}\n- Method: {method}\n\nApply these changes?"),
            multiselect::ConfirmAction::Proceed,
        ));
        select.confirm_dialog_scroll = 0;
        return Ok(None);
    }

    // Sync Updates tab selections to source tabs
    if let Some(ui) = select
        .tabs
        .iter()
        .position(|t| t.name.starts_with("Updates"))
    {
        let names: HashSet<String> = select.tabs[ui]
            .groups
            .iter()
            .flat_map(|g| &g.items)
            .filter(|i| i.selected)
            .map(|i| i.label.clone())
            .collect();
        for tab in &mut select.tabs {
            if tab.name == "Installed" || tab.name.starts_with("Updates") {
                continue;
            }
            for group in &mut tab.groups {
                for item in &mut group.items {
                    if names.contains(item.label.as_str()) {
                        item.selected = true;
                    }
                }
            }
        }
    }

    // Check if CLI update is selected
    let cli_selected = select
        .tabs
        .iter()
        .flat_map(|t| &t.groups)
        .flat_map(|g| &g.items)
        .any(|i| i.label == "vstack (cli)" && i.selected);

    if select.multi {
        let install_count = select
            .tabs
            .iter()
            .filter(|t| t.name != "Installed" && !t.name.starts_with("Updates"))
            .flat_map(|t| &t.groups)
            .flat_map(|g| &g.items)
            .filter(|i| i.selected)
            .count();

        if install_count == 0 && !cli_selected && !select.allow_empty_confirm {
            select.flash_message = Some("Select at least one item to continue".into());
            return Ok(None);
        }

        // CLI-only: run binary update directly
        if install_count == 0 && cli_selected {
            io::stdout().execute(LeaveAlternateScreen)?;
            terminal::disable_raw_mode()?;
            eprintln!("Updating vstack...\n");
            let _ = crate::commands::update::run(false);
            eprintln!("\nRestart vstack to use the new version.");
            std::process::exit(0);
        }
    }

    Ok(Some(SelectResult::Confirmed))
}

/// Run a tabbed select UI.
fn run_tabbed_select(
    select: &mut TabbedSelect,
    dep_context: Option<DependencyContext<'_>>,
) -> Result<SelectResult> {
    terminal::enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    io::stdout().execute(EnableMouseCapture)?;

    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let multi = select.multi;
    let mut last_click: Option<std::time::Instant> = None;

    let result = loop {
        terminal.draw(|f| render::draw_tabbed_select(f, select))?;

        match event::read()? {
            Event::Mouse(mouse) => {
                use ratatui::layout::Position;
                let pos = Position {
                    x: mouse.column,
                    y: mouse.row,
                };

                match mouse.kind {
                    MouseEventKind::ScrollUp => {
                        if select.confirm_dialog.is_some() {
                            select.confirm_dialog_scroll =
                                select.confirm_dialog_scroll.saturating_sub(1);
                        } else if select.layout_list.contains(pos) {
                            select.scroll_up(3);
                        }
                    }
                    MouseEventKind::ScrollDown => {
                        if select.confirm_dialog.is_some() {
                            select.confirm_dialog_scroll =
                                select.confirm_dialog_scroll.saturating_add(1);
                        } else if select.layout_list.contains(pos) {
                            select.scroll_down(3);
                        }
                    }
                    MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                        // Repo dialog clicks
                        if let Some(dialog) = select.repo_dialog.as_mut() {
                            let inner = select.repo_dialog_inner;
                            if !dialog.input_mode && inner.contains(pos) {
                                let row = (pos.y - inner.y) as usize;
                                let total_options = dialog.options.len();
                                if row < total_options {
                                    let source =
                                        dialog.options[row].source.clone();
                                    select.repo_dialog = None;
                                    break SelectResult::SwitchSource(source);
                                } else if row == total_options {
                                    // "+ Add repo by link"
                                    dialog.input_mode = true;
                                    dialog.input.clear();
                                }
                            }
                            continue;
                        }

                        if select.source_chip_area.contains(pos)
                            && !select.source_options.is_empty()
                        {
                            select.open_repo_dialog();
                        } else if select.action_button_area.contains(pos) && is_final_step(select) {
                            select.action_button_focused = true;
                            if let Some(result) = try_confirm_select(select)? {
                                break result;
                            }
                        } else if let Some((idx, _)) = select
                            .step_hit_areas
                            .iter()
                            .enumerate()
                            .find(|(_, area)| area.contains(pos))
                        {
                            let target_step = idx + 1;
                            if let Some(cur_step) = current_step(select) {
                                select.action_button_focused = false;
                                if target_step < cur_step {
                                    break SelectResult::JumpToStep(target_step);
                                }
                                if target_step > cur_step
                                    && try_confirm_select(select)?.is_some()
                                {
                                    break SelectResult::JumpToStep(target_step);
                                }
                            }
                        } else if select.layout_tab_bar.contains(pos) && select.tabs.len() > 1 {
                            // Tab bar click
                            for (i, area) in select.tab_hit_areas.iter().enumerate() {
                                if area.contains(pos) {
                                    select.active_tab = i;
                                    select.cursor = 0;
                                    select.scroll = 0;
                                    select.action_button_focused = false;
                                    break;
                                }
                            }
                        } else if select.layout_list.contains(pos) {
                            // List area click
                            let visual_row = (mouse.row - select.layout_list.y) as usize;
                            if let Some(idx) = visual_row_to_item(select, visual_row) {
                                select.action_button_focused = false;
                                let is_same = select.cursor == idx;
                                select.cursor = idx;
                                let now = std::time::Instant::now();
                                if is_same {
                                    if let Some(prev) = last_click {
                                        if now.duration_since(prev).as_millis() < 400 {
                                            select.toggle();
                                            last_click = None;
                                        } else {
                                            last_click = Some(now);
                                        }
                                    } else {
                                        last_click = Some(now);
                                    }
                                } else {
                                    last_click = Some(now);
                                }
                            }
                        }
                    }
                    _ => {}
                }
                continue;
            }
            Event::Key(key) => {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                // Clear flash message on any keypress
                select.flash_message = None;

                if let Some(dialog) = select.repo_dialog.as_mut() {
                    if dialog.input_mode {
                        match key.code {
                            KeyCode::Esc => select.repo_dialog = None,
                            KeyCode::Backspace => {
                                dialog.input.pop();
                            }
                            KeyCode::Enter => {
                                let source = dialog.input.trim().to_string();
                                if source.is_empty() {
                                    select.flash_message = Some("Enter a repo or URL".into());
                                } else {
                                    select.repo_dialog = None;
                                    break SelectResult::SwitchSource(source);
                                }
                            }
                            KeyCode::Char(c) => dialog.input.push(c),
                            _ => {}
                        }
                    } else {
                        let add_index = dialog.options.len();
                        match key.code {
                            KeyCode::Esc => select.repo_dialog = None,
                            KeyCode::Up => {
                                if dialog.cursor > 0 {
                                    dialog.cursor -= 1;
                                }
                            }
                            KeyCode::Down => {
                                if dialog.cursor < add_index {
                                    dialog.cursor += 1;
                                }
                            }
                            KeyCode::Enter => {
                                if dialog.cursor == add_index {
                                    dialog.input_mode = true;
                                    dialog.input.clear();
                                } else if let Some(option) = dialog.options.get(dialog.cursor) {
                                    let source = option.source.clone();
                                    select.repo_dialog = None;
                                    break SelectResult::SwitchSource(source);
                                }
                            }
                            KeyCode::Char('x') | KeyCode::Delete => {
                                if dialog.cursor == add_index {
                                    // Can't remove the "+ Add" row
                                } else if let Some(option) = dialog.options.get(dialog.cursor) {
                                    let source = option.source.clone();
                                    let label = option.label.clone();
                                    let packages = packages_from_source(&source);
                                    select.repo_dialog = None;
                                    if packages.is_empty() {
                                        forget_source(select, &source);
                                        select.flash_message =
                                            Some(format!("Removed source: {label}"));
                                        select.open_repo_dialog();
                                    } else {
                                        let pkg_list = packages.join(", ");
                                        let n = packages.len();
                                        select.confirm_dialog = Some((
                                            format!(
                                                "Remove source \"{label}\"?\n\n\
                                                 {n} package(s) installed from this source:\n\
                                                 {pkg_list}\n\n\
                                                 Press enter to uninstall and remove, or esc to cancel."
                                            ),
                                            multiselect::ConfirmAction::RemoveSource {
                                                source,
                                                packages,
                                            },
                                        ));
                                        select.confirm_dialog_scroll = 0;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    continue;
                }

                // Handle confirm dialog (modal — intercepts all input)
                if select.confirm_dialog.is_some() {
                    match key.code {
                        KeyCode::Up => {
                            select.confirm_dialog_scroll =
                                select.confirm_dialog_scroll.saturating_sub(1);
                        }
                        KeyCode::Down => {
                            select.confirm_dialog_scroll =
                                select.confirm_dialog_scroll.saturating_add(1);
                        }
                        KeyCode::Enter => {
                            let (_, action) = select.confirm_dialog.take().unwrap();
                            select.confirm_dialog_scroll = 0;
                            match action {
                                multiselect::ConfirmAction::Proceed => {
                                    break SelectResult::Confirmed;
                                }
                                multiselect::ConfirmAction::UpdateAll => {
                                    // Collect update names
                                    let names: HashSet<String> = select
                                        .tabs
                                        .iter()
                                        .find(|t| t.name.starts_with("Updates"))
                                        .map(|t| {
                                            t.groups
                                                .iter()
                                                .flat_map(|g| &g.items)
                                                .map(|i| i.label.clone())
                                                .collect()
                                        })
                                        .unwrap_or_default();

                                    let has_cli = names.iter().any(|name| name == "vstack (cli)");
                                    let has_content = names.iter().any(|n| n != "vstack (cli)");

                                    // CLI-only: run binary update directly
                                    if has_cli && !has_content {
                                        io::stdout().execute(DisableMouseCapture)?;
                                        io::stdout().execute(LeaveAlternateScreen)?;
                                        terminal::disable_raw_mode()?;
                                        eprintln!("Updating vstack...\n");
                                        let _ = crate::commands::update::run(false);
                                        eprintln!("\nRestart vstack to use the new version.");
                                        std::process::exit(0);
                                    }

                                    // Select items in Updates tab + source tabs
                                    for tab in &mut select.tabs {
                                        for group in &mut tab.groups {
                                            for item in &mut group.items {
                                                if names.contains(item.label.as_str()) {
                                                    item.selected = true;
                                                }
                                            }
                                        }
                                    }

                                    // Proceed directly to install
                                    break SelectResult::Confirmed;
                                }
                                multiselect::ConfirmAction::UninstallAll => {
                                    let names: Vec<String> = select
                                        .tabs
                                        .iter()
                                        .find(|t| t.name == "Installed")
                                        .map(|t| {
                                            t.groups
                                                .iter()
                                                .flat_map(|g| &g.items)
                                                .map(|i| i.label.clone())
                                                .collect()
                                        })
                                        .unwrap_or_default();
                                    let n = names.len();
                                    remove_installed_items(select, &names);
                                    select.flash_message = Some(format!("Uninstalled {n} item(s)"));
                                }
                                multiselect::ConfirmAction::RemoveSource {
                                    source,
                                    packages,
                                } => {
                                    remove_installed_items(select, &packages);
                                    forget_source(select, &source);
                                    let n = packages.len();
                                    select.flash_message = Some(format!(
                                        "Removed source and uninstalled {n} package(s)"
                                    ));
                                }
                            }
                        }
                        KeyCode::Esc => {
                            select.confirm_dialog = None;
                            select.confirm_dialog_scroll = 0;
                        }
                        _ => {}
                    }
                    continue;
                }

                match key.code {
                    KeyCode::Up => {
                        if is_final_step(select) && select.action_button_focused {
                            select.action_button_focused = false;
                        } else {
                            select.move_up();
                        }
                    }
                    KeyCode::Down => {
                        if is_final_step(select) && !select.action_button_focused {
                            let last_index = select.item_count().saturating_sub(1);
                            if select.item_count() > 0 && select.cursor >= last_index {
                                select.action_button_focused = true;
                            } else {
                                select.move_down();
                            }
                        } else if !is_final_step(select) {
                            select.move_down();
                        }
                    }
                    KeyCode::Tab => select.next_tab(),
                    KeyCode::BackTab => select.prev_tab(),
                    KeyCode::Left => break SelectResult::Back,
                    KeyCode::Char('r') | KeyCode::Char('R')
                        if !select.source_options.is_empty() =>
                    {
                        select.open_repo_dialog();
                    }
                    KeyCode::Enter | KeyCode::Char(' ') => {
                        if is_final_step(select) && select.action_button_focused {
                            if let Some(result) = try_confirm_select(select)? {
                                break result;
                            }
                            continue;
                        }

                        let cur_tab_name = select.tabs[select.active_tab].name.clone();

                        // Installed tab: no toggling
                        if cur_tab_name == "Installed" {
                            select.flash_message =
                                Some("Press d to remove, or D to remove all".into());
                            continue;
                        }

                        // Updates tab: no toggling, point to u/d keys
                        if cur_tab_name.starts_with("Updates") {
                            select.flash_message =
                                Some("Press u to update all, or d to remove".into());
                            continue;
                        }

                        // Block toggling installed items — point to d key
                        if let Some(item) = get_cursor_item(select)
                            && item.installed
                            && !item.outdated
                        {
                            select.flash_message =
                                Some("Already installed — press d to remove".into());
                            continue;
                        }

                        // Get the label before toggle for dep tracking
                        let pre_label = get_cursor_label(select);
                        let was_selected = get_cursor_selected(select);

                        select.toggle();

                        // Auto-select dependencies
                        if let (Some((skills, graph)), Some(label)) = (dep_context, &pre_label) {
                            let now_selected = get_cursor_selected(select);
                            if now_selected && !was_selected {
                                // Just selected — add deps
                                if let Some(deps) = graph.get(label.as_str()) {
                                    for dep in deps {
                                        select.select_by_label(dep, true);
                                    }
                                    // Transitive
                                    let (expanded, _) = skill::expand_dependencies(
                                        std::slice::from_ref(label),
                                        graph,
                                    );
                                    for dep in &expanded {
                                        if dep != label {
                                            select.select_by_label(dep, true);
                                        }
                                    }
                                }
                            } else if !now_selected && was_selected {
                                // Just deselected — unlock deps that no other selected skill needs
                                unlock_orphan_deps(select, skills, graph);
                            }
                        }
                    }
                    KeyCode::Char('a') if multi => select.toggle_all(),
                    KeyCode::Right => {
                        if is_final_step(select) {
                            select.flash_message = Some("Press i or click Install".into());
                            continue;
                        }
                        if let Some(result) = try_confirm_select(select)? {
                            break result;
                        }
                    }
                    KeyCode::Char('i') | KeyCode::Char('I') if is_final_step(select) => {
                        if let Some(result) = try_confirm_select(select)? {
                            break result;
                        }
                    }
                    KeyCode::Char('u') | KeyCode::Char('U')
                        if select.tabs[select.active_tab].name.starts_with("Updates") =>
                    {
                        let count = select.tabs[select.active_tab]
                            .groups
                            .iter()
                            .flat_map(|g| &g.items)
                            .count();
                        if count == 0 {
                            continue;
                        }
                        select.confirm_dialog = Some((
                            format!("Update all {count} item(s) to latest?"),
                            multiselect::ConfirmAction::UpdateAll,
                        ));
                        select.confirm_dialog_scroll = 0;
                    }
                    KeyCode::Char('d') => {
                        // Remove the installed item under cursor (works on any tab)
                        if let Some(item) = get_cursor_item(select) {
                            if item.installed {
                                let label = item.label.clone();
                                remove_installed_items(select, std::slice::from_ref(&label));
                                select.flash_message = Some(format!("Removed {label}"));
                            } else {
                                select.flash_message =
                                    Some("Not installed — nothing to remove".into());
                            }
                        }
                    }
                    KeyCode::Char('D') => {
                        // Count all installed items across all tabs
                        let count = select
                            .tabs
                            .iter()
                            .find(|t| t.name == "Installed")
                            .map(|t| t.groups.iter().flat_map(|g| &g.items).count())
                            .unwrap_or(0);
                        if count == 0 {
                            select.flash_message = Some("Nothing installed to remove".into());
                            continue;
                        }
                        select.confirm_dialog = Some((
                            format!(
                                "Remove all {count} installed item(s)? \
                             This cannot be undone."
                            ),
                            multiselect::ConfirmAction::UninstallAll,
                        ));
                        select.confirm_dialog_scroll = 0;
                    }
                    KeyCode::Esc | KeyCode::Char('q') => break SelectResult::Cancelled,
                    _ => {}
                }
            } // Event::Key
            _ => {} // other events
        } // match event
    };

    // Don't leave alternate screen on step navigation — caller will re-enter immediately.
    if !matches!(result, SelectResult::Back | SelectResult::JumpToStep(_)) {
        io::stdout().execute(DisableMouseCapture)?;
        io::stdout().execute(LeaveAlternateScreen)?;
        terminal::disable_raw_mode()?;
    }

    Ok(result)
}

/// Map a visual row (relative to list area top, after scroll) to an item index.
/// Uses the exact rows from the last render.
fn visual_row_to_item(select: &TabbedSelect, visual_row: usize) -> Option<usize> {
    select.rendered_list_rows.get(visual_row).copied().flatten()
}

fn get_cursor_item(select: &TabbedSelect) -> Option<&SelectItem> {
    let tab = &select.tabs[select.active_tab];
    let mut idx = 0;
    for group in &tab.groups {
        for item in &group.items {
            if idx == select.cursor {
                return Some(item);
            }
            idx += 1;
        }
    }
    None
}

fn get_cursor_label(select: &TabbedSelect) -> Option<String> {
    let tab = &select.tabs[select.active_tab];
    let mut idx = 0;
    for group in &tab.groups {
        for item in &group.items {
            if idx == select.cursor {
                return Some(item.label.clone());
            }
            idx += 1;
        }
    }
    None
}

fn get_cursor_selected(select: &TabbedSelect) -> bool {
    let tab = &select.tabs[select.active_tab];
    let mut idx = 0;
    for group in &tab.groups {
        for item in &group.items {
            if idx == select.cursor {
                return item.selected;
            }
            idx += 1;
        }
    }
    false
}

/// After deselecting a skill, unlock any dependency that's no longer needed
fn unlock_orphan_deps(
    select: &mut TabbedSelect,
    _skills: &[Skill],
    graph: &HashMap<String, Vec<String>>,
) {
    // Collect all currently selected (non-locked) skill labels
    let selected: Vec<String> = select
        .tabs
        .iter()
        .filter(|t| t.name == "Skills")
        .flat_map(|t| &t.groups)
        .flat_map(|g| &g.items)
        .filter(|i| i.selected && !i.locked)
        .map(|i| i.label.clone())
        .collect();

    // Find all deps still needed by selected skills
    let (all_needed, _) = skill::expand_dependencies(&selected, graph);
    let all_needed: HashSet<String> = all_needed.into_iter().collect();

    // Unlock and deselect any locked item not in all_needed
    for tab in &mut select.tabs {
        if tab.name != "Skills" {
            continue;
        }
        for group in &mut tab.groups {
            for item in &mut group.items {
                if item.locked && !all_needed.contains(&item.label) {
                    item.locked = false;
                    item.selected = false;
                }
            }
        }
    }
}

/// Remove installed items from disk, lock files, and TUI state
fn remove_installed_items(select: &mut TabbedSelect, names: &[String]) {
    let names_set: HashSet<&str> = names.iter().map(|name| name.as_str()).collect();

    // Remove from both project and global scopes
    for scope_global in [false, true] {
        let lock_path = crate::config::lock_file_path(scope_global);
        if let Ok(mut lock) = crate::config::LockFile::load(&lock_path) {
            let mut changed = false;
            for name in names {
                if let Some(entry) = lock.entries.get(name).cloned() {
                    let harnesses: Vec<Harness> = entry
                        .harnesses
                        .iter()
                        .filter_map(|h| Harness::from_id(h))
                        .collect();
                    let _ = crate::installer::remove_item(name, &harnesses, scope_global);
                    lock.remove(name);
                    changed = true;
                }
            }
            if changed {
                let _ = lock.save(&lock_path);
            }
        }
    }

    // Clear installed/outdated flags on items in source tabs
    for tab in &mut select.tabs {
        if tab.name == "Installed" || tab.name.starts_with("Updates") {
            continue;
        }
        for group in &mut tab.groups {
            for item in &mut group.items {
                if names_set.contains(item.label.as_str()) {
                    item.installed = false;
                    item.outdated = false;
                }
            }
        }
    }

    // Clean up the Updates tab — remove uninstalled items
    if let Some(tab_idx) = select.tabs.iter().position(|t| t.name.starts_with("Updates")) {
        for group in &mut select.tabs[tab_idx].groups {
            group
                .items
                .retain(|i| !names_set.contains(i.label.as_str()));
        }
        select.tabs[tab_idx].groups.retain(|g| !g.items.is_empty());

        if select.tabs[tab_idx].groups.is_empty() {
            select.tabs.remove(tab_idx);
            if select.active_tab >= select.tabs.len() {
                select.active_tab = 0;
            }
        } else {
            // Update the tab name count
            let count: usize = select.tabs[tab_idx]
                .groups
                .iter()
                .map(|g| g.items.len())
                .sum();
            select.tabs[tab_idx].name = format!("Updates ({count})");
        }
    }

    // Clean up the Installed tab
    if let Some(tab_idx) = select.tabs.iter().position(|t| t.name == "Installed") {
        for group in &mut select.tabs[tab_idx].groups {
            group
                .items
                .retain(|i| !names_set.contains(i.label.as_str()));
        }
        select.tabs[tab_idx].groups.retain(|g| !g.items.is_empty());

        if select.tabs[tab_idx].groups.is_empty() {
            select.tabs.remove(tab_idx);
            if select.active_tab >= select.tabs.len() {
                select.active_tab = 0;
            }
        }

        let count = select.item_count();
        if count == 0 {
            select.cursor = 0;
        } else if select.cursor >= count {
            select.cursor = count - 1;
        }
        select.scroll = 0;
    }
}

/// Get all package names installed from a given source.
fn packages_from_source(source: &str) -> Vec<String> {
    let mut packages = Vec::new();
    for scope_global in [false, true] {
        let lock_path = crate::config::lock_file_path(scope_global);
        if let Ok(lock) = crate::config::LockFile::load(&lock_path) {
            for (name, entry) in &lock.entries {
                if entry.source == source {
                    packages.push(name.clone());
                }
            }
        }
    }
    packages.sort();
    packages.dedup();
    packages
}

/// Remove a source from the registry and update the source selector.
fn forget_source(select: &mut TabbedSelect, source: &str) {
    let reg_path = crate::config::source_registry_path();
    if let Ok(mut registry) = crate::config::SourceRegistry::load(&reg_path) {
        registry.forget(source);
        let _ = registry.save(&reg_path);
    }
    select.source_options.retain(|o| o.source != source);
}

/// Show a post-install summary screen.
pub fn run_summary_screen(data: &SummaryData) -> Result<SummaryAction> {
    terminal::enable_raw_mode()?;
    io::stdout().execute(EnterAlternateScreen)?;
    io::stdout().execute(EnableMouseCapture)?;

    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut scroll: usize = 0;
    let mut max_scroll: usize = 0;

    let action = loop {
        let sc = scroll;
        terminal.draw(|f| {
            max_scroll = render::draw_summary(f, data, sc);
        })?;
        // Clamp after render computes max_scroll
        scroll = scroll.min(max_scroll);

        match event::read()? {
            Event::Mouse(mouse) => match mouse.kind {
                MouseEventKind::ScrollUp => scroll = scroll.saturating_sub(3),
                MouseEventKind::ScrollDown => scroll = (scroll + 3).min(max_scroll),
                _ => {}
            },
            Event::Key(key) => {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                match key.code {
                    KeyCode::Up => scroll = scroll.saturating_sub(1),
                    KeyCode::Down => scroll = (scroll + 1).min(max_scroll),
                    KeyCode::Char('i') => break SummaryAction::InstallMore,
                    KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter => {
                        break SummaryAction::Exit
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    };

    io::stdout().execute(DisableMouseCapture)?;
    io::stdout().execute(LeaveAlternateScreen)?;
    terminal::disable_raw_mode()?;

    Ok(action)
}
