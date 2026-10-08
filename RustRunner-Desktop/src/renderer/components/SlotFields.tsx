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
  followsLabel,
  choices,
  error,
  onVisit,
  onFile,
  onKind,
  onLink,
  onUnlink,
}: {
  state: SlotState;
  /** For an output that follows another (STAR's BAM in its folder): that one's label. */
  followsLabel?: string;
  choices: LinkChoice[];
  error?: string;
  onVisit: () => void;
  onFile: (value: string) => void;
  onKind: (kind: SlotKind) => void;
  onLink: (choice: LinkChoice) => void;
  onUnlink: (fromNodeId?: string) => void;
}) {
  const { def, links } = state;
  const id = def.id;
  const isOutput = def.kind === 'output';
  const optional = !isOutput && !def.required;

  // An output that is another output plus a suffix has no field: it follows.
  if (def.derived) {
    return (
      <div className="slot-field" data-testid={`prop-slot-${id}-row`}>
        <div className="field">
          <span className="field-label" id={`prop-slot-${id}-label`}>
            {def.label} (written by this step)
          </span>
          <div role="group" aria-labelledby={`prop-slot-${id}-label`}>
            <code className="slot-file" data-testid={`prop-slot-${id}`}>
              {state.files.length > 0 ? state.files.join(', ') : 'follows the folder above'}
            </code>
          </div>
          <div className="field-hint">
            {def.hint} It follows {followsLabel ? `"${followsLabel}"` : 'the folder'}, so there is
            nothing to type. Later steps can use it.
          </div>
        </div>
      </div>
    );
  }

  // Links already made, so the picker offers only the others.
  const linkedKeys = new Set(links.map((l) => l.nodeId));
  const pickable = def.multiple ? choices.filter((c) => !linkedKeys.has(c.nodeId)) : choices;

  const linkedList = links.length > 0 && (
    <div className="field">
      <span className="field-label" id={`prop-slot-${id}-label`}>
        {def.label}
      </span>
      {links.map((link, index) => {
        // The first link keeps the plain test ids; later ones (a slot for several files) are numbered.
        const suffix = index === 0 ? '' : `-${index + 1}`;
        return (
        <div
          key={link.nodeId}
          className="slot-linked"
          role="group"
          aria-labelledby={`prop-slot-${id}-label`}
        >
          <Badge tone="info" icon="link" data-testid={`prop-slot-${id}-from-badge${suffix}`}>
            from {link.stepLabel}
          </Badge>
          <code className="slot-file" data-testid={`prop-slot-${id}${suffix}`}>
            {link.files.length > 0 ? link.files.join(', ') : 'no file yet'}
          </code>
          <Button
            size="sm"
            onClick={() => onUnlink(def.multiple ? link.nodeId : undefined)}
            data-testid={`prop-slot-${id}-unlink${suffix}`}
            aria-label={`Unlink ${def.label} from ${link.stepLabel}`}
          >
            Unlink
          </Button>
        </div>
        );
      })}
      <div className="field-hint">
        {def.multiple
          ? 'These follow the connected steps. Unlink one to type its file names instead.'
          : `It follows the ${links[0].outputLabel.toLowerCase()} of ${links[0].stepLabel}. Unlink to type a file name instead.`}
      </div>
      {error && (
        <div className="field-error">
          <span>{error}</span>
        </div>
      )}
    </div>
  );

  const picker = !isOutput && pickable.length > 0 && (
    <Select
      label={`Take "${def.label}" from a step`}
      hideLabel
      value=""
      data-testid={`prop-slot-${id}-from`}
      onChange={(e) => {
        const choice = pickable.find((c) => c.value === e.target.value);
        if (choice) onLink(choice);
      }}
    >
      <option value="">{def.multiple ? 'Add the output of a step…' : 'Use the output of a step…'}</option>
      {pickable.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </Select>
  );

  const placeholder = isOutput
    ? def.isDir
      ? 'e.g. results/'
      : 'e.g. results/sorted.bam'
    : def.example
      ? `e.g. ${def.example}`
      : 'File name, e.g. data/genome.fa';
  const typedHint = isOutput
    ? `${def.hint}${def.isDir ? ' A folder: end it with /.' : ''} Later steps can use it.`
    : `${def.hint} ${def.multiple ? 'Separate several files with commas.' : ''}`.trim();

  return (
    <div className="slot-field" data-testid={`prop-slot-${id}-row`}>
      {linkedList}
      {(links.length === 0 || def.multiple) && (
        <>
          <TextField
            label={
              isOutput
                ? `${def.label} (written by this step)`
                : links.length > 0
                  ? `${def.label}: more files by name`
                  : def.label
            }
            optional={optional}
            value={state.value}
            data-testid={links.length > 0 ? `prop-slot-${id}-typed` : `prop-slot-${id}`}
            placeholder={placeholder}
            error={links.length === 0 ? error : undefined}
            hint={typedHint}
            onChange={(e) => onFile(e.target.value)}
            onBlur={onVisit}
          />
          {picker}
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
  onUnlink: (slot: string, fromNodeId?: string) => void;
  onChoose: (option: BindingOption) => void;
  onDismiss: () => void;
}) {
  if (slots.length === 0 && !prompt) return null;
  /** Every file belongs to a catalog tool: the command is built for the person, so it is not explained. */
  const catalogOnly = slots.length > 0 && slots.every((s) => s.def.fromCatalog);
  const manyOutputs = prompt ? new Set(prompt.options.map((o) => o.outputKey)).size > 1 : false;

  return (
    <div className="slot-group" role="group" aria-labelledby="prop-slots-label" data-testid="prop-slots">
      <span className="field-label" id="prop-slots-label">
        {catalogOnly ? 'Files' : 'Files named in the command'}
      </span>
      <div className="field-hint">
        {catalogOnly ? (
          <>Type the name of each file, or connect a step that makes it.</>
        ) : (
          <>
            Each <code>{'{name}'}</code> in the command is a file. Type its name, or connect a step
            that makes it. To keep braces as plain text, write them twice:{' '}
            <code>{'{{name}}'}</code>.
          </>
        )}
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
          followsLabel={
            state.def.derived
              ? slots.find((other) => other.def.id === state.def.derived!.from)?.def.label
              : undefined
          }
          choices={choices}
          error={errorFor(state.def.id)}
          onVisit={() => onVisit(state.def.id)}
          onFile={(value) => onFile(state.def.id, value)}
          onKind={(kind) => onKind(state.def.id, kind)}
          onLink={(choice) => onLink(state.def.id, choice)}
          onUnlink={(fromNodeId) => onUnlink(state.def.id, fromNodeId)}
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
