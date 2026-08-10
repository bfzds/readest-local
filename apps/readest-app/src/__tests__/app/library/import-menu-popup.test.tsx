import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

import ImportMenuPopup, { getMenuPosition } from '@/app/library/components/ImportMenuPopup';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

const renderPopup = (props: Partial<React.ComponentProps<typeof ImportMenuPopup>> = {}) => {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const onClose = vi.fn();
  const utils = render(
    <ImportMenuPopup
      anchor={anchor}
      onClose={onClose}
      onImportBooksFromFiles={vi.fn()}
      {...props}
    />,
  );
  return { ...utils, anchor, onClose };
};

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('ImportMenuPopup', () => {
  it('shows local-file import and hides platform-dependent options by default', () => {
    renderPopup();

    expect(screen.getByRole('menuitem', { name: 'From Local File' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'From Directory' })).toBeNull();
  });

  it('adds the directory option when its callback is available', () => {
    const onImportBooksFromDirectory = vi.fn();
    const { onClose } = renderPopup({ onImportBooksFromDirectory });

    fireEvent.click(screen.getByRole('menuitem', { name: 'From Directory' }));
    expect(onImportBooksFromDirectory).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('runs the selected action and dismisses the popup', () => {
    const onImportBooksFromFiles = vi.fn();
    const { onClose } = renderPopup({ onImportBooksFromFiles });

    fireEvent.click(screen.getByRole('menuitem', { name: 'From Local File' }));

    expect(onImportBooksFromFiles).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses the popup when the backdrop is clicked', () => {
    const { container, onClose } = renderPopup();

    fireEvent.click(container.querySelector('.overlay')!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('getMenuPosition', () => {
  const bounds = { left: 8, top: 8, right: 992, bottom: 792 };
  const menu = { width: 200, height: 240 };
  const anchorRect = (left: number, top: number, width = 100, height = 140) =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    }) as DOMRect;

  it('centers the menu under the anchor', () => {
    expect(getMenuPosition(anchorRect(400, 200), menu, bounds)).toEqual({
      left: 400 + 50 - 100,
      top: 340 + 8,
    });
  });

  it('flips above the anchor when there is no room below', () => {
    expect(getMenuPosition(anchorRect(400, 600), menu, bounds)).toEqual({
      left: 350,
      top: 600 - 8 - 240,
    });
  });

  it('keeps the menu inside the bounds near the edges', () => {
    expect(getMenuPosition(anchorRect(0, 200), menu, bounds).left).toBe(8);
    expect(getMenuPosition(anchorRect(960, 200, 40), menu, bounds).left).toBe(792);
    expect(
      getMenuPosition(anchorRect(400, 40), menu, { left: 8, top: 8, right: 992, bottom: 292 }).top,
    ).toBe(8);
  });

  it('respects safe area insets when clamping', () => {
    const insetBounds = { left: 52, top: 8, right: 992, bottom: 792 };

    expect(getMenuPosition(anchorRect(0, 200), menu, insetBounds).left).toBe(52);
  });
});
