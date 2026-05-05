use crate::agent::Agent;
use crate::config::{self, ItemKind};
use crate::harness::Harness;
use crate::hook::Hook;
use crate::installer;
use crate::mapping::{MappingConfig, OptionalSkill};
use crate::pi_extension::PiExtension;
use crate::project_config::ProjectConfig;
use crate::skill::Skill;
use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Result counts from one invocation of [`refresh_items_in_scope`].
#[derive(Default)]
pub struct RefreshStats {
    pub agents_refreshed: usize,
    pub skills_refreshed: usize,
    pub pi_refreshed: usize,
    /// Map of agent_name → (full merged required-skills list, newly added skill names).
    pub upstream_skill_updates: HashMap<String, (Vec<String>, Vec<String>)>,
    /// Map of agent_name → (full merged optional-skills list, newly added skill names).
    pub upstream_optional_updates: HashMap<String, (Vec<OptionalSkill>, Vec<String>)>,
}

impl RefreshStats {
    /// Persist any required/optional skill upstream additions back to the
    /// project's `vstack.toml`. No-op for global scope (no project config).
    pub fn persist_upstream(&self, project_root: &Path) {
        if !self.upstream_skill_updates.is_empty() {
            let merged: HashMap<String, Vec<String>> = self
                .upstream_skill_updates
                .iter()
                .map(|(k, (list, _))| (k.clone(), list.clone()))
                .collect();
            crate::project_config::merge_upstream_agent_skills(project_root, &merged);
        }
        if !self.upstream_optional_updates.is_empty() {
            let merged: HashMap<String, Vec<OptionalSkill>> = self
                .upstream_optional_updates
                .iter()
                .map(|(k, (list, _))| (k.clone(), list.clone()))
                .collect();
            crate::project_config::merge_upstream_agent_skills_optional(project_root, &merged);
        }
    }
}

/// Generic upstream-merge: starts with `project_list` if present, else
/// `source_list`; appends source items not already present, returning
/// (merged, names_added). Used by both required and optional skill merges.
fn merge_upstream<T: Clone>(
    project_list: Option<&[T]>,
    source_list: &[T],
    key: impl Fn(&T) -> String,
) -> (Vec<T>, Vec<String>) {
    let Some(project_list) = project_list else {
        return (source_list.to_vec(), Vec::new());
    };
    let mut merged: Vec<T> = project_list.to_vec();
    let existing: std::collections::HashSet<String> = merged.iter().map(&key).collect();
    let prev_len = merged.len();
    for s in source_list {
        if !existing.contains(&key(s)) {
            merged.push(s.clone());
        }
    }
    let added: Vec<String> = merged[prev_len..].iter().map(&key).collect();
    (merged, added)
}

/// Re-install the items currently recorded in `lock` (or just those in
/// `name_filter`) using the supplied source data.
///
/// Both `vstack refresh` and the TUI's inline-update path go through this
/// helper. Caller is responsible for: source discovery (filling in
/// `agents`/`skills`/`hooks`/`pi_extensions` and `mapping`), project-config
/// loading, lock loading, lock-disk reconciliation, and writing the
/// upstream-additions back to disk via
/// [`crate::project_config::merge_upstream_agent_skills`] /
/// [`crate::project_config::merge_upstream_agent_skills_optional`].
#[allow(clippy::too_many_arguments)]
pub fn refresh_items_in_scope(
    global: bool,
    lock: &config::LockFile,
    agents: &[Agent],
    skills: &[Skill],
    hooks: &[Hook],
    pi_extensions: &[PiExtension],
    mapping: &MappingConfig,
    project_config: &mut ProjectConfig,
    project_root: &Path,
    name_filter: Option<&[String]>,
) -> RefreshStats {
    let mut stats = RefreshStats::default();
    let pass = |name: &str| name_filter.is_none_or(|f| f.iter().any(|n| n == name));

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

    let installed_hooks: Vec<Hook> = hooks
        .iter()
        .filter(|h| installed_hook_names.contains(&h.name))
        .cloned()
        .collect();

    // ── Agents ───────────────────────────────────────────────
    for (name, entry) in lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::Agent)
        .filter(|(n, _)| pass(n))
    {
        let Some(agent) = agents.iter().find(|a| &a.name == name) else {
            if name_filter.is_none() {
                eprintln!("  ! {} — source not found, skipped", name);
            }
            continue;
        };

        // Required skills: project list (if present) merged with source additions.
        let source_skills = mapping.skills_for_agent(&agent.name, &agent.role, &installed_skills);
        let project_required = project_config.agent_skills_for(&agent.name);
        let (skill_names, added) = merge_upstream(
            project_required.as_deref().map(|v| &v[..]),
            &source_skills,
            |s| s.clone(),
        );
        if !added.is_empty() {
            project_config
                .agent_skills
                .insert(agent.name.clone(), skill_names.clone());
            stats
                .upstream_skill_updates
                .insert(agent.name.clone(), (skill_names.clone(), added));
        }

        let skill_pairs = crate::resolve::resolve_skill_pairs(&skill_names, skills);

        // Optional skills: same merge logic as required.
        let source_optional = mapping.optional_skills_for_agent(&agent.name, &installed_skills);
        let project_optional: Option<&[OptionalSkill]> = project_config
            .agent_skills_optional
            .get(&agent.name)
            .map(|v| v.as_slice());
        let (optional_entries, added) =
            merge_upstream(project_optional, &source_optional, |e| e.skill.clone());
        if !added.is_empty() {
            project_config
                .agent_skills_optional
                .insert(agent.name.clone(), optional_entries.clone());
            stats
                .upstream_optional_updates
                .insert(agent.name.clone(), (optional_entries.clone(), added));
        }
        let optional_pairs = crate::resolve::resolve_optional_skill_pairs(&optional_entries);

        let matched_hooks: Vec<Hook> = mapping
            .hooks_for_agent(&agent.role, &installed_hooks)
            .into_iter()
            .cloned()
            .collect();

        for harness_id in &entry.harnesses {
            if let Some(harness) = Harness::from_id(harness_id) {
                let existing_path = harness
                    .agents_dir(global)
                    .join(harness.agent_filename(&agent.name));
                let file_extras = crate::resolve::read_existing_extras(&existing_path, harness);
                // Project-level vstack.toml is only meaningful in project scope.
                if !global {
                    project_config.save_extracted(project_root, &agent.name, &file_extras);
                }
            }
        }

        let extras =
            crate::resolve::build_agent_extras(project_config, &agent.name, &agent.role, None);

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
        stats.agents_refreshed += 1;
    }

    // ── Skills ───────────────────────────────────────────────
    for (name, entry) in lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::Skill)
        .filter(|(n, _)| pass(n))
    {
        let Some(skill) = skills.iter().find(|s| &s.name == name) else {
            continue;
        };

        for harness_id in &entry.harnesses {
            if let Some(harness) = Harness::from_id(harness_id) {
                let skill_instr = project_config.skill_instructions_for(&skill.name);
                let _ = installer::install_skill(skill, harness, global, entry.method, skill_instr);
            }
        }
        stats.skills_refreshed += 1;
    }

    // ── Hooks ─────────────────────────────────────────────
    // Hooks are reattached on agent regen (above), so refresh doesn't need
    // a separate pass — they ride along with their owning agents.

    // ── Pi packages ──────────────────────────────────────
    for (name, _) in lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::PiExtension)
        .filter(|(n, _)| pass(n))
    {
        let Some(ext) = pi_extensions.iter().find(|e| &e.name == name) else {
            continue;
        };
        let _ = crate::pi_extension::install_pi_extension(ext, global);
        stats.pi_refreshed += 1;
    }

    stats
}

/// Reinstall every item recorded in the scope lock from current source:
/// regenerate agent files (re-applying `vstack.toml` customizations),
/// re-copy skills, and re-copy Pi packages. Use after editing source files
/// to push changes to the install scope without re-running `vstack add`.
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
        all_source_agents
            .extend(crate::agent::discover_agents(&dir.join("agents")).unwrap_or_default());
        all_source_skills
            .extend(crate::skill::discover_skills(&dir.join("skills")).unwrap_or_default());
        all_source_hooks
            .extend(crate::hook::discover_hooks(&dir.join("hooks")).unwrap_or_default());
    }

    let mut all_pi_extensions = Vec::new();
    for dir in &source_dirs {
        all_pi_extensions.extend(
            crate::pi_extension::discover_pi_extensions(&dir.join("pi-extensions"))
                .unwrap_or_default(),
        );
    }

    let stats = refresh_items_in_scope(
        global,
        &lock,
        &all_source_agents,
        &all_source_skills,
        &all_source_hooks,
        &all_pi_extensions,
        &mapping,
        &mut project_config,
        &project_root,
        None,
    );

    if !global {
        stats.persist_upstream(&project_root);
        for (agent, (_, added)) in &stats.upstream_skill_updates {
            eprintln!(
                "  + {} — added upstream skills: {}",
                agent,
                added.join(", ")
            );
        }
        for (agent, (_, added)) in &stats.upstream_optional_updates {
            eprintln!(
                "  + {} — added upstream optional skills: {}",
                agent,
                added.join(", ")
            );
        }
    }

    // Update lock file timestamps and content hashes. Also repair stale source
    // paths: if an entry's recorded source no longer resolves but we found a
    // working source via CWD/registry fallback, rewrite the entry's source so
    // future refresh/staleness checks use the valid path.
    let mut lock = config::LockFile::load(&lock_path)?;
    let now = config::now_iso();
    let fallback_source = source_dirs.first().map(|p| p.display().to_string());
    let mut repaired_sources = 0usize;
    for entry in lock.entries.values_mut() {
        if resolve_single_source(&entry.source).is_none() {
            if let Some(replacement) = &fallback_source {
                if &entry.source != replacement {
                    entry.source = replacement.clone();
                    repaired_sources += 1;
                }
            }
        }
        entry.installed_at = now.clone();
        entry.source_hash = config::compute_source_hash(entry);
    }
    lock.save(&lock_path)?;
    if repaired_sources > 0 {
        eprintln!(
            "  Repaired {} lock entry source path(s) (previous source missing)",
            repaired_sources
        );
    }

    eprintln!(
        "Refreshed {} agent(s), {} skill(s), {} pi-package(s)",
        stats.agents_refreshed, stats.skills_refreshed, stats.pi_refreshed
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
            for entry in registry.current.iter().chain(registry.entries.iter()) {
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
    let cache_dir = config::global_base_dir().join(".vstack").join("cache");
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
