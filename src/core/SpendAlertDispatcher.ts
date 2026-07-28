/**
 * SpendAlertDispatcher — the Increment-C channel-abstracted alert layer of the
 * Routing Control Room (docs/specs/routing-control-room-spend-alerts.md,
 * §Surface 2 Alerts / FD-6 / Amendment 2).
 *
 * ONE dedicated topic, message-INTO not topic-PER: every spend alert lands in
 * the single "💰 Routing & Spend Alerts" topic (the `burnDetection.alertTopicId`
 * sendToTopic precedent) — deliberately NEVER `POST /attention` (topic-per-item
 * is the flood the operator directive forbids). The lifeline is the single
 * NAMED emergency exception (unresolvable topic / failed money-critical
 * delivery), never a second routine destination.
 *
 * Discipline (all BEFORE any channel send):
 *  - LANE-SCOPED dedup (S-F8): money-critical kinds (cap-hit, holder-dead)
 *    ride a DISTINCT dedupe lane from informational kinds (door-dark,
 *    fallback-spike, price/recon drift), so a flapping door's volume can never
 *    coalesce a money-critical cap alert into a digest line. Lanes govern
 *    COALESCING, never the destination.
 *  - EDGE latch per dedupeKey: latches ONLY on CONFIRMED delivery, so a
 *    transient failure stays eligible for re-send instead of permanently
 *    suppressed.
 *  - COALESCING: informational alerts within the digest window aggregate into
 *    ONE message per episode; money-critical alerts are never digested.
 *  - dryRun-FIRST (FD-16: Increment C ships dryRun-first live-on-dev): while
 *    dryRun holds, every decision is recorded to the scrubbed jsonl and
 *    NOTHING is delivered.
 *  - Scrubbed jsonl audit (S-F7): kind / lane / dedupeKey / decision / door /
 *    counts — NEVER a provider response/error body, never a key-shaped
 *    substring, never a token.
 */

import fs from 'node:fs';
import path from 'node:path';

export type SpendAlertKind =
  | 'stale-price'
  | 'observed-drift'
  | 'cap-approach'
  | 'cap-hit'
  | 'door-dark'
  | 'fallback-spike'
  | 'recon-drift'
  | 'holder-dead';

/** Money-critical kinds ride their own dedupe lane + the durable relay (S-F8/G5). */
export const MONEY_CRITICAL_KINDS: ReadonlySet<SpendAlertKind> = new Set(['cap-hit', 'holder-dead']);

export interface SpendAlert {
  kind: SpendAlertKind;
  /** Stable idempotency key — see the spec's per-kind dedupe-key shapes. */
  dedupeKey: string;
  /** Metadata-only, plain-English text (already scrubbed by the emitter). */
  text: string;
  /** Re-arm window override; default 24h informational / 6h money-critical. */
  reArmMs?: number;
}

export type DispatchDecision =
  | 'sent'
  | 'sent-lifeline'
  | 'queued-durable'
  | 'coalesced'
  | 'suppressed'
  | 'dry-run'
  | 'failed';

export interface DispatchResult {
  decision: DispatchDecision;
  lane: 'money-critical' | 'informational';
}

/**
 * A delivery channel (FD-6). Increment C ships TelegramSpendTopicChannel; a
 * future SlackSpendChannel is a registry entry + `alerts.channels` config add —
 * no dispatcher/emitter rework.
 */
export interface AlertChannel {
  readonly id: string;
  /**
   * Deliver one already-deduped, already-coalesced message. Returns true on
   * CONFIRMED delivery (the latch condition). `moneyCritical` lets the channel
   * pick the durable path.
   */
  deliver(text: string, moneyCritical: boolean): Promise<'sent' | 'sent-lifeline' | 'queued-durable' | 'failed'>;
}

export interface SpendAlertDispatcherOptions {
  channels: AlertChannel[];
  /** dryRun-first (FD-16): default TRUE — decisions audited, nothing delivered. */
  dryRun?: boolean;
  /** Digest window for informational coalescing (default 15 min). */
  digestWindowMs?: number;
  /** Scrubbed audit sink path (default `<logsDir>/routing-spend-alerts.jsonl`). */
  auditPath?: string;
  now?: () => number;
}

const DEFAULT_REARM_INFORMATIONAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REARM_MONEY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DIGEST_WINDOW_MS = 15 * 60 * 1000;

export class SpendAlertDispatcher {
  private readonly channels: AlertChannel[];
  private readonly dryRun: boolean;
  private readonly digestWindowMs: number;
  private readonly auditPath: string | null;
  private readonly now: () => number;

  /** Edge latches per lane (S-F8: distinct lanes so volumes can't cross-suppress). */
  private latched = new Map<string, number>(); // `${lane}|${dedupeKey}` → confirmed-at ms
  /** Pending informational digest: texts accumulated within the window. */
  private digestPending: Array<{ key: string; text: string }> = [];
  private digestTimer: ReturnType<typeof setTimeout> | null = null;
  private digestFlushInFlight = false;

  constructor(opts: SpendAlertDispatcherOptions) {
    this.channels = opts.channels;
    this.dryRun = opts.dryRun !== false; // default TRUE (FD-16 dryRun-first)
    this.digestWindowMs = opts.digestWindowMs ?? DEFAULT_DIGEST_WINDOW_MS;
    this.auditPath = opts.auditPath ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  laneOf(kind: SpendAlertKind): 'money-critical' | 'informational' {
    return MONEY_CRITICAL_KINDS.has(kind) ? 'money-critical' : 'informational';
  }

  /** Dispatch one alert through dedup → coalescing → channels. Never throws. */
  async dispatch(alert: SpendAlert): Promise<DispatchResult> {
    const lane = this.laneOf(alert.kind);
    try {
      const latchKey = `${lane}|${alert.dedupeKey}`;
      const reArm = alert.reArmMs ?? (lane === 'money-critical' ? DEFAULT_REARM_MONEY_MS : DEFAULT_REARM_INFORMATIONAL_MS);
      const last = this.latched.get(latchKey);
      if (last !== undefined && this.now() - last < reArm) {
        this.audit({ decision: 'suppressed', kind: alert.kind, lane, dedupeKey: alert.dedupeKey });
        return { decision: 'suppressed', lane };
      }
      if (this.dryRun) {
        // FD-16 soak: record the WOULD-send (with the latch set, so the soak
        // telemetry measures the real post-dedup volume) — deliver nothing.
        this.latched.set(latchKey, this.now());
        this.audit({ decision: 'dry-run', kind: alert.kind, lane, dedupeKey: alert.dedupeKey });
        return { decision: 'dry-run', lane };
      }
      if (lane === 'informational') {
        // Coalesce into ONE digest message per window (never for money-critical).
        this.digestPending.push({ key: alert.dedupeKey, text: alert.text });
        this.latched.set(latchKey, this.now()); // digested = handled; window re-arms it
        this.scheduleDigestFlush();
        this.audit({ decision: 'coalesced', kind: alert.kind, lane, dedupeKey: alert.dedupeKey, pending: this.digestPending.length });
        return { decision: 'coalesced', lane };
      }
      // Money-critical: immediate, never digested, durable path preferred.
      const outcome = await this.deliverThroughChannels(alert.text, true);
      if (outcome === 'sent' || outcome === 'sent-lifeline' || outcome === 'queued-durable') {
        this.latched.set(latchKey, this.now());
      }
      this.audit({ decision: outcome, kind: alert.kind, lane, dedupeKey: alert.dedupeKey });
      return { decision: outcome, lane };
    } catch (err) {
      // The dispatcher is a notifier — it must never throw into an emitter's
      // (or the gate's) call path. Audit and move on.
      this.audit({ decision: 'failed', kind: alert.kind, lane, dedupeKey: alert.dedupeKey, error: String(err).slice(0, 200) });
      return { decision: 'failed', lane };
    }
  }

  /** Flush any pending digest immediately (test hook + shutdown path). */
  async flushDigest(): Promise<void> {
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
    if (this.digestFlushInFlight || this.digestPending.length === 0) return;
    this.digestFlushInFlight = true;
    try {
      const items = this.digestPending.splice(0);
      const text =
        items.length === 1
          ? items[0].text
          : `📋 Routing spend digest (${items.length} notices):\n` + items.map((i) => `• ${i.text}`).join('\n');
      const outcome = await this.deliverThroughChannels(text, false);
      if (outcome === 'failed') {
        // Stay eligible: un-latch the digested keys so the next occurrence retries.
        for (const i of items) this.latched.delete(`informational|${i.key}`);
      }
      this.audit({ decision: `digest-${outcome}`, count: items.length });
    } finally {
      this.digestFlushInFlight = false;
    }
  }

  private scheduleDigestFlush(): void {
    if (this.digestTimer) return;
    this.digestTimer = setTimeout(() => {
      this.digestTimer = null;
      void this.flushDigest();
    }, this.digestWindowMs);
    this.digestTimer.unref?.();
  }

  private async deliverThroughChannels(text: string, moneyCritical: boolean): Promise<'sent' | 'sent-lifeline' | 'queued-durable' | 'failed'> {
    let best: 'sent' | 'sent-lifeline' | 'queued-durable' | 'failed' = 'failed';
    for (const ch of this.channels) {
      try {
        const r = await ch.deliver(text, moneyCritical);
        if (r === 'sent') return 'sent';
        if (r === 'queued-durable' && best === 'failed') best = 'queued-durable';
        if (r === 'sent-lifeline' && best === 'failed') best = 'sent-lifeline';
      } catch {
        // @silent-fallback-ok: one channel throwing must not break the others;
        // the terminal outcome (incl. all-failed) is audited by the caller.
      }
    }
    return best;
  }

  private audit(entry: Record<string, unknown>): void {
    if (!this.auditPath) return;
    try {
      fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
      fs.appendFileSync(this.auditPath, JSON.stringify({ ts: new Date(this.now()).toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch {
      // @silent-fallback-ok: the audit line is observability riding a
      // notification decision that already happened — never blocks dispatch.
    }
  }
}
