//! Child process management
//!
//! Every step runs as a tree of processes (`bash` -> tool, or `micromamba run`
//! -> `bash` -> tool). If only the top-level `rustrunner` process is signalled,
//! those children would keep running as orphans, so this module:
//!
//! - starts each step's child in its **own process group** (unix), so the whole
//!   tree can be signalled at once with `kill(-pgid, ...)`
//! - keeps a registry of the running children
//! - offers [`install_signal_handlers`], which makes SIGINT/SIGTERM terminate
//!   every registered process group before `rustrunner` itself exits
//!
//! On Windows the console delivers Ctrl-C to child processes itself; for the
//! forced-termination path the process tree is killed with `taskkill /T`.

#[cfg(unix)]
use std::collections::HashSet;
use std::io;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

use log::{info, warn};

#[cfg(unix)]
/// How long children get to exit after SIGTERM before they are killed.
const TERMINATION_GRACE: Duration = Duration::from_secs(3);

#[cfg(unix)]
/// Poll interval while waiting for terminated children to disappear.
const TERMINATION_POLL: Duration = Duration::from_millis(50);

/// Process ids (== process group ids on unix) of the currently running steps.
static RUNNING: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Set once a termination signal has been received; no new children may start.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn running() -> std::sync::MutexGuard<'static, Vec<u32>> {
    // The registry holds plain integers, so a poisoned lock is still usable.
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs `cmd` to completion, capturing its output, as a tracked process group.
///
/// Behaves like [`Command::output`] (stdin is closed, stdout/stderr captured)
/// but registers the child so that a termination signal received by this
/// process also terminates the child and everything it spawned.
pub fn run_tracked(mut cmd: Command) -> io::Result<Output> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "rustrunner is shutting down; step not started",
        ));
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // pgid 0 = new group whose id is the child's pid.
        cmd.process_group(0);
    }

    let child = cmd.spawn()?;
    let pid = child.id();
    running().push(pid);

    // A signal may have arrived between the check above and registration, in
    // which case the handler's snapshot missed this child: stop it ourselves.
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        terminate_groups(&[pid]);
    }

    let output = child.wait_with_output();
    running().retain(|p| *p != pid);
    output
}

/// Returns the process ids of all currently running tracked children.
pub fn running_pids() -> Vec<u32> {
    running().clone()
}

/// Terminates every tracked child's process group (SIGTERM, then SIGKILL).
pub fn terminate_all() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    let pids = running_pids();
    if !pids.is_empty() {
        info!("Terminating {} running step process group(s)", pids.len());
        terminate_groups(&pids);
    }
}

/// Terminates the given process groups: polite first, forceful after a grace
/// period. Returns once every group is gone or the kill has been sent.
pub fn terminate_groups(pids: &[u32]) {
    #[cfg(unix)]
    {
        for &pid in pids {
            signal_group(pid, libc::SIGTERM);
        }

        let deadline = Instant::now() + TERMINATION_GRACE;
        let mut alive: HashSet<u32> = pids.iter().copied().collect();
        while !alive.is_empty() && Instant::now() < deadline {
            alive.retain(|&pid| group_exists(pid));
            if !alive.is_empty() {
                thread::sleep(TERMINATION_POLL);
            }
        }

        for pid in alive {
            warn!("Process group {} ignored SIGTERM; sending SIGKILL", pid);
            signal_group(pid, libc::SIGKILL);
        }
    }

    #[cfg(not(unix))]
    {
        for &pid in pids {
            let status = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if let Err(e) = status {
                warn!("Failed to terminate process tree {}: {}", pid, e);
            }
        }
    }
}

#[cfg(unix)]
fn signal_group(pgid: u32, signal: libc::c_int) {
    // SAFETY: kill(2) has no memory-safety preconditions; a negative pid
    // addresses the process group. ESRCH (already gone) is expected and fine.
    unsafe {
        libc::kill(-(pgid as libc::pid_t), signal);
    }
}

/// True while any process in the group still exists (zombies included until
/// reaped; the waiting worker thread or init reaps them promptly).
#[cfg(unix)]
fn group_exists(pgid: u32) -> bool {
    // SAFETY: signal 0 only performs the existence/permission check.
    let rc = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
    rc == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// Installs a SIGINT/SIGTERM handler (Ctrl-C on Windows) that terminates all
/// running steps, removes their temporary scripts and exits with the
/// conventional `128 + signal` status.
///
/// Safe to call once at startup; the handler runs on its own thread so no
/// work happens in async-signal context.
pub fn install_signal_handlers(cleanup: impl Fn() + Send + 'static) -> io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()?;

    // Register the OS handlers synchronously so signals arriving right after
    // this function returns are already captured.
    #[cfg(unix)]
    let (mut sigint, mut sigterm) = {
        use tokio::signal::unix::{signal, SignalKind};
        let _guard = runtime.enter();
        (
            signal(SignalKind::interrupt())?,
            signal(SignalKind::terminate())?,
        )
    };

    thread::Builder::new()
        .name("signal-handler".into())
        .spawn(move || {
            #[cfg(unix)]
            let code = runtime.block_on(async {
                tokio::select! {
                    _ = sigint.recv() => 128 + libc::SIGINT,
                    _ = sigterm.recv() => 128 + libc::SIGTERM,
                }
            });
            #[cfg(not(unix))]
            let code = {
                let _ = runtime.block_on(tokio::signal::ctrl_c());
                130
            };

            info!("Termination signal received - stopping running steps");
            terminate_all();
            cleanup();
            std::process::exit(code);
        })?;

    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn pid_alive(pid: i32) -> bool {
        // SAFETY: signal 0 is an existence probe only.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn wait_until(mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        cond()
    }

    #[test]
    fn test_run_tracked_captures_output_and_status() {
        let mut ok = Command::new("bash");
        ok.args(["-c", "echo hello; echo oops >&2"]);
        let out = run_tracked(ok).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "oops");

        let mut bad = Command::new("bash");
        bad.args(["-c", "exit 3"]);
        assert_eq!(run_tracked(bad).unwrap().status.code(), Some(3));
    }

    #[test]
    fn test_run_tracked_registers_while_running_and_unregisters_after() {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", "echo $$; sleep 0.3"]);
        let handle = thread::spawn(move || run_tracked(cmd).unwrap());

        // Other tests share the registry, so look for this child's own pid.
        let out = handle.join().unwrap();
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        assert!(
            !running_pids().contains(&pid),
            "finished child still registered"
        );
    }

    #[test]
    fn test_children_run_in_their_own_process_group() {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", "ps -o pgid= -p $$"]);
        let out = run_tracked(cmd).unwrap();
        let pgid: i32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        // SAFETY: getpgrp has no preconditions.
        assert_ne!(pgid, unsafe { libc::getpgrp() });
    }

    /// The core guarantee: terminating a step's group also kills grandchildren
    /// (the `sleep` below is not the direct child), which plain
    /// `Child::kill` / SIGTERM-to-parent would orphan.
    #[test]
    fn test_terminate_groups_kills_grandchildren() {
        use std::os::unix::process::CommandExt;

        let mut cmd = Command::new("bash");
        cmd.args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(Stdio::piped())
            .process_group(0);
        let mut child = cmd.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let grandchild: i32 = line.trim().parse().unwrap();
        assert!(pid_alive(grandchild));

        terminate_groups(&[child.id()]);
        child.wait().unwrap();

        assert!(
            wait_until(|| !pid_alive(grandchild)),
            "grandchild {grandchild} survived group termination"
        );
    }

    #[test]
    fn test_terminate_groups_escalates_to_sigkill() {
        use std::os::unix::process::CommandExt;

        // Ignores SIGTERM, so only the SIGKILL escalation can stop it.
        let mut cmd = Command::new("bash");
        cmd.args([
            "-c",
            "trap '' TERM; echo ready; while true; do sleep 1; done",
        ])
        .stdout(Stdio::piped())
        .process_group(0);
        let mut child = cmd.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();

        terminate_groups(&[child.id()]);
        let status = child.wait().unwrap();
        assert!(!status.success());
    }
}
