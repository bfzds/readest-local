import { describe, it, expect, afterEach } from 'vitest';
import { blurActiveElement } from '@/utils/focus';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('blurActiveElement', () => {
  it('blurs an input that currently has focus', () => {
    document.body.innerHTML = '<input id="search" />';
    const input = document.querySelector<HTMLInputElement>('#search')!;
    input.focus();
    expect(document.activeElement).toBe(input);

    blurActiveElement();

    expect(document.activeElement).not.toBe(input);
  });

  it('is a no-op when focus is on a non-HTMLElement (document/body)', () => {
    // jsdom 默认 activeElement 为 body；若 body 不是可聚焦元素不应抛错。
    expect(() => blurActiveElement()).not.toThrow();
  });
});
