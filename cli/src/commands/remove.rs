use crate::config::{self, LockFile};
use crate::harness::Harness;
use crate::installer;
use anyhow::Result;

pub fn run(names: &[String], global: bool) -> Result<()> {
    if names.is_empty() {
        eprintln!("Usage: vstack remove <name> [<name>...]");
        return Ok(());
    }

    let lock_path = config::lock_file_path(global);
    let mut lock = LockFile::load(&lock_path).unwrap_or_default();

    for name in names {
        // Look up entry first to determine kind and harnesses
        let lock_entry = lock.entries.get(name.as_str()).cloned();
        let harnesses: Vec<Harness> = if let Some(ref entry) = lock_entry {
            entry
                .harnesses
                .iter()
                .filter_map(|h| Harness::from_id(h))
                .collect()
        } else {
            Harness::ALL.to_vec()
        };

        // Pi extensions live in a separate location and are removed via
        // the dedicated helper.
        let mut removed = Vec::new();
        if matches!(
            lock_entry.as_ref().map(|e| e.kind),
            Some(crate::config::ItemKind::PiExtension)
        ) {
            removed.extend(crate::pi_extension::remove_pi_extension(name, global)?);
        } else {
            removed.extend(installer::remove_item(name, &harnesses, global)?);
        }

        if removed.is_empty() {
            eprintln!("  {name}: not found");
        } else {
            for path in &removed {
                eprintln!("  removed {}", path.display());
            }
            lock.remove(name);
        }
    }

    lock.save(&lock_path)?;
    Ok(())
}
