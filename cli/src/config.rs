use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Lock file entry for tracking installed items
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockEntry {
    pub name: String,
    pub kind: ItemKind,
    pub source: String,
    pub harnesses: Vec<String>,
    pub method: InstallMethod,
    pub installed_at: String,
    /// Content hash of the source at install time. Used for staleness
    /// detection instead of mtime (immune to git checkout/rebase).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemKind {
    Skill,
    Agent,
    Hook,
    PiExtension,
}

impl ItemKind {
    /// Short human label used in TUI rows, dialogs, and inspector. Stays
    /// consistent with [`Display`] except `PiExtension` reads as
    /// "pi-package" — that's what users call them in the package manager.
    pub fn label_short(self) -> &'static str {
        match self {
            ItemKind::Agent => "agent",
            ItemKind::Skill => "skill",
            ItemKind::Hook => "hook",
            ItemKind::PiExtension => "pi-package",
        }
    }

    /// Same as [`label_short`] but accepts `Option<ItemKind>`; falls back
    /// to "item" when None (e.g. the `vstack (cli)` binary update entry).
    pub fn label_short_or_item(kind: Option<Self>) -> &'static str {
        kind.map_or("item", Self::label_short)
    }
}

impl std::fmt::Display for ItemKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ItemKind::Skill => write!(f, "skill"),
            ItemKind::Agent => write!(f, "agent"),
            ItemKind::Hook => write!(f, "hook"),
            ItemKind::PiExtension => write!(f, "pi-extension"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Symlink,
    Copy,
}

impl std::fmt::Display for InstallMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallMethod::Symlink => write!(f, "symlink"),
            InstallMethod::Copy => write!(f, "copy"),
        }
    }
}

/// Lock file tracking all installations
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LockFile {
    pub version: u32,
    pub entries: BTreeMap<String, LockEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SourceRegistry {
    /// Last selected source outside a project-scoped install.
    pub current: Option<String>,
    pub entries: Vec<String>,
    /// Sources the user explicitly removed. This lets vstack ship a default
    /// source for fresh installs without resurrecting it after removal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_entries: Vec<String>,
    /// Last selected source per project root. This prevents choosing a source
    /// in one project from silently changing the package source used by
    /// another project.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub project_current: BTreeMap<String, String>,
}

impl LockFile {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self {
                version: 1,
                ..Default::default()
            });
        }
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("reading lock file {}", path.display()))?;
        serde_json::from_str(&content).context("parsing lock file")
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn add(&mut self, entry: LockEntry) {
        self.entries.insert(entry.name.clone(), entry);
    }

    pub fn remove(&mut self, name: &str) -> Option<LockEntry> {
        self.entries.remove(name)
    }
}

impl SourceRegistry {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("reading source registry {}", path.display()))?;
        let mut registry: Self =
            serde_json::from_str(&content).context("parsing source registry")?;
        let pruned = registry.prune_dead_paths();
        if pruned > 0 {
            // Best-effort persist; if it fails we still return the in-memory
            // pruned view so the rest of the run sees a clean list.
            let _ = registry.save(path);
        }
        Ok(registry)
    }

    /// Drop entries that look like local filesystem paths but no longer exist.
    /// Remote shorthand entries (e.g. "owner/repo", "https://...") are
    /// preserved unconditionally — they're not paths to check. Returns the
    /// number of entries removed.
    pub fn prune_dead_paths(&mut self) -> usize {
        let before = self.entries.len();
        self.entries.retain(|entry| !is_dead_local_path(entry));
        if let Some(current) = &self.current
            && is_dead_local_path(current)
        {
            self.current = None;
        }
        let before_project = self.project_current.len();
        self.project_current
            .retain(|_, source| !is_dead_local_path(source));
        before - self.entries.len() + before_project - self.project_current.len()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn remember(&mut self, source: &str) {
        // Temporary installer sandboxes should be usable for the current
        // command, but should not become sticky source choices in the user's
        // global registry. They are often one-off partial vstack sources such
        // as /tmp/vstack-install-<package>.
        if is_temporary_local_path(source) {
            return;
        }
        self.remember_entry(source);
        self.current = Some(source.to_string());
    }

    pub fn remember_for_project(&mut self, project_root: &Path, source: &str) {
        // Same temp-source rule as the global current: allow the current
        // command to use /tmp explicitly, but don't make it sticky.
        if is_temporary_local_path(source) {
            return;
        }
        self.remember_entry(source);
        self.project_current
            .insert(project_key(project_root), source.to_string());
    }

    pub fn current_for_project(&self, project_root: &Path) -> Option<&str> {
        self.project_current
            .get(&project_key(project_root))
            .map(String::as_str)
    }

    fn remember_entry(&mut self, source: &str) {
        if !self.entries.iter().any(|entry| entry == source) {
            self.entries.push(source.to_string());
        }
    }

    pub fn forget(&mut self, source: &str) {
        self.entries.retain(|e| e != source);
        if self.current.as_deref() == Some(source) {
            self.current = None;
        }
        self.project_current.retain(|_, current| current != source);
        if !self.removed_entries.iter().any(|entry| entry == source) {
            self.removed_entries.push(source.to_string());
        }
    }

    pub fn was_removed(&self, source: &str) -> bool {
        self.removed_entries.iter().any(|entry| entry == source)
    }
}

fn project_key(project_root: &Path) -> String {
    project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf())
        .display()
        .to_string()
}

/// True iff `entry` looks like a local filesystem path (absolute, `~`-tilde,
/// or relative starting with `.`) that no longer exists. Anything that doesn't
/// match those shapes (remote shorthand `owner/repo`, URLs, etc.) is left
/// alone — only path-like entries can become dead.
fn is_dead_local_path(entry: &str) -> bool {
    expanded_local_path(entry).is_some_and(|expanded| !expanded.exists())
}

/// True iff `entry` is a local path under the OS temp directory. These paths
/// are valid to install from explicitly, but should not be remembered as
/// durable package sources.
fn is_temporary_local_path(entry: &str) -> bool {
    let Some(path) = expanded_local_path(entry) else {
        return false;
    };
    let temp = std::env::temp_dir();
    let temp = temp.canonicalize().unwrap_or(temp);
    let path = path.canonicalize().unwrap_or(path);
    path.starts_with(temp)
}

fn expanded_local_path(entry: &str) -> Option<PathBuf> {
    let looks_like_path = entry.starts_with('/')
        || entry.starts_with('~')
        || entry.starts_with("./")
        || entry.starts_with("../");
    if !looks_like_path {
        return None;
    }
    Some(if let Some(stripped) = entry.strip_prefix("~/") {
        user_home_dir().join(stripped)
    } else if entry == "~" {
        user_home_dir()
    } else {
        PathBuf::from(entry)
    })
}

/// Resolve the lock file path based on scope
pub fn lock_file_path(global: bool) -> PathBuf {
    if global {
        global_state_dir().join(".vstack-lock.json")
    } else {
        project_root().join(".vstack-lock.json")
    }
}

pub fn user_home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("~"))
}

pub fn user_config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| user_home_dir().join(".config"))
}

pub fn global_state_dir() -> PathBuf {
    user_config_dir().join("vstack")
}

pub fn source_registry_path() -> PathBuf {
    global_state_dir().join("sources.json")
}

pub fn display_path(path: &Path) -> String {
    let home = user_home_dir();
    if let Ok(rel) = path.strip_prefix(&home) {
        if rel.as_os_str().is_empty() {
            "~".into()
        } else {
            format!("~/{}", rel.display())
        }
    } else {
        path.display().to_string()
    }
}

/// Base directory for legacy home-scoped global installations.
pub fn global_base_dir() -> PathBuf {
    user_home_dir()
}

pub fn claude_global_dir() -> PathBuf {
    user_home_dir().join(".claude")
}

pub fn cursor_global_dir() -> PathBuf {
    user_home_dir().join(".cursor")
}

pub fn opencode_global_dir() -> PathBuf {
    if let Some(config_path) = std::env::var_os("OPENCODE_CONFIG").map(PathBuf::from)
        && let Some(parent) = config_path.parent()
    {
        return parent.to_path_buf();
    }
    std::env::var_os("OPENCODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_config_dir().join("opencode"))
}

pub fn opencode_global_config_path() -> PathBuf {
    std::env::var_os("OPENCODE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| opencode_global_dir().join("opencode.json"))
}

pub fn opencode_project_config_path() -> PathBuf {
    let root = project_root();
    let json = root.join("opencode.json");
    if json.exists() {
        return json;
    }
    let jsonc = root.join("opencode.jsonc");
    if jsonc.exists() {
        return jsonc;
    }
    json
}

pub fn codex_home_dir() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home_dir().join(".codex"))
}

/// Global Pi config directory.
///
/// Honors `PI_CODING_AGENT_DIR` so tests can redirect to a sandbox dir
/// without touching the real `~/.pi/agent`.
pub fn pi_global_dir() -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home_dir().join(".pi").join("agent"))
}

/// Project-local Pi config directory.
pub fn pi_project_dir() -> PathBuf {
    project_root().join(".pi")
}

/// Pi `settings.json` for the chosen scope.
pub fn pi_settings_path(global: bool) -> PathBuf {
    if global {
        pi_global_dir().join("settings.json")
    } else {
        pi_project_dir().join("settings.json")
    }
}

/// Directory where Pi packages installed via vstack land.
pub fn pi_packages_dir(global: bool) -> PathBuf {
    if global {
        pi_global_dir().join("packages")
    } else {
        pi_project_dir().join("packages")
    }
}

/// Directory where vstack symlinks Pi package `bin` entries.
/// Pi expects CLI tools at `<scope>/bin/<name>`.
pub fn pi_bin_dir(global: bool) -> PathBuf {
    if global {
        pi_global_dir().join("bin")
    } else {
        pi_project_dir().join("bin")
    }
}

/// Source index file: per-scope JSON tracking which vstack repo each
/// installed package was copied from, so the extension manager can detect
/// when source-side versions advance and prompt the user to update.
pub fn pi_source_index_path(global: bool) -> PathBuf {
    if global {
        pi_global_dir().join(".vstack-source.json")
    } else {
        pi_project_dir().join(".vstack-source.json")
    }
}

/// Find the project root by walking up from CWD.
/// Looks for `.vstack-lock.json` or harness config dirs.
pub fn project_root() -> PathBuf {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(find_project_root).clone()
}

fn find_project_root() -> PathBuf {
    let Ok(mut dir) = std::env::current_dir() else {
        return PathBuf::from(".");
    };
    loop {
        if dir.join(".vstack-lock.json").exists()
            || dir.join(".claude").is_dir()
            || dir.join(".cursor").is_dir()
            || dir.join(".codex").is_dir()
            || dir.join(".opencode").is_dir()
            || dir.join(".pi").is_dir()
            || dir.join(".agents").is_dir()
        {
            return dir;
        }
        if !dir.pop() {
            break;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Get current timestamp as ISO 8601 string (UTC)
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Manual ISO 8601 without chrono: YYYY-MM-DDTHH:MM:SSZ
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;
    // Days since epoch to date (simplified Gregorian)
    let (year, month, day) = epoch_days_to_date(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

// ── Content hash helpers (FNV-1a — portable, deterministic) ──────

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x00000100000001B3;

fn fnv1a(data: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

fn fnv1a_chain(state: u64, data: &[u8]) -> u64 {
    let mut h = state;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Compute a content hash for a single file.
fn hash_file_bytes(path: &Path) -> u64 {
    match std::fs::read(path) {
        Ok(content) => fnv1a(&content),
        Err(_) => 0,
    }
}

/// Compute a content hash for a directory (all files, sorted by relative path).
fn hash_dir_bytes(dir: &Path) -> u64 {
    let mut state = FNV_OFFSET;
    let mut walker = walkdir::WalkDir::new(dir).min_depth(1).sort_by_file_name().into_iter();
    while let Some(entry) = walker.next() {
        let Ok(entry) = entry else { continue };
        if entry.file_type().is_dir() && should_skip_hash_dir(entry.file_name().to_string_lossy().as_ref()) {
            walker.skip_current_dir();
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(dir).unwrap_or(entry.path());
        // Hash relative path then file content into the running state
        state = fnv1a_chain(state, rel.to_string_lossy().as_bytes());
        if let Ok(content) = std::fs::read(entry.path()) {
            state = fnv1a_chain(state, &content);
        }
    }
    state
}

fn should_skip_hash_dir(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".git" | ".turbo" | ".next" | ".cache" | "build" | "out" | "coverage" | ".pi"
    )
}

/// Extract the relevant section for a given name from a TOML file.
/// Returns the raw text of lines belonging to that key, or empty if not found.
/// This avoids hashing the entire config when only one agent/skill's section matters.
fn extract_toml_section_for(path: &Path, name: &str) -> Vec<u8> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    let mut capturing = false;
    for line in content.lines() {
        let trimmed = line.trim();
        // Match: name = ... (start of this key's value)
        if trimmed.starts_with(&format!("{} =", name))
            || trimmed.starts_with(&format!("\"{}\" =", name))
        {
            capturing = true;
            result.extend_from_slice(line.as_bytes());
            result.push(b'\n');
            continue;
        }
        if capturing {
            // Stop at next top-level key or section header
            if trimmed.starts_with('[')
                || (!trimmed.is_empty()
                    && !trimmed.starts_with('#')
                    && !trimmed.starts_with('"')
                    && !trimmed.starts_with('{')
                    && !trimmed.starts_with(']')
                    && !trimmed.starts_with(',')
                    && !line.starts_with(' ')
                    && !line.starts_with('\t'))
            {
                capturing = false;
            } else {
                result.extend_from_slice(line.as_bytes());
                result.push(b'\n');
            }
        }
    }
    result
}

/// Refresh cached repos for all remote sources found in installed lock entries.
/// Called once at TUI startup so staleness checks see the latest content.
pub fn refresh_remote_caches(lock: &LockFile) {
    let mut seen = std::collections::HashSet::new();
    for entry in lock.entries.values() {
        let src = &entry.source;
        // Only remote sources (owner/repo format)
        if src.contains('/') && !src.starts_with('.') && !src.starts_with('/') {
            if !seen.insert(src.clone()) {
                continue;
            }
            let cache_key = src.replace('/', "_");
            let cache_dir = global_base_dir()
                .join(".vstack")
                .join("cache")
                .join(&cache_key);
            if cache_dir.join(".git").exists() {
                let fetch = std::process::Command::new("git")
                    .args(["fetch", "origin", "--quiet"])
                    .current_dir(&cache_dir)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
                if fetch.is_ok_and(|s| s.success()) {
                    let _ = std::process::Command::new("git")
                        .args(["reset", "--hard", "origin/HEAD"])
                        .current_dir(&cache_dir)
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
        }
    }
}

/// Resolve a lock entry's source string to an actual directory path.
/// Handles "." by walking up from CWD to find a vstack source repo,
/// and absolute paths directly.
pub fn resolve_source_path(source: &str) -> Option<PathBuf> {
    let p = Path::new(source);
    if p.is_absolute() && p.is_dir() {
        return Some(p.to_path_buf());
    }
    // Check cached repo (owner/repo → ~/.vstack/cache/owner_repo)
    if source.contains('/') && !source.starts_with('.') && !source.starts_with('/') {
        let cache_key = source.replace('/', "_");
        let cache_dir = global_base_dir()
            .join(".vstack")
            .join("cache")
            .join(&cache_key);
        if cache_dir.is_dir() {
            return Some(cache_dir);
        }
    }
    // "." or relative — walk up from CWD to find vstack source
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if crate::resolve::is_vstack_source(&dir) {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Compute source hash for a lock entry based on its kind.
pub fn compute_source_hash(entry: &LockEntry) -> String {
    let source_root = match resolve_source_path(&entry.source) {
        Some(p) => p,
        None => return String::new(),
    };
    let proj_root = project_root();

    let mut state = FNV_OFFSET;

    match entry.kind {
        ItemKind::Skill => {
            let dir = source_root.join("skills").join(&entry.name);
            if dir.exists() {
                state = fnv1a_chain(state, &hash_dir_bytes(&dir).to_le_bytes());
            }
            // Only hash this skill's section from project vstack.toml
            let project_config = proj_root.join("vstack.toml");
            let section = extract_toml_section_for(&project_config, &entry.name);
            if !section.is_empty() {
                state = fnv1a_chain(state, &section);
            }
        }
        ItemKind::Agent => {
            let file = source_root
                .join("agents")
                .join(format!("{}.md", entry.name));
            if file.exists() {
                state = fnv1a_chain(state, &hash_file_bytes(&file).to_le_bytes());
            }
            // Hash this agent's sections from both configs
            let source_config = source_root.join("vstack.toml");
            for config_path in [&source_config, &proj_root.join("vstack.toml")] {
                let section = extract_toml_section_for(config_path, &entry.name);
                if !section.is_empty() {
                    state = fnv1a_chain(state, &section);
                }
            }
        }
        ItemKind::Hook => {
            let file = source_root.join("hooks").join(format!("{}.sh", entry.name));
            if file.exists() {
                state = fnv1a_chain(state, &hash_file_bytes(&file).to_le_bytes());
            }
        }
        ItemKind::PiExtension => {
            let dir = source_root.join("pi-extensions").join(&entry.name);
            if dir.exists() {
                state = fnv1a_chain(state, &hash_dir_bytes(&dir).to_le_bytes());
            }
        }
    }

    format!("{:016x}", state)
}

/// Check if an entry's source has changed since install.
/// Uses content hash (immune to git mtime resets).
/// Falls back to "not outdated" if no hash stored (old lock format).
pub fn is_source_changed(entry: &LockEntry) -> bool {
    if entry.source_hash.is_empty() {
        return false; // No hash stored — assume fresh (legacy lock)
    }
    let current = compute_source_hash(entry);
    current != entry.source_hash
}

/// Discovered item on disk that was installed by vstack.
#[derive(Debug)]
pub struct DiskItem {
    pub name: String,
    pub kind: ItemKind,
}

/// Scan the canonical skill directory and harness agent/hook directories
/// for items installed by vstack. Skills are identified by the `.vstack-refreshed`
/// marker. Agents/hooks are identified by presence in harness directories that
/// vstack manages (we can only reliably detect these via the lock, so this
/// function focuses on skills).
pub fn scan_installed_skills_on_disk(global: bool) -> Vec<DiskItem> {
    let mut items = Vec::new();

    // Canonical skill location: .agents/skills/<name>/
    let canonical_skills = if global {
        vec![
            global_state_dir().join("skills"),
            codex_home_dir().join("skills"),
        ]
    } else {
        vec![project_root().join(".agents").join("skills")]
    };

    let mut seen = std::collections::HashSet::new();
    for skills_dir in canonical_skills {
        if !skills_dir.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&skills_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Only count directories with a .vstack-refreshed marker
            if !path.join(".vstack-refreshed").exists() {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if seen.insert(name.to_string()) {
                    items.push(DiskItem {
                        name: name.to_string(),
                        kind: ItemKind::Skill,
                    });
                }
            }
        }
    }

    items
}

/// Reconcile the lock file with what's actually on disk.
/// - Items on disk (with .vstack-refreshed marker) but missing from lock → re-add
/// - Items in lock but missing from disk → remove from lock
/// Returns true if the lock was modified.
pub fn reconcile_lock_with_disk(lock: &mut LockFile, global: bool, source: &str) -> bool {
    let mut modified = false;

    // Re-add skills found on disk but missing from lock
    let disk_skills = scan_installed_skills_on_disk(global);
    let now = now_iso();
    for item in &disk_skills {
        if !lock.entries.contains_key(&item.name) {
            // Determine which harnesses have this skill by checking dirs
            let mut harnesses = Vec::new();
            for harness in crate::harness::Harness::ALL {
                let skill_path = harness.skills_dir(global).join(&item.name);
                if skill_path.exists() || skill_path.is_symlink() {
                    harnesses.push(harness.id().to_string());
                }
            }
            if harnesses.is_empty() {
                // At minimum it's in the canonical location
                harnesses.push("claude-code".to_string());
            }
            let mut entry = LockEntry {
                name: item.name.clone(),
                kind: item.kind,
                source: source.to_string(),
                harnesses,
                method: InstallMethod::Symlink,
                installed_at: now.clone(),
                source_hash: String::new(),
            };
            entry.source_hash = compute_source_hash(&entry);
            eprintln!("  Recovered lock entry for installed skill: {}", item.name);
            lock.add(entry);
            modified = true;
        }
    }

    // Remove lock entries for skills whose files no longer exist on disk
    let disk_names: std::collections::HashSet<&str> =
        disk_skills.iter().map(|d| d.name.as_str()).collect();
    let stale_skills: Vec<String> = lock
        .entries
        .iter()
        .filter(|(_, e)| e.kind == ItemKind::Skill && !disk_names.contains(e.name.as_str()))
        .map(|(name, _)| name.clone())
        .collect();
    for name in stale_skills {
        // Verify the canonical dir is actually gone (not just missing the marker)
        let canonical = if global {
            global_state_dir().join("skills").join(&name)
        } else {
            project_root().join(".agents").join("skills").join(&name)
        };
        if !canonical.exists() {
            eprintln!("  Removed stale lock entry (files missing): {name}");
            lock.remove(&name);
            modified = true;
        }
    }

    // Remove stale Pi package lock entries. Pi packages do not have the skill
    // marker file; their on-disk truth is the deployed package directory and/or
    // a matching settings.json packages entry.
    let stale_pi_extensions: Vec<String> = lock
        .entries
        .iter()
        .filter(|(_, e)| {
            e.kind == ItemKind::PiExtension
                && !crate::pi_extension::is_pi_extension_installed(&e.name, global)
        })
        .map(|(name, _)| name.clone())
        .collect();
    for name in stale_pi_extensions {
        eprintln!("  Removed stale lock entry (Pi package missing): {name}");
        lock.remove(&name);
        modified = true;
    }

    modified
}

fn epoch_days_to_date(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod source_registry_tests {
    use super::*;
    use std::fs;

    fn sandbox(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vstack_source_registry_{label}_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn prune_drops_dead_absolute_paths_keeps_shorthand_and_live_paths() {
        let dir = sandbox("prune_drops_dead");
        let live = dir.join("live");
        fs::create_dir_all(&live).unwrap();
        let dead = dir.join("dead");
        // dead is intentionally not created.

        let mut reg = SourceRegistry {
            current: Some("vanillagreencom/vstack".to_string()),
            entries: vec![
                "vanillagreencom/vstack".to_string(),
                live.display().to_string(),
                dead.display().to_string(),
                "https://example.com/repo".to_string(),
            ],
            ..Default::default()
        };
        let pruned = reg.prune_dead_paths();
        assert_eq!(pruned, 1);
        assert_eq!(
            reg.entries,
            vec![
                "vanillagreencom/vstack".to_string(),
                live.display().to_string(),
                "https://example.com/repo".to_string(),
            ]
        );
        assert_eq!(reg.current.as_deref(), Some("vanillagreencom/vstack"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_clears_current_if_current_is_dead() {
        let dir = sandbox("prune_clears_current");
        let dead = dir.join("dead");
        let mut reg = SourceRegistry {
            current: Some(dead.display().to_string()),
            entries: vec![dead.display().to_string()],
            ..Default::default()
        };
        let pruned = reg.prune_dead_paths();
        assert_eq!(pruned, 1);
        assert!(reg.current.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_persists_pruned_view_to_disk() {
        let dir = sandbox("load_persists");
        let path = dir.join("sources.json");
        let dead = dir.join("dead-source").display().to_string();
        let raw = serde_json::json!({
            "current": "vanillagreencom/vstack",
            "entries": ["vanillagreencom/vstack", dead],
        });
        fs::write(&path, raw.to_string()).unwrap();

        let loaded = SourceRegistry::load(&path).unwrap();
        assert_eq!(loaded.entries, vec!["vanillagreencom/vstack".to_string()]);

        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["entries"].as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remember_ignores_temp_sources() {
        let dir = sandbox("remember_temp");
        let mut reg = SourceRegistry::default();

        reg.remember("vanillagreencom/vstack");
        reg.remember(&dir.display().to_string());

        assert_eq!(reg.current.as_deref(), Some("vanillagreencom/vstack"));
        assert_eq!(reg.entries, vec!["vanillagreencom/vstack".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remember_for_project_does_not_change_global_current() {
        let project_a = sandbox("project_a");
        let project_b = sandbox("project_b");
        let mut reg = SourceRegistry::default();

        reg.remember("vanillagreencom/vstack");
        reg.remember_for_project(&project_a, "owner/a");
        reg.remember_for_project(&project_b, "owner/b");

        assert_eq!(reg.current.as_deref(), Some("vanillagreencom/vstack"));
        assert_eq!(reg.current_for_project(&project_a), Some("owner/a"));
        assert_eq!(reg.current_for_project(&project_b), Some("owner/b"));
        assert!(reg.entries.contains(&"owner/a".to_string()));
        assert!(reg.entries.contains(&"owner/b".to_string()));
        let _ = fs::remove_dir_all(&project_a);
        let _ = fs::remove_dir_all(&project_b);
    }

    #[test]
    fn forget_clears_matching_project_current() {
        let project = sandbox("forget_project");
        let mut reg = SourceRegistry::default();
        reg.remember_for_project(&project, "owner/repo");

        reg.forget("owner/repo");

        assert_eq!(reg.current_for_project(&project), None);
        assert!(!reg.entries.contains(&"owner/repo".to_string()));
        let _ = fs::remove_dir_all(&project);
    }

    #[test]
    fn forget_records_removed_source_tombstone() {
        let mut reg = SourceRegistry::default();

        reg.forget("vanillagreencom/vstack");

        assert!(reg.was_removed("vanillagreencom/vstack"));
    }
}
