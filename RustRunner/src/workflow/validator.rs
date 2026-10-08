//! Workflow Validation
//!
//! Provides comprehensive validation for workflow structures including:
//! - Step field validation
//! - Dependency graph validation (no cycles)
//! - Topological sorting
//! - Reference integrity checking

use std::collections::{HashMap, HashSet, VecDeque};

use log::{debug, info, warn};

use super::model::{Step, Workflow, MAX_RETRY_DELAY_SECS};
use super::slots::{slot_problems, unused_slots};

/// Largest `retries` value accepted for a single step.
pub const MAX_RETRIES: u32 = 100;

/// Validation error types for user-friendly error messages.
#[derive(Debug, Clone)]
pub enum ValidationError {
    EmptyWorkflow,
    DuplicateStepId(String),
    EmptyStepId,
    EmptyTool(String),
    EmptyCommand(String),
    InvalidReference {
        step: String,
        reference: String,
    },
    CyclicDependency,
    ContradictoryDependency {
        first: String,
        second: String,
    },
    UnusedPlaceholder {
        step: String,
        placeholder: String,
    },
    TooManyRetries {
        step: String,
        retries: u32,
    },
    RetryDelayTooLong {
        step: String,
        secs: u64,
    },
    ZeroTimeout(String),
    InvalidCheck {
        step: String,
        reason: String,
    },
    InvalidMetadata(String),
    /// A problem with a step's named slots or the placeholders of its
    /// command; the text already names the step and the slot.
    InvalidSlot(String),
    /// A problem with a step's `install` block; the text names the step.
    InvalidInstall(String),
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyWorkflow => write!(f, "Workflow has no steps"),
            Self::InvalidMetadata(reason) => write!(f, "{}", reason),
            Self::InvalidSlot(reason) => write!(f, "{}", reason),
            Self::InvalidInstall(reason) => write!(f, "{}", reason),
            Self::DuplicateStepId(id) => write!(f, "Duplicate step ID: '{}'", id),
            Self::EmptyStepId => write!(f, "Step has empty or whitespace-only ID"),
            Self::EmptyTool(step) => write!(f, "Step '{}' has no tool specified", step),
            Self::EmptyCommand(step) => write!(f, "Step '{}' has no command specified", step),
            Self::InvalidReference { step, reference } => {
                write!(f, "Step '{}' references unknown step '{}'", step, reference)
            }
            Self::CyclicDependency => {
                write!(
                    f,
                    "Workflow contains cyclic dependencies (steps depend on each other in a loop)"
                )
            }
            Self::ContradictoryDependency { first, second } => write!(
                f,
                "Steps '{}' and '{}' contradict each other: one says '{}' runs before '{}' \
                 (via previous/next) and the other says '{}' runs before '{}'",
                first, second, first, second, second, first
            ),
            Self::UnusedPlaceholder { step, placeholder } => {
                write!(
                    f,
                    "Step '{}': command uses {} but no file specified",
                    step, placeholder
                )
            }
            Self::TooManyRetries { step, retries } => write!(
                f,
                "Step '{}': retries is {} but at most {} are allowed",
                step, retries, MAX_RETRIES
            ),
            Self::RetryDelayTooLong { step, secs } => write!(
                f,
                "Step '{}': retry_delay_secs is {} but at most {} are allowed",
                step, secs, MAX_RETRY_DELAY_SECS
            ),
            Self::ZeroTimeout(step) => write!(
                f,
                "Step '{}': timeout_secs must be greater than 0 (leave it empty for no timeout)",
                step
            ),
            Self::InvalidCheck { step, reason } => {
                write!(f, "Step '{}': invalid output check: {}", step, reason)
            }
        }
    }
}

/// Validates a step's output checks.
fn validate_check_settings(step: &Step) -> Vec<ValidationError> {
    step.checks
        .iter()
        .filter_map(|check| {
            check
                .config_problem(step)
                .map(|reason| ValidationError::InvalidCheck {
                    step: step.id.clone(),
                    reason: format!("{} ({})", reason, check.describe()),
                })
        })
        .collect()
}

/// Validates a step's retry and timeout settings.
/// Problems with the step's `install` block, each naming the step.
fn install_problems(step: &Step) -> Vec<String> {
    step.install
        .as_ref()
        .map(|install| {
            install
                .problems()
                .into_iter()
                .map(|p| format!("Step '{}': install: {}", step.id, p))
                .collect()
        })
        .unwrap_or_default()
}

fn validate_retry_settings(step: &Step) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    if step.retries > MAX_RETRIES {
        errors.push(ValidationError::TooManyRetries {
            step: step.id.clone(),
            retries: step.retries,
        });
    }
    if step.retry_delay_secs > MAX_RETRY_DELAY_SECS {
        errors.push(ValidationError::RetryDelayTooLong {
            step: step.id.clone(),
            secs: step.retry_delay_secs,
        });
    }
    if step.timeout_secs == Some(0) {
        errors.push(ValidationError::ZeroTimeout(step.id.clone()));
    }

    errors
}

/// Validates a single step's fields.
fn validate_step(step: &Step) -> Vec<ValidationError> {
    let mut errors = Vec::new();

    // Check ID
    if step.id.trim().is_empty() {
        errors.push(ValidationError::EmptyStepId);
        return errors; // Can't validate further without ID
    }

    // Warn about step ids that aren't clean identifiers. These are sanitized
    // when used as a temp-script filename, but a `/` or `..` in an id signals a
    // likely mistake worth surfacing.
    if step.id.contains('/') || step.id.contains('\\') || step.id.contains("..") {
        warn!(
            "Step '{}': id contains path separators; it will be sanitized for file operations",
            step.id
        );
    }

    // Check tool
    if step.tool.trim().is_empty() {
        errors.push(ValidationError::EmptyTool(step.id.clone()));
    }

    // Check command
    if step.command.trim().is_empty() {
        errors.push(ValidationError::EmptyCommand(step.id.clone()));
    }

    errors.extend(validate_retry_settings(step));
    errors.extend(validate_check_settings(step));
    errors.extend(
        slot_problems(step)
            .into_iter()
            .map(ValidationError::InvalidSlot),
    );
    errors.extend(
        install_problems(step)
            .into_iter()
            .map(ValidationError::InvalidInstall),
    );
    for name in unused_slots(step) {
        warn!(
            "Step '{}': slot '{}' is declared but the command never uses {{{}}}",
            step.id, name, name
        );
    }

    if step.mock && step.output_paths().is_empty() {
        warn!(
            "Step '{}' is mocked but declares no outputs, so mocking creates nothing",
            step.id
        );
    }

    // Warn about placeholder mismatches
    if step.command.contains("{input}") && step.input.is_empty() {
        warn!(
            "Step '{}': command uses {{input}} but no input specified",
            step.id
        );
    }

    if step.command.contains("{output}") && step.output.is_empty() {
        warn!(
            "Step '{}': command uses {{output}} but no output specified",
            step.id
        );
    }

    // Log step properties
    if step.previous.is_empty() {
        debug!("Step '{}' is a root step (no dependencies)", step.id);
    }

    if step.next.is_empty() {
        debug!("Step '{}' is a leaf step (nothing depends on it)", step.id);
    }

    errors
}

/// Validates the entire workflow structure.
///
/// Performs the following checks:
/// 1. Workflow is not empty
/// 2. No duplicate step IDs
/// 3. All steps have valid fields
/// 4. All references point to existing steps
/// 5. No cyclic dependencies
/// 6. Topological sort succeeds
///
/// On success, the workflow steps are reordered in topological order.
pub fn validate_workflow(workflow: &mut Workflow) -> Result<(), String> {
    info!("Validating workflow with {} steps", workflow.steps.len());

    // Check for empty workflow
    if workflow.steps.is_empty() {
        return Err(ValidationError::EmptyWorkflow.to_string());
    }

    // Normalize and check the optional metadata
    if let Some(metadata) = workflow.metadata.as_mut() {
        metadata.normalize();
        metadata
            .validate()
            .map_err(|e| ValidationError::InvalidMetadata(e).to_string())?;
        if metadata.is_empty() {
            workflow.metadata = None;
        }
    }

    // Refresh tools list
    workflow.refresh_tools();

    // Check for duplicate IDs
    let mut seen_ids: HashSet<String> = HashSet::new();
    for step in &workflow.steps {
        if !seen_ids.insert(step.id.clone()) {
            return Err(ValidationError::DuplicateStepId(step.id.clone()).to_string());
        }
    }

    // Validate each step
    let mut all_errors = Vec::new();
    for step in &workflow.steps {
        let errors = validate_step(step);
        all_errors.extend(errors);

        // Check references
        for prev_id in &step.previous {
            if !seen_ids.contains(prev_id) {
                all_errors.push(ValidationError::InvalidReference {
                    step: step.id.clone(),
                    reference: prev_id.clone(),
                });
            }
        }

        for next_id in &step.next {
            if !seen_ids.contains(next_id) {
                all_errors.push(ValidationError::InvalidReference {
                    step: step.id.clone(),
                    reference: next_id.clone(),
                });
            }
        }
    }

    if !all_errors.is_empty() {
        let error_messages: Vec<String> = all_errors.iter().map(|e| e.to_string()).collect();
        return Err(error_messages.join("\n"));
    }

    // Topological sort (also detects cycles)
    topological_sort(workflow)?;

    info!(
        "Workflow validated: {} steps, {} tools",
        workflow.steps.len(),
        workflow.tools.len()
    );
    Ok(())
}

/// Makes `previous` and `next` agree: both become the deduplicated union of
/// what either side declares.
///
/// Hand-written YAML may spell a dependency from either end (`previous` on the
/// later step, `next` on the earlier one, or both); the planner only reads
/// `previous`, so after this call every edge is present in both lists. Order
/// is stable: the declared entries keep their position and edges contributed
/// by the other side are appended in step order.
///
/// Errors when two steps each claim to run before the other. That is a
/// contradiction in what was written, which is more useful to report than a
/// generic cycle. References to unknown steps are ignored here (they are
/// reported by the reference check).
fn normalize_dependencies(workflow: &mut Workflow) -> Result<(), String> {
    let ids: HashSet<String> = workflow.steps.iter().map(|s| s.id.clone()).collect();

    // Every declared edge as (before, after), in a stable order.
    let mut edges: Vec<(String, String)> = Vec::new();
    for step in &workflow.steps {
        for prev in &step.previous {
            edges.push((prev.clone(), step.id.clone()));
        }
        for next in &step.next {
            edges.push((step.id.clone(), next.clone()));
        }
    }
    edges.retain(|(a, b)| ids.contains(a) && ids.contains(b));

    let edge_set: HashSet<(&str, &str)> = edges
        .iter()
        .map(|(a, b)| (a.as_str(), b.as_str()))
        .collect();
    for (a, b) in &edges {
        if a != b && edge_set.contains(&(b.as_str(), a.as_str())) {
            return Err(ValidationError::ContradictoryDependency {
                first: a.clone(),
                second: b.clone(),
            }
            .to_string());
        }
    }

    for step in &mut workflow.steps {
        let mut previous: Vec<String> = Vec::new();
        let mut next: Vec<String> = Vec::new();
        // Keep unknown references untouched so they are still reported.
        for prev in &step.previous {
            if !ids.contains(prev) && !previous.contains(prev) {
                previous.push(prev.clone());
            }
        }
        for next_id in &step.next {
            if !ids.contains(next_id) && !next.contains(next_id) {
                next.push(next_id.clone());
            }
        }
        for (before, after) in &edges {
            if *after == step.id && !previous.contains(before) {
                previous.push(before.clone());
            }
            if *before == step.id && !next.contains(after) {
                next.push(after.clone());
            }
        }
        step.previous = previous;
        step.next = next;
    }
    Ok(())
}

/// Performs topological sort on workflow steps using Kahn's algorithm.
///
/// This ensures steps are ordered so that dependencies come before dependents.
/// Also detects cyclic dependencies (which would make execution impossible).
/// The graph is built from `previous` and `next` together (see
/// [`normalize_dependencies`]), so either spelling works.
fn topological_sort(workflow: &mut Workflow) -> Result<(), String> {
    normalize_dependencies(workflow)?;

    // Build in-degree map
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    for step in &workflow.steps {
        in_degree.insert(step.id.clone(), step.previous.len());
    }

    // Start with root nodes (in-degree = 0)
    let mut queue: VecDeque<String> = workflow
        .steps
        .iter()
        .filter(|s| s.previous.is_empty())
        .map(|s| s.id.clone())
        .collect();

    let mut sorted_order: Vec<String> = Vec::new();

    while let Some(current_id) = queue.pop_front() {
        sorted_order.push(current_id.clone());

        // Get successors
        let successors: Vec<String> = workflow
            .steps
            .iter()
            .find(|s| s.id == current_id)
            .map(|s| s.next.clone())
            .unwrap_or_default();

        for successor_id in successors {
            if let Some(degree) = in_degree.get_mut(&successor_id) {
                *degree -= 1;
                if *degree == 0 {
                    queue.push_back(successor_id);
                }
            }
        }
    }

    // Check for cycles
    if sorted_order.len() != workflow.steps.len() {
        return Err(ValidationError::CyclicDependency.to_string());
    }

    // Reorder steps according to topological sort
    let step_map: HashMap<String, Step> = workflow
        .steps
        .drain(..)
        .map(|s| (s.id.clone(), s))
        .collect();

    workflow.steps = sorted_order
        .into_iter()
        .map(|id| step_map.get(&id).unwrap().clone())
        .collect();

    debug!(
        "Topological order: {:?}",
        workflow.steps.iter().map(|s| &s.id).collect::<Vec<_>>()
    );

    Ok(())
}

/// Quick validation that returns a list of error messages.
///
/// Useful for GUI validation feedback.
pub fn quick_validate(workflow: &Workflow) -> Vec<String> {
    let mut errors = Vec::new();

    if workflow.steps.is_empty() {
        errors.push("Workflow has no steps".to_string());
        return errors;
    }

    let step_ids: HashSet<_> = workflow.steps.iter().map(|s| s.id.as_str()).collect();

    for step in &workflow.steps {
        if step.id.trim().is_empty() {
            errors.push("A step has an empty ID".to_string());
        }

        if step.tool.trim().is_empty() {
            errors.push(format!("Step '{}': missing tool", step.id));
        }

        if step.command.trim().is_empty() {
            errors.push(format!("Step '{}': missing command", step.id));
        }

        if step.command.contains("{input}") && step.input.is_empty() {
            errors.push(format!(
                "Step '{}': command uses {{input}} but no input specified",
                step.id
            ));
        }

        if step.command.contains("{output}") && step.output.is_empty() {
            errors.push(format!(
                "Step '{}': command uses {{output}} but no output specified",
                step.id
            ));
        }

        errors.extend(validate_retry_settings(step).iter().map(|e| e.to_string()));
        errors.extend(validate_check_settings(step).iter().map(|e| e.to_string()));
        errors.extend(slot_problems(step));
        errors.extend(install_problems(step));

        for prev_id in &step.previous {
            if !step_ids.contains(prev_id.as_str()) {
                errors.push(format!(
                    "Step '{}': references unknown step '{}'",
                    step.id, prev_id
                ));
            }
        }

        for next_id in &step.next {
            if !step_ids.contains(next_id.as_str()) {
                errors.push(format!(
                    "Step '{}': references unknown step '{}'",
                    step.id, next_id
                ));
            }
        }
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metadata_is_normalized_and_blank_metadata_dropped() {
        use crate::workflow::WorkflowMetadata;
        let mut wf = Workflow::from_steps(vec![Step::new("a", "bash", "echo hi")])
            .with_metadata(WorkflowMetadata::new(Some("  qc "), None));
        validate_workflow(&mut wf).unwrap();
        assert_eq!(wf.metadata.unwrap().name.as_deref(), Some("qc"));

        let mut blank = Workflow::from_steps(vec![Step::new("a", "bash", "echo hi")])
            .with_metadata(WorkflowMetadata::new(Some(" "), Some("")));
        validate_workflow(&mut blank).unwrap();
        assert!(blank.metadata.is_none());
    }

    #[test]
    fn test_metadata_with_newline_is_rejected() {
        use crate::workflow::WorkflowMetadata;
        let mut wf = Workflow::from_steps(vec![Step::new("a", "bash", "echo hi")])
            .with_metadata(WorkflowMetadata::new(Some("x\nStarting step: a"), None));
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("control characters"), "{}", err);
    }

    #[test]
    fn test_retry_settings_valid() {
        let mut wf = Workflow::from_steps(vec![Step::new("a", "bash", "echo hi")
            .with_retries(3)
            .with_timeout_secs(60)]);
        assert!(validate_workflow(&mut wf).is_ok());
    }

    #[test]
    fn test_retry_settings_rejected() {
        let cases = [
            (
                Step::new("a", "bash", "x").with_retries(MAX_RETRIES + 1),
                "retries",
            ),
            (
                Step::new("a", "bash", "x").with_retry_backoff(
                    crate::workflow::RetryBackoff::Fixed,
                    MAX_RETRY_DELAY_SECS + 1,
                ),
                "retry_delay_secs",
            ),
            (
                Step::new("a", "bash", "x").with_timeout_secs(0),
                "timeout_secs",
            ),
        ];
        for (step, needle) in cases {
            let mut wf = Workflow::from_steps(vec![step.clone()]);
            let err = validate_workflow(&mut wf).unwrap_err();
            assert!(err.contains(needle), "{err}");
            let quick = quick_validate(&wf);
            assert!(quick.iter().any(|m| m.contains(needle)), "{quick:?}");
        }
    }

    #[test]
    fn test_invalid_checks_rejected() {
        use crate::workflow::{CheckKind, OutputCheck};
        let base = || Step::new("a", "bash", "x").with_output("out.txt");
        let mut lines_on_exists = OutputCheck::new(CheckKind::Exists);
        lines_on_exists.lines = Some(3);
        let cases = vec![
            (base().with_check(OutputCheck::min_lines(0)), "0 lines"),
            (
                base().with_check(OutputCheck::new(CheckKind::MinLines)),
                "needs a `lines`",
            ),
            (
                base().with_check(lines_on_exists),
                "only applies to min_lines",
            ),
            (
                base().with_check(OutputCheck::new(CheckKind::Exists).with_target("other.txt")),
                "not one of the step's outputs",
            ),
            (
                Step::new("a", "bash", "x").with_check(OutputCheck::new(CheckKind::NonEmpty)),
                "no outputs",
            ),
        ];
        for (step, needle) in cases {
            let mut wf = Workflow::from_steps(vec![step]);
            let err = validate_workflow(&mut wf).unwrap_err();
            assert!(err.contains(needle), "{err}");
            let quick = quick_validate(&wf);
            assert!(quick.iter().any(|m| m.contains(needle)), "{quick:?}");
        }
    }

    #[test]
    fn test_valid_checks_accepted() {
        use crate::workflow::{CheckKind, OutputCheck};
        let step = Step::new("a", "bash", "x")
            .with_outputs(vec!["a.txt, b.txt".to_string()])
            .with_check(OutputCheck::new(CheckKind::Exists))
            .with_check(
                OutputCheck::min_lines(5)
                    .with_target("b.txt")
                    .non_blocking(),
            );
        let mut wf = Workflow::from_steps(vec![step]);
        assert!(validate_workflow(&mut wf).is_ok());
    }

    #[test]
    fn test_valid_workflow() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("step1", "bash", "echo hello").with_output("out.txt"),
            Step::new("step2", "bash", "cat {input}")
                .with_input("out.txt")
                .depends_on("step1"),
        ]);

        // Add next reference
        workflow.steps[0].next.push("step2".to_string());

        assert!(validate_workflow(&mut workflow).is_ok());
    }

    #[test]
    fn test_empty_workflow() {
        let mut workflow = Workflow::new();
        assert!(validate_workflow(&mut workflow).is_err());
    }

    #[test]
    fn test_duplicate_ids() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("same_id", "bash", "echo 1"),
            Step::new("same_id", "bash", "echo 2"),
        ]);

        assert!(validate_workflow(&mut workflow).is_err());
    }

    #[test]
    fn test_cyclic_dependency() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("a", "bash", "echo a").depends_on("b"),
            Step::new("b", "bash", "echo b").depends_on("a"),
        ]);

        workflow.steps[0].next.push("b".to_string());
        workflow.steps[1].next.push("a".to_string());

        assert!(validate_workflow(&mut workflow).is_err());
    }

    #[test]
    fn test_validate_step_empty_tool() {
        let step = Step::new("test", "", "echo test");
        let errors = validate_step(&step);

        assert!(!errors.is_empty());
        assert!(errors
            .iter()
            .any(|e| matches!(e, ValidationError::EmptyTool(_))));
    }

    #[test]
    fn test_validate_step_empty_command() {
        let step = Step::new("test", "bash", "");
        let errors = validate_step(&step);

        assert!(!errors.is_empty());
        assert!(errors
            .iter()
            .any(|e| matches!(e, ValidationError::EmptyCommand(_))));
    }

    #[test]
    fn test_validate_step_empty_id() {
        let step = Step::new("", "bash", "echo test");
        let errors = validate_step(&step);

        assert!(!errors.is_empty());
        assert!(errors
            .iter()
            .any(|e| matches!(e, ValidationError::EmptyStepId)));
    }

    #[test]
    fn test_validate_step_valid() {
        let step = Step::new("good", "bash", "echo test")
            .with_input("in.txt")
            .with_output("out.txt");
        let errors = validate_step(&step);

        assert!(errors.is_empty());
    }

    #[test]
    fn test_quick_validate_empty() {
        let workflow = Workflow::new();
        let errors = quick_validate(&workflow);

        assert!(!errors.is_empty());
        assert!(errors[0].contains("no steps"));
    }

    #[test]
    fn test_quick_validate_missing_tool() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("test", "", "echo test"))
            .unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.iter().any(|e| e.contains("missing tool")));
    }

    #[test]
    fn test_quick_validate_placeholder_mismatch_input() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("test", "bash", "cat {input}"))
            .unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.iter().any(|e| e.contains("no input specified")));
    }

    #[test]
    fn test_quick_validate_placeholder_mismatch_output() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("test", "bash", "echo hello > {output}"))
            .unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.iter().any(|e| e.contains("no output specified")));
    }

    #[test]
    fn test_quick_validate_valid() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(
                Step::new("test", "bash", "cat {input} > {output}")
                    .with_input("in.txt")
                    .with_output("out.txt"),
            )
            .unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.is_empty());
    }

    #[test]
    fn test_quick_validate_unknown_reference() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("test", "bash", "echo test").depends_on("nonexistent"))
            .unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.iter().any(|e| e.contains("unknown step")));
    }

    #[test]
    fn test_topological_sort_multiple_roots() {
        let step1 = Step::new("step1", "bash", "echo 1");
        let step2 = Step::new("step2", "bash", "echo 2");
        let step3 = Step::new("step3", "bash", "echo 3");

        let mut workflow = Workflow::from_steps(vec![step1, step2, step3]);
        let result = topological_sort(&mut workflow);

        assert!(result.is_ok());
        assert_eq!(workflow.steps.len(), 3);
    }

    #[test]
    fn test_topological_sort_linear() {
        let mut step1 = Step::new("step1", "bash", "echo 1");
        let step2 = Step::new("step2", "bash", "echo 2");
        let step3 = Step::new("step3", "bash", "echo 3");

        step1.next = vec!["step2".to_string()];
        let mut step2_mod = step2.depends_on("step1");
        step2_mod.next = vec!["step3".to_string()];
        let step3_mod = step3.depends_on("step2");

        let mut workflow = Workflow::from_steps(vec![step3_mod, step1, step2_mod]);
        let result = topological_sort(&mut workflow);

        assert!(result.is_ok());
        assert_eq!(workflow.steps[0].id, "step1");
        assert_eq!(workflow.steps[2].id, "step3");
    }

    fn chain_ids(workflow: &Workflow) -> Vec<&str> {
        workflow.steps.iter().map(|s| s.id.as_str()).collect()
    }

    #[test]
    fn test_dependencies_previous_only() {
        let a = Step::new("a", "bash", "echo a");
        let b = Step::new("b", "bash", "echo b").depends_on("a");
        let c = Step::new("c", "bash", "echo c").depends_on("b");
        let mut wf = Workflow::from_steps(vec![c, b, a]);
        validate_workflow(&mut wf).unwrap();
        assert_eq!(chain_ids(&wf), ["a", "b", "c"]);
        // next is derived so every reader sees the same graph
        assert_eq!(wf.steps[0].next, ["b"]);
        assert_eq!(wf.steps[1].next, ["c"]);
    }

    #[test]
    fn test_dependencies_next_only() {
        let mut a = Step::new("a", "bash", "echo a");
        a.next = vec!["b".into()];
        let mut b = Step::new("b", "bash", "echo b");
        b.next = vec!["c".into()];
        let c = Step::new("c", "bash", "echo c");
        let mut wf = Workflow::from_steps(vec![c, b, a]);
        validate_workflow(&mut wf).unwrap();
        assert_eq!(chain_ids(&wf), ["a", "b", "c"]);
        // previous is derived, which is what the planner reads
        assert_eq!(wf.steps[1].previous, ["a"]);
        assert_eq!(wf.steps[2].previous, ["b"]);
    }

    #[test]
    fn test_dependencies_both_are_deduplicated() {
        let mut a = Step::new("a", "bash", "echo a");
        a.next = vec!["b".into(), "b".into()];
        let b = Step::new("b", "bash", "echo b").depends_on("a");
        let mut wf = Workflow::from_steps(vec![b, a]);
        validate_workflow(&mut wf).unwrap();
        assert_eq!(chain_ids(&wf), ["a", "b"]);
        assert_eq!(wf.steps[0].next, ["b"]);
        assert_eq!(wf.steps[1].previous, ["a"]);
    }

    #[test]
    fn test_dependencies_mixed_spellings_form_a_diamond() {
        let mut a = Step::new("a", "bash", "echo a");
        a.next = vec!["b".into()];
        let b = Step::new("b", "bash", "echo b");
        let c = Step::new("c", "bash", "echo c").depends_on("a");
        let mut d = Step::new("d", "bash", "echo d").depends_on("b");
        d.previous.push("c".into());
        let mut wf = Workflow::from_steps(vec![d, c, b, a]);
        validate_workflow(&mut wf).unwrap();
        let order = chain_ids(&wf);
        assert_eq!(order[0], "a");
        assert_eq!(order[3], "d");
    }

    #[test]
    fn test_dependencies_contradiction_is_reported_clearly() {
        // a says it runs before b; b says it runs before a.
        let mut a = Step::new("a", "bash", "echo a");
        a.next = vec!["b".into()];
        let mut b = Step::new("b", "bash", "echo b");
        b.next = vec!["a".into()];
        let mut wf = Workflow::from_steps(vec![a, b]);
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("contradict"), "{}", err);
        assert!(err.contains("'a'") && err.contains("'b'"), "{}", err);
        assert!(!err.contains("cyclic"), "{}", err);

        // previous on one side, next on the other, same pair reversed
        let a = Step::new("a", "bash", "echo a").depends_on("b");
        let mut b = Step::new("b", "bash", "echo b");
        b.previous = vec!["a".into()];
        let mut wf = Workflow::from_steps(vec![a, b]);
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("contradict"), "{}", err);
    }

    #[test]
    fn test_dependencies_real_cycle_is_still_cyclic() {
        let a = Step::new("a", "bash", "echo a").depends_on("c");
        let b = Step::new("b", "bash", "echo b").depends_on("a");
        let c = Step::new("c", "bash", "echo c").depends_on("b");
        let mut wf = Workflow::from_steps(vec![a, b, c]);
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("cyclic"), "{}", err);
    }

    #[test]
    fn test_validate_invalid_reference() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("step1", "bash", "echo test").depends_on("ghost")
        ]);

        let result = validate_workflow(&mut workflow);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("unknown step"));
    }

    #[test]
    fn test_validation_error_display() {
        let err = ValidationError::EmptyWorkflow;
        assert_eq!(err.to_string(), "Workflow has no steps");

        let err = ValidationError::DuplicateStepId("test".to_string());
        assert!(err.to_string().contains("test"));

        let err = ValidationError::EmptyTool("step1".to_string());
        assert!(err.to_string().contains("step1"));

        let err = ValidationError::CyclicDependency;
        assert!(err.to_string().contains("cyclic"));
    }

    // ---- named slots ----

    fn slot_step() -> Step {
        Step::new("align", "bash", "run {ref} > {sam}")
            .with_named_input("ref", &["genome.fa"])
            .with_named_output("sam", &["out.sam"])
    }

    #[test]
    fn test_slot_step_is_valid() {
        let mut wf = Workflow::from_steps(vec![slot_step()]);
        validate_workflow(&mut wf).unwrap();
        assert!(quick_validate(&wf).is_empty());
    }

    #[test]
    fn test_unbound_slot_is_named_in_the_error() {
        let mut step = slot_step();
        step.named_inputs.insert("ref".into(), vec![]);
        let mut wf = Workflow::from_steps(vec![step]);
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("{ref}") && err.contains("align"), "{err}");
        let quick = quick_validate(&wf);
        assert!(quick.iter().any(|m| m.contains("{ref}")), "{quick:?}");
    }

    #[test]
    fn test_unknown_placeholder_is_named_in_the_error() {
        let mut step = slot_step();
        step.command = "run {ref} {typo} > {sam}".into();
        let mut wf = Workflow::from_steps(vec![step]);
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("{typo}"), "{err}");
    }

    #[test]
    fn test_bad_slot_names_are_rejected() {
        for bad in ["input", "has space", "9lives"] {
            let step = Step::new("a", "bash", "true").with_named_input(bad, &["f"]);
            let mut wf = Workflow::from_steps(vec![step]);
            let err = validate_workflow(&mut wf).unwrap_err();
            assert!(err.contains(bad), "{bad}: {err}");
        }
    }

    #[test]
    fn test_plain_steps_are_not_second_guessed() {
        // Braces that are not slots are fine in a step without named slots.
        let mut wf = Workflow::from_steps(vec![Step::new(
            "a",
            "bash",
            "awk '{print $1}' f.txt; echo {nothing_here}",
        )]);
        validate_workflow(&mut wf).unwrap();
    }

    #[test]
    fn test_unused_slot_is_only_a_warning() {
        let step = Step::new("a", "bash", "true").with_named_input("spare", &["f.txt"]);
        let mut wf = Workflow::from_steps(vec![step]);
        validate_workflow(&mut wf).unwrap();
    }

    // ---- optional slots and install ----

    #[test]
    fn test_optional_slot_may_be_empty() {
        let step = Step::new("align", "bash", "run {ref} {reads1} {reads2} > {sam}")
            .with_named_input("ref", &["genome.fa"])
            .with_named_input("reads1", &["a.fq"])
            .with_named_input("reads2", &[])
            .with_named_output("sam", &["out.sam"])
            .with_optional_slots(&["reads2"]);
        let mut wf = Workflow::from_steps(vec![step]);
        validate_workflow(&mut wf).unwrap();
    }

    #[test]
    fn test_empty_slot_that_is_not_optional_is_still_an_error() {
        let step = Step::new("align", "bash", "run {reads1} {reads2}")
            .with_named_input("reads1", &["a.fq"])
            .with_named_input("reads2", &[])
            .with_optional_slots(&["reads1"]);
        let mut wf = Workflow::from_steps(vec![step]);
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("{reads2}"), "{err}");
    }

    #[test]
    fn test_optional_slot_must_be_a_named_input() {
        let step = Step::new("a", "bash", "run {x}")
            .with_named_input("x", &["f"])
            .with_optional_slots(&["ghost"]);
        let mut wf = Workflow::from_steps(vec![step]);
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("ghost"), "{err}");
    }

    #[test]
    fn test_valid_install_blocks_pass() {
        use crate::environment::install::Install;
        let steps = vec![
            Step::new("a", "samtools", "samtools --version").with_install(Install::Conda {
                package: "samtools".into(),
                version: Some("1.24".into()),
                channel: Some("bioconda".into()),
                osx64: false,
                constraints: Vec::new(),
            }),
            Step::new("b", "minimap2", "minimap2 --version").with_install(Install::System {
                binary: "minimap2".into(),
            }),
        ];
        let mut wf = Workflow::from_steps(steps);
        validate_workflow(&mut wf).unwrap();
    }

    #[test]
    fn test_bad_install_is_named_in_the_error() {
        use crate::environment::install::Install;
        let step = Step::new("align", "star", "STAR --version").with_install(Install::Conda {
            package: "star".into(),
            version: Some("1.0 && rm -rf ~".into()),
            channel: None,
            osx64: false,
            constraints: Vec::new(),
        });
        let mut wf = Workflow::from_steps(vec![step]);
        let quick = quick_validate(&wf);
        assert!(
            quick
                .iter()
                .any(|m| m.contains("install") && m.contains("align")),
            "{quick:?}"
        );
        let err = validate_workflow(&mut wf).unwrap_err();
        assert!(err.contains("version"), "{err}");
    }

    #[test]
    fn test_install_block_parses_from_yaml() {
        let yaml = "steps:\n  - id: a\n    tool: star\n    command: STAR --version\n    install:\n      kind: conda\n      package: star\n      version: 2.7.10b\n      osx64: true\n";
        let wf: Workflow = serde_yaml::from_str(yaml).unwrap();
        assert!(matches!(
            wf.steps[0].install,
            Some(crate::environment::install::Install::Conda { osx64: true, .. })
        ));
    }
}
