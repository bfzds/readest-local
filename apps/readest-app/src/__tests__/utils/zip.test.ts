import { describe, test, expect, vi, beforeEach } from 'vitest';

const { configureMock } = vi.hoisted(() => ({ configureMock: vi.fn() }));

vi.mock('@zip.js/zip.js', () => ({
  configure: configureMock,
}));

import { configureZip } from '@/utils/zip';

describe('configureZip', () => {
  beforeEach(() => {
    configureMock.mockClear();
  });

  test('defaults to web worker decompression with a statically shipped worker script', async () => {
    await configureZip();
    expect(configureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebWorkers: true,
        workerURI: '/workers/zip/zip-web-worker.js',
      }),
    );
  });

  test('keeps caller overrides on top of the worker defaults', async () => {
    await configureZip({ useWebWorkers: false });
    expect(configureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebWorkers: false,
        workerURI: '/workers/zip/zip-web-worker.js',
      }),
    );
  });
});
