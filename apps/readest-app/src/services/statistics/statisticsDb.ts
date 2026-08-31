import type { AppService } from '@/types/system';
import type { DatabaseService, DatabaseRow } from '@/types/database';
import type { PageStatEvent, StatBook } from '@/types/statistics';

interface BookRow extends DatabaseRow {
  id: number;
  title: string;
  authors: string;
  md5: string;
  total_read_time: number;
  total_read_pages: number;
  last_open: number;
  pages: number;
}

type CursorKey = 'push' | 'pull';

/**
 * Per-tab singleton open promise. OPFS permits only ONE access handle per file
 * across the whole origin, so a second `connect()` to statistics.db throws
 * `NoModificationAllowedError`. Every ReadingStatsTracker instance (and split-
 * view books) must therefore share a single connection — we memoise the open
 * and never thrash it.
 */
let sharedDb: Promise<StatisticsDb> | null = null;
let lifecycleBound = false;

function bindLifecycle(): void {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  // Fold the WAL into the main db when the tab is backgrounded/closed — the
  // most reliable point for best-effort async OPFS work before teardown.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && sharedDb) {
      void sharedDb.then((s) => s.checkpoint()).catch(() => {});
    }
  });
}

/**
 * Typed wrapper over the KOReader-compatible `statistics.db`. All identity is
 * keyed on `book_hash` (= Book.hash); the local autoincrement `id_book` never
 * leaves this class.
 */
export class StatisticsDb {
  /**
   * Per-book cap on retained `page_stat_data` rows (SF12). Page events accrue
   * one row per (page, start_time), so a frequently re-read book grows without
   * bound. The only production consumer, getMedianPageDurationSecs, reads the
   * 50 most recent rows, so pruning to this cap is safe.
   */
  static readonly MAX_PAGE_EVENTS_PER_BOOK = 10_000;

  // Serializes applyRemoteEvents so two concurrent pulls can't nest BEGINs.
  private applyRemoteLock: Promise<void> = Promise.resolve();

  private constructor(private readonly db: DatabaseService) {}

  /** Production entry point — opens + migrates statistics.db (per-tab singleton). */
  static async open(appService: AppService): Promise<StatisticsDb> {
    bindLifecycle();
    if (!sharedDb) {
      const opening = (async () => {
        const db = await appService.openDatabase('statistics', 'statistics.db', 'Data');
        return new StatisticsDb(db);
      })();
      sharedDb = opening;
      void opening.catch(() => {
        if (sharedDb === opening) sharedDb = null;
      });
    }
    return sharedDb;
  }

  /** Test/advanced entry point — wrap an already-migrated DatabaseService. */
  static from(db: DatabaseService): StatisticsDb {
    return new StatisticsDb(db);
  }

  /**
   * Fold the WAL into the main db file and truncate it. The Turso engine does
   * NOT implement `PRAGMA wal_autocheckpoint` (so there's no auto threshold to
   * rely on), but `wal_checkpoint(TRUNCATE)` works — verified folding a 688 KB
   * WAL back to 0 B. We call this when the tab is hidden so the WAL stays bounded.
   */
  async checkpoint(): Promise<void> {
    await this.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** Checkpoint, close the underlying connection, and reset the singleton. */
  async close(): Promise<void> {
    try {
      await this.checkpoint();
    } catch {
      // best-effort — a checkpoint failure must not block close
    }
    await this.db.close();
    sharedDb = null;
  }

  async upsertBook(book: StatBook): Promise<number> {
    const existing = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      book.bookMd5,
    ]);
    if (existing[0]) {
      // md5 is the identity; keep the latest title/authors (LWW, matches server stat_books).
      await this.db.execute(`UPDATE book SET title = ?, authors = ? WHERE id = ?`, [
        book.title,
        book.authors,
        existing[0].id,
      ]);
      return existing[0].id;
    }
    await this.db.execute(
      `INSERT INTO book (title, authors, md5, notes, last_open, highlights, pages, total_read_time, total_read_pages)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)
       ON CONFLICT(title, authors, md5) DO NOTHING`,
      [book.title, book.authors, book.bookMd5],
    );
    const rows = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      book.bookMd5,
    ]);
    return rows[0]!.id;
  }

  async insertPageEvent(
    idBook: number,
    e: { page: number; startTime: number; duration: number; totalPages: number },
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id_book, page, start_time)
       DO UPDATE SET duration = max(duration, excluded.duration), total_pages = excluded.total_pages`,
      [idBook, e.page, e.startTime, e.duration, e.totalPages],
    );
  }

  async prunePageEvents(idBook: number): Promise<void> {
    const keep = StatisticsDb.MAX_PAGE_EVENTS_PER_BOOK;
    // Skip the DELETE when the book hasn't outgrown the cap (a no-op scan on
    // every flush costs the same as the guard, but avoids a modifying query
    // and lets un-capped books stay untouched).
    const countRows = await this.db.select<{ c: number }>(
      `SELECT COUNT(*) AS c FROM page_stat_data WHERE id_book = ?`,
      [idBook],
    );
    if ((countRows[0]?.c ?? 0) <= keep) return;
    // D-10：裁剪的"累计 retained + DELETE"做成单事务，中途失败整体回滚，
    // 避免 retained 已累计而 DELETE 未执行（或反之）的计数不一致。
    await this.db.execute('BEGIN');
    try {
      // 删行前先把将被删除的（最老）事件 duration 并入 retained_read_time。
      // 否则下次 recompute 会把 total_read_time 重投影成"现存行之和"，历史累计
      // 随裁剪回缩（SF12 后续修复）。
      const archived = await this.db.select<{ sumDuration: number | null }>(
        `SELECT SUM(duration) AS sumDuration
           FROM (
             SELECT duration FROM page_stat_data
             WHERE id_book = ? ORDER BY start_time DESC LIMIT -1 OFFSET ?
           )`,
        [idBook, keep],
      );
      await this.db.execute(
        `UPDATE book SET retained_read_time = retained_read_time + COALESCE(?, 0) WHERE id = ?`,
        [archived[0]?.sumDuration ?? 0, idBook],
      );
      // B-9：被裁剪事件里的页面（去重后）也可能在保留区仍出现 —— 只累计
      // "被删页集合 − 保留区还在的页" 的净新增页数，避免重复累计与回缩。
      await this.db.execute(
        `UPDATE book SET retained_pages = retained_pages + (
           SELECT COUNT(DISTINCT deleted.page) FROM (
             SELECT page FROM page_stat_data
             WHERE id_book = ? ORDER BY start_time DESC LIMIT -1 OFFSET ?
           ) deleted
           WHERE deleted.page NOT IN (
             SELECT page FROM page_stat_data
             WHERE id_book = ? ORDER BY start_time DESC LIMIT ?
           )
         )
         WHERE id = ?`,
        [idBook, keep, idBook, keep, idBook],
      );
      await this.db.execute(
        'DELETE FROM page_stat_data WHERE id_book = ? AND rowid NOT IN (SELECT rowid FROM page_stat_data WHERE id_book = ? ORDER BY start_time DESC LIMIT ?)',
        [idBook, idBook, keep],
      );
      await this.db.execute('COMMIT');
    } catch (err) {
      await this.db.execute('ROLLBACK');
      throw err;
    }
  }

  async recomputeBookTotals(idBook: number): Promise<void> {
    await this.db.execute(
      `UPDATE book SET
         total_read_time  = COALESCE(retained_read_time, 0) + COALESCE((SELECT SUM(duration) FROM page_stat_data WHERE id_book = ?), 0),
         total_read_pages = COALESCE(retained_pages, 0) + COALESCE((SELECT COUNT(DISTINCT page) FROM page_stat_data WHERE id_book = ?), 0),
         last_open        = COALESCE((SELECT MAX(start_time + duration) FROM page_stat_data WHERE id_book = ?), last_open),
         pages            = COALESCE((SELECT total_pages FROM page_stat_data WHERE id_book = ? ORDER BY start_time DESC LIMIT 1), pages)
       WHERE id = ?`,
      [idBook, idBook, idBook, idBook, idBook],
    );
  }

  /**
   * Returns the median duration of time spent on each page in seconds. Returns
   * `null` if sufficient data is not available.
   *
   * Use the median since reading times are skewed; thus the median must be
   * used to get the middle value.
   */
  async getMedianPageDurationSecs(idBook: number): Promise<number | null> {
    const PAGE_THRESHOLD = 5;
    const rows = await this.db.select<{ duration: number }>(
      `SELECT duration
         FROM page_stat_data
         WHERE id_book = ?
         ORDER BY start_time DESC
         LIMIT 50`,
      [idBook],
    );
    if (rows.length < PAGE_THRESHOLD) return null;
    // The query orders by recency; sort by value so the middle is the true median.
    const pageDurations = rows.map((d) => d['duration']).sort((a, b) => a - b);
    const mid = Math.floor(pageDurations.length / 2);
    return pageDurations.length % 2 !== 0
      ? (pageDurations[mid] ?? 0)
      : ((pageDurations[mid - 1] ?? 0) + (pageDurations[mid] ?? 0)) / 2;
  }

  async getBookByMd5(md5: string): Promise<BookRow | null> {
    const rows = await this.db.select<BookRow>(`SELECT * FROM book WHERE md5 = ? LIMIT 1`, [md5]);
    return rows[0] ?? null;
  }

  /**
   * Ensure a book row exists for an event whose metadata record isn't in the
   * current batch (paged pull can deliver an event before its `stat_books`
   * record). Unlike `upsertBook`, this NEVER overwrites an existing real title
   * with the hash placeholder — the real record, arriving in any page, wins.
   */
  private async ensureBookId(bookMd5: string): Promise<number> {
    const existing = await this.db.select<BookRow>(`SELECT id FROM book WHERE md5 = ? LIMIT 1`, [
      bookMd5,
    ]);
    if (existing[0]) return existing[0].id;
    return this.upsertBook({ bookMd5, title: bookMd5, authors: '' });
  }

  /** Events with start_time > cursor, joined to their md5, for pushing. */
  async getEventsForPush(
    sinceStartTime: number,
  ): Promise<{ events: PageStatEvent[]; books: StatBook[] }> {
    const rows = await this.db.select<DatabaseRow>(
      `SELECT b.md5 AS bookMd5, b.title AS title, b.authors AS authors,
              p.page AS page, p.start_time AS startTime, p.duration AS duration, p.total_pages AS totalPages
       FROM page_stat_data p JOIN book b ON b.id = p.id_book
       WHERE p.start_time > ?
       ORDER BY p.start_time ASC`,
      [sinceStartTime],
    );
    const events: PageStatEvent[] = rows.map((r) => ({
      bookMd5: String(r['bookMd5']),
      page: Number(r['page']),
      startTime: Number(r['startTime']),
      duration: Number(r['duration']),
      totalPages: Number(r['totalPages']),
    }));
    const bookMap = new Map<string, StatBook>();
    for (const r of rows) {
      const md5 = String(r['bookMd5']);
      if (!bookMap.has(md5)) {
        bookMap.set(md5, {
          bookMd5: md5,
          title: String(r['title']),
          authors: String(r['authors']),
        });
      }
    }
    return { events, books: [...bookMap.values()] };
  }

  async applyRemoteEvents(books: StatBook[], events: PageStatEvent[]): Promise<void> {
    if (books.length === 0 && events.length === 0) return;
    // Serialize against other pulls: the statistics connection is shared across
    // ReadingStatsTracker instances (split view), and a second concurrent pull
    // would open a BEGIN inside this one's still-open BEGIN ("cannot start a
    // transaction within a transaction", READEST-N). The per-op native
    // lock can't make this multi-statement transaction atomic on its own.
    const prev = this.applyRemoteLock;
    let release!: () => void;
    this.applyRemoteLock = new Promise<void>((resolve) => (release = resolve));
    await prev;
    try {
      // One transaction for the whole pulled batch: a single commit instead of
      // O(rows) fsyncs, and the apply is atomic (a failed pull leaves no partial
      // state). Critical when a fresh device backfills tens of thousands of rows.
      await this.db.execute('BEGIN');
      try {
        const idByMd5 = new Map<string, number>();
        for (const b of books) idByMd5.set(b.bookMd5, await this.upsertBook(b));
        // Books referenced only by events (no metadata record) get a placeholder row.
        // 先对缺失的 bookMd5 去重后一次性补齐 id，避免逐事件往返。
        const missing = new Set<string>();
        for (const e of events) {
          if (!idByMd5.has(e.bookMd5)) missing.add(e.bookMd5);
        }
        for (const md5 of missing) {
          idByMd5.set(md5, await this.ensureBookId(md5));
        }
        const touched = new Set<number>();
        const eventRows: Array<[number, number, number, number, number]> = [];
        for (const e of events) {
          const id = idByMd5.get(e.bookMd5)!;
          eventRows.push([id, e.page, e.startTime, e.duration, e.totalPages]);
          touched.add(id);
        }
        // P-10：逐事件 INSERT 攒成 VALUES 多行分块插入（SQLite 参数上限内），
        // 大 pull 从 O(events) 次 IPC 收敛到 O(events/100)。
        const ROWS_PER_BATCH = 100;
        for (let i = 0; i < eventRows.length; i += ROWS_PER_BATCH) {
          const chunk = eventRows.slice(i, i + ROWS_PER_BATCH);
          const rowsPlaceholder = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
          await this.db.execute(
            `INSERT INTO page_stat_data (id_book, page, start_time, duration, total_pages)
             VALUES ${rowsPlaceholder}
             ON CONFLICT(id_book, page, start_time)
             DO UPDATE SET duration = max(duration, excluded.duration),
                           total_pages = excluded.total_pages`,
            chunk.flat(),
          );
        }
        // recompute 聚合为一条 correlated UPDATE，替代逐 id 多次往返。
        if (touched.size > 0) {
          const ids = [...touched];
          const idsPlaceholder = ids.map(() => '?').join(', ');
          await this.db.execute(
            `UPDATE book SET
               total_read_time  = COALESCE(retained_read_time, 0) + COALESCE((SELECT SUM(duration) FROM page_stat_data WHERE id_book = book.id), 0),
               total_read_pages = COALESCE(retained_pages, 0) + COALESCE((SELECT COUNT(DISTINCT page) FROM page_stat_data WHERE id_book = book.id), 0),
               last_open        = COALESCE((SELECT MAX(start_time + duration) FROM page_stat_data WHERE id_book = book.id), last_open),
               pages            = COALESCE((SELECT total_pages FROM page_stat_data WHERE id_book = book.id ORDER BY start_time DESC LIMIT 1), pages)
             WHERE id IN (${idsPlaceholder})`,
            ids,
          );
        }
        await this.db.execute('COMMIT');
      } catch (err) {
        await this.db.execute('ROLLBACK');
        throw err;
      }
    } finally {
      release();
    }
  }

  async getCursor(key: CursorKey): Promise<number> {
    const rows = await this.db.select<{ value: number }>(
      `SELECT value FROM readest_stat_sync_state WHERE key = ?`,
      [key],
    );
    return rows[0]?.value ?? 0;
  }

  async setCursor(key: CursorKey, value: number): Promise<void> {
    await this.db.execute(
      `INSERT INTO readest_stat_sync_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}
