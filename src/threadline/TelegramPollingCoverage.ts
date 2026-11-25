import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

interface CoverageAttempt {
  generation: string;
  cursor: number;
}

/** The caller establishes writer custody and authenticates the poll result. */
export class TelegramPollingCoverage {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_polling_coverage (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        drained INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  beginCatchUp(cursor: number): CoverageAttempt {
    if (this.db.inTransaction || !Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error('invalid polling coverage cursor');
    }
    const generation = randomUUID();
    this.db.prepare(`
      INSERT INTO telegram_polling_coverage (singleton, generation, cursor)
      VALUES (1, ?, ?)
      ON CONFLICT (singleton) DO UPDATE SET generation = excluded.generation,
        cursor = excluded.cursor, drained = 0
    `).run(generation, cursor);
    return { generation, cursor };
  }

  observeResult(attempt: CoverageAttempt, updateCount: number): boolean {
    if (this.db.inTransaction || !Number.isSafeInteger(updateCount) || updateCount < 0) return false;
    return this.db.prepare(`
      UPDATE telegram_polling_coverage SET generation = ?, drained = ?
      WHERE singleton = 1 AND generation = ? AND cursor = ? AND drained = 0
    `).run(updateCount === 0 ? attempt.generation : randomUUID(), updateCount === 0 ? 1 : 0,
      attempt.generation, attempt.cursor).changes === 1 && updateCount === 0;
  }

  close(): void {
    if (this.db.inTransaction) throw new Error('polling coverage close requires a top-level write');
    this.db.prepare('UPDATE telegram_polling_coverage SET generation = ?, drained = 0 WHERE singleton = 1')
      .run(randomUUID());
  }
}
