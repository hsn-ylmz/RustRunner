//! Environment Management Module
//!
//! Handles integration with conda/micromamba for managing
//! isolated bioinformatics tool environments.

pub mod conda;

pub use conda::{create_env, search_packages, ToolEnvMap, MICROMAMBA_PATH, ENV_MAP_PATH, MAMBA_ROOT_PREFIX};
