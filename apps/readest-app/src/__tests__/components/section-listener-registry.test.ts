import { describe, expect, it, vi } from 'vitest';
import { createSectionListenerRegistry } from '@/app/reader/components/annotator/sectionListenerRegistry';

describe('section listener registry', () => {
  it('同一 index 替换 doc 时立即清理旧 doc', () => {
    const registry = createSectionListenerRegistry();
    const first = document.implementation.createHTMLDocument();
    const second = document.implementation.createHTMLDocument();
    const cleanupFirst = vi.fn();
    const cleanupSecond = vi.fn();

    expect(registry.replace(3, first, cleanupFirst)).toBe(true);
    expect(registry.replace(3, second, cleanupSecond)).toBe(true);
    expect(cleanupFirst).toHaveBeenCalledOnce();
    expect(cleanupSecond).not.toHaveBeenCalled();
  });

  it('同一 doc 重复 load 不重复注册', () => {
    const registry = createSectionListenerRegistry();
    const doc = document.implementation.createHTMLDocument();
    const cleanup = vi.fn();
    expect(registry.replace(1, doc, cleanup)).toBe(true);
    expect(registry.replace(1, doc, vi.fn())).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('disposeAll 只调用每个活动 cleanup 一次', () => {
    const registry = createSectionListenerRegistry();
    const cleanup = vi.fn();
    registry.replace(1, document.implementation.createHTMLDocument(), cleanup);
    registry.disposeAll();
    registry.disposeAll();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
