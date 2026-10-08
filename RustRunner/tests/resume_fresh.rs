//! End-to-end checks for resuming a run, running from scratch (`--fresh`), and
//! the workflow metadata echoed in the log and saved in the run state.

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

const WORKFLOW: &str = r#"
metadata:
  name: Resume Demo
  version: "2.1"
steps:
  - id: first
    tool: bash
    command: "echo run >> first_runs.log; touch first.out"
    input: []
    output: [first.out]
    previous: []
    next: [second]
  - id: second
    tool: bash
    command: "test -f allow || exit 1; echo run >> second_runs.log; touch second.out"
    input: []
    output: [second.out]
    previous: [first]
    next: []
"#;

fn run(dir: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(dir.join("demo.yaml"))
        .arg("--working-dir")
        .arg(dir)
        .args(extra)
        .output()
        .unwrap()
}

fn log_lines(dir: &Path, name: &str) -> usize {
    fs::read_to_string(dir.join(name))
        .map(|s| s.lines().count())
        .unwrap_or(0)
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn resume_skips_finished_steps_and_fresh_runs_everything_again() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("demo.yaml"), WORKFLOW).unwrap();

    // Run 1: the second step fails, the first is recorded as completed.
    let out = run(dir.path(), &[]);
    assert!(!out.status.success());
    let log = text(&out);
    assert!(log.contains("Workflow: Resume Demo (version 2.1)"), "{log}");
    assert_eq!(log_lines(dir.path(), "first_runs.log"), 1);

    let state = fs::read_to_string(dir.path().join(".rustrunner/demo.state")).unwrap();
    assert!(
        state.contains("\"workflow_name\": \"Resume Demo\""),
        "{state}"
    );
    assert!(state.contains("\"workflow_version\": \"2.1\""), "{state}");

    // Run 2 (default = resume): only the failed step runs again.
    fs::write(dir.path().join("allow"), "").unwrap();
    let out = run(dir.path(), &[]);
    assert!(out.status.success(), "{}", text(&out));
    let log = text(&out);
    assert!(
        log.contains("Skipping previously completed step: first"),
        "{log}"
    );
    assert!(log.contains("Resuming previous run: 1 step(s)"), "{log}");
    assert!(log.contains("Workflow: Resume Demo (version 2.1)"), "{log}");
    assert_eq!(log_lines(dir.path(), "first_runs.log"), 1);
    assert_eq!(log_lines(dir.path(), "second_runs.log"), 1);

    // Run 3 (--fresh): everything runs again.
    let out = run(dir.path(), &["--fresh"]);
    assert!(out.status.success(), "{}", text(&out));
    let log = text(&out);
    assert!(log.contains("Running from scratch"), "{log}");
    assert!(!log.contains("Skipping previously completed"), "{log}");
    assert_eq!(log_lines(dir.path(), "first_runs.log"), 2);
    assert_eq!(log_lines(dir.path(), "second_runs.log"), 2);
}

#[test]
fn fresh_dry_run_keeps_the_saved_state() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("demo.yaml"), WORKFLOW).unwrap();
    fs::write(dir.path().join("allow"), "").unwrap();
    assert!(run(dir.path(), &[]).status.success());

    let state_file = dir.path().join(".rustrunner/demo.state");
    let before = fs::read_to_string(&state_file).unwrap();
    let out = run(dir.path(), &["--fresh", "--dry-run"]);
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(fs::read_to_string(&state_file).unwrap(), before);
}

#[test]
fn metadata_with_a_newline_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    // A double-quoted YAML scalar with an escaped newline.
    let yaml = WORKFLOW.replace("name: Resume Demo", "name: \"x\\nStarting step: first\"");
    fs::write(dir.path().join("demo.yaml"), yaml).unwrap();
    let out = run(dir.path(), &[]);
    assert!(!out.status.success());
    assert!(text(&out).contains("control characters"), "{}", text(&out));
}
