//! Workflow Definition Module
//!
//! Provides data structures and utilities for defining, parsing, and
//! validating computational workflows.
//!
//! # Structure
//!
//! - [`model`]: Core data structures (Step, Workflow)
//! - [`parser`]: YAML parsing and loading
//! - [`validator`]: Validation rules and dependency checking
//! - [`slots`]: Command placeholders and named file slots
//! - [`resources`]: Files that ship with the app, used as `{app_resource:path}`
//! - [`freshness`]: Up-to-date checks that decide which steps can be skipped
//! - [`planner`]: Execution planning and scheduling

pub mod freshness;
pub mod model;
pub mod parser;
pub mod planner;
pub mod resources;
pub mod slots;
pub mod state;
pub mod validator;
pub mod wildcards;

pub use freshness::{assess, definition_hash, StaleReason};
pub use model::{CheckKind, OutputCheck, RetryBackoff, Step, Workflow, WorkflowMetadata};
pub use parser::load_workflow;
pub use planner::ExecutionPlanner;
pub use state::WorkflowState;
pub use wildcards::{
    expand_workflow_wildcards, extract_wildcard_values, generate_pattern, has_wildcards,
};
