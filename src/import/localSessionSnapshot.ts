/**
 * Read-only snapshots of explicitly selected local session files (§A.3/B.10/E).
 * No source discovery, temporary files, history writes or authorization grants.
 * The caller must bind a trusted, current owner grant to the exact selection;
 * the selection digest below binds bytes to that input but supplies no authority.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import { TextDecoder } from 'node:util';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import { MAX_ELEMENT_CHARS } from './jsonArrayStream.js';
import {
  createLocalSessionParser, LocalSessionRefused,
  type LocalSessionProposal, type LocalSessionRepresentation, type LocalSessionSource,
} from './localSessionParsers.js';

/** Existing importer conversation ceiling, applied conservatively to input bytes. */
export const MAX_LOCAL_SESSION_BYTES = MAX_ELEMENT_CHARS;
export interface LocalSessionSelection {
  filePath: string;
  source: LocalSessionSource;
  expectedSessionId: string;
  expectedProjectPath: string;
  expectedRepresentation?: LocalSessionRepresentation;
}
export interface LocalSessionSnapshotOptions {
  /** Must be supplied by the trusted owner integration; literal true alone permits a read. */
  authorized: (selection: Readonly<LocalSessionSelection>) => boolean;
  /** The caller can request less work, never raise the existing importer ceiling. */
  maxBytes?: number;
}
export interface LocalSessionFileIdentity {
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
}
export interface LocalSessionSnapshotReceipt {
  version: 1;
  source: LocalSessionSource;
  representation: LocalSessionRepresentation;
  /** Hash of the exact selected path, source, session and project; contains no raw private path. */
  selectionSha256: string;
  sha256: string;
  bytes: number;
  fileIdentity: LocalSessionFileIdentity;
}
export interface LocalSessionSnapshot {
  proposal: LocalSessionProposal;
  receipt: LocalSessionSnapshotReceipt;
}
export type LocalSessionSnapshotRefusal =
  | 'invalid-selection' | 'invalid-budget' | 'invalid-receipt' | 'not-authorized'
  | 'not-regular' | 'source-changed' | 'too-large' | 'read-failed'
  | 'invalid-utf8' | 'parser-refused' | 'receipt-mismatch' | 'unsupported-filesystem';
export class LocalSessionSnapshotRefused extends Error {
  constructor(readonly reason: LocalSessionSnapshotRefusal) {
    super(`Local session snapshot refused: ${reason}`);
  }
}
const refuse = (reason: LocalSessionSnapshotRefusal): never => { throw new LocalSessionSnapshotRefused(reason); };
const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const sourceOk = (value: unknown): value is LocalSessionSource => value === CLAUDE_CODE_FRAMEWORK || value === 'codex';
const representationOk = (value: unknown): value is LocalSessionRepresentation =>
  value === 'canonical' || value === 'event-fallback' || value === 'claude-records';

function ownSelection(input: LocalSessionSelection): Readonly<LocalSessionSelection> {
  try {
    // Read each caller-controlled property once before the first authorization call.
    const { filePath, source, expectedSessionId, expectedProjectPath, expectedRepresentation } = input;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !sourceOk(source)
      || typeof expectedSessionId !== 'string' || !expectedSessionId
      || typeof expectedProjectPath !== 'string' || !path.isAbsolute(expectedProjectPath)
      || (expectedRepresentation !== undefined && (!representationOk(expectedRepresentation)
        || (source === CLAUDE_CODE_FRAMEWORK ? expectedRepresentation !== 'claude-records' : expectedRepresentation === 'claude-records')))) refuse('invalid-selection');
    return Object.freeze({ filePath, source, expectedSessionId, expectedProjectPath,
      ...(expectedRepresentation === undefined ? {} : { expectedRepresentation }) });
  } catch { return refuse('invalid-selection'); }
}
function ownOptions(options: LocalSessionSnapshotOptions): { check: (selection: Readonly<LocalSessionSelection>) => void; budget: number } {
  let authorized: LocalSessionSnapshotOptions['authorized'];
  let maxBytes: number | undefined;
  try { authorized = options.authorized; maxBytes = options.maxBytes; } catch { return refuse('not-authorized'); }
  if (typeof authorized !== 'function') refuse('not-authorized');
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_LOCAL_SESSION_BYTES)) refuse('invalid-budget');
  return {
    budget: maxBytes ?? MAX_LOCAL_SESSION_BYTES,
    check(selection): void {
      let admitted: unknown;
      try { admitted = authorized(selection); } catch { refuse('not-authorized'); }
      if (admitted !== true) refuse('not-authorized');
    },
  };
}
function identity(stat: BigIntStats): LocalSessionFileIdentity {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString() };
}
function sameIdentity(left: LocalSessionFileIdentity, right: LocalSessionFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function ownReceipt(input: LocalSessionSnapshotReceipt): Readonly<LocalSessionSnapshotReceipt> {
  try {
    const { version, source, representation, selectionSha256, sha256: digest, bytes, fileIdentity } = input;
    const { dev, ino, size, mtimeNs, ctimeNs } = fileIdentity;
    if (version !== 1 || !sourceOk(source) || !representationOk(representation)
      || (source === CLAUDE_CODE_FRAMEWORK ? representation !== 'claude-records' : representation === 'claude-records')
      || typeof selectionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(selectionSha256)
      || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_LOCAL_SESSION_BYTES || size !== bytes
      || typeof dev !== 'string' || !/^\d+$/.test(dev) || typeof ino !== 'string' || !/^\d+$/.test(ino)
      || typeof mtimeNs !== 'string' || !/^-?\d+$/.test(mtimeNs) || typeof ctimeNs !== 'string' || !/^-?\d+$/.test(ctimeNs)) refuse('invalid-receipt');
    return Object.freeze({ version, source, representation, selectionSha256, sha256: digest, bytes,
      fileIdentity: Object.freeze({ dev, ino, size, mtimeNs, ctimeNs }) });
  } catch { return refuse('invalid-receipt'); }
}

/** One descriptor pass. UTF-8 decoding and parsing are optional for receipt verification. */
async function readSelected(
  selection: Readonly<LocalSessionSelection>,
  options: ReturnType<typeof ownOptions>,
  onText?: (text: string, final: boolean) => void,
  onBytes?: (bytes: Buffer) => Promise<void>,
): Promise<{ bytes: number; sha256: string; fileIdentity: LocalSessionFileIdentity }> {
  const { check, budget } = options;
  let handle: fs.promises.FileHandle | undefined;
  let inspected = false;
  let wipe: Buffer | undefined;
  try {
    check(selection);
    const linked = await fs.promises.lstat(selection.filePath, { bigint: true });
    inspected = true;
    check(selection);
    if (!linked.isFile()) refuse('not-regular');
    if (linked.size > BigInt(budget)) refuse('too-large');
    if (!Number.isInteger(fs.constants.O_NOFOLLOW) || !fs.constants.O_NOFOLLOW
      || !Number.isInteger(fs.constants.O_NONBLOCK) || !fs.constants.O_NONBLOCK) refuse('unsupported-filesystem');
    check(selection);
    handle = await fs.promises.open(selection.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    check(selection);
    const opened = await handle.stat({ bigint: true });
    check(selection);
    if (!opened.isFile()) refuse('not-regular');
    const before = identity(opened);
    if (!sameIdentity(identity(linked), before)) refuse('source-changed');
    if (opened.size > BigInt(budget)) refuse('too-large');
    const digest = crypto.createHash('sha256');
    const decoder = onText || onBytes ? new TextDecoder('utf-8', { fatal: true }) : null;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    wipe = buffer;
    let bytes = 0;
    while (true) {
      check(selection);
      const result = await handle.read(buffer, 0, buffer.length, bytes);
      check(selection);
      const current = await handle.stat({ bigint: true });
      check(selection);
      if (!current.isFile() || !sameIdentity(before, identity(current))) refuse('source-changed');
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (bytes > budget) refuse('too-large');
      if (bytes > before.size) refuse('source-changed');
      const chunk = buffer.subarray(0, result.bytesRead);
      digest.update(chunk);
      if (decoder) {
        let text: string;
        try { text = decoder.decode(chunk, { stream: true }); } catch { return refuse('invalid-utf8'); }
        check(selection);
        onText?.(text, false);
      }
      if (onBytes) {
        check(selection); await onBytes(chunk); check(selection);
      }
    }
    if (bytes !== before.size) refuse('source-changed');
    check(selection);
    const after = await handle.stat({ bigint: true });
    check(selection);
    const currentLink = await fs.promises.lstat(selection.filePath, { bigint: true });
    check(selection);
    if (!after.isFile() || !currentLink.isFile() || !sameIdentity(before, identity(after)) || !sameIdentity(before, identity(currentLink))) refuse('source-changed');
    if (decoder) {
      let tail: string;
      try { tail = decoder.decode(); } catch { return refuse('invalid-utf8'); }
      check(selection);
      onText?.(tail, true);
    }
    check(selection);
    return { bytes, sha256: digest.digest('hex'), fileIdentity: before };
  } catch (error) {
    if (error instanceof LocalSessionSnapshotRefused) throw error;
    if (error instanceof LocalSessionRefused) return refuse('parser-refused');
    if (inspected && ['ELOOP', 'ENOENT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) return refuse('source-changed');
    return refuse('read-failed');
  } finally {
    wipe?.fill(0);
    // Closing the descriptor never requires ongoing permission to read its source.
    try { await handle?.close(); } catch { /* @silent-fallback-ok: read-only FD disposal cannot change source bytes */ }
  }
}

export async function snapshotLocalSession(selection: LocalSessionSelection, options: LocalSessionSnapshotOptions): Promise<LocalSessionSnapshot> {
  const selected = ownSelection(selection);
  const access = ownOptions(options);
  access.check(selected);
  const parser = createLocalSessionParser(selected.source, selected);
  // Keep only the unfinished record's decoded chunks, not a raw whole-file copy.
  let pending: string[] = [];
  const snapshot = await readSelected(selected, access, (text, final) => {
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf('\n', start)) !== -1) {
      const tail = text.slice(start, newline);
      parser.push(pending.length ? pending.join('') + tail : tail);
      pending = [];
      start = newline + 1;
    }
    if (start < text.length) pending.push(text.slice(start));
    if (final && pending.length) { parser.push(pending.join('')); pending = []; }
  });
  access.check(selected);
  let proposal: LocalSessionProposal;
  try { proposal = parser.finish(); } catch { return refuse('parser-refused'); }
  access.check(selected);
  for (const message of proposal.conversation.messages) {
    if (message.part) Object.freeze(message.part);
    Object.freeze(message);
  }
  for (const overflow of proposal.conversation.overflow) Object.freeze(overflow);
  Object.freeze(proposal.conversation.messages);
  Object.freeze(proposal.conversation.overflow);
  Object.freeze(proposal.conversation.stats);
  Object.freeze(proposal.conversation);
  Object.freeze(proposal.counts);
  Object.freeze(proposal);
  return Object.freeze({
    proposal,
    receipt: Object.freeze({ version: 1, source: selected.source, representation: proposal.representation,
      selectionSha256: sha256(JSON.stringify(selected)), ...snapshot,
      fileIdentity: Object.freeze(snapshot.fileIdentity) }),
  });
}

/** Re-read exact selected bytes under current authority; matching size/time alone never suffices. */
export async function verifyLocalSessionSnapshot(
  selection: LocalSessionSelection, receipt: LocalSessionSnapshotReceipt, options: LocalSessionSnapshotOptions,
): Promise<void> {
  const selected = ownSelection(selection);
  const expected = ownReceipt(receipt);
  const access = ownOptions(options);
  access.check(selected);
  if (expected.source !== selected.source || expected.selectionSha256 !== sha256(JSON.stringify(selected))
    || (selected.expectedRepresentation !== undefined && selected.expectedRepresentation !== expected.representation)) refuse('receipt-mismatch');
  const current = await readSelected(selected, access);
  access.check(selected);
  if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256 || !sameIdentity(current.fileIdentity, expected.fileIdentity)) refuse('source-changed');
}

/** Shared descriptor/UTF-8/hash reader for server-owned immutable staging. The
 * caller retains exact current authorization and binds this selection to its
 * trusted grant. No path is accepted from a native request by this helper.
 * onBytes borrows a bounded buffer until its promise settles; retain a copy if
 * needed. Final identity/hash checks must succeed before publishing any output.
 */
export async function streamLocalSessionBytes(
  selection: LocalSessionSelection, options: LocalSessionSnapshotOptions,
  onBytes: (bytes: Buffer) => Promise<void>,
): Promise<{ bytes: number; sha256: string; fileIdentity: LocalSessionFileIdentity }> {
  const selected = ownSelection(selection);
  const access = ownOptions(options);
  const consume = onBytes;
  if (typeof consume !== 'function') refuse('invalid-selection');
  access.check(selected);
  return readSelected(selected, access, undefined, consume);
}

/** A single borrowed-block bridge to the shared descriptor reader. No raw-file
 * copy or unbounded queue is materialized in the parent. Borrowed bytes become
 * invalid immediately on abort and may be wiped before next()/return(). Aborting also releases
 * a producer waiting for its consumer, even if no further next() is requested.
 */
export function localSessionByteChunks(
  selection: LocalSessionSelection, options: LocalSessionSnapshotOptions, signal: AbortSignal,
): AsyncGenerator<Buffer> {
  const selected = ownSelection(selection);
  const access = ownOptions(options);
  return (async function* () {
    let disposed = false;
    let done = false;
    let failure: unknown;
    let queued: { bytes: Buffer; acknowledge(): void } | undefined;
    let borrowed: typeof queued;
    let wake: (() => void) | undefined;
    const notify = () => { const next = wake; wake = undefined; next?.(); };
    const stop = () => { disposed = true; queued?.acknowledge(); borrowed?.acknowledge(); notify(); };
    signal.addEventListener('abort', stop, { once: true });
    const producer = readSelected(selected, {
      budget: access.budget,
      check(current) {
        if (disposed || signal.aborted) refuse('not-authorized');
        access.check(current);
      },
    }, undefined, bytes => new Promise<void>(resolve => {
      queued = { bytes, acknowledge: resolve };
      notify();
    })).then(() => { done = true; }, error => { done = true; failure = error; }).finally(notify);
    try {
      for (;;) {
        if (disposed || signal.aborted) refuse('not-authorized');
        if (queued) {
          access.check(selected);
          const block = queued; queued = undefined; borrowed = block;
          try { yield block.bytes; } finally { borrowed = undefined; block.acknowledge(); }
        } else if (done) {
          if (failure) throw failure;
          break;
        } else await new Promise<void>(resolve => { wake = resolve; });
      }
    } finally {
      signal.removeEventListener('abort', stop);
      stop();
      await producer;
    }
  })();
}
