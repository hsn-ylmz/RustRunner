/**
 * RustRunner Electron Main Process
 *
 * Manages application lifecycle, window creation, and IPC communication
 * with the renderer process for workflow execution.
 */

import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  nativeTheme,
  IpcMainEvent,
} from 'electron';
import log from 'electron-log';
import yaml from 'js-yaml';

import MenuBuilder from './menu';
import { setupAutoUpdater } from './updater';
import { resolveHtmlPath } from './util';

// =============================================================================
// Types
// =============================================================================

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
     * Wildcard file mappings for this step (wildcard name -> concrete files).
     * Matches the `wildcard_files` field on the Rust `Step` struct, which
     * `load_workflow` merges and expands before validation. Deliberately
     * snake_case: it goes straight into the YAML serde reads.
     */
    wildcard_files?: Record<string, string[]>;
  }>;
}

// =============================================================================
// Application State
// =============================================================================

let mainWindow: BrowserWindow | null = null;
let currentRustProcess: ChildProcess | null = null;
let pauseFlagPath: string = '';

/**
 * Set just before we kill the child on the user's behalf, so the `close`
 * handler can report "stopped" rather than surfacing the kill as a failure.
 */
let stoppedByUser = false;

/** Renderer-reported unsaved-changes state, consulted by the close guard. */
let rendererIsDirty = false;
/** Set once the user confirms discarding changes, so `close` doesn't re-prompt. */
let allowClose = false;

// =============================================================================
// Engine Binary Resolution
// =============================================================================

/**
 * Locates the rustrunner engine binary.
 *
 * Order: explicit RUSTRUNNER_BIN override, then the packaged resource, then
 * the cargo debug build relative to this repo. `app.isPackaged` is used rather
 * than NODE_ENV because it's true regardless of how the app was launched.
 */
function resolveRustExecutable(): string {
  if (process.env.RUSTRUNNER_BIN) {
    return process.env.RUSTRUNNER_BIN;
  }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'rustrunner');
  }

  // __dirname is dist/main/ at runtime, so walk back up to the repo root.
  return path.join(__dirname, '../../../RustRunner/target/debug/rustrunner');
}

// =============================================================================
// IPC Handlers
// =============================================================================

// File selection for wildcards
ipcMain.handle('select-files', async (): Promise<string[] | null> => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: 'Select Files for Batch Processing',
    message: 'Choose multiple files to process with wildcards',
    buttonLabel: 'Select Files',
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'FASTQ Files', extensions: ['fastq', 'fq'] },
      { name: 'Text Files', extensions: ['txt', 'csv', 'tsv'] },
      { name: 'BAM Files', extensions: ['bam', 'sam'] },
      { name: 'VCF Files', extensions: ['vcf', 'bcf'] },
    ],
  });

  return result.canceled ? null : result.filePaths;
});

// Directory selection dialog
ipcMain.handle('select-directory', async (): Promise<string | null> => {
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Working Directory',
    message: 'Choose where workflow files will be created',
    buttonLabel: 'Select Directory',
  });

  return result.canceled ? null : result.filePaths[0] || null;
});

// -----------------------------------------------------------------------------
// Workflow file persistence
//
// The renderer used to save via a synthetic <a download> and open via a hidden
// <input type="file">, which meant no real path ever reached the app: every
// save produced a new timestamped copy in ~/Downloads and "Save" could never
// overwrite. These handlers give the renderer actual paths to work with.
// -----------------------------------------------------------------------------

const WORKFLOW_FILTERS = [
  { name: 'RustRunner Workflow', extensions: ['json'] },
  { name: 'All Files', extensions: ['*'] },
];

/**
 * Writes workflow JSON to `filePath`, or prompts for one when it's null.
 * Returns the path actually written, or null if the user cancelled.
 */
ipcMain.handle(
  'save-workflow',
  async (
    _event,
    contents: string,
    filePath: string | null,
    suggestedName: string
  ): Promise<string | null> => {
    if (!mainWindow) return null;

    let target = filePath;

    if (!target) {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Workflow',
        defaultPath: `${suggestedName}.json`,
        filters: WORKFLOW_FILTERS,
      });
      if (result.canceled || !result.filePath) return null;
      target = result.filePath;
    }

    fs.writeFileSync(target, contents, 'utf-8');
    log.info(`Workflow saved to ${target}`);
    return target;
  }
);

/** Prompts for a workflow file and returns its path + contents. */
ipcMain.handle(
  'open-workflow',
  async (): Promise<{ path: string; contents: string } | null> => {
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Workflow',
      properties: ['openFile'],
      filters: WORKFLOW_FILTERS,
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const target = result.filePaths[0];
    return { path: target, contents: fs.readFileSync(target, 'utf-8') };
  }
);

/**
 * Asks the user whether to discard unsaved changes. Used both for in-app
 * destructive actions (New / Open / Clear) and the window close guard.
 */
ipcMain.handle('confirm-discard', async (_event, message: string): Promise<boolean> => {
  if (!mainWindow) return true;

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Discard', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Unsaved Changes',
    message,
    detail: 'Your changes will be lost.',
  });

  return response === 0;
});

/** Renderer keeps the main process informed so the close guard can act. */
ipcMain.on('set-dirty', (_event, dirty: boolean) => {
  rendererIsDirty = dirty;
});

// Workflow execution
ipcMain.on(
  'run-workflow',
  async (
    event: IpcMainEvent,
    workflowData: WorkflowData,
    dryRun: boolean = false,
    workingDir: string = ''
  ) => {
    try {
      // Refuse to start a second run while one is active. Overwriting
      // currentRustProcess would orphan the previous process (unkillable,
      // unpausable) and leak it.
      if (currentRustProcess) {
        event.reply(
          'workflow-error',
          'A workflow is already running. Stop it before starting another.'
        );
        return;
      }

      log.info('Starting workflow execution', { dryRun, workingDir });
      stoppedByUser = false;

      // Serialize workflow to YAML
      const yamlContent = yaml.dump(workflowData);

      // Create temp directory
      const tempDir = path.join(app.getPath('temp'), 'rustrunner');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const workflowPath = path.join(tempDir, 'workflow.yaml');
      fs.writeFileSync(workflowPath, yamlContent, 'utf-8');

      // Setup pause control
      pauseFlagPath = path.join(tempDir, 'pause.flag');
      if (fs.existsSync(pauseFlagPath)) {
        fs.unlinkSync(pauseFlagPath);
      }

      const rustExecutable = resolveRustExecutable();

      if (!fs.existsSync(rustExecutable)) {
        event.reply(
          'workflow-error',
          `Rust executable not found: ${rustExecutable}\n` +
            (app.isPackaged
              ? 'The packaged app is missing its bundled engine.'
              : 'Run `cargo build` in RustRunner/, or set RUSTRUNNER_BIN to the binary path.')
        );
        return;
      }

      // Build arguments. Wildcards are NOT passed on the command line — the
      // Rust CLI has no --wildcards flag and rejects unknown options. They
      // travel inside the YAML as per-step `wildcard_files`, which
      // load_workflow() merges and expands before validation.
      const args = [workflowPath, pauseFlagPath];
      if (dryRun) args.push('--dry-run');
      if (workingDir) args.push('--working-dir', workingDir);

      log.info('Spawning Rust process', { rustExecutable, args });

      // Spawn process
      const rustProcess = spawn(rustExecutable, args);
      currentRustProcess = rustProcess;

      // Stream output
      rustProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString();
        log.info('Rust stdout:', output);
        event.reply('workflow-output', output);
      });

      rustProcess.stderr.on('data', (data: Buffer) => {
        const error = data.toString();
        log.error('Rust stderr:', error);
        event.reply('workflow-output', error);
      });

      // Handle completion
      rustProcess.on('close', (code: number | null) => {
        log.info(`Rust process exited with code ${code}`);
        currentRustProcess = null;

        // Cleanup
        try {
          if (fs.existsSync(workflowPath)) fs.unlinkSync(workflowPath);
          if (fs.existsSync(pauseFlagPath)) fs.unlinkSync(pauseFlagPath);
        } catch (err) {
          log.error('Cleanup failed:', err);
        }

        // A kill we initiated is not a failure — report it as its own outcome
        // so the renderer doesn't log "Failed with code null".
        if (stoppedByUser) {
          stoppedByUser = false;
          event.reply('workflow-complete', false, 'Workflow stopped by user', 'stopped');
          return;
        }

        event.reply(
          'workflow-complete',
          code === 0,
          code === 0 ? 'Workflow completed successfully' : `Failed with code ${code}`,
          code === 0 ? 'success' : 'failed'
        );
      });

      rustProcess.on('error', (err: Error) => {
        log.error('Spawn error:', err);
        currentRustProcess = null;
        event.reply('workflow-error', err.message);
      });
    } catch (error: unknown) {
      log.error('Execution error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      event.reply('workflow-error', message);
    }
  }
);

// Pause workflow
ipcMain.on('pause-workflow', (event: IpcMainEvent) => {
  if (!currentRustProcess || !pauseFlagPath) return;

  try {
    fs.writeFileSync(pauseFlagPath, 'paused', 'utf-8');
    log.info('Created pause flag');
    event.reply('workflow-output', '\n[PAUSED] Workflow paused\n');
  } catch (error) {
    log.error('Pause error:', error);
  }
});

// Resume workflow
ipcMain.on('resume-workflow', (event: IpcMainEvent) => {
  if (!currentRustProcess || !pauseFlagPath) return;

  try {
    if (fs.existsSync(pauseFlagPath)) {
      fs.unlinkSync(pauseFlagPath);
      log.info('Removed pause flag');
      event.reply('workflow-output', '\n[RESUMED] Workflow resumed\n');
    }
  } catch (error) {
    log.error('Resume error:', error);
  }
});

// Stop workflow
ipcMain.on('stop-workflow', (event: IpcMainEvent) => {
  if (!currentRustProcess) return;

  try {
    // Clear any pause flag first so a paused engine can wake and observe the
    // termination signal instead of blocking in its pause wait-loop.
    if (pauseFlagPath && fs.existsSync(pauseFlagPath)) {
      fs.unlinkSync(pauseFlagPath);
    }
    stoppedByUser = true;
    currentRustProcess.kill();
    log.info('Sent stop signal to workflow process');
    event.reply('workflow-output', '\n[STOPPED] Workflow stopped by user\n');
  } catch (error) {
    log.error('Stop error:', error);
  }
});

// =============================================================================
// Environment Setup
// =============================================================================

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

// =============================================================================
// Window Creation
// =============================================================================

/**
 * Returns the path to the appropriate icon based on the current system theme.
 * Uses icon_dark for dark mode and icon_light for light mode.
 */
const getThemedIconPath = (getAssetPath: (...paths: string[]) => string): string => {
  const iconName = nativeTheme.shouldUseDarkColors ? 'icon_dark' : 'icon_light';

  // Use platform-appropriate format
  if (process.platform === 'win32') {
    return getAssetPath(`${iconName}.ico`);
  } else if (process.platform === 'darwin') {
    return getAssetPath(`${iconName}.icns`);
  }
  // Linux and fallback
  return getAssetPath(`${iconName}.png`);
};

const createWindow = async (): Promise<void> => {

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    icon: getThemedIconPath(getAssetPath),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) throw new Error('mainWindow is not defined');
    mainWindow.show();

    // Kick off the silent update check now that the renderer is mounted.
    // setupAutoUpdater schedules the actual fetch with its own delay,
    // and no-ops in dev mode.
    setupAutoUpdater(mainWindow);
  });

  // Unsaved-changes guard. `close` can't await, so cancel it, ask, and
  // re-close once the user confirms.
  mainWindow.on('close', (event) => {
    if (allowClose || !rendererIsDirty || !mainWindow) return;

    event.preventDefault();
    const win = mainWindow;

    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Discard', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Unsaved Changes',
        message: 'Quit without saving this workflow?',
        detail: 'Your changes will be lost.',
      })
      .then(({ response }) => {
        if (response === 0) {
          allowClose = true;
          win.close();
        }
      })
      .catch(log.error);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Listen for system theme changes and update the window icon dynamically
  nativeTheme.on('updated', () => {
    if (mainWindow) {
      const newIconPath = getThemedIconPath(getAssetPath);
      log.info(`System theme changed — switching icon to: ${path.basename(newIconPath)}`);
      mainWindow.setIcon(newIconPath);
    }
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  mainWindow.webContents.setWindowOpenHandler((edata) => {
    // Only hand off web URLs to the OS. Anything else (file://, custom
    // schemes, etc.) is refused rather than opened.
    try {
      const { protocol } = new URL(edata.url);
      if (protocol === 'http:' || protocol === 'https:') {
        shell.openExternal(edata.url);
      } else {
        log.warn(`Blocked external open for non-web URL: ${edata.url}`);
      }
    } catch {
      log.warn(`Blocked external open for invalid URL: ${edata.url}`);
    }
    return { action: 'deny' };
  });
};

// =============================================================================
// App Lifecycle
// =============================================================================

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      if (mainWindow === null) createWindow();
    });
  })
  .catch(log.error);
