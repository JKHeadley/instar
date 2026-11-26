import { expect, it } from 'vitest';
import { CHUNK_BYTES } from '../../src/core/appMediaTypes.js';
import { localHistoryWorkerInput } from '../../src/import/LocalHistoryWorkerInput.js';

function frame(header: Buffer, body = Buffer.alloc(0)): Buffer {
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, body]);
}
async function* chunks(bytes: Buffer, width: number) {
  for (let offset = 0; offset < bytes.length; offset += width) yield bytes.subarray(offset, offset + width);
}
it.each([1, 3, 7, CHUNK_BYTES])('preserves binary body after a fragmented private UTF8 header (%i)', async width => {
  const header = { owner: 'synthetic-🌱', files: ['one', 'two'] };
  const body = Buffer.from([0, 255, 10, 123, 0, 129]);
  const input = await localHistoryWorkerInput(chunks(frame(Buffer.from(JSON.stringify(header)), body), width));
  expect(input.header).toEqual(header);
  const result: Buffer[] = [];
  for await (const block of input.body) result.push(block);
  expect(Buffer.concat(result)).toEqual(body);
});
it.each([
  Buffer.alloc(0), Buffer.from([0, 0, 0]), frame(Buffer.alloc(0)),
  frame(Buffer.from('{')), frame(Buffer.from([34, 255, 34])),
  frame(Buffer.alloc(CHUNK_BYTES + 1, 32)),
])('closes upstream when a private header is refused', async bytes => {
  let closed = false;
  async function* source() { try { yield* chunks(bytes, 7); } finally { closed = true; } }
  await expect(localHistoryWorkerInput(source())).rejects.toThrow();
  expect(closed).toBe(true);
});
it('closes upstream when a consumer abandons the body', async () => {
  let closed = false;
  async function* source() {
    try { yield frame(Buffer.from('{}'), Buffer.from('first')); yield Buffer.from('second'); }
    finally { closed = true; }
  }
  const input = await localHistoryWorkerInput(source());
  for await (const _block of input.body) break;
  expect(closed).toBe(true);
});
it('refuses an oversized body block without forwarding it', async () => {
  async function* source() { yield frame(Buffer.from('{}')); yield Buffer.alloc(CHUNK_BYTES + 1); }
  const input = await localHistoryWorkerInput(source());
  await expect((async () => { for await (const _block of input.body) { /* consume */ } })()).rejects.toThrow('local-history-worker-frame');
});
