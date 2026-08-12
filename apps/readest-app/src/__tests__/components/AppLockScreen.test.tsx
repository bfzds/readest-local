import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const unlockMock = vi.fn();

vi.mock('@/libs/crypto/applock', () => ({
  PIN_LENGTH: 4,
  verifyPin: vi.fn(),
}));

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (k: string) => k }));

vi.mock('@/store/appLockStore', () => ({
  useAppLockStore: () => ({
    pinHash: 'h',
    pinSalt: 's',
    unlock: unlockMock,
  }),
}));

vi.mock('@/components/PinInput', () => ({
  __esModule: true,
  default: ({
    ariaLabel,
    value,
    onChange,
  }: {
    ariaLabel: string;
    value: string;
    onChange: (value: string) => void;
  }) => <input aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

import AppLockScreen from '@/components/AppLockScreen';
import { verifyPin } from '@/libs/crypto/applock';

const verifyPinMock = vi.mocked(verifyPin);

beforeEach(() => {
  unlockMock.mockReset();
  verifyPinMock.mockReset();
});
afterEach(cleanup);

describe('AppLockScreen PIN entry', () => {
  it('renders the PIN entry', () => {
    render(<AppLockScreen />);
    expect(screen.getByLabelText('PIN code')).toBeTruthy();
    expect(screen.getByText('Enter your PIN')).toBeTruthy();
  });

  it('calls unlock when the correct PIN is entered', async () => {
    verifyPinMock.mockResolvedValue(true);
    render(<AppLockScreen />);
    fireEvent.change(screen.getByLabelText('PIN code'), { target: { value: '1234' } });
    await waitFor(() => expect(unlockMock).toHaveBeenCalledTimes(1));
  });

  it('shows an error and clears the PIN when the PIN is incorrect', async () => {
    verifyPinMock.mockResolvedValue(false);
    render(<AppLockScreen />);
    fireEvent.change(screen.getByLabelText('PIN code'), { target: { value: '9999' } });
    await waitFor(() => expect(screen.getByText('Incorrect PIN')).toBeTruthy());
    expect(screen.getByLabelText<HTMLInputElement>('PIN code').value).toBe('');
  });
});
