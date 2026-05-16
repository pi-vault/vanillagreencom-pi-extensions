use std::cmp::Ordering;
use std::path::Path;

#[must_use]
pub fn cmp_archive_paths_desc(left: &Path, right: &Path) -> Ordering {
    archive_file_name(right).cmp(archive_file_name(left))
}

fn archive_file_name(path: &Path) -> &str {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
}
