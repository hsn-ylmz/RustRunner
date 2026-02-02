//! Workflow Parser
//!
//! Handles loading and parsing workflow definitions from YAML files.
//! Supports both explicit dependencies (from GUI) and implicit dependencies
//! (derived from input/output file matching).

use std::collections::HashMap;
use std::error::Error;
use std::fs;

use log::{debug, info, warn};

use super::model::Workflow;
#[cfg(test)]
use super::model::Step;
use super::validator::validate_workflow;

/// Expands wildcard steps in a workflow into concrete steps.
fn expand_wildcards_in_workflow(workflow: &mut Workflow) -> Result<(), String> {
    use std::collections::HashMap;
    use crate::workflow::wildcards;

    // Check if any steps have wildcards
    let has_wildcards = workflow.steps.iter().any(|step| {
        wildcards::has_wildcards(&step.input.join(" "))
            || wildcards::has_wildcards(&step.output.join(" "))
    });

    if !has_wildcards {
        info!("No wildcards detected in workflow");
        return Ok(());
    }

    info!("Detected wildcards in workflow, preparing expansion...");

    // Build wildcard file mappings from all steps
    let mut wildcard_files: HashMap<String, Vec<String>> = HashMap::new();

    for step in &workflow.steps {
        // Merge this step's wildcard files into global map
        for (name, files) in &step.wildcard_files {
            wildcard_files
                .entry(name.clone())
                .or_insert_with(Vec::new)
                .extend(files.clone());
        }
    }

    // Remove duplicates
    for files in wildcard_files.values_mut() {
        files.sort();
        files.dedup();
    }

    info!("Wildcard file mappings:");
    for (name, files) in &wildcard_files {
        info!("  {{{}}} -> {} files", name, files.len());
    }

    // Perform expansion
    let original_count = workflow.steps.len();
    wildcards::expand_workflow_wildcards(workflow, &wildcard_files)?;
    let expanded_count = workflow.steps.len();

    info!(
        "Wildcard expansion: {} steps → {} steps ({} added)",
        original_count,
        expanded_count,
        expanded_count - original_count
    );

    Ok(())
}

/// Loads a workflow from a YAML file.
///
/// This function:
/// 1. Reads and parses the YAML file
/// 2. Populates dependencies (explicit or implicit)
/// 3. Validates the workflow structure
/// 4. Performs topological sort for execution order
///
/// # Arguments
///
/// * `path` - Path to the workflow YAML file
///
/// # Returns
///
/// * `Ok(Workflow)` - Successfully loaded and validated workflow
/// * `Err` - Parse or validation error
///
/// # Example
///
/// ```rust,no_run
/// use rustrunner::workflow::load_workflow;
///
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     let workflow = load_workflow("pipeline.yaml")?;
///     println!("Loaded {} steps", workflow.steps.len());
///     Ok(())
/// }
/// ```
pub fn load_workflow(path: &str) -> Result<Workflow, Box<dyn Error>> {
    info!("Loading workflow from: {}", path);

    let yaml_content = fs::read_to_string(path).map_err(|e| {
        format!(
            "Failed to read workflow file '{}': {}. Check that the file exists and is readable.",
            path, e
        )
    })?;

    debug!("YAML content loaded ({} bytes)", yaml_content.len());

    let mut workflow: Workflow = serde_yaml::from_str(&yaml_content).map_err(|e| {
        format!(
            "Failed to parse workflow YAML: {}. Check the file format.",
            e
        )
    })?;

    info!(
        "Parsed {} steps, {} tools defined",
        workflow.steps.len(),
        workflow.tools.len()
    );

    // Populate dependencies based on structure
    populate_dependencies(&mut workflow)?;

    // Expand wildcards BEFORE validation
    expand_wildcards_in_workflow(&mut workflow)?;

    // Validate and sort
    validate_workflow(&mut workflow)?;

    Ok(workflow)
}

/// Populates step dependencies based on the workflow structure.
///
/// Supports two modes:
/// - **Explicit dependencies**: Steps have `previous`/`next` fields set (GUI mode)
/// - **Implicit dependencies**: Dependencies derived from input/output file matching (CLI mode)
pub fn populate_dependencies(workflow: &mut Workflow) -> Result<(), String> {
    // Check if explicit dependencies exist
    let has_explicit_deps = workflow
        .steps
        .iter()
        .any(|s| !s.previous.is_empty() || !s.next.is_empty());

    if has_explicit_deps {
        info!("Using explicit dependencies from workflow definition");
        validate_explicit_dependencies(workflow)?;
    } else {
        info!("Deriving dependencies from input/output file matching");
        derive_dependencies_from_files(workflow)?;
    }

    Ok(())
}

/// Validates that explicit dependencies are consistent and reference valid steps.
fn validate_explicit_dependencies(workflow: &Workflow) -> Result<(), String> {
    let step_ids: std::collections::HashSet<_> = workflow.steps.iter().map(|s| &s.id).collect();

    for step in &workflow.steps {
        // Check previous references
        for prev_id in &step.previous {
            if !step_ids.contains(prev_id) {
                return Err(format!(
                    "Step '{}' references unknown dependency: '{}'",
                    step.id, prev_id
                ));
            }
        }

        // Check next references
        for next_id in &step.next {
            if !step_ids.contains(next_id) {
                return Err(format!(
                    "Step '{}' references unknown dependent: '{}'",
                    step.id, next_id
                ));
            }
        }
    }

    // Verify bidirectional consistency
    for step in &workflow.steps {
        for next_id in &step.next {
            let next_step = workflow.steps.iter().find(|s| s.id == *next_id).unwrap();
            if !next_step.previous.contains(&step.id) {
                warn!(
                    "Inconsistency: {} -> {} but {} doesn't list {} as previous",
                    step.id, next_id, next_id, step.id
                );
            }
        }
    }

    info!("Explicit dependencies validated");
    Ok(())
}

/// Derives dependencies from input/output file matching.
///
/// If step A produces file X and step B requires file X as input,
/// then B depends on A.
fn derive_dependencies_from_files(workflow: &mut Workflow) -> Result<(), String> {
    // Clear existing dependencies
    for step in &mut workflow.steps {
        step.previous.clear();
        step.next.clear();
    }

    // Build output -> step mapping
    let mut output_to_step: HashMap<String, String> = HashMap::new();

    for step in &workflow.steps {
        for output in &step.output {
            // Handle comma-separated outputs
            for file in output.split(',').map(|s| s.trim()) {
                if !file.is_empty() {
                    if output_to_step.contains_key(file) {
                        return Err(format!(
                            "Multiple steps produce '{}': '{}' and '{}'",
                            file, output_to_step[file], step.id
                        ));
                    }
                    output_to_step.insert(file.to_string(), step.id.clone());
                }
            }
        }
    }

    // Build dependency maps
    let mut dependencies: HashMap<String, Vec<String>> = HashMap::new();
    let mut dependents: HashMap<String, Vec<String>> = HashMap::new();

    for step in &workflow.steps {
        for input in &step.input {
            for file in input.split(',').map(|s| s.trim()) {
                if let Some(producer_id) = output_to_step.get(file) {
                    dependencies
                        .entry(step.id.clone())
                        .or_default()
                        .push(producer_id.clone());

                    dependents
                        .entry(producer_id.clone())
                        .or_default()
                        .push(step.id.clone());
                }
            }
        }
    }

    // Apply dependencies to steps
    for step in &mut workflow.steps {
        if let Some(deps) = dependencies.get(&step.id) {
            step.previous = deps.clone();
            step.previous.sort();
            step.previous.dedup();
            debug!("Step '{}' depends on: {:?}", step.id, step.previous);
        }

        if let Some(nexts) = dependents.get(&step.id) {
            step.next = nexts.clone();
            step.next.sort();
            step.next.dedup();
            debug!("Step '{}' required by: {:?}", step.id, step.next);
        }
    }

    info!("Derived {} dependency relationships", dependencies.len());
    Ok(())
}

/// Saves a workflow to a YAML file.
///
/// # Arguments
///
/// * `workflow` - The workflow to save
/// * `path` - Output file path
pub fn save_workflow(workflow: &Workflow, path: &str) -> Result<(), Box<dyn Error>> {
    let yaml_content = serde_yaml::to_string(workflow)?;
    fs::write(path, yaml_content)?;
    info!("Workflow saved to: {}", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_dependencies() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("step1", "bash", "echo test")
                .with_output("intermediate.txt"),
            Step::new("step2", "bash", "cat {input}")
                .with_input("intermediate.txt")
                .with_output("final.txt"),
        ]);

        derive_dependencies_from_files(&mut workflow).unwrap();

        assert!(workflow.steps[1].previous.contains(&"step1".to_string()));
        assert!(workflow.steps[0].next.contains(&"step2".to_string()));
    }

    #[test]
    fn test_populate_dependencies_empty_workflow() {
        let mut workflow = Workflow::from_steps(vec![]);
        let result = populate_dependencies(&mut workflow);
        assert!(result.is_ok());
    }

    #[test]
    fn test_derive_dependencies_no_matches() {
        let step1 = Step::new("step1", "bash", "echo test")
            .with_output("file1.txt");
        let step2 = Step::new("step2", "bash", "echo test")
            .with_input("file2.txt");

        let mut workflow = Workflow::from_steps(vec![step1, step2]);
        derive_dependencies_from_files(&mut workflow).unwrap();

        assert!(workflow.steps[1].previous.is_empty());
        assert!(workflow.steps[0].next.is_empty());
    }

    #[test]
    fn test_derive_dependencies_chain() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("step1", "bash", "echo test")
                .with_output("file_a.txt"),
            Step::new("step2", "bash", "cat {input}")
                .with_input("file_a.txt")
                .with_output("file_b.txt"),
            Step::new("step3", "bash", "cat {input}")
                .with_input("file_b.txt")
                .with_output("file_c.txt"),
        ]);

        derive_dependencies_from_files(&mut workflow).unwrap();

        assert!(workflow.steps[1].previous.contains(&"step1".to_string()));
        assert!(workflow.steps[2].previous.contains(&"step2".to_string()));
        assert!(workflow.steps[0].next.contains(&"step2".to_string()));
        assert!(workflow.steps[1].next.contains(&"step3".to_string()));
    }

    #[test]
    fn test_validate_explicit_dependencies_invalid_reference() {
        let mut step1 = Step::new("step1", "bash", "echo test");
        step1.next = vec!["nonexistent".to_string()];

        let workflow = Workflow::from_steps(vec![step1]);
        let result = validate_explicit_dependencies(&workflow);

        assert!(result.is_err());
    }

    #[test]
    fn test_validate_explicit_dependencies_valid() {
        let mut step1 = Step::new("step1", "bash", "echo 1");
        let mut step2 = Step::new("step2", "bash", "echo 2");

        step1.next = vec!["step2".to_string()];
        step2.previous = vec!["step1".to_string()];

        let workflow = Workflow::from_steps(vec![step1, step2]);
        let result = validate_explicit_dependencies(&workflow);

        assert!(result.is_ok());
    }

    #[test]
    fn test_save_workflow() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let workflow_path = temp_dir.path().join("test.yaml");

        let workflow = Workflow::from_steps(vec![
            Step::new("step1", "bash", "echo test"),
        ]);

        let result = save_workflow(&workflow, workflow_path.to_str().unwrap());
        assert!(result.is_ok());
        assert!(workflow_path.exists());
    }

    #[test]
    fn test_load_workflow_file_not_found() {
        let result = load_workflow("/nonexistent/path/workflow.yaml");
        assert!(result.is_err());
    }

    #[test]
    fn test_load_workflow_valid_yaml() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let workflow_path = temp_dir.path().join("test_load.yaml");

        let yaml_content = r#"
steps:
  - id: step1
    tool: bash
    command: echo hello
    input: []
    output: []
    previous: []
    next: []
    threads: 1
"#;
        std::fs::write(&workflow_path, yaml_content).unwrap();

        let result = load_workflow(workflow_path.to_str().unwrap());
        assert!(result.is_ok());

        let workflow = result.unwrap();
        assert_eq!(workflow.steps.len(), 1);
        assert_eq!(workflow.steps[0].id, "step1");
    }

    #[test]
    fn test_load_workflow_invalid_yaml() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let workflow_path = temp_dir.path().join("bad.yaml");

        std::fs::write(&workflow_path, "this is not valid yaml: [[[").unwrap();

        let result = load_workflow(workflow_path.to_str().unwrap());
        assert!(result.is_err());
    }

    #[test]
    fn test_expand_wildcards_no_wildcards() {
        let mut workflow = Workflow::from_steps(vec![
            Step::new("step1", "bash", "echo test"),
        ]);

        let result = expand_wildcards_in_workflow(&mut workflow);
        assert!(result.is_ok());
        assert_eq!(workflow.steps.len(), 1);
    }
}
