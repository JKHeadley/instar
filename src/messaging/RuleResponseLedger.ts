import Database from 'better-sqlite3';
import { scrubForStore } from '../core/durableSecretScrub.js';

const RULE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ACTIONS = ['none', 'learning-note', 'targeted-reminder', 'draft-check'] as const;

export class RuleResponseLedger {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('busy_timeout = 3000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_findings (
        rule TEXT NOT NULL, topic INTEGER NOT NULL, message INTEGER NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY (rule, topic, message)
      );
      CREATE TABLE IF NOT EXISTS draft_overrides (
        rule TEXT NOT NULL, topic INTEGER NOT NULL, draft_hash TEXT NOT NULL, reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL, PRIMARY KEY (rule, topic, draft_hash)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  response(rule: string) {
    if (!RULE_ID.test(rule)) throw new Error('invalid rule ID');
    const { total } = this.db.prepare('SELECT count(*) AS total FROM rule_findings WHERE rule = ?')
      .get(rule) as { total: number };
    return { rule, total, action: ACTIONS[Math.min(total, 3)] };
  }

  recordFinding(input: { rule: string; topic: number; message: number; confirmed: boolean }) {
    const { rule, topic, message, confirmed } = input;
    if (!RULE_ID.test(rule) || !Number.isSafeInteger(topic) || topic < 1 || !Number.isSafeInteger(message) || message < 1) {
      throw new Error('invalid finding coordinates');
    }
    return this.db.transaction(() => {
      const added = confirmed && this.db.prepare(
        'INSERT OR IGNORE INTO rule_findings VALUES (?, ?, ?, ?)',
      ).run(rule, topic, message, new Date().toISOString()).changes === 1;
      return { ...this.response(rule), added };
    }).immediate();
  }

  draftResponse(rule: string, topic: number, digest: string) {
    if (!Number.isSafeInteger(topic) || topic < 1 || !DIGEST.test(digest)) throw new Error('invalid draft coordinates');
    const response = this.response(rule);
    const row = this.db.prepare('SELECT reason FROM draft_overrides WHERE rule = ? AND topic = ? AND draft_hash = ?')
      .get(rule, topic, digest) as { reason: string } | undefined;
    return { ...response, overrideReason: row?.reason ?? null };
  }

  recordOverride(rule: string, topic: number, digest: string, reason: string) {
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 500) throw new Error('override reason required');
    const scrubbed = scrubForStore(reason.trim());
    if (scrubbed.error || !scrubbed.text) throw new Error('override reason could not be saved');
    return this.db.transaction(() => {
      const response = this.draftResponse(rule, topic, digest);
      if (response.action !== 'draft-check') throw new Error('rule has not reached draft checking');
      this.db.prepare('INSERT OR IGNORE INTO draft_overrides VALUES (?, ?, ?, ?, ?)')
        .run(rule, topic, digest, scrubbed.text, new Date().toISOString());
      return this.draftResponse(rule, topic, digest);
    }).immediate();
  }
}
