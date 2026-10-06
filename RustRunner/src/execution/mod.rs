//! Workflow Execution Module
//!
//! Provides the core execution engine for running workflow steps,
//! including parallel scheduling, resource management, and
//! pause/resume functionality.
//!
//! # Architecture
//!
//! - [`engine`]: Main execution engine orchestrating workflow runs
//! - [`process`]: Process-group tracking and signal-driven termination
//! - [`step`]: Individual step execution logic
//! - [`tools`]: Shared system-tool classification

pub mod engine;
pub mod process;
pub mod step;
pub mod tools;

pub use engine::Engine;
