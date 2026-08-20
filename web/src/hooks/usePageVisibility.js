/**
 * Whether this tab is on screen.
 *
 * Polling a hidden tab is work nobody is looking at, paid for in requests, and
 * browsers throttle the timers behind it anyway - so a backgrounded dashboard
 * ends up polling erratically rather than usefully. Plan section 6: hidden tabs
 * poll not at all, and on return they poll immediately at the base interval.
 */

import { useEffect, useState } from 'react';

/**
 * @returns {boolean} true when the document is visible
 */
export function usePageVisibility() {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    // Read once on mount as well: the tab may already have been hidden when this
    // component mounted, and no event fires for a state that did not change.
    onChange();

    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}
