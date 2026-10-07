/**
 * The tool catalog palette: a browsable list of the bundled tools (favourites,
 * recently used, then categories and their subcategories), ranked search, a
 * "fits after the selected step" filter, and a preview of the tool under the
 * cursor. Picking a tool adds a prefilled node; the free-form "Add node"
 * button stays for anything not listed.
 *
 * Keyboard: focus stays in the search box. Up and Down move over the rows,
 * Enter adds the tool (or opens and closes a category), Left and Right fold a
 * category while the box is empty, Escape closes. The row under the cursor is
 * announced through `aria-activedescendant`.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  CATALOG,
  categoryLabel,
  describeInstall,
  type CatalogTool,
} from '../tools/catalog';
import {
  browseOrder,
  fitsAfter,
  groupTools,
  moveIndex,
  rankTools,
  sharedTypes,
  toggleFavourite,
  type NavItem,
  type PalettePrefs,
} from '../toolBrowser';
import { nodeColorVar } from '../nodeColors';
import { Badge, Button, Checkbox, Icon, IconButton, Panel, Select, TextField } from '../ui';

/** The step that is selected on the canvas, when there is one. */
export interface SelectedStep {
  label: string;
  /** Its catalog tool; absent for a free-form step. */
  tool?: CatalogTool;
}

const PAGE = 6;

export function ToolPalette({
  onAdd,
  onClose,
  onAddCustom,
  prefs,
  onPrefsChange,
  selectedStep = null,
  onOpenDocs,
}: {
  onAdd: (tool: CatalogTool) => void;
  onClose: () => void;
  /** Adds an empty custom step; offered when the search finds nothing. */
  onAddCustom?: () => void;
  prefs: PalettePrefs;
  onPrefsChange: (prefs: PalettePrefs) => void;
  selectedStep?: SelectedStep | null;
  /** Opens a tool's documentation page (https only; the app checks it again). */
  onOpenDocs: (url: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [onlyFits, setOnlyFits] = useState(false);
  const [openCategories, setOpenCategories] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const previous = selectedStep?.tool;
  const fitsActive = onlyFits && Boolean(previous);

  const pool = useMemo(
    () =>
      CATALOG.tools.filter(
        (t) => (!category || t.category === category) && (!fitsActive || (previous && fitsAfter(t, previous)))
      ),
    [category, fitsActive, previous]
  );

  const searching = query.trim() !== '';
  const groups = useMemo(() => groupTools(pool), [pool]);
  const allOpen = Boolean(category) || fitsActive;
  const open = useMemo<ReadonlySet<string>>(
    () => (allOpen ? new Set(groups.map((g) => g.id)) : openCategories),
    [allOpen, groups, openCategories]
  );

  const inPool = useMemo(() => new Set(pool.map((t) => t.id)), [pool]);
  const byId = (id: string) => CATALOG.tools.find((t) => t.id === id);
  const favourites = useMemo(
    () => prefs.favourites.map(byId).filter((t): t is CatalogTool => Boolean(t) && inPool.has(t!.id)),
    [prefs.favourites, inPool]
  );
  const recent = useMemo(
    () => prefs.recent.map(byId).filter((t): t is CatalogTool => Boolean(t) && inPool.has(t!.id)),
    [prefs.recent, inPool]
  );

  const results = useMemo(() => (searching ? rankTools(query, pool) : []), [searching, query, pool]);

  const items: NavItem[] = useMemo(
    () =>
      searching
        ? results.map((tool) => ({ kind: 'tool' as const, key: `tool-${tool.id}`, tool }))
        : browseOrder(groups, favourites, recent, open),
    [searching, results, groups, favourites, recent, open]
  );

  const found = items.findIndex((i) => i.key === activeKey);
  // Without a choice yet the cursor is on the first row; when every category is
  // open anyway (a filter is on) it is on the first tool, so the preview has something to show.
  const firstTool = allOpen ? items.findIndex((i) => i.kind === 'tool') : -1;
  const activeIndex = found >= 0 ? found : items.length > 0 ? Math.max(firstTool, 0) : -1;
  const active = activeIndex >= 0 ? items[activeIndex] : null;
  const activeTool = active?.kind === 'tool' ? active.tool : null;

  // Keep the row under the cursor in view while moving with the keys.
  useEffect(() => {
    if (!active) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-nav-key="${active.key}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active?.key]);

  const toggleCategory = (id: string) => {
    if (allOpen) return;
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const move = (by: number) => {
    const to = moveIndex(activeIndex, by, items.length);
    if (to >= 0) setActiveKey(items[to].key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    switch (e.key) {
      case 'Escape':
        onClose();
        return;
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        return;
      case 'PageDown':
        e.preventDefault();
        move(PAGE);
        return;
      case 'PageUp':
        e.preventDefault();
        move(-PAGE);
        return;
      case 'Enter':
        if (!active) return;
        e.preventDefault();
        if (active.kind === 'tool') onAdd(active.tool);
        else toggleCategory(active.id);
        return;
      case 'ArrowRight':
      case 'ArrowLeft':
        // Only while the box is empty, so the caret keys still edit a query.
        if (!searching && active?.kind === 'category') {
          e.preventDefault();
          const isOpen = open.has(active.id);
          if ((e.key === 'ArrowRight') !== isOpen) toggleCategory(active.id);
        }
        return;
    }
  };

  const favouriteIds = new Set(prefs.favourites);
  const rowId = (key: string) => `palette-row-${key}`;

  const renderTool = (tool: CatalogTool, key: string, testId: string, withCategory: boolean) => {
    const isActive = active?.key === key;
    const needsDb = Boolean(tool.needs_database);
    return (
      <div
        key={key}
        id={rowId(key)}
        role="treeitem"
        aria-level={searching ? 1 : 2}
        aria-selected={isActive}
        data-nav-key={key}
        data-testid={testId}
        className={`tool-palette-item${isActive ? ' is-active' : ''}`}
        onMouseMove={() => !isActive && setActiveKey(key)}
        onClick={() => onAdd(tool)}
      >
        <span
          className="tool-palette-swatch"
          style={{ background: nodeColorVar(CATALOG.categories[tool.category]?.color) }}
        />
        <span className="tool-palette-text">
          <span className="tool-palette-name">
            {tool.name}
            {favouriteIds.has(tool.id) && (
              <Icon name="star-filled" size={12} className="tool-palette-star" />
            )}
            {favouriteIds.has(tool.id) && <span className="visually-hidden"> (favourite)</span>}
            {needsDb && (
              <Badge tone="warning" variant="outline" className="tool-palette-flag">
                Needs a database
              </Badge>
            )}
          </span>
          <span className="tool-palette-category">
            {withCategory ? `${categoryLabel(tool.category)} · ` : ''}
            {tool.subcategory}
          </span>
          <span className="tool-palette-description">{tool.description}</span>
        </span>
      </div>
    );
  };

  const renderSection = (title: string, icon: 'star' | 'clock', tools: CatalogTool[], prefix: string) =>
    tools.length > 0 && (
      <div role="group" aria-label={title} className="tool-palette-group" key={prefix}>
        <div className="tool-palette-group-title" aria-hidden="true">
          <Icon name={icon} size={12} /> {title}
        </div>
        {tools.map((tool) => renderTool(tool, `${prefix}-${tool.id}`, `palette-${prefix}-${tool.id}`, true))}
      </div>
    );

  const selectedLabel = selectedStep?.label ?? '';

  return (
    <Panel
      className="tool-palette"
      data-testid="tool-palette"
      role="dialog"
      aria-label="Tool catalog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      title="Tool catalog"
      actions={
        <IconButton
          icon="x"
          label="Close tool catalog"
          size="sm"
          onClick={onClose}
          data-testid="palette-close"
        />
      }
    >
      <TextField
        inputRef={searchRef}
        label="Search tools"
        hideLabel
        type="search"
        placeholder="Search by name, job, package or file type"
        value={query}
        data-testid="palette-search"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-tree"
        aria-autocomplete="list"
        aria-activedescendant={active ? rowId(active.key) : undefined}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveKey(null);
        }}
      />

      <div className="tool-palette-filters">
        <Select
          label="Category"
          hideLabel
          value={category}
          data-testid="palette-category"
          onChange={(e) => {
            setCategory(e.target.value);
            setActiveKey(null);
          }}
        >
          <option value="">All categories</option>
          {Object.entries(CATALOG.categories).map(([id, { label }]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
        {!searching && !allOpen && (
          <Button
            size="sm"
            data-testid="palette-toggle-all"
            onClick={() =>
              setOpenCategories(
                openCategories.size === groups.length ? new Set() : new Set(groups.map((g) => g.id))
              )
            }
          >
            {openCategories.size === groups.length ? 'Collapse all' : 'Expand all'}
          </Button>
        )}
      </div>

      <Checkbox
        label={previous ? `Only tools that fit after ${selectedLabel}` : 'Only tools that fit after the selected step'}
        hint={
          previous
            ? undefined
            : selectedStep
              ? `${selectedLabel} is not a catalog tool, so its output type is not known.`
              : 'Select a step on the canvas first.'
        }
        checked={fitsActive}
        disabled={!previous}
        data-testid="palette-fits-after"
        onChange={(e) => {
          setOnlyFits(e.target.checked);
          setActiveKey(null);
        }}
      />

      <div className="tool-palette-body">
        <div
          className="tool-palette-list"
          id="palette-tree"
          role="tree"
          aria-label="Tools"
          data-testid="palette-list"
          ref={listRef}
        >
          {items.length === 0 && (
            <div className="tool-palette-empty" data-testid="palette-empty">
              <Icon name="info" size={16} />
              <p>
                {searching
                  ? `No catalog tool matches "${query.trim()}".`
                  : fitsActive
                    ? `No catalog tool reads what ${selectedLabel} makes.`
                    : 'No catalog tool in this category.'}{' '}
                Try a shorter word, or a tool's job such as "align" or "trim".
              </p>
              <div className="tool-palette-empty-actions">
                <Button
                  size="sm"
                  data-testid="palette-clear-search"
                  onClick={() => {
                    setQuery('');
                    setCategory('');
                    setOnlyFits(false);
                    searchRef.current?.focus();
                  }}
                >
                  Clear search
                </Button>
                {onAddCustom && (
                  <Button size="sm" data-testid="palette-add-custom" onClick={onAddCustom}>
                    Add a custom step
                  </Button>
                )}
              </div>
            </div>
          )}

          {searching && results.map((tool) => renderTool(tool, `tool-${tool.id}`, `palette-item-${tool.id}`, true))}

          {!searching && (
            <>
              {renderSection('Favourites', 'star', favourites, 'fav')}
              {renderSection('Recently used', 'clock', recent, 'recent')}
              {groups.map((group) => {
                const isOpen = open.has(group.id);
                const key = `cat-${group.id}`;
                const isActive = active?.key === key;
                return (
                  <div role="group" key={group.id} className="tool-palette-group">
                    <div
                      id={rowId(key)}
                      role="treeitem"
                      aria-level={1}
                      aria-expanded={isOpen}
                      aria-selected={isActive}
                      data-nav-key={key}
                      data-testid={`palette-category-${group.id}`}
                      className={`tool-palette-category-row${isActive ? ' is-active' : ''}`}
                      onMouseMove={() => !isActive && setActiveKey(key)}
                      onClick={() => toggleCategory(group.id)}
                    >
                      <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                      <span
                        className="tool-palette-swatch tool-palette-swatch-dot"
                        style={{ background: nodeColorVar(group.color) }}
                      />
                      <span className="tool-palette-category-name">{group.label}</span>
                      <span className="tool-palette-count">
                        {group.count} {group.count === 1 ? 'tool' : 'tools'}
                      </span>
                    </div>
                    {isOpen &&
                      group.subcategories.map((sub) => (
                        <div role="group" aria-label={sub.name} key={sub.name}>
                          <div className="tool-palette-sub" aria-hidden="true">
                            {sub.name}
                          </div>
                          {sub.tools.map((tool) =>
                            renderTool(tool, `tool-${tool.id}`, `palette-item-${tool.id}`, false)
                          )}
                        </div>
                      ))}
                  </div>
                );
              })}
            </>
          )}
        </div>

        <ToolPreview
          tool={activeTool}
          previous={previous && activeTool && fitsAfter(activeTool, previous) ? previous : undefined}
          favourite={activeTool ? favouriteIds.has(activeTool.id) : false}
          onToggleFavourite={() => activeTool && onPrefsChange(toggleFavourite(prefs, activeTool.id))}
          onAdd={() => activeTool && onAdd(activeTool)}
          onOpenDocs={onOpenDocs}
          categoryHint={
            active?.kind === 'category'
              ? `${categoryLabel(active.id)}: press Enter to ${open.has(active.id) ? 'fold' : 'open'} it.`
              : undefined
          }
        />
      </div>

      <div className="tool-palette-footer">
        <span>
          {items.length > 0 && searching
            ? `${results.length} of ${CATALOG.tools.length} tools. `
            : `${CATALOG.tools.length} tools. `}
          Up and Down move, Enter adds, Esc closes.
        </span>
        <span>Catalog {CATALOG.version}, bundled.</span>
      </div>
    </Panel>
  );
}

function TypeList({ types }: { types: string[] }) {
  return (
    <span className="tool-preview-types">
      {types.map((t) => (
        <Badge key={t} tone="neutral" variant="outline">
          {t}
        </Badge>
      ))}
    </span>
  );
}

/** What the tool under the cursor does, reads, makes and needs. */
function ToolPreview({
  tool,
  previous,
  favourite,
  onToggleFavourite,
  onAdd,
  onOpenDocs,
  categoryHint,
}: {
  tool: CatalogTool | null;
  previous?: CatalogTool;
  favourite: boolean;
  onToggleFavourite: () => void;
  onAdd: () => void;
  onOpenDocs: (url: string) => void;
  categoryHint?: string;
}) {
  if (!tool) {
    return (
      <div className="tool-preview tool-preview-empty" data-testid="palette-preview" aria-live="polite">
        <Icon name="info" size={16} />
        <p>{categoryHint ?? 'Move over a tool to see what it does, what it reads and what it makes.'}</p>
      </div>
    );
  }
  const version = tool.install.kind === 'system' ? null : tool.install.version;
  return (
    <div className="tool-preview" data-testid="palette-preview" aria-live="polite">
      <h4 className="tool-preview-name" data-testid="palette-preview-name">
        {tool.name}
      </h4>
      <p className="tool-preview-text">{tool.description}</p>
      {previous && (
        <p className="tool-preview-fit" data-testid="palette-preview-fit">
          <Icon name="check" size={12} /> Reads what {previous.name} makes ({sharedTypes(tool, previous).join(', ')}).
        </p>
      )}

      {tool.needs_database && (
        <div className="tool-preview-database" data-testid="palette-preview-database">
          <Icon name="alert" size={14} />
          <div>
            <strong>Needs {tool.needs_database.label}.</strong> {tool.needs_database.hint}{' '}
            <button
              type="button"
              className="link-button"
              data-testid="palette-preview-database-docs"
              onClick={() => onOpenDocs(tool.docs)}
            >
              Open the documentation
            </button>
          </div>
        </div>
      )}

      <h5 className="tool-preview-heading">Reads</h5>
      <ul className="tool-preview-slots">
        {tool.inputs.map((slot) => (
          <li key={slot.name}>
            <span>
              {slot.label}
              {!slot.required && <span className="tool-preview-optional"> (optional)</span>}
            </span>
            <TypeList types={slot.types} />
          </li>
        ))}
      </ul>

      <h5 className="tool-preview-heading">Makes</h5>
      <ul className="tool-preview-slots">
        {tool.outputs
          .filter((slot) => !slot.derived)
          .map((slot) => (
            <li key={slot.name}>
              <span>{slot.is_dir ? `${slot.label} (folder)` : slot.label}</span>
              <TypeList types={slot.types} />
            </li>
          ))}
      </ul>

      <h5 className="tool-preview-heading">Installation</h5>
      <p className="tool-preview-text" data-testid="palette-preview-install">
        {describeInstall(tool.install)}
      </p>
      {version && (
        <p className="tool-preview-text tool-preview-version" data-testid="palette-preview-version">
          Version {version}
        </p>
      )}

      <div className="tool-preview-actions">
        <Button size="sm" variant="primary" icon="plus" data-testid="palette-preview-add" onClick={onAdd}>
          Add to workflow
        </Button>
        <Button
          size="sm"
          icon={favourite ? 'star-filled' : 'star'}
          pressed={favourite}
          aria-pressed={favourite}
          data-testid="palette-favourite"
          onClick={onToggleFavourite}
        >
          {favourite ? 'Remove from favourites' : 'Add to favourites'}
        </Button>
        <Button size="sm" variant="ghost" icon="link" data-testid="palette-preview-docs" onClick={() => onOpenDocs(tool.docs)}>
          Documentation
        </Button>
      </div>
    </div>
  );
}

