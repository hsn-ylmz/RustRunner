//! Files that ship with the app, referenced from a command as
//! `{app_resource:<path>}`.
//!
//! Some catalog tools run a script that is part of RustRunner (the riboWaltz
//! report is an R script). The command cannot embed it (here-documents are
//! refused by the slot scanner on purpose) and cannot guess where the app is
//! installed, so it names the file relative to the app's resources folder:
//!
//! ```text
//! Rscript {app_resource:ribowaltz/ribowaltz_report.R} --gtf {annotation}
//! ```
//!
//! The engine replaces the placeholder with the absolute, shell-quoted path of
//! that file, in steps that have named slots (every catalog step does).
//!
//! # Where the resources folder is
//!
//! First match wins:
//!
//! 1. `RUSTRUNNER_RESOURCES`, when it names an existing folder (tests, and
//!    people who relocate the app);
//! 2. `app_resources/` next to the engine executable (the packaged app puts it
//!    beside `env_map.json`);
//! 3. `runtime/app_resources/` of the source tree the engine was built from,
//!    in debug (development) builds only. A release build never looks there:
//!    the path is the build machine's, and on another computer whoever can
//!    create that folder would decide which script runs.
//!
//! # What is accepted
//!
//! The path is relative, made of plain segments (letters, digits, `_`, `-`,
//! `.`), has no empty, `.` or `..` segment, no hidden (dot) segment and is at
//! most 120 characters long. After joining it to the folder, the result must
//! be an existing regular file whose real path (symbolic links followed) is
//! still inside the real path of the folder. A workflow file from somebody
//! else can therefore never use this placeholder to point at another file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::slots::placeholder_names;
use crate::environment::install::sha256_file;

/// The text before the path inside the braces.
pub const PREFIX: &str = "app_resource:";

/// Longest resource path accepted.
pub const MAX_PATH_LEN: usize = 120;

/// The resource path of a placeholder name (`app_resource:a/b.R` gives
/// `a/b.R`), or `None` when `name` is not a resource placeholder.
pub fn resource_of(name: &str) -> Option<&str> {
    name.strip_prefix(PREFIX)
}

/// Why `rel` cannot name a bundled file, or `None` when its shape is fine.
pub fn path_problem(rel: &str) -> Option<String> {
    if rel.is_empty() {
        return Some("no file is named after \"app_resource:\"".to_string());
    }
    if rel.chars().count() > MAX_PATH_LEN {
        return Some(format!(
            "the path is longer than {} characters",
            MAX_PATH_LEN
        ));
    }
    if rel.starts_with('/') {
        return Some("the path must be relative to the app's resources folder".to_string());
    }
    for segment in rel.split('/') {
        if segment.is_empty() {
            return Some(
                "the path has an empty part (a leading, trailing or double /)".to_string(),
            );
        }
        if segment == "." || segment == ".." {
            return Some("the path may not use . or .. parts".to_string());
        }
        if segment.starts_with('.') {
            return Some("the path may not name hidden files".to_string());
        }
        if !segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        {
            return Some(
                "the path may only use letters, digits, '_', '-', '.' and '/'".to_string(),
            );
        }
    }
    None
}

/// The app's resources folder, or `None` when none of the places holds one.
pub fn resources_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("RUSTRUNNER_RESOURCES") {
        let dir = PathBuf::from(dir);
        if dir.is_dir() {
            return Some(dir);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(beside) = exe.parent().map(|d| d.join("app_resources")) {
            if beside.is_dir() {
                return Some(beside);
            }
        }
    }
    source_tree_resources()
}

/// The development fallback: `runtime/app_resources/` of the source tree, for
/// debug builds only (see the module docs).
fn source_tree_resources() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("runtime")
        .join("app_resources");
    dev.is_dir().then_some(dev)
}

/// The absolute path of the bundled file `rel` inside `root`, checked as
/// described in the module docs.
pub fn resolve_in(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if let Some(problem) = path_problem(rel) {
        return Err(format!("{{app_resource:{}}}: {}", rel, problem));
    }
    let real_root = root.canonicalize().map_err(|e| {
        format!(
            "{{app_resource:{}}}: the app's resources folder {} cannot be read: {}",
            rel,
            root.display(),
            e
        )
    })?;
    let real = real_root.join(rel).canonicalize().map_err(|_| {
        format!(
            "{{app_resource:{}}}: this file is not part of the installed app (looked in {}). \
             Reinstall RustRunner, or set RUSTRUNNER_RESOURCES to the folder that holds it",
            rel,
            real_root.display()
        )
    })?;
    if !real.starts_with(&real_root) {
        return Err(format!(
            "{{app_resource:{}}}: the path leaves the app's resources folder",
            rel
        ));
    }
    if !real.is_file() {
        return Err(format!("{{app_resource:{}}}: this is not a file", rel));
    }
    Ok(real)
}

/// [`resolve_in`] for the folder [`resources_dir`] finds.
pub fn resolve(rel: &str) -> Result<PathBuf, String> {
    if let Some(problem) = path_problem(rel) {
        return Err(format!("{{app_resource:{}}}: {}", rel, problem));
    }
    match resources_dir() {
        Some(root) => resolve_in(&root, rel),
        None => Err(format!(
            "{{app_resource:{}}}: the app's resources folder was not found. \
             Reinstall RustRunner, or set RUSTRUNNER_RESOURCES to the folder that holds it",
            rel
        )),
    }
}

/// The bundled files a command names, in order, without repeats.
pub fn resources_in(command: &str) -> Vec<String> {
    placeholder_names(command)
        .iter()
        .filter_map(|name| resource_of(name).map(str::to_string))
        .collect()
}

/// Resource path to a digest of that file's content, for the step's
/// definition hash: an app update that changes a script then runs the step
/// again. Empty (and so absent from the hash) for a command without resources;
/// a file that cannot be read gets the digest `missing`.
pub fn digests(command: &str) -> BTreeMap<String, String> {
    digests_with(command, &resolve)
}

/// [`digests`] with the lookup of the bundled files given.
pub fn digests_with(
    command: &str,
    find: &dyn Fn(&str) -> Result<PathBuf, String>,
) -> BTreeMap<String, String> {
    resources_in(command)
        .into_iter()
        .map(|rel| {
            let digest = find(&rel)
                .ok()
                .and_then(|path| sha256_file(&path).ok())
                .unwrap_or_else(|| "missing".to_string());
            (rel, digest)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A resources folder, `<temp>/res`, inside a folder of the test's own
    /// (`<temp>/outside.txt` is a file next to it that must stay out of reach).
    struct Bundle {
        _temp: TempDir,
        root: std::path::PathBuf,
    }

    impl Bundle {
        fn path(&self) -> &Path {
            &self.root
        }
    }

    fn bundle() -> Bundle {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("res");
        std::fs::create_dir_all(root.join("ribowaltz")).unwrap();
        std::fs::write(root.join("ribowaltz/report.R"), "cat('hi')\n").unwrap();
        std::fs::write(root.join("top.txt"), "x").unwrap();
        std::fs::write(temp.path().join("outside.txt"), "secret").unwrap();
        Bundle { _temp: temp, root }
    }

    #[test]
    fn test_resource_of_needs_the_prefix() {
        assert_eq!(resource_of("app_resource:a/b.R"), Some("a/b.R"));
        assert_eq!(resource_of("app_resource:"), Some(""));
        assert_eq!(resource_of("reads"), None);
        assert_eq!(resource_of("App_resource:a"), None);
    }

    #[test]
    fn test_plain_relative_paths_are_accepted() {
        for ok in ["a.R", "ribowaltz/report.R", "a-b_c/d.e.f", "v1.2/x"] {
            assert_eq!(path_problem(ok), None, "{}", ok);
        }
    }

    #[test]
    fn test_bad_paths_are_refused_with_a_reason() {
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../x",
            "a/./x",
            "a//b",
            "a/",
            ".hidden",
            "a/.hidden",
            "a b",
            "a;b",
            "a$b",
            "a\\b",
            "a'b",
            "ünï.R",
            &"x".repeat(MAX_PATH_LEN + 1),
        ] {
            assert!(path_problem(bad).is_some(), "{:?} should be refused", bad);
        }
        assert!(path_problem(&"x".repeat(MAX_PATH_LEN)).is_none());
    }

    #[test]
    fn test_resolve_gives_the_absolute_path_of_an_existing_file() {
        let dir = bundle();
        let path = resolve_in(dir.path(), "ribowaltz/report.R").unwrap();
        assert!(path.is_absolute());
        assert!(path.ends_with("ribowaltz/report.R"));
        assert!(path.starts_with(dir.path().canonicalize().unwrap()));
    }

    #[test]
    fn test_resolve_refuses_traversal_before_touching_the_disk() {
        let dir = bundle();
        for bad in [
            "../outside.txt",
            "ribowaltz/../../outside.txt",
            "/etc/hosts",
        ] {
            let error = resolve_in(dir.path(), bad).unwrap_err();
            assert!(error.contains("app_resource"), "{}", error);
        }
    }

    #[test]
    fn test_resolve_reports_a_missing_file_and_a_folder() {
        let dir = bundle();
        let missing = resolve_in(dir.path(), "ribowaltz/nope.R").unwrap_err();
        assert!(
            missing.contains("not part of the installed app"),
            "{}",
            missing
        );
        let folder = resolve_in(dir.path(), "ribowaltz").unwrap_err();
        assert!(folder.contains("not a file"), "{}", folder);
    }

    #[cfg(unix)]
    #[test]
    fn test_a_symlink_out_of_the_folder_is_refused() {
        let dir = bundle();
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("evil.R"), "system('x')").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("evil.R"),
            dir.path().join("ribowaltz/link.R"),
        )
        .unwrap();
        let error = resolve_in(dir.path(), "ribowaltz/link.R").unwrap_err();
        assert!(
            error.contains("leaves the app's resources folder"),
            "{}",
            error
        );
        // A link that stays inside is fine.
        std::os::unix::fs::symlink(
            dir.path().join("top.txt"),
            dir.path().join("ribowaltz/inside.txt"),
        )
        .unwrap();
        assert!(resolve_in(dir.path(), "ribowaltz/inside.txt").is_ok());
    }

    #[test]
    fn test_resources_in_lists_each_file_once() {
        assert_eq!(
            resources_in(
                "Rscript {app_resource:a/b.R} {x} {app_resource:a/b.R} {app_resource:c.R}"
            ),
            vec!["a/b.R", "c.R"]
        );
        assert!(resources_in("echo {x}").is_empty());
    }

    #[test]
    fn test_digests_follow_the_content_and_flag_a_missing_file() {
        let dir = bundle();
        let find = |rel: &str| resolve_in(dir.path(), rel);
        let command = "Rscript {app_resource:ribowaltz/report.R} {app_resource:ribowaltz/gone.R}";
        let before = digests_with(command, &find);
        assert_eq!(before.len(), 2);
        assert_eq!(before["ribowaltz/gone.R"], "missing");
        assert_ne!(before["ribowaltz/report.R"], "missing");
        assert_eq!(before, digests_with(command, &find));
        std::fs::write(dir.path().join("ribowaltz/report.R"), "cat('changed')\n").unwrap();
        let after = digests_with(command, &find);
        assert_ne!(before["ribowaltz/report.R"], after["ribowaltz/report.R"]);
        assert!(digests_with("echo {x}", &find).is_empty());
    }

    #[test]
    fn test_the_source_tree_fallback_exists_only_in_debug_builds() {
        assert_eq!(
            source_tree_resources().is_some(),
            cfg!(debug_assertions),
            "a release build must not look for scripts at the build machine's path"
        );
    }

    #[test]
    fn test_the_shipped_riboseq_script_is_found_in_the_source_tree() {
        // The development fallback (`runtime/app_resources`) is what debug
        // cargo tests use; the real-tool suite puts the folder beside the engine.
        let path = resolve_in(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/app_resources"),
            "ribowaltz/ribowaltz_report.R",
        )
        .unwrap();
        assert!(path.is_file());
        if cfg!(debug_assertions) && std::env::var_os("RUSTRUNNER_RESOURCES").is_none() {
            assert_eq!(resolve("ribowaltz/ribowaltz_report.R").unwrap(), path);
        }
    }
}
