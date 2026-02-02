# RustRunner

**Visual Workflow Execution Engine for Bioinformatics Pipelines**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-35.0.2-47848F.svg)](https://www.electronjs.org/)
[![Rust](https://img.shields.io/badge/Rust-2021_Edition-orange.svg)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-18.3-61DAFB.svg)](https://reactjs.org/)

---

## Overview

RustRunner is a desktop application for creating and executing bioinformatics workflow pipelines through a visual, node-based interface. It is designed for researchers who need powerful workflow automation without command-line expertise.

The application pairs a **React/Electron** frontend with a **Rust** backend execution engine, offering real-time output streaming, parallel job scheduling, pause/resume control, and integrated conda environment management via micromamba.

### Key Features

- **Visual Workflow Editor** -- Drag-and-drop node-based interface built with React Flow for designing pipelines
- **Parallel Execution** -- Configurable parallel job scheduling with dependency-aware DAG resolution
- **Batch Processing** -- Wildcard pattern support (`{sample}.fastq`) for processing multiple files in one run
- **Dry Run Mode** -- Preview generated commands without executing them
- **Pause / Resume** -- Pause and resume running workflows at any time
- **Conda Integration** -- Automatic per-tool environment isolation via micromamba
- **Real-Time Logging** -- Live execution output streamed from the Rust engine to the GUI
- **Resource Monitoring** -- CPU and memory usage tracking during execution
- **Cross-Platform** -- Builds for macOS, Windows, and Linux

---

## Technology Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Frontend** | Electron 35.0.2, React 18.3, TypeScript 5.8 | Desktop shell, visual workflow editor |
| **Visual Editor** | React Flow (@xyflow/react 12.4) | Node-based graph interface |
| **Bundler** | Webpack 5.98 | Module bundling for the renderer process |
| **Backend** | Rust (2021 edition), Tokio 1.35 | Workflow parsing, execution engine, process management |
| **Serialization** | serde, serde_yaml, serde_json | YAML/JSON workflow parsing |
| **Env Management** | Micromamba | Lightweight conda alternative for tool isolation |
| **Packaging** | electron-builder 26.7 | Cross-platform application packaging |

---

## Architecture

```
+----------------------------+         IPC          +-------------------------+
|   Electron Renderer        | <------------------> |   Electron Main Process |
|   (React + React Flow)     |   contextBridge      |   (TypeScript/Node.js)  |
|                            |                      |                         |
|  - Visual node editor      |                      |  - Window management    |
|  - Workflow configuration   |                      |  - File dialogs         |
|  - Real-time log display   |                      |  - YAML serialization   |
|  - File/dir selection      |                      |  - Child process spawn  |
+----------------------------+                      +------------+------------+
                                                                 |
                                                          spawns |  stdin/stdout
                                                                 v
                                                    +-------------------------+
                                                    |   Rust Engine (CLI)     |
                                                    |                         |
                                                    |  - YAML workflow parser |
                                                    |  - DAG dependency graph |
                                                    |  - Parallel scheduler   |
                                                    |  - Micromamba envs      |
                                                    |  - Resource monitoring  |
                                                    |  - Pause flag polling   |
                                                    +-------------------------+
```

**Communication flow:**

1. The React UI sends workflow data to the main process via Electron IPC
2. The main process serializes the workflow to YAML and writes it to a temp directory
3. The main process spawns the Rust binary as a child process
4. The Rust engine parses the YAML, builds a dependency graph, and executes steps
5. stdout/stderr from the Rust process is streamed back to the UI in real time
6. Pause/resume is controlled by the presence/absence of a `pause.flag` file

---

## Prerequisites

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Rust** >= 1.70 (2021 edition)
- **Cargo** (included with Rust toolchain)

### Platform-Specific

| Platform | Additional Requirements |
|----------|------------------------|
| macOS | Xcode Command Line Tools |
| Windows | Visual Studio Build Tools (C++ workload) |
| Linux | `build-essential`, `libgtk-3-dev`, `libwebkit2gtk-4.0-dev` |

### Optional

- **Micromamba** -- Required for workflows that use conda-managed tools. Download from [micro.mamba.pm](https://micro.mamba.pm/) and place the binary at `RustRunner/runtime/micromamba`.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/rustrunner/rustrunner.git
cd rustrunner

# Install Node.js dependencies
cd RustRunner-Desktop
npm install

# Build the Rust backend (release mode)
cd ../RustRunner
cargo build --release

# Return to project root
cd ..
```

---

## Development

### Run in Development Mode

```bash
# Terminal 1: Start the Electron app (builds both main + renderer, then launches)
cd RustRunner-Desktop
npm start
```

The `npm start` script runs `npm run build && electron .`, which compiles TypeScript for the main process and bundles the React renderer with Webpack before launching Electron.

### Run with Hot Reload (Renderer)

```bash
# Start Webpack dev server + Electron concurrently
cd RustRunner-Desktop
npm run dev
```

This launches `webpack-dev-server` on port 3000 with hot module replacement for the React UI, then starts the Electron main process once the dev server is ready.

### Build Rust Backend (Debug)

```bash
cd RustRunner
cargo build
```

### Build Rust Backend (Release)

```bash
cd RustRunner
cargo build --release
```

### Run Rust Tests

```bash
cd RustRunner
cargo test
```

### Run Rust CLI Directly

```bash
cd RustRunner
cargo run -- workflow.yaml --dry-run
cargo run -- workflow.yaml --parallel 8 --working-dir /path/to/data
```

---

## Building for Production

### Build All Components

```bash
# 1. Build the Rust binary (release mode, optimized)
cd RustRunner
cargo build --release

# 2. Build and package the Electron app
cd ../RustRunner-Desktop
npm run package
```

### Platform-Specific Packaging

```bash
# macOS (DMG + ZIP)
npm run package:mac

# Windows (NSIS installer)
npm run package:win

# Linux (AppImage)
npm run package:linux
```

### Build Outputs

| Output | Location |
|--------|----------|
| Rust binary (release) | `RustRunner/target/release/rustrunner` |
| Compiled Electron JS | `RustRunner-Desktop/dist/` |
| Packaged application | `RustRunner-Desktop/release/build/` |

The `afterPack.js` script automatically copies the Rust binary, micromamba, `env_map.json`, and icon assets into the packaged application resources during the build.

---

## Project Structure

```
RustRunner/
├── .gitignore                          # Git ignore rules
├── README.md                           # This file
│
├── RustRunner/                         # Rust backend (execution engine)
│   ├── Cargo.toml                      # Rust package manifest
│   ├── Cargo.lock                      # Dependency lock file
│   ├── src/
│   │   ├── main.rs                     # CLI entry point
│   │   ├── lib.rs                      # Library root & module exports
│   │   ├── workflow/                   # Workflow parsing & data models
│   │   │   ├── mod.rs                  # Module exports
│   │   │   ├── model.rs               # Step & Workflow structs
│   │   │   ├── parser.rs              # YAML workflow parsing
│   │   │   ├── validator.rs           # Workflow validation
│   │   │   ├── planner.rs             # Execution planning & DAG
│   │   │   ├── state.rs               # State persistence
│   │   │   └── wildcards.rs           # Batch file pattern expansion
│   │   ├── execution/                  # Execution engine
│   │   │   ├── mod.rs
│   │   │   ├── engine.rs              # Parallel scheduler & runner
│   │   │   └── step.rs               # Individual step execution
│   │   ├── environment/                # Conda/micromamba integration
│   │   │   ├── mod.rs
│   │   │   └── conda.rs              # Environment creation & activation
│   │   └── monitoring/                 # Execution monitoring
│   │       ├── mod.rs
│   │       ├── resource.rs            # CPU/memory tracking
│   │       └── timeline.rs            # Event timeline
│   └── runtime/
│       ├── env_map.json               # Tool-to-conda-environment mappings
│       └── micromamba                  # Micromamba binary (not tracked)
│
└── RustRunner-Desktop/                 # Electron frontend (desktop GUI)
    ├── package.json                    # Node dependencies & build config
    ├── package-lock.json               # Dependency lock file
    ├── webpack.config.js               # Webpack bundler configuration
    ├── tsconfig.json                   # Renderer TypeScript config
    ├── tsconfig.main.json              # Main process TypeScript config
    ├── assets/                         # Application icons
    │   ├── icon_light.{png,icns,ico}   # Light mode icons
    │   └── icon_dark.{png,icns,ico}    # Dark mode icons
    ├── scripts/
    │   └── afterPack.js               # Post-build: copies binaries to app bundle
    └── src/
        ├── main/                       # Electron main process
        │   ├── main.ts                # App lifecycle, IPC handlers, process spawning
        │   ├── preload.ts             # Context bridge (safe API for renderer)
        │   ├── menu.ts                # Application menu
        │   └── util.ts                # HTML path resolution helper
        └── renderer/                   # React renderer process
            ├── index.tsx              # React entry point
            ├── index.html             # HTML template
            ├── App.tsx                # Main workflow editor component
            ├── App.css                # Application styles
            └── preload.d.ts           # Type definitions for preload API
```

---

## Configuration

### Environment Mappings (`RustRunner/runtime/env_map.json`)

Maps bioinformatics tool names to their conda environment names. When the Rust engine encounters a step using a mapped tool, it activates the corresponding micromamba environment before execution.

```json
{
  "map": {
    "fastqc": "fastqc",
    "bowtie2": "bowtie2",
    "samtools": "samtools",
    "bwa": "bwa",
    "hisat2": "hisat2"
  }
}
```

Add entries here for any new tools that require isolated conda environments.

### Electron Builder (`RustRunner-Desktop/package.json` > `build`)

Key packaging settings:

- `asar: false` -- App is not compressed into an ASAR archive (required for native binary access)
- `extraResources` -- Copies the Rust binary, micromamba, env_map.json, and icons into the packaged app
- `afterPack` -- Runs `scripts/afterPack.js` for additional binary setup

### Rust CLI Options

```
Usage: rustrunner [OPTIONS] <WORKFLOW_FILE> [PAUSE_FLAG_PATH]

Arguments:
  <WORKFLOW_FILE>     Path to workflow YAML file
  [PAUSE_FLAG_PATH]   Optional path for pause/resume control

Options:
  --dry-run           Preview commands without execution
  --working-dir PATH  Set working directory for file operations
  --parallel N        Maximum parallel jobs (default: 4)
  --verbose           Enable debug logging
  --help              Show help message
  --version           Show version information
```

---

## Troubleshooting

### Rust binary not found when running in development

The main process looks for the debug binary at `../RustRunner/target/debug/rustrunner` relative to the compiled Electron main process. Make sure you have run `cargo build` in the `RustRunner/` directory.

### `npm run package` fails with "Rust executable not found"

The `afterPack.js` script requires a release build of the Rust binary. Run:

```bash
cd RustRunner
cargo build --release
```

### Micromamba-dependent workflows fail

Download the micromamba binary for your platform from [micro.mamba.pm](https://micro.mamba.pm/) and place it at `RustRunner/runtime/micromamba`. Make sure it has executable permissions (`chmod +x`).

### macOS: "app is damaged" or Gatekeeper warnings

The default build configuration disables code signing (`identity: null`). For local development, bypass Gatekeeper:

```bash
xattr -cr /path/to/RustRunner.app
```

For distribution, configure code signing in `package.json` under `build.mac`.

### Windows: Missing Visual C++ redistributable

Ensure the Visual Studio Build Tools are installed with the "Desktop development with C++" workload, which provides the MSVC compiler and linker needed by Rust.

### Large `node_modules` or `target/` directories

These directories are build artifacts and can be safely deleted and regenerated:

```bash
# Regenerate Node dependencies
cd RustRunner-Desktop && npm install

# Regenerate Rust build
cd RustRunner && cargo build
```

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run Rust tests (`cargo test`) and verify the Electron app builds (`npm run build`)
5. Commit with a descriptive message
6. Push to your fork and open a Pull Request

### Code Style

- **Rust**: Follow standard `rustfmt` formatting. Run `cargo fmt` before committing.
- **TypeScript/React**: Follow the existing project conventions. Use TypeScript strict mode for main process code.

---

## License

This project is licensed under the MIT License.

---

## Authors

- **Hasan Yilmaz** -- Creator and primary developer

---

## Acknowledgments

- [Electron](https://www.electronjs.org/) -- Cross-platform desktop framework
- [React Flow](https://reactflow.dev/) -- Node-based graph editor
- [Tokio](https://tokio.rs/) -- Async Rust runtime
- [Micromamba](https://mamba.readthedocs.io/) -- Fast conda package manager
- [electron-builder](https://www.electron.build/) -- Application packaging

---

## Roadmap

- [ ] Workflow templates and presets for common bioinformatics pipelines
- [ ] Workflow import/export in standard formats (CWL, WDL)
- [ ] Integrated tool documentation and parameter help
- [ ] Execution history and result comparison
- [ ] Remote execution support (SSH, cloud runners)
- [ ] Plugin system for custom node types
- [ ] Support for custom scripts
