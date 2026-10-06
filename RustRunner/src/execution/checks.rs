//! Output checks
//!
//! Runs a step's [`OutputCheck`]s after the step itself succeeded. Checks
//! never re-run the tool: they run once, after the step's retry loop has
//! ended, because a missing or empty output is usually a deterministic
//! property of the inputs and re-running the same command would just repeat
//! it (and burn time on a long-running tool).

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::workflow::{CheckKind, OutputCheck, Step};

/// One check that did not pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckFailure {
    /// Which kind of check failed.
    pub kind: CheckKind,
    /// The check, as returned by [`OutputCheck::describe`].
    pub check: String,
    /// What was wrong.
    pub message: String,
    /// Whether the failure fails the step.
    pub blocking: bool,
}

impl CheckFailure {
    /// One-line text for logs and summaries.
    pub fn render(&self) -> String {
        format!("{}: {}", self.check, self.message)
    }
}

/// Whether a check says nothing about a mocked step. A mock creates empty
/// placeholders, so `non_empty` and `min_lines` would always fail; they are
/// reported as skipped instead. `exists` still runs.
pub fn skipped_for_mock(kind: CheckKind) -> bool {
    matches!(kind, CheckKind::NonEmpty | CheckKind::MinLines)
}

/// Runs all of `step`'s checks and returns the failures (empty when every
/// check passed). Relative output paths resolve against `working_dir`.
///
/// On a mocked step the content checks are not evaluated (see
/// [`skipped_for_mock`]).
pub fn run_checks(step: &Step, working_dir: &Option<PathBuf>) -> Vec<CheckFailure> {
    let mut failures = Vec::new();

    for check in &step.checks {
        if step.mock && skipped_for_mock(check.kind) {
            continue;
        }
        // A target is a path or the name of a named output; no target means
        // every output, named ones included.
        let targets = check.target_files(step);
        if targets.is_empty() {
            // Normally caught by the validator; report rather than pass silently.
            failures.push(CheckFailure {
                kind: check.kind,
                check: check.describe(),
                message: "no matching output to check".to_string(),
                blocking: check.blocking,
            });
            continue;
        }
        for target in &targets {
            let path = match working_dir {
                Some(dir) => dir.join(target),
                None => PathBuf::from(target),
            };
            if let Err(message) = evaluate(check, &path) {
                failures.push(CheckFailure {
                    kind: check.kind,
                    check: check.describe(),
                    message: format!("{}: {}", target, message),
                    blocking: check.blocking,
                });
            }
        }
    }

    failures
}

/// Evaluates one check against one path.
fn evaluate(check: &OutputCheck, path: &Path) -> Result<(), String> {
    let meta = fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "does not exist".to_string(),
        _ => format!("cannot be read ({})", e),
    })?;

    match check.kind {
        CheckKind::Exists => Ok(()),
        CheckKind::NonEmpty => {
            let empty = if meta.is_dir() {
                fs::read_dir(path)
                    .map_err(|e| format!("cannot be read ({})", e))?
                    .next()
                    .is_none()
            } else {
                meta.len() == 0
            };
            if empty {
                Err("is empty".to_string())
            } else {
                Ok(())
            }
        }
        CheckKind::MinLines => {
            let required = check.lines.unwrap_or(1);
            if meta.is_dir() {
                return Err("is a directory, so lines cannot be counted".to_string());
            }
            let found = count_lines(path).map_err(|e| format!("cannot be read ({})", e))?;
            if found < required {
                Err(format!(
                    "has {} lines, expected at least {}",
                    found, required
                ))
            } else {
                Ok(())
            }
        }
    }
}

/// Counts lines in a file; a final line without a trailing newline counts.
fn count_lines(path: &Path) -> std::io::Result<u64> {
    let mut file = File::open(path)?;
    let mut buf = [0u8; 64 * 1024];
    let mut lines = 0u64;
    let mut last = b'\n';
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        lines += buf[..n].iter().filter(|&&b| b == b'\n').count() as u64;
        last = buf[n - 1];
    }
    if last != b'\n' {
        lines += 1;
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn run(step: &Step, dir: &Path) -> Vec<CheckFailure> {
        run_checks(step, &Some(dir.to_path_buf()))
    }

    #[test]
    fn test_mocked_step_skips_only_content_checks() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("empty.txt"), "").unwrap();
        let mut step = Step::new("s", "bash", "true")
            .with_output("empty.txt")
            .with_check(OutputCheck::new(CheckKind::NonEmpty))
            .with_check(OutputCheck::min_lines(3));
        assert_eq!(run(&step, dir.path()).len(), 2);
        step.mock = true;
        assert!(run(&step, dir.path()).is_empty());

        // exists still runs on a mocked step
        let step = Step::new("s", "bash", "true")
            .with_output("missing.txt")
            .with_check(OutputCheck::new(CheckKind::Exists))
            .with_mock(true);
        assert_eq!(run(&step, dir.path()).len(), 1);
        assert!(skipped_for_mock(CheckKind::MinLines) && !skipped_for_mock(CheckKind::Exists));
    }

    #[test]
    fn test_exists() {
        let dir = tempdir().unwrap();
        let step = Step::new("s", "bash", "x")
            .with_output("out.txt")
            .with_check(OutputCheck::new(CheckKind::Exists));
        let failures = run(&step, dir.path());
        assert_eq!(failures.len(), 1);
        assert!(failures[0].message.contains("does not exist"));
        assert!(failures[0].blocking);

        fs::write(dir.path().join("out.txt"), "").unwrap();
        assert!(run(&step, dir.path()).is_empty());
    }

    #[test]
    fn test_non_empty_file_and_directory() {
        let dir = tempdir().unwrap();
        let step = Step::new("s", "bash", "x")
            .with_outputs(vec!["f.txt".into(), "d".into()])
            .with_check(OutputCheck::new(CheckKind::NonEmpty));
        fs::write(dir.path().join("f.txt"), "").unwrap();
        fs::create_dir(dir.path().join("d")).unwrap();
        assert_eq!(run(&step, dir.path()).len(), 2);

        fs::write(dir.path().join("f.txt"), "x").unwrap();
        let failures = run(&step, dir.path());
        assert_eq!(failures.len(), 1);
        assert!(failures[0].message.starts_with("d:"));

        fs::write(dir.path().join("d").join("a"), "").unwrap();
        assert!(run(&step, dir.path()).is_empty());
    }

    #[test]
    fn test_min_lines() {
        let dir = tempdir().unwrap();
        let step = Step::new("s", "bash", "x")
            .with_output("out.tsv")
            .with_check(OutputCheck::min_lines(3));
        fs::write(dir.path().join("out.tsv"), "a\nb\n").unwrap();
        let failures = run(&step, dir.path());
        assert_eq!(failures.len(), 1);
        assert!(failures[0]
            .message
            .contains("has 2 lines, expected at least 3"));

        // A last line without a trailing newline still counts.
        fs::write(dir.path().join("out.tsv"), "a\nb\nc").unwrap();
        assert!(run(&step, dir.path()).is_empty());
    }

    #[test]
    fn test_min_lines_on_directory_fails() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("d")).unwrap();
        let step = Step::new("s", "bash", "x")
            .with_output("d")
            .with_check(OutputCheck::min_lines(1));
        assert!(run(&step, dir.path())[0].message.contains("directory"));
    }

    #[test]
    fn test_target_limits_check_and_non_blocking_flag_is_carried() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        let step = Step::new("s", "bash", "x")
            .with_outputs(vec!["a.txt".into(), "b.txt".into()])
            .with_check(OutputCheck::new(CheckKind::Exists).with_target("a.txt"))
            .with_check(
                OutputCheck::new(CheckKind::Exists)
                    .with_target("b.txt")
                    .non_blocking(),
            );
        let failures = run(&step, dir.path());
        assert_eq!(failures.len(), 1);
        assert!(!failures[0].blocking);
        assert!(failures[0].render().contains("b.txt"));
    }

    #[test]
    fn test_comma_separated_outputs_are_split() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        let step = Step::new("s", "bash", "x")
            .with_output("a.txt, b.txt")
            .with_check(OutputCheck::new(CheckKind::Exists));
        let failures = run(&step, dir.path());
        assert_eq!(failures.len(), 1);
        assert!(failures[0].message.starts_with("b.txt"));
    }

    // ---- named slots ----

    #[test]
    fn test_checks_cover_named_outputs() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.bam"), "data").unwrap();
        fs::write(dir.path().join("empty.tsv"), "").unwrap();
        let step = Step::new("s", "bash", "true")
            .with_named_output("bam", &["a.bam"])
            .with_named_output("counts", &["empty.tsv"])
            .with_check(OutputCheck::new(CheckKind::NonEmpty));
        // No target: every output, named ones included.
        let failures = run(&step, dir.path());
        assert_eq!(failures.len(), 1);
        assert!(failures[0].message.contains("empty.tsv"), "{:?}", failures);
    }

    #[test]
    fn test_check_target_by_slot_name_and_by_path() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.bam"), "data").unwrap();
        fs::write(dir.path().join("empty.tsv"), "").unwrap();
        let base = Step::new("s", "bash", "true")
            .with_named_output("bam", &["a.bam"])
            .with_named_output("counts", &["empty.tsv"]);
        let by_slot = base
            .clone()
            .with_check(OutputCheck::new(CheckKind::NonEmpty).with_target("counts"));
        assert_eq!(run(&by_slot, dir.path()).len(), 1);
        let by_path = base
            .clone()
            .with_check(OutputCheck::new(CheckKind::NonEmpty).with_target("a.bam"));
        assert!(run(&by_path, dir.path()).is_empty());
        let missing_slot = base.with_check(OutputCheck::new(CheckKind::Exists).with_target("nope"));
        assert_eq!(run(&missing_slot, dir.path()).len(), 1);
    }
}
