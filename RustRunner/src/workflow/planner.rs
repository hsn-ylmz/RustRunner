//! Execution Planner
//!
//! Manages workflow execution scheduling including:
//! - Dependency tracking
//! - Parallel job management
//! - Thread/resource allocation
//! - Step status tracking

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use log::{debug, info, warn};
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
    /// Attempts used by the step (1 unless it was retried; 0 if never run)
    pub attempts: u32,
}

impl StepMetrics {
    fn new() -> Self {
        Self {
            start_time: None,
            end_time: None,
            duration_ms: None,
            status: StepStatus::Pending,
            attempts: 0,
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
    ) -> Result<Self, String> {
        let max_system_threads = num_cpus::get();

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
        })
    }

    /// Creates a planner that resumes from a previous state.
    pub fn from_state(
        workflow: Workflow,
        state: WorkflowState,
        dry_run: bool,
        max_parallel_jobs: usize,
    ) -> Result<Self, String> {
        let mut planner = Self::new(workflow, dry_run, max_parallel_jobs)?;

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
            // Skip completed, running and failed steps (a failed step is not
            // retried here: its attempts are used up inside the step runner).
            if self.completed_steps.contains(&step.id)
                || self.running_steps.contains(&step.id)
                || self.is_failed(&step.id)
            {
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
                // If nothing is running or already queued this round, allow the
                // step to run alone even though it exceeds the thread budget.
                // Otherwise a step whose `threads` is larger than the whole
                // system could never be scheduled and the engine would spin
                // forever with no work in flight.
                let nothing_in_flight = self.current_threads_used == 0 && threads_to_allocate == 0;
                if !nothing_in_flight {
                    debug!(
                        "Step '{}' needs {} threads but only {} available",
                        step.id,
                        step_threads,
                        self.max_system_threads
                            .saturating_sub(self.current_threads_used + threads_to_allocate)
                    );
                    continue;
                }
                warn!(
                    "Step '{}' requests {} threads, more than the {} available - running it alone",
                    step.id, step_threads, self.max_system_threads
                );
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

    /// Records how many attempts a step used (retries included).
    pub fn record_attempts(&mut self, step_id: &str, attempts: u32) {
        if let Some(metrics) = self.step_metrics.get_mut(step_id) {
            metrics.attempts = attempts;
        }
    }

    /// Steps that needed more than one attempt, in workflow order, as
    /// `(step_id, attempts)`.
    pub fn retried_steps(&self) -> Vec<(String, u32)> {
        self.workflow
            .steps
            .iter()
            .filter_map(|s| {
                let attempts = self.step_metrics.get(&s.id)?.attempts;
                (attempts > 1).then(|| (s.id.clone(), attempts))
            })
            .collect()
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
    ///
    /// Steps that failed, and steps that can never run because something they
    /// depend on failed, are not work: a keep-going run is over once the
    /// independent branches are done.
    pub fn has_work_remaining(&self) -> bool {
        let blocked = self.blocked_steps();
        self.workflow.steps.iter().any(|s| {
            !self.completed_steps.contains(&s.id)
                && !self.is_failed(&s.id)
                && !blocked.contains_key(&s.id)
        })
    }

    fn is_failed(&self, step_id: &str) -> bool {
        matches!(
            self.step_metrics.get(step_id).map(|m| &m.status),
            Some(StepStatus::Failed(_))
        )
    }

    /// Ids of the steps that failed, in workflow order.
    pub fn failed_steps(&self) -> Vec<String> {
        self.workflow
            .steps
            .iter()
            .filter(|s| self.is_failed(&s.id))
            .map(|s| s.id.clone())
            .collect()
    }

    /// Steps that can no longer run because a step they depend on (directly
    /// or through other steps) failed, as `step -> the failed step to blame`.
    /// Steps that already completed or started are never reported.
    pub fn blocked_steps(&self) -> HashMap<String, String> {
        let by_id: HashMap<&str, &Step> = self
            .workflow
            .steps
            .iter()
            .map(|s| (s.id.as_str(), s))
            .collect();
        let mut blocked: HashMap<String, String> = HashMap::new();
        // Dependencies can be listed in any order, so repeat until nothing
        // new is blocked (at most one pass per step).
        loop {
            let mut changed = false;
            for step in &self.workflow.steps {
                if blocked.contains_key(&step.id)
                    || self.completed_steps.contains(&step.id)
                    || self.running_steps.contains(&step.id)
                    || self.is_failed(&step.id)
                {
                    continue;
                }
                let culprit = step.previous.iter().find_map(|dep| {
                    if !by_id.contains_key(dep.as_str()) {
                        None
                    } else if self.is_failed(dep) {
                        Some(dep.clone())
                    } else {
                        blocked.get(dep).cloned()
                    }
                });
                if let Some(culprit) = culprit {
                    blocked.insert(step.id.clone(), culprit);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        blocked
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

    #[cfg(test)]
    fn set_max_system_threads(&mut self, threads: usize) {
        self.max_system_threads = threads;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_workflow() -> Workflow {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("step1", "bash", "echo 1").with_output("out1.txt"))
            .unwrap();
        workflow
            .add_step(
                Step::new("step2", "bash", "echo 2")
                    .with_input("out1.txt")
                    .with_output("out2.txt")
                    .depends_on("step1"),
            )
            .unwrap();

        if let Some(s1) = workflow.get_step_mut("step1") {
            s1.next.push("step2".to_string());
        }

        workflow
    }

    #[test]
    fn test_record_attempts_and_retried_steps() {
        let mut planner = ExecutionPlanner::new(create_test_workflow(), false, 4).unwrap();
        planner.record_attempts("step1", 1);
        planner.record_attempts("step2", 3);
        assert_eq!(planner.get_metrics()["step2"].attempts, 3);
        assert_eq!(planner.retried_steps(), vec![("step2".to_string(), 3)]);
        // Unknown ids are ignored.
        planner.record_attempts("nope", 5);
    }

    #[test]
    fn test_planner_creation() {
        let workflow = create_test_workflow();
        let planner = ExecutionPlanner::new(workflow, false, 4);
        assert!(planner.is_ok());

        let planner = planner.unwrap();
        assert!(!planner.is_dry_run());
        assert_eq!(planner.progress(), (0, 2));
    }

    #[test]
    fn test_planner_dry_run() {
        let workflow = create_test_workflow();
        let planner = ExecutionPlanner::new(workflow, true, 4).unwrap();
        assert!(planner.is_dry_run());
    }

    #[test]
    fn test_planner_get_ready_steps() {
        let workflow = create_test_workflow();
        let planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

        let ready = planner.get_ready_steps();
        // Only step1 should be ready (step2 depends on step1)
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, "step1");
    }

    #[test]
    fn test_over_threaded_step_runs_alone_not_starved() {
        // A step requesting more threads than the system has must still be
        // schedulable when nothing else is running, otherwise the engine would
        // spin forever with no work in flight.
        let mut workflow = Workflow::new();
        let mut big = Step::new("big", "bash", "echo hi");
        big.threads = 999;
        workflow.add_step(big).unwrap();

        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();
        planner.set_max_system_threads(4);

        let ready = planner.get_ready_steps();
        assert_eq!(ready.len(), 1, "over-threaded step should run alone");
        assert_eq!(ready[0].id, "big");
    }

    #[test]
    fn test_over_threaded_step_waits_when_something_running() {
        // The same over-budget step must NOT be co-scheduled alongside other
        // in-flight work - it only runs alone.
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("small", "bash", "echo a"))
            .unwrap();
        let mut big = Step::new("big", "bash", "echo b");
        big.threads = 999;
        workflow.add_step(big).unwrap();

        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();
        planner.set_max_system_threads(4);

        planner.mark_step_running("small");
        let ready = planner.get_ready_steps();
        assert!(
            ready.iter().all(|s| s.id != "big"),
            "over-threaded step must wait while other steps run"
        );
    }

    #[test]
    fn test_planner_mark_running_and_completed() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

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
        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

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
        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

        planner.mark_step_running("step1");
        planner.mark_step_failed("step1", "Test error".to_string());

        let metrics = planner.get_metrics();
        match &metrics.get("step1").unwrap().status {
            StepStatus::Failed(msg) => assert_eq!(msg, "Test error"),
            _ => panic!("Expected Failed status"),
        }
    }

    #[test]
    fn test_failed_step_blocks_only_its_downstream() {
        // a -> b -> c, and an independent d.
        let mut wf = Workflow::new();
        wf.add_step(Step::new("a", "bash", "x")).unwrap();
        wf.add_step(Step::new("b", "bash", "x").depends_on("a"))
            .unwrap();
        wf.add_step(Step::new("c", "bash", "x").depends_on("b"))
            .unwrap();
        wf.add_step(Step::new("d", "bash", "x")).unwrap();
        let mut planner = ExecutionPlanner::new(wf, false, 4).unwrap();

        planner.mark_step_running("a");
        planner.mark_step_failed("a", "boom".into());

        let blocked = planner.blocked_steps();
        assert_eq!(blocked.get("b").map(String::as_str), Some("a"));
        // c is blamed on the step that actually failed, not on b.
        assert_eq!(blocked.get("c").map(String::as_str), Some("a"));
        assert!(!blocked.contains_key("d"));
        assert_eq!(planner.failed_steps(), vec!["a".to_string()]);

        // d can still run; once it is done nothing is left to do.
        let ready: Vec<String> = planner
            .get_ready_steps()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ready, vec!["d".to_string()]);
        assert!(planner.has_work_remaining());
        planner.mark_step_running("d");
        planner.mark_step_completed("d");
        assert!(!planner.has_work_remaining());
    }

    #[test]
    fn test_planner_has_work_remaining() {
        let workflow = create_test_workflow();
        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

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
        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

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
        let mut planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

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

        let planner = ExecutionPlanner::from_state(workflow, state, false, 4).unwrap();

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

        let planner = ExecutionPlanner::new(workflow, false, 4).unwrap();

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
        let planner = ExecutionPlanner::new(workflow, false, 2).unwrap();

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
