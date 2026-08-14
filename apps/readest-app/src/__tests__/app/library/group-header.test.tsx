import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import GroupHeader from '@/app/library/components/GroupHeader';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/hooks/useResponsiveSize', () => ({
  useResponsiveSize: (n: number) => n,
}));

const routerStub = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => routerStub,
}));

const navigateToLibraryMock = vi.fn();
vi.mock('@/utils/nav', () => ({
  navigateToLibrary: (...args: unknown[]) => navigateToLibraryMock(...args),
}));

afterEach(() => {
  cleanup();
  navigateToLibraryMock.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('GroupHeader back button', () => {
  // Regression for #4437: inside a series/author folder after a cold start, the
  // URL is just `?group=X` (groupBy comes from settings, not the URL). Deleting
  // `group` would leave an empty query, and `router.replace('/library')` with an
  // empty search silently no-ops under the Next.js 16.2 static export (same root
  // cause as #3782, fixed for the breadcrumb "All" button in #3832). The back
  // button must keep the query non-empty via the `group=` workaround so the
  // navigation actually commits.
  it('keeps a non-empty query when group is the only param', () => {
    window.history.replaceState(null, '', '?group=abc123');
    render(<GroupHeader groupName='My Series' />);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(navigateToLibraryMock).toHaveBeenCalledTimes(1);
    const query = navigateToLibraryMock.mock.calls[0]![1] as string;
    expect(query).not.toBe('');
    const params = new URLSearchParams(query);
    expect(params.has('group')).toBe(true);
    expect(params.get('group')).toBe('');
  });

  it('backs out to the top level when no source group is recorded', () => {
    window.history.replaceState(null, '', '?groupBy=author&sort=title&group=abc123');
    render(<GroupHeader groupName='Jane Doe' />);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const query = navigateToLibraryMock.mock.calls[0]![1] as string;
    const params = new URLSearchParams(query);
    // No `from` param → top level (empty group). The groupBy override is dropped
    // so the source view resolves its own dimension from per-group memory; other
    // params like sort are preserved.
    expect(params.get('group')).toBe('');
    expect(params.has('groupBy')).toBe(false);
    expect(params.get('sort')).toBe('title');
  });

  // A virtual group opened inside a folder records the source folder in `from`;
  // "back" must return to that folder, not the whole-library top level.
  it('backs out to the recorded source folder when from is set', () => {
    window.history.replaceState(null, '', '?group=abc123&groupBy=author&from=folder456');
    render(<GroupHeader groupName='Jane Doe' />);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    const query = navigateToLibraryMock.mock.calls[0]![1] as string;
    const params = new URLSearchParams(query);
    expect(params.get('group')).toBe('folder456');
    expect(params.has('from')).toBe(false);
    expect(params.has('groupBy')).toBe(false);
  });
});
