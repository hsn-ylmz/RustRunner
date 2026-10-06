/**
 * Canvas: the React Flow surface, the custom node renderer and node placement.
 */

import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  NodeToolbar,
  useReactFlow,
  MiniMap,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeStatus } from '../stepEvents';
import { firstFreePosition, type Rect } from '../nodePlacement';

export const COLOR_OPTIONS = [
  '#a8e6cf', '#88c5f7', '#d4a5f7', '#f5efe9',
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6',
];

export const DEFAULT_COLOR = '#88c5f7';

/**
 * Chooses where a newly added node should appear.
 *
 * Measured against the canvas element, NOT the window: the toolbars and the
 * properties panel make the canvas considerably smaller than the window, so
 * window-relative placement lands nodes near the canvas's bottom-right corner.
 *
 * Placement also has to dodge the floating overlays, which sit above the nodes
 * and swallow clicks on anything underneath them — the execution controls
 * (top-left), the MiniMap (bottom-right) and the zoom Controls (bottom-left).
 * Nodes are laid out on a 3x2 grid inside the remaining box and cycle through
 * its cells, so consecutive nodes never stack on each other either.
 *
 * Positions are computed in screen space and converted, so panning and zoom
 * are handled by React Flow rather than guessed at. The viewport can move
 * between additions (the first node triggers fit-to-view, opening the
 * properties panel resizes the canvas), so a grid cell that was empty when it
 * was computed may not be where the earlier nodes ended up; `occupied` lets
 * the choice skip cells that would cover an existing node.
 */
export function nextNodePosition(
  wrapper: HTMLElement | null,
  nodeCount: number,
  toFlow: (p: { x: number; y: number }) => { x: number; y: number },
  occupied: Rect[] = []
): { x: number; y: number } {
  if (!wrapper) {
    return toFlow({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  const rect = wrapper.getBoundingClientRect();

  // Insets clearing the floating overlays. Generous rather than exact — the
  // cost of being wrong is an unclickable node.
  const box = {
    left: rect.x + 170,
    top: rect.y + 90,
    right: rect.right - 230,
    bottom: rect.bottom - 60,
  };

  // Two columns, not three: a node renders around 300px wide, so three columns
  // in this box would be narrower than the nodes themselves and they'd overlap.
  const COLS = 2;
  const ROWS = 2;
  const cells = COLS * ROWS;
  const width = Math.max(box.right - box.left, 1);
  const height = Math.max(box.bottom - box.top, 1);

  const slot = (index: number) => {
    const cell = index % cells;
    const col = cell % COLS;
    const row = Math.floor(cell / COLS);

    // Once the grid wraps, nudge each new lap so nodes don't land exactly on
    // top of the ones from the previous lap.
    const lap = Math.floor(index / cells) * 26;

    return toFlow({
      x: box.left + (width * (col + 0.5)) / COLS + lap,
      y: box.top + (height * (row + 0.5)) / ROWS + lap,
    });
  };

  // Walk the slots from the natural one until a slot is clear of every node
  // already placed; fall back to the natural one if the canvas is full.
  const MAX_TRIES = cells * 20;
  const candidates = (function* () {
    for (let i = 0; i < MAX_TRIES; i++) yield slot(nodeCount + i);
  })();
  return firstFreePosition(candidates, occupied) ?? slot(nodeCount);
}

/** Badge glyph shown in the corner of a node for each execution state. */
const STATUS_GLYPH: Record<string, string> = {
  running: '●',
  retrying: '↻',
  succeeded: '✓',
  skipped: '⏭',
  failed: '✕',
};

function CustomNode({ id, data, selected }: any) {
  const { updateNodeData } = useReactFlow();

  const handleColorChange = (newColor: string) => {
    updateNodeData(id, { color: newColor });
  };

  const nodeColor = data.color || DEFAULT_COLOR;

  // Injected by the editor rather than stored on the node, so execution state
  // never ends up in a saved workflow file.
  const status: NodeStatus | undefined = data.__status;
  const invalidReason: string | undefined = data.__invalidReason;

  const state = status?.state ?? 'idle';
  const showCount = status && status.total > 1;

  return (
    <>
      <NodeToolbar isVisible={selected} className="nopan">
        <div className="color-picker-toolbar">
          {COLOR_OPTIONS.map((colorOption) => (
            <button
              key={colorOption}
              onClick={() => handleColorChange(colorOption)}
              className={`color-button ${colorOption === nodeColor ? 'selected' : ''}`}
              style={{ backgroundColor: colorOption }}
              title={`Change color to ${colorOption}`}
            />
          ))}
        </div>
      </NodeToolbar>

      <div
        className={[
          'custom-node',
          selected ? 'selected' : '',
          `node-state-${state}`,
          invalidReason ? 'node-invalid' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ background: nodeColor }}
        data-testid="workflow-node"
        data-state={state}
        title={status?.message || invalidReason || undefined}
      >
        <Handle type="target" position={Position.Top} />

        {state !== 'idle' && state !== 'pending' && (
          <div className={`node-status-badge node-status-${state}`}>
            {STATUS_GLYPH[state]}
          </div>
        )}

        <div className="node-label">{data.label || 'New Node'}</div>
        <div className="node-tool">{data.tool || 'No tool'}</div>

        {showCount && (
          <div className="node-progress">
            {status!.finished}/{status!.total}
          </div>
        )}

        {invalidReason && (
          <div className="node-invalid-badge" title={invalidReason}>
            !
          </div>
        )}

        <Handle type="source" position={Position.Bottom} />
      </div>
    </>
  );
}

const nodeTypes = { custom: CustomNode };
const defaultEdgeOptions = { animated: true };

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelectionChange,
}: {
  nodes: any[];
  edges: any[];
  onNodesChange: (changes: any) => void;
  onEdgesChange: (changes: any) => void;
  onConnect: (params: any) => void;
  onSelectionChange: (selection: any) => void;
}) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      defaultEdgeOptions={defaultEdgeOptions}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onSelectionChange={onSelectionChange}
      nodeTypes={nodeTypes}
      fitView
      // A lone first node would otherwise be fitted at React Flow's 2x maximum
      // zoom, which makes it huge and throws off where later nodes land.
      fitViewOptions={{ maxZoom: 1 }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={30}
        color="var(--canvas-grid)"
      />
      <Controls />
      <MiniMap
        nodeStrokeWidth={1}
        nodeColor={(node: any) => node.data?.color || '#aaa'}
      />
    </ReactFlow>
  );
}
