//! Workflow Execution Engine
//!
//! The core engine that orchestrates workflow execution including:
//! - Parallel step scheduling with dependency resolution
//! - Resource monitoring
//! - Pause/resume functionality via file-based signaling
//! - State persistence for crash recovery
//! - Automatic conda environment setup for tools

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use log::{error, info, warn};

use crate::environment::conda::{create_env, create_env_with, ToolEnvMap};
use crate::environment::install::{current_platform, find_on_path, tools_root, Install};
use crate::monitoring::{EventType, ExecutionTimeline, ResourceMonitor};
use crate::workflow::{
    assess, definition_hash, ExecutionPlanner, StaleReason, Workflow, WorkflowState,
};

use super::checks::run_checks;
use super::events::{new_run_id, Event, EventSink, RunStatus, RunSummary};
use super::process::is_shutting_down;
use super::report::{RunContext, StepInfo, RUNS_DIR};
use super::step::{environment_label, execute_step_with_events};
use super::tools::is_system_tool;
use crate::workflow::slots::{display_command, sorted_slots};

/// Interval for checking the pause flag file.
const PAUSE_CHECK_INTERVAL: Duration = Duration::from_millis(500);

/// Interval for resource monitoring samples.
const MONITOR_SAMPLE_INTERVAL: Duration = Duration::from_millis(500);

/// Reason carried by `step_skipped` for a step whose outputs are current.
const UP_TO_DATE: &str = "up_to_date";

/// Remembers the definition a step succeeded with, so the next run can tell
/// whether it changed.
fn record_definition(
    state: &mut WorkflowState,
    definitions: &HashMap<String, String>,
    step_id: &str,
) {
    if let Some(hash) = definitions.get(step_id) {
        state.record_definition(step_id, hash.clone());
    }
}

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
    events: &EventSink,
) -> (Result<(), String>, Vec<String>) {
    let failures = run_checks(step, working_dir);
    let mut blocking = Vec::new();
    let mut warnings = Vec::new();
    for failure in failures {
        events.emit(Event::CheckFailed {
            step: step.id.clone(),
            kind: failure.kind.as_str().to_string(),
            blocking: failure.blocking,
            message: failure.render(),
        });
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

/// Formats the "mocked steps" section of the run summary, or `None` when no
/// step is mocked (or nothing really ran, as in a dry run).
fn format_mock_summary(workflow: &Workflow, dry_run: bool) -> Option<String> {
    if dry_run {
        return None;
    }
    let mocked: Vec<&str> = workflow
        .steps
        .iter()
        .filter(|s| s.mock)
        .map(|s| s.id.as_str())
        .collect();
    if mocked.is_empty() {
        return None;
    }
    let mut out = String::from("MOCKED steps (the tool did not run, outputs are placeholders):");
    for id in mocked {
        out.push_str(&format!("\n  {}", id));
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
    keep_going: bool,
    events: EventSink,
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
            keep_going: false,
            events: EventSink::disabled(),
        }
    }

    /// Sets where machine-readable run events go (`--json-events`). Events are
    /// off by default.
    pub fn set_event_sink(&mut self, events: EventSink) {
        self.events = events;
    }

    /// When set, the state of any earlier run is discarded and every step runs
    /// again. By default a run resumes from the saved state.
    pub fn set_fresh(&mut self, fresh: bool) {
        self.fresh = fresh;
    }

    /// Keeps the run going after a step fails (`--keep-going`). A failed step
    /// then blocks only the steps that depend on it; independent branches run
    /// to the end, and the run still finishes as failed. The workflow's own
    /// `keep_going` setting turns this on too.
    pub fn set_keep_going(&mut self, keep_going: bool) {
        self.keep_going = keep_going;
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
        // Generate workflow path if not set
        if self.workflow_path.is_empty() {
            self.workflow_path = "workflow.yaml".to_string();
        }

        let total = self.workflow.steps.len();
        self.events.update_tally(|t| {
            *t = RunSummary {
                total,
                ..RunSummary::default()
            }
        });
        if !self.dry_run {
            self.events.enable_report(self.report_context());
        }
        self.events.emit(Event::RunStarted {
            workflow: self.display_name(),
            run_id: new_run_id(),
            steps: self.workflow.steps.iter().map(|s| s.id.clone()).collect(),
            dry_run: self.dry_run,
        });

        let result = self.execute();

        match &result {
            Ok(()) => self.events.finish(RunStatus::Succeeded, None),
            Err(e) => {
                let status = if is_shutting_down() {
                    RunStatus::Stopped
                } else {
                    RunStatus::Failed
                };
                self.events.finish(status, Some(e.to_string()));
            }
        }
        result
    }

    /// The workflow's name for events: its metadata name, else the file stem.
    fn display_name(&self) -> String {
        self.workflow
            .metadata
            .as_ref()
            .and_then(|m| m.name.clone())
            .filter(|n| !n.is_empty())
            .or_else(|| {
                Path::new(&self.workflow_path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "workflow".to_string())
    }

    /// What the run report needs to know about the workflow and where to put
    /// the report: `<working dir>/.rustrunner/runs`.
    fn report_context(&self) -> RunContext {
        let base = match &self.working_dir {
            Some(dir) => std::path::absolute(dir).unwrap_or_else(|_| dir.clone()),
            None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        };
        let metadata = self.workflow.metadata.as_ref();
        RunContext {
            runs_dir: base.join(RUNS_DIR),
            workflow_name: self.display_name(),
            workflow_id: metadata.and_then(|m| m.id.clone()),
            workflow_version: metadata.and_then(|m| m.version.clone()),
            keep_going: self.keep_going || self.workflow.keep_going,
            working_dir: base.to_string_lossy().into_owned(),
            steps: self
                .workflow
                .steps
                .iter()
                .map(|s| StepInfo {
                    id: s.id.clone(),
                    tool: s.tool.clone(),
                    command: display_command(s),
                    threads: s.threads,
                    depends_on: s.previous.clone(),
                    checks: s
                        .checks
                        .iter()
                        .map(|c| (c.kind.as_str().to_string(), c.describe()))
                        .collect(),
                })
                .collect(),
        }
    }

    /// Whether the step is mocked (its tool is not run).
    fn is_mocked(&self, step_id: &str) -> bool {
        self.workflow
            .steps
            .iter()
            .any(|s| s.id == step_id && s.mock)
    }

    /// Whether the step's result rests on a mock: the step is mocked, or a
    /// step it depends on (directly or further up) is. Such a step's outputs
    /// were made from placeholders, so its success is never remembered as up
    /// to date; otherwise removing the mocked step later would leave a
    /// placeholder-derived result that looks current.
    fn rests_on_mock(&self, step_id: &str) -> bool {
        let by_id: HashMap<&str, &crate::workflow::Step> = self
            .workflow
            .steps
            .iter()
            .map(|s| (s.id.as_str(), s))
            .collect();
        let mut seen: HashSet<&str> = HashSet::new();
        let mut stack = vec![step_id];
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            let Some(step) = by_id.get(id) else {
                continue;
            };
            if step.mock {
                return true;
            }
            stack.extend(step.previous.iter().map(String::as_str));
        }
        false
    }

    /// Reports a finished step: its event and the run totals.
    fn report_completion(&self, step_id: &str, attempts: u32, result: &Result<(), String>) {
        let mocked = self.is_mocked(step_id);
        match result {
            Ok(()) => self.events.emit(Event::StepSucceeded {
                step: step_id.to_string(),
                attempts,
                mocked,
            }),
            Err(reason) => self.events.emit(Event::StepFailed {
                step: step_id.to_string(),
                reason: reason.clone(),
                attempts,
            }),
        }
        self.events.update_tally(|t| {
            if result.is_ok() {
                t.succeeded += 1;
                if mocked {
                    t.mocked += 1;
                }
            } else {
                t.failed += 1;
            }
            if attempts > 1 {
                t.retried += 1;
            }
        });
    }

    /// The body of [`Engine::run`], between `run_started` and `run_finished`.
    fn execute(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let start_time = Instant::now();

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
        let workflow_id = self.workflow.metadata.as_ref().and_then(|m| m.id.clone());
        let keep_going = self.keep_going || self.workflow.keep_going;
        if keep_going {
            info!("Keep going: a failed step blocks only the steps that depend on it");
        }
        // A workflow that has just been given an id takes over the state it
        // saved under its old (file name) key. A dry run must not touch files.
        if !self.dry_run {
            if let Err(e) = WorkflowState::migrate_legacy(
                &self.workflow_path,
                workflow_id.as_deref(),
                state_dir.as_deref(),
            ) {
                warn!("Could not move the saved state to the workflow id: {}", e);
            }
        }
        let mut state = if self.fresh {
            let fresh = WorkflowState::new(&self.workflow_path)
                .with_id(workflow_id.as_deref())
                .in_dir(state_dir.as_deref());
            if WorkflowState::state_file_exists_keyed(
                &self.workflow_path,
                workflow_id.as_deref(),
                state_dir.as_deref(),
            ) {
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
            match WorkflowState::load_keyed(
                &self.workflow_path,
                workflow_id.as_deref(),
                state_dir.as_deref(),
            ) {
                Ok(state) => state,
                Err(e) => {
                    // A file that exists but fails to load is corrupt/incompatible.
                    // Warn loudly so completed steps aren't silently re-run.
                    if WorkflowState::state_file_exists_keyed(
                        &self.workflow_path,
                        workflow_id.as_deref(),
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
                    WorkflowState::new(&self.workflow_path)
                        .with_id(workflow_id.as_deref())
                        .in_dir(state_dir.as_deref())
                }
            }
        };
        state.set_metadata(self.workflow.metadata.as_ref());

        // Decide which steps are up to date: they succeeded before with this
        // very definition, their outputs exist and are newer than their
        // inputs, and nothing upstream has to run. Every other step runs, and
        // the state forgets that it ever succeeded.
        let env_map = ToolEnvMap::load();
        let env_of = |step: &crate::workflow::Step| environment_label(step, env_map.as_map());
        let definitions: HashMap<String, String> = self
            .workflow
            .steps
            .iter()
            .map(|s| (s.id.clone(), definition_hash(s, env_of(s).as_deref())))
            .collect();
        let stale: HashMap<String, StaleReason> =
            assess(&self.workflow, &state, self.working_dir.as_deref(), &env_of);
        let mut forgot_a_success = false;
        for step in &self.workflow.steps {
            let Some(reason) = stale.get(&step.id) else {
                continue;
            };
            if !self.fresh {
                info!("Step '{}' will run: {}", step.id, reason);
            }
            forgot_a_success |= state.completed_steps.contains(&step.id);
            state.invalidate(&step.id);
        }
        // Write that down before any stale step starts. Otherwise the file
        // still calls the step finished while it rewrites its outputs, and a
        // run killed at that moment (Stop, a crash) would leave fresh-looking
        // partial outputs behind that the next run skips as up to date.
        if forgot_a_success && !self.dry_run {
            state.save().map_err(|e| {
                format!(
                    "Could not save the run state before re-running out-of-date steps: {}",
                    e
                )
            })?;
        }

        if state.is_resume() {
            info!(
                "Resuming previous run: {} step(s) already completed and up to date",
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

        // Steps that are up to date and not repeated.
        let mut not_run: HashSet<String> = HashSet::new();
        if state.is_resume() {
            for step in &self.workflow.steps {
                if state.completed_steps.contains(&step.id) {
                    if self.dry_run {
                        println!();
                        println!("[DRY RUN] Step: {}", step.id);
                        println!("  Up to date: would be skipped");
                    }
                    self.events.emit(Event::StepSkipped {
                        step: step.id.clone(),
                        reason: UP_TO_DATE.to_string(),
                    });
                    self.events.update_tally(|t| t.skipped += 1);
                    not_run.insert(step.id.clone());
                }
            }
        }
        // Steps that were handed to a worker (or the dry run) in this run.
        let mut started: HashSet<String> = HashSet::new();

        // Create channel for step completion
        let (tx, rx): (Sender<StepCompletion>, Receiver<StepCompletion>) = channel();
        let mut check_warnings: Vec<String> = Vec::new();

        // Start resource monitoring
        let monitor_running = Arc::new(AtomicBool::new(true));
        let monitor_flag = Arc::clone(&monitor_running);
        let monitor_events = self.events.clone();

        let monitor_handle = thread::spawn(move || {
            let mut monitor = ResourceMonitor::new();
            let mut reported = 0;
            while monitor_flag.load(Ordering::Relaxed) {
                monitor.sample();
                // Hand new samples to the run report as they are taken, so a
                // stopped run keeps the ones up to the stop.
                for sample in &monitor.get_samples()[reported..] {
                    monitor_events.record_resource(sample.cpu_usage, sample.memory_mb);
                }
                reported = monitor.get_samples().len();
                thread::sleep(MONITOR_SAMPLE_INTERVAL);
            }
            monitor
        });

        let mut running_count = 0;

        // Error captured inside the loop. We break out on failure instead of
        // returning early so the monitor thread is always stopped and joined
        // below (an early `?` would leak the detached sampling thread).
        let mut run_error: Option<Box<dyn std::error::Error>> = None;
        // The first step that failed in a keep-going run.
        let mut first_failure: Option<String> = None;

        // Main execution loop
        loop {
            // A termination signal is being handled: start nothing new. The
            // running steps are being killed and are collected below. Without
            // this a keep-going run would hand the next independent steps to
            // workers, which only report them as failed.
            if is_shutting_down() {
                run_error = Some("Workflow stopped by a termination signal".into());
                break;
            }

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
                    started.insert(step.id.clone());
                    self.events.emit(Event::StepStarted {
                        step: step.id.clone(),
                        attempt: 1,
                        max_attempts: step.retries.saturating_add(1),
                    });
                    timeline.add_event(step.id.clone(), EventType::Started);
                    planner.mark_step_running(&step.id);

                    if self.dry_run {
                        // Dry run output
                        println!();
                        println!("[DRY RUN] Step: {}", step.id);
                        println!("  Tool: {}", step.tool);
                        println!("  Command: {}", step.command);
                        if step.is_structured() {
                            println!("  Resolved command: {}", display_command(&step));
                        }
                        println!("  Input: {:?}", step.input);
                        println!("  Output: {:?}", step.output);
                        for (name, files) in sorted_slots(&step.named_inputs) {
                            println!("  Named input {}: {:?}", name, files);
                        }
                        for (name, files) in sorted_slots(&step.named_outputs) {
                            println!("  Named output {}: {:?}", name, files);
                        }
                        println!("  Threads: {}", step.threads);
                        if let Some(install) = &step.install {
                            println!("  Install: {}", install.describe());
                        }
                        if step.mock {
                            println!("  Mock: outputs would be created, the tool would not run");
                        }
                        match (self.fresh, stale.get(&step.id)) {
                            (true, _) => println!("  Would run: run from scratch"),
                            (false, Some(reason)) => println!("  Would run: {}", reason),
                            (false, None) => {}
                        }
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
                        self.report_completion(&step.id, 1, &Ok(()));
                        continue;
                    }

                    // Spawn worker thread
                    let tx = tx.clone();
                    let step_clone = step.clone();
                    let env_map_clone = env_map.as_map().clone();
                    let working_dir_clone = self.working_dir.clone();
                    let pause_clone = self.pause_flag_path.clone();
                    let events_clone = self.events.clone();

                    thread::spawn(move || {
                        let run = execute_step_with_events(
                            &step_clone,
                            &env_map_clone,
                            &working_dir_clone,
                            pause_clone.as_deref().map(Path::new),
                            &events_clone,
                        );
                        let mut result = run.result.map_err(|e| e.to_string());
                        let mut warnings = Vec::new();
                        if result.is_ok() {
                            let (checked, warned) =
                                apply_checks(&step_clone, &working_dir_clone, &events_clone);
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
                self.events
                    .update_tally(|t| t.check_warnings += warnings.len());
                check_warnings.extend(warnings);
                planner.record_attempts(&step_id, attempts);
                state.record_attempts(&step_id, attempts);
                self.report_completion(&step_id, attempts, &result);

                match result {
                    Ok(()) => {
                        info!("Step '{}' completed successfully", step_id);
                        planner.mark_step_completed(&step_id);
                        timeline.add_event(step_id.clone(), EventType::Completed);
                        // A mocked step made placeholders, and a step after it
                        // consumed them: neither may be remembered as done, or a
                        // later real run could skip it.
                        if !self.rests_on_mock(&step_id) {
                            state.mark_completed(&step_id);
                            record_definition(&mut state, &definitions, &step_id);
                        }
                        // A success must not hide an earlier failure of this run.
                        if let Some(failed) = &first_failure {
                            state.mark_failed(failed);
                        }
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

                        if keep_going {
                            // Only this step's downstream is off the table;
                            // everything else keeps being scheduled.
                            self.report_blocked(&planner, &mut not_run);
                            // The state names the run's first failure.
                            let first = first_failure.get_or_insert_with(|| step_id.clone());
                            if *first != step_id {
                                state.mark_failed(first);
                                if let Err(save_err) = state.save() {
                                    warn!("Failed to persist state: {}", save_err);
                                }
                            }
                            continue;
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
                self.events
                    .update_tally(|t| t.check_warnings += done.warnings.len());
                check_warnings.extend(done.warnings);
                planner.record_attempts(&done.step_id, done.attempts);
                state.record_attempts(&done.step_id, done.attempts);
                self.report_completion(&done.step_id, done.attempts, &done.result);
                match done.result {
                    Ok(()) => {
                        info!("Step '{}' completed successfully", done.step_id);
                        planner.mark_step_completed(&done.step_id);
                        timeline.add_event(done.step_id.clone(), EventType::Completed);
                        if !self.rests_on_mock(&done.step_id) {
                            state.mark_completed(&done.step_id);
                            record_definition(&mut state, &definitions, &done.step_id);
                        }
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

        // A keep-going run ends once the independent branches are done; report
        // what failed and what was never reached.
        if run_error.is_none() && keep_going && first_failure.is_some() {
            let failed = planner.failed_steps();
            let blocked = planner.blocked_steps();
            let mut skipped: Vec<&str> = self
                .workflow
                .steps
                .iter()
                .filter(|s| blocked.contains_key(&s.id))
                .map(|s| s.id.as_str())
                .collect();
            skipped.sort_unstable();
            let mut message = format!(
                "Workflow failed: {} step(s) failed ({})",
                failed.len(),
                failed.join(", ")
            );
            if !skipped.is_empty() {
                message.push_str(&format!(
                    "; {} step(s) not run because a step they depend on failed ({})",
                    skipped.len(),
                    skipped.join(", ")
                ));
            }
            error!("{}", message);
            run_error = Some(message.into());
        }

        // Steps that never started because the run stopped early.
        if run_error.is_some() {
            let reason = match &state.failed_step {
                Some(failed) => format!("not run: the workflow stopped at step '{}'", failed),
                None => "not run: the workflow stopped early".to_string(),
            };
            for step in &self.workflow.steps {
                if !started.contains(&step.id) && !not_run.contains(&step.id) {
                    self.events.emit(Event::StepSkipped {
                        step: step.id.clone(),
                        reason: reason.clone(),
                    });
                    self.events.update_tally(|t| t.skipped += 1);
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
        if let Some(summary) = format_mock_summary(&self.workflow, self.dry_run) {
            println!("{}", summary);
            println!();
        }
        println!("{}", final_monitor.get_summary());

        Ok(())
    }

    /// Reports the steps a failure has made unreachable (keep-going mode) as
    /// skipped, once each, as soon as they are known.
    fn report_blocked(&self, planner: &ExecutionPlanner, reported: &mut HashSet<String>) {
        let blocked = planner.blocked_steps();
        for step in &self.workflow.steps {
            let Some(culprit) = blocked.get(&step.id) else {
                continue;
            };
            if !reported.insert(step.id.clone()) {
                continue;
            }
            warn!(
                "Step '{}' will not run: step '{}' failed and it depends on it",
                step.id, culprit
            );
            self.events.emit(Event::StepSkipped {
                step: step.id.clone(),
                reason: format!("not run: step '{}' failed", culprit),
            });
            self.events.update_tally(|t| t.skipped += 1);
        }
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
            // A mocked step never starts its tool, so it needs no environment.
            .filter(|step| !step.mock)
            // A step with an `install` block is set up from it, not from its tool name.
            .filter(|step| step.install.is_none())
            .map(|step| step.tool.as_str())
            .filter(|tool| !is_system_tool(tool))
            .collect();
        let mut tools: Vec<String> = tools.into_iter().map(String::from).collect();
        tools.sort();
        tools
    }

    /// The distinct `install` blocks of the steps that will really run, in
    /// order of first use. A mocked step never starts its tool.
    pub(crate) fn installs_required(&self) -> Vec<Install> {
        let mut installs: Vec<Install> = Vec::new();
        for step in self.workflow.steps.iter().filter(|s| !s.mock) {
            if let Some(install) = &step.install {
                if !installs.contains(install) {
                    installs.push(install.clone());
                }
            }
        }
        installs
    }

    /// Makes every `install` block usable before any step starts: creates the
    /// pinned conda environments, downloads and verifies external tools, and
    /// checks that system tools exist. Unlike the environment setup for plain
    /// tools, a failure here stops the run: the step could not work.
    fn setup_installs(&self) -> Result<(), Box<dyn std::error::Error>> {
        let platform = current_platform();
        for install in self.installs_required() {
            info!("Preparing tool: {}", install.describe());
            match &install {
                Install::Conda { .. } => {
                    let (Some(name), Some(spec)) =
                        (install.conda_env_name(platform), install.conda_spec())
                    else {
                        continue;
                    };
                    create_env_with(
                        &name,
                        &[spec],
                        &install.conda_channels(),
                        install.conda_subdir(platform),
                    )?;
                }
                Install::External { binary, .. } => {
                    install
                        .ensure_external(&tools_root(), platform)
                        .map_err(|e| format!("Could not install '{}': {}", binary, e))?;
                }
                Install::System { binary } => {
                    if find_on_path(binary).is_none() {
                        return Err(format!(
                            "'{}' was not found on this computer. Install it and make sure it is on your PATH, then run again.",
                            binary
                        )
                        .into());
                    }
                }
            }
        }
        Ok(())
    }

    /// Sets up conda environments for all tools in the workflow.
    ///
    /// For each unique tool in the workflow:
    /// 1. Skips system tools (bash, cat, etc.)
    /// 2. Checks if tool is already in env_map
    /// 3. Creates a new conda environment if needed
    /// 4. Updates env_map with the new mapping
    fn setup_environments(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.setup_installs()?;
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

            match create_env(&env_name, std::slice::from_ref(tool)) {
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
        let (result, warnings) = apply_checks(
            &step,
            &Some(dir.path().to_path_buf()),
            &EventSink::disabled(),
        );
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

    /// `kg_bad` fails at once while `kg_ok` is still running; `kg_after`
    /// depends on the failure and `kg_ok2` on the slow, healthy step.
    fn keep_going_workflow(prefix: &str) -> Workflow {
        let bad = format!("{prefix}_bad");
        let after = format!("{prefix}_after");
        let ok = format!("{prefix}_ok");
        let ok2 = format!("{prefix}_ok2");
        Workflow::from_steps(vec![
            Step::new(bad.as_str(), "bash", "exit 1"),
            Step::new(after.as_str(), "bash", "touch after.txt")
                .with_output("after.txt")
                .depends_on(bad.as_str()),
            Step::new(ok.as_str(), "bash", "sleep 1; touch ok.txt").with_output("ok.txt"),
            Step::new(ok2.as_str(), "bash", "touch ok2.txt")
                .with_output("ok2.txt")
                .depends_on(ok.as_str()),
        ])
    }

    #[test]
    fn test_without_keep_going_the_independent_branch_is_not_continued() {
        let (result, dir) = run_in_tempdir(keep_going_workflow("nokg"));
        assert!(result
            .unwrap_err()
            .contains("Workflow failed at step 'nokg_bad'"));
        // The running sibling is waited for, but nothing new is started.
        assert!(dir.path().join("ok.txt").exists());
        assert!(!dir.path().join("ok2.txt").exists());
    }

    #[test]
    fn test_keep_going_runs_independent_branch_and_skips_only_downstream() {
        let dir = tempdir().unwrap();
        let wf = keep_going_workflow("kg").with_keep_going(true);
        let (result, events) = run_with_events_in(wf, dir.path(), false);

        let err = result.unwrap_err();
        assert!(err.contains("1 step(s) failed (kg_bad)"), "{err}");
        assert!(
            err.contains("1 step(s) not run because a step they depend on failed (kg_after)"),
            "{err}"
        );
        assert!(dir.path().join("ok.txt").exists());
        assert!(
            dir.path().join("ok2.txt").exists(),
            "the independent branch must run to the end"
        );
        assert!(
            !dir.path().join("after.txt").exists(),
            "the failed step's downstream must not run"
        );

        // The state records the finished branch (a resume skips it) and the failure.
        let state = WorkflowState::load_in("wf.yaml", Some(dir.path())).unwrap();
        assert!(state.completed_steps.contains("kg_ok"));
        assert!(state.completed_steps.contains("kg_ok2"));
        assert!(!state.completed_steps.contains("kg_after"));
        assert_eq!(state.failed_step.as_deref(), Some("kg_bad"));

        let tokens = outline(&events);
        for expected in [
            "step_failed:kg_bad",
            "step_skipped:kg_after",
            "step_succeeded:kg_ok",
            "step_succeeded:kg_ok2",
        ] {
            assert!(
                tokens.iter().any(|t| t == expected),
                "{expected} in {tokens:?}"
            );
        }
        assert_eq!(tokens.last().unwrap(), "run_finished:failed");
        assert_eq!(
            tokens
                .iter()
                .filter(|t| t.starts_with("run_finished"))
                .count(),
            1
        );
        // The skipped step is announced as soon as the failure is known, so
        // before the slow independent branch finishes.
        let pos = |t: &str| tokens.iter().position(|x| x == t).unwrap();
        assert!(pos("step_skipped:kg_after") < pos("step_succeeded:kg_ok2"));
        let skipped = events
            .iter()
            .find(|e| e["event"] == "step_skipped")
            .unwrap();
        assert!(skipped["reason"].as_str().unwrap().contains("kg_bad"));

        let summary = &events.last().unwrap()["summary"];
        assert_eq!(summary["total"], 4);
        assert_eq!(summary["succeeded"], 2);
        assert_eq!(summary["failed"], 1);
        assert_eq!(summary["skipped"], 1);
        assert!(summary["error"].as_str().unwrap().contains("kg_bad"));
    }

    #[test]
    fn test_keep_going_can_be_set_on_the_engine_and_skips_whole_chains() {
        // a_bad -> mid -> leaf: both descendants are skipped, none run.
        let dir = tempdir().unwrap();
        let wf = Workflow::from_steps(vec![
            Step::new("chain_bad", "bash", "exit 1"),
            Step::new("chain_mid", "bash", "touch mid.txt")
                .with_output("mid.txt")
                .depends_on("chain_bad"),
            Step::new("chain_leaf", "bash", "touch leaf.txt")
                .with_output("leaf.txt")
                .depends_on("chain_mid"),
            Step::new("chain_free", "bash", "touch free.txt").with_output("free.txt"),
        ]);
        let mut engine = Engine::new(wf);
        engine.set_working_dir(dir.path().to_path_buf());
        engine.set_workflow_path(dir.path().join("wf.yaml").to_str().unwrap());
        engine.set_keep_going(true);
        let err = engine.run().unwrap_err().to_string();
        assert!(err.contains("(chain_leaf, chain_mid)"), "{err}");
        assert!(dir.path().join("free.txt").exists());
        assert!(!dir.path().join("mid.txt").exists());
        assert!(!dir.path().join("leaf.txt").exists());
    }

    #[test]
    fn test_keep_going_with_no_failure_succeeds() {
        let wf =
            Workflow::from_steps(vec![Step::new("kgok_a", "bash", "true")]).with_keep_going(true);
        let (result, _dir) = run_in_tempdir(wf);
        assert!(result.is_ok(), "{:?}", result);
    }

    /// A one-step workflow that logs every real execution to `runs.log`. The
    /// output path is absolute because the in-process engine does not change
    /// into the working directory the way the CLI does.
    fn counting_workflow(dir: &Path, id: Option<&str>) -> Workflow {
        let out = dir.join("id.out");
        // Step ids key the temp script file; keep concurrent tests apart.
        let tag: String = dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect();
        let step_id = format!("idc_{tag}");
        let wf = Workflow::from_steps(vec![Step::new(
            step_id.as_str(),
            "bash",
            "echo run >> runs.log; touch id.out",
        )
        .with_output(out.to_str().unwrap())]);
        match id {
            Some(id) => wf.with_metadata(crate::workflow::WorkflowMetadata::default().with_id(id)),
            None => wf,
        }
    }

    fn run_named(dir: &Path, file: &str, wf: Workflow) {
        let mut engine = Engine::new(wf);
        engine.set_working_dir(dir.to_path_buf());
        engine.set_workflow_path(dir.join(file).to_str().unwrap());
        engine.run().unwrap();
    }

    fn runs(dir: &Path) -> usize {
        fs::read_to_string(dir.join("runs.log"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    #[test]
    fn test_state_is_keyed_on_the_workflow_id_and_a_rename_keeps_history() {
        let dir = tempdir().unwrap();
        run_named(
            dir.path(),
            "before.yaml",
            counting_workflow(dir.path(), Some("wf-1234")),
        );
        assert!(dir.path().join(".rustrunner/wf-1234.state").exists());
        assert!(!dir.path().join(".rustrunner/before.state").exists());

        // Same id under another file name: the history is found, nothing re-runs.
        run_named(
            dir.path(),
            "after_rename.yaml",
            counting_workflow(dir.path(), Some("wf-1234")),
        );
        assert_eq!(runs(dir.path()), 1);

        // A different id is a different workflow, even under the same file name.
        run_named(
            dir.path(),
            "before.yaml",
            counting_workflow(dir.path(), Some("wf-9999")),
        );
        assert_eq!(
            runs(dir.path()),
            2,
            "a different id has no history: it runs"
        );
        assert!(dir.path().join(".rustrunner/wf-9999.state").exists());
    }

    #[test]
    fn test_workflow_without_id_still_uses_the_file_stem() {
        let dir = tempdir().unwrap();
        run_named(
            dir.path(),
            "plain.yaml",
            counting_workflow(dir.path(), None),
        );
        assert!(dir.path().join(".rustrunner/plain.state").exists());
        run_named(
            dir.path(),
            "plain.yaml",
            counting_workflow(dir.path(), None),
        );
        assert_eq!(runs(dir.path()), 1);
    }

    #[test]
    fn test_old_state_moves_to_the_id_when_a_workflow_gains_one() {
        let dir = tempdir().unwrap();
        run_named(
            dir.path(),
            "legacy.yaml",
            counting_workflow(dir.path(), None),
        );
        assert!(dir.path().join(".rustrunner/legacy.state").exists());

        run_named(
            dir.path(),
            "legacy.yaml",
            counting_workflow(dir.path(), Some("wf-new")),
        );
        assert_eq!(runs(dir.path()), 1, "the old history must be resumed");
        assert!(dir.path().join(".rustrunner/wf-new.state").exists());
        assert!(
            !dir.path().join(".rustrunner/legacy.state").exists(),
            "the old file is moved, not copied"
        );
    }

    #[test]
    fn test_dry_run_does_not_migrate_the_old_state() {
        let dir = tempdir().unwrap();
        run_named(
            dir.path(),
            "legacy.yaml",
            counting_workflow(dir.path(), None),
        );

        let mut engine = Engine::new(counting_workflow(dir.path(), Some("wf-dry")));
        engine.set_working_dir(dir.path().to_path_buf());
        engine.set_workflow_path(dir.path().join("legacy.yaml").to_str().unwrap());
        engine.set_dry_run(true);
        engine.run().unwrap();
        assert!(dir.path().join(".rustrunner/legacy.state").exists());
        assert!(!dir.path().join(".rustrunner/wf-dry.state").exists());
    }

    /// Regression: a stale step was forgotten only in memory, and the state
    /// file still listed it as finished (with its old hash) until the first
    /// step of the new run ended. A run stopped while the stale step was
    /// rewriting its outputs then left partial outputs that looked current.
    #[test]
    fn test_a_stale_step_is_forgotten_on_disk_before_it_runs() {
        let dir = tempdir().unwrap();
        let out = dir.path().join("p.out");
        let workflow = |command: &str| {
            Workflow::from_steps(vec![
                Step::new("persist_inval", "bash", command).with_output(out.to_str().unwrap())
            ])
            .with_metadata(crate::workflow::WorkflowMetadata::default().with_id("wf-persist"))
        };
        run_named(dir.path(), "p.yaml", workflow("touch p.out"));

        // The edited command copies the state file as it is while it runs.
        run_named(
            dir.path(),
            "p.yaml",
            workflow("cp .rustrunner/wf-persist.state during.json; touch p.out"),
        );
        let during: WorkflowState =
            serde_json::from_str(&fs::read_to_string(dir.path().join("during.json")).unwrap())
                .unwrap();
        assert!(!during.completed_steps.contains("persist_inval"));
        assert!(!during.step_hashes.contains_key("persist_inval"));

        // Afterwards it is recorded as finished with the new definition.
        let after =
            WorkflowState::load_keyed("p.yaml", Some("wf-persist"), Some(dir.path())).unwrap();
        assert!(after.completed_steps.contains("persist_inval"));
        assert!(after.step_hashes.contains_key("persist_inval"));
    }

    #[test]
    fn test_fresh_run_discards_the_id_keyed_state() {
        let dir = tempdir().unwrap();
        run_named(
            dir.path(),
            "f.yaml",
            counting_workflow(dir.path(), Some("wf-fresh")),
        );
        let mut engine = Engine::new(counting_workflow(dir.path(), Some("wf-fresh")));
        engine.set_working_dir(dir.path().to_path_buf());
        engine.set_workflow_path(dir.path().join("f.yaml").to_str().unwrap());
        engine.set_fresh(true);
        engine.run().unwrap();
        assert_eq!(runs(dir.path()), 2);
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

    // ---- run events -------------------------------------------------------

    use crate::execution::events::testing::SharedBuffer;
    use serde_json::Value;

    /// Runs `workflow` in `dir` with events captured.
    fn run_with_events_in(
        workflow: Workflow,
        dir: &Path,
        dry_run: bool,
    ) -> (Result<(), String>, Vec<Value>) {
        let buf = SharedBuffer::default();
        let mut engine = Engine::new(workflow);
        engine.set_working_dir(dir.to_path_buf());
        engine.set_workflow_path(dir.join("wf.yaml").to_str().unwrap());
        engine.set_dry_run(dry_run);
        engine.set_event_sink(EventSink::to_writer(buf.clone()));
        let result = engine.run().map_err(|e| e.to_string());
        (result, buf.events())
    }

    /// One short token per event, e.g. `step_started:a:1`, to assert on order.
    fn outline(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .map(|e| {
                let name = e["event"].as_str().unwrap();
                let step = e["step"].as_str().unwrap_or("");
                match name {
                    "step_started" | "step_retrying" => {
                        format!("{}:{}:{}", name, step, e["attempt"])
                    }
                    "run_finished" => format!("{}:{}", name, e["status"].as_str().unwrap()),
                    _ => format!("{}:{}", name, step)
                        .trim_end_matches(':')
                        .to_string(),
                }
            })
            .collect()
    }

    #[test]
    fn test_events_for_a_successful_run_are_ordered() {
        let dir = tempdir().unwrap();
        let wf =
            two_step_workflow(Step::new("ev_ok", "bash", "echo up > up.txt").with_output("up.txt"))
                .with_metadata(crate::workflow::WorkflowMetadata::new(Some("Demo"), None));
        let (result, events) = run_with_events_in(wf, dir.path(), false);
        result.unwrap();

        assert_eq!(
            outline(&events),
            [
                "run_started",
                "step_started:ev_ok:1",
                "step_succeeded:ev_ok",
                "step_started:ev_ok_down:1",
                "step_succeeded:ev_ok_down",
                "run_finished:succeeded",
            ]
        );
        assert!(events.iter().all(|e| e["v"] == 1));
        assert_eq!(events[0]["workflow"], "Demo");
        assert_eq!(
            events[0]["steps"],
            serde_json::json!(["ev_ok", "ev_ok_down"])
        );
        assert_eq!(events[0]["dry_run"], false);
        assert!(!events[0]["run_id"].as_str().unwrap().is_empty());
        let summary = &events[5]["summary"];
        assert_eq!(summary["total"], 2);
        assert_eq!(summary["succeeded"], 2);
        assert_eq!(summary["failed"], 0);
        assert_eq!(summary["skipped"], 0);
    }

    #[test]
    fn test_events_for_a_retried_step() {
        let dir = tempdir().unwrap();
        // Fails until the marker file exists, which the first attempt creates.
        let wf = Workflow::from_steps(vec![Step::new(
            "ev_retry",
            "bash",
            "if [ -f marker ]; then exit 0; fi; touch marker; exit 3",
        )
        .with_retries(2)
        .with_retry_backoff(crate::workflow::RetryBackoff::Fixed, 0)]);
        let (result, events) = run_with_events_in(wf, dir.path(), false);
        result.unwrap();

        assert_eq!(
            outline(&events),
            [
                "run_started",
                "step_started:ev_retry:1",
                "step_retrying:ev_retry:1",
                "step_started:ev_retry:2",
                "step_succeeded:ev_retry",
                "run_finished:succeeded",
            ]
        );
        assert_eq!(events[1]["max_attempts"], 3);
        assert_eq!(events[2]["max_attempts"], 3);
        assert_eq!(events[2]["delay_secs"], 0);
        assert!(events[2]["reason"].as_str().unwrap().contains("failed"));
        assert_eq!(events[4]["attempts"], 2);
        assert_eq!(events[5]["summary"]["retried"], 1);
    }

    #[test]
    fn test_events_for_a_step_that_exhausts_its_retries() {
        let dir = tempdir().unwrap();
        let wf = Workflow::from_steps(vec![Step::new("ev_giveup", "bash", "exit 1")
            .with_retries(1)
            .with_retry_backoff(crate::workflow::RetryBackoff::Fixed, 0)]);
        let (result, events) = run_with_events_in(wf, dir.path(), false);
        assert!(result.is_err());

        assert_eq!(
            outline(&events),
            [
                "run_started",
                "step_started:ev_giveup:1",
                "step_retrying:ev_giveup:1",
                "step_started:ev_giveup:2",
                "step_failed:ev_giveup",
                "run_finished:failed",
            ]
        );
        assert_eq!(events[4]["attempts"], 2);
        assert!(events[4]["reason"].as_str().unwrap().contains("Gave up"));
        let summary = &events[5]["summary"];
        assert_eq!(summary["failed"], 1);
        assert!(summary["error"]
            .as_str()
            .unwrap()
            .contains("Workflow failed at step 'ev_giveup'"));
    }

    #[test]
    fn test_events_for_a_blocking_check_failure() {
        let dir = tempdir().unwrap();
        let wf = two_step_workflow(
            Step::new("ev_chk", "bash", "touch empty.txt")
                .with_output("empty.txt")
                .with_retries(2)
                .with_check(OutputCheck::new(CheckKind::NonEmpty)),
        );
        let (result, events) = run_with_events_in(wf, dir.path(), false);
        assert!(result.is_err());

        // The tool ran once (no retry for a check), the check is reported
        // before the step fails, and the downstream step is skipped.
        assert_eq!(
            outline(&events),
            [
                "run_started",
                "step_started:ev_chk:1",
                "check_failed:ev_chk",
                "step_failed:ev_chk",
                "step_skipped:ev_chk_down",
                "run_finished:failed",
            ]
        );
        assert_eq!(events[2]["kind"], "non_empty");
        assert_eq!(events[2]["blocking"], true);
        assert!(events[2]["message"].as_str().unwrap().contains("is empty"));
        assert!(events[3]["reason"]
            .as_str()
            .unwrap()
            .contains("output check failed"));
        assert!(events[4]["reason"].as_str().unwrap().contains("ev_chk"));
        let summary = &events[5]["summary"];
        assert_eq!(summary["failed"], 1);
        assert_eq!(summary["skipped"], 1);
        assert_eq!(summary["retried"], 0);
    }

    #[test]
    fn test_events_for_a_non_blocking_check_failure() {
        let dir = tempdir().unwrap();
        let wf = Workflow::from_steps(vec![Step::new("ev_warn", "bash", "echo one > few.txt")
            .with_output("few.txt")
            .with_check(OutputCheck::min_lines(5).non_blocking())]);
        let (result, events) = run_with_events_in(wf, dir.path(), false);
        result.unwrap();

        assert_eq!(
            outline(&events),
            [
                "run_started",
                "step_started:ev_warn:1",
                "check_failed:ev_warn",
                "step_succeeded:ev_warn",
                "run_finished:succeeded",
            ]
        );
        assert_eq!(events[2]["kind"], "min_lines");
        assert_eq!(events[2]["blocking"], false);
        assert_eq!(events[4]["summary"]["check_warnings"], 1);
    }

    #[test]
    fn test_events_for_a_dry_run() {
        let dir = tempdir().unwrap();
        let wf = Workflow::from_steps(vec![Step::new("ev_dry", "bash", "echo hi")]);
        let (result, events) = run_with_events_in(wf, dir.path(), true);
        result.unwrap();
        assert_eq!(
            outline(&events),
            [
                "run_started",
                "step_started:ev_dry:1",
                "step_succeeded:ev_dry",
                "run_finished:succeeded",
            ]
        );
        assert_eq!(events[0]["dry_run"], true);
    }

    #[test]
    fn test_no_events_without_a_sink() {
        // The default sink is disabled; the run behaves as before.
        let dir = tempdir().unwrap();
        let wf = Workflow::from_steps(vec![Step::new("ev_none", "bash", "echo hi")]);
        let (result, _dir) = {
            let mut engine = Engine::new(wf);
            engine.set_working_dir(dir.path().to_path_buf());
            engine.set_workflow_path(dir.path().join("wf.yaml").to_str().unwrap());
            (engine.run().map_err(|e| e.to_string()), ())
        };
        result.unwrap();
    }

    // ---- run report -------------------------------------------------------

    use crate::execution::report::{read_index, RUNS_DIR};

    /// The single run directory under `dir`, and its `run.json`.
    fn only_run(dir: &Path) -> (PathBuf, Value) {
        let index = read_index(&dir.join(RUNS_DIR));
        assert_eq!(index.len(), 1, "{:?}", index);
        let run_dir = dir.join(RUNS_DIR).join(&index[0].run_id);
        let json = fs::read_to_string(run_dir.join("run.json")).unwrap();
        (run_dir, serde_json::from_str(&json).unwrap())
    }

    #[test]
    fn test_a_real_run_writes_a_report_and_names_it_in_run_finished() {
        let dir = tempdir().unwrap();
        let up = Step::new("rep_up", "bash", "echo up > up.txt")
            .with_output("up.txt")
            .with_check(OutputCheck::new(CheckKind::Exists));
        let (result, events) = run_with_events_in(two_step_workflow(up), dir.path(), false);
        result.unwrap();

        let (run_dir, run) = only_run(dir.path());
        let report = run_dir.join("report.html");
        assert!(report.is_file());
        let finished = events.last().unwrap();
        assert_eq!(finished["event"], "run_finished");
        let reported = PathBuf::from(finished["report"].as_str().unwrap());
        assert!(reported.is_absolute());
        assert_eq!(
            reported.canonicalize().unwrap(),
            report.canonicalize().unwrap()
        );

        // The record agrees with the events and the totals.
        assert_eq!(run["status"], "succeeded");
        assert_eq!(run["run_id"], events[0]["run_id"]);
        assert_eq!(run["summary"], finished["summary"]);
        assert_eq!(run["steps"].as_array().unwrap().len(), 2);
        assert_eq!(run["steps"][0]["id"], "rep_up");
        assert_eq!(run["steps"][0]["status"], "succeeded");
        assert_eq!(run["steps"][0]["attempts"], 1);
        assert_eq!(run["steps"][0]["checks"][0]["passed"], true);
        assert_eq!(run["steps"][1]["depends_on"][0], "rep_up");

        let html = fs::read_to_string(report).unwrap();
        assert!(html.contains("rep_up") && html.contains("rep_up_down"));
    }

    #[test]
    fn test_a_dry_run_writes_no_report() {
        let dir = tempdir().unwrap();
        let wf = Workflow::from_steps(vec![Step::new("rep_dry", "bash", "echo hi")]);
        let (result, events) = run_with_events_in(wf, dir.path(), true);
        result.unwrap();
        assert!(!dir.path().join(RUNS_DIR).exists());
        assert!(!dir.path().join(".rustrunner").exists());
        assert!(events.last().unwrap().get("report").is_none());
    }

    #[test]
    fn test_a_failed_run_reports_the_failure_with_its_stderr_tail() {
        let dir = tempdir().unwrap();
        let bad = Step::new("rep_bad", "bash", "echo 'disk on fire' >&2; exit 3");
        let (result, events) = run_with_events_in(two_step_workflow(bad), dir.path(), false);
        assert!(result.is_err());

        let (_, run) = only_run(dir.path());
        assert_eq!(run["status"], "failed");
        assert_eq!(run["steps"][0]["status"], "failed");
        assert_eq!(run["steps"][0]["stderr_tail"], "disk on fire");
        assert!(run["steps"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("rep_bad"));
        assert_eq!(run["steps"][1]["status"], "skipped");
        assert!(run["steps"][1]["reason"]
            .as_str()
            .unwrap()
            .contains("rep_bad"));
        assert!(run["summary"]["error"]
            .as_str()
            .unwrap()
            .contains("rep_bad"));
        assert!(events.last().unwrap()["report"].is_string());
    }

    #[test]
    fn test_a_report_is_written_without_a_listener_and_escapes_step_names() {
        let dir = tempdir().unwrap();
        let evil = "<script>alert(1)</script>";
        let wf = Workflow::from_steps(vec![Step::new(evil, "bash", "echo '<b>x</b>' >&2; exit 1")])
            .with_metadata(crate::workflow::WorkflowMetadata::new(Some(evil), None));
        let mut engine = Engine::new(wf);
        engine.set_working_dir(dir.path().to_path_buf());
        engine.set_workflow_path(dir.path().join("wf.yaml").to_str().unwrap());
        assert!(engine.run().is_err());

        let (run_dir, _) = only_run(dir.path());
        let html = fs::read_to_string(run_dir.join("report.html")).unwrap();
        assert!(
            !html.contains("<script"),
            "unescaped step name in the report"
        );
        assert!(!html.contains("<b>x</b>"));
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
    }

    #[test]
    fn test_runs_are_listed_newest_first() {
        let dir = tempdir().unwrap();
        for n in 0..2 {
            let wf = Workflow::from_steps(vec![Step::new(format!("rep_hist{n}"), "bash", "true")]);
            // The run id has one-second resolution plus the process id, so a
            // second run in this process would reuse it; wait it out.
            std::thread::sleep(Duration::from_millis(1100));
            let (result, _) = run_with_events_in(wf, dir.path(), false);
            result.unwrap();
        }
        let index = read_index(&dir.path().join(RUNS_DIR));
        assert_eq!(index.len(), 2);
        assert!(index[0].started_at >= index[1].started_at);
        assert_ne!(index[0].run_id, index[1].run_id);
    }

    // ---- mocked steps -----------------------------------------------------

    /// `up` (optionally mocked) writes `mock_<tag>/up.txt` and a `<tag>.ran`
    /// marker when its tool really runs; `down` always runs for real.
    fn mock_workflow(tag: &str, mocked: bool) -> Workflow {
        let up = format!("mk_{tag}_up");
        let down = format!("mk_{tag}_down");
        let mut wf = Workflow::from_steps(vec![
            Step::new(
                up.as_str(),
                "bash",
                format!("touch {tag}.ran; echo real > up.txt; mkdir -p {tag}_dir"),
            )
            .with_outputs(vec!["up.txt".to_string(), format!("{tag}_dir/")])
            .with_mock(mocked),
            Step::new(
                down.as_str(),
                "bash",
                format!("touch {tag}.down.ran; echo d > down.txt"),
            )
            .with_output("down.txt")
            .depends_on(up.as_str()),
        ]);
        wf.steps[0].next.push(down);
        wf
    }

    fn state_in(dir: &Path) -> WorkflowState {
        WorkflowState::load_in(dir.join("wf.yaml").to_str().unwrap(), Some(dir)).unwrap()
    }

    #[test]
    fn test_mocked_step_creates_outputs_and_does_not_run_the_tool() {
        let dir = tempdir().unwrap();
        let (result, events) = run_with_events_in(mock_workflow("m1", true), dir.path(), false);
        result.unwrap();

        // The tool did not run, the declared outputs exist: a file and a directory.
        assert!(!dir.path().join("m1.ran").exists());
        assert_eq!(fs::metadata(dir.path().join("up.txt")).unwrap().len(), 0);
        assert!(dir.path().join("m1_dir").is_dir());
        // The step after it ran for real.
        assert!(dir.path().join("m1.down.ran").exists());

        let up = events
            .iter()
            .find(|e| e["event"] == "step_succeeded" && e["step"] == "mk_m1_up")
            .unwrap();
        assert_eq!(up["mocked"], true);
        let down = events
            .iter()
            .find(|e| e["event"] == "step_succeeded" && e["step"] == "mk_m1_down")
            .unwrap();
        assert!(down.get("mocked").is_none(), "{down}");
        let finished = events.last().unwrap();
        assert_eq!(finished["summary"]["mocked"], 1);
        assert_eq!(finished["summary"]["succeeded"], 2);
    }

    #[test]
    fn test_mocked_step_keeps_the_content_of_an_existing_output() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("up.txt"), "precious\n").unwrap();
        let (result, _) = run_with_events_in(mock_workflow("m2", true), dir.path(), false);
        result.unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("up.txt")).unwrap(),
            "precious\n"
        );
    }

    #[test]
    fn test_mocked_step_never_records_freshness_so_a_real_run_reruns_it() {
        let dir = tempdir().unwrap();
        let (result, _) = run_with_events_in(mock_workflow("m3", true), dir.path(), false);
        result.unwrap();

        // Nothing about the mocked step is remembered.
        let state = state_in(dir.path());
        assert!(!state.completed_steps.contains("mk_m3_up"));
        assert!(!state.step_hashes.contains_key("mk_m3_up"));
        // The real step after it ran on placeholder inputs, so its result is
        // not remembered either (see the test below for why).
        assert!(!state.completed_steps.contains("mk_m3_down"));
        assert!(!state.step_hashes.contains_key("mk_m3_down"));

        // The same workflow, no longer mocked: the tool runs now even though
        // the placeholder outputs exist, and so does everything downstream.
        fs::remove_file(dir.path().join("m3.down.ran")).unwrap();
        let (result, events) = run_with_events_in(mock_workflow("m3", false), dir.path(), false);
        result.unwrap();
        assert!(dir.path().join("m3.ran").exists(), "tool must really run");
        assert_eq!(
            fs::read_to_string(dir.path().join("up.txt"))
                .unwrap()
                .trim(),
            "real"
        );
        assert!(dir.path().join("m3.down.ran").exists());
        assert!(events.iter().all(|e| e["event"] != "step_skipped"));
        let state = state_in(dir.path());
        assert!(state.completed_steps.contains("mk_m3_up"));
        assert!(state.step_hashes.contains_key("mk_m3_up"));
        // Once everything ran for real, the downstream step is remembered too.
        assert!(state.completed_steps.contains("mk_m3_down"));
        assert!(state.step_hashes.contains_key("mk_m3_down"));
    }

    #[test]
    fn test_a_step_that_ran_on_mocked_inputs_is_never_up_to_date() {
        let dir = tempdir().unwrap();
        // up (mocked) -> down -> after: down and after consume placeholders,
        // directly and through down.
        let mut wf = mock_workflow("m7", true);
        let after = Step::new(
            "mk_m7_after",
            "bash",
            "touch m7.after.ran; echo a > after.txt",
        )
        .with_output("after.txt")
        .depends_on("mk_m7_down");
        wf.steps[1].next.push("mk_m7_after".to_string());
        wf.steps.push(after);
        let (result, _) = run_with_events_in(wf, dir.path(), false);
        result.unwrap();
        assert!(dir.path().join("m7.down.ran").exists());
        assert!(dir.path().join("m7.after.ran").exists());

        let state = state_in(dir.path());
        for id in ["mk_m7_up", "mk_m7_down", "mk_m7_after"] {
            assert!(!state.completed_steps.contains(id), "{id} remembered");
            assert!(!state.step_hashes.contains_key(id), "{id} hashed");
        }

        // The mocked step is removed from the workflow altogether. The step
        // that consumed its placeholder keeps the very same definition and its
        // output exists, but its result came from a placeholder, so it must
        // run again rather than be skipped as up to date.
        fs::remove_file(dir.path().join("m7.down.ran")).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let down_only = Workflow::from_steps(vec![Step::new(
            "mk_m7_down",
            "bash",
            "touch m7.down.ran; echo d > down.txt",
        )
        .with_output("down.txt")]);
        let (result, events) = run_with_events_in(down_only, dir.path(), false);
        result.unwrap();
        assert!(dir.path().join("m7.down.ran").exists(), "must re-run");
        assert!(events.iter().all(|e| e["event"] != "step_skipped"));
    }

    #[test]
    fn test_mocking_a_step_that_ran_for_real_forgets_its_freshness() {
        let dir = tempdir().unwrap();
        let (result, _) = run_with_events_in(mock_workflow("m4", false), dir.path(), false);
        result.unwrap();
        assert!(state_in(dir.path()).step_hashes.contains_key("mk_m4_up"));

        let (result, _) = run_with_events_in(mock_workflow("m4", true), dir.path(), false);
        result.unwrap();
        let state = state_in(dir.path());
        assert!(!state.completed_steps.contains("mk_m4_up"));
        assert!(!state.step_hashes.contains_key("mk_m4_up"));

        // Back to real: it runs again, it is not skipped as up to date.
        fs::remove_file(dir.path().join("m4.ran")).unwrap();
        let (result, _) = run_with_events_in(mock_workflow("m4", false), dir.path(), false);
        result.unwrap();
        assert!(dir.path().join("m4.ran").exists());
    }

    #[test]
    fn test_mocked_step_is_never_skipped_as_up_to_date() {
        let dir = tempdir().unwrap();
        for _ in 0..2 {
            let (result, events) = run_with_events_in(mock_workflow("m5", true), dir.path(), false);
            result.unwrap();
            assert!(events
                .iter()
                .all(|e| !(e["event"] == "step_skipped" && e["step"] == "mk_m5_up")));
            std::thread::sleep(Duration::from_millis(1100));
        }
    }

    #[test]
    fn test_mocked_step_skips_content_checks_but_runs_exists() {
        let dir = tempdir().unwrap();
        let mut wf = mock_workflow("m6", true);
        wf.steps[0].checks = vec![
            OutputCheck::new(CheckKind::Exists),
            OutputCheck::new(CheckKind::NonEmpty),
            OutputCheck::min_lines(5),
        ];
        let (result, events) = run_with_events_in(wf, dir.path(), false);
        result.unwrap();
        assert!(events.iter().all(|e| e["event"] != "check_failed"));

        let (run_dir, json) = only_run(dir.path());
        let up = json["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == "mk_m6_up")
            .unwrap();
        assert_eq!(up["mocked"], true);
        let checks = up["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 3);
        assert!(checks[0].get("skipped").is_none());
        assert_eq!(checks[1]["skipped"], true);
        assert_eq!(checks[2]["skipped"], true);
        let html = fs::read_to_string(run_dir.join("report.html")).unwrap();
        assert!(html.contains("MOCKED"));
        assert!(html.contains("skipped"));
    }

    #[test]
    fn test_mocked_step_fails_when_an_output_cannot_be_created() {
        // The check names an output the mock cannot create: its parent is a file.
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("blocker"), "x").unwrap();
        let wf = Workflow::from_steps(vec![Step::new("mk_m7_up", "bash", "true")
            .with_output("blocker/out.txt")
            .with_mock(true)]);
        let (result, _) = run_with_events_in(wf, dir.path(), false);
        assert!(result.is_err());
    }

    #[test]
    fn test_dry_run_of_a_mocked_step_creates_nothing() {
        let dir = tempdir().unwrap();
        let (result, events) = run_with_events_in(mock_workflow("m8", true), dir.path(), true);
        result.unwrap();
        assert!(!dir.path().join("up.txt").exists());
        assert!(!dir.path().join("m8_dir").exists());
        assert!(events.last().unwrap()["summary"]["succeeded"] == 2);
    }

    #[test]
    fn test_steps_with_install_are_set_up_from_it_not_from_the_tool_name() {
        let pinned = Install::Conda {
            package: "samtools".into(),
            version: Some("1.24".into()),
            channel: None,
            osx64: false,
        };
        let steps = vec![
            Step::new("a", "samtools", "samtools view x").with_install(pinned.clone()),
            Step::new("b", "samtools", "samtools sort x").with_install(pinned.clone()),
            Step::new("c", "bowtie2", "bowtie2 x"),
            Step::new("d", "samtools", "samtools flagstat x")
                .with_install(pinned.clone())
                .with_mock(true),
            Step::new("e", "minimap2", "minimap2 x").with_install(Install::System {
                binary: "minimap2".into(),
            }),
        ];
        let engine = Engine::new(Workflow::from_steps(steps));
        // Only the step without an install block uses the old tool-name path.
        assert_eq!(engine.tools_requiring_environments(), ["bowtie2"]);
        // Equal blocks are set up once; a mocked step needs nothing.
        let installs = engine.installs_required();
        assert_eq!(installs.len(), 2);
        assert_eq!(installs[0], pinned);
    }

    #[test]
    fn test_a_mocked_step_needs_no_conda_environment() {
        let wf = Workflow::from_steps(vec![
            Step::new("mk_env_a", "samtools", "samtools view x").with_mock(true),
            Step::new("mk_env_b", "bowtie2", "bowtie2 x"),
        ]);
        let engine = Engine::new(wf);
        assert_eq!(engine.tools_requiring_environments(), ["bowtie2"]);
    }

    #[test]
    fn test_old_yaml_without_mock_loads_as_not_mocked() {
        let step: Step = serde_yaml::from_str("id: a\ntool: bash\ncommand: echo hi\n").unwrap();
        assert!(!step.mock);
        let text = serde_yaml::to_string(&step).unwrap();
        assert!(!text.contains("mock"), "{text}");
        let step: Step =
            serde_yaml::from_str("id: a\ntool: bash\ncommand: echo hi\nmock: true\n").unwrap();
        assert!(step.mock);
    }
}
