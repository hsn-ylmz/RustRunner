/**
 * Auto-Update Module
 *
 * Wires up electron-updater to check GitHub releases, signal the renderer
 * over the `update-status` IPC channel, and handle the install action.
 *
 * Two entry points:
 *   - `setupAutoUpdater(window)` — called once at startup. Registers all
 *     event listeners and schedules a silent check ~5s later.
 *   - `checkForUpdatesManually()` — called from the Help menu. Same
 *     pipeline but tags emitted payloads with `manual: true` so the
 *     renderer surfaces the "Checking…" and "Up to date" states it
 *     otherwise suppresses.
 *
 * Platform handling
 *   electron-updater's auto-install path requires the new app bundle to
 *   pass codesign verification against the current one. On macOS our
 *   build has `identity: null`, so verification fails and quitAndInstall
 *   throws. We treat darwin as **detection-only**: no background download,
 *   no in-app install — instead, the renderer's action button opens the
 *   GitHub release page in the user's browser so they can install
 *   manually. Flip CAN_AUTO_INSTALL once signing is set up.
 *
 *   Windows NSIS and Linux AppImage don't require signing and use the
 *   full auto-download + quitAndInstall flow.
 *
 *   Dev mode (app.isPackaged === false) is a no-op for everything —
 *   electron-updater can't resolve its own version or feed URL without
 *   a packaged build.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

// =============================================================================
// Types
// =============================================================================

/**
 * Status payloads pushed to the renderer.
 *
 * `manual` indicates the user triggered the check (vs the silent startup
 * sweep); the renderer uses it to decide whether to show "Checking…"
 * and "Up to date" states.
 *
 * `canAutoInstall` on `available` / `downloaded` tells the renderer what
 * the action button should do: trigger `quitAndInstall` or open the
 * GitHub release page.
 *
 * Keep this shape in sync with `UpdateStatus` in renderer/preload.d.ts
 * and renderer/App.tsx.
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
  | {
      status: 'downloading';
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | { status: 'downloaded'; version: string; canAutoInstall: boolean }
  | { status: 'error'; manual: boolean; message: string };

// =============================================================================
// Constants
// =============================================================================

/**
 * GitHub owner/repo for the fallback "Download from GitHub" link on
 * platforms where auto-install isn't supported. Must match the publish
 * config in package.json (build.publish[0]).
 */
const GITHUB_OWNER = 'hsn-ylmz';
const GITHUB_REPO = 'RustRunner';

/**
 * Whether the current platform supports auto-install of downloaded updates.
 *
 * macOS is excluded because our build is unsigned; quitAndInstall would
 * fail signature verification. Once signing is configured in
 * package.json (build.mac.identity), flip this to `true` for darwin.
 */
const CAN_AUTO_INSTALL = process.platform !== 'darwin';

/** Delay between window-open and the silent startup check. */
const STARTUP_CHECK_DELAY_MS = 5_000;

/** IPC channel used to push update status to the renderer. */
const UPDATE_STATUS_CHANNEL = 'update-status';

/** IPC channel the renderer uses to trigger the action button. */
const INSTALL_UPDATE_CHANNEL = 'install-update';

// =============================================================================
// Module state
// =============================================================================

/**
 * Guards against double-initialization. On macOS, the user can close the
 * window and reopen it via the dock, which fires `ready-to-show` a second
 * time. Without this flag we'd stack listeners and send duplicates.
 */
let initialized = false;

/**
 * True while the renderer should treat the current pipeline as manual
 * (show "Checking…" / "Up to date"). Set by checkForUpdatesManually(),
 * cleared when the pipeline reaches a terminal state.
 */
let manualCheckInFlight = false;

/**
 * Cached window reference so the manual-check entry point can also send
 * events without re-receiving the window parameter every call.
 */
let cachedWindow: BrowserWindow | null = null;

// =============================================================================
// Helpers
// =============================================================================

function send(payload: UpdateStatus): void {
  if (cachedWindow && !cachedWindow.isDestroyed()) {
    cachedWindow.webContents.send(UPDATE_STATUS_CHANNEL, payload);
  }
}

/** GitHub releases URL for the given version (or `/latest` if omitted). */
function releaseUrl(version?: string): string {
  const base = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
  return version ? `${base}/tag/v${version}` : `${base}/latest`;
}

// =============================================================================
// Public API
// =============================================================================

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  // Refresh the cached window every call — even when we bail early, so a
  // later manual check (which is a no-op in dev anyway) has a target.
  cachedWindow = mainWindow;

  if (!app.isPackaged) {
    log.info('[updater] dev mode — skipping auto-update check');
    return;
  }

  if (initialized) {
    log.info('[updater] already initialized — skipping re-registration');
    return;
  }
  initialized = true;

  autoUpdater.logger = log;

  // On platforms that can't auto-install we also disable auto-download —
  // downloading a .dmg that we can't install just wastes bandwidth.
  autoUpdater.autoDownload = CAN_AUTO_INSTALL;
  autoUpdater.autoInstallOnAppQuit = CAN_AUTO_INSTALL;

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking for update');
    send({ status: 'checking', manual: manualCheckInFlight });
  });

  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] update available: ${info.version}`);
    send({
      status: 'available',
      manual: manualCheckInFlight,
      version: info.version,
      canAutoInstall: CAN_AUTO_INSTALL,
      downloadUrl: CAN_AUTO_INSTALL ? undefined : releaseUrl(info.version),
      releaseDate: info.releaseDate,
      releaseNotes:
        typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    });
    // On detection-only platforms (macOS unsigned), `available` is the
    // terminal state — there's no download/install phase. On auto-install
    // platforms we keep `manualCheckInFlight` set so the eventual
    // `downloaded` event can still be considered part of the manual
    // pipeline (though the renderer doesn't actually use it there).
    if (!CAN_AUTO_INSTALL) {
      manualCheckInFlight = false;
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`[updater] up to date (latest = ${info.version})`);
    send({ status: 'up-to-date', manual: manualCheckInFlight, version: info.version });
    manualCheckInFlight = false;
  });

  autoUpdater.on('download-progress', (progress) => {
    // progress.percent is a float in [0, 100]
    send({
      status: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] update downloaded: ${info.version}`);
    send({
      status: 'downloaded',
      version: info.version,
      canAutoInstall: CAN_AUTO_INSTALL,
    });
    manualCheckInFlight = false;
  });

  autoUpdater.on('error', (err) => {
    log.error('[updater] error:', err);
    send({
      status: 'error',
      manual: manualCheckInFlight,
      message: err?.message ?? String(err),
    });
    manualCheckInFlight = false;
  });

  // The renderer's action button. Behavior depends on platform:
  //   - Auto-installable: quit and run the bundled installer
  //   - Detection-only:   open the GitHub release page externally
  ipcMain.on(INSTALL_UPDATE_CHANNEL, () => {
    if (CAN_AUTO_INSTALL) {
      log.info('[updater] install-update — calling quitAndInstall');
      // The two args (isSilent, isForceRunAfter) only affect Windows.
      autoUpdater.quitAndInstall(false, true);
    } else {
      const url = releaseUrl();
      log.info(`[updater] install-update — opening external URL: ${url}`);
      shell.openExternal(url).catch((err) => {
        log.error('[updater] failed to open release URL:', err);
      });
    }
  });

  // Silent startup check. Promise rejections are caught here so a network
  // failure doesn't crash the main process — the 'error' event handler
  // will also fire and surface the message to the renderer.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('[updater] startup checkForUpdates failed:', err);
    });
  }, STARTUP_CHECK_DELAY_MS);
}

/**
 * Manually trigger an update check (e.g. from the Help menu).
 *
 * Sets `manualCheckInFlight = true` so the renderer can surface
 * states that are normally suppressed for the silent startup sweep.
 * Cleared automatically when the check reaches a terminal state.
 *
 * No-op in dev mode or before setupAutoUpdater() has run.
 */
export function checkForUpdatesManually(): void {
  if (!app.isPackaged) {
    log.info('[updater] manual check requested in dev — ignoring');
    return;
  }

  if (!initialized) {
    log.warn('[updater] manual check requested before initialization');
    return;
  }

  log.info('[updater] manual check requested');
  manualCheckInFlight = true;

  autoUpdater.checkForUpdates().catch((err) => {
    log.error('[updater] manual checkForUpdates failed:', err);
    // The 'error' event handler will also fire and forward to the renderer,
    // so we don't double-send here.
  });
}
