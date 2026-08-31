import { expect, test } from 'vitest';

import { createLibrarySearchWorker } from '@/services/librarySearchWorker';

const nearbyOptions = {
  locale: 'en',
  matchCase: false,
  matchDiacritics: false,
  nearbyWords: 5,
};

const fuzzyOptions = { matchCase: false, matchDiacritics: false };

test('runs searches in the module worker and restarts after cancellation', async () => {
  const searchWorker = createLibrarySearchWorker();

  const nearbyResult = await searchWorker.search({
    sectionKey: 'nearby',
    text: 'alpha one beta gap',
    query: 'alpha beta',
    mode: 'nearby-words',
    fuzzyOptions: { matchCase: false, matchDiacritics: false },
    nearbyOptions,
    limit: 500,
  });
  expect(nearbyResult.truncated).toBe(false);
  expect(nearbyResult.matches).toEqual([
    {
      start: 0,
      end: 14,
      runs: [
        { start: 0, end: 5 },
        { start: 10, end: 14 },
      ],
    },
  ]);

  const controller = new AbortController();
  const aborted = searchWorker.search(
    {
      sectionKey: 'large',
      text: 'alpha '.repeat(500_000),
      query: 'omega',
      mode: 'fuzzy',
      fuzzyOptions: { matchCase: false, matchDiacritics: false },
      nearbyOptions,
      limit: 500,
    },
    controller.signal,
  );
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

  await expect(
    searchWorker.search({
      sectionKey: 'fuzzy',
      text: 'UserAuthController',
      query: 'UserController',
      mode: 'fuzzy',
      fuzzyOptions: { matchCase: false, matchDiacritics: false },
      nearbyOptions,
      limit: 500,
    }),
  ).resolves.toEqual({
    truncated: false,
    matches: [
      {
        start: 0,
        end: 18,
        runs: [
          { start: 0, end: 4 },
          { start: 8, end: 18 },
        ],
        typoCount: 0,
      },
    ],
  });

  searchWorker.close();
});

test('search-batch returns per-section results in the same order as single searches', async () => {
  const searchWorker = createLibrarySearchWorker();

  const single = await searchWorker.search({
    sectionKey: 'single',
    text: 'UserAuthController intro',
    query: 'UserController',
    mode: 'fuzzy',
    fuzzyOptions,
    nearbyOptions,
    limit: 500,
  });

  const batches = await searchWorker.searchBatch(
    [
      { sectionKey: 'a', text: 'UserAuthController intro', limit: 500 },
      { sectionKey: 'b', text: 'Nothing relevant here.', limit: 500 },
    ],
    {
      query: 'UserController',
      mode: 'fuzzy',
      fuzzyOptions,
      nearbyOptions,
    },
  );

  expect(batches.map((entry) => entry.sectionKey)).toEqual(['a', 'b']);
  expect(batches[0]!.matches).toEqual(single.matches);
  expect(batches[1]!.matches).toEqual([]);
  expect(batches[1]!.truncated).toBe(false);

  searchWorker.close();
});

test('search-batch nearby words keeps per-section word segmentation', async () => {
  const searchWorker = createLibrarySearchWorker();
  const batches = await searchWorker.searchBatch(
    [
      { sectionKey: 'n0', text: 'alpha one beta gap', limit: 500 },
      { sectionKey: 'n1', text: 'no co-occurrence here at all', limit: 500 },
    ],
    {
      query: 'alpha beta',
      mode: 'nearby-words',
      fuzzyOptions,
      nearbyOptions,
    },
  );

  expect(batches[0]!.sectionKey).toBe('n0');
  expect(batches[0]!.matches).toEqual([
    {
      start: 0,
      end: 14,
      runs: [
        { start: 0, end: 5 },
        { start: 10, end: 14 },
      ],
    },
  ]);
  expect(batches[1]!.matches).toEqual([]);

  searchWorker.close();
});

test('search-batch honors a shared budget across sections (P-4)', async () => {
  const searchWorker = createLibrarySearchWorker();
  const batches = await searchWorker.searchBatch(
    [
      { sectionKey: 'b0', text: 'a'.repeat(200), limit: 500 },
      { sectionKey: 'b1', text: 'a'.repeat(200), limit: 500 },
    ],
    {
      query: 'a',
      mode: 'fuzzy',
      fuzzyOptions,
      nearbyOptions,
    },
    undefined,
    3,
  );
  // budget=3：第一节即用尽，第二节不再产出，总量不超过预算。
  const totalMatches = batches.reduce((n, entry) => n + entry.matches.length, 0);
  expect(totalMatches).toBeLessThanOrEqual(3);
  expect(batches.length).toBeLessThanOrEqual(2);

  searchWorker.close();
});
