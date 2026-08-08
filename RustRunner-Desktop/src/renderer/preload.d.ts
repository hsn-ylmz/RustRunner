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
    threads?: number;
    /**
     * Per-step wildcard mappings (wildcard name -> concrete files). snake_case
     * on purpose: this is serialized straight to YAML and read by the Rust
     * `Step::wildcard_files` field, which load_workflow() expands.
     */
    wildcard_files?: Record<string, string[]>;
  }>;
}

/** Menu selections forwarded from the main process over 'menu-action'. */
export type MenuAction = 'new' | 'open' | 'save' | 'save-as' | 'undo' | 'redo';

/** How a run ended, so the renderer can style a user-stop distinctly. */
export type WorkflowOutcome = 'success' | 'failed' | 'stopped';

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
    stopWorkflow(): void;
    selectDirectory(): Promise<string | null>;
    selectFiles(): Promise<string[] | null>;

    // Workflow persistence. filePath = null prompts for a location;
    // resolves to the path written, or null if the user cancelled.
    saveWorkflow(
      contents: string,
      filePath: string | null,
      suggestedName: string
    ): Promise<string | null>;
    openWorkflow(): Promise<{ path: string; contents: string } | null>;
    confirmDiscard(message: string): Promise<boolean>;
    setDirty(dirty: boolean): void;

    // Event listeners. All return an unsubscribe function so React effects
    // can clean up on unmount.
    onWorkflowOutput(callback: (output: string) => void): () => void;
    onWorkflowComplete(
      callback: (
        success: boolean,
        message: string,
        outcome?: WorkflowOutcome
      ) => void
    ): () => void;
    onWorkflowError(callback: (error: string) => void): () => void;
    onMenuAction(callback: (action: MenuAction) => void): () => void;

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
