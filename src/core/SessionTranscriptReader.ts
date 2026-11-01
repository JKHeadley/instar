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
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: string | null;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  /** Pass as `before` for the next older page; null at the start of the file. */
  nextBefore: number | null;
  size: number;
}

const CHUNK = 512 * 1024;
const MAX_TEXT = 4000;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = [i.description, i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.prompt].find((v) => typeof v === 'string' && v.trim());
  const detail = typeof pick === 'string' ? pick.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return detail ? `${name}: ${detail}` : name;
}

/** One transcript record → zero or more readable entries (Claude Code or Codex shapes). */
export function extractEntries(record: unknown, offset: number): TranscriptEntry[] {
  if (!record || typeof record !== 'object') return [];
  const r = record as Record<string, unknown>;
  const at = typeof r.timestamp === 'string' ? r.timestamp : null;
  const out: TranscriptEntry[] = [];
  // Claude Code: { type: 'user'|'assistant', message: { content } }
  if ((r.type === 'user' || r.type === 'assistant') && r.message && typeof r.message === 'object') {
    if (r.isMeta === true || r.isSidechain === true) return [];
    const content = (r.message as Record<string, unknown>).content;
    if (typeof content === 'string') {
      if (content.trim()) out.push({ offset, role: r.type, text: clip(content.trim()), at });
      return out;
    }
    if (!Array.isArray(content)) return [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ offset, role: r.type, text: clip(b.text.trim()), at });
      else if (b.type === 'tool_use' && typeof b.name === 'string') out.push({ offset, role: 'tool', text: toolLine(b.name, b.input), at });
    }
    return out;
  }
  // Codex rollout: { type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } }
  if (r.type === 'response_item' && r.payload && typeof r.payload === 'object') {
    const p = r.payload as Record<string, unknown>;
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
      const text = (p.content as Array<Record<string, unknown>>).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim();
      if (text && !text.startsWith('<environment_context>') && !text.startsWith('<user_instructions>')) out.push({ offset, role: p.role, text: clip(text), at });
    } else if (p.type === 'function_call' && typeof p.name === 'string') {
      let args: unknown = p.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep the string */ } }
      out.push({ offset, role: 'tool', text: toolLine(p.name, args), at });
    }
  }
  return out;
}

/**
 * The `limit` newest entries that start before byte `before` (default: end of file),
 * oldest first. Scans at most MAX_SCAN_BYTES per call; a page that hits that bound
 * returns what it found with `nextBefore` set so the caller can keep going.
 */
export function readTranscriptPage(filePath: string, opts: { before?: number; limit?: number } = {}): TranscriptPage {
  const limit = Math.min(Math.max(opts.limit ?? 150, 1), 500);
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let end = Math.min(typeof opts.before === 'number' && opts.before >= 0 ? opts.before : size, size);
    const found: TranscriptEntry[] = [];
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
        const es = extractEntries(rec, lines[i].off);
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
