//! Environment Management Module
//!
//! Handles integration with conda/micromamba for managing
//! isolated bioinformatics tool environments.

pub mod conda;
pub mod install;

pub use conda::{
    create_env, create_env_with, search_packages, ToolEnvMap, ENV_MAP_PATH, MAMBA_ROOT_PREFIX,
    MICROMAMBA_PATH,
};
pub use install::Install;
