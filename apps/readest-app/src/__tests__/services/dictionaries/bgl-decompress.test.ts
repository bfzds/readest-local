import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'fflate';

import { decompressBglData } from '@/services/dictionaries/bglDecompress';

describe('decompressBglData', () => {
  const payload = new TextEncoder().encode('Hello BGL 词典数据 payload');
  let gz: Uint8Array;

  beforeEach(() => {
    gz = gzipSync(payload);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('main-thread fallback (Worker unavailable)', () => {
    beforeEach(() => {
      vi.stubGlobal('Worker', undefined);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test('decompresses on the main thread', async () => {
      const out = await decompressBglData(gz);
      expect(Array.from(out)).toEqual(Array.from(payload));
    });

    test('decompresses a subarray view of a larger buffer', async () => {
      // 模拟 bglReader：gzip 数据位于带 junk 前缀的整本 buffer 内。
      const padded = new Uint8Array(6 + gz.length);
      padded.set(gz, 6);
      const out = await decompressBglData(padded.subarray(6));
      expect(Array.from(out)).toEqual(Array.from(payload));
    });
  });

  describe('when Worker construction fails', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'Worker',
        class {
          constructor() {
            throw new Error('mock worker fail');
          }
        },
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    test('falls back to main-thread decompression', async () => {
      const out = await decompressBglData(gz);
      expect(Array.from(out)).toEqual(Array.from(payload));
    });
  });
});
