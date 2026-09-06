import { useCallback, useEffect, useRef } from 'react';

export type DragKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export const useDrag = (
  onDragMove: (data: { clientX: number; clientY: number; deltaX: number; deltaY: number }) => void,
  onDragKeyDown: (data: { key: DragKey; step: number }) => void,
  onDragEnd?: (data: {
    velocity: number;
    deltaT: number;
    clientX: number;
    clientY: number;
    deltaX: number;
    deltaY: number;
  }) => void,
  cursor: string = 'col-resize',
) => {
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const lastX = useRef(0);
  const lastY = useRef(0);
  const startTime = useRef(0);
  // Per-drag teardown handles so an unmount mid-drag can still remove the
  // listeners, the shield, and the global styles (otherwise the page is left
  // with a stuck overlay and userSelect/cursor).
  const shieldRef = useRef<HTMLDivElement | null>(null);
  const removeListenersRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      removeListenersRef.current?.();
      shieldRef.current?.remove();
      document.body.style.userSelect = '';
      document.documentElement.style.cursor = '';
    },
    [],
  );

  const handleDragStart = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      isDragging.current = true;

      if ('touches' in e) {
        startY.current = e.touches[0]!.clientY;
        startX.current = e.touches[0]!.clientX;
      } else {
        startY.current = e.clientY;
        startX.current = e.clientX;
      }
      // Deltas are relative to the LAST position; seed it with this drag's
      // start so the first move isn't measured against a stale previous drag.
      lastX.current = startX.current;
      lastY.current = startY.current;
      startTime.current = performance.now();

      document.body.style.userSelect = 'none';
      document.documentElement.style.cursor = cursor;

      // Cover the viewport with a transparent, top-most shield for the duration
      // of the drag. Book content is rendered in iframes, and fixed-layout/PDF
      // pages set inline `pointer-events: auto` on their iframe (foliate-js
      // fixed-layout.js) which defeats a plain `body { pointer-events: none }`.
      // Without the shield a `mouseup` released over a PDF page is delivered
      // into the iframe's own document and never reaches these window
      // listeners, so the drag never ends and the panel "sticks" to the cursor
      // (readest#5043). The shield sits above every iframe, so all pointer
      // events land on it and bubble to window, ending the drag reliably.
      const shield = document.createElement('div');
      shield.className = 'drag-shield';
      Object.assign(shield.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        zIndex: '2147483647',
        cursor,
        pointerEvents: 'auto',
      });
      document.body.appendChild(shield);
      shieldRef.current = shield;

      const handleMove = (event: MouseEvent | TouchEvent) => {
        if (isDragging.current) {
          let deltaX = 0;
          let deltaY = 0;
          let clientX = 0;
          let clientY = 0;

          if ('touches' in event && event.touches.length > 0) {
            const currentTouch = event.touches[0]!;
            clientX = currentTouch.clientX;
            clientY = currentTouch.clientY;
          } else {
            const evt = event as MouseEvent;
            clientX = evt.clientX;
            clientY = evt.clientY;
          }
          deltaX = clientX - lastX.current;
          deltaY = clientY - lastY.current;
          lastX.current = clientX;
          lastY.current = clientY;

          onDragMove({ clientX, clientY, deltaX, deltaY });
        }
      };

      const handleEnd = (event: MouseEvent | TouchEvent) => {
        isDragging.current = false;

        shield.remove();
        shieldRef.current = null;
        removeListenersRef.current = null;
        document.body.style.userSelect = '';
        document.documentElement.style.cursor = '';

        let deltaX = 0;
        let deltaY = 0;
        let clientX = 0;
        let clientY = 0;
        const endTime = performance.now();
        const deltaT = endTime - startTime.current;

        if ('touches' in event) {
          const currentTouch = event.changedTouches[0]!;
          clientX = currentTouch.clientX;
          clientY = currentTouch.clientY;
        } else {
          const evt = event as MouseEvent;
          clientX = evt.clientX;
          clientY = evt.clientY;
        }
        deltaX = clientX - startX.current;
        deltaY = clientY - startY.current;
        const velocity = deltaY / deltaT;

        if (onDragEnd) {
          onDragEnd({ velocity, deltaT, clientX, clientY, deltaX, deltaY });
        }

        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };

      const removeListeners = () => {
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleEnd);
        window.removeEventListener('touchmove', handleMove);
        window.removeEventListener('touchend', handleEnd);
      };
      removeListenersRef.current = removeListeners;

      window.addEventListener('mousemove', handleMove, { passive: true });
      window.addEventListener('mouseup', handleEnd);
      window.addEventListener('touchmove', handleMove, { passive: true });
      window.addEventListener('touchend', handleEnd);
    },
    [onDragMove, onDragEnd, cursor],
  );

  const handleDragKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = 0.02;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight':
          onDragKeyDown({ key: e.key, step });
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    [onDragKeyDown],
  );

  return { handleDragStart, handleDragKeyDown };
};
