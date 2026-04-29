use crate::skill::Skill;
use std::collections::HashMap;

use super::multiselect::{ItemGroup, SelectItem, Tab};

pub(super) struct InstalledInfo {
    pub scope: String,
    pub harnesses: Vec<String>,
    pub kind: Option<crate::config::ItemKind>,
    pub installed_at: String,
    pub lock_entry: crate::config::LockEntry,
}

pub(super) type InstalledState = HashMap<String, InstalledInfo>;

pub(super) fn load_installed_state() -> InstalledState {
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
                    lock_entry: entry.clone(),
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
                    lock_entry: entry.clone(),
                });
        }
    }

    state
}

/// Check if an installed item's source has changed (content hash comparison).
pub(super) fn is_item_outdated(info: &InstalledInfo) -> bool {
    crate::config::is_source_changed(&info.lock_entry)
}

pub(super) fn installed_scope_label(scope: &str) -> String {
    match scope {
        "project+global" => "both".into(),
        other => other.to_string(),
    }
}

pub(super) fn build_item_tabs(
    items: &super::DiscoveredItems,
    dep_display: &HashMap<String, String>,
    installed: &InstalledState,
) -> Vec<Tab> {
    let mut tabs = Vec::new();

    // Config paths no longer needed for staleness — hash-based detection
    // includes config content in the hash at install time.

    // ── Agents tab ───────────────────────────────────────────────────
    if !items.agents.is_empty() {
        let mut engineers = Vec::new();
        let mut reviewers = Vec::new();
        let mut managers = Vec::new();

        for a in &items.agents {
            let installed_info = installed.get(&a.name);
            let is_installed = installed_info.is_some();
            let agent_outdated = installed_info.is_some_and(|info| is_item_outdated(info));
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
                outdated: installed_info.is_some_and(|info| is_item_outdated(info)),
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
                    outdated: installed_info.is_some_and(|info| is_item_outdated(info)),
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

    // ── Pi Extensions tab ────────────────────────────────────────────
    if !items.pi_extensions.is_empty() {
        let items_list: Vec<SelectItem> = items
            .pi_extensions
            .iter()
            .map(|ext| {
                let installed_info = installed.get(&ext.name);
                let is_installed = installed_info.is_some();
                let suffix = ext.version.clone().map(|v| format!("v{v}"));
                SelectItem {
                    label: ext.name.clone(),
                    description: if ext.description.is_empty() {
                        "Pi extension package".into()
                    } else {
                        ext.description.clone()
                    },
                    selected: false,
                    tag: Some("pi".into()),
                    suffix,
                    locked: false,
                    installed: is_installed,
                    installed_scope: installed_info.map(|info| installed_scope_label(&info.scope)),
                    outdated: installed_info.is_some_and(|info| is_item_outdated(info)),
                }
            })
            .collect();

        tabs.push(Tab {
            name: "Pi Extensions".into(),
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
pub(super) fn check_for_update() -> Option<String> {
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

pub(super) fn build_dep_display(
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
