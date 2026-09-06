import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * Regression test: opening the Font settings panel must not silently clear the
 * user's Ctrl+wheel zoom anchor (effectiveFontSize). The panel's
 * defaultFontSize effect only reacts when the user actually edits the default,
 * not on mount with an unchanged value.
 */

const currentViewSettings = {
  defaultFont: 'Serif',
  defaultCJKFont: 'LXGW WenKai',
  defaultFontSize: 18,
  minimumFontSize: 8,
  overrideFont: false,
  serifFont: 'Bitter',
  sansSerifFont: 'Roboto',
  monospaceFont: 'Fira Code',
  fontWeight: 400,
  effectiveFontSize: 120,
};

const mockGetViewSettings = vi.fn(() => currentViewSettings);
const mockGetView = vi.fn(() => null);
const mockSetFontPanelView = vi.fn();
const mockOnRegisterReset = vi.fn();

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: null }),
}));

vi.mock('@/helpers/settings', () => ({
  saveViewSettings: vi.fn(),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getViewSettings: mockGetViewSettings,
    getView: mockGetView,
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {},
    fontPanelView: 'main-fonts',
    setFontPanelView: mockSetFontPanelView,
  }),
}));

vi.mock('@/store/customFontStore', () => ({
  useCustomFontStore: () => ({
    fonts: {},
    getFontFamilies: () => [],
  }),
}));

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
}));

vi.mock('@/utils/bridge', () => ({
  getSysFontsList: vi.fn(async () => ({ error: null, fonts: {} })),
}));

vi.mock('@/hooks/useResetSettings', () => ({
  useResetViewSettings: () => vi.fn(),
}));

vi.mock('@/hooks/useKeyDownActions', () => ({
  useKeyDownActions: vi.fn(),
}));

vi.mock('@/components/settings/CustomFonts', () => ({
  default: () => null,
}));

import FontPanel from '@/components/settings/FontPanel';
import { saveViewSettings } from '@/helpers/settings';

const renderPanel = () =>
  render(<FontPanel bookKey='book-1' onRegisterReset={mockOnRegisterReset} />);

const increaseDefaultFontSize = () => {
  const row = screen.getByText('Default Font Size').closest('[data-setting-id]') as HTMLElement;
  fireEvent.click(row.querySelector("button[aria-label='Increase']") as HTMLButtonElement);
};

beforeEach(() => {
  vi.clearAllMocks();
  currentViewSettings.defaultFontSize = 18;
  currentViewSettings.effectiveFontSize = 120;
});

afterEach(() => {
  cleanup();
});

describe('FontPanel zoom anchor preservation', () => {
  it('does not clear effectiveFontSize when the panel mounts', () => {
    renderPanel();

    expect(saveViewSettings).not.toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'effectiveFontSize',
      undefined,
    );
  });

  it('does not save anything for defaultFontSize when the value is unchanged', () => {
    renderPanel();

    expect(saveViewSettings).not.toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'defaultFontSize',
      18,
    );
  });

  it('clears the zoom anchor only when the user edits the default font size', () => {
    renderPanel();

    increaseDefaultFontSize();

    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'defaultFontSize',
      19,
    );
    expect(saveViewSettings).toHaveBeenCalledTimes(2);
    expect(saveViewSettings).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'book-1',
      'effectiveFontSize',
      undefined,
    );
  });
});
