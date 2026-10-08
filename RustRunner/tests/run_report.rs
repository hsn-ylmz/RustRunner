//! End-to-end checks for the per-run report written by the real binary:
//! `.rustrunner/runs/<run_id>/{run.json,report.html}`, the index, the path in
//! `run_finished`, and that a dry run leaves nothing behind.

#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

const PREFIX: &str = "RUSTRUNNER_EVENT ";

const WORKFLOW: &str = r#"
metadata:
  name: Report demo
steps:
  - id: make
    tool: bash
    command: "echo made > made.txt"
    input: []
    output: [made.txt]
    previous: []
    next: [boom]
  - id: boom
    tool: bash
    command: "echo 'something <b>broke</b>' >&2; exit 2"
    input: [made.txt]
    output: [never.txt]
    previous: [make]
    next: [after]
  - id: after
    tool: bash
    command: "touch after.txt"
    input: [never.txt]
    output: [after.txt]
    previous: [boom]
    next: []
"#;

fn run(dir: &Path, extra: &[&str]) -> Output {
    fs::write(dir.join("wf.yaml"), WORKFLOW).unwrap();
    Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(dir.join("wf.yaml"))
        .arg("--working-dir")
        .arg(dir)
        .args(extra)
        .output()
        .unwrap()
}

fn finished_event(stderr: &[u8]) -> Value {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter_map(|l| l.strip_prefix(PREFIX))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .find(|e| e["event"] == "run_finished")
        .expect("run_finished")
}

fn runs_dir(dir: &Path) -> PathBuf {
    dir.join(".rustrunner/runs")
}

#[test]
fn a_failed_run_leaves_a_report_that_run_finished_points_to() {
    let dir = tempfile::tempdir().unwrap();
    let out = run(dir.path(), &["--json-events"]);
    assert!(!out.status.success());

    let finished = finished_event(&out.stderr);
    let report = PathBuf::from(finished["report"].as_str().expect("report path"));
    assert!(report.is_absolute() && report.is_file(), "{report:?}");
    assert!(fs::canonicalize(&report)
        .unwrap()
        .starts_with(fs::canonicalize(runs_dir(dir.path())).unwrap()));

    let html = fs::read_to_string(&report).unwrap();
    assert!(html.contains("Report demo"));
    assert!(html.contains("something &lt;b&gt;broke&lt;/b&gt;"));
    assert!(!html.contains("<b>broke</b>"));

    let run: Value =
        serde_json::from_str(&fs::read_to_string(report.with_file_name("run.json")).unwrap())
            .unwrap();
    let statuses: Vec<&str> = run["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["status"].as_str().unwrap())
        .collect();
    assert_eq!(statuses, ["succeeded", "failed", "skipped"]);
    assert_eq!(run["steps"][1]["stderr_tail"], "something <b>broke</b>");
    assert_eq!(run["summary"], finished["summary"]);

    let index: Value =
        serde_json::from_str(&fs::read_to_string(runs_dir(dir.path()).join("index.json")).unwrap())
            .unwrap();
    assert_eq!(index["runs"].as_array().unwrap().len(), 1);
    assert_eq!(index["runs"][0]["status"], "failed");
    assert_eq!(index["runs"][0]["workflow"], "Report demo");
}

#[test]
fn the_report_is_written_without_json_events_too() {
    let dir = tempfile::tempdir().unwrap();
    run(dir.path(), &[]);
    assert_eq!(fs::read_dir(runs_dir(dir.path())).unwrap().count(), 2); // run dir + index
}

#[test]
fn a_dry_run_writes_no_report() {
    let dir = tempfile::tempdir().unwrap();
    let out = run(dir.path(), &["--json-events", "--dry-run"]);
    assert!(out.status.success());
    assert!(finished_event(&out.stderr).get("report").is_none());
    assert!(!runs_dir(dir.path()).exists());
}

#[test]
fn a_stopped_run_still_leaves_a_report_with_the_interrupted_step() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("wf.yaml"),
        r#"
steps:
  - id: long_step
    tool: bash
    command: "touch started; sleep 120"
    input: []
    output: []
    previous: []
    next: []
"#,
    )
    .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(dir.path().join("wf.yaml"))
        .arg("--working-dir")
        .arg(dir.path())
        .arg("--json-events")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !dir.path().join("started").exists() {
        assert!(Instant::now() < deadline, "step never started");
        thread::sleep(Duration::from_millis(50));
    }
    // SAFETY: plain kill(2) on our own child.
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let out = child.wait_with_output().unwrap();

    let finished = finished_event(&out.stderr);
    assert_eq!(finished["status"], "stopped");
    let report = PathBuf::from(finished["report"].as_str().expect("report path"));
    let run: Value =
        serde_json::from_str(&fs::read_to_string(report.with_file_name("run.json")).unwrap())
            .unwrap();
    assert_eq!(run["status"], "stopped");
    assert_ne!(run["steps"][0]["status"], "succeeded");
}
