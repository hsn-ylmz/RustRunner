---
name: ui-ux
description: Design rules for the RustRunner Desktop renderer (tokens, primitives, layout, copy, accessibility) and how to capture and review screenshots. Use whenever you add or change any UI in RustRunner-Desktop/src/renderer, write UI copy, touch CSS, or review the look of the app.
---

# RustRunner UI/UX

RustRunner is a visual, no-DSL workflow builder for biologists who are not programmers. Goal: a first-time user builds and runs a pipeline without reading docs. Calm, dense but legible, light and dark, Figma/Linear level of polish.

## Principles

1. Forms and feedback, never a DSL. Every setting is a labelled field with a hint; never ask for syntax without an example.
2. Say what is happening and what to do next. A disabled control says why (`disabledReason`); an error says what is wrong and the fix.
3. One primary action per screen region (Run, Create, Save). Everything else is secondary or ghost.
4. Colour is never the only signal: pair it with an icon, a word, or a line style (status badges, dashed mismatch edges).
5. Nothing important is hover-only. Tooltips are extra; the same information must be reachable by keyboard focus or be visible.
6. Calm: no hover lifts, no decorative motion. Motion only shows progress, and respects reduced motion (handled globally in `styles/base.css`).

## Where things live (`RustRunner-Desktop/src/renderer`)

| Path | What |
| --- | --- |
| `styles/tokens.css` | All tokens, light and dark. The only file with colour literals. |
| `styles/base.css` | Reset, page defaults, global focus ring, reduced motion. |
| `ui/` | Primitives (import from `../ui`), `ui/ui.css` their styles. |
| `App.css` | Layout and app-specific pieces (nodes, edges, panels). Tokens only. |
| `nodeColors.ts` | Node colour names; the only other file allowed colour literals (legacy hex of old files). |

## Tokens

Use `var(--name)` only. Never write a hex, `rgb()`, `hsl()`, `white` or `black` outside `tokens.css`; `npm test` (designSystem.test.ts) fails on it, and also on undefined `var(--x)` and on any text/background pair below 4.5:1 or boundary below 3:1 in either theme.

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg` (canvas), `--surface` (toolbar, palette), `--surface-muted` (side/bottom panels), `--surface-sunken` (inputs, log), `--elevated` (dialogs), `--overlay` |
| Text | `--text`, `--text-muted` (hints, placeholders), `--text-inverse` (on solid fills) |
| Borders | `--border` (decorative dividers), `--border-strong` (edge of a control, 3:1) |
| Roles | `--accent --success --warning --danger --info`, each with `-solid` (fill, white text), `-solid-hover`, `-subtle` (tint). Plain `--role` is text/icon colour. |
| Status | `--status-{pending,running,retrying,succeeded,failed,skipped}` (text/border) and `-solid` (badge fill) |
| Canvas | `--edge-default/-match/-mismatch`, `--node-border`, `--node-text(-muted)`, `--node-<name>` fills (mint, sky, lilac, sand, rose, peach, lemon, sage, periwinkle, lavender) |
| Space | `--space-half` 2, `--space-1..6` = 4, 8, 12, 16, 24, 32 |
| Radius | `--radius-control` 4, `--radius-card` 8, `--radius-pill` |
| Type | `--text-xs..xl` = 12, 13, 14, 16, 20; `--weight-*`; `--font-sans`, `--font-mono` |
| Other | `--shadow-sm/md/lg`, `--focus-ring-color/-width/-offset`, `--duration-fast/base/slow`, `--ease-standard` |

To add or change a colour: edit both dark blocks and the light block in `tokens.css` (the two dark blocks must be identical), add the pair to `requirements()` in `designSystem.test.ts` if it is a new text/background combination, run `npm test`.

Node colours are stored by name (`"sky"`); `normalizeNodeColor` also accepts the hex values older files hold. Never read `data.color` as CSS directly: use `nodeColorVar()`.

## Primitives (`import { ... } from './ui'`)

| Use | When |
| --- | --- |
| `Button` variant `primary` | The single next step (Run, Create, Save). One per region. |
| `Button` `secondary` (default) | Any other action. `ghost` for dense toolbar rows. `danger` for destructive actions about to happen (Stop). |
| `Button` props | `size` sm/md/lg, `icon`, `loading` (spinner, keeps focus), `disabledReason` (unavailable and why, stays focusable), `tooltip`, `fullWidth`, `pressed`. Prefer `disabledReason` over bare `disabled` for anything a first-time user might find greyed out. |
| `IconButton` | Icon-only action. `label` is required: it is the accessible name and the tooltip. |
| `TextField`, `NumberField` (`unit`), `TextArea`, `Select`, `Checkbox` | Every input. Each takes `label`, `hint`, `error`, `required`/`optional`, `hideLabel`; ids and `aria-describedby` are wired for you. Extra props (`data-testid`, `min`...) go to the control. Never write a bare `<label>` + `<input>`. |
| `Panel` | A side/bottom surface with a title. |
| `Section` | A titled group inside a panel or dialog (`card` for a block that stands apart). |
| `Badge` | State or tag: tone neutral/accent/success/warning/danger/info, variant subtle/solid/outline/dashed, optional icon. Always has text. |
| `Callout` | Inline message about the adjacent content (missing option, hand-edited command). Use a field's `error` for one field. |
| `Tooltip` | Short extra explanation; opens on hover and keyboard focus. Not for essential information. |
| `Dialog` | Modal: titled, Escape closes, focus trapped and restored, overlay click ignored when `dirty`. |
| `Icon` | Inline SVG set (`ui/Icon.tsx`). Add icons there; do not use emoji or text glyphs. |

Keep `data-testid` and the class names the e2e tests use (`.working-directory`, `.dirty-marker`, `.step-row-details`).

## Layout

- Spacing from the 4-point scale only; type from the five sizes. No other px values for gap, padding, font-size.
- Radii: controls 4, cards and dialogs 8, chips pill.
- Control height 32 (md), 28 (sm), 40 (lg). Pointer targets at least 24px.
- Labels above fields, hints below at 12px regular (not italic, not monospace). Group a panel with `Section`s: what it is, files, run settings, testing, checks.
- Toolbar labels stay on one line. Floating canvas overlays must not hide each other: check the palette and run column at 1440x900 with the properties panel open.
- Never rely on `opacity` for disabled or pending states: it destroys text contrast. Disabled is a flat neutral fill (`--disabled-*`).

## Copy

- Plain words a biologist uses: file, sample, step, run. Avoid: wildcard, pattern, step ID, blocking, mock, DSL terms. If a technical word is unavoidable, explain it in the hint.
- Sentence case. Buttons are verbs ("Add node", "Clear canvas", "Clear log"); no trailing colon on labels; no emoji.
- One or two short lines per hint: say what it does, then an example. Errors: what is wrong, then what to do ("empty.txt is empty. Check the command or turn the check off.").
- Name things by what the person sees (node name), not internal ids.

## Accessibility checklist

- [ ] Every input has a visible or `hideLabel` label tied by `htmlFor` (use the field primitives).
- [ ] Every icon-only button has `aria-label` (use `IconButton`).
- [ ] Focus ring visible on everything focusable: do not set `outline: none`.
- [ ] Text 4.5:1, boundaries and icons 3:1 in light and dark (the vitest checks tokens; check any new combination).
- [ ] Status and verdicts have an icon or text, not just colour.
- [ ] Dialogs: role, labelled by title, Escape, focus trap and restore.
- [ ] Tabs use the tablist pattern (arrow keys, `aria-controls`, tabpanel).
- [ ] No information only in `title` or hover; animations stop under `prefers-reduced-motion`.
- [ ] Works at 1440x900 and at about 1100px wide without horizontal page scroll.

## Capturing and reviewing screenshots

`npm run ux:screens` (in `RustRunner-Desktop`) builds the engine and app, drives the real Electron app through the standard states (empty canvas, catalog palette, selected catalog and custom node, details and new dialogs, typed edges with match and mismatch, retrying, running, finished, failed with a blocking check, run history, validation error) in light and dark at 1440x900, and writes PNGs named `<group>-<nn>-<state>-<scheme>.png` to `UX_OUT`. Without `UX_OUT` the spec is skipped.

```
cd RustRunner-Desktop
UX_OUT=../ux-review/<name> npx playwright test ux-screens   # after `npm run build`
```

The fixtures sandbox HOME, so nothing touches `~/.rustrunner`. Then open the PNGs with the Read tool and check, in both themes: contrast of text and borders, focus and selection visibility, overlaps and wrapping (toolbar, run column, palette), truncated labels, status readable without colour, consistent spacing. Compare against `ux-review/before/` and `ux-review/after-design-system/`. Add a state to `e2e/ux-screens.e2e.ts` when you add a new screen or dialog.

## Before you finish a UI change

`npm test` (tokens, no raw colours, primitives), both `tsc` projects, `npm run test:e2e`, then re-capture and look at the affected screens in light and dark.
