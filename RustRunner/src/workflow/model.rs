//! Workflow Data Model
//!
//! Core data structures representing workflow steps and their relationships.
//!
//! # Example YAML Format
//!
//! ```yaml
//! steps:
//!   - id: quality_control
//!     tool: fastqc
//!     command: fastqc {input} -o {output}
//!     input: raw_reads.fastq
//!     output: qc_report/
//!     threads: 2
//!
//!   - id: align_reads
//!     tool: bowtie2
//!     command: bowtie2 -x genome -U {input} -S {output}
//!     input: raw_reads.fastq
//!     output: aligned.sam
//!     previous:
//!       - quality_control
//!     threads: 8
//! ```

use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Represents a single step in a workflow.
///
/// Each step defines a command to execute, along with its inputs, outputs,
/// and dependencies on other steps.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Step {
    /// Unique identifier for this step (derived from label if using GUI)
    pub id: String,

    /// Tool or command to use (e.g., "bash", "bowtie2", "samtools")
    pub tool: String,

    /// Command template with placeholders
    /// Supported placeholders: {input}, {output}, {inputs}, {outputs}
    pub command: String,

    /// Input file(s) for this step
    #[serde(deserialize_with = "single_or_vec", default)]
    pub input: Vec<String>,

    /// Output file(s) produced by this step
    #[serde(deserialize_with = "single_or_vec", default)]
    pub output: Vec<String>,

    /// IDs of steps that must complete before this step can run
    #[serde(default)]
    pub previous: Vec<String>,

    /// IDs of steps that depend on this step (auto-populated)
    #[serde(default)]
    pub next: Vec<String>,

    /// Number of threads/cores this step requires
    #[serde(default = "default_threads")]
    pub threads: usize,

    /// Optional color for GUI visualization
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,

    /// Wildcard file mappings (wildcard_name -> list of concrete files)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub wildcard_files: HashMap<String, Vec<String>>,
}

/// Default thread count for steps that don't specify
fn default_threads() -> usize {
    1
}

/// Deserializes either a single string or array of strings into Vec<String>
fn single_or_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let val = Value::deserialize(deserializer)?;
    match val {
        Value::Null => Ok(Vec::new()),
        Value::String(s) if s.is_empty() => Ok(Vec::new()),
        Value::String(s) => Ok(vec![s]),
        Value::Array(arr) => arr
            .into_iter()
            .map(|v| match v {
                Value::String(s) => Ok(s),
                _ => Err(de::Error::custom("Expected string in array")),
            })
            .collect(),
        _ => Err(de::Error::custom("Expected string or array of strings")),
    }
}

impl Step {
    /// Creates a new Step with the given parameters.
    ///
    /// # Arguments
    ///
    /// * `id` - Unique identifier
    /// * `tool` - Tool name
    /// * `command` - Command template
    ///
    /// # Example
    ///
    /// ```
    /// use rustrunner::workflow::Step;
    ///
    /// let step = Step::new("align", "bowtie2", "bowtie2 -x ref {input} > {output}")
    ///     .with_input("reads.fastq")
    ///     .with_output("aligned.sam")
    ///     .with_threads(4);
    /// ```
    pub fn new(id: impl Into<String>, tool: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: id.into().trim().to_string(),
            tool: tool.into().trim().to_string(),
            command: command.into().trim().to_string(),
            input: Vec::new(),
            output: Vec::new(),
            previous: Vec::new(),
            next: Vec::new(),
            threads: 1,
            color: None,
            wildcard_files: HashMap::new(),
        }
    }

    /// Sets the input file(s) for this step.
    pub fn with_input(mut self, input: impl Into<String>) -> Self {
        self.input = vec![input.into()];
        self
    }

    /// Sets multiple input files for this step.
    pub fn with_inputs(mut self, inputs: Vec<String>) -> Self {
        self.input = inputs;
        self
    }

    /// Sets the output file(s) for this step.
    pub fn with_output(mut self, output: impl Into<String>) -> Self {
        self.output = vec![output.into()];
        self
    }

    /// Sets multiple output files for this step.
    pub fn with_outputs(mut self, outputs: Vec<String>) -> Self {
        self.output = outputs;
        self
    }

    /// Sets the thread count for this step.
    pub fn with_threads(mut self, threads: usize) -> Self {
        self.threads = threads;
        self
    }

    /// Adds a dependency on another step.
    pub fn depends_on(mut self, step_id: impl Into<String>) -> Self {
        self.previous.push(step_id.into());
        self
    }

    /// Checks if all output files exist.
    pub fn outputs_exist(&self) -> bool {
        if self.output.is_empty() {
            return false;
        }
        self.output.iter().all(|file| {
            // Handle comma-separated outputs
            file.split(',')
                .map(|f| f.trim())
                .filter(|f| !f.is_empty())
                .all(|f| Path::new(f).exists())
        })
    }

    /// Checks if outputs are outdated compared to inputs.
    ///
    /// Returns true if any input is newer than any output, or if outputs don't exist.
    pub fn outputs_outdated(&self) -> bool {
        use std::fs;

        if !self.outputs_exist() {
            return true;
        }

        // Get newest input modification time
        let newest_input = self
            .input
            .iter()
            .flat_map(|s| s.split(',').map(|f| f.trim().to_string()))
            .filter_map(|f| fs::metadata(&f).ok())
            .filter_map(|m| m.modified().ok())
            .max();

        // Get oldest output modification time
        let oldest_output = self
            .output
            .iter()
            .flat_map(|s| s.split(',').map(|f| f.trim().to_string()))
            .filter_map(|f| fs::metadata(&f).ok())
            .filter_map(|m| m.modified().ok())
            .min();

        match (newest_input, oldest_output) {
            (Some(input_time), Some(output_time)) => input_time > output_time,
            _ => true,
        }
    }

    /// Determines if this step should run based on output existence and freshness.
    pub fn should_run(&self, force: bool) -> bool {
        if force {
            return true;
        }
        !self.outputs_exist() || self.outputs_outdated()
    }

    /// Checks if this step has wildcard patterns
    pub fn has_wildcards(&self) -> bool {
        use crate::workflow::wildcards::has_wildcards;

        self.input.iter().any(|i| has_wildcards(i))
            || self.output.iter().any(|o| has_wildcards(o))
            || has_wildcards(&self.command)
    }

    /// Gets all wildcard names used in this step
    pub fn get_wildcard_names(&self) -> Vec<String> {
        use crate::workflow::wildcards::extract_wildcard_names;
        use std::collections::HashSet;

        let mut names = HashSet::new();

        for input in &self.input {
            names.extend(extract_wildcard_names(input));
        }
        for output in &self.output {
            names.extend(extract_wildcard_names(output));
        }

        names.into_iter().collect()
    }

    /// Validates wildcard configuration
    pub fn validate_wildcards(&self) -> Result<(), String> {
        if !self.has_wildcards() {
            return Ok(());
        }

        let wildcard_names = self.get_wildcard_names();

        for name in &wildcard_names {
            if !self.wildcard_files.contains_key(name) {
                return Err(format!(
                    "Step '{}': Wildcard '{{{}}}' has no file mapping",
                    self.id, name
                ));
            }
        }

        if wildcard_names.len() > 1 {
            return Err(format!(
                "Step '{}': Multiple wildcards not supported in v1.0",
                self.id
            ));
        }

        Ok(())
    }
}

/// Represents a complete workflow with multiple steps.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Workflow {
    /// Ordered list of steps in the workflow
    pub steps: Vec<Step>,

    /// List of unique tools used (auto-populated)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
}

impl Workflow {
    /// Creates a new empty workflow.
    pub fn new() -> Self {
        Self {
            steps: Vec::new(),
            tools: Vec::new(),
        }
    }

    /// Creates a workflow from a list of steps.
    pub fn from_steps(steps: Vec<Step>) -> Self {
        let mut workflow = Self {
            steps,
            tools: Vec::new(),
        };
        workflow.refresh_tools();
        workflow
    }

    /// Adds a step to the workflow.
    pub fn add_step(&mut self, step: Step) -> Result<(), String> {
        if self.steps.iter().any(|s| s.id == step.id) {
            return Err(format!("Step '{}' already exists", step.id));
        }
        self.steps.push(step);
        self.refresh_tools();
        Ok(())
    }

    /// Removes a step from the workflow.
    pub fn remove_step(&mut self, id: &str) -> Result<(), String> {
        let index = self
            .steps
            .iter()
            .position(|s| s.id == id)
            .ok_or_else(|| format!("Step '{}' not found", id))?;

        // Remove references to this step from other steps
        for step in &mut self.steps {
            step.previous.retain(|s| s != id);
            step.next.retain(|s| s != id);
        }

        self.steps.remove(index);
        self.refresh_tools();
        Ok(())
    }

    /// Gets a step by ID.
    pub fn get_step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    /// Gets a mutable reference to a step by ID.
    pub fn get_step_mut(&mut self, id: &str) -> Option<&mut Step> {
        self.steps.iter_mut().find(|s| s.id == id)
    }

    /// Returns steps with no dependencies (entry points).
    pub fn root_steps(&self) -> Vec<&Step> {
        self.steps.iter().filter(|s| s.previous.is_empty()).collect()
    }

    /// Returns steps with no dependents (exit points).
    pub fn leaf_steps(&self) -> Vec<&Step> {
        self.steps.iter().filter(|s| s.next.is_empty()).collect()
    }

    /// Updates the tools list based on steps.
    pub fn refresh_tools(&mut self) {
        let tool_set: HashSet<_> = self.steps.iter().map(|s| s.tool.clone()).collect();
        self.tools = tool_set.into_iter().collect();
        self.tools.sort();
    }

    /// Returns the number of steps in the workflow.
    pub fn len(&self) -> usize {
        self.steps.len()
    }

    /// Returns true if the workflow has no steps.
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
}

impl Default for Workflow {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_step_creation() {
        let step = Step::new("test", "bash", "echo hello")
            .with_input("input.txt")
            .with_output("output.txt")
            .with_threads(2);

        assert_eq!(step.id, "test");
        assert_eq!(step.tool, "bash");
        assert_eq!(step.threads, 2);
        assert_eq!(step.input, vec!["input.txt"]);
        assert_eq!(step.output, vec!["output.txt"]);
    }

    #[test]
    fn test_workflow_add_step() {
        let mut workflow = Workflow::new();
        let step = Step::new("step1", "bash", "echo test");

        assert!(workflow.add_step(step.clone()).is_ok());
        assert!(workflow.add_step(step).is_err()); // Duplicate
        assert_eq!(workflow.len(), 1);
    }

    #[test]
    fn test_workflow_root_leaf_detection() {
        let mut workflow = Workflow::new();
        workflow
            .add_step(Step::new("root", "bash", "echo root"))
            .unwrap();
        workflow
            .add_step(Step::new("leaf", "bash", "echo leaf").depends_on("root"))
            .unwrap();

        // Update next references
        if let Some(root) = workflow.get_step_mut("root") {
            root.next.push("leaf".to_string());
        }

        assert_eq!(workflow.root_steps().len(), 1);
        assert_eq!(workflow.leaf_steps().len(), 1);
        assert_eq!(workflow.root_steps()[0].id, "root");
        assert_eq!(workflow.leaf_steps()[0].id, "leaf");
    }

    #[test]
    fn test_step_outputs_exist() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let output_file = temp_dir.path().join("output.txt");
        std::fs::write(&output_file, "test").unwrap();

        let step = Step::new("test", "bash", "echo test")
            .with_output(output_file.to_str().unwrap());

        assert!(step.outputs_exist());
    }

    #[test]
    fn test_step_outputs_not_exist() {
        let step = Step::new("test", "bash", "echo test")
            .with_output("/nonexistent/path/file.txt");

        assert!(!step.outputs_exist());
    }

    #[test]
    fn test_step_outputs_empty() {
        let step = Step::new("test", "bash", "echo test");
        assert!(!step.outputs_exist());
    }

    #[test]
    fn test_step_outputs_outdated() {
        use tempfile::tempdir;
        use std::thread;
        use std::time::Duration;

        let temp_dir = tempdir().unwrap();
        let input_file = temp_dir.path().join("input.txt");
        let output_file = temp_dir.path().join("output.txt");

        // Create output first
        std::fs::write(&output_file, "output").unwrap();

        // Wait and create input (newer)
        thread::sleep(Duration::from_millis(100));
        std::fs::write(&input_file, "input").unwrap();

        let step = Step::new("test", "bash", "cat {input} > {output}")
            .with_input(input_file.to_str().unwrap())
            .with_output(output_file.to_str().unwrap());

        assert!(step.outputs_outdated());
    }

    #[test]
    fn test_step_should_run_force() {
        let step = Step::new("test", "bash", "echo test");
        assert!(step.should_run(true));
    }

    #[test]
    fn test_step_should_run_no_outputs() {
        let step = Step::new("test", "bash", "echo test")
            .with_output("/nonexistent/file.txt");
        assert!(step.should_run(false));
    }

    #[test]
    fn test_step_multiple_inputs_outputs() {
        let step = Step::new("test", "bash", "cat {inputs} > {output}")
            .with_inputs(vec!["file1.txt".to_string(), "file2.txt".to_string()])
            .with_outputs(vec!["out1.txt".to_string(), "out2.txt".to_string()]);

        assert_eq!(step.input.len(), 2);
        assert_eq!(step.output.len(), 2);
    }

    #[test]
    fn test_step_depends_on_multiple() {
        let step = Step::new("test", "bash", "echo test")
            .depends_on("parent1")
            .depends_on("parent2");

        assert_eq!(step.previous.len(), 2);
        assert!(step.previous.contains(&"parent1".to_string()));
        assert!(step.previous.contains(&"parent2".to_string()));
    }

    #[test]
    fn test_workflow_is_empty() {
        let workflow = Workflow::new();
        assert!(workflow.is_empty());
        assert_eq!(workflow.len(), 0);
    }

    #[test]
    fn test_workflow_not_empty() {
        let mut workflow = Workflow::new();
        workflow.add_step(Step::new("test", "bash", "echo test")).unwrap();

        assert!(!workflow.is_empty());
        assert_eq!(workflow.len(), 1);
    }

    #[test]
    fn test_workflow_get_step_mut() {
        let mut workflow = Workflow::new();
        workflow.add_step(Step::new("test", "bash", "echo test")).unwrap();

        let step_mut = workflow.get_step_mut("test");
        assert!(step_mut.is_some());

        step_mut.unwrap().command = "echo modified".to_string();

        assert_eq!(workflow.get_step("test").unwrap().command, "echo modified");
    }

    #[test]
    fn test_workflow_get_step_none() {
        let workflow = Workflow::new();
        assert!(workflow.get_step("nonexistent").is_none());
    }

    #[test]
    fn test_workflow_from_steps() {
        let steps = vec![
            Step::new("step1", "bash", "echo 1"),
            Step::new("step2", "python", "print(2)"),
        ];

        let workflow = Workflow::from_steps(steps);
        assert_eq!(workflow.len(), 2);
        assert_eq!(workflow.tools.len(), 2);
    }

    #[test]
    fn test_workflow_remove_step() {
        let mut workflow = Workflow::new();
        workflow.add_step(Step::new("step1", "bash", "echo 1")).unwrap();
        workflow.add_step(Step::new("step2", "bash", "echo 2")).unwrap();

        assert!(workflow.remove_step("step1").is_ok());
        assert_eq!(workflow.len(), 1);
        assert_eq!(workflow.steps[0].id, "step2");
    }

    #[test]
    fn test_workflow_remove_nonexistent_step() {
        let mut workflow = Workflow::new();
        assert!(workflow.remove_step("nonexistent").is_err());
    }

    #[test]
    fn test_workflow_remove_cleans_references() {
        let mut workflow = Workflow::new();
        let mut step1 = Step::new("step1", "bash", "echo 1");
        let mut step2 = Step::new("step2", "bash", "echo 2");

        step2.previous = vec!["step1".to_string()];
        step1.next = vec!["step2".to_string()];

        workflow.steps.push(step1);
        workflow.steps.push(step2);

        workflow.remove_step("step1").unwrap();
        assert!(workflow.steps[0].previous.is_empty());
    }

    #[test]
    fn test_workflow_refresh_tools() {
        let steps = vec![
            Step::new("step1", "bash", "echo 1"),
            Step::new("step2", "python", "print(2)"),
            Step::new("step3", "bash", "echo 3"),
        ];

        let workflow = Workflow::from_steps(steps);
        assert_eq!(workflow.tools.len(), 2);
        assert!(workflow.tools.contains(&"bash".to_string()));
        assert!(workflow.tools.contains(&"python".to_string()));
    }

    #[test]
    fn test_workflow_default() {
        let workflow = Workflow::default();
        assert!(workflow.is_empty());
    }

    #[test]
    fn test_step_has_wildcards() {
        let step = Step::new("test", "bash", "cat {sample}.fastq")
            .with_input("{sample}.fastq");
        assert!(step.has_wildcards());

        let step2 = Step::new("test2", "bash", "echo hello")
            .with_input("regular.txt");
        assert!(!step2.has_wildcards());
    }

    #[test]
    fn test_step_get_wildcard_names() {
        let step = Step::new("test", "bash", "cat {input}")
            .with_input("{sample}.fastq")
            .with_output("{sample}.bam");

        let names = step.get_wildcard_names();
        assert!(names.contains(&"sample".to_string()));
    }

    #[test]
    fn test_step_validate_wildcards_ok() {
        let mut step = Step::new("test", "bash", "cat {input}")
            .with_input("{sample}.fastq")
            .with_output("{sample}.bam");

        step.wildcard_files.insert(
            "sample".to_string(),
            vec!["s1.fastq".to_string(), "s2.fastq".to_string()],
        );

        assert!(step.validate_wildcards().is_ok());
    }

    #[test]
    fn test_step_validate_wildcards_missing_mapping() {
        let step = Step::new("test", "bash", "cat {input}")
            .with_input("{sample}.fastq")
            .with_output("{sample}.bam");

        let result = step.validate_wildcards();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no file mapping"));
    }

    #[test]
    fn test_step_validate_wildcards_none() {
        let step = Step::new("test", "bash", "echo hello");
        assert!(step.validate_wildcards().is_ok());
    }
}
