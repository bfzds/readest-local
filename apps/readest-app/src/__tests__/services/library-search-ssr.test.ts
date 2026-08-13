// @vitest-environment node
import { describe, expect, it } from 'vitest';

// The reader and library pages import this service statically, so Next.js
// evaluates its module graph on the server while collecting page data —
// where browser globals like NodeFilter do not exist.
describe('librarySearchService SSR safety', () => {
  // Long timeout: the dynamic import pulls in a large module graph (fzf, lunr,
  // …). Under a parallel vitest run on a cold Windows start it exceeds the
  // default 5s and fails spuriously; it passes when run alone.
  it('imports without browser globals', async () => {
    expect(typeof NodeFilter).toBe('undefined');
    await expect(import('@/services/librarySearchService')).resolves.toBeDefined();
  }, 30000);
});
