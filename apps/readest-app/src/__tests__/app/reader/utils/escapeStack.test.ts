import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  pushEscapeHandler,
  popEscapeHandler,
  handleEscapeStack,
} from '@/app/reader/utils/escapeStack';

beforeEach(() => {
  popEscapeHandler('a');
  popEscapeHandler('b');
});

describe('escapeStack', () => {
  it('dispatches to the top of the stack first (LIFO)', () => {
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    pushEscapeHandler('a', a);
    pushEscapeHandler('b', b);

    expect(handleEscapeStack()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it('falls through to lower layers when the top does not consume', () => {
    const a = vi.fn(() => true);
    const b = vi.fn(() => false);
    pushEscapeHandler('a', a);
    pushEscapeHandler('b', b);

    expect(handleEscapeStack()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('returns false when no layer consumes', () => {
    pushEscapeHandler('a', () => false);
    expect(handleEscapeStack()).toBe(false);
  });

  it('keeps the layer position on re-registration and removes on pop', () => {
    const a = vi.fn(() => true);
    const b1 = vi.fn(() => true);
    pushEscapeHandler('a', a);
    pushEscapeHandler('b', b1);

    // Re-registering 'a' must not move it above 'b'.
    const a2 = vi.fn(() => true);
    pushEscapeHandler('a', a2);
    expect(handleEscapeStack()).toBe(true);
    expect(b1).toHaveBeenCalledTimes(1);
    expect(a2).not.toHaveBeenCalled();

    popEscapeHandler('b');
    expect(handleEscapeStack()).toBe(true);
    expect(a2).toHaveBeenCalledTimes(1);
  });
});
