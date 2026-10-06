/**
 * Preload Script
 *
 * Exposes a safe subset of Electron APIs to the renderer process
 * via the contextBridge.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { ResumeInfo } from './resumeState';

// Type definitions
export type Channels = 'ipc-example';

interface WorkflowData {
  metadata?: { name?: string; version?: string };
  steps: Array<{
    id: string;
    tool: string;
    command: string;
    input: string[];
    output: string[];
    previous: string[];
    next: string[];
    threads?: number;
    /** Re-runs after a failure or timeout (0 = single attempt). */
    retries?: number;
    retry_backoff?: 'fixed' | 'exponential';
    retry_delay_secs?: number;
    /** Per-attempt wall-clock limit; the step is killed when exceeded. */
    timeout_secs?: number;
    /** Output checks run after the step succeeds (see the Rust `OutputCheck`). */
    checks?: Array<{
      kind: 'exists' | 'non_empty' | 'min_lines';
      lines?: number;
      target?: string;
      blocking?: boolean;
    }>;
    /** Per-step wildcard mappings; serialized straight into the workflow YAML. */
    wildcard_files?: Record<string, string[]>;
  }>;
}

/** Menu selections forwarded from the main process. */
type MenuAction = 'new' | 'open' | 'save' | 'save-as' | 'undo' | 'redo';

/**
 * Subscribes to `channel` and returns an unsubscribe function.
 *
 * Every event-style API below goes through this so React effects can always
 * clean up — previously onWorkflowOutput/Complete/Error returned void, leaving
 * listeners stacked on every remount.
 */
function subscribe(
  channel: string,
  handler: (...args: any[]) => void
): () => void {
  const subscription = (_event: IpcRendererEvent, ...args: any[]) =>
    handler(...args);
  ipcRenderer.on(channel, subscription);
  return () => ipcRenderer.removeListener(channel, subscription);
}

// API exposed to renderer
const electronHandler = {
  ipcRenderer: {
    // Generic IPC
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },

    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    },

    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },

    // Workflow execution
    runWorkflow(
      workflowData: WorkflowData,
      dryRun: boolean = false,
      workingDir: string = '',
      fresh: boolean = false
    ) {
      ipcRenderer.send('run-workflow', workflowData, dryRun, workingDir, fresh);
    },

    // Saved-run info for "Resume last run".
    getResumeInfo(workflowName: string, workingDir: string): Promise<ResumeInfo> {
      return ipcRenderer.invoke('get-resume-info', workflowName, workingDir);
    },

    pauseWorkflow() {
      ipcRenderer.send('pause-workflow');
    },

    resumeWorkflow() {
      ipcRenderer.send('resume-workflow');
    },

    stopWorkflow() {
      ipcRenderer.send('stop-workflow');
    },

    // Directory selection
    selectDirectory(): Promise<string | null> {
      return ipcRenderer.invoke('select-directory');
    },

    // File selection for wildcards
    selectFiles(): Promise<string[] | null> {
      return ipcRenderer.invoke('select-files');
    },

    // Workflow file persistence. Pass filePath = null to prompt for a
    // location; resolves to the path actually written, or null if cancelled.
    saveWorkflow(
      contents: string,
      filePath: string | null,
      suggestedName: string
    ): Promise<string | null> {
      return ipcRenderer.invoke('save-workflow', contents, filePath, suggestedName);
    },

    openWorkflow(): Promise<{ path: string; contents: string } | null> {
      return ipcRenderer.invoke('open-workflow');
    },

    confirmDiscard(message: string): Promise<boolean> {
      return ipcRenderer.invoke('confirm-discard', message);
    },

    setDirty(dirty: boolean) {
      ipcRenderer.send('set-dirty', dirty);
    },

    // Event listeners. All return an unsubscribe function.
    onWorkflowOutput(callback: (output: string) => void) {
      return subscribe('workflow-output', callback);
    },

    onWorkflowComplete(
      callback: (
        success: boolean,
        message: string,
        outcome?: 'success' | 'failed' | 'stopped'
      ) => void
    ) {
      return subscribe('workflow-complete', callback);
    },

    onWorkflowError(callback: (error: string) => void) {
      return subscribe('workflow-error', callback);
    },

    onMenuAction(callback: (action: MenuAction) => void) {
      return subscribe('menu-action', callback);
    },

    // Auto-update
    // The payload shape matches the UpdateStatus union in main/updater.ts.
    // It's typed as `unknown` here so the preload stays a thin pipe; the
    // renderer narrows via the type defined in preload.d.ts.
    onUpdateStatus(callback: (payload: unknown) => void) {
      return subscribe('update-status', callback);
    },

    installUpdate() {
      ipcRenderer.send('install-update');
    },
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
