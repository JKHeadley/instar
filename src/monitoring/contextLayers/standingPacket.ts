/**
 * The standing packet and its verifier (context-budget-layered-summaries §9.5,
 * §9.7, §9.1, §8, §6, §6.2; Phase 1 S10).
 *
 * Every topic keeps a STANDING PACKET: what the conversation needs to resume
 * after an unplanned compaction (which has no handoff and no verbatim tail).
 * It is re-rendered and verified on every layer commit (debounced per topic),
 * staged on disk for the `SessionStart` (`compact`) hook to READ (the 5 s hook
 * never composes), and read by the spawn path's `formatContextForSession`.
 *
 * Contents, in priority order (§8: protected class first):
 *   1. the Anchor's framing message(s), verbatim from the TopicMemory rows;
 *   2. the ledger's LIVE set (§6.2 `selectLiveSet`): each entry's bound
 *      operator row verbatim, or a one-line derived label when it has none;
 *   3. the operator's last N typed messages (U, `operator` label), verbatim,
 *      each with its derived referent stub beside (never inside) the quote;
 *   4. H1 (current work) and H2 (current phase or `absent`), with their
 *      `as of` freshness stamps and author;
 *   5. H3 (the long-term view) with its stamp;
 *   6. chunk and range pointers for on-demand lookup, and every
 *      "unsummarized gap" a pending chunk declares.
 * A missing layer is a line that says so (in-band), never a silent absence.
 *
 * Size. Claude Code passes a hook's output to the model whole only up to
 * 10,000 characters (2.1.322; larger arrives as a 2 KB preview and a file
 * path). The session-start compact branch fits its whole recovery block to
 * 9,000 (`fit-recovery-output.mjs`, RF). The packet's DELIVERED variant is
 * bounded to `STANDING_PACKET_DELIVERED_MAX_CHARS` (UTF-16 code units, the
 * fitter's unit) so it rides inside that block whole, beside the marker, the
 * Telegram relay line and a short identity head. Over it, the delivered
 * variant is REDUCED in the spec's order (§9.5): H3 first, then the chunk
 * list, then the protected class last — each protected row whole or omitted,
 * never cut (a truncated quote is not verbatim) — and the FULL packet is saved
 * privately (0600, `state/context-layers/_recovery/`, the RF location, never
 * served, never backed up, pruned after 7 days) with an explicit instruction
 * inside the budget to Read it now. Every omission is disclosed in-band.
 *
 * Verification (§9.5 "re-rendered and verified"; §9.7 "the verifier's
 * byte-identity check is against the source row"): a packet is used only
 * after `verifyStandingPacket` passes — size under budget, every rendered
 * protected row byte-identical to BOTH its stored reference (sha256, length)
 * and the TopicMemory row now, the required sections present outside any
 * quote, and every present derived layer stamped `as of`. A failure never
 * delivers a wrong packet: nothing is staged (the hook prints today's
 * RF-fitted legacy block) and the failure is counted and reported. That is a
 * choice of fallback, not new blocking authority.
 *
 * Protected words are rendered here and written ONLY to the transient staged
 * file and the private full-packet file (both under the never-served,
 * never-replicated layer root); the layer store itself keeps references only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TopicIntentFile } from '../../core/TopicIntent.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { contextLayersRoot } from '../clearSeedPointer.js';
import { keepInstructionsDir, readKeepInstructionsPointer, removeKeepInstructions, writeKeepInstructions, KEEP_INSTRUCTIONS_MAX_CHARS } from '../keepInstructions.js';
import { rowRefMatches, type LayerStore, type RowRef, type StoredRecord } from './LayerStore.js';
import { ANCHOR_KEY, RECENT_OPERATOR_TURNS, anchorLedgerView, entryView } from './anchorLedger.js';
import { stubFor } from './userCorpus.js';
import { layerFreshness } from './layerProjection.js';
import { H3_KEY, renderH3 } from './h3Builder.js';

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * The delivered packet's ceiling, in UTF-16 code units. basis:
 * external-constraint — Claude Code's 10,000-character hook-output limit,
 * less the machine-load preamble (~320), the recovery marker, the Telegram
 * relay section (≤ 700), a short identity head and the fitter's Read
 * instruction (~600), all inside the fitter's 9,000.
 */
export const STANDING_PACKET_DELIVERED_MAX_CHARS = 6_000;
/** The hook refuses a staged file over this (a margin over the delivered ceiling for the pointer check). */
export const STANDING_PACKET_HOOK_MAX_CHARS = 6_500;
/** The keep-instructions variant (PreCompact, §9.5): Anchor, live ledger, in-flight work; under KEEP_INSTRUCTIONS_MAX_CHARS. */
export const KEEP_PACKET_MAX_CHARS = 5_000;
/** The spawn path uses the full packet up to this size, else the delivered variant (which points at the full file). */
export const SPAWN_PACKET_MAX_CHARS = 32_000;
/** A full packet over this is refused outright (a sanity bound; never truncated). */
export const STANDING_PACKET_FULL_MAX_CHARS = 1_000_000;
/** Newest operator turns placed ahead of the ledger when the delivered variant must shed protected rows. */
export const NEWEST_TURNS_FIRST = 3;
/** A derived field (H1/H2 goal, trend) is head-cut past this, with disclosure (paraphrase, never a quote). */
export const DERIVED_FIELD_MAX_CHARS = 600;
/** Chunk/range pointers listed in the packet (the rest are counted). */
export const CHUNK_POINTERS_MAX = 12;
/** A staged packet older than this is not delivered by the hook. */
export const STANDING_PACKET_MAX_AGE_MS = 7 * 86_400_000;
/** The feature id (the layers' maturation-ladder entry). */
export const STANDING_PACKET_SOURCE = 'standing-packet';

export const PACKET_HEADER_PREFIX = '=== STANDING PACKET (topic ';
export const PACKET_END = '=== END STANDING PACKET ===';
export const SECTION = {
  anchor: '--- ANCHOR: what this topic is for (the operator\'s framing words, verbatim) ---',
  ledger: '--- DECISIONS AND EVOLUTIONS (live ledger, newest first) ---',
  recent: '--- THE OPERATOR\'S RECENT MESSAGES (verbatim, oldest first) ---',
  h1: '--- CURRENT WORK (H1, derived) ---',
  h2: '--- CURRENT PHASE (H2, derived) ---',
  h3: '--- LONG-TERM VIEW (H3, derived) ---',
  chunks: '--- OLDER DETAIL ON DEMAND (chunks and ranges) ---',
  omitted: '--- WHAT THIS PACKET LEAVES OUT ---',
} as const;
export type SectionKey = keyof typeof SECTION;
/** Sections the DELIVERED packet must carry (each holds content, an `absent:` line, or an omission note). */
export const REQUIRED_SECTIONS: readonly SectionKey[] = ['anchor', 'ledger', 'recent', 'h1', 'h2', 'omitted'];
/** Sections the FULL packet must carry. */
export const REQUIRED_FULL_SECTIONS: readonly SectionKey[] = ['anchor', 'ledger', 'recent', 'h1', 'h2', 'h3', 'chunks', 'omitted'];

const SAFE_TOPIC = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,127}$/;

// ── Inputs ──────────────────────────────────────────────────────────────────

/** The TopicMemory surface the packet reads: one row's exact text by message id. */
export interface PacketRowSource {
  getRow(topicId: number, messageId: number): { text: string; timestamp: string | null } | null;
  countMessagesAfter?(topicId: number, messageId: number): { total: number; fromUser: number } | null;
  topicName?(topicId: number): string | null;
  /** The agent's newest message in the topic (id and time), for the "is the operator's newest message answered" line. */
  lastAgentMessage?(topicId: number): { messageId: number; timestamp: string | null } | null;
}

export interface AssembleOptions {
  /** Where the full packet will be saved when the delivered variant is reduced (embedded in the Read line). */
  fullPacketPath: string;
  /** The topic's TopicIntent file, for the ledger live set's phase and re-reference floor. */
  intent?: TopicIntentFile | null;
  deliveredMaxChars?: number;
  now?: number;
  /** Parts already built for this topic (the stager shares one build between the packet and the keep text). */
  built?: BuiltParts;
}

/** One rendered protected row: where its verbatim text sits in a packet. */
export interface ProtectedSpan {
  kind: 'anchor' | 'ledger' | 'u';
  messageId: number;
  ref: RowRef;
  start: number;
  length: number;
}

export interface SectionInfo { key: SectionKey; present: boolean; chars: number; note: string | null }

export interface StandingPacket {
  topicKey: string;
  builtAt: number;
  full: string;
  fullSpans: ProtectedSpan[];
  delivered: string;
  deliveredSpans: ProtectedSpan[];
  /** True when the delivered variant omits anything the full packet carries. */
  reduced: boolean;
  /** What the delivered variant left out (each disclosed in-band). */
  omitted: string[];
  sections: SectionInfo[];
  /** Protected rows a reference names that TopicMemory no longer holds (each fails verification). */
  missingRows: number[];
  protectedRows: number;
  fullPacketPath: string;
}

// ── Assembly ────────────────────────────────────────────────────────────────

export interface Part {
  id: string;
  section: SectionKey;
  /** Rendered text, and its protected spans with offsets relative to the text. */
  text: string;
  spans: Array<Omit<ProtectedSpan, 'start'> & { start: number }>;
  kind: 'protected' | 'derived' | 'fixed';
  /** How an omission of this part reads in the disclosure. */
  omitLabel: string;
}

const iso = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'time unknown');
const tsOf = (raw: string | null): string => { const t = raw ? Date.parse(raw) : NaN; return Number.isFinite(t) ? iso(t) : (raw ?? 'time unknown'); };
/**
 * Derived text (H1/H2/H3, chunk gaps, stubs) is an LLM output built from
 * transcripts that may contain earlier packets. A derived line must never
 * wear the operator-quote frame, a ledger label or a section header: any such
 * line is prefixed so it reads as quoted derived text, and the verifier
 * refuses a frame-shaped line the renderer did not emit (§9.7 byte identity).
 */
export const FRAME_LINE = /^(\[#|\[end #|\[G |--- |=== )/;
export function neutralizeDerived(text: string): string {
  return text.split('\n').map((l) => (FRAME_LINE.test(l.replace(/^\s+/, '')) ? `> ${l}` : l)).join('\n');
}
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)} [… ${s.length - n} more characters of this derived summary not shown]`);

function authorLine(r: StoredRecord): string {
  const a = r.author;
  return `author: ${a.kind}, machine ${a.machine}${a.sessionId ? `, session ${a.sessionId}` : ''}${a.model ? `, model ${a.model}` : ''}`;
}

/** A verbatim protected row: a header line, the row's exact text, an end line. Spans are relative to the returned text. */
function quotePart(id: string, section: SectionKey, kind: ProtectedSpan['kind'], ref: RowRef, row: { text: string; timestamp: string | null }, header: string, omitLabel: string, extraAfterHeader: string[] = []): Part {
  const head = [header, ...extraAfterHeader].join('\n') + '\n';
  const text = `${head}${row.text}\n[end #${ref.messageId}]`;
  return { id, section, kind: 'protected', text, spans: [{ kind, messageId: ref.messageId, ref, start: head.length, length: row.text.length }], omitLabel };
}

/** Build the packet's parts from the layers. Reads only; never throws on a missing layer (it is disclosed). */
export type BuiltParts = { parts: Part[]; notes: Record<SectionKey, string[]>; missingRows: number[]; protectedPriority: string[] };
export function buildParts(store: LayerStore, rows: PacketRowSource, topicKey: string, o: AssembleOptions): BuiltParts {
  const topicId = Number(topicKey);
  const parts: Part[] = [];
  const notes: Record<SectionKey, string[]> = { anchor: [], ledger: [], recent: [], h1: [], h2: [], h3: [], chunks: [], omitted: [] };
  const missingRows: number[] = [];
  const quoted = new Set<number>();
  const getRow = (id: number) => { try { return Number.isSafeInteger(topicId) ? rows.getRow(topicId, id) : null; } catch { return null; /* @silent-fallback-ok — a row that cannot be read is recorded as missing and fails verification */ } };
  const countAfter = (id: number) => (rows.countMessagesAfter && Number.isSafeInteger(topicId) ? rows.countMessagesAfter(topicId, id) : null);

  // 1. Anchor.
  const anchor = store.read(topicKey, 'anchor', ANCHOR_KEY);
  const anchorIds: string[] = [];
  if (!anchor) notes.anchor.push('absent: the Anchor has not been evaluated for this topic yet.');
  else if (anchor.status !== 'anchored' || !anchor.rows?.length) notes.anchor.push('absent: no-anchor (no operator message frames this topic; H3 carries its purpose).');
  else {
    for (const ref of anchor.rows) {
      const row = getRow(ref.messageId);
      if (!row) { missingRows.push(ref.messageId); notes.anchor.push(`missing: framing message #${ref.messageId} is not in TopicMemory.`); continue; }
      const id = `anchor-${ref.messageId}`;
      parts.push(quotePart(id, 'anchor', 'anchor', ref, row, `[#${ref.messageId} · ${tsOf(row.timestamp)} · operator · framing]`, `Anchor message #${ref.messageId} (${ref.length} characters)`));
      anchorIds.push(id);
      quoted.add(ref.messageId);
    }
  }

  // 2. Ledger live set (§6.2).
  const ledgerIds: string[] = [];
  const recs = new Map(store.list(topicKey, 'ledger-entry').map((r) => [r.entryKey, r]));
  if (recs.size === 0) notes.ledger.push('absent: no decision or evolution has been recorded for this topic.');
  else {
    const view = anchorLedgerView(store, topicKey, o.intent ?? null, { limit: 500 });
    const live = view.entries.filter((e) => e.live);
    if (view.liveSet.live > live.length) notes.ledger.push(`${view.liveSet.live - live.length} older live entries are beyond this listing and not shown (GET /topic/${topicKey}/anchor lists them).`);
    if (live.length === 0) notes.ledger.push(`absent: none of the ${recs.size} ledger entries is live (all superseded, withdrawn or expired).`);
    if (view.liveSet.archived) notes.ledger.push(`${view.liveSet.archived} archived entries are not shown (GET /topic/${topicKey}/anchor lists them).`);
    for (const e of live) {
      const rec = recs.get(e.key);
      const ref = rec?.rows?.[0];
      const label = `[G ${e.type} ${e.key} · ${e.status}${e.cause ? ` · ${e.cause}` : ''}${e.supersedes ? ` · supersedes ${e.supersedes}` : ''}`;
      if (ref) {
        if (quoted.has(ref.messageId)) {
          parts.push({ id: `ledger-${e.key}`, section: 'ledger', kind: 'derived', text: `${label} · bound to #${ref.messageId}, quoted above]`, spans: [], omitLabel: `ledger entry ${e.key}` });
          ledgerIds.push(`ledger-${e.key}`);
          continue;
        }
        const row = getRow(ref.messageId);
        if (!row) { missingRows.push(ref.messageId); notes.ledger.push(`missing: ledger entry ${e.key}'s bound message #${ref.messageId} is not in TopicMemory.`); continue; }
        parts.push(quotePart(`ledger-${e.key}`, 'ledger', 'ledger', ref, row, `${label} · bound to #${ref.messageId} · ${tsOf(row.timestamp)}]`, `ledger entry ${e.key} (message #${ref.messageId}, ${ref.length} characters)`));
        quoted.add(ref.messageId);
      } else {
        const ev = e.evidenceMessageIds.length ? ` · evidence #${e.evidenceMessageIds.slice(0, 5).join(', #')}` : '';
        parts.push({ id: `ledger-${e.key}`, section: 'ledger', kind: 'derived', text: `${label}${ev} · no operator row bound: not settled authority]`, spans: [], omitLabel: `ledger entry ${e.key}` });
      }
      ledgerIds.push(`ledger-${e.key}`);
    }
  }

  // 3. The operator's last N typed messages (U, protected class).
  const ops = store.list(topicKey, 'u')
    .filter((u) => u.data.label === 'operator' && u.data.authority === 'operator' && u.rows?.[0])
    .sort((a, b) => (Number(a.data.rowId) || 0) - (Number(b.data.rowId) || 0))
    .slice(-RECENT_OPERATOR_TURNS);
  const recentIds: string[] = [];
  if (ops.length === 0) notes.recent.push('absent: no operator message has been listed for this topic yet.');
  else {
    // §6 freshness for U: operator rows TopicMemory holds that U has not listed yet are disclosed, never silent.
    const newestRef = ops[ops.length - 1].rows![0];
    let behind: number | null = null;
    try { behind = countAfter(newestRef.messageId)?.fromUser ?? null; } catch { behind = null; /* @silent-fallback-ok — reads as unknown below */ }
    notes.recent.push(behind === null
      ? `as of ${iso(o.now ?? Date.now())}: whether newer operator messages exist is unknown; check the topic's recent messages.`
      : behind > 0
        ? `as of ${iso(o.now ?? Date.now())}: ${behind} newer operator message(s) are in the topic but not in this packet yet; read the topic's recent messages before answering.`
        : `as of ${iso(o.now ?? Date.now())}: the operator corpus is current through #${newestRef.messageId}, the operator's newest message (if it is left out for size below, it is in the full packet).`);
    let agentLast: { messageId: number; timestamp: string | null } | null = null;
    try { agentLast = rows.lastAgentMessage && Number.isSafeInteger(topicId) ? rows.lastAgentMessage(topicId) : null; } catch { agentLast = null; /* @silent-fallback-ok — the line says unknown */ }
    const newestRow = getRow(newestRef.messageId);
    const opAt = newestRow?.timestamp ? Date.parse(newestRow.timestamp) : NaN;
    const agAt = agentLast?.timestamp ? Date.parse(agentLast.timestamp) : NaN;
    if (!agentLast) notes.recent.push('The agent\'s last reply in this topic: unknown.');
    else if (Number.isFinite(opAt) && Number.isFinite(agAt) && opAt > agAt) notes.recent.push(`UNANSWERED: the operator's newest message (#${newestRef.messageId}) came after the agent's last reply (#${agentLast.messageId}, ${tsOf(agentLast.timestamp)}). Answer it.`);
    else notes.recent.push(`The agent's last reply in this topic: #${agentLast.messageId}, ${tsOf(agentLast.timestamp)}.`);
  }
  for (const u of ops) {
    const ref = u.rows![0];
    if (quoted.has(ref.messageId)) {
      parts.push({ id: `u-${ref.messageId}`, section: 'recent', kind: 'derived', text: `[#${ref.messageId} · quoted above]`, spans: [], omitLabel: `operator message #${ref.messageId}` });
      recentIds.push(`u-${ref.messageId}`);
      continue;
    }
    const row = getRow(ref.messageId);
    if (!row) { missingRows.push(ref.messageId); notes.recent.push(`missing: operator message #${ref.messageId} is not in TopicMemory.`); continue; }
    const stub = stubFor(store, topicKey, ref.messageId);
    const extra = stub ? [`derived referent stub (not the operator's words): ${stub.text}`] : [];
    parts.push(quotePart(`u-${ref.messageId}`, 'recent', 'u', ref, row, `[#${ref.messageId} · ${tsOf(row.timestamp)} · operator${u.data.pastedArtifact === true ? ' · pasted artifact, kept whole' : ''}]`, `operator message #${ref.messageId} (${ref.length} characters)`, extra));
    recentIds.push(`u-${ref.messageId}`);
  }

  // 4. H1 and H2 (derived; stamped).
  const stamp = (r: StoredRecord) => layerFreshness(r, countAfter).line;
  const h1 = store.read(topicKey, 'h1', 'current');
  if (!h1) notes.h1.push('absent: no current-work layer has been written for this topic yet (stale: unknown).');
  else {
    const d = h1.data;
    const lines = [`${stamp(h1)} · ${authorLine(h1)}`, `Goal: ${cut(String(d.goal ?? ''), DERIVED_FIELD_MAX_CHARS)}`];
    if (d.trend) lines.push(`Trend: ${cut(String(d.trend), DERIVED_FIELD_MAX_CHARS)}`);
    if (Array.isArray(d.themes) && d.themes.length) lines.push(`Themes: ${cut((d.themes as unknown[]).map(String).join('; '), 400)}`);
    if (typeof d.disclosure === 'string') lines.push(`(${cut(d.disclosure, 200)})`);
    parts.push({ id: 'h1', section: 'h1', kind: 'derived', text: neutralizeDerived(lines.join('\n')), spans: [], omitLabel: 'H1' });
  }
  const h2 = store.read(topicKey, 'h2', 'current');
  if (!h2) notes.h2.push('absent: the phase layer has not been evaluated yet.');
  else if (h2.status !== 'live') notes.h2.push(`absent: no current phase (as of ${iso(h2.asOf.at)}; the topic is a stream of separate requests).`);
  else {
    const d = h2.data;
    parts.push({ id: 'h2', section: 'h2', kind: 'derived', text: [`${stamp(h2)} · ${authorLine(h2)}`, `Phase goal: ${cut(String(d.goal ?? ''), DERIVED_FIELD_MAX_CHARS)}`, ...(d.trend ? [`Trend: ${cut(String(d.trend), DERIVED_FIELD_MAX_CHARS)}`] : [])].join('\n'), spans: [], omitLabel: 'H2' });
    parts[parts.length - 1].text = neutralizeDerived(parts[parts.length - 1].text);
  }

  // 5. H3.
  const h3 = store.read(topicKey, 'h3', H3_KEY);
  if (!h3) notes.h3.push('absent: the long-term view has not been built for this topic yet.');
  else parts.push({ id: 'h3', section: 'h3', kind: 'derived', text: neutralizeDerived(`${stamp(h3)} · ${authorLine(h3)}\n${renderH3(h3)}`), spans: [], omitLabel: `H3, the long-term view (${renderH3(h3).length} characters)` });

  // 6. Chunk and range pointers, and every unsummarized gap.
  const chunks = store.list(topicKey, 'chunk');
  const ranges = store.list(topicKey, 'c2');
  if (chunks.length + ranges.length === 0) notes.chunks.push('absent: no chunk or range summary exists for this topic yet.');
  else {
    const seq = (r: StoredRecord) => (r.recordType === 'c2' && Array.isArray(r.data.seqRange) ? Number((r.data.seqRange as unknown[])[1]) + 0.5 : Number(r.data.seq ?? 0));
    const all = [...chunks, ...ranges].sort((a, b) => seq(b) - seq(a));
    const lines = [`${chunks.length} chunks and ${ranges.length} ranges. Read one: GET /topic/${topicKey}/chunks/<key> on your agent server (bearer token); list them: GET /topic/${topicKey}/chunks.`];
    for (const r of all.slice(0, CHUNK_POINTERS_MAX)) {
      const sr = r.recordType === 'c2' && Array.isArray(r.data.seqRange) ? ` seq ${(r.data.seqRange as unknown[]).join('..')}` : ` seq ${String(r.data.seq ?? '?')}`;
      lines.push(`- ${r.recordType === 'c2' ? 'range' : 'chunk'} ${r.entryKey} ·${sr} · ${r.status ?? 'unknown'} · as of ${iso(r.asOf.at)}${typeof r.data.gap === 'string' ? ` · ${r.data.gap}` : ''}`);
    }
    if (all.length > CHUNK_POINTERS_MAX) lines.push(`(${all.length - CHUNK_POINTERS_MAX} older pointers not listed)`);
    // An unsummarized gap is listed even past the pointer cap (§9.5).
    for (const r of all.slice(CHUNK_POINTERS_MAX)) if (typeof r.data.gap === 'string') lines.push(`- chunk ${r.entryKey} · ${r.data.gap}`);
    parts.push({ id: 'chunks', section: 'chunks', kind: 'derived', text: neutralizeDerived(lines.join('\n')), spans: [], omitLabel: `the chunk and range pointers (${all.length})` });
  }

  // Priority for shedding protected rows from the delivered variant: Anchor,
  // the newest few operator turns, the live ledger, then older turns newest first.
  const newestTurns = [...recentIds].reverse();
  const protectedPriority = [...anchorIds, ...newestTurns.slice(0, NEWEST_TURNS_FIRST), ...ledgerIds, ...newestTurns.slice(NEWEST_TURNS_FIRST)];
  return { parts, notes, missingRows, protectedPriority };
}

const SECTION_ORDER: SectionKey[] = ['anchor', 'ledger', 'recent', 'h1', 'h2', 'h3', 'chunks', 'omitted'];

/** Render the parts that are `included` into one text; omitted parts are listed in the disclosure. */
function renderPackets(topicKey: string, topicName: string | null, builtAt: number, parts: Part[], notes: Record<SectionKey, string[]>, included: Set<string>, sections: readonly SectionKey[], disclosure: { readLine: string | null; extra: string[]; intro?: boolean }): { text: string; spans: ProtectedSpan[]; omitted: string[]; sectionInfo: SectionInfo[] } {
  const out: string[] = [];
  let len = 0;
  const spans: ProtectedSpan[] = [];
  const push = (s: string) => { out.push(s); len += s.length + 1; };
  push(`${PACKET_HEADER_PREFIX}${topicKey}${topicName ? ` "${topicName.replace(/[\r\n"]/g, ' ').slice(0, 80)}"` : ''}, built ${iso(builtAt)}) ===`);
  if (disclosure.intro !== false) push('This is your conversation\'s standing packet, rebuilt from its layers and verified before delivery. Resume the conversation where it left off: do not greet or re-introduce yourself, and if the operator\'s newest message below is unanswered, answer it substantively. Text between a [#id ...] line and its [end #id] line is the operator\'s own words, verbatim; everything else is derived and may be stale (each layer says as of when).');
  const omitted: string[] = [];
  const leftBySection: string[] = [];
  const sectionInfo: SectionInfo[] = [];
  for (const key of SECTION_ORDER) {
    if (!sections.includes(key)) continue;
    const startLen = len;
    push('');
    push(SECTION[key]);
    if (key === 'omitted') {
      const lines = [...disclosure.extra];
      if (omitted.length === 0) lines.push('Nothing: this is the whole packet.');
      else {
        lines.push(`Left out here for size (${omitted.length}), by section: ${leftBySection.join(', ')}. Each section above says which.`);
        if (disclosure.readLine) lines.push(disclosure.readLine);
      }
      for (const l of lines) push(l);
      sectionInfo.push({ key, present: true, chars: len - startLen, note: null });
      continue;
    }
    const mine = parts.filter((p) => p.section === key);
    const left: string[] = [];
    let wrote = 0;
    for (const p of mine) {
      if (!included.has(p.id)) { omitted.push(p.omitLabel); left.push(p.id); continue; }
      for (const s of p.spans) spans.push({ ...s, start: len + s.start });
      push(p.text);
      wrote++;
    }
    // One line per section for whatever it left out (never one per row: a
    // mature topic's placeholders must not crowd out the words themselves).
    // Newest first in the recent section, so the newest omitted turn is always named.
    const named = key === 'recent' ? [...left].reverse() : left;
    if (left.length) push(`(left out for size here: ${left.length} of ${mine.length}: ${named.slice(0, 8).map((x) => x.slice(0, 40)).join(', ')}${left.length > 8 ? `, and ${left.length - 8} more` : ''}; all in the full packet)`);
    if (left.length) leftBySection.push(`${key} ${left.length}`);
    for (const n of notes[key]) push(n);
    sectionInfo.push({ key, present: wrote > 0, chars: len - startLen, note: notes[key][0] ?? null });
  }
  push(PACKET_END);
  // Sections excluded from this variant entirely (the keep variant) are not omissions.
  return { text: out.join('\n'), spans, omitted, sectionInfo };
}

/**
 * Assemble the standing packet for one topic: the full packet, and the
 * delivered variant bounded to the hook's budget (reduced in the spec's
 * order, every omission disclosed, the Read line inside the budget).
 */
export function assembleStandingPacket(store: LayerStore, rows: PacketRowSource, topicKey: string, o: AssembleOptions): StandingPacket {
  const builtAt = o.now ?? Date.now();
  const budget = o.deliveredMaxChars ?? STANDING_PACKET_DELIVERED_MAX_CHARS;
  const { parts, notes, missingRows, protectedPriority } = o.built ?? buildParts(store, rows, topicKey, o);
  let topicName: string | null = null;
  try { topicName = rows.topicName && /^\d+$/.test(topicKey) ? rows.topicName(Number(topicKey)) : null; } catch { topicName = null; /* @silent-fallback-ok — the header omits the name */ }
  const all = new Set(parts.map((p) => p.id));
  const full = renderPackets(topicKey, topicName, builtAt, parts, notes, all, SECTION_ORDER, { readLine: null, extra: [] });
  const readLine = `READ THE FULL PACKET NOW with the Read tool before continuing: ${o.fullPacketPath}`;
  const render = (inc: Set<string>) => renderPackets(topicKey, topicName, builtAt, parts, notes, inc, SECTION_ORDER, { readLine, extra: [] });
  let delivered = full;
  let inc = all;
  if (full.text.length > budget) {
    // §9.5/§12: the protected class is reduced LAST. Fill the budget with the
    // protected rows first (whole rows only, in priority order: the Anchor, the
    // newest turns, the live ledger, older turns), then the derived layers in
    // the reverse of the spec's shedding order — H1, H2, the chunk list, H3 —
    // so H3 is the first thing left out, then the chunk list, then H2 and H1,
    // and an operator row only when even the derived layers are gone.
    const base = new Set<string>();
    for (const id of [...protectedPriority, 'h1', 'h2', 'chunks', 'h3']) {
      if (!all.has(id)) continue;
      const trial = new Set(base); trial.add(id);
      if (render(trial).text.length <= budget) base.add(id);
    }
    inc = base;
    delivered = render(inc);
  }
  return {
    topicKey, builtAt,
    full: full.text, fullSpans: full.spans,
    delivered: delivered.text, deliveredSpans: delivered.spans,
    reduced: delivered.omitted.length > 0,
    omitted: delivered.omitted,
    sections: delivered.sectionInfo,
    missingRows,
    protectedRows: full.spans.length,
    fullPacketPath: o.fullPacketPath,
  };
}

/**
 * The PreCompact keep-instructions variant (§9.5: "keep the Anchor, the
 * ledger rows, the in-flight work"), pre-rendered for `writeKeepInstructions`.
 * Protected rows whole or omitted; bounded under the keep ceiling.
 */
export function renderKeepInstructions(store: LayerStore, rows: PacketRowSource, topicKey: string, o: { intent?: TopicIntentFile | null; now?: number; maxChars?: number; built?: BuiltParts } = {}): { text: string; spans: ProtectedSpan[]; omitted: string[]; missingRows: number[] } {
  const max = Math.min(o.maxChars ?? KEEP_PACKET_MAX_CHARS, KEEP_INSTRUCTIONS_MAX_CHARS);
  const { parts, notes, missingRows, protectedPriority } = o.built ?? buildParts(store, rows, topicKey, { fullPacketPath: '', intent: o.intent, now: o.now });
  const keepSections: SectionKey[] = ['anchor', 'ledger', 'h1', 'omitted'];
  const pre = 'When you write this compaction summary, carry the following forward. The quoted operator words (between a [#id ...] line and its [end #id] line) are the topic\'s framing and decisions: keep them verbatim and whole, never paraphrased. Keep the in-flight work (H1) and any unanswered operator message.';
  const builtAt = o.now ?? Date.now();
  const render = (inc: Set<string>) => {
    const r = renderPackets(topicKey, null, builtAt, parts, notes, inc, keepSections, { readLine: 'The standing packet re-seeds the full set after the compaction.', extra: [], intro: false });
    const text = `${pre}\n\n${r.text}`;
    return { ...r, text, spans: r.spans.map((s) => ({ ...s, start: s.start + pre.length + 2 })) };
  };
  const ids = parts.filter((p) => keepSections.includes(p.section)).map((p) => p.id);
  let inc = new Set(ids);
  let r = render(inc);
  if (r.text.length > max) {
    const base = new Set(ids.filter((id) => !protectedPriority.includes(id)));
    for (const id of protectedPriority.filter((x) => ids.includes(x))) { const t = new Set(base); t.add(id); if (render(t).text.length <= max) base.add(id); }
    inc = base;
    r = render(inc);
  }
  return { text: r.text, spans: r.spans, omitted: r.omitted, missingRows };
}

// ── Verification ────────────────────────────────────────────────────────────

export type VerifyProblem =
  | 'delivered-oversize' | 'full-oversize' | 'protected-row-missing' | 'protected-hash-mismatch'
  | 'protected-row-changed' | 'section-missing' | 'freshness-stamp-missing' | 'read-line-missing' | 'bad-topic'
  | 'forged-quote-frame' | 'unsafe-character';

export interface VerifyResult { ok: boolean; problems: Array<{ problem: VerifyProblem; detail: string }> }

function inSpan(i: number, spans: readonly ProtectedSpan[]): boolean {
  return spans.some((s) => i >= s.start && i < s.start + s.length);
}

/** Index of a header line outside every protected span (an operator may quote a header). */
function headerAt(text: string, header: string, spans: readonly ProtectedSpan[]): number {
  let from = 0;
  for (;;) {
    const i = text.indexOf(`\n${header}\n`, from);
    if (i < 0) return -1;
    if (!inSpan(i + 1, spans)) return i + 1;
    from = i + 1;
  }
}

function checkVariant(name: 'delivered' | 'full', text: string, spans: readonly ProtectedSpan[], required: readonly SectionKey[], rows: PacketRowSource, topicId: number, problems: VerifyResult['problems']): void {
  for (const s of spans) {
    const slice = text.slice(s.start, s.start + s.length);
    if (!rowRefMatches(s.ref, slice)) { problems.push({ problem: 'protected-hash-mismatch', detail: `${name}: #${s.messageId} (${s.kind}) does not match its stored reference` }); continue; }
    let row: { text: string } | null = null;
    try { row = rows.getRow(topicId, s.messageId); } catch { row = null; /* @silent-fallback-ok — reads as missing below */ }
    if (!row) problems.push({ problem: 'protected-row-missing', detail: `${name}: #${s.messageId} is not in TopicMemory` });
    else if (row.text !== slice) problems.push({ problem: 'protected-row-changed', detail: `${name}: #${s.messageId} differs from its TopicMemory row` });
  }
  const at: Partial<Record<SectionKey, number>> = {};
  for (const key of required) {
    const i = headerAt(text, SECTION[key], spans);
    if (i < 0) problems.push({ problem: 'section-missing', detail: `${name}: ${key}` });
    else at[key] = i;
  }
  if (!text.startsWith(PACKET_HEADER_PREFIX) || !text.endsWith(PACKET_END)) problems.push({ problem: 'section-missing', detail: `${name}: header or end line` });
  // Outside the protected spans, a line shaped like a quote frame, a ledger
  // label or a section header must be one the renderer emitted at a known
  // place: otherwise derived text is posing as the operator's verbatim words.
  const headerAtSpan = new Set<number>();
  const endAtSpan = new Map<number, number>();
  for (const s of spans) {
    let h = text.lastIndexOf('\n', s.start - 2) + 1;
    if (text.startsWith('derived referent stub', h)) { headerAtSpan.add(h); h = text.lastIndexOf('\n', h - 2) + 1; }
    headerAtSpan.add(h);
    endAtSpan.set(s.start + s.length + 1, s.messageId);
  }
  const headers = new Set<string>([...Object.values(SECTION), PACKET_END]);
  let ledgerFrom = -1; let ledgerTo = -1;
  let off = 0;
  for (const line of text.split('\n')) {
    const at = off;
    off += line.length + 1;
    if (inSpan(at, spans)) continue;
    if (at === 0) continue; // the packet header line
    if (line === SECTION.ledger) { ledgerFrom = at; ledgerTo = text.length; continue; }
    if (headers.has(line)) { if (ledgerFrom >= 0 && ledgerTo === text.length && at > ledgerFrom) ledgerTo = at; continue; }
    if (!FRAME_LINE.test(line)) continue;
    const endM = /^\[end #(\d+)\]$/.exec(line);
    if (endM && endAtSpan.get(at) === Number(endM[1])) continue;
    if (/^\[#\d+ · /.test(line) && (headerAtSpan.has(at) || /^\[#\d+ · quoted above\]$/.test(line))) continue;
    if (line.startsWith('[G ') && (headerAtSpan.has(at) || (ledgerFrom >= 0 && at > ledgerFrom && at < ledgerTo && /\]$/.test(line)))) continue;
    problems.push({ problem: 'forged-quote-frame', detail: `${name}: a frame-shaped line the renderer did not emit at offset ${at}` });
  }
  // Every present derived layer carries its freshness stamp (§6: "as of <time>").
  const ordered = (Object.entries(at) as Array<[SectionKey, number]>).sort((a, b) => a[1] - b[1]);
  for (const [key, i] of ordered) {
    if (key !== 'h1' && key !== 'h2' && key !== 'h3') continue;
    const next = ordered.find(([, j]) => j > i)?.[1] ?? text.length;
    const body = text.slice(i + SECTION[key].length + 1, next);
    const absent = /^(absent:|\(left out for size)/.test(body.trimStart());
    if (!absent && !/\bas of \d{4}-\d{2}-\d{2}T/.test(body)) problems.push({ problem: 'freshness-stamp-missing', detail: `${name}: ${key}` });
  }
}

/**
 * Check a built packet before it is used (§9.5, §9.7). Signal, plus the
 * choice of fallback: a failure means the packet is not staged and the
 * caller delivers today's block instead.
 */
export function verifyStandingPacket(p: StandingPacket, rows: PacketRowSource, o: { deliveredMaxChars?: number } = {}): VerifyResult {
  const problems: VerifyResult['problems'] = [];
  const topicId = Number(p.topicKey);
  if (!SAFE_TOPIC.test(p.topicKey) || !Number.isSafeInteger(topicId)) return { ok: false, problems: [{ problem: 'bad-topic', detail: p.topicKey.slice(0, 64) }] };
  if (p.delivered.length > (o.deliveredMaxChars ?? STANDING_PACKET_DELIVERED_MAX_CHARS)) problems.push({ problem: 'delivered-oversize', detail: `${p.delivered.length} characters` });
  if (p.full.length > STANDING_PACKET_FULL_MAX_CHARS) problems.push({ problem: 'full-oversize', detail: `${p.full.length} characters` });
  for (const m of p.missingRows) problems.push({ problem: 'protected-row-missing', detail: `#${m}` });
  // A NUL cannot pass through the hook's shell (bash drops it), so a packet
  // carrying one would arrive altered: refused, the older block is used.
  if (p.delivered.includes('\u0000')) problems.push({ problem: 'unsafe-character', detail: 'NUL in the delivered packet' });
  checkVariant('delivered', p.delivered, p.deliveredSpans, REQUIRED_SECTIONS, rows, topicId, problems);
  checkVariant('full', p.full, p.fullSpans, REQUIRED_FULL_SECTIONS, rows, topicId, problems);
  if (p.reduced && !p.delivered.includes(`READ THE FULL PACKET NOW with the Read tool before continuing: ${p.fullPacketPath}`)) problems.push({ problem: 'read-line-missing', detail: 'reduced packet without its Read line' });
  return { ok: problems.length === 0, problems };
}

// ── Staging ─────────────────────────────────────────────────────────────────

export interface StandingPacketPointer {
  schema: 'standing-packet/1';
  topicKey: string;
  /** sha256 of the staged (delivered) text, hex. */
  sha256: string;
  /** Length in UTF-16 code units. */
  chars: number;
  builtAt: number;
  verified: true;
  reduced: boolean;
  /** The saved full packet (absolute), when reduced. */
  fullPath: string | null;
  protectedRows: number;
  omitted: number;
}

export function standingPacketDir(stateDir: string): string { return path.join(contextLayersRoot(stateDir), '_standing'); }
export function recoveryDir(stateDir: string): string { return path.join(contextLayersRoot(stateDir), '_recovery'); }
export function fullPacketPathFor(stateDir: string, topicKey: string): string { return path.join(recoveryDir(stateDir), `packet-${topicKey}.txt`); }

function ensureDir(d: string): void {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(d).isSymbolicLink()) throw new Error(`standing packet directory is a symlink: ${d}`);
  fs.chmodSync(d, 0o700);
}

function writeAtomic(file: string, body: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Drop saved files older than 7 days (the RF rule for `_recovery/`). */
function pruneRecovery(dir: string, now: number): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; /* @silent-fallback-ok — nothing to prune */ }
  for (const f of names) {
    const p = path.join(dir, f);
    try { if (now - fs.statSync(p).mtimeMs > STANDING_PACKET_MAX_AGE_MS) SafeFsExecutor.safeRmSync(p, { force: true, operation: 'src/monitoring/contextLayers/standingPacket.ts:pruneRecovery' }); } catch { /* @silent-fallback-ok — best-effort pruning, as RF's */ }
  }
}

/** Remove a topic's staged packet (pointer first, so the hook goes quiet at once). */
export function unstageStandingPacket(stateDir: string, topicKey: string): void {
  if (!SAFE_TOPIC.test(topicKey)) return;
  const dir = standingPacketDir(stateDir);
  for (const f of [path.join(dir, `${topicKey}.json`), path.join(dir, `${topicKey}.md`)]) {
    if (fs.existsSync(f)) SafeFsExecutor.safeRmSync(f, { force: true, operation: 'src/monitoring/contextLayers/standingPacket.ts:unstage' });
  }
}

/** With the layers off: no staged packet survives, so the hook behaves exactly as today. */
export function clearStagedStandingPackets(stateDir: string): number {
  const dir = standingPacketDir(stateDir);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    SafeFsExecutor.safeRmSync(path.join(dir, f), { force: true, operation: 'src/monitoring/contextLayers/standingPacket.ts:clearStaged' });
    n++;
  }
  // Keep-instructions this feature wrote are withdrawn too (a fold's own are left alone).
  const kdir = keepInstructionsDir(stateDir);
  if (fs.existsSync(kdir)) {
    for (const f of fs.readdirSync(kdir)) {
      const m = /^([A-Za-z0-9_-]{1,128})\.json$/.exec(f);
      if (!m) continue;
      if (readKeepInstructionsPointer(stateDir, m[1])?.source === STANDING_PACKET_SOURCE) removeKeepInstructions(stateDir, m[1]);
    }
  }
  return n;
}

/** Read the staged pointer for a topic (for the route and tests), or null. */
export function readStandingPacketPointer(stateDir: string, topicKey: string): StandingPacketPointer | null {
  if (!SAFE_TOPIC.test(topicKey)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(standingPacketDir(stateDir), `${topicKey}.json`), 'utf-8')) as StandingPacketPointer;
    return v.schema === 'standing-packet/1' && v.topicKey === topicKey ? v : null;
  } catch {
    return null; // @silent-fallback-ok — absent or torn reads as not staged (the hook treats it the same way)
  }
}

/** Write a VERIFIED packet: full file first (when reduced), then the delivered text, then the pointer. */
export function stageStandingPacket(stateDir: string, p: StandingPacket, now: number = Date.now()): StandingPacketPointer {
  if (!SAFE_TOPIC.test(p.topicKey)) throw new Error('unsafe topic key');
  for (const d of [contextLayersRoot(stateDir), standingPacketDir(stateDir), recoveryDir(stateDir)]) ensureDir(d);
  const fullPath = fullPacketPathFor(stateDir, p.topicKey);
  // Always written (never removed on restage): a session told to Read it must
  // never find it gone because a later packet happened to fit. The 7-day prune removes it.
  writeAtomic(fullPath, p.full);
  pruneRecovery(recoveryDir(stateDir), now);
  const body = Buffer.from(p.delivered, 'utf-8');
  const dir = standingPacketDir(stateDir);
  writeAtomic(path.join(dir, `${p.topicKey}.md`), body);
  const pointer: StandingPacketPointer = {
    schema: 'standing-packet/1', topicKey: p.topicKey,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    chars: p.delivered.length, builtAt: p.builtAt, verified: true, reduced: p.reduced,
    fullPath: p.reduced ? fullPath : null, protectedRows: p.protectedRows, omitted: p.omitted.length,
  };
  writeAtomic(path.join(dir, `${p.topicKey}.json`), JSON.stringify(pointer));
  return pointer;
}

// ── The stager: re-render and verify on every layer commit ─────────────────

/** Layer types whose commit re-renders the packet. */
export const PACKET_INPUT_TYPES: ReadonlySet<string> = new Set(['anchor', 'ledger-entry', 'u', 'u-stub', 'h1', 'h2', 'h3', 'chunk', 'c2']);
export const STANDING_PACKET_DEBOUNCE_MS = 5_000;

export interface StandingPacketStagerDeps {
  stateDir: string;
  store: LayerStore;
  rows: PacketRowSource;
  /** The topic's TopicIntent file (live-set phase and re-reference floor); null when unavailable. */
  intent?: (topicId: number) => TopicIntentFile | null;
  /** This machine's live Claude Code sessions bound to the topic (Instar session ids), for the keep-instructions. */
  sessionsForTopic?: (topicId: number) => string[];
  /** Every live session id on this machine: keep-instructions this feature wrote for an ended session are swept. */
  liveSessionIds?: () => string[];
  /** Verification failure (counted by the stager; this reports it: DegradationReporter + featureEvidence). */
  onVerifyFailed?: (topicKey: string, result: VerifyResult) => void;
  /** A staged packet (featureEvidence). */
  onStaged?: (topicKey: string, pointer: StandingPacketPointer) => void;
  now?: () => number;
  debounceMs?: number;
}

export interface StandingPacketStatus {
  staged: number;
  verifyFailed: number;
  failedByProblem: Record<string, number>;
  reduced: number;
  stageErrors: number;
  keepWritten: number;
  keepSkippedFold: number;
  keepFailed: number;
  keepWithdrawn: number;
  keepSwept: number;
  scheduled: number;
  last: Array<{ topicKey: string; at: number; ok: boolean; deliveredChars: number; fullChars: number; reduced: boolean; omitted: number; protectedRows: number; problems: string[] }>;
}

export type StageOutcome =
  | { ok: true; packet: StandingPacket; pointer: StandingPacketPointer }
  | { ok: false; reason: 'verify-failed'; result: VerifyResult; packet: StandingPacket }
  | { ok: false; reason: 'stage-error' | 'bad-topic'; detail: string };

export class StandingPacketStager {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly st: Omit<StandingPacketStatus, 'scheduled' | 'last'> = { staged: 0, verifyFailed: 0, failedByProblem: {}, reduced: 0, stageErrors: 0, keepWritten: 0, keepSkippedFold: 0, keepFailed: 0, keepWithdrawn: 0, keepSwept: 0 };
  private readonly last = new Map<string, StandingPacketStatus['last'][number]>();
  private stopped = false;

  constructor(private readonly d: StandingPacketStagerDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** A layer commit for a topic: re-render after a short debounce (coalesces a burst of writes). */
  request(topicKey: string): void {
    if (this.stopped || !/^\d{1,15}$/.test(topicKey) || this.timers.has(topicKey)) return;
    const t = setTimeout(() => {
      this.timers.delete(topicKey);
      // Only topics with a live session here: nothing would read the packet otherwise (the spawn path builds its own).
      const sessions = this.d.sessionsForTopic?.(Number(topicKey)) ?? [];
      if (sessions.length === 0) return;
      this.stageNow(topicKey);
    }, this.d.debounceMs ?? STANDING_PACKET_DEBOUNCE_MS);
    t.unref?.();
    this.timers.set(topicKey, t);
  }

  /** Assemble, verify and stage now. A failure unstages (the hook falls back to today's block) and is reported. */
  stageNow(topicKey: string): StageOutcome {
    if (!/^\d{1,15}$/.test(topicKey)) return { ok: false, reason: 'bad-topic', detail: topicKey.slice(0, 64) };
    const topicId = Number(topicKey);
    let intent: TopicIntentFile | null = null;
    try { intent = this.d.intent?.(topicId) ?? null; } catch { intent = null; /* @silent-fallback-ok — the live set falls back to no phase and no re-references (the route's behaviour) */ }
    const fullPacketPath = fullPacketPathFor(this.d.stateDir, topicKey);
    this.sweepEndedKeep();
    let packet: StandingPacket;
    let built: BuiltParts;
    try {
      built = buildParts(this.d.store, this.d.rows, topicKey, { fullPacketPath, intent, now: this.now() });
      packet = assembleStandingPacket(this.d.store, this.d.rows, topicKey, { fullPacketPath, intent, now: this.now(), built });
    } catch (e) {
      this.st.stageErrors++;
      this.unstage(topicKey);
      return { ok: false, reason: 'stage-error', detail: e instanceof Error ? e.message : String(e) };
    }
    const result = verifyStandingPacket(packet, this.d.rows);
    const record = (ok: boolean) => {
      this.last.set(topicKey, { topicKey, at: this.now(), ok, deliveredChars: packet.delivered.length, fullChars: packet.full.length, reduced: packet.reduced, omitted: packet.omitted.length, protectedRows: packet.protectedRows, problems: result.problems.map((p) => p.problem) });
      if (this.last.size > 50) this.last.delete(this.last.keys().next().value as string);
    };
    if (!result.ok) {
      this.st.verifyFailed++;
      for (const p of result.problems) this.st.failedByProblem[p.problem] = (this.st.failedByProblem[p.problem] ?? 0) + 1;
      this.unstage(topicKey);
      record(false);
      try { this.d.onVerifyFailed?.(topicKey, result); } catch { /* @silent-fallback-ok — the reporter is a side channel; the failure is already counted */ }
      return { ok: false, reason: 'verify-failed', result, packet };
    }
    let pointer: StandingPacketPointer;
    try {
      pointer = stageStandingPacket(this.d.stateDir, packet, this.now());
    } catch (e) {
      this.st.stageErrors++;
      this.unstage(topicKey);
      return { ok: false, reason: 'stage-error', detail: e instanceof Error ? e.message : String(e) };
    }
    this.st.staged++;
    if (packet.reduced) this.st.reduced++;
    record(true);
    try { this.d.onStaged?.(topicKey, pointer); } catch { /* @silent-fallback-ok — evidence is a side channel */ }
    this.writeKeep(topicKey, intent, built);
    return { ok: true, packet, pointer };
  }

  /** Keep-instructions this feature wrote for sessions no longer running here (they quote operator rows): removed, at most every 10 minutes. */
  private lastSweep = 0;
  private sweepEndedKeep(): void {
    if (!this.d.liveSessionIds || this.now() - this.lastSweep < 10 * 60_000) return;
    this.lastSweep = this.now();
    let live: Set<string>;
    try { live = new Set(this.d.liveSessionIds()); } catch { return; /* @silent-fallback-ok — no session list, no sweep this time */ }
    const dir = keepInstructionsDir(this.d.stateDir);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; /* @silent-fallback-ok — no keep directory yet */ }
    for (const f of names) {
      const m = /^([A-Za-z0-9_-]{1,128})\.json$/.exec(f);
      if (!m || live.has(m[1])) continue;
      if (readKeepInstructionsPointer(this.d.stateDir, m[1])?.source === STANDING_PACKET_SOURCE) { removeKeepInstructions(this.d.stateDir, m[1]); this.st.keepSwept++; }
    }
  }

  /** The PreCompact producer (§9.1, §9.5): pre-rendered keep-instructions for every live session of the topic. */
  private writeKeep(topicKey: string, intent: TopicIntentFile | null, built: BuiltParts): void {
    const sessions = this.d.sessionsForTopic?.(Number(topicKey)) ?? [];
    if (sessions.length === 0) return;
    let keep: ReturnType<typeof renderKeepInstructions>;
    try { keep = renderKeepInstructions(this.d.store, this.d.rows, topicKey, { intent, now: this.now(), built }); } catch { this.st.keepFailed++; return; }
    // The keep text quotes protected rows too: it is written only when each is byte-identical to its row.
    const topicId = Number(topicKey);
    const bad = keep.missingRows.length > 0 || keep.spans.some((s) => {
      const slice = keep.text.slice(s.start, s.start + s.length);
      let row: { text: string } | null = null;
      try { row = this.d.rows.getRow(topicId, s.messageId); } catch { row = null; }
      return !rowRefMatches(s.ref, slice) || !row || row.text !== slice;
    });
    for (const sid of sessions) {
      // A fold's own keep-instructions (source fold:…) are never overwritten.
      const prev = readKeepInstructionsPointer(this.d.stateDir, sid);
      if (prev && prev.source.startsWith('fold:')) { this.st.keepSkippedFold++; continue; }
      if (bad) { if (prev?.source === STANDING_PACKET_SOURCE) removeKeepInstructions(this.d.stateDir, sid); this.st.keepFailed++; continue; }
      const w = writeKeepInstructions(this.d.stateDir, { instarSessionId: sid, text: keep.text, source: STANDING_PACKET_SOURCE }, this.now());
      if (w.written) this.st.keepWritten++; else this.st.keepFailed++;
    }
  }

  /**
   * A packet that cannot be verified is withdrawn everywhere it was carried:
   * the staged packet, the saved full packet, and the keep-instructions this
   * feature wrote for the topic's sessions (they quote the same rows). A
   * fold's keep-instructions are left alone.
   */
  private unstage(topicKey: string): void {
    try {
      unstageStandingPacket(this.d.stateDir, topicKey);
      const full = fullPacketPathFor(this.d.stateDir, topicKey);
      if (fs.existsSync(full)) SafeFsExecutor.safeRmSync(full, { force: true, operation: 'src/monitoring/contextLayers/standingPacket.ts:withdraw' });
      for (const sid of this.d.sessionsForTopic?.(Number(topicKey)) ?? []) {
        if (readKeepInstructionsPointer(this.d.stateDir, sid)?.source === STANDING_PACKET_SOURCE) { removeKeepInstructions(this.d.stateDir, sid); this.st.keepWithdrawn++; }
      }
    } catch { /* @silent-fallback-ok — an unremovable pointer still fails the hook's hash check once the text changes; counted as a stage error */ this.st.stageErrors++; }
  }

  /**
   * The spawn path (§6: `formatContextForSession` reads the packet): a fresh,
   * verified packet text for the topic, or null (the caller keeps today's
   * context). Also refreshes the staged copy.
   */
  packetForSession(topicId: number): string | null {
    const r = this.stageNow(String(topicId));
    if (!r.ok) return null;
    return r.packet.full.length <= SPAWN_PACKET_MAX_CHARS ? r.packet.full : r.packet.delivered;
  }

  status(): StandingPacketStatus {
    return { ...this.st, failedByProblem: { ...this.st.failedByProblem }, scheduled: this.timers.size, last: [...this.last.values()].slice(-20) };
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** The route's view of one topic's packet: sizes, sections, verification — never the words. */
export function standingPacketView(stager: StandingPacketStager, stateDir: string, topicKey: string, rows: PacketRowSource, intent: TopicIntentFile | null, store: LayerStore) {
  const packet = assembleStandingPacket(store, rows, topicKey, { fullPacketPath: fullPacketPathFor(stateDir, topicKey), intent });
  const v = verifyStandingPacket(packet, rows);
  const staged = readStandingPacketPointer(stateDir, topicKey);
  return {
    topicKey,
    builtAt: packet.builtAt,
    budget: { deliveredMaxChars: STANDING_PACKET_DELIVERED_MAX_CHARS, hookLimitChars: 10_000, fitterLimitChars: 9_000 },
    deliveredChars: packet.delivered.length,
    fullChars: packet.full.length,
    reduced: packet.reduced,
    omitted: packet.omitted.length,
    protectedRows: packet.protectedRows,
    deliveredProtectedRows: packet.deliveredSpans.length,
    sections: packet.sections.map((s) => ({ key: s.key, present: s.present, chars: s.chars, absent: s.note?.startsWith('absent:') ?? false })),
    verification: { ok: v.ok, problems: v.problems.map((p) => p.problem) },
    staged: staged ? { chars: staged.chars, builtAt: staged.builtAt, reduced: staged.reduced, omitted: staged.omitted, protectedRows: staged.protectedRows } : null,
    stager: stager.status(),
  };
}
