/**
 * What a first-time user sees on an empty canvas: what to do first, and how
 * the whole thing works in three steps. It sits over the canvas and is gone as
 * soon as there is a step.
 */

import { Button } from '../ui';

const STEPS: { title: string; text: string }[] = [
  { title: 'Add steps', text: 'Pick tools from the catalog, or write your own command.' },
  {
    title: 'Connect them',
    text: 'Drag from the dot under one step to the dot above the next, so results flow along.',
  },
  { title: 'Run', text: 'Press Run. You choose a folder for the results the first time.' },
];

export function EmptyState({
  modifier,
  onOpenCatalog,
  onAddCustom,
  onOpenWorkflow,
}: {
  /** "Cmd" or "Ctrl", for the tip line. */
  modifier: string;
  onOpenCatalog: () => void;
  onAddCustom: () => void;
  onOpenWorkflow: () => void;
}) {
  return (
    <div className="empty-state-wrap">
      <section className="empty-state" data-testid="empty-state" aria-labelledby="empty-state-title">
        <h2 className="empty-state-title" id="empty-state-title">
          Build your first pipeline
        </h2>
        <p className="empty-state-lead">
          A pipeline is a chain of steps. Each step runs one tool on your files.
        </p>

        <div className="empty-state-actions">
          <Button
            variant="primary"
            size="lg"
            icon="plus"
            fullWidth
            data-testid="empty-add-catalog"
            onClick={onOpenCatalog}
          >
            Add a tool from the catalog
          </Button>
          <Button fullWidth icon="plus" data-testid="empty-add-custom" onClick={onAddCustom}>
            Add a custom step
          </Button>
          <Button variant="ghost" fullWidth icon="folder" data-testid="empty-open" onClick={onOpenWorkflow}>
            Open a workflow
          </Button>
        </div>

        <ol className="empty-state-steps" aria-label="How it works">
          {STEPS.map((step, i) => (
            <li key={step.title}>
              <span className="empty-state-number" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <strong>{step.title}.</strong> {step.text}
              </span>
            </li>
          ))}
        </ol>

        <p className="empty-state-tip">
          Tip: press {modifier}+K to search tools, or ? to see every shortcut.
        </p>
      </section>
    </div>
  );
}
