/**
 * Connections edited from the properties panel instead of by dragging between
 * handles. Dragging needs a pointer; the "Runs after" list gives the keyboard
 * (and anyone who finds the 12px handles fiddly) the same power. A connection
 * is a canvas edge from the earlier step (source) to the later one (target),
 * exactly what a drag creates.
 */

export interface GraphNode {
  id: string;
  data?: { label?: string };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  [key: string]: unknown;
}

/** One candidate in a step's "Runs after" list. */
export interface UpstreamChoice {
  nodeId: string;
  label: string;
  /** A connection from this step into the selected one exists. */
  connected: boolean;
  /**
   * Connecting would close a loop: the candidate already runs after the
   * selected step (directly or through others). Never true when connected.
   */
  wouldLoop: boolean;
}

/** Ids of every step that runs after `nodeId`, directly or indirectly. */
export function downstreamOf(edges: ReadonlyArray<GraphEdge>, nodeId: string): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.source);
    if (list) list.push(e.target);
    else next.set(e.source, [e.target]);
  }
  const seen = new Set<string>();
  const stack = [...(next.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return seen;
}

/**
 * The steps the selected one could run after, in canvas order, with whether
 * each is connected and whether connecting it would make a loop.
 */
export function upstreamChoices(
  nodes: ReadonlyArray<GraphNode>,
  edges: ReadonlyArray<GraphEdge>,
  nodeId: string
): UpstreamChoice[] {
  const after = downstreamOf(edges, nodeId);
  const incoming = new Set(edges.filter((e) => e.target === nodeId).map((e) => e.source));
  return nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => {
      const connected = incoming.has(n.id);
      return {
        nodeId: n.id,
        label: n.data?.label?.trim() || 'Unnamed step',
        connected,
        wouldLoop: !connected && after.has(n.id),
      };
    });
}

/** The id React Flow gives an edge made by dragging between the default handles. */
export function edgeIdFor(source: string, target: string): string {
  return `xy-edge__${source}-${target}`;
}

/**
 * Adds or removes the connection `source` -> `target`. Adding is refused (the
 * edges come back unchanged) when it exists already, joins a step to itself,
 * or would close a loop. `defaults` are the canvas's edge options (type,
 * animation), which React Flow only applies to edges made by dragging.
 */
export function setConnection<E extends GraphEdge>(
  edges: ReadonlyArray<E>,
  source: string,
  target: string,
  connected: boolean,
  defaults: Partial<E> = {}
): E[] {
  if (!connected) {
    return edges.filter((e) => !(e.source === source && e.target === target));
  }
  const exists = edges.some((e) => e.source === source && e.target === target);
  // source -> target closes a loop when target already leads to source.
  if (exists || source === target || downstreamOf(edges, target).has(source)) {
    return [...edges];
  }
  return [...edges, { ...defaults, id: edgeIdFor(source, target), source, target } as E];
}
