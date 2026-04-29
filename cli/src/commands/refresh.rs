use crate::config::{self, ItemKind};
use crate::harness::Harness;
use crate::installer;
use anyhow::Result;
use std::path::PathBuf;

/// Regenerate all installed agent files and re-copy skills from source.
pub fn run(global: bool) -> Result<()> {
    let lock_path = config::lock_file_path(global);
    let mut lock = config::LockFile::load(&lock_path)?;

    // Reconcile lock with disk before refreshing (recovers orphaned entries)
    let source_hint = lock
        .entries
        .values()
        .next()
        .map(|e| e.source.clone())
        .unwrap_or_default();
    if config::reconcile_lock_with_disk(&mut lock, global, &source_hint) {
        lock.save(&lock_path)?;
    }

    let project_root = config::project_root();

    if lock.entries.is_empty() {
        eprintln!("Nothing installed. Run `vstack add` first.");
        return Ok(());
    }

    if !global {
        let agent_names: Vec<String> = lock
            .entries
            .iter()
            .filter(|(_, e)| e.kind == ItemKind::Agent)
            .map(|(n, _)| n.clone())
            .collect();
        let skill_names: Vec<String> = lock
            .entries
            .iter()
            .filter(|(_, e)| e.kind == ItemKind::Skill)
            .map(|(n, _)| n.clone())
            .collect();
        crate::project_config::ensure_project_config(&project_root, &agent_names, &skill_names);
    }
    let mut project_config = crate::project_config::ProjectConfig::load(&project_root);

    // Resolve source directories from lock file entries
    let source_dirs = resolve_sources(&lock);
    if source_dirs.is_empty() {
        eprintln!("Could not locate any package sources. Run `vstack add` to reinstall.");
        return Ok(());
    }

    // Aggregate source data from all resolved sources
    let mut all_source_agents = Vec::new();
    let mut all_source_skills = Vec::new();
    let mut all_source_hooks = Vec::new();
    let mut mapping = crate::mapping::MappingConfig::default();

    for dir in &source_dirs {
        mapping = crate::mapping::MappingConfig::load(dir);
        all_source_agents.extend(
            crate::agent::discover_agents(&dir.join("agents")).unwrap_or_default(),
        );
        all_source_skills.extend(
            crate::skill::discover_skills(&dir.join("skills")).unwrap_or_default(),
        );
        all_source_hooks.extend(
            crate::hook::discover_hooks(&dir.join("hooks")).unwrap_or_default(),
        );
    }

    let installed_skills: Vec<String> = lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::Skill)
        .map(|(name, _)| name.clone())
        .collect();

    let installed_hook_names: std::collections::HashSet<String> = lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::Hook)
        .map(|(name, _)| name.clone())
        .collect();

    // Filter source hooks to only those actually installed
    let installed_hooks: Vec<crate::hook::Hook> = all_source_hooks
        .into_iter()
        .filter(|h| installed_hook_names.contains(&h.name))
        .collect();

    // Refresh agents
    let mut agents_refreshed = 0usize;
    let mut skills_refreshed = 0usize;
    // Tracks agents whose project [agent-skills] got new upstream additions:
    // agent_name → (full merged list, newly added skill names)
    let mut upstream_skill_updates: std::collections::HashMap<String, (Vec<String>, Vec<String>)> =
        std::collections::HashMap::new();
    // Tracks agents whose [agent-skills-optional] got new upstream additions
    let mut upstream_optional_updates: std::collections::HashMap<
        String,
        (Vec<crate::mapping::OptionalSkill>, Vec<String>),
    > = std::collections::HashMap::new();
    let agent_entries: Vec<_> = lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::Agent)
        .collect();

    for (name, entry) in &agent_entries {
        let Some(agent) = all_source_agents.iter().find(|a| &a.name == *name) else {
            eprintln!("  ! {} — source not found, skipped", name);
            continue;
        };

        // Start from project [agent-skills] if present, else source mapping.
        // Then merge any new skills from the source mapping that aren't already
        // in the list — this ensures upstream additions propagate to projects.
        let source_skills =
            mapping.skills_for_agent(&agent.name, &agent.role, &installed_skills);
        let skill_names: Vec<String> =
            if let Some(project_list) = project_config.agent_skills_for(&agent.name) {
                let mut merged = project_list.clone();
                let existing: std::collections::HashSet<String> =
                    merged.iter().cloned().collect();
                for s in &source_skills {
                    if !existing.contains(s) {
                        merged.push(s.clone());
                    }
                }
                if merged.len() > project_list.len() {
                    let added: Vec<String> = merged[project_list.len()..].to_vec();
                    project_config.agent_skills.insert(agent.name.clone(), merged.clone());
                    upstream_skill_updates.insert(agent.name.clone(), (merged.clone(), added));
                }
                merged
            } else {
                source_skills
            };

        let skill_pairs =
            crate::resolve::resolve_skill_pairs(&skill_names, &all_source_skills);

        // Start from project [agent-skills-optional] if present, else source mapping.
        // Then merge any new optional skills from the source mapping that aren't
        // already in the list — same principle as required skills above.
        let source_optional =
            mapping.optional_skills_for_agent(&agent.name, &installed_skills);
        let optional_entries =
            if let Some(project_list) = project_config.agent_skills_optional.get(&agent.name) {
                let mut merged = project_list.clone();
                let existing: std::collections::HashSet<String> =
                    merged.iter().map(|e| e.skill.clone()).collect();
                for s in &source_optional {
                    if !existing.contains(&s.skill) {
                        merged.push(s.clone());
                    }
                }
                if merged.len() > project_list.len() {
                    let added: Vec<String> =
                        merged[project_list.len()..].iter().map(|e| e.skill.clone()).collect();
                    project_config
                        .agent_skills_optional
                        .insert(agent.name.clone(), merged.clone());
                    upstream_optional_updates
                        .insert(agent.name.clone(), (merged.clone(), added));
                }
                merged
            } else {
                source_optional
            };
        let optional_pairs = crate::resolve::resolve_optional_skill_pairs(&optional_entries);

        let matched_hooks: Vec<crate::hook::Hook> = mapping
            .hooks_for_agent(&agent.role, &installed_hooks)
            .into_iter()
            .cloned()
            .collect();

        for harness_id in &entry.harnesses {
            if let Some(harness) = Harness::from_id(harness_id) {
                let existing_path = harness
                    .agents_dir(global)
                    .join(harness.agent_filename(&agent.name));
                let file_extras =
                    crate::resolve::read_existing_extras(&existing_path, harness);
                project_config.save_extracted(&project_root, &agent.name, &file_extras);
            }
        }

        let extras = crate::resolve::build_agent_extras(
            &project_config,
            &agent.name,
            &agent.role,
            None,
        );

        for harness_id in &entry.harnesses {
            if let Some(harness) = Harness::from_id(harness_id) {
                let _ = harness.generate_agent(
                    agent,
                    global,
                    &skill_pairs,
                    &optional_pairs,
                    &matched_hooks,
                    &extras,
                );
            }
        }
        agents_refreshed += 1;
    }

    // Persist upstream skill additions to project vstack.toml
    if !global && !upstream_skill_updates.is_empty() {
        let merged_map: std::collections::HashMap<String, Vec<String>> = upstream_skill_updates
            .iter()
            .map(|(k, (list, _))| (k.clone(), list.clone()))
            .collect();
        crate::project_config::merge_upstream_agent_skills(&project_root, &merged_map);
        for (agent, (_, added)) in &upstream_skill_updates {
            eprintln!("  + {} — added upstream skills: {}", agent, added.join(", "));
        }
    }

    // Persist upstream optional skill additions to project vstack.toml
    if !global && !upstream_optional_updates.is_empty() {
        let merged_map: std::collections::HashMap<String, Vec<crate::mapping::OptionalSkill>> =
            upstream_optional_updates
                .iter()
                .map(|(k, (list, _))| (k.clone(), list.clone()))
                .collect();
        crate::project_config::merge_upstream_agent_skills_optional(&project_root, &merged_map);
        for (agent, (_, added)) in &upstream_optional_updates {
            eprintln!(
                "  + {} — added upstream optional skills: {}",
                agent,
                added.join(", ")
            );
        }
    }

    // Refresh skills — re-copy from source
    let skill_entries: Vec<_> = lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::Skill)
        .collect();

    for (name, entry) in &skill_entries {
        let Some(skill) = all_source_skills.iter().find(|s| &s.name == *name) else {
            continue;
        };

        for harness_id in &entry.harnesses {
            if let Some(harness) = Harness::from_id(harness_id) {
                let skill_instr = project_config.skill_instructions_for(&skill.name);
                let _ = installer::install_skill(skill, harness, global, entry.method, skill_instr);
            }
        }
        skills_refreshed += 1;
    }

    // Refresh Pi extensions — re-copy from source and re-register settings
    let mut all_pi_extensions = Vec::new();
    for dir in &source_dirs {
        all_pi_extensions
            .extend(crate::pi_extension::discover_pi_extensions(&dir.join("pi-extensions"))
                .unwrap_or_default());
    }
    let pi_ext_entries: Vec<_> = lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::PiExtension)
        .collect();
    let mut pi_extensions_refreshed = 0usize;
    for (name, _) in &pi_ext_entries {
        let Some(ext) = all_pi_extensions.iter().find(|e| &e.name == *name) else {
            continue;
        };
        let _ = crate::pi_extension::install_pi_extension(ext, global);
        pi_extensions_refreshed += 1;
    }

    // Update lock file timestamps and content hashes
    let mut lock = config::LockFile::load(&lock_path)?;
    let now = config::now_iso();
    for entry in lock.entries.values_mut() {
        entry.installed_at = now.clone();
        entry.source_hash = config::compute_source_hash(entry);
    }
    lock.save(&lock_path)?;

    eprintln!(
        "Refreshed {} agent(s), {} skill(s), {} pi-extension(s)",
        agents_refreshed, skills_refreshed, pi_extensions_refreshed
    );
    Ok(())
}

/// Resolve source directories from lock file entries.
/// Handles local paths, "." (walks up from CWD), and remote shorthand (cached clones).
fn resolve_sources(lock: &config::LockFile) -> Vec<PathBuf> {
    let mut sources: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for entry in lock.entries.values() {
        if seen.contains(&entry.source) {
            continue;
        }
        seen.insert(entry.source.clone());

        if let Some(dir) = resolve_single_source(&entry.source) {
            if !sources.contains(&dir) {
                sources.push(dir);
            }
        }
    }

    // Fallback: walk up from CWD to find a vstack source repo
    if sources.is_empty() {
        if let Ok(mut dir) = std::env::current_dir() {
            loop {
                if crate::resolve::is_vstack_source(&dir) {
                    sources.push(dir);
                    break;
                }
                if !dir.pop() {
                    break;
                }
            }
        }
    }

    // Fallback: try the source registry (cached remote repos)
    if sources.is_empty() {
        let reg_path = config::source_registry_path();
        if let Ok(registry) = config::SourceRegistry::load(&reg_path) {
            for entry in registry
                .current
                .iter()
                .chain(registry.entries.iter())
            {
                if let Some(dir) = resolve_single_source(entry) {
                    if !sources.contains(&dir) {
                        sources.push(dir);
                    }
                }
            }
        }
    }

    sources
}

fn resolve_single_source(source: &str) -> Option<PathBuf> {
    // Absolute or relative path that exists
    let p = std::path::Path::new(source);
    if p.is_absolute() && p.is_dir() && crate::resolve::is_vstack_source(p) {
        return Some(p.to_path_buf());
    }

    // "." — walk up from CWD
    if source == "." {
        let mut dir = std::env::current_dir().ok()?;
        loop {
            if crate::resolve::is_vstack_source(&dir) {
                return Some(dir);
            }
            if !dir.pop() {
                break;
            }
        }
        return None;
    }

    // Remote shorthand (owner/repo) — update and use cached clone
    let cache_dir = config::global_base_dir()
        .join(".vstack")
        .join("cache");
    let key = source.replace('/', "_");
    let cached = cache_dir.join(&key);
    if cached.join(".git").exists() {
        update_cached_repo(&cached);
        return Some(cached);
    }

    None
}

/// Pull latest changes for a cached remote repo.
fn update_cached_repo(repo_dir: &std::path::Path) {
    eprintln!("Updating cached repo...");
    let fetch = std::process::Command::new("git")
        .args(["fetch", "origin", "--quiet"])
        .current_dir(repo_dir)
        .status();
    match fetch {
        Ok(s) if s.success() => {
            let reset = std::process::Command::new("git")
                .args(["reset", "--hard", "origin/HEAD"])
                .current_dir(repo_dir)
                .stderr(std::process::Stdio::null())
                .status();
            if !reset.is_ok_and(|s| s.success()) {
                eprintln!("  Warning: git reset failed — cached repo may be stale");
            }
        }
        Ok(_) => eprintln!("  Warning: git fetch failed — using cached version"),
        Err(_) => eprintln!("  Warning: git not available — using cached version"),
    }
}

