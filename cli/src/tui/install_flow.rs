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

use super::multiselect::{self, ItemGroup, SelectItem, Tab, TabbedSelect};
use super::render;
use super::state::{
    build_dep_display, build_item_tabs, load_installed_state, InstalledState,
};
use super::{
    DiscoveredItems, InstallFlowResult, InstallSelections, SourceSelectorData,
};

type DependencyContext<'a> = (&'a [Skill], &'a HashMap<String, Vec<String>>);

pub fn run_install_flow(
    items: DiscoveredItems,
    source_selector: &SourceSelectorData,
) -> Result<InstallFlowResult> {
    if items.agents.is_empty()
        && items.skills.is_empty()
        && items.hooks.is_empty()
        && items.pi_extensions.is_empty()
    {
        eprintln!("No agents, skills, hooks, or pi-extensions found.");
        return Ok(InstallFlowResult::Cancelled);
    }

    let dep_graph = skill::build_dependency_graph(&items.skills);
    let dep_display = build_dep_display(&items.skills, &dep_graph);

    // Load installed state from lock files
    let installed = load_installed_state();
    let has_installed_items = !installed.is_empty();

    // Refresh cached remote repos so staleness checks see latest content
    if has_installed_items {
        let project_lock =
            crate::config::LockFile::load(&crate::config::lock_file_path(false)).unwrap_or_default();
        crate::config::refresh_remote_caches(&project_lock);
        let global_lock =
            crate::config::LockFile::load(&crate::config::lock_file_path(true)).unwrap_or_default();
        crate::config::refresh_remote_caches(&global_lock);
    }
    let installed_names: std::collections::HashSet<String> = installed.keys().cloned().collect();

    let prev_harnesses: std::collections::HashSet<String> = installed
        .values()
        .flat_map(|info| &info.harnesses)
        .cloned()
        .collect();
    let has_previous = !prev_harnesses.is_empty();

    // Build step 1 once (preserved across back navigation)
    let tabs = build_item_tabs(&items, &dep_display, &installed);
    let step_labels = ["Packages", "Scope", "Harnesses", "Method", "Install"];
    let mut step1_select = TabbedSelect::new("Select packages to install", tabs, true)
        .with_step("1/5")
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
        selected_pi_extensions,
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
            SelectResult::UpdateInPlace(names) => {
                let n = names.len();
                perform_inline_update(&names, &items, &installed);
                // Clear outdated flags and remove from Updates tab
                clear_updated_items(&mut step1_select, &names);
                step1_select.flash_message =
                    Some(format!("Updated {n} item(s)"));
                continue 'steps;
            }
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

        let selected_pi_extensions: Vec<crate::pi_extension::PiExtension> = items
            .pi_extensions
            .iter()
            .filter(|e| {
                all_selected
                    .iter()
                    .any(|(tab, label)| *tab == "Pi Extensions" && *label == e.name)
            })
            .cloned()
            .collect();

        let no_new_selection = selected_agents.is_empty()
            && selected_skills.is_empty()
            && selected_hooks.is_empty()
            && selected_pi_extensions.is_empty()
            && !update_cli;

        let (selected_agents, selected_skills, selected_hooks, selected_pi_extensions) =
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
                    items
                        .pi_extensions
                        .iter()
                        .filter(|e| installed_names.contains(&e.name))
                        .cloned()
                        .collect(),
                )
            } else {
                (
                    selected_agents,
                    selected_skills,
                    selected_hooks,
                    selected_pi_extensions,
                )
            };

        if selected_agents.is_empty()
            && selected_skills.is_empty()
            && selected_hooks.is_empty()
            && selected_pi_extensions.is_empty()
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
                .with_step("2/5")
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
                SelectResult::JumpToStep(3) | SelectResult::JumpToStep(4) | SelectResult::JumpToStep(5) => {}
                SelectResult::JumpToStep(_) => continue 'scope_step,
                SelectResult::Confirmed | SelectResult::UpdateInPlace(_) => {}
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
                .with_step("3/5")
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
                    SelectResult::JumpToStep(4) | SelectResult::JumpToStep(5) => {}
                    SelectResult::JumpToStep(_) => continue 'harness_step,
                    SelectResult::Confirmed | SelectResult::UpdateInPlace(_) => {}
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

            let mut method_select = TabbedSelect::new("Installation method", method_tabs, false)
                .with_step("4/5")
                .with_step_labels(&step_labels)
                .with_source_selector(
                    source_selector.current_label.clone(),
                    source_selector.options.clone(),
                );

            let method = 'method_step: loop {
            match run_tabbed_select(&mut method_select, None)? {
                SelectResult::Cancelled => return Ok(InstallFlowResult::Cancelled),
                SelectResult::Back => continue 'harness_step, // back to step 3
                SelectResult::SwitchSource(source) => {
                    return Ok(InstallFlowResult::SwitchSource(source));
                }
                SelectResult::JumpToStep(1) => continue 'steps,
                SelectResult::JumpToStep(2) => continue 'scope_step,
                SelectResult::JumpToStep(3) => continue 'harness_step,
                SelectResult::JumpToStep(4) => continue 'method_step,
                SelectResult::JumpToStep(5) | SelectResult::Confirmed => {}
                SelectResult::JumpToStep(_) => continue 'method_step,
                SelectResult::UpdateInPlace(_) => continue 'method_step,
            }

            let method_selected = method_select.all_selected();
            let method = if method_selected.iter().any(|(_, l)| *l == "Copy") {
                InstallMethod::Copy
            } else {
                InstallMethod::Symlink
            };

            // ── Step 5: Install confirmation ──────────────────────
            let mut count_lines: Vec<String> = Vec::new();
            if !selected_agents.is_empty() {
                count_lines.push(format!(
                    "{} agent{}",
                    selected_agents.len(),
                    if selected_agents.len() == 1 { "" } else { "s" }
                ));
            }
            if !selected_skills.is_empty() {
                count_lines.push(format!(
                    "{} skill{}",
                    selected_skills.len(),
                    if selected_skills.len() == 1 { "" } else { "s" }
                ));
            }
            if !selected_hooks.is_empty() {
                count_lines.push(format!(
                    "{} hook{}",
                    selected_hooks.len(),
                    if selected_hooks.len() == 1 { "" } else { "s" }
                ));
            }
            if !selected_pi_extensions.is_empty()
                && harnesses.iter().any(|h| matches!(h, Harness::Pi))
            {
                count_lines.push(format!(
                    "{} pi-extension{}",
                    selected_pi_extensions.len(),
                    if selected_pi_extensions.len() == 1 { "" } else { "s" }
                ));
            }
            if update_cli {
                count_lines.push("CLI binary update".into());
            }

            let scope_label = if global { "Global" } else { "Project" };
            let harness_list = harnesses
                .iter()
                .map(|h| h.name())
                .collect::<Vec<_>>()
                .join(", ");
            let method_label = if method == InstallMethod::Copy { "Copy" } else { "Symlink" };

            let install_tabs = vec![Tab {
                name: "Summary".into(),
                groups: vec![ItemGroup {
                    label: String::new(),
                    items: Vec::new(),
                }],
            }];

            let mut install_select = TabbedSelect::new("Confirm installation", install_tabs, false)
                .with_step("5/5")
                .with_step_labels(&step_labels)
                .with_source_selector(
                    source_selector.current_label.clone(),
                    source_selector.options.clone(),
                );
            install_select.install_summary = vec![
                count_lines.join(", "),
                format!("Scope: {scope_label}"),
                format!("Harnesses: {harness_list}"),
                format!("Method: {method_label}"),
            ];
            install_select.action_button_focused = true;

            match run_tabbed_select(&mut install_select, None)? {
                SelectResult::Cancelled => return Ok(InstallFlowResult::Cancelled),
                SelectResult::Back => continue 'method_step,
                SelectResult::SwitchSource(source) => {
                    return Ok(InstallFlowResult::SwitchSource(source));
                }
                SelectResult::JumpToStep(1) => continue 'steps,
                SelectResult::JumpToStep(2) => continue 'scope_step,
                SelectResult::JumpToStep(3) => continue 'harness_step,
                SelectResult::JumpToStep(4) => continue 'method_step,
                SelectResult::JumpToStep(5) => continue,
                SelectResult::JumpToStep(_) => continue,
                SelectResult::UpdateInPlace(_) => continue,
                SelectResult::Confirmed => {
                    break 'method_step method;
                }
            }
            }; // end method_step

            break 'harness_step (harnesses, method);
            }; // end harness_step

            break 'scope_step (global, harnesses, Vec::new(), method);
        }; // end scope_step

        break 'steps (
            selected_agents,
            selected_skills,
            selected_hooks,
            selected_pi_extensions,
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
        pi_extensions: selected_pi_extensions,
        harnesses,
        skipped_harnesses,
        global,
        method,
        update_cli,
    }))
}

#[derive(PartialEq)]
enum SelectResult {
    Confirmed,
    Cancelled,
    Back,
    JumpToStep(usize),
    SwitchSource(String),
    /// Run an inline update for the named items without leaving the TUI.
    UpdateInPlace(Vec<String>),
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
        && select.confirm_summary.is_none()
    {
        // Final step without a confirm summary (e.g. Install step) — confirm directly
        return Ok(Some(SelectResult::Confirmed));
    }

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
                                    let names: Vec<String> = select
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

                                    break SelectResult::UpdateInPlace(names);
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
                            let count = select.item_count();
                            if count == 0 || select.cursor >= count.saturating_sub(1) {
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
                    KeyCode::Char('u')
                        if select.tabs[select.active_tab].name.starts_with("Updates") =>
                    {
                        // Update single item under cursor immediately
                        if let Some(item) = get_cursor_item(select) {
                            if item.outdated {
                                let name = item.label.clone();
                                // CLI binary: run update directly and exit
                                if name == "vstack (cli)" {
                                    io::stdout().execute(DisableMouseCapture)?;
                                    io::stdout().execute(LeaveAlternateScreen)?;
                                    terminal::disable_raw_mode()?;
                                    eprintln!("Updating vstack...\n");
                                    let _ = crate::commands::update::run(false);
                                    eprintln!("\nRestart vstack to use the new version.");
                                    std::process::exit(0);
                                }
                                break SelectResult::UpdateInPlace(vec![name]);
                            }
                        }
                    }
                    KeyCode::Char('U')
                        if select.tabs[select.active_tab].name.starts_with("Updates") =>
                    {
                        // Update all outdated items
                        let names: Vec<String> = select.tabs[select.active_tab]
                            .groups
                            .iter()
                            .flat_map(|g| &g.items)
                            .map(|i| i.label.clone())
                            .collect();
                        if names.is_empty() {
                            continue;
                        }
                        // For bulk update, confirm first
                        select.confirm_dialog = Some((
                            format!("Update all {} item(s) to latest?", names.len()),
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
                    if entry.kind == crate::config::ItemKind::PiExtension {
                        let _ = crate::pi_extension::remove_pi_extension(name, scope_global);
                    } else {
                        let harnesses: Vec<Harness> = entry
                            .harnesses
                            .iter()
                            .filter_map(|h| Harness::from_id(h))
                            .collect();
                        let _ = crate::installer::remove_item(name, &harnesses, scope_global);
                    }
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

/// Run an inline update for the named items without leaving the TUI.
/// Re-installs agents, skills, and hooks from the discovered source.
fn perform_inline_update(
    names: &[String],
    items: &DiscoveredItems,
    _installed: &InstalledState,
) {

    for scope_global in [false, true] {
        let lock_path = crate::config::lock_file_path(scope_global);
        let Ok(lock) = crate::config::LockFile::load(&lock_path) else {
            continue;
        };

        let project_root = crate::config::project_root();
        let mut project_config = crate::project_config::ProjectConfig::load(&project_root);
        let mut upstream_skill_updates: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();

        // Determine source mapping (from first discovered agent/skill path)
        let source_dir = items
            .agents
            .first()
            .map(|a| a.source_path.parent().and_then(|p| p.parent()))
            .flatten()
            .or_else(|| {
                items
                    .skills
                    .first()
                    .map(|s| s.source_dir.parent())
                    .flatten()
            });
        let mapping = source_dir
            .map(|d| crate::mapping::MappingConfig::load(d))
            .unwrap_or_default();

        let installed_skills: Vec<String> = lock
            .entries
            .iter()
            .filter(|(_, e)| e.kind == crate::config::ItemKind::Skill)
            .map(|(n, _)| n.clone())
            .collect();

        for name in names {
            let Some(entry) = lock.entries.get(name) else {
                continue;
            };
            let harnesses: Vec<Harness> = entry
                .harnesses
                .iter()
                .filter_map(|h| Harness::from_id(h))
                .collect();

            match entry.kind {
                crate::config::ItemKind::Agent => {
                    let Some(agent) = items.agents.iter().find(|a| a.name == *name) else {
                        continue;
                    };
                    let source_skills =
                        mapping.skills_for_agent(&agent.name, &agent.role, &installed_skills);
                    let skill_names: Vec<String> = if let Some(project_list) =
                        project_config.agent_skills_for(&agent.name)
                    {
                        let mut merged = project_list.clone();
                        let existing: std::collections::HashSet<String> =
                            merged.iter().cloned().collect();
                        for s in &source_skills {
                            if !existing.contains(s) {
                                merged.push(s.clone());
                            }
                        }
                        if merged.len() > project_list.len() {
                            project_config
                                .agent_skills
                                .insert(agent.name.clone(), merged.clone());
                            upstream_skill_updates
                                .insert(agent.name.clone(), merged.clone());
                        }
                        merged
                    } else {
                        source_skills
                    };
                    let skill_pairs =
                        crate::resolve::resolve_skill_pairs(&skill_names, &items.skills);
                    let optional_entries =
                        mapping.optional_skills_for_agent(&agent.name, &installed_skills);
                    let optional_pairs =
                        crate::resolve::resolve_optional_skill_pairs(&optional_entries);
                    let installed_hooks: Vec<crate::hook::Hook> = items
                        .hooks
                        .iter()
                        .filter(|h| {
                            lock.entries
                                .get(&h.name)
                                .is_some_and(|e| e.kind == crate::config::ItemKind::Hook)
                        })
                        .cloned()
                        .collect();
                    let matched_hooks: Vec<crate::hook::Hook> = mapping
                        .hooks_for_agent(&agent.role, &installed_hooks)
                        .into_iter()
                        .cloned()
                        .collect();
                    let extras = crate::resolve::build_agent_extras(
                        &project_config,
                        &agent.name,
                        &agent.role,
                        None,
                    );
                    for harness in &harnesses {
                        let _ = harness.generate_agent(
                            agent,
                            scope_global,
                            &skill_pairs,
                            &optional_pairs,
                            &matched_hooks,
                            &extras,
                        );
                    }
                }
                crate::config::ItemKind::Skill => {
                    let Some(skill) = items.skills.iter().find(|s| s.name == *name) else {
                        continue;
                    };
                    let instr = project_config.skill_instructions_for(&skill.name);
                    for harness in &harnesses {
                        let _ = crate::installer::install_skill(
                            skill,
                            *harness,
                            scope_global,
                            entry.method,
                            instr,
                        );
                    }
                }
                crate::config::ItemKind::Hook => {
                    let Some(hook) = items.hooks.iter().find(|h| h.name == *name) else {
                        continue;
                    };
                    let agents_for_hook: Vec<crate::agent::Agent> = items
                        .agents
                        .iter()
                        .filter(|a| {
                            lock.entries
                                .get(&a.name)
                                .is_some_and(|e| e.kind == crate::config::ItemKind::Agent)
                        })
                        .cloned()
                        .collect();
                    for harness in &harnesses {
                        let _ = crate::installer::install_hook(
                            hook,
                            *harness,
                            scope_global,
                            &agents_for_hook,
                        );
                    }
                }
                crate::config::ItemKind::PiExtension => {
                    let Some(ext) =
                        items.pi_extensions.iter().find(|e| e.name == *name)
                    else {
                        continue;
                    };
                    let _ = crate::pi_extension::install_pi_extension(ext, scope_global);
                }
            }
        }

        // Persist upstream skill additions to project vstack.toml
        if !scope_global && !upstream_skill_updates.is_empty() {
            crate::project_config::merge_upstream_agent_skills(
                &project_root,
                &upstream_skill_updates,
            );
        }

        // Update lock file timestamps
        let mut lock = crate::config::LockFile::load(&lock_path).unwrap_or_default();
        let now = crate::config::now_iso();
        for name in names {
            if let Some(entry) = lock.entries.get_mut(name) {
                entry.installed_at = now.clone();
                entry.source_hash = crate::config::compute_source_hash(entry);
            }
        }
        let _ = lock.save(&lock_path);
    }
}

/// Clear outdated flags and remove items from the Updates tab after inline update.
fn clear_updated_items(select: &mut TabbedSelect, names: &[String]) {
    let names_set: HashSet<&str> = names.iter().map(|n| n.as_str()).collect();

    // Clear outdated flags in source tabs
    for tab in &mut select.tabs {
        if tab.name == "Installed" || tab.name.starts_with("Updates") {
            continue;
        }
        for group in &mut tab.groups {
            for item in &mut group.items {
                if names_set.contains(item.label.as_str()) {
                    item.outdated = false;
                }
            }
        }
    }

    // Remove from Updates tab
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
            let count: usize = select.tabs[tab_idx]
                .groups
                .iter()
                .map(|g| g.items.len())
                .sum();
            select.tabs[tab_idx].name = format!("Updates ({count})");
        }
    }

    // Fix cursor
    let count = select.item_count();
    if count == 0 {
        select.cursor = 0;
    } else if select.cursor >= count {
        select.cursor = count - 1;
    }
    select.scroll = 0;
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
