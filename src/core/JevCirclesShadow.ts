/**
 * JevCirclesShadow — a dark, log-only measurement of the "you're going in
 * circles" nudge (research: docs/research/jev field note 2026-09-30, idea B1).
 *
 * Spec: docs/specs/jev-circles-shadow.md
 *
 * CONTRACT (the whole reason this is safe to ship):
 *   - It delivers NOTHING. No session, user or topic ever sees a nudge. It
 *     writes one content-free row per check to a JSONL log and nothing reads
 *     that log on any decision path; a read route summarises it for people.
 *   - It is never awaited on the hook path. `observe()` is synchronous and
 *     cheap (a counter); every 5th action a detached check reads the session's
 *     own transcript tail, builds the last 15 actions exactly as the research
 *     harness did, secret-scrubs them, and asks Jev the measured five-label
 *     question. Failures record a closed-enum reason and never throw.
 *   - Dev-gated and read live: `intelligence.jevCirclesShadow.enabled` omitted
 *     ⇒ live on a development agent, dark on the fleet; explicit false is the
 *     kill switch, honoured on the next action without a restart. Inert without
 *     the vault `typesafe_api_key`. Bounded: a daily call cap, a fetch timeout,
 *     at most MAX_IN_FLIGHT calls at once.
 *   - Cooldown is accounted AS IF nudging (30 min per session), so the log
 *     shows the real would-fire rate rather than one row per repeated window.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrubForStore } from './durableSecretScrub.js';
import { resolveDevAgentGate } from './devAgentGate.js';

export const JEV_CIRCLES_FEATURE = 'jev-circles-shadow';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const CIRCLES_MODEL = 'jev-1.13.0';
/** Actions per window (the measured window size). */
export const CIRCLES_WINDOW = 15;
/** A check runs every STRIDE reported actions per session. */
export const CIRCLES_STRIDE = 5;
/** P(circling) at or above this is a would-nudge (the held-out working threshold). */
export const CIRCLES_THRESHOLD = 0.5;
export const CIRCLES_COOLDOWN_MS = 30 * 60_000;
export const CIRCLES_DEFAULT_TIMEOUT_MS = 1500;
export const CIRCLES_DEFAULT_DAILY_CAP = 2000;
export const MAX_IN_FLIGHT = 2;
/** Sessions tracked at once; the least recently active is dropped past this. */
export const MAX_SESSIONS = 500;
/** Bytes read from the end of a transcript per check. */
export const TRANSCRIPT_TAIL_BYTES = 1_000_000;
/** Bytes of log read by the summary (and the daily-cap seed). */
export const SUMMARY_TAIL_BYTES = 5_000_000;
const KEY_REREAD_MS = 10 * 60_000;

/**
 * The measured question, verbatim from harness/idea3-circles/runjev.mjs. Asked
 * in both option orders in the one call (order flips moved ~6% of windows), so
 * a later analysis can require both to agree. The would-nudge decision uses the
 * forward order, which is the one the held-out numbers were scored on.
 */
export const CIRCLES_CRITERIA: Readonly<Record<string, string>> = {
  circling: 'Going in circles: at least the third attempt at essentially the same fix or retry for the same unresolved problem, and the attempts are not converging (the same failure keeps coming back).',
  polling: 'Legitimately waiting or monitoring: repeated checks of a status, log, CI run, lock or background job, with nothing being fixed.',
  converging: 'Iterative fixing or debugging where each attempt makes visible progress (a different error, fewer failures, a new hypothesis).',
  normal: 'Ordinary forward progress with no problematic repetition.',
  cannot_tell: 'The activity shown does not contain enough to tell.',
};
const INSTRUCTIONS = 'Which best describes this recent activity of an AI coding agent?';
export const WINDOW_HEADER = 'RECENT AGENT ACTIVITY (15 tool actions, oldest first; the ok/ERROR flag is a rough keyword guess):\n';

export function circlesQuestions(): Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> {
  const fwd = { ...CIRCLES_CRITERIA };
  const rev = Object.fromEntries(Object.entries(CIRCLES_CRITERIA).reverse());
  return {
    state: { type: 'choice', instructions: INSTRUCTIONS, criteria: fwd },
    state_rev: { type: 'choice', instructions: INSTRUCTIONS, criteria: rev },
  };
}

export interface JevCirclesShadowConfig {
  enabled?: boolean;
  model?: string;
  timeoutMs?: number;
  maxChecksPerDay?: number;
}

export type CirclesSkipReason =
  | 'disabled-no-key'
  | 'no-transcript'
  | 'short-window'
  | 'daily-cap'
  | 'busy'
  | 'scrub-error'
  | 'timeout'
  | 'http-error'
  | 'model-mismatch'
  | 'no-answers';

/** Reasons that mean a vendor call was attempted (they count toward the daily cap). */
const CALL_REASONS: ReadonlySet<string> = new Set(['timeout', 'http-error', 'model-mismatch', 'no-answers']);

export type CirclesRow =
  | {
      kind: 'check';
      ts: string;
      session: string;
      label: string;
      confidence: number;
      pCircling: number;
      labelRev?: string;
      pCirclingRev?: number;
      wouldNudge: boolean;
      /** P(circling) cleared the threshold but the session's cooldown held it. */
      cooldown?: true;
      /** Actions in the window flagged ERROR (content-free shape of the window). */
      errorActions: number;
      ms: number;
    }
  | { kind: 'skipped'; ts: string; session: string; reason: CirclesSkipReason };

// ── The window, built exactly as harness/idea3-circles/extract.py builds it ──

const SECRETISH = /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{16,})/g;
const ERR = /(error|Error|ERROR|FAIL|failed|Failed|not found|No such file|refused|denied|Traceback|exit code [1-9]|Exit code [1-9]|✗|×|timed out|Timeout)/;

// Slices count code points, as Python's do (an emoji is one character there, two here).
function headCp(s: string, n: number): string {
  return Array.from(s.slice(0, 2 * n)).slice(0, n).join('');
}
function tailCp(s: string, n: number): string {
  return Array.from(s.slice(-4 * n)).slice(-n).join('');
}

/** Characters of a raw field scrubbed before any cut (the kept part is at most 220). */
const SCRUB_SPAN = 4096;

/**
 * Scrub a bounded slice of a RAW field before it is cut: a cut can slice a
 * secret so no pattern matches the part that survives (a PEM body without its
 * header, a token across the command cut). The kept part is far from the
 * slice's own edge, so a secret the slice itself cuts is never kept. A field
 * showing a private-key marker is withheld whole.
 */
function scrubRaw(s: string, fromEnd: boolean): string {
  const slice = fromEnd ? s.slice(-SCRUB_SPAN) : s.slice(0, SCRUB_SPAN);
  if (/PRIVATE KEY-----/.test(slice)) return '[REDACTED]';
  const scrubbed = scrubForStore(slice);
  return scrubbed.error || scrubbed.truncated ? '[REDACTED]' : scrubbed.text;
}

function clean(s: unknown, n: number): string {
  return headCp(scrubRaw(String(s ?? ''), false).replace(SECRETISH, '[REDACTED]').replace(/\s+/g, ' ').trim(), n);
}

function basename(p: unknown): string {
  return path.basename(String(p ?? ''));
}

/** Python `json.dumps` default form (", " / ": " separators, ASCII-escaped), as the harness rendered other tools' input. */
function pyDumps(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${pyDumps(k)}: ${pyDumps(x)}`).join(', ')}}`;
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return JSON.stringify(v) ?? 'null';
}

export interface CirclesAction { head: string; flag: 'ok' | 'ERROR'; tail: string; note: string }

function summarize(name: string, input: Record<string, unknown>, content: unknown, isError: boolean): CirclesAction {
  let head: string;
  if (name === 'Bash') head = `Bash: ${clean(input.command, 160)}`;
  else if (name === 'Edit' || name === 'MultiEdit') head = `Edit ${basename(input.file_path)}: '${clean(input.old_string, 50)}' -> '${clean(input.new_string, 50)}'`;
  else if (name === 'Write') head = `Write ${basename(input.file_path)} (${Array.from(String(input.content ?? '')).length} chars)`;
  else if (name === 'Read') head = `Read ${basename(input.file_path)}`;
  else if (name === 'Grep' || name === 'Glob') head = `${name}: ${clean(input.pattern, 80)}`;
  else head = `${name}: ${clean(pyDumps(input), 120)}`;
  const r = Array.isArray(content)
    ? content.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => String((x as { text?: unknown }).text ?? '')).join(' ')
    : String(content ?? '');
  const tail = clean(tailCp(scrubRaw(r, true), 220), 160);
  const flag = isError || (name === 'Bash' && ERR.test(r.slice(-600))) ? 'ERROR' : 'ok';
  return { head, flag, tail, note: '' };
}

/**
 * Parse Claude Code transcript JSONL (possibly a tail that starts mid-line)
 * into tool actions, oldest first. Pure. Unparseable lines are skipped.
 */
export function buildActions(jsonl: string, last?: number): CirclesAction[] {
  const tus = new Map<string, { name: string; input: Record<string, unknown>; note: string }>();
  const raw: Array<{ name: string; input: Record<string, unknown>; note: string; content: unknown; isError: boolean }> = [];
  let lastText = '';
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    let d: { type?: string; message?: { content?: unknown } };
    try { d = JSON.parse(line); } catch { continue; }
    const t = d?.type;
    const c = d?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue;
      if (t === 'assistant' && b.type === 'text') lastText = String(b.text ?? '');
      if (t === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string') {
        const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
        tus.set(b.id, { name: String(b.name ?? ''), input, note: lastText });
        lastText = '';
      }
      if (t === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && tus.has(b.tool_use_id)) {
        const tu = tus.get(b.tool_use_id)!;
        tus.delete(b.tool_use_id);
        if (tu.name === 'TodoWrite' || tu.name === 'ToolSearch') continue;
        raw.push({ ...tu, content: b.content, isError: b.is_error === true });
      }
    }
  }
  // Only the actions that will be shown are rendered (and scrubbed).
  return (last === undefined ? raw : raw.slice(-last)).map((x) => {
    const a = summarize(x.name, x.input, x.content, x.isError);
    a.note = clean(x.note, 110);
    return a;
  });
}

export function renderWindow(actions: CirclesAction[]): string {
  return WINDOW_HEADER + actions
    .map((a, k) => `${k + 1}. ${a.note ? `[${a.note}] ` : ''}${a.head} => ${a.flag}: ${a.tail}`)
    .join('\n');
}

/**
 * A transcript path taken from a hook payload is only read when it is the
 * session's own Claude Code transcript: absolute, under a `projects`
 * directory, named `<session_id>.jsonl`.
 */
export function isSessionTranscriptPath(p: unknown, sessionId: string): p is string {
  if (typeof p !== 'string' || !p || !UUID.test(sessionId)) return false;
  if (!path.isAbsolute(p) || path.normalize(p) !== p) return false;
  // <config home>/projects/<encoded cwd>/<session id>.jsonl, config home `.claude*`.
  const parts = p.split(path.sep);
  const n = parts.length;
  return n >= 4 && parts[n - 1] === `${sessionId}.jsonl` && parts[n - 3] === 'projects' && parts[n - 4].startsWith('.claude');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── The shadow ──────────────────────────────────────────────────────────

export interface JevCirclesShadowDeps {
  /** Live config read per action; `enabled` is already dev-gate-resolved. */
  getConfig: () => JevCirclesShadowConfig | undefined;
  readKey: () => string | null;
  logPath: string;
  metrics?: { record(r: Record<string, unknown>): void } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Test seam: read the transcript tail. `truncated` = the file was longer than `bytes`. */
  readTail?: (file: string, bytes: number, sessionId: string) => Promise<{ text: string; truncated: boolean }>;
}

interface SessionState { count: number; lastNudgeAt: number; noted: Set<CirclesSkipReason> }

export class JevCirclesShadow {
  private readonly deps: JevCirclesShadowDeps;
  private readonly sessions = new Map<string, SessionState>();
  private inFlight = 0;
  private cachedKey: string | null = null;
  private keyReadAt = 0;
  private day = '';
  private dayCalls = 0;
  private capNotedDay = '';
  /** Test seam: resolves when the most recent detached check settles. */
  lastCheck: Promise<void> = Promise.resolve();

  constructor(deps: JevCirclesShadowDeps) {
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

  /** Synchronous, never throws. Called once per reported tool action. */
  observe(ev: { sessionId?: unknown; transcriptPath?: unknown }): void {
    try {
      const cfg = this.deps.getConfig();
      if (!cfg || cfg.enabled !== true) return;
      const sid = typeof ev.sessionId === 'string' ? ev.sessionId : '';
      if (!sid) return;
      let st = this.sessions.get(sid);
      if (st) this.sessions.delete(sid);
      else st = { count: 0, lastNudgeAt: -Infinity, noted: new Set() };
      this.sessions.set(sid, st); // most recently active last
      if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
      st.count++;
      if (st.count % CIRCLES_STRIDE !== 0) return;
      this.lastCheck = this.check(sid, st, ev.transcriptPath, cfg).catch(() => {
        /* @silent-fallback-ok — check() records its own reason rows; a throw here only means a row write failed */
      });
    } catch {
      // @silent-fallback-ok — a research instrument must never touch the hook path.
    }
  }

  private skip(sid: string, st: SessionState | null, reason: CirclesSkipReason, once = false): void {
    if (once && st) {
      if (st.noted.has(reason)) return;
      st.noted.add(reason);
    }
    this.write({ kind: 'skipped', ts: new Date(this.now()).toISOString(), session: sid, reason });
  }

  private async check(sid: string, st: SessionState, transcriptPath: unknown, cfg: JevCirclesShadowConfig): Promise<void> {
    if (!this.cachedKey && this.now() - this.keyReadAt >= KEY_REREAD_MS) this.refreshKey();
    if (!this.cachedKey) return this.skip(sid, st, 'disabled-no-key', true);
    if (!isSessionTranscriptPath(transcriptPath, sid)) return this.skip(sid, st, 'no-transcript', true);

    let tail: { text: string; truncated: boolean };
    try {
      tail = await (this.deps.readTail ?? readTail)(transcriptPath, TRANSCRIPT_TAIL_BYTES, sid);
    } catch {
      // @silent-fallback-ok — an unreadable (or symlinked-away) transcript is recorded once per session as no-transcript.
      return this.skip(sid, st, 'no-transcript', true);
    }
    const actions = buildActions(tail.text, CIRCLES_WINDOW);
    if (actions.length < CIRCLES_WINDOW) {
      // Early in a session: nothing to ask yet. A full 1 MB tail that still holds
      // fewer than 15 actions (huge results) is a blind spot, so it is recorded.
      if (tail.truncated) this.skip(sid, st, 'short-window', true);
      return;
    }

    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day !== day) { this.day = day; this.dayCalls = this.countCallsOn(day); }
    const cap = typeof cfg.maxChecksPerDay === 'number' && cfg.maxChecksPerDay >= 0 ? cfg.maxChecksPerDay : CIRCLES_DEFAULT_DAILY_CAP;
    if (this.dayCalls >= cap) {
      if (this.capNotedDay !== day) { this.capNotedDay = day; this.skip(sid, null, 'daily-cap'); }
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) return this.skip(sid, null, 'busy');

    const scrubbed = scrubForStore(renderWindow(actions));
    if (scrubbed.error || scrubbed.truncated) return this.skip(sid, null, 'scrub-error');

    this.dayCalls++;
    this.inFlight++;
    const model = cfg.model || CIRCLES_MODEL;
    const timeoutMs = typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0 ? Math.min(cfg.timeoutMs, 10_000) : CIRCLES_DEFAULT_TIMEOUT_MS;
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
        body: JSON.stringify({ state: scrubbed.text, model, questions: circlesQuestions() }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { this.cachedKey = null; this.keyReadAt = this.now(); }
        return this.skip(sid, null, 'http-error');
      }
      const json = (await res.json()) as {
        model?: string;
        usage?: { input_tokens?: number };
        answers?: Record<string, { choice?: unknown; probabilities?: Record<string, unknown> }>;
      };
      modelServed = typeof json.model === 'string' ? json.model : undefined;
      tokensIn = json.usage?.input_tokens;
      if (modelServed !== model) return this.skip(sid, null, 'model-mismatch');
      const fwd = readChoice(json.answers?.state);
      if (!fwd) return this.skip(sid, null, 'no-answers');
      const rev = readChoice(json.answers?.state_rev);
      const nowMs = this.now();
      const over = fwd.pCircling >= CIRCLES_THRESHOLD;
      const held = over && nowMs - st.lastNudgeAt < CIRCLES_COOLDOWN_MS;
      if (over && !held) st.lastNudgeAt = nowMs;
      outcome = over && !held ? 'fired' : 'noop';
      this.write({
        kind: 'check',
        ts: new Date(t0).toISOString(),
        session: sid,
        label: fwd.label,
        confidence: fwd.confidence,
        pCircling: fwd.pCircling,
        ...(rev ? { labelRev: rev.label, pCirclingRev: rev.pCircling } : {}),
        wouldNudge: over && !held,
        ...(held ? { cooldown: true as const } : {}),
        errorActions: actions.filter((a) => a.flag === 'ERROR').length,
        ms: nowMs - t0,
      });
    } catch (err) {
      return this.skip(sid, null, (err as Error)?.name === 'AbortError' ? 'timeout' : 'http-error');
    } finally {
      clearTimeout(timer);
      this.inFlight--;
      try {
        this.deps.metrics?.record({
          feature: JEV_CIRCLES_FEATURE,
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

  /** Seeds the daily cap from the log, so a restart does not reset the bound. */
  private countCallsOn(day: string): number {
    let n = 0;
    for (const row of readRows(this.deps.logPath)) {
      if (!row.ts.startsWith(day)) continue;
      if (row.kind === 'check' || (row.kind === 'skipped' && CALL_REASONS.has(row.reason))) n++;
    }
    return n;
  }

  private write(row: CirclesRow): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, JSON.stringify(row) + '\n');
    } catch {
      // @silent-fallback-ok — an unwritable research log loses rows, never session work.
    }
  }

  summary(): CirclesSummary {
    return summarizeCirclesLog(this.deps.logPath, this.deps.getConfig()?.enabled === true);
  }
}

function readChoice(a: { choice?: unknown; probabilities?: Record<string, unknown> } | undefined): { label: string; confidence: number; pCircling: number } | null {
  if (!a || typeof a.choice !== 'string' || !a.probabilities || typeof a.probabilities !== 'object') return null;
  const pc = a.probabilities.circling;
  const conf = a.probabilities[a.choice];
  if (typeof pc !== 'number' || !Number.isFinite(pc)) return null;
  return { label: a.choice, confidence: typeof conf === 'number' && Number.isFinite(conf) ? conf : 0, pCircling: pc };
}

async function readTail(file: string, bytes: number, sessionId: string): Promise<{ text: string; truncated: boolean }> {
  // The shape check runs again on the resolved path, so a symlink cannot point it elsewhere.
  const real = await fs.promises.realpath(file);
  if (!isSessionTranscriptPath(real, sessionId)) throw new Error('not a session transcript');
  const fh = await fs.promises.open(real, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const text = buf.toString('utf8');
    // A tail that starts mid-line drops the partial first line.
    return size > len ? { text: text.slice(text.indexOf('\n') + 1), truncated: true } : { text, truncated: false };
  } finally {
    await fh.close();
  }
}

function readRows(logPath: string): CirclesRow[] {
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
  const rows: CirclesRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as CirclesRow;
      if (r && typeof r.ts === 'string' && (r.kind === 'check' || r.kind === 'skipped')) rows.push(r);
    } catch { /* @silent-fallback-ok — a torn line is skipped */ }
  }
  return rows;
}

export interface CirclesSummary {
  enabled: boolean;
  since: string | null;
  checks: number;
  wouldNudges: number;
  cooldownHeld: number;
  labels: Record<string, number>;
  skipped: Record<string, number>;
  perSession: Record<string, { checks: number; wouldNudges: number; lastTs: string }>;
}

export function summarizeCirclesLog(logPath: string, enabled: boolean): CirclesSummary {
  const out: CirclesSummary = { enabled, since: null, checks: 0, wouldNudges: 0, cooldownHeld: 0, labels: {}, skipped: {}, perSession: {} };
  for (const r of readRows(logPath)) {
    if (!out.since) out.since = r.ts;
    if (r.kind === 'skipped') { out.skipped[r.reason] = (out.skipped[r.reason] ?? 0) + 1; continue; }
    out.checks++;
    out.labels[r.label] = (out.labels[r.label] ?? 0) + 1;
    if (r.wouldNudge) out.wouldNudges++;
    if (r.cooldown) out.cooldownHeld++;
    const s = (out.perSession[r.session] ??= { checks: 0, wouldNudges: 0, lastTs: r.ts });
    s.checks++;
    if (r.wouldNudge) s.wouldNudges++;
    s.lastTs = r.ts;
  }
  return out;
}

// ── Production wiring ───────────────────────────────────────────────────

let installed: JevCirclesShadow | null = null;
/** server.ts installs the one instance; the hook-events and read routes find it here. */
export function installJevCirclesShadow(s: JevCirclesShadow | null): void { installed = s; }
export function getJevCirclesShadow(): JevCirclesShadow | null { return installed; }

/** The production factory, shared by server.ts and the E2E test. */
export function buildJevCirclesShadow(opts: {
  readLiveIntelligence: () => unknown;
  bootBlock?: JevCirclesShadowConfig;
  developmentAgent?: boolean;
  readSecret: (name: string) => unknown;
  stateDir: string;
  metrics?: JevCirclesShadowDeps['metrics'];
  fetchImpl?: typeof fetch;
}): JevCirclesShadow {
  return new JevCirclesShadow({
    getConfig: () => {
      const intel = opts.readLiveIntelligence();
      const live = intel && typeof intel === 'object' ? (intel as Record<string, unknown>).jevCirclesShadow : undefined;
      const block = (live && typeof live === 'object' ? live : opts.bootBlock ?? {}) as JevCirclesShadowConfig;
      const enabled = resolveDevAgentGate(typeof block.enabled === 'boolean' ? block.enabled : undefined, { developmentAgent: opts.developmentAgent });
      return { ...block, enabled };
    },
    readKey: () => {
      const v = opts.readSecret('typesafe_api_key');
      return typeof v === 'string' && v ? v : null;
    },
    logPath: path.join(opts.stateDir, '..', 'logs', 'jev-circles-shadow.jsonl'),
    metrics: opts.metrics,
    fetchImpl: opts.fetchImpl,
  });
}
