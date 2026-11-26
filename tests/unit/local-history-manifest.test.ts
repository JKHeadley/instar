import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseLocalHistoryManifest } from '../../src/import/LocalHistoryManifest.js';
function manifest() {
  return { bootId: 'boot-1', selectionChallenge: Buffer.alloc(32, 1).toString('base64'), selectionRequestId: crypto.randomUUID(),
    targetMachineId: 'machine-1', purpose: 'upload-selected-local-conversations', project: '/selected/project',
    files: [{ fileId: crypto.randomUUID(), source: 'codex', displayName: 'renamed.jsonl', expectedSessionId: 'session-1', bytes: 1234, sha256: 'a'.repeat(64) }] };
}
const policy = { machineId: 'machine-1', bootId: 'boot-1', maxFileBytes: 8 * 1024 * 1024 };
describe('local history manifest', () => {
  it('binds every reviewed selection field while excluding the separate action id', () => {
    const a = manifest(); const initial = parseLocalHistoryManifest(a, policy).fingerprint;
    expect(parseLocalHistoryManifest({ ...a, selectionRequestId: crypto.randomUUID() }, policy).fingerprint).toBe(initial);
    expect(parseLocalHistoryManifest({ ...a, project: '/different' }, policy).fingerprint).not.toBe(initial);
    expect(parseLocalHistoryManifest({ ...a, bootId: 'new-boot' }, { ...policy, bootId: 'new-boot' }).fingerprint).not.toBe(initial);
    for (const change of [{ fileId: crypto.randomUUID() }, { source: 'claude-code' }, { displayName: 'other' },
      { expectedSessionId: 'other' }, { bytes: 4321 }]) {
      expect(parseLocalHistoryManifest({ ...a, files: [{ ...a.files[0], ...change }] }, policy).fingerprint).not.toBe(initial);
    }
    const other = { ...a.files[0], fileId: crypto.randomUUID(), expectedSessionId: 'second' };
    expect(parseLocalHistoryManifest({ ...a, files: [a.files[0], other] }, policy).fingerprint)
      .not.toBe(parseLocalHistoryManifest({ ...a, files: [other, a.files[0]] }, policy).fingerprint);
  });
  it('rejects unsafe integer totals, noncanonical nonce encoding and nested extra authority', () => {
    const a = manifest();
    expect(() => parseLocalHistoryManifest({ ...a, selectionChallenge: a.selectionChallenge.slice(0, -1) }, policy)).toThrow();
    expect(() => parseLocalHistoryManifest({ ...a, files: [null] }, policy)).toThrow();
    expect(() => parseLocalHistoryManifest({ ...a, files: [{ ...a.files[0], ownerId: 'other' }] }, policy)).toThrow();
    expect(() => parseLocalHistoryManifest({ ...a, files: [{ ...a.files[0], bytes: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...policy, maxFileBytes: Number.MAX_SAFE_INTEGER })).toThrow();
    const huge = { ...a.files[0], bytes: Number.MAX_SAFE_INTEGER };
    expect(() => parseLocalHistoryManifest({ ...a, files: [huge, { ...huge, fileId: crypto.randomUUID(), expectedSessionId: 'second' }] },
      { ...policy, maxFileBytes: Number.MAX_SAFE_INTEGER })).toThrow();
  });

  it('freezes exact provenance without interpreting display names as paths', () => {
    const input = manifest(); input.files[0].displayName = '../../not-a-server-path';
    const parsed = parseLocalHistoryManifest(input, policy);
    input.files[0].expectedSessionId = 'changed';
    expect(parsed.manifest.files[0].expectedSessionId).toBe('session-1');
    expect(Object.isFrozen(parsed.manifest.files[0])).toBe(true);
    expect(parsed.manifest.files[0].displayName).toBe('../../not-a-server-path');
  });
  it('keeps logical fingerprint stable across new upload challenges, but binds content and target', () => {
    const a = manifest(); const b = { ...a, selectionChallenge: Buffer.alloc(32, 2).toString('base64') };
    const fingerprint = parseLocalHistoryManifest(a, policy).fingerprint;
    expect(parseLocalHistoryManifest(b, policy).fingerprint).toBe(fingerprint);
    expect(parseLocalHistoryManifest({ ...b, files: [{ ...b.files[0], sha256: 'b'.repeat(64) }] }, policy).fingerprint).not.toBe(fingerprint);
    expect(() => parseLocalHistoryManifest({ ...a, targetMachineId: 'other' }, policy)).toThrow();
  });
  it('supports selections above fifty MiB using individually supported files', () => {
    const a = manifest(); a.files = Array.from({ length: 11 }, (_, index) => ({ ...a.files[0], fileId: crypto.randomUUID(), expectedSessionId: 'session-' + index, bytes: 5 * 1024 * 1024 }));
    expect(parseLocalHistoryManifest(a, policy).totalBytes).toBe(55 * 1024 * 1024);
  });
  it('rejects duplicate files and destination identities rather than choosing one', () => {
    const a = manifest();
    expect(() => parseLocalHistoryManifest({ ...a, files: [a.files[0], a.files[0]] }, policy)).toThrow();
    expect(() => parseLocalHistoryManifest({ ...a, files: [a.files[0], { ...a.files[0], fileId: crypto.randomUUID(), sha256: 'b'.repeat(64) }] }, policy)).toThrow();
  });
  it.each([
    { path: '/server/secret' }, { projectPath: '/other' }, { ownerId: 'arbitrary-owner' },
    { bootId: 'old' }, { selectionChallenge: 'not-a-nonce' }, { purpose: 'copy-without-preview' },
    { files: [] }, { project: '' },
  ])('rejects malformed or extra authority fields %j', change => {
    expect(() => parseLocalHistoryManifest({ ...manifest(), ...change }, policy)).toThrow();
  });
  it.each([
    { source: 'chatgpt' }, { bytes: 0 }, { bytes: 1.5 }, { bytes: 9 * 1024 * 1024 },
    { sha256: 'not-a-hash' }, { expectedSessionId: '' }, { path: '/arbitrary' },
  ])('rejects unsupported file metadata %j', change => {
    const a = manifest();
    expect(() => parseLocalHistoryManifest({ ...a, files: [{ ...a.files[0], ...change }] }, policy)).toThrow();
  });
});
