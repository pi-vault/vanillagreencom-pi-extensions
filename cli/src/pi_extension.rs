use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A Pi extension package discovered under `pi-extensions/<name>/`.
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
    /// Parse a `pi-extensions/<name>/package.json` and the directory containing it.
    pub fn from_dir(dir: &Path) -> Result<Self> {
        let pkg_path = dir.join("package.json");
        let raw = std::fs::read_to_string(&pkg_path)
            .with_context(|| format!("reading {}", pkg_path.display()))?;
        let parsed: RawPackage = serde_json::from_str(&raw)
            .with_context(|| format!("parsing {}", pkg_path.display()))?;

        let pi_extensions = parsed
            .pi
            .map(|m| m.extensions)
            .unwrap_or_default();

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

/// Discover Pi extension packages in `<source>/pi-extensions/<name>/package.json`.
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

/// Install a Pi extension package into the chosen scope.
///
/// Steps:
/// 1. Copy the package directory into `<scope>/packages/<name>/`.
/// 2. Add a relative path entry (`./packages/<name>`) to Pi's `settings.json`
///    `packages` array, preserving any existing entries.
///
/// Pi resolves relative path entries against the settings file directory:
/// - `~/.pi/agent/settings.json` → `~/.pi/agent`
/// - `<project>/.pi/settings.json` → `<project>/.pi`
///
/// Both layouts use the same `./packages/<name>` shape.
pub fn install_pi_extension(ext: &PiExtension, global: bool) -> Result<PathBuf> {
    let dest_dir = crate::config::pi_packages_dir(global);
    std::fs::create_dir_all(&dest_dir)?;
    let dest = dest_dir.join(&ext.name);

    if dest.exists() {
        if dest.is_symlink() {
            let _ = std::fs::remove_file(&dest);
        } else {
            let _ = std::fs::remove_dir_all(&dest);
        }
    }

    copy_dir(&ext.source_dir, &dest)?;
    register_in_pi_settings(&ext.name, &dest, global)?;

    Ok(dest)
}

/// Remove a Pi extension package and its settings entry.
pub fn remove_pi_extension(name: &str, global: bool) -> Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    let dest = crate::config::pi_packages_dir(global).join(name);
    if dest.is_symlink() || dest.is_file() {
        if std::fs::remove_file(&dest).is_ok() {
            removed.push(dest.clone());
        }
    } else if dest.is_dir() && std::fs::remove_dir_all(&dest).is_ok() {
        removed.push(dest.clone());
    }
    let _ = unregister_from_pi_settings(name, &dest, global);
    Ok(removed)
}

/// The canonical `packages` entry vstack writes for a given package name.
fn relative_settings_entry(name: &str) -> String {
    format!("./packages/{}", name)
}

/// True if a `packages` entry refers to our package — matches:
/// - the canonical relative form (`./packages/<name>`)
/// - the legacy absolute path we used to write
/// - either form wrapped in a `{ "source": ... }` object
fn entry_matches_package(
    entry: &serde_json::Value,
    name: &str,
    absolute_dest: &Path,
) -> bool {
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

    // Drop legacy absolute-path entries for this package; the relative form
    // below is the canonical one.
    let absolute = dest.to_string_lossy().into_owned();
    packages.retain(|e| match e {
        serde_json::Value::String(s) => s != &absolute && s != &entry,
        serde_json::Value::Object(obj) => !obj
            .get("source")
            .and_then(|v| v.as_str())
            .is_some_and(|s| s == absolute || s == entry),
        _ => true,
    });

    packages.push(serde_json::Value::String(entry));

    write_settings(&settings_path, &settings)
}

/// Remove the settings entry for `name` (matches relative or absolute form).
fn unregister_from_pi_settings(name: &str, dest: &Path, global: bool) -> Result<()> {
    let settings_path = crate::config::pi_settings_path(global);
    if !settings_path.exists() {
        return Ok(());
    }
    let mut settings = load_or_init_settings(&settings_path)?;
    let Some(map) = settings.as_object_mut() else {
        return Ok(());
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
    Ok(())
}

fn load_or_init_settings(path: &Path) -> Result<serde_json::Value> {
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
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

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in walkdir::WalkDir::new(src).min_depth(1) {
        let entry = entry?;
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
                let _ = std::fs::set_permissions(
                    &target,
                    std::fs::Permissions::from_mode(mode),
                );
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
                "description": "Pi extension and CLI",
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
        let dir = std::env::temp_dir().join(format!(
            "vstack_pi_pkg_single_bin_{}",
            std::process::id()
        ));
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
        let root = std::env::temp_dir().join(format!(
            "vstack_pi_discover_{}",
            std::process::id()
        ));
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
        assert_eq!(
            relative_settings_entry("pi-statusline"),
            "./packages/pi-statusline"
        );
    }

    #[test]
    fn entry_matches_package_for_relative_and_absolute_legacy() {
        let dest = Path::new("/var/tmp/scope/packages/pi-session-bridge");

        // Relative canonical form
        let rel = serde_json::Value::String("./packages/pi-session-bridge".into());
        assert!(entry_matches_package(&rel, "pi-session-bridge", dest));

        // Legacy absolute form
        let abs = serde_json::Value::String(
            "/var/tmp/scope/packages/pi-session-bridge".into(),
        );
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

        let other_pkg = serde_json::Value::String("./packages/pi-statusline".into());
        assert!(!entry_matches_package(&other_pkg, "pi-session-bridge", dest));
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
        let sandbox = std::env::temp_dir().join(format!(
            "vstack_pi_install_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let source = sandbox.join("src").join("pi-mini");
        write_mini_source(&source, "pi-mini");
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            let ext = PiExtension::from_dir(&source).unwrap();
            let dest = install_pi_extension(&ext, true).unwrap();
            assert!(dest.join("package.json").exists());
            assert!(dest.join("extensions").join("mini.ts").exists());

            let settings_path = pi_dir.join("settings.json");
            let settings: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap())
                    .unwrap();
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

            let after: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&settings_path).unwrap(),
            )
            .unwrap();
            assert!(
                after.get("packages").is_none(),
                "expected packages key gone after sole package removed, got {after}"
            );
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn install_two_pi_extensions_coexist_and_preserve_other_settings() {
        let sandbox = std::env::temp_dir().join(format!(
            "vstack_pi_two_install_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let bridge_src = sandbox.join("src").join("pi-session-bridge");
        let stat_src = sandbox.join("src").join("pi-statusline");
        write_mini_source(&bridge_src, "pi-session-bridge");
        write_mini_source(&stat_src, "pi-statusline");

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
            let stat = PiExtension::from_dir(&stat_src).unwrap();
            install_pi_extension(&bridge, true).unwrap();
            install_pi_extension(&stat, true).unwrap();

            // Re-install one to verify dedupe (no duplicate entries)
            install_pi_extension(&stat, true).unwrap();

            let settings: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&settings_path).unwrap(),
            )
            .unwrap();
            let pkgs: Vec<&str> = settings
                .get("packages")
                .and_then(|p| p.as_array())
                .unwrap()
                .iter()
                .filter_map(|e| e.as_str())
                .collect();
            assert!(pkgs.contains(&"npm:@foo/bar"), "third-party preserved");
            assert!(pkgs.contains(&"./packages/pi-session-bridge"));
            assert!(pkgs.contains(&"./packages/pi-statusline"));
            // Dedupe: pi-statusline appears exactly once
            assert_eq!(
                pkgs.iter()
                    .filter(|s| **s == "./packages/pi-statusline")
                    .count(),
                1,
                "expected pi-statusline once, got {pkgs:?}"
            );
            assert_eq!(settings.get("theme").and_then(|t| t.as_str()), Some("dark"));
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn install_dedupes_legacy_absolute_path_entry() {
        let sandbox = std::env::temp_dir().join(format!(
            "vstack_pi_legacy_dedupe_{}",
            std::process::id()
        ));
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
            install_pi_extension(&ext, true).unwrap();

            let settings: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(&settings_path).unwrap(),
            )
            .unwrap();
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
    fn parse_pi_statusline_package() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_pi_statusline_parse_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        write_pkg(
            &dir,
            r#"{
                "name": "pi-statusline",
                "version": "0.1.2",
                "description": "Claude-style compact status line.",
                "keywords": ["pi-package", "pi", "statusline"],
                "pi": { "extensions": ["./extensions/statusline.ts"] },
                "peerDependencies": {
                    "@mariozechner/pi-coding-agent": "*",
                    "@mariozechner/pi-tui": "*"
                }
            }"#,
        );
        let ext = PiExtension::from_dir(&dir).unwrap();
        assert_eq!(ext.name, "pi-statusline");
        assert!(ext.bin.is_empty(), "statusline has no CLI bin");
        assert_eq!(
            ext.pi_extensions,
            vec!["./extensions/statusline.ts".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// End-to-end smoke test that installs both vstack-managed Pi extensions
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
        // Locate the repo's pi-extensions directory relative to CARGO_MANIFEST_DIR
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let pi_ext_root = manifest_dir
            .parent()
            .expect("repo root above cli/")
            .join("pi-extensions");
        let bridge = pi_ext_root.join("session-bridge");
        let stat = pi_ext_root.join("pi-statusline");
        if !bridge.is_dir() || !stat.is_dir() {
            eprintln!(
                "skipping pi_smoke: pi-extensions/{{session-bridge,pi-statusline}} missing"
            );
            return;
        }

        // If `pi` isn't installed, skip silently — this test exists for
        // operators who actually have Pi available.
        let pi_on_path = std::env::var_os("PATH")
            .map(|paths| {
                std::env::split_paths(&paths).any(|p| p.join("pi").is_file())
            })
            .unwrap_or(false);
        if !pi_on_path {
            eprintln!("skipping pi_smoke: `pi` not on PATH");
            return;
        }

        let sandbox = std::env::temp_dir().join(format!(
            "vstack_pi_smoke_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let pi_dir = sandbox.join("agent");

        with_pi_dir(&pi_dir, || {
            let bridge_ext = PiExtension::from_dir(&bridge).unwrap();
            let stat_ext = PiExtension::from_dir(&stat).unwrap();
            install_pi_extension(&bridge_ext, true).unwrap();
            install_pi_extension(&stat_ext, true).unwrap();

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
            for forbidden in [
                "Failed to load extension",
                "pi-session-bridge",
                "pi-statusline",
            ]
            .iter()
            .filter(|s| **s == "Failed to load extension")
            {
                assert!(
                    !combined.contains(forbidden),
                    "pi reported `{forbidden}`: {combined}"
                );
            }
        });

        let _ = std::fs::remove_dir_all(&sandbox);
    }
}
