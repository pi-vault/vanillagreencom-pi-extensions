# pi-skills-manager

![Skills Manager overlay](assets/skills-manager.png)

Dedicated Pi skills manager for vstack packages. It provides one `/skill` manager view for browsing, previewing, creating, editing, renaming, deleting, and enabling/disabling skills while preserving Pi's native `/skill:<name>` invocation and autocomplete behavior.

## Commands

| Command | Action |
| --- | --- |
| `/skill` | Open the skills manager overlay. |
| `/skill disable` | Disable the manager feature toggle; run `/reload` to unload hooks/commands. |
| `/skill enable` | Recovery command when disabled; enables the manager and reloads. |
| `/skill:<name>` | Native Pi skill invocation; handled by Pi, not this manager. |

## What it does

- Leaves Pi's top-level `enableSkillCommands` setting alone so native `/skill:<name>` commands and autocomplete keep working.
- Hides Pi's default startup `[Skills]` block so skill discovery lives in the manager.
- Shows project/global skills separately from package/library skills.
- Searches by name, description, source, scope, and path.
- Inserts enabled skills into the editor as native `/skill:<name>` commands.
- Previews frontmatter and rendered skill content.
- Toggles skills on/off through Pi settings filters; run `/reload` after toggles to fully apply prompt/resource changes.
- Creates new project/global skills with the current model and thinking level, falling back to a deterministic template if model auth is unavailable.
- Edits, renames, and deletes your own top-level project/global skills. Package skills are preview/toggle/insert only.

## Keys

Browse mode:

- Type to search.
- `↑/↓` selects.
- `Enter` inserts an enabled native `/skill:<name>` command, or starts **Create new skill** from the first row.
- `Tab` previews the selected skill.
- `Ctrl+X` enables/disables the selected skill.
- `Backspace` deletes your own selected skill when the search box is empty.
- `Esc` clears search, then closes.

Preview mode:

- `↑/↓`, `-/=`, `Home/End` scroll.
- `Enter` inserts an enabled native `/skill:<name>` command.
- `Ctrl+X` enables/disables.
- `Ctrl+E` edits, `Ctrl+R` renames, and `Backspace`/`Delete` deletes your own skills.
- `Esc` or `Tab` returns to browse.

Edit mode: `Ctrl+S` saves; `Esc` returns to preview.

Create flow:

1. Name, normalized to a lowercase skill slug.
2. Trigger-focused description.
3. Visibility: project (`.pi/skills/<name>/SKILL.md`) or global (`~/.pi/agent/skills/<name>/SKILL.md`).

## Settings

Settings are exposed through `pi-extension-manager` under **Skills Manager**:

- `enabled`
- `hideStartupSkillsBlock`
- `aiGenerationEnabled`
- `defaultCreateLocation`
- `popupWidth`, `popupMaxHeight`, `listRows`

## Notes

Native skill command registration is controlled by Pi's own `enableSkillCommands` setting (`/settings` → **Skill commands**). This manager does not change that setting.

## Attribution

This package is locally owned by vstack and is based on ideas and portions of the MIT-licensed [`@kmiyh/pi-skills-menu`](https://github.com/Kmiyh/pi-skills-menu). See `THIRD_PARTY_NOTICES.md`.
