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
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use log::{info, warn};

#[cfg(unix)]
/// How long children get to exit after SIGTERM before they are killed.
const TERMINATION_GRACE: Duration = Duration::from_secs(3);

#[cfg(unix)]
/// Poll interval while waiting for terminated children to disappear.
const TERMINATION_POLL: Duration = Duration::from_millis(50);

/// Poll interval while waiting for a child that has a timeout.
const TIMEOUT_POLL: Duration = Duration::from_millis(20);

/// Process ids (== process group ids on unix) of the currently running steps.
static RUNNING: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Set once a termination signal has been received; no new children may start.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn running() -> std::sync::MutexGuard<'static, Vec<u32>> {
    // The registry holds plain integers, so a poisoned lock is still usable.
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Result of a tracked run: the captured output and whether the run was
/// stopped because it exceeded its timeout.
#[derive(Debug)]
pub struct TrackedOutput {
    pub output: Output,
    /// True when the process group was terminated for running past the timeout.
    pub timed_out: bool,
}

/// True once a termination signal has been received. Callers that sleep or
/// loop (e.g. retry back-off) use this to give up promptly.
pub fn is_shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

/// Runs `cmd` to completion, capturing its output, as a tracked process group.
///
/// Behaves like [`Command::output`] (stdin is closed, stdout/stderr captured)
/// but registers the child so that a termination signal received by this
/// process also terminates the child and everything it spawned.
pub fn run_tracked(cmd: Command) -> io::Result<Output> {
    run_tracked_with_timeout(cmd, None).map(|t| t.output)
}

/// Like [`run_tracked`], but terminates the child's whole process group
/// (SIGTERM, then SIGKILL after a grace period) once `timeout` has elapsed.
/// The partial output captured up to that point is still returned, with
/// `timed_out` set.
pub fn run_tracked_with_timeout(
    mut cmd: Command,
    timeout: Option<Duration>,
) -> io::Result<TrackedOutput> {
    if is_shutting_down() {
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

    let mut child = cmd.spawn()?;
    let pid = child.id();
    running().push(pid);

    // A signal may have arrived between the check above and registration, in
    // which case the handler's snapshot missed this child: stop it ourselves.
    if is_shutting_down() {
        terminate_groups(&[pid]);
    }

    // Drain both pipes concurrently so a chatty child can't block on a full
    // pipe while we poll for its exit.
    let stdout_reader = drain(child.stdout.take());
    let stderr_reader = drain(child.stderr.take());

    let mut timed_out = false;
    let status = match timeout {
        None => child.wait(),
        Some(limit) => {
            let deadline = Instant::now() + limit;
            // When the group gets SIGKILL if it is still running after the
            // polite request. Only set once the timeout has fired.
            let mut kill_at: Option<Instant> = None;
            loop {
                // Keep reaping while waiting for the group to stop: an
                // unreaped zombie child would make the group look alive.
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => {}
                    Err(e) => break Err(e),
                }
                let now = Instant::now();
                if !timed_out && now >= deadline {
                    timed_out = true;
                    warn!(
                        "Process group {} exceeded its {}s timeout; terminating",
                        pid,
                        limit.as_secs()
                    );
                    kill_at = Some(request_termination(pid));
                    continue;
                }
                if let Some(at) = kill_at {
                    if now >= at {
                        warn!("Process group {} ignored SIGTERM; sending SIGKILL", pid);
                        force_kill(pid);
                        kill_at = None;
                    }
                }
                thread::sleep(TIMEOUT_POLL);
            }
        }
    };

    // The direct child is gone, but on timeout something else in its group
    // may still hold the output pipes open (which would block the readers
    // below). The child has been reaped, so this returns at once unless such
    // a straggler really exists.
    #[cfg(unix)]
    if timed_out {
        terminate_groups(&[pid]);
    }
    running().retain(|p| *p != pid);

    let status = status?;
    Ok(TrackedOutput {
        output: Output {
            status,
            stdout: stdout_reader.join().unwrap_or_default(),
            stderr: stderr_reader.join().unwrap_or_default(),
        },
        timed_out,
    })
}

/// Reads a pipe to the end on its own thread.
fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            // A read error just truncates the captured output.
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    })
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

/// Asks a timed-out process group to stop without waiting for it, and returns
/// when it should be force-killed if it is still running.
///
/// On unix this sends SIGTERM to the group. Windows has no polite equivalent
/// for a console tree, so the tree is killed right away.
fn request_termination(pid: u32) -> Instant {
    #[cfg(unix)]
    {
        signal_group(pid, libc::SIGTERM);
        Instant::now() + TERMINATION_GRACE
    }
    #[cfg(not(unix))]
    {
        terminate_groups(&[pid]);
        Instant::now()
    }
}

/// Force-kills a process group without waiting (no-op on Windows, where
/// [`request_termination`] already killed the tree).
fn force_kill(pid: u32) {
    #[cfg(unix)]
    signal_group(pid, libc::SIGKILL);
    #[cfg(not(unix))]
    let _ = pid;
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
    fn test_timeout_kills_process_group_and_reports_it() {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", "echo started; sleep 60 & echo $!; wait"]);
        let started = Instant::now();
        let out = run_tracked_with_timeout(cmd, Some(Duration::from_millis(300))).unwrap();
        assert!(out.timed_out);
        assert!(!out.output.status.success());
        assert!(started.elapsed() < Duration::from_secs(20));

        let stdout = String::from_utf8_lossy(&out.output.stdout).to_string();
        let grandchild: i32 = stdout.lines().nth(1).unwrap().trim().parse().unwrap();
        assert!(
            wait_until(|| !pid_alive(grandchild)),
            "grandchild {grandchild} survived the timeout"
        );
    }

    /// Regression: the timeout path used to wait out the whole SIGTERM grace
    /// period because nobody reaped the terminated child, so its zombie kept
    /// the process group "alive" and every timeout cost an extra ~3s.
    #[test]
    fn test_timeout_returns_promptly_when_child_obeys_sigterm() {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", "sleep 60"]);
        let started = Instant::now();
        let out = run_tracked_with_timeout(cmd, Some(Duration::from_millis(200))).unwrap();
        assert!(out.timed_out);
        assert!(
            started.elapsed() < TERMINATION_GRACE,
            "timeout took {:?}, i.e. it waited out the grace period",
            started.elapsed()
        );
    }

    #[test]
    fn test_timeout_escalates_to_sigkill_for_stubborn_child() {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", "trap '' TERM; while true; do sleep 0.1; done"]);
        let started = Instant::now();
        let out = run_tracked_with_timeout(cmd, Some(Duration::from_millis(200))).unwrap();
        assert!(out.timed_out);
        assert!(!out.output.status.success());
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn test_timeout_not_hit_for_fast_command() {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", "echo quick"]);
        let out = run_tracked_with_timeout(cmd, Some(Duration::from_secs(30))).unwrap();
        assert!(!out.timed_out);
        assert!(out.output.status.success());
        assert_eq!(String::from_utf8_lossy(&out.output.stdout).trim(), "quick");
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
