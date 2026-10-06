//! End-to-end checks for `--json-events`: the event lines the real binary
//! writes to stderr, their order, and that the human log is unchanged.

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

const PREFIX: &str = "RUSTRUNNER_EVENT ";

fn write_workflow(dir: &Path, yaml: &str) {
    fs::write(dir.join("wf.yaml"), yaml).unwrap();
}

fn run(dir: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(dir.join("wf.yaml"))
        .arg("--working-dir")
        .arg(dir)
        .args(extra)
        .output()
        .unwrap()
}

/// The events on stderr, in order. Fails on a prefixed line that is not JSON.
fn events_of(stderr: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter_map(|line| line.strip_prefix(PREFIX))
        .map(|json| serde_json::from_str(json).unwrap_or_else(|e| panic!("{e}: {json}")))
        .collect()
}

/// `name` or `name:step` per event.
fn outline(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|e| {
            let name = e["event"].as_str().unwrap();
            match (e["step"].as_str(), e["attempt"].as_u64()) {
                (Some(step), Some(n)) => format!("{name}:{step}:{n}"),
                (Some(step), None) => format!("{name}:{step}"),
                _ => match e["status"].as_str() {
                    Some(status) => format!("{name}:{status}"),
                    None => name.to_string(),
                },
            }
        })
        .collect()
}

// `flaky` fails once then succeeds; `thin` produces an empty file that a
// blocking check rejects; `after` depends on `thin` and so never runs.
const WORKFLOW: &str = r#"
steps:
  - id: flaky
    tool: bash
    command: "if [ -f marker ]; then touch flaky.out; else touch marker; exit 1; fi"
    input: []
    output: [flaky.out]
    previous: []
    next: [thin]
    retries: 1
    retry_delay_secs: 0
  - id: thin
    tool: bash
    command: "touch thin.out"
    input: []
    output: [thin.out]
    previous: [flaky]
    next: [after]
    checks:
      - kind: non_empty
  - id: after
    tool: bash
    command: "touch after.out"
    input: []
    output: [after.out]
    previous: [thin]
    next: []
"#;

#[test]
fn events_follow_retry_check_failure_and_skip_in_order() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(dir.path(), WORKFLOW);

    let out = run(dir.path(), &["--json-events"]);
    assert!(!out.status.success());
    let events = events_of(&out.stderr);

    assert_eq!(
        outline(&events),
        [
            "run_started",
            "step_started:flaky:1",
            "step_retrying:flaky:1",
            "step_started:flaky:2",
            "step_succeeded:flaky",
            "step_started:thin:1",
            "check_failed:thin",
            "step_failed:thin",
            "step_skipped:after",
            "run_finished:failed",
        ]
    );
    assert!(events.iter().all(|e| e["v"] == 1));
    assert_eq!(events[0]["workflow"], "wf");
    assert_eq!(events[2]["max_attempts"], 2);
    assert_eq!(events[6]["kind"], "non_empty");
    assert_eq!(events[6]["blocking"], true);
    assert_eq!(events[9]["summary"]["total"], 3);
    assert_eq!(events[9]["summary"]["succeeded"], 1);
    assert_eq!(events[9]["summary"]["failed"], 1);
    assert_eq!(events[9]["summary"]["skipped"], 1);
    assert_eq!(events[9]["summary"]["retried"], 1);

    // The human log still flows next to the events.
    let log =
        String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    assert!(log.contains("Starting step: flaky"), "{log}");
    assert!(log.contains("[ERROR] Step 'thin' failed"), "{log}");
}

#[test]
fn without_the_flag_no_event_lines_are_written() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(dir.path(), WORKFLOW);

    let out = run(dir.path(), &[]);
    assert!(!out.status.success());
    let all =
        String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    assert!(!all.contains("RUSTRUNNER_EVENT"), "{all}");
    assert!(all.contains("Starting step: flaky"), "{all}");
}

#[test]
fn a_resumed_run_reports_finished_steps_as_skipped() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(dir.path(), WORKFLOW);
    // First run: flaky succeeds (after its retry), thin fails its check.
    assert!(!run(dir.path(), &[]).status.success());
    // Make the check pass and resume.
    fs::write(dir.path().join("thin.out"), "data\n").unwrap();
    let wf = WORKFLOW.replace("touch thin.out", "echo data > thin.out");
    write_workflow(dir.path(), &wf);

    let out = run(dir.path(), &["--json-events"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let events = events_of(&out.stderr);
    assert_eq!(
        outline(&events),
        [
            "run_started",
            "step_skipped:flaky",
            "step_started:thin:1",
            "step_succeeded:thin",
            "step_started:after:1",
            "step_succeeded:after",
            "run_finished:succeeded",
        ]
    );
    // Finished steps whose outputs are current are skipped as up to date.
    assert_eq!(events[1]["reason"], "up_to_date");
    assert_eq!(events[6]["summary"]["skipped"], 1);
    assert_eq!(events[6]["summary"]["succeeded"], 2);
}

#[test]
fn a_terminated_run_ends_with_a_stopped_run_finished() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(
        dir.path(),
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
    );

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

    let events = events_of(&out.stderr);
    let names = outline(&events);
    assert_eq!(names.first().map(String::as_str), Some("run_started"));
    assert_eq!(
        names.last().map(String::as_str),
        Some("run_finished:stopped")
    );
    assert_eq!(
        names
            .iter()
            .filter(|n| n.starts_with("run_finished"))
            .count(),
        1
    );
}
