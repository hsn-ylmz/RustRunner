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
  }>;
  wildcardFiles?: Record<string, string[]>;
}

// =============================================================================
// Application State
// =============================================================================

let mainWindow: BrowserWindow | null = null;
let currentRustProcess: ChildProcess | null = null;
let pauseFlagPath: string = '';

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
      log.info('Starting workflow execution', { dryRun, workingDir });

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

      // Find Rust executable
      const rustExecutable =
        process.env.NODE_ENV === 'development'
          ? path.join(__dirname, '../../../RustRunner/target/debug/rustrunner')
          : path.join(process.resourcesPath, 'rustrunner');

      if (!fs.existsSync(rustExecutable)) {
        event.reply('workflow-error', `Rust executable not found: ${rustExecutable}`);
        return;
      }

      // Build arguments
      const args = [workflowPath, pauseFlagPath];
      if (dryRun) args.push('--dry-run');
      if (workingDir) args.push('--working-dir', workingDir);

      // Serialize wildcard files to JSON
      if (workflowData.wildcardFiles) {
        const wildcardsPath = path.join(tempDir, 'wildcards.json');
        fs.writeFileSync(
          wildcardsPath,
          JSON.stringify(workflowData.wildcardFiles),
          'utf-8'
        );
        args.push('--wildcards', wildcardsPath);
      }

      log.info('Spawning Rust process', { args });

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

        event.reply(
          'workflow-complete',
          code === 0,
          code === 0 ? 'Workflow completed successfully' : `Failed with code ${code}`
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
    shell.openExternal(edata.url);
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
