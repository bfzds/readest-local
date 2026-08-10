import { writeTextToClipboard } from '@/utils/clipboard';

/** Whether the Web Share API is available on this platform. */
export const canShareText = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/**
 * Share selected text through the Web Share API, falling back to the
 * clipboard. A user dismissal (AbortError) is respected and does not copy.
 */
export const shareSelectedText = async (text: string): Promise<void> => {
  if (!text) return;

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }

  await writeTextToClipboard(text);
};
