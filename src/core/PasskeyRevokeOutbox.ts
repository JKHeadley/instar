/**
 * PasskeyRevokeOutbox — durable re-delivery of SIGNED `passkey-cell` revokes to peer machines
 * (spec docs/specs/agent-held-google-passkey.md §3.2 "Revoke is carried by the mandate outbox",
 * FD15 "Revokes never silently expire").
 *
 * A revoke only removes authority, so the SAME signed bundle (same principal, `issuedAt`, nonce)
 * is re-delivered unchanged until the peer applies it. The outbox is:
 *   - DURABLE: `<stateDir>/state/passkey-revoke-outbox.json`, atomic writes, 0600; attempts and the
 *     next-attempt time survive a restart, so a restart never resets the backoff;
 *   - DEDUPLICATED per (cell, op), latest-wins: a newer revoke for the same cell replaces the older
 *     pending bundle;
 *   - BACKED OFF per (peer, revoke): 1h, 6h, then daily. A peer-online observation may bring the next
 *     attempt FORWARD, never below a 15-minute floor after the last attempt;
 *   - BREAKERED: 30 days after `issuedAt` without an applied acknowledgement the entry ESCALATES — one
 *     aggregated HIGH attention item per affected machine (key `passkey-incomplete-revoke:<machineId>`,
 *     listing every such cell) — and automatic re-delivery stops, apart from ONE attempt in total when
 *     the peer is next observed online (recorded as `postBreakerAttemptAt` so a flapping peer cannot
 *     re-trigger it);
 *   - CLOSED on the peer's applied ack, on an operator dismissal at the peer, or when the operator
 *     closes it after Google-side removal is verified/attested (a later increment's op).
 *
 * This file carries a self-triggered retry loop, so it is a registered self-action controller
 * (`passkey-revoke-outbox` in src/testing/selfActionRegistry.ts): under sustained rejection the
 * emit count is bounded by the backoff schedule up to the 30-day breaker (+1), horizon-independent.
 *
 * Machine-local BY DESIGN (§12): each issuing machine re-delivers its own revokes. (Lease-holder
 * takeover of a lost issuer's outbox rides the replicated `passkeyTombstones` store — a later
 * increment; while that store is dark the outbox lives on the issuing machine only, an accepted
 * Rung-1 residual per §3.2.)
 */
/* @self-action-controller: passkey-revoke-outbox */
import fs from 'node:fs';
import path from 'node:path';
import type { PortablePasskeyCellMandate } from './PasskeyCellMandate.js';

export const PASSKEY_REVOKE_OUTBOX_FILE = path.join('state', 'passkey-revoke-outbox.json');
/** Backoff after the 1st, 2nd and every later failed attempt. */
export const OUTBOX_BACKOFF_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const;
/** A peer-online observation may pull the next attempt forward, but never below this floor. */
export const OUTBOX_ONLINE_FLOOR_MS = 15 * 60_000;
export const OUTBOX_BREAKER_MS = 30 * 24 * 60 * 60_000;
export const OUTBOX_MAX_ATTEMPTS_PER_TICK = 10;

export type OutboxEntryState = 'pending' | 'applied' | 'escalated' | 'closed';

export interface OutboxEntry {
  /** `<canonicalEmail>@<targetMachineId>` */
  key: string;
  canonicalEmail: string;
  targetMachineId: string;
  op: 'revoke';
  principal: string;
  issuedAt: string;
  nonce: string;
  /** The exact signed bundle re-delivered unchanged. */
  portable: PortablePasskeyCellMandate;
  /** The cutoff the issuer named (null = the peer applies its own current instance). */
  cutoffSeq: number | null;
  state: OutboxEntryState;
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastResult?: string;
  appliedAt?: string;
  escalatedAt?: string;
  /** Set when the single post-breaker attempt was spent. */
  postBreakerAttemptAt?: string;
  /** True once the peer has been observed OFFLINE since the last attempt — arms exactly one forward pull on the next online observation (edge, not level). */
  peerSeenOfflineSinceAttempt?: boolean;
  /** False while the escalation's attention item still has to be raised (the raise is retried each tick until it lands). */
  escalationNotified?: boolean;
  closedAt?: string;
  closedReason?: string;
  enqueuedAt: string;
}

interface OutboxFile { version: 1; entries: Record<string, OutboxEntry> }

export type DeliveryOutcome =
  | { kind: 'applied'; detail?: unknown }
  | { kind: 'dismissed'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'unreachable'; reason: string };

export interface PasskeyRevokeOutboxDeps {
  stateDir: string;
  /** Deliver a signed bundle to a peer; must classify the outcome and never throw. */
  deliver: (targetMachineId: string, portable: PortablePasskeyCellMandate) => Promise<DeliveryOutcome>;
  /** Is the peer currently observed online (registry/heartbeat)? Unknown ⇒ false. */
  peerOnline: (machineId: string) => boolean;
  /** Raise/refresh the aggregated HIGH item for a machine's incomplete revokes. May return a promise. */
  raiseIncompleteRevoke: (item: { id: string; machineId: string; cells: string[]; body: string }) => unknown;
  /** Called once a peer applied the revoke (e.g. forget the issued peer-grant copy). */
  onApplied?: (entry: OutboxEntry) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface OutboxTickResult {
  attempted: string[];
  applied: string[];
  escalated: string[];
  closed: string[];
}

export class PasskeyRevokeOutbox {
  private readonly file: string;
  private readonly d: PasskeyRevokeOutboxDeps;
  private readonly now: () => number;
  private ticking = false;
  /** One in-flight delivery at a time — shared by `tick` and `attemptNow` so the same bundle is never sent twice concurrently. */
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(deps: PasskeyRevokeOutboxDeps) {
    this.d = deps;
    this.file = path.join(deps.stateDir, PASSKEY_REVOKE_OUTBOX_FILE);
    this.now = deps.now ?? Date.now;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  list(): OutboxEntry[] { return Object.values(this.read().entries).map((e) => ({ ...e })); }
  get(key: string): OutboxEntry | null { const e = this.read().entries[key]; return e ? { ...e } : null; }
  pending(): OutboxEntry[] { return this.list().filter((e) => e.state === 'pending' || e.state === 'escalated'); }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /** Enqueue (latest-wins per cell). Returns the stored entry. The first attempt is due immediately. */
  enqueue(input: { canonicalEmail: string; targetMachineId: string; principal: string; portable: PortablePasskeyCellMandate; cutoffSeq: number | null }): OutboxEntry {
    const key = `${input.canonicalEmail}@${input.targetMachineId}`;
    const data = this.read();
    const at = new Date(this.now()).toISOString();
    const entry: OutboxEntry = {
      key, canonicalEmail: input.canonicalEmail, targetMachineId: input.targetMachineId, op: 'revoke',
      principal: input.principal, issuedAt: input.portable.body.issuedAt, nonce: input.portable.body.nonce,
      portable: input.portable, cutoffSeq: input.cutoffSeq, state: 'pending', attempts: 0, nextAttemptAt: at, enqueuedAt: at,
    };
    data.entries[key] = entry;
    this.write(data);
    return { ...entry };
  }

  /** Operator/verified closure (e.g. Google-side removal verified or attested). */
  close(key: string, reason: string): boolean {
    const data = this.read();
    const e = data.entries[key];
    if (!e || e.state === 'closed') return false;
    e.state = 'closed'; e.closedAt = new Date(this.now()).toISOString(); e.closedReason = reason;
    this.write(data);
    return true;
  }

  /** Attempt ONE entry now (the PIN route's synchronous first try). Honors nothing but existence. */
  async attemptNow(key: string): Promise<OutboxEntry | null> {
    const e = this.read().entries[key];
    if (!e || e.state === 'closed' || e.state === 'applied') return e ? { ...e } : null;
    await this.serialized(() => this.attempt(e.key));
    return this.get(key);
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.inflight.then(fn, fn);
    this.inflight = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The self-triggered loop: re-deliver due entries, escalate breakered ones, spend the single
   * post-breaker attempt when the peer is next seen online. Single-flight; bounded per tick.
   */
  async tick(): Promise<OutboxTickResult> {
    const result: OutboxTickResult = { attempted: [], applied: [], escalated: [], closed: [] };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      return await this.serialized(() => this.tickBody(result));
    } finally {
      this.ticking = false;
    }
  }

  private async tickBody(result: OutboxTickResult): Promise<OutboxTickResult> {
    {
      const now = this.now();
      let budget = OUTBOX_MAX_ATTEMPTS_PER_TICK;
      for (const e of this.list()) {
        if (budget <= 0) break;
        if (e.state === 'closed' || e.state === 'applied') continue;
        const issued = Date.parse(e.issuedAt);
        const breakered = Number.isFinite(issued) && now - issued >= OUTBOX_BREAKER_MS;
        if (e.state === 'pending' && breakered) {
          await this.escalate(e.key);
          result.escalated.push(e.key);
          // fall through: the escalated entry may still get its one post-breaker attempt below
        }
        const cur = this.read().entries[e.key];
        if (!cur) continue;
        const online = this.d.peerOnline(cur.targetMachineId);
        if (!online && !cur.peerSeenOfflineSinceAttempt) this.mark(cur.key, { peerSeenOfflineSinceAttempt: true });
        if (cur.state === 'escalated') {
          if (cur.escalationNotified === false) await this.raise(cur.key);
          if (cur.postBreakerAttemptAt || !online) continue;
          budget -= 1;
          result.attempted.push(cur.key);
          const out = await this.attempt(cur.key, { postBreaker: true });
          if (out === 'applied') result.applied.push(cur.key);
          if (out === 'closed') result.closed.push(cur.key);
          continue;
        }
        const due = Date.parse(cur.nextAttemptAt);
        const lastAt = cur.lastAttemptAt ? Date.parse(cur.lastAttemptAt) : Number.NEGATIVE_INFINITY;
        // EDGE-triggered forward pull (spec §3.2 "a peer-online EVENT"): only when the peer was observed
        // offline since the last attempt and is online now — one pull per offline→online transition,
        // never below the floor. A peer that stays online-but-refusing follows the plain backoff.
        const onlinePull = online && cur.peerSeenOfflineSinceAttempt === true && now - lastAt >= OUTBOX_ONLINE_FLOOR_MS;
        if (now < due && !onlinePull) continue;
        budget -= 1;
        result.attempted.push(cur.key);
        const out = await this.attempt(cur.key);
        if (out === 'applied') result.applied.push(cur.key);
        if (out === 'closed') result.closed.push(cur.key);
      }
      return result;
    }
  }

  private mark(key: string, patch: Partial<OutboxEntry>): void {
    const data = this.read();
    const e = data.entries[key];
    if (!e) return;
    Object.assign(e, patch);
    this.write(data);
  }

  private async attempt(key: string, opts: { postBreaker?: boolean } = {}): Promise<'applied' | 'closed' | 'failed'> {
    const before = this.read().entries[key];
    if (!before) return 'failed';
    let outcome: DeliveryOutcome;
    try {
      outcome = await this.d.deliver(before.targetMachineId, before.portable);
    } catch (err) {
      outcome = { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) };
    }
    const data = this.read();
    const e = data.entries[key];
    if (!e) return 'failed';
    const at = new Date(this.now()).toISOString();
    e.attempts += 1;
    e.lastAttemptAt = at;
    e.peerSeenOfflineSinceAttempt = false;
    if (opts.postBreaker) e.postBreakerAttemptAt = at;
    switch (outcome.kind) {
      case 'applied':
        e.state = 'applied'; e.appliedAt = at; e.lastResult = 'applied';
        this.write(data);
        try { this.d.onApplied?.({ ...e }); } catch (err) { this.d.log?.(`[passkey-outbox] onApplied hook failed: ${err instanceof Error ? err.message : String(err)}`); }
        return 'applied';
      case 'dismissed':
        e.state = 'closed'; e.closedAt = at; e.closedReason = `dismissed-at-peer:${outcome.reason}`; e.lastResult = outcome.reason;
        this.write(data);
        return 'closed';
      default: {
        e.lastResult = `${outcome.kind}:${outcome.reason}`;
        // A permanent refusal (bad signature, wrong target) is NOT retried into the breaker: it is
        // named, and the operator re-issues. Unreachable / issuer-not-yet-trusted keep backing off.
        const permanent = outcome.kind === 'refused' && /bad-signature|target-not-this-machine|not-a-passkey-cell-mandate|unknown-op|malformed|ttl-too-long/.test(outcome.reason);
        if (permanent) {
          e.state = 'closed'; e.closedAt = at; e.closedReason = `permanent-refusal:${outcome.reason}`;
          this.write(data);
          this.d.log?.(`[passkey-outbox] ${key} closed on permanent refusal ${outcome.reason} — re-issue a fresh revoke`);
          return 'closed';
        }
        if (e.state === 'pending') {
          const idx = Math.min(e.attempts - 1, OUTBOX_BACKOFF_MS.length - 1);
          e.nextAttemptAt = new Date(this.now() + OUTBOX_BACKOFF_MS[idx]).toISOString();
        }
        this.write(data);
        return 'failed';
      }
    }
  }

  private async escalate(key: string): Promise<void> {
    const data = this.read();
    const e = data.entries[key];
    if (!e || e.state !== 'pending') return;
    e.state = 'escalated'; e.escalatedAt = new Date(this.now()).toISOString(); e.escalationNotified = false;
    this.write(data);
    await this.raise(key);
  }

  /**
   * Raise/refresh the ONE aggregated item for the entry's machine (every escalated cell for it). The
   * sink must UPSERT (refresh the body, reopen a resolved row); the flag is cleared only when the sink
   * returned without throwing, so a failed raise is retried on the next tick.
   */
  private async raise(key: string): Promise<void> {
    const data = this.read();
    const e = data.entries[key];
    if (!e || e.state !== 'escalated') return;
    const cells = Object.values(data.entries).filter((x) => x.targetMachineId === e.targetMachineId && x.state === 'escalated').map((x) => x.canonicalEmail).sort();
    const body = `A passkey revoke for ${cells.length} account cell(s) on machine ${e.targetMachineId} has not been acknowledged for 30 days: `
      + `${cells.join(', ')}. That machine may still hold the passkey. Until it is removed on Google (the digest will carry the link), `
      + `the key remains usable by whoever holds that machine. Automatic re-delivery has stopped; one more attempt runs when the machine next comes online.`;
    try {
      await this.d.raiseIncompleteRevoke({ id: `passkey-incomplete-revoke:${e.targetMachineId}`, machineId: e.targetMachineId, cells, body });
      // Every escalated entry for this machine is now represented by the refreshed item.
      const fresh = this.read();
      for (const x of Object.values(fresh.entries)) if (x.targetMachineId === e.targetMachineId && x.state === 'escalated') x.escalationNotified = true;
      this.write(fresh);
    } catch (err) {
      this.d.log?.(`[passkey-outbox] attention raise failed for ${e.targetMachineId} (will retry next tick): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── File I/O ──────────────────────────────────────────────────────────────

  private read(): OutboxFile {
    if (!fs.existsSync(this.file)) return { version: 1, entries: {} };
    let parsed: Partial<OutboxFile>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<OutboxFile>;
    } catch (err) {
      throw new Error(`passkey-revoke-outbox-unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') throw new Error('passkey-revoke-outbox-unreadable: unexpected shape');
    return { version: 1, entries: parsed.entries };
  }

  private write(data: OutboxFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
