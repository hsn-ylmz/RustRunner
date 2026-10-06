import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Dialog,
  IconButton,
  NumberField,
  Panel,
  Section,
  Select,
  TextArea,
  TextField,
  Tooltip,
  buttonClassName,
  describedBy,
  fieldIds,
} from '../ui';
import { FOCUSABLE_SELECTOR, trapTarget } from '../ui/focus';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

/** The value of attribute `name` on the first element matching `tag`. */
function attr(markup: string, tag: string, name: string): string | undefined {
  const el = new RegExp(`<${tag}\\b[^>]*>`).exec(markup)?.[0] ?? '';
  return new RegExp(`\\s${name}="([^"]*)"`).exec(el)?.[1];
}

describe('buttonClassName', () => {
  it('defaults to a medium secondary button', () => {
    expect(buttonClassName()).toBe('btn btn-secondary btn-md');
  });

  it('adds variant, size, width, icon-only and pressed modifiers', () => {
    expect(
      buttonClassName({ variant: 'primary', size: 'lg', fullWidth: true, iconOnly: true, pressed: true, className: 'x' })
    ).toBe('btn btn-primary btn-lg btn-block btn-icon is-pressed x');
  });
});

describe('Button', () => {
  it('renders a native button that does not submit forms', () => {
    const m = html(<Button>Save</Button>);
    expect(attr(m, 'button', 'type')).toBe('button');
    expect(m).toContain('Save');
  });

  it('uses the native disabled state when disabled', () => {
    const m = html(<Button disabled>Save</Button>);
    expect(m).toMatch(/<button[^>]*\sdisabled=""/);
    expect(m).not.toContain('aria-disabled');
  });

  it('stays focusable and says why when given a reason', () => {
    const m = html(<Button disabledReason="Add a step first">Run</Button>);
    expect(m).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(attr(m, 'button', 'aria-disabled')).toBe('true');
  });

  it('marks a loading button busy and unavailable without dropping focus', () => {
    const m = html(<Button loading>Run</Button>);
    expect(attr(m, 'button', 'aria-busy')).toBe('true');
    expect(attr(m, 'button', 'aria-disabled')).toBe('true');
    expect(m).toContain('icon-spin');
  });

  it('shows the icon before the label', () => {
    const m = html(<Button icon="plus">Add</Button>);
    expect(m.indexOf('<svg')).toBeLessThan(m.indexOf('Add'));
  });
});

describe('IconButton', () => {
  it('is named by its label', () => {
    const m = html(<IconButton icon="x" label="Close tool catalog" />);
    expect(attr(m, 'button', 'aria-label')).toBe('Close tool catalog');
    expect(m).toContain('btn-icon');
  });

  it('reports a toggle state through aria-pressed', () => {
    expect(attr(html(<IconButton icon="x" label="Bold" pressed />), 'button', 'aria-pressed')).toBe('true');
  });
});

describe('fields', () => {
  it('derives the hint and error ids from the control id', () => {
    expect(fieldIds('f1')).toEqual({ id: 'f1', hintId: 'f1-hint', errorId: 'f1-error' });
  });

  it('describes a control by its error first, then its hint', () => {
    const ids = fieldIds('f1');
    expect(describedBy(ids, { hint: 'h', error: 'e' })).toBe('f1-error f1-hint');
    expect(describedBy(ids, { hint: 'h' })).toBe('f1-hint');
    expect(describedBy(ids, {})).toBeUndefined();
    expect(describedBy(ids, { hint: 'h', extra: 'u' })).toBe('f1-hint u');
  });

  it('names a text field with its label', () => {
    const m = html(<TextField id="name" label="Node name" />);
    expect(m).toContain('<label class="field-label" for="name">Node name</label>');
    expect(attr(m, 'input', 'id')).toBe('name');
  });

  it('wires hint and error to the control', () => {
    const m = html(<TextField id="t" label="Tool" hint="Pick one" error="Required" />);
    expect(attr(m, 'input', 'aria-describedby')).toBe('t-error t-hint');
    expect(attr(m, 'input', 'aria-invalid')).toBe('true');
    expect(m).toContain('id="t-error"');
    expect(m).toContain('id="t-hint"');
  });

  it('does not mark a valid field invalid', () => {
    expect(attr(html(<TextField id="t" label="Tool" hint="Pick one" />), 'input', 'aria-invalid')).toBeUndefined();
  });

  it('flags required and optional fields in the label', () => {
    expect(html(<TextField label="Reference" required />)).toContain('(required)');
    expect(html(<TextField label="Version" optional />)).toContain('(optional)');
  });

  it('hides a label visually but keeps it for screen readers', () => {
    const m = html(<TextField id="s" label="Search tools" hideLabel />);
    expect(m).toContain('field-label visually-hidden');
    expect(m).toContain('Search tools');
  });

  it('passes extra attributes to the control, not the wrapper', () => {
    const m = html(<TextField id="x" label="L" data-testid="prop-label" maxLength={5} />);
    expect(attr(m, 'input', 'data-testid')).toBe('prop-label');
    expect(attr(m, 'input', 'maxLength')).toBe('5');
    expect(attr(m, 'div', 'data-testid')).toBeUndefined();
  });

  it('generates a unique id when none is given', () => {
    const m = html(
      <>
        <TextField label="A" />
        <TextField label="B" />
      </>
    );
    const ids = [...m.matchAll(/<input[^>]*\sid="([^"]+)"/g)].map((x) => x[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(m).toContain(`for="${id}"`);
  });

  it('shows a unit after a number field and includes it in the description', () => {
    const m = html(<NumberField id="d" label="Retry delay" unit="seconds" />);
    expect(attr(m, 'input', 'type')).toBe('number');
    expect(m).toContain('>seconds<');
    expect(attr(m, 'input', 'aria-describedby')).toBe('d-unit');
  });

  it('renders select options and a text area with their labels', () => {
    const select = html(
      <Select id="s" label="Mode">
        <option value="a">A</option>
      </Select>
    );
    expect(attr(select, 'select', 'id')).toBe('s');
    expect(select).toContain('<option value="a">A</option>');
    const area = html(<TextArea id="c" label="Command" mono />);
    expect(area).toContain('<textarea');
    expect(area).toContain('control-mono');
  });

  it('puts the checkbox inside its label so the text is clickable', () => {
    const m = html(<Checkbox id="k" label="Keep going" hint="More" disabled />);
    expect(m).toContain('<label class="check-row" for="k">');
    expect(attr(m, 'input', 'type')).toBe('checkbox');
    expect(attr(m, 'input', 'aria-describedby')).toBe('k-hint');
    expect(m).toContain('is-disabled');
  });
});

describe('containers and badges', () => {
  it('names a section by its title', () => {
    const m = html(
      <Section title="Files">
        <p>body</p>
      </Section>
    );
    const titleId = /<h4[^>]*id="([^"]+)"/.exec(m)?.[1];
    expect(titleId).toBeTruthy();
    expect(attr(m, 'section', 'aria-labelledby')).toBe(titleId);
  });

  it('draws a card section with the card modifier', () => {
    expect(html(<Section title="T" card />)).toContain('section-card');
  });

  it('gives a panel a title and a scrolling body', () => {
    const m = html(<Panel title="Properties">x</Panel>);
    expect(m).toContain('<h3 class="panel-title">Properties</h3>');
    expect(m).toContain('panel-body');
  });

  it('renders a badge with tone, variant and text', () => {
    const m = html(
      <Badge tone="danger" variant="solid" icon="x">
        3 failed
      </Badge>
    );
    expect(m).toContain('badge badge-danger badge-solid');
    expect(m).toContain('3 failed');
    expect(m).toContain('<svg');
  });

  it('renders a callout with an icon and its message', () => {
    const m = html(<Callout tone="warning">Fill in: Reference</Callout>);
    expect(m).toContain('callout-warning');
    expect(m).toContain('Fill in: Reference');
    expect(m).toContain('<svg');
  });
});

describe('Tooltip', () => {
  it('renders just the control while closed', () => {
    const m = html(
      <Tooltip content="Why">
        <button>Go</button>
      </Tooltip>
    );
    expect(m).toContain('tooltip-anchor');
    expect(m).not.toContain('role="tooltip"');
  });

  it('renders the child untouched when there is nothing to say', () => {
    const m = html(
      <Tooltip content="">
        <button>Go</button>
      </Tooltip>
    );
    expect(m).toBe('<button>Go</button>');
  });
});

describe('Dialog', () => {
  it('is a labelled modal with its title, body and footer', () => {
    const m = html(
      <Dialog title="New workflow" onClose={() => {}} footer={<button>OK</button>}>
        <p>body</p>
      </Dialog>
    );
    expect(attr(m, 'div', 'class')).toBe('dialog-overlay');
    expect(m).toContain('role="dialog"');
    expect(m).toContain('aria-modal="true"');
    const titleId = /<h3[^>]*id="([^"]+)"/.exec(m)?.[1];
    expect(m).toContain(`aria-labelledby="${titleId}"`);
    expect(m).toContain('New workflow');
    expect(m).toContain('dialog-footer');
  });
});

describe('trapTarget', () => {
  it('leaves Tab alone in the middle of the dialog', () => {
    expect(trapTarget(4, 1, false)).toBeNull();
    expect(trapTarget(4, 2, true)).toBeNull();
  });

  it('wraps from the last control to the first and back', () => {
    expect(trapTarget(4, 3, false)).toBe(0);
    expect(trapTarget(4, 0, true)).toBe(3);
  });

  it('pulls focus back in when it is outside the dialog', () => {
    expect(trapTarget(4, -1, false)).toBe(0);
    expect(trapTarget(4, -1, true)).toBe(3);
  });

  it('does nothing when there is nothing to focus', () => {
    expect(trapTarget(0, -1, false)).toBeNull();
  });

  it('keeps disabled controls out of the tab order', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('input:not([disabled])');
  });
});
