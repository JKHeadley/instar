/**
 * SpendAlertResolver — the MINIMAL topic-resolver foundation + the two
 * Increment-B alert kinds (stale-price / observed-drift) of the Routing Control
 * Room (docs/specs/routing-control-room-spend-alerts.md, §Surface 2 Alerts,
 * C5-5 sequencing: stale pricing changes money ADMISSION behavior, so its alarm
 * ships WITH the money increment; the full channel abstraction + the remaining
 * emitter set are Increment C).
 *
 * Resolution LADDER (first hit wins; only the last rung creates):
 *  1. Operator-configured `routingSpend.alerts.telegramTopicId` — that id IS the
 *     topic; nothing is ever created.
 *  2. The machine-local persisted record (the `persistLifelineTopicId` pattern).
 *     (The pool-published half of rung 2 rides the machine-registry heartbeat
 *     surface and lands with Increment C — tracked: CMT-1929.)
 *  3. Create ONCE — ONLY when this machine is the CONFIRMED serving-lease holder
 *     (fenced; lease re-confirmed within the same bounded staleness window the
 *     money gate uses) — as a bounded create-once SYSTEM topic. In-process
 *     single-flight guards a burst of first-alerts.
 *  Anyone who cannot resolve/create falls back to the LIFELINE — fail toward
 *  the lifeline, never toward a possible duplicate.
 *
 * Emission discipline: edge-triggered per dedupe key (an alert latches only on
 * a CONFIRMED send, so a transient failure stays eligible for re-send);
 * metadata-only text (door / age-days / threshold — NEVER a provider body or a
 * key-shaped substring).
 */

export interface SpendAlert {
  /** Informational lane in B (stale-price / observed-drift). Money-critical lanes land in C. */
  kind: 'stale-price' | 'observed-drift';
  dedupeKey: string;
  text: string;
}

export interface SpendAlertResolverDeps {
  /** Rung 1: the operator-configured topic id (config-read, live). */
  configuredTopicId: () => number | undefined;
  /** Rung 2 (machine-local half): read/persist the auto-created id. */
  readPersistedTopicId: () => number | undefined;
  persistTopicId: (topicId: number) => void;
  /** Rung 3 gate: ms since the serving lease was POSITIVELY re-confirmed (null = not holder / unconfirmed). */
  servingLeaseConfirmedAgoMs: () => number | null;
  /** Create the bounded create-once system topic; returns its id. */
  createTopic: () => Promise<number>;
  /** Deliver one message into a topic; resolves true on CONFIRMED send. */
  sendToTopic: (topicId: number, text: string) => Promise<boolean>;
  /** The lifeline fallback topic id (always-existing system topic), if resolvable. */
  lifelineTopicId: () => number | undefined;
  /** Scrubbed observability sink (jsonl line per emission/decision). */
  audit?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

/** The same bounded staleness window the money gate uses (N-2). */
export const SERVING_LEASE_WINDOW_MS = 60_000;

export class SpendAlertResolver {
  private readonly d: SpendAlertResolverDeps;
  private readonly now: () => number;
  /** Edge-trigger latch: dedupeKey → last CONFIRMED emission ms. */
  private latched = new Map<string, number>();
  /** In-process single-flight for topic creation. */
  private creating: Promise<number | undefined> | null = null;

  constructor(deps: SpendAlertResolverDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Resolve the dedicated topic id via the ladder — or undefined (caller falls back to lifeline). */
  async resolveTopicId(): Promise<number | undefined> {
    const configured = this.d.configuredTopicId();
    if (typeof configured === 'number' && Number.isFinite(configured)) return configured;
    const persisted = this.d.readPersistedTopicId();
    if (typeof persisted === 'number' && Number.isFinite(persisted)) return persisted;
    // Rung 3: create once — serving-lease-holder-only, fenced, single-flight.
    const confirmedAgo = this.d.servingLeaseConfirmedAgoMs();
    if (confirmedAgo === null || confirmedAgo > SERVING_LEASE_WINDOW_MS) {
      this.d.audit?.({ decision: 'no-create', reason: 'not-confirmed-serving-lease-holder', confirmedAgo });
      return undefined; // fail toward the lifeline, never toward a possible duplicate
    }
    if (!this.creating) {
      this.creating = (async () => {
        try {
          const id = await this.d.createTopic();
          this.d.persistTopicId(id);
          this.d.audit?.({ decision: 'created', topicId: id });
          return id;
        } catch (err) {
          // @silent-fallback-ok: audited create-failure — the caller falls back to
          // the LIFELINE (fail toward the lifeline, never toward a possible duplicate).
          this.d.audit?.({ decision: 'create-failed', error: String(err) });
          return undefined;
        } finally {
          this.creating = null;
        }
      })();
    }
    return this.creating;
  }

  /**
   * Emit one alert: dedicated topic first, lifeline on ANY failure (unset,
   * create-refused, send-failed). Edge-triggered — a dedupe key that already
   * emitted (confirmed) within `reArmMs` is suppressed; the latch only sets on
   * CONFIRMED delivery, so a transient failure stays eligible.
   */
  async emit(alert: SpendAlert, reArmMs = 24 * 60 * 60 * 1000): Promise<'sent' | 'sent-lifeline' | 'suppressed' | 'failed'> {
    const last = this.latched.get(alert.dedupeKey);
    if (last !== undefined && this.now() - last < reArmMs) {
      this.d.audit?.({ decision: 'suppressed', dedupeKey: alert.dedupeKey });
      return 'suppressed';
    }
    const topicId = await this.resolveTopicId();
    if (topicId !== undefined) {
      try {
        if (await this.d.sendToTopic(topicId, alert.text)) {
          this.latched.set(alert.dedupeKey, this.now());
          this.d.audit?.({ decision: 'sent', topicId, kind: alert.kind, dedupeKey: alert.dedupeKey });
          return 'sent';
        }
      } catch {
        // @silent-fallback-ok: fall through to the LIFELINE delivery below — the
        // designed path for a set-but-wrong id (never a black hole); the terminal
        // outcome is audited ('sent-lifeline' or 'failed', which stays re-eligible).
      }
    }
    const lifeline = this.d.lifelineTopicId();
    if (lifeline !== undefined) {
      try {
        if (await this.d.sendToTopic(lifeline, alert.text)) {
          this.latched.set(alert.dedupeKey, this.now());
          this.d.audit?.({ decision: 'sent-lifeline', kind: alert.kind, dedupeKey: alert.dedupeKey });
          return 'sent-lifeline';
        }
      } catch {
        // audited below — never throws into the caller's cadence
      }
    }
    this.d.audit?.({ decision: 'failed', kind: alert.kind, dedupeKey: alert.dedupeKey });
    return 'failed'; // NOT latched — stays eligible for the next tick
  }
}

/**
 * Build the two Increment-B alert kinds from the price authority's staleness /
 * drift view for the metered doors. Metadata-only wording (S-F7).
 */
export function buildStalePriceAlert(door: string, ageDays: number, slaDays: number): SpendAlert {
  return {
    kind: 'stale-price',
    dedupeKey: `spend-stale-price:${door}`,
    text:
      `⚠️ Routing price freshness: the reviewed price for ${door} is ${Math.floor(ageDays)} days old ` +
      `(SLA ${slaDays}d). Spending on this door books conservatively until a fresh price is promoted — ` +
      `review the Spend tab's promote flow.`,
  };
}

export function buildObservedDriftAlert(door: string, modelId: string, driftPct: number): SpendAlert {
  const dir = driftPct > 0 ? 'above' : 'below';
  return {
    kind: 'observed-drift',
    dedupeKey: `spend-observed-drift:${door}:${modelId}`,
    text:
      `📈 Price drift observed: ${door} ${modelId} — the provider-published price is ~${Math.abs(Math.round(driftPct))}% ` +
      `${dir} the reviewed price the books use. Promote the observed price (PIN) if it's genuine.`,
  };
}
