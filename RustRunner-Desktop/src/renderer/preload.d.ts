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

/**
 * Payloads pushed from the main process over the 'update-status' channel.
 * Must stay in sync with the UpdateStatus union in src/main/updater.ts
 * and the inline copy in src/renderer/App.tsx.
 *
 * `manual` distinguishes user-triggered (Help → Check for Updates…) from
 * the silent startup check — the renderer only surfaces "Checking…" and
 * "Up to date" when manual is true.
 *
 * `canAutoInstall` tells the renderer what the action button does:
 * trigger an in-app install (true), or open the GitHub release page in
 * the user's browser (false, e.g. unsigned macOS).
 */
export type UpdateStatus =
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

    // Auto-update API. Returns an unsubscribe function so React effects
    // can clean up the listener on unmount.
    onUpdateStatus(callback: (payload: UpdateStatus) => void): () => void;
    installUpdate(): void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
