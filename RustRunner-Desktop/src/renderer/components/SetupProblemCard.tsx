import { useState } from 'react';
import { Button, Callout, Icon } from '../ui';
import { describeInstallResult, type SetupProblemView } from '../runFeedback';

type InstallState =
  | { phase: 'idle' }
  | { phase: 'installing' }
  | { phase: 'finished'; tone: 'success' | 'danger'; text: string };

/**
 * A run that could not start because something it needs is missing: says what
 * is missing, offers the one action that fixes it (when the app can do it), and
 * lists the places the engine looked for the technical reader.
 */
export function SetupProblemCard({ problem }: { problem: SetupProblemView }) {
  const [install, setInstall] = useState<InstallState>({ phase: 'idle' });

  const runInstall = async () => {
    setInstall({ phase: 'installing' });
    try {
      const result = await window.electron.ipcRenderer.installMicromamba();
      setInstall({ phase: 'finished', ...describeInstallResult(result) });
    } catch (e) {
      const text = e instanceof Error ? e.message : 'The installation failed.';
      setInstall({ phase: 'finished', ...describeInstallResult({ ok: false, error: text }) });
    }
  };

  const installed = install.phase === 'finished' && install.tone === 'success';

  return (
    <div className="failure-card setup-card" data-testid="setup-card" role="group" aria-label="Setup problem">
      <div className="failure-main">
        <div className="failure-head">
          <h4 className="failure-title" data-testid="setup-title">
            <Icon name="alert" size={14} /> {problem.headline}
          </h4>
          {problem.actionLabel && !installed && (
            <div className="failure-actions">
              <Button
                size="sm"
                variant="primary"
                data-testid="setup-install"
                loading={install.phase === 'installing'}
                onClick={runInstall}
              >
                {install.phase === 'installing' ? 'Installing...' : problem.actionLabel}
              </Button>
            </div>
          )}
        </div>
        <p className="failure-what" data-testid="setup-what">
          {problem.what}
        </p>
        {install.phase === 'finished' && (
          <Callout tone={install.tone} data-testid="setup-install-result" role="status">
            {install.text}
          </Callout>
        )}
      </div>
      {problem.searched.length > 0 && (
        <details className="setup-searched" data-testid="setup-searched">
          <summary>Where the engine looked ({problem.searched.length})</summary>
          <ul>
            {problem.searched.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
