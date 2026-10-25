import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from './SqliteRegistry.js';

export type RecoveryDenial =
  | 'operator-stopped' | 'owner-changed' | 'newer-delivery' | 'session-active'
  | 'incarnation-changed' | 'delivery-not-exhausted' | 'breaker-open' | 'capability-expired'
  | 'recovery-already-recorded';

export interface RecoveryAuthoritySnapshot {
  operatorStopEpoch: number;
  observedOperatorStopEpoch: number;
  ownerEpoch: number;
  observedOwnerEpoch: number;
  latestOrdinal: number;
  deliveryOrdinal: number;
  sessionActive: boolean;
  incarnation: string;
  observedIncarnation: string;
  deliveryExhausted: boolean;
  breakerOpen: boolean;
}

export interface RecoveryCapability {
  id: string;
  conversationId: string;
  deliveryId: string;
  ownerEpoch: number;
  incarnation: string;
  expiresAt: number;
}

/** Deterministic, closed-world authority for the independently dark refresh path. */
export class RecoveryActuationAuthority {
  private readonly capabilities = new Map<string, RecoveryCapability & { consumed: boolean }>();
  private readonly db: BetterSqliteDatabase | null;

  constructor(db: BetterSqliteDatabase | null = null) {
    this.db = db;
    if (db) {
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = FULL');
      db.exec(`CREATE TABLE IF NOT EXISTS recovery_capability (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        owner_epoch INTEGER NOT NULL, incarnation TEXT NOT NULL, expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_recovery_capability_expiry ON recovery_capability(expires_at);
      CREATE TABLE IF NOT EXISTS recovery_effect (
        conversation_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        effect_type TEXT NOT NULL, capability_id TEXT NOT NULL,
        phase TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, delivery_id, effect_type)
      );`);
      db.prepare(`UPDATE recovery_effect SET phase = 'effect-unknown', updated_at = ?
        WHERE phase = 'publish-started'`).run(Date.now());
      registerSqliteHandle(() => { try { db.close(); } catch { /* already closed */ } });
    }
  }

  static open(stateDir: string): RecoveryActuationAuthority {
    const dbPath = path.join(stateDir, 'state', 'recovery-actuation.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
    db.pragma('journal_mode = WAL');
    return new RecoveryActuationAuthority(db);
  }

  authorize(input: RecoveryAuthoritySnapshot & { conversationId: string; deliveryId: string; now?: number; ttlMs?: number }):
    { ok: true; capability: RecoveryCapability } | { ok: false; reason: RecoveryDenial } {
    if (input.operatorStopEpoch !== input.observedOperatorStopEpoch) return { ok: false, reason: 'operator-stopped' };
    if (input.ownerEpoch !== input.observedOwnerEpoch) return { ok: false, reason: 'owner-changed' };
    if (input.latestOrdinal > input.deliveryOrdinal) return { ok: false, reason: 'newer-delivery' };
    if (input.sessionActive) return { ok: false, reason: 'session-active' };
    if (input.incarnation !== input.observedIncarnation) return { ok: false, reason: 'incarnation-changed' };
    if (!input.deliveryExhausted) return { ok: false, reason: 'delivery-not-exhausted' };
    if (input.breakerOpen) return { ok: false, reason: 'breaker-open' };
    if (this.db) {
      const prior = this.db.prepare(`SELECT 1 FROM recovery_effect
        WHERE conversation_id = ? AND delivery_id = ? AND effect_type = 'session-recovery'`).get(
        input.conversationId, input.deliveryId,
      );
      if (prior) return { ok: false, reason: 'recovery-already-recorded' };
    }
    const capability: RecoveryCapability = {
      id: crypto.randomUUID(), conversationId: input.conversationId, deliveryId: input.deliveryId,
      ownerEpoch: input.ownerEpoch, incarnation: input.incarnation,
      expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? 30_000),
    };
    if (this.db) {
      this.db.prepare(`INSERT INTO recovery_capability
        (id, conversation_id, delivery_id, owner_epoch, incarnation, expires_at, consumed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(
        capability.id, capability.conversationId, capability.deliveryId,
        capability.ownerEpoch, capability.incarnation, capability.expiresAt, input.now ?? Date.now(),
      );
    } else {
      this.capabilities.set(capability.id, { ...capability, consumed: false });
    }
    return { ok: true, capability };
  }

  /** FULL-durable effect journal around the external recovery publication. */
  publish(id: string, effect: () => boolean, now = Date.now()):
    { ok: true; requested: boolean } | { ok: false; reason: RecoveryDenial | 'invalid-capability' | 'capability-consumed' | 'effect-unknown' } {
    if (!this.db) {
      const consumed = this.consume(id, now);
      if (!consumed.ok) return consumed;
      try { return { ok: true, requested: effect() }; }
      catch { return { ok: false, reason: 'effect-unknown' }; }
    }
    const begun = this.db.transaction(() => {
      const row = this.db!.prepare('SELECT * FROM recovery_capability WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) return { ok: false as const, reason: 'invalid-capability' as const };
      if (Number(row.consumed) === 1) return { ok: false as const, reason: 'capability-consumed' as const };
      if (Number(row.expires_at) <= now) return { ok: false as const, reason: 'capability-expired' as const };
      try {
        this.db!.prepare(`INSERT INTO recovery_effect
          (conversation_id, delivery_id, effect_type, capability_id, phase, created_at, updated_at)
          VALUES (?, ?, 'session-recovery', ?, 'publish-started', ?, ?)`).run(
          row.conversation_id, row.delivery_id, id, now, now,
        );
      } catch {
        return { ok: false as const, reason: 'recovery-already-recorded' as const };
      }
      this.db!.prepare('UPDATE recovery_capability SET consumed = 1, consumed_at = ? WHERE id = ?').run(now, id);
      return { ok: true as const };
    }).immediate();
    if (!begun.ok) return begun;
    try {
      const requested = effect();
      this.db.prepare(`UPDATE recovery_effect SET phase = ?, updated_at = ? WHERE capability_id = ?`)
        .run(requested ? 'requested' : 'refused', Date.now(), id);
      return { ok: true, requested };
    } catch {
      this.db.prepare(`UPDATE recovery_effect SET phase = 'effect-unknown', updated_at = ? WHERE capability_id = ?`)
        .run(Date.now(), id);
      return { ok: false, reason: 'effect-unknown' };
    }
  }

  consume(id: string, now = Date.now()): { ok: true; capability: RecoveryCapability } | { ok: false; reason: RecoveryDenial | 'invalid-capability' | 'capability-consumed' } {
    if (this.db) {
      return this.db.transaction(() => {
        const row = this.db!.prepare('SELECT * FROM recovery_capability WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        if (!row) return { ok: false as const, reason: 'invalid-capability' as const };
        if (Number(row.consumed) === 1) return { ok: false as const, reason: 'capability-consumed' as const };
        if (Number(row.expires_at) <= now) return { ok: false as const, reason: 'capability-expired' as const };
        const changed = this.db!.prepare(`UPDATE recovery_capability SET consumed = 1, consumed_at = ?
          WHERE id = ? AND consumed = 0 AND expires_at > ?`).run(now, id, now).changes;
        if (changed !== 1) return { ok: false as const, reason: 'capability-consumed' as const };
        return { ok: true as const, capability: rowToCapability(row) };
      }).immediate();
    }
    const stored = this.capabilities.get(id);
    if (!stored) return { ok: false, reason: 'invalid-capability' };
    if (stored.consumed) return { ok: false, reason: 'capability-consumed' };
    if (stored.expiresAt <= now) return { ok: false, reason: 'capability-expired' };
    stored.consumed = true;
    const { consumed: _, ...capability } = stored;
    return { ok: true, capability };
  }

  status(now = Date.now()): { live: number; consumed: number; expired: number; durable: boolean; recoveryEffects?: Record<string, number> } {
    if (!this.db) {
      const rows = [...this.capabilities.values()];
      return {
        live: rows.filter((r) => !r.consumed && r.expiresAt > now).length,
        consumed: rows.filter((r) => r.consumed).length,
        expired: rows.filter((r) => !r.consumed && r.expiresAt <= now).length,
        durable: false,
      };
    }
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN consumed = 0 AND expires_at > ? THEN 1 ELSE 0 END) AS live,
      SUM(CASE WHEN consumed = 1 THEN 1 ELSE 0 END) AS consumed,
      SUM(CASE WHEN consumed = 0 AND expires_at <= ? THEN 1 ELSE 0 END) AS expired
      FROM recovery_capability`).get(now, now) as { live: number | null; consumed: number | null; expired: number | null };
    const effects = this.db.prepare('SELECT phase, COUNT(*) AS count FROM recovery_effect GROUP BY phase').all() as Array<{ phase: string; count: number }>;
    return { live: Number(row.live ?? 0), consumed: Number(row.consumed ?? 0), expired: Number(row.expired ?? 0), durable: true,
      recoveryEffects: Object.fromEntries(effects.map((e) => [e.phase, Number(e.count)])) };
  }

  close(): void {
    try { this.db?.close(); } catch { /* idempotent */ }
  }
}

function rowToCapability(row: Record<string, unknown>): RecoveryCapability {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), deliveryId: String(row.delivery_id),
    ownerEpoch: Number(row.owner_epoch), incarnation: String(row.incarnation), expiresAt: Number(row.expires_at),
  };
}
