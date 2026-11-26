/**
 * JevMemoryPicker — ranks the Claude Code memory index (MEMORY.md, one line per
 * memory) against a session's opening context, so the relevant entries can
 * load instead of whichever entries happen to sit first in the file.
 *
 * Spec: docs/specs/jev-memory-picker.md
 * Evidence: docs/research/jev/field-notes/2026-09-30-idea2-memory-selection.md
 *
 * CONTRACT:
 *   - Signal only. It chooses which already-saved index lines are offered to a
 *     session; it cannot block, send or change anything. In `shadow` mode (the
 *     default) it changes nothing at all: it logs what it WOULD inject.
 *   - Fail-open. Every failure (no key, timeout, HTTP error, model mismatch,
 *     scrub error, cap, busy) falls back to positional order — today's loader.
 *   - Fixed top-N by rank, never a confidence cutoff: Jev's probabilities here
 *     are low and bunched (the note: 6% of pairs reach 0.5).
 *   - Rows carry line ids, scores and counts — never memory or message text.
 *   - Everything sent to Jev is secret-scrubbed first; every call is metered.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { scrubForStore } from './durableSecretScrub.js';
import { BoundedJsonlAudit } from './BoundedJsonlAudit.js';
import { resolveDevAgentGate } from './devAgentGate.js';

export const JEV_MEMORY_PICKER_FEATURE = 'jev-memory-picker';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** The documented standing-rule marker: a line carrying it always loads. */
export const PINNED_MARKER = '<!-- pinned -->';
/** Claude Code's positional load limits for MEMORY.md (measured: the cut falls
 *  where the running character count passes 25,000; at most 200 lines). */
export const POSITIONAL_MAX_CHARS = 25_000;
export const POSITIONAL_MAX_LINES = 200;
/** Ranked lines added beyond the cut, and their character cap (Claude Code
 *  still loads the positional prefix itself; the picker can only add). */
export const DEFAULT_INJECT_LINES = 40;
export const DEFAULT_INJECT_MAX_CHARS = 10_000;
export const DEFAULT_TIMEOUT_MS = 1500;
export const TIMEOUT_MIN_MS = 100;
export const TIMEOUT_MAX_MS = 3000;
/** Extra wait past the fetch abort before the caller stops waiting regardless. */
export const RACE_SLACK_MS = 250;
export const DEFAULT_DAILY_CALL_CAP = 300;
export const MAX_IN_FLIGHT = 2;
export const MAX_INDEX_BYTES = 256 * 1024;
export const MAX_CONTEXT_CHARS = 4000;
export const MAX_ENTRY_CHARS = 500;
export const MAX_GLOSSARY_LINES = 20;
export const MAX_GLOSSARY_CHARS = 200;
export const KEY_REREAD_MS = 10 * 60_000;
export const INJECT_HEADER = '--- MEMORY INDEX: RANKED ENTRIES BEYOND THE LOAD CUT ---';
export const INJECT_FOOTER = '--- END MEMORY INDEX RANKED ENTRIES ---';

/**
 * The frozen wordings (the note's B and C). Score = their mean: C excludes
 * general principles, which demotes the generic lessons B alone over-ranks.
 * Changing a wording is a reviewed code change, never config.
 */
export const QUESTION_B = (line: string): string =>
  `Saved memory note: "${line}". The note concerns the same subject, system, account, machine or kind of work as the conversation's current request.`;
export const QUESTION_C = (line: string): string =>
  `Saved memory note: "${line}". The note is about a specific system, account, machine, tool or piece of work that the conversation's current request involves. A general working principle that would apply to any request does not count.`;

export interface JevMemoryPickerConfig {
  /** Omitted ⇒ the developmentAgent gate decides; false is the kill switch. */
  enabled?: boolean;
  mode?: 'shadow' | 'inject';
  model?: string;
  timeoutMs?: number;
  injectLines?: number;
  injectMaxChars?: number;
  glossary?: string[];
  dailyCallCap?: number;
}

export interface IndexEntry {
  /** 1-based line number in the file. */
  line: number;
  /** `L<line>-<sha8>` — stable enough to join rows against a file snapshot. */
  id: string;
  /** The line with the pinned marker stripped. */
  text: string;
  pinned: boolean;
  /** Inside the prefix Claude Code loads by position. */
  inPrefix: boolean;
}

export type PickReason =
  | 'fits'
  | 'no-index'
  | 'oversize-index'
  | 'no-context'
  | 'disabled-no-key'
  | 'daily-cap'
  | 'busy'
  | 'scrub-error'
  | 'timeout'
  | 'http-error'
  | 'model-mismatch'
  | 'no-answers';

export interface PickResult {
  outcome: 'ranked' | 'fallback' | 'skipped';
  reason?: PickReason;
  /** Entries Claude Code would NOT load by itself, to add: pinned first, then by rank. */
  inject: IndexEntry[];
  scores: Map<number, number>;
}

/** Parse the index: every `- ` line is an entry; the prefix is what loads by position. */
export function parseIndex(content: string): IndexEntry[] {
  const lines = content.split('\n');
  const out: IndexEntry[] = [];
  let chars = 0;
  let prefixOpen = true;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // The running count includes the joining newline, as the loader measures the text.
    chars += raw.length + (i > 0 ? 1 : 0);
    if (prefixOpen && (chars > POSITIONAL_MAX_CHARS || i + 1 > POSITIONAL_MAX_LINES)) prefixOpen = false;
    if (!raw.startsWith('- ')) continue;
    const pinned = raw.includes(PINNED_MARKER);
    const text = (pinned ? raw.split(PINNED_MARKER).join('') : raw).trimEnd();
    const sha8 = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
    out.push({ line: i + 1, id: `L${i + 1}-${sha8}`, text, pinned, inPrefix: prefixOpen });
  }
  return out;
}

/** The entries Jev ranks: non-pinned, beyond the positional cut. */
export function candidates(entries: IndexEntry[]): IndexEntry[] {
  return entries.filter((e) => !e.pinned && !e.inPrefix);
}

/**
 * Compose what to add: pinned entries beyond the cut (file order), then the
 * `ranked` entries, stopping at `maxLines` entries or `maxChars` characters.
 * With no ranking (any Jev failure) only the pinned entries are added — with
 * nothing pinned, that is exactly today's load.
 */
export function compose(entries: IndexEntry[], ranked: IndexEntry[], maxLines: number, maxChars: number): IndexEntry[] {
  const out: IndexEntry[] = [];
  let chars = 0;
  for (const e of [...entries.filter((x) => x.pinned && !x.inPrefix), ...ranked]) {
    if (out.length >= maxLines || chars + e.text.length + 1 > maxChars) break;
    out.push(e);
    chars += e.text.length + 1;
  }
  return out;
}

/** Order candidates by score, highest first; ties by file position. Unscored entries are dropped. */
export function rankByScore(cands: IndexEntry[], scores: Map<number, number>): IndexEntry[] {
  return cands
    .filter((e) => scores.has(e.line))
    .sort((a, b) => scores.get(b.line)! - scores.get(a.line)! || a.line - b.line);
}

/**
 * Derive the memory index path Claude Code uses for a project. Returns null
 * unless `configDir` is an absolute path inside `homeDir` whose last segment
 * starts with `.claude`. The project key replaces every non-alphanumeric
 * character with `-` (Claude Code's own scheme), so it can hold no separator.
 * Pure: `resolveMemoryIndexPath` repeats the checks on the real paths.
 */
export function memoryIndexPath(configDir: unknown, projectDir: unknown, homeDir: string): string | null {
  if (typeof configDir !== 'string' || typeof projectDir !== 'string') return null;
  if (!path.isAbsolute(configDir) || !path.isAbsolute(projectDir) || !path.isAbsolute(homeDir)) return null;
  const dir = path.resolve(configDir);
  const home = path.resolve(homeDir);
  if (!dir.startsWith(home + path.sep)) return null;
  if (!path.basename(dir).startsWith('.claude')) return null;
  const key = path.resolve(projectDir).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(dir, 'projects', key, 'memory', 'MEMORY.md');
}

/**
 * The same derivation on symlink-resolved paths: a `configDir` that is a link
 * out of the home directory is refused, and so is an index file that is itself
 * a symlink. Returns null when refused or absent.
 */
export async function resolveMemoryIndexPath(configDir: unknown, projectDir: unknown, homeDir: string): Promise<string | null> {
  if (memoryIndexPath(configDir, projectDir, homeDir) === null) return null;
  try {
    const realDir = await fsp.realpath(configDir as string);
    const realHome = await fsp.realpath(homeDir);
    const file = memoryIndexPath(realDir, projectDir, realHome);
    if (!file) return null;
    const st = await fsp.lstat(file);
    return st.isFile() ? file : null;
  } catch {
    // @silent-fallback-ok — a missing config dir or index file means there is nothing to rank.
    return null;
  }
}

/** Render the inject block, or '' when there is nothing to add. */
export function renderInjectBlock(inject: IndexEntry[]): string {
  if (inject.length === 0) return '';
  return [
    INJECT_HEADER,
    'These memory index entries sit past the point where MEMORY.md stops loading, and were ranked relevant to this session:',
    ...inject.map((e) => e.text),
    INJECT_FOOTER,
  ].join('\n');
}

/** Which session-start event asked (logged on every row). */
export type PickSource = 'startup' | 'resume' | 'clear' | 'compact' | 'other';
export function pickSource(v: unknown): PickSource {
  return v === 'startup' || v === 'resume' || v === 'clear' || v === 'compact' ? v : 'other';
}

const PICKER_DEFAULTS = {
  mode: 'shadow' as 'shadow' | 'inject',
  model: 'jev-1.13.0',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  injectLines: DEFAULT_INJECT_LINES,
  injectMaxChars: DEFAULT_INJECT_MAX_CHARS,
  glossary: [] as string[],
  dailyCallCap: DEFAULT_DAILY_CALL_CAP,
};

/** A row's view of an entry: id, score, pinned flag — never its text. */
const rowEntry = (scores: Map<number, number>) => (e: IndexEntry): Record<string, unknown> => ({
  id: e.id,
  ...(scores.has(e.line) ? { p: Math.round(scores.get(e.line)! * 1000) / 1000 } : {}),
  ...(e.pinned ? { pinned: true } : {}),
});

export interface JevMemoryPickerDeps {
  /** Live config read per request, `enabled` already gate-resolved. */
  getConfig: () => JevMemoryPickerConfig | undefined;
  /** Resolves the vault key; called at construction and at most every KEY_REREAD_MS after a miss. */
  readKey: () => string | null;
  logPath: string;
  metrics?: { record(r: Record<string, unknown>): void } | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The home directory the index path must sit inside (default os.homedir()). */
  homeDir?: string;
}

export class JevMemoryPicker {
  private readonly deps: JevMemoryPickerDeps;
  private readonly audit: BoundedJsonlAudit;
  private cachedKey: string | null = null;
  private keyReadAt = 0;
  private inFlight = 0;
  private capDay = '';
  private capCount = 0;
  /** Test seam: the latest detached shadow run. */
  lastRun: Promise<PickResult | null> = Promise.resolve(null);

  readonly homeDir: string;

  constructor(deps: JevMemoryPickerDeps) {
    this.deps = deps;
    this.homeDir = deps.homeDir ?? os.homedir();
    this.audit = new BoundedJsonlAudit({ file: deps.logPath });
    this.refreshKey();
  }

  /** Resolves when every queued log row is written (tests, shutdown). */
  flush(): Promise<void> {
    return this.audit.flush();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private refreshKey(): void {
    this.keyReadAt = this.now();
    try {
      this.cachedKey = this.deps.readKey() || null;
    } catch {
      // @silent-fallback-ok — an unreadable vault means "no key"; picks fall back to positional order with reason disabled-no-key.
      this.cachedKey = null;
    }
  }

  /** The live config, normalised. Null when disabled (the kill switch). */
  config(): typeof PICKER_DEFAULTS | null {
    let cfg: JevMemoryPickerConfig | undefined;
    try {
      cfg = this.deps.getConfig();
    } catch {
      // @silent-fallback-ok — an unreadable config means off; the session starts exactly as today.
      return null;
    }
    if (!cfg || cfg.enabled !== true) return null;
    const num = (v: unknown, d: number, lo: number, hi: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d;
    return {
      mode: cfg.mode === 'inject' ? 'inject' : 'shadow',
      model: typeof cfg.model === 'string' && cfg.model ? cfg.model : 'jev-1.13.0',
      timeoutMs: num(cfg.timeoutMs, DEFAULT_TIMEOUT_MS, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
      injectLines: num(cfg.injectLines, DEFAULT_INJECT_LINES, 0, 200),
      injectMaxChars: num(cfg.injectMaxChars, DEFAULT_INJECT_MAX_CHARS, 0, 50_000),
      glossary: Array.isArray(cfg.glossary)
        ? cfg.glossary.filter((g): g is string => typeof g === 'string' && g.trim() !== '').slice(0, MAX_GLOSSARY_LINES).map((g) => g.slice(0, MAX_GLOSSARY_CHARS))
        : [],
      dailyCallCap: num(cfg.dailyCallCap, DEFAULT_DAILY_CALL_CAP, 0, 100_000),
    };
  }

  /**
   * Rank the index at `indexPath` against `context` and log one row. Never
   * rejects: every failure resolves to "add only the pinned entries beyond the
   * cut" (with nothing pinned, today's load exactly).
   */
  async pick(indexPath: string, context: string, source: PickSource = 'other'): Promise<PickResult> {
    const cfg = this.config() ?? { ...PICKER_DEFAULTS };
    const t0 = this.now();
    const ctx = context.slice(0, MAX_CONTEXT_CHARS);
    const base = {
      ts: new Date(t0).toISOString(),
      mode: cfg.mode,
      source,
      contextSha256: crypto.createHash('sha256').update(ctx, 'utf8').digest('hex'),
      contextChars: ctx.length,
    };
    const skip = (reason: PickReason, inject: IndexEntry[] = []): PickResult => {
      this.audit.append({ ...base, outcome: 'skipped', reason, ms: this.now() - t0, ...(inject.length ? { inject: inject.map(rowEntry(new Map())) } : {}) });
      return { outcome: 'skipped', reason, inject, scores: new Map() };
    };

    let content: string;
    try {
      const st = await fsp.lstat(indexPath);
      if (!st.isFile()) return skip('no-index');
      if (st.size > MAX_INDEX_BYTES) return skip('oversize-index');
      content = await fsp.readFile(indexPath, 'utf8');
    } catch {
      // @silent-fallback-ok — no index file means nothing to rank; the row records no-index.
      return skip('no-index');
    }
    const entries = parseIndex(content);
    const cands = candidates(entries);
    const pinnedOnly = compose(entries, [], cfg.injectLines, cfg.injectMaxChars);
    if (cands.length === 0) return skip('fits', pinnedOnly);
    if (ctx.trim() === '') return skip('no-context', pinnedOnly);

    const scored = await this.rank(cands, ctx, cfg);
    const scores = 'scores' in scored ? scored.scores : new Map<number, number>();
    const inject = 'scores' in scored ? compose(entries, rankByScore(cands, scores), cfg.injectLines, cfg.injectMaxChars) : pinnedOnly;
    const outcome = 'scores' in scored ? 'ranked' : 'fallback';
    const reason = 'reason' in scored ? scored.reason : undefined;
    this.audit.append({
      ...base,
      outcome,
      ...(reason ? { reason } : {}),
      entries: entries.length,
      prefix: entries.filter((e) => e.inPrefix).length,
      pinned: entries.filter((e) => e.pinned).length,
      candidates: cands.length,
      ms: this.now() - t0,
      ...(scored.jevMs !== undefined ? { jevMs: scored.jevMs } : {}),
      model: cfg.model,
      inject: inject.map(rowEntry(scores)),
    });
    return { outcome, ...(reason ? { reason } : {}), inject, scores };
  }

  /** One bounded Jev call. Resolves to scores, or to a fallback reason. */
  private async rank(
    cands: IndexEntry[],
    ctx: string,
    cfg: NonNullable<ReturnType<JevMemoryPicker['config']>>,
  ): Promise<{ scores: Map<number, number>; jevMs?: number } | { reason: PickReason; jevMs?: number }> {
    const nowMs = this.now();
    if (!this.cachedKey && nowMs - this.keyReadAt >= KEY_REREAD_MS) this.refreshKey();
    if (!this.cachedKey) return { reason: 'disabled-no-key' };
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (this.capDay !== day) { this.capDay = day; this.capCount = 0; }
    if (this.capCount >= cfg.dailyCallCap) return { reason: 'daily-cap' };
    if (this.inFlight >= MAX_IN_FLIGHT) return { reason: 'busy' };

    const glossary = cfg.glossary.length ? `Glossary of our internal names:\n${cfg.glossary.map((g) => `- ${g}`).join('\n')}\n\n` : '';
    const state = scrubForStore(`${glossary}Conversation at session start:\n${ctx}`);
    if (state.error || state.truncated) return { reason: 'scrub-error' };
    const questions: Record<string, { type: 'noul'; instructions: string }> = {};
    for (const e of cands) {
      const s = scrubForStore(e.text.slice(0, MAX_ENTRY_CHARS));
      if (s.error || s.truncated) return { reason: 'scrub-error' };
      questions[`b${e.line}`] = { type: 'noul', instructions: QUESTION_B(s.text) };
      questions[`c${e.line}`] = { type: 'noul', instructions: QUESTION_C(s.text) };
    }

    this.capCount++;
    this.inFlight++;
    const t0 = this.now();
    const ctrl = new AbortController();
    const abort = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tokensIn: number | undefined;
    let modelServed: string | undefined;
    let metricOutcome: 'fired' | 'error' = 'error';
    const call = (async (): Promise<{ scores: Map<number, number> } | { reason: PickReason }> => {
      try {
        const res = await (this.deps.fetchImpl ?? fetch)(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.cachedKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: state.text, model: cfg.model, questions }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) { this.cachedKey = null; this.keyReadAt = this.now(); }
          return { reason: 'http-error' };
        }
        const json = (await res.json()) as { model?: string; answers?: Record<string, { noul?: number }>; usage?: { input_tokens?: number } };
        modelServed = typeof json.model === 'string' ? json.model : undefined;
        tokensIn = json.usage?.input_tokens;
        if (modelServed !== cfg.model) return { reason: 'model-mismatch' };
        const scores = new Map<number, number>();
        for (const e of cands) {
          const ps = [json.answers?.[`b${e.line}`]?.noul, json.answers?.[`c${e.line}`]?.noul]
            .filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
          if (ps.length) scores.set(e.line, ps.reduce((a, b) => a + b, 0) / ps.length);
        }
        if (scores.size === 0) return { reason: 'no-answers' };
        metricOutcome = 'fired';
        return { scores };
      } catch (err) {
        return { reason: (err as Error)?.name === 'AbortError' ? 'timeout' : 'http-error' };
      }
    })();
    const deadline = new Promise<{ reason: PickReason }>((resolve) => {
      timer = setTimeout(() => resolve({ reason: 'timeout' }), cfg.timeoutMs + RACE_SLACK_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const out = await Promise.race([call, deadline]);
      return { ...out, jevMs: this.now() - t0 };
    } finally {
      clearTimeout(abort);
      if (timer) clearTimeout(timer);
      this.inFlight--;
      try {
        this.deps.metrics?.record({
          feature: JEV_MEMORY_PICKER_FEATURE,
          kind: 'llm',
          outcome: metricOutcome,
          tokensIn,
          tokensOut: 0, // TypeSafe does not bill output tokens
          latencyMs: this.now() - t0,
          model: modelServed ?? cfg.model,
          framework: 'typesafe-api',
        });
      } catch { /* @silent-fallback-ok — metering must never break the picker */ }
    }
  }
}

/**
 * The production wiring, shared by server.ts and the E2E test: the live
 * `intelligence.jevMemoryPicker` block wins over the boot block, and an
 * omitted `enabled` is decided by the developmentAgent gate.
 */
export function buildJevMemoryPicker(opts: {
  readLiveIntelligence: () => unknown;
  bootBlock?: JevMemoryPickerConfig;
  developmentAgent?: boolean;
  readSecret: (name: string) => unknown;
  stateDir: string;
  metrics?: JevMemoryPickerDeps['metrics'];
  fetchImpl?: typeof fetch;
  now?: () => number;
  homeDir?: string;
}): JevMemoryPicker {
  return new JevMemoryPicker({
    getConfig: () => {
      const intel = opts.readLiveIntelligence();
      const live = intel && typeof intel === 'object' ? (intel as Record<string, unknown>).jevMemoryPicker : undefined;
      const block = ((live && typeof live === 'object' ? live : undefined) ?? opts.bootBlock ?? {}) as JevMemoryPickerConfig;
      const enabled = resolveDevAgentGate(typeof block.enabled === 'boolean' ? block.enabled : undefined, { developmentAgent: opts.developmentAgent });
      return { ...block, enabled };
    },
    readKey: () => {
      const v = opts.readSecret('typesafe_api_key');
      return typeof v === 'string' && v ? v : null;
    },
    logPath: path.join(opts.stateDir, '..', 'logs', 'jev-memory-picker.jsonl'),
    metrics: opts.metrics,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    homeDir: opts.homeDir,
  });
}

/** Build the opening-context text from a topic's name and last messages. */
export function topicOpeningContext(topic: { topicName?: string | null; recentMessages?: Array<{ fromUser?: boolean; text?: string }> } | null | undefined, extra?: unknown): string {
  const parts: string[] = [];
  if (topic?.topicName) parts.push(`Topic: ${topic.topicName}`);
  for (const m of (topic?.recentMessages ?? []).slice(-3)) {
    if (typeof m.text === 'string' && m.text.trim()) parts.push(`${m.fromUser ? 'User' : 'Agent'}: ${m.text.slice(0, 600)}`);
  }
  if (typeof extra === 'string' && extra.trim()) parts.push(extra.slice(0, MAX_CONTEXT_CHARS));
  return parts.join('\n').slice(0, MAX_CONTEXT_CHARS);
}
