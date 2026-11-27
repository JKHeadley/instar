/**
 * The deterministic span sampler (context-budget-layered-summaries §6.5, §12
 * "Sampler ceilings"). One sampler for every raw-span read: chunk builds on
 * span close, watermark and PostCompact (Phase 1), and probe generation
 * (Phase 2, §10). Same input ⇒ same output, byte for byte: no clock, no
 * randomness, no model.
 *
 * Selection order (§12 Defaults row "Sampler ceilings"):
 *   1. floor items — every handoff-named or ledger-named entry, ALWAYS
 *      included, even past the ceiling (a floor is never dropped for budget);
 *   2. entries carrying a message id (oldest first);
 *   3. agent prose (oldest first);
 *   4. tool results containing an error (oldest first);
 *   5. the span tail (newest first);
 *   6. tool results containing a file path (newest first).
 * Anything else (tool calls, plain tool output) is taken last, newest first,
 * only while room remains. An entry that does not fit is skipped and the next
 * one tried, so a large early entry never starves smaller later ones.
 *
 * Each non-floor entry is cut to its edges at `maxEntryChars`, disclosed
 * (`clipped`). The selection is returned in ORIGINAL span order with
 * `sampledFrom` (span size), `dropped` (entries not selected) and `chars`, so
 * the caller can disclose "sampled from N entries" in-band.
 *
 * Input is the archive's shape (`ArchivedEntry`-like: entry id, message ids,
 * text fields, metadata), produced by `spanEntriesFromTranscript` /
 * `spanEntriesFromArchive` below, so a span re-read from the archive samples
 * exactly as it did when first read.
 */

/** Default ceiling: 30K tokens (§12), at the layer budget's chars/4 estimate. */
export const DEFAULT_SAMPLER_MAX_CHARS = 30_000 * 4;
/** Default per-entry cut for non-floor entries. */
export const DEFAULT_SAMPLER_ENTRY_CHARS = 4_000;
/** Default span tail: the last N entries. */
export const DEFAULT_SAMPLER_TAIL = 12;

export type SpanEntryKind = 'user-message' | 'user' | 'agent-prose' | 'tool-use' | 'tool-result' | 'system' | 'other';

/** One span entry in the sampler's normalized form. */
export interface SpanEntry {
  entryId: string;
  kind: SpanEntryKind;
  /** The entry's text (already scrubbed when read from the archive). */
  text: string;
  /** TopicMemory message ids this entry carries. */
  messageIds: number[];
  /** A tool result the engine flagged as an error, or whose text reads as one. */
  isError: boolean;
  /** A tool result whose text names a file path. */
  hasFilePath: boolean;
  timestamp: string | null;
  toolName: string | null;
}

export type SampleReason = 'floor' | 'message-id' | 'agent-prose' | 'error' | 'tail' | 'file-path' | 'other';

export interface SampledEntry extends SpanEntry {
  reason: SampleReason;
  /** The text the sample carries (cut to its edges when `clipped`). */
  sampledText: string;
  clipped: boolean;
}

export interface SampleResult {
  /** Selected entries in original span order. */
  entries: SampledEntry[];
  /** Entries in the span. */
  sampledFrom: number;
  /** Entries not selected. */
  dropped: number;
  /** Characters the selection carries. */
  chars: number;
  /** Selected entries cut to their edges. */
  clipped: number;
  /** True when the floor alone exceeded the ceiling (the floor is kept anyway). */
  floorOverBudget: boolean;
  /** The one-line in-band disclosure. */
  disclosure: string;
}

export interface SampleOptions {
  maxChars?: number;
  maxEntryChars?: number;
  tail?: number;
  /** Entry ids that are always included (handoff- or ledger-named). */
  floorIds?: Iterable<string>;
  /** Message ids whose entries are floor too (a ledger entry names a message). */
  floorMessageIds?: Iterable<number>;
}

const ERROR_RE = /\b(?:error|exception|traceback|failed|failure|fatal|panic|ENOENT|EACCES|denied)\b|\bERR!/i;
const FILE_PATH_RE = /(?:^|[\s'"`(=:])(?:~?\/|\.{1,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,8}\b/;

export function looksLikeError(text: string): boolean { return ERROR_RE.test(text); }
export function mentionsFilePath(text: string): boolean { return FILE_PATH_RE.test(text); }

function edges(s: string, n: number): { text: string; clipped: boolean } {
  if (s.length <= n) return { text: s, clipped: false };
  const half = Math.max(1, Math.floor((n - 40) / 2));
  return { text: `${s.slice(0, half)} … [${s.length - 2 * half} chars cut] … ${s.slice(-half)}`, clipped: true };
}

export function sampleSpan(span: readonly SpanEntry[], o: SampleOptions = {}): SampleResult {
  const maxChars = o.maxChars ?? DEFAULT_SAMPLER_MAX_CHARS;
  const entryCap = o.maxEntryChars ?? DEFAULT_SAMPLER_ENTRY_CHARS;
  const tailN = o.tail ?? DEFAULT_SAMPLER_TAIL;
  const floorIds = new Set(o.floorIds ?? []);
  const floorMsgs = new Set(o.floorMessageIds ?? []);
  const chosen = new Map<number, { reason: SampleReason; text: string; clipped: boolean }>();
  let chars = 0;

  const isFloor = (e: SpanEntry) => floorIds.has(e.entryId) || e.messageIds.some((m) => floorMsgs.has(m));
  // 1. The floor: each floor entry cut only at the overall ceiling (never at the per-entry cut), never dropped.
  span.forEach((e, i) => {
    if (!isFloor(e)) return;
    const cut = edges(e.text, Math.max(entryCap, maxChars));
    chosen.set(i, { reason: 'floor', text: cut.text, clipped: cut.clipped });
    chars += cut.text.length;
  });
  const floorOverBudget = chars > maxChars;

  const take = (indices: number[], reason: SampleReason) => {
    for (const i of indices) {
      if (chosen.has(i)) continue;
      const cut = edges(span[i].text, entryCap);
      if (chars + cut.text.length > maxChars) continue;
      chosen.set(i, { reason, text: cut.text, clipped: cut.clipped });
      chars += cut.text.length;
    }
  };
  const idx = span.map((_, i) => i);
  const newestFirst = (xs: number[]) => [...xs].reverse();
  take(idx.filter((i) => span[i].messageIds.length > 0 || span[i].kind === 'user-message'), 'message-id');
  take(idx.filter((i) => span[i].kind === 'agent-prose'), 'agent-prose');
  take(idx.filter((i) => span[i].kind === 'tool-result' && span[i].isError), 'error');
  take(newestFirst(idx.slice(Math.max(0, span.length - tailN))), 'tail');
  take(newestFirst(idx.filter((i) => span[i].kind === 'tool-result' && span[i].hasFilePath)), 'file-path');
  take(newestFirst(idx), 'other');

  const entries: SampledEntry[] = [...chosen.keys()].sort((a, b) => a - b).map((i) => {
    const c = chosen.get(i)!;
    return { ...span[i], reason: c.reason, sampledText: c.text, clipped: c.clipped };
  });
  const dropped = span.length - entries.length;
  const clipped = entries.filter((e) => e.clipped).length;
  const disclosure = dropped === 0 && clipped === 0
    ? `complete: all ${span.length} entries`
    : `sampled from ${span.length} entries: ${entries.length} kept, ${dropped} dropped, ${clipped} cut to their edges`;
  return { entries, sampledFrom: span.length, dropped, chars, clipped, floorOverBudget, disclosure };
}

// ── Normalization: Claude Code JSONL ⇄ archive entries ⇄ span entries ───────

/** The archive input shape (TranscriptArchive.ArchiveEntryInput), kept structural to avoid a cycle. */
export interface SpanArchiveInput {
  entryId: string;
  messageIds?: number[];
  fields: Record<string, string>;
  meta?: Record<string, string | number | boolean | null>;
}

const CHANNEL_PREFIX = /^\s*\[(?:telegram|slack|whatsapp|imessage|app|mobile):[^\]]{1,400}\]/;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).filter(Boolean).join('\n');
  return '';
}

/**
 * One Claude Code transcript line → zero or more archive entries (one per
 * content block, ids `<uuid>` then `<uuid>:<n>`), or null for a line that is
 * not conversation (summaries, snapshots, hook bookkeeping, torn lines).
 * `kind` and the error/file-path flags travel in `meta`, so a span re-read from
 * the archive normalizes identically.
 */
export function archiveEntriesFromTranscriptLine(line: string): { entries: SpanArchiveInput[]; compactBoundary: boolean; lineUuid: string | null } | null {
  let e: { type?: string; subtype?: string; uuid?: string; timestamp?: string; isCompactSummary?: boolean; isMeta?: boolean; message?: { role?: string; content?: unknown } };
  try { e = JSON.parse(line); } catch { return null; /* @silent-fallback-ok — a torn transcript line is not an entry */ }
  if (!e || typeof e !== 'object') return null;
  if (e.type === 'system' && e.subtype === 'compact_boundary') return { entries: [], compactBoundary: true, lineUuid: typeof e.uuid === 'string' ? e.uuid : null };
  if ((e.type !== 'user' && e.type !== 'assistant') || typeof e.uuid !== 'string' || !e.uuid) return null;
  // The post-compaction summary and engine meta lines are not span content.
  if (e.isCompactSummary || e.isMeta) return null;
  const ts = typeof e.timestamp === 'string' ? e.timestamp : null;
  const content = e.message?.content;
  const blocks: Array<{ kind: SpanEntryKind; text: string; tool: string | null; isError: boolean }> = [];
  if (typeof content === 'string') {
    blocks.push({ kind: e.type === 'user' ? (CHANNEL_PREFIX.test(content) ? 'user-message' : 'user') : 'agent-prose', text: content, tool: null, isError: false });
  } else if (Array.isArray(content)) {
    for (const c of content as Array<Record<string, unknown>>) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string') {
        blocks.push({ kind: e.type === 'user' ? (CHANNEL_PREFIX.test(c.text) ? 'user-message' : 'user') : 'agent-prose', text: c.text, tool: null, isError: false });
      } else if (c.type === 'tool_use') {
        let input = '';
        try { input = JSON.stringify(c.input ?? {}); } catch { input = ''; /* @silent-fallback-ok — an unserializable tool input is carried as its name only */ }
        blocks.push({ kind: 'tool-use', text: `${String(c.name ?? 'tool')} ${input}`, tool: typeof c.name === 'string' ? c.name : null, isError: false });
      } else if (c.type === 'tool_result') {
        blocks.push({ kind: 'tool-result', text: blockText(c.content), tool: null, isError: c.is_error === true });
      }
    }
  }
  const entries = blocks.filter((b) => b.text.length > 0).map((b, i) => ({
    entryId: i === 0 ? e.uuid! : `${e.uuid}:${i}`,
    fields: { text: b.text },
    meta: {
      kind: b.kind, ts, tool: b.tool,
      isError: b.kind === 'tool-result' && (b.isError || looksLikeError(b.text)),
      hasFilePath: b.kind === 'tool-result' && mentionsFilePath(b.text),
    },
  }));
  return { entries, compactBoundary: false, lineUuid: e.uuid! };
}

const KINDS: readonly SpanEntryKind[] = ['user-message', 'user', 'agent-prose', 'tool-use', 'tool-result', 'system', 'other'];

/** Archive entries (as written or as read back) → sampler entries. */
export function spanEntriesFromArchive(entries: ReadonlyArray<{ entryId: string; messageIds?: number[]; fields: Record<string, string>; meta?: Record<string, string | number | boolean | null> }>): SpanEntry[] {
  return entries.map((e) => {
    const m = e.meta ?? {};
    const kind = KINDS.includes(m.kind as SpanEntryKind) ? (m.kind as SpanEntryKind) : 'other';
    return {
      entryId: e.entryId,
      kind,
      text: Object.values(e.fields ?? {}).join('\n'),
      messageIds: (e.messageIds ?? []).filter((n) => Number.isSafeInteger(n)),
      isError: m.isError === true,
      hasFilePath: m.hasFilePath === true,
      timestamp: typeof m.ts === 'string' ? m.ts : null,
      toolName: typeof m.tool === 'string' ? m.tool : null,
    };
  });
}
