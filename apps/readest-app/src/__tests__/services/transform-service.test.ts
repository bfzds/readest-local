import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transformMock } = vi.hoisted(() => ({
  transformMock: vi.fn(async (ctx: { content: string }) => ctx.content + '!'),
}));

vi.mock('@/services/transformers', () => ({
  availableTransformers: [{ name: 'mock', transform: transformMock }],
}));

import { transformContent } from '@/services/transformService';
import type { TransformContext } from '@/services/transformers/types';

const baseCtx = (content: string, bookKey = 'b1'): TransformContext => ({
  bookKey,
  viewSettings: {} as never,
  userLocale: 'zh-CN',
  isFixedLayout: false,
  primaryLanguage: 'zh',
  width: 800,
  height: 600,
  content,
  sectionHref: 's1.xhtml',
  transformers: ['mock'],
});

describe('transformContent cache', () => {
  beforeEach(() => {
    transformMock.mockClear();
  });

  it('reuses the cached output without re-running transformers', async () => {
    const first = await transformContent(baseCtx('hello'));
    expect(first).toBe('hello!');
    expect(transformMock).toHaveBeenCalledTimes(1);

    const second = await transformContent(baseCtx('hello'));
    expect(second).toBe('hello!');
    expect(transformMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates when the chapter content changes', async () => {
    await transformContent(baseCtx('hello', 'b2'));
    await transformContent(baseCtx('world different text', 'b2'));
    expect(transformMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates when view settings change', async () => {
    await transformContent(baseCtx('hello', 'b3'));
    await transformContent({
      ...baseCtx('hello', 'b3'),
      viewSettings: { vertical: true, fontScale: 1.2 } as never,
    });
    expect(transformMock).toHaveBeenCalledTimes(2);
  });

  it('keeps per-section entries separate', async () => {
    await transformContent(baseCtx('hello', 'b4'));
    await transformContent({ ...baseCtx('hello', 'b4'), sectionHref: 's2.xhtml' });
    expect(transformMock).toHaveBeenCalledTimes(2);
  });
});
