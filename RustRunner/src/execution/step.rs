//! Individual Step Execution
//!
//! Handles the execution of a single workflow step including:
//! - Command placeholder substitution
//! - Script generation
//! - Environment activation (conda/system)
//! - Output directory creation

use std::collections::HashMap;
use std::error::Error;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use log::{debug, error, warn};

use crate::environment::conda::MICROMAMBA_PATH;
use crate::workflow::Step;

/// Tools available in standard system PATH that don't require conda.
const SYSTEM_TOOLS: &[&str] = &[
    "bash", "sh", "echo", "cat", "cp", "mv", "rm", "mkdir", "sleep", "touch", "ls", "grep", "sed",
    "awk", "head", "tail", "sort", "uniq", "wc", "cut", "tr", "tee", "curl", "wget", "gzip", 
    "gunzip", "tar", "zip", "unzip", "bc", "date", "find", "xargs", "diff", "comm", "paste",
    "rev", "fold", "printf", "test", "true", "false",
];

/// Executes a single workflow step.
///
/// This function handles:
/// - Command placeholder resolution ({input}, {output})
/// - Temporary script generation
/// - Conda environment activation for bioinformatics tools
/// - Working directory management
/// - Output capture and error handling
///
/// # Arguments
///
/// * `step` - The workflow step to execute
/// * `tool_env_map` - Mapping of tool names to conda environment names
/// * `working_dir` - Optional working directory for relative paths
///
/// # Returns
///
/// * `Ok(())` - Step completed successfully
/// * `Err` - Step failed with descriptive error
///
/// # Placeholder Substitution
///
/// The following placeholders are supported:
/// - `{input}` / `{inputs}` - Space-separated input files
/// - `{output}` / `{outputs}` - Space-separated output files
pub fn execute_step(
    step: &Step,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let step_name = &step.id;

    // Parse comma-separated file lists
    let input_files = parse_file_list(&step.input);
    let output_files = parse_file_list(&step.output);

    // Create output directories
    ensure_output_directories(&output_files, working_dir)?;

    // Resolve placeholders
    let inputs_str = input_files.join(" ");
    let outputs_str = output_files.join(" ");

    let command_text = step
        .command
        .replace("{input}", &inputs_str)
        .replace("{output}", &outputs_str)
        .replace("{inputs}", &inputs_str)
        .replace("{outputs}", &outputs_str);

    // Create execution script
    let script_path = create_execution_script(step_name, &command_text)?;

    // Execute based on tool type
    let output = if is_system_tool(&step.tool) {
        execute_with_bash(&script_path, working_dir)?
    } else {
        execute_with_conda(&script_path, &step.tool, tool_env_map, working_dir)?
    };

    // Clean up script
    if let Err(e) = fs::remove_file(&script_path) {
        warn!("Failed to clean up script {}: {}", script_path.display(), e);
    }

    // Process result
    if output.status.success() {
        debug!("Step '{}' completed successfully", step_name);

        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            debug!("Step '{}' output:\n{}", step_name, stdout);
        }

        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        error!(
            "Step '{}' failed with exit code: {:?}",
            step_name,
            output.status.code()
        );

        if !stderr.trim().is_empty() {
            error!("stderr:\n{}", stderr);
        }
        if !stdout.trim().is_empty() {
            debug!("stdout:\n{}", stdout);
        }

        Err(format!("Step '{}' failed. See logs for details.", step_name).into())
    }
}

/// Parses comma-separated file strings into a vector.
fn parse_file_list(files: &[String]) -> Vec<String> {
    files
        .iter()
        .flat_map(|s| s.split(',').map(|part| part.trim().to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

/// Creates parent directories for output files.
fn ensure_output_directories(
    output_files: &[String],
    working_dir: &Option<PathBuf>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    for output_file in output_files {
        if output_file.is_empty() {
            continue;
        }

        let output_path = match working_dir {
            Some(dir) => dir.join(output_file),
            None => PathBuf::from(output_file),
        };

        if let Some(parent) = output_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
                debug!("Created directory: {}", parent.display());
            }
        }
    }
    Ok(())
}

/// Creates a temporary bash script for step execution.
fn create_execution_script(
    step_id: &str,
    command_text: &str,
) -> Result<PathBuf, Box<dyn Error + Send + Sync>> {
    let script_dir = std::env::temp_dir().join("rustrunner_scripts");
    fs::create_dir_all(&script_dir)?;

    let script_path = script_dir.join(format!("step_{}.sh", step_id));
    let mut file = File::create(&script_path)?;

    writeln!(file, "#!/bin/bash")?;
    writeln!(file, "set -e")?;
    writeln!(file, "{}", command_text)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755))?;
    }

    Ok(script_path)
}

/// Checks if a tool is a system tool (doesn't require conda).
fn is_system_tool(tool: &str) -> bool {
    SYSTEM_TOOLS.contains(&tool)
}

/// Executes a script directly with bash.
fn execute_with_bash(
    script_path: &PathBuf,
    working_dir: &Option<PathBuf>,
) -> Result<std::process::Output, Box<dyn Error + Send + Sync>> {
    let mut cmd = Command::new("bash");
    cmd.arg(script_path);

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
        debug!("Executing in directory: {}", dir.display());
    }

    Ok(cmd.output()?)
}

/// Executes a script within a conda environment.
fn execute_with_conda(
    script_path: &PathBuf,
    tool: &str,
    tool_env_map: &HashMap<String, String>,
    working_dir: &Option<PathBuf>,
) -> Result<std::process::Output, Box<dyn Error + Send + Sync>> {
    let env_name = tool_env_map.get(tool).ok_or_else(|| {
        format!(
            "No conda environment configured for tool '{}'. \
             Create one with: micromamba create -n {} {} -c bioconda -c conda-forge",
            tool, tool, tool
        )
    })?;

    let mut cmd = Command::new(&*MICROMAMBA_PATH);
    cmd.arg("run").arg("-n").arg(env_name).arg("bash").arg(script_path);

    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
        debug!(
            "Executing in directory: {} (conda env: {})",
            dir.display(),
            env_name
        );
    }

    Ok(cmd.output()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_file_list() {
        let input = vec!["file1.txt, file2.txt".to_string()];
        let result = parse_file_list(&input);
        assert_eq!(result, vec!["file1.txt", "file2.txt"]);
    }

    #[test]
    fn test_is_system_tool() {
        assert!(is_system_tool("bash"));
        assert!(is_system_tool("echo"));
        assert!(!is_system_tool("bowtie2"));
        assert!(!is_system_tool("samtools"));
    }

    #[test]
    fn test_parse_file_list_empty() {
        let input: Vec<String> = vec![];
        let result = parse_file_list(&input);
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_file_list_multiple() {
        let input = vec!["file1.txt,file2.txt,file3.txt".to_string()];
        let result = parse_file_list(&input);

        assert_eq!(result.len(), 3);
        assert_eq!(result, vec!["file1.txt", "file2.txt", "file3.txt"]);
    }

    #[test]
    fn test_parse_file_list_with_spaces() {
        let input = vec!["file1.txt, file2.txt , file3.txt".to_string()];
        let result = parse_file_list(&input);

        assert_eq!(result, vec!["file1.txt", "file2.txt", "file3.txt"]);
    }

    #[test]
    fn test_parse_file_list_empty_entries() {
        let input = vec!["file1.txt,,file2.txt".to_string()];
        let result = parse_file_list(&input);

        assert_eq!(result, vec!["file1.txt", "file2.txt"]);
    }

    #[test]
    fn test_parse_file_list_multiple_vec_entries() {
        let input = vec![
            "file1.txt".to_string(),
            "file2.txt,file3.txt".to_string(),
        ];
        let result = parse_file_list(&input);

        assert_eq!(result.len(), 3);
    }

    #[test]
    fn test_is_system_tool_variations() {
        assert!(is_system_tool("bash"));
        assert!(is_system_tool("grep"));
        assert!(is_system_tool("awk"));
        assert!(is_system_tool("sed"));
        assert!(is_system_tool("sort"));
        assert!(is_system_tool("wc"));
        assert!(is_system_tool("cat"));
        assert!(is_system_tool("head"));
        assert!(is_system_tool("tail"));
        assert!(!is_system_tool("bowtie2"));
        assert!(!is_system_tool("samtools"));
        assert!(!is_system_tool("BASH")); // Case sensitive
    }

    #[test]
    fn test_create_execution_script() {
        let script = create_execution_script("test_step", "echo 'hello world'");
        assert!(script.is_ok());

        let script_path = script.unwrap();
        assert!(script_path.exists());

        let content = std::fs::read_to_string(&script_path).unwrap();
        assert!(content.contains("#!/bin/bash"));
        assert!(content.contains("set -e"));
        assert!(content.contains("echo 'hello world'"));

        // Cleanup
        std::fs::remove_file(script_path).unwrap();
    }

    #[test]
    fn test_create_execution_script_multiline_command() {
        let script = create_execution_script("multi", "echo line1\necho line2");
        assert!(script.is_ok());

        let script_path = script.unwrap();
        let content = std::fs::read_to_string(&script_path).unwrap();
        assert!(content.contains("echo line1"));
        assert!(content.contains("echo line2"));

        std::fs::remove_file(script_path).unwrap();
    }

    #[test]
    fn test_ensure_output_directories() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let nested_file = "subdir1/subdir2/output.txt";

        let result = ensure_output_directories(
            &vec![nested_file.to_string()],
            &Some(temp_dir.path().to_path_buf())
        );

        assert!(result.is_ok());
        assert!(temp_dir.path().join("subdir1/subdir2").exists());
    }

    #[test]
    fn test_ensure_output_directories_empty() {
        let result = ensure_output_directories(
            &vec!["".to_string()],
            &None
        );

        assert!(result.is_ok());
    }

    #[test]
    fn test_ensure_output_directories_no_working_dir() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let output = temp_dir.path().join("newdir/output.txt");

        let result = ensure_output_directories(
            &vec![output.to_str().unwrap().to_string()],
            &None
        );

        assert!(result.is_ok());
        assert!(temp_dir.path().join("newdir").exists());
    }

    #[test]
    fn test_execute_step_simple_bash() {
        use tempfile::tempdir;

        let temp_dir = tempdir().unwrap();
        let output_file = temp_dir.path().join("out.txt");

        let step = Step::new("test_exec", "bash", &format!("echo hello > {}", output_file.display()))
            .with_output(output_file.to_str().unwrap());

        let env_map = HashMap::new();
        let result = execute_step(&step, &env_map, &None);

        assert!(result.is_ok());
        assert!(output_file.exists());
    }
}
