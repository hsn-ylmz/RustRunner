//! End-to-end checks for keep-going mode (`--keep-going` / `keep_going: true`)
//! and the workflow id that keys the saved run state.

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;

const PREFIX: &str = "RUSTRUNNER_EVENT ";

/// `bad` fails; `after_bad` depends on it. `slow` and `slow_next` are an
/// independent branch that is still running when `bad` fails.
fn workflow(extra_top: &str, id: &str) -> String {
    format!(
        r#"
{extra_top}
metadata:
  id: {id}
  name: Keep Going Demo
steps:
  - id: bad
    tool: bash
    command: "exit 1"
    input: []
    output: []
    previous: []
    next: [after_bad]
  - id: after_bad
    tool: bash
    command: "touch after_bad.out"
    input: []
    output: [after_bad.out]
    previous: [bad]
    next: []
  - id: slow
    tool: bash
    command: "sleep 1; echo run >> slow_runs.log; touch slow.out"
    input: []
    output: [slow.out]
    previous: []
    next: [slow_next]
  - id: slow_next
    tool: bash
    command: "touch slow_next.out"
    input: []
    output: [slow_next.out]
    previous: [slow]
    next: []
"#
    )
}

fn run(dir: &Path, file: &str, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(dir.join(file))
        .arg("--working-dir")
        .arg(dir)
        .args(extra)
        .output()
        .unwrap()
}

fn events_of(out: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .filter_map(|l| l.strip_prefix(PREFIX))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn keep_going_flag_runs_the_independent_branch_and_reports_the_summary() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("wf.yaml"), workflow("", "kg-cli")).unwrap();

    let out = run(dir.path(), "wf.yaml", &["--keep-going", "--json-events"]);
    assert_eq!(out.status.code(), Some(1), "{}", text(&out));
    assert!(dir.path().join("slow.out").exists());
    assert!(dir.path().join("slow_next.out").exists());
    assert!(!dir.path().join("after_bad.out").exists());

    let log = text(&out);
    assert!(log.contains("1 step(s) failed (bad)"), "{log}");
    assert!(
        log.contains("1 step(s) not run because a step they depend on failed (after_bad)"),
        "{log}"
    );

    let events = events_of(&out);
    let last = events.last().unwrap();
    assert_eq!(last["event"], "run_finished");
    assert_eq!(last["status"], "failed");
    assert_eq!(last["summary"]["failed"], 1);
    assert_eq!(last["summary"]["skipped"], 1);
    assert_eq!(last["summary"]["succeeded"], 2);
    let skipped: Vec<&Value> = events
        .iter()
        .filter(|e| e["event"] == "step_skipped")
        .collect();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["step"], "after_bad");
    assert!(skipped[0]["reason"].as_str().unwrap().contains("bad"));
}

#[test]
fn yaml_field_turns_keep_going_on_and_the_default_stays_off() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("on.yaml"),
        workflow("keep_going: true", "kg-on"),
    )
    .unwrap();
    fs::write(dir.path().join("off.yaml"), workflow("", "kg-off")).unwrap();

    let on = run(dir.path(), "on.yaml", &[]);
    assert_eq!(on.status.code(), Some(1));
    assert!(dir.path().join("slow_next.out").exists(), "{}", text(&on));

    let dir2 = tempfile::tempdir().unwrap();
    fs::write(dir2.path().join("off.yaml"), workflow("", "kg-off")).unwrap();
    let off = run(dir2.path(), "off.yaml", &[]);
    assert_eq!(off.status.code(), Some(1));
    assert!(
        text(&off).contains("Workflow failed at step 'bad'"),
        "{}",
        text(&off)
    );
    assert!(
        !dir2.path().join("slow_next.out").exists(),
        "without keep-going no new step starts after a failure"
    );
}

#[test]
fn resume_after_keep_going_reruns_only_the_failed_branch() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("wf.yaml"), workflow("", "kg-resume")).unwrap();
    assert_eq!(
        run(dir.path(), "wf.yaml", &["--keep-going"]).status.code(),
        Some(1)
    );
    assert!(dir.path().join(".rustrunner/kg-resume.state").exists());

    // Fix the failing step and resume: the finished branch is not run again.
    let fixed = workflow("", "kg-resume").replace("\"exit 1\"", "\"true\"");
    fs::write(dir.path().join("wf.yaml"), fixed).unwrap();
    let out = run(dir.path(), "wf.yaml", &["--keep-going"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out));
    assert_eq!(
        fs::read_to_string(dir.path().join("slow_runs.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(dir.path().join("after_bad.out").exists());
}

#[test]
fn renaming_the_workflow_file_keeps_the_saved_run_when_it_has_an_id() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("first_name.yaml"),
        workflow("", "stable-id-1"),
    )
    .unwrap();
    run(dir.path(), "first_name.yaml", &["--keep-going"]);
    assert!(dir.path().join(".rustrunner/stable-id-1.state").exists());
    assert!(!dir.path().join(".rustrunner/first_name.state").exists());

    fs::rename(
        dir.path().join("first_name.yaml"),
        dir.path().join("second_name.yaml"),
    )
    .unwrap();
    let out = run(dir.path(), "second_name.yaml", &["--keep-going"]);
    assert!(
        text(&out).contains("Resuming previous run: 2 step(s) already completed"),
        "{}",
        text(&out)
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("slow_runs.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn an_unsafe_workflow_id_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("wf.yaml"), workflow("", "\"../evil\"")).unwrap();
    let out = run(dir.path(), "wf.yaml", &[]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out).contains("id may only contain"), "{}", text(&out));
    assert!(!dir.path().join("..").join("evil.state").exists());
}
