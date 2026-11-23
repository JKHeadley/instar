/** Fixed private parse child. All provenance and selected bytes arrive on stdin,
 * never argv, environment, logs or a client-supplied path. No filesystem writes.
 */
import { holdLocalHistoryChild } from './LocalHistoryChildCustody.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { TextDecoder } from 'node:util';
import { createLocalSessionParser, type LocalSessionSource } from './localSessionParsers.js';
import { MAX_LOCAL_SESSION_BYTES } from './localSessionSnapshot.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';

let terminal = false;

async function run(): Promise<void> {
  if (!process.connected) throw new Error('no-parent');
  const custodyBytes = process.env.INSTAR_LOCAL_HISTORY_CUSTODY;
  delete process.env.INSTAR_LOCAL_HISTORY_CUSTODY;
  if (!custodyBytes || custodyBytes.length > CHUNK_BYTES) throw new Error('no-custody');
  const custody = holdLocalHistoryChild(JSON.parse(custodyBytes));
  // This fork does not run the server shutdown handlers. Close SQLite only in
  // its synchronous exit phase, after all parsing/stream work has stopped.
  process.once('exit', () => custody.close());
  if (!custody.active()) throw new Error('lost-custody');
  process.on('disconnect', () => { if (!terminal) process.exit(71); });
  await new Promise<void>((resolve, reject) => process.send!({ kind: 'ready' }, error => error ? reject(error) : resolve()));
  let prefix = Buffer.alloc(0);
  let headerBytes: number | undefined;
  let parser: ReturnType<typeof createLocalSessionParser> | undefined;
  let declaredBytes = 0;
  let declaredHash = '';
  let seen = 0;
  let pending = '';
  const hash = crypto.createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function consume(text: string): void {
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      parser!.push(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  }
  for await (const value of process.stdin) {
    let chunk = value as Buffer;
    if (!parser) {
      prefix = Buffer.concat([prefix, chunk]);
      if (headerBytes === undefined && prefix.length >= 4) {
        headerBytes = prefix.readUInt32BE(0);
        if (headerBytes < 2 || headerBytes > CHUNK_BYTES) throw new Error('invalid-header');
      }
      if (headerBytes === undefined || prefix.length < 4 + headerBytes) continue;
      const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(4, 4 + headerBytes)));
      if (!header || (header.source !== 'codex' && header.source !== CLAUDE_CODE_FRAMEWORK)
        || typeof header.expectedSessionId !== 'string' || !header.expectedSessionId
        || typeof header.expectedProjectPath !== 'string' || !header.expectedProjectPath
        || !Number.isSafeInteger(header.bytes) || header.bytes <= 0 || header.bytes > MAX_LOCAL_SESSION_BYTES
        || (header.expectedRepresentation !== undefined && !['canonical', 'event-fallback', 'claude-records'].includes(header.expectedRepresentation))
        || typeof header.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(header.sha256)) throw new Error('invalid-header');
      declaredBytes = header.bytes; declaredHash = header.sha256;
      parser = createLocalSessionParser(header.source as LocalSessionSource, {
        expectedSessionId: header.expectedSessionId, expectedProjectPath: header.expectedProjectPath,
        expectedRepresentation: header.expectedRepresentation,
      });
      chunk = prefix.subarray(4 + headerBytes);
    }
    seen += chunk.length;
    if (seen > declaredBytes) throw new Error('source-size');
    hash.update(chunk);
    consume(decoder.decode(chunk, { stream: true }));
    prefix = Buffer.alloc(0);
  }
  if (!parser || seen !== declaredBytes || hash.digest('hex') !== declaredHash) throw new Error('source-mismatch');
  consume(decoder.decode());
  if (pending) parser.push(pending);
  const proposal = parser.finish();
  const serialized = JSON.stringify(proposal);
  const digest = crypto.createHash('sha256');
  let outputBytes = 0;
  // Split UTF-8 at byte boundaries after bounded string slices. Slices may split
  // a UTF-16 surrogate pair; keep that pair together before encoding.
  for (let offset = 0; offset < serialized.length;) {
    let end = Math.min(serialized.length, offset + 32 * 1024);
    const last = serialized.charCodeAt(end - 1);
    if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--;
    const block = Buffer.from(serialized.slice(offset, end));
    digest.update(block); outputBytes += block.length;
    try {
      await new Promise<void>((resolve, reject) => process.stdout.write(block, error => error ? reject(error) : resolve()));
    } finally { block.fill(0); }
    offset = end;
  }
  const outputFinished = once(process.stdout, 'finish');
  process.stdout.end();
  await outputFinished;
  const receipt = { kind: 'complete', bytes: outputBytes, sha256: digest.digest('hex'),
    counts: proposal.counts, representation: proposal.representation };
  await new Promise<void>((resolve, reject) => process.send!(receipt, error => error ? reject(error) : resolve()));
  terminal = true;
  process.disconnect();
}

void run().catch(() => {
  terminal = true;
  // Never serialize the input, parser exception or stack to stderr/IPC.
  if (process.connected) process.send?.({ kind: 'refused', code: 'parser-refused' });
  process.exitCode = 65;
  process.stdin.destroy();
  process.stdout.destroy();
  if (process.connected) process.disconnect();
});
