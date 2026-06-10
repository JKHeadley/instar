/**
 * GrowthDigestPublisher — Slice 2 of the proactive growth analyst.
 *
 * WHY THIS EXISTS (Justin, 2026-06-06, topic 21624): "I have YET to have an agent
 * proactively check in with me about ANY of these." Slice 1
 * (GrowthMilestoneAnalyst) already COMPUTES the growth picture (R1–R6) and exposes
 * it via read routes — but nothing ever SENDS it. This component is the voice:
 * on a cadence it takes the analyst's already-computed `GrowthDigest`, decides
 * whether there is anything worth saying, formats ONE consolidated "growth
 * check-in," and routes it through the SAME flood-guarded post-update funnel the
 * `/telegram/post-update` route uses.
 *
 * It owns NO analysis. It is a cadence + lease-check + decide-to-speak + format +
 * deliver + audit wrapper. It can never block, delay, or rewrite anything — it
 * only sends a message or stays quiet. Spec:
 * docs/specs/PROACTIVE-GROWTH-DIGEST-PUBLISHER-SLICE2-SPEC.md.
 *
 * Hardened by the Slice-2 convergence review (§9):
 *  - MULTI-MACHINE: an in-process croner runs on BOTH the awake and the standby
 *    machine, so the digest would double-send. The publisher is lease-gated
 *    (`isAwake`) — only the awake machine sends (mirrors the scheduler /
 *    ActivitySentinel precedent the superseded job relied on).
 *  - SINGLE FUNNEL: the `send` dep is the shared res-free `evaluateOutbound` path
 *    (`postToUpdatesTopic`), never a raw `sendToTopic` — one guarded chokepoint,
 *    not two.
 *  - NO CALM NOISE: a fully-calm week is silent by default
 *    (`sendOnCalmWeeks:false`) — a weekly "all healthy" is the exact noise the
 *    operator killed burnDetection for.
 *  - MISSED-RUN CATCH-UP: croner schedules only the next fire; a fire that elapsed
 *    while the box was asleep is replayed once on `.start()` (the proactive
 *    check-in must not be silently dropped for a week). Idempotent on the window
 *    ISO so a restart loop can't re-fire the same window.
 */

import { Cron } from 'croner';
import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from './scrubSecrets.js';
import type { GrowthDigest, GrowthFinding, GrowthRuleId } from './GrowthMilestoneAnalyst.js';

export type GrowthDigestDelivery = 'off' | 'dry-run' | 'live';

export type GrowthDigestTrigger = 'cron' | 'catchup' | 'manual';

export interface DeliveryResult {
  ok: boolean;
  /** Why a non-send happened (dedup/budget/tone block, no-updates-topic, …). A
   *  block is a NORMAL outcome, never an error — the publisher never re-acts. */
  reason?: string;
}

export interface GrowthDigestAuditEntry {
  ts: string;
  action:
    | 'sent'
    | 'send-blocked'
    | 'dry-run'
    | 'skipped-standby'
    | 'skipped-off'
    | 'skipped-overlap'
    | 'skipped-calm'
    | 'error';
  trigger?: GrowthDigestTrigger;
  /** ISO of the scheduled window this cycle belongs to. The idempotency key for
   *  catch-up: recorded ONLY on a real post-lease decision (never on a pre-lease
   *  `skipped-standby`), so the awake machine still owns an un-consumed window. */
  window?: string;
  reason?: string;
  counts?: GrowthDigest['counts'];
  /** For `dry-run`: the EXACT message that WOULD have been sent (how the operator
   *  inspects a real sample before going live). */
  wouldSend?: string;
  /** §3.5 belt: on a live send while `initiative-digest-review` is still enabled,
   *  a SIGNAL (never a cross-component mutation) that the old voice should be
   *  disabled to avoid two voices on the same initiatives. */
  supersedeConflict?: boolean;
}

/** Refuse a cadence whose two soonest fires are < 1h apart — `buildDigest` is a
 *  synchronous, event-loop-blocking pass; a fat-fingered per-minute cron must not
 *  turn an observe-only-derived component into a CPU/disk churner (Scalability S2). */
const SANITY_FLOOR_MS = 60 * 60 * 1000;
const DEFAULT_SETTLE_MS = 60 * 1000;
const DEFAULT_PER_RULE_CAP = 5;
const DEFAULT_DETAIL_CAP = 200;
const TELEGRAM_MAX = 4096;

export interface GrowthDigestPublisherDeps {
  /** Bound to the live analyst (`(now) => analyst.buildDigest(now)`). */
  buildDigest: (now: Date) => GrowthDigest;
  /** `monitoring.growthAnalyst.digestCron` (default '0 11 * * 1'). */
  cron: string;
  /** Rollout stage. The publisher is only constructed when mode !== 'off'. */
  mode: GrowthDigestDelivery;
  /** IANA tz for BOTH the cron fire and the rendered header date (default UTC). */
  timezone?: string;
  /** Send on a fully-calm week? Default false (no "all healthy" heartbeat). */
  sendOnCalmWeeks?: boolean;
  /** The SINGLE guarded funnel to the Updates topic. Attached at route
   *  registration via `attachSender` (where `ctx`/the route helper lives). */
  send?: (text: string) => Promise<DeliveryResult>;
  /** Multi-machine lease gate — only the awake machine sends. Default no-op. */
  isAwake?: () => boolean;
  /** Append-one-JSON-line audit sink (default → logs/growth-digest.jsonl). */
  audit?: (entry: GrowthDigestAuditEntry) => void;
  /** The set of window ISOs already decided (for catch-up idempotency). */
  recordedWindows?: () => Set<string>;
  /** §3.5 belt: is the superseded `initiative-digest-review` job still enabled? */
  supersededJobStillEnabled?: () => boolean;
  now?: () => Date;
  onError?: (where: string, err: unknown) => void;
  /** Settle delay before the missed-run catch-up (default 60s — long enough for
   *  the multi-machine lease to settle so a freshly-booted machine that acquires
   *  the lease isn't wrongly skipped). */
  settleMs?: number;
  /** Formatter: low/normal bulk cap per rule (default 5). */
  perRuleCap?: number;
  /** Formatter: per-detail char cap (default 200). */
  detailCap?: number;
}

export class GrowthDigestPublisher {
  private readonly deps: GrowthDigestPublisherDeps;
  private readonly cron: string;
  private readonly mode: GrowthDigestDelivery;
  private readonly timezone?: string;
  private readonly sendOnCalmWeeks: boolean;
  private readonly settleMs: number;
  private readonly perRuleCap: number;
  private readonly detailCap: number;

  private sender?: (text: string) => Promise<DeliveryResult>;
  private cronTask: Cron | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(deps: GrowthDigestPublisherDeps) {
    this.deps = deps;
    this.cron = deps.cron;
    this.mode = deps.mode;
    this.timezone = deps.timezone;
    this.sendOnCalmWeeks = deps.sendOnCalmWeeks === true;
    this.sender = deps.send;
    this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
    this.perRuleCap = deps.perRuleCap ?? DEFAULT_PER_RULE_CAP;
    this.detailCap = deps.detailCap ?? DEFAULT_DETAIL_CAP;
  }

  private nowFn(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Attach the guarded sender after construction (route-registration time). */
  attachSender(send: (text: string) => Promise<DeliveryResult>): void {
    this.sender = send;
  }

  /** True once the cron task is scheduled (false if refused by the sanity-floor
   *  or an invalid cron). Used by wiring tests. */
  isStarted(): boolean {
    return this.cronTask !== null;
  }

  /**
   * Schedule the cadence + arm the missed-run catch-up. Idempotent. Refuses a
   * sub-hourly cadence (sanity-floor) and an invalid cron (both logged via
   * onError; the publisher simply does not start, which is the safe direction —
   * an observe-only-derived component never crashes the server).
   */
  start(): void {
    if (this.cronTask) return;
    if (!this.cadenceWithinFloor()) {
      this.deps.onError?.(
        'start',
        new Error(`digestCron '${this.cron}' fires more often than the 1h sanity-floor — refusing to start`),
      );
      return;
    }
    try {
      this.cronTask = new Cron(
        this.cron,
        { timezone: this.timezone, protect: true, unref: true },
        () => {
          void this.publishOnce(this.nowFn(), 'cron');
        },
      );
    } catch (err) {
      this.deps.onError?.('cron-construct', err);
      this.cronTask = null;
      return;
    }
    // Missed-run catch-up after the settle delay (so the lease has time to settle).
    this.settleTimer = setTimeout(() => {
      void this.catchUp();
    }, this.settleMs);
    if (typeof this.settleTimer.unref === 'function') this.settleTimer.unref();
  }

  /** Stop the cron + cancel a pending catch-up. Idempotent. */
  stop(): void {
    try {
      this.cronTask?.stop();
    } catch {
      /* @silent-fallback-ok — teardown is best-effort at shutdown */
    }
    this.cronTask = null;
    if (this.settleTimer) {
      try {
        clearTimeout(this.settleTimer);
      } catch {
        /* @silent-fallback-ok — teardown is best-effort at shutdown */
      }
      this.settleTimer = null;
    }
  }

  /** Replay a single fire time that elapsed while the box was down/asleep. */
  private async catchUp(): Promise<void> {
    const now = this.nowFn();
    const missed = this.previousScheduledFire(now);
    if (!missed) return;
    const key = missed.toISOString();
    let recorded: Set<string>;
    try {
      recorded = this.deps.recordedWindows ? this.deps.recordedWindows() : new Set<string>();
    } catch (err) {
      this.deps.onError?.('recordedWindows', err);
      recorded = new Set<string>();
    }
    if (recorded.has(key)) return; // this window was already published/decided
    await this.publishOnce(now, 'catchup', key);
  }

  /**
   * Run ONE cadence cycle. PUBLIC so tests (and a future debug route) can drive a
   * cycle deterministically. Never throws — an observe-only-derived component must
   * never crash the server, so every branch is wrapped and audited.
   */
  async publishOnce(now: Date, trigger: GrowthDigestTrigger, windowKey?: string): Promise<void> {
    // 1. Lease gate (pre-lease check — a standby machine never sends and never
    //    consumes the window; the awake machine still owns it).
    let awake = true;
    try {
      awake = this.deps.isAwake ? this.deps.isAwake() : true;
    } catch (err) {
      this.deps.onError?.('isAwake', err);
      awake = true; // fail-open toward delivery (the slice's reason to exist)
    }
    if (!awake) {
      this.record({ action: 'skipped-standby', trigger });
      return;
    }

    // Window key for idempotency (the scheduled fire this cycle covers).
    let window = windowKey;
    if (window === undefined) {
      window = this.previousScheduledFire(now)?.toISOString();
    }

    // 2. Mode off (belt — the publisher is only constructed when mode !== 'off').
    if (this.mode === 'off') {
      this.record({ action: 'skipped-off', trigger, window });
      return;
    }

    // 3. In-flight guard (belt-and-suspenders with croner protect:true, because
    //    publishOnce is also publicly callable).
    if (this.running) {
      this.record({ action: 'skipped-overlap', trigger, window });
      return;
    }
    this.running = true;
    try {
      // 4. Build the digest (heavy synchronous pass).
      let digest: GrowthDigest;
      try {
        digest = this.deps.buildDigest(now);
      } catch (err) {
        this.deps.onError?.('buildDigest', err);
        // No window recorded → catch-up may retry next boot (safe direction).
        this.record({ action: 'error', trigger, reason: 'build-error' });
        return;
      }

      // 5. Decide to speak.
      if (digest.calm && !this.sendOnCalmWeeks) {
        this.record({ action: 'skipped-calm', trigger, window, counts: digest.counts });
        return;
      }

      // 6. Format (scrubbed + capped + clamped).
      let text: string;
      try {
        text = formatDigest(digest, {
          timezone: this.timezone,
          perRuleCap: this.perRuleCap,
          detailCap: this.detailCap,
        });
      } catch (err) {
        this.deps.onError?.('formatDigest', err);
        this.record({ action: 'error', trigger, reason: 'format-error' });
        return;
      }

      // 7. Dry-run — record the would-send sample, never send.
      if (this.mode === 'dry-run') {
        this.record({ action: 'dry-run', trigger, window, counts: digest.counts, wouldSend: text });
        return;
      }

      // 8. Live — go through the shared guarded funnel.
      let result: DeliveryResult;
      try {
        result = this.sender ? await this.sender(text) : { ok: false, reason: 'no-sender' };
      } catch (err) {
        this.deps.onError?.('send', err);
        result = { ok: false, reason: 'send-threw' };
      }
      const entry: GrowthDigestAuditEntry = {
        ts: now.toISOString(),
        action: result.ok ? 'sent' : 'send-blocked',
        trigger,
        window,
        reason: result.reason,
        counts: digest.counts,
      };
      // §3.5 belt: a SIGNAL (never a mutation) that the old voice is still on.
      if (result.ok && this.deps.supersededJobStillEnabled) {
        try {
          if (this.deps.supersededJobStillEnabled()) entry.supersedeConflict = true;
        } catch (err) {
          this.deps.onError?.('supersededJobStillEnabled', err);
        }
      }
      this.record(entry);
    } finally {
      this.running = false;
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private record(e: Partial<GrowthDigestAuditEntry> & { action: GrowthDigestAuditEntry['action'] }): void {
    const entry: GrowthDigestAuditEntry = {
      ts: e.ts ?? this.nowFn().toISOString(),
      action: e.action,
      ...(e.trigger ? { trigger: e.trigger } : {}),
      ...(e.window ? { window: e.window } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.counts ? { counts: e.counts } : {}),
      ...(e.wouldSend ? { wouldSend: e.wouldSend } : {}),
      ...(e.supersedeConflict ? { supersedeConflict: true } : {}),
    };
    try {
      this.deps.audit?.(entry);
    } catch (err) {
      this.deps.onError?.('audit', err);
    }
  }

  /** True if the cadence's two soonest fires are ≥1h apart (or not computable). */
  private cadenceWithinFloor(): boolean {
    try {
      const c = new Cron(this.cron, this.timezone ? { timezone: this.timezone } : {});
      const f1 = c.nextRun(this.nowFn());
      if (!f1) return true;
      const f2 = c.nextRun(f1);
      if (!f2) return true;
      return f2.getTime() - f1.getTime() >= SANITY_FLOOR_MS;
    } catch {
      // @silent-fallback-ok — an invalid cron is re-caught + logged by start()'s
      // own `new Cron` (the authoritative report path); returning true here just
      // defers to it. Not a degradation — the floor check is a guard, not a sink.
      return true;
    }
  }

  /**
   * The most-recent scheduled fire time at/under `now`. croner's `previousRun()`
   * only tracks the instance's own executions (null on a fresh instance), so we
   * derive the cadence interval from two future `nextRun` probes and scan forward
   * from a bounded lookback to find the last fire ≤ now.
   */
  private previousScheduledFire(now: Date): Date | null {
    try {
      const c = new Cron(this.cron, this.timezone ? { timezone: this.timezone } : {});
      const f1 = c.nextRun(now);
      if (!f1) return null;
      const f2 = c.nextRun(f1);
      const intervalMs = f2 ? f2.getTime() - f1.getTime() : 7 * 86_400_000;
      const probe = new Date(now.getTime() - intervalMs * 2 - 60_000);
      let last: Date | null = null;
      let n = c.nextRun(probe);
      let guard = 0;
      while (n && n.getTime() <= now.getTime() && guard++ < 5000) {
        last = n;
        n = c.nextRun(n);
      }
      return last;
    } catch (err) {
      // @silent-fallback-ok — onError-surfaced; an uncomputable previous fire only
      // skips one catch-up (the safe direction for this observe-only-derived
      // publisher), never a wrong action. The weekly cron still fires normally.
      this.deps.onError?.('previousScheduledFire', err);
      return null;
    }
  }
}

// ── Formatter (pure, exported, NO LLM) ────────────────────────────────────────

export interface FormatDigestOptions {
  timezone?: string;
  perRuleCap?: number;
  detailCap?: number;
}

const RULE_ORDER: GrowthRuleId[] = ['R1', 'R6', 'R2', 'R3', 'R4', 'R5'];

const RULE_HEADER: Record<GrowthRuleId, string> = {
  R1: '🔸 Ready to promote',
  R2: '🔸 Incubation expired (unproven)',
  R3: '🔸 Stalling — waiting on you / drifting',
  R4: '🔸 Spec patterns',
  R5: '🔸 Recurring corrections',
  R6: '🔸 Dev-gated features still dark',
};

const FOOTER = 'Read the full digest anytime: GET /growth/digest (or the dashboard).';

/**
 * Render a `GrowthDigest` into ONE compact Telegram message. The analyst already
 * decided what crosses a rule — the formatter only renders it. Guarantees:
 *  - Priority-never-truncate: every `priority:'high'` finding and every
 *    decision-demanding maturity action (R1 promote, R6 dev-gate-dark) is rendered
 *    IN FULL, never capped.
 *  - Only the low/normal BULK is capped at `perRuleCap` per rule with a "+N more".
 *  - Cap-before-concat: bulk sections stop appending as the running length nears
 *    4096 — the full N-line string is never materialised then sliced.
 *  - Render-boundary scrub: every title/detail passes through `scrubSecrets`, and
 *    each detail is hard-capped to `detailCap` chars (covers dry-run text too).
 */
export function formatDigest(digest: GrowthDigest, opts: FormatDigestOptions = {}): string {
  const perRuleCap = opts.perRuleCap ?? DEFAULT_PER_RULE_CAP;
  const detailCap = opts.detailCap ?? DEFAULT_DETAIL_CAP;

  const header = `📊 Growth check-in — ${formatHeaderDate(digest.generatedAt, opts.timezone)}`;
  const summary = scrubSecrets(digest.summary);

  // Calm digest: header + summary only (the summary already carries the changing
  // incubating count + next-window-closes, so it is not byte-identical week/week).
  if (digest.calm || digest.findings.length === 0) {
    return clampToTelegram([header, '', summary].join('\n'));
  }

  // "Always full" = high-priority + decision-demanding (R1/R6). The rest is the
  // cappable bulk (R3 stalling is the volume driver).
  const alwaysFull = digest.findings.filter(isAlwaysFull);
  const bulk = digest.findings.filter((f) => !isAlwaysFull(f));

  const parts: string[] = [header, '', summary];

  // Mandatory sections first (never capped, never dropped).
  for (const rule of RULE_ORDER) {
    const rows = alwaysFull.filter((f) => f.rule === rule);
    if (rows.length === 0) continue;
    parts.push('', RULE_HEADER[rule] + ':');
    for (const f of rows) parts.push(renderFinding(f, detailCap));
  }

  // Bulk sections — capped per rule, and cap-before-concat against 4096.
  const footerReserve = FOOTER.length + 8;
  let truncatedBulk = false;
  for (const rule of RULE_ORDER) {
    const rows = bulk.filter((f) => f.rule === rule);
    if (rows.length === 0) continue;
    const sectionLines: string[] = ['', RULE_HEADER[rule] + ':'];
    const shown = rows.slice(0, perRuleCap);
    for (const f of shown) sectionLines.push(renderFinding(f, detailCap));
    if (rows.length > perRuleCap) {
      sectionLines.push(`  +${rows.length - perRuleCap} more (see full digest)`);
    }
    const projected = parts.join('\n').length + sectionLines.join('\n').length + 1 + footerReserve;
    if (projected > TELEGRAM_MAX) {
      truncatedBulk = true;
      break;
    }
    parts.push(...sectionLines);
  }

  if (truncatedBulk) {
    parts.push('', '…(more findings — full digest at /growth/digest)');
  }
  parts.push('', FOOTER);

  return clampToTelegram(parts.join('\n'));
}

function isAlwaysFull(f: GrowthFinding): boolean {
  return f.priority === 'high' || f.rule === 'R1' || f.rule === 'R6';
}

function renderFinding(f: GrowthFinding, detailCap: number): string {
  const title = scrubSecrets(f.title);
  let detail = scrubSecrets(f.detail);
  if (detail.length > detailCap) detail = detail.slice(0, detailCap - 1) + '…';
  return `• ${title} — ${detail}`;
}

function formatHeaderDate(iso: string, timezone?: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: timezone || 'UTC',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Hard-clamp to Telegram's 4096 limit. Only engages if the mandatory (always-full)
 *  set alone somehow exceeds it — bulk is already cap-before-concat'd. */
function clampToTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX) return text;
  const note = '\n…(truncated — full digest at /growth/digest)';
  return text.slice(0, TELEGRAM_MAX - note.length) + note;
}

/** Default audit sink + window-reader over logs/growth-digest.jsonl. The publisher
 *  injects `audit` (write) and `recordedWindows` (read) from this so the same file
 *  is the durable "did we publish this window?" record. */
export function createGrowthDigestAuditSink(stateDir: string): {
  write: (entry: GrowthDigestAuditEntry) => void;
  recordedWindows: () => Set<string>;
  logPath: string;
} {
  const logPath = path.join(stateDir, 'logs', 'growth-digest.jsonl');
  return {
    logPath,
    write(entry: GrowthDigestAuditEntry): void {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
      } catch {
        /* never throw from the audit sink */
      }
    },
    recordedWindows(): Set<string> {
      const out = new Set<string>();
      let raw: string;
      try {
        raw = fs.readFileSync(logPath, 'utf-8');
      } catch {
        return out; // no log yet → no windows decided
      }
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t) as Partial<GrowthDigestAuditEntry>;
          if (e && typeof e.window === 'string') out.add(e.window);
        } catch {
          /* skip a corrupt/partial line */
        }
      }
      return out;
    },
  };
}
