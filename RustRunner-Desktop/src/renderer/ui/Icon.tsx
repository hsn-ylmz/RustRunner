/**
 * One inline-SVG icon set. Replaces text glyphs and emoji, which render
 * differently on every OS. Icons are decorative: the text next to them (or the
 * aria-label of the button holding them) carries the meaning.
 */

import type { ReactNode } from 'react';
import { cx } from './cx';

export type IconName =
  | 'check'
  | 'x'
  | 'alert'
  | 'info'
  | 'retry'
  | 'skip'
  | 'dot'
  | 'circle'
  | 'plus'
  | 'trash'
  | 'folder'
  | 'file'
  | 'spinner'
  | 'chevron-down'
  | 'play'
  | 'pause'
  | 'stop';

/** 16x16 drawings, stroked with the current text colour. */
const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M3.5 8.5l3 3 6-7" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  alert: (
    <>
      <path d="M8 2.5L14 13H2L8 2.5z" />
      <path d="M8 6.5v3M8 11.3v.2" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v4M8 5v.2" />
    </>
  ),
  retry: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.8v3h-3" />,
  skip: (
    <>
      <path d="M3.5 3.5l6 4.5-6 4.5z" />
      <path d="M12 3.5v9" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3.5" fill="currentColor" />,
  circle: <circle cx="8" cy="8" r="4.5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />,
  folder: (
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z" />
  ),
  file: (
    <>
      <path d="M4 2h5l3 3v9H4V2z" />
      <path d="M9 2v3h3" />
    </>
  ),
  spinner: <path d="M8 2a6 6 0 1 0 6 6" />,
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  play: <path d="M5 3.5v9l7.5-4.5z" />,
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  stop: <path d="M4.5 4.5h7v7h-7z" />,
};

export function Icon({
  name,
  size = 16,
  spin = false,
  className,
}: {
  name: IconName;
  size?: number;
  spin?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={cx('icon', spin && 'icon-spin', className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
