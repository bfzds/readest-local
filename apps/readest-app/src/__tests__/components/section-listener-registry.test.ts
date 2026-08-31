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

  it('disposeDocument 调用该 doc 的 cleanup 且幂等（pagehide 接线复用此入口）', () => {
    const registry = createSectionListenerRegistry();
    const doc = document.implementation.createHTMLDocument();
    const cleanup = vi.fn();
    expect(registry.replace(4, doc, cleanup)).toBe(true);

    registry.disposeDocument(doc);
    expect(cleanup).toHaveBeenCalledOnce();

    // 幂等：重复 dispose 不再触发（Annotator 的 pagehide 与组件卸载都可能
    // 针对同一 doc 再调用一次）。
    registry.disposeDocument(doc);
    expect(cleanup).toHaveBeenCalledOnce();

    // 该 index 已解除占用：新 doc 顶替时旧 cleanup 不再被再次调用。
    const next = document.implementation.createHTMLDocument();
    const nextCleanup = vi.fn();
    expect(registry.replace(4, next, nextCleanup)).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(nextCleanup).not.toHaveBeenCalled();
  });
});
