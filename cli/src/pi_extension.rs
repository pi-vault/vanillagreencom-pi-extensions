use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A Pi package discovered under `pi-extensions/<name>/`.
///
/// Pi packages are npm-shaped. We surface the subset of `package.json`
/// that vstack actually uses to display, install, and register the
/// package with Pi.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiExtension {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    /// `pi.extensions` from package.json — the relative paths Pi loads.
    #[serde(default)]
    pub pi_extensions: Vec<String>,
    /// `bin` map from package.json. Names → relative script paths.
    #[serde(default)]
    pub bin: std::collections::BTreeMap<String, String>,
    /// Directory containing the package's `package.json`.
    #[serde(skip)]
    pub source_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
struct RawPackage {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    pi: Option<PiManifest>,
    #[serde(default)]
    bin: Option<BinField>,
}

#[derive(Debug, Deserialize)]
struct PiManifest {
    #[serde(default)]
    extensions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum BinField {
    /// `"bin": "./bin/foo.js"` — implicit name = package name.
    Single(String),
    /// `"bin": { "foo": "./bin/foo.js" }`.
    Map(std::collections::BTreeMap<String, String>),
}

impl PiExtension {
    /// Parse a Pi package manifest at `pi-extensions/<name>/package.json`.
    pub fn from_dir(dir: &Path) -> Result<Self> {
        let pkg_path = dir.join("package.json");
        let raw = std::fs::read_to_string(&pkg_path)
            .with_context(|| format!("reading {}", pkg_path.display()))?;
        let parsed: RawPackage = serde_json::from_str(&raw)
            .with_context(|| format!("parsing {}", pkg_path.display()))?;

        let pi_extensions = parsed.pi.map(|m| m.extensions).unwrap_or_default();

        let bin = match parsed.bin {
            Some(BinField::Single(path)) => {
                let mut map = std::collections::BTreeMap::new();
                map.insert(parsed.name.clone(), path);
                map
            }
            Some(BinField::Map(map)) => map,
            None => std::collections::BTreeMap::new(),
        };

        Ok(PiExtension {
            name: parsed.name,
            description: parsed.description,
            version: parsed.version,
            keywords: parsed.keywords,
            pi_extensions,
            bin,
            source_dir: dir.to_path_buf(),
        })
    }
}

/// Discover Pi packages in `<source>/pi-extensions/<name>/package.json`.
pub fn discover_pi_extensions(dir: &Path) -> Result<Vec<PiExtension>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join("package.json").exists() {
            continue;
        }
        match PiExtension::from_dir(&path) {
            Ok(ext) => out.push(ext),
            Err(e) => eprintln!("Warning: skipping {}: {e}", path.display()),
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Package renames shipped by vstack. Pi de-duplicates packages by identity,
/// not by the resources they register, so a renamed package can leave a legacy
/// package behind that registers the same tool/command and crashes Pi startup.
const PI_EXTENSION_RENAMES: &[(&str, &[&str])] = &[
    // `prompt-stash` was renamed to match vstack's Pi package naming convention.
    ("pi-prompt-stash", &["prompt-stash"]),
    // `pi-subagents` was renamed once the package grew persistent tmux panes.
    ("pi-subagents-tmux", &["pi-subagents"]),
];

/// Legacy package names that should be removed from the same scope before the
/// current package is installed.
pub fn legacy_names_for(name: &str) -> &'static [&'static str] {
    PI_EXTENSION_RENAMES
        .iter()
        .find_map(|(current, legacy)| (*current == name).then_some(*legacy))
        .unwrap_or(&[])
}

/// Does the package appear to be installed in the given Pi scope?
///
/// This checks both the deployed package directory and `settings.json`, so it
/// also catches stale settings entries left after manual deletion.
pub fn is_pi_extension_installed(name: &str, global: bool) -> bool {
    let dest = crate::config::pi_packages_dir(global).join(name);
    dest.exists()
        || dest.is_symlink()
        || settings_references_package(name, &dest, global).unwrap_or(false)
}

fn settings_references_package(name: &str, dest: &Path, global: bool) -> Result<bool> {
    let settings_path = crate::config::pi_settings_path(global);
    if !settings_path.exists() {
        return Ok(false);
    }
    let settings = load_or_init_settings(&settings_path)?;
    Ok(settings
        .get("packages")
        .and_then(|p| p.as_array())
        .is_some_and(|packages| {
            packages
                .iter()
                .any(|e| entry_matches_package(e, name, dest))
        }))
}

fn remove_same_scope_legacy_packages(name: &str, global: bool) -> Result<()> {
    for legacy in legacy_names_for(name) {
        if !is_pi_extension_installed(legacy, global) {
            continue;
        }

        let removed = remove_pi_extension(legacy, global)?;
        let scope_label = if global { "global" } else { "project" };
        if removed.is_empty() {
            eprintln!("  Migrated legacy pi-package {legacy} → {name} ({scope_label} scope)");
        } else {
            let removed_list = removed
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            eprintln!(
                "  Migrated legacy pi-package {legacy} → {name} ({scope_label} scope): removed {removed_list}"
            );
        }
    }
    Ok(())
}

/// Install a Pi package into the chosen scope.
///
/// Steps:
/// 1. Remove any same-scope vstack legacy package names for this package
///    (for example `pi-subagents` → `pi-subagents-tmux`). Renamed Pi
///    packages can register the same tools, and Pi treats them as distinct
///    packages, so leaving the legacy package installed crashes startup.
/// 2. If the SAME extension (or one of its legacy names) is already installed
///    at the OTHER scope, SKIP the install with a notice. Pi loads packages
///    from BOTH global and project scopes; duplicate resources cause
///    "Tool X conflicts with Y" errors at Pi startup. The existing scope wins
///    — to switch scopes, the user explicitly runs
///    `vstack remove [--global] <name>` then re-installs at the desired scope.
/// 3. Copy the package directory into `<scope>/packages/<name>/`.
/// 4. For every entry in the package.json `bin` field, create a symlink
///    at `<scope>/bin/<cli-name>` pointing at the installed binary.
/// 5. Add a relative path entry (`./packages/<name>`) to Pi's `settings.json`
///    `packages` array, preserving any existing entries.
///
/// Pi resolves relative path entries against the settings file directory:
/// - `~/.pi/agent/settings.json` → `~/.pi/agent`
/// - `<project>/.pi/settings.json` → `<project>/.pi`
///
/// Both layouts use the same `./packages/<name>` shape.
///
/// Returns `Ok(None)` when the install was skipped due to a cross-scope
/// duplicate; callers can use this to omit the entry from the lock file
/// summary so vstack's view of state stays accurate.
pub fn install_pi_extension(ext: &PiExtension, global: bool) -> Result<Option<PathBuf>> {
    // Step 1: same-scope legacy migration for package renames. This is safe to
    // do automatically because these are vstack-owned package names and the new
    // package supersedes the old one.
    remove_same_scope_legacy_packages(&ext.name, global)?;

    // Step 2a: cross-scope guard for the same current package name. Pi loads
    // from both scopes — duplicate registration would crash startup. Existing
    // scope is authoritative.
    if is_pi_extension_installed(&ext.name, !global) {
        let this_label = if global { "global" } else { "project" };
        let other_label = if global { "project" } else { "global" };
        eprintln!(
            "  Skip pi-package {} ({this_label} install): already installed at {other_label} scope. Run `vstack remove {}{}` first to switch.",
            ext.name,
            if !global { "--global " } else { "" },
            ext.name,
        );
        return Ok(None);
    }

    // Step 2b: cross-scope guard for legacy package names. We migrate the
    // selected scope automatically, but do not delete packages from the other
    // scope as a side effect of this install.
    for legacy in legacy_names_for(&ext.name) {
        if is_pi_extension_installed(legacy, !global) {
            let this_label = if global { "global" } else { "project" };
            let other_label = if global { "project" } else { "global" };
            eprintln!(
                "  Skip pi-package {} ({this_label} install): legacy package {legacy} is installed at {other_label} scope and registers the same resources. Run `vstack remove {}{legacy}` first.",
                ext.name,
                if !global { "--global " } else { "" },
            );
            return Ok(None);
        }
    }

    let dest_dir = crate::config::pi_packages_dir(global);
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(&ext.name);

    // Idempotent reinstall: clear any prior copy. NotFound is fine; other
    // errors (EACCES etc.) propagate so we don't copy onto a broken state.
    clear_path(&dest)?;

    copy_dir(&ext.source_dir, &dest)?;
    install_bin_links(ext, &dest, global)?;
    register_in_pi_settings(&ext.name, &dest, global)?;

    Ok(Some(dest))
}

/// Remove a Pi package, its bin symlinks, and its settings entry.
pub fn remove_pi_extension(name: &str, global: bool) -> Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    let dest = crate::config::pi_packages_dir(global).join(name);

    // Read package.json BEFORE deleting the dir so we know which bin
    // symlinks to clean up. Best-effort: if the package.json is gone or
    // unreadable, skip bin cleanup rather than failing the whole remove.
    if dest.is_dir()
        && let Ok(ext) = PiExtension::from_dir(&dest)
    {
        for cli_name in ext.bin.keys() {
            let link = crate::config::pi_bin_dir(global).join(cli_name);
            match std::fs::remove_file(&link) {
                Ok(()) => removed.push(link),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }

    // NotFound is expected when the package isn't installed.
    if clear_path(&dest)? {
        removed.push(dest.clone());
    }
    if unregister_from_pi_settings(name, &dest, global)? {
        removed.push(crate::config::pi_settings_path(global));
    }
    Ok(removed)
}

/// Create symlinks at `<scope>/bin/<cli-name>` for every entry in the
/// package's `bin` field. Existing files at the link path are removed
/// first (idempotent re-install). Absolute targets so the symlink keeps
/// resolving even if relative pathing is fragile.
fn install_bin_links(ext: &PiExtension, package_dest: &Path, global: bool) -> Result<()> {
    if ext.bin.is_empty() {
        return Ok(());
    }
    let bin_dir = crate::config::pi_bin_dir(global);
    std::fs::create_dir_all(&bin_dir)?;
    for (cli_name, rel_target) in &ext.bin {
        let target = package_dest.join(rel_target);
        if !target.exists() {
            eprintln!(
                "  Warning: skip bin link {cli_name} → {} (target missing)",
                target.display()
            );
            continue;
        }
        let link = bin_dir.join(cli_name);
        let _ = std::fs::remove_file(&link);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link)
            .with_context(|| format!("symlinking bin {} → {}", link.display(), target.display()))?;
    }
    Ok(())
}

/// The canonical `packages` entry vstack writes for a given package name.
fn relative_settings_entry(name: &str) -> String {
    format!("./packages/{}", name)
}

/// True if a `packages` entry refers to our package — matches:
/// - the canonical relative form (`./packages/<name>`)
/// - the legacy absolute path we used to write
/// - either form wrapped in a `{ "source": ... }` object
fn entry_matches_package(entry: &serde_json::Value, name: &str, absolute_dest: &Path) -> bool {
    let canonical = relative_settings_entry(name);
    let absolute = absolute_dest.to_string_lossy();
    let matches_str = |s: &str| s == canonical || s == absolute.as_ref();
    match entry {
        serde_json::Value::String(s) => matches_str(s),
        serde_json::Value::Object(obj) => obj
            .get("source")
            .and_then(|v| v.as_str())
            .is_some_and(matches_str),
        _ => false,
    }
}

/// Add a relative `./packages/<name>` entry to the `packages` array of Pi's
/// `settings.json` for the scope, preserving every other entry.
///
/// Dedupe also recognizes the absolute-path form previously written by
/// vstack so re-installs don't leave a stale duplicate behind.
fn register_in_pi_settings(name: &str, dest: &Path, global: bool) -> Result<()> {
    let settings_path = crate::config::pi_settings_path(global);
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut settings = load_or_init_settings(&settings_path)?;
    let entry = relative_settings_entry(name);

    let map = settings
        .as_object_mut()
        .context("Pi settings.json is not a JSON object")?;
    if !map.contains_key("packages") {
        map.insert("packages".into(), serde_json::json!([]));
    }
    let packages = map
        .get_mut("packages")
        .and_then(|p| p.as_array_mut())
        .context("Pi settings.json `packages` is not an array")?;

    // Replace any existing entry for this package in place so reinstalling a
    // package does not change Pi extension load order. This matters when two
    // packages both customize the same UI surface (for example the editor).
    // Dedupe also recognizes legacy absolute-path entries and object forms.
    let mut replacement_index = None;
    let mut next_packages = Vec::with_capacity(packages.len() + 1);
    for existing in packages.drain(..) {
        if entry_matches_package(&existing, name, dest) {
            if replacement_index.is_none() {
                replacement_index = Some(next_packages.len());
            }
            continue;
        }
        next_packages.push(existing);
    }

    let replacement = serde_json::Value::String(entry);
    if let Some(index) = replacement_index {
        next_packages.insert(index, replacement);
    } else {
        next_packages.push(replacement);
    }
    *packages = next_packages;

    write_settings(&settings_path, &settings)
}

/// Remove the settings entry for `name` (matches relative or absolute form).
/// Returns true when `settings.json` changed.
fn unregister_from_pi_settings(name: &str, dest: &Path, global: bool) -> Result<bool> {
    let settings_path = crate::config::pi_settings_path(global);
    if !settings_path.exists() {
        return Ok(false);
    }
    let mut settings = load_or_init_settings(&settings_path)?;
    let Some(map) = settings.as_object_mut() else {
        return Ok(false);
    };

    let mut changed = false;
    if let Some(packages) = map.get_mut("packages").and_then(|p| p.as_array_mut()) {
        let before = packages.len();
        packages.retain(|entry| !entry_matches_package(entry, name, dest));
        changed = packages.len() != before;
        if packages.is_empty() {
            map.remove("packages");
            changed = true;
        }
    }

    if changed {
        write_settings(&settings_path, &settings)?;
    }
    Ok(changed)
}

fn load_or_init_settings(path: &Path) -> Result<serde_json::Value> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(&content)
        .with_context(|| format!("parsing Pi settings {}", path.display()))
}

fn write_settings(path: &Path, value: &serde_json::Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let pretty = serde_json::to_string_pretty(value)?;
    std::fs::write(path, pretty)?;
    Ok(())
}

/// Remove `path` whether it's a file, symlink, or directory. Returns
/// `Ok(true)` if something was removed, `Ok(false)` if it didn't exist.
/// Other errors (permissions, IO) propagate.
fn clear_path(path: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                std::fs::remove_dir_all(path)?;
            } else {
                std::fs::remove_file(path)?;
            }
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

const COPY_DIR_SKIP_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    ".turbo",
    ".next",
    ".cache",
    "dist",
    "build",
    "out",
    "coverage",
    ".pi",
];

fn should_skip_copy_entry(name: &str) -> bool {
    COPY_DIR_SKIP_NAMES.contains(&name)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    let mut walker = walkdir::WalkDir::new(src).min_depth(1).into_iter();
    while let Some(next) = walker.next() {
        let entry = next?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.file_type().is_dir() && should_skip_copy_entry(&name) {
            walker.skip_current_dir();
            continue;
        }
        let rel = entry.path().strip_prefix(src)?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = entry
                    .metadata()
                    .ok()
                    .and_then(|m| Some(m.permissions().mode()))
                    .unwrap_or(0o644);
                let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_pkg(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("package.json"), json).unwrap();
    }

    #[test]
    fn parse_session_bridge_shape() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_pi_pkg_session_bridge_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        write_pkg(
            &dir,
            r#"{
                "name": "pi-session-bridge",
                "version": "0.1.0",
                "description": "Pi package and CLI",
                "keywords": ["pi-package", "pi"],
                "bin": { "pi-bridge": "./bin/pi-bridge.js" },
                "pi": { "extensions": ["./extensions/session-bridge.ts"] }
            }"#,
        );
        let ext = PiExtension::from_dir(&dir).expect("parse ok");
        assert_eq!(ext.name, "pi-session-bridge");
        assert_eq!(ext.version.as_deref(), Some("0.1.0"));
        assert!(ext.keywords.contains(&"pi-package".into()));
        assert_eq!(
            ext.pi_extensions,
            vec!["./extensions/session-bridge.ts".to_string()]
        );
        assert_eq!(ext.bin.get("pi-bridge").unwrap(), "./bin/pi-bridge.js");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_single_string_bin() {
        let dir =
            std::env::temp_dir().join(format!("vstack_pi_pkg_single_bin_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_pkg(
            &dir,
            r#"{
                "name": "pi-foo",
                "bin": "./bin/foo.js"
            }"#,
        );
        let ext = PiExtension::from_dir(&dir).expect("parse ok");
        assert_eq!(ext.bin.get("pi-foo").unwrap(), "./bin/foo.js");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discover_picks_up_packages() {
        let root = std::env::temp_dir().join(format!("vstack_pi_discover_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        write_pkg(
            &root.join("alpha"),
            r#"{ "name": "alpha", "pi": { "extensions": ["./alpha.ts"] } }"#,
        );
        write_pkg(
            &root.join("beta"),
            r#"{ "name": "beta", "pi": { "extensions": ["./beta.ts"] } }"#,
        );
        // Subdir without package.json is skipped.
        std::fs::create_dir_all(root.join("not-a-pkg")).unwrap();

        let mut discovered = discover_pi_extensions(&root).unwrap();
        discovered.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(discovered.len(), 2);
        assert_eq!(discovered[0].name, "alpha");
        assert_eq!(discovered[1].name, "beta");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn relative_settings_entry_format() {
        assert_eq!(
            relative_settings_entry("pi-session-bridge"),
            "./packages/pi-session-bridge"
        );
        assert_eq!(relative_settings_entry("pi-qol"), "./packages/pi-qol");
    }

    #[test]
    fn prompt_stash_rename_has_legacy_name() {
        assert_eq!(legacy_names_for("pi-prompt-stash"), &["prompt-stash"]);
    }

    #[test]
    fn entry_matches_package_for_relative_and_absolute_legacy() {
        let dest = Path::new("/var/tmp/scope/packages/pi-session-bridge");

        // Relative canonical form
        let rel = serde_json::Value::String("./packages/pi-session-bridge".into());
        assert!(entry_matches_package(&rel, "pi-session-bridge", dest));

        // Legacy absolute form
        let abs = serde_json::Value::String("/var/tmp/scope/packages/pi-session-bridge".into());
        assert!(entry_matches_package(&abs, "pi-session-bridge", dest));

        // Object form wrapping the absolute path
        let obj = serde_json::json!({
            "source": "/var/tmp/scope/packages/pi-session-bridge",
            "extensions": []
        });
        assert!(entry_matches_package(&obj, "pi-session-bridge", dest));

        // Unrelated entries don't match
        let other = serde_json::Value::String("npm:@foo/bar".into());
        assert!(!entry_matches_package(&other, "pi-session-bridge", dest));

        let other_pkg = serde_json::Value::String("./packages/pi-qol".into());
        assert!(!entry_matches_package(
            &other_pkg,
            "pi-session-bridge",
            dest
        ));
    }

    /// Mutex guarding `PI_CODING_AGENT_DIR` for tests that mutate it.
    static PI_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_pi_dir<R>(pi_dir: &Path, body: impl FnOnce() -> R) -> R {
        let guard = PI_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os("PI_CODING_AGENT_DIR");
        unsafe {
            std::env::set_var("PI_CODING_AGENT_DIR", pi_dir);
        }
        let result = body();
        unsafe {
            if let Some(prev) = prev {
                std::env::set_var("PI_CODING_AGENT_DIR", prev);
            } else {
                std::env::remove_var("PI_CODING_AGENT_DIR");
            }
        }
        drop(guard);
        result
    }

    fn write_mini_source(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir.join("extensions")).unwrap();
        std::fs::write(dir.join("extensions").join("mini.ts"), "// noop\n").unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(
                r#"{{ "name": "{name}", "pi": {{ "extensions": ["./extensions/mini.ts"] }} }}"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn install_and_remove_pi_extension_round_trip() {
        let sandbox =
            std::env::temp_dir().join(format!("vstack_pi_install_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let source = sandbox.join("src").join("pi-mini");
        write_mini_source(&source, "pi-mini");
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            let ext = PiExtension::from_dir(&source).unwrap();
            let dest = install_pi_extension(&ext, true).unwrap().unwrap();
            assert!(dest.join("package.json").exists());
            assert!(dest.join("extensions").join("mini.ts").exists());

            let settings_path = pi_dir.join("settings.json");
            let settings: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            let pkgs = settings
                .get("packages")
                .and_then(|p| p.as_array())
                .expect("packages array");
            // We write the canonical relative form, not the absolute path
            let want = relative_settings_entry("pi-mini");
            assert!(
                pkgs.iter()
                    .any(|e| matches!(e, serde_json::Value::String(s) if s == &want)),
                "expected {want} in {pkgs:?}"
            );
            // And NEVER leak the absolute path
            let absolute = dest.to_string_lossy().into_owned();
            assert!(
                !pkgs
                    .iter()
                    .any(|e| matches!(e, serde_json::Value::String(s) if s == &absolute)),
                "absolute path leaked into settings: {pkgs:?}"
            );

            // Remove
            let _ = remove_pi_extension(&ext.name, true).unwrap();
            assert!(!dest.exists());

            let after: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            assert!(
                after.get("packages").is_none(),
                "expected packages key gone after sole package removed, got {after}"
            );
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn install_creates_and_remove_clears_bin_symlinks() {
        let sandbox =
            std::env::temp_dir().join(format!("vstack_pi_bin_links_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        let source = sandbox.join("src").join("pi-bridgey");
        std::fs::create_dir_all(source.join("bin")).unwrap();
        std::fs::create_dir_all(source.join("extensions")).unwrap();
        std::fs::write(source.join("extensions").join("ext.ts"), "// noop\n").unwrap();
        std::fs::write(
            source.join("bin").join("pi-bridge.js"),
            "#!/usr/bin/env node\n",
        )
        .unwrap();
        std::fs::write(
            source.join("package.json"),
            r#"{
                "name": "pi-bridgey",
                "pi": { "extensions": ["./extensions/ext.ts"] },
                "bin": { "pi-bridge": "./bin/pi-bridge.js" }
            }"#,
        )
        .unwrap();
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            let ext = PiExtension::from_dir(&source).unwrap();
            let dest = install_pi_extension(&ext, true).unwrap().unwrap();

            let link = pi_dir.join("bin").join("pi-bridge");
            assert!(
                link.is_symlink(),
                "expected bin symlink at {}",
                link.display()
            );
            let target = std::fs::read_link(&link).unwrap();
            assert_eq!(target, dest.join("./bin/pi-bridge.js"));

            // Remove clears the symlink
            let removed = remove_pi_extension(&ext.name, true).unwrap();
            assert!(
                removed.iter().any(|p| p == &link),
                "expected remove output to include bin link {}",
                link.display()
            );
            assert!(!link.exists(), "bin link should be gone");
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn install_pi_subagents_tmux_migrates_legacy_pi_subagents() {
        let sandbox = std::env::temp_dir().join(format!(
            "vstack_pi_subagents_migrate_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let legacy_src = sandbox.join("src").join("pi-subagents");
        let current_src = sandbox.join("src").join("pi-subagents-tmux");
        write_mini_source(&legacy_src, "pi-subagents");
        write_mini_source(&current_src, "pi-subagents-tmux");
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            let legacy = PiExtension::from_dir(&legacy_src).unwrap();
            let legacy_dest = install_pi_extension(&legacy, true).unwrap().unwrap();
            assert!(legacy_dest.exists());

            let current = PiExtension::from_dir(&current_src).unwrap();
            let current_dest = install_pi_extension(&current, true).unwrap().unwrap();
            assert!(current_dest.exists());
            assert!(
                !legacy_dest.exists(),
                "legacy package dir should be removed during rename migration"
            );

            let settings_path = pi_dir.join("settings.json");
            let settings: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            let pkgs: Vec<&str> = settings
                .get("packages")
                .and_then(|p| p.as_array())
                .unwrap()
                .iter()
                .filter_map(|e| e.as_str())
                .collect();
            assert!(pkgs.contains(&"./packages/pi-subagents-tmux"));
            assert!(
                !pkgs.contains(&"./packages/pi-subagents"),
                "legacy settings entry should be removed, got {pkgs:?}"
            );
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn remove_pi_extension_cleans_stale_settings_entry() {
        let sandbox = std::env::temp_dir().join(format!(
            "vstack_pi_remove_stale_settings_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            let settings_path = pi_dir.join("settings.json");
            std::fs::create_dir_all(&pi_dir).unwrap();
            std::fs::write(
                &settings_path,
                serde_json::to_string_pretty(&serde_json::json!({
                    "packages": ["./packages/pi-stale"],
                }))
                .unwrap(),
            )
            .unwrap();

            assert!(is_pi_extension_installed("pi-stale", true));
            let removed = remove_pi_extension("pi-stale", true).unwrap();
            assert!(
                removed.iter().any(|p| p == &settings_path),
                "settings.json should be reported as changed"
            );

            let after: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            assert!(after.get("packages").is_none());
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn install_two_pi_extensions_coexist_and_preserve_other_settings() {
        let sandbox =
            std::env::temp_dir().join(format!("vstack_pi_two_install_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let bridge_src = sandbox.join("src").join("pi-session-bridge");
        let qol_src = sandbox.join("src").join("pi-qol");
        write_mini_source(&bridge_src, "pi-session-bridge");
        write_mini_source(&qol_src, "pi-qol");

        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            // Pre-seed settings with unrelated content + a third-party package
            let settings_path = pi_dir.join("settings.json");
            std::fs::create_dir_all(&pi_dir).unwrap();
            std::fs::write(
                &settings_path,
                serde_json::to_string_pretty(&serde_json::json!({
                    "theme": "dark",
                    "packages": ["npm:@foo/bar"],
                }))
                .unwrap(),
            )
            .unwrap();

            // Install both vstack-managed packages
            let bridge = PiExtension::from_dir(&bridge_src).unwrap();
            let qol = PiExtension::from_dir(&qol_src).unwrap();
            install_pi_extension(&bridge, true).unwrap().unwrap();
            install_pi_extension(&qol, true).unwrap().unwrap();

            // Re-install one to verify dedupe (no duplicate entries)
            install_pi_extension(&qol, true).unwrap().unwrap();

            let settings: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            let pkgs: Vec<&str> = settings
                .get("packages")
                .and_then(|p| p.as_array())
                .unwrap()
                .iter()
                .filter_map(|e| e.as_str())
                .collect();
            assert!(pkgs.contains(&"npm:@foo/bar"), "third-party preserved");
            assert!(pkgs.contains(&"./packages/pi-session-bridge"));
            assert!(pkgs.contains(&"./packages/pi-qol"));
            // Dedupe: pi-qol appears exactly once
            assert_eq!(
                pkgs.iter().filter(|s| **s == "./packages/pi-qol").count(),
                1,
                "expected pi-qol once, got {pkgs:?}"
            );
            assert_eq!(settings.get("theme").and_then(|t| t.as_str()), Some("dark"));
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn reinstall_preserves_extension_manager_user_config() {
        let sandbox = std::env::temp_dir().join(format!(
            "vstack_pi_preserve_ext_config_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let source = sandbox.join("src").join("pi-qol");
        write_mini_source(&source, "pi-qol");
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            let settings_path = pi_dir.join("settings.json");
            std::fs::create_dir_all(&pi_dir).unwrap();
            let user_config = serde_json::json!({
                "newlineOnShiftEnter": false,
                "newlineFallbackKey": "none",
                "permissionGate.enabled": false,
                "customUserSetting": "must-survive-refresh"
            });
            std::fs::write(
                &settings_path,
                serde_json::to_string_pretty(&serde_json::json!({
                    "theme": "dark",
                    "packages": ["npm:@foo/bar", "./packages/pi-qol", "./packages/pi-tool-renderer"],
                    "vstack": {
                        "extensionManager": {
                            "config": {
                                "pi-qol": user_config,
                                "pi-tool-renderer": { "enabled": false }
                            },
                            "disabledItems": ["tool:example"],
                            "disabledProviders": ["provider:example"]
                        }
                    }
                }))
                .unwrap(),
            )
            .unwrap();

            let ext = PiExtension::from_dir(&source).unwrap();
            install_pi_extension(&ext, true).unwrap().unwrap();
            // vstack refresh/update re-enters the same install path; verify a
            // second install only re-copies package files and de-dupes packages,
            // never rewriting extension-manager user config.
            install_pi_extension(&ext, true).unwrap().unwrap();

            let settings: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            let manager = settings
                .get("vstack")
                .and_then(|v| v.get("extensionManager"))
                .expect("extension manager config should survive reinstall");
            assert_eq!(
                manager.get("config").and_then(|c| c.get("pi-qol")),
                Some(&user_config),
                "pi-qol user settings must not be clobbered by reinstall/refresh"
            );
            assert_eq!(
                manager
                    .get("config")
                    .and_then(|c| c.get("pi-tool-renderer"))
                    .and_then(|c| c.get("enabled"))
                    .and_then(|v| v.as_bool()),
                Some(false),
                "other extension settings must also be preserved"
            );
            assert_eq!(
                manager
                    .get("disabledItems")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len()),
                Some(1)
            );
            assert_eq!(settings.get("theme").and_then(|t| t.as_str()), Some("dark"));

            let pkgs: Vec<&str> = settings
                .get("packages")
                .and_then(|p| p.as_array())
                .unwrap()
                .iter()
                .filter_map(|e| e.as_str())
                .collect();
            assert!(pkgs.contains(&"npm:@foo/bar"));
            assert_eq!(
                pkgs.iter().filter(|s| **s == "./packages/pi-qol").count(),
                1,
                "reinstall should not duplicate package entries: {pkgs:?}"
            );
            assert_eq!(
                pkgs,
                vec!["npm:@foo/bar", "./packages/pi-qol", "./packages/pi-tool-renderer"],
                "reinstall should preserve package load order: {pkgs:?}"
            );
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn install_dedupes_legacy_absolute_path_entry() {
        let sandbox =
            std::env::temp_dir().join(format!("vstack_pi_legacy_dedupe_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let source = sandbox.join("src").join("pi-mini");
        write_mini_source(&source, "pi-mini");
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            // Pre-seed settings with a legacy absolute-path entry
            let dest = pi_dir.join("packages").join("pi-mini");
            let settings_path = pi_dir.join("settings.json");
            std::fs::create_dir_all(&pi_dir).unwrap();
            std::fs::write(
                &settings_path,
                serde_json::to_string_pretty(&serde_json::json!({
                    "packages": [dest.to_string_lossy()],
                }))
                .unwrap(),
            )
            .unwrap();

            let ext = PiExtension::from_dir(&source).unwrap();
            install_pi_extension(&ext, true).unwrap().unwrap();

            let settings: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
            let pkgs: Vec<&str> = settings
                .get("packages")
                .and_then(|p| p.as_array())
                .unwrap()
                .iter()
                .filter_map(|e| e.as_str())
                .collect();
            // Legacy absolute path replaced by relative form, no duplicates
            assert_eq!(pkgs, vec!["./packages/pi-mini"]);
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn parse_pi_qol_package() {
        let dir = std::env::temp_dir().join(format!("vstack_pi_qol_parse_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_pkg(
            &dir,
            r#"{
                "name": "pi-qol",
                "version": "0.1.0",
                "description": "Pi quality-of-life helpers.",
                "keywords": ["pi-package", "pi", "qol"],
                "pi": { "extensions": ["./extensions/qol.ts"] },
                "peerDependencies": {
                    "@mariozechner/pi-coding-agent": "*",
                    "@mariozechner/pi-tui": "*"
                }
            }"#,
        );
        let ext = PiExtension::from_dir(&dir).unwrap();
        assert_eq!(ext.name, "pi-qol");
        assert!(ext.bin.is_empty(), "qol has no CLI bin");
        assert_eq!(ext.pi_extensions, vec!["./extensions/qol.ts".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end smoke test that installs all vstack-managed Pi packages
    /// from the repo into a sandboxed `PI_CODING_AGENT_DIR`, then launches
    /// `pi` in non-interactive mode and confirms it prints no extension errors.
    ///
    /// Skipped by default (and silently skipped when `pi` is not on PATH so
    /// the suite still passes for users without Pi installed). Run with:
    ///
    /// ```bash
    /// cargo test --test-threads=1 pi_smoke_install_and_launch -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "exercises real `pi` binary; opt-in via --ignored"]
    fn pi_smoke_install_and_launch() {
        // Locate and install every repo-managed Pi package relative
        // to CARGO_MANIFEST_DIR, so this smoke stays current as the catalog grows.
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let pi_ext_root = manifest_dir
            .parent()
            .expect("repo root above cli/")
            .join("pi-extensions");
        let extensions = discover_pi_extensions(&pi_ext_root).unwrap();
        if extensions.is_empty() {
            eprintln!("skipping pi_smoke: no pi-packages found");
            return;
        }

        // If `pi` isn't installed, skip silently — this test exists for
        // operators who actually have Pi available.
        let pi_on_path = std::env::var_os("PATH")
            .map(|paths| std::env::split_paths(&paths).any(|p| p.join("pi").is_file()))
            .unwrap_or(false);
        if !pi_on_path {
            eprintln!("skipping pi_smoke: `pi` not on PATH");
            return;
        }

        let sandbox = std::env::temp_dir().join(format!("vstack_pi_smoke_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            for ext in &extensions {
                install_pi_extension(ext, true).unwrap().unwrap();
            }

            let bridge_dir = sandbox.join("bridge");
            let output = std::process::Command::new("pi")
                .args([
                    "--mode",
                    "json",
                    "--no-session",
                    "--no-tools",
                    "--thinking",
                    "off",
                    "-p",
                    "ping",
                ])
                .env("PI_CODING_AGENT_DIR", &pi_dir)
                .env("PI_BRIDGE_DIR", &bridge_dir)
                .env("PI_TELEMETRY", "0")
                .output()
                .expect("spawn pi");

            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let combined = format!("{stderr}\n{stdout}");

            // Pi must not emit extension load errors for our packages
            assert!(
                !combined.contains("extension_error"),
                "pi reported extension_error: {combined}"
            );
            for forbidden in ["Failed to load extension"] {
                assert!(
                    !combined.contains(forbidden),
                    "pi reported `{forbidden}`: {combined}"
                );
            }
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }
}
