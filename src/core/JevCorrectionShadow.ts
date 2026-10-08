/**
 * JevCorrectionShadow — a dark, log-only measurement of whether Jev notices the
 * operator correcting the agent (or stating a standing preference) more often
 * than the Layer-0 keyword detector the Correction & Preference Learning
 * Sentinel gates on.
 *
 * Spec: docs/specs/jev-correction-shadow.md
 *
 * CONTRACT (the whole reason this is safe to ship):
 *   - It changes NOTHING the sentinel records. It writes one content-free row
 *     per inbound user message to a JSONL log; nothing reads that log on any
 *     decision path; a read route summarises it for people.
 *   - It is never awaited on the message seam. `observe()` is synchronous and
 *     cheap; for a user message a detached check secret-scrubs the message
 *     (plus the tail of the agent's previous message as context) and asks Jev
 *     one four-way question that includes "cannot tell". Failures record a
 *     closed-enum reason and never throw.
 *   - Dev-gated and read live: `intelligence.jevCorrectionShadow.enabled`
 *     omitted ⇒ live on a development agent, dark on the fleet; explicit false
 *     is the kill switch, honoured on the next message without a restart.
 *     Inert without the vault `typesafe_api_key`. Bounded: a daily call cap
 *     seeded from the log, a fetch timeout, at most MAX_IN_FLIGHT calls at once.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrubForStore } from './durableSecretScrub.js';
import { resolveDevAgentGate } from './devAgentGate.js';

export const JEV_CORRECTION_FEATURE = 'jev-correction-shadow';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const CORRECTION_MODEL = 'jev-1.13.0';
/**
 * A flag needs P(correction) + P(preference), forward order, at or above this.
 * The sum, not the top label: on the 14-day backfill Jev split one clear
 * correction 0.49 / 0.48 between the two, and a top-label rule missed it.
 */
export const CORRECTION_THRESHOLD = 0.5;
export const CORRECTION_DEFAULT_TIMEOUT_MS = 1500;
export const CORRECTION_DEFAULT_DAILY_CAP = 500;
export const MAX_IN_FLIGHT = 2;
/** Code points of the user message sent (head). */
export const USER_CHARS = 1500;
/** Code points of the previous agent message sent as context (tail). */
export const CONTEXT_CHARS = 800;
/** Topics whose last agent message is remembered; least recently active dropped past this. */
export const MAX_TOPICS = 200;
/** Bytes of log read by the summary (and the daily-cap seed). */
export const SUMMARY_TAIL_BYTES = 5_000_000;
const KEY_REREAD_MS = 10 * 60_000;

/**
 * The question. Four options including "cannot tell"; Jev is never asked to
 * count. Asked in both option orders in the one call (the circles research saw
 * order flips move ~6% of answers), so a later analysis can require both to
 * agree. The flag uses the forward order.
 */
export const CORRECTION_CRITERIA: Readonly<Record<string, string>> = {
  correction: 'The user says the agent got something wrong: a mistake, a misunderstanding, a false claim, unwanted work, or something to undo or redo.',
  preference: 'The user states a lasting preference or standing rule for how the agent should work from now on (style, process, what to always or never do), without saying the last reply was wrong.',
  neither: 'An ordinary request, question, answer, approval, thanks or piece of information; no correction and no standing preference.',
  cannot_tell: 'Too short or unclear to tell.',
};
const INSTRUCTIONS = 'A person sent the USER MESSAGE to their AI agent, replying to the AGENT MESSAGE. Which best describes the USER MESSAGE?';

export function correctionQuestions(): Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> {
  const fwd = { ...CORRECTION_CRITERIA };
  const rev = Object.fromEntries(Object.entries(CORRECTION_CRITERIA).reverse());
  return {
    kind: { type: 'choice', instructions: INSTRUCTIONS, criteria: fwd },
    kind_rev: { type: 'choice', instructions: INSTRUCTIONS, criteria: rev },
  };
}

function headCp(s: string, n: number): string {
  return Array.from(s.slice(0, 2 * n)).slice(0, n).join('');
}
function tailCp(s: string, n: number): string {
  return Array.from(s.slice(-4 * n)).slice(-n).join('');
}

/** Characters of a raw field scrubbed before any cut (the kept part is far inside it). */
const SCRUB_SPAN = 8192;

/**
 * Scrub a bounded slice of a RAW field before it is cut, so a cut can never
 * slice a secret into a part no pattern matches (the circles review's floor).
 * A private-key marker withholds the field. Returns null on a scrub failure.
 */
function scrubThenCut(s: string, n: number, fromEnd: boolean): string | null {
  const slice = fromEnd ? s.slice(-SCRUB_SPAN) : s.slice(0, SCRUB_SPAN);
  if (/PRIVATE KEY-----/.test(slice)) return '[REDACTED]';
  const scrubbed = scrubForStore(slice);
  if (scrubbed.error || scrubbed.truncated) return null;
  return fromEnd ? tailCp(scrubbed.text, n) : headCp(scrubbed.text, n);
}

/**
 * The text sent to Jev. Pure. Null when a scrub fails (nothing is sent).
 * Shared by the live shadow and the one-off research backfill so both ask the
 * identical question over the identical rendering.
 */
export function renderCorrectionState(userText: string, prevAgentText: string): string | null {
  const user = scrubThenCut(userText, USER_CHARS, false);
  const prev = prevAgentText ? scrubThenCut(prevAgentText, CONTEXT_CHARS, true) : '';
  if (user === null || prev === null) return null;
  const state = `AGENT MESSAGE (context only):\n${prev || '(none)'}\n\nUSER MESSAGE (classify this one):\n${user}`;
  // The whole state is scrubbed again before it leaves the machine.
  const again = scrubForStore(state);
  return again.error || again.truncated ? null : again.text;
}

export interface JevCorrectionShadowConfig {
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  maxChecksPerDay?: number;
}

/** The Layer-0 verdict the sentinel gates on, reduced to content-free fields. */
export interface Layer0Verdict { signal: boolean; kind: 'preference' | 'frustration' | null; weight: number }

export type CorrectionSkipReason =
  | 'disabled-no-key'
  | 'daily-cap'
  | 'busy'
  | 'scrub-error'
  | 'timeout'
  | 'http-error'
  | 'model-mismatch'
  | 'no-answers';

/** Reasons that mean a vendor call was attempted (they count toward the daily cap). */
const CALL_REASONS: ReadonlySet<string> = new Set(['timeout', 'http-error', 'model-mismatch', 'no-answers']);

export type CorrectionRow =
  | {
      kind: 'check';
      ts: string;
      topic: number | null;
      messageId: number | null;
      chars: number;
      hadContext: boolean;
      label: string;
      confidence: number;
      pCorrection: number;
      pPreference: number;
      pNeither: number;
      pCannotTell: number;
      labelRev?: string;
      /** Forward-order P(correction) + P(preference) ≥ threshold. */
      jevFlag: boolean;
      layer0: Layer0Verdict;
      agree: boolean;
      ms: number;
    }
  | { kind: 'skipped'; ts: string; topic: number | null; reason: CorrectionSkipReason };

export interface InboundEntry {
  topicId?: number | null;
  messageId?: number | null;
  text?: string | null;
  fromUser?: boolean;
  provenance?: string;
}

export interface JevCorrectionShadowDeps {
  /** Live config read per message; `enabled` is already dev-gate-resolved. */
  getConfig: () => JevCorrectionShadowConfig | undefined;
  readKey: () => string | null;
  /** The sentinel's own Layer-0 classifier (HumanAsDetectorLog.classify). */
  layer0: (text: string) => { learningKind: 'preference' | 'frustration' | null; deterministicWeight: number } | null;
  logPath: string;
  metrics?: { record(r: Record<string, unknown>): void } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Answer { label: string; confidence: number; p: Record<string, number> }

export class JevCorrectionShadow {
  private readonly deps: JevCorrectionShadowDeps;
  /** topic → tail of the agent's last conversational message (never persisted, never served). */
  private readonly lastAgent = new Map<number, string>();
  private inFlight = 0;
  private cachedKey: string | null = null;
  private keyReadAt = 0;
  private keyNoted = false;
  private day = '';
  private dayCalls = 0;
  private capNotedDay = '';
  /** Test seam: resolves when the most recent detached check settles. */
  lastCheck: Promise<void> = Promise.resolve();

  constructor(deps: JevCorrectionShadowDeps) {
    this.deps = deps;
    this.refreshKey();
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private refreshKey(): void {
    this.keyReadAt = this.now();
    try {
      this.cachedKey = this.deps.readKey() || null;
    } catch {
      // @silent-fallback-ok — an unreadable vault means "no key"; the shadow records disabled-no-key and stays inert.
      this.cachedKey = null;
    }
  }

  /** Synchronous, never throws. Called once per logged message (user or agent). */
  observe(entry: InboundEntry): void {
    try {
      const cfg = this.deps.getConfig();
      if (!cfg || cfg.enabled !== true) return;
      const text = typeof entry.text === 'string' ? entry.text : '';
      const topic = typeof entry.topicId === 'number' && Number.isFinite(entry.topicId) ? entry.topicId : null;
      if (!text) return;
      if (!entry.fromUser) {
        // Remember the agent's last conversational message per topic (automation notices are not what the user replies to).
        if (topic === null || entry.provenance === 'automation') return;
        this.lastAgent.delete(topic);
        this.lastAgent.set(topic, text.slice(-SCRUB_SPAN)); // the scrub span, so the tail is scrubbed before any cut
        if (this.lastAgent.size > MAX_TOPICS) this.lastAgent.delete(this.lastAgent.keys().next().value as number);
        return;
      }
      const prev = topic === null ? '' : this.lastAgent.get(topic) ?? '';
      const messageId = typeof entry.messageId === 'number' && Number.isFinite(entry.messageId) ? entry.messageId : null;
      // Deferred to a later turn: nothing of the check (vault read, cap seed,
      // scrub, Layer 0) runs inside the message-logging call stack.
      this.lastCheck = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.check(topic, messageId, text, prev, cfg))
        .catch(() => {
          /* @silent-fallback-ok — check() records its own reason rows; a throw here only means a row write failed */
        });
    } catch {
      // @silent-fallback-ok — a research instrument must never touch the message seam.
    }
  }

  private skip(topic: number | null, reason: CorrectionSkipReason): void {
    this.write({ kind: 'skipped', ts: new Date(this.now()).toISOString(), topic, reason });
  }

  private layer0(text: string): Layer0Verdict {
    try {
      const v = this.deps.layer0(text);
      return { signal: v?.learningKind != null, kind: v?.learningKind ?? null, weight: v?.deterministicWeight ?? 0 };
    } catch {
      // @silent-fallback-ok — a Layer-0 fault reads as "no signal", which is what the sentinel itself would do.
      return { signal: false, kind: null, weight: 0 };
    }
  }

  private async check(topic: number | null, messageId: number | null, text: string, prev: string, cfg: JevCorrectionShadowConfig): Promise<void> {
    if (!this.cachedKey && this.now() - this.keyReadAt >= KEY_REREAD_MS) { this.refreshKey(); this.keyNoted = false; }
    if (!this.cachedKey) {
      if (!this.keyNoted) { this.keyNoted = true; this.skip(topic, 'disabled-no-key'); }
      return;
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day !== day) {
      this.day = day;
      const seeded = this.seedDay(day);
      this.dayCalls = seeded.calls;
      if (seeded.capNoted) this.capNotedDay = day;
    }
    const cap = typeof cfg.maxChecksPerDay === 'number' && cfg.maxChecksPerDay >= 0 ? cfg.maxChecksPerDay : CORRECTION_DEFAULT_DAILY_CAP;
    if (this.dayCalls >= cap) {
      if (this.capNotedDay !== day) { this.capNotedDay = day; this.skip(topic, 'daily-cap'); }
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) return this.skip(topic, 'busy');

    const state = renderCorrectionState(text, prev);
    if (state === null) return this.skip(topic, 'scrub-error');
    const layer0 = this.layer0(text);

    this.dayCalls++;
    this.inFlight++;
    const model = cfg.model || CORRECTION_MODEL;
    const timeoutMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? Math.min(cfg.timeoutMs, 10_000) : CORRECTION_DEFAULT_TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const t0 = this.now();
    let outcome: 'fired' | 'noop' | 'error' = 'error';
    let tokensIn: number | undefined;
    let modelServed: string | undefined;
    try {
      const res = await (this.deps.fetchImpl ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cachedKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, model, questions: correctionQuestions() }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { this.cachedKey = null; this.keyReadAt = this.now(); }
        return this.skip(topic, 'http-error');
      }
      const json = (await res.json()) as {
        model?: string;
        usage?: { input_tokens?: number };
        answers?: Record<string, { choice?: unknown; probabilities?: Record<string, unknown> }>;
      };
      modelServed = typeof json.model === 'string' ? json.model : undefined;
      tokensIn = json.usage?.input_tokens;
      if (modelServed !== model) return this.skip(topic, 'model-mismatch');
      const fwd = readChoice(json.answers?.kind);
      if (!fwd) return this.skip(topic, 'no-answers');
      const rev = readChoice(json.answers?.kind_rev);
      const jevFlag = (fwd.p.correction ?? 0) + (fwd.p.preference ?? 0) >= CORRECTION_THRESHOLD;
      outcome = jevFlag ? 'fired' : 'noop';
      this.write({
        kind: 'check',
        ts: new Date(t0).toISOString(),
        topic,
        messageId,
        chars: Array.from(text).length,
        hadContext: prev.length > 0,
        label: fwd.label,
        confidence: fwd.confidence,
        pCorrection: fwd.p.correction ?? 0,
        pPreference: fwd.p.preference ?? 0,
        pNeither: fwd.p.neither ?? 0,
        pCannotTell: fwd.p.cannot_tell ?? 0,
        ...(rev ? { labelRev: rev.label } : {}),
        jevFlag,
        layer0,
        agree: jevFlag === layer0.signal,
        ms: this.now() - t0,
      });
    } catch (err) {
      return this.skip(topic, (err as Error)?.name === 'AbortError' ? 'timeout' : 'http-error');
    } finally {
      clearTimeout(timer);
      this.inFlight--;
      try {
        this.deps.metrics?.record({
          feature: JEV_CORRECTION_FEATURE,
          kind: 'llm',
          outcome,
          tokensIn,
          tokensOut: 0, // TypeSafe does not bill output tokens
          latencyMs: this.now() - t0,
          model: modelServed ?? model,
          framework: 'typesafe-api',
        });
      } catch { /* @silent-fallback-ok — metering must never break the instrument */ }
    }
  }

  /** Seeds the daily cap (and its once-a-day note) from the log, so a restart resets neither. */
  private seedDay(day: string): { calls: number; capNoted: boolean } {
    let calls = 0;
    let capNoted = false;
    for (const row of readRows(this.deps.logPath)) {
      if (!row.ts.startsWith(day)) continue;
      if (row.kind === 'check' || (row.kind === 'skipped' && CALL_REASONS.has(row.reason))) calls++;
      if (row.kind === 'skipped' && row.reason === 'daily-cap') capNoted = true;
    }
    return { calls, capNoted };
  }

  private write(row: CorrectionRow): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, JSON.stringify(row) + '\n');
    } catch {
      // @silent-fallback-ok — an unwritable research log loses rows, never message delivery.
    }
  }

  summary(): CorrectionSummary {
    return summarizeCorrectionLog(this.deps.logPath, this.deps.getConfig()?.enabled === true);
  }
}

function readChoice(a: { choice?: unknown; probabilities?: Record<string, unknown> } | undefined): Answer | null {
  if (!a || typeof a.choice !== 'string' || !a.probabilities || typeof a.probabilities !== 'object') return null;
  const p: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.probabilities)) if (typeof v === 'number' && Number.isFinite(v)) p[k] = v;
  if (!(a.choice in p)) return null;
  return { label: a.choice, confidence: p[a.choice], p };
}

function readRows(logPath: string): CorrectionRow[] {
  let text: string;
  try {
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, 'r');
    try {
      const len = Math.min(size, SUMMARY_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      if (size > len) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // @silent-fallback-ok — no log yet means no rows.
    return [];
  }
  const rows: CorrectionRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as CorrectionRow;
      if (r && typeof r.ts === 'string' && (r.kind === 'check' || r.kind === 'skipped')) rows.push(r);
    } catch { /* @silent-fallback-ok — a torn line is skipped */ }
  }
  return rows;
}

export interface CorrectionSummary {
  enabled: boolean;
  since: string | null;
  checks: number;
  /** Jev flagged (correction or preference). */
  jevFlags: number;
  /** Layer-0 marked a learning signal (what the sentinel distills today). */
  layer0Signals: number;
  both: number;
  jevOnly: number;
  layer0Only: number;
  /** Fraction of checks where Jev and Layer-0 agree; null with no checks. */
  agreement: number | null;
  labels: Record<string, number>;
  /** Checks whose reverse-order label differs from the forward one. */
  orderFlips: number;
  skipped: Record<string, number>;
}

export function summarizeCorrectionLog(logPath: string, enabled: boolean): CorrectionSummary {
  const out: CorrectionSummary = {
    enabled, since: null, checks: 0, jevFlags: 0, layer0Signals: 0, both: 0, jevOnly: 0, layer0Only: 0,
    agreement: null, labels: {}, orderFlips: 0, skipped: {},
  };
  let agree = 0;
  for (const r of readRows(logPath)) {
    if (!out.since) out.since = r.ts;
    if (r.kind === 'skipped') { out.skipped[r.reason] = (out.skipped[r.reason] ?? 0) + 1; continue; }
    out.checks++;
    out.labels[r.label] = (out.labels[r.label] ?? 0) + 1;
    const l0 = r.layer0?.signal === true;
    if (r.jevFlag) out.jevFlags++;
    if (l0) out.layer0Signals++;
    if (r.jevFlag && l0) out.both++;
    else if (r.jevFlag) out.jevOnly++;
    else if (l0) out.layer0Only++;
    if (r.agree) agree++;
    if (r.labelRev && r.labelRev !== r.label) out.orderFlips++;
  }
  if (out.checks > 0) out.agreement = agree / out.checks;
  return out;
}

// ── Production wiring ───────────────────────────────────────────────────

let installed: JevCorrectionShadow | null = null;
/** server.ts installs the one instance; the message seam and read route find it here. */
export function installJevCorrectionShadow(s: JevCorrectionShadow | null): void { installed = s; }
export function getJevCorrectionShadow(): JevCorrectionShadow | null { return installed; }

/** The production factory, shared by server.ts and the E2E test. */
export function buildJevCorrectionShadow(opts: {
  readLiveIntelligence: () => unknown;
  bootBlock?: JevCorrectionShadowConfig;
  developmentAgent?: boolean;
  readSecret: (name: string) => unknown;
  layer0: JevCorrectionShadowDeps['layer0'];
  stateDir: string;
  metrics?: JevCorrectionShadowDeps['metrics'];
  fetchImpl?: typeof fetch;
}): JevCorrectionShadow {
  return new JevCorrectionShadow({
    getConfig: () => {
      const intel = opts.readLiveIntelligence();
      const live = intel && typeof intel === 'object' ? (intel as Record<string, unknown>).jevCorrectionShadow : undefined;
      const block = (live && typeof live === 'object' ? live : opts.bootBlock ?? {}) as JevCorrectionShadowConfig;
      const enabled = resolveDevAgentGate(typeof block.enabled === 'boolean' ? block.enabled : undefined, { developmentAgent: opts.developmentAgent });
      return { ...block, enabled };
    },
    readKey: () => {
      const v = opts.readSecret('typesafe_api_key');
      return typeof v === 'string' && v ? v : null;
    },
    layer0: opts.layer0,
    logPath: path.join(opts.stateDir, '..', 'logs', 'jev-correction-shadow.jsonl'),
    metrics: opts.metrics,
    fetchImpl: opts.fetchImpl,
  });
}
