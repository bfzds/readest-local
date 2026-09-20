import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ImportFromFolderDialog from '@/app/library/components/ImportFromFolderDialog';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string | number>) => {
    if (!options) return key;
    return key.replace(/{{(\w+)}}/g, (_match, name) => String(options[name] ?? ''));
  },
}));

vi.mock('@/hooks/useKeyDownActions', () => ({
  useKeyDownActions: () => ({ current: null }),
}));

vi.mock('@/components/Dialog', () => ({
  __esModule: true,
  default: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title?: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role='dialog' aria-label={title}>
        {children}
      </div>
    ) : null,
}));

const REGISTERED = '/library/Books';

const setup = (overrides: Partial<React.ComponentProps<typeof ImportFromFolderDialog>> = {}) => {
  const props = {
    initialDirectory: REGISTERED,
    isRegisteredExternalRoot: (dir: string) => dir === REGISTERED,
    onPickDirectory: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  const utils = render(<ImportFromFolderDialog {...props} />);
  return { ...utils, props };
};

const getReadInPlaceCheckbox = (): HTMLInputElement =>
  screen.getByText('Read books in place').closest('label')!.querySelector('input')!;

afterEach(cleanup);

describe('Import-from-Folder dialog: read-in-place toggle (#5680)', () => {
  it('shows the toggle ON but editable for a registered external folder', () => {
    setup();

    const checkbox = getReadInPlaceCheckbox();
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
  });

  it('reports readInPlace: false when unchecked on a registered folder', () => {
    const { props } = setup({ initialAutoImport: true });

    fireEvent.click(getReadInPlaceCheckbox());
    expect(getReadInPlaceCheckbox().checked).toBe(false);

    fireEvent.click(screen.getByText('OK'));
    // Local adaptation of #5680: watching is decoupled from read-in-place, so
    // unchecking the latter leaves the folder watched and its books are copied
    // into the library instead of read in place (upstream forces autoImport off
    // here, which this branch's watched-folder rework deliberately dropped).
    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ directory: REGISTERED, readInPlace: false, autoImport: true }),
    );
  });

  it('turns the toggle on when picking a registered folder', async () => {
    setup({
      initialDirectory: '/library/Downloads',
      initialReadInPlace: false,
      onPickDirectory: vi.fn().mockResolvedValue(REGISTERED),
    });

    expect(getReadInPlaceCheckbox().checked).toBe(false);

    fireEvent.click(screen.getByLabelText('Choose a folder'));
    await waitFor(() => expect(getReadInPlaceCheckbox().checked).toBe(true));
  });

  it('keeps the persisted last choice for unregistered folders', () => {
    setup({ initialDirectory: '/library/Downloads', initialReadInPlace: false });

    const checkbox = getReadInPlaceCheckbox();
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
  });
});
