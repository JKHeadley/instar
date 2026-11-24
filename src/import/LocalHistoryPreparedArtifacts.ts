/** Read-only validation of bounded normalized artifacts in a fixed worker.
 * This module opens no path, grants no authority and performs no mutation.
 * A visitor sees a verified individual artifact, NOT proof of the whole stream:
 * a later artifact or trailing byte can still refuse the complete preflight.
 */
import crypto from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import { MAX_PARTS, PART_CHARS, removeSecrets } from './exportParsers.js';
import { localSessionOriginalId, type LocalSessionProposal, type LocalSessionRepresentation,
  type LocalSessionSource } from './localSessionParsers.js';

export interface LocalHistoryPreparedArtifactDescriptor {
  readonly fileId: string;
  readonly source: LocalSessionSource;
  /** Raw source identity, normalized by the actual local parser's helper. */
  readonly expectedSessionId: string;
  /** Raw frozen manifest provenance; the actual producer's scrub is reused. */
  readonly projectPath: string;
  readonly representation: LocalSessionRepresentation;
  readonly bytes: number;
  readonly sha256: string;
}
export interface LocalHistoryPreparedArtifactPolicy {
  readonly maxArtifactBytes: number;
  /** One read-only, synchronous phase notification per declared file, before its
   * body is read. The fixed zero-based index advances once; this is no heartbeat. */
  readonly onArtifactStart?: (descriptor: Readonly<LocalHistoryPreparedArtifactDescriptor>, index: number) => void;
}
export class LocalHistoryPreparedArtifactRefused extends Error {
  constructor(readonly reason: 'policy' | 'metadata' | 'size' | 'stream' | 'integrity' | 'utf8' | 'json' | 'shape' | 'binding' | 'tail' | 'visitor' | 'progress') {
    super('local-history-prepared-' + reason);
  }
}
function refuse(reason: LocalHistoryPreparedArtifactRefused['reason']): never { throw new LocalHistoryPreparedArtifactRefused(reason); }
type RecordValue = Record<string, unknown>;
const own = (record: RecordValue, key: string) => Object.prototype.hasOwnProperty.call(record, key);
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('shape');
  const found = value as RecordValue;
  if (Object.keys(found).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !own(found, key))) return refuse('shape');
  return found;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function timestamp(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function compatible(source: LocalSessionSource, representation: unknown): representation is LocalSessionRepresentation {
  return source === CLAUDE_CODE_FRAMEWORK ? representation === 'claude-records'
    : representation === 'canonical' || representation === 'event-fallback';
}
interface Selected {
  descriptor: Readonly<LocalHistoryPreparedArtifactDescriptor>;
  originalId: string;
  normalizedProject: string;
}
function selection(descriptors: readonly LocalHistoryPreparedArtifactDescriptor[], maxArtifactBytes: number): Selected[] {
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > 1024) return refuse('metadata');
  const files = new Set<string>(), destinations = new Set<string>(), projects = new Map<string, string>();
  let metadataBytes = 0;
  try {
    return descriptors.map(value => {
      if (!value || typeof value !== 'object') return refuse('metadata');
      const descriptor = Object.freeze({ fileId: value.fileId, source: value.source,
        expectedSessionId: value.expectedSessionId, projectPath: value.projectPath,
        representation: value.representation, bytes: value.bytes, sha256: value.sha256 });
      if (typeof descriptor.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(descriptor.fileId)
        || (descriptor.source !== 'codex' && descriptor.source !== CLAUDE_CODE_FRAMEWORK)
        || !text(descriptor.expectedSessionId) || descriptor.expectedSessionId.includes('\0')
        || !text(descriptor.projectPath) || descriptor.projectPath.includes('\0')
        || !compatible(descriptor.source, descriptor.representation)
        || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0
        || typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) return refuse('metadata');
      if (descriptor.bytes > maxArtifactBytes || descriptor.bytes > bufferConstants.MAX_LENGTH
        || descriptor.bytes > bufferConstants.MAX_STRING_LENGTH) return refuse('size');
      metadataBytes += Buffer.byteLength(descriptor.fileId) + Buffer.byteLength(descriptor.expectedSessionId)
        + Buffer.byteLength(descriptor.sha256) + Buffer.byteLength(descriptor.representation);
      if (!projects.has(descriptor.projectPath)) metadataBytes += Buffer.byteLength(descriptor.projectPath);
      if (!Number.isSafeInteger(metadataBytes) || metadataBytes > CHUNK_BYTES) return refuse('metadata');
      const originalId = localSessionOriginalId(descriptor.expectedSessionId), destination = JSON.stringify([descriptor.source, originalId]);
      if (files.has(descriptor.fileId) || destinations.has(destination)) return refuse('metadata');
      files.add(descriptor.fileId); destinations.add(destination);
      if (!projects.has(descriptor.projectPath)) projects.set(descriptor.projectPath, removeSecrets(descriptor.projectPath).text);
      return { descriptor, originalId, normalizedProject: projects.get(descriptor.projectPath)! };
    });
  } catch (error) { if (error instanceof LocalHistoryPreparedArtifactRefused) throw error; return refuse('metadata'); }
}
function proposal(value: unknown, selected: Selected): LocalSessionProposal {
  const root = record(value, ['conversation', 'representation', 'projectPath', 'counts']);
  const conversation = record(root.conversation, ['from', 'originalId', 'title', 'createdAt', 'messages', 'overflow', 'stats']);
  if (root.representation !== selected.descriptor.representation || root.projectPath !== selected.normalizedProject
    || conversation.from !== selected.descriptor.source || conversation.originalId !== selected.originalId) return refuse('binding');
  if (!text(conversation.title) || !timestamp(conversation.createdAt) || !Array.isArray(conversation.messages)
    || !Array.isArray(conversation.overflow)) return refuse('shape');
  const stats = record(conversation.stats, ['redactions', 'splitMessages', 'droppedBranches']);
  if (!Object.values(stats).every(count)) return refuse('shape');
  const counts = record(root.counts, ['records', 'malformed', 'excluded', 'duplicateMessages', 'toolCalls']);
  if (!Object.values(counts).every(count) || counts.records === 0) return refuse('shape');
  const keys = new Set<string>(), parts = new Map<string, { of: number; indices: Set<number> }>();
  for (const raw of conversation.messages) {
    const message = record(raw, ['key', 'role', 'senderName', 'at', 'text'], ['part']);
    if (!text(message.key) || keys.has(message.key) || !['operator', 'agent'].includes(message.role as string)
      || !text(message.senderName) || !timestamp(message.at) || !text(message.text) || message.text.length > PART_CHARS) return refuse('shape');
    keys.add(message.key);
    if (own(message, 'part')) {
      const part = record(message.part, ['n', 'of']);
      if (!count(part.n) || !count(part.of) || part.of < 2 || part.of > MAX_PARTS || part.n < 1 || part.n > part.of
        || !message.key.endsWith('#' + part.n)) return refuse('shape');
      const base = message.key.slice(0, -String(part.n).length - 1);
      if (!base) return refuse('shape');
      const group = parts.get(base) ?? { of: part.of, indices: new Set<number>() };
      if (group.of !== part.of || group.indices.has(part.n)) return refuse('shape');
      group.indices.add(part.n); parts.set(base, group); Object.freeze(part);
    }
    Object.freeze(message);
  }
  for (const group of parts.values()) if (group.indices.size !== group.of) return refuse('shape');
  const overflowKeys = new Set<string>();
  for (const raw of conversation.overflow) {
    const overflow = record(raw, ['key', 'text']);
    if (!text(overflow.key) || overflowKeys.has(overflow.key) || !text(overflow.text)
      || overflow.text.length <= PART_CHARS * MAX_PARTS || parts.get(overflow.key)?.of !== MAX_PARTS) return refuse('shape');
    overflowKeys.add(overflow.key); Object.freeze(overflow);
  }
  Object.freeze(conversation.messages); Object.freeze(conversation.overflow);
  Object.freeze(stats); Object.freeze(counts); Object.freeze(conversation); Object.freeze(root);
  return root as unknown as LocalSessionProposal;
}

/** Input is the exact concatenation of declared normalized bytes. Input chunks
 * are borrowed and bounded by the existing importer block policy. This reader
 * copies/hashes one artifact at a time and clears its own byte buffer afterward.
 * Visitors must remain read-only; whole-preflight validity exists only on return.
 */
export async function visitPreparedArtifacts(input: AsyncIterable<Uint8Array>,
  descriptors: readonly LocalHistoryPreparedArtifactDescriptor[], policy: LocalHistoryPreparedArtifactPolicy,
  visit: (descriptor: Readonly<LocalHistoryPreparedArtifactDescriptor>, validated: LocalSessionProposal) => void | Promise<void>): Promise<void> {
  const maximum = policy?.maxArtifactBytes;
  const onArtifactStart = policy?.onArtifactStart;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || typeof visit !== 'function'
    || (onArtifactStart !== undefined && typeof onArtifactStart !== 'function')
    || !input || typeof input[Symbol.asyncIterator] !== 'function') return refuse('policy');
  const selected = selection(descriptors, maximum);
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = input[Symbol.asyncIterator]();
    if (!iterator || typeof iterator.next !== 'function') return refuse('stream');
  } catch { return refuse('stream'); }
  let chunk: Uint8Array | undefined, offset = 0;
  let ended = false;
  const next = async (): Promise<boolean> => {
    while (!chunk || offset === chunk.byteLength) {
      if (ended) return false;
      let result: IteratorResult<Uint8Array>;
      try { result = await iterator.next(); } catch { return refuse('stream'); }
      if (!result || typeof result !== 'object') return refuse('stream');
      if (result.done) { ended = true; chunk = undefined; return false; }
      if (!(result.value instanceof Uint8Array) || result.value.byteLength > CHUNK_BYTES) return refuse('stream');
      chunk = result.value; offset = 0;
    }
    return true;
  };
  try {
    for (const [index, artifact] of selected.entries()) {
      try { onArtifactStart?.(artifact.descriptor, index); } catch { return refuse('progress'); }
      let bytes: Buffer;
      try { bytes = Buffer.alloc(artifact.descriptor.bytes); } catch { return refuse('size'); }
      try {
        const hash = crypto.createHash('sha256'), utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        let written = 0;
        while (written < bytes.length) {
          if (!await next()) return refuse('size');
          const take = Math.min(bytes.length - written, chunk!.byteLength - offset);
          bytes.set(chunk!.subarray(offset, offset + take), written);
          const block = bytes.subarray(written, written + take);
          hash.update(block);
          // Validate incrementally without retaining one string per tiny feed.
          try { utf8.decode(block, { stream: true }); } catch { return refuse('utf8'); }
          written += take; offset += take;
        }
        try { utf8.decode(); } catch { return refuse('utf8'); }
        if (hash.digest('hex') !== artifact.descriptor.sha256) return refuse('integrity');
        let decoded: string;
        try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return refuse('utf8'); }
        let value: unknown;
        try { value = JSON.parse(decoded); } catch { return refuse('json'); }
        const validated = proposal(value, artifact);
        try { await visit(artifact.descriptor, validated); } catch { return refuse('visitor'); }
      } finally { bytes.fill(0); }
    }
    if (await next()) return refuse('tail');
  } catch (error) {
    if (error instanceof LocalHistoryPreparedArtifactRefused) throw error;
    return refuse('stream');
  } finally {
    chunk = undefined;
    if (!ended && iterator.return) { try { await iterator.return(); } catch { /* @silent-fallback-ok: iterator disposal cannot make a refused artifact valid */ } }
  }
}
