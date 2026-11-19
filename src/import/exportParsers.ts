/**
 * Turns one conversation from a Claude or ChatGPT export into Instar's imported shape
 * (docs/specs/import-from-claude-chatgpt.md §A.1, §A.2, §B.5, §B.6, §B.8). Tolerant: unknown fields are
 * ignored, and a conversation it can't read returns null (counted by the caller).
 *
 * Every text is passed through the secret scrub before splitting, so a key can't hide across a split.
 */
import crypto from 'node:crypto';
import { scrubForStore } from '../core/durableSecretScrub.js';

export type ImportSource = 'claude' | 'chatgpt';

/** One stored message: at most PART_CHARS characters. A long original becomes numbered parts. */
export interface ImportedMessage {
  /** The original message id (ChatGPT node id, Claude uuid), or a content hash; plus #<part> when split. */
  key: string;
  role: 'operator' | 'agent';
  senderName: string;
  /** ISO time from the export; null when the export had none. */
  at: string | null;
  text: string;
  part?: { n: number; of: number };
}

export interface ImportedConversation {
  from: ImportSource;
  originalId: string;
  title: string;
  createdAt: string | null;
  messages: ImportedMessage[];
  /** Full texts too long for 10 parts, keyed by the message key (kept as attachments). */
  overflow: Array<{ key: string; text: string }>;
  stats: { redactions: number; splitMessages: number; droppedBranches: number };
}

export const PART_CHARS = 16_000;
export const MAX_PARTS = 10;
export const REMOVED_MARKER = '[removed: looked like a secret]';

/** The scrub, with the plain marker the person reads. Returns the text and how many spans were removed. */
export function removeSecrets(text: string): { text: string; removed: number } {
  if (text.length <= SCRUB_WINDOW) return scrubOne(text);
  // The scrub's timing is proven up to its default bound (1 MB), so a longer text is scanned in windows.
  // Windows OVERLAP by SCRUB_OVERLAP and every span is kept in whole-text coordinates, so a match that a
  // window edge cuts in two is found whole by the next window. Cutting at whitespace instead is not
  // enough: some secret shapes carry whitespace inside them (a `Bearer <token>` pair, a `password: value`
  // pair, a private key block), and a long run with no whitespace near the edge forces a cut mid-token.
  const spans: Array<[number, number]> = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(text.length, pos + SCRUB_WINDOW);
    const r = scrubForStore(text.slice(pos, end), { maxBytes: SCRUB_WINDOW });
    let next = end - SCRUB_OVERLAP;
    for (const s of r.redactions) {
      let a = pos + s.offset;
      let b = a + s.length;
      if (b === end && end < text.length) {
        // The match runs into the window edge, so it may continue past it. Its run is removed through to
        // the next whitespace (fail toward removal: a labelled value re-read from its own start has lost
        // its label and would not match again). The next window also starts at the match, so whatever
        // follows the run is read with the match's context.
        while (b < text.length && !/\s/.test(text[b]!)) b++;
        next = a > pos ? Math.min(next, a) : Math.max(next, b);
      }
      spans.push([a, b]);
    }
    if (end >= text.length) break;
    pos = Math.max(pos + 1, next);
  }
  return applySpans(text, spans);
}

const SCRUB_WINDOW = 1_000_000;
/**
 * Longer than every bounded secret shape that must be seen whole to match (a private key block is at most
 * ~8.3 KB, a project key ~4.2 KB). A token run that reaches a window edge is caught by the edge rule
 * above. Not covered: a JWT whose middle segment alone exceeds the overlap, and a label separated from its
 * value by more than the overlap in whitespace.
 */
const SCRUB_OVERLAP = 65_536;

/** A removal longer than this says how much it removed, so a reader knows text is missing (an extended run, a scrub error). */
const LONG_REMOVAL = 1_024;

/** Replace the union of the spans with the marker; overlapping or duplicate spans count once. */
function applySpans(text: string, spans: Array<[number, number]>): { text: string; removed: number } {
  if (!spans.length) return { text, removed: 0 };
  spans.sort((x, y) => (x[0] - y[0]) || (y[1] - x[1]));
  let out = '';
  let last = 0;
  let removed = 0;
  let cur: [number, number] | null = null;
  const flush = (): void => {
    if (!cur) return;
    const len = cur[1] - cur[0];
    out += text.slice(last, cur[0]) + (len > LONG_REMOVAL ? `${REMOVED_MARKER} (${len} characters)` : REMOVED_MARKER);
    last = cur[1];
    removed++;
  };
  for (const s of spans) {
    if (cur && s[0] < cur[1]) cur[1] = Math.max(cur[1], s[1]);
    else { flush(); cur = [s[0], s[1]]; }
  }
  flush();
  return { text: out + text.slice(last), removed };
}

function scrubOne(text: string): { text: string; removed: number } {
  const r = scrubForStore(text);
  if (!r.redactions.length) return { text, removed: 0 };
  return { text: r.text.replace(/\[REDACTED:[a-z0-9_-]+\]/gi, REMOVED_MARKER), removed: r.redactions.length };
}

function hashKey(...parts: string[]): string {
  return `h-${crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`;
}

function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length ? v : null;
}

/** Splits one message into stored parts; beyond MAX_PARTS the whole text goes to overflow. */
function pushMessage(conv: ImportedConversation, key: string, role: ImportedMessage['role'], at: string | null, rawText: string): void {
  const clean = removeSecrets(rawText);
  conv.stats.redactions += clean.removed;
  const text = clean.text;
  const senderName = role === 'operator' ? 'You' : conv.from === 'claude' ? 'Claude' : 'ChatGPT';
  if (text.length <= PART_CHARS) {
    conv.messages.push({ key, role, senderName, at, text });
    return;
  }
  conv.stats.splitMessages++;
  const of = Math.ceil(text.length / PART_CHARS);
  if (of > MAX_PARTS) {
    const shown = MAX_PARTS - 1;
    for (let n = 1; n <= shown; n++) {
      conv.messages.push({ key: `${key}#${n}`, role, senderName, at, text: text.slice((n - 1) * PART_CHARS, n * PART_CHARS), part: { n, of: MAX_PARTS } });
    }
    conv.messages.push({ key: `${key}#${MAX_PARTS}`, role, senderName, at, text: '(This message is longer than the importer shows here. Open "Show the full message" to read all of it.)', part: { n: MAX_PARTS, of: MAX_PARTS } });
    conv.overflow.push({ key, text });
    return;
  }
  for (let n = 1; n <= of; n++) {
    conv.messages.push({ key: `${key}#${n}`, role, senderName, at, text: text.slice((n - 1) * PART_CHARS, n * PART_CHARS), part: { n, of } });
  }
}

function empty(from: ImportSource, originalId: string, title: string, createdAt: string | null): ImportedConversation {
  return { from, originalId, title, createdAt, messages: [], overflow: [], stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 } };
}

/** A Claude conversation: {uuid, name, created_at, chat_messages: [{uuid, sender, text | content[], created_at}]}. */
export function parseClaudeConversation(raw: unknown): ImportedConversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const originalId = str(c.uuid) ?? str(c.id);
  if (!originalId || !Array.isArray(c.chat_messages)) return null;
  const titleRaw = str(c.name) ?? 'Untitled chat';
  const conv = empty('claude', originalId, removeSecrets(titleRaw).text.slice(0, 300), iso(c.created_at));
  c.chat_messages.forEach((m, index) => {
    if (!m || typeof m !== 'object') return;
    const msg = m as Record<string, unknown>;
    const sender = msg.sender;
    if (sender !== 'human' && sender !== 'assistant') return;
    let text = str(msg.text);
    if (!text && Array.isArray(msg.content)) {
      text = msg.content
        .filter((p): p is { type?: unknown; text?: unknown } => !!p && typeof p === 'object')
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n\n') || null;
    }
    if (!text) return;
    const at = iso(msg.created_at);
    const key = str(msg.uuid) ?? hashKey(originalId, String(index), at ?? '', text);
    pushMessage(conv, key, sender === 'human' ? 'operator' : 'agent', at, text);
  });
  return conv;
}

interface GptNode { id?: unknown; parent?: unknown; children?: unknown; message?: unknown }

/**
 * A ChatGPT conversation: a `mapping` tree of nodes. The branch kept is the one ending at
 * `current_node` (what the person last saw); other branches are dropped and counted.
 */
export function parseChatGptConversation(raw: unknown): ImportedConversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const originalId = str(c.conversation_id) ?? str(c.id);
  const mapping = c.mapping;
  if (!originalId || !mapping || typeof mapping !== 'object') return null;
  const nodes = mapping as Record<string, GptNode>;
  const titleRaw = str(c.title) ?? 'Untitled chat';
  const conv = empty('chatgpt', originalId, removeSecrets(titleRaw).text.slice(0, 300), iso(c.create_time));

  // Leaves beyond the one kept are dropped branches.
  const leaves = Object.values(nodes).filter((n) => n && typeof n === 'object' && (!Array.isArray(n.children) || n.children.length === 0)).length;
  conv.stats.droppedBranches = Math.max(0, leaves - 1);

  let cur = str(c.current_node);
  if (!cur || !nodes[cur]) {
    // No current node: the latest-created leaf stands in.
    let best: { id: string; t: number } | null = null;
    for (const [id, n] of Object.entries(nodes)) {
      if (Array.isArray(n?.children) && n.children.length) continue;
      const t = Number((n?.message as Record<string, unknown> | undefined)?.create_time ?? 0) || 0;
      if (!best || t > best.t) best = { id, t };
    }
    cur = best?.id ?? null;
  }
  const chain: GptNode[] = [];
  const seen = new Set<string>();
  while (cur && nodes[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.push(nodes[cur]);
    cur = str(nodes[cur].parent);
  }
  chain.reverse();
  chain.forEach((node, index) => {
    const m = node.message as Record<string, unknown> | undefined;
    if (!m || typeof m !== 'object') return;
    const role = (m.author as Record<string, unknown> | undefined)?.role;
    if (role !== 'user' && role !== 'assistant') return;
    const content = m.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts.filter((p): p is string => typeof p === 'string').join('\n\n').trim();
    if (!text) return;
    const at = iso(m.create_time);
    const key = str(m.id) ?? str(node.id) ?? hashKey(originalId, String(index), at ?? '', text);
    pushMessage(conv, key, role === 'user' ? 'operator' : 'agent', at, text);
  });
  return conv;
}

export interface ImportedProject {
  from: ImportSource;
  originalId: string;
  name: string;
  instructions: string;
  fileNames: string[];
  redactions: number;
}

/** A Claude project: {uuid, name, prompt_template | prompt, docs: [{filename}]}. */
export function parseClaudeProject(raw: unknown): ImportedProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const originalId = str(p.uuid) ?? str(p.id);
  if (!originalId) return null;
  const name = removeSecrets(str(p.name) ?? 'Untitled project');
  const instr = removeSecrets(str(p.prompt_template) ?? str(p.prompt) ?? str(p.description) ?? '');
  const docs = Array.isArray(p.docs) ? p.docs : [];
  const fileNames = docs
    .map((d) => (d && typeof d === 'object' ? str((d as Record<string, unknown>).filename) : null))
    .filter((n): n is string => !!n)
    .map((n) => removeSecrets(n.slice(0, 300)));
  return {
    from: 'claude', originalId, name: name.text.slice(0, 300), instructions: instr.text, fileNames: fileNames.map((f) => f.text),
    redactions: name.removed + instr.removed + fileNames.reduce((n, f) => n + f.removed, 0),
  };
}
