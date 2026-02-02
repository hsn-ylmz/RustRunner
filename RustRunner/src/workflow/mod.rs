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
//! - [`planner`]: Execution planning and scheduling

pub mod model;
pub mod parser;
pub mod planner;
pub mod state;
pub mod validator;
pub mod wildcards;

pub use model::{Step, Workflow};
pub use parser::load_workflow;
pub use planner::ExecutionPlanner;
pub use state::WorkflowState;
pub use wildcards::{
    expand_workflow_wildcards,
    extract_wildcard_values,
    generate_pattern,
    has_wildcards
};