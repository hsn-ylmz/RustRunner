# Graph Report - RustRunner  (2026-08-08)

## Corpus Check
- 40 files · ~32,249 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 725 nodes · 1304 edges · 48 communities (27 shown, 21 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 15 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `51430023`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Workflow Data Model|Workflow Data Model]]
- [[_COMMUNITY_NPM Dependencies & Config|NPM Dependencies & Config]]
- [[_COMMUNITY_Conda Environment Execution|Conda Environment Execution]]
- [[_COMMUNITY_Execution Planner & Metrics|Execution Planner & Metrics]]
- [[_COMMUNITY_Electron-Builder Packaging|Electron-Builder Packaging]]
- [[_COMMUNITY_Step Script Execution|Step Script Execution]]
- [[_COMMUNITY_Parallel Execution Engine|Parallel Execution Engine]]
- [[_COMMUNITY_Workflow State Tracking|Workflow State Tracking]]
- [[_COMMUNITY_Resource Monitoring|Resource Monitoring]]
- [[_COMMUNITY_Execution Timeline|Execution Timeline]]
- [[_COMMUNITY_Validation & Formatting|Validation & Formatting]]
- [[_COMMUNITY_Architecture Concepts (README)|Architecture Concepts (README)]]
- [[_COMMUNITY_Workflow YAML Parser|Workflow YAML Parser]]
- [[_COMMUNITY_Electron Main Window & Menu|Electron Main Window & Menu]]
- [[_COMMUNITY_Rust CLI Entrypoint|Rust CLI Entrypoint]]
- [[_COMMUNITY_Renderer IPC API|Renderer IPC API]]
- [[_COMMUNITY_Wildcard Expansion|Wildcard Expansion]]
- [[_COMMUNITY_React Flow Node Editor|React Flow Node Editor]]
- [[_COMMUNITY_TypeScript Config (Renderer)|TypeScript Config (Renderer)]]
- [[_COMMUNITY_TypeScript Config (Main)|TypeScript Config (Main)]]
- [[_COMMUNITY_afterPack Binary Copy|afterPack Binary Copy]]
- [[_COMMUNITY_App Icon Branding (Dark)|App Icon Branding (Dark)]]
- [[_COMMUNITY_Electron Preload Bridge|Electron Preload Bridge]]
- [[_COMMUNITY_App Icon Branding (Light)|App Icon Branding (Light)]]
- [[_COMMUNITY_Webpack Config|Webpack Config]]
- [[_COMMUNITY_Graphify Integration|Graphify Integration]]
- [[_COMMUNITY_RustRunner|RustRunner]]
- [[_COMMUNITY_graphify query commands|graphify query commands]]
- [[_COMMUNITY_afterPack.js binary bundling script|afterPack.js binary bundling script]]
- [[_COMMUNITY_DAG Dependency Graph Resolution|DAG Dependency Graph Resolution]]
- [[_COMMUNITY_Dry Run Mode|Dry Run Mode]]
- [[_COMMUNITY_electron-builder packaging|electron-builder packaging]]
- [[_COMMUNITY_Electron Main Process|Electron Main Process]]
- [[_COMMUNITY_env_map.json Tool-to-Environment Mapping|env_map.json Tool-to-Environment Mapping]]
- [[_COMMUNITY_Micromamba Conda Integration|Micromamba Conda Integration]]
- [[_COMMUNITY_Parallel Job Scheduler|Parallel Job Scheduler]]
- [[_COMMUNITY_PauseResume via pause.flag file|Pause/Resume via pause.flag file]]
- [[_COMMUNITY_React Flow node-based editor|React Flow node-based editor]]
- [[_COMMUNITY_Real-Time Log Streaming|Real-Time Log Streaming]]
- [[_COMMUNITY_Resource Monitoring (CPUmemory)|Resource Monitoring (CPU/memory)]]
- [[_COMMUNITY_Rust Engine (CLI execution engine)|Rust Engine (CLI execution engine)]]
- [[_COMMUNITY_Visual Workflow Editor|Visual Workflow Editor]]
- [[_COMMUNITY_Wildcard Batch Processing|Wildcard Batch Processing]]
- [[_COMMUNITY_YAML Workflow Serialization|YAML Workflow Serialization]]
- [[_COMMUNITY_Competitive research cache|Competitive research cache]]
- [[_COMMUNITY_Report structure|Report structure]]
- [[_COMMUNITY_RustRunner — Session Report · 2026-07-04|RustRunner — Session Report · 2026-07-04]]
- [[_COMMUNITY_session-report-check.sh|session-report-check.sh]]

## God Nodes (most connected - your core abstractions)
1. `Workflow` - 37 edges
2. `Step` - 29 edges
3. `execute_step()` - 20 edges
4. `ExecutionPlanner` - 19 edges
5. `WorkflowState` - 19 edges
6. `Engine` - 17 edges
7. `ResourceMonitor` - 17 edges
8. `RustRunner` - 17 edges
9. `scripts` - 15 edges
10. `build` - 15 edges

## Surprising Connections (you probably didn't know these)
- `root` --implements--> `Electron Renderer (React + React Flow)`  [INFERRED]
  RustRunner-Desktop/src/renderer/index.tsx → README.md
- `Renderer Content-Security-Policy` --conceptually_related_to--> `Electron IPC / contextBridge`  [INFERRED]
  RustRunner-Desktop/src/renderer/index.html → README.md
- `run()` --calls--> `load_workflow()`  [INFERRED]
  RustRunner/src/main.rs → RustRunner/src/workflow/parser.rs
- `load_workflow()` --calls--> `validate_workflow()`  [INFERRED]
  RustRunner/src/workflow/parser.rs → RustRunner/src/workflow/validator.rs
- `Engine` --references--> `Workflow`  [EXTRACTED]
  RustRunner/src/execution/engine.rs → RustRunner/src/workflow/model.rs

## Import Cycles
- None detected.

## Communities (48 total, 21 thin omitted)

### Community 0 - "Workflow Data Model"
Cohesion: 0.08
Nodes (39): D, Default, Error, HashMap, Into, Option, Result, Self (+31 more)

### Community 1 - "NPM Dependencies & Config"
Cohesion: 0.04
Nodes (46): author, dependencies, electron-log, electron-updater, js-yaml, react, react-dom, @xyflow/react (+38 more)

### Community 2 - "Conda Environment Execution"
Cohesion: 0.11
Nodes (25): Command, check_env(), create_env(), list_packages(), micromamba_command(), Box, Default, Error (+17 more)

### Community 3 - "Execution Planner & Metrics"
Cohesion: 0.15
Nodes (27): create_test_workflow(), ExecutionPlanner, HashMap, HashSet, Instant, Option, Result, Self (+19 more)

### Community 4 - "Electron-Builder Packaging"
Cohesion: 0.06
Nodes (36): build, afterPack, appId, asar, directories, dmg, extraResources, files (+28 more)

### Community 5 - "Step Script Execution"
Cohesion: 0.12
Nodes (33): Output, create_execution_script(), ensure_output_directories(), execute_step(), execute_with_bash(), execute_with_conda(), is_system_tool(), parse_file_list() (+25 more)

### Community 6 - "Parallel Execution Engine"
Cohesion: 0.15
Nodes (21): create_test_workflow(), Engine, Box, Error, HashMap, Into, Option, PathBuf (+13 more)

### Community 7 - "Workflow State Tracking"
Cohesion: 0.14
Nodes (21): Box, Error, HashSet, Option, Result, Self, String, test_mark_completed() (+13 more)

### Community 8 - "Resource Monitoring"
Cohesion: 0.12
Nodes (22): Pid, ResourceMonitor, ResourceSample, Default, Duration, Instant, Option, Self (+14 more)

### Community 9 - "Execution Timeline"
Cohesion: 0.15
Nodes (23): EventType, ExecutionTimeline, Default, Duration, HashMap, Instant, Self, String (+15 more)

### Community 10 - "Validation & Formatting"
Cohesion: 0.12
Nodes (23): Display, Formatter, quick_validate(), Result, String, Vec, test_quick_validate_empty(), test_quick_validate_missing_tool() (+15 more)

### Community 12 - "Workflow YAML Parser"
Cohesion: 0.20
Nodes (21): derive_dependencies_from_files(), expand_wildcards_in_workflow(), load_workflow(), populate_dependencies(), Box, Error, Result, String (+13 more)

### Community 13 - "Electron Main Window & Menu"
Cohesion: 0.15
Nodes (13): createWindow(), getThemedIconPath(), WORKFLOW_FILTERS, WorkflowData, DarwinMenuItemConstructorOptions, MenuAction, MenuBuilder, checkForUpdatesManually() (+5 more)

### Community 14 - "Rust CLI Entrypoint"
Cohesion: 0.22
Nodes (17): ExitCode, Config, main(), parse_arguments(), print_banner(), print_usage(), Box, Default (+9 more)

### Community 15 - "Renderer IPC API"
Cohesion: 0.08
Nodes (6): ElectronAPI, MenuAction, UpdateStatus, Window, WorkflowData, WorkflowOutcome

### Community 16 - "Wildcard Expansion"
Cohesion: 0.20
Nodes (15): expand_workflow_wildcards(), extract_wildcard_names(), extract_wildcard_values(), generate_pattern(), has_wildcards(), HashMap, Option, Result (+7 more)

### Community 17 - "React Flow Node Editor"
Cohesion: 0.10
Nodes (27): Electron Renderer (React + React Flow), classifyLogLine(), COLOR_OPTIONS, convertNodesToWorkflow(), defaultEdgeOptions, findInvalidNodeIds(), formatBytesPerSec(), generatePattern() (+19 more)

### Community 18 - "TypeScript Config (Renderer)"
Cohesion: 0.12
Nodes (15): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module, moduleResolution (+7 more)

### Community 19 - "TypeScript Config (Main)"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution, outDir (+7 more)

### Community 20 - "afterPack Binary Copy"
Cohesion: 0.47
Nodes (5): copyBinary(), default(), fs, getRustTarget(), path

### Community 21 - "App Icon Branding (Dark)"
Cohesion: 0.60
Nodes (5): White upward-diagonal running/speed arrow, RustRunner application branding/identity, Hand-drawn brushstroke/grunge illustration style, Rust-colored gear/cog motif, RustRunner Desktop app icon (dark variant)

### Community 22 - "Electron Preload Bridge"
Cohesion: 0.33
Nodes (4): Channels, ElectronHandler, MenuAction, WorkflowData

### Community 23 - "App Icon Branding (Light)"
Cohesion: 1.00
Nodes (3): RustRunner brand identity (rust-red palette, motion arrow), Diagonal claw-slash / arrow motif, RustRunner Desktop app icon (light variant)

### Community 26 - "RustRunner"
Cohesion: 0.05
Nodes (39): Acknowledgments, Architecture, Authors, Build All Components, Build Outputs, Build Rust Backend (Debug), Build Rust Backend (Release), Building for Production (+31 more)

### Community 44 - "Competitive research cache"
Cohesion: 0.13
Nodes (14): Apache Airflow, Argo / Mage / Windmill / n8n / Node-RED (to rotate in), Competitive research cache, Cross-tool themes most worth stealing (ranked), Dagster, Direct — visual / GUI workflow builders, Galaxy (closest UX analog), Indirect — bioinformatics DSL engines (+6 more)

### Community 45 - "Report structure"
Cohesion: 0.17
Nodes (11): 1. Header, 2. Build & test health, 3. Broken / not-working features, 4. Not-useful / low-value features, 5. Competitive scan, 6. Prioritized recommendations, Ground rules, Output (+3 more)

### Community 46 - "RustRunner — Session Report · 2026-07-04"
Cohesion: 0.29
Nodes (6): 1. Build & test health, 2. Broken / not-working features (priority order), 3. Not-useful / low-value / dead code, 4. Competitive scan (direct + indirect; full detail in `reports/_competitive-cache.md`), 5. Prioritized recommendations, RustRunner — Session Report · 2026-07-04

## Knowledge Gaps
- **206 isolated node(s):** `session-report-check.sh script`, `name`, `version`, `description`, `main` (+201 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Workflow` connect `Workflow Data Model` to `Execution Planner & Metrics`, `Parallel Execution Engine`, `Validation & Formatting`, `Workflow YAML Parser`, `Wildcard Expansion`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `Step` connect `Workflow Data Model` to `Validation & Formatting`, `Execution Planner & Metrics`, `Step Script Execution`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `WorkflowState` connect `Workflow State Tracking` to `Wildcard Expansion`, `Execution Planner & Metrics`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **What connects `session-report-check.sh script`, `name`, `version` to the rest of the system?**
  _207 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Workflow Data Model` be split into smaller, more focused modules?**
  _Cohesion score 0.08438228438228439 - nodes in this community are weakly interconnected._
- **Should `NPM Dependencies & Config` be split into smaller, more focused modules?**
  _Cohesion score 0.0425531914893617 - nodes in this community are weakly interconnected._
- **Should `Conda Environment Execution` be split into smaller, more focused modules?**
  _Cohesion score 0.1064102564102564 - nodes in this community are weakly interconnected._