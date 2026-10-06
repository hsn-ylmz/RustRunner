/** Slim banner reporting auto-update status. */

import { Button, Icon, IconButton, type IconName } from '../ui';

/**
 * Status payloads emitted by the main process over the 'update-status'
 * IPC channel. Kept inline (rather than imported from preload.d.ts) so the
 * renderer stays free of cross-process type imports — the shape is also
 * declared in src/main/updater.ts and src/renderer/preload.d.ts; keep all
 * three in sync.
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

/** What an update failure means for the person, before the technical message. */
export const UPDATE_ERROR_HELP =
  'You can keep working. RustRunner tries again the next time it starts.';

/** Human-readable bytes-per-second for the download progress line. */
function formatBytesPerSec(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes.toFixed(0)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}

/**
 * Renders a slim banner at the top of the app when there's something
 * worth saying about updates.
 *
 * Status × manual matrix:
 *
 *   checking      manual → "Checking for updates…"   silent → hidden
 *   up-to-date    manual → "You're up to date"       silent → hidden
 *   available     always shown
 *                   canAutoInstall=true  → "Downloading in the background…"
 *                   canAutoInstall=false → "Download from GitHub" action
 *   downloading   always shown, with a progress strip
 *   downloaded    always shown — "Restart & Install" (only fires on auto-install platforms)
 *   error         always shown
 *
 * Dismissal is per-status-transition; the parent un-dismisses when the
 * status field changes, so dismissing during download still surfaces the
 * "ready to install" prompt when the download finishes.
 */
export function UpdateBanner({
  status,
  onInstall,
  onDismiss,
}: {
  status: UpdateStatus | null;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  if (!status) return null;

  // Silent-flow suppression: hide the "Checking…" tick and the
  // "Up to date" reassurance unless the user explicitly asked.
  if (status.status === 'checking' && !status.manual) return null;
  if (status.status === 'up-to-date' && !status.manual) return null;

  let title = '';
  let detail = '';
  let progressPct: number | null = null;
  let action: { label: string; onClick: () => void } | null = null;
  let variant: 'info' | 'success' | 'error' = 'info';
  let icon: IconName = 'info';
  let busy = false;

  switch (status.status) {
    case 'checking':
      title = 'Checking for updates…';
      icon = 'spinner';
      busy = true;
      break;
    case 'available':
      title = `Update available — v${status.version}`;
      if (status.canAutoInstall) {
        detail = 'Downloading in the background…';
      } else {
        // Detection-only platform (e.g. unsigned macOS): point the user
        // to GitHub for a manual install.
        detail = 'Open the GitHub release page to download.';
        action = { label: 'Download from GitHub', onClick: onInstall };
      }
      break;
    case 'downloading': {
      title = 'Downloading update';
      icon = 'spinner';
      busy = true;
      progressPct = Math.max(0, Math.min(100, status.percent));
      const speed = formatBytesPerSec(status.bytesPerSecond);
      detail = speed
        ? `${progressPct.toFixed(0)}% — ${speed}`
        : `${progressPct.toFixed(0)}%`;
      break;
    }
    case 'downloaded':
      title = `Update ready — v${status.version}`;
      detail = status.canAutoInstall
        ? 'Restart RustRunner to install.'
        : 'Open the GitHub release page to install.';
      action = {
        label: status.canAutoInstall ? 'Restart & Install' : 'Download from GitHub',
        onClick: onInstall,
      };
      variant = 'success';
      icon = 'check';
      break;
    case 'up-to-date':
      title = `You're up to date — v${status.version}`;
      variant = 'success';
      icon = 'check';
      break;
    case 'error':
      title = 'Could not check for updates';
      detail = status.message ? `${UPDATE_ERROR_HELP} (${status.message})` : UPDATE_ERROR_HELP;
      variant = 'error';
      icon = 'alert';
      break;
  }

  return (
    <div
      className={`update-banner update-banner-${variant}`}
      role="status"
      data-testid="update-banner"
      data-variant={variant}
    >
      <Icon name={icon} size={16} spin={busy} className="update-banner-icon" />
      <div className="update-banner-text">
        <span className="update-banner-title">{title}</span>
        {detail && (
          <span className="update-banner-detail" title={detail}>
            {detail}
          </span>
        )}
      </div>

      {progressPct !== null && (
        <div
          className="update-banner-progress"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPct)}
        >
          <div
            className="update-banner-progress-bar"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      <div className="update-banner-actions">
        {action && (
          <Button variant="primary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
        <IconButton
          icon="x"
          size="sm"
          label="Dismiss update notification"
          onClick={onDismiss}
        />
      </div>
    </div>
  );
}
