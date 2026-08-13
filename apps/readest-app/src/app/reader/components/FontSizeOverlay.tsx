import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { eventDispatcher } from '@/utils/event';

// Keep the indicator on screen through a burst of wheel steps, then fade it
// out this long after the last adjustment.
const HIDE_DELAY_MS = 800;

/**
 * Transient centered indicator showing the current effective font size while
 * Ctrl+wheel zoom adjusts it (fired from useIframeEvents.adjustFontSize as
 * `font-size-changed`). Self-contained: it keeps itself visible through a burst
 * of steps and fades out shortly after the last one. pointer-events-none keeps
 * it from ever stealing input; bg-base-100/text-base-content make it inherit the
 * current theme (dark theme → light text, light theme → dark text).
 */
const FontSizeOverlay: React.FC = () => {
  const [size, setSize] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onFontSizeChanged = (event: CustomEvent) => {
      const next = event.detail?.size;
      if (typeof next !== 'number') return;
      setSize(next);
      setVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        setVisible(false);
        hideTimerRef.current = null;
      }, HIDE_DELAY_MS);
    };
    eventDispatcher.on('font-size-changed', onFontSizeChanged);
    return () => {
      eventDispatcher.off('font-size-changed', onFontSizeChanged);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <div
      aria-hidden
      className={clsx(
        'pointer-events-none fixed inset-0 z-40 flex items-center justify-center',
        'not-eink:transition-opacity not-eink:duration-150 motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        className={clsx(
          'eink-bordered flex items-baseline gap-1 rounded-2xl px-6 py-3 shadow-lg',
          'bg-base-100/90 text-base-content',
        )}
      >
        <span className='text-4xl font-semibold leading-none tabular-nums'>{size ?? ''}</span>
        <span className='text-sm opacity-70'>px</span>
      </div>
    </div>
  );
};

export default FontSizeOverlay;
