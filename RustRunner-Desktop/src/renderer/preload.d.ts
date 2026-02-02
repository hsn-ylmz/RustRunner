/**
 * Type definitions for the Electron preload API
 */

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

interface ElectronAPI {
  ipcRenderer: {
    sendMessage(channel: string, ...args: unknown[]): void;
    on(channel: string, func: (...args: unknown[]) => void): () => void;
    once(channel: string, func: (...args: unknown[]) => void): void;
    runWorkflow(workflowData: WorkflowData, dryRun?: boolean, workingDir?: string): void;
    pauseWorkflow(): void;
    resumeWorkflow(): void;
    selectDirectory(): Promise<string | null>;
    selectFiles(): Promise<string[] | null>;
    onWorkflowOutput(callback: (output: string) => void): void;
    onWorkflowComplete(callback: (success: boolean, message: string) => void): void;
    onWorkflowError(callback: (error: string) => void): void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
