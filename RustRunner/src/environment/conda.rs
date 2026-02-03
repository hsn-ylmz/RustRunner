//! Conda/Micromamba Environment Management
//!
//! Provides integration with micromamba for managing isolated
//! bioinformatics tool environments.
//!
//! # Environment Resolution Priority
//!
//! Micromamba binary is resolved in the following order:
//! 1. Development path: `{project_root}/runtime/micromamba`
//! 2. Production path: Next to the rustrunner executable
//! 3. System PATH: Falls back to system-installed micromamba

use std::collections::HashMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use log::{debug, error, info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

/// Lazily-initialized path to the environment mapping file.
pub static ENV_MAP_PATH: Lazy<PathBuf> = Lazy::new(|| {
    // Priority 1: Production environment (next to executable)
    // Check this first to ensure packaged apps use their bundled env_map
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let prod_path = exe_dir.join("env_map.json");
            if prod_path.exists() {
                info!("Using production env_map: {}", prod_path.display());
                return prod_path;
            }
        }
    }

    // Priority 2: Development environment (only if production not found)
    // This is used when running via `cargo run` during development
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("runtime")
        .join("env_map.json");

    if dev_path.exists() {
        info!("Using development env_map: {}", dev_path.display());
        return dev_path;
    }

    // Priority 3: Current working directory
    let cwd_path = PathBuf::from("env_map.json");
    info!("Using CWD env_map: {}", cwd_path.display());
    cwd_path
});

/// Lazily-initialized path to the micromamba binary.
pub static MICROMAMBA_PATH: Lazy<PathBuf> = Lazy::new(|| {
    // Priority 1: Production environment (next to executable)
    // Check this first to ensure packaged apps use their bundled micromamba
    let exe_path = std::env::current_exe().expect("Failed to get current executable path");
    let exe_dir = exe_path.parent().expect("Executable must be in a directory");
    let prod_path = exe_dir.join("micromamba");

    if prod_path.exists() {
        info!("Using production micromamba: {}", prod_path.display());
        return prod_path;
    }

    // Priority 2: Development environment (only if production not found)
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("runtime")
        .join("micromamba");

    if dev_path.exists() {
        info!("Using development micromamba: {}", dev_path.display());
        return dev_path;
    }

    // Priority 3: System PATH
    if let Ok(output) = Command::new("which").arg("micromamba").output() {
        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                let system_path = PathBuf::from(path_str);
                info!("Using system micromamba: {}", system_path.display());
                return system_path;
            }
        }
    }

    // Not found
    warn!("Micromamba binary not found");
    warn!("  Searched: {}", prod_path.display());
    warn!("  Searched: {}", dev_path.display());
    warn!("  Searched: system PATH");
    warn!("  Download from: https://micro.mamba.pm/");

    prod_path
});

/// Lazily-initialized path to the micromamba root prefix (where environments are stored).
/// This ensures the app uses its own isolated environment directory, not the system's.
pub static MAMBA_ROOT_PREFIX: Lazy<PathBuf> = Lazy::new(|| {
    // Use app-specific directory in user's home for environments
    // This keeps environments isolated per-app and persists across updates
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());

    let prefix = PathBuf::from(home)
        .join(".rustrunner")
        .join("micromamba");

    // Create the directory if it doesn't exist
    if !prefix.exists() {
        if let Err(e) = fs::create_dir_all(&prefix) {
            warn!("Failed to create micromamba root prefix: {}", e);
        }
    }

    info!("Using micromamba root prefix: {}", prefix.display());
    prefix
});

/// Creates a Command configured with the correct MAMBA_ROOT_PREFIX environment variable.
fn micromamba_command() -> Command {
    let mut cmd = Command::new(&*MICROMAMBA_PATH);
    cmd.env("MAMBA_ROOT_PREFIX", &*MAMBA_ROOT_PREFIX);
    cmd
}

/// Mapping of tool names to conda environment names.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ToolEnvMap {
    map: HashMap<String, String>,
}

impl ToolEnvMap {
    /// Creates a new empty mapping.
    pub fn new() -> Self {
        Self {
            map: HashMap::new(),
        }
    }

    /// Loads the mapping from disk.
    pub fn load() -> Self {
        if ENV_MAP_PATH.exists() {
            let content = fs::read_to_string(&*ENV_MAP_PATH).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or_else(|_| Self::new())
        } else {
            Self::new()
        }
    }

    /// Saves the mapping to disk.
    pub fn save(&self) -> Result<(), Box<dyn Error>> {
        if let Some(parent) = ENV_MAP_PATH.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&*ENV_MAP_PATH, json)?;
        Ok(())
    }

    /// Gets the environment name for a tool.
    pub fn get(&self, tool: &str) -> Option<&String> {
        self.map.get(tool)
    }

    /// Sets the environment for a tool.
    pub fn set(&mut self, tool: impl Into<String>, env: impl Into<String>) {
        self.map.insert(tool.into(), env.into());
    }

    /// Returns the internal map.
    pub fn as_map(&self) -> &HashMap<String, String> {
        &self.map
    }
}

impl Default for ToolEnvMap {
    fn default() -> Self {
        Self::new()
    }
}

/// Checks whether a micromamba environment exists.
fn check_env(env_name: &str) -> Result<bool, Box<dyn Error>> {
    let output = micromamba_command()
        .arg("env")
        .arg("list")
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("Failed to list environments: {}", stderr);
        return Err("Failed to list micromamba environments".into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let exists = stdout.lines().any(|line| {
        matches!(line.split_whitespace().next(), Some(name) if name == env_name)
    });

    Ok(exists)
}

/// Creates a new micromamba environment with specified tools.
///
/// If the environment already exists, this function returns immediately.
///
/// # Arguments
///
/// * `env_name` - Name for the new environment
/// * `tools` - Tools to install (e.g., ["bowtie2", "samtools=1.17"])
///
/// # Example
///
/// ```rust,no_run
/// use rustrunner::environment::conda::create_env;
///
/// fn main() -> Result<(), Box<dyn std::error::Error>> {
///     create_env("alignment_env", &["bowtie2".to_string(), "samtools".to_string()])?;
///     Ok(())
/// }
/// ```
pub fn create_env(env_name: &str, tools: &[String]) -> Result<(), Box<dyn Error>> {
    debug!("Checking for environment: {}", env_name);

    if check_env(env_name)? {
        info!("Environment '{}' already exists", env_name);
        return Ok(());
    }

    info!(
        "Creating environment '{}' with tools: {:?}",
        env_name, tools
    );

    let output = micromamba_command()
        .arg("create")
        .arg("-y")
        .arg("-n")
        .arg(env_name)
        .arg("-c")
        .arg("bioconda")
        .arg("-c")
        .arg("conda-forge")
        .args(tools)
        .output()?;

    if output.status.success() {
        info!("Successfully created environment '{}'", env_name);
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("Failed to create environment '{}': {}", env_name, stderr);
        Err(format!("Failed to create environment '{}'", env_name).into())
    }
}

/// Searches for packages in conda repositories.
///
/// # Arguments
///
/// * `query` - Search term
/// * `channel` - Channel to search (default: "bioconda")
///
/// # Returns
///
/// List of matching package names with versions
pub fn search_packages(query: &str, channel: Option<&str>) -> Result<Vec<String>, Box<dyn Error>> {
    let channel = channel.unwrap_or("bioconda");

    let output = micromamba_command()
        .arg("search")
        .arg("-c")
        .arg(channel)
        .arg(query)
        .output()?;

    if !output.status.success() {
        debug!("Search returned no results for '{}'", query);
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let packages: Vec<String> = stdout
        .lines()
        .skip(2) // Skip header
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                Some(format!("{}={}", parts[0], parts[1]))
            } else {
                None
            }
        })
        .collect();

    Ok(packages)
}

/// Lists packages installed in an environment.
pub fn list_packages(env_name: &str) -> Result<Vec<String>, Box<dyn Error>> {
    let output = micromamba_command()
        .arg("list")
        .arg("-n")
        .arg(env_name)
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to list packages: {}", stderr).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let packages: Vec<String> = stdout
        .lines()
        .skip(3) // Skip header
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                Some(format!("{}={}", parts[0], parts[1]))
            } else {
                None
            }
        })
        .collect();

    Ok(packages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_env_map_new() {
        let map = ToolEnvMap::new();
        assert!(map.map.is_empty());
    }

    #[test]
    fn test_tool_env_map_set_get() {
        let mut map = ToolEnvMap::new();
        map.set("bowtie2", "alignment_env");

        assert_eq!(map.get("bowtie2"), Some(&"alignment_env".to_string()));
        assert_eq!(map.get("unknown"), None);
    }

    #[test]
    fn test_tool_env_map_as_map() {
        let mut map = ToolEnvMap::new();
        map.set("tool1", "env1");
        map.set("tool2", "env2");

        let inner_map = map.as_map();
        assert_eq!(inner_map.len(), 2);
        assert_eq!(inner_map.get("tool1"), Some(&"env1".to_string()));
        assert_eq!(inner_map.get("tool2"), Some(&"env2".to_string()));
    }

    #[test]
    fn test_tool_env_map_empty() {
        let map = ToolEnvMap::new();
        assert_eq!(map.as_map().len(), 0);
        assert!(map.get("nonexistent").is_none());
    }

    #[test]
    fn test_tool_env_map_overwrite() {
        let mut map = ToolEnvMap::new();
        map.set("tool", "env1");
        map.set("tool", "env2");

        assert_eq!(map.get("tool"), Some(&"env2".to_string()));
        assert_eq!(map.as_map().len(), 1);
    }

    #[test]
    fn test_tool_env_map_default() {
        let map = ToolEnvMap::default();
        assert!(map.as_map().is_empty());
    }

    #[test]
    fn test_tool_env_map_multiple_tools_same_env() {
        let mut map = ToolEnvMap::new();
        map.set("bowtie2", "alignment_env");
        map.set("samtools", "alignment_env");

        assert_eq!(map.get("bowtie2"), Some(&"alignment_env".to_string()));
        assert_eq!(map.get("samtools"), Some(&"alignment_env".to_string()));
        assert_eq!(map.as_map().len(), 2);
    }

    #[test]
    fn test_tool_env_map_clone() {
        let mut map = ToolEnvMap::new();
        map.set("tool1", "env1");

        let cloned = map.clone();
        assert_eq!(cloned.get("tool1"), Some(&"env1".to_string()));

        // Modify original - clone should not change
        map.set("tool1", "env2");
        assert_eq!(cloned.get("tool1"), Some(&"env1".to_string()));
    }
}
