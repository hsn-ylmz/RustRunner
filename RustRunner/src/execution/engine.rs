//! Workflow Execution Engine
//!
//! The core engine that orchestrates workflow execution including:
//! - Parallel step scheduling with dependency resolution
//! - Resource monitoring
//! - Pause/resume functionality via file-based signaling
//! - State persistence for crash recovery
//! - Automatic conda environment setup for tools

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use log::{error, info, warn};

use crate::environment::conda::{create_env, ToolEnvMap};
use crate::monitoring::{EventType, ExecutionTimeline, ResourceMonitor};
use crate::workflow::{ExecutionPlanner, Workflow, WorkflowState};

use super::checks::run_checks;
use super::step::execute_step_with_retries;
use super::tools::is_system_tool;

/// Interval for checking the pause flag file.
const PAUSE_CHECK_INTERVAL: Duration = Duration::from_millis(500);

/// Interval for resource monitoring samples.
const MONITOR_SAMPLE_INTERVAL: Duration = Duration::from_millis(500);

/// Message a worker thread sends when its step is done.
struct StepCompletion {
    step_id: String,
    /// Attempts used by the tool run (output checks never add attempts).
    attempts: u32,
    /// Final result, including blocking output-check failures.
    result: Result<(), String>,
    /// Non-blocking output-check failures, to be shown in the summary.
    warnings: Vec<String>,
}

/// Runs the checks of a step whose command succeeded. A blocking failure
/// turns the result into an error; non-blocking ones come back as warnings.
fn apply_checks(
    step: &crate::workflow::Step,
    working_dir: &Option<PathBuf>,
) -> (Result<(), String>, Vec<String>) {
    let failures = run_checks(step, working_dir);
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    for failure in failures {
        if failure.blocking {
            blocking.push(failure.render());
        } else {
            warn!(
                "Step '{}': output check failed: {}",
                step.id,
                failure.render()
            );
            warnings.push(format!("{}: {}", step.id, failure.render()));
        }
    }
    let result = if blocking.is_empty() {
        Ok(())
    } else {
        Err(format!("output check failed: {}", blocking.join("; ")))
    };
    (result, warnings)
}

/// Formats the "output check warnings" section of the run summary, or `None`
/// when there are none.
fn format_check_warnings(warnings: &[String]) -> Option<String> {
    if warnings.is_empty() {
        return None;
    }
    let mut out = String::from("Output check warnings:");
    for w in warnings {
        out.push_str(&format!("\n  {}", w));
    }
    Some(out)
}

/// Formats the "retried steps" section of the run summary, or `None` when no
/// step needed more than one attempt.
fn format_retry_summary(retried: &[(String, u32)]) -> Option<String> {
    if retried.is_empty() {
        return None;
    }
    let mut out = String::from("Retried steps:");
    for (id, attempts) in retried {
        out.push_str(&format!("\n  {}: {} attempts", id, attempts));
    }
    Some(out)
}

/// Workflow execution engine.
///
/// Manages the complete lifecycle of workflow execution from start to finish,
/// handling parallelization, resource constraints, and state persistence.
///
/// # Example
///
/// ```rust,no_run
/// use rustrunner::execution::Engine;
/// use rustrunner::load_workflow;
///
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let workflow = load_workflow("pipeline.yaml")?;
///     let mut engine = Engine::new(workflow);
///     engine.set_max_parallel(4);
///     engine.set_working_dir("/data/analysis");
///
///     engine.run()?;
///     Ok(())
/// }
/// ```
pub struct Engine {
    workflow: Workflow,
    workflow_path: String,
    max_parallel: usize,
    dry_run: bool,
    pause_flag_path: Option<String>,
    working_dir: Option<PathBuf>,
    fresh: bool,
}

impl Engine {
    /// Creates a new execution engine for a workflow.
    pub fn new(workflow: Workflow) -> Self {
        Self {
            workflow,
            workflow_path: String::new(),
            max_parallel: 4,
            dry_run: false,
            pause_flag_path: None,
            working_dir: None,
            fresh: false,
        }
    }

    /// When set, the state of any earlier run is discarded and every step runs
    /// again. By default a run resumes from the saved state.
    pub fn set_fresh(&mut self, fresh: bool) {
        self.fresh = fresh;
    }

    /// Sets the workflow file path (used for state persistence).
    pub fn set_workflow_path(&mut self, path: impl Into<String>) {
        self.workflow_path = path.into();
    }

    /// Sets the maximum number of parallel jobs.
    pub fn set_max_parallel(&mut self, max: usize) {
        self.max_parallel = max;
    }

    /// Enables or disables dry run mode.
    pub fn set_dry_run(&mut self, dry_run: bool) {
        self.dry_run = dry_run;
    }

    /// Sets the path for pause/resume signaling.
    pub fn set_pause_flag_path(&mut self, path: impl Into<String>) {
        self.pause_flag_path = Some(path.into());
    }

    /// Sets the working directory for step execution.
    pub fn set_working_dir(&mut self, dir: impl Into<PathBuf>) {
        self.working_dir = Some(dir.into());
    }

    /// Executes the workflow.
    ///
    /// This is the main entry point that:
    /// 1. Sets up conda environments for required tools
    /// 2. Loads or creates execution state
    /// 3. Verifies previously completed steps
    /// 4. Executes remaining steps in parallel
    /// 5. Saves state after each step
    /// 6. Reports final results
    ///
    /// # Returns
    ///
    /// * `Ok(())` - Workflow completed successfully
    /// * `Err` - A step failed or an error occurred
    pub fn run(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let start_time = Instant::now();

        // Generate workflow path if not set
        if self.workflow_path.is_empty() {
            self.workflow_path = "workflow.yaml".to_string();
        }

        // Setup conda environments for all tools (skip in dry run)
        if !self.dry_run {
            self.setup_environments()?;
        }

        if let Some(label) = self.workflow.metadata.as_ref().and_then(|m| m.label()) {
            info!("Workflow: {}", label);
        }

        // Load or create state. The state lives under the working directory
        // (the CLI has already changed into it, so this is the same place it
        // always was).
        let state_dir = self.working_dir.clone();
        let mut state = if self.fresh {
            let fresh = WorkflowState::new(&self.workflow_path).in_dir(state_dir.as_deref());
            if WorkflowState::state_file_exists_in(&self.workflow_path, state_dir.as_deref()) {
                if self.dry_run {
                    info!("Running from scratch (saved state left untouched: dry run)");
                } else {
                    info!("Running from scratch - discarding the saved state of the previous run");
                    if let Err(e) = fresh.delete() {
                        warn!("Could not delete the previous run's state: {}", e);
                    }
                }
            } else {
                info!("Running from scratch");
            }
            fresh
        } else {
            match WorkflowState::load_in(&self.workflow_path, state_dir.as_deref()) {
                Ok(state) => state,
                Err(e) => {
                    // A file that exists but fails to load is corrupt/incompatible.
                    // Warn loudly so completed steps aren't silently re-run.
                    if WorkflowState::state_file_exists_in(
                        &self.workflow_path,
                        state_dir.as_deref(),
                    ) {
                        warn!(
                            "Existing state file could not be read ({}). Starting fresh - \
                             previously completed steps will re-run.",
                            e
                        );
                    } else {
                        info!("Starting fresh workflow execution");
                    }
                    WorkflowState::new(&self.workflow_path).in_dir(state_dir.as_deref())
                }
            }
        };
        state.set_metadata(self.workflow.metadata.as_ref());

        // Verify completed steps still have outputs
        let steps_to_rerun: Vec<String> = self
            .workflow
            .steps
            .iter()
            .filter(|step| state.completed_steps.contains(&step.id) && !step.outputs_exist())
            .map(|step| {
                info!("Step '{}' outputs missing - scheduling rerun", step.id);
                step.id.clone()
            })
            .collect();

        for step_id in steps_to_rerun {
            state.completed_steps.remove(&step_id);
        }

        if state.is_resume() {
            info!(
                "Resuming previous run: {} step(s) already completed",
                state.completed_steps.len()
            );
            if let Some(failed) = &state.failed_step {
                info!("The previous run stopped at step '{}'", failed);
            }
        }

        // Initialize monitoring
        let mut timeline = ExecutionTimeline::new();

        info!(
            "Starting execution (max parallel: {}, dry run: {})",
            self.max_parallel, self.dry_run
        );

        // Create planner
        let mut planner = if state.is_resume() {
            ExecutionPlanner::from_state(
                self.workflow.clone(),
                state.clone(),
                self.dry_run,
                self.max_parallel,
            )?
        } else {
            ExecutionPlanner::new(self.workflow.clone(), self.dry_run, self.max_parallel)?
        };

        // Load environment mappings
        let env_map = ToolEnvMap::load();

        // Create channel for step completion
        let (tx, rx): (Sender<StepCompletion>, Receiver<StepCompletion>) = channel();
        let mut check_warnings: Vec<String> = Vec::new();

        // Start resource monitoring
        let monitor_running = Arc::new(AtomicBool::new(true));
        let monitor_flag = Arc::clone(&monitor_running);

        let monitor_handle = thread::spawn(move || {
            let mut monitor = ResourceMonitor::new();
            while monitor_flag.load(Ordering::Relaxed) {
                monitor.sample();
                thread::sleep(MONITOR_SAMPLE_INTERVAL);
            }
            monitor
        });

        let mut running_count = 0;

        // Error captured inside the loop. We break out on failure instead of
        // returning early so the monitor thread is always stopped and joined
        // below (an early `?` would leak the detached sampling thread).
        let mut run_error: Option<Box<dyn std::error::Error>> = None;

        // Main execution loop
        loop {
            // Schedule ready steps
            while running_count < self.max_parallel {
                let ready_steps = planner.get_ready_steps();
                if ready_steps.is_empty() {
                    break;
                }

                for step in ready_steps {
                    if running_count >= self.max_parallel {
                        break;
                    }

                    // Check for pause signal
                    if let Some(ref pause_path) = self.pause_flag_path {
                        self.check_pause_flag(pause_path);
                    }

                    info!("Starting step: {}", step.id);
                    timeline.add_event(step.id.clone(), EventType::Started);
                    planner.mark_step_running(&step.id);

                    if self.dry_run {
                        // Dry run output
                        println!();
                        println!("[DRY RUN] Step: {}", step.id);
                        println!("  Tool: {}", step.tool);
                        println!("  Command: {}", step.command);
                        println!("  Input: {:?}", step.input);
                        println!("  Output: {:?}", step.output);
                        println!("  Threads: {}", step.threads);
                        if step.retries > 0 {
                            println!(
                                "  Retries: {} ({}, {}s delay)",
                                step.retries,
                                step.retry_backoff.as_str(),
                                step.retry_delay_secs
                            );
                        }
                        if let Some(secs) = step.timeout_secs {
                            println!("  Timeout: {}s", secs);
                        }
                        for check in &step.checks {
                            println!("  Check: {}", check.describe());
                        }

                        timeline.add_event(step.id.clone(), EventType::Completed);
                        planner.mark_step_completed(&step.id);
                        continue;
                    }

                    // Spawn worker thread
                    let tx = tx.clone();
                    let step_clone = step.clone();
                    let env_map_clone = env_map.as_map().clone();
                    let working_dir_clone = self.working_dir.clone();
                    let pause_clone = self.pause_flag_path.clone();

                    thread::spawn(move || {
                        let run = execute_step_with_retries(
                            &step_clone,
                            &env_map_clone,
                            &working_dir_clone,
                            pause_clone.as_deref().map(Path::new),
                        );
                        let mut result = run.result.map_err(|e| e.to_string());
                        let mut warnings = Vec::new();
                        if result.is_ok() {
                            let (checked, warned) = apply_checks(&step_clone, &working_dir_clone);
                            result = checked;
                            warnings = warned;
                        }

                        if let Err(e) = tx.send(StepCompletion {
                            step_id: step_clone.id.clone(),
                            attempts: run.attempts,
                            result,
                            warnings,
                        }) {
                            error!("Failed to send completion signal: {}", e);
                        }
                    });

                    running_count += 1;
                }
            }

            // Check for completion
            if running_count == 0 && !planner.has_work_remaining() {
                break;
            }

            // Deadlock detection: nothing is running, yet work remains and no
            // step can be scheduled. Without this guard the loop would spin at
            // 100% CPU forever (e.g. an unschedulable step or a dependency
            // cycle the validator missed).
            if running_count == 0 && planner.has_work_remaining() {
                let (completed, total) = planner.progress();
                run_error = Some(
                    format!(
                        "Workflow deadlocked: {}/{} steps completed but no remaining \
                         step can be scheduled (check dependencies and thread limits)",
                        completed, total
                    )
                    .into(),
                );
                break;
            }

            // Wait for step completion (skip in dry run)
            if running_count > 0 && !self.dry_run {
                let StepCompletion {
                    step_id,
                    attempts,
                    result,
                    warnings,
                } = match rx.recv() {
                    Ok(msg) => msg,
                    Err(e) => {
                        run_error =
                            Some(format!("Failed to receive step completion: {}", e).into());
                        break;
                    }
                };

                running_count -= 1;
                check_warnings.extend(warnings);
                planner.record_attempts(&step_id, attempts);
                state.record_attempts(&step_id, attempts);

                match result {
                    Ok(()) => {
                        info!("Step '{}' completed successfully", step_id);
                        planner.mark_step_completed(&step_id);
                        timeline.add_event(step_id.clone(), EventType::Completed);
                        state.mark_completed(&step_id);
                        if let Err(e) = state.save() {
                            run_error = Some(e);
                            break;
                        }
                    }
                    Err(e) => {
                        error!("Step '{}' failed: {}", step_id, e);
                        planner.mark_step_failed(&step_id, e.clone());
                        timeline.add_event(step_id.clone(), EventType::Failed);
                        state.mark_failed(&step_id);
                        // Best-effort persist; the step failure is the primary error.
                        if let Err(save_err) = state.save() {
                            warn!("Failed to persist state after step failure: {}", save_err);
                        }

                        run_error =
                            Some(format!("Workflow failed at step '{}': {}", step_id, e).into());
                        break;
                    }
                }
            }
        }

        // A failure ends the loop while sibling steps may still be running.
        // Wait for them rather than returning: once this process exits nothing
        // could stop their process groups any more (the GUI's Stop signals
        // only this process), and steps that do finish are recorded so a
        // resumed run skips them.
        if running_count > 0 {
            info!(
                "Waiting for {} running step(s) to finish before stopping",
                running_count
            );
            let first_failure = state.failed_step.clone();
            while running_count > 0 {
                let Ok(done) = rx.recv() else { break };
                running_count -= 1;
                check_warnings.extend(done.warnings);
                planner.record_attempts(&done.step_id, done.attempts);
                state.record_attempts(&done.step_id, done.attempts);
                match done.result {
                    Ok(()) => {
                        info!("Step '{}' completed successfully", done.step_id);
                        planner.mark_step_completed(&done.step_id);
                        timeline.add_event(done.step_id.clone(), EventType::Completed);
                        state.mark_completed(&done.step_id);
                    }
                    Err(e) => {
                        error!("Step '{}' failed: {}", done.step_id, e);
                        planner.mark_step_failed(&done.step_id, e);
                        timeline.add_event(done.step_id.clone(), EventType::Failed);
                    }
                }
                // The run still stopped at the first failure.
                if let Some(failed) = &first_failure {
                    state.mark_failed(failed);
                }
                if let Err(e) = state.save() {
                    warn!("Failed to persist state: {}", e);
                }
            }
        }

        // Stop monitoring - always run, on both the success and error paths, so
        // the sampling thread is never left detached.
        monitor_running.store(false, Ordering::Relaxed);
        let final_monitor = monitor_handle
            .join()
            .map_err(|_| "Monitor thread panicked")?;

        // Propagate any error captured in the loop, now that cleanup is done.
        if let Some(e) = run_error {
            return Err(e);
        }

        let total_time = start_time.elapsed();

        // Print summary
        println!();
        println!("Workflow completed successfully");
        if let Some(label) = self.workflow.metadata.as_ref().and_then(|m| m.label()) {
            println!("Workflow: {}", label);
        }
        println!("Total execution time: {:.2?}", total_time);
        println!();
        if let Some(summary) = format_retry_summary(&planner.retried_steps()) {
            println!("{}", summary);
            println!();
        }
        if let Some(summary) = format_check_warnings(&check_warnings) {
            println!("{}", summary);
            println!();
        }
        println!("{}", final_monitor.get_summary());

        Ok(())
    }

    /// Checks if pause flag exists and waits for it to be removed.
    fn check_pause_flag(&self, pause_flag_path: &str) {
        let pause_path = Path::new(pause_flag_path);

        if pause_path.exists() {
            info!("Execution paused - waiting for resume signal");

            while pause_path.exists() {
                thread::sleep(PAUSE_CHECK_INTERVAL);
            }

            info!("Resumed");
        }
    }

    /// Returns the unique, sorted tools in the workflow that are not system
    /// tools and therefore need a conda environment.
    pub(crate) fn tools_requiring_environments(&self) -> Vec<String> {
        let tools: HashSet<&str> = self
            .workflow
            .steps
            .iter()
            .map(|step| step.tool.as_str())
            .filter(|tool| !is_system_tool(tool))
            .collect();
        let mut tools: Vec<String> = tools.into_iter().map(String::from).collect();
        tools.sort();
        tools
    }

    /// Sets up conda environments for all tools in the workflow.
    ///
    /// For each unique tool in the workflow:
    /// 1. Skips system tools (bash, cat, etc.)
    /// 2. Checks if tool is already in env_map
    /// 3. Creates a new conda environment if needed
    /// 4. Updates env_map with the new mapping
    fn setup_environments(&self) -> Result<(), Box<dyn std::error::Error>> {
        let conda_tools = self.tools_requiring_environments();

        if conda_tools.is_empty() {
            info!("No conda tools required - using system tools only");
            return Ok(());
        }

        info!(
            "Setting up environments for {} tools: {:?}",
            conda_tools.len(),
            conda_tools
        );

        // Load existing env_map
        let mut env_map = ToolEnvMap::load();

        for tool in &conda_tools {
            // Check if we already have a mapping for this tool
            if env_map.get(tool).is_some() {
                info!("Tool '{}' already has environment mapping", tool);
            } else {
                // No mapping - create environment with same name as tool
                info!("Creating environment for tool: {}", tool);
            }

            // Create the environment (will skip if already exists)
            // Environment name = tool name for simplicity
            let env_name = tool.clone();

            match create_env(&env_name, &[tool.clone()]) {
                Ok(()) => {
                    // Update env_map if not already present
                    if env_map.get(tool).is_none() {
                        env_map.set(tool, &env_name);
                    }
                    info!("Environment '{}' ready", env_name);
                }
                Err(e) => {
                    warn!(
                        "Failed to create environment for '{}': {}. Will try to continue.",
                        tool, e
                    );
                }
            }
        }

        // Save updated env_map
        if let Err(e) = env_map.save() {
            warn!("Failed to save environment map: {}", e);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{CheckKind, OutputCheck, Step, Workflow};
    use std::fs;
    use tempfile::tempdir;

    fn create_test_workflow() -> Workflow {
        let mut workflow = Workflow::new();
        workflow
            .add_step(
                Step::new("step1", "bash", "echo 'test1' > output1.txt").with_output("output1.txt"),
            )
            .unwrap();
        workflow
            .add_step(
                Step::new("step2", "bash", "cat {input} > output2.txt")
                    .with_input("output1.txt")
                    .with_output("output2.txt")
                    .depends_on("step1"),
            )
            .unwrap();

        // Add next reference
        if let Some(step1) = workflow.get_step_mut("step1") {
            step1.next.push("step2".to_string());
        }

        workflow
    }

    #[test]
    fn test_format_retry_summary() {
        assert_eq!(format_retry_summary(&[]), None);
        let text = format_retry_summary(&[("align".to_string(), 3)]).unwrap();
        assert!(text.starts_with("Retried steps:"));
        assert!(text.contains("align: 3 attempts"));
    }

    #[test]
    fn test_engine_creation() {
        let workflow = create_test_workflow();
        let engine = Engine::new(workflow);

        assert_eq!(engine.max_parallel, 4);
        assert!(!engine.dry_run);
        assert_eq!(engine.workflow_path, "");
    }

    #[test]
    fn test_engine_configuration() {
        let workflow = create_test_workflow();
        let mut engine = Engine::new(workflow);

        engine.set_workflow_path("test.yaml");
        engine.set_max_parallel(8);
        engine.set_dry_run(true);

        assert_eq!(engine.workflow_path, "test.yaml");
        assert_eq!(engine.max_parallel, 8);
        assert!(engine.dry_run);
    }

    #[test]
    fn test_engine_working_directory() {
        let workflow = create_test_workflow();
        let mut engine = Engine::new(workflow);

        let temp_dir = tempdir().unwrap();
        let path = temp_dir.path().to_path_buf();
        engine.set_working_dir(path.clone());

        assert_eq!(engine.working_dir, Some(path));
    }

    #[test]
    fn test_engine_pause_flag_path() {
        let workflow = create_test_workflow();
        let mut engine = Engine::new(workflow);

        engine.set_pause_flag_path("/tmp/pause.flag");
        assert_eq!(engine.pause_flag_path, Some("/tmp/pause.flag".to_string()));
    }

    #[test]
    fn test_dry_run_execution() {
        let workflow = create_test_workflow();
        let mut engine = Engine::new(workflow);

        let temp_dir = tempdir().unwrap();
        engine.set_working_dir(temp_dir.path().to_path_buf());
        engine.set_dry_run(true);
        engine.set_workflow_path("test.yaml");

        // Dry run should succeed without executing commands
        let result = engine.run();
        assert!(result.is_ok(), "Dry run should succeed: {:?}", result.err());
    }

    #[test]
    fn test_pause_flag_check() {
        let workflow = create_test_workflow();
        let engine = Engine::new(workflow);

        let temp_dir = tempdir().unwrap();
        let pause_path = temp_dir.path().join("pause.flag");

        // Verify no pause file => no blocking
        assert!(!pause_path.exists());

        // Create and remove to test detection
        fs::write(&pause_path, "paused").unwrap();
        assert!(pause_path.exists());
        fs::remove_file(&pause_path).unwrap();
        assert!(!pause_path.exists());

        // Now check_pause_flag should not block since file doesn't exist
        engine.check_pause_flag(pause_path.to_str().unwrap());
    }

    #[test]
    fn test_engine_default_workflow_path() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("s1", "bash", "echo hello"))
            .unwrap();
        let mut engine = Engine::new(workflow);
        engine.set_dry_run(true);

        // workflow_path is empty, run() should set default
        assert_eq!(engine.workflow_path, "");
        let _ = engine.run();
        assert_eq!(engine.workflow_path, "workflow.yaml");
    }

    /// Runs a workflow in a fresh temp dir; returns the run result, the dir
    /// and the engine's error text, if any.
    fn run_in_tempdir(workflow: Workflow) -> (Result<(), String>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let mut engine = Engine::new(workflow);
        engine.set_working_dir(dir.path().to_path_buf());
        engine.set_workflow_path(dir.path().join("wf.yaml").to_str().unwrap());
        let result = engine.run().map_err(|e| e.to_string());
        (result, dir)
    }

    /// Builds `first` plus a dependent step. Step ids are the key of the temp
    /// script file, so concurrently running tests must use distinct ids.
    fn two_step_workflow(first: Step) -> Workflow {
        let up_id = first.id.clone();
        let down_id = format!("{}_down", up_id);
        let mut wf = Workflow::from_steps(vec![
            first,
            Step::new(down_id.as_str(), "bash", "echo done > down.txt")
                .with_output("down.txt")
                .depends_on(up_id.as_str()),
        ]);
        wf.steps[0].next.push(down_id);
        wf
    }

    #[test]
    fn test_blocking_check_failure_fails_step_and_skips_downstream() {
        let up = Step::new("blk_up", "bash", "touch up.txt")
            .with_output("up.txt")
            .with_check(OutputCheck::new(CheckKind::NonEmpty));
        let (result, dir) = run_in_tempdir(two_step_workflow(up));
        let err = result.unwrap_err();
        assert!(err.contains("Workflow failed at step 'blk_up'"), "{err}");
        assert!(err.contains("output check failed"), "{err}");
        assert!(err.contains("is empty"), "{err}");
        assert!(
            !dir.path().join("down.txt").exists(),
            "downstream must not run"
        );
    }

    #[test]
    fn test_check_failure_does_not_rerun_the_tool() {
        // retries = 2, but the check fails after the (successful) command, so
        // the command must run exactly once.
        let up = Step::new("norerun_up", "bash", "echo run >> runs.log; touch up.txt")
            .with_output("up.txt")
            .with_retries(2)
            .with_retry_backoff(crate::workflow::RetryBackoff::Fixed, 0)
            .with_check(OutputCheck::new(CheckKind::NonEmpty));
        let (result, dir) = run_in_tempdir(two_step_workflow(up));
        assert!(result.is_err());
        let runs = fs::read_to_string(dir.path().join("runs.log")).unwrap();
        assert_eq!(runs.lines().count(), 1);
    }

    #[test]
    fn test_non_blocking_check_failure_lets_workflow_finish() {
        let up = Step::new("nonblk_up", "bash", "touch up.txt")
            .with_output("up.txt")
            .with_check(OutputCheck::min_lines(5).non_blocking());
        let (result, dir) = run_in_tempdir(two_step_workflow(up));
        assert!(result.is_ok(), "{:?}", result);
        assert!(dir.path().join("down.txt").exists());
    }

    #[test]
    fn test_passing_checks_let_workflow_finish() {
        let up = Step::new("pass_up", "bash", "printf 'a\\nb\\n' > up.txt")
            .with_output("up.txt")
            .with_check(OutputCheck::new(CheckKind::Exists))
            .with_check(OutputCheck::new(CheckKind::NonEmpty))
            .with_check(OutputCheck::min_lines(2));
        let (result, _dir) = run_in_tempdir(two_step_workflow(up));
        assert!(result.is_ok(), "{:?}", result);
    }

    #[test]
    fn test_apply_checks_splits_blocking_and_warnings() {
        let dir = tempdir().unwrap();
        let step = Step::new("s", "bash", "x")
            .with_output("missing.txt")
            .with_check(OutputCheck::new(CheckKind::Exists).non_blocking())
            .with_check(OutputCheck::new(CheckKind::NonEmpty));
        let (result, warnings) = apply_checks(&step, &Some(dir.path().to_path_buf()));
        assert!(result.unwrap_err().contains("non_empty"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].starts_with("s: exists"));
        assert!(format_check_warnings(&warnings)
            .unwrap()
            .starts_with("Output check warnings:"));
        assert_eq!(format_check_warnings(&[]), None);
    }

    /// Regression: a failing step used to make `run()` return while sibling
    /// steps were still running. The CLI then exited, leaving those steps'
    /// process groups running unattended (out of reach of the GUI's Stop) and
    /// never recording them as finished for a resume.
    #[test]
    fn test_failure_waits_for_running_siblings_and_records_them() {
        let wf = Workflow::from_steps(vec![
            Step::new("sib_fail", "bash", "exit 1"),
            Step::new("sib_slow", "bash", "sleep 1; touch slow.txt").with_output("slow.txt"),
        ]);
        let (result, dir) = run_in_tempdir(wf);
        let err = result.unwrap_err();
        assert!(err.contains("Workflow failed at step 'sib_fail'"), "{err}");
        assert!(
            dir.path().join("slow.txt").exists(),
            "run() returned before the running sibling finished"
        );
        let state = WorkflowState::load_in("wf.yaml", Some(dir.path())).unwrap();
        assert!(state.completed_steps.contains("sib_slow"));
        assert_eq!(state.failed_step.as_deref(), Some("sib_fail"));
    }

    #[test]
    fn test_setup_environments_system_tools_only() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("bash_step", "bash", "echo test"))
            .unwrap();

        let engine = Engine::new(workflow);

        // Should not error for system tools only
        let result = engine.setup_environments();
        assert!(result.is_ok());
    }
}
