/**
 * Read a session's own conversation record (the framework transcript) a page at a
 * time, newest first, for the console's History view.
 *
 * Why: interactive sessions draw full-screen in tmux's alternate screen, so tmux keeps
 * no scrollback and the live terminal can only show the current screen. The framework
 * transcript (Claude Code JSONL, Codex rollout JSONL) holds the whole conversation.
 *
 * Read-only and bounded: a page reads backward from a byte offset in fixed chunks, never
 * the whole file, and each entry's text is clipped.
 */
import fs from 'node:fs';

export interface TranscriptEntry {
  /** Byte offset of the record's line: stable, used as the cursor. */
  offset: number;
  /** Position among the entries of the same record. With `offset` it names one entry exactly. */
  index: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: string | null;
  /** Set when the text was cut at MAX_TEXT characters; the same page read with `full` has it whole. */
  clipped?: true;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  /** Pass as `before` for the next older page; null at the start of the file. */
  nextBefore: number | null;
  /** With `nextBefore`: the entries of the record at that offset with a lower index are still unread. */
  nextBeforeIndex?: number;
  size: number;
}

const CHUNK = 512 * 1024;
const MAX_TEXT = 4000;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

export const TRANSCRIPT_MAX_TEXT = MAX_TEXT;

function toolLine(name: string, input: unknown, clean: (s: string) => string): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = [i.description, i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.prompt].find((v) => typeof v === 'string' && v.trim());
  const detail = typeof pick === 'string' ? clean(pick).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return detail ? `${name}: ${detail}` : name;
}

/** One transcript record → zero or more readable entries (Claude Code or Codex shapes). */
export function extractEntries(record: unknown, offset: number, clean: (s: string) => string = (s) => s, opts: { full?: boolean } = {}): TranscriptEntry[] {
  const out = extractRaw(record, offset, clean, opts.full === true);
  out.forEach((e, i) => { e.index = i; });
  return out;
}

// `clipped` travels on the text through a marker object so each push site stays one line.
type Draft = Omit<TranscriptEntry, 'index'> & { index?: number };

function extractRaw(record: unknown, offset: number, clean: (s: string) => string, full: boolean): TranscriptEntry[] {
  // `clean` runs before the clip, so a cut can't leave the start of something it would have removed.
  // A cut is never silent: the entry says so, and `full` turns the cut off.
  const out: Draft[] = [];
  const push = (role: TranscriptEntry['role'], raw: string, at: string | null): void => {
    const text = clean(raw);
    if (!full && text.length > MAX_TEXT) out.push({ offset, role, text: `${text.slice(0, MAX_TEXT)}…`, at, clipped: true });
    else out.push({ offset, role, text, at });
  };
  if (!record || typeof record !== 'object') return [];
  const r = record as Record<string, unknown>;
  const at = typeof r.timestamp === 'string' ? r.timestamp : null;
  // Claude Code: { type: 'user'|'assistant', message: { content } }
  if ((r.type === 'user' || r.type === 'assistant') && r.message && typeof r.message === 'object') {
    if (r.isMeta === true || r.isSidechain === true) return [];
    const content = (r.message as Record<string, unknown>).content;
    if (typeof content === 'string') {
      if (content.trim()) push(r.type, content.trim(), at);
      return out as TranscriptEntry[];
    }
    if (!Array.isArray(content)) return [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) push(r.type, b.text.trim(), at);
      else if (b.type === 'tool_use' && typeof b.name === 'string') out.push({ offset, role: 'tool', text: toolLine(b.name, b.input, clean), at });
    }
    return out as TranscriptEntry[];
  }
  // Codex rollout: { type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } }
  if (r.type === 'response_item' && r.payload && typeof r.payload === 'object') {
    const p = r.payload as Record<string, unknown>;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
      const text = (p.content as Array<Record<string, unknown>>).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim();
      if (text && !text.startsWith('<environment_context>') && !text.startsWith('<user_instructions>')) push(p.role, text, at);
    } else if (p.type === 'function_call' && typeof p.name === 'string') {
      let args: unknown = p.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep the string */ } }
      out.push({ offset, role: 'tool', text: toolLine(p.name, args, clean), at });
    }
  }
  return out as TranscriptEntry[];
}

/**
 * The `limit` newest entries that start before byte `before` (default: end of file),
 * oldest first. Scans at most MAX_SCAN_BYTES per call; a page that hits that bound
 * returns what it found with `nextBefore` set so the caller can keep going.
 */
export function readTranscriptPage(filePath: string, opts: { before?: number; beforeIndex?: number; limit?: number; clean?: (s: string) => string; full?: boolean } = {}): TranscriptPage {
  const limit = Math.min(Math.max(opts.limit ?? 150, 1), 500);
  const extract = { full: opts.full === true };
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let end = Math.min(typeof opts.before === 'number' && opts.before >= 0 ? opts.before : size, size);
    const found: TranscriptEntry[] = [];
    // An offset-plus-index cursor: the entries of the record AT `before` that come before
    // `beforeIndex` are still unread (a page that ended inside one record).
    if (typeof opts.beforeIndex === 'number' && opts.beforeIndex > 0 && typeof opts.before === 'number' && opts.before < size) {
      const rec = readRecordAt(fd, opts.before, size);
      const es = rec === undefined ? [] : extractEntries(rec, opts.before, opts.clean, extract).filter((e) => e.index < opts.beforeIndex!);
      for (let j = es.length - 1; j >= 0; j--) found.push(es[j]);
    }
    let carry = Buffer.alloc(0);
    let scanned = 0;
    let stoppedAt: number | null = null;
    while (end > 0 && found.length < limit && scanned < MAX_SCAN_BYTES) {
      const start = Math.max(0, end - CHUNK);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      scanned += buf.length;
      let data = Buffer.concat([buf, carry]);
      // Every complete line lies after the first newline (unless this chunk starts the file).
      let cut = start === 0 ? 0 : data.indexOf(0x0a) + 1;
      if (start !== 0 && cut === 0) { carry = data; end = start; continue; }
      carry = data.subarray(0, cut);
      const body = data.subarray(cut);
      const lines: Array<{ off: number; text: string }> = [];
      let pos = 0;
      while (pos < body.length) {
        const nl = body.indexOf(0x0a, pos);
        const stop = nl === -1 ? body.length : nl;
        if (stop > pos) lines.push({ off: start + cut + pos, text: body.subarray(pos, stop).toString('utf8') });
        pos = stop + 1;
      }
      // Stop only between lines, so a line's entries are never split across pages.
      for (let i = lines.length - 1; i >= 0; i--) {
        if (found.length >= limit) { stoppedAt = lines[i + 1].off; break; }
        let rec: unknown;
        try { rec = JSON.parse(lines[i].text); } catch { continue; }
        const es = extractEntries(rec, lines[i].off, opts.clean, extract);
        for (let j = es.length - 1; j >= 0; j--) found.push(es[j]);
      }
      if (stoppedAt !== null) break;
      end = start;
      data = Buffer.alloc(0);
    }
    found.reverse();
    // Older data remains: before the line we stopped at, or before the unread partial line.
    const boundary = stoppedAt ?? end + carry.length;
    return { entries: found, nextBefore: boundary > 0 ? boundary : null, size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether `offset` is the first byte of a record (the file start, or just after a newline). */
export function isRecordStart(filePath: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0) return false;
  if (offset === 0) return true;
  const fd = fs.openSync(filePath, 'r');
  try {
    if (offset >= fs.fstatSync(fd).size) return false;
    const b = Buffer.alloc(1);
    fs.readSync(fd, b, 0, 1, offset - 1);
    return b[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/** The parsed record that starts at `offset`, read forward to its newline (bounded by MAX_SCAN_BYTES). */
function readRecordAt(fd: number, offset: number, size: number): unknown {
  const parts: Buffer[] = [];
  let pos = offset;
  while (pos < size && pos - offset < MAX_SCAN_BYTES) {
    const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
    fs.readSync(fd, buf, 0, buf.length, pos);
    const nl = buf.indexOf(0x0a);
    if (nl !== -1) { parts.push(buf.subarray(0, nl)); break; }
    parts.push(buf);
    pos += buf.length;
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return undefined; } // @silent-fallback-ok — an unparseable record yields no entries, as in the backward scan
}
