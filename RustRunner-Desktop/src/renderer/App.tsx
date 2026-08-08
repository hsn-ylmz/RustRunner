/**
 * RustRunner Workflow Editor
 * 
 * Visual workflow design interface using React Flow.
 * Now with wildcards support for batch file processing.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  NodeToolbar,
  useReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  MiniMap,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './App.css';
import {
  applyStepEvent,
  parseStepEvent,
  type NodeStatus,
} from './stepEvents';

// =============================================================================
// Constants
// =============================================================================

const COLOR_OPTIONS = [
  '#a8e6cf', '#88c5f7', '#d4a5f7', '#f5efe9',
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6',
];

const DEFAULT_COLOR = '#88c5f7';

/**
 * Cap on retained log lines. A chatty run (or `seq 1 200000`) used to grow
 * the array without limit, one <div> per stdout chunk, until the renderer
 * stalled. Oldest lines are dropped and replaced with a trim marker.
 */
const MAX_LOG_LINES = 5000;

/** Cap on undo history depth. */
const MAX_HISTORY = 50;

// =============================================================================
// Auto-update Types
// =============================================================================

/**
 * Status payloads emitted by the main process over the 'update-status'
 * IPC channel. Kept inline (rather than imported from preload.d.ts) so the
 * renderer stays free of cross-process type imports — the shape is also
 * declared in src/main/updater.ts and src/renderer/preload.d.ts; keep all
 * three in sync.
 */
type UpdateStatus =
  | { status: 'checking'; manual: boolean }
  | {
      status: 'available';
      manual: boolean;
      version: string;
      canAutoInstall: boolean;
      downloadUrl?: string;
      releaseDate?: string;
      releaseNotes?: string | null;
    }
  | { status: 'up-to-date'; manual: boolean; version: string }
  | { status: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { status: 'downloaded'; version: string; canAutoInstall: boolean }
  | { status: 'error'; manual: boolean; message: string };

/** Human-readable bytes-per-second for the download progress line. */
function formatBytesPerSec(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

// =============================================================================
// Utility Functions
// =============================================================================

function labelToId(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/** The wildcard name the file picker generates patterns for. */
const WILDCARD_NAME = 'sample';

/**
 * Builds the engine-facing workflow from the canvas.
 *
 * Wildcard files are attached **per step** as `wildcard_files`, matching the
 * Rust `Step` struct. `load_workflow` merges those and expands the workflow
 * before validation, so no CLI flag is involved — the engine has no
 * `--wildcards` option and rejects unknown ones outright.
 *
 * Files are looked up from the live `nodes` list rather than iterated out of
 * `nodeWildcardFiles`, so entries left behind by deleted nodes can never reach
 * a run, and each step gets only its own files instead of the union of all.
 */
function convertNodesToWorkflow(
  nodes: any[],
  edges: any[],
  nodeWildcardFiles: Record<string, string[]> = {}
) {
  const nodeIdToStepId = new Map<string, string>();
  nodes.forEach((node: any) => {
    nodeIdToStepId.set(node.id, labelToId(node.data.label));
  });

  const steps = nodes.map((node: any) => {
    const stepId = nodeIdToStepId.get(node.id)!;
    const incoming = edges.filter((e: any) => e.target === node.id);
    const outgoing = edges.filter((e: any) => e.source === node.id);
    const files = nodeWildcardFiles[node.id] || [];

    const step: any = {
      id: stepId,
      tool: node.data.tool || '',
      command: node.data.command || '',
      input: node.data.input ? [node.data.input] : [],
      output: node.data.output ? [node.data.output] : [],
      previous: incoming.map((e: any) => nodeIdToStepId.get(e.source)!),
      next: outgoing.map((e: any) => nodeIdToStepId.get(e.target)!),
      threads: normalizeThreads(node.data.threads),
    };

    // Omit the key entirely when empty — Rust skips serializing empty maps and
    // an empty mapping would just be noise in the YAML.
    if (files.length > 0) {
      step.wildcard_files = { [WILDCARD_NAME]: files };
    }

    return step;
  });

  return { steps };
}

/**
 * Picks a severity class for one log line.
 *
 * Ordered most- to least-specific: the engine's own `[ERROR]`/`[WARN]` prefixes
 * win over keyword sniffing, so a command that merely mentions "error" isn't
 * painted red. Applied per line rather than per stdout chunk.
 */
function classifyLogLine(line: string): string {
  if (/^\s*\[ERROR\]/.test(line)) return 'error';
  if (/^\s*\[WARN\]/.test(line)) return 'warning';
  if (/^\s*\[(PAUSED|STOPPED)\]/.test(line)) return 'warning';
  if (/completed successfully|Workflow completed/i.test(line)) return 'success';
  if (/\bfailed\b|Execution error/i.test(line)) return 'error';
  if (/stopped by user|paused/i.test(line)) return 'warning';
  if (/\[DRY RUN\]|Wildcards|Starting step:/i.test(line)) return 'info';
  return '';
}

/**
 * Chooses where a newly added node should appear.
 *
 * Measured against the canvas element, NOT the window: the toolbars and the
 * properties panel make the canvas considerably smaller than the window, so
 * window-relative placement lands nodes near the canvas's bottom-right corner.
 *
 * Placement also has to dodge the floating overlays, which sit above the nodes
 * and swallow clicks on anything underneath them — the execution controls
 * (top-left), the MiniMap (bottom-right) and the zoom Controls (bottom-left).
 * Nodes are laid out on a 3x2 grid inside the remaining box and cycle through
 * its cells, so consecutive nodes never stack on each other either.
 *
 * Positions are computed in screen space and converted, so panning and zoom
 * are handled by React Flow rather than guessed at.
 */
function nextNodePosition(
  wrapper: HTMLElement | null,
  nodeCount: number,
  toFlow: (p: { x: number; y: number }) => { x: number; y: number }
): { x: number; y: number } {
  if (!wrapper) {
    return toFlow({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  const rect = wrapper.getBoundingClientRect();

  // Insets clearing the floating overlays. Generous rather than exact — the
  // cost of being wrong is an unclickable node.
  const box = {
    left: rect.x + 170,
    top: rect.y + 90,
    right: rect.right - 230,
    bottom: rect.bottom - 60,
  };

  // Two columns, not three: a node renders around 300px wide, so three columns
  // in this box would be narrower than the nodes themselves and they'd overlap.
  const COLS = 2;
  const ROWS = 2;
  const cells = COLS * ROWS;
  const cell = nodeCount % cells;
  const col = cell % COLS;
  const row = Math.floor(cell / COLS);

  // Once the grid wraps, nudge each new lap so nodes don't land exactly on top
  // of the ones from the previous lap.
  const lap = Math.floor(nodeCount / cells) * 26;

  const width = Math.max(box.right - box.left, 1);
  const height = Math.max(box.bottom - box.top, 1);

  return toFlow({
    x: box.left + (width * (col + 0.5)) / COLS + lap,
    y: box.top + (height * (row + 0.5)) / ROWS + lap,
  });
}

/** Coerces a threads value from the UI into a positive integer. */
function normalizeThreads(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Finds step ids that would collide or be empty once labels are slugified.
 * Surfaced live on the canvas rather than only when Run is pressed, since
 * `labelToId` silently maps "Process" and "process" onto the same id.
 */
function findInvalidNodeIds(nodes: any[]): Record<string, string> {
  const counts = new Map<string, number>();
  nodes.forEach((node: any) => {
    const id = labelToId(node.data?.label || '');
    counts.set(id, (counts.get(id) || 0) + 1);
  });

  const problems: Record<string, string> = {};
  nodes.forEach((node: any) => {
    const id = labelToId(node.data?.label || '');
    if (!id) {
      problems[node.id] = 'Name must contain at least one letter or number';
    } else if ((counts.get(id) || 0) > 1) {
      problems[node.id] = `Duplicate step ID "${id}"`;
    }
  });

  return problems;
}

function validateWorkflow(workflow: any): string[] {
  const errors: string[] = [];

  if (!workflow.steps || workflow.steps.length === 0) {
    errors.push('Workflow has no steps');
    return errors;
  }

  const stepIds = new Set<string>();
  workflow.steps.forEach((step: any) => {
    if (stepIds.has(step.id)) {
      errors.push(`Duplicate step ID: ${step.id}`);
    }
    stepIds.add(step.id);

    if (!step.id || step.id.trim() === '') {
      errors.push('Step has empty ID');
    }
    if (!step.tool || step.tool.trim() === '') {
      errors.push(`Step ${step.id}: missing tool`);
    }
    if (!step.command || step.command.trim() === '') {
      errors.push(`Step ${step.id}: missing command`);
    }
  });

  return errors;
}

// =============================================================================
// Wildcard Helper Functions
// =============================================================================

/**
 * Generates a wildcard pattern from a list of files.
 * Example: ["sample1.fastq", "sample2.fastq"] -> "{sample}.fastq"
 */
function generatePattern(files: string[]): string {
  if (files.length === 0) return '';
  
  const firstFile = files[0];
  const fileName = firstFile.split('/').pop() || firstFile;
  const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
  const dir = firstFile.substring(0, firstFile.lastIndexOf('/') + 1);
  
  return `${dir}{sample}${ext}`;
}

/**
 * Checks if a string contains wildcard syntax.
 */
function hasWildcards(text: string): boolean {
  return text.includes('{') && text.includes('}');
}

// =============================================================================
// Custom Node Component
// =============================================================================

/** Badge glyph shown in the corner of a node for each execution state. */
const STATUS_GLYPH: Record<string, string> = {
  running: '●',
  done: '✓',
  failed: '✕',
};

function CustomNode({ id, data, selected }: any) {
  const { updateNodeData } = useReactFlow();

  const handleColorChange = (newColor: string) => {
    updateNodeData(id, { color: newColor });
  };

  const nodeColor = data.color || DEFAULT_COLOR;

  // Injected by the editor rather than stored on the node, so execution state
  // never ends up in a saved workflow file.
  const status: NodeStatus | undefined = data.__status;
  const invalidReason: string | undefined = data.__invalidReason;

  const state = status?.state ?? 'idle';
  const showCount = status && status.total > 1;

  return (
    <>
      <NodeToolbar isVisible={selected} className="nopan">
        <div className="color-picker-toolbar">
          {COLOR_OPTIONS.map((colorOption) => (
            <button
              key={colorOption}
              onClick={() => handleColorChange(colorOption)}
              className={`color-button ${colorOption === nodeColor ? 'selected' : ''}`}
              style={{ backgroundColor: colorOption }}
              title={`Change color to ${colorOption}`}
            />
          ))}
        </div>
      </NodeToolbar>

      <div
        className={[
          'custom-node',
          selected ? 'selected' : '',
          `node-state-${state}`,
          invalidReason ? 'node-invalid' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ background: nodeColor }}
        title={status?.message || invalidReason || undefined}
      >
        <Handle type="target" position={Position.Top} />

        {state !== 'idle' && state !== 'pending' && (
          <div className={`node-status-badge node-status-${state}`}>
            {STATUS_GLYPH[state]}
          </div>
        )}

        <div className="node-label">{data.label || 'New Node'}</div>
        <div className="node-tool">{data.tool || 'No tool'}</div>

        {showCount && (
          <div className="node-progress">
            {status!.finished}/{status!.total}
          </div>
        )}

        {invalidReason && (
          <div className="node-invalid-badge" title={invalidReason}>
            !
          </div>
        )}

        <Handle type="source" position={Position.Bottom} />
      </div>
    </>
  );
}

// =============================================================================
// Properties Panel Component
// =============================================================================

function PropertiesPanel({
  selectedNode,
  onNodeUpdate,
  nodeFiles,
  onNodeFilesUpdate,
  addLog,
  invalidReason,
}: any) {
  if (!selectedNode) {
    return (
      <div className="properties-panel">
        <h3>Properties</h3>
        <p className="no-selection">Select a node to edit its properties</p>
      </div>
    );
  }

  const handleInputChange = (field: string, value: string) => {
    onNodeUpdate(selectedNode.id, field, value);
  };

  const handleFileSelection = async () => {
    try {
      const files = await window.electron.ipcRenderer.selectFiles();
      if (files && files.length > 0) {
        // Generate pattern automatically
        const pattern = generatePattern(files);
        handleInputChange('input', pattern);
        
        // Store files for this node
        onNodeFilesUpdate(selectedNode.id, files);
        
        // Log success
        addLog(`Selected ${files.length} file(s) for ${selectedNode.data.label}`);
        
        // Auto-suggest output pattern if not set
        if (!selectedNode.data.output || selectedNode.data.output === '') {
          const outputPattern = pattern.replace('{sample}', 'output/{sample}');
          handleInputChange('output', outputPattern);
        }
      }
    } catch (error) {
      console.error('File selection error:', error);
      addLog('Failed to select files');
    }
  };

  const handleClearFiles = () => {
    onNodeFilesUpdate(selectedNode.id, []);
    handleInputChange('input', '');
    addLog(`Cleared files for ${selectedNode.data.label}`);
  };

  return (
    <div className="properties-panel">
      <h3>Node Properties</h3>

      <div className="property-group">
        <label className="property-label">Node Name:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.label || ''}
          onChange={(e) => handleInputChange('label', e.target.value)}
        />
        {selectedNode.data.label && !invalidReason && (
          <div className="property-hint">
            Step ID: {labelToId(selectedNode.data.label)}
          </div>
        )}
        {invalidReason && (
          <div className="property-error">⚠ {invalidReason}</div>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Tool:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.tool || ''}
          onChange={(e) => handleInputChange('tool', e.target.value)}
          placeholder="e.g., bash, fastqc, bowtie2"
        />
      </div>

      <div className="property-group">
        <label className="property-label">Command:</label>
        <textarea
          className="property-textarea"
          value={selectedNode.data.command || ''}
          onChange={(e) => handleInputChange('command', e.target.value)}
          placeholder="Enter command to execute"
          rows={4}
        />
        <div className="property-hint">
          Use {'{input}'} and {'{output}'} as placeholders
        </div>
      </div>

      {/* WILDCARDS FEATURE: File Selection */}
      <div className="property-group">
        <label className="property-label">Input Files:</label>
        <button 
          className="property-button" 
          onClick={handleFileSelection}
        >
          📁 Select Files for Batch Processing...
        </button>
        
        {nodeFiles && nodeFiles.length > 0 && (
          <>
            <div className="file-list">
              <div className="file-list-header">
                ✓ Selected {nodeFiles.length} file(s):
              </div>
              {nodeFiles.slice(0, 5).map((file: string, i: number) => (
                <div key={i} className="file-item">
                  {file.split('/').pop()}
                </div>
              ))}
              {nodeFiles.length > 5 && (
                <div className="file-item file-item-more">
                  ... and {nodeFiles.length - 5} more
                </div>
              )}
            </div>
            
            <div className="wildcard-info">
              <div className="property-hint">
                🔄 Pattern: <code>{generatePattern(nodeFiles)}</code>
              </div>
              <div className="property-hint">
                ⚡ Will create {nodeFiles.length} step instance(s)
              </div>
            </div>
            
            <button 
              className="property-button property-button-secondary" 
              onClick={handleClearFiles}
            >
              Clear Selected Files
            </button>
          </>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Input Pattern:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.input || ''}
          onChange={(e) => handleInputChange('input', e.target.value)}
          placeholder="e.g., {sample}.fastq or data/{sample}.txt"
        />
        {hasWildcards(selectedNode.data.input || '') && (
          <div className="property-hint">
            🎯 Wildcard detected - this will process multiple files
          </div>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Output Pattern:</label>
        <input
          type="text"
          className="property-input"
          value={selectedNode.data.output || ''}
          onChange={(e) => handleInputChange('output', e.target.value)}
          placeholder="e.g., output/{sample}.txt"
        />
        {hasWildcards(selectedNode.data.output || '') && (
          <div className="property-hint">
            💾 Output will be generated for each input file
          </div>
        )}
      </div>

      <div className="property-group">
        <label className="property-label">Threads:</label>
        <input
          type="number"
          min={1}
          step={1}
          className="property-input"
          value={selectedNode.data.threads ?? 1}
          onChange={(e) => handleInputChange('threads', e.target.value)}
          onBlur={(e) =>
            handleInputChange('threads', String(normalizeThreads(e.target.value)))
          }
        />
        <div className="property-hint">
          CPU threads this step requests from the scheduler.
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Node Types
// =============================================================================

const nodeTypes = { custom: CustomNode };
const defaultEdgeOptions = { animated: true };

// =============================================================================
// Update Banner Component
// =============================================================================

/**
 * Renders a slim banner at the top of the app when there's something
 * worth saying about updates.
 *
 * Status × manual matrix:
 *
 *   checking      manual → "Checking for updates…"   silent → hidden
 *   up-to-date    manual → "You're up to date"       silent → hidden
 *   available     always shown
 *                   canAutoInstall=true  → "Downloading in the background…"
 *                   canAutoInstall=false → "Download from GitHub" action
 *   downloading   always shown, with a progress strip
 *   downloaded    always shown — "Restart & Install" (only fires on auto-install platforms)
 *   error         always shown
 *
 * Dismissal is per-status-transition; the parent un-dismisses when the
 * status field changes, so dismissing during download still surfaces the
 * "ready to install" prompt when the download finishes.
 */
function UpdateBanner({
  status,
  onInstall,
  onDismiss,
}: {
  status: UpdateStatus | null;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  if (!status) return null;

  // Silent-flow suppression: hide the "Checking…" tick and the
  // "Up to date" reassurance unless the user explicitly asked.
  if (status.status === 'checking' && !status.manual) return null;
  if (status.status === 'up-to-date' && !status.manual) return null;

  let title = '';
  let detail = '';
  let progressPct: number | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  let variant: 'info' | 'success' | 'error' = 'info';

  switch (status.status) {
    case 'checking':
      title = 'Checking for updates…';
      break;
    case 'available':
      title = `Update available — v${status.version}`;
      if (status.canAutoInstall) {
        detail = 'Downloading in the background…';
      } else {
        // Detection-only platform (e.g. unsigned macOS): point the user
        // to GitHub for a manual install.
        detail = 'Open the GitHub release page to download.';
        action = { label: 'Download from GitHub', onClick: onInstall };
      }
      break;
    case 'downloading': {
      title = 'Downloading update';
      progressPct = Math.max(0, Math.min(100, status.percent));
      const speed = formatBytesPerSec(status.bytesPerSecond);
      detail = speed
        ? `${progressPct.toFixed(0)}% — ${speed}`
        : `${progressPct.toFixed(0)}%`;
      break;
    }
    case 'downloaded':
      title = `Update ready — v${status.version}`;
      detail = status.canAutoInstall
        ? 'Restart RustRunner to install.'
        : 'Open the GitHub release page to install.';
      action = {
        label: status.canAutoInstall ? 'Restart & Install' : 'Download from GitHub',
        onClick: onInstall,
      };
      variant = 'success';
      break;
    case 'up-to-date':
      title = `You're up to date — v${status.version}`;
      variant = 'success';
      break;
    case 'error':
      title = 'Update check failed';
      detail = status.message;
      variant = 'error';
      break;
  }

  return (
    <div className={`update-banner update-banner-${variant}`} role="status">
      <div className="update-banner-text">
        <span className="update-banner-title">{title}</span>
        {detail && <span className="update-banner-detail">{detail}</span>}
      </div>

      {progressPct !== null && (
        <div className="update-banner-progress" aria-hidden="true">
          <div
            className="update-banner-progress-bar"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      <div className="update-banner-actions">
        {action && (
          <button className="update-banner-button" onClick={action.onClick}>
            {action.label}
          </button>
        )}
        <button
          className="update-banner-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss update notification"
          title="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Main Editor Component
// =============================================================================

function WorkflowEditorInner() {
  const [nodes, setNodes] = useState<any[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  // Selection is stored as an id, not a node object. Holding the object meant
  // keeping a detached snapshot in sync by hand, which is what forced the old
  // setSelectedNode-inside-setNodes call; deriving it below removes that.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState('Untitled Workflow');
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [executionState, setExecutionState] = useState<'idle' | 'running' | 'paused'>('idle');
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [tempWorkflowName, setTempWorkflowName] = useState('');
  const [executionLogs, setExecutionLogs] = useState<string[]>([]);
  const [showExecutionPanel, setShowExecutionPanel] = useState(true);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [nodeWildcardFiles, setNodeWildcardFiles] = useState<Record<string, string[]>>({});
  const [stepStatus, setStepStatus] = useState<Record<string, NodeStatus>>({});
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logContentRef = useRef<HTMLDivElement>(null);
  /** The canvas viewport, for placing new nodes where they're actually visible. */
  const flowWrapperRef = useRef<HTMLDivElement>(null);
  /** False while the user has scrolled up, so new output doesn't yank them back. */
  const stickToBottomRef = useRef(true);
  const { screenToFlowPosition } = useReactFlow();

  const selectedNode =
    nodes.find((n: any) => n.id === selectedNodeId) ?? null;

  const invalidNodeIds = findInvalidNodeIds(nodes);

  /**
   * Base step ids currently on the canvas, used to attribute engine events
   * back to nodes. Kept in a ref so the IPC listener effect doesn't need to
   * re-subscribe on every canvas edit.
   */
  const baseStepIdsRef = useRef<string[]>([]);
  baseStepIdsRef.current = nodes.map((n: any) => labelToId(n.data?.label || ''));

  /** Maps a canvas node id to its slugified step id. */
  const nodeIdToStepId = (nodeId: string): string => {
    const node = nodes.find((n: any) => n.id === nodeId);
    return node ? labelToId(node.data?.label || '') : '';
  };

  // Suppress ResizeObserver errors
  useEffect(() => {
    const handleError = (event: any) => {
      if (event.message?.includes('ResizeObserver loop completed')) {
        event.stopImmediatePropagation();
        return false;
      }
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  /**
   * Appends lines to the log, capping the buffer.
   *
   * Engine output arrives as arbitrarily sized stdout chunks; those are split
   * into lines before they get here so each entry renders and classifies
   * independently, and so a single chunk can't hide 500 lines behind one
   * severity class.
   */
  const appendLogLines = useCallback((lines: string[]) => {
    if (lines.length === 0) return;

    setExecutionLogs((prev) => {
      const next = [...prev, ...lines];
      if (next.length <= MAX_LOG_LINES) return next;

      const dropped = next.length - MAX_LOG_LINES;
      return [
        `… ${dropped} earlier line(s) trimmed`,
        ...next.slice(dropped + 1),
      ];
    });
  }, []);

  const addLog = useCallback(
    (message: string) => {
      const timestamp = new Date().toLocaleTimeString();
      appendLogLines([`[${timestamp}] ${message}`]);
    },
    [appendLogLines]
  );

  // Setup IPC listeners
  useEffect(() => {
    const unsubscribeOutput = window.electron.ipcRenderer.onWorkflowOutput(
      (output: string) => {
        const lines = output.split('\n').filter((line) => line.trim() !== '');

        // Drive canvas status off the same lines. Anything unrecognized just
        // falls through to the log pane, so wording drift degrades the badges
        // rather than breaking output.
        setStepStatus((prev) => {
          let next = prev;
          for (const line of lines) {
            const event = parseStepEvent(line);
            if (event) {
              next = applyStepEvent(next, event, baseStepIdsRef.current);
            }
          }
          return next;
        });

        appendLogLines(lines);
      }
    );

    const unsubscribeComplete = window.electron.ipcRenderer.onWorkflowComplete(
      (success: boolean, message: string, outcome?: string) => {
        setExecutionState('idle');
        if (outcome === 'stopped') {
          addLog('Workflow stopped by user');
        } else {
          addLog(success ? 'Workflow completed successfully!' : `Workflow failed: ${message}`);
        }
      }
    );

    const unsubscribeError = window.electron.ipcRenderer.onWorkflowError(
      (error: string) => {
        setExecutionState('idle');
        addLog(`Execution error: ${error}`);
      }
    );

    // Auto-update status. Un-dismiss whenever the *kind* of status changes,
    // so a user who dismissed during "downloading" still sees the banner
    // when it transitions to "downloaded". Numeric progress ticks don't
    // count as a kind-change and won't reset the dismissal.
    const unsubscribeUpdate = window.electron.ipcRenderer.onUpdateStatus(
      (payload: UpdateStatus) => {
        setUpdateStatus((prev) => {
          if (prev?.status !== payload.status) {
            setUpdateDismissed(false);
          }
          return payload;
        });
      }
    );

    addLog('Ready to execute workflows');

    return () => {
      unsubscribeOutput();
      unsubscribeComplete();
      unsubscribeError();
      unsubscribeUpdate();
    };
  }, [addLog, appendLogLines]);

  // Auto-dismiss the "up to date" toast after a few seconds — it's only
  // there to give feedback that the manual check ran; we don't want it
  // lingering. Other statuses persist until dismissed by the user or
  // superseded by a new status.
  useEffect(() => {
    if (updateStatus?.status === 'up-to-date' && updateStatus.manual) {
      const id = setTimeout(() => setUpdateDismissed(true), 4000);
      return () => clearTimeout(id);
    }
  }, [updateStatus]);

  // Auto-scroll logs, but only while the user is already at the bottom.
  useEffect(() => {
    if (stickToBottomRef.current) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [executionLogs]);

  const handleLogScroll = useCallback(() => {
    const el = logContentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  }, []);

  // Keep the main process's view of unsaved state current for the close guard.
  useEffect(() => {
    window.electron.ipcRenderer.setDirty(isDirty);
  }, [isDirty]);

  const markDirty = useCallback(() => setIsDirty(true), []);

  // Callbacks
  const onSelectionChange = useCallback(({ nodes: selectedNodes }: any) => {
    setSelectedNodeId(selectedNodes?.length > 0 ? selectedNodes[0].id : null);
  }, []);

  const onNodesChange = useCallback(
    (changes: any) => {
      setNodes((nds) => applyNodeChanges(changes, nds) as any[]);

      // Deletions can also come from the Delete/Backspace key, which bypasses
      // deleteSelectedNodes entirely. Purge here so the wildcard map doesn't
      // accumulate entries for nodes that no longer exist.
      const removed = changes.filter((c: any) => c.type === 'remove');
      if (removed.length > 0) {
        const removedIds = removed.map((c: any) => c.id);
        setNodeWildcardFiles((prev) => {
          const updated = { ...prev };
          removedIds.forEach((id: string) => delete updated[id]);
          return updated;
        });
        setSelectedNodeId((prev) => (prev && removedIds.includes(prev) ? null : prev));
      }

      if (changes.some((c: any) => c.type !== 'select' && c.type !== 'dimensions')) {
        markDirty();
      }
    },
    [markDirty]
  );

  const onEdgesChange = useCallback(
    (changes: any) => {
      setEdges((eds) => applyEdgeChanges(changes, eds) as any[]);
      if (changes.some((c: any) => c.type !== 'select')) markDirty();
    },
    [markDirty]
  );

  const onConnect = useCallback(
    (params: any) => {
      setEdges((eds) => addEdge(params, eds) as any[]);
      markDirty();
    },
    [markDirty]
  );

  const onNodeUpdate = useCallback(
    (nodeId: string, field: string, value: string) => {
      setNodes((nds) =>
        nds.map((node: any) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, [field]: value } }
            : node
        )
      );
      markDirty();
    },
    [markDirty]
  );

  const handleNodeFilesUpdate = useCallback(
    (nodeId: string, files: string[]) => {
      setNodeWildcardFiles((prev) => ({ ...prev, [nodeId]: files }));
      markDirty();
    },
    [markDirty]
  );

  // ---------------------------------------------------------------------------
  // Undo / redo
  //
  // Snapshots of the structural state only. Held in refs rather than state so
  // pushing a snapshot doesn't itself trigger a render.
  // ---------------------------------------------------------------------------

  const undoStack = useRef<any[]>([]);
  const redoStack = useRef<any[]>([]);

  const snapshot = useCallback(
    () => ({
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
      nodeWildcardFiles: JSON.parse(JSON.stringify(nodeWildcardFiles)),
    }),
    [nodes, edges, nodeWildcardFiles]
  );

  /** Records the current state as an undo point. Call *before* mutating. */
  const pushHistory = useCallback(() => {
    undoStack.current = [...undoStack.current, snapshot()].slice(-MAX_HISTORY);
    redoStack.current = [];
  }, [snapshot]);

  const restore = useCallback((state: any) => {
    setNodes(state.nodes);
    setEdges(state.edges);
    setNodeWildcardFiles(state.nodeWildcardFiles);
    setSelectedNodeId(null);
  }, []);

  const handleUndo = useCallback(() => {
    // A focused text field gets native undo instead — the accelerator is
    // captured by the menu, so forward it rather than swallowing it.
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      document.execCommand('undo');
      return;
    }

    const prev = undoStack.current[undoStack.current.length - 1];
    if (!prev) return;

    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, snapshot()].slice(-MAX_HISTORY);
    restore(prev);
    markDirty();
  }, [snapshot, restore, markDirty]);

  const handleRedo = useCallback(() => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      document.execCommand('redo');
      return;
    }

    const next = redoStack.current[redoStack.current.length - 1];
    if (!next) return;

    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, snapshot()].slice(-MAX_HISTORY);
    restore(next);
    markDirty();
  }, [snapshot, restore, markDirty]);

  const addNode = useCallback(() => {
    pushHistory();

    const position = nextNodePosition(
      flowWrapperRef.current,
      nodes.length,
      screenToFlowPosition
    );

    const newNode = {
      id: `node_${Date.now()}`,
      position,
      data: {
        label: `Node ${nodes.length + 1}`,
        tool: '',
        command: '',
        input: '',
        output: '',
        threads: 1,
        color: DEFAULT_COLOR,
      },
      type: 'custom',
    };
    setNodes((nds) => [...nds, newNode]);
    markDirty();
  }, [nodes.length, screenToFlowPosition, pushHistory, markDirty]);

  const deleteSelectedNodes = useCallback(() => {
    const selectedIds = nodes.filter((n: any) => n.selected).map((n: any) => n.id);
    if (selectedIds.length === 0) return;

    pushHistory();
    setNodes((nds) => nds.filter((node: any) => !node.selected));
    setEdges((eds) =>
      eds.filter((edge: any) => !selectedIds.includes(edge.source) && !selectedIds.includes(edge.target))
    );

    setNodeWildcardFiles((prev) => {
      const updated = { ...prev };
      selectedIds.forEach((id) => delete updated[id]);
      return updated;
    });

    setSelectedNodeId(null);
    markDirty();
  }, [nodes, pushHistory, markDirty]);

  // ---------------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------------

  /**
   * Gate for destructive actions. Resolves false when the user backs out of
   * discarding unsaved work.
   */
  const confirmDiscardIfDirty = useCallback(
    async (message: string): Promise<boolean> => {
      if (!isDirty) return true;
      return window.electron.ipcRenderer.confirmDiscard(message);
    },
    [isDirty]
  );

  const handleNew = useCallback(async () => {
    if (!(await confirmDiscardIfDirty('Start a new workflow without saving?'))) return;
    setTempWorkflowName('My Workflow');
    setShowNameDialog(true);
  }, [confirmDiscardIfDirty]);

  const handleConfirmNew = useCallback(() => {
    if (!tempWorkflowName.trim()) return;
    setWorkflowName(tempWorkflowName);
    setShowNameDialog(false);
    addLog(`New workflow created: ${tempWorkflowName}`);

    const templateNodes = [
      {
        id: 'node_1',
        position: { x: 250, y: 100 },
        data: { label: 'Start', tool: '', command: '', input: '', output: '', threads: 1, color: '#a8e6cf' },
        type: 'custom',
      },
      {
        id: 'node_2',
        position: { x: 250, y: 250 },
        data: { label: 'Process', tool: '', command: '', input: '', output: '', threads: 1, color: DEFAULT_COLOR },
        type: 'custom',
      },
    ];

    setNodes(templateNodes);
    setEdges([]);
    setSelectedNodeId(null);
    setExecutionState('idle');
    setNodeWildcardFiles({});
    setStepStatus({});
    setCurrentFilePath(null);
    setIsDirty(false);
    undoStack.current = [];
    redoStack.current = [];
  }, [tempWorkflowName, addLog]);

  const handleOpen = useCallback(async () => {
    if (!(await confirmDiscardIfDirty('Open another workflow without saving?'))) return;

    try {
      const result = await window.electron.ipcRenderer.openWorkflow();
      if (!result) return;

      const data = JSON.parse(result.contents);

      // Guard the shape before handing it to React Flow — a malformed file
      // would otherwise blow up deep inside the renderer.
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        addLog('Invalid workflow file: expected "nodes" and "edges" arrays');
        return;
      }
      if (!data.nodes.every((n: any) => n && typeof n.id === 'string' && n.position)) {
        addLog('Invalid workflow file: one or more nodes are malformed');
        return;
      }

      setNodes(data.nodes);
      setEdges(data.edges);
      setSelectedNodeId(null);
      setStepStatus({});
      setNodeWildcardFiles(data.wildcardFiles || {});
      if (data.metadata?.name) setWorkflowName(data.metadata.name);
      setCurrentFilePath(result.path);
      setIsDirty(false);
      undoStack.current = [];
      redoStack.current = [];

      addLog(
        `Workflow opened: ${data.nodes.length} nodes, ${data.edges.length} edges — ${result.path}`
      );
    } catch (error) {
      addLog(`Failed to open workflow: ${error}`);
    }
  }, [addLog, confirmDiscardIfDirty]);

  /**
   * Writes the workflow. `saveAs` forces a location prompt; otherwise the
   * current file is overwritten in place, falling back to a prompt the first
   * time. Previously every save produced a fresh timestamped copy in the
   * browser download directory and could never overwrite.
   */
  const saveWorkflowTo = useCallback(
    async (saveAs: boolean) => {
      try {
        const exportData = {
          nodes,
          edges,
          wildcardFiles: nodeWildcardFiles,
          metadata: {
            name: workflowName,
            version: '1.1.0',
            createdAt: new Date().toISOString(),
          },
        };

        const safeName = workflowName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const written = await window.electron.ipcRenderer.saveWorkflow(
          JSON.stringify(exportData, null, 2),
          saveAs ? null : currentFilePath,
          safeName
        );

        if (!written) return;

        setCurrentFilePath(written);
        setIsDirty(false);
        addLog(`Workflow saved: ${written}`);
      } catch (error) {
        addLog(`Failed to save workflow: ${error}`);
      }
    },
    [nodes, edges, nodeWildcardFiles, workflowName, currentFilePath, addLog]
  );

  const handleSave = useCallback(() => saveWorkflowTo(false), [saveWorkflowTo]);
  const handleSaveAs = useCallback(() => saveWorkflowTo(true), [saveWorkflowTo]);

  const handleClear = useCallback(async () => {
    if (nodes.length === 0 && edges.length === 0) return;
    if (!(await confirmDiscardIfDirty('Clear all nodes and edges?'))) return;

    pushHistory();
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setExecutionState('idle');
    setNodeWildcardFiles({});
    setStepStatus({});
    addLog('Canvas cleared');
  }, [nodes.length, edges.length, confirmDiscardIfDirty, pushHistory, addLog]);

  const handleSelectDirectory = useCallback(async () => {
    const directory = await window.electron.ipcRenderer.selectDirectory();
    if (directory) {
      setWorkingDirectory(directory);
      addLog(`Working directory set: ${directory}`);
    }
  }, [addLog]);

  /**
   * Shared preflight for Run and Dry Run: resolves a working directory,
   * builds and validates the workflow, and clears stale canvas status.
   * Returns null when the user cancelled or validation failed.
   */
  const prepareRun = useCallback(
    async (label: string): Promise<{ workflow: any; dir: string } | null> => {
      let dir = workingDirectory;
      if (!dir) {
        addLog(`Select working directory for ${label}...`);
        dir = (await window.electron.ipcRenderer.selectDirectory()) || '';
        if (!dir) {
          addLog(`${label} cancelled - no directory selected`);
          return null;
        }
        setWorkingDirectory(dir);
        addLog(`Working directory set: ${dir}`);
      }

      const workflow = convertNodesToWorkflow(nodes, edges, nodeWildcardFiles);

      const errors = validateWorkflow(workflow);
      if (errors.length > 0) {
        addLog('Workflow validation failed:');
        errors.forEach((err) => addLog(`  - ${err}`));
        return null;
      }

      const wildcardSteps = workflow.steps.filter((s: any) => s.wildcard_files);
      if (wildcardSteps.length > 0) {
        const total = wildcardSteps.reduce(
          (sum: number, s: any) => sum + s.wildcard_files[WILDCARD_NAME].length,
          0
        );
        addLog(
          `🔄 Wildcards on ${wildcardSteps.length} step(s) — ${total} file(s) to expand`
        );
      }

      setStepStatus({});
      return { workflow, dir };
    },
    [nodes, edges, nodeWildcardFiles, workingDirectory, addLog]
  );

  // Execution
  const handleRun = useCallback(async () => {
    if (executionState === 'paused') {
      setExecutionState('running');
      window.electron.ipcRenderer.resumeWorkflow();
      return;
    }

    const prepared = await prepareRun('workflow files');
    if (!prepared) return;

    setExecutionState('running');
    window.electron.ipcRenderer.runWorkflow(prepared.workflow, false, prepared.dir);
  }, [executionState, prepareRun]);

  const handleDryRun = useCallback(async () => {
    const prepared = await prepareRun('dry run');
    if (!prepared) return;

    addLog('Starting dry run (commands will not execute)...');
    window.electron.ipcRenderer.runWorkflow(prepared.workflow, true, prepared.dir);
  }, [prepareRun, addLog]);

  const handlePause = useCallback(() => {
    if (executionState === 'running') {
      setExecutionState('paused');
      window.electron.ipcRenderer.pauseWorkflow();
    }
  }, [executionState]);

  const handleStop = useCallback(() => {
    if (executionState === 'idle') return;
    addLog('Stopping workflow...');
    // The main process kills the Rust child, which triggers
    // workflow-complete and resets executionState to 'idle'.
    window.electron.ipcRenderer.stopWorkflow();
  }, [executionState, addLog]);

  const handleClearLogs = useCallback(() => {
    setExecutionLogs([]);
    const timestamp = new Date().toLocaleTimeString();
    setExecutionLogs([`[${timestamp}] Logs cleared`]);
  }, []);

  const handleTogglePanel = useCallback(() => {
    setShowExecutionPanel((prev) => !prev);
  }, []);

  // Menu → renderer dispatch. The File/Edit menu items can't act in the main
  // process because the workflow lives in renderer state; before this, the
  // Windows/Linux Ctrl+N/O/S accelerators were declared but did nothing.
  useEffect(() => {
    return window.electron.ipcRenderer.onMenuAction((action) => {
      switch (action) {
        case 'new':
          handleNew();
          break;
        case 'open':
          handleOpen();
          break;
        case 'save':
          handleSave();
          break;
        case 'save-as':
          handleSaveAs();
          break;
        case 'undo':
          handleUndo();
          break;
        case 'redo':
          handleRedo();
          break;
      }
    });
  }, [handleNew, handleOpen, handleSave, handleSaveAs, handleUndo, handleRedo]);

  // Nodes handed to React Flow carry live status and validation state under
  // reserved `__` keys. Kept out of `nodes` itself so neither ends up in a
  // saved workflow file or in the undo history.
  const decoratedNodes = nodes.map((node: any) => {
    const status = stepStatus[nodeIdToStepId(node.id)];
    const invalidReason = invalidNodeIds[node.id];
    if (!status && !invalidReason) return node;
    return { ...node, data: { ...node.data, __status: status, __invalidReason: invalidReason } };
  });

  const progress = (() => {
    const entries = Object.values(stepStatus);
    if (entries.length === 0) return null;
    const finished = entries.filter(
      (s) => s.state === 'done' || s.state === 'failed'
    ).length;
    return `${finished} / ${nodes.length} steps`;
  })();

  return (
    <div className="workflow-editor">
      {/* Auto-update banner — only renders for meaningful states. */}
      {!updateDismissed && (
        <UpdateBanner
          status={updateStatus}
          onInstall={() => window.electron.ipcRenderer.installUpdate()}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      <div className="main-content">
        <div className="flow-container" ref={flowWrapperRef}>
          {/* Top Toolbar */}
          <div className="top-toolbar">
            <div className="workflow-info">
              <div className="workflow-title">
                {workflowName}
                {isDirty && <span className="dirty-marker" title="Unsaved changes">•</span>}
              </div>
              {(currentFilePath || workingDirectory) && (
                <div className="working-directory">
                  {(currentFilePath || workingDirectory).replace(/^.*[\\\/]/, '')}
                </div>
              )}
            </div>

            <div className="file-buttons">
              <button className="toolbar-button" onClick={handleNew}>New</button>
              <button className="toolbar-button" onClick={handleOpen}>Open</button>
              <button className="toolbar-button" onClick={handleSave}>Save</button>
              <button className="toolbar-button" onClick={handleSaveAs}>Save As</button>
              <button className="toolbar-button" onClick={handleClear}>Clear</button>
              <button className="toolbar-button" onClick={handleSelectDirectory}>
                Set Directory
              </button>
            </div>

            <div className="edit-buttons">
              <button className="toolbar-button add-button" onClick={addNode}>+ Add Node</button>
              <button className="toolbar-button delete-button" onClick={deleteSelectedNodes}>Delete</button>
            </div>
          </div>

          {/* Execution Controls */}
          <div className="execution-controls">
            <button
              className={`execution-button run-button ${executionState === 'running' ? 'active' : ''}`}
              onClick={handleRun}
              disabled={nodes.length === 0 || executionState === 'running'}
            >
              {executionState === 'paused' ? 'Resume' : 'Run'}
            </button>

            <button
              className="execution-button dry-run-button"
              onClick={handleDryRun}
              disabled={nodes.length === 0 || executionState !== 'idle'}
            >
              Dry Run
            </button>

            <button
              className={`execution-button pause-button ${executionState === 'paused' ? 'active' : ''}`}
              onClick={handlePause}
              disabled={executionState !== 'running'}
            >
              Pause
            </button>

            <button
              className="execution-button stop-button"
              onClick={handleStop}
              disabled={executionState === 'idle'}
            >
              Stop
            </button>

            {progress && <div className="execution-progress">{progress}</div>}
          </div>

          <ReactFlow
            nodes={decoratedNodes}
            edges={edges}
            defaultEdgeOptions={defaultEdgeOptions}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            fitView
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={30}
              color="var(--canvas-grid)"
            />
            <Controls />
            <MiniMap
              nodeStrokeWidth={1}
              nodeColor={(node: any) => node.data?.color || '#aaa'}
            />
          </ReactFlow>
        </div>

        {selectedNode && (
          <PropertiesPanel
            selectedNode={selectedNode}
            onNodeUpdate={onNodeUpdate}
            nodeFiles={nodeWildcardFiles[selectedNode.id] || []}
            onNodeFilesUpdate={handleNodeFilesUpdate}
            addLog={addLog}
            invalidReason={invalidNodeIds[selectedNode.id]}
          />
        )}
      </div>

      {/* Execution Logs Panel */}
      <div className={`execution-panel ${showExecutionPanel ? 'visible' : 'hidden'}`}>
        <div className="execution-panel-header">
          <h3>Execution Logs</h3>
          <div className="execution-panel-controls">
            <button className="panel-button" onClick={handleClearLogs}>Clear</button>
            <button className="panel-button" onClick={handleTogglePanel}>
              {showExecutionPanel ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {showExecutionPanel && (
          <div
            className="execution-panel-content"
            ref={logContentRef}
            onScroll={handleLogScroll}
          >
            {executionLogs.map((log, index) => (
              <div key={index} className={`log-entry ${classifyLogLine(log)}`}>
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      {/* Name Dialog */}
      {showNameDialog && (
        <div className="dialog-overlay" onClick={() => setShowNameDialog(false)}>
          <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
            <h3>New Workflow</h3>
            <label>
              Workflow Name:
              <input
                type="text"
                className="dialog-input"
                value={tempWorkflowName}
                onChange={(e) => setTempWorkflowName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleConfirmNew()}
                autoFocus
              />
            </label>
            <p className="dialog-hint">
              You will choose a working directory when you click Run.
            </p>
            <div className="dialog-buttons">
              <button className="dialog-button cancel" onClick={() => setShowNameDialog(false)}>
                Cancel
              </button>
              <button className="dialog-button confirm" onClick={handleConfirmNew}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// App with Provider
// =============================================================================

export default function App() {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner />
    </ReactFlowProvider>
  );
}
