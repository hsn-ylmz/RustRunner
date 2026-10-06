//! Workflow State Persistence
//!
//! Provides automatic state saving for workflow execution, enabling
//! resume functionality after interruption.
//!
//! State is saved to `.rustrunner/{workflow_name}.state` after each
//! step completion.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use log::info;
use serde::{Deserialize, Serialize};

use super::model::WorkflowMetadata;

/// Persistent state for a workflow execution.
///
/// Tracks which steps have completed and any failures,
/// allowing execution to resume from the last successful point.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkflowState {
    /// Path to the workflow file this state belongs to
    pub workflow_path: String,

    /// Set of step IDs that have completed successfully
    pub completed_steps: HashSet<String>,

    /// ID of the step that failed (if any)
    pub failed_step: Option<String>,

    /// Last time the state was updated
    pub timestamp: SystemTime,

    /// Number of attempts the most recent run of each step needed
    /// (absent in state files written before retries existed).
    #[serde(default)]
    pub step_attempts: HashMap<String, u32>,

    /// Name of the workflow the last run executed, from its metadata
    /// (absent in state files written before metadata existed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_name: Option<String>,

    /// Version of the workflow the last run executed, from its metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_version: Option<String>,

    /// Directory the `.rustrunner/` folder lives in; not persisted.
    #[serde(skip)]
    base_dir: Option<PathBuf>,
}

impl WorkflowState {
    /// Creates a new empty state for a workflow.
    pub fn new(workflow_path: &str) -> Self {
        Self {
            workflow_path: workflow_path.to_string(),
            completed_steps: HashSet::new(),
            failed_step: None,
            timestamp: SystemTime::now(),
            step_attempts: HashMap::new(),
            workflow_name: None,
            workflow_version: None,
            base_dir: None,
        }
    }

    /// Records the name and version of the workflow being run.
    pub fn set_metadata(&mut self, metadata: Option<&WorkflowMetadata>) {
        self.workflow_name = metadata.and_then(|m| m.name.clone());
        self.workflow_version = metadata.and_then(|m| m.version.clone());
    }

    /// Records how many attempts a step used.
    pub fn record_attempts(&mut self, step_id: &str, attempts: u32) {
        self.step_attempts.insert(step_id.to_string(), attempts);
    }

    /// Directs this state's file to `<dir>/.rustrunner/` instead of the
    /// current directory.
    pub fn in_dir(mut self, dir: Option<&Path>) -> Self {
        self.base_dir = dir.map(Path::to_path_buf);
        self
    }

    /// Saves the state to a file.
    ///
    /// State is saved to `.rustrunner/{workflow_stem}.state` in the base
    /// directory (the current directory unless set with [`Self::in_dir`]).
    pub fn save(&self) -> Result<(), Box<dyn Error>> {
        let state_file = self.state_file_path();
        if let Some(parent) = state_file.parent() {
            fs::create_dir_all(parent)?;
        }

        let json = serde_json::to_string_pretty(self)?;
        fs::write(&state_file, json)?;

        info!("Saved workflow state to {}", state_file.display());
        Ok(())
    }

    /// Loads state from the current directory.
    ///
    /// Returns an error if no state file exists or it can't be read.
    pub fn load(workflow_path: &str) -> Result<Self, Box<dyn Error>> {
        Self::load_in(workflow_path, None)
    }

    /// Loads state from `<dir>/.rustrunner/` (the current directory when
    /// `dir` is `None`).
    pub fn load_in(workflow_path: &str, dir: Option<&Path>) -> Result<Self, Box<dyn Error>> {
        let state_file = Self::state_file_path_for(workflow_path, dir);

        let content = fs::read_to_string(&state_file)?;
        let state: WorkflowState = serde_json::from_str(&content)?;

        info!("Loaded workflow state from {}", state_file.display());
        info!("Previously completed: {:?}", state.completed_steps);

        Ok(state.in_dir(dir))
    }

    /// Returns true if a persisted state file exists for the given workflow.
    ///
    /// Lets callers distinguish "no prior run" (fresh start, expected) from
    /// "a state file exists but failed to load" (corrupt - worth a warning).
    pub fn state_file_exists(workflow_path: &str) -> bool {
        Self::state_file_exists_in(workflow_path, None)
    }

    /// Like [`Self::state_file_exists`], looking under `dir`.
    pub fn state_file_exists_in(workflow_path: &str, dir: Option<&Path>) -> bool {
        Self::state_file_path_for(workflow_path, dir).exists()
    }

    /// Returns the path to the state file.
    fn state_file_path(&self) -> PathBuf {
        Self::state_file_path_for(&self.workflow_path, self.base_dir.as_deref())
    }

    /// Returns the state file path for a given workflow path.
    fn state_file_path_for(workflow_path: &str, dir: Option<&Path>) -> PathBuf {
        let stem = Path::new(workflow_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("workflow");

        let relative = Path::new(".rustrunner").join(format!("{}.state", stem));
        match dir {
            Some(dir) => dir.join(relative),
            None => relative,
        }
    }

    /// Marks a step as completed.
    pub fn mark_completed(&mut self, step_id: &str) {
        self.completed_steps.insert(step_id.to_string());
        self.failed_step = None;
        self.timestamp = SystemTime::now();
    }

    /// Marks a step as failed.
    pub fn mark_failed(&mut self, step_id: &str) {
        self.failed_step = Some(step_id.to_string());
        self.timestamp = SystemTime::now();
    }

    /// Returns true if this state represents a resumed execution.
    pub fn is_resume(&self) -> bool {
        !self.completed_steps.is_empty() || self.failed_step.is_some()
    }

    /// Clears all state (for fresh start).
    pub fn clear(&mut self) {
        self.completed_steps.clear();
        self.failed_step = None;
        self.step_attempts.clear();
        self.timestamp = SystemTime::now();
    }

    /// Deletes the state file.
    pub fn delete(&self) -> Result<(), Box<dyn Error>> {
        let state_file = self.state_file_path();
        if state_file.exists() {
            fs::remove_file(&state_file)?;
            info!("Deleted state file: {}", state_file.display());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_state_creation() {
        let state = WorkflowState::new("test.yaml");
        assert_eq!(state.workflow_path, "test.yaml");
        assert!(state.completed_steps.is_empty());
        assert!(!state.is_resume());
    }

    #[test]
    fn test_record_attempts_roundtrip_and_old_state_compat() {
        let mut state = WorkflowState::new("t.yaml");
        state.record_attempts("align", 3);
        let json = serde_json::to_string(&state).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.step_attempts.get("align"), Some(&3));

        // A state file written before `step_attempts` existed still loads.
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value.as_object_mut().unwrap().remove("step_attempts");
        let old: WorkflowState = serde_json::from_value(value).unwrap();
        assert!(old.step_attempts.is_empty());
    }

    #[test]
    fn test_metadata_roundtrip_and_old_state_compat() {
        let mut state = WorkflowState::new("t.yaml");
        state.set_metadata(Some(&WorkflowMetadata::new(Some("qc"), Some("1.2"))));
        let json = serde_json::to_string(&state).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.workflow_name.as_deref(), Some("qc"));
        assert_eq!(loaded.workflow_version.as_deref(), Some("1.2"));

        state.set_metadata(None);
        let json = serde_json::to_string(&state).unwrap();
        assert!(!json.contains("workflow_name"));
        // State files written before metadata existed still load.
        let old: WorkflowState = serde_json::from_str(&json).unwrap();
        assert!(old.workflow_name.is_none() && old.workflow_version.is_none());
    }

    #[test]
    fn test_save_and_load_in_dir_round_trip() {
        let dir = tempdir().unwrap();
        let mut state = WorkflowState::new("/elsewhere/flow.yaml").in_dir(Some(dir.path()));
        state.mark_completed("a");
        state.save().unwrap();
        assert!(dir.path().join(".rustrunner/flow.state").exists());
        assert!(WorkflowState::state_file_exists_in(
            "flow.yaml",
            Some(dir.path())
        ));

        let loaded = WorkflowState::load_in("flow.yaml", Some(dir.path())).unwrap();
        assert!(loaded.completed_steps.contains("a"));
        // The loaded state keeps writing to the same directory.
        loaded.delete().unwrap();
        assert!(!dir.path().join(".rustrunner/flow.state").exists());
    }

    #[test]
    fn test_mark_completed() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_completed("step1");

        assert!(state.completed_steps.contains("step1"));
        assert!(state.is_resume());
    }

    #[test]
    fn test_mark_failed() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_failed("step2");

        assert_eq!(state.failed_step, Some("step2".to_string()));
        assert!(state.is_resume());
    }

    #[test]
    fn test_state_serialization_roundtrip() {
        // Test serialization/deserialization without filesystem cwd changes
        let mut state = WorkflowState::new("test_roundtrip.yaml");
        state.mark_completed("step1");
        state.mark_completed("step2");

        let json = serde_json::to_string_pretty(&state).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&json).unwrap();

        assert_eq!(loaded.completed_steps.len(), 2);
        assert!(loaded.completed_steps.contains("step1"));
        assert!(loaded.completed_steps.contains("step2"));
        assert_eq!(loaded.workflow_path, "test_roundtrip.yaml");
    }

    #[test]
    fn test_state_save_creates_dir() {
        let temp_dir = tempdir().unwrap();
        let rustrunner_dir = temp_dir.path().join(".rustrunner");

        // Manually write state file to temp location
        let mut state = WorkflowState::new("test_save.yaml");
        state.mark_completed("step1");

        fs::create_dir_all(&rustrunner_dir).unwrap();
        let state_file = rustrunner_dir.join("test_save.state");
        let json = serde_json::to_string_pretty(&state).unwrap();
        fs::write(&state_file, &json).unwrap();

        assert!(state_file.exists());

        // Read it back
        let content = fs::read_to_string(&state_file).unwrap();
        let loaded: WorkflowState = serde_json::from_str(&content).unwrap();
        assert!(loaded.completed_steps.contains("step1"));
    }

    #[test]
    fn test_state_delete_existing_file() {
        let temp_dir = tempdir().unwrap();
        let state_file = temp_dir.path().join("test.state");

        // Create a file
        fs::write(&state_file, "{}").unwrap();
        assert!(state_file.exists());

        // Delete it
        fs::remove_file(&state_file).unwrap();
        assert!(!state_file.exists());
    }

    #[test]
    fn test_state_clear() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_completed("step1");
        state.mark_failed("step2");

        state.clear();

        assert!(state.completed_steps.is_empty());
        assert!(state.failed_step.is_none());
        assert!(!state.is_resume());
    }

    #[test]
    fn test_state_failed_step_tracking() {
        let mut state = WorkflowState::new("test.yaml");

        state.mark_failed("step3");
        assert_eq!(state.failed_step, Some("step3".to_string()));
        assert!(state.is_resume());

        // Completing after failure should clear failed status
        state.mark_completed("step3");
        assert!(state.failed_step.is_none());
        assert!(state.completed_steps.contains("step3"));
    }

    #[test]
    fn test_state_multiple_completions() {
        let mut state = WorkflowState::new("test.yaml");

        state.mark_completed("step1");
        state.mark_completed("step2");
        state.mark_completed("step3");

        assert_eq!(state.completed_steps.len(), 3);
        assert!(state.is_resume());
    }

    #[test]
    fn test_state_load_nonexistent() {
        let result = WorkflowState::load("/nonexistent/path/workflow.yaml");
        assert!(result.is_err());
    }

    #[test]
    fn test_state_delete_nonexistent() {
        let state = WorkflowState::new("/nonexistent/workflow.yaml");
        // Should not error when deleting a non-existent file
        let result = state.delete();
        assert!(result.is_ok());
    }

    #[test]
    fn test_state_is_not_resume_when_empty() {
        let state = WorkflowState::new("test.yaml");
        assert!(!state.is_resume());
    }

    #[test]
    fn test_state_is_resume_with_failed() {
        let mut state = WorkflowState::new("test.yaml");
        state.mark_failed("step1");
        assert!(state.is_resume());
    }
}
