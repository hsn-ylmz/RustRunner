//! Individual Step Execution
//!
//! Handles the execution of a single workflow step including:
//! - Command placeholder substitution
//! - Script generation
//! - Environment activation (conda/system)
//! - Output directory creation

use std::collections::HashMap;
use std::error::Error;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use log::{debug, error, info, warn};

use crate::environment::conda::{MAMBA_ROOT_PREFIX, MICROMAMBA_PATH};
use crate::environment::install::{current_platform, path_with_first, tools_root, Install};
use crate::workflow::slots::render_command;
use crate::workflow::Step;

use super::events::{Event, EventSink};
use super::process::{is_shutting_down, run_tracked_with_timeout, TrackedOutput};
use super::tools::is_system_tool;

/// Executes a single workflow step.
///
/// This function handles:
/// - Command placeholder resolution ({input}, {output})
/// - Temporary script generation
/// - Conda environment activation for bioinformatics tools
/// - Working directory management
/// - Output capture and error handling
///
/// # Arguments
///
/// * `step` - The workflow step to execute
/// * `tool_env_map` - Mapping of tool names to conda environment names
/// * `working_dir` - Optional working directory for relative paths
///
/// # Returns
///
/// * `Ok(())` - Step completed successfully
/// * `Err` - Step failed with descriptive error
///
/// This runs the step as configured, including its retries and timeout; use
/// [`execute_step_with_retries`] to also learn how many attempts were made.
///
/// # Placeholder Substitution
///
/// The following placeholders are supported:
/// - `{input}` / `{inputs}` - Space-separated input files
/// - `{output}` / `{outputs}` - Space-separated output files
/// - `{threads}` - The step's thread count
/// - `{name}` - The files of a named input or output slot (see
///   [`crate::workflow::slots`])
pub fn execute_step(
    step: &Step,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    execute_step_with_retries(step, tool_env_map, working_dir, None).result
}

/// Outcome of running a step including every retry.
#[derive(Debug)]
pub struct StepRun {
    /// Number of attempts that were started (at least 1).
    pub attempts: u32,
    /// Final result after the last attempt.
    pub result: Result<(), Box<dyn Error + Send + Sync>>,
}

/// Why a single attempt did not succeed.
enum AttemptError {
    /// The command failed or timed out; another attempt may succeed.
    Retryable(String),
    /// Retrying cannot help (setup problem, spawn failure, shutdown).
    Fatal(String),
}

/// Interval at which waits re-check for shutdown or a resume signal.
const WAIT_SLICE: Duration = Duration::from_millis(100);

/// Executes a step, re-running it on failure or timeout according to its
/// `retries`, `retry_backoff`, `retry_delay_secs` and `timeout_secs`.
///
/// Between attempts the function waits out the back-off delay and then, if
/// `pause_flag` points at an existing file, waits for it to disappear (the
/// GUI's Pause). A termination signal (the GUI's Stop) aborts the wait and
/// any further attempts. Failures that retrying cannot fix (for example a
/// missing conda environment) are not retried.
///
/// This is [`execute_step_with_events`] without events.
pub fn execute_step_with_retries(
    step: &Step,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
    pause_flag: Option<&Path>,
) -> StepRun {
    execute_step_with_events(
        step,
        tool_env_map,
        working_dir,
        pause_flag,
        &EventSink::disabled(),
    )
}

/// Like [`execute_step_with_retries`], and also reports run events.
///
/// `events` receives `step_retrying` for each failed attempt that will be
/// repeated and `step_started` for every attempt after the first; the caller
/// announces the first attempt and the final outcome.
pub fn execute_step_with_events(
    step: &Step,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
    pause_flag: Option<&Path>,
    events: &EventSink,
) -> StepRun {
    let step_name = &step.id;

    // Every declared output, including the named ones.
    let output_files = step.output_paths();

    // Create output directories
    if let Err(e) = ensure_output_directories(&output_files, working_dir) {
        return StepRun {
            attempts: 1,
            result: Err(e),
        };
    }

    // A mocked step stands in for the tool: it makes the outputs and returns.
    if step.mock {
        info!(
            "Step '{}' is mocked: creating its outputs instead of running it",
            step_name
        );
        return StepRun {
            attempts: 1,
            result: create_mock_outputs(&output_files, working_dir),
        };
    }

    // Resolve placeholders. Each file is shell-quoted individually so paths
    // containing spaces or shell metacharacters (e.g. a filename picked from
    // disk like `my sample; rm -rf ~.fastq`) are passed as literal arguments
    // rather than being interpreted by bash. A step with named slots fails
    // here, before anything runs, when a placeholder has no file.
    let command_text = match render_command(step) {
        Ok(text) => text,
        Err(errors) => {
            return StepRun {
                attempts: 1,
                result: Err(errors.join("\n").into()),
            }
        }
    };

    let max_attempts = step.retries.saturating_add(1);
    let timeout = step.timeout_secs.map(Duration::from_secs);

    for attempt in 1..=max_attempts {
        if attempt > 1 {
            let delay = step.retry_delay(attempt - 1);
            info!(
                "Step '{}': waiting {}s before attempt {}/{}",
                step_name,
                delay.as_secs(),
                attempt,
                max_attempts
            );
            if !sleep_unless_shutdown(delay) || !wait_while_paused(pause_flag) {
                return StepRun {
                    attempts: attempt - 1,
                    result: Err(format!(
                        "Step '{}' stopped before retry attempt {}",
                        step_name, attempt
                    )
                    .into()),
                };
            }
        }

        if max_attempts > 1 {
            info!("Step '{}': attempt {}/{}", step_name, attempt, max_attempts);
        }
        if attempt > 1 {
            events.emit(Event::StepStarted {
                step: step_name.clone(),
                attempt,
                max_attempts,
            });
        }

        match run_attempt(
            step,
            &command_text,
            tool_env_map,
            working_dir,
            timeout,
            events,
        ) {
            Ok(()) => {
                if attempt > 1 {
                    info!(
                        "Step '{}' succeeded on attempt {}/{}",
                        step_name, attempt, max_attempts
                    );
                }
                return StepRun {
                    attempts: attempt,
                    result: Ok(()),
                };
            }
            Err(AttemptError::Fatal(msg)) => {
                return StepRun {
                    attempts: attempt,
                    result: Err(msg.into()),
                };
            }
            Err(AttemptError::Retryable(msg)) if attempt == max_attempts => {
                let msg = if max_attempts > 1 {
                    format!("{} Gave up after {} attempts.", msg, attempt)
                } else {
                    msg
                };
                return StepRun {
                    attempts: attempt,
                    result: Err(msg.into()),
                };
            }
            Err(AttemptError::Retryable(msg)) => {
                warn!(
                    "Step '{}': attempt {}/{} failed ({}); will retry",
                    step_name, attempt, max_attempts, msg
                );
                events.emit(Event::StepRetrying {
                    step: step_name.clone(),
                    attempt,
                    max_attempts,
                    delay_secs: step.retry_delay(attempt).as_secs(),
                    reason: msg,
                });
            }
        }
    }

    unreachable!("max_attempts is at least 1 and every iteration returns or continues")
}

/// Sleeps for `total`, returning early with `false` if a termination signal
/// arrives.
fn sleep_unless_shutdown(total: Duration) -> bool {
    let deadline = Instant::now() + total;
    loop {
        if is_shutting_down() {
            return false;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep(WAIT_SLICE.min(deadline - now));
    }
}

/// Blocks while the pause flag file exists. Returns `false` if a termination
/// signal arrived while waiting.
fn wait_while_paused(pause_flag: Option<&Path>) -> bool {
    let Some(path) = pause_flag else {
        return !is_shutting_down();
    };
    if path.exists() {
        info!("Retry held while the workflow is paused");
    }
    while path.exists() {
        if is_shutting_down() {
            return false;
        }
        thread::sleep(WAIT_SLICE);
    }
    !is_shutting_down()
}

/// Runs the step's command once.
fn run_attempt(
    step: &Step,
    command_text: &str,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
    timeout: Option<Duration>,
    events: &EventSink,
) -> Result<(), AttemptError> {
    let step_name = &step.id;

    // Create execution script
    let script_path = create_execution_script(step_name, command_text)
        .map_err(|e| AttemptError::Fatal(e.to_string()))?;

    // Execute based on where the tool comes from
    let tracked = match launch_for(step, tool_env_map) {
        Ok(Launch::Bash) => execute_with_bash(&script_path, working_dir, timeout, None),
        Ok(Launch::BashWithPath(dir)) => {
            execute_with_bash(&script_path, working_dir, timeout, Some(&dir))
        }
        Ok(Launch::Conda(env_name)) => {
            execute_with_conda(&script_path, &env_name, working_dir, timeout)
        }
        Err(e) => Err(e.into()),
    };

    // Clean up script
    if let Err(e) = fs::remove_file(&script_path) {
        warn!("Failed to clean up script {}: {}", script_path.display(), e);
    }

    let tracked = tracked.map_err(|e| AttemptError::Fatal(e.to_string()))?;
    let output = tracked.output;

    if tracked.timed_out {
        let stderr = String::from_utf8_lossy(&output.stderr);
        events.note_stderr(step_name, &stderr);
        error!(
            "Step '{}' exceeded its {}s timeout and was killed",
            step_name,
            timeout.map(|t| t.as_secs()).unwrap_or(0)
        );
        if !stderr.trim().is_empty() {
            error!("stderr:\n{}", stderr);
        }
        return Err(AttemptError::Retryable(format!(
            "Step '{}' timed out after {}s and was killed.",
            step_name,
            timeout.map(|t| t.as_secs()).unwrap_or(0)
        )));
    }

    // Process result
    if output.status.success() {
        debug!("Step '{}' completed successfully", step_name);

        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            debug!("Step '{}' output:\n{}", step_name, stdout);
        }

        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        events.note_stderr(step_name, &stderr);

        error!(
            "Step '{}' failed with exit code: {:?}",
            step_name,
            output.status.code()
        );

        if !stderr.trim().is_empty() {
            error!("stderr:\n{}", stderr);
        }
        if !stdout.trim().is_empty() {
            debug!("stdout:\n{}", stdout);
        }

        Err(AttemptError::Retryable(format!(
            "Step '{}' failed. See logs for details.",
            step_name
        )))
    }
}

/// Creates parent directories for output files. An output that names a folder
/// (a path ending in `/`) is created itself, so a tool that writes into it
/// finds it there.
fn ensure_output_directories(
    output_files: &[String],
    working_dir: &Option<PathBuf>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    for output_file in output_files {
        if output_file.is_empty() {
            continue;
        }

        let output_path = match working_dir {
            Some(dir) => dir.join(output_file),
            None => PathBuf::from(output_file),
        };

        if output_file.ends_with('/') || output_file.ends_with('\\') {
            if !output_path.exists() {
                fs::create_dir_all(&output_path)?;
                debug!("Created output folder: {}", output_path.display());
            }
            continue;
        }

        if let Some(parent) = output_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
                debug!("Created directory: {}", parent.display());
            }
        }
    }
    Ok(())
}

/// Stands in for a mocked step: creates every declared output that is missing
/// (an empty file, or a directory for a path ending in `/`) and refreshes the
/// modification time of files that exist, leaving their content alone.
fn create_mock_outputs(
    output_files: &[String],
    working_dir: &Option<PathBuf>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    for output_file in output_files {
        let path = match working_dir {
            Some(dir) => dir.join(output_file),
            None => PathBuf::from(output_file),
        };
        if output_file.ends_with('/') || output_file.ends_with('\\') || path.is_dir() {
            fs::create_dir_all(&path)
                .map_err(|e| format!("Cannot create mock directory '{}': {}", output_file, e))?;
            continue;
        }
        let file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("Cannot create mock output '{}': {}", output_file, e))?;
        file.set_modified(std::time::SystemTime::now())
            .map_err(|e| format!("Cannot touch mock output '{}': {}", output_file, e))?;
        debug!("Mocked output: {}", path.display());
    }
    Ok(())
}

/// Directory holding this process's temporary step scripts.
pub fn script_dir() -> PathBuf {
    std::env::temp_dir().join(format!("rustrunner_scripts_{}", std::process::id()))
}

/// Removes this process's temporary step scripts (best effort).
pub fn cleanup_scripts() {
    let _ = fs::remove_dir_all(script_dir());
}

/// Creates a temporary bash script for step execution.
fn create_execution_script(
    step_id: &str,
    command_text: &str,
) -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    // Scope the script directory to this process so two concurrent runs (e.g.
    // two app windows) can't collide on a fixed path and delete or overwrite
    // each other's scripts mid-execution.
    let script_dir = script_dir();
    fs::create_dir_all(&script_dir)?;

    // Sanitize the step id so it can't escape the script directory via `/` or
    // `..` (path traversal) when used as a filename.
    let safe_id: String = step_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();

    let script_path = script_dir.join(format!("step_{}.sh", safe_id));
    let mut file = File::create(&script_path)?;

    writeln!(file, "#!/bin/bash")?;
    writeln!(file, "set -e")?;
    writeln!(file, "{}", command_text)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))?;
    }

    Ok(script_path)
}

/// Executes a script directly with bash.
fn execute_with_bash(
    script_path: &PathBuf,
    working_dir: &Option<PathBuf>,
    timeout: Option<Duration>,
    path_first: Option<&Path>,
) -> Result<TrackedOutput, Box<dyn Error + Send + Sync>> {
    let mut cmd = Command::new("bash");
    cmd.arg(script_path);
    if let Some(dir) = path_first {
        if let Some(path) = path_with_first(dir) {
            cmd.env("PATH", path);
        }
    }

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
        debug!("Executing in directory: {}", dir.display());
    }

    Ok(run_tracked_with_timeout(cmd, timeout)?)
}

/// How a step's script is started.
#[derive(Debug, PartialEq, Eq)]
enum Launch {
    /// `bash script`: a system tool, or a program already on the `PATH`.
    Bash,
    /// `bash script` with this folder first on the `PATH` (a downloaded tool).
    BashWithPath(PathBuf),
    /// `micromamba run -n <env> bash script`.
    Conda(String),
}

/// The conda environment the step runs in, if it runs in one: the one its
/// `install` block names (version included), else the environment
/// `env_map.json` maps its tool to. Used for launching and, as a label, for
/// the step's definition hash.
pub fn environment_label(step: &Step, tool_env_map: &HashMap<String, String>) -> Option<String> {
    match &step.install {
        Some(install) => install.hash_label(current_platform()),
        None => tool_env_map.get(&step.tool).cloned(),
    }
}

fn launch_for(step: &Step, tool_env_map: &HashMap<String, String>) -> Result<Launch, String> {
    match &step.install {
        Some(Install::System { .. }) => Ok(Launch::Bash),
        Some(install @ Install::External { binary, .. }) => install
            .installed_path_dir(&tools_root(), current_platform())
            .map(Launch::BashWithPath)
            .ok_or_else(|| {
                format!(
                    "The tool '{}' has not been downloaded (or the download was not verified). \
                     Run the workflow again to download it.",
                    binary
                )
            }),
        Some(install @ Install::Conda { package, .. }) => {
            let name = install
                .conda_env_name(current_platform())
                .ok_or_else(|| format!("No conda environment can be named for '{}'", package))?;
            Ok(Launch::Conda(name))
        }
        None if is_system_tool(&step.tool) => Ok(Launch::Bash),
        None => tool_env_map
            .get(&step.tool)
            .map(|name| Launch::Conda(name.clone()))
            .ok_or_else(|| {
                format!(
                    "No conda environment configured for tool '{}'. \
                     Create one with: micromamba create -n {} {} -c bioconda -c conda-forge",
                    step.tool, step.tool, step.tool
                )
            }),
    }
}

/// Executes a script within a conda environment.
fn execute_with_conda(
    script_path: &PathBuf,
    env_name: &str,
    working_dir: &Option<PathBuf>,
    timeout: Option<Duration>,
) -> Result<TrackedOutput, Box<dyn Error + Send + Sync>> {
    let mut cmd = Command::new(&*MICROMAMBA_PATH);
    cmd.env("MAMBA_ROOT_PREFIX", &*MAMBA_ROOT_PREFIX);
    cmd.arg("run")
        .arg("-n")
        .arg(env_name)
        .arg("bash")
        .arg(script_path);

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
        debug!(
            "Executing in directory: {} (conda env: {})",
            dir.display(),
            env_name
        );
    }

    Ok(run_tracked_with_timeout(cmd, timeout)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::model::split_list as parse_file_list;
    use crate::workflow::slots::{shell_join, shell_quote};

    #[test]
    fn test_parse_file_list() {
        let input = vec!["file1.txt, file2.txt".to_string()];
        let result = parse_file_list(&input);
        assert_eq!(result, vec!["file1.txt", "file2.txt"]);
    }

    #[test]
    fn test_shell_quote_plain() {
        assert_eq!(shell_quote("file.txt"), "'file.txt'");
    }

    #[test]
    fn test_shell_quote_spaces_and_metachars() {
        // Spaces and shell metacharacters must stay inside one quoted word.
        assert_eq!(shell_quote("my file; rm -rf ~"), "'my file; rm -rf ~'");
        assert_eq!(shell_quote("$(whoami).txt"), "'$(whoami).txt'");
    }

    #[test]
    fn test_shell_quote_embedded_single_quote() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn test_shell_join_quotes_each_file() {
        let files = vec!["a b.txt".to_string(), "c.txt".to_string()];
        assert_eq!(shell_join(&files), "'a b.txt' 'c.txt'");
    }

    #[test]
    fn test_create_execution_script_sanitizes_step_id() {
        // A step id with path separators must not escape the script directory.
        let script = create_execution_script("../evil/step", "echo hi").unwrap();
        let parent = script.parent().unwrap();
        assert!(parent
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("rustrunner_scripts_"));
        // Every non-alphanumeric char (including '.') is replaced with '_',
        // so "../evil/step" -> "___evil_step".
        assert_eq!(
            script.file_name().unwrap().to_str().unwrap(),
            "step____evil_step.sh"
        );
        std::fs::remove_file(script).unwrap();
    }

    #[test]
    fn test_is_system_tool() {
        assert!(is_system_tool("bash"));
        assert!(is_system_tool("echo"));
        assert!(!is_system_tool("bowtie2"));
        assert!(!is_system_tool("samtools"));
    }

    #[test]
    fn test_parse_file_list_empty() {
        let input: Vec<String> = vec![];
        let result = parse_file_list(&input);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_file_list_multiple() {
        let input = vec!["file1.txt,file2.txt,file3.txt".to_string()];
        let result = parse_file_list(&input);

        assert_eq!(result.len(), 3);
        assert_eq!(result, vec!["file1.txt", "file2.txt", "file3.txt"]);
    }

    #[test]
    fn test_parse_file_list_with_spaces() {
        let input = vec!["file1.txt, file2.txt , file3.txt".to_string()];
        let result = parse_file_list(&input);

        assert_eq!(result, vec!["file1.txt", "file2.txt", "file3.txt"]);
    }

    #[test]
    fn test_parse_file_list_empty_entries() {
        let input = vec!["file1.txt,,file2.txt".to_string()];
        let result = parse_file_list(&input);

        assert_eq!(result, vec!["file1.txt", "file2.txt"]);
    }

    #[test]
    fn test_parse_file_list_multiple_vec_entries() {
        let input = vec!["file1.txt".to_string(), "file2.txt,file3.txt".to_string()];
        let result = parse_file_list(&input);

        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_is_system_tool_variations() {
        assert!(is_system_tool("bash"));
        assert!(is_system_tool("grep"));
        assert!(is_system_tool("awk"));
        assert!(is_system_tool("sed"));
        assert!(is_system_tool("sort"));
        assert!(is_system_tool("wc"));
        assert!(is_system_tool("cat"));
        assert!(is_system_tool("head"));
        assert!(is_system_tool("tail"));
        assert!(!is_system_tool("bowtie2"));
        assert!(!is_system_tool("samtools"));
        assert!(!is_system_tool("BASH")); // Case sensitive
    }

    #[test]
    fn test_create_execution_script() {
        let script = create_execution_script("test_step", "echo 'hello world'");
        assert!(script.is_ok());

        let script_path = script.unwrap();
        assert!(script_path.exists());

        let content = std::fs::read_to_string(&script_path).unwrap();
        assert!(content.contains("#!/bin/bash"));
        assert!(content.contains("set -e"));
        assert!(content.contains("echo 'hello world'"));

        // Cleanup
        std::fs::remove_file(script_path).unwrap();
    }

    #[test]
    fn test_create_execution_script_multiline_command() {
        let script = create_execution_script("multi", "echo line1\necho line2");
        assert!(script.is_ok());

        let script_path = script.unwrap();
        let content = std::fs::read_to_string(&script_path).unwrap();
        assert!(content.contains("echo line1"));
        assert!(content.contains("echo line2"));

        std::fs::remove_file(script_path).unwrap();
    }

    #[test]
    fn test_ensure_output_directories() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let nested_file = "subdir1/subdir2/output.txt";

        let result = ensure_output_directories(
            &[nested_file.to_string()],
            &Some(temp_dir.path().to_path_buf()),
        );

        assert!(result.is_ok());
        assert!(temp_dir.path().join("subdir1/subdir2").exists());
    }

    #[test]
    fn test_ensure_output_directories_empty() {
        let result = ensure_output_directories(&["".to_string()], &None);

        assert!(result.is_ok());
    }

    #[test]
    fn test_ensure_output_directories_no_working_dir() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let output = temp_dir.path().join("newdir/output.txt");

        let result = ensure_output_directories(&[output.to_str().unwrap().to_string()], &None);

        assert!(result.is_ok());
        assert!(temp_dir.path().join("newdir").exists());
    }

    #[test]
    fn test_execute_step_simple_bash() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let output_file = temp_dir.path().join("out.txt");

        let step = Step::new(
            "test_exec",
            "bash",
            format!("echo hello > {}", output_file.display()),
        )
        .with_output(output_file.to_str().unwrap());

        let env_map = HashMap::new();
        let result = execute_step(&step, &env_map, &None);

        assert!(result.is_ok());
        assert!(output_file.exists());
    }

    use crate::workflow::RetryBackoff;
    use tempfile::tempdir;

    fn retry_step(id: &str, command: &str, retries: u32) -> Step {
        Step::new(id, "bash", command)
            .with_retries(retries)
            .with_retry_backoff(RetryBackoff::Fixed, 0)
    }

    #[test]
    fn test_retry_succeeds_on_second_attempt() {
        let dir = tempdir().unwrap();
        // Fails the first time (creating the marker), succeeds afterwards.
        let step = retry_step(
            "retry_second_attempt",
            "if [ -f marker ]; then echo ok > result.txt; else touch marker; exit 1; fi",
            2,
        );
        let run = execute_step_with_retries(
            &step,
            &HashMap::new(),
            &Some(dir.path().to_path_buf()),
            None,
        );
        assert!(run.result.is_ok(), "{:?}", run.result);
        assert_eq!(run.attempts, 2);
        assert!(dir.path().join("result.txt").exists());
    }

    #[test]
    fn test_retries_exhausted_reports_attempts() {
        let dir = tempdir().unwrap();
        let step = retry_step("retry_exhausted", "echo x >> count.txt; exit 1", 2);
        let run = execute_step_with_retries(
            &step,
            &HashMap::new(),
            &Some(dir.path().to_path_buf()),
            None,
        );
        assert_eq!(run.attempts, 3);
        let err = run.result.unwrap_err().to_string();
        assert!(err.contains("Gave up after 3 attempts"), "{err}");
        let runs = std::fs::read_to_string(dir.path().join("count.txt")).unwrap();
        assert_eq!(runs.lines().count(), 3);
    }

    #[test]
    fn test_no_retries_means_single_attempt_and_plain_error() {
        let step = retry_step("retry_none", "exit 1", 0);
        let run = execute_step_with_retries(&step, &HashMap::new(), &None, None);
        assert_eq!(run.attempts, 1);
        let err = run.result.unwrap_err().to_string();
        assert!(!err.contains("Gave up"), "{err}");
    }

    #[test]
    fn test_setup_errors_are_not_retried() {
        // No conda environment is configured for this tool: retrying is futile.
        let mut step = retry_step("retry_fatal", "true", 3);
        step.tool = "definitely_not_a_configured_tool".to_string();
        let run = execute_step_with_retries(&step, &HashMap::new(), &None, None);
        assert_eq!(run.attempts, 1);
        assert!(run.result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn test_timeout_kills_sleep_and_counts_as_failed_attempt() {
        let step = retry_step("retry_timeout", "sleep 60", 1).with_timeout_secs(1);
        let started = Instant::now();
        let run = execute_step_with_retries(&step, &HashMap::new(), &None, None);
        assert_eq!(run.attempts, 2);
        let err = run.result.unwrap_err().to_string();
        assert!(err.contains("timed out after 1s"), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "sleep was not killed: {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_timeout_does_not_affect_fast_step() {
        let step = Step::new("timeout_fast", "bash", "true").with_timeout_secs(30);
        let run = execute_step_with_retries(&step, &HashMap::new(), &None, None);
        assert!(run.result.is_ok());
        assert_eq!(run.attempts, 1);
    }

    #[test]
    fn test_retry_waits_for_pause_flag_to_clear() {
        let dir = tempdir().unwrap();
        let pause = dir.path().join("pause.flag");
        std::fs::write(&pause, "paused").unwrap();
        let remover = {
            let pause = pause.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(600));
                std::fs::remove_file(pause).unwrap();
            })
        };
        let step = retry_step(
            "retry_paused",
            "if [ -f marker ]; then exit 0; else touch marker; exit 1; fi",
            1,
        );
        let started = Instant::now();
        let run = execute_step_with_retries(
            &step,
            &HashMap::new(),
            &Some(dir.path().to_path_buf()),
            Some(&pause),
        );
        remover.join().unwrap();
        assert_eq!(run.attempts, 2);
        assert!(run.result.is_ok());
        assert!(started.elapsed() >= Duration::from_millis(500));
    }

    // ---- named slots through a real shell ----

    /// File names that would hurt if the shell interpreted them. Each is
    /// written to disk, so these are real, legal names.
    #[cfg(unix)]
    const NASTY_NAMES: [&str; 9] = [
        "plain.txt",
        "with space.txt",
        "semi; touch PWNED_SEMI.txt",
        "sub $(touch PWNED_SUB.txt) shell.txt",
        "tick `touch PWNED_TICK.txt`.txt",
        "it's quoted.txt",
        "dq \"quoted\" and \\ back.txt",
        "vars $HOME ${USER} $0.txt",
        "-leading dash and * glob.txt",
    ];

    /// Runs `command` with slot `f` = every nasty name and `o` = out.txt, and
    /// returns what the command wrote for each. Fails the test when any
    /// PWNED marker file appears.
    #[cfg(unix)]
    fn run_with_nasty_names(id: &str, command: &str) -> Vec<String> {
        let mut results = Vec::new();
        for name in NASTY_NAMES {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join(name), name).unwrap();
            let step = Step::new(id, "bash", command)
                .with_named_input("f", &[name])
                .with_named_output("o", &["out.txt"]);
            let run = execute_step_with_retries(
                &step,
                &HashMap::new(),
                &Some(dir.path().to_path_buf()),
                None,
            );
            assert!(run.result.is_ok(), "{name}: {:?}", run.result);
            let leaked: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("PWNED"))
                .collect();
            assert!(leaked.is_empty(), "{name} injected {leaked:?}");
            results.push(std::fs::read_to_string(dir.path().join("out.txt")).unwrap());
        }
        results
    }

    #[cfg(unix)]
    #[test]
    fn test_slot_paths_are_one_literal_argument_unquoted() {
        // cat reads the file named by the slot; its content is the name.
        let results = run_with_nasty_names("nasty_plain", "cat -- {f} > {o}");
        assert_eq!(results, NASTY_NAMES);
    }

    #[cfg(unix)]
    #[test]
    fn test_slot_paths_are_literal_inside_double_quotes() {
        let results = run_with_nasty_names("nasty_double", "printf '%s' \"{f}\" > {o}");
        assert_eq!(results, NASTY_NAMES);
    }

    #[cfg(unix)]
    #[test]
    fn test_slot_paths_are_literal_inside_single_quotes() {
        let results = run_with_nasty_names("nasty_single", "printf '%s' '{f}' > {o}");
        assert_eq!(results, NASTY_NAMES);
    }

    #[cfg(unix)]
    #[test]
    fn test_slot_paths_are_literal_after_an_equals_sign() {
        let results = run_with_nasty_names("nasty_equals", "printf '%s' --file={f} > {o}");
        let expected: Vec<String> = NASTY_NAMES
            .iter()
            .map(|n| format!("--file={}", n))
            .collect();
        assert_eq!(results, expected);
    }

    #[cfg(unix)]
    #[test]
    fn test_several_files_in_one_slot_are_separate_arguments() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a b.txt"), "A").unwrap();
        std::fs::write(dir.path().join("c'd.txt"), "C").unwrap();
        let step = Step::new("slot_many", "bash", "cat {both} > {o}")
            .with_named_input("both", &["a b.txt", "c'd.txt"])
            .with_named_output("o", &["merged.txt"]);
        let run = execute_step_with_retries(
            &step,
            &HashMap::new(),
            &Some(dir.path().to_path_buf()),
            None,
        );
        assert!(run.result.is_ok(), "{:?}", run.result);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("merged.txt")).unwrap(),
            "AC"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_unbound_slot_fails_before_anything_runs() {
        let dir = tempdir().unwrap();
        let step =
            Step::new("slot_unbound", "bash", "touch ran.txt {ref}").with_named_input("ref", &[]);
        let run = execute_step_with_retries(
            &step,
            &HashMap::new(),
            &Some(dir.path().to_path_buf()),
            None,
        );
        let err = run.result.unwrap_err().to_string();
        assert!(err.contains("{ref}"), "{err}");
        assert!(!dir.path().join("ran.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn test_named_output_directories_are_created_and_mock_makes_them() {
        let dir = tempdir().unwrap();
        let mut step = Step::new("slot_mocked", "bash", "false")
            .with_named_output("bam", &["out/deep/a.bam"])
            .with_output("plain.txt");
        step.mock = true;
        let run = execute_step_with_retries(
            &step,
            &HashMap::new(),
            &Some(dir.path().to_path_buf()),
            None,
        );
        assert!(run.result.is_ok(), "{:?}", run.result);
        assert!(dir.path().join("out/deep/a.bam").exists());
        assert!(dir.path().join("plain.txt").exists());
    }

    // ---- where the tool comes from ----

    fn conda_install(version: Option<&str>) -> Install {
        Install::Conda {
            package: "samtools".into(),
            version: version.map(String::from),
            channel: None,
            osx64: false,
        }
    }

    #[test]
    fn test_launch_follows_the_install_block() {
        let map = HashMap::new();
        let plain = Step::new("a", "bash", "true");
        assert_eq!(launch_for(&plain, &map), Ok(Launch::Bash));

        let pinned = Step::new("a", "samtools", "true").with_install(conda_install(Some("1.24")));
        assert_eq!(
            launch_for(&pinned, &map),
            Ok(Launch::Conda("samtools-1.24".to_string()))
        );

        let system = Step::new("a", "minimap2", "true").with_install(Install::System {
            binary: "minimap2".into(),
        });
        assert_eq!(launch_for(&system, &map), Ok(Launch::Bash));
    }

    #[test]
    fn test_launch_without_install_uses_the_env_map_as_before() {
        let mut map = HashMap::new();
        map.insert("samtools".to_string(), "my_env".to_string());
        let step = Step::new("a", "samtools", "true");
        assert_eq!(
            launch_for(&step, &map),
            Ok(Launch::Conda("my_env".to_string()))
        );
        let unmapped = Step::new("a", "bowtie2", "true");
        let error = launch_for(&unmapped, &map).unwrap_err();
        assert!(
            error.contains("No conda environment configured for tool 'bowtie2'"),
            "{error}"
        );
    }

    #[test]
    fn test_an_external_tool_that_was_never_downloaded_says_so() {
        let mut url = std::collections::BTreeMap::new();
        let mut sha = std::collections::BTreeMap::new();
        for platform in crate::environment::install::PLATFORMS {
            url.insert(platform.to_string(), "https://example.org/t".to_string());
            sha.insert(platform.to_string(), "a".repeat(64));
        }
        let step = Step::new("a", "t", "t").with_install(Install::External {
            binary: "t".into(),
            version: None,
            url,
            sha256: sha,
            license: None,
        });
        let error = launch_for(&step, &HashMap::new()).unwrap_err();
        assert!(error.contains("has not been downloaded"), "{error}");
    }

    #[test]
    fn test_environment_label_makes_a_pin_part_of_the_definition() {
        let mut map = HashMap::new();
        map.insert("samtools".to_string(), "samtools".to_string());
        let old = Step::new("a", "samtools", "true");
        assert_eq!(environment_label(&old, &map), Some("samtools".to_string()));
        let a = Step::new("a", "samtools", "true").with_install(conda_install(Some("1.20")));
        let b = Step::new("a", "samtools", "true").with_install(conda_install(Some("1.24")));
        assert_ne!(environment_label(&a, &map), environment_label(&b, &map));
        let system =
            Step::new("a", "x", "true").with_install(Install::System { binary: "x".into() });
        assert_eq!(environment_label(&system, &map), None);
    }

    #[test]
    fn test_output_that_names_a_folder_is_created_itself() {
        let dir = tempfile::tempdir().unwrap();
        let base = Some(dir.path().to_path_buf());
        ensure_output_directories(
            &[
                "qc/".to_string(),
                "deep/er/file.txt".to_string(),
                "plain.txt".to_string(),
            ],
            &base,
        )
        .unwrap();
        assert!(dir.path().join("qc").is_dir());
        assert!(dir.path().join("deep/er").is_dir());
        assert!(!dir.path().join("deep/er/file.txt").exists());
        assert!(!dir.path().join("plain.txt").exists());
    }
}
