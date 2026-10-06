/**
 * RustRunner Workflow Editor
 *
 * Owns editor state and wires the canvas, properties panel, execution logs
 * and update banner together. Pure logic lives in ./workflowConversion and
 * the presentational pieces in ./components.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  useReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  ReactFlowProvider,
} from '@xyflow/react';
import './App.css';
import {
  applyStepEvent,
  parseStepEvent,
  type NodeStatus,
} from './stepEvents';
import {
  WILDCARD_NAME,
  convertNodesToWorkflow,
  findInvalidNodeIds,
  labelToId,
  validateWorkflow,
} from './workflowConversion';
import { UpdateBanner, type UpdateStatus } from './components/UpdateBanner';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ExecutionLogs } from './components/ExecutionLogs';
import {
  WorkflowCanvas,
  DEFAULT_COLOR,
  nextNodePosition,
} from './components/WorkflowCanvas';

/**
 * Cap on retained log lines. A chatty run (or `seq 1 200000`) used to grow
 * the array without limit, one <div> per stdout chunk, until the renderer
 * stalled. Oldest lines are dropped and replaced with a trim marker.
 */
const MAX_LOG_LINES = 5000;

/** Cap on undo history depth. */
const MAX_HISTORY = 50;


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
  /** The canvas viewport, for placing new nodes where they're actually visible. */
  const flowWrapperRef = useRef<HTMLDivElement>(null);
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
    (nodeId: string, field: string, value: string | boolean) => {
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


          <WorkflowCanvas
            nodes={decoratedNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
          />
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
      <ExecutionLogs
        logs={executionLogs}
        visible={showExecutionPanel}
        onClear={handleClearLogs}
        onToggle={handleTogglePanel}
      />

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
