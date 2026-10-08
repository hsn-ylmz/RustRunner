/** A key cap: one shortcut key (or a +-joined combination) drawn as keys. */

import { cx } from './cx';

export function Kbd({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cx('kbd-group', className)}>
      {keys.split('+').map((key, i) => (
        <kbd key={`${key}-${i}`} className="kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}
