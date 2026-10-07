/**
 * A small drawing of a template's pipeline: one box per step, coloured like
 * the step is on the canvas, with the connections as curves. It is a picture
 * only; `dagDescription` gives the same information as a sentence.
 */

import { nodeColorVar } from '../nodeColors';
import { dagDescription, dagOf } from '../templates/gallery';
import type { WorkflowTemplate } from '../templates/schema';

export function TemplateDag({
  template,
  className,
}: {
  template: Pick<WorkflowTemplate, 'steps' | 'edges'>;
  className?: string;
}) {
  const dag = dagOf(template);
  return (
    <svg
      className={className ? `template-dag ${className}` : 'template-dag'}
      viewBox={`0 0 ${dag.width} ${dag.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={dagDescription(template)}
      data-testid="template-dag"
    >
      {dag.edges.map((edge) => (
        <path key={`${edge.from}-${edge.to}`} className="template-dag-edge" d={edge.path} />
      ))}
      {dag.nodes.map((node) => (
        <rect
          key={node.key}
          className="template-dag-node"
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx={12}
          style={{ fill: nodeColorVar(node.color) }}
        />
      ))}
    </svg>
  );
}
