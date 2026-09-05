import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

type ReaderStoreState = {
  getView: () => unknown;
  getViewState: () => { ttsEnabled: boolean };
  __ttsEnabled: boolean;
};

const readerStoreState: ReaderStoreState = {
  getView: () => ({}),
  getViewState: () => ({ ttsEnabled: readerStoreState.__ttsEnabled }),
  __ttsEnabled: false,
};

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: dispatchMock } }));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector?: (s: ReaderStoreState) => unknown) =>
    selector ? selector(readerStoreState) : readerStoreState,
}));

import FloatingSpeakButton from '@/app/reader/components/FloatingSpeakButton';

afterEach(() => {
  cleanup();
  dispatchMock.mockClear();
  readerStoreState.__ttsEnabled = false;
});

describe('FloatingSpeakButton', () => {
  it('dispatches tts-speak when TTS is off', () => {
    render(<FloatingSpeakButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Speak'));
    expect(dispatchMock).toHaveBeenCalledWith('tts-speak', { bookKey: 'book-1' });
  });

  it('dispatches tts-stop when TTS is on', () => {
    readerStoreState.__ttsEnabled = true;
    render(<FloatingSpeakButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Stop'));
    expect(dispatchMock).toHaveBeenCalledWith('tts-stop', { bookKey: 'book-1' });
  });

  it('labels itself as Stop while TTS is playing and Speak when idle', () => {
    const { rerender } = render(<FloatingSpeakButton bookKey='book-1' />);
    expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy();
    readerStoreState.__ttsEnabled = true;
    rerender(<FloatingSpeakButton bookKey='book-1' />);
    expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('title')).toBe('Stop');
    expect(screen.queryByRole('button', { name: 'Speak' })).toBeNull();
  });

  it('does nothing without a mounted view', () => {
    const originalGetView = readerStoreState.getView;
    readerStoreState.getView = () => null;
    render(<FloatingSpeakButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Speak'));
    expect(dispatchMock).not.toHaveBeenCalled();
    readerStoreState.getView = originalGetView;
  });
});
