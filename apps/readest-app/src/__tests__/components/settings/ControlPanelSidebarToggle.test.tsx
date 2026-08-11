import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobileApp: false } }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

const stubView = {
  renderer: {
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    hasAttribute: () => false,
    setStyles: vi.fn(),
  },
};

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => stubView,
    getViews: () => [],
    getViewSettings: () => ({
      scrolled: false,
      noContinuousScroll: false,
      showSideBar: false,
      showGoToLibraryButton: false,
      showAnnotationQuickActionButton: false,
    }),
    recreateViewer: vi.fn(),
  }),
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ isFixedLayout: false, book: { format: 'EPUB' } }),
  }),
}));

const sidebarActions = {
  isSideBarVisible: false,
  setSideBarVisible: vi.fn(),
};

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => sidebarActions,
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: { globalViewSettings: {} } }),
}));

vi.mock('@/hooks/useResetSettings', () => ({
  useResetViewSettings: () => vi.fn(),
}));

vi.mock('@/hooks/useEinkMode', () => ({
  useEinkMode: () => ({ applyEinkMode: vi.fn() }),
}));

const saveViewSettings = vi.fn();
vi.mock('@/helpers/settings', () => ({
  saveViewSettings: (...args: unknown[]) => saveViewSettings(...args),
  saveSysSettings: vi.fn(),
}));

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
}));

vi.mock('@/utils/share', () => ({
  canShareText: () => true,
}));

vi.mock('@/utils/telemetry', () => ({
  optInTelemetry: vi.fn(),
  optOutTelemetry: vi.fn(),
}));

vi.mock('@/components/settings/PageTurnerSettings', () => ({
  default: () => null,
}));

vi.mock('@/utils/style', () => ({ getStyles: () => '' }));
vi.mock('@/utils/config', () => ({ getMaxInlineSize: () => 720 }));

const applyPageTurnAttributes = vi.fn();
vi.mock('@/app/reader/hooks/useCapturedTurn', () => ({
  applyPageTurnAttributes: (...args: unknown[]) => applyPageTurnAttributes(...args),
}));

import ControlPanel from '@/components/settings/ControlPanel';

const sidebarSwitch = () =>
  screen.getByText('Sidebar').closest('label')?.querySelector('input') ??
  (screen.getByText('Sidebar').closest('div')?.querySelector('input') as HTMLInputElement);

const goToLibrarySwitch = () =>
  screen.getByText('Go to Library').closest('label')?.querySelector('input') ??
  (screen.getByText('Go to Library').closest('div')?.querySelector('input') as HTMLInputElement);

const quickActionSwitch = () =>
  screen.getByText('Enable Quick Action on Selection').closest('label')?.querySelector('input') ??
  (screen
    .getByText('Enable Quick Action on Selection')
    .closest('div')
    ?.querySelector('input') as HTMLInputElement);

afterEach(() => {
  cleanup();
  saveViewSettings.mockClear();
  applyPageTurnAttributes.mockClear();
  sidebarActions.setSideBarVisible.mockClear();
});

describe('Settings > Behavior > Sidebar', () => {
  it('renders the Sidebar switch off by default', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    expect(sidebarSwitch()?.checked).toBe(false);
  });

  it('saves showSideBar when toggled on', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    fireEvent.click(sidebarSwitch() as HTMLInputElement);
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'test',
      'showSideBar',
      true,
      false,
      false,
    );
  });

  it('shows the sidebar immediately when switched on', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    fireEvent.click(sidebarSwitch() as HTMLInputElement);
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(true);
  });

  it('hides the sidebar immediately when switched off', () => {
    sidebarActions.isSideBarVisible = true;
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    expect(sidebarSwitch()?.checked).toBe(true);
    fireEvent.click(sidebarSwitch() as HTMLInputElement);
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(false);
  });
});

describe('Settings > Reading Interface > toolbar button visibility', () => {
  it('renders the Go to Library switch off by default', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    expect(goToLibrarySwitch()?.checked).toBe(false);
  });

  it('saves showGoToLibraryButton when toggled on', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    fireEvent.click(goToLibrarySwitch() as HTMLInputElement);
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'test',
      'showGoToLibraryButton',
      true,
      false,
      false,
    );
  });

  it('renders the Enable Quick Action on Selection switch off by default', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    expect(quickActionSwitch()?.checked).toBe(false);
  });

  it('saves showAnnotationQuickActionButton when toggled on', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    fireEvent.click(quickActionSwitch() as HTMLInputElement);
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'test',
      'showAnnotationQuickActionButton',
      true,
      false,
      false,
    );
  });
});
