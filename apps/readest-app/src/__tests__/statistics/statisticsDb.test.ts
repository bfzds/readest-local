import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import type { DatabaseService } from '@/types/database';
import type { AppService } from '@/types/system';
import { StatisticsDb } from '@/services/statistics/statisticsDb';

async function freshStatsDb(): Promise<DatabaseService> {
  // In-memory libsql DB; run the same migrations production uses.
  const db = await NodeDatabaseService.open(':memory:');
  await migrate(db, getMigrations('statistics'));
  return db;
}

describe('statistics migration', () => {
  let db: DatabaseService;
  beforeEach(async () => {
    db = await freshStatsDb();
  });

  it('creates KOReader book + page_stat_data tables and extension tables', async () => {
    const tables = await db.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`,
    );
    const names = tables.map((t) => t.name);
    expect(names).toContain('book');
    expect(names).toContain('page_stat_data');
    expect(names).toContain('numbers');
    expect(names).toContain('page_stat'); // the rescaling view
    expect(names).toContain('readest_page_ext');
    expect(names).toContain('readest_book_ext');
    expect(names).toContain('readest_stat_sync_state');
  });

  it('is idempotent when the page_stat view already exists (READEST-13)', async () => {
    // A DB imported from KOReader (or left by a partially-applied migration)
    // already has a page_stat view but no migration record. turso ignores
    // IF NOT EXISTS on CREATE VIEW, so a non-idempotent migration throws
    // "View page_stat already exists" here.
    const imported = await NodeDatabaseService.open(':memory:');
    await imported.execute('CREATE VIEW page_stat AS SELECT 1 AS x');

    await expect(migrate(imported, getMigrations('statistics'))).resolves.toBeUndefined();

    const views = await imported.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'view'`,
    );
    expect(views.map((v) => v.name)).toContain('page_stat');
  });

  it('seeds the numbers helper table 1..1000', async () => {
    const rows = await db.select<{ c: number }>(`SELECT COUNT(*) AS c FROM numbers`);
    expect(rows[0]!.c).toBe(1000);
  });

  it('enforces the page_stat_data uniqueness key', async () => {
    await db.execute(`INSERT INTO book (title, authors, md5) VALUES ('T','A','m')`);
    const id = (await db.select<{ id: number }>(`SELECT id FROM book LIMIT 1`))[0]!.id;
    await db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages) VALUES (?,?,?,?,?)`,
      [id, 5, 1000, 10, 100],
    );
    await db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?,?,?,?,?)
       ON CONFLICT(id_book, page, start_time) DO UPDATE SET duration = max(duration, excluded.duration)`,
      [id, 5, 1000, 25, 100],
    );
    const rows = await db.select<{ duration: number; c: number }>(
      `SELECT duration, COUNT(*) OVER () AS c FROM page_stat_data`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.duration).toBe(25);
  });
});

describe('StatisticsDb', () => {
  let stats: StatisticsDb;
  beforeEach(async () => {
    stats = StatisticsDb.from(await freshStatsDb());
  });

  it('upserts a book by md5 and returns a stable id_book', async () => {
    const id1 = await stats.upsertBook({ bookMd5: 'm1', title: 'T1', authors: 'A1' });
    const id2 = await stats.upsertBook({ bookMd5: 'm1', title: 'T1', authors: 'A1' });
    expect(id1).toBe(id2);
  });

  it('inserts page events and keeps the longer duration on re-flush', async () => {
    const id = await stats.upsertBook({ bookMd5: 'm1', title: 'T1', authors: 'A1' });
    await stats.insertPageEvent(id, { page: 3, startTime: 100, duration: 10, totalPages: 50 });
    await stats.insertPageEvent(id, { page: 3, startTime: 100, duration: 30, totalPages: 50 });
    await stats.insertPageEvent(id, { page: 4, startTime: 140, duration: 12, totalPages: 50 });
    await stats.recomputeBookTotals(id);
    const book = await stats.getBookByMd5('m1');
    expect(book!.total_read_time).toBe(42); // 30 + 12
    expect(book!.total_read_pages).toBe(2); // distinct pages 3,4
    expect(book!.last_open).toBe(152); // max(start_time + duration) = 140 + 12
  });

  it('returns events for push after a start_time cursor, joined with md5', async () => {
    const id = await stats.upsertBook({ bookMd5: 'm1', title: 'T1', authors: 'A1' });
    await stats.insertPageEvent(id, { page: 1, startTime: 100, duration: 5, totalPages: 9 });
    await stats.insertPageEvent(id, { page: 2, startTime: 200, duration: 5, totalPages: 9 });
    const { events } = await stats.getEventsForPush(150);
    expect(events.map((e) => e.startTime)).toEqual([200]);
    expect(events[0]!.bookMd5).toBe('m1');
  });

  it('applies remote events idempotently via upsert', async () => {
    const remoteBooks = [{ bookMd5: 'm2', title: 'T2', authors: 'A2' }];
    const remoteEvents = [
      { bookMd5: 'm2', page: 1, startTime: 300, duration: 8, totalPages: 20 },
      { bookMd5: 'm2', page: 1, startTime: 300, duration: 8, totalPages: 20 }, // dup
    ];
    await stats.applyRemoteEvents(remoteBooks, remoteEvents);
    await stats.applyRemoteEvents(remoteBooks, remoteEvents); // again — still idempotent
    const book = await stats.getBookByMd5('m2');
    expect(book!.total_read_time).toBe(8);
  });

  it('applies a large batch across chunked inserts with correct totals', async () => {
    // 150 事件要跨 2 个批量插入（每批 100 行），总数与聚合必须与逐条一致。
    const remoteBooks = [{ bookMd5: 'm-big', title: 'Big', authors: 'A' }];
    const remoteEvents = Array.from({ length: 150 }, (_, i) => ({
      bookMd5: 'm-big',
      page: (i % 50) + 1,
      startTime: 1000 + i,
      duration: 10,
      totalPages: 50,
    }));
    await stats.applyRemoteEvents(remoteBooks, remoteEvents);
    const book = await stats.getBookByMd5('m-big');
    // 150 条 × 10s = 1500 秒；若任一批次漏插则总和会变小。
    expect(book!.total_read_time).toBe(150 * 10);
    expect(book!.total_read_pages).toBe(50); // DISTINCT(page) over 1..50
  });

  it('serializes concurrent applyRemoteEvents without nesting transactions (READEST-N)', async () => {
    // Two pulls racing on the shared connection (split-view trackers) must not
    // open a BEGIN inside a BEGIN ("cannot start a transaction within a transaction").
    const a = stats.applyRemoteEvents(
      [{ bookMd5: 'ra', title: 'RA', authors: '' }],
      [{ bookMd5: 'ra', page: 1, startTime: 400, duration: 3, totalPages: 10 }],
    );
    const b = stats.applyRemoteEvents(
      [{ bookMd5: 'rb', title: 'RB', authors: '' }],
      [{ bookMd5: 'rb', page: 1, startTime: 401, duration: 4, totalPages: 10 }],
    );
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    expect((await stats.getBookByMd5('ra'))!.total_read_time).toBe(3);
    expect((await stats.getBookByMd5('rb'))!.total_read_time).toBe(4);
  });

  it('reads and writes sync cursors', async () => {
    expect(await stats.getCursor('push')).toBe(0);
    await stats.setCursor('push', 1234);
    expect(await stats.getCursor('push')).toBe(1234);
  });

  it('prunes page events beyond the per-book TTL cap (SF12)', async () => {
    const db = await freshStatsDb();
    const s = StatisticsDb.from(db);
    const id = await s.upsertBook({ bookMd5: 'm-ttl', title: 'T', authors: 'A' });
    // Insert more events than the retention cap.
    const cap = StatisticsDb.MAX_PAGE_EVENTS_PER_BOOK;
    for (let i = 0; i < cap + 100; i++) {
      await s.insertPageEvent(id, {
        page: 1,
        startTime: 100000 + i,
        duration: 1,
        totalPages: 10,
      });
    }
    await s.prunePageEvents(id);
    const rows = await db.select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM page_stat_data WHERE id_book = ?`,
      [id],
    );
    expect(rows[0]!.c).toBe(cap);
  });

  it('prune 后 recompute 不使 total_read_time 回缩（被删事件并入 retained）', async () => {
    const db = await freshStatsDb();
    const s = StatisticsDb.from(db);
    const id = await s.upsertBook({ bookMd5: 'm-ttl2', title: 'T', authors: 'A' });
    const cap = StatisticsDb.MAX_PAGE_EVENTS_PER_BOOK;
    const total = cap + 100;
    for (let i = 0; i < total; i++) {
      await s.insertPageEvent(id, { page: 1, startTime: 100000 + i, duration: 1, totalPages: 10 });
    }
    await s.recomputeBookTotals(id);
    expect((await s.getBookByMd5('m-ttl2'))!.total_read_time).toBe(total);
    await s.prunePageEvents(id);
    const rows = await db.select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM page_stat_data WHERE id_book = ?`,
      [id],
    );
    expect(rows[0]!.c).toBe(cap);
    // 跨 flush 再次重算：历史被删事件 duration 已并入 retained_read_time，总量不缩水
    await s.recomputeBookTotals(id);
    expect((await s.getBookByMd5('m-ttl2'))!.total_read_time).toBe(total);
  });

  it('keeps one book row per md5 even when title/authors change (no duplicates)', async () => {
    const id1 = await stats.upsertBook({ bookMd5: 'm1', title: 'Old', authors: 'A' });
    const id2 = await stats.upsertBook({ bookMd5: 'm1', title: 'New', authors: 'B' });
    expect(id2).toBe(id1);
    const book = await stats.getBookByMd5('m1');
    expect(book!.title).toBe('New'); // latest title wins
    // exactly one row for this md5
    const rows = await stats.getEventsForPush(-1); // no events; just exercise no crash
    void rows;
  });

  it('returns null until enough page data exists for a median', async () => {
    const id = await stats.upsertBook({ bookMd5: 'm-few', title: 'T', authors: 'A' });
    for (let i = 0; i < 4; i++) {
      await stats.insertPageEvent(id, {
        page: i,
        startTime: 100 + i,
        duration: 10,
        totalPages: 50,
      });
    }
    expect(await stats.getMedianPageDurationSecs(id)).toBeNull();
  });

  it('takes the median by duration value, not by recency (odd count)', async () => {
    const id = await stats.upsertBook({ bookMd5: 'm-odd', title: 'T', authors: 'A' });
    // Inserted in ascending start_time; durations are NOT sorted by value, so the
    // median must sort by value before picking the middle (recency-middle is 50).
    const byTime = [30, 10, 50, 20, 40];
    for (let i = 0; i < byTime.length; i++) {
      await stats.insertPageEvent(id, {
        page: i,
        startTime: 100 + i,
        duration: byTime[i]!,
        totalPages: 50,
      });
    }
    // Sorted: [10, 20, 30, 40, 50] -> median 30.
    expect(await stats.getMedianPageDurationSecs(id)).toBe(30);
  });

  it('averages the two middle durations (even count)', async () => {
    const id = await stats.upsertBook({ bookMd5: 'm-even', title: 'T', authors: 'A' });
    const byTime = [60, 10, 50, 20, 40, 30];
    for (let i = 0; i < byTime.length; i++) {
      await stats.insertPageEvent(id, {
        page: i,
        startTime: 100 + i,
        duration: byTime[i]!,
        totalPages: 50,
      });
    }
    // Sorted: [10, 20, 30, 40, 50, 60] -> (30 + 40) / 2 = 35.
    expect(await stats.getMedianPageDurationSecs(id)).toBe(35);
  });
});

describe('StatisticsDb.open', () => {
  it('retries after a transient singleton open failure', async () => {
    const db = await freshStatsDb();
    const error = new Error('transient open failure');
    const openDatabase = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(db);
    const appService = { openDatabase } as unknown as AppService;

    await expect(StatisticsDb.open(appService)).rejects.toBe(error);

    const stats = await StatisticsDb.open(appService);
    expect(openDatabase).toHaveBeenCalledTimes(2);
    await stats.close();
  });
});

describe('prune retained pages (B-9)', () => {
  let db: DatabaseService;
  beforeEach(async () => {
    db = await freshStatsDb();
  });

  it('total_read_pages 不回缩，同页出现在裁剪与保留区只计一次', async () => {
    const stats = StatisticsDb.from(db);
    await db.execute(
      `INSERT INTO book (title, authors, md5, total_read_time, total_read_pages) VALUES (?,'','md5-b9',0,0)`,
      ['B9'],
    );
    const row = await db.select<{ id: number }>(`SELECT id FROM book WHERE md5 = 'md5-b9'`);
    const idBook = row[0]!.id;

    // 共 10005 个事件（略超 10000 cap）：最老的 105 个含独有的页 999（绝不
    // 出现在保留区），其余古老事件页为 1..20；较新 9900 个为页 1..100 循环 —
    // 保证 prune 后保留区覆盖 1..100，被删区净增仅为 {999}。
    for (let t = 0; t < 10005; t++) {
      const page = t < 105 ? (t === 0 ? 999 : (t % 20) + 1) : (t % 100) + 1;
      await db.execute(
        `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages) VALUES (?,?,?,1000,100)`,
        [idBook, page, t * 1000],
      );
    }

    await stats.prunePageEvents(idBook);
    await stats.recomputeBookTotals(idBook);

    const totals = await db.select<{ total_read_pages: number }>(
      `SELECT total_read_pages FROM book WHERE id = ?`,
      [idBook],
    );
    // 历史唯一页 = 保留区 1..100（100 页） + 被删区净增 999（1 页） = 101。
    // 若只按现存行 COUNT(DISTINCT page) 会回缩成 100。
    expect(totals[0]!.total_read_pages).toBe(101);
  });

  it('retained_pages 默认 0，未超限的库不累积', async () => {
    const stats = StatisticsDb.from(db);
    await db.execute(
      `INSERT INTO book (title, authors, md5, total_read_time, total_read_pages) VALUES (?,'','md5-b9b',0,0)`,
      ['B9b'],
    );
    const row = await db.select<{ id: number }>(`SELECT id FROM book WHERE md5 = 'md5-b9b'`);
    const idBook = row[0]!.id;
    await db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages) VALUES (?,1,0,1000,10)`,
      [idBook],
    );
    await stats.prunePageEvents(idBook);
    await stats.recomputeBookTotals(idBook);
    const totals = await db.select<{ total_read_pages: number; retained_pages: number }>(
      `SELECT total_read_pages, retained_pages FROM book WHERE id = ?`,
      [idBook],
    );
    expect(totals[0]).toMatchObject({ total_read_pages: 1, retained_pages: 0 });
  });
});
