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
  BaseEdge,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { NodeStatus } from '../stepEvents';
import { firstFreePosition, type Rect } from '../nodePlacement';
import type { TypeCheck } from '../tools/catalog';
import { NODE_COLORS, nodeColorVar, normalizeNodeColor } from '../nodeColors';
import { MISMATCH_LABEL, edgeLabelWidth } from '../edgeLabel';
import { Badge, Icon, Tooltip, type IconName } from '../ui';

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

/** Icon shown in the corner of a node for each execution state. */
const STATUS_ICON: Record<string, IconName> = {
  running: 'dot',
  retrying: 'retry',
  succeeded: 'check',
  skipped: 'skip',
  failed: 'x',
};

const STATUS_NAME: Record<string, string> = {
  running: 'Running',
  retrying: 'Retrying',
  succeeded: 'Succeeded',
  skipped: 'Skipped',
  failed: 'Failed',
};

function CustomNode({ id, data, selected }: any) {
  const { updateNodeData } = useReactFlow();

  const handleColorChange = (newColor: string) => {
    updateNodeData(id, { color: newColor });
  };

  const nodeColor = normalizeNodeColor(data.color);

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
          {NODE_COLORS.map((option) => (
            <Tooltip key={option.id} content={option.label} placement="top">
              <button
                type="button"
                onClick={() => handleColorChange(option.id)}
                className={`color-button ${option.id === nodeColor ? 'selected' : ''}`}
                style={{ backgroundColor: nodeColorVar(option.id) }}
                aria-label={`Node colour: ${option.label}`}
                aria-pressed={option.id === nodeColor}
              />
            </Tooltip>
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
        style={{ background: nodeColorVar(nodeColor) }}
        data-testid="workflow-node"
        data-state={state}
        title={
          status?.message ||
          (state === 'retrying' && status?.attempt && status.maxAttempts
            ? `Retrying: attempt ${status.attempt}/${status.maxAttempts} failed`
            : undefined) ||
          invalidReason ||
          undefined
        }
      >
        <Handle type="target" position={Position.Top} />

        {state !== 'idle' && state !== 'pending' && (
          <div
            className={`node-status-badge node-status-${state}`}
            role="img"
            aria-label={STATUS_NAME[state]}
          >
            <Icon name={STATUS_ICON[state]} size={12} />
          </div>
        )}

        {(data.mock === true || data.mock === 'true') && (
          <Badge
            tone="warning"
            variant="dashed"
            className="node-mock-badge"
            data-testid="node-mock-badge"
            title="Mocked: the tool does not run, placeholder outputs are created"
          >
            MOCK
          </Badge>
        )}

        <div className="node-label">{data.label || 'New Node'}</div>
        <div className="node-tool">{data.tool || 'No tool'}</div>

        {status?.mocked && state === 'succeeded' && (
          <Badge
            tone="warning"
            variant="dashed"
            className="node-mocked-run"
            data-testid="node-mocked-run"
          >
            MOCKED
          </Badge>
        )}

        {showCount && (
          <div className="node-progress">
            {status!.finished}/{status!.total}
          </div>
        )}

        {invalidReason && (
          <div
            className="node-invalid-badge"
            title={invalidReason}
            role="img"
            aria-label={invalidReason}
          >
            <Icon name="alert" size={12} />
          </div>
        )}

        <Handle type="source" position={Position.Bottom} />
      </div>
    </>
  );
}

/**
 * An edge coloured by its file-type check: green and solid with a check mark
 * when an output type of the source is an input type of the target, orange and
 * dashed with a "types differ" label when not, neutral when either end is not a
 * catalog tool. Dash and label carry the verdict without colour. The editor
 * injects the check under `__typeCheck` (like `__status` on nodes), so it never
 * reaches a saved workflow. The title
 * is the tooltip. The check only informs; it never blocks a connection.
 */
function TypedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  interactionWidth,
  data,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const check = (data as { __typeCheck?: TypeCheck } | undefined)?.__typeCheck;
  const status = check?.status ?? 'unknown';
  const mismatchWidth = edgeLabelWidth(MISMATCH_LABEL, 12);

  return (
    <g
      className={`typed-edge typed-edge-${status}`}
      data-testid="typed-edge"
      data-type-match={status}
    >
      {check && <title>{check.message}</title>}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={interactionWidth}
      />
      {/* The verdict is also written on the edge: a dashed line and a label, so
          it never depends on telling green from orange. */}
      {status === 'mismatch' && (
        <g
          className="typed-edge-label typed-edge-label-mismatch"
          data-testid="typed-edge-label"
          transform={`translate(${labelX}, ${labelY})`}
        >
          <rect
            x={-mismatchWidth / 2}
            y={-11}
            width={mismatchWidth}
            height={22}
            rx={11}
          />
          {/* The warning mark is drawn, not typed: emoji and symbol glyphs
              render differently on every OS. */}
          <g
            className="edge-label-icon"
            transform={`translate(${-mismatchWidth / 2 + 8}, -6) scale(0.75)`}
          >
            <path d="M8 2.5L14 13H2L8 2.5z" />
            <path d="M8 6.5v3M8 11.3v.2" />
          </g>
          <text x={8} textAnchor="middle" dominantBaseline="central">
            {MISMATCH_LABEL}
          </text>
        </g>
      )}
      {status === 'match' && (
        <g
          className="typed-edge-label typed-edge-label-match"
          data-testid="typed-edge-label"
          transform={`translate(${labelX}, ${labelY})`}
        >
          <circle r={9} />
          <text textAnchor="middle" dominantBaseline="central">
            ✓
          </text>
        </g>
      )}
    </g>
  );
}

const nodeTypes = { custom: CustomNode };
const edgeTypes = { typed: TypedEdge };
const defaultEdgeOptions = { animated: true, type: 'typed' };

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
      edgeTypes={edgeTypes}
      fitView
      // A lone first node would otherwise be fitted at React Flow's 2x maximum
      // zoom, which makes it huge and throws off where later nodes land.
      fitViewOptions={{ maxZoom: 1 }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={30}
        color="var(--canvas-dot)"
      />
      <Controls />
      <MiniMap nodeStrokeWidth={1} nodeColor={(node: any) => nodeColorVar(node.data?.color)} />
    </ReactFlow>
  );
}
