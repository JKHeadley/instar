import type { Database } from 'better-sqlite3';

type CaptureResult = 'recorded' | 'duplicate' | 'conflict' | 'refused';

const referencePattern = /^telegram:[1-9]\d*:-?[1-9]\d*:[1-9]\d*:[1-9]\d*$/;
function validReference(reference: string): boolean {
  return typeof reference === 'string' && reference.length <= 80 && referencePattern.test(reference);
}

const digestPattern = /^[a-f0-9]{64}$/;

/** Stores only an authenticated polling record's coordinates and digest.
 * A disagreement permanently disqualifies the reference from this store.
 */
export class TelegramSendEvidenceStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_send_evidence (
        reference TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        conflicted INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  capture(reference: string, digest: string): CaptureResult {
    if (this.db.inTransaction || !validReference(reference) || typeof digest !== 'string' || !digestPattern.test(digest)) return 'refused';

    return this.db.transaction((): CaptureResult => {
      const current = this.db.prepare('SELECT digest, conflicted FROM telegram_send_evidence WHERE reference = ?')
        .get(reference) as { digest: string; conflicted: number } | undefined;
      if (!current) {
        this.db.prepare('INSERT INTO telegram_send_evidence (reference, digest) VALUES (?, ?)').run(reference, digest);
        return 'recorded';
      }
      if (current.conflicted) return 'conflict';
      if (current.digest === digest) return 'duplicate';
      this.db.prepare('UPDATE telegram_send_evidence SET conflicted = 1 WHERE reference = ?').run(reference);
      return 'conflict';
    }).immediate();
  }

  /** The authenticated ingress caller supplies the original message reference.
   * A tombstone also blocks capture when an edit is observed first.
   */
  invalidate(reference: string): boolean {
    if (this.db.inTransaction || !validReference(reference)) return false;
    this.db.prepare(`
      INSERT INTO telegram_send_evidence (reference, digest, conflicted)
      VALUES (?, '', 1)
      ON CONFLICT (reference) DO UPDATE SET conflicted = 1
    `).run(reference);
    return true;
  }

  matches(reference: string, digest: string): boolean {
    if (this.db.inTransaction) return false;
    return this.db.prepare('SELECT 1 FROM telegram_send_evidence WHERE reference = ? AND digest = ? AND conflicted = 0')
      .get(reference, digest) !== undefined;
  }
}
