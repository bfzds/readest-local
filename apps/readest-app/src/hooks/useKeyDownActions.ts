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

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent | CustomEvent) => {
      if (event instanceof CustomEvent) {
        if (event.detail.keyName === 'Back') {
          onCancel?.();
          return true;
        }
      } else {
        if (event.key === 'Escape') {
          onCancel?.();
        } else if (event.key === 'Enter') {
          onConfirm?.();
        }
        event.stopPropagation();
      }
      return false;
    };

    window.addEventListener('keydown', handleKeyDown);

    if (elementRef.current) {
      elementRef.current.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return internalRef;
};
