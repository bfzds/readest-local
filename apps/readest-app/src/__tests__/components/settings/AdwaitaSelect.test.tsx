import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import AdwaitaSelect from '@/components/settings/primitives/AdwaitaSelect';
import { DropdownProvider } from '@/context/DropdownContext';

afterEach(() => cleanup());

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

const renderSelect = (props: Partial<Parameters<typeof AdwaitaSelect>[0]> = {}) => {
  const onChange = vi.fn();
  render(
    <DropdownProvider>
      <AdwaitaSelect
        value='a'
        onChange={onChange}
        options={options}
        ariaLabel='Test Select'
        {...props}
      />
    </DropdownProvider>,
  );
  return onChange;
};

describe('AdwaitaSelect', () => {
  it('renders the current value label as the trigger', () => {
    renderSelect();
    expect(screen.getByRole('button', { name: 'Test Select' }).textContent).toContain('Alpha');
  });

  it('falls back to the raw value when it is not in options', () => {
    renderSelect({ value: 'zzz' });
    expect(screen.getByRole('button', { name: 'Test Select' }).textContent).toContain('zzz');
  });

  it('opens a listbox and selects via click', () => {
    const onChange = renderSelect();
    fireEvent.click(screen.getByRole('button', { name: 'Test Select' }));

    const option = screen.getByRole('option', { name: 'Gamma' });
    expect(option.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('marks the current value as selected in the listbox', () => {
    renderSelect();
    fireEvent.click(screen.getByRole('button', { name: 'Test Select' }));
    expect(screen.getByRole('option', { name: 'Alpha' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('navigates with arrow keys and selects with Enter', () => {
    const onChange = renderSelect();
    fireEvent.click(screen.getByRole('button', { name: 'Test Select' }));

    const listbox = screen.getByRole('listbox');
    listbox.focus();
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('skips disabled options when navigating', () => {
    const onChange = renderSelect({
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta', disabled: true },
        { value: 'c', label: 'Gamma' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test Select' }));

    const listbox = screen.getByRole('listbox');
    listbox.focus();
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('closes on Escape', () => {
    const onChange = renderSelect();
    fireEvent.click(screen.getByRole('button', { name: 'Test Select' }));
    expect(screen.getByRole('listbox')).toBeTruthy();

    const listbox = screen.getByRole('listbox');
    listbox.focus();
    fireEvent.keyDown(listbox, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('forwards the testId to the trigger button', () => {
    renderSelect({ testId: 'my-select' });
    expect(screen.getByTestId('my-select')).toBeTruthy();
  });
});
