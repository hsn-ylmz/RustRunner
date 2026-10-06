import { describe, expect, it } from 'vitest';
import { downstreamOf, edgeIdFor, setConnection, upstreamChoices } from '../connections';

const node = (id: string, label?: string) => ({ id, data: { label } });
const edge = (source: string, target: string) => ({ id: edgeIdFor(source, target), source, target });

describe('downstreamOf', () => {
  it('follows connections transitively and ignores unrelated steps', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')];
    expect([...downstreamOf(edges, 'a')].sort()).toEqual(['b', 'c']);
    expect(downstreamOf(edges, 'c').size).toBe(0);
  });

  it('terminates on a graph that already has a loop', () => {
    const edges = [edge('a', 'b'), edge('b', 'a')];
    expect([...downstreamOf(edges, 'a')].sort()).toEqual(['a', 'b']);
  });
});

describe('upstreamChoices', () => {
  const nodes = [node('a', 'Trim'), node('b', 'Align'), node('c', 'Count'), node('d', '  ')];

  it('lists every other step in canvas order with its connection state', () => {
    const choices = upstreamChoices(nodes, [edge('a', 'b')], 'b');
    expect(choices.map((c) => c.nodeId)).toEqual(['a', 'c', 'd']);
    expect(choices.find((c) => c.nodeId === 'a')).toMatchObject({ label: 'Trim', connected: true, wouldLoop: false });
    expect(choices.find((c) => c.nodeId === 'd')?.label).toBe('Unnamed step');
  });

  it('marks steps that already run after the selected one as loops', () => {
    const choices = upstreamChoices(nodes, [edge('a', 'b'), edge('b', 'c')], 'a');
    expect(choices.find((c) => c.nodeId === 'b')?.wouldLoop).toBe(true);
    expect(choices.find((c) => c.nodeId === 'c')?.wouldLoop).toBe(true);
    expect(choices.find((c) => c.nodeId === 'd')?.wouldLoop).toBe(false);
  });
});

describe('setConnection', () => {
  it('adds an edge with the canvas defaults and the id a drag would give it', () => {
    const next = setConnection([], 'a', 'b', true, { type: 'typed', animated: true } as any);
    expect(next).toEqual([{ id: 'xy-edge__a-b', source: 'a', target: 'b', type: 'typed', animated: true }]);
  });

  it('removes only the named connection', () => {
    const next = setConnection([edge('a', 'b'), edge('a', 'c')], 'a', 'b', false);
    expect(next).toEqual([edge('a', 'c')]);
  });

  it('refuses duplicates, self connections and loops', () => {
    const edges = [edge('a', 'b'), edge('b', 'c')];
    expect(setConnection(edges, 'a', 'b', true)).toEqual(edges);
    expect(setConnection(edges, 'a', 'a', true)).toEqual(edges);
    expect(setConnection(edges, 'c', 'a', true)).toEqual(edges);
    expect(setConnection(edges, 'a', 'c', true)).toHaveLength(3);
  });

  it('does not mutate its input', () => {
    const edges = [edge('a', 'b')];
    setConnection(edges, 'b', 'c', true);
    setConnection(edges, 'a', 'b', false);
    expect(edges).toEqual([edge('a', 'b')]);
  });
});
