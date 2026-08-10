import { describe, it, expect } from 'vitest';
import { middleware } from '@/middleware';

describe('middleware cross-origin isolation headers', () => {
  it('serves COOP same-origin on every response', () => {
    const res = middleware();
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('serves COEP require-corp on every response', () => {
    const res = middleware();
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });
});
