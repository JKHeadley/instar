/** Fixed child stdin framing. Header metadata is private parent input, never argv. */
import { TextDecoder } from 'node:util';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';

export async function localHistoryWorkerInput(stream: AsyncIterable<Uint8Array>): Promise<{
  header: unknown; body: AsyncIterable<Buffer>;
}> {
  const iterator = stream[Symbol.asyncIterator](); let pending = Buffer.alloc(0);
  const read = async (length: number) => {
    const parts: Buffer[] = []; let remaining = length;
    while (remaining) {
      if (!pending.length) {
        const next = await iterator.next();
        if (next.done || !next.value.length || next.value.length > CHUNK_BYTES) throw new Error('local-history-worker-frame');
        pending = Buffer.from(next.value);
      }
      const take = Math.min(remaining, pending.length); parts.push(Buffer.from(pending.subarray(0, take)));
      pending = pending.subarray(take); remaining -= take;
    }
    const out = Buffer.concat(parts); for (const part of parts) part.fill(0); return out;
  };
  let header: unknown;
  try {
    const size = await read(4), length = size.readUInt32BE(0); size.fill(0);
    if (!length || length > CHUNK_BYTES) throw new Error('local-history-worker-frame');
    const bytes = await read(length);
    try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    finally { bytes.fill(0); }
  } catch (error) {
    pending.fill(0);
    try { await iterator.return?.(); } catch { /* Preserve the framing refusal. */ }
    throw error;
  }
  const body = async function* () {
    try {
      if (pending.length) { const first = pending; pending = Buffer.alloc(0); yield first; }
      while (true) {
        const next = await iterator.next(); if (next.done) return;
        if (!next.value.length || next.value.length > CHUNK_BYTES) throw new Error('local-history-worker-frame');
        yield Buffer.from(next.value);
      }
    } finally { pending.fill(0); await iterator.return?.(); }
  };
  return { header, body: body() };
}
