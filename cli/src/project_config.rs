use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

/// Project-level agent customization config.
///
/// Loaded from `vstack.toml` at the project root. These sections are
/// independent of the source repo's mapping sections and survive updates.
///
/// `[agent-skills]` is the single source of truth for which skills appear
/// in each agent's frontmatter. Users can add or remove entries and run
/// `vstack refresh` to apply.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProjectConfig {
    /// Skills attached to each agent's frontmatter.  This is the
    /// authoritative list — editing it and running `vstack refresh`
    /// updates the generated agent files.
    #[serde(rename = "agent-skills")]
    pub agent_skills: HashMap<String, Vec<String>>,
    /// Per-agent display colors written to agent frontmatter when supported.
    /// Empty values are ignored and fall back to source frontmatter.
    #[serde(rename = "agent-colors")]
    pub agent_colors: HashMap<String, String>,
    /// Typed frontmatter overrides parsed from `[agent-frontmatter]` and
    /// `[agent-frontmatter.<harness>]`. Parsed manually in `load()` so nested
    /// TOML tables can coexist with per-agent inline tables.
    #[serde(skip)]
    pub agent_frontmatter: HashMap<String, crate::agent::AgentFrontmatterOverrides>,
    #[serde(skip)]
    pub agent_frontmatter_by_harness:
        HashMap<String, HashMap<String, crate::agent::AgentFrontmatterOverrides>>,
    #[serde(rename = "agent-skills-optional")]
    pub agent_skills_optional: HashMap<String, Vec<crate::mapping::OptionalSkill>>,
    #[serde(rename = "agent-launch-instructions", alias = "agent-guidance")]
    pub agent_guidance: HashMap<String, String>,
    #[serde(rename = "agent-additional-instructions", alias = "agent-instructions")]
    pub agent_instructions: HashMap<String, String>,
    #[serde(rename = "skill-instructions")]
    pub skill_instructions: HashMap<String, String>,
    #[serde(rename = "custom-hooks", default)]
    pub custom_hooks: Vec<CustomHook>,
}

/// A user-defined hook from project config
#[derive(Debug, Clone, Deserialize)]
pub struct CustomHook {
    pub event: String,
    #[serde(default)]
    pub matcher: Option<String>,
    pub command: String,
    /// What this hook does — inlined as instruction text in harnesses
    /// that can't run scripts (Cursor, OpenCode, Codex).
    #[serde(default)]
    pub description: Option<String>,
    /// Which agents to apply to: "all", a role name ("engineer"),
    /// or a list of agent names (["rust", "iced"])
    #[serde(default = "default_hook_agents")]
    pub agents: CustomHookTarget,
}

fn default_hook_agents() -> CustomHookTarget {
    CustomHookTarget::All("all".into())
}

fn is_agent_frontmatter_override(value: &toml::Value) -> bool {
    let Some(table) = value.as_table() else {
        return false;
    };
    [
        "color",
        "model",
        "tools",
        "pane",
        "mode",
        "sandbox-mode",
        "model-reasoning-effort",
    ]
    .iter()
    .any(|key| table.contains_key(*key))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CustomHookTarget {
    All(String),
    List(Vec<String>),
}

impl ProjectConfig {
    /// Load project config from a directory's `vstack.toml`.
    /// Returns default (empty) if the file is missing or unparseable.
    pub fn load(project_root: &Path) -> Self {
        let path = project_root.join("vstack.toml");
        if !path.exists() {
            return Self::default();
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let mut parsed: Self = toml::from_str(&content).unwrap_or_default();
        parsed.load_agent_frontmatter_tables(&content);
        parsed
    }

    fn load_agent_frontmatter_tables(&mut self, content: &str) {
        let Ok(value) = toml::from_str::<toml::Value>(content) else {
            return;
        };
        let Some(table) = value
            .get("agent-frontmatter")
            .and_then(|value| value.as_table())
        else {
            return;
        };

        for (key, value) in table {
            if is_agent_frontmatter_override(value) {
                if let Ok(overrides) = value.clone().try_into() {
                    self.agent_frontmatter.insert(key.clone(), overrides);
                }
                continue;
            }

            let Some(agent_table) = value.as_table() else {
                continue;
            };
            let harness_key = crate::harness::Harness::from_id(key)
                .map(|harness| harness.id().to_string())
                .unwrap_or_else(|| key.clone());
            for (agent_name, override_value) in agent_table {
                if !is_agent_frontmatter_override(override_value) {
                    continue;
                }
                if let Ok(overrides) = override_value.clone().try_into() {
                    self.agent_frontmatter_by_harness
                        .entry(harness_key.clone())
                        .or_default()
                        .insert(agent_name.clone(), overrides);
                }
            }
        }
    }

    /// Get the project-level skill list for an agent, if one exists.
    /// Returns `None` when the agent has no `[agent-skills]` entry,
    /// which tells callers to fall back to source mapping.
    pub fn agent_skills_for(&self, agent_name: &str) -> Option<&Vec<String>> {
        self.agent_skills.get(agent_name)
    }

    /// Get the project-level color override for an agent, if one exists.
    pub fn color_for(&self, agent_name: &str) -> Option<&str> {
        self.agent_colors
            .get(agent_name)
            .map(|s| s.as_str())
            .filter(|s| !s.trim().is_empty())
    }

    /// Get global + harness-specific frontmatter overrides for an agent.
    pub fn frontmatter_for(
        &self,
        agent_name: &str,
        harness_id: &str,
    ) -> crate::agent::AgentFrontmatterOverrides {
        let base = self
            .agent_frontmatter
            .get(agent_name)
            .cloned()
            .unwrap_or_default();
        let harness = self
            .agent_frontmatter_by_harness
            .get(harness_id)
            .and_then(|entries| entries.get(agent_name))
            .cloned()
            .unwrap_or_default();
        base.merge(&harness)
    }

    /// Get guidance text for an agent
    pub fn guidance_for(&self, agent_name: &str) -> Option<&str> {
        self.agent_guidance.get(agent_name).map(|s| s.as_str())
    }

    /// Get additional instructions for an agent
    pub fn instructions_for(&self, agent_name: &str) -> Option<&str> {
        self.agent_instructions.get(agent_name).map(|s| s.as_str())
    }

    /// Get project-specific instructions for a skill
    pub fn skill_instructions_for(&self, skill_name: &str) -> Option<&str> {
        self.skill_instructions
            .get(skill_name)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
    }

    /// Get custom hooks that apply to a specific agent, as CustomHookEntry for agent frontmatter
    pub fn custom_hooks_for(
        &self,
        agent_name: &str,
        agent_role: &crate::agent::AgentRole,
    ) -> Vec<crate::agent::CustomHookEntry> {
        let role_str = agent_role.as_str();
        self.custom_hooks
            .iter()
            .filter(|h| match &h.agents {
                CustomHookTarget::All(s) => s == "all",
                CustomHookTarget::List(names) => {
                    names.iter().any(|n| n == agent_name || n == role_str)
                }
            })
            .map(|h| crate::agent::CustomHookEntry {
                event: h.event.clone(),
                matcher: h.matcher.clone(),
                command: h.command.clone(),
                description: h.description.clone(),
            })
            .collect()
    }

    /// Merge extracted agent sections into vstack.toml, preserving existing entries.
    /// Only writes new entries — never overwrites user-set values.
    pub fn save_extracted(
        &mut self,
        project_root: &Path,
        agent_name: &str,
        extracted: &crate::agent::AgentExtras,
    ) {
        let needs_guidance =
            extracted.guidance.is_some() && self.guidance_for(agent_name).is_none();
        let needs_instructions =
            extracted.instructions.is_some() && self.instructions_for(agent_name).is_none();
        let needs_color = extracted.color.is_some()
            && self.color_for(agent_name).is_none()
            && self
                .agent_frontmatter
                .get(agent_name)
                .and_then(|entry| entry.color.as_deref())
                .is_none();

        if !needs_guidance && !needs_instructions && !needs_color {
            return;
        }

        if let Some(ref color) = extracted.color {
            if needs_color {
                self.agent_colors
                    .insert(agent_name.to_string(), color.clone());
            }
        }

        if let Some(ref text) = extracted.guidance {
            if needs_guidance {
                self.agent_guidance
                    .insert(agent_name.to_string(), text.clone());
            }
        }
        if let Some(ref text) = extracted.instructions {
            if needs_instructions {
                self.agent_instructions
                    .insert(agent_name.to_string(), text.clone());
            }
        }

        // Write back to vstack.toml surgically — preserve comments and structure
        let path = project_root.join("vstack.toml");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let mut out = existing.clone();

        if needs_color {
            if let Some(ref color) = extracted.color {
                out = upsert_agent_value_in_section(&out, "[agent-colors]", agent_name, color);
            }
        }

        if needs_guidance {
            if let Some(ref text) = extracted.guidance {
                out = upsert_agent_value_in_section(
                    &out,
                    "[agent-launch-instructions]",
                    agent_name,
                    text,
                );
            }
        }

        if needs_instructions {
            if let Some(ref text) = extracted.instructions {
                out = upsert_agent_value_in_section(
                    &out,
                    "[agent-additional-instructions]",
                    agent_name,
                    text,
                );
            }
        }

        if out != existing {
            let _ = std::fs::write(&path, out);
        }
    }
}

/// Set `<agent_name> = "<text>"` inside `[section_header]`:
///
/// - if the section has any line starting with `<agent_name> =` (any value),
///   replace the FIRST such line and drop any duplicate trailing siblings;
/// - otherwise append the entry to the section.
///
/// This is duplicate-safe even if the file got corrupted by a prior bug —
/// running it always leaves exactly one `<agent_name> = ...` line in the
/// section.
fn upsert_agent_value_in_section(
    content: &str,
    section_header: &str,
    agent_name: &str,
    text: &str,
) -> String {
    // Escape ALL chars that would produce invalid TOML inside a single
    // double-quoted string. Notably `\n` MUST be escaped — otherwise a
    // multi-line value silently produces a malformed file that subsequent
    // parses treat as empty, causing this function to be re-invoked and
    // append fresh duplicates of the body lines on every install.
    let escaped = text
        .replace('\\', "\\\\")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
        .replace('"', "\\\"");
    let new_line = format!("{} = \"{}\"", agent_name, escaped);
    let key_prefix = format!("{} =", agent_name);
    let key_prefix_tight = format!("{}=", agent_name);

    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::with_capacity(lines.len());
    let mut in_section = false;
    let mut wrote_replacement = false;
    let mut found_any = false;

    for line in &lines {
        let trimmed = line.trim();

        if trimmed.starts_with('[') && !trimmed.starts_with("# [") {
            // Section transition
            in_section = trimmed == section_header;
            result.push(line.to_string());
            continue;
        }

        if in_section
            && (trimmed.starts_with(&key_prefix) || trimmed.starts_with(&key_prefix_tight))
        {
            // First occurrence: replace; subsequent: drop
            found_any = true;
            if !wrote_replacement {
                result.push(new_line.clone());
                wrote_replacement = true;
            }
            continue;
        }

        result.push(line.to_string());
    }

    let mut out = result.join("\n");
    if content.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }

    if !found_any {
        // Section didn't have an entry yet — append one.
        let entry = format!("{}\n", new_line);
        out = insert_entries_into_section(&out, section_header, &entry);
    }
    out
}

/// Write computed agent→skill mappings into the project vstack.toml.
///
/// Merge upstream skill additions into existing `[agent-skills]` entries.
///
/// For each agent in `updates`, if the project toml already has an entry,
/// replace it with the updated list (which includes upstream additions).
/// Agents without an existing entry are ignored — `write_agent_skills`
/// handles those.
pub fn merge_upstream_agent_skills(project_root: &Path, updates: &HashMap<String, Vec<String>>) {
    if updates.is_empty() {
        return;
    }
    let path = project_root.join("vstack.toml");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut out = content.clone();
    for (agent, skills) in updates {
        // Build the replacement value
        let new_value = if skills.is_empty() {
            "[]".to_string()
        } else {
            let mut v = "[\n".to_string();
            for s in skills {
                v.push_str(&format!("    \"{}\",\n", s));
            }
            v.push(']');
            v
        };

        // Replace the existing entry using regex-like line matching.
        // Handles both inline arrays and multi-line arrays.
        out = replace_toml_array_value(&out, "[agent-skills]", agent, &new_value);
    }

    if out != content {
        let _ = std::fs::write(&path, out);
    }
}

/// Merge upstream additions into the project's `[agent-skills-optional]`.
/// Same principle as `merge_upstream_agent_skills`: only add entries whose
/// `skill` name isn't already present — never remove user edits.
pub fn merge_upstream_agent_skills_optional(
    project_root: &Path,
    updates: &HashMap<String, Vec<crate::mapping::OptionalSkill>>,
) {
    if updates.is_empty() {
        return;
    }
    let path = project_root.join("vstack.toml");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut out = content.clone();
    for (agent, skills) in updates {
        if skills.is_empty() {
            continue;
        }
        let mut v = "[\n".to_string();
        for s in skills {
            let when = s.when.replace('"', "\\\"");
            v.push_str(&format!(
                "    {{ skill = \"{}\", when = \"{}\" }},\n",
                s.skill, when
            ));
        }
        v.push(']');
        out = replace_toml_array_value(&out, "[agent-skills-optional]", agent, &v);
    }

    if out != content {
        let _ = std::fs::write(&path, out);
    }
}

/// Replace a TOML array value for a key within a specific section.
/// Handles both `key = [...]` (inline) and multi-line arrays.
fn replace_toml_array_value(
    content: &str,
    section_header: &str,
    key: &str,
    new_value: &str,
) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut i = 0;
    let mut in_section = false;

    while i < lines.len() {
        let trimmed = lines[i].trim();

        // Track which section we're in
        if trimmed.starts_with('[') && !trimmed.starts_with("# [") {
            in_section = trimmed == section_header;
        }

        if in_section {
            // Check if this line starts the key we want to replace
            let key_prefix = format!("{} = ", key);
            let key_prefix_tight = format!("{}= ", key);
            if trimmed.starts_with(&key_prefix) || trimmed.starts_with(&key_prefix_tight) {
                // Check if it's a multi-line array (value starts with [ but doesn't close)
                if let Some(after_eq) = trimmed.split_once('=').map(|(_, v)| v.trim()) {
                    if after_eq.starts_with('[') && !after_eq.contains(']') {
                        // Multi-line array — skip until closing ]
                        i += 1;
                        while i < lines.len() && !lines[i].trim().starts_with(']') {
                            i += 1;
                        }
                        // Skip the closing ] line too
                        if i < lines.len() {
                            i += 1;
                        }
                    } else {
                        // Single-line — skip just this line
                        i += 1;
                    }
                } else {
                    i += 1;
                }
                // Write replacement
                result.push(format!("{} = {}", key, new_value));
                continue;
            }
        }

        result.push(lines[i].to_string());
        i += 1;
    }

    let mut out = result.join("\n");
    // Preserve trailing newline if original had one
    if content.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// For each agent: if the project toml already has an `[agent-skills]` entry,
/// preserve it (the user may have added or removed skills).  For agents that
/// have NO entry yet, write the computed list from source mapping.
///
/// This must be called AFTER `ensure_project_config` and AFTER the skill
/// mapping is computed.
pub fn write_agent_skills(project_root: &Path, agent_skill_map: &HashMap<String, Vec<String>>) {
    let path = project_root.join("vstack.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // Parse the existing file to discover which agents already have entries.
    // We only ADD agents that are missing — never clobber user edits.
    let parsed: ProjectConfig = toml::from_str(&existing).unwrap_or_default();

    // Sort agents for deterministic output
    let mut agents: Vec<&String> = agent_skill_map.keys().collect();
    agents.sort();

    let mut new_entries = String::new();
    for agent in agents {
        if parsed.agent_skills.contains_key(agent.as_str()) {
            continue; // User's list is authoritative — don't overwrite
        }
        let skills = &agent_skill_map[agent];
        new_entries.push_str(&format!("{} = [", agent));
        if skills.is_empty() {
            new_entries.push_str("]\n");
        } else {
            new_entries.push('\n');
            for s in skills {
                new_entries.push_str(&format!("    \"{}\",\n", s));
            }
            new_entries.push_str("]\n");
        }
    }

    if new_entries.is_empty() {
        return;
    }

    // Insert the new entries into the [agent-skills] section
    let out = insert_entries_into_section(&existing, "[agent-skills]", &new_entries);
    if out != existing {
        let _ = std::fs::write(&path, out);
    }
}

/// Write default agent color entries to `[agent-frontmatter]`.
/// Legacy `[agent-colors]` remains supported and is treated as user-owned.
/// Only adds agents that don't already have a color — never overwrites user edits.
pub fn write_agent_colors(project_root: &Path, agent_color_map: &HashMap<String, Option<String>>) {
    let path = project_root.join("vstack.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    let parsed = ProjectConfig::load(project_root);

    let mut content = existing.clone();
    if !content.contains("[agent-frontmatter]") {
        content.push_str("\n\n# ── Agent Frontmatter ────────────────────────────────\n");
        content.push_str("# Optional generated-frontmatter overrides.\n");
        content.push_str("#\n");
        content.push_str("[agent-frontmatter]\n");
    }

    let mut agents: Vec<&String> = agent_color_map.keys().collect();
    agents.sort();

    let mut new_entries = String::new();
    for agent in agents {
        if parsed.agent_colors.contains_key(agent.as_str()) {
            continue;
        }
        if parsed
            .agent_frontmatter
            .get(agent.as_str())
            .and_then(|entry| entry.color.as_deref())
            .is_some()
        {
            continue;
        }
        let color = agent_color_map
            .get(agent)
            .and_then(|value| value.as_deref())
            .unwrap_or("");
        let escaped = color.replace('\\', "\\\\").replace('"', "\\\"");
        new_entries.push_str(&format!("{} = {{ color = \"{}\" }}\n", agent, escaped));
    }

    if new_entries.is_empty() {
        if content != existing {
            let _ = std::fs::write(&path, content);
        }
        return;
    }

    let out = insert_entries_into_section(&content, "[agent-frontmatter]", &new_entries);
    if out != existing {
        let _ = std::fs::write(&path, out);
    }
}

/// Write `[agent-skills-optional]` entries to the project's vstack.toml.
/// Only adds agents that don't already have an entry — never overwrites user edits.
pub fn write_agent_skills_optional(
    project_root: &Path,
    agent_optional_map: &HashMap<String, Vec<crate::mapping::OptionalSkill>>,
) {
    if agent_optional_map.is_empty() {
        return;
    }
    let path = project_root.join("vstack.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    let parsed: ProjectConfig = toml::from_str(&existing).unwrap_or_default();

    // Ensure the section header exists
    let mut content = existing.clone();
    if !content.contains("[agent-skills-optional]") {
        content.push_str("\n\n# ── Optional Skills ──────────────────────────────────\n");
        content.push_str("# Specialist skills loaded on demand. The agent gets a\n");
        content.push_str("# \"Load When Needed\" table. Edit `when` descriptions\n");
        content.push_str("# or remove entries, then run `vstack refresh`.\n");
        content.push_str("#\n");
        content.push_str("[agent-skills-optional]\n");
    }

    let mut agents: Vec<&String> = agent_optional_map.keys().collect();
    agents.sort();

    let mut new_entries = String::new();
    for agent in agents {
        if parsed.agent_skills_optional.contains_key(agent.as_str()) {
            continue;
        }
        let skills = &agent_optional_map[agent];
        if skills.is_empty() {
            continue;
        }
        new_entries.push_str(&format!("{} = [\n", agent));
        for s in skills {
            let when = s.when.replace('"', "\\\"");
            new_entries.push_str(&format!(
                "    {{ skill = \"{}\", when = \"{}\" }},\n",
                s.skill, when
            ));
        }
        new_entries.push_str("]\n");
    }

    if new_entries.is_empty() {
        return;
    }

    let out = insert_entries_into_section(&content, "[agent-skills-optional]", &new_entries);
    if out != existing {
        let _ = std::fs::write(&path, out);
    }
}

/// Create or update vstack.toml at the project root.
///
/// - If the file doesn't exist, generates a full template with commented placeholders.
/// - If the file exists, appends commented placeholders for any new agents/skills
///   not already mentioned, and updates the installed-skills reference block.
///   Never modifies existing user content.
pub fn ensure_project_config(project_root: &Path, agents: &[String], skills: &[String]) {
    let path = project_root.join("vstack.toml");

    if path.exists() {
        migrate_section_names(&path);
        update_project_config(&path, agents, skills);
    } else {
        create_project_config(&path, agents, skills);
    }
}

/// Migrate old TOML section names to new ones (one-time, idempotent).
fn migrate_section_names(path: &Path) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    let mut out = content.clone();
    let migrations = [
        ("[agent-guidance]", "[agent-launch-instructions]"),
        ("[agent-instructions]", "[agent-additional-instructions]"),
    ];
    let mut changed = false;
    for (old, new) in &migrations {
        // Only rename if the old name exists and the new name does NOT
        if out.contains(old) && !out.contains(new) {
            out = out.replace(old, new);
            changed = true;
        }
    }
    if changed {
        let _ = std::fs::write(path, out);
    }
}

fn create_project_config(path: &Path, agents: &[String], skills: &[String]) {
    let mut out = String::new();

    out.push_str("# ─────────────────────────────────────────────────────\n");
    out.push_str("# vstack.toml — project-level agent customization\n");
    out.push_str("#\n");
    out.push_str("# Customize agent behavior for this project. These\n");
    out.push_str("# settings are merged into generated agent files on\n");
    out.push_str("# every install and refresh.\n");
    out.push_str("#\n");
    out.push_str("# After editing, run:  vstack refresh\n");
    out.push_str("# ─────────────────────────────────────────────────────\n");
    out.push('\n');

    // ── agent-launch-instructions ──
    out.push_str("\n# ── Launch Instructions ───────────────────────────────\n");
    out.push_str("# Adds a \"## Launch Instructions\" section near the top\n");
    out.push_str("# of each agent file. Defines what the agent should\n");
    out.push_str("# do when it is first invoked in your project.\n");
    out.push_str("#\n");
    out.push_str("# For multi-line values, use triple quotes:\n");
    out.push_str("#   agent = \"\"\"\n");
    out.push_str("#   First line.\n");
    out.push_str("#   Second line.\n");
    out.push_str("#   \"\"\"\n");
    out.push_str("#\n");
    out.push_str("[agent-launch-instructions]\n\n");
    for (i, name) in agents.iter().enumerate() {
        out.push_str(&format!("{} = \"\"\n", name));
        if i + 1 < agents.len() {
            out.push('\n');
        }
    }

    // ── agent-additional-instructions ──
    out.push_str("\n\n# ── Additional Instructions ──────────────────────────\n");
    out.push_str("# Adds a \"## Additional Instructions\" section at the\n");
    out.push_str("# bottom of each agent file. Project-specific rules,\n");
    out.push_str("# conventions, or reminders for this agent.\n");
    out.push_str("#\n");
    out.push_str("[agent-additional-instructions]\n\n");
    for (i, name) in agents.iter().enumerate() {
        out.push_str(&format!("{} = \"\"\n", name));
        if i + 1 < agents.len() {
            out.push('\n');
        }
    }

    // ── skill-instructions ──
    out.push_str("\n\n# ── Skill Instructions ────────────────────────────────\n");
    out.push_str("# Adds a \"## Project Instructions\" section at the\n");
    out.push_str("# top of each skill's SKILL.md. Project-specific\n");
    out.push_str("# context for how this skill applies to your codebase.\n");
    out.push_str("# Won't overwrite the skill author's own instructions.\n");
    out.push_str("#\n");
    out.push_str("[skill-instructions]\n\n");
    for (i, name) in skills.iter().enumerate() {
        out.push_str(&format!("{} = \"\"\n", name));
        if i + 1 < skills.len() {
            out.push('\n');
        }
    }

    // ── agent-skills ──
    out.push_str("\n\n# ── Agent Skills ─────────────────────────────────────\n");
    out.push_str("# Skills attached to each agent's frontmatter.\n");
    out.push_str("# This is the single source of truth — add or remove\n");
    out.push_str("# skills here and run `vstack refresh` to apply.\n");
    out.push_str("#\n");
    out.push_str("# Populated automatically at install time from source\n");
    out.push_str("# mappings. You can freely add your own skills to any\n");
    out.push_str("# agent's list (they don't need to be in the vstack\n");
    out.push_str("# repo — local skill directories work too).\n");
    out.push_str("#\n");
    out.push_str("[agent-skills]\n");
    // Actual skill lists are written by write_agent_skills() after
    // the mapping is computed, so we just emit the section header here.

    // ── agent-frontmatter ──
    out.push_str("\n\n# ── Agent Frontmatter ────────────────────────────────\n");
    out.push_str("# Optional generated-frontmatter overrides. Top-level entries\n");
    out.push_str("# apply to every harness; harness-specific tables win. Prefer\n");
    out.push_str("# harness-specific model values when model id formats differ.\n");
    out.push_str("# Supported fields: color, model, tools, pane, mode,\n");
    out.push_str("# sandbox-mode, model-reasoning-effort. Unknown fields ignored.\n");
    out.push_str("# Example:\n");
    out.push_str("# researcher = { color = \"purple\" }\n");
    out.push_str("# [agent-frontmatter.pi]\n");
    out.push_str("# researcher = { model = \"openai/gpt-5.5:xhigh\", tools = [\"read\", \"grep\", \"find\", \"ls\", \"bash\", \"edit\", \"write\", \"web_research\"] }\n");
    out.push_str("#\n");
    out.push_str("[agent-frontmatter]\n");
    // Color entries are still also supported from legacy [agent-colors].

    // ── agent-skills-optional ──
    out.push_str("\n\n# ── Optional Skills ──────────────────────────────────\n");
    out.push_str("# Specialist skills loaded on demand. The agent gets a\n");
    out.push_str("# \"Load When Needed\" table. Edit `when` descriptions\n");
    out.push_str("# or remove entries, then run `vstack refresh`.\n");
    out.push_str("#\n");
    out.push_str("[agent-skills-optional]\n");
    // Actual entries are written by write_agent_skills_optional().

    // ── custom-hooks ──
    out.push_str("\n\n# ── Custom Hooks ─────────────────────────────────────\n");
    out.push_str("# Project-local hooks not from the vstack source repo.\n");
    out.push_str("# Each hook needs: event, command, and optional matcher.\n");
    out.push_str("#\n");
    out.push_str("# [[custom-hooks]]\n");
    out.push_str(
        "# event = \"PreToolUse\"      # PreToolUse | PostToolUse | PostCompact | TaskCompleted\n",
    );
    out.push_str("# matcher = \"Bash\"           # optional: Bash | Edit|Write | (omit for all)\n");
    out.push_str("# command = \"./scripts/my-hook.sh\"\n");
    out.push_str("# description = \"What this hook does\"     # inlined as instructions in non-Claude-Code harnesses\n");
    out.push_str("# agents = \"all\"             # \"all\", a role (\"engineer\"), or a list [\"rust\", \"iced\"]\n");

    append_skills_reference(&mut out, skills);
    let _ = std::fs::write(path, out);
}

fn update_project_config(path: &Path, agents: &[String], skills: &[String]) {
    let Ok(existing) = std::fs::read_to_string(path) else {
        return;
    };

    // Find agents not already mentioned as a TOML key (commented or active).
    let new_agents: Vec<&String> = agents
        .iter()
        .filter(|name| is_new_key(&existing, name))
        .collect();

    // Find skills not already mentioned
    let new_skills: Vec<&String> = skills
        .iter()
        .filter(|name| is_new_key(&existing, name))
        .collect();

    // Strip old skills reference block and re-append with current list
    let content = strip_skills_reference(&existing);
    let mut out = content.trim_end().to_string();
    out.push('\n');

    let mut all_new_keys: Vec<(&str, Vec<&String>)> = Vec::new();
    if !new_agents.is_empty() {
        all_new_keys.push(("[agent-launch-instructions]", new_agents.clone()));
        all_new_keys.push(("[agent-additional-instructions]", new_agents));
    }
    if !new_skills.is_empty() {
        all_new_keys.push(("[skill-instructions]", new_skills));
    }

    for (section, keys) in all_new_keys {
        out = insert_keys_into_section(&out, section, &keys);
    }

    append_skills_reference(&mut out, skills);
    // Only write if content actually changed to avoid bumping mtime,
    // which would make staleness checks flag everything as outdated.
    if out != existing {
        let _ = std::fs::write(path, out);
    }
}

/// Returns true if a name does NOT appear as a TOML key in the file.
fn is_new_key(content: &str, name: &str) -> bool {
    let patterns = [
        format!("{} =", name),
        format!("{}=", name),
        format!("# {} =", name),
        format!("# {}=", name),
    ];
    !patterns.iter().any(|p| content.contains(p))
}

fn append_skills_reference(out: &mut String, skills: &[String]) {
    if !skills.is_empty() {
        out.push_str("\n\n# ── Installed skills (reference) ─────────────────────\n");
        for name in skills {
            out.push_str(&format!("#   {}\n", name));
        }
    }
}

/// Insert new keys into a specific TOML section, preserving all other content.
fn insert_keys_into_section(content: &str, section_header: &str, new_keys: &[&String]) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut i = 0;
    let mut found = false;

    while i < lines.len() {
        let trimmed = lines[i].trim();
        result.push(lines[i].to_string());

        if trimmed == section_header {
            found = true;
            // Scan forward past existing keys in this section
            i += 1;
            while i < lines.len() {
                let next = lines[i].trim();
                let is_key_line = next.contains(" = ") || next.contains("= ");
                let is_comment = next.starts_with('#');

                if next.starts_with('[') && !next.starts_with("# [") {
                    break;
                }
                if next.is_empty() || (is_comment && next.starts_with("# ──")) {
                    break;
                }

                result.push(lines[i].to_string());

                if !is_key_line && !is_comment {
                    i += 1;
                    break;
                }
                i += 1;
            }

            if !new_keys.is_empty() {
                // Blank line before new entries if section already had content
                if result.last().map_or(false, |l| {
                    !l.trim().is_empty() && l.trim() != section_header
                }) {
                    result.push(String::new());
                }
                for name in new_keys {
                    result.push(format!("{} = \"\"", name));
                }
            }
            continue;
        }

        i += 1;
    }

    // If the section didn't exist, create it at the end
    if !found {
        result.push(String::new());
        result.push(section_header.to_string());
        for name in new_keys {
            result.push(format!("{} = \"\"", name));
        }
    }

    result.join("\n")
}

/// Insert raw TOML text after existing keys in a `[section]`, preserving all
/// comments and surrounding content.  If the section doesn't exist, appends it.
fn insert_entries_into_section(content: &str, section_header: &str, entries: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut i = 0;
    let mut inserted = false;

    while i < lines.len() {
        let trimmed = lines[i].trim();
        result.push(lines[i].to_string());

        if trimmed == section_header {
            // Scan forward past existing keys/values (including multi-line arrays)
            i += 1;
            while i < lines.len() {
                let next = lines[i].trim();
                // Stop at next section header or section-separator comment
                if next.starts_with('[') && !next.starts_with("# [") {
                    break;
                }
                if next.starts_with("# ──") {
                    break;
                }
                // Stop at blank line that isn't inside a multi-line array
                if next.is_empty() {
                    break;
                }
                result.push(lines[i].to_string());
                i += 1;
            }
            // Insert new entries here, right after existing keys
            for line in entries.lines() {
                result.push(line.to_string());
            }
            inserted = true;
            continue;
        }

        i += 1;
    }

    if !inserted {
        result.push(String::new());
        result.push(section_header.to_string());
        for line in entries.lines() {
            result.push(line.to_string());
        }
    }

    result.join("\n")
}

fn strip_skills_reference(content: &str) -> String {
    // The reference block is always pure comments: a `# ── Installed skills...`
    // header followed by `#   <name>` lines. Strip the contiguous comment run
    // (and any trailing blank lines that belonged to it) starting at the
    // header. Anything after that run — including TOML the user added below —
    // is preserved verbatim.
    let markers = [
        "# ── Installed skills (reference)",
        "# Installed skills (for reference",
    ];

    for marker in markers {
        let Some(header_byte) = content.find(marker) else {
            continue;
        };

        // Anchor strip start at the start of the header line, including any
        // blank lines that immediately precede it (those typically belong to
        // the section gap our writer emits).
        let mut start = header_byte;
        let prefix = &content[..start];
        let trimmed_prefix = prefix.trim_end_matches([' ', '\t']);
        let consumed = prefix.len() - trimmed_prefix.len();
        start = start.saturating_sub(consumed);
        // Pull in the leading newlines too (one per `\n`).
        while start > 0 && content.as_bytes()[start - 1] == b'\n' {
            start -= 1;
        }

        // Walk forward consuming the contiguous comment block.
        let mut cursor = header_byte;
        loop {
            let line_end = content[cursor..]
                .find('\n')
                .map(|i| cursor + i + 1)
                .unwrap_or(content.len());
            let line = &content[cursor..line_end];
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') || line.trim().is_empty() {
                cursor = line_end;
                if cursor >= content.len() {
                    break;
                }
            } else {
                break;
            }
        }

        let mut out = String::with_capacity(content.len());
        out.push_str(&content[..start]);
        if !out.is_empty() && !out.ends_with('\n') && cursor < content.len() {
            out.push('\n');
        }
        out.push_str(&content[cursor..]);
        return out;
    }
    content.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_config_parses_all_sections() {
        let toml = r#"
[agent-skills]
rust = ["rust-arch", "rust-async", "my-custom-skill"]

[agent-colors]
rust = "green"
generalist = ""

[agent-launch-instructions]
rust = "Use when working on backend Rust services."

[agent-additional-instructions]
rust = "Always run clippy before committing."
"#;
        let config: ProjectConfig = toml::from_str(toml).unwrap();
        let skills = config.agent_skills_for("rust").unwrap();
        assert_eq!(skills.len(), 3);
        assert_eq!(skills[0], "rust-arch");
        assert_eq!(skills[2], "my-custom-skill");

        assert_eq!(config.color_for("rust"), Some("green"));
        assert_eq!(config.color_for("generalist"), None);

        assert_eq!(
            config.guidance_for("rust"),
            Some("Use when working on backend Rust services.")
        );
        assert_eq!(
            config.instructions_for("rust"),
            Some("Always run clippy before committing.")
        );

        // Unknown agent returns None
        assert!(config.agent_skills_for("unknown").is_none());
        assert!(config.color_for("unknown").is_none());
        assert!(config.guidance_for("unknown").is_none());
        assert!(config.instructions_for("unknown").is_none());
    }

    #[test]
    fn project_config_missing_file_returns_default() {
        let config = ProjectConfig::load(std::path::Path::new("/nonexistent/path"));
        assert!(config.agent_skills.is_empty());
        assert!(config.agent_colors.is_empty());
        assert!(config.agent_guidance.is_empty());
        assert!(config.agent_instructions.is_empty());
    }

    #[test]
    fn project_config_parses_frontmatter_overrides() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_test_agent_frontmatter_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("vstack.toml"),
            r#"
[agent-frontmatter]
researcher = { color = "purple", model = "generic-model" }

[agent-frontmatter.pi]
researcher = { model = "openai/gpt-5.5:xhigh", tools = "read, grep, web_research" }

[agent-frontmatter.claude]
researcher = { model = "opus[1m]" }
"#,
        )
        .unwrap();

        let config = ProjectConfig::load(&dir);
        let pi = config.frontmatter_for("researcher", "pi");
        assert_eq!(pi.color.as_deref(), Some("purple"));
        assert_eq!(pi.model.as_deref(), Some("openai/gpt-5.5:xhigh"));
        assert_eq!(
            pi.tools,
            Some(vec!["read".into(), "grep".into(), "web_research".into()])
        );
        let claude = config.frontmatter_for("researcher", "claude-code");
        assert_eq!(claude.model.as_deref(), Some("opus[1m]"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_agent_colors_adds_missing_entries_without_overwriting() {
        let dir =
            std::env::temp_dir().join(format!("vstack_test_agent_colors_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vstack.toml");
        std::fs::write(
            &path,
            "[agent-colors]\nrust = \"blue\"\n\n[agent-skills]\nrust = []\n",
        )
        .unwrap();

        let mut colors = HashMap::new();
        colors.insert("rust".to_string(), Some("green".to_string()));
        colors.insert("iced".to_string(), Some("magenta".to_string()));
        write_agent_colors(&dir, &colors);

        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("rust = \"blue\""));
        assert!(updated.contains("iced = { color = \"magenta\" }"));

        let config = ProjectConfig::load(&dir);
        assert_eq!(config.color_for("rust"), Some("blue"));
        assert_eq!(
            config.frontmatter_for("iced", "pi").color.as_deref(),
            Some("magenta")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_config_agent_skills_authoritative() {
        // Project [agent-skills] is the single source of truth
        let toml = r#"
[agent-skills]
iced = ["iced-rs", "trading-design", "my-custom"]

[agent-launch-instructions]
rust = "Use for Rust work."
"#;
        let config: ProjectConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.guidance_for("rust"), Some("Use for Rust work."));
        let iced_skills = config.agent_skills_for("iced").unwrap();
        assert_eq!(iced_skills, &["iced-rs", "trading-design", "my-custom"]);
        // Agent without entry → None (falls back to source mapping)
        assert!(config.agent_skills_for("rust").is_none());
    }

    #[test]
    fn update_project_config_appends_new_agents() {
        let dir =
            std::env::temp_dir().join(format!("vstack_test_update_config_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        // Create initial config with "rust" agent
        create_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        let initial = std::fs::read_to_string(&path).unwrap();
        assert!(initial.contains("rust = \"\""));
        assert!(initial.contains("#   rust-arch"));

        // Update with "rust" + new "iced" agent and new skill
        update_project_config(
            &path,
            &["rust".into(), "iced".into()],
            &["rust-arch".into(), "trading-design".into()],
        );
        let updated = std::fs::read_to_string(&path).unwrap();

        // Original rust placeholders preserved
        assert!(updated.contains("rust = \"\""));
        // New iced agent added (uncommented, empty value)
        assert!(updated.contains("iced = \"\""));
        // Skills reference updated
        assert!(updated.contains("#   trading-design"));
        // Old skills still listed
        assert!(updated.contains("#   rust-arch"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_project_config_preserves_user_edits() {
        let dir =
            std::env::temp_dir().join(format!("vstack_test_preserve_edits_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        // Simulate user-edited file with active (uncommented) config
        let user_content = r#"[agent-launch-instructions]
rust = "Use for my backend services."

[agent-additional-instructions]
rust = "Always use thiserror for errors."
"#;
        std::fs::write(&path, user_content).unwrap();

        // Update with rust (already present) + new iced
        update_project_config(
            &path,
            &["rust".into(), "iced".into()],
            &["trading-design".into()],
        );
        let updated = std::fs::read_to_string(&path).unwrap();

        // User content preserved
        assert!(updated.contains("rust = \"Use for my backend services.\""));
        assert!(updated.contains("rust = \"Always use thiserror for errors.\""));
        // New agent added (uncommented, empty value)
        assert!(updated.contains("iced = \"\""));
        // Rust not duplicated
        let iced_section = updated.find("iced = \"\"").unwrap();
        assert!(
            !updated[iced_section..].contains("rust = \"\""),
            "rust should not appear in new agents section"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_project_config_no_change_when_all_present() {
        let dir =
            std::env::temp_dir().join(format!("vstack_test_no_change_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        create_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        let before = std::fs::read_to_string(&path).unwrap();

        // Same agents/skills — should not add "New agents" section
        update_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        let after = std::fs::read_to_string(&path).unwrap();

        assert!(!after.contains("── New agents"));
        // Content should be essentially the same (skills ref regenerated but identical)
        assert_eq!(before.trim(), after.trim());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_agent_value_replaces_empty_placeholder() {
        let toml = "[agent-launch-instructions]\nrust = \"\"\ngeneralist = \"\"\n";
        let out = upsert_agent_value_in_section(
            toml,
            "[agent-launch-instructions]",
            "rust",
            "Pick the highest-priority backend task.",
        );
        assert!(out.contains("rust = \"Pick the highest-priority backend task.\""));
        assert!(out.contains("generalist = \"\""));
        // Exactly one rust line
        assert_eq!(out.lines().filter(|l| l.starts_with("rust = ")).count(), 1);
    }

    #[test]
    fn upsert_agent_value_collapses_duplicates() {
        // Simulate corruption: section has the same key 3 times
        let toml = "[agent-launch-instructions]\n\
rust = \"first\"\n\
rust = \"second\"\n\
rust = \"third\"\n\
generalist = \"\"\n";
        let out =
            upsert_agent_value_in_section(toml, "[agent-launch-instructions]", "rust", "canonical");
        // Duplicates collapsed to a single line with the new value
        let rust_lines: Vec<&str> = out.lines().filter(|l| l.starts_with("rust = ")).collect();
        assert_eq!(
            rust_lines.len(),
            1,
            "expected a single rust line, got {rust_lines:?}"
        );
        assert_eq!(rust_lines[0], "rust = \"canonical\"");
        // Other agent untouched
        assert!(out.contains("generalist = \"\""));
    }

    #[test]
    fn upsert_agent_value_only_touches_target_section() {
        let toml = "[agent-launch-instructions]\nrust = \"\"\n\n[agent-additional-instructions]\nrust = \"DO NOT TOUCH\"\n";
        let out = upsert_agent_value_in_section(
            toml,
            "[agent-launch-instructions]",
            "rust",
            "launch text",
        );
        assert!(out.contains("[agent-launch-instructions]\nrust = \"launch text\""));
        assert!(
            out.contains("[agent-additional-instructions]\nrust = \"DO NOT TOUCH\""),
            "additional-instructions section corrupted: {out}"
        );
    }

    #[test]
    fn upsert_agent_value_escapes_newlines() {
        // Regression: a multi-line value used to be written with literal
        // newlines inside a single double-quoted string, producing invalid
        // TOML. On the next run the parser would fail, ProjectConfig::load
        // would return default, save_extracted would think the value was
        // missing, and upsert would write again — leaving the previous
        // body lines as orphans and compounding the corruption every run.
        let toml = "[agent-launch-instructions]\nrust = \"\"\n";
        let multiline = "first line\nsecond line\nthird line";
        let out =
            upsert_agent_value_in_section(toml, "[agent-launch-instructions]", "rust", multiline);

        // Result must parse as valid TOML
        let parsed: toml::Value = toml::from_str(&out)
            .unwrap_or_else(|e| panic!("upsert produced invalid TOML: {e}\n---\n{out}"));

        // The value round-trips correctly
        let value = parsed
            .get("agent-launch-instructions")
            .and_then(|t| t.get("rust"))
            .and_then(|v| v.as_str())
            .expect("missing rust value");
        assert_eq!(value, multiline);

        // No literal newlines inside the value's line in the source
        assert!(
            out.contains(r#"rust = "first line\nsecond line\nthird line""#),
            "expected escaped \\n sequence, got: {out}"
        );
    }

    #[test]
    fn upsert_agent_value_appends_when_missing() {
        let toml = "[agent-launch-instructions]\ngeneralist = \"\"\n";
        let out = upsert_agent_value_in_section(
            toml,
            "[agent-launch-instructions]",
            "rust",
            "new launch",
        );
        assert!(out.contains("rust = \"new launch\""));
    }

    #[test]
    fn strip_skills_reference_handles_trailing_active_toml() {
        // Simulates a vstack.toml where the user appended a real `[[custom-hooks]]`
        // block AFTER the reference block. The previous logic refused to strip
        // (because the tail was not pure comments), causing each refresh to
        // append a fresh duplicate reference block. The fix strips the
        // contiguous comment run only, leaving any later TOML intact.
        let content = "[agent-skills]\nrust = []\n\n\
# ── Installed skills (reference) ─────────────────────\n\
#   rust-arch\n\
#   rust-async\n\
\n\
[[custom-hooks]]\n\
event = \"PreToolUse\"\n\
command = \"./scripts/x.sh\"\n";

        let stripped = strip_skills_reference(content);
        assert!(
            !stripped.contains("Installed skills (reference)"),
            "reference block should be gone, got: {stripped}"
        );
        assert!(
            stripped.contains("[[custom-hooks]]"),
            "user-added TOML should be preserved, got: {stripped}"
        );
        assert!(
            stripped.contains("event = \"PreToolUse\""),
            "user-added TOML body should be preserved, got: {stripped}"
        );
    }

    #[test]
    fn strip_skills_reference_keeps_newline_before_trailing_toml() {
        let content = "# agents = \"all\"\n\n# ── Installed skills (reference) ─────────────────────\n#   rust\n[agent-frontmatter.pi]\nresearcher = { model = \"m\" }\n";
        let stripped = strip_skills_reference(content);
        assert!(
            stripped.contains("# agents = \"all\"\n[agent-frontmatter.pi]"),
            "active TOML should remain on its own line, got: {stripped:?}"
        );
    }

    #[test]
    fn update_project_config_idempotent_with_trailing_active_toml() {
        // Even with active TOML below the reference block, repeated refreshes
        // must not grow the file (no duplicate reference blocks).
        let dir = std::env::temp_dir().join(format!(
            "vstack_test_idempotent_refresh_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        create_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        // Manually append an active block AFTER the auto-generated reference
        let mut current = std::fs::read_to_string(&path).unwrap();
        current.push_str(
            "\n\n[[custom-hooks]]\nevent = \"PreToolUse\"\ncommand = \"./scripts/x.sh\"\n",
        );
        std::fs::write(&path, &current).unwrap();

        // First update may reorder (moves regenerated reference to end).
        // The test we care about: subsequent updates are byte-stable.
        update_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        let after_first = std::fs::read_to_string(&path).unwrap();

        for _ in 0..3 {
            update_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        }
        let after_n = std::fs::read_to_string(&path).unwrap();

        assert_eq!(
            after_first, after_n,
            "file should be byte-stable across repeated refreshes"
        );
        // Reference block appears exactly once
        assert_eq!(
            after_n.matches("# ── Installed skills (reference)").count(),
            1,
            "expected single reference block, got\n{after_n}"
        );
        // Custom hooks block preserved
        assert!(
            after_n.contains("[[custom-hooks]]"),
            "custom-hooks block lost: {after_n}"
        );
        // Skill listed in reference exactly once
        assert_eq!(
            after_n.matches("#   rust-arch").count(),
            1,
            "rust-arch should appear in reference exactly once: {after_n}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_project_config_preserves_full_skills_reference() {
        let dir =
            std::env::temp_dir().join(format!("vstack_test_skills_ref_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        // Initial install with multiple skills
        create_project_config(
            &path,
            &["rust".into()],
            &["rust-arch".into(), "rust-ffi".into(), "worktree".into()],
        );
        let initial = std::fs::read_to_string(&path).unwrap();
        assert!(initial.contains("#   rust-arch"));
        assert!(initial.contains("#   rust-ffi"));
        assert!(initial.contains("#   worktree"));

        // Incremental install adds one new skill but passes ALL installed skills
        // (simulating the fixed behavior in add.rs)
        update_project_config(
            &path,
            &["rust".into()],
            &[
                "rust-arch".into(),
                "rust-ffi".into(),
                "second-opinion".into(),
                "worktree".into(),
            ],
        );
        let updated = std::fs::read_to_string(&path).unwrap();

        // ALL skills present in reference — not just the new one
        assert!(
            updated.contains("#   rust-arch"),
            "rust-arch missing from reference"
        );
        assert!(
            updated.contains("#   rust-ffi"),
            "rust-ffi missing from reference"
        );
        assert!(
            updated.contains("#   worktree"),
            "worktree missing from reference"
        );
        assert!(
            updated.contains("#   second-opinion"),
            "second-opinion missing from reference"
        );

        // New skill got a [skill-instructions] placeholder
        assert!(
            updated.contains("second-opinion = \"\""),
            "second-opinion placeholder missing"
        );
        // Existing skills NOT re-added as placeholders
        let rust_ffi_count = updated.matches("rust-ffi = \"\"").count();
        assert_eq!(
            rust_ffi_count, 1,
            "rust-ffi placeholder duplicated (count={})",
            rust_ffi_count
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
