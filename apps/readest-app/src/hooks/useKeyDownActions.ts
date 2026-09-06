import { RefObject, useEffect, useRef } from 'react';

interface UseKeyDownOptions {
  onCancel?: () => void;
  onConfirm?: () => void;
  enabled?: boolean;
  elementRef?: RefObject<HTMLElement | null>;
}

export const useKeyDownActions = ({
  onCancel,
  onConfirm,
  enabled = true,
  elementRef: providedRef,
}: UseKeyDownOptions) => {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const elementRef = providedRef || internalRef;
  // Keep the latest callbacks reachable from the (once-registered) listener so
  // rerenders don't leave a stale closure behind.
  const onCancelRef = useRef(onCancel);
  const onConfirmRef = useRef(onConfirm);
  onCancelRef.current = onCancel;
  onConfirmRef.current = onConfirm;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent | CustomEvent) => {
      if (event instanceof CustomEvent) {
        if (event.detail.keyName === 'Back') {
          onCancelRef.current?.();
          return true;
        }
      } else {
        if (event.key === 'Escape') {
          onCancelRef.current?.();
        } else if (event.key === 'Enter') {
          // When a button has focus the browser turns Enter into a click on
          // that button; calling onConfirm here as well would run it twice.
          if ((event.target as HTMLElement | null)?.tagName !== 'BUTTON') {
            onConfirmRef.current?.();
          }
        }
        event.stopPropagation();
      }
      return false;
    };

    // Capture the element so cleanup can detach from it even after the ref
    // has moved on; the previous code never removed this listener at all.
    const element = elementRef.current;
    window.addEventListener('keydown', handleKeyDown);
    element?.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      element?.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return internalRef;
};
