/** Parse only sealed, bounded native request metadata. Provenance remains
 * untrusted until the parser checks the actual uploaded bytes. This validates
 * neither owner permission nor capacity reservation and never opens a path.
 */
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import crypto from 'node:crypto';

export interface LocalHistorySelectedFile {
  readonly fileId: string;
  readonly source: 'codex' | typeof CLAUDE_CODE_FRAMEWORK;
  readonly displayName: string;
  readonly expectedSessionId: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface LocalHistoryManifest {
  readonly bootId: string;
  readonly selectionChallenge: string;
  readonly selectionRequestId: string;
  readonly targetMachineId: string;
  readonly purpose: 'upload-selected-local-conversations';
  readonly project: string;
  readonly files: readonly LocalHistorySelectedFile[];
}
export interface LocalHistoryManifestPolicy {
  machineId: string;
  bootId: string;
  /** Actual supported adapter ceiling; never infer this from UTF-16 limits. */
  maxFileBytes: number;
}
function invalid(): never { throw new Error('local-history-manifest-invalid'); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) invalid();
  return result;
}

export function parseLocalHistoryManifest(value: unknown, policy: LocalHistoryManifestPolicy): {
  manifest: LocalHistoryManifest; fingerprint: string; totalBytes: number;
} {
  if (!Number.isSafeInteger(policy.maxFileBytes) || policy.maxFileBytes <= 0
    || !policy.machineId || !policy.bootId) invalid();
  const body = object(value, ['bootId', 'selectionChallenge', 'selectionRequestId', 'targetMachineId', 'purpose', 'project', 'files']);
  if (body.bootId !== policy.bootId || body.targetMachineId !== policy.machineId
    || body.purpose !== 'upload-selected-local-conversations') invalid();
  const challenge = text(body.selectionChallenge);
  const challengeBytes = Buffer.from(challenge, 'base64');
  if (challengeBytes.length !== 32 || challengeBytes.toString('base64') !== challenge) invalid();
  const requestId = id(body.selectionRequestId);
  const project = text(body.project);
  if (!Array.isArray(body.files) || body.files.length === 0) invalid();
  const fileIds = new Set<string>();
  const destinations = new Set<string>();
  let totalBytes = 0;
  const files = body.files.map(value => {
    const file = object(value, ['fileId', 'source', 'displayName', 'expectedSessionId', 'bytes', 'sha256']);
    const fileId = id(file.fileId);
    if (file.source !== 'codex' && file.source !== CLAUDE_CODE_FRAMEWORK) invalid();
    const source = file.source;
    const expectedSessionId = text(file.expectedSessionId);
    const displayName = text(file.displayName);
    if (typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || file.bytes > policy.maxFileBytes) throw new Error('local-history-source-capacity');
    const sha256 = text(file.sha256);
    if (!/^[0-9a-f]{64}$/.test(sha256)) invalid();
    const destination = JSON.stringify([source, expectedSessionId]);
    if (fileIds.has(fileId) || destinations.has(destination)) throw new Error('local-history-duplicate-source');
    fileIds.add(fileId); destinations.add(destination);
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('local-history-source-capacity');
    return Object.freeze({ fileId, source, displayName, expectedSessionId, bytes: file.bytes, sha256 });
  });
  const manifest: LocalHistoryManifest = Object.freeze({ bootId: policy.bootId,
    targetMachineId: policy.machineId, purpose: 'upload-selected-local-conversations', project,
    selectionChallenge: challenge, selectionRequestId: requestId, files: Object.freeze(files) });
  // Challenge freshness and request id are checked by the durable consume-once
  // ledger; a fresh transport/challenge must not alter the logical selection.
  const canonical = JSON.stringify(['instar-local-history-manifest-v1', manifest.targetMachineId,
    manifest.bootId, manifest.purpose, manifest.project,
    files.map(file => [file.fileId, file.source, file.displayName, file.expectedSessionId, file.bytes, file.sha256])]);
  return { manifest, totalBytes, fingerprint: crypto.createHash('sha256').update(canonical).digest('hex') };
}
