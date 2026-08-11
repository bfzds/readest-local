import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const readerStoreState = {
  getView: () => null,
  getViewSettings: () => ({
    vertical: false,
    scrolled: false,
    showStickyProgressBar: false,
    marginBottomPx: 20,
    showRemainingTime: false,
    showRemainingPages: false,
    showProgressInfo: true,
    showCurrentTime: false,
    showCurrentBatteryStatus: false,
    rtl: false,
  }),
};

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { hasSafeAreaInset: false } }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector?: (state: typeof readerStoreState) => unknown) =>
    selector ? selector(readerStoreState) : readerStoreState,
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: (selector?: (state: { getBookData: () => unknown }) => unknown) => {
    const state = { getBookData: () => ({}) };
    return selector ? selector(state) : state;
  },
}));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({
    sectionLabel: '第一章',
    section: { current: 0, total: 10 },
    pageinfo: { current: 0, total: 100 },
    fraction: 0,
    pageItem: null,
  }),
}));
vi.mock('@/app/reader/hooks/useCurrentTime', () => ({
  useCurrentTime: () => '',
}));
vi.mock('@/app/reader/hooks/useCurrentBattery', () => ({
  useCurrentBatteryStatus: () => null,
}));
vi.mock('@/hooks/useMedianPageDurationSecs', () => ({
  useMedianPageDurationSecs: () => undefined,
}));

import ProgressBar from '@/app/reader/components/ProgressBar';

afterEach(() => cleanup());

describe('ProgressBar', () => {
  it('shows the current section label at the bottom', () => {
    render(
      <ProgressBar
        bookKey='book-1'
        horizontalGap={5}
        contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }}
        gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />,
    );
    expect(screen.getByText('第一章')).toBeDefined();
  });
});
