//! Wildcard Pattern Detection and Expansion
//!
//! Simple wildcard system for v1.0:
//! - Detects patterns by removing file extensions
//! - Expands `{sample}` patterns into concrete file paths
//! - Generates multiple steps from one wildcard step

use log::{debug, info};
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::workflow::Workflow;

/// Names that denote command placeholders and so cannot name a wildcard.
const RESERVED_WILDCARD_NAMES: [&str; 4] = ["input", "output", "inputs", "outputs"];

/// Extracts wildcard values from a list of file paths.
///
/// Algorithm:
/// 1. Remove common extension
/// 2. Use remaining part as wildcard value
///
/// # Example
/// ```
/// use rustrunner::workflow::wildcards::extract_wildcard_values;
///
/// let files = vec!["sample1.fastq".to_string(), "sample2.fastq".to_string(), "sample3.fastq".to_string()];
/// let wildcards = extract_wildcard_values(&files);
/// assert_eq!(wildcards, vec!["sample1", "sample2", "sample3"]);
/// ```
pub fn extract_wildcard_values(files: &[String]) -> Vec<String> {
    if files.is_empty() {
        return Vec::new();
    }

    // Find common extension
    let extensions: Vec<_> = files
        .iter()
        .filter_map(|f| Path::new(f).extension())
        .filter_map(|e| e.to_str())
        .collect();

    let common_ext = if !extensions.is_empty() && extensions.windows(2).all(|w| w[0] == w[1]) {
        Some(extensions[0])
    } else {
        None
    };

    // Extract wildcard values (filename stem only, without directory or extension)
    files
        .iter()
        .map(|file| {
            let path = Path::new(file);
            if common_ext.is_some() {
                // Return just the file stem (no directory, no extension)
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(file)
                    .to_string()
            } else {
                // No common extension, use just the filename
                path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(file)
                    .to_string()
            }
        })
        .collect()
}

/// Generates a pattern string from files.
///
/// # Example
/// ```
/// use rustrunner::workflow::wildcards::generate_pattern;
///
/// let files = vec!["sample1.fastq".to_string(), "sample2.fastq".to_string()];
/// let pattern = generate_pattern(&files, "sample");
/// assert_eq!(pattern, Some("{sample}.fastq".to_string()));
/// ```
pub fn generate_pattern(files: &[String], wildcard_name: &str) -> Option<String> {
    if files.is_empty() {
        return None;
    }

    let first = &files[0];
    let path = Path::new(first);

    // Get extension
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    // Get directory
    let dir = path
        .parent()
        .and_then(|p| p.to_str())
        .filter(|s| !s.is_empty())
        .map(|s| format!("{}/", s))
        .unwrap_or_default();

    Some(format!("{}{{{}}}{}", dir, wildcard_name, ext))
}

/// Checks if a string contains wildcard syntax.
pub fn has_wildcards(text: &str) -> bool {
    text.contains('{') && text.contains('}')
}

/// Extracts wildcard names from a pattern.
///
/// # Example
/// ```
/// use rustrunner::workflow::wildcards::extract_wildcard_names;
///
/// let pattern = "reads/{sample}.fastq";
/// let names = extract_wildcard_names(pattern);
/// assert_eq!(names, vec!["sample"]);
/// ```
pub fn extract_wildcard_names(pattern: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut in_wildcard = false;
    let mut current_name = String::new();

    for ch in pattern.chars() {
        match ch {
            '{' => {
                in_wildcard = true;
                current_name.clear();
            }
            '}' => {
                if in_wildcard && !current_name.is_empty() {
                    names.push(current_name.clone());
                    current_name.clear();
                }
                in_wildcard = false;
            }
            _ => {
                if in_wildcard {
                    current_name.push(ch);
                }
            }
        }
    }

    names
}

/// Expands wildcard steps in a workflow into concrete steps.
///
/// For each step with wildcards in input/output:
/// 1. Detect wildcard names
/// 2. Find matching files (user must have specified these via GUI)
/// 3. Create one concrete step per wildcard value
///
/// # Arguments
///
/// * `workflow` - The workflow to expand
/// * `wildcard_files` - Workflow-wide fallback map of wildcard names to
///   concrete file lists. A step's own `wildcard_files` entry for the same
///   name always wins, so two steps may use the same wildcard name with
///   different file sets, or different names altogether.
pub fn expand_workflow_wildcards(
    workflow: &mut Workflow,
    wildcard_files: &HashMap<String, Vec<String>>,
) -> Result<(), String> {
    info!("Expanding wildcard steps...");

    let mut expanded_steps = Vec::new();

    for step in &workflow.steps {
        // Check if step has wildcards
        let has_input_wildcards = step.input.iter().any(|i| has_wildcards(i));
        let has_output_wildcards = step.output.iter().any(|o| has_wildcards(o));

        if !has_input_wildcards && !has_output_wildcards {
            // No wildcards, keep as-is
            expanded_steps.push(step.clone());
            continue;
        }

        // Extract wildcard names
        let mut wildcard_names = HashSet::new();
        for input in &step.input {
            wildcard_names.extend(extract_wildcard_names(input));
        }
        for output in &step.output {
            wildcard_names.extend(extract_wildcard_names(output));
        }

        if wildcard_names.is_empty() {
            expanded_steps.push(step.clone());
            continue;
        }

        // For v1, we only support a single wildcard per step
        if wildcard_names.len() > 1 {
            return Err(format!(
                "Step '{}': Multiple wildcards not supported in v1 (found: {:?})",
                step.id, wildcard_names
            ));
        }

        let wildcard_name = wildcard_names.iter().next().unwrap();

        // `{input}` / `{output}` are command placeholders; a wildcard with one
        // of those names would silently rewrite the command.
        if RESERVED_WILDCARD_NAMES.contains(&wildcard_name.as_str()) {
            return Err(format!(
                "Step '{}': '{{{}}}' is a command placeholder and cannot be used as a wildcard name",
                step.id, wildcard_name
            ));
        }

        // Get the files for this wildcard: the step's own mapping first, then
        // the workflow-wide fallback.
        let files = step
            .wildcard_files
            .get(wildcard_name)
            .or_else(|| wildcard_files.get(wildcard_name))
            .ok_or_else(|| {
                format!(
                    "Step '{}': No files provided for wildcard '{{{}}}'",
                    step.id, wildcard_name
                )
            })?;

        // Extract wildcard values
        let wildcard_values = extract_wildcard_values(files);

        info!(
            "Expanding step '{}' with wildcard '{{{}}}' into {} instances",
            step.id,
            wildcard_name,
            wildcard_values.len()
        );

        // Create one step per wildcard value
        for value in wildcard_values.iter() {
            let mut new_step = step.clone();

            // Update step ID
            new_step.id = format!("{}_{}", step.id, value);

            // Substitute wildcards in inputs
            new_step.input = step
                .input
                .iter()
                .map(|input| substitute_wildcard(input, wildcard_name, value))
                .collect();

            // Substitute wildcards in outputs
            new_step.output = step
                .output
                .iter()
                .map(|output| substitute_wildcard(output, wildcard_name, value))
                .collect();

            // Substitute wildcards in check targets so they keep matching
            // the expanded outputs
            for check in &mut new_step.checks {
                if let Some(target) = check.target.as_mut() {
                    *target = substitute_wildcard(target, wildcard_name, value);
                }
            }

            // Substitute wildcards in command
            new_step.command = substitute_wildcard(&step.command, wildcard_name, value);

            // Update dependencies
            new_step.previous = step
                .previous
                .iter()
                .map(|dep| {
                    // If dependency also had wildcards, update reference
                    format!("{}_{}", dep, value)
                })
                .collect();

            new_step.next = step
                .next
                .iter()
                .map(|dep| format!("{}_{}", dep, value))
                .collect();

            debug!(
                "  Created step '{}' with input={:?}, output={:?}",
                new_step.id, new_step.input, new_step.output
            );

            expanded_steps.push(new_step);
        }
    }

    workflow.steps = expanded_steps;
    info!(
        "Wildcard expansion complete: {} total steps",
        workflow.steps.len()
    );

    Ok(())
}

/// Substitutes a wildcard in a string with a concrete value.
fn substitute_wildcard(text: &str, wildcard_name: &str, value: &str) -> String {
    text.replace(&format!("{{{}}}", wildcard_name), value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{CheckKind, OutputCheck, Step};

    #[test]
    fn test_expansion_substitutes_check_targets() {
        let step = Step::new("count", "bash", "wc -l {input} > {output}")
            .with_input("{sample}.txt")
            .with_output("{sample}.cnt")
            .with_check(OutputCheck::new(CheckKind::Exists).with_target("{sample}.cnt"));
        let mut wf = Workflow::from_steps(vec![step]);
        let mut files = HashMap::new();
        files.insert(
            "sample".to_string(),
            vec!["a.txt".to_string(), "b.txt".to_string()],
        );
        expand_workflow_wildcards(&mut wf, &files).unwrap();
        assert_eq!(wf.steps.len(), 2);
        for s in &wf.steps {
            let target = s.checks[0].target.clone().unwrap();
            assert_eq!(vec![target], s.output);
        }
    }

    fn wildcard_step(id: &str, name: &str, files: &[&str]) -> Step {
        let mut step = Step::new(id, "bash", "cat {input} > {output}")
            .with_input(format!("in/{{{}}}.txt", name))
            .with_output(format!("out/{{{}}}.txt", name));
        step.wildcard_files.insert(
            name.to_string(),
            files.iter().map(|f| f.to_string()).collect(),
        );
        step
    }

    #[test]
    fn test_distinct_wildcard_names_expand_independently() {
        let mut wf = Workflow::from_steps(vec![
            wildcard_step("align", "sample", &["a.txt", "b.txt"]),
            wildcard_step("merge", "lane", &["l1.txt", "l2.txt", "l3.txt"]),
        ]);
        expand_workflow_wildcards(&mut wf, &HashMap::new()).unwrap();
        let ids: Vec<&str> = wf.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["align_a", "align_b", "merge_l1", "merge_l2", "merge_l3"]
        );
        assert_eq!(wf.steps[2].input, vec!["in/l1.txt"]);
        assert_eq!(wf.steps[0].output, vec!["out/a.txt"]);
    }

    #[test]
    fn test_same_wildcard_name_keeps_per_step_files() {
        let mut wf = Workflow::from_steps(vec![
            wildcard_step("one", "sample", &["a.txt"]),
            wildcard_step("two", "sample", &["x.txt", "y.txt"]),
        ]);
        // The workflow-wide map is the union of both, as the parser builds it.
        let mut merged = HashMap::new();
        merged.insert(
            "sample".to_string(),
            vec![
                "a.txt".to_string(),
                "x.txt".to_string(),
                "y.txt".to_string(),
            ],
        );
        expand_workflow_wildcards(&mut wf, &merged).unwrap();
        let ids: Vec<&str> = wf.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["one_a", "two_x", "two_y"]);
    }

    #[test]
    fn test_reserved_wildcard_name_is_rejected() {
        let mut wf = Workflow::from_steps(vec![wildcard_step("s", "input", &["a.txt"])]);
        let err = expand_workflow_wildcards(&mut wf, &HashMap::new()).unwrap_err();
        assert!(err.contains("command placeholder"), "{}", err);
    }

    #[test]
    fn test_extract_wildcard_values() {
        let files = vec![
            "sample1.fastq".to_string(),
            "sample2.fastq".to_string(),
            "sample3.fastq".to_string(),
        ];

        let values = extract_wildcard_values(&files);
        assert_eq!(values, vec!["sample1", "sample2", "sample3"]);
    }

    #[test]
    fn test_generate_pattern() {
        let files = vec![
            "reads/sample1.fastq".to_string(),
            "reads/sample2.fastq".to_string(),
        ];

        let pattern = generate_pattern(&files, "sample").unwrap();
        assert_eq!(pattern, "reads/{sample}.fastq");
    }

    #[test]
    fn test_has_wildcards() {
        assert!(has_wildcards("{sample}.fastq"));
        assert!(has_wildcards("output/{id}.txt"));
        assert!(!has_wildcards("regular_file.txt"));
    }

    #[test]
    fn test_extract_wildcard_names() {
        let names = extract_wildcard_names("reads/{sample}.fastq");
        assert_eq!(names, vec!["sample"]);

        let names = extract_wildcard_names("{id}_{replicate}.txt");
        assert_eq!(names, vec!["id", "replicate"]);
    }

    #[test]
    fn test_substitute_wildcard() {
        let result = substitute_wildcard("reads/{sample}.fastq", "sample", "sample1");
        assert_eq!(result, "reads/sample1.fastq");
    }
}
