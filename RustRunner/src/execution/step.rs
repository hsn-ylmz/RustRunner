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
use crate::workflow::Step;

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
pub fn execute_step_with_retries(
    step: &Step,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
    pause_flag: Option<&Path>,
) -> StepRun {
    let step_name = &step.id;

    // Parse comma-separated file lists
    let input_files = parse_file_list(&step.input);
    let output_files = parse_file_list(&step.output);

    // Create output directories
    if let Err(e) = ensure_output_directories(&output_files, working_dir) {
        return StepRun {
            attempts: 1,
            result: Err(e),
        };
    }

    // Resolve placeholders. Each file is shell-quoted individually so paths
    // containing spaces or shell metacharacters (e.g. a filename picked from
    // disk like `my sample; rm -rf ~.fastq`) are passed as literal arguments
    // rather than being interpreted by bash.
    let inputs_str = shell_join(&input_files);
    let outputs_str = shell_join(&output_files);

    let command_text = step
        .command
        .replace("{input}", &inputs_str)
        .replace("{output}", &outputs_str)
        .replace("{inputs}", &inputs_str)
        .replace("{outputs}", &outputs_str);

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

        match run_attempt(step, &command_text, tool_env_map, working_dir, timeout) {
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
) -> Result<(), AttemptError> {
    let step_name = &step.id;

    // Create execution script
    let script_path = create_execution_script(step_name, command_text)
        .map_err(|e| AttemptError::Fatal(e.to_string()))?;

    // Execute based on tool type
    let tracked = if is_system_tool(&step.tool) {
        execute_with_bash(&script_path, working_dir, timeout)
    } else {
        execute_with_conda(&script_path, &step.tool, tool_env_map, working_dir, timeout)
    };

    // Clean up script
    if let Err(e) = fs::remove_file(&script_path) {
        warn!("Failed to clean up script {}: {}", script_path.display(), e);
    }

    let tracked = tracked.map_err(|e| AttemptError::Fatal(e.to_string()))?;
    let output = tracked.output;

    if tracked.timed_out {
        let stderr = String::from_utf8_lossy(&output.stderr);
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

/// Quotes a single string for safe use as one POSIX shell word.
///
/// Wraps the value in single quotes and escapes any embedded single quote as
/// `'\''`, which is the standard way to make an arbitrary string a single
/// shell argument.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Shell-quotes each file and joins them with spaces for command substitution.
fn shell_join(files: &[String]) -> String {
    files
        .iter()
        .map(|f| shell_quote(f))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parses comma-separated file strings into a vector.
fn parse_file_list(files: &[String]) -> Vec<String> {
    files
        .iter()
        .flat_map(|s| s.split(',').map(|part| part.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

/// Creates parent directories for output files.
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

        if let Some(parent) = output_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
                debug!("Created directory: {}", parent.display());
            }
        }
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
) -> Result<TrackedOutput, Box<dyn Error + Send + Sync>> {
    let mut cmd = Command::new("bash");
    cmd.arg(script_path);

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
        debug!("Executing in directory: {}", dir.display());
    }

    Ok(run_tracked_with_timeout(cmd, timeout)?)
}

/// Executes a script within a conda environment.
fn execute_with_conda(
    script_path: &PathBuf,
    tool: &str,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
    timeout: Option<Duration>,
) -> Result<TrackedOutput, Box<dyn Error + Send + Sync>> {
    let env_name = tool_env_map.get(tool).ok_or_else(|| {
        format!(
            "No conda environment configured for tool '{}'. \
             Create one with: micromamba create -n {} {} -c bioconda -c conda-forge",
            tool, tool, tool
        )
    })?;

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
            &vec![nested_file.to_string()],
            &Some(temp_dir.path().to_path_buf()),
        );

        assert!(result.is_ok());
        assert!(temp_dir.path().join("subdir1/subdir2").exists());
    }

    #[test]
    fn test_ensure_output_directories_empty() {
        let result = ensure_output_directories(&vec!["".to_string()], &None);

        assert!(result.is_ok());
    }

    #[test]
    fn test_ensure_output_directories_no_working_dir() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let output = temp_dir.path().join("newdir/output.txt");

        let result = ensure_output_directories(&vec![output.to_str().unwrap().to_string()], &None);

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
            &format!("echo hello > {}", output_file.display()),
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
}
