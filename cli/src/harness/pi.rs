use crate::agent::{self, Agent, AgentRole};
use crate::hook::Hook;
use anyhow::Result;
use std::path::{Path, PathBuf};

/// Generate a Pi agent file (`<scope>/agents/<name>.md`).
///
/// Pi has no built-in subagents; agent files only act as agent definitions when
/// a Pi extension that loads `agents/*.md` is also installed. Even then, the
/// markdown body is the canonical place for vstack-managed prose, so we emit
/// the same "Required Skills" / hook prose / additional instructions sections
/// that other harnesses use.
///
/// Frontmatter format:
/// ```yaml
/// ---
/// name: rust
/// description: "..."
/// tools: read, grep, find, ls, bash, edit, write
/// model: claude-opus-4-5
/// pane: true
/// ---
/// ```
pub fn generate_agent(
    agent: &Agent,
    dir: &Path,
    skills: &[(String, String)],
    optional_skills: &[(String, String)],
    _hooks: &[Hook],
    extras: &agent::AgentExtras,
) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)?;

    let path = dir.join(format!("{}.md", agent.name));

    let model = pi_model_for(&agent.model);
    let tools = pi_tools_for(&agent.role);

    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", agent.name));

    let desc = agent.description.replace('\\', "\\\\").replace('"', "\\\"");
    output.push_str(&format!("description: \"{}\"\n", desc));
    output.push_str(&format!("tools: {}\n", tools));
    output.push_str(&format!("model: {}\n", model));
    if matches!(agent.role, AgentRole::Engineer) {
        output.push_str("pane: true\n");
    }
    output.push_str("---\n\n");

    output.push_str("> **Never edit this file directly.** To make additions or modifications, edit the appropriate section in `./vstack.toml`. Then run `vstack refresh`.\n\n");

    let guidance = agent::guidance_section(extras.guidance.as_deref());
    let skills_section = agent::load_skills_section(skills, optional_skills);
    let combined = format!("{}{}", guidance, skills_section);
    let body = agent::insert_after_intro(&agent.body, &combined);
    let hooks_prose = agent::custom_hooks_section(&extras.custom_hooks);
    let instructions = agent::instructions_section(extras.instructions.as_deref());
    let body = agent::append_section(&body, &hooks_prose);
    let body = agent::append_section(&body, &instructions);
    output.push_str(&body);

    if !output.ends_with('\n') {
        output.push('\n');
    }

    std::fs::write(&path, &output)?;
    Ok(path)
}

/// Map vstack canonical model names to Pi model identifiers.
///
/// Pi defaults to OpenAI models for vstack-managed agents. Pi accepts
/// `provider/model` and an optional `:thinking` shorthand (per the Pi
/// `--model` flag), so we encode the canonical effort level alongside
/// the model id. Users can still override per-agent in source frontmatter.
pub fn pi_model_for(model: &str) -> String {
    match model.to_lowercase().as_str() {
        "opus" => "openai/gpt-5.5:xhigh".into(),
        "sonnet" => "openai/gpt-5.5:high".into(),
        "haiku" => "openai/gpt-5.5:medium".into(),
        other => other.into(),
    }
}

/// Pi tool list for an agent role.
///
/// Engineers get the full read+write toolset; reviewers/managers get a
/// read-only toolset so they can investigate without mutating the workspace.
pub fn pi_tools_for(role: &AgentRole) -> &'static str {
    match role {
        AgentRole::Engineer => "read, grep, find, ls, bash, edit, write",
        AgentRole::Reviewer | AgentRole::Manager => "read, grep, find, ls, bash",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{Agent, AgentExtras, AgentRole};

    fn agent_fixture(name: &str, role: AgentRole, model: &str) -> Agent {
        Agent {
            name: name.into(),
            description: "Pi test agent".into(),
            model: model.into(),
            role,
            color: None,
            body: format!("# {name}\n\nIntro.\n\n## Capabilities\n\nDoes work.\n"),
            source_path: PathBuf::new(),
        }
    }

    #[test]
    fn pi_model_mapping() {
        assert_eq!(pi_model_for("opus"), "openai/gpt-5.5:xhigh");
        assert_eq!(pi_model_for("sonnet"), "openai/gpt-5.5:high");
        assert_eq!(pi_model_for("haiku"), "openai/gpt-5.5:medium");
        assert_eq!(pi_model_for("custom-id"), "custom-id");
    }

    #[test]
    fn pi_tools_engineer_gets_write_tools() {
        let tools = pi_tools_for(&AgentRole::Engineer);
        assert!(tools.contains("write"));
        assert!(tools.contains("edit"));
        assert!(tools.contains("bash"));
    }

    #[test]
    fn pi_tools_reviewer_is_read_only() {
        let tools = pi_tools_for(&AgentRole::Reviewer);
        assert!(!tools.contains("write"));
        assert!(!tools.contains("edit"));
        assert!(tools.contains("read"));
    }

    #[test]
    fn generate_agent_writes_pi_frontmatter_and_body() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_pi_agent_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let agent = agent_fixture("rust", AgentRole::Engineer, "opus");
        let extras = AgentExtras {
            guidance: Some("Read open issues and start.".into()),
            instructions: Some("Run clippy before commits.".into()),
            custom_hooks: Vec::new(),
        };
        let skills = vec![(
            "rust-arch".into(),
            "Architecture patterns for Rust: more details.".into(),
        )];
        let path =
            generate_agent(&agent, &dir, &skills, &[], &[], &extras).expect("generate ok");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("name: rust"));
        assert!(content.contains("model: openai/gpt-5.5:xhigh"));
        assert!(content.contains("tools: read, grep, find, ls, bash, edit, write"));
        assert!(content.contains("pane: true"));
        assert!(content.contains("## Launch Instructions"));
        assert!(content.contains("Read open issues and start."));
        assert!(content.contains("## Required Skills"));
        assert!(content.contains("rust-arch"));
        assert!(content.contains("## Additional Instructions"));
        assert!(content.contains("Never edit this file directly"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_agent_reviewer_omits_pane_and_uses_read_tools() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_pi_agent_reviewer_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let agent = agent_fixture("reviewer-arch", AgentRole::Reviewer, "sonnet");
        let extras = AgentExtras::default();
        let path =
            generate_agent(&agent, &dir, &[], &[], &[], &extras).expect("generate ok");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("model: openai/gpt-5.5:high"));
        assert!(content.contains("tools: read, grep, find, ls, bash"));
        assert!(!content.contains("pane: true"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
