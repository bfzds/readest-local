import {
  findFuzzyMatches,
  findNearbyMatches,
  segmentNearbyWords,
} from './library-search-algorithms.js';

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_SECTIONS = 256;
const sections = new Map();
let cachedBytes = 0;

const trimCache = () => {
  while (
    sections.size > MAX_CACHE_SECTIONS ||
    (sections.size > 0 && cachedBytes > MAX_CACHE_BYTES)
  ) {
    const oldestKey = sections.keys().next().value;
    cachedBytes -= sections.get(oldestKey).bytes;
    sections.delete(oldestKey);
  }
};

const getSection = (key, text) => {
  const existing = sections.get(key);
  if (existing?.text === text) {
    sections.delete(key);
    sections.set(key, existing);
    return existing;
  }
  if (existing) {
    cachedBytes -= existing.bytes;
    sections.delete(key);
  }

  const section = { text, bytes: text.length * 2, words: new Map() };
  if (section.bytes <= MAX_CACHE_BYTES) {
    sections.set(key, section);
    cachedBytes += section.bytes;
    trimCache();
  }
  return section;
};

const matchSection = (sectionKey, text, query, mode, fuzzyOptions, nearbyOptions, limit) => {
  const section = getSection(sectionKey, text);
  const state = {};
  const matches =
    mode === 'fuzzy'
      ? findFuzzyMatches(section.text, query, fuzzyOptions, limit, state)
      : findNearbyMatches(
          section.text,
          query,
          nearbyOptions,
          (() => {
            const locale = nearbyOptions.locale ?? 'en';
            const existing = section.words.get(locale);
            if (existing) return existing;
            const words = segmentNearbyWords(section.text, locale);
            section.words.set(locale, words);
            if (sections.get(sectionKey) === section) {
              const wordBytes = words.reduce((bytes, word) => bytes + word.text.length * 2 + 32, 0);
              section.bytes += wordBytes;
              cachedBytes += wordBytes;
              sections.delete(sectionKey);
              sections.set(sectionKey, section);
              trimCache();
            }
            return words;
          })(),
          limit,
          state,
        );
  return { matches, truncated: Boolean(state.truncated) };
};

self.onmessage = (event) => {
  if (event.data.type === 'search') {
    const { id, sectionKey, text, query, mode, fuzzyOptions, nearbyOptions, limit } =
      event.data.payload;
    try {
      const { matches, truncated } = matchSection(
        sectionKey,
        text,
        query,
        mode,
        fuzzyOptions,
        nearbyOptions,
        limit,
      );
      self.postMessage({ type: 'success', id, matches, truncated });
    } catch (error) {
      self.postMessage({
        type: 'error',
        id,
        message: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return;
  }
  if (event.data.type !== 'search-batch') return;
  const { id, query, mode, fuzzyOptions, nearbyOptions, sections } = event.data.payload;
  try {
    const results = sections.map(({ sectionKey, text, limit }) => {
      const { matches, truncated } = matchSection(
        sectionKey,
        text,
        query,
        mode,
        fuzzyOptions,
        nearbyOptions,
        limit,
      );
      return { sectionKey, matches, truncated };
    });
    self.postMessage({ type: 'batch-success', id, results });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
      ...(error?.code ? { code: error.code } : {}),
    });
  }
};
