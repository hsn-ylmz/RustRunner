//! Workflow Validation
//!
//! Provides comprehensive validation for workflow structures including:
//! - Step field validation
//! - Dependency graph validation (no cycles)
//! - Topological sorting
//! - Reference integrity checking

use std::collections::{HashMap, HashSet, VecDeque};

use log::{debug, info, warn};

use super::model::{Step, Workflow};

/// Validation error types for user-friendly error messages.
#[derive(Debug, Clone)]
pub enum ValidationError {
    EmptyWorkflow,
    DuplicateStepId(String),
    EmptyStepId,
    EmptyTool(String),
    EmptyCommand(String),
    InvalidReference { step: String, reference: String },
    CyclicDependency,
    UnusedPlaceholder { step: String, placeholder: String },
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyWorkflow => write!(f, "Workflow has no steps"),
            Self::DuplicateStepId(id) => write!(f, "Duplicate step ID: '{}'", id),
            Self::EmptyStepId => write!(f, "Step has empty or whitespace-only ID"),
            Self::EmptyTool(step) => write!(f, "Step '{}' has no tool specified", step),
            Self::EmptyCommand(step) => write!(f, "Step '{}' has no command specified", step),
            Self::InvalidReference { step, reference } => {
                write!(f, "Step '{}' references unknown step '{}'", step, reference)
            }
            Self::CyclicDependency => {
                write!(f, "Workflow contains cyclic dependencies (steps depend on each other in a loop)")
            }
            Self::UnusedPlaceholder { step, placeholder } => {
                write!(f, "Step '{}': command uses {} but no file specified", step, placeholder)
            }
        }
    }
}

/// Validates a single step's fields.
fn validate_step(step: &Step) -> Vec<ValidationError> {
    let mut errors = Vec::new();

    // Check ID
    if step.id.trim().is_empty() {
        errors.push(ValidationError::EmptyStepId);
        return errors; // Can't validate further without ID
    }

    // Check tool
    if step.tool.trim().is_empty() {
        errors.push(ValidationError::EmptyTool(step.id.clone()));
    }

    // Check command
    if step.command.trim().is_empty() {
        errors.push(ValidationError::EmptyCommand(step.id.clone()));
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

/// Performs topological sort on workflow steps using Kahn's algorithm.
///
/// This ensures steps are ordered so that dependencies come before dependents.
/// Also detects cyclic dependencies (which would make execution impossible).
fn topological_sort(workflow: &mut Workflow) -> Result<(), String> {
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

        for prev_id in &step.previous {
            if !step_ids.contains(prev_id.as_str()) {
                errors.push(format!(
                    "Step '{}': references unknown step '{}'",
                    step.id, prev_id
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
        assert!(errors.iter().any(|e| matches!(e, ValidationError::EmptyTool(_))));
    }

    #[test]
    fn test_validate_step_empty_command() {
        let step = Step::new("test", "bash", "");
        let errors = validate_step(&step);

        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| matches!(e, ValidationError::EmptyCommand(_))));
    }

    #[test]
    fn test_validate_step_empty_id() {
        let step = Step::new("", "bash", "echo test");
        let errors = validate_step(&step);

        assert!(!errors.is_empty());
        assert!(errors.iter().any(|e| matches!(e, ValidationError::EmptyStepId)));
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
        workflow.add_step(Step::new("test", "", "echo test")).unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.iter().any(|e| e.contains("missing tool")));
    }

    #[test]
    fn test_quick_validate_placeholder_mismatch_input() {
        let mut workflow = Workflow::new();
        workflow.add_step(
            Step::new("test", "bash", "cat {input}")
        ).unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.iter().any(|e| e.contains("no input specified")));
    }

    #[test]
    fn test_quick_validate_placeholder_mismatch_output() {
        let mut workflow = Workflow::new();
        workflow.add_step(
            Step::new("test", "bash", "echo hello > {output}")
        ).unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.iter().any(|e| e.contains("no output specified")));
    }

    #[test]
    fn test_quick_validate_valid() {
        let mut workflow = Workflow::new();
        workflow.add_step(
            Step::new("test", "bash", "cat {input} > {output}")
                .with_input("in.txt")
                .with_output("out.txt")
        ).unwrap();

        let errors = quick_validate(&workflow);
        assert!(errors.is_empty());
    }

    #[test]
    fn test_quick_validate_unknown_reference() {
        let mut workflow = Workflow::new();
        workflow.add_step(
            Step::new("test", "bash", "echo test").depends_on("nonexistent")
        ).unwrap();

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

    #[test]
    fn test_validate_invalid_reference() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("step1", "bash", "echo test").depends_on("ghost"),
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
}
