import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import MiscPanel from '@/components/settings/MiscPanel';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {} }),
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => null,
    getViewSettings: () => ({ userStylesheet: '', userUIStylesheet: '' }),
    setViewSettings: vi.fn(),
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {},
    setSettings: vi.fn(),
    saveSettings: vi.fn(),
  }),
}));

vi.mock('@/helpers/settings', () => ({ saveViewSettings: vi.fn() }));

vi.mock('@/hooks/useResetSettings', () => ({
  useResetViewSettings: () => vi.fn(),
}));

vi.mock('@/utils/css', () => ({
  validateCSS: () => ({ isValid: true }),
  formatCSS: (s: string) => s,
}));

afterEach(() => cleanup());

describe('MiscPanel unsaved draft reporting', () => {
  it('reports dirty once a CSS draft is edited and unregisters on unmount', () => {
    const onRegisterUnsavedCheck = vi.fn();
    render(
      <MiscPanel
        bookKey='book-1'
        onRegisterReset={() => {}}
        onRegisterUnsavedCheck={onRegisterUnsavedCheck}
      />,
    );

    const latestChecker = () =>
      onRegisterUnsavedCheck.mock.calls[onRegisterUnsavedCheck.mock.calls.length - 1][0] as
        | (() => boolean)
        | null;
    expect(latestChecker()).toBe(false);

    // The first textarea is the book (content) stylesheet draft.
    const textarea = screen.getAllByRole('textbox')[0] as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'body { color: red }' } });
    expect(latestChecker()).toBe(true);

    cleanup();
    expect(latestChecker()).toBeNull();
  });
});
