/**
 * "Save as template": names the template and asks which files become the
 * template's own inputs (the ones the next person is asked for) and which stay
 * as they are. A workflow with a step written by hand cannot be saved; the
 * dialog says which step is in the way.
 */

import { useMemo, useState } from 'react';
import { Button, Callout, Checkbox, Dialog, TextArea, TextField } from '../ui';
import {
  buildUserTemplate,
  groupCandidates,
  inputCandidates,
  templateBlockers,
  type CandidateGroup,
} from '../templates/fromWorkflow';
import type { WorkflowTemplate } from '../templates/schema';

interface Choice {
  ask: boolean;
  label: string;
}

export function SaveTemplateDialog({
  nodes,
  edges,
  defaultName,
  onClose,
  onSave,
}: {
  nodes: any[];
  edges: any[];
  defaultName: string;
  onClose: () => void;
  /** Stores the template. Resolves an error sentence, or null when saved. */
  onSave: (template: WorkflowTemplate) => Promise<string | null>;
}) {
  const blockers = useMemo(() => templateBlockers(nodes), [nodes]);
  const groups = useMemo(
    () => (blockers.length > 0 ? [] : groupCandidates(inputCandidates(nodes, edges))),
    [nodes, edges, blockers.length]
  );
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      groupCandidates(inputCandidates(nodes, edges)).map((g) => [g.id, { ask: g.required, label: g.label }])
    )
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choiceOf = (g: CandidateGroup): Choice => choices[g.id] ?? { ask: g.required, label: g.label };
  const setChoice = (g: CandidateGroup, patch: Partial<Choice>) =>
    setChoices((c) => ({ ...c, [g.id]: { ...choiceOf(g), ...patch } }));

  const blocked =
    blockers.length > 0
      ? blockers[0]
      : name.trim() === ''
        ? 'Give the template a name'
        : groups.some((g) => choiceOf(g).ask && choiceOf(g).label.trim() === '')
          ? 'Every file you ask for needs a name'
          : undefined;

  const save = async () => {
    const result = buildUserTemplate(nodes, edges, {
      name,
      description,
      inputs: groups
        .filter((g) => g.mustAsk || choiceOf(g).ask)
        .map((g) => ({ candidateIds: g.candidates.map((c) => c.id), label: choiceOf(g).label.trim() })),
    });
    if (result.ok === false) {
      setError(result.errors.join(' '));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const problem = await onSave(result.template);
      if (problem) setError(problem);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Save as template"
      testId="save-template-dialog"
      onClose={onClose}
      dirty={name !== defaultName || description !== ''}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            data-testid="save-template-confirm"
            disabledReason={blocked}
            onClick={() => void save()}
          >
            Save template
          </Button>
        </>
      }
    >
      {blockers.length > 0 ? (
        <Callout tone="warning" data-testid="save-template-blockers">
          <strong>This workflow cannot be a template yet.</strong>
          <ul className="template-list">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Callout>
      ) : (
        <>
          <TextField
            label="Template name"
            value={name}
            data-testid="save-template-name"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !blocked && void save()}
          />
          <TextArea
            label="What does it do"
            optional
            rows={3}
            value={description}
            data-testid="save-template-description"
            placeholder="One or two sentences, for the template list."
            onChange={(e) => setDescription(e.target.value)}
          />
          <fieldset className="template-asks">
            <legend className="field-label">Files to ask for</legend>
            <p className="template-hint">
              Tick the files you want to choose each time you use the template. Files you leave unticked stay as they are now.
            </p>
            {groups.length === 0 && <p className="template-hint">No step reads a file you set yourself.</p>}
            {groups.map((g) => {
              const choice = choiceOf(g);
              const asked = g.mustAsk || choice.ask;
              const now = g.candidates[0].value;
              return (
                <div className="template-ask" key={g.id}>
                  <Checkbox
                    label={g.label}
                    checked={asked}
                    disabled={g.mustAsk}
                    data-testid={`save-template-ask-${g.id.replace(/\W+/g, '-')}`}
                    hint={
                      g.mustAsk
                        ? 'Needed: no file is chosen here, so the template has to ask for one.'
                        : now
                          ? `Now: ${now}`
                          : 'Optional.'
                    }
                    onChange={(e) => setChoice(g, { ask: e.target.checked })}
                  />
                  {asked && (
                    <TextField
                      label="Ask for it as"
                      value={choice.label}
                      onChange={(e) => setChoice(g, { label: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
          {error && (
            <Callout tone="danger" data-testid="save-template-error">
              {error}
            </Callout>
          )}
        </>
      )}
    </Dialog>
  );
}
