/**
 * Preload Script
 *
 * Exposes a safe subset of Electron APIs to the renderer process
 * via the contextBridge.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Type definitions
export type Channels = 'ipc-example';

interface WorkflowData {
  steps: Array<{
    id: string;
    tool: string;
    command: string;
    input: string[];
    output: string[];
    previous: string[];
    next: string[];
  }>;
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
    runWorkflow(workflowData: WorkflowData, dryRun: boolean = false, workingDir: string = '') {
      ipcRenderer.send('run-workflow', workflowData, dryRun, workingDir);
    },

    pauseWorkflow() {
      ipcRenderer.send('pause-workflow');
    },

    resumeWorkflow() {
      ipcRenderer.send('resume-workflow');
    },

    // Directory selection
    selectDirectory(): Promise<string | null> {
      return ipcRenderer.invoke('select-directory');
    },

    // File selection for wildcards
    selectFiles(): Promise<string[] | null> {
      return ipcRenderer.invoke('select-files');
    },

    // Event listeners
    onWorkflowOutput(callback: (output: string) => void) {
      ipcRenderer.on('workflow-output', (_event, output) => callback(output));
    },

    onWorkflowComplete(callback: (success: boolean, message: string) => void) {
      ipcRenderer.on('workflow-complete', (_event, success, message) =>
        callback(success, message)
      );
    },

    onWorkflowError(callback: (error: string) => void) {
      ipcRenderer.on('workflow-error', (_event, error) => callback(error));
    },
  },
};

// Expose to renderer
contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
