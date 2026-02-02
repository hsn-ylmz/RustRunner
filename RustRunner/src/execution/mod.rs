//! Workflow Execution Module
//!
//! Provides the core execution engine for running workflow steps,
//! including parallel scheduling, resource management, and
//! pause/resume functionality.
//!
//! # Architecture
//!
//! - [`engine`]: Main execution engine orchestrating workflow runs
//! - [`step`]: Individual step execution logic

pub mod engine;
pub mod step;

pub use engine::Engine;
