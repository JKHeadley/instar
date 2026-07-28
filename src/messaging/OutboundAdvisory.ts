/**
 * OutboundAdvisory — the inform-only preflight surface for automated senders.
 *
 * Spec: docs/specs/outbound-jargon-filepath-gap.md (§2.4, §2.4(5), §2.4(6)).
 *
 * Three responsibilities, all strictly non-blocking:
 *
 * 1. **Advisory composition** (`composeAdvisories`) — run the deterministic
 *    detectors (jargon, raw-file-path, localhost-link) over a candidate text
 *    and return static-guidance advisories. No LLM call, fail-OPEN per
 *    detector, guidance keyed by code (never derived from message content —
 *    injection-pinned), detector match rendered only as an inert bounded
 *    token by the consumer.
 *
 * 2. **Audit** (`recordPreflight` / `recordAck`) — the SERVER is the single
 *    writer of `logs/outbound-advisory.jsonl`: one O_APPEND write per line,
 *    `{ts, topicId, jobSlug, kind, textHash, advisories, action}` with
 *    action `clean | advised | acked`. Size-rotated (single rollover to
 *    `.1` at the byte cap). The script writes NOTHING here.
 *
 * 3. **Repeated-ignore escalation** — the load-bearing bound on the design's
 *    worst failure mode (a sender silently dropping its own flagged
 *    message). Fed by an in-memory write-time index (no poller, no file
 *    scan; resets on restart are accepted best-effort observability):
 *    - per-SIGNATURE (jobSlug, topicId, sorted code set) unresolved-advised
 *      count in a rolling window, NOT reset by interleaved clean rows for
 *      other messages (the reset-gaming case);
 *    - a signature resolves on an `acked` with the same codes, or a `clean`
 *      preflight of the same message — "same message" judged by token-set
 *      similarity (the fix re-send is near-identical), never by exact hash
 *      alone;
 *    - a per-jobSlug AGGREGATE (across topics, higher threshold) covers
 *      one-shot senders whose topics vary;
 *    - a preemptive-ack consumer: N consecutive acked-with-NONEMPTY
 *      advisories per signature raises too (a job habitually overriding
 *      instead of fixing is operator-relevant).
 *    Escalation INFORMS THE OPERATOR (one deduped Attention item with the
 *    FIXED sourceContext 'outbound-advisory-escalation' so the per-source
 *    topic budget genuinely binds — P17). It never gates the sender.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectJargon } from '../core/JargonDetector.js';
import { detectRawFilePath } from '../core/raw-file-path.js';
import { detectLocalhostLink } from '../core/localhost-link.js';
import { detectTimeClaimContradiction, type TimeClaimClock } from '../core/time-claim.js';

// ── Advisory composition ────────────────────────────────────────────────

export type AdvisoryCode = 'JARGON' | 'RAW_FILE_PATH' | 'LOCALHOST_LINK' | 'TIME_CLAIM';

export interface Advisory {
  code: AdvisoryCode;
  /** Bounded inert detector match (≤120 chars) — data, never instructions. */
  match?: string;
  /** STATIC guidance keyed by code — never derived from message content. */
  guidance: string;
}

/** Static guidance table — injection-pinned by construction. */
const GUIDANCE: Record<AdvisoryCode, string> = {
  JARGON:
    'This automated message uses internal developer jargon the user may not understand or be able to act on. ' +
    'Restate it in plain English from the user’s perspective (what is wrong / what happened, not which internal component did it).',
  RAW_FILE_PATH:
    'This automated message shows the user a literal file path they usually cannot open or act on. ' +
    'Describe the file conceptually, or publish the content as a private view and send the link instead.',
  LOCALHOST_LINK:
    'This message contains a machine-local (localhost/loopback) link the user cannot open from their device. ' +
    'IMPORTANT: the server’s pre-existing deterministic guard will refuse a raw localhost link REGARDLESS of --ack-advisory — ' +
    'acknowledging this advisory will NOT deliver it. Replace the link with the public tunnel URL (GET /tunnel → url + path) before re-sending.',
  TIME_CLAIM:
    'This message states an elapsed/remaining time for this topic’s active time-boxed session that contradicts the live session clock. ' +
    'Never estimate time — read GET /session/clock (Bearer auth) and quote its numbers exactly, then re-send with the corrected figure.',
};

/** Analyzed-text cap (consistent with the pipeline's downstream rejects). */
export const PREFLIGHT_TEXT_CAP = 64 * 1024;

export interface ComposeAdvisoryOptions {
  /**
   * Active session clock(s) for the sending topic (caller resolves them —
   * this module stays pure). Absent/empty → the TIME_CLAIM detector is a
   * no-op. Spec: time-claim verification rides the same inform-only slot
   * (operator mandate 2026-06-12, topic 13481).
   */
  sessionClocks?: ReadonlyArray<TimeClaimClock>;
}

/**
 * The TIME_CLAIM detector alone — used for NON-automated (conversational
 * session) preflights, where the jargon/path detectors deliberately do NOT
 * apply (over-block concern, outbound-jargon-filepath-gap §4 Q2) but a time
 * claim contradicting the live clock is wrong regardless of message kind.
 * Fail-OPEN like every detector.
 */
export function composeTimeClaimAdvisories(
  text: string,
  sessionClocks: ReadonlyArray<TimeClaimClock> | undefined,
): Advisory[] {
  if (!sessionClocks || sessionClocks.length === 0) return [];
  try {
    const input =
      typeof text === 'string'
        ? text.length > PREFLIGHT_TEXT_CAP
          ? text.slice(0, PREFLIGHT_TEXT_CAP)
          : text
        : '';
    const tc = detectTimeClaimContradiction(input, sessionClocks);
    if (tc.detected) {
      return [
        {
          code: 'TIME_CLAIM',
          match: tc.match ? tc.match.slice(0, 120) : undefined,
          guidance: GUIDANCE.TIME_CLAIM,
        },
      ];
    }
  } catch {
    /* @silent-fallback-ok — fail-open by spec contract (outbound-jargon-filepath-gap §2.3): a detector error skips the signal, never withholds a message */
  }
  return [];
}

/**
 * Run the deterministic detectors over a candidate text. Each detector is
 * individually fail-OPEN: a throw skips that signal and never withholds.
 */
export function composeAdvisories(text: string, opts?: ComposeAdvisoryOptions): Advisory[] {
  const input =
    typeof text === 'string'
      ? text.length > PREFLIGHT_TEXT_CAP
        ? text.slice(0, PREFLIGHT_TEXT_CAP)
        : text
      : '';
  const advisories: Advisory[] = [];

  try {
    const j = detectJargon(input);
    if (j.detected) {
      advisories.push({
        code: 'JARGON',
        match: (j.terms ?? []).slice(0, 8).join(', ').slice(0, 120) || undefined,
        guidance: GUIDANCE.JARGON,
      });
    }
  } catch {
    /* @silent-fallback-ok — fail-open by spec contract (outbound-jargon-filepath-gap §2.3): a detector error skips the signal, never withholds a message */
  }

  try {
    const fp = detectRawFilePath(input);
    if (fp.detected) {
      advisories.push({ code: 'RAW_FILE_PATH', match: fp.match, guidance: GUIDANCE.RAW_FILE_PATH });
    }
  } catch {
    /* @silent-fallback-ok — fail-open by spec contract (outbound-jargon-filepath-gap §2.3): a detector error skips the signal, never withholds a message */
  }

  try {
    const ll = detectLocalhostLink(input);
    if (ll.detected) {
      advisories.push({
        code: 'LOCALHOST_LINK',
        match: ll.match ? ll.match.slice(0, 120) : undefined,
        guidance: GUIDANCE.LOCALHOST_LINK,
      });
    }
  } catch {
    /* @silent-fallback-ok — fail-open by spec contract (outbound-jargon-filepath-gap §2.3): a detector error skips the signal, never withholds a message */
  }

  advisories.push(...composeTimeClaimAdvisories(input, opts?.sessionClocks));

  return advisories;
}

// ── Audit + escalation ─────────────────────────────────────────────────

export type AdvisoryAction = 'clean' | 'advised' | 'acked';

export interface AdvisoryAuditEntry {
  ts: string;
  topicId: number;
  jobSlug: string;
  kind: string;
  textHash: string;
  advisories: string[];
  action: AdvisoryAction;
}

export interface AttentionRaiser {
  (item: {
    id: string;
    title: string;
    summary: string;
    category: string;
    priority: 'HIGH' | 'NORMAL' | 'LOW';
    description?: string;
    sourceContext?: string;
  }): Promise<unknown> | unknown;
}

export interface OutboundAdvisoryAuditOptions {
  /** Absolute path of the JSONL audit file (e.g. <root>/logs/outbound-advisory.jsonl). */
  logPath: string;
  /** Size-rotation cap in bytes (single rollover to `.1`). Default 10MB. */
  maxLogBytes?: number;
  /** Per-signature unresolved-advised threshold (live-read). Default 3. */
  getIgnoreThreshold?: () => number;
  /** Per-jobSlug aggregate threshold (live-read). Default 5. */
  getSlugThreshold?: () => number;
  /** Operator-inform surface. Absent → escalation is a no-op (audit still writes). */
  raiseAttention?: AttentionRaiser;
}

/** Fixed sourceContext — P17: the per-source topic budget must genuinely bind. */
export const ADVISORY_ESCALATION_SOURCE = 'outbound-advisory-escalation';

interface AdvisedEpisode {
  ts: number;
  textHash: string;
  /** Token-set fingerprint for near-identical (fix-landing) matching. */
  tokens: Set<number>;
  codes: string[];
}

interface SignatureState {
  jobSlug: string;
  topicId: number;
  codesKey: string;
  unresolved: AdvisedEpisode[];
  consecutiveAcksWithAdvisories: number;
  escalatedIgnore: boolean;
  escalatedAck: boolean;
}

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h rolling window
const MAX_SIGNATURES = 500; // memory bound
// Near-identical threshold for the fix-landing resolution: a real fix
// (replace a path with words, restate jargon) keeps roughly half the token
// set (measured ~0.47 on the founding incident shape), while an unrelated
// clean heartbeat from the same job scores ~0.05–0.1. 0.4 separates the two
// cases with margin on both sides.
const NEAR_IDENTICAL_JACCARD = 0.4;
const RECENT_PREFLIGHT_WINDOW_MS = 10 * 60 * 1000; // §2.1 spoof-correlation window

function tokenFingerprint(text: string): Set<number> {
  const out = new Set<number>();
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const w of words) {
    if (!w) continue;
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) {
      h ^= w.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    out.add(h >>> 0);
    if (out.size >= 128) break;
  }
  return out;
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class OutboundAdvisoryAudit {
  private logPath: string;
  private maxLogBytes: number;
  private getIgnoreThreshold: () => number;
  private getSlugThreshold: () => number;
  private raiseAttention: AttentionRaiser | null;

  /** Write-time index — per-signature state (key: slug|topic|codes). */
  private signatures = new Map<string, SignatureState>();
  /** Recent PREFLIGHT-written rows (clean/advised) for §2.1 spoof correlation.
   *  Keyed slug|topic → last preflight ts. Acked rows never land here —
   *  a send's own ack must not self-license it. */
  private recentPreflights = new Map<string, number>();
  /** Per-slug escalation dedup for the aggregate bound. */
  private escalatedSlugs = new Set<string>();

  constructor(opts: OutboundAdvisoryAuditOptions) {
    this.logPath = opts.logPath;
    this.maxLogBytes = opts.maxLogBytes ?? 10 * 1024 * 1024;
    this.getIgnoreThreshold = opts.getIgnoreThreshold ?? (() => 3);
    this.getSlugThreshold = opts.getSlugThreshold ?? (() => 5);
    this.raiseAttention = opts.raiseAttention ?? null;
  }

  /**
   * Record a PREFLIGHT outcome (the preflight route is the caller).
   * action is derived: advisories present → 'advised', none → 'clean'.
   * Never throws — audit failure must never affect delivery.
   */
  recordPreflight(entry: {
    topicId: number;
    jobSlug: string;
    kind: string;
    text: string;
    advisories: string[];
  }): AdvisoryAction {
    const action: AdvisoryAction = entry.advisories.length > 0 ? 'advised' : 'clean';
    const textHash = safeHash(entry.text);
    this.appendLine({
      ts: new Date().toISOString(),
      topicId: entry.topicId,
      jobSlug: entry.jobSlug,
      kind: entry.kind,
      textHash,
      advisories: entry.advisories,
      action,
    });

    const now = Date.now();
    try {
      this.recentPreflights.set(`${entry.jobSlug}|${entry.topicId}`, now);
      this.prunePreflights(now);

      if (action === 'advised') {
        const sig = this.signature(entry.jobSlug, entry.topicId, entry.advisories);
        sig.unresolved.push({
          ts: now,
          textHash,
          tokens: tokenFingerprint(entry.text),
          codes: [...entry.advisories].sort(),
        });
        this.pruneEpisodes(sig, now);
        this.maybeEscalateIgnore(sig);
      } else {
        // A clean preflight resolves a prior advised episode ONLY when it is
        // the SAME message coming back fixed (near-identical token set or an
        // exact hash re-check that now passes). An interleaved clean heartbeat
        // for a DIFFERENT message must NOT reset the count (reset-gaming).
        this.resolveNearIdentical(entry.jobSlug, entry.topicId, entry.text, textHash);
      }
    } catch {
      /* @silent-fallback-ok — §2.4(5): audit/escalation is observe-only; an index error must never affect delivery */
    }
    return action;
  }

  /**
   * Record an ACK (the /telegram/reply route is the single writer of 'acked'
   * — it fires when a send carries metadata.advisoryAck). Resolves the
   * signature's unresolved episodes when the codes match; counts consecutive
   * non-empty-advisory acks for the preemptive-ack consumer.
   */
  recordAck(entry: {
    topicId: number;
    jobSlug: string;
    kind: string;
    text: string;
    advisories: string[];
  }): void {
    this.appendLine({
      ts: new Date().toISOString(),
      topicId: entry.topicId,
      jobSlug: entry.jobSlug,
      kind: entry.kind,
      textHash: safeHash(entry.text),
      advisories: entry.advisories,
      action: 'acked',
    });

    try {
      if (entry.advisories.length > 0) {
        const sig = this.signature(entry.jobSlug, entry.topicId, entry.advisories);
        // Ack with the same codes resolves the unresolved-advised episodes…
        sig.unresolved = [];
        sig.escalatedIgnore = false;
        // …but habitual overriding is itself operator-relevant.
        sig.consecutiveAcksWithAdvisories++;
        this.maybeEscalatePreemptiveAck(sig);
      } else {
        // Preemptive ack on a clean message — recorded in the audit (that IS
        // the consumer-visible signal); resets nothing.
      }
    } catch {
      /* @silent-fallback-ok — §2.4(5): observe-only audit; never affects delivery */
    }
  }

  /**
   * §2.1 spoof correlation: was there a PREFLIGHT-written (clean/advised)
   * row for this slug+topic recently? Acked rows deliberately don't count.
   */
  hasRecentPreflight(jobSlug: string, topicId: number, windowMs = RECENT_PREFLIGHT_WINDOW_MS): boolean {
    const ts = this.recentPreflights.get(`${jobSlug}|${topicId}`);
    return typeof ts === 'number' && Date.now() - ts <= windowMs;
  }

  /**
   * Bounded tail read for GET /messaging/advisory-log — reads the last
   * `maxBytes` of the file (default 256KB), NEVER the whole file, and
   * returns up to `limit` newest parsed entries.
   */
  readTail(limit = 50, maxBytes = 256 * 1024): AdvisoryAuditEntry[] {
    try {
      const stat = fs.statSync(this.logPath);
      const start = Math.max(0, stat.size - maxBytes);
      const fd = fs.openSync(this.logPath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const lines = buf.toString('utf8').split('\n').filter(Boolean);
        // Drop a possibly-partial first line when we started mid-file.
        const usable = start > 0 ? lines.slice(1) : lines;
        const out: AdvisoryAuditEntry[] = [];
        for (const line of usable.slice(-limit)) {
          try {
            out.push(JSON.parse(line) as AdvisoryAuditEntry);
          } catch {
            /* @silent-fallback-ok — bounded tail read skips a malformed JSONL line */
          }
        }
        return out;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* @silent-fallback-ok — read surface degrades to empty, never 500s */
      return [];
    }
  }

  // ── internals ──────────────────────────────────────────────────────

  private signature(jobSlug: string, topicId: number, codes: string[]): SignatureState {
    const codesKey = [...codes].sort().join(',');
    const key = `${jobSlug}|${topicId}|${codesKey}`;
    let sig = this.signatures.get(key);
    if (!sig) {
      sig = {
        jobSlug,
        topicId,
        codesKey,
        unresolved: [],
        consecutiveAcksWithAdvisories: 0,
        escalatedIgnore: false,
        escalatedAck: false,
      };
      this.signatures.set(key, sig);
      // Memory bound: drop the oldest signatures past the cap.
      if (this.signatures.size > MAX_SIGNATURES) {
        const first = this.signatures.keys().next().value;
        if (first) this.signatures.delete(first);
      }
    }
    return sig;
  }

  private pruneEpisodes(sig: SignatureState, now: number): void {
    sig.unresolved = sig.unresolved.filter((e) => now - e.ts <= ROLLING_WINDOW_MS);
  }

  private prunePreflights(now: number): void {
    if (this.recentPreflights.size <= 1000) return;
    for (const [k, ts] of this.recentPreflights) {
      if (now - ts > RECENT_PREFLIGHT_WINDOW_MS) this.recentPreflights.delete(k);
    }
  }

  private resolveNearIdentical(jobSlug: string, topicId: number, text: string, textHash: string): void {
    const tokens = tokenFingerprint(text);
    for (const sig of this.signatures.values()) {
      if (sig.jobSlug !== jobSlug || sig.topicId !== topicId || sig.unresolved.length === 0) continue;
      const before = sig.unresolved.length;
      sig.unresolved = sig.unresolved.filter(
        (e) => e.textHash !== textHash && jaccard(e.tokens, tokens) < NEAR_IDENTICAL_JACCARD,
      );
      if (sig.unresolved.length < before) {
        sig.escalatedIgnore = false;
        sig.consecutiveAcksWithAdvisories = 0;
      }
    }
  }

  private maybeEscalateIgnore(sig: SignatureState): void {
    if (!this.raiseAttention) return;
    const threshold = clampThreshold(this.getIgnoreThreshold(), 3);
    // Per-signature items are deliberately NORMAL priority: the
    // AttentionTopicGuard exempts HIGH/URGENT from the per-source topic
    // budget, so HIGH per-signature items from a topic-varying sender would
    // be exactly the un-budgeted topic-per-signature flood P17 forbids
    // (second-pass review finding, 2026-06-11). NORMAL rides the fixed
    // sourceContext budget (≤N topics, then coalesced). The per-slug
    // AGGREGATE below is the loud HIGH bound — intrinsically ONE deduped
    // item per slug. Once the slug aggregate has fired, further
    // per-signature items for that slug are suppressed (the aggregate
    // already names the job).
    if (!sig.escalatedIgnore && sig.unresolved.length >= threshold && !this.escalatedSlugs.has(sig.jobSlug)) {
      sig.escalatedIgnore = true;
      void Promise.resolve(
        this.raiseAttention({
          id: `outbound-advisory:ignored:${sig.jobSlug}:${sig.topicId}:${sig.codesKey}`,
          title: `Job "${sig.jobSlug}" is dropping its own messages after advisories`,
          summary:
            `${sig.unresolved.length} automated message(s) from job "${sig.jobSlug}" (topic ${sig.topicId}) were flagged by the outbound advisory ` +
            `[${sig.codesKey}] and never re-sent — the sender is silently dropping them instead of fixing or acknowledging. ` +
            `The advisory layer never blocks; this is the sender ignoring its own feedback.`,
          category: 'health',
          priority: 'NORMAL',
          sourceContext: ADVISORY_ESCALATION_SOURCE,
        }),
      ).catch(() => {
        /* @silent-fallback-ok — operator-inform is best-effort; never gates the sender */
      });
    }

    // Per-slug aggregate (across topics, higher threshold) — covers one-shot
    // senders whose topics vary.
    const slugThreshold = clampThreshold(this.getSlugThreshold(), 5);
    if (!this.escalatedSlugs.has(sig.jobSlug)) {
      let total = 0;
      const topics = new Set<number>();
      for (const s of this.signatures.values()) {
        if (s.jobSlug !== sig.jobSlug) continue;
        total += s.unresolved.length;
        if (s.unresolved.length > 0) topics.add(s.topicId);
      }
      if (total >= slugThreshold && topics.size > 1) {
        this.escalatedSlugs.add(sig.jobSlug);
        void Promise.resolve(
          this.raiseAttention({
            id: `outbound-advisory:ignored-slug:${sig.jobSlug}`,
            title: `Job "${sig.jobSlug}" is dropping advised messages across topics`,
            summary:
              `${total} automated message(s) from job "${sig.jobSlug}" across topics [${[...topics].join(', ')}] were flagged by the ` +
              `outbound advisory and never re-sent. One-shot sends have no retry behind them — these messages are lost unless the job is fixed.`,
            category: 'health',
            priority: 'HIGH',
            sourceContext: ADVISORY_ESCALATION_SOURCE,
          }),
        ).catch(() => {
          /* @silent-fallback-ok — operator-inform is best-effort */
        });
      }
    }
  }

  private maybeEscalatePreemptiveAck(sig: SignatureState): void {
    if (!this.raiseAttention) return;
    const threshold = clampThreshold(this.getIgnoreThreshold(), 3);
    if (!sig.escalatedAck && sig.consecutiveAcksWithAdvisories >= threshold) {
      sig.escalatedAck = true;
      void Promise.resolve(
        this.raiseAttention({
          id: `outbound-advisory:habitual-ack:${sig.jobSlug}:${sig.topicId}:${sig.codesKey}`,
          title: `Job "${sig.jobSlug}" habitually overrides advisories instead of fixing`,
          summary:
            `${sig.consecutiveAcksWithAdvisories} consecutive sends from job "${sig.jobSlug}" (topic ${sig.topicId}) acknowledged ` +
            `non-empty advisories [${sig.codesKey}] with --ack-advisory rather than fixing the message. The messages ARE delivering; ` +
            `this is a quality signal, not a delivery failure.`,
          category: 'health',
          priority: 'NORMAL',
          sourceContext: ADVISORY_ESCALATION_SOURCE,
        }),
      ).catch(() => {
        /* @silent-fallback-ok — operator-inform is best-effort; never gates the sender */
      });
    }
  }

  private appendLine(entry: AdvisoryAuditEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch {
      /* @silent-fallback-ok — §2.4(5): single-writer audit is best-effort; a write failure never affects delivery */
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size >= this.maxLogBytes) {
        fs.renameSync(this.logPath, `${this.logPath}.1`);
      }
    } catch {
      /* @silent-fallback-ok — rotation is best-effort; append proceeds */
    }
  }
}

function safeHash(text: string): string {
  try {
    return sha256Hex(text);
  } catch {
    /* @silent-fallback-ok — observe-only audit hashing; an empty hash degrades the row, never delivery */
    return '';
  }
}

function clampThreshold(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
