//! Finding the micromamba binary
//!
//! The engine needs micromamba for every conda environment. Where it looks is
//! decided here, as a pure function of a few inputs, so that the run can check
//! for it before the first step, name every place it looked, and be tested
//! without touching the real machine.
//!
//! # Search order
//!
//! 1. `RUSTRUNNER_MICROMAMBA`, when set: exactly that file and nothing else
//!    (an explicit choice is never second-guessed; if it is wrong, say so).
//! 2. Next to the rustrunner executable (a packaged app's bundled copy).
//! 3. `{project_root}/runtime/micromamba` (running from source).
//! 4. `~/.rustrunner/bin/micromamba` (installed by the app's "Install the tool
//!    installer" action when the bundled copy is missing).
//! 5. Every folder on the `PATH`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::install::is_executable_file;

/// Environment variable that names the micromamba binary to use, and only it.
pub const MICROMAMBA_ENV: &str = "RUSTRUNNER_MICROMAMBA";

/// The file name of the binary on this platform.
pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "micromamba.exe"
    } else {
        "micromamba"
    }
}

/// Where the search looks. Built from the real machine by
/// [`MicromambaSources::from_environment`], or by hand in tests.
#[derive(Debug, Clone, Default)]
pub struct MicromambaSources {
    /// `RUSTRUNNER_MICROMAMBA`: when present it is the only place searched.
    pub explicit: Option<PathBuf>,
    /// The folder of the running executable.
    pub exe_dir: Option<PathBuf>,
    /// `{project_root}/runtime`.
    pub runtime_dir: Option<PathBuf>,
    /// `~/.rustrunner/bin`.
    pub user_bin_dir: Option<PathBuf>,
    /// The value of `PATH`.
    pub path_var: Option<OsString>,
}

impl MicromambaSources {
    /// The sources of this process.
    pub fn from_environment() -> Self {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .filter(|h| !h.is_empty())
            .map(PathBuf::from);
        Self {
            explicit: std::env::var_os(MICROMAMBA_ENV)
                .filter(|p| !p.is_empty())
                .map(PathBuf::from),
            exe_dir: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
            runtime_dir: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime")),
            user_bin_dir: home.map(|h| h.join(".rustrunner").join("bin")),
            path_var: std::env::var_os("PATH"),
        }
    }

    /// Every file the search looks at, in order, without repeats.
    pub fn candidates(&self) -> Vec<PathBuf> {
        if let Some(explicit) = &self.explicit {
            return vec![explicit.clone()];
        }
        let name = binary_name();
        let mut found: Vec<PathBuf> = Vec::new();
        let dirs = [&self.exe_dir, &self.runtime_dir, &self.user_bin_dir]
            .into_iter()
            .flatten()
            .cloned()
            .chain(
                self.path_var
                    .iter()
                    .flat_map(std::env::split_paths)
                    .filter(|dir| !dir.as_os_str().is_empty()),
            );
        for dir in dirs {
            let candidate = dir.join(name);
            if !found.contains(&candidate) {
                found.push(candidate);
            }
        }
        found
    }
}

/// What a search found, and everywhere it looked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicromambaLookup {
    /// The first usable binary, if any.
    pub found: Option<PathBuf>,
    /// Every path looked at, in order, as text.
    pub searched: Vec<String>,
}

/// Searches `sources` for micromamba.
pub fn locate(sources: &MicromambaSources) -> MicromambaLookup {
    let candidates = sources.candidates();
    let found = candidates.iter().find(|c| is_executable_file(c)).cloned();
    MicromambaLookup {
        found,
        searched: candidates.iter().map(|c| c.display().to_string()).collect(),
    }
}

/// Searches this machine for micromamba.
pub fn locate_micromamba() -> MicromambaLookup {
    locate(&MicromambaSources::from_environment())
}

impl MicromambaLookup {
    /// The message of a run that needs micromamba and cannot find it: what is
    /// missing, every path searched, and how to fix it.
    pub fn missing_message(&self) -> String {
        let mut text = String::from(
            "The tool installer (micromamba) was not found, and this workflow needs it to set up its tools.\nSearched:\n",
        );
        for path in &self.searched {
            text.push_str("  ");
            text.push_str(path);
            text.push('\n');
        }
        text.push_str(&format!(
            "To fix it, either choose \"Install the tool installer\" in the RustRunner app, \
             or download micromamba from https://micro.mamba.pm/ and put it in one of the \
             folders above (or anywhere on your PATH), or set {} to its full path.",
            MICROMAMBA_ENV
        ));
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn make_binary(dir: &Path) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(binary_name());
        fs::write(&path, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn sources_in(root: &Path) -> MicromambaSources {
        MicromambaSources {
            explicit: None,
            exe_dir: Some(root.join("exe")),
            runtime_dir: Some(root.join("runtime")),
            user_bin_dir: Some(root.join("home/.rustrunner/bin")),
            path_var: Some(std::env::join_paths([root.join("p1"), root.join("p2")]).unwrap()),
        }
    }

    #[test]
    fn test_nothing_found_lists_every_place_in_order() {
        let root = tempdir().unwrap();
        let lookup = locate(&sources_in(root.path()));
        assert!(lookup.found.is_none());
        let name = binary_name();
        let expected: Vec<String> = ["exe", "runtime", "home/.rustrunner/bin", "p1", "p2"]
            .iter()
            .map(|d| root.path().join(d).join(name).display().to_string())
            .collect();
        assert_eq!(lookup.searched, expected);
    }

    #[test]
    fn test_the_bundled_copy_wins_over_the_path() {
        let root = tempdir().unwrap();
        let bundled = make_binary(&root.path().join("exe"));
        make_binary(&root.path().join("p1"));
        assert_eq!(locate(&sources_in(root.path())).found, Some(bundled));
    }

    #[test]
    fn test_runtime_then_user_dir_then_path() {
        let root = tempdir().unwrap();
        let on_path = make_binary(&root.path().join("p2"));
        assert_eq!(locate(&sources_in(root.path())).found, Some(on_path));
        let user = make_binary(&root.path().join("home/.rustrunner/bin"));
        assert_eq!(locate(&sources_in(root.path())).found, Some(user));
        let runtime = make_binary(&root.path().join("runtime"));
        assert_eq!(locate(&sources_in(root.path())).found, Some(runtime));
    }

    #[test]
    fn test_an_explicit_path_is_the_only_place_searched() {
        let root = tempdir().unwrap();
        make_binary(&root.path().join("exe"));
        let mut sources = sources_in(root.path());
        sources.explicit = Some(root.path().join("nowhere").join(binary_name()));
        let lookup = locate(&sources);
        assert!(lookup.found.is_none());
        assert_eq!(lookup.searched.len(), 1);

        let elsewhere = make_binary(&root.path().join("elsewhere"));
        sources.explicit = Some(elsewhere.clone());
        assert_eq!(locate(&sources).found, Some(elsewhere));
    }

    #[test]
    fn test_a_file_that_is_not_executable_does_not_count() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let root = tempdir().unwrap();
            let path = make_binary(&root.path().join("exe"));
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(locate(&sources_in(root.path())).found.is_none());
        }
    }

    #[test]
    fn test_repeated_folders_are_listed_once() {
        let root = tempdir().unwrap();
        let mut sources = sources_in(root.path());
        sources.path_var =
            Some(std::env::join_paths([root.path().join("exe"), root.path().join("exe")]).unwrap());
        assert_eq!(sources.candidates().len(), 3);
    }

    #[test]
    fn test_the_message_names_every_path_and_the_fix() {
        let lookup = MicromambaLookup {
            found: None,
            searched: vec!["/a/micromamba".into(), "/b/micromamba".into()],
        };
        let text = lookup.missing_message();
        assert!(text.contains("/a/micromamba") && text.contains("/b/micromamba"));
        assert!(text.contains("Install the tool installer"));
        assert!(text.contains("https://micro.mamba.pm/"));
        assert!(text.contains(MICROMAMBA_ENV));
    }
}
