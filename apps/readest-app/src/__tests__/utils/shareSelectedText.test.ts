import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const writeClipboardMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/utils/clipboard', () => ({
  writeTextToClipboard: (...args: unknown[]) => writeClipboardMock(...args),
}));

import { canShareText, shareSelectedText } from '@/utils/share';

describe('shareSelectedText', () => {
  beforeEach(() => {
    writeClipboardMock.mockClear().mockResolvedValue(undefined);
    // @ts-expect-error - reset between tests
    delete globalThis.navigator.share;
  });

  afterEach(() => {
    // @ts-expect-error - cleanup
    delete globalThis.navigator.share;
  });

  test('no-op on empty text', async () => {
    await shareSelectedText('');
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  test('uses navigator.share when available', async () => {
    const navShare = vi.fn().mockResolvedValue(undefined);
    globalThis.navigator.share = navShare;

    await shareSelectedText('hello');

    expect(navShare).toHaveBeenCalledWith({ text: 'hello' });
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  test('swallows an AbortError (user dismissed) without clipboard fallback', async () => {
    const abortErr = new Error('user dismissed');
    abortErr.name = 'AbortError';
    const navShare = vi.fn().mockRejectedValue(abortErr);
    globalThis.navigator.share = navShare;

    await expect(shareSelectedText('hello')).resolves.toBeUndefined();
    expect(writeClipboardMock).not.toHaveBeenCalled();
  });

  test('falls back to clipboard when navigator.share fails for a non-Abort reason', async () => {
    const notAllowed = new Error('permission denied');
    notAllowed.name = 'NotAllowedError';
    const navShare = vi.fn().mockRejectedValue(notAllowed);
    globalThis.navigator.share = navShare;

    await shareSelectedText('hello');

    expect(writeClipboardMock).toHaveBeenCalledWith('hello');
  });

  test('falls back to clipboard when no share method exists', async () => {
    await shareSelectedText('hello');
    expect(writeClipboardMock).toHaveBeenCalledWith('hello');
  });
});

describe('canShareText', () => {
  beforeEach(() => {
    // @ts-expect-error - reset between tests
    delete globalThis.navigator.share;
  });

  afterEach(() => {
    // @ts-expect-error - cleanup
    delete globalThis.navigator.share;
  });

  test('true when the Web Share API is present', () => {
    globalThis.navigator.share = vi.fn().mockResolvedValue(undefined);
    expect(canShareText()).toBe(true);
  });

  test('false without the Web Share API', () => {
    expect(canShareText()).toBe(false);
  });
});
