//! End-to-end checks for `{app_resource:path}`: files that ship with the app
//! are named in a command and the engine fills in their absolute path. The
//! real binary, a real shell, a resources folder of the test's own
//! (`RUSTRUNNER_RESOURCES`).

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use rustrunner::workflow::{Step, Workflow};
use serde_json::Value;

const PREFIX: &str = "RUSTRUNNER_EVENT ";

/// A resources folder with one script, and a working directory.
struct Setup {
    resources: tempfile::TempDir,
    work: tempfile::TempDir,
}

fn setup(script: &str) -> Setup {
    let resources = tempfile::tempdir().unwrap();
    fs::create_dir_all(resources.path().join("tools")).unwrap();
    fs::write(resources.path().join("tools/make.sh"), script).unwrap();
    Setup {
        resources,
        work: tempfile::tempdir().unwrap(),
    }
}

fn write_workflow(dir: &Path, command: &str) {
    let step = Step::new("make", "bash", command)
        .with_named_input("seed", &["seed.txt"])
        .with_named_output("result", &["result.txt"]);
    let yaml = serde_yaml::to_string(&Workflow::from_steps(vec![step])).unwrap();
    fs::write(dir.join("wf.yaml"), yaml).unwrap();
    fs::write(dir.join("seed.txt"), "seed\n").unwrap();
}

fn run(setup: &Setup, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(setup.work.path().join("wf.yaml"))
        .arg("--working-dir")
        .arg(setup.work.path())
        .arg("--json-events")
        .args(extra)
        .env("RUSTRUNNER_RESOURCES", setup.resources.path())
        .output()
        .unwrap()
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn events_of(out: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .filter_map(|line| line.strip_prefix(PREFIX))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

fn skipped(out: &Output) -> Vec<String> {
    events_of(out)
        .iter()
        .filter(|e| e["event"] == "step_skipped")
        .map(|e| e["step"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_bundled_script_runs_with_its_absolute_path() {
    let s = setup("#!/bin/sh\ncat \"$1\" > \"$2\"\necho \"from the bundle\" >> \"$2\"\n");
    write_workflow(
        s.work.path(),
        "sh {app_resource:tools/make.sh} {seed} {result}",
    );
    let out = run(&s, &[]);
    assert!(out.status.success(), "{}", text(&out));
    assert_eq!(
        fs::read_to_string(s.work.path().join("result.txt")).unwrap(),
        "seed\nfrom the bundle\n"
    );
}

#[test]
fn the_dry_run_shows_the_resolved_path() {
    let s = setup("true\n");
    write_workflow(
        s.work.path(),
        "sh {app_resource:tools/make.sh} {seed} {result}",
    );
    let out = run(&s, &["--dry-run"]);
    assert!(out.status.success(), "{}", text(&out));
    let real = s.resources.path().canonicalize().unwrap();
    assert!(
        text(&out).contains(&real.join("tools/make.sh").display().to_string()),
        "{}",
        text(&out)
    );
    assert!(!s.work.path().join("result.txt").exists());
}

#[test]
fn changing_the_bundled_script_runs_the_step_again() {
    let s = setup("cat \"$1\" > \"$2\"; echo one >> \"$2\"\n");
    write_workflow(
        s.work.path(),
        "sh {app_resource:tools/make.sh} {seed} {result}",
    );
    assert!(run(&s, &[]).status.success());

    let again = run(&s, &[]);
    assert!(again.status.success(), "{}", text(&again));
    assert_eq!(skipped(&again), vec!["make"], "unchanged: up to date");

    // An app update that changes the script must not be mistaken for "up to date".
    fs::write(
        s.resources.path().join("tools/make.sh"),
        "cat \"$1\" > \"$2\"; echo two >> \"$2\"\n",
    )
    .unwrap();
    let third = run(&s, &[]);
    assert!(third.status.success(), "{}", text(&third));
    assert!(skipped(&third).is_empty(), "{:?}", skipped(&third));
    assert_eq!(
        fs::read_to_string(s.work.path().join("result.txt")).unwrap(),
        "seed\ntwo\n"
    );
}

#[test]
fn a_path_that_leaves_the_resources_folder_is_refused_before_anything_runs() {
    let s = setup("true\n");
    // A script next to the resources folder (inside the test's own temp folders).
    let secret = s.work.path().join("secret.sh");
    fs::write(&secret, "touch PWNED\n").unwrap();
    for bad in [
        "../secret.sh",
        "tools/../../secret.sh",
        "../../../../../../../../../../tmp/secret.sh",
        "/etc/hosts",
        ".hidden/x.sh",
    ] {
        write_workflow(
            s.work.path(),
            &format!("sh {{app_resource:{}}} {{seed}} {{result}}", bad),
        );
        let out = run(&s, &[]);
        assert!(!out.status.success(), "{} should fail", bad);
        // A path that is not even a placeholder is refused by the scanner as
        // an unknown name; either way the shell never saw it.
        assert!(!s.work.path().join("PWNED").exists());
        assert!(!s.work.path().join("result.txt").exists());
    }
}

#[test]
fn a_symlink_that_points_out_of_the_folder_is_refused() {
    let s = setup("true\n");
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("evil.sh"), "touch PWNED\n").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("evil.sh"),
        s.resources.path().join("tools/link.sh"),
    )
    .unwrap();
    write_workflow(
        s.work.path(),
        "sh {app_resource:tools/link.sh} {seed} {result}",
    );
    let out = run(&s, &[]);
    assert!(!out.status.success());
    assert!(
        text(&out).contains("leaves the app's resources folder"),
        "{}",
        text(&out)
    );
    assert!(!s.work.path().join("PWNED").exists());
}

#[test]
fn a_missing_bundled_file_says_so() {
    let s = setup("true\n");
    write_workflow(
        s.work.path(),
        "sh {app_resource:tools/absent.sh} {seed} {result}",
    );
    let out = run(&s, &[]);
    assert!(!out.status.success());
    assert!(
        text(&out).contains("not part of the installed app"),
        "{}",
        text(&out)
    );
}

#[test]
fn the_validator_reports_it_before_the_run() {
    let s = setup("true\n");
    write_workflow(
        s.work.path(),
        "sh {app_resource:tools/absent.sh} {seed} {result}",
    );
    let out = run(&s, &["--dry-run"]);
    assert!(!out.status.success());
    assert!(text(&out).contains("tools/absent.sh"), "{}", text(&out));
}
