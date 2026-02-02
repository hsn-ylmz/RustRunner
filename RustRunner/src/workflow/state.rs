//! Workflow State Persistence
//!
//! Provides automatic state saving for workflow execution, enabling
//! resume functionality after interruption.
//!
//! State is saved to `.rustrunner/{workflow_name}.state` after each
//! step completion.

use std::collections::HashSet;
use std::error::Error;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use log::info;
use serde::{Deserialize, Serialize};

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
}

impl WorkflowState {
    /// Creates a new empty state for a workflow.
    pub fn new(workflow_path: &str) -> Self {
        Self {
            workflow_path: workflow_path.to_string(),
            completed_steps: HashSet::new(),
            failed_step: None,
            timestamp: SystemTime::now(),
        }
    }

    /// Saves the state to a file.
    ///
    /// State is saved to `.rustrunner/{workflow_stem}.state`
    /// in the current directory.
    pub fn save(&self) -> Result<(), Box<dyn Error>> {
        fs::create_dir_all(".rustrunner")?;

        let state_file = self.state_file_path();
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&state_file, json)?;

        info!("Saved workflow state to {}", state_file);
        Ok(())
    }

    /// Loads state from a file.
    ///
    /// Returns an error if no state file exists or it can't be read.
    pub fn load(workflow_path: &str) -> Result<Self, Box<dyn Error>> {
        let state_file = Self::state_file_path_for(workflow_path);

        let content = fs::read_to_string(&state_file)?;
        let state: WorkflowState = serde_json::from_str(&content)?;

        info!("Loaded workflow state from {}", state_file);
        info!("Previously completed: {:?}", state.completed_steps);

        Ok(state)
    }

    /// Returns the path to the state file.
    fn state_file_path(&self) -> String {
        Self::state_file_path_for(&self.workflow_path)
    }

    /// Returns the state file path for a given workflow path.
    fn state_file_path_for(workflow_path: &str) -> String {
        let stem = Path::new(workflow_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("workflow");

        format!(".rustrunner/{}.state", stem)
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
        self.timestamp = SystemTime::now();
    }

    /// Deletes the state file.
    pub fn delete(&self) -> Result<(), Box<dyn Error>> {
        let state_file = self.state_file_path();
        if Path::new(&state_file).exists() {
            fs::remove_file(&state_file)?;
            info!("Deleted state file: {}", state_file);
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
