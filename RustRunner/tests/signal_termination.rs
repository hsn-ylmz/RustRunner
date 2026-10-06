//! End-to-end check that stopping `rustrunner` with SIGTERM/SIGINT also stops
//! the processes its steps started (no orphans).

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn pid_alive(pid: i32) -> bool {
    // SAFETY: signal 0 is an existence probe only.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_for(deadline_secs: u64, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(deadline_secs);
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    cond()
}

fn read_pid(path: &Path) -> Option<i32> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn run_and_signal(signal: libc::c_int) {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("sleeper.pid");

    // The step backgrounds a long sleep (a grandchild of rustrunner), records
    // its pid, then waits on it.
    let yaml = format!(
        r#"
steps:
  - id: long_step
    tool: bash
    command: "sleep 120 & echo $! > '{}'; wait"
    input: []
    output: []
    previous: []
    next: []
    threads: 1
"#,
        pid_file.display()
    );
    let workflow = dir.path().join("wf.yaml");
    fs::write(&workflow, yaml).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_rustrunner"))
        .arg(&workflow)
        .arg("--working-dir")
        .arg(dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    assert!(
        wait_for(20, || read_pid(&pid_file).is_some()),
        "step never started"
    );
    let sleeper = read_pid(&pid_file).unwrap();
    assert!(pid_alive(sleeper));

    // SAFETY: plain kill(2) on a child we own.
    unsafe { libc::kill(child.id() as i32, signal) };

    let status = child.wait().unwrap();
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&status),
        None,
        "rustrunner should exit via its handler, not die from the signal"
    );
    assert_eq!(status.code(), Some(128 + signal));

    assert!(
        wait_for(10, || !pid_alive(sleeper)),
        "step's child process {sleeper} was orphaned"
    );
}

#[test]
fn sigterm_terminates_running_step_processes() {
    run_and_signal(libc::SIGTERM);
}

#[test]
fn sigint_terminates_running_step_processes() {
    run_and_signal(libc::SIGINT);
}
