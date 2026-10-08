//! End-to-end checks for skipping steps whose outputs are up to date: the
//! real binary, a real state file and real file timestamps.

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, SystemTime};

use serde_json::Value;

const PREFIX: &str = "RUSTRUNNER_EVENT ";

/// `a` -> `b` -> `c` is a chain; `d` is independent. Each step appends a line
/// to `<id>_runs.log` so the tests can count how often it really ran.
fn chain_yaml(b_command: &str) -> String {
    format!(
        r#"
steps:
  - id: a
    tool: bash
    command: "echo run >> a_runs.log; cp in.txt a.out"
    input: [in.txt]
    output: [a.out]
    previous: []
    next: [b]
  - id: b
    tool: bash
    command: "{b_command}"
    input: [a.out]
    output: [b.out]
    previous: [a]
    next: [c]
  - id: c
    tool: bash
    command: "echo run >> c_runs.log; cp b.out c.out"
    input: [b.out]
    output: [c.out]
    previous: [b]
    next: []
  - id: d
    tool: bash
    command: "echo run >> d_runs.log; echo d > d.out"
    input: []
    output: [d.out]
    previous: []
    next: []
"#
    )
}

const B_COMMAND: &str = "echo run >> b_runs.log; cp a.out b.out";

fn setup(yaml: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("in.txt"), "data\n").unwrap();
    fs::write(dir.path().join("wf.yaml"), yaml).unwrap();
    dir
}

fn run(dir: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(dir.join("wf.yaml"))
        .arg("--working-dir")
        .arg(dir)
        .arg("--json-events")
        .args(extra)
        .output()
        .unwrap()
}

fn ok(out: &Output) {
    assert!(
        out.status.success(),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

fn events_of(out: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .filter_map(|line| line.strip_prefix(PREFIX))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

/// Steps reported as skipped, with the reason of each.
fn skipped(out: &Output) -> Vec<(String, String)> {
    let mut list: Vec<(String, String)> = events_of(out)
        .iter()
        .filter(|e| e["event"] == "step_skipped")
        .map(|e| {
            (
                e["step"].as_str().unwrap().to_string(),
                e["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    list.sort();
    list
}

/// Steps that were started, sorted.
fn started(out: &Output) -> Vec<String> {
    let mut list: Vec<String> = events_of(out)
        .iter()
        .filter(|e| e["event"] == "step_started")
        .map(|e| e["step"].as_str().unwrap().to_string())
        .collect();
    list.sort();
    list.dedup();
    list
}

fn up_to_date(ids: &[&str]) -> Vec<(String, String)> {
    ids.iter()
        .map(|id| (id.to_string(), "up_to_date".to_string()))
        .collect()
}

fn runs(dir: &Path, step: &str) -> usize {
    fs::read_to_string(dir.join(format!("{step}_runs.log")))
        .map(|s| s.lines().count())
        .unwrap_or(0)
}

fn set_mtime(path: &Path, time: SystemTime) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(time)
        .unwrap();
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_second_run_skips_every_step() {
    let dir = setup(&chain_yaml(B_COMMAND));
    let first = run(dir.path(), &[]);
    ok(&first);
    assert_eq!(started(&first), ["a", "b", "c", "d"]);

    let second = run(dir.path(), &[]);
    ok(&second);
    assert!(started(&second).is_empty());
    assert_eq!(skipped(&second), up_to_date(&["a", "b", "c", "d"]));
    for step in ["a", "b", "c", "d"] {
        assert_eq!(runs(dir.path(), step), 1, "step {step}");
    }
    let finished = events_of(&second).pop().unwrap();
    assert_eq!(finished["status"], "succeeded");
    assert_eq!(finished["summary"]["skipped"], 4);
}

#[test]
fn editing_a_command_reruns_that_step_and_its_children_only() {
    let dir = setup(&chain_yaml(B_COMMAND));
    ok(&run(dir.path(), &[]));

    let edited = chain_yaml("echo run >> b_runs.log; cp -f a.out b.out");
    fs::write(dir.path().join("wf.yaml"), edited).unwrap();
    let out = run(dir.path(), &[]);
    ok(&out);

    assert_eq!(started(&out), ["b", "c"]);
    assert_eq!(skipped(&out), up_to_date(&["a", "d"]));
    assert_eq!(runs(dir.path(), "a"), 1);
    assert_eq!(runs(dir.path(), "b"), 2);
    assert_eq!(runs(dir.path(), "c"), 2);
    assert_eq!(runs(dir.path(), "d"), 1);

    // The new definition is what is recorded now.
    let again = run(dir.path(), &[]);
    ok(&again);
    assert!(started(&again).is_empty());
}

#[test]
fn a_deleted_output_reruns_its_step_and_children() {
    let dir = setup(&chain_yaml(B_COMMAND));
    ok(&run(dir.path(), &[]));
    fs::remove_file(dir.path().join("b.out")).unwrap();

    let out = run(dir.path(), &[]);
    ok(&out);
    assert_eq!(started(&out), ["b", "c"]);
    assert_eq!(skipped(&out), up_to_date(&["a", "d"]));
}

#[test]
fn a_newer_input_reruns_the_steps_that_read_it() {
    let dir = setup(&chain_yaml(B_COMMAND));
    ok(&run(dir.path(), &[]));
    set_mtime(
        &dir.path().join("in.txt"),
        SystemTime::now() + Duration::from_secs(3600),
    );

    let out = run(dir.path(), &[]);
    ok(&out);
    assert_eq!(started(&out), ["a", "b", "c"]);
    assert_eq!(skipped(&out), up_to_date(&["d"]));
}

#[test]
fn from_scratch_runs_everything_again() {
    let dir = setup(&chain_yaml(B_COMMAND));
    ok(&run(dir.path(), &[]));
    let out = run(dir.path(), &["--fresh"]);
    ok(&out);
    assert_eq!(started(&out), ["a", "b", "c", "d"]);
    assert!(skipped(&out).is_empty());
}

#[test]
fn a_state_file_without_hashes_is_treated_as_unknown_and_runs() {
    let dir = setup(&chain_yaml(B_COMMAND));
    ok(&run(dir.path(), &[]));

    // Rewrite the state the way an older version saved it.
    let state_path = dir.path().join(".rustrunner/wf.state");
    let mut state: Value = serde_json::from_str(&fs::read_to_string(&state_path).unwrap()).unwrap();
    assert!(state["step_hashes"].is_object());
    state.as_object_mut().unwrap().remove("step_hashes");
    fs::write(&state_path, state.to_string()).unwrap();

    let out = run(dir.path(), &[]);
    ok(&out);
    assert_eq!(started(&out), ["a", "b", "c", "d"]);

    // The run recorded hashes, so the next one skips everything.
    let after = run(dir.path(), &[]);
    ok(&after);
    assert!(started(&after).is_empty());
}

#[test]
fn a_failed_step_is_not_up_to_date_next_time() {
    let yaml = chain_yaml("echo run >> b_runs.log; exit 1");
    let dir = setup(&yaml);
    assert!(!run(dir.path(), &[]).status.success());

    // Fix b. a stays up to date; b and c have never succeeded.
    fs::write(dir.path().join("wf.yaml"), chain_yaml(B_COMMAND)).unwrap();
    let out = run(dir.path(), &[]);
    ok(&out);
    assert_eq!(started(&out), ["b", "c"]);
    assert!(skipped(&out).contains(&("a".to_string(), "up_to_date".to_string())));
}

#[test]
fn dry_run_says_which_steps_would_run_and_why() {
    let dir = setup(&chain_yaml(B_COMMAND));
    ok(&run(dir.path(), &[]));
    let state_path = dir.path().join(".rustrunner/wf.state");
    let before = fs::read_to_string(&state_path).unwrap();

    // b changed, d lost its output, nothing else differs.
    fs::write(
        dir.path().join("wf.yaml"),
        chain_yaml("echo run >> b_runs.log; cp -f a.out b.out"),
    )
    .unwrap();
    fs::remove_file(dir.path().join("d.out")).unwrap();
    let out = run(dir.path(), &["--dry-run"]);
    ok(&out);
    let text = stdout(&out);

    assert!(text.contains("Would run: definition changed"), "{text}");
    assert!(
        text.contains("Would run: upstream step 'b' will run"),
        "{text}"
    );
    assert!(
        text.contains("Would run: outputs missing (d.out)"),
        "{text}"
    );
    assert!(text.contains("Up to date: would be skipped"), "{text}");
    assert_eq!(skipped(&out), up_to_date(&["a"]));
    // A dry run changes nothing: no state, no files, no commands.
    assert_eq!(fs::read_to_string(&state_path).unwrap(), before);
    assert_eq!(runs(dir.path(), "b"), 1);
    assert!(!dir.path().join("d.out").exists());

    // Input newer is reported too.
    fs::write(dir.path().join("wf.yaml"), chain_yaml(B_COMMAND)).unwrap();
    set_mtime(
        &dir.path().join("in.txt"),
        SystemTime::now() + Duration::from_secs(3600),
    );
    let text = stdout(&run(dir.path(), &["--dry-run"]));
    assert!(text.contains("Would run: input newer (in.txt)"), "{text}");

    // A from-scratch dry run lists every step as running.
    let text = stdout(&run(dir.path(), &["--dry-run", "--fresh"]));
    assert!(!text.contains("Up to date"), "{text}");
    assert_eq!(
        text.matches("Would run: run from scratch").count(),
        4,
        "{text}"
    );
}

const WILDCARD_YAML: &str = r#"
steps:
  - id: upper
    tool: bash
    command: "echo run >> upper_runs.log; tr a-z A-Z < {input} > {output}"
    input: ["{sample}.txt"]
    output: ["{sample}.upper"]
    previous: []
    next: [count]
    wildcard_files:
      sample: [s1.txt, s2.txt]
  - id: count
    tool: bash
    command: "echo run >> count_runs.log; wc -l < {input} > {output}"
    input: ["{sample}.upper"]
    output: ["{sample}.count"]
    previous: [upper]
    next: []
    wildcard_files:
      sample: [s1.txt, s2.txt]
"#;

#[test]
fn wildcard_expanded_steps_are_tracked_per_sample() {
    let dir = setup(WILDCARD_YAML);
    fs::write(dir.path().join("s1.txt"), "one\n").unwrap();
    fs::write(dir.path().join("s2.txt"), "two\n").unwrap();
    ok(&run(dir.path(), &[]));
    assert_eq!(runs(dir.path(), "upper"), 2);
    assert_eq!(runs(dir.path(), "count"), 2);

    let again = run(dir.path(), &[]);
    ok(&again);
    assert!(started(&again).is_empty());
    assert_eq!(skipped(&again).len(), 4);

    // Only sample 2 changes: its two steps run, sample 1's two are skipped.
    set_mtime(
        &dir.path().join("s2.txt"),
        SystemTime::now() + Duration::from_secs(3600),
    );
    let out = run(dir.path(), &[]);
    ok(&out);
    assert_eq!(started(&out).len(), 2, "{:?}", started(&out));
    assert_eq!(skipped(&out).len(), 2);
    assert_eq!(runs(dir.path(), "upper"), 3);
    assert_eq!(runs(dir.path(), "count"), 3);

    // Editing the template changes every expanded step.
    let edited = WILDCARD_YAML.replace("tr a-z A-Z", "tr a-z A-Z | cat");
    fs::write(dir.path().join("wf.yaml"), edited).unwrap();
    let out = run(dir.path(), &[]);
    ok(&out);
    assert_eq!(started(&out).len(), 4, "{:?}", started(&out));
}
