import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export type TranscriptKind = 'claude' | 'codex';

export interface TranscriptCheckpoint {
  inode: number;
  head_hash: string;
  birth_ms: number;
  offset: number;
  extra?: string | null;
}

export interface TranscriptRequest {
  file: string;
  kind: TranscriptKind;
  checkpoint?: TranscriptCheckpoint;
  detail?: { offset: number; end: number; inode: number; head: string };
}

export interface TranscriptRecord {
  position: number;
  value: Record<string, any>;
}

export interface TranscriptBatch {
  inode: number;
  head: string;
  birthMs: number;
  mtimeMs: number;
  checkpointOffset: number;
  end: number;
  more: boolean;
  records: TranscriptRecord[];
}

const CHUNK_BYTES = 256 * 1024;
const MAX_RECORDS = 128;

export function transcriptObservationId(source: string, nativeId: string): string {
  return createHash('sha256').update(`${source}\u0000${nativeId}`).digest('hex').slice(0, 32);
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 256) : null;
}

function pickUsage(value: Record<string, unknown>, keys: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'number') result[key] = field;
  }
  return result;
}

const CLAUDE_USAGE = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
const CODEX_USAGE = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];

/** Discard message bodies and all other fields that the ledger never uses. */
function projectTranscriptRecord(bytes: Buffer, kind: TranscriptKind): Record<string, any> | undefined {
  if (kind === 'codex' && bytes[0] !== 0x7b) return;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return; }
  if (kind === 'claude') {
    if (value?.type !== 'assistant' || !value.message?.usage || !value.requestId || !value.sessionId || !value.timestamp) return;
    const { requestId, sessionId, timestamp, cwd } = value;
    const { usage, model } = value.message;
    return { type: 'assistant', observationId: transcriptObservationId('claude-transcript', String(requestId)),
      ts: Date.parse(timestamp), sessionId: boundedString(sessionId), cwd: boundedString(cwd),
      message: { usage: pickUsage(usage, CLAUDE_USAGE), model: boundedString(model) } };
  }
  const { type, timestamp, payload } = value ?? {};
  if (!payload || typeof payload !== 'object') return;
  if (type === 'session_meta') {
    return { type, payload: { id: boundedString(payload.id), cwd: boundedString(payload.cwd),
      resumed: Object.keys(payload).some(key => /fork|resum|parent/i.test(key) && payload[key]) } };
  }
  if (type === 'turn_context') return { type, payload: { model: boundedString(payload.model) } };
  if (payload.type === 'token_count' && payload.info?.total_token_usage) {
    return { ts: Date.parse(timestamp ?? ''), payload: { type: 'token_count',
      info: { total_token_usage: pickUsage(payload.info.total_token_usage, CODEX_USAGE) } } };
  }
}

/** Read a bounded batch of complete lines. A long first line is assembled only in the worker. */
export async function readTranscriptBatch(request: TranscriptRequest): Promise<TranscriptBatch | null> {
  const handle = await open(request.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const headBuffer = Buffer.alloc(256);
    const { bytesRead: headSize } = await handle.read(headBuffer, 0, headBuffer.length, 0);
    const head = createHash('sha256').update(headBuffer.subarray(0, headSize)).digest('hex').slice(0, 16);
    const cp = request.checkpoint;
    const same = cp && cp.inode === stat.ino && cp.head_hash === head && stat.size >= cp.offset;
    const checkpointOffset = same ? cp.offset : 0;
    const detail = request.detail;
    if (detail && (!same || detail.inode !== stat.ino || detail.head !== head)) return null;
    const start = detail?.offset ?? checkpointOffset;
    const limit = Math.min(detail?.end ?? stat.size, stat.size);
    const records: TranscriptRecord[] = [];
    let end = start;
    let cursor = start;
    while (cursor < limit && end === start) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, limit - cursor));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
      if (bytesRead === 0) break;
      const slice = buffer.subarray(0, bytesRead);
      let from = 0;
      for (let lf = slice.indexOf(0x0a, from); lf >= 0; lf = slice.indexOf(0x0a, from)) {
        let line = slice.subarray(from, lf);
        const position = end;
        if (position < cursor) {
          // Locate the newline before allocating. An incomplete large line
          // never accumulates in memory or advances the cursor.
          line = Buffer.allocUnsafe(cursor + lf - position);
          let filled = 0;
          while (filled < line.length) {
            const read = await handle.read(line, filled, line.length - filled, position + filled);
            if (read.bytesRead === 0) return null;
            filled += read.bytesRead;
          }
        }
        end = cursor + lf + 1;
        from = lf + 1;
        const value = projectTranscriptRecord(line, request.kind);
        if (value !== undefined) records.push({ position, value });
        if (records.length >= MAX_RECORDS) break;
      }
      cursor += bytesRead;
    }
    if (end === start) return null;
    return { inode: stat.ino, head, birthMs: same ? cp.birth_ms : Math.max(0, Math.floor(stat.birthtimeMs)),
      mtimeMs: stat.mtimeMs, checkpointOffset, end, more: end < limit, records };
  } finally {
    await handle.close();
  }
}
