/**
 * Searchable list of the bundled catalog tools. Picking one adds a prefilled
 * node; the free-form "+ Add Node" button stays for anything not listed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, categoryLabel, searchTools, type CatalogTool } from '../tools/catalog';
import { nodeColorVar } from '../nodeColors';
import { IconButton, Panel, Select, TextField } from '../ui';

export function ToolPalette({
  onAdd,
  onClose,
}: {
  onAdd: (tool: CatalogTool) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const results = useMemo(() => searchTools(query, category), [query, category]);

  return (
    <Panel
      className="tool-palette"
      data-testid="tool-palette"
      role="dialog"
      aria-label="Tool catalog"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      title="Tool Catalog"
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
        placeholder="Search by name or category"
        value={query}
        data-testid="palette-search"
        onChange={(e) => setQuery(e.target.value)}
      />

      <Select
        label="Category"
        hideLabel
        value={category}
        data-testid="palette-category"
        onChange={(e) => setCategory(e.target.value)}
      >
        <option value="">All categories</option>
        {Object.entries(CATALOG.categories).map(([id, { label }]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </Select>

      <div className="tool-palette-list" data-testid="palette-list">
        {results.length === 0 && (
          <div className="tool-palette-empty">
            No catalog tool matches. Use Add node for a custom step.
          </div>
        )}
        {results.map((tool) => (
          <button
            key={tool.id}
            className="tool-palette-item"
            data-testid={`palette-item-${tool.id}`}
            onClick={() => onAdd(tool)}
            title={`Add ${tool.name}`}
          >
            <span
              className="tool-palette-swatch"
              style={{ background: nodeColorVar(CATALOG.categories[tool.category]?.color) }}
            />
            <span className="tool-palette-text">
              <span className="tool-palette-name">{tool.name}</span>
              <span className="tool-palette-category">{categoryLabel(tool.category)}</span>
              <span className="tool-palette-description">{tool.description}</span>
              <span className="tool-palette-types">
                {tool.inputTypes.join(', ')} {'→'} {tool.outputTypes.join(', ')}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="tool-palette-footer">
        Catalog {CATALOG.version}, bundled. Tools are installed with conda when a workflow first
        runs them.
      </div>
    </Panel>
  );
}
