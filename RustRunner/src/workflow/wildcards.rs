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
const RESERVED_WILDCARD_NAMES: [&str; 5] = ["input", "output", "inputs", "outputs", "threads"];

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
        // Wildcards live in the input and output patterns, including those of
        // named slots (`reads1: data/{sample}_R1.fastq`).
        let patterns = step.pattern_entries();
        if !patterns.iter().any(|p| has_wildcards(p)) {
            // No wildcards, keep as-is
            expanded_steps.push(step.clone());
            continue;
        }

        // Extract wildcard names
        let mut wildcard_names = HashSet::new();
        for pattern in &patterns {
            wildcard_names.extend(extract_wildcard_names(pattern));
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

        // Extract wildcard values. A pattern such as `{sample}_R1.fastq` says
        // which part of each file name is the value.
        let wildcard_values = extract_values_for_patterns(files, wildcard_name, &patterns);

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

            // ... and in the files of every named input and output
            for slots in [&mut new_step.named_inputs, &mut new_step.named_outputs] {
                for files in slots.values_mut() {
                    for file in files.iter_mut() {
                        *file = substitute_wildcard(file, wildcard_name, value);
                    }
                }
            }

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

/// The literal text around `{name}` in the file-name part of `pattern`, when
/// the name occurs once and there is some literal text.
fn literal_around<'a>(pattern: &'a str, name: &str) -> Option<(&'a str, &'a str)> {
    let file_name = pattern.rsplit(['/', '\\']).next().unwrap_or(pattern);
    let token = format!("{{{}}}", name);
    if file_name.matches(&token).count() != 1 {
        return None;
    }
    let (prefix, suffix) = file_name.split_once(&token)?;
    (!prefix.is_empty() || !suffix.is_empty()).then_some((prefix, suffix))
}

/// The wildcard values of `files`, read off the step's patterns.
///
/// When a pattern's file name has literal text around `{name}` (for example
/// `{sample}_R1.fastq`) and every file name fits it, the part in place of
/// `{name}` is the value (`s1_R1.fastq` gives `s1`). If several patterns fit,
/// the one with the most literal text wins, because it is the most specific.
/// Otherwise the value is the file's stem, as in [`extract_wildcard_values`].
fn extract_values_for_patterns(files: &[String], name: &str, patterns: &[&String]) -> Vec<String> {
    let names: Vec<&str> = files
        .iter()
        .map(|f| {
            Path::new(f)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(f.as_str())
        })
        .collect();

    let mut best: Option<(usize, Vec<String>)> = None;
    for pattern in patterns {
        let Some((prefix, suffix)) = literal_around(pattern, name) else {
            continue;
        };
        let values: Option<Vec<String>> = names
            .iter()
            .map(|n| {
                let middle = n.strip_prefix(prefix)?.strip_suffix(suffix)?;
                (!middle.is_empty()).then(|| middle.to_string())
            })
            .collect();
        if let Some(values) = values {
            let weight = prefix.len() + suffix.len();
            if best.as_ref().is_none_or(|(w, _)| weight > *w) {
                best = Some((weight, values));
            }
        }
    }
    match best {
        Some((_, values)) if !values.is_empty() => values,
        _ => extract_wildcard_values(files),
    }
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

    // ---- named slots ----

    fn paired_step() -> Step {
        let mut step = Step::new("align", "bash", "run {r1} {r2} {ref} > {bam}")
            .with_named_input("r1", &["data/{sample}_R1.fastq"])
            .with_named_input("r2", &["data/{sample}_R2.fastq"])
            .with_named_input("ref", &["genome.fa"])
            .with_named_output("bam", &["out/{sample}.bam"]);
        step.wildcard_files.insert(
            "sample".to_string(),
            vec![
                "data/s1_R1.fastq".to_string(),
                "data/s2_R1.fastq".to_string(),
            ],
        );
        step
    }

    #[test]
    fn test_per_slot_patterns_expand_with_values_taken_from_the_pattern() {
        let mut wf = Workflow::from_steps(vec![paired_step()]);
        expand_workflow_wildcards(&mut wf, &HashMap::new()).unwrap();
        let ids: Vec<&str> = wf.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["align_s1", "align_s2"]);
        let s1 = &wf.steps[0];
        assert_eq!(s1.named_inputs["r1"], vec!["data/s1_R1.fastq"]);
        assert_eq!(s1.named_inputs["r2"], vec!["data/s1_R2.fastq"]);
        assert_eq!(s1.named_inputs["ref"], vec!["genome.fa"]);
        assert_eq!(s1.named_outputs["bam"], vec!["out/s1.bam"]);
        assert_eq!(wf.steps[1].named_outputs["bam"], vec!["out/s2.bam"]);
    }

    #[test]
    fn test_a_wildcard_only_in_a_slot_still_expands() {
        let mut step = Step::new("s", "bash", "cat {f}").with_named_input("f", &["{x}.txt"]);
        step.wildcard_files.insert(
            "x".to_string(),
            vec!["a.txt".to_string(), "b.txt".to_string()],
        );
        let mut wf = Workflow::from_steps(vec![step]);
        expand_workflow_wildcards(&mut wf, &HashMap::new()).unwrap();
        assert_eq!(wf.steps.len(), 2);
        assert_eq!(wf.steps[1].named_inputs["f"], vec!["b.txt"]);
    }

    #[test]
    fn test_two_wildcard_names_across_slots_are_rejected() {
        let mut step = Step::new("s", "bash", "cat {f} {g}")
            .with_named_input("f", &["{x}.txt"])
            .with_named_input("g", &["{y}.txt"]);
        step.wildcard_files
            .insert("x".to_string(), vec!["a.txt".to_string()]);
        step.wildcard_files
            .insert("y".to_string(), vec!["a.txt".to_string()]);
        let mut wf = Workflow::from_steps(vec![step]);
        let err = expand_workflow_wildcards(&mut wf, &HashMap::new()).unwrap_err();
        assert!(err.contains("Multiple wildcards"), "{err}");
    }

    #[test]
    fn test_most_specific_pattern_decides_the_values() {
        let files = vec!["d/s1_R1.fq".to_string(), "d/s2_R1.fq".to_string()];
        let broad = "d/{sample}.fq".to_string();
        let narrow = "d/{sample}_R1.fq".to_string();
        let values = extract_values_for_patterns(&files, "sample", &[&broad, &narrow]);
        assert_eq!(values, vec!["s1", "s2"]);
        // Order does not matter.
        let values = extract_values_for_patterns(&files, "sample", &[&narrow, &broad]);
        assert_eq!(values, vec!["s1", "s2"]);
    }

    #[test]
    fn test_values_fall_back_to_the_file_stem() {
        let files = vec!["d/a.fq".to_string(), "d/b.fq".to_string()];
        // No literal text around the name, or files that do not fit.
        for pattern in ["d/{sample}", "d/{sample}_R1.fq", "d/{other}.fq"] {
            let p = pattern.to_string();
            assert_eq!(
                extract_values_for_patterns(&files, "sample", &[&p]),
                vec!["a", "b"],
                "{pattern}"
            );
        }
        // One file that does not fit spoils the pattern for all of them.
        let mixed = vec!["d/a_R1.fq".to_string(), "d/b.fq".to_string()];
        let p = "d/{sample}_R1.fq".to_string();
        assert_eq!(
            extract_values_for_patterns(&mixed, "sample", &[&p]),
            vec!["a_R1", "b"]
        );
    }

    #[test]
    fn test_plain_patterns_keep_their_original_values() {
        // The same values as before per-slot patterns existed.
        let mut wf = Workflow::from_steps(vec![wildcard_step(
            "align",
            "sample",
            &["in/a.txt", "in/b.txt"],
        )]);
        expand_workflow_wildcards(&mut wf, &HashMap::new()).unwrap();
        assert_eq!(wf.steps[0].input, vec!["in/a.txt"]);
        assert_eq!(wf.steps[1].output, vec!["out/b.txt"]);
    }

    #[test]
    fn test_slot_patterns_with_a_path_separator_in_the_value_part() {
        // The pattern's directory is ignored when reading values.
        let files = vec!["/abs/dir/x_R1.fq".to_string()];
        let p = "other/{s}_R1.fq".to_string();
        assert_eq!(extract_values_for_patterns(&files, "s", &[&p]), vec!["x"]);
    }
}
