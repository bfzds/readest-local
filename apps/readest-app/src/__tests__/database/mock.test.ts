import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseService, DatabaseExecResult, DatabaseRow } from '@/types/database';

// ---------------------------------------------------------------------------
// Mock: NativeDatabaseService
// ---------------------------------------------------------------------------

vi.mock('tauri-plugin-turso', () => {
  const rows = new Map<string, DatabaseRow[]>();

  const mockDb = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      const insertTable = sql.match(/INTO\s+(\w+)/i)?.[1];
      const fromTable = sql.match(/FROM\s+(\w+)/i)?.[1];
      const table = insertTable ?? fromTable ?? '_default';
      if (/^INSERT/i.test(sql.trim())) {
        const existing = rows.get(table) ?? [];
        const id = existing.length + 1;
        existing.push({ id, value: params[0] ?? null });
        rows.set(table, existing);
        return { rowsAffected: 1, lastInsertId: id };
      }
      if (/^DELETE/i.test(sql.trim())) {
        const existing = rows.get(table) ?? [];
        rows.set(table, []);
        return { rowsAffected: existing.length, lastInsertId: 0 };
      }
      return { rowsAffected: 0, lastInsertId: 0 };
    }),
    select: vi.fn(async (sql: string) => {
      const table = sql.match(/FROM\s+(\w+)/i)?.[1] ?? '_default';
      return rows.get(table) ?? [];
    }),
    batch: vi.fn(async () => {}),
    close: vi.fn(async () => {
      rows.clear();
      return true;
    }),
  };

  return {
    Database: {
      load: vi.fn(async () => mockDb),
    },
    __mockDb: mockDb,
    __rows: rows,
  };
});

// ---------------------------------------------------------------------------
// Tests: NativeDatabaseService
// ---------------------------------------------------------------------------

describe('NativeDatabaseService', () => {
  let db: DatabaseService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('tauri-plugin-turso');
    (mod as unknown as { __rows: Map<string, DatabaseRow[]> }).__rows.clear();

    const { NativeDatabaseService } = await import('@/services/database/nativeDatabaseService');
    db = await NativeDatabaseService.open('sqlite:test.db');
  });

  it('execute() returns DatabaseExecResult for INSERT', async () => {
    const result: DatabaseExecResult = await db.execute('INSERT INTO items (value) VALUES (?)', [
      'hello',
    ]);
    expect(result.rowsAffected).toBe(1);
    expect(result.lastInsertId).toBeGreaterThan(0);
  });

  it('execute() returns DatabaseExecResult for DELETE', async () => {
    await db.execute('INSERT INTO items (value) VALUES (?)', ['a']);
    const result = await db.execute('DELETE FROM items');
    expect(result.rowsAffected).toBe(1);
  });

  it('select() returns typed row arrays', async () => {
    await db.execute('INSERT INTO items (value) VALUES (?)', ['alpha']);
    await db.execute('INSERT INTO items (value) VALUES (?)', ['beta']);

    const rows = await db.select<{ id: number; value: string }>('SELECT * FROM items');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(1);
    expect(rows[0]!.value).toBe('alpha');
    expect(rows[1]!.id).toBe(2);
    expect(rows[1]!.value).toBe('beta');
  });

  it('select() returns empty array when no rows', async () => {
    const rows = await db.select('SELECT * FROM empty_table');
    expect(rows).toEqual([]);
  });

  it('batch() delegates to underlying db.batch()', async () => {
    await db.batch(['CREATE TABLE t (id INTEGER)', 'INSERT INTO t VALUES (1)']);
    const mod = await import('tauri-plugin-turso');
    const mockDb = (mod as unknown as { __mockDb: { batch: ReturnType<typeof vi.fn> } }).__mockDb;
    expect(mockDb.batch).toHaveBeenCalledWith([
      'CREATE TABLE t (id INTEGER)',
      'INSERT INTO t VALUES (1)',
    ]);
  });

  it('close() delegates to underlying db.close()', async () => {
    await db.close();
    const mod = await import('tauri-plugin-turso');
    const mockDb = (mod as unknown as { __mockDb: { close: ReturnType<typeof vi.fn> } }).__mockDb;
    expect(mockDb.close).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: DatabaseExecResult shape
// ---------------------------------------------------------------------------

describe('DatabaseExecResult type contract', () => {
  it('has rowsAffected and lastInsertId properties', () => {
    const result: DatabaseExecResult = {
      rowsAffected: 5,
      lastInsertId: 42,
    };
    expect(result.rowsAffected).toBe(5);
    expect(result.lastInsertId).toBe(42);
  });
});
