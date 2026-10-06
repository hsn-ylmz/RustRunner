//! End-to-end checks for named file slots (`named_inputs` / `named_outputs`):
//! the real binary, a real shell, real files whose names would hurt if the
//! shell interpreted them.

#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rustrunner::workflow::{Step, Workflow};
use serde_json::Value;

const PREFIX: &str = "RUSTRUNNER_EVENT ";

/// A name with a space, a quote, a command substitution and a semicolon.
const NASTY: &str = "out dir/it's a $(touch PWNED_SUB); touch PWNED_SEMI.bam";
const NASTY_INDEX: &str = "out dir/it's `touch PWNED_TICK`.bai";

fn write_workflow(dir: &Path, steps: Vec<Step>) {
    let yaml = serde_yaml::to_string(&Workflow::from_steps(steps)).unwrap();
    fs::write(dir.join("wf.yaml"), yaml).unwrap();
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

fn skipped(out: &Output) -> Vec<String> {
    let mut list: Vec<String> = events_of(out)
        .iter()
        .filter(|e| e["event"] == "step_skipped")
        .map(|e| e["step"].as_str().unwrap().to_string())
        .collect();
    list.sort();
    list
}

fn no_injection(dir: &Path) {
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with("PWNED") {
                found.push(path.clone());
            }
            if path.is_dir() {
                walk(&path, found);
            }
        }
    }
    let mut found = Vec::new();
    walk(dir, &mut found);
    assert!(found.is_empty(), "shell code ran: {found:?}");
}

/// `make` writes two named outputs; `merge` reads them through slots.
fn two_steps() -> Vec<Step> {
    vec![
        Step::new("make", "bash", "printf data > {bam} && printf idx > {bai}")
            .with_named_output("bam", &[NASTY])
            .with_named_output("bai", &[NASTY_INDEX]),
        Step::new("merge", "bash", "cat {bam} {bai} > {merged}")
            .with_named_input("bam", &[NASTY])
            .with_named_input("bai", &[NASTY_INDEX])
            .with_named_output("merged", &["merged.txt"]),
    ]
}

#[test]
fn files_with_hostile_names_flow_through_named_slots() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(dir.path(), two_steps());

    let out = run(dir.path(), &[]);
    ok(&out);
    assert_eq!(
        fs::read_to_string(dir.path().join("merged.txt")).unwrap(),
        "dataidx"
    );
    assert!(dir.path().join(NASTY).exists());
    no_injection(dir.path());

    // The connection came from the named output: merge ran after make.
    let order: Vec<String> = events_of(&out)
        .iter()
        .filter(|e| e["event"] == "step_started")
        .map(|e| e["step"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(order, vec!["make", "merge"]);
}

#[test]
fn a_second_run_skips_steps_whose_named_files_are_current() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(dir.path(), two_steps());
    ok(&run(dir.path(), &[]));

    let again = run(dir.path(), &[]);
    ok(&again);
    assert_eq!(skipped(&again), vec!["make", "merge"]);

    // A missing named output makes its step run again, and its child with it.
    fs::remove_file(dir.path().join(NASTY_INDEX)).unwrap();
    let third = run(dir.path(), &[]);
    ok(&third);
    assert!(skipped(&third).is_empty(), "{:?}", skipped(&third));
}

#[test]
fn rebinding_a_slot_changes_the_definition_and_reruns_the_step() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "A").unwrap();
    fs::write(dir.path().join("b.txt"), "B").unwrap();
    let step = |file: &str| {
        Step::new("copy", "bash", "cat {src} > {dst}")
            .with_named_input("src", &[file])
            .with_named_output("dst", &["copy.txt"])
    };

    write_workflow(dir.path(), vec![step("a.txt")]);
    ok(&run(dir.path(), &[]));
    assert_eq!(
        fs::read_to_string(dir.path().join("copy.txt")).unwrap(),
        "A"
    );

    write_workflow(dir.path(), vec![step("a.txt")]);
    assert_eq!(skipped(&run(dir.path(), &[])), vec!["copy"]);

    write_workflow(dir.path(), vec![step("b.txt")]);
    let out = run(dir.path(), &[]);
    ok(&out);
    assert!(skipped(&out).is_empty());
    assert_eq!(
        fs::read_to_string(dir.path().join("copy.txt")).unwrap(),
        "B"
    );
}

#[test]
fn an_unbound_slot_stops_the_run_before_anything_starts() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(
        dir.path(),
        vec![
            Step::new("align", "bash", "touch ran.txt && cat {ref} {reads}")
                .with_named_input("ref", &[])
                .with_named_input("reads", &["r.fq"]),
        ],
    );
    let out = run(dir.path(), &[]);
    assert!(!out.status.success());
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(text.contains("{ref}") && text.contains("no file"), "{text}");
    assert!(!dir.path().join("ran.txt").exists());
}

#[test]
fn an_unknown_placeholder_stops_the_run_and_names_it() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(
        dir.path(),
        vec![Step::new("s", "bash", "echo {reds}").with_named_input("reads", &["r.fq"])],
    );
    let out = run(dir.path(), &[]);
    assert!(!out.status.success());
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(text.contains("{reds}"), "{text}");
}

#[test]
fn dry_run_shows_the_resolved_command_and_creates_nothing() {
    let dir = tempfile::tempdir().unwrap();
    write_workflow(dir.path(), two_steps());
    let out = run(dir.path(), &["--dry-run"]);
    ok(&out);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("Resolved command: cat "), "{text}");
    assert!(text.contains("Named output bam"), "{text}");
    assert!(!dir.path().join("merged.txt").exists());
    assert!(!dir.path().join("out dir").exists());
}

#[test]
fn the_report_records_the_command_that_ran() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a b.txt"), "A").unwrap();
    write_workflow(
        dir.path(),
        vec![Step::new("copy", "bash", "cat {src} > {dst}")
            .with_named_input("src", &["a b.txt"])
            .with_named_output("dst", &["copy.txt"])],
    );
    ok(&run(dir.path(), &[]));

    let runs_dir = dir.path().join(".rustrunner/runs");
    let run_json = fs::read_dir(&runs_dir)
        .unwrap()
        .flatten()
        .map(|e| e.path().join("run.json"))
        .find(|p| p.exists())
        .expect("a run record");
    let record: Value = serde_json::from_str(&fs::read_to_string(run_json).unwrap()).unwrap();
    assert_eq!(record["steps"][0]["command"], "cat 'a b.txt' > 'copy.txt'");
}

#[test]
fn a_check_can_target_a_named_output() {
    let dir = tempfile::tempdir().unwrap();
    let step = Step::new("s", "bash", "printf x > {full}; : > {empty}")
        .with_named_output("full", &["full.txt"])
        .with_named_output("empty", &["empty.txt"])
        .with_check(
            rustrunner::workflow::OutputCheck::new(rustrunner::workflow::CheckKind::NonEmpty)
                .with_target("empty"),
        );
    write_workflow(dir.path(), vec![step]);
    let out = run(dir.path(), &[]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("empty.txt"));
}

#[test]
fn per_slot_wildcards_expand_into_one_step_per_sample() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["s1_R1.fq", "s1_R2.fq", "s2_R1.fq", "s2_R2.fq"] {
        fs::write(dir.path().join(name), name).unwrap();
    }
    let mut step = Step::new("pair", "bash", "cat {r1} {r2} > {merged}")
        .with_named_input("r1", &["{sample}_R1.fq"])
        .with_named_input("r2", &["{sample}_R2.fq"])
        .with_named_output("merged", &["{sample}.txt"]);
    step.wildcard_files.insert(
        "sample".to_string(),
        vec!["s1_R1.fq".to_string(), "s2_R1.fq".to_string()],
    );
    write_workflow(dir.path(), vec![step]);
    ok(&run(dir.path(), &[]));
    assert_eq!(
        fs::read_to_string(dir.path().join("s1.txt")).unwrap(),
        "s1_R1.fqs1_R2.fq"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("s2.txt")).unwrap(),
        "s2_R1.fqs2_R2.fq"
    );
}
