/**
 * WS5.2 (ws52-operator-tap-not-text Part B, R3.3) — durable operator-message outbox.
 *
 * The cross-model pass (codex) flagged that "exactly one tappable link / one failure
 * message" is unachievable across mesh redelivery, fronting-machine restart, and
 * retry WITHOUT a durable, idempotent outbox. This store guarantees AT MOST ONE
 * visible operator message PER LEDGER STATE: the first claim for a
 * (ledgerKey, state) pair emits; every later claim for the SAME (ledgerKey, state)
 * — a redelivery, a restart replay, a retry — is suppressed. A genuine state
 * TRANSITION (enroll-in-flight → login-issued → failed) is a new (ledgerKey, state)
 * key, so each distinct state surfaces its own single message.
 *
 * fs-backed (the DeliveredMandateStore pattern), pure + unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface OperatorOutboxRecord {
  /** `${ledgerKey}::${state}` — the dedup unit (one message per ledger state). */
  dedupKey: string;
  /** The event that first emitted for this (ledgerKey,state) — audit + idempotency. */
  eventId: string;
  ledgerKey: string;
  state: string;
  emittedAt: string;
}

export interface OperatorOutboxDeps {
  filePath: string;
  now?: () => number;
}

export class AccountFollowMeOperatorOutbox {
  private readonly d: OperatorOutboxDeps;
  constructor(deps: OperatorOutboxDeps) {
    this.d = deps;
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private dedupKey(ledgerKey: string, state: string): string {
    return `${ledgerKey}::${state}`;
  }

  private readAll(): OperatorOutboxRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf8'));
      return Array.isArray(raw) ? (raw as OperatorOutboxRecord[]) : [];
    } catch {
      // @silent-fallback-ok — no outbox yet ⇒ nothing emitted ⇒ first claim should emit.
      return [];
    }
  }

  private writeAll(records: OperatorOutboxRecord[]): void {
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.writeFileSync(this.d.filePath, JSON.stringify(records, null, 2));
  }

  /**
   * Atomically decide whether to emit an operator message for this (ledgerKey,state).
   * Returns `{ emit:true }` exactly once per (ledgerKey,state) — the FIRST caller
   * records and emits; every subsequent caller (redelivery/restart/retry, regardless
   * of eventId) gets `{ emit:false }`. This is the "at most one message per ledger
   * state" guarantee.
   */
  claimEmit(args: { ledgerKey: string; state: string; eventId: string }): {
    emit: boolean;
    firstEventId: string;
  } {
    const key = this.dedupKey(args.ledgerKey, args.state);
    const all = this.readAll();
    const existing = all.find((r) => r.dedupKey === key);
    if (existing) {
      return { emit: false, firstEventId: existing.eventId };
    }
    const record: OperatorOutboxRecord = {
      dedupKey: key,
      eventId: args.eventId,
      ledgerKey: args.ledgerKey,
      state: args.state,
      emittedAt: new Date(this.now()).toISOString(),
    };
    this.writeAll([...all, record]);
    return { emit: true, firstEventId: args.eventId };
  }

  /** Has a message already been emitted for this (ledgerKey,state)? (read-only) */
  hasEmitted(ledgerKey: string, state: string): boolean {
    return this.readAll().some((r) => r.dedupKey === this.dedupKey(ledgerKey, state));
  }

  /** Drop all outbox records for a ledger key (e.g. when the pair is removed/revoked). Idempotent. */
  clearLedger(ledgerKey: string): void {
    const all = this.readAll();
    const next = all.filter((r) => r.ledgerKey !== ledgerKey);
    if (next.length !== all.length) this.writeAll(next);
  }

  list(): OperatorOutboxRecord[] {
    return this.readAll();
  }
}
