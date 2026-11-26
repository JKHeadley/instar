/**
 * Layer cadence and its brakes (context-budget-layered-summaries §6.4, §3.2
 * item 7, decision 7). The topic-intent layer updates on user turns and
 * milestones, and on BOUNDED transcript-growth ticks so a tool-heavy session
 * with no messages still keeps H1 current. Every path here is braked in code,
 * not prose:
 *
 *  - `TopicLayerBudget` — a per-topic daily input-token ceiling and a
 *    component (`LayerUpdate`) daily ceiling. Over either, the update is
 *    DEFERRED (counted, visible on the status and the card), never silently
 *    skipped.
 *  - `tickDue` — a per-session minimum interval (default 10 minutes, growing
 *    with the number of recent updates), skipped while the session is
 *    mid-turn or its transcript has not grown.
 *  - `buildTickDigest` — at most the last K tool names (default 12) and the
 *    first and last 500 characters of each tool result, ≤ 4K tokens total,
 *    scrubbed with `scrubForStore` BEFORE any LLM call, disclosing
 *    "N results sampled".
 *
 * Signal-only: nothing here decides anything about a message or a session; it
 * decides only whether to spend on a layer update.
 */
import fs from 'node:fs';
import { scrubForStore } from '../../core/durableSecretScrub.js';
import { MAX_MESSAGE_CHARS } from '../../core/TopicIntentExtractor.js';
import { redactLiveValues } from '../PostCompactStore.js';

export const LAYER_UPDATE_COMPONENT = 'LayerUpdate';
export const DEFAULT_TICK_BASE_MS = 10 * 60_000;
export const DEFAULT_TICK_TOOL_NAMES = 12;
export const TICK_RESULT_EDGE_CHARS = 500;
/**
 * The digest's bound: what the extractor actually carries (it clips a message
 * to MAX_MESSAGE_CHARS). Within §6.4's "≤ 4K tokens"; a digest the prompt
 * would cut could disclose a sample it never delivered.
 */
export const TICK_MAX_CHARS = MAX_MESSAGE_CHARS;
/** Read at most this much of a transcript's tail per tick. */
export const TICK_TAIL_BYTES = 512 * 1024;

/** Rough token estimate for budgeting (chars / 4, rounded up). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface LayerBudgetLimits {
  /** Per-topic estimated input tokens per rolling 24 h. */
  perTopicDailyInputTokens: number;
  /** All topics together, per rolling 24 h, for the LayerUpdate component. */
  componentDailyInputTokens: number;
}

export const DEFAULT_LAYER_BUDGET: LayerBudgetLimits = {
  perTopicDailyInputTokens: 400_000,
  componentDailyInputTokens: 4_000_000,
};

export type BudgetVerdict = { ok: true } | { ok: false; reason: 'topic-ceiling' | 'component-ceiling' };

export interface LayerBudgetStatus {
  limits: LayerBudgetLimits;
  componentInputTokens24h: number;
  deferred: { topic: number; component: number };
  topics: Array<{ topicKey: string; inputTokens24h: number; deferred: number }>;
}

/** Per-topic and per-component daily token ceilings; over a ceiling ⇒ deferred and counted. */
export class TopicLayerBudget {
  private readonly rows = new Map<string, Array<{ at: number; tokens: number }>>();
  private deferredTopic = 0;
  private deferredComponent = 0;
  private readonly deferredByTopic = new Map<string, number>();

  constructor(private readonly o: { limits?: () => LayerBudgetLimits; now?: () => number } = {}) {}

  private limits(): LayerBudgetLimits { return this.o.limits?.() ?? DEFAULT_LAYER_BUDGET; }
  private now(): number { return (this.o.now ?? Date.now)(); }

  private window(topicKey: string): Array<{ at: number; tokens: number }> {
    const cut = this.now() - 86_400_000;
    const kept = (this.rows.get(topicKey) ?? []).filter((r) => r.at > cut);
    this.rows.set(topicKey, kept);
    return kept;
  }

  private componentTokens(): number {
    let n = 0;
    for (const k of [...this.rows.keys()]) n += this.window(k).reduce((s, r) => s + r.tokens, 0);
    return n;
  }

  /** Reserve `tokens` for one update of `topicKey`, or report why it is deferred. */
  admit(topicKey: string, tokens: number): BudgetVerdict {
    const lim = this.limits();
    const mine = this.window(topicKey).reduce((s, r) => s + r.tokens, 0);
    if (mine + tokens > lim.perTopicDailyInputTokens) {
      this.deferredTopic++;
      this.deferredByTopic.set(topicKey, (this.deferredByTopic.get(topicKey) ?? 0) + 1);
      return { ok: false, reason: 'topic-ceiling' };
    }
    if (this.componentTokens() + tokens > lim.componentDailyInputTokens) {
      this.deferredComponent++;
      this.deferredByTopic.set(topicKey, (this.deferredByTopic.get(topicKey) ?? 0) + 1);
      return { ok: false, reason: 'component-ceiling' };
    }
    this.window(topicKey).push({ at: this.now(), tokens });
    return { ok: true };
  }

  /** Return a reservation whose update never ran (a shed or failed tick), so retries cannot fill the ceiling with phantom spend. */
  refund(topicKey: string, tokens: number): void {
    const rows = this.window(topicKey);
    const i = rows.map((r) => r.tokens).lastIndexOf(tokens);
    if (i >= 0) rows.splice(i, 1);
  }

  status(): LayerBudgetStatus {
    const topics = [...this.rows.keys()].map((k) => ({
      topicKey: k, inputTokens24h: this.window(k).reduce((s, r) => s + r.tokens, 0), deferred: this.deferredByTopic.get(k) ?? 0,
    }));
    return { limits: this.limits(), componentInputTokens24h: this.componentTokens(), deferred: { topic: this.deferredTopic, component: this.deferredComponent }, topics };
  }
}

// ── Transcript-growth ticks ────────────────────────────────────────────────

export interface TickState {
  lastTickAt: number;
  lastSize: number;
  /** Timestamps of recent layer updates for this session (any trigger). */
  recentUpdates: number[];
}

/** The minimum interval: the base, growing with the number of updates in the last hour (×1.5 each, capped at ×6). */
export function tickInterval(baseMs: number, recentUpdateCount: number): number {
  return Math.round(baseMs * Math.min(6, Math.pow(1.5, Math.max(0, recentUpdateCount))));
}

export type TickDecision = { due: true } | { due: false; reason: 'mid-turn' | 'not-grown' | 'interval' };

export function tickDue(s: TickState, o: { now: number; size: number; midTurn: boolean; baseMs?: number }): TickDecision {
  if (o.midTurn) return { due: false, reason: 'mid-turn' };
  if (o.size <= s.lastSize) return { due: false, reason: 'not-grown' };
  const recent = s.recentUpdates.filter((t) => o.now - t < 3_600_000).length;
  if (o.now - s.lastTickAt < tickInterval(o.baseMs ?? DEFAULT_TICK_BASE_MS, recent)) return { due: false, reason: 'interval' };
  return { due: true };
}

export interface TickDigest {
  /** The scrubbed, bounded digest text fed to the extractor. */
  text: string;
  /** Tool results sampled into the digest (disclosed in-band). */
  sampled: number;
  /** Tool results seen in the tail read. */
  seen: number;
  toolNames: string[];
}

function edges(s: string, n: number): string {
  if (s.length <= 2 * n) return s;
  return `${s.slice(0, n)} … [${s.length - 2 * n} chars] … ${s.slice(-n)}`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n');
  return '';
}

/**
 * Build a tick digest from transcript JSONL lines (Claude Code shape). Only
 * tool calls and tool results are read; operator and agent prose already
 * reach the layer through the message path. Each result is scrubbed WHOLE
 * (shape patterns, then the live-value pass) BEFORE it is cut to its edges, so
 * a secret straddling a cut can never survive as a fragment. Newest results
 * first; `sampled` counts exactly the results the digest carries.
 */
export function buildTickDigest(lines: string[], o: { maxToolNames?: number; liveSecrets?: readonly string[]; maxChars?: number } = {}): TickDigest | null {
  const k = o.maxToolNames ?? DEFAULT_TICK_TOOL_NAMES;
  const cap = o.maxChars ?? TICK_MAX_CHARS;
  const calls: string[] = [];
  const results: string[] = [];
  for (const line of lines) {
    let e: { type?: string; message?: { content?: unknown } } | null;
    try { e = JSON.parse(line); } catch { continue; /* @silent-fallback-ok — a torn tail line is skipped */ }
    const content = e?.message?.content;
    if (!e || !Array.isArray(content)) continue;
    for (const c of content as Array<Record<string, unknown>>) {
      if (e.type === 'assistant' && c?.type === 'tool_use' && typeof c.name === 'string') calls.push(c.name);
      if (e.type === 'user' && c?.type === 'tool_result') results.push(resultText(c.content));
    }
  }
  if (calls.length === 0 && results.length === 0) return null;
  const names = calls.slice(-k);
  const newestFirst = results.slice(-k).reverse();
  const header = (n: number) => `[transcript-growth tick: ${n} of ${results.length} recent tool results sampled, newest first; last tools: ${names.join(', ') || 'none'}]`;
  const parts: string[] = [];
  for (const r of newestFirst) {
    const whole = redactLiveValues(scrubForStore(r).text, o.liveSecrets ?? []).text;
    const piece = `--- result ${parts.length + 1} (newest first) ---\n${edges(whole, TICK_RESULT_EDGE_CHARS)}`;
    if ([header(parts.length + 1), ...parts, piece].join('\n').length > cap) break;
    parts.push(piece);
  }
  const text = [header(parts.length), ...parts].join('\n');
  return { text: text.length > cap ? text.slice(0, cap) : text, sampled: parts.length, seen: results.length, toolNames: names };
}

/** The tail of a transcript as whole lines (the first, possibly partial, line dropped). */
export function readTranscriptTail(file: string, maxBytes = TICK_TAIL_BYTES): { lines: string[]; size: number } | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift();
    return { lines: lines.filter(Boolean), size };
  } catch {
    return null; // @silent-fallback-ok — an unreadable transcript is not ticked; the next pass retries
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — close of a read fd */ } }
  }
}

/** Async form of `readTranscriptTail`: never blocks the event loop. */
export async function readTranscriptTailAsync(file: string, maxBytes = TICK_TAIL_BYTES): Promise<{ lines: string[]; size: number } | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift();
    return { lines: lines.filter(Boolean), size };
  } catch {
    return null; // @silent-fallback-ok — an unreadable transcript is not ticked; the next pass retries
  } finally {
    if (fh) { try { await fh.close(); } catch { /* @silent-fallback-ok — close of a read handle */ } }
  }
}
