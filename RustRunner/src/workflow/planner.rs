//! Execution Planner
//!
//! Manages workflow execution scheduling including:
//! - Dependency tracking
//! - Parallel job management
//! - Thread/resource allocation
//! - Step status tracking

use super::wildcards::expand_workflow_wildcards;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use log::{debug, info};
use num_cpus;

use super::model::{Step, Workflow};
use super::state::WorkflowState;

/// Status of a workflow step during execution.
#[derive(Debug, Clone, PartialEq)]
pub enum StepStatus {
    /// Step is waiting for dependencies
    Pending,
    /// Step is currently executing
    Running,
    /// Step completed successfully
    Completed,
    /// Step failed with error message
    Failed(String),
    /// Step was skipped (outputs exist)
    Skipped,
}

/// Execution metrics for a single step.
#[derive(Debug, Clone)]
pub struct StepMetrics {
    /// When the step started executing
    pub start_time: Option<Instant>,
    /// When the step finished
    pub end_time: Option<Instant>,
    /// Duration in milliseconds
    pub duration_ms: Option<u128>,
    /// Current status
    pub status: StepStatus,
}

impl StepMetrics {
    fn new() -> Self {
        Self {
            start_time: None,
            end_time: None,
            duration_ms: None,
            status: StepStatus::Pending,
        }
    }
}

/// Manages execution planning and step scheduling.
///
/// The planner tracks:
/// - Which steps have completed
/// - Which steps are currently running
/// - Resource allocation (threads)
/// - Execution metrics
pub struct ExecutionPlanner {
    /// The workflow being executed
    workflow: Workflow,
    /// Whether this is a dry run
    dry_run: bool,
    /// Steps that have completed
    completed_steps: HashSet<String>,
    /// Steps currently running
    running_steps: HashSet<String>,
    /// Maximum parallel jobs allowed
    max_parallel_jobs: usize,
    /// Metrics for each step
    step_metrics: HashMap<String, StepMetrics>,
    /// Current total threads in use
    current_threads_used: usize,
    /// Maximum system threads available
    max_system_threads: usize,
    /// Wildcard files to expand before planning
    wildcard_files: Option<HashMap<String, Vec<String>>>,
}

impl ExecutionPlanner {
    /// Creates a new execution planner for a workflow.
    ///
    /// # Arguments
    ///
    /// * `workflow` - The workflow to execute
    /// * `dry_run` - If true, steps are not actually executed
    /// * `max_parallel_jobs` - Maximum concurrent steps
    pub fn new(
        workflow: Workflow,
        dry_run: bool,
        max_parallel_jobs: usize,
        wildcard_files: Option<HashMap<String, Vec<String>>>,
    ) -> Result<Self, String> {
        let max_system_threads = num_cpus::get();

        // Expand wildcards before planning
        let mut workflow = workflow;
        if let Some(files) = &wildcard_files {
            expand_workflow_wildcards(&mut workflow, &files)?;
        }

        info!(
            "Creating planner: {} max jobs, {} system threads",
            max_parallel_jobs, max_system_threads
        );

        let mut step_metrics = HashMap::new();
        for step in &workflow.steps {
            step_metrics.insert(step.id.clone(), StepMetrics::new());
        }

        Ok(Self {
            workflow,
            dry_run,
            completed_steps: HashSet::new(),
            running_steps: HashSet::new(),
            max_parallel_jobs,
            step_metrics,
            current_threads_used: 0,
            max_system_threads,
            wildcard_files,
        })
    }

    /// Creates a planner that resumes from a previous state.
    pub fn from_state(
        workflow: Workflow,
        state: WorkflowState,
        dry_run: bool,
        max_parallel_jobs: usize,
        wildcard_files: Option<HashMap<String, Vec<String>>>,
    ) -> Result<Self, String> {
        let mut planner = Self::new(workflow, dry_run, max_parallel_jobs, wildcard_files)?;

        // Mark previously completed steps
        for step_id in &state.completed_steps {
            if planner.workflow.steps.iter().any(|s| s.id == *step_id) {
                planner.completed_steps.insert(step_id.clone());
                if let Some(metrics) = planner.step_metrics.get_mut(step_id) {
                    metrics.status = StepStatus::Skipped;
                }
                info!("Skipping previously completed step: {}", step_id);
            }
        }

        Ok(planner)
    }

    /// Returns steps that are ready to execute.
    ///
    /// A step is ready if:
    /// - It hasn't completed or started
    /// - All its dependencies are completed
    /// - Adding it wouldn't exceed resource limits
    pub fn get_ready_steps(&self) -> Vec<Step> {
        let mut ready_steps = Vec::new();
        let mut threads_to_allocate = 0;

        for step in &self.workflow.steps {
            // Skip completed or running steps
            if self.completed_steps.contains(&step.id) || self.running_steps.contains(&step.id) {
                continue;
            }

            // Check if all dependencies are completed
            let deps_complete = step.previous.is_empty()
                || step
                    .previous
                    .iter()
                    .all(|dep| self.completed_steps.contains(dep));

            if !deps_complete {
                continue;
            }

            // Check parallel job limit
            if ready_steps.len() >= self.max_parallel_jobs {
                break;
            }

            // Check thread limit
            let step_threads = step.threads;
            if self.current_threads_used + threads_to_allocate + step_threads
                > self.max_system_threads
            {
                debug!(
                    "Step '{}' needs {} threads but only {} available",
                    step.id,
                    step_threads,
                    self.max_system_threads - self.current_threads_used - threads_to_allocate
                );
                continue;
            }

            ready_steps.push(step.clone());
            threads_to_allocate += step_threads;
        }

        ready_steps
    }

    /// Marks a step as running.
    pub fn mark_step_running(&mut self, step_id: &str) {
        self.running_steps.insert(step_id.to_string());

        // Track thread usage
        if let Some(step) = self.workflow.steps.iter().find(|s| s.id == step_id) {
            self.current_threads_used += step.threads;
            debug!(
                "Step '{}' started using {} threads (total: {}/{})",
                step_id, step.threads, self.current_threads_used, self.max_system_threads
            );
        }

        if let Some(metrics) = self.step_metrics.get_mut(step_id) {
            metrics.start_time = Some(Instant::now());
            metrics.status = StepStatus::Running;
        }
    }

    /// Marks a step as completed.
    pub fn mark_step_completed(&mut self, step_id: &str) {
        self.running_steps.remove(step_id);
        self.completed_steps.insert(step_id.to_string());

        // Release thread resources
        if let Some(step) = self.workflow.steps.iter().find(|s| s.id == step_id) {
            self.current_threads_used = self.current_threads_used.saturating_sub(step.threads);
            debug!(
                "Step '{}' completed, released {} threads (total: {}/{})",
                step_id, step.threads, self.current_threads_used, self.max_system_threads
            );
        }

        if let Some(metrics) = self.step_metrics.get_mut(step_id) {
            let now = Instant::now();
            metrics.end_time = Some(now);
            if let Some(start) = metrics.start_time {
                metrics.duration_ms = Some(start.elapsed().as_millis());
            }
            metrics.status = StepStatus::Completed;
        }
    }

    /// Marks a step as failed.
    pub fn mark_step_failed(&mut self, step_id: &str, error: String) {
        self.running_steps.remove(step_id);

        // Release thread resources
        if let Some(step) = self.workflow.steps.iter().find(|s| s.id == step_id) {
            self.current_threads_used = self.current_threads_used.saturating_sub(step.threads);
        }

        if let Some(metrics) = self.step_metrics.get_mut(step_id) {
            let now = Instant::now();
            metrics.end_time = Some(now);
            if let Some(start) = metrics.start_time {
                metrics.duration_ms = Some(start.elapsed().as_millis());
            }
            metrics.status = StepStatus::Failed(error);
        }
    }

    /// Returns true if there are more steps to execute.
    pub fn has_work_remaining(&self) -> bool {
        self.completed_steps.len() < self.workflow.steps.len()
    }

    /// Returns the current progress as (completed, total).
    pub fn progress(&self) -> (usize, usize) {
        (self.completed_steps.len(), self.workflow.steps.len())
    }

    /// Returns metrics for all steps.
    pub fn get_metrics(&self) -> &HashMap<String, StepMetrics> {
        &self.step_metrics
    }

    /// Returns whether this is a dry run.
    pub fn is_dry_run(&self) -> bool {
        self.dry_run
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_workflow() -> Workflow {
        let mut workflow = Workflow::new();
        workflow.add_step(
            Step::new("step1", "bash", "echo 1")
                .with_output("out1.txt")
        ).unwrap();
        workflow.add_step(
            Step::new("step2", "bash", "echo 2")
                .with_input("out1.txt")
                .with_output("out2.txt")
                .depends_on("step1")
        ).unwrap();

        if let Some(s1) = workflow.get_step_mut("step1") {
            s1.next.push("step2".to_string());
        }

        workflow
    }

    #[test]
    fn test_planner_creation() {
        let workflow = create_test_workflow();
        let planner = ExecutionPlanner::new(workflow, false, 4, None);
        assert!(planner.is_ok());

        let planner = planner.unwrap();
        assert!(!planner.is_dry_run());
        assert_eq!(planner.progress(), (0, 2));
    }

    #[test]
    fn test_planner_dry_run() {
        let workflow = create_test_workflow();
        let planner = ExecutionPlanner::new(workflow, true, 4, None).unwrap();
        assert!(planner.is_dry_run());
    }

    #[test]
    fn test_planner_get_ready_steps() {
        let workflow = create_test_workflow();
        let planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        let ready = planner.get_ready_steps();
        // Only step1 should be ready (step2 depends on step1)
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, "step1");
    }

    #[test]
    fn test_planner_mark_running_and_completed() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        planner.mark_step_running("step1");

        let metrics = planner.get_metrics();
        assert_eq!(metrics.get("step1").unwrap().status, StepStatus::Running);

        planner.mark_step_completed("step1");

        let metrics = planner.get_metrics();
        assert_eq!(metrics.get("step1").unwrap().status, StepStatus::Completed);
        assert_eq!(planner.progress(), (1, 2));
    }

    #[test]
    fn test_planner_step2_ready_after_step1_complete() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        // step2 should NOT be ready yet
        let ready = planner.get_ready_steps();
        assert!(ready.iter().all(|s| s.id != "step2"));

        // Complete step1
        planner.mark_step_running("step1");
        planner.mark_step_completed("step1");

        // Now step2 should be ready
        let ready = planner.get_ready_steps();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, "step2");
    }

    #[test]
    fn test_planner_failed_step() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        planner.mark_step_running("step1");
        planner.mark_step_failed("step1", "Test error".to_string());

        let metrics = planner.get_metrics();
        match &metrics.get("step1").unwrap().status {
            StepStatus::Failed(msg) => assert_eq!(msg, "Test error"),
            _ => panic!("Expected Failed status"),
        }
    }

    #[test]
    fn test_planner_has_work_remaining() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        assert!(planner.has_work_remaining());

        planner.mark_step_running("step1");
        planner.mark_step_completed("step1");
        assert!(planner.has_work_remaining());

        planner.mark_step_running("step2");
        planner.mark_step_completed("step2");
        assert!(!planner.has_work_remaining());
    }

    #[test]
    fn test_planner_progress() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        assert_eq!(planner.progress(), (0, 2));

        planner.mark_step_running("step1");
        planner.mark_step_completed("step1");
        assert_eq!(planner.progress(), (1, 2));

        planner.mark_step_running("step2");
        planner.mark_step_completed("step2");
        assert_eq!(planner.progress(), (2, 2));
    }

    #[test]
    fn test_planner_metrics_duration() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        planner.mark_step_running("step1");
        std::thread::sleep(std::time::Duration::from_millis(10));
        planner.mark_step_completed("step1");

        let metrics = planner.get_metrics();
        let step1_metrics = metrics.get("step1").unwrap();
        assert!(step1_metrics.start_time.is_some());
        assert!(step1_metrics.end_time.is_some());
        assert!(step1_metrics.duration_ms.is_some());
        assert!(step1_metrics.duration_ms.unwrap() >= 10);
    }

    #[test]
    fn test_planner_from_state() {
        let workflow = create_test_workflow();
        let mut state = WorkflowState::new("test.yaml");
        state.mark_completed("step1");

        let planner = ExecutionPlanner::from_state(workflow, state, false, 4, None).unwrap();

        assert_eq!(planner.progress(), (1, 2));

        // step2 should now be ready since step1 is completed
        let ready = planner.get_ready_steps();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, "step2");
    }

    #[test]
    fn test_planner_parallel_independent_steps() {
        let mut workflow = Workflow::new();
        workflow.add_step(Step::new("a", "bash", "echo a")).unwrap();
        workflow.add_step(Step::new("b", "bash", "echo b")).unwrap();
        workflow.add_step(Step::new("c", "bash", "echo c")).unwrap();

        let planner = ExecutionPlanner::new(workflow, false, 4, None).unwrap();

        // All steps are independent, so all should be ready
        let ready = planner.get_ready_steps();
        assert_eq!(ready.len(), 3);
    }

    #[test]
    fn test_planner_respects_max_parallel() {
        let mut workflow = Workflow::new();
        workflow.add_step(Step::new("a", "bash", "echo a")).unwrap();
        workflow.add_step(Step::new("b", "bash", "echo b")).unwrap();
        workflow.add_step(Step::new("c", "bash", "echo c")).unwrap();

        // max_parallel=2, so only 2 should be ready at once
        let planner = ExecutionPlanner::new(workflow, false, 2, None).unwrap();

        let ready = planner.get_ready_steps();
        assert_eq!(ready.len(), 2);
    }

    #[test]
    fn test_planner_step_metrics_new_default() {
        let metrics = StepMetrics::new();
        assert!(metrics.start_time.is_none());
        assert!(metrics.end_time.is_none());
        assert!(metrics.duration_ms.is_none());
        assert_eq!(metrics.status, StepStatus::Pending);
    }
}