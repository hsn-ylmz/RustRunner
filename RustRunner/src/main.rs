//! RustRunner CLI Entry Point
//!
//! Provides command-line interface for workflow execution.
//!
//! # Usage
//!
//! ```bash
//! # Execute a workflow
//! rustrunner workflow.yaml
//!
//! # With pause control
//! rustrunner workflow.yaml /tmp/pause.flag
//!
//! # Dry run mode (preview commands)
//! rustrunner workflow.yaml --dry-run
//!
//! # Specify working directory
//! rustrunner workflow.yaml --working-dir /path/to/data
//!
//! # Set maximum parallel jobs
//! rustrunner workflow.yaml --parallel 8
//! ```

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use log::{error, info, warn};

use rustrunner::execution::Engine;
use rustrunner::workflow::parser::load_workflow;
use rustrunner::{APP_NAME, VERSION};

/// Default workflow file used when none is specified.
const DEFAULT_WORKFLOW: &str = "workflow.yaml";

/// Default maximum parallel jobs.
const DEFAULT_MAX_PARALLEL: usize = 4;

/// Command-line configuration parsed from arguments.
#[derive(Debug)]
struct Config {
    workflow_path: String,
    pause_flag_path: Option<String>,
    dry_run: bool,
    working_dir: Option<PathBuf>,
    max_parallel: usize,
    verbose: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            workflow_path: DEFAULT_WORKFLOW.to_string(),
            pause_flag_path: None,
            dry_run: false,
            working_dir: None,
            max_parallel: DEFAULT_MAX_PARALLEL,
            verbose: false,
        }
    }
}

/// Configures the logging system with appropriate formatting.
fn setup_logging(verbose: bool) {
    let level = if verbose { "debug" } else { "info" };

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(level))
        .format(|buf, record| {
            use std::io::Write;

            match record.level() {
                log::Level::Warn | log::Level::Error => {
                    writeln!(buf, "[{}] {}", record.level(), record.args())
                }
                _ => writeln!(buf, "{}", record.args()),
            }
        })
        .init();
}

/// Prints the application banner with version information.
fn print_banner() {
    println!();
    println!("{} v{}", APP_NAME, VERSION);
    println!("Visual Workflow Execution Engine");
    println!();
}

/// Prints usage information.
fn print_usage() {
    println!("Usage: rustrunner [OPTIONS] <WORKFLOW_FILE> [PAUSE_FLAG_PATH]");
    println!();
    println!("Arguments:");
    println!("  <WORKFLOW_FILE>     Path to workflow YAML file");
    println!("  [PAUSE_FLAG_PATH]   Optional path for pause/resume control");
    println!();
    println!("Options:");
    println!("  --dry-run           Preview commands without execution");
    println!("  --working-dir PATH  Set working directory for file operations");
    println!("  --parallel N        Maximum parallel jobs (default: {})", DEFAULT_MAX_PARALLEL);
    println!("  --verbose           Enable debug logging");
    println!("  --help              Show this help message");
    println!("  --version           Show version information");
    println!();
    println!("Examples:");
    println!("  rustrunner pipeline.yaml");
    println!("  rustrunner pipeline.yaml --dry-run");
    println!("  rustrunner pipeline.yaml --working-dir /data/analysis --parallel 8");
}

/// Parses command-line arguments into a Config struct.
fn parse_arguments(args: &[String]) -> Result<Config, String> {
    let mut config = Config::default();
    let mut positional_index = 0;
    let mut i = 1; // Skip program name

    while i < args.len() {
        let arg = &args[i];

        match arg.as_str() {
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            "--version" | "-V" => {
                println!("{} {}", APP_NAME, VERSION);
                std::process::exit(0);
            }
            "--dry-run" => {
                config.dry_run = true;
            }
            "--verbose" | "-v" => {
                config.verbose = true;
            }
            "--working-dir" => {
                i += 1;
                if i >= args.len() {
                    return Err("--working-dir requires a path argument".to_string());
                }
                config.working_dir = Some(PathBuf::from(&args[i]));
            }
            "--parallel" => {
                i += 1;
                if i >= args.len() {
                    return Err("--parallel requires a number argument".to_string());
                }
                config.max_parallel = args[i]
                    .parse()
                    .map_err(|_| format!("Invalid parallel value: {}", args[i]))?;
            }
            arg if arg.starts_with('-') => {
                return Err(format!("Unknown option: {}", arg));
            }
            _ => {
                // Positional argument
                match positional_index {
                    0 => config.workflow_path = arg.clone(),
                    1 => config.pause_flag_path = Some(arg.clone()),
                    _ => return Err(format!("Unexpected argument: {}", arg)),
                }
                positional_index += 1;
            }
        }
        i += 1;
    }

    Ok(config)
}

/// Validates and sets up the working directory.
fn setup_working_directory(
    working_dir: Option<PathBuf>,
) -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let Some(dir) = working_dir else {
        let current = env::current_dir()?;
        info!("Working directory: {}", current.display());
        return Ok(None);
    };

    if !dir.exists() {
        return Err(format!("Working directory does not exist: {}", dir.display()).into());
    }

    if !dir.is_dir() {
        return Err(format!("Path is not a directory: {}", dir.display()).into());
    }

    // Change to working directory for relative path resolution
    env::set_current_dir(&dir)?;
    info!("Working directory: {}", env::current_dir()?.display());

    Ok(Some(dir))
}

/// Main application entry point.
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();

    // Parse arguments
    let config = parse_arguments(&args).map_err(|e| {
        eprintln!("Error: {}", e);
        eprintln!();
        print_usage();
        e
    })?;

    // Setup logging
    setup_logging(config.verbose);

    // Print banner
    print_banner();

    // Display configuration
    if let Some(ref path) = config.pause_flag_path {
        info!("Pause control: {}", path);
    }

    if config.dry_run {
        info!("Mode: DRY RUN (commands will not execute)");
        println!();
    }

    // Setup working directory
    let work_dir = setup_working_directory(config.working_dir)?;

    // Load workflow
    info!("Loading workflow: {}", config.workflow_path);
    let workflow = load_workflow(&config.workflow_path).map_err(|e| {
        error!("Failed to load workflow: {}", e);
        format!(
            "Could not load workflow from '{}': {}",
            config.workflow_path, e
        )
    })?;

    info!(
        "Workflow loaded: {} steps, {} unique tools",
        workflow.steps.len(),
        workflow.tools.len()
    );

    // Create and configure engine
    let mut engine = Engine::new(workflow);
    engine.set_workflow_path(&config.workflow_path);
    engine.set_max_parallel(config.max_parallel);
    engine.set_dry_run(config.dry_run);

    if let Some(pause_path) = config.pause_flag_path {
        engine.set_pause_flag_path(pause_path);
    }

    if let Some(dir) = work_dir {
        engine.set_working_dir(dir);
    }

    // Execute workflow
    engine.run()?;

    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!();
            eprintln!("Error: {}", e);
            ExitCode::FAILURE
        }
    }
}
