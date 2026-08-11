import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

let mockGlobalShowSideBar = false;

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {} }),
}));

vi.mock('@/helpers/settings', () => ({
  saveSysSettings: vi.fn(),
}));

const sidebarActions = {
  sideBarWidth: '300px',
  isSideBarVisible: false,
  isSideBarPinned: false,
  getSideBarWidth: () => '300px',
  setSideBarWidth: vi.fn(),
  setSideBarPin: vi.fn(),
  setSideBarVisible: vi.fn(),
  toggleSideBar: vi.fn(),
  toggleSideBarPin: vi.fn(),
};

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      globalViewSettings: { showSideBar: mockGlobalShowSideBar },
      globalReadSettings: {},
    },
  }),
}));

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => sidebarActions,
}));

import useSidebar from '@/app/reader/hooks/useSidebar';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useSidebar default visibility', () => {
  it('keeps the sidebar hidden when the toggle is off even when pinned', () => {
    mockGlobalShowSideBar = false;
    renderHook(() => useSidebar('300px', true));
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(false);
  });

  it('shows the pinned sidebar when the toggle is on', () => {
    mockGlobalShowSideBar = true;
    renderHook(() => useSidebar('300px', true));
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(true);
  });

  it('keeps a non-pinned sidebar hidden when the toggle is on', () => {
    mockGlobalShowSideBar = true;
    renderHook(() => useSidebar('300px', false));
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(false);
  });
});
