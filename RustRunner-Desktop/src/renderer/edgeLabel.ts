/**
 * Sizing for the label drawn on a typed edge. SVG text does not size its own
 * background, so the pill is measured from the character count: generous
 * rather than exact, because a clipped label ("types differ" with its last
 * letter cut off) is worse than a pill that is a little roomy.
 */

export const MISMATCH_LABEL = 'types differ';

/** Width in px of the pill for `text` at the 12px label size. */
export function edgeLabelWidth(text: string, iconWidth = 0): number {
  const PX_PER_CHAR = 7;
  const PADDING = 20;
  const ICON_GAP = iconWidth > 0 ? 6 : 0;
  return Math.ceil(text.length * PX_PER_CHAR + PADDING + iconWidth + ICON_GAP);
}
