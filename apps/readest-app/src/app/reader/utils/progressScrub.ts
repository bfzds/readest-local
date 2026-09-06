/**
 * Pure geometry/mapping helpers for the footer progress-strip scrub gesture.
 * Kept side-effect free so the drag math is unit-testable without a view.
 */

/** Map a pointer x within the strip's bounding rect to a 0..1 fraction. */
export const xToFraction = (x: number, rectLeft: number, rectWidth: number): number => {
  if (rectWidth <= 0) return 0;
  const fraction = (x - rectLeft) / rectWidth;
  return Math.min(1, Math.max(0, fraction));
};

/**
 * 0-based page index rendered at a fraction of a total-page document, matching
 * what `goToFraction` will land on and what `formatProgress(current, total)`
 * would then display. fraction 0 → index 0, fraction 1 → index total-1.
 */
export const fractionToPageIndex = (fraction: number, total: number): number => {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, Math.round(fraction * total) - 1));
};

/**
 * Small leading+trailing throttle for the scrub jump: the first call fires
 * immediately so the view follows the pointer without initial lag, moves are
 * coalesced at `intervalMs`, and the last position is always flushed.
 */
export const createScrubThrottle = (fn: (fraction: number) => void, intervalMs = 150) => {
  let lastCall = 0;
  let pending: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  const flush = () => {
    timer = null;
    if (pending === null) return;
    const value = pending;
    pending = null;
    lastCall = Date.now();
    fn(value);
  };
  return {
    call(value: number) {
      pending = value;
      if (timer) return;
      // The very first call of a gesture fires immediately so the view starts
      // following the pointer without initial lag.
      const elapsed = Date.now() - lastCall;
      if (!fired || elapsed >= intervalMs) {
        fired = true;
        flush();
      } else {
        timer = setTimeout(flush, intervalMs - elapsed);
      }
    },
    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
};
