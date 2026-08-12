import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { AppService } from '@/types/system';

// The native-bridge Android file picker (#1217) delivered results as a plugin
// event so they survive the WebView/process being torn down while the system
// picker is foregrounded. The app no longer targets Android, so the hook never
// registers the listener.

type PluginEventHandler = (payload: { uris: string[] }) => void | Promise<void>;

const listeners: { plugin: string; event: string; handler: PluginEventHandler }[] = [];
const unregisterMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  addPluginListener: async (plugin: string, event: string, handler: PluginEventHandler) => {
    listeners.push({ plugin, event, handler });
    return { unregister: unregisterMock };
  },
  invoke: vi.fn(),
}));

import { useAndroidPickedBooks } from '@/hooks/useAndroidFilePicker';

const makeAppService = (): AppService => ({}) as unknown as AppService;

beforeEach(() => {
  listeners.length = 0;
  unregisterMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('useAndroidPickedBooks', () => {
  test('is a no-op on desktop (never registers a native-bridge listener)', () => {
    const onPickedBooks = vi.fn();
    renderHook(() => useAndroidPickedBooks(makeAppService(), onPickedBooks));
    expect(listeners).toHaveLength(0);
    expect(onPickedBooks).not.toHaveBeenCalled();
  });
});
