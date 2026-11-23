/** Fixed private parse child. All provenance and selected bytes arrive on stdin,
 * never argv, environment, logs or a client-supplied path. No history mutation.
 */
import { holdLocalHistoryChild } from './LocalHistoryChildCustody.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { TextDecoder } from 'node:util';
import { createLocalSessionParser, localSessionOriginalId, type LocalSessionSource } from './localSessionParsers.js';
import { ImportedHistoryStore } from './ImportedHistoryStore.js';
import type { LocalSourceClaim } from './LocalSourceIdentity.js';
import { MAX_LOCAL_SESSION_BYTES } from './localSessionSnapshot.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';

let terminal = false;

async function run(): Promise<void> {
  if (!process.connected) throw new Error('no-parent');
  const custodyBytes = process.env.INSTAR_LOCAL_HISTORY_CUSTODY;
  delete process.env.INSTAR_LOCAL_HISTORY_CUSTODY;
  if (!custodyBytes || custodyBytes.length > CHUNK_BYTES) throw new Error('no-custody');
  const custodyToken = JSON.parse(custodyBytes);
  const custody = holdLocalHistoryChild(custodyToken);
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
  let previousClaim: Readonly<LocalSourceClaim> | null = null;
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
        || (header.ownerUserId !== undefined && (typeof header.ownerUserId !== 'string' || !header.ownerUserId.trim()
          || header.ownerUserId.includes('\0') || Buffer.byteLength(header.ownerUserId) > 256))
        || !Number.isSafeInteger(header.bytes) || header.bytes <= 0 || header.bytes > MAX_LOCAL_SESSION_BYTES
        || (header.expectedRepresentation !== undefined && !['canonical', 'event-fallback', 'claude-records'].includes(header.expectedRepresentation))
        || typeof header.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(header.sha256)) throw new Error('invalid-header');
      declaredBytes = header.bytes; declaredHash = header.sha256;
      if (header.ownerUserId !== undefined && fs.existsSync(path.join(custodyToken.stateDir, 'imported-history'))) {
        // Manifest hydration and authoritative source-mode lookup stay inside
        // the admitted, bounded child. This path never claims or appends data.
        previousClaim = new ImportedHistoryStore(custodyToken.stateDir, { existingOnly: true }).readLocalSourceClaim({
          ownerUserId: header.ownerUserId, source: header.source, originalId: localSessionOriginalId(header.expectedSessionId),
        });
        if (previousClaim && header.expectedRepresentation !== undefined && header.expectedRepresentation !== previousClaim.representation) throw new Error('claim-mode-mismatch');
      }
      parser = createLocalSessionParser(header.source as LocalSessionSource, {
        expectedSessionId: header.expectedSessionId, expectedProjectPath: header.expectedProjectPath,
        expectedRepresentation: previousClaim?.representation ?? header.expectedRepresentation,
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
  if (previousClaim && (previousClaim.originalId !== proposal.conversation.originalId || previousClaim.source !== proposal.conversation.from
    || previousClaim.projectPath !== proposal.projectPath || previousClaim.representation !== proposal.representation
    || previousClaim.parserContractVersion !== 1)) throw new Error('source-claim-mismatch');
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
