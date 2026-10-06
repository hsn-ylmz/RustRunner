/**
 * The files a command names with `{placeholders}`, drawn as labelled fields,
 * and the preview of the command with those files filled in. The rules (which
 * slots a step has, what connecting does, how the command resolves) live in
 * slots.ts; this is only the drawing.
 */

import { Badge, Button, Callout, Select, TextField } from '../ui';
import type { BindingOption, LinkChoice, Preview, SlotKind, SlotState } from '../slots';

export interface BindingPromptData {
  /** The earlier step whose file is waiting for a slot. */
  sourceLabel: string;
  options: BindingOption[];
}

function SlotField({
  state,
  choices,
  error,
  onVisit,
  onFile,
  onKind,
  onLink,
  onUnlink,
}: {
  state: SlotState;
  choices: LinkChoice[];
  error?: string;
  onVisit: () => void;
  onFile: (value: string) => void;
  onKind: (kind: SlotKind) => void;
  onLink: (choice: LinkChoice) => void;
  onUnlink: () => void;
}) {
  const { def, link } = state;
  const id = def.id;
  const isOutput = def.kind === 'output';

  return (
    <div className="slot-field" data-testid={`prop-slot-${id}-row`}>
      {link ? (
        <div className="field">
          <span className="field-label" id={`prop-slot-${id}-label`}>
            {def.label}
          </span>
          <div className="slot-linked" role="group" aria-labelledby={`prop-slot-${id}-label`}>
            <Badge tone="info" icon="link" data-testid={`prop-slot-${id}-from-badge`}>
              from {link.stepLabel}
            </Badge>
            <code className="slot-file" data-testid={`prop-slot-${id}`}>
              {state.files.length > 0 ? state.files.join(', ') : 'no file yet'}
            </code>
            <Button size="sm" onClick={onUnlink} data-testid={`prop-slot-${id}-unlink`}>
              Unlink
            </Button>
          </div>
          <div className="field-hint">
            It follows the {link.outputLabel.toLowerCase()} of {link.stepLabel}. Unlink to type a
            file name instead.
          </div>
          {error && (
            <div className="field-error">
              <span>{error}</span>
            </div>
          )}
        </div>
      ) : (
        <>
          <TextField
            label={isOutput ? `${def.label} (written by this step)` : def.label}
            value={state.value}
            data-testid={`prop-slot-${id}`}
            placeholder={isOutput ? 'e.g. results/sorted.bam' : 'File name, e.g. data/genome.fa'}
            error={error}
            hint={`${def.hint}${isOutput ? ' Later steps can use it.' : ' Separate several files with commas.'}`}
            onChange={(e) => onFile(e.target.value)}
            onBlur={onVisit}
          />
          {!isOutput && choices.length > 0 && (
            <Select
              label={`Take "${def.label}" from a step`}
              hideLabel
              value=""
              data-testid={`prop-slot-${id}-from`}
              onChange={(e) => {
                const choice = choices.find((c) => c.value === e.target.value);
                if (choice) onLink(choice);
              }}
            >
              <option value="">Use the output of a step…</option>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </>
      )}
      {!def.fromCatalog && (
        <Select
          label={`What "${def.label}" is`}
          value={def.kind}
          className="slot-kind"
          data-testid={`prop-slot-${id}-kind`}
          onChange={(e) => onKind(e.target.value === 'output' ? 'output' : 'input')}
        >
          <option value="input">A file the step reads</option>
          <option value="output">A file the step writes</option>
        </Select>
      )}
    </div>
  );
}

export function SlotFields({
  slots,
  choices,
  prompt,
  errorFor,
  onVisit,
  onFile,
  onKind,
  onLink,
  onUnlink,
  onChoose,
  onDismiss,
}: {
  slots: SlotState[];
  choices: LinkChoice[];
  prompt: BindingPromptData | null;
  errorFor: (slot: string) => string | undefined;
  onVisit: (slot: string) => void;
  onFile: (slot: string, value: string) => void;
  onKind: (slot: string, kind: SlotKind) => void;
  onLink: (slot: string, choice: LinkChoice) => void;
  onUnlink: (slot: string) => void;
  onChoose: (option: BindingOption) => void;
  onDismiss: () => void;
}) {
  if (slots.length === 0 && !prompt) return null;
  const manyOutputs = prompt ? new Set(prompt.options.map((o) => o.outputKey)).size > 1 : false;

  return (
    <div className="slot-group" role="group" aria-labelledby="prop-slots-label" data-testid="prop-slots">
      <span className="field-label" id="prop-slots-label">
        Files named in the command
      </span>
      <div className="field-hint">
        Each <code>{'{name}'}</code> in the command is a file. Type its name, or connect a step that
        makes it. To keep braces as plain text, write them twice: <code>{'{{name}}'}</code>.
      </div>

      {prompt && (
        <Callout tone="info" data-testid="binding-prompt">
          <div>
            Where should the file from <strong>{prompt.sourceLabel}</strong> go?
          </div>
          <div className="slot-prompt-actions" role="group" aria-label="Choose where the file goes">
            {prompt.options.map((o) => (
              <Button
                key={`${o.slot}|${o.outputKey}`}
                size="sm"
                onClick={() => onChoose(o)}
                data-testid={`binding-option-${o.slot}-${o.outputKey || 'main'}`}
              >
                {manyOutputs ? `${o.outputLabel} to ${o.slotLabel}` : o.slotLabel}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={onDismiss} data-testid="binding-skip">
              Leave empty
            </Button>
          </div>
        </Callout>
      )}

      {slots.map((state) => (
        <SlotField
          key={state.def.id}
          state={state}
          choices={choices}
          error={errorFor(state.def.id)}
          onVisit={() => onVisit(state.def.id)}
          onFile={(value) => onFile(state.def.id, value)}
          onKind={(kind) => onKind(state.def.id, kind)}
          onLink={(choice) => onLink(state.def.id, choice)}
          onUnlink={() => onUnlink(state.def.id)}
        />
      ))}
    </div>
  );
}

/**
 * The command with each placeholder replaced by its file. One that has no file
 * is marked with its own text ("no file"), not only a colour.
 */
export function CommandPreview({ preview }: { preview: Preview }) {
  if (preview.pieces.length === 0) return null;
  return (
    <div className="field" data-testid="command-preview-field">
      <span className="field-label" id="command-preview-label">
        What will run
      </span>
      <pre
        className="command-preview"
        role="group"
        aria-labelledby="command-preview-label"
        data-testid="command-preview"
      >
        {preview.pieces.map((piece, i) =>
          piece.state === 'text' ? (
            <span key={i}>{piece.text}</span>
          ) : piece.state === 'filled' ? (
            <span key={i} className="preview-filled">
              {piece.text}
            </span>
          ) : (
            <mark key={i} className="preview-missing" data-testid={`preview-missing-${piece.name}`}>
              {piece.text}
              <span className="preview-flag">
                {piece.reason === 'unknown' ? ' unknown' : piece.reason === 'unsafe' ? ' not in quotes' : ' no file'}
              </span>
            </mark>
          )
        )}
      </pre>
      {preview.missing.length > 0 ? (
        <div className="field-hint" data-testid="command-preview-missing">
          Marked parts have no file yet: {preview.missing.map((n) => `{${n}}`).join(', ')}.
        </div>
      ) : (
        <div className="field-hint">Quotes are added around file names for you.</div>
      )}
    </div>
  );
}
