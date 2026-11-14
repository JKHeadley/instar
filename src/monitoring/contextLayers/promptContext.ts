/**
 * The per-prompt delta hook's server side, measured in SHADOW first
 * (context-budget-layered-summaries §7.7, §9.5, §17 "Seeded marker / context
 * epoch", decision 10; Phase 1 slice S15).
 *
 * Today the UserPromptSubmit hook (`telegram-topic-context.sh`) fetches the
 * topic-intent briefing and the 15 most recent topic messages on EVERY prompt,
 * so a long session holds the same briefing and the same messages many times
 * over. §7.7 replaces that with the DELTA since the last prompt for this
 * `(topic, session)`: new messages and a changed briefing, one request.
 *
 * This module computes, in one call:
 *  - the FULL output: exactly the data today's two calls return (the hook
 *    renders it with the same formatter it always used);
 *  - the DELTA against the context epoch:
 *      * no seeded marker for the session (Codex, a Claude session that was
 *        never seeded, a session with no id)  ⇒ the delta IS the full output;
 *      * a seeded marker whose epoch has no prompt cursor yet ⇒ the delta is
 *        measured from the SEED (messages after `seededAt`, the briefing only
 *        when it changed since the seed served it), so the first prompt after a
 *        compaction never receives the packet and the briefing both;
 *      * otherwise the delta since the last prompt of this epoch.
 *
 * Both sizes go to a local-only shadow log under the layer store root
 * (`state/context-layers/_delta-shadow/`, git-ignored, never served, bounded
 * and rotated). Rows carry ids and hashes only, never message or briefing text.
 *
 * Reduction (returning the delta to the session) is a separate per-machine
 * switch, `contextBudget.deltaHook.enabled` (default off), and is REFUSED unless
 * the standing compaction canary reads `healthy` on this machine. In shadow the
 * session receives the full output, always.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contextLayersRoot } from '../clearSeedPointer.js';
import { foldMarkerPath } from '../foldMarker.js';
import { FoldRecordStore, TERMINAL_STATES } from '../FoldCoordinator.js';
import { FOLD_LOCK_TTL_CEILING_MS } from '../../core/foldLeaseFactory.js';
import type { CanaryReport } from '../compactionCanary.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

/** The feature id the maturation ladder reads (src/data/feature-ladders.json). */
export const DELTA_HOOK_FEATURE_ID = 'contextBudget.deltaHook';

/** Claude Code hands a hook's output to the model whole only below 10,000 chars (PR #3048). */
export const HOOK_OUTPUT_LIMIT_CHARS = 9_000;
/** The message count the hook has always asked for. */
export const PROMPT_HISTORY_LIMIT = 15;
/** Response bounds: the formatter shows at most 300 chars per message, so 1,000 is lossless for display. */
export const MAX_MESSAGE_CHARS = 1_000;
export const MAX_BRIEFING_CHARS = 32_000;
/** Shadow log bounds: one active file and one rotated file, each at most this size. */
export const SHADOW_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** At most this many omitted item ids per row (the count is always exact). */
export const SHADOW_ROW_MAX_OMITTED = 40;
/**
 * A fetch counts as the SEED's only when it happened within this window before
 * the marker was written (the seed hook fetches, prints, then writes the
 * marker, all under its own short timeouts). Only the briefing route and the
 * topic history routes record fetches; the prompt route never does, so a
 * pre-compaction prompt cannot pass for the seed.
 */
export const SEED_FETCH_MATCH_MS = 30_000;
/** A PostCompact record this long after the marker means a later compaction that did not seed: the marker is stale. */
export const STALE_MARKER_TOLERANCE_MS = 60_000;
/** In delta mode the route fits the delta under this, so the cursor records only what was delivered. */
export const DELTA_DELIVERY_BUDGET_CHARS = 7_500;
/** Cursor files untouched this long are pruned (at most once an hour). */
export const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** A topic history read within this long after an omission counts as a candidate re-fetch. */
export const REFETCH_WINDOW_MS = 30 * 60_000;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// ── Messages ─────────────────────────────────────────────────────────────

/** The fields the hook's formatter reads, and nothing else. */
export interface PromptMessage {
  messageId?: number;
  eventId?: string;
  fromUser?: boolean;
  direction?: string;
  timestamp: string;
  text: string;
}

/** Keep only the formatter's fields, bounded. */
export function slimMessage(raw: Record<string, unknown>): PromptMessage {
  const m: PromptMessage = {
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '',
    text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_MESSAGE_CHARS) : '',
  };
  if (typeof raw.messageId === 'number' && Number.isFinite(raw.messageId)) m.messageId = raw.messageId;
  if (typeof raw.eventId === 'string' && raw.eventId) m.eventId = raw.eventId.slice(0, 128);
  if (typeof raw.fromUser === 'boolean') m.fromUser = raw.fromUser;
  if (typeof raw.direction === 'string') m.direction = raw.direction.slice(0, 16);
  return m;
}

/** The formatter's own rule: `fromUser`, else `direction == 'in'`, else inbound. */
export function isFromUser(m: PromptMessage): boolean {
  if (typeof m.fromUser === 'boolean') return m.fromUser;
  return (m.direction ?? 'in') === 'in';
}

function shortHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** A message's identity: its event id, else direction + Telegram id, else a hash (never the text itself). */
export function messageKey(m: PromptMessage): string {
  if (m.eventId) return `e:${m.eventId}`;
  if (typeof m.messageId === 'number') return `${isFromUser(m) ? 'in' : 'out'}:${m.messageId}`;
  return `h:${shortHash(`${m.timestamp}\u0000${m.text}`)}`;
}

/** The trailing run of user messages with no agent reply after them (the formatter's rule). */
export function unansweredOf(messages: readonly PromptMessage[]): PromptMessage[] {
  let pending: PromptMessage[] = [];
  for (const m of messages) {
    if (!m.text.trim()) continue;
    if (isFromUser(m)) pending.push(m);
    else pending = [];
  }
  return pending;
}

// ── The briefing ─────────────────────────────────────────────────────────

/**
 * A briefing's identity for "did it change": its text with the volatile parts
 * removed (the freshness stamp's "N messages behind", the lag warning, and the
 * confidence numbers that move without the substance moving).
 */
export function stableBriefingHash(text: string): string | null {
  if (!text.trim()) return null;
  const stable = text
    .split('\n')
    .filter((ln) => !/^\s+as of \S+, (?:\d+ messages behind|stale: unknown)/.test(ln))
    .filter((ln) => !/^\s+FRESHNESS WARNING:/.test(ln))
    .map((ln) => ln.replace(/confidence \d+(?:\.\d+)?/g, 'confidence ~').replace(/\(retries: \d+\/\d+\)/g, '(retries)'))
    .join('\n');
  return shortHash(stable);
}

/** Cap the briefing for the response, saying so in-band. */
export function boundBriefing(text: string): string {
  if (text.length <= MAX_BRIEFING_CHARS) return text;
  let head = text.slice(0, MAX_BRIEFING_CHARS);
  // Never split a surrogate pair: a lone high surrogate would make the hook's parser fail.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}\n[briefing truncated: ${text.length - head.length} more characters]`;
}

/**
 * Recent seed-shaped fetches per topic (in memory): the briefing route and the
 * topic history routes, so the delta can see what the seed itself fetched.
 */
export class SeedFetchLog {
  private readonly byTopic = new Map<number, Array<{ at: number; kind: 'briefing' | 'history'; hash: string | null }>>();
  constructor(private readonly now: () => number = Date.now) {}
  private push(topicId: number, e: { kind: 'briefing' | 'history'; hash: string | null }): void {
    const list = this.byTopic.get(topicId) ?? [];
    list.push({ at: this.now(), ...e });
    while (list.length > 32) list.shift();
    this.byTopic.set(topicId, list);
    if (this.byTopic.size > 2_000) this.byTopic.delete(this.byTopic.keys().next().value as number);
  }
  noteBriefing(topicId: number, text: string): void { this.push(topicId, { kind: 'briefing', hash: stableBriefingHash(text) }); }
  noteHistory(topicId: number): void { this.push(topicId, { kind: 'history', hash: null }); }
  /** The newest fetch of a kind in [at - SEED_FETCH_MATCH_MS, at + 1s]. */
  servedNear(topicId: number, at: number, kind: 'briefing' | 'history' = 'briefing'): { found: boolean; hash: string | null } {
    const list = this.byTopic.get(topicId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.kind === kind && e.at <= at + 1_000 && at - e.at <= SEED_FETCH_MATCH_MS) return { found: true, hash: e.hash };
    }
    return { found: false, hash: null };
  }
}

// ── Rendering (for sizes only; the hook renders what the session sees) ──

function localStamp(raw: string): string {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw.slice(0, 16).replace('T', ' ');
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  let zone = '';
  try { zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? ''; } catch { zone = ''; /* @silent-fallback-ok — a size estimate without the zone label */ }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${zone}`;
}

/**
 * The text the hook prints for a briefing and a message list, mirroring its
 * Python formatter line for line (the zone label is the server's, so a size can
 * differ from the hook's by a few characters).
 */
export function renderPromptContextText(
  topicId: number,
  briefing: string,
  messages: readonly PromptMessage[],
  opts: { mode?: 'full' | 'delta'; unanswered?: readonly PromptMessage[] } = {},
): string {
  const out: string[] = [];
  if (briefing) { out.push(briefing); out.push(''); }
  const mode = opts.mode ?? 'full';
  if (messages.length === 0 && mode !== 'delta') return out.join('\n');
  if (mode === 'delta') {
    out.push(messages.length > 0
      ? `TOPIC ${topicId} NEW MESSAGES SINCE YOUR LAST PROMPT (auto-injected; earlier history is already in your context):`
      : `TOPIC ${topicId}: no new messages since your last prompt (earlier history is already in your context).`);
  } else {
    out.push(`TOPIC ${topicId} RECENT HISTORY (auto-injected):`);
  }
  for (const m of messages) {
    let text = m.text.trim();
    if (text.length > 300) text = `${text.slice(0, 297)}...`;
    out.push(`  [${localStamp(m.timestamp)}] ${isFromUser(m) ? 'User' : 'Agent'}: ${text}`);
  }
  const pending = mode === 'delta' ? [...(opts.unanswered ?? [])] : unansweredOf(messages);
  if (pending.length > 0) {
    out.push('');
    out.push('*** UNANSWERED MESSAGE(S) FROM USER ***');
    for (const pm of pending) out.push(`  [${localStamp(pm.timestamp)}] "${pm.text.slice(0, 200)}"`);
    out.push('');
    out.push('You MUST address these messages substantively. Do NOT respond with just');
    out.push('a greeting or generic reply. Read the conversation history above and');
    out.push('respond to what the user actually said. If the current message is a');
    out.push('follow-up like "hello?" or "please respond", address the EARLIER');
    out.push('unanswered message — that is what the user is waiting for.');
  }
  return out.join('\n');
}

// ── The context epoch ────────────────────────────────────────────────────

export type ContextEpoch =
  | { kind: 'unseeded'; key: 'unseeded' }
  | { kind: 'seeded'; key: string; seededAt: number; source: 'compact' | 'clear' };

/**
 * The epoch this session's context is in, keyed on the seeded marker (§7.7,
 * §17): a compaction's recovery seed (`source: compact`) or a fold's clear seed
 * (`source: clear`) both put the packet in context. No marker, an unreadable
 * marker, or a marker for another session ⇒ `unseeded` (today's behaviour).
 */
export function resolveContextEpoch(stateDir: string, claudeSessionId: string | null | undefined, topicId?: number): ContextEpoch {
  if (!claudeSessionId || !SAFE_ID.test(claudeSessionId)) return { kind: 'unseeded', key: 'unseeded' };
  const file = path.join(contextLayersRoot(stateDir), '_seeded', `${claudeSessionId}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { seededAt?: unknown; epoch?: unknown; sessionId?: unknown; source?: unknown };
    if (raw.sessionId !== undefined && raw.sessionId !== claudeSessionId) return { kind: 'unseeded', key: 'unseeded' };
    if (typeof raw.seededAt !== 'number' || !Number.isFinite(raw.seededAt)) return { kind: 'unseeded', key: 'unseeded' };
    const source = raw.source === 'clear' ? 'clear' : 'compact';
    // §17 "absent or mismatched ⇒ full briefing": a compaction recorded after this
    // marker (its seed failed, so no new marker) means the marker no longer
    // describes this context.
    if (topicId !== undefined && laterCompactionThan(stateDir, topicId, claudeSessionId, raw.seededAt)) return { kind: 'unseeded', key: 'unseeded' };
    const epoch = typeof raw.epoch === 'string' && raw.epoch ? raw.epoch : String(raw.seededAt);
    return { kind: 'seeded', key: `${source}:${epoch}:${raw.seededAt}`.slice(0, 200), seededAt: raw.seededAt, source };
  } catch {
    return { kind: 'unseeded', key: 'unseeded' }; // @silent-fallback-ok — no or torn marker ⇒ the full briefing, never less (§17)
  }
}

/** Is there a PostCompact record for this session well after `seededAt`? Reads file names only. */
function laterCompactionThan(stateDir: string, topicId: number, sid: string, seededAt: number): boolean {
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(contextLayersRoot(stateDir), String(topicId), 'post-compact')); } catch { return false; } // @silent-fallback-ok — no PostCompact records: nothing contradicts the marker
  for (const n of names) {
    const m = /^(\d+)-([A-Za-z0-9_-]{1,128})\.json$/.exec(n);
    if (m && m[2] === sid && Number(m[1]) > seededAt + STALE_MARKER_TOLERANCE_MS) return true;
  }
  return false;
}

// ── The prompt cursor ────────────────────────────────────────────────────

export interface PromptCursor {
  schema: 'prompt-cursor/1';
  topicId: number;
  sessionId: string;
  epoch: string;
  /** Message keys this epoch's context already holds (ids, never text). */
  seenKeys: string[];
  briefingHash: string | null;
  updatedAt: number;
}

const MAX_SEEN_KEYS = 200;

/** One small file per (topic, session) under the layer root, 0700/0600, atomic replace. */
export class PromptCursorStore {
  private lastPruneAt = 0;
  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}
  /** Remove cursors untouched for CURSOR_MAX_AGE_MS (at most once an hour). */
  private prune(): void {
    const t = this.now();
    if (t - this.lastPruneAt < 60 * 60_000) return;
    this.lastPruneAt = t;
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir()); } catch { return; } // @silent-fallback-ok — no cursor directory yet
    for (const n of names) {
      if (!/^\d+--[A-Za-z0-9_-]{1,128}\.json$/.test(n)) continue;
      const f = path.join(this.dir(), n);
      try { if (t - fs.statSync(f).mtimeMs > CURSOR_MAX_AGE_MS) SafeFsExecutor.safeRmSync(f, { force: true, operation: 'src/monitoring/contextLayers/promptContext.ts:prune' }); } catch { /* @silent-fallback-ok — a cursor that cannot be pruned now is pruned next hour */ }
    }
  }
  private dir(): string { return path.join(contextLayersRoot(this.stateDir), '_prompt-cursors'); }
  private file(topicId: number, sessionId: string): string | null {
    if (!Number.isSafeInteger(topicId) || topicId < 0 || !SAFE_ID.test(sessionId)) return null;
    return path.join(this.dir(), `${topicId}--${sessionId}.json`);
  }
  get(topicId: number, sessionId: string): PromptCursor | null {
    const f = this.file(topicId, sessionId);
    if (!f) return null;
    try {
      const c = JSON.parse(fs.readFileSync(f, 'utf-8')) as PromptCursor;
      if (c?.schema !== 'prompt-cursor/1' || c.topicId !== topicId || c.sessionId !== sessionId || !Array.isArray(c.seenKeys)) return null;
      return c;
    } catch {
      return null; // @silent-fallback-ok — no cursor ⇒ the delta is measured from the seed again (larger, never smaller)
    }
  }
  put(c: PromptCursor): boolean {
    const f = this.file(c.topicId, c.sessionId);
    if (!f) return false;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...c, seenKeys: c.seenKeys.slice(-MAX_SEEN_KEYS) }), { mode: 0o600 });
      fs.renameSync(tmp, f);
      this.prune();
      return true;
    } catch {
      return false; // @silent-fallback-ok — the caller records a featureEvidence error; the next prompt re-measures from the seed
    }
  }
}

// ── The delta ────────────────────────────────────────────────────────────

export type DeltaBasis = 'unseeded-full' | 'seed' | 'last-prompt';

export interface OmittedItem { k: 'm' | 'b'; id: string }

export interface PromptDelta {
  basis: DeltaBasis;
  briefingIncluded: boolean;
  messages: PromptMessage[];
  omitted: OmittedItem[];
  /** The cursor to store after this prompt (null for an unseeded epoch: nothing to remember). */
  nextCursor: PromptCursor | null;
}

export function computePromptDelta(input: {
  topicId: number;
  sessionId: string | null;
  epoch: ContextEpoch;
  cursor: PromptCursor | null;
  briefing: string;
  messages: readonly PromptMessage[];
  /** For the seed basis: did the seed's own briefing fetch get recorded, and with what hash? */
  seedBriefing: { found: boolean; hash: string | null };
  /** For the seed basis: did the seed's own history fetch get recorded? Absent ⇒ no message counts as delivered. */
  seedHistory?: { found: boolean };
  now: number;
}): PromptDelta {
  const keys = input.messages.map(messageKey);
  const briefingHash = stableBriefingHash(input.briefing);
  if (input.epoch.kind === 'unseeded' || !input.sessionId) {
    return { basis: 'unseeded-full', briefingIncluded: !!input.briefing, messages: [...input.messages], omitted: [], nextCursor: null };
  }
  const seeded = input.epoch;
  const fromSeed = !input.cursor || input.cursor.epoch !== seeded.key;
  let seen: Set<string>;
  let briefingKnown: boolean;
  if (fromSeed) {
    // The seed delivered the topic's recent messages as of `seededAt` — but only
    // when its own history fetch was seen; otherwise nothing counts as delivered.
    seen = new Set(!input.seedHistory?.found ? [] : input.messages.filter((m) => {
      const t = Date.parse(m.timestamp);
      return Number.isFinite(t) && t <= seeded.seededAt;
    }).map(messageKey));
    // The briefing is known only when the seed's own fetch was seen AND it has not changed since.
    briefingKnown = input.seedBriefing.found && input.seedBriefing.hash === briefingHash;
  } else {
    seen = new Set(input.cursor!.seenKeys);
    briefingKnown = input.cursor!.briefingHash === briefingHash;
  }
  const messages: PromptMessage[] = [];
  const omitted: OmittedItem[] = [];
  input.messages.forEach((m, i) => {
    if (seen.has(keys[i])) omitted.push({ k: 'm', id: keys[i] });
    else messages.push(m);
  });
  const briefingIncluded = !!input.briefing && !briefingKnown;
  if (input.briefing && !briefingIncluded && briefingHash) omitted.push({ k: 'b', id: briefingHash });
  const merged = [...(fromSeed ? [...seen] : input.cursor!.seenKeys), ...keys];
  const seenKeys = [...new Set(merged)].slice(-MAX_SEEN_KEYS);
  return {
    basis: fromSeed ? 'seed' : 'last-prompt',
    briefingIncluded,
    messages,
    omitted,
    nextCursor: {
      schema: 'prompt-cursor/1', topicId: input.topicId, sessionId: input.sessionId, epoch: seeded.key,
      seenKeys, briefingHash, updatedAt: input.now,
    },
  };
}

/**
 * Fit a delta for DELIVERY (reduction mode only). A delta that fits `budget`
 * is delivered whole and its cursor is the delta's own. A delta that does not
 * fit is NOT trimmed: that prompt receives the full output instead (which the
 * hook bounds), and the cursor records everything as delivered. Trimming a
 * delta would either starve a large changed briefing forever or drop new
 * messages with no sign to the session that anything was held back.
 */
export function fitDeltaForDelivery(
  topicId: number,
  delta: PromptDelta,
  briefing: string,
  unanswered: readonly PromptMessage[],
  budget = DELTA_DELIVERY_BUDGET_CHARS,
): { fits: true; briefingIncluded: boolean; messages: PromptMessage[]; cursor: PromptCursor | null } | { fits: false; cursor: PromptCursor | null } {
  const size = renderPromptContextText(topicId, delta.briefingIncluded ? briefing : '', delta.messages, { mode: 'delta', unanswered }).length;
  if (size <= budget) return { fits: true, briefingIncluded: delta.briefingIncluded, messages: [...delta.messages], cursor: delta.nextCursor };
  return { fits: false, cursor: delta.nextCursor };
}

// ── The reduction gate ───────────────────────────────────────────────────

export type ReductionVerdict = { allowed: true; reason: 'canary-healthy' } | { allowed: false; reason: string };

/**
 * May this machine return the delta instead of the full output? Only when the
 * switch is on AND the standing compaction canary reads `healthy` for the
 * Claude Code engine here (§7.7 "gated per machine on 9.1 being verified there").
 * Any diverged group refuses; no evidence refuses.
 */
export function reductionVerdict(switchOn: boolean, canary: CanaryReport | null | undefined, sentinelPresent: boolean): ReductionVerdict {
  if (!switchOn) return { allowed: false, reason: 'switch-off' };
  if (!sentinelPresent) return { allowed: false, reason: 'sentinel-off' };
  if (!canary) return { allowed: false, reason: 'canary-not-wired' };
  const groups = canary.groups.filter((g) => g.engine === 'claude-code');
  if (groups.length === 0) return { allowed: false, reason: 'canary-no-claude-code-group' };
  if (groups.some((g) => g.state === 'diverged')) return { allowed: false, reason: 'canary-diverged' };
  // The canary is keyed per machine, engine AND version: the version that ran the
  // newest compaction here is the running one, and it is the one that must be healthy.
  const newest = canary.recent.filter((d) => d.engine === 'claude-code').sort((a, b) => b.at - a.at)[0];
  if (!newest) return { allowed: false, reason: 'canary-no-recent-detection' };
  const running = groups.find((g) => g.version === newest.version);
  if (!running) return { allowed: false, reason: 'canary-running-version-unseen' };
  if (running.state === 'healthy') return { allowed: true, reason: 'canary-healthy' };
  return { allowed: false, reason: `canary-${running.state}` };
}

// ── Fold suppression ─────────────────────────────────────────────────────

/**
 * Is the hook suppressed for this prompt? While a fold is open for the topic
 * (its record is non-terminal, or torn: containment wins) or this session's
 * fold marker exists, the hook injects nothing (§7.7).
 */
export type FoldSuppression = { suppress: true; reason: 'fold-marker' | 'fold-open' } | { suppress: false; note?: 'fold-stale' | 'fold-torn' };

/**
 * Folds are Claude Code only, so a Codex session is never suppressed. Bounded:
 * a non-terminal record older than the fold lock's TTL ceiling, or a torn
 * record, does NOT suppress (the hook prints the full output and the caller
 * logs the note) — a stuck record must not mute a topic indefinitely.
 */
export function foldSuppression(stateDir: string, topicId: number, instarSessionId: string | null | undefined, framework = 'claude-code', now: number = Date.now()): FoldSuppression {
  if (framework !== 'claude-code') return { suppress: false };
  if (instarSessionId && SAFE_ID.test(instarSessionId)) {
    const f = foldMarkerPath(stateDir, instarSessionId);
    if (f && fs.existsSync(f)) return { suppress: true, reason: 'fold-marker' };
  }
  const store = new FoldRecordStore(stateDir);
  const topicKey = String(topicId);
  const open = store.list(topicKey).filter((r) => !TERMINAL_STATES.has(r.state));
  if (open.some((r) => now - r.updatedAt <= FOLD_LOCK_TTL_CEILING_MS)) return { suppress: true, reason: 'fold-open' };
  if (open.length > 0) return { suppress: false, note: 'fold-stale' };
  if (store.tornRecords(topicKey).length > 0) return { suppress: false, note: 'fold-torn' };
  return { suppress: false };
}

// ── The shadow log ───────────────────────────────────────────────────────

export interface ShadowPromptRow {
  t: 'prompt';
  at: number;
  topicId: number;
  session: string | null;
  framework: string;
  epoch: string;
  basis: DeltaBasis;
  /** What the session actually received. */
  returned: 'full' | 'delta';
  fullChars: number;
  deltaChars: number;
  briefingIncluded: boolean;
  omittedCount: number;
  omitted: OmittedItem[];
  reduction: { switchOn: boolean; allowed: boolean; reason: string };
}

export interface ShadowSuppressedRow { t: 'suppressed' | 'fold-not-suppressed'; at: number; topicId: number; session: string | null; reason: string }
export interface ShadowRefetchRow { t: 'history-read'; at: number; topicId: number; route: string; sinceOmissionMs: number; omittedAtPrompt: number }
export type ShadowRow = ShadowPromptRow | ShadowSuppressedRow | ShadowRefetchRow;

export function deltaShadowDir(stateDir: string): string {
  return path.join(contextLayersRoot(stateDir), '_delta-shadow');
}

/** Append-only JSONL, one active file + one rotated file, each ≤ SHADOW_LOG_MAX_BYTES. */
export class DeltaShadowLog {
  constructor(private readonly stateDir: string, private readonly maxBytes = SHADOW_LOG_MAX_BYTES) {}
  file(): string { return path.join(deltaShadowDir(this.stateDir), 'prompts.jsonl'); }
  rotated(): string { return `${this.file()}.1`; }
  append(row: ShadowRow): boolean {
    const f = this.file();
    const line = `${JSON.stringify(row)}\n`;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = fs.statSync(f).size; } catch { size = 0; /* @silent-fallback-ok — no active file yet */ }
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) fs.renameSync(f, this.rotated());
      fs.appendFileSync(f, line, { mode: 0o600 });
      return true;
    } catch {
      return false; // @silent-fallback-ok — the caller records a featureEvidence error; a lost row costs a sample, never the prompt
    }
  }
  rows(): ShadowRow[] {
    const out: ShadowRow[] = [];
    for (const f of [this.rotated(), this.file()]) {
      let raw = '';
      try { raw = fs.readFileSync(f, 'utf-8'); } catch { continue; } // @silent-fallback-ok — a missing segment holds no rows
      for (const ln of raw.split('\n')) {
        if (!ln) continue;
        try { out.push(JSON.parse(ln) as ShadowRow); } catch { /* @silent-fallback-ok — a torn last line is skipped */ }
      }
    }
    return out;
  }
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export interface DeltaShadowSummary {
  prompts: number;
  seededPrompts: number;
  firstPromptsAfterSeed: { count: number; briefingWouldRepeat: number };
  suppressed: number;
  /** Stale or torn fold records that did NOT suppress (the session got the full output). */
  foldNotSuppressed: number;
  returnedDelta: number;
  fullChars: { median: number | null; p95: number | null; total: number };
  deltaChars: { median: number | null; p95: number | null; total: number };
  omittedItems: number;
  refetched: { status: 'nothing-omitted'; count: 0 } | { status: 'unknown'; reason: string; historyReadsAfterOmission: number };
  reductionRefusals: Record<string, number>;
  reworkBaseline: { status: 'unknown'; reason: string };
  log: { file: string; bytes: number; rotatedBytes: number; maxBytes: number };
}

export function summarizeShadow(log: DeltaShadowLog, maxBytes = SHADOW_LOG_MAX_BYTES): DeltaShadowSummary {
  const rows = log.rows();
  const prompts = rows.filter((r): r is ShadowPromptRow => r.t === 'prompt');
  const full = prompts.map((r) => r.fullChars).sort((a, b) => a - b);
  const delta = prompts.map((r) => r.deltaChars).sort((a, b) => a - b);
  const omittedItems = prompts.reduce((n, r) => n + r.omittedCount, 0);
  const reads = rows.filter((r) => r.t === 'history-read').length;
  const refusals: Record<string, number> = {};
  // A delta over the delivery budget is allowed but sent full: counted here so its rate is visible.
  for (const r of prompts) if (r.reduction.switchOn && (!r.reduction.allowed || r.reduction.reason === 'delta-over-budget')) refusals[r.reduction.reason] = (refusals[r.reduction.reason] ?? 0) + 1;
  const firstAfterSeed = prompts.filter((r) => r.basis === 'seed');
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } }; // @silent-fallback-ok — a missing segment is 0 bytes
  return {
    prompts: prompts.length,
    seededPrompts: prompts.filter((r) => r.basis !== 'unseeded-full').length,
    // A first prompt after a seed whose full output repeats the briefing the seed already delivered.
    firstPromptsAfterSeed: { count: firstAfterSeed.length, briefingWouldRepeat: firstAfterSeed.filter((r) => r.omitted.some((o) => o.k === 'b')).length },
    suppressed: rows.filter((r) => r.t === 'suppressed').length,
    foldNotSuppressed: rows.filter((r) => r.t === 'fold-not-suppressed').length,
    returnedDelta: prompts.filter((r) => r.returned === 'delta').length,
    fullChars: { median: quantile(full, 0.5), p95: quantile(full, 0.95), total: full.reduce((a, b) => a + b, 0) },
    deltaChars: { median: quantile(delta, 0.5), p95: quantile(delta, 0.95), total: delta.reduce((a, b) => a + b, 0) },
    omittedItems,
    refetched: omittedItems === 0
      ? { status: 'nothing-omitted', count: 0 }
      : {
          status: 'unknown',
          reason: 'A history read carries no session id, and a session reading a file directly is not observable, so a re-fetch cannot be tied to the item the delta omitted. historyReadsAfterOmission counts every topic history read within 30 minutes of an omission in that topic: an upper bound for HTTP reads only.',
          historyReadsAfterOmission: reads,
        },
    reductionRefusals: refusals,
    reworkBaseline: { status: 'unknown', reason: 'The rework rate comes from the measurement backend (Phase 1 S13), which is not built yet.' },
    log: { file: 'state/context-layers/_delta-shadow/prompts.jsonl', bytes: size(log.file()), rotatedBytes: size(log.rotated()), maxBytes },
  };
}
