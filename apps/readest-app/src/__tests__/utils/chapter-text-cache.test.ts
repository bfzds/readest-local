import { describe, test, expect } from 'vitest';
import { ChapterTextCache } from '@/utils/chapterTextCache';

const textBytes = (s: string) => s.length * 2;

describe('ChapterTextCache', () => {
  test('returns undefined for a missing key', () => {
    const cache = new ChapterTextCache(1024);
    expect(cache.get('missing')).toBeUndefined();
  });

  test('stores and retrieves text', () => {
    const cache = new ChapterTextCache(1024);
    cache.set('c1', 'hello');
    expect(cache.get('c1')).toBe('hello');
    expect(cache.size()).toBe(1);
  });

  test('evicts the oldest chapter when the byte budget is exceeded', () => {
    const cache = new ChapterTextCache(100);
    cache.set('a', 'x'.repeat(30)); // 60 bytes
    cache.set('b', 'y'.repeat(30)); // 60 bytes -> total 120 > 100
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe('y'.repeat(30));
  });

  test('a hit promotes the chapter to most-recently-used', () => {
    const cache = new ChapterTextCache(100);
    cache.set('a', 'x'.repeat(30)); // 60
    cache.set('b', 'y'.repeat(30)); // 120, evicts a
    cache.set('a', 'x'.repeat(30)); // a becomes recent, evicts b
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe('x'.repeat(30));
  });

  test('updating an existing key re-counts its bytes', () => {
    const cache = new ChapterTextCache(100);
    cache.set('a', 'x'.repeat(30)); // 60
    cache.set('a', 'x'.repeat(20)); // shrinks to 40, no eviction
    cache.set('b', 'y'.repeat(30)); // 40 + 60 = 100, fits
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.size()).toBe(2);
  });

  test('evicts down to a single entry when a huge chapter arrives', () => {
    const cache = new ChapterTextCache(100);
    cache.set('a', 'x'.repeat(30));
    cache.set('b', 'y'.repeat(1000)); // 2000 bytes, evicts a and stays
    expect(cache.size()).toBe(1);
    expect(cache.get('b')).toBe('y'.repeat(1000));
  });

  test('tracks byte usage across eviction (no negative/leaked bytes)', () => {
    const cache = new ChapterTextCache(100);
    cache.set('a', 'x'.repeat(30));
    cache.set('b', 'y'.repeat(30));
    // after evicting a, only b remains
    expect(cache.size()).toBe(1);
    // adding a small c must not evict b
    cache.set('c', 'z'.repeat(10)); // 20 bytes, 60 + 20 = 80 <= 100
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.size()).toBe(2);
  });

  test('clear empties the cache', () => {
    const cache = new ChapterTextCache(1024);
    cache.set('a', 'x');
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  test('byte estimate matches UTF-16 cost', () => {
    const cache = new ChapterTextCache(100);
    cache.set('a', '汉字'); // 2 chars * 2 = 4 bytes
    cache.set('b', 'y'.repeat(50)); // 100 bytes
    // total 104 > 100 -> evicts a (older)
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe('y'.repeat(50));
  });

  test('maxBytes of zero still keeps the latest entry', () => {
    const cache = new ChapterTextCache(0);
    cache.set('a', 'x');
    cache.set('b', 'y');
    expect(cache.size()).toBe(1);
    expect(cache.get('b')).toBe('y');
  });

  test('byte cost matches textBytes helper', () => {
    expect(textBytes('abc')).toBe(6);
    expect(textBytes('汉字')).toBe(4);
  });
});
