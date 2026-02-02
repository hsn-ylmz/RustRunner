//! Workflow Execution Engine
//!
//! The core engine that orchestrates workflow execution including:
//! - Parallel step scheduling with dependency resolution
//! - Resource monitoring
//! - Pause/resume functionality via file-based signaling
//! - State persistence for crash recovery
//! - Automatic conda environment setup for tools

use std::collections::{HashMap,HashSet};
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

use super::step::execute_step;

/// Interval for checking the pause flag file.
const PAUSE_CHECK_INTERVAL: Duration = Duration::from_millis(500);

/// Interval for resource monitoring samples.
const MONITOR_SAMPLE_INTERVAL: Duration = Duration::from_millis(500);

/// System tools that don't require conda environments
const SYSTEM_TOOLS: &[&str] = &["bash", "sh", "echo", "cat", "cp", "mv", "rm", "mkdir", "sleep", "curl", "wget", "grep", "awk", "sed", "sort", "uniq", "head", "tail", "wc", "tr", "cut", "bc", "gzip", "gunzip", "tar", "zip", "unzip"];

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
    wildcard_files: Option<HashMap<String, Vec<String>>>
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
            wildcard_files: None
        }
    }

    pub fn set_wildcard_files(&mut self, files: HashMap<String, Vec<String>>) {
        self.wildcard_files = Some(files);
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

        // Load or create state
        let mut state = WorkflowState::load(&self.workflow_path).unwrap_or_else(|_| {
            info!("Starting fresh workflow execution");
            WorkflowState::new(&self.workflow_path)
        });


        // Verify completed steps still have outputs
        let steps_to_rerun: Vec<String> = self
            .workflow
            .steps
            .iter()
            .filter(|step| {
                state.completed_steps.contains(&step.id) && !step.outputs_exist()
            })
            .map(|step| {
                info!(
                    "Step '{}' outputs missing - scheduling rerun",
                    step.id
                );
                step.id.clone()
            })
            .collect();

        for step_id in steps_to_rerun {
            state.completed_steps.remove(&step_id);
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
                self.wildcard_files.clone(),  // Pass wildcards
            )?
        } else {
            ExecutionPlanner::new(
                self.workflow.clone(),
                self.dry_run,
                self.max_parallel,
                self.wildcard_files.clone(),  // Pass wildcards
            )?
        };

        // Load environment mappings
        let env_map = ToolEnvMap::load();

        // Create channel for step completion
        let (tx, rx): (
            Sender<(String, Result<(), String>)>,
            Receiver<(String, Result<(), String>)>,
        ) = channel();

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

                        timeline.add_event(step.id.clone(), EventType::Completed);
                        planner.mark_step_completed(&step.id);
                        continue;
                    }

                    // Spawn worker thread
                    let tx = tx.clone();
                    let step_clone = step.clone();
                    let env_map_clone = env_map.as_map().clone();
                    let working_dir_clone = self.working_dir.clone();

                    thread::spawn(move || {
                        let result = execute_step(&step_clone, &env_map_clone, &working_dir_clone)
                            .map_err(|e| e.to_string());

                        if let Err(e) = tx.send((step_clone.id.clone(), result)) {
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

            // Wait for step completion (skip in dry run)
            if running_count > 0 && !self.dry_run {
                let (step_id, result) = rx.recv().map_err(|e| {
                    format!("Failed to receive step completion: {}", e)
                })?;

                running_count -= 1;

                match result {
                    Ok(()) => {
                        info!("Step '{}' completed successfully", step_id);
                        planner.mark_step_completed(&step_id);
                        timeline.add_event(step_id.clone(), EventType::Completed);
                        state.mark_completed(&step_id);
                        state.save()?;
                    }
                    Err(e) => {
                        error!("Step '{}' failed: {}", step_id, e);
                        planner.mark_step_failed(&step_id, e.clone());
                        timeline.add_event(step_id.clone(), EventType::Failed);
                        state.mark_failed(&step_id);
                        state.save()?;

                        monitor_running.store(false, Ordering::Relaxed);
                        return Err(format!(
                            "Workflow failed at step '{}': {}",
                            step_id, e
                        )
                        .into());
                    }
                }
            }
        }

        // Stop monitoring
        monitor_running.store(false, Ordering::Relaxed);
        let final_monitor = monitor_handle
            .join()
            .map_err(|_| "Monitor thread panicked")?;

        let total_time = start_time.elapsed();

        // Print summary
        println!();
        println!("Workflow completed successfully");
        println!("Total execution time: {:.2?}", total_time);
        println!();
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

    /// Sets up conda environments for all tools in the workflow.
    ///
    /// For each unique tool in the workflow:
    /// 1. Skips system tools (bash, cat, etc.)
    /// 2. Checks if tool is already in env_map
    /// 3. Creates a new conda environment if needed
    /// 4. Updates env_map with the new mapping
    fn setup_environments(&self) -> Result<(), Box<dyn std::error::Error>> {
        // Collect unique tools from workflow
        let tools: HashSet<String> = self
            .workflow
            .steps
            .iter()
            .map(|step| step.tool.clone())
            .collect();

        // Filter out system tools
        let conda_tools: Vec<&String> = tools
            .iter()
            .filter(|tool| !SYSTEM_TOOLS.contains(&tool.as_str()))
            .collect();

        if conda_tools.is_empty() {
            info!("No conda tools required - using system tools only");
            return Ok(());
        }

        info!("Setting up environments for {} tools: {:?}", conda_tools.len(), conda_tools);

        // Load existing env_map
        let mut env_map = ToolEnvMap::load();

        for tool in conda_tools {
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
    use crate::workflow::{Step, Workflow};
    use std::fs;
    use tempfile::tempdir;

    fn create_test_workflow() -> Workflow {
        let mut workflow = Workflow::new();
        workflow.add_step(
            Step::new("step1", "bash", "echo 'test1' > output1.txt")
                .with_output("output1.txt")
        ).unwrap();
        workflow.add_step(
            Step::new("step2", "bash", "cat {input} > output2.txt")
                .with_input("output1.txt")
                .with_output("output2.txt")
                .depends_on("step1")
        ).unwrap();

        // Add next reference
        if let Some(step1) = workflow.get_step_mut("step1") {
            step1.next.push("step2".to_string());
        }

        workflow
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
    fn test_engine_wildcard_files() {
        let workflow = create_test_workflow();
        let mut engine = Engine::new(workflow);

        let mut wf = HashMap::new();
        wf.insert("sample".to_string(), vec!["s1.txt".to_string(), "s2.txt".to_string()]);
        engine.set_wildcard_files(wf.clone());

        assert!(engine.wildcard_files.is_some());
        let stored = engine.wildcard_files.unwrap();
        assert_eq!(stored.get("sample").unwrap().len(), 2);
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
        workflow.add_step(Step::new("s1", "bash", "echo hello")).unwrap();
        let mut engine = Engine::new(workflow);
        engine.set_dry_run(true);

        // workflow_path is empty, run() should set default
        assert_eq!(engine.workflow_path, "");
        let _ = engine.run();
        assert_eq!(engine.workflow_path, "workflow.yaml");
    }

    #[test]
    fn test_setup_environments_system_tools_only() {
        let mut workflow = Workflow::new();
        workflow.add_step(
            Step::new("bash_step", "bash", "echo test")
        ).unwrap();

        let engine = Engine::new(workflow);

        // Should not error for system tools only
        let result = engine.setup_environments();
        assert!(result.is_ok());
    }
}
