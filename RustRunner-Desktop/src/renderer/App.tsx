/**
 * RustRunner Workflow Editor
 *
 * Owns editor state and wires the canvas, properties panel, execution logs
 * and update banner together. Pure logic lives in ./workflowConversion and
 * the presentational pieces in ./components.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  addEdge,
  ReactFlowProvider,
} from '@xyflow/react';
import './styles/tokens.css';
import './styles/base.css';
import './ui/ui.css';
import './App.css';
import {
  applyRunEvent,
  buildStatusRows,
  toStepEvent,
  resolveBaseStepId,
  rollupNodeStatuses,
  type RunPhase,
  type StepRuns,
} from './stepEvents';
import {
  convertNodesToWorkflow,
  countMockedNodes,
  findInvalidNodeIds,
  generateWorkflowId,
  isValidWorkflowId,
  labelToId,
  validateWorkflow,
} from './workflowConversion';
import {
  belowPosition,
  occupiedRects,
  typicalNodeSize,
  viewportToReveal,
} from './nodePlacement';
import {
  emptyHistory,
  record,
  redo,
  takeSnapshot,
  undo,
  type GraphSnapshot,
  type History,
  type RecordOptions,
} from './history';
import {
  blockedReason,
  collectIssues,
  fieldErrors,
  type ValidationIssue,
} from './validation';
import {
  SHORTCUTS,
  formatKeys,
  isTypingTarget,
  matchShortcut,
  type ShortcutAction,
} from './shortcuts';
import { RUN_TOOLTIPS, describeRunState, type RunOutcome } from './runState';
import { describeResume, type ResumeInfo } from './resume';
import { UpdateBanner, type UpdateStatus } from './components/UpdateBanner';
import { PropertiesPanel, type FocusRequest } from './components/PropertiesPanel';
import { EmptyState } from './components/EmptyState';
import { ProblemsPanel } from './components/ProblemsPanel';
import { ExecutionLogs, type ExecutionTab } from './components/ExecutionLogs';
import { StepStatusPanel } from './components/StepStatusPanel';
import { RunHistoryPanel } from './components/RunHistoryPanel';
import type { RunHistoryEntry } from '../main/runHistory';
import { ToolPalette } from './components/ToolPalette';
import {
  buildCatalogNodeData,
  checkEdge,
  validateCatalogNodes,
  type CatalogTool,
} from './tools/catalog';
import {
  DEFAULT_EDGE_OPTIONS,
  WorkflowCanvas,
  nextNodePosition,
} from './components/WorkflowCanvas';
import { setConnection, upstreamChoices } from './connections';
import {
  applyBinding,
  connectWithBinding,
  kindPatch,
  linkChoices,
  linkPatch,
  planBinding,
  previewForNode,
  slotStates,
  typedPatch,
  unlinkPatch,
  type BindingOption,
  type SlotKind,
} from './slots';
import { DEFAULT_NODE_COLOR } from './nodeColors';
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Icon,
  IconButton,
  Kbd,
  TextField,
  ToastHost,
  Tooltip,
  useToasts,
  type ConfirmRequest,
} from './ui';
import { RunBanner } from './components/RunBanner';
import {
  PENDING_STATUS,
  buildFailureCard,
  describeRunResult,
  sectionToEdit,
  type FailureCardData,
  type RunResult,
} from './runFeedback';
import type { LogFilter } from './logLines';

/**
 * Cap on retained log lines. A chatty run (or `seq 1 200000`) used to grow
 * the array without limit, one <div> per stdout chunk, until the renderer
 * stalled. Oldest lines are dropped and replaced with a trim marker.
 */
const MAX_LOG_LINES = 5000;

/** The Mac check decides which key is "Mod" in shortcuts and their labels. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

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
  const [workflowVersion, setWorkflowVersion] = useState('');
  // Stable id: keys the engine's saved run, so renaming keeps its up-to-date steps.
  const [workflowId, setWorkflowId] = useState(() => generateWorkflowId());
  /** Keep running independent steps after one fails. */
  const [keepGoing, setKeepGoing] = useState(false);
  const [tempKeepGoing, setTempKeepGoing] = useState(false);
  /** 'new' starts a fresh canvas; 'details' only edits the name and version. */
  const [nameDialog, setNameDialog] = useState<'new' | 'details' | null>(null);
  const [tempWorkflowName, setTempWorkflowName] = useState('');
  const [tempWorkflowVersion, setTempWorkflowVersion] = useState('');
  const [executionLogs, setExecutionLogs] = useState<string[]>([]);
  const [showExecutionPanel, setShowExecutionPanel] = useState(true);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [nodeWildcardFiles, setNodeWildcardFiles] = useState<Record<string, string[]>>({});
  /** What the engine has reported per engine step during the current/last run. */
  const [stepRuns, setStepRuns] = useState<StepRuns>({});
  const [runPhase, setRunPhase] = useState<RunPhase>('none');
  const [executionTab, setExecutionTab] = useState<ExecutionTab>('logs');
  const [resumeInfo, setResumeInfo] = useState<ResumeInfo | null>(null);
  /** Runs of this workflow in the working directory, newest first. */
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [historyStatus, setHistoryStatus] = useState<'loading' | 'ready' | 'error'>('ready');
  /** Bumped by "Try again" to reload the history. */
  const [historyReload, setHistoryReload] = useState(0);
  /** HTML report of the last real run (absolute path from the engine). */
  const [latestReport, setLatestReport] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** A connection that could fill several file slots: the person picks one in the later step's properties. */
  const [pendingBinding, setPendingBinding] = useState<{ sourceId: string; targetId: string } | null>(null);
  /** The canvas viewport, for placing new nodes where they're actually visible. */
  const flowWrapperRef = useRef<HTMLDivElement>(null);
  /** The catalog button, so closing the palette hands focus back to it. */
  const paletteButtonRef = useRef<HTMLButtonElement>(null);
  const { screenToFlowPosition, fitView, getViewport, setViewport } = useReactFlow();

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** The problem list is open (the person asked, or tried to run with problems). */
  const [problemsOpen, setProblemsOpen] = useState(false);
  /** Show every problem on its field, not only on fields already visited. */
  const [revealProblems, setRevealProblems] = useState(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const confirmResolver = useRef<((ok: boolean) => void) | null>(null);
  const [runOutcome, setRunOutcome] = useState<RunOutcome | null>(null);
  const [dryRunActive, setDryRunActive] = useState(false);
  /** How the last run ended, from the engine's `run_finished` event. */
  const [runResult, setRunResult] = useState<(RunResult & { dry: boolean }) | null>(null);
  const [summaryDismissed, setSummaryDismissed] = useState(false);
  const [logFilter, setLogFilter] = useState<LogFilter>('all');
  const { toasts, notify, dismiss: dismissToast } = useToasts();
  /** Whether the run now in flight is a dry run, readable from the IPC listeners. */
  const dryRunRef = useRef(false);

  const selectedNode =
    nodes.find((n: any) => n.id === selectedNodeId) ?? null;

  const invalidNodeIds = findInvalidNodeIds(nodes);

  /** Everything that stops a run, for the problem list, the fields and the Run buttons. */
  const issues = useMemo(
    () => collectIssues(nodes, nodeWildcardFiles, edges),
    [nodes, nodeWildcardFiles, edges]
  );
  const hasProblems = nodes.length > 0 && issues.length > 0;

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
        // Raw engine log only; step progress arrives as typed events below.
        const lines = output.split('\n').filter((line) => line.trim() !== '');
        appendLogLines(lines);
      }
    );

    // Typed run events drive the canvas badges and the status panel.
    const unsubscribeEvent = window.electron.ipcRenderer.onWorkflowEvent(
      (runEvent) => {
        if (runEvent.event === 'run_started') {
          setLatestReport(null);
          setRunResult(null);
          setSummaryDismissed(false);
        }
        if (runEvent.event === 'run_finished') {
          if (runEvent.report) setLatestReport(runEvent.report);
          setRunResult({
            status: runEvent.status,
            summary: runEvent.summary,
            report: runEvent.report,
            dry: dryRunRef.current,
          });
        }
        const event = toStepEvent(runEvent);
        if (!event || !resolveBaseStepId(event.stepId, baseStepIdsRef.current)) {
          return;
        }
        setStepRuns((prev) => applyRunEvent(prev, event));
      }
    );

    const unsubscribeComplete = window.electron.ipcRenderer.onWorkflowComplete(
      (success: boolean, message: string, outcome?: string) => {
        setExecutionState('idle');
        setRunPhase('ended');
        // A dry run runs nothing, so it does not change how the last real run ended.
        if (!dryRunRef.current) {
          setRunOutcome(outcome === 'stopped' ? 'stopped' : success ? 'success' : 'failed');
        }
        dryRunRef.current = false;
        setDryRunActive(false);
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
        setRunPhase('ended');
        if (!dryRunRef.current) setRunOutcome('failed');
        dryRunRef.current = false;
        setDryRunActive(false);
        addLog(`Execution error: ${error}`);
        notify('danger', 'The run could not be started. See the log for details.');
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
      unsubscribeEvent();
      unsubscribeComplete();
      unsubscribeError();
      unsubscribeUpdate();
    };
  }, [addLog, appendLogLines, notify]);

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

  // ---------------------------------------------------------------------------
  // Undo / redo
  //
  // Snapshots of the structural state (nodes, edges, selected files), kept in a
  // ref so recording one does not render. `recordEdit` is called *before* an
  // edit changes the canvas; the rules live in ./history.
  // ---------------------------------------------------------------------------

  /** The latest canvas state, readable from callbacks that must not re-subscribe. */
  const graphRef = useRef<{ nodes: any[]; edges: any[]; wildcardFiles: Record<string, string[]> }>({
    nodes,
    edges,
    wildcardFiles: nodeWildcardFiles,
  });
  graphRef.current = { nodes, edges, wildcardFiles: nodeWildcardFiles };

  const historyRef = useRef<History<GraphSnapshot>>(emptyHistory());

  const currentSnapshot = useCallback((): GraphSnapshot => {
    const g = graphRef.current;
    return takeSnapshot(g.nodes, g.edges, g.wildcardFiles);
  }, []);

  const recordEdit = useCallback(
    (options?: RecordOptions) => {
      historyRef.current = record(historyRef.current, currentSnapshot, options);
    },
    [currentSnapshot]
  );

  const resetHistory = useCallback(() => {
    historyRef.current = emptyHistory();
  }, []);

  const restore = useCallback((state: GraphSnapshot) => {
    setNodes(state.nodes);
    setEdges(state.edges);
    setNodeWildcardFiles(state.wildcardFiles);
    setSelectedNodeId(null);
  }, []);

  const stepHistory = useCallback(
    (direction: 'undo' | 'redo') => {
      const step = (direction === 'undo' ? undo : redo)(historyRef.current, currentSnapshot());
      if (!step) return;
      historyRef.current = step.history;
      restore(step.state);
      markDirty();
    },
    [currentSnapshot, restore, markDirty]
  );

  /**
   * Undo and redo from the Edit menu. A focused text field gets its own native
   * undo instead; the accelerator is captured by the menu, so it is forwarded
   * rather than swallowed.
   */
  const handleUndo = useCallback(() => {
    const el = document.activeElement;
    if (isTypingTarget(el)) {
      document.execCommand('undo');
      return;
    }
    stepHistory('undo');
  }, [stepHistory]);

  const handleRedo = useCallback(() => {
    const el = document.activeElement;
    if (isTypingTarget(el)) {
      document.execCommand('redo');
      return;
    }
    stepHistory('redo');
  }, [stepHistory]);

  const onNodesChange = useCallback(
    (changes: any) => {
      // updateNodeData (the colour picker) hands back the node as the canvas
      // sees it, with the live status and problem keys added. Those are derived
      // and must not become part of the saved node.
      const cleaned = changes.map((c: any) => {
        if (c.type !== 'replace' || !c.item?.data) return c;
        const data = Object.fromEntries(
          Object.entries(c.item.data).filter(([key]) => !key.startsWith('__'))
        );
        return { ...c, item: { ...c.item, data } };
      });
      if (cleaned.some((c: any) => c.type === 'replace')) {
        recordEdit({ key: `replace:${cleaned.find((c: any) => c.type === 'replace').id}` });
      }
      setNodes((nds) => applyNodeChanges(cleaned, nds) as any[]);

      // Deletions can also come from the canvas itself. Purge here so the
      // wildcard map doesn't accumulate entries for nodes that no longer exist.
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
    [markDirty, recordEdit]
  );

  const onEdgesChange = useCallback(
    (changes: any) => {
      setEdges((eds) => applyEdgeChanges(changes, eds) as any[]);
      if (changes.some((c: any) => c.type !== 'select')) markDirty();
    },
    [markDirty]
  );

  /**
   * A new connection fills a free file slot of the later step with a matching
   * output of the earlier one (see slots.ts). When several fit, the person is
   * asked in the later step's properties, which open for that.
   */
  const bindAfterConnect = useCallback(
    (sourceId: string, targetId: string, edgesBefore: any[], edgesAfter: any[]) => {
      const current = graphRef.current.nodes;
      const { nodes: bound, plan } = connectWithBinding(
        current,
        edgesBefore,
        edgesAfter,
        sourceId,
        targetId
      );
      if (plan.kind === 'ask') {
        setNodes(bound.map((n: any) => (n.selected === (n.id === targetId) ? n : { ...n, selected: n.id === targetId })));
        setSelectedNodeId(targetId);
        setPendingBinding({ sourceId, targetId });
        return;
      }
      setPendingBinding(null);
      if (bound.some((n: any, i: number) => n !== current[i])) setNodes(bound);
    },
    []
  );

  const onConnect = useCallback(
    (params: any) => {
      recordEdit();
      const before = graphRef.current.edges;
      const after = addEdge(params, before) as any[];
      setEdges(after);
      if (after.length > before.length) {
        bindAfterConnect(params.source, params.target, before, after);
      }
      markDirty();
    },
    [markDirty, recordEdit, bindAfterConnect]
  );

  /**
   * "Runs after" in the properties panel: the keyboard's way to connect two
   * steps. Same edge as a drag, one undo step; loops are refused.
   */
  const onConnectionChange = useCallback(
    (sourceId: string, targetId: string, connected: boolean) => {
      recordEdit();
      const before = graphRef.current.edges;
      const after = setConnection(before, sourceId, targetId, connected, DEFAULT_EDGE_OPTIONS);
      setEdges(after);
      if (connected && after.length > before.length) {
        bindAfterConnect(sourceId, targetId, before, after);
      }
      markDirty();
    },
    [markDirty, recordEdit, bindAfterConnect]
  );

  /** A drag is one undo step: the state from before it started. */
  const onDragStart = useCallback(() => recordEdit(), [recordEdit]);

  const onNodeUpdate = useCallback(
    (nodeId: string, field: string, value: string | boolean) => {
      recordEdit({ key: `${nodeId}:${field}` });
      setNodes((nds) =>
        nds.map((node: any) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, [field]: value } }
            : node
        )
      );
      markDirty();
    },
    [markDirty, recordEdit]
  );

  /** Changes several fields of a node at once, so no render sees a half-applied edit. */
  const onNodePatch = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      recordEdit({ key: `${nodeId}:${Object.keys(patch).sort().join(',')}` });
      setNodes((nds) =>
        nds.map((node: any) =>
          node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
        )
      );
      markDirty();
    },
    [markDirty, recordEdit]
  );

  const handleNodeFilesUpdate = useCallback(
    (nodeId: string, files: string[]) => {
      recordEdit({ key: `${nodeId}:files` });
      setNodeWildcardFiles((prev) => ({ ...prev, [nodeId]: files }));
      markDirty();
    },
    [markDirty, recordEdit]
  );

  /**
   * Where a new step goes: under the selected step, or under the one added
   * last, so a chain reads top to bottom and its connections run straight
   * down (see belowPosition). The view pans when that spot is off screen.
   * With nothing to follow, the first free cell of the visible canvas.
   */
  const placeNewNode = useCallback((): { x: number; y: number } => {
    const occupied = occupiedRects(nodes);
    const anchorNode = nodes.find((n: any) => n.id === selectedNodeId) ?? nodes[nodes.length - 1];
    const below = anchorNode ? belowPosition(occupiedRects([anchorNode])[0], occupied) : null;
    if (!below) {
      return nextNodePosition(flowWrapperRef.current, nodes.length, screenToFlowPosition, occupied);
    }
    const wrapper = flowWrapperRef.current;
    if (wrapper) {
      const box = wrapper.getBoundingClientRect();
      const current = getViewport();
      const next = viewportToReveal(
        current,
        { ...below, ...typicalNodeSize(occupied) },
        { width: box.width, height: box.height },
        // Clear of the run controls on the left; on the right, of the
        // properties panel that opens when nothing was selected yet.
        { top: 16, left: 216, bottom: 24, right: 24 + (selectedNodeId ? 0 : 320) }
      );
      if (next.x !== current.x || next.y !== current.y) void setViewport(next);
    }
    return below;
  }, [nodes, selectedNodeId, screenToFlowPosition, getViewport, setViewport]);

  const addNode = useCallback(() => {
    recordEdit();

    const position = placeNewNode();

    // Selected at once, like a step from the catalog, so its properties are
    // next in the tab order and the keyboard can fill it in straight away.
    const newNode = {
      id: `node_${Date.now()}`,
      position,
      selected: true,
      data: {
        label: `Node ${nodes.length + 1}`,
        tool: '',
        command: '',
        input: '',
        output: '',
        threads: 1,
        color: DEFAULT_NODE_COLOR,
      },
      type: 'custom',
    };
    setNodes((nds) => [...nds.map((n: any) => (n.selected ? { ...n, selected: false } : n)), newNode]);
    setEdges((eds) => (eds.some((e: any) => e.selected) ? eds.map((e: any) => ({ ...e, selected: false })) : eds));
    setSelectedNodeId(newNode.id);
    // The problem list would cover the new step; its button stays.
    setProblemsOpen(false);
    markDirty();
  }, [nodes, placeNewNode, recordEdit, markDirty]);

  /** Adds a node prefilled from a catalog tool and selects it, so its options show. */
  const addCatalogNode = useCallback(
    (tool: CatalogTool) => {
      recordEdit();

      const position = placeNewNode();

      const newNode = {
        id: `node_${Date.now()}`,
        position,
        selected: true,
        data: buildCatalogNodeData(
          tool,
          nodes.map((n: any) => n.data?.label || '')
        ),
        type: 'custom',
      };
      setNodes((nds) => [...nds.map((n: any) => ({ ...n, selected: false })), newNode]);
      setSelectedNodeId(newNode.id);
      setPaletteOpen(false);
      setProblemsOpen(false);
      markDirty();
    },
    [nodes, placeNewNode, recordEdit, markDirty]
  );

  /** Removes the selected steps (with their connections) and the selected connections. */
  const deleteSelection = useCallback(() => {
    const g = graphRef.current;
    const nodeIds = g.nodes.filter((n: any) => n.selected).map((n: any) => n.id);
    const edgeIds = g.edges.filter((e: any) => e.selected).map((e: any) => e.id);
    if (nodeIds.length === 0 && edgeIds.length === 0) return;

    recordEdit();
    setNodes((nds) => nds.filter((node: any) => !nodeIds.includes(node.id)));
    setEdges((eds) =>
      eds.filter(
        (edge: any) =>
          !edgeIds.includes(edge.id) &&
          !nodeIds.includes(edge.source) &&
          !nodeIds.includes(edge.target)
      )
    );
    setNodeWildcardFiles((prev) => {
      const updated = { ...prev };
      nodeIds.forEach((id: string) => delete updated[id]);
      return updated;
    });
    setSelectedNodeId(null);
    markDirty();
  }, [recordEdit, markDirty]);

  /** Clears the selection (Escape). */
  const deselectAll = useCallback(() => {
    setNodes((nds) => (nds.some((n: any) => n.selected) ? nds.map((n: any) => ({ ...n, selected: false })) : nds));
    setEdges((eds) => (eds.some((e: any) => e.selected) ? eds.map((e: any) => ({ ...e, selected: false })) : eds));
    setSelectedNodeId(null);
  }, []);

  // ---------------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------------

  /** Asks in the app (not the operating system) and resolves with the answer. */
  const askConfirm = useCallback(
    (request: ConfirmRequest): Promise<boolean> =>
      new Promise((resolve) => {
        confirmResolver.current?.(false);
        confirmResolver.current = resolve;
        setConfirmRequest(request);
      }),
    []
  );

  const resolveConfirm = useCallback((ok: boolean) => {
    confirmResolver.current?.(ok);
    confirmResolver.current = null;
    setConfirmRequest(null);
  }, []);

  /**
   * Gate for destructive actions. Resolves false when the user backs out of
   * discarding unsaved work.
   */
  const confirmDiscardIfDirty = useCallback(
    async (request: ConfirmRequest): Promise<boolean> => {
      if (!isDirty) return true;
      return askConfirm(request);
    },
    [isDirty, askConfirm]
  );

  const handleNew = useCallback(async () => {
    if (
      !(await confirmDiscardIfDirty({
        title: 'Start a new workflow?',
        message: 'This workflow has unsaved changes. Starting a new one discards them.',
        confirmLabel: 'Discard changes',
      }))
    ) {
      return;
    }
    setTempWorkflowName('My Workflow');
    setTempWorkflowVersion('');
    setTempKeepGoing(false);
    setNameDialog('new');
  }, [confirmDiscardIfDirty]);

  const handleEditDetails = useCallback(() => {
    setTempWorkflowName(workflowName);
    setTempWorkflowVersion(workflowVersion);
    setTempKeepGoing(keepGoing);
    setNameDialog('details');
  }, [workflowName, workflowVersion, keepGoing]);

  const handleConfirmDetails = useCallback(() => {
    if (!tempWorkflowName.trim()) return;
    setWorkflowName(tempWorkflowName);
    setWorkflowVersion(tempWorkflowVersion);
    setKeepGoing(tempKeepGoing);
    setNameDialog(null);
    markDirty();
  }, [tempWorkflowName, tempWorkflowVersion, tempKeepGoing, markDirty]);

  const handleConfirmNew = useCallback(() => {
    if (!tempWorkflowName.trim()) return;
    setWorkflowName(tempWorkflowName);
    setWorkflowVersion(tempWorkflowVersion);
    setKeepGoing(tempKeepGoing);
    // A new workflow is a new identity: it never inherits another's saved run.
    setWorkflowId(generateWorkflowId());
    setNameDialog(null);
    addLog(`New workflow created: ${tempWorkflowName}`);

    const templateNodes = [
      {
        id: 'node_1',
        position: { x: 250, y: 100 },
        data: { label: 'Start', tool: '', command: '', input: '', output: '', threads: 1, color: 'mint' },
        type: 'custom',
      },
      {
        id: 'node_2',
        position: { x: 250, y: 250 },
        data: { label: 'Process', tool: '', command: '', input: '', output: '', threads: 1, color: DEFAULT_NODE_COLOR },
        type: 'custom',
      },
    ];

    setNodes(templateNodes);
    setEdges([]);
    setSelectedNodeId(null);
    setExecutionState('idle');
    setNodeWildcardFiles({});
    setStepRuns({});
    setRunPhase('none');
    setCurrentFilePath(null);
    setIsDirty(false);
    resetHistory();
    setRunOutcome(null);
    setProblemsOpen(false);
    setRevealProblems(false);
  }, [tempWorkflowName, tempWorkflowVersion, tempKeepGoing, addLog, resetHistory]);

  const handleOpen = useCallback(async () => {
    if (
      !(await confirmDiscardIfDirty({
        title: 'Open another workflow?',
        message: 'This workflow has unsaved changes. Opening another one discards them.',
        confirmLabel: 'Discard changes',
      }))
    ) {
      return;
    }

    try {
      const result = await window.electron.ipcRenderer.openWorkflow();
      if (!result) return;

      const data = JSON.parse(result.contents);

      // Guard the shape before handing it to React Flow — a malformed file
      // would otherwise blow up deep inside the renderer.
      if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        addLog('Invalid workflow file: expected "nodes" and "edges" arrays');
        notify('danger', 'That file is not a RustRunner workflow.');
        return;
      }
      if (!data.nodes.every((n: any) => n && typeof n.id === 'string' && n.position)) {
        addLog('Invalid workflow file: one or more nodes are malformed');
        notify('danger', 'That workflow file is damaged: one or more steps cannot be read.');
        return;
      }

      setNodes(data.nodes);
      setEdges(data.edges);
      setSelectedNodeId(null);
      setStepRuns({});
      setRunPhase('none');
      setNodeWildcardFiles(data.wildcardFiles || {});
      if (data.metadata?.name) setWorkflowName(data.metadata.name);
      setWorkflowVersion(
        typeof data.metadata?.workflowVersion === 'string' ? data.metadata.workflowVersion : ''
      );
      setKeepGoing(data.metadata?.keepGoing === true);
      // Keep the id the file carries. A file from before ids existed gets one
      // now and is marked unsaved, so saving it makes the id permanent (until
      // then each open would pick a new one and lose the saved run).
      const fileId = data.metadata?.workflowId;
      const hasId = isValidWorkflowId(fileId);
      setWorkflowId(hasId ? fileId : generateWorkflowId());
      setCurrentFilePath(result.path);
      setIsDirty(!hasId);
      resetHistory();
      setRunOutcome(null);
      setProblemsOpen(false);
      setRevealProblems(false);

      addLog(
        `Workflow opened: ${data.nodes.length} nodes, ${data.edges.length} edges — ${result.path}`
      );
    } catch (error) {
      addLog(`Failed to open workflow: ${error}`);
      notify('danger', 'Could not open that workflow file.');
    }
  }, [addLog, confirmDiscardIfDirty, resetHistory, notify]);

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
            // Version of the workflow itself; `version` below is the file format's.
            workflowVersion,
            workflowId,
            keepGoing,
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
        notify('success', `Saved ${written.split(/[\\/]/).pop()}`);
      } catch (error) {
        addLog(`Failed to save workflow: ${error}`);
        notify('danger', 'Could not save the workflow. Check that the folder is writable.');
      }
    },
    [
      nodes,
      edges,
      nodeWildcardFiles,
      workflowName,
      workflowVersion,
      workflowId,
      keepGoing,
      currentFilePath,
      addLog,
      notify,
    ]
  );

  const handleSave = useCallback(() => saveWorkflowTo(false), [saveWorkflowTo]);
  const handleSaveAs = useCallback(() => saveWorkflowTo(true), [saveWorkflowTo]);

  const handleClear = useCallback(async () => {
    if (nodes.length === 0 && edges.length === 0) return;
    if (
      !(await confirmDiscardIfDirty({
        title: 'Clear the canvas?',
        message:
          'Every step and connection is removed. You can bring them back with Undo (' +
          formatKeys('Mod+Z', IS_MAC) +
          ') until you open or start another workflow.',
        confirmLabel: 'Clear canvas',
      }))
    ) {
      return;
    }

    recordEdit();
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setExecutionState('idle');
    setNodeWildcardFiles({});
    setStepRuns({});
    setRunPhase('none');
    addLog('Canvas cleared');
  }, [nodes.length, edges.length, confirmDiscardIfDirty, recordEdit, addLog]);

  const handleSelectDirectory = useCallback(async () => {
    const directory = await window.electron.ipcRenderer.selectDirectory();
    if (directory) {
      setWorkingDirectory(directory);
      addLog(`Working directory set: ${directory}`);
      notify('info', `Working directory: ${directory}`);
    }
  }, [addLog, notify]);

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

      const workflow = convertNodesToWorkflow(nodes, edges, nodeWildcardFiles, {
        id: workflowId,
        name: workflowName,
        version: workflowVersion,
        keepGoing,
      });

      const errors = [...validateWorkflow(workflow), ...validateCatalogNodes(nodes)];
      if (errors.length > 0) {
        addLog('Workflow validation failed:');
        errors.forEach((err) => addLog(`  - ${err}`));
        notify(
          'danger',
          `The workflow cannot run yet: ${errors[0]}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}`
        );
        return null;
      }

      const wildcardSteps = workflow.steps.filter((s: any) => s.wildcard_files);
      if (wildcardSteps.length > 0) {
        const total = wildcardSteps.reduce(
          (sum: number, s: any) =>
            sum +
            Object.values(s.wildcard_files as Record<string, string[]>).reduce(
              (n, files) => n + files.length,
              0
            ),
          0
        );
        addLog(
          `🔄 Wildcards on ${wildcardSteps.length} step(s) — ${total} file(s) to expand`
        );
      }

      setStepRuns({});
      setRunPhase('active');
      return { workflow, dir };
    },
    [
      nodes,
      edges,
      nodeWildcardFiles,
      workflowName,
      workflowVersion,
      workflowId,
      keepGoing,
      workingDirectory,
      addLog,
      notify,
    ]
  );

  // Which saved run (if any) a normal Run builds on. Looked up in
  // the working directory, where the engine keeps its state, and refreshed
  // whenever a run ends since the engine writes it after every step.
  useEffect(() => {
    if (!workingDirectory || executionState !== 'idle') {
      if (!workingDirectory) setResumeInfo(null);
      return;
    }
    let cancelled = false;
    window.electron.ipcRenderer
      .getResumeInfo(workflowName, workingDirectory, workflowId)
      .then((info) => {
        if (!cancelled) setResumeInfo(info);
      })
      .catch(() => {
        if (!cancelled) setResumeInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workflowName, workflowId, workingDirectory, executionState]);

  // The runs of this workflow, from the index the engine keeps in the working
  // directory; refreshed whenever a run ends.
  useEffect(() => {
    if (!workingDirectory) {
      setRunHistory([]);
      return;
    }
    if (executionState !== 'idle') return;
    let cancelled = false;
    setHistoryStatus('loading');
    window.electron.ipcRenderer
      .listRunHistory(workingDirectory, workflowName, workflowId)
      .then((runs) => {
        if (cancelled) return;
        setRunHistory(runs);
        setHistoryStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setRunHistory([]);
        setHistoryStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [workflowName, workflowId, workingDirectory, executionState, historyReload]);

  const openReport = useCallback(
    async (reportRef: string) => {
      try {
        const result = await window.electron.ipcRenderer.openRunReport(
          workingDirectory,
          reportRef
        );
        if (result.ok === false) {
          addLog(`Could not open the report: ${result.error}`);
          notify('danger', 'Could not open the report. It may have been moved or deleted.');
        }
      } catch (err) {
        addLog(`Could not open the report: ${err instanceof Error ? err.message : String(err)}`);
        notify('danger', 'Could not open the report. It may have been moved or deleted.');
      }
    },
    [workingDirectory, addLog, notify]
  );

  /**
   * True when a run must not start. With problems on the canvas the list opens
   * and every one of them shows on its field: Run being greyed out is not left
   * as the only signal.
   */
  const refuseRun = useCallback((): boolean => {
    if (nodes.length === 0) return true;
    if (issues.length === 0) return false;
    setProblemsOpen(true);
    setRevealProblems(true);
    setPaletteOpen(false);
    return true;
  }, [nodes.length, issues.length]);

  // Execution. A normal run lets the engine skip every step whose outputs are
  // up to date (they exist, are newer than the inputs, and the step's command
  // is unchanged since it last succeeded); steps that are out of date run
  // together with everything downstream. "Run from scratch" asks the engine to
  // ignore its saved state so that every step runs.
  const startRun = useCallback(
    async (fresh: boolean) => {
      if (refuseRun()) return;
      const prepared = await prepareRun(fresh ? 'run from scratch' : 'run');
      if (!prepared) return;

      if (fresh) {
        addLog('Running from scratch: any saved progress is discarded');
      } else if (resumeInfo?.canResume) {
        addLog(
          `Running: steps whose outputs are up to date are skipped (${resumeInfo.completedCount} finished earlier)` +
            (resumeInfo.failedStep ? `, the last run stopped at "${resumeInfo.failedStep}"` : '')
        );
      } else {
        addLog('Running: no saved progress for this workflow yet, every step runs');
      }

      dryRunRef.current = false;
      setRunOutcome(null);
      setRunResult(null);
      setExecutionState('running');
      window.electron.ipcRenderer.runWorkflow(prepared.workflow, false, prepared.dir, fresh);
    },
    [prepareRun, resumeInfo, addLog, refuseRun]
  );

  const handleRun = useCallback(async () => {
    if (executionState === 'paused') {
      setExecutionState('running');
      window.electron.ipcRenderer.resumeWorkflow();
      return;
    }
    await startRun(false);
  }, [executionState, startRun]);

  const handleRunFromScratch = useCallback(() => startRun(true), [startRun]);

  const handleDryRun = useCallback(async () => {
    if (refuseRun()) return;
    const prepared = await prepareRun('dry run');
    if (!prepared) return;
    dryRunRef.current = true;
    setDryRunActive(true);
    setRunResult(null);

    addLog('Starting dry run (commands will not execute)...');
    // Not fresh: the preview shows which steps would be skipped as up to date
    // and why the others would run. A dry run never touches saved state.
    window.electron.ipcRenderer.runWorkflow(prepared.workflow, true, prepared.dir, false);
  }, [prepareRun, addLog, refuseRun]);

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
  }, []);

  const handleTogglePanel = useCallback(() => {
    setShowExecutionPanel((prev) => !prev);
  }, []);

  /** "Show logs" on the failure card: the log, narrowed to the errors. */
  const showErrorLogs = useCallback(() => {
    setShowExecutionPanel(true);
    setExecutionTab('logs');
    setLogFilter('errors');
  }, []);

  /** "Edit step" on the failure card: select the step and open the section that fixes it. */
  const editFailedStep = useCallback(
    (card: FailureCardData) => {
      const node = nodes.find((n: any) => labelToId(n.data?.label || '') === card.nodeStepId);
      if (!node) {
        notify('warning', `"${card.nodeLabel}" is no longer on the canvas.`);
        return;
      }
      setNodes((nds) => nds.map((n: any) => ({ ...n, selected: n.id === node.id })));
      setEdges((eds) =>
        eds.some((e: any) => e.selected) ? eds.map((e: any) => ({ ...e, selected: false })) : eds
      );
      setSelectedNodeId(node.id);
      setFocusRequest({ nodeId: node.id, section: sectionToEdit(card) });
      fitView({ nodes: [{ id: node.id }], maxZoom: 1, duration: 200 });
    },
    [nodes, notify, fitView]
  );

  /** Selects the step a problem belongs to, brings it into view and puts the cursor in the field. */
  const jumpToIssue = useCallback(
    (issue: ValidationIssue) => {
      if (!issue.nodeId) return;
      const nodeId = issue.nodeId;
      setNodes((nds) => nds.map((n: any) => ({ ...n, selected: n.id === nodeId })));
      setEdges((eds) => (eds.some((e: any) => e.selected) ? eds.map((e: any) => ({ ...e, selected: false })) : eds));
      setSelectedNodeId(nodeId);
      if (issue.field) setFocusRequest({ nodeId, field: issue.field });
      fitView({ nodes: [{ id: nodeId }], maxZoom: 1, duration: 200 });
    },
    [fitView]
  );

  const openPalette = useCallback(() => {
    setProblemsOpen(false);
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    paletteButtonRef.current?.focus();
  }, []);

  // Keyboard shortcuts. The handler reads the latest actions from a ref so the
  // listener is attached once. The File and Edit menu accelerators can deliver
  // the same key press too (the page may see it first), so one action is not
  // run twice within a moment.
  const shortcutActions = useRef<Record<ShortcutAction, () => void>>(null as never);
  const modalOpen = nameDialog !== null || confirmRequest !== null || shortcutsOpen;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = modalOpen;
  shortcutActions.current = {
    save: () => void handleSave(),
    open: () => void handleOpen(),
    run: () => {
      if (executionState !== 'running') void handleRun();
    },
    palette: openPalette,
    undo: () => stepHistory('undo'),
    redo: () => stepHistory('redo'),
    delete: deleteSelection,
    escape: () => {
      if (paletteOpen) closePalette();
      else if (problemsOpen) setProblemsOpen(false);
      else deselectAll();
    },
    help: () => setShortcutsOpen(true),
  };
  useEffect(() => {
    let last = { action: '' as string, at: 0 };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || modalOpenRef.current) return;
      const action = matchShortcut(e, { isMac: IS_MAC, typing: isTypingTarget(e.target) });
      if (!action) return;
      const now = Date.now();
      if (last.action === action && now - last.at < 100) {
        e.preventDefault();
        return;
      }
      last = { action, at: now };
      // Keys that act on the canvas must not also scroll or navigate the page.
      e.preventDefault();
      shortcutActions.current[action]();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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
  const stepStatus = useMemo(
    () => rollupNodeStatuses(stepRuns, baseStepIdsRef.current),
    [stepRuns, nodes]
  );

  const statusRows = useMemo(
    () =>
      buildStatusRows(
        stepRuns,
        nodes.map((n: any) => ({
          stepId: labelToId(n.data?.label || ''),
          label: n.data?.label || 'Node',
        })),
        runPhase
      ),
    [stepRuns, nodes, runPhase]
  );

  // Edges carry their file-type check under a reserved `__` key for the same
  // reason: it is derived from the nodes and must not be saved.
  const decoratedEdges = useMemo(
    () =>
      edges.map((edge: any) => {
        const targetState = stepStatus[nodeIdToStepId(edge.target)]?.state;
        return {
          ...edge,
          data: {
            ...edge.data,
            __typeCheck: checkEdge(edge, nodes),
            // The edge that feeds a step that is working right now.
            __active: targetState === 'running' || targetState === 'retrying',
          },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, nodes, stepStatus]
  );

  const mockedCount = countMockedNodes(nodes);

  const summaryVisible = runResult !== null && runPhase === 'ended' && !summaryDismissed;
  const failureCard = useMemo(
    () =>
      summaryVisible && runResult?.status === 'failed' && !runResult.dry
        ? buildFailureCard(
            stepRuns,
            nodes.map((n: any) => ({
              stepId: labelToId(n.data?.label || ''),
              label: n.data?.label || 'Node',
            })),
            executionLogs
          )
        : null,
    [summaryVisible, runResult, stepRuns, nodes, executionLogs]
  );

  const decoratedNodes = nodes.map((node: any) => {
    // While a run is active a step the engine has not reached yet is waiting.
    const status =
      stepStatus[nodeIdToStepId(node.id)] ?? (runPhase === 'active' ? PENDING_STATUS : undefined);
    const invalidReason = invalidNodeIds[node.id];
    if (!status && !invalidReason) return node;
    return { ...node, data: { ...node.data, __status: status, __invalidReason: invalidReason } };
  });

  const selectedEdgeCount = edges.filter((e: any) => e.selected).length;
  const fieldIssues = selectedNode ? fieldErrors(issues, selectedNode.id) : {};

  // Named file slots of the selected step (see slots.ts).
  const slotView = useMemo(() => {
    if (!selectedNode) return null;
    return {
      states: slotStates(selectedNode, nodes, edges),
      choices: linkChoices(selectedNode, nodes, edges),
      preview: previewForNode(selectedNode, nodes, edges),
    };
  }, [selectedNode, nodes, edges]);

  /** The question shown in the later step's properties after a connection that fits several slots. */
  const bindingPrompt = useMemo(() => {
    if (!pendingBinding || selectedNodeId !== pendingBinding.targetId) return null;
    const plan = planBinding(nodes, edges, pendingBinding.sourceId, pendingBinding.targetId);
    if (plan.kind !== 'ask') return null;
    const source = nodes.find((n: any) => n.id === pendingBinding.sourceId);
    return { sourceLabel: (source?.data?.label || '').trim() || 'the earlier step', options: plan.options };
  }, [pendingBinding, selectedNodeId, nodes, edges]);

  const chooseBinding = useCallback(
    (option: BindingOption) => {
      if (!pendingBinding) return;
      recordEdit();
      setNodes((nds) => applyBinding(nds, pendingBinding.targetId, pendingBinding.sourceId, option));
      setPendingBinding(null);
      markDirty();
    },
    [pendingBinding, recordEdit, markDirty]
  );

  const finishedSteps = Object.values(stepStatus).filter(
    (st) => st.state === 'succeeded' || st.state === 'failed' || st.state === 'skipped'
  ).length;
  const runView = describeRunState({
    executionState,
    dryRun: dryRunActive,
    outcome: runOutcome,
    finished: finishedSteps,
    total: nodes.length,
  });

  /** Why a run cannot start right now, or undefined when it can. */
  const startBlockedReason =
    nodes.length === 0
      ? 'Add a step to run the workflow'
      : hasProblems
        ? blockedReason(issues)
        : undefined;

  const progress = (() => {
    const entries = Object.values(stepStatus);
    if (entries.length === 0) return null;
    const finished = entries.filter(
      (s) => s.state === 'succeeded' || s.state === 'failed' || s.state === 'skipped'
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

      {/* The workflow bar: a row above the canvas, never over it, so the canvas
          and its overlays keep their place whatever the window width. */}
      <header className="top-toolbar" aria-label="Workflow">
        <div className="workflow-info">
          <div className="workflow-title" data-testid="workflow-title">
            <Tooltip content="Rename the workflow, set its version and what happens after a failure">
              <button
                type="button"
                className="workflow-name-button"
                data-testid="details"
                onClick={handleEditDetails}
              >
                <span className="workflow-name">{workflowName}</span>
                <Icon name="pencil" size={14} className="workflow-name-icon" />
                <span className="visually-hidden">(workflow details)</span>
              </button>
            </Tooltip>
            {isDirty && (
              <Badge tone="neutral" variant="outline" className="dirty-marker">
                Unsaved
              </Badge>
            )}
          </div>
          <div className="workflow-location">
            <Tooltip
              content={
                workingDirectory
                  ? `Results go to ${workingDirectory}. Click to choose another folder.`
                  : 'Choose the folder where results are written. Run asks for one if none is set.'
              }
            >
              <button
                type="button"
                className={workingDirectory ? 'working-directory' : 'working-directory is-unset'}
                data-testid="set-directory"
                onClick={handleSelectDirectory}
              >
                <Icon name="folder" size={12} />
                {workingDirectory
                  ? `Folder: ${workingDirectory.replace(/^.*[\\/]/, '')}`
                  : 'Choose results folder'}
              </button>
            </Tooltip>
            {currentFilePath && (
              <span className="workflow-file" title={currentFilePath}>
                <Icon name="file" size={12} />
                {currentFilePath.replace(/^.*[\\/]/, '')}
              </span>
            )}
          </div>
        </div>

        <div className="file-buttons" role="group" aria-label="File">
          <Button variant="ghost" onClick={handleNew}>New</Button>
          <Button variant="ghost" onClick={handleOpen}>Open</Button>
          <Button variant="ghost" onClick={handleSave}>Save</Button>
          <Button variant="ghost" onClick={handleSaveAs}>Save as</Button>
          <Button
            variant="ghost"
            onClick={handleClear}
            tooltip="Remove every step from the canvas"
          >
            Clear canvas
          </Button>
        </div>

        <div className="edit-buttons" role="group" aria-label="Steps">
          <Button
            ref={paletteButtonRef}
            onClick={() => (paletteOpen ? closePalette() : openPalette())}
            data-testid="open-palette"
            aria-expanded={paletteOpen}
            tooltip={
              <>
                Search the bundled catalog of common bioinformatics tools{' '}
                <Kbd keys={formatKeys('Mod+K', IS_MAC)} />
              </>
            }
          >
            Tool catalog
          </Button>
          <Button
            icon="plus"
            onClick={addNode}
            data-testid="add-node"
            tooltip="Add a step whose command you write yourself"
          >
            Add node
          </Button>
          <Button
            icon="trash"
            onClick={deleteSelection}
            data-testid="delete-node"
            disabledReason={
              selectedNode || selectedEdgeCount > 0
                ? undefined
                : 'Select a step or a connection to delete it'
            }
            tooltip="Delete the selected step or connection (Delete key)"
          >
            Delete
          </Button>
          <IconButton
            icon="info"
            label="Keyboard shortcuts (?)"
            onClick={() => setShortcutsOpen(true)}
            data-testid="open-shortcuts"
          />
        </div>
      </header>

      <div className="main-content">
        <div className="flow-container" ref={flowWrapperRef}>
          {/* Run controls: what is happening, how to start, how to hold or end it. */}
          <div
            className="execution-controls"
            role="group"
            aria-label="Run controls"
            data-testid="run-controls"
          >
            <div className="run-state" data-testid="run-state" role="status">
              <Badge tone={runView.tone} variant="subtle" icon={runView.icon}>
                {runView.label}
              </Badge>
            </div>

            {/* Clicking a greyed-out Run is how someone asks "why not?": show the problems. */}
            <div
              className="run-group"
              role="group"
              aria-label="Start"
              onClick={() => {
                if (hasProblems && executionState === 'idle') refuseRun();
              }}
            >
              <Button
                variant="primary"
                size="lg"
                fullWidth
                icon="play"
                onClick={handleRun}
                data-testid="run"
                loading={executionState === 'running'}
                disabledReason={executionState === 'paused' ? undefined : startBlockedReason}
                tooltipPlacement="right"
                tooltip={
                  executionState === 'paused'
                    ? 'Continue the paused run.'
                    : `${RUN_TOOLTIPS.run} ${describeResume(resumeInfo, Boolean(workingDirectory))}`
                }
              >
                {executionState === 'paused' ? 'Continue' : 'Run'}
              </Button>

              <Button
                size="sm"
                fullWidth
                onClick={handleRunFromScratch}
                data-testid="run-from-scratch"
                disabledReason={
                  startBlockedReason ??
                  (executionState !== 'idle' ? 'A run is in progress' : undefined)
                }
                tooltipPlacement="right"
                tooltip={RUN_TOOLTIPS.fromScratch}
              >
                Run from scratch
              </Button>

              <Button
                size="sm"
                fullWidth
                onClick={handleDryRun}
                data-testid="dry-run"
                disabledReason={
                  startBlockedReason ??
                  (executionState !== 'idle' ? 'A run is in progress' : undefined)
                }
                tooltipPlacement="right"
                tooltip={RUN_TOOLTIPS.dryRun}
              >
                Dry run
              </Button>
            </div>

            <div className="run-group run-group-row" role="group" aria-label="During a run">
              <Button
                size="sm"
                fullWidth
                icon="pause"
                pressed={executionState === 'paused'}
                onClick={handlePause}
                data-testid="pause"
                disabledReason={
                  executionState === 'running'
                    ? undefined
                    : executionState === 'paused'
                      ? 'Paused. Press Continue to go on.'
                      : 'Nothing is running'
                }
                tooltipPlacement="right"
                tooltip={RUN_TOOLTIPS.pause}
              >
                Pause
              </Button>

              <Button
                variant="danger"
                size="sm"
                fullWidth
                icon="stop"
                onClick={handleStop}
                data-testid="stop"
                disabledReason={executionState === 'idle' ? 'Nothing is running' : undefined}
                tooltipPlacement="right"
                tooltip={RUN_TOOLTIPS.stop}
              >
                Stop
              </Button>
            </div>

            {hasProblems && (
              <Button
                size="sm"
                fullWidth
                icon="alert"
                className="problems-toggle"
                data-testid="problems-toggle"
                aria-expanded={problemsOpen}
                onClick={() => {
                  setProblemsOpen((open) => !open);
                  setRevealProblems(true);
                  setPaletteOpen(false);
                }}
              >
                {issues.length === 1 ? '1 problem' : `${issues.length} problems`}
              </Button>
            )}

            {mockedCount > 0 && (
              <Badge
                tone="warning"
                variant="outline"
                icon="alert"
                className="mock-warning"
                data-testid="mock-warning"
                title="Mocked steps do not run their tool; they only create placeholder outputs. Results downstream are not real."
              >
                {mockedCount} mocked step{mockedCount === 1 ? '' : 's'}
              </Badge>
            )}

            {progress && <div className="execution-progress" data-testid="progress">{progress}</div>}
          </div>

          {paletteOpen && <ToolPalette
              onAdd={addCatalogNode}
              onClose={closePalette}
              onAddCustom={() => {
                closePalette();
                addNode();
              }}
            />}

          {problemsOpen && hasProblems && (
            <ProblemsPanel
              issues={issues}
              onSelect={jumpToIssue}
              onClose={() => setProblemsOpen(false)}
            />
          )}

          {nodes.length === 0 && !paletteOpen && (
            <EmptyState
              modifier={formatKeys('Mod', IS_MAC)}
              onOpenCatalog={openPalette}
              onAddCustom={addNode}
              onOpenWorkflow={handleOpen}
            />
          )}

          <WorkflowCanvas
            nodes={decoratedNodes}
            edges={decoratedEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            onDragStart={onDragStart}
          />
        </div>

        {selectedNode && (
          <PropertiesPanel
            selectedNode={selectedNode}
            onNodeUpdate={onNodeUpdate}
            onNodePatch={onNodePatch}
            nodeFiles={nodeWildcardFiles[selectedNode.id] || []}
            onNodeFilesUpdate={handleNodeFilesUpdate}
            addLog={addLog}
            fieldIssues={fieldIssues}
            revealErrors={revealProblems}
            focusRequest={focusRequest}
            onFocusHandled={() => setFocusRequest(null)}
            keepGoing={keepGoing}
            onOpenDetails={handleEditDetails}
            upstream={upstreamChoices(nodes, edges, selectedNode.id)}
            onConnectionChange={(sourceId, connected) =>
              onConnectionChange(sourceId, selectedNode.id, connected)
            }
            slots={slotView?.states ?? []}
            slotChoices={slotView?.choices ?? []}
            commandPreview={slotView?.preview ?? null}
            onSlotFile={(slotId: string, value: string) =>
              onNodePatch(selectedNode.id, typedPatch(selectedNode.data, slotId, value))
            }
            onSlotKind={(slotId: string, kind: SlotKind) =>
              onNodePatch(selectedNode.id, kindPatch(selectedNode.data, slotId, kind))
            }
            onSlotLink={(slotId: string, nodeId: string, outputKey: string) =>
              onNodePatch(selectedNode.id, linkPatch(selectedNode.data, slotId, nodeId, outputKey))
            }
            onSlotUnlink={(slotId: string) =>
              onNodePatch(selectedNode.id, unlinkPatch(selectedNode, nodes, edges, slotId))
            }
            bindingPrompt={bindingPrompt}
            onChooseBinding={chooseBinding}
            onDismissBinding={() => setPendingBinding(null)}
          />
        )}
      </div>

      {/* Execution Logs Panel */}
      <ExecutionLogs
        logs={executionLogs}
        visible={showExecutionPanel}
        onClear={handleClearLogs}
        onToggle={handleTogglePanel}
        tab={executionTab}
        onTabChange={setExecutionTab}
        stepCount={statusRows.length}
        stepsView={<StepStatusPanel rows={statusRows} phase={runPhase} />}
        historyView={
          <RunHistoryPanel
            runs={runHistory}
            hasWorkingDirectory={Boolean(workingDirectory)}
            status={historyStatus}
            onRetry={() => setHistoryReload((n) => n + 1)}
            onOpenReport={openReport}
          />
        }
        historyCount={runHistory.length}
        latestReport={latestReport !== null}
        onOpenLatestReport={() => latestReport && openReport(latestReport)}
        filter={logFilter}
        onFilterChange={setLogFilter}
        onNotify={notify}
        bannerSize={summaryVisible ? (failureCard ? 'failure' : 'summary') : undefined}
        banner={
          summaryVisible && runResult ? (
            <RunBanner
              summary={describeRunResult(runResult, runResult.dry)}
              failure={failureCard}
              hasReport={Boolean(runResult.report)}
              onOpenReport={() => runResult.report && openReport(runResult.report)}
              onShowLogs={showErrorLogs}
              onEditStep={editFailedStep}
              onDismiss={() => setSummaryDismissed(true)}
            />
          ) : undefined
        }
      />

      <ToastHost toasts={toasts} onDismiss={dismissToast} />

      {/* Name / details dialog */}
      {nameDialog && (
        <Dialog
          title={nameDialog === 'new' ? 'New workflow' : 'Workflow details'}
          onClose={() => setNameDialog(null)}
          dirty={
            nameDialog === 'new'
              ? tempWorkflowName !== 'My Workflow' || tempWorkflowVersion !== '' || tempKeepGoing
              : tempWorkflowName !== workflowName ||
                tempWorkflowVersion !== workflowVersion ||
                tempKeepGoing !== keepGoing
          }
          testId="workflow-dialog"
          footer={
            <>
              <Button onClick={() => setNameDialog(null)}>Cancel</Button>
              <Button
                variant="primary"
                data-testid="dialog-confirm"
                onClick={nameDialog === 'new' ? handleConfirmNew : handleConfirmDetails}
                disabledReason={tempWorkflowName.trim() ? undefined : 'Give the workflow a name'}
              >
                {nameDialog === 'new' ? 'Create' : 'Save'}
              </Button>
            </>
          }
        >
          <TextField
            label="Workflow name"
            data-testid="dialog-name"
            value={tempWorkflowName}
            onChange={(e) => setTempWorkflowName(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' &&
              (nameDialog === 'new' ? handleConfirmNew() : handleConfirmDetails())
            }
            autoFocus
          />
          <TextField
            label="Version"
            optional
            value={tempWorkflowVersion}
            placeholder="e.g. 1.0"
            hint={
              nameDialog === 'new'
                ? undefined
                : 'Shown in the run log and saved with each run. Renaming the workflow keeps its saved run, so its saved progress is still found.'
            }
            onChange={(e) => setTempWorkflowVersion(e.target.value)}
            onKeyDown={(e) =>
              e.key === 'Enter' &&
              (nameDialog === 'new' ? handleConfirmNew() : handleConfirmDetails())
            }
          />
          <Checkbox
            label="Keep going after a failure"
            data-testid="keep-going"
            checked={tempKeepGoing}
            onChange={(e) => setTempKeepGoing(e.target.checked)}
            hint="When a step fails, steps that do not depend on it still run. The run still ends as failed, with a summary of what failed and what was not run."
          />
          {nameDialog === 'new' && (
            <p className="dialog-note">You will choose a working directory when you click Run.</p>
          )}
        </Dialog>
      )}

      {confirmRequest && <ConfirmDialog request={confirmRequest} onResolve={resolveConfirm} />}

      {shortcutsOpen && (
        <Dialog
          title="Keyboard shortcuts"
          onClose={() => setShortcutsOpen(false)}
          testId="shortcuts-dialog"
          footer={<Button onClick={() => setShortcutsOpen(false)}>Close</Button>}
        >
          <table className="shortcuts-table">
            <tbody>
              {SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.action}>
                  <td>{shortcut.label}</td>
                  <td>
                    <Kbd keys={formatKeys(shortcut.keys, IS_MAC)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dialog-note">
            Shortcuts that edit the canvas do not fire while you are typing in a field.
          </p>
        </Dialog>
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
