import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NODE_COLOR,
  LEGACY_NODE_COLOR_HEX,
  NODE_COLORS,
  isNodeColorId,
  nodeColorLabel,
  nodeColorVar,
  normalizeNodeColor,
} from '../nodeColors';
import { loadThemes } from './tokenModel';
import { edgeLabelWidth, MISMATCH_LABEL, mismatchLabel } from '../edgeLabel';

describe('node colours', () => {
  it('has a token for every colour a person can pick', () => {
    const { light, dark } = loadThemes();
    for (const { id } of NODE_COLORS) {
      expect(light, id).toHaveProperty([`--node-${id}`]);
      expect(dark, id).toHaveProperty([`--node-${id}`]);
    }
  });

  it('has no duplicate or unnamed colours', () => {
    expect(new Set(NODE_COLORS.map((c) => c.id)).size).toBe(NODE_COLORS.length);
    for (const c of NODE_COLORS) expect(c.label.length).toBeGreaterThan(0);
  });

  it('defaults to a colour that exists', () => {
    expect(isNodeColorId(DEFAULT_NODE_COLOR)).toBe(true);
  });

  it('keeps a colour name as it is', () => {
    expect(normalizeNodeColor('rose')).toBe('rose');
  });

  it('maps every hex value that older workflow files stored', () => {
    expect(LEGACY_NODE_COLOR_HEX).toHaveLength(10);
    for (const hex of LEGACY_NODE_COLOR_HEX) {
      expect(isNodeColorId(normalizeNodeColor(hex)), hex).toBe(true);
    }
    expect(normalizeNodeColor('#88C5F7')).toBe('sky');
    expect(normalizeNodeColor(' #a8e6cf ')).toBe('mint');
    expect(normalizeNodeColor('#ef4444')).toBe('rose');
  });

  it('falls back to the default for missing or unknown values', () => {
    for (const v of [undefined, null, '', '#123456', 42, 'chartreuse']) {
      expect(normalizeNodeColor(v)).toBe(DEFAULT_NODE_COLOR);
    }
  });

  it('paints with the token, so the theme reaches the node', () => {
    expect(nodeColorVar('lilac')).toBe('var(--node-lilac)');
    expect(nodeColorVar('#d4a5f7')).toBe('var(--node-lilac)');
    expect(nodeColorLabel('#d4a5f7')).toBe('Lilac');
  });
});

describe('edge label width', () => {
  it('grows with the text so the label is never clipped', () => {
    expect(edgeLabelWidth('types differ')).toBeGreaterThan(edgeLabelWidth('differ'));
  });

  it('leaves room for the icon and the padding', () => {
    expect(edgeLabelWidth(MISMATCH_LABEL, 12)).toBeGreaterThan(
      edgeLabelWidth(MISMATCH_LABEL) + 12
    );
  });

  it('is wide enough for 12px text (about 6.5px per character)', () => {
    expect(edgeLabelWidth(MISMATCH_LABEL, 12)).toBeGreaterThanOrEqual(MISMATCH_LABEL.length * 6.5 + 12);
  });
});

describe('mismatchLabel', () => {
  it('says what the next step needs and what it gets', () => {
    expect(mismatchLabel({ made: ['fastq'], expected: ['sam', 'bam'] })).toBe('needs sam/bam, gets fastq');
  });

  it('shortens long type lists', () => {
    expect(mismatchLabel({ made: ['a', 'b', 'c'], expected: ['x'] })).toBe('needs x, gets a/b…');
  });

  it('falls back to the generic label without types', () => {
    expect(mismatchLabel({})).toBe(MISMATCH_LABEL);
    expect(mismatchLabel({ made: [], expected: ['x'] })).toBe(MISMATCH_LABEL);
  });
});
