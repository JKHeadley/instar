import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { parseLocalSessionLines } from '../../src/import/localSessionParsers.js';
import { readLocalHistoryPreparedPreview } from '../../src/import/LocalHistoryPreparedPreview.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'prepared preview fixtures',
}); });
function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-preview-')); dirs.push(stateDir);
  const proposal = parseLocalSessionLines('codex', [
    JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-session', cwd: '/synthetic/project' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'synthetic-message', role: 'user',
      content: [{ type: 'input_text', text: 'Private synthetic message body' }] } }),
  ]);
  const bytes = Buffer.from(JSON.stringify(proposal));
  const input = { stateDir, ownerUserId: 'synthetic-owner', maxArtifactBytes: 1024 * 1024,
    descriptors: [{ fileId: 'file-one', source: 'codex' as const, expectedSessionId: 'synthetic-session',
      projectPath: '/synthetic/project', representation: proposal.representation, bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
  return { input, bytes, proposal };
}
async function* body(bytes: Buffer) { yield bytes; }
it('returns bounded counts only after EOF and creates no history for a fresh destination', async () => {
  const { input, bytes } = fixture(); const phases: number[] = [];
  const result = await readLocalHistoryPreparedPreview(input, body(bytes), index => phases.push(index));
  expect(result.messages).toBe(1); expect(result.newMessages).toBe(1);
  expect(result.files[0].destinationFingerprint).toBeNull();
  expect(JSON.stringify(result)).not.toContain('Private synthetic message body');
  expect(phases).toEqual([0]);
  expect(fs.readdirSync(input.stateDir)).toEqual([]);
});
it('counts existing messages using the durable store and keeps different owners separate', async () => {
  const { input, bytes, proposal } = fixture();
  const store = new ImportedHistoryStore(input.stateDir);
  await store.withWriter(async () => {
    const claim = store.assertOrClaimLocalSource({ ownerUserId: input.ownerUserId, source: 'codex',
      originalId: proposal.conversation.originalId, projectPath: proposal.projectPath,
      representation: proposal.representation, parserContractVersion: 1 });
    store.addConversation({ ...proposal.conversation, originalId: claim.destinationId }); store.flush();
  });
  const result = await readLocalHistoryPreparedPreview(input, body(bytes));
  expect(result.newMessages).toBe(0); expect(result.files[0].destinationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect((await readLocalHistoryPreparedPreview({ ...input, ownerUserId: 'other-owner' }, body(bytes))).newMessages).toBe(1);
});
it('refuses trailing bytes after a valid artifact without returning a partial preview', async () => {
  const { input, bytes } = fixture();
  await expect(readLocalHistoryPreparedPreview(input, body(Buffer.concat([bytes, Buffer.from('x')])))).rejects.toThrow();
  expect(fs.readdirSync(input.stateDir)).toEqual([]);
});
it('refuses a provenance mismatch before returning a preview', async () => {
  const { input, bytes } = fixture(); input.descriptors[0].expectedSessionId = 'different-session';
  await expect(readLocalHistoryPreparedPreview(input, body(bytes))).rejects.toThrow();
});

it('waits for final EOF before planning a first claim', async () => {
  const { input, bytes } = fixture();
  const store = new ImportedHistoryStore(input.stateDir);
  const plan = vi.spyOn(ImportedHistoryStore.prototype, 'planSourceClaimWrite');
  try {
    await expect(readLocalHistoryPreparedPreview({ ...input, includeFirstClaimPlan: true },
      body(Buffer.concat([bytes, Buffer.from('x')])))).rejects.toThrow();
    expect(plan).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(store.dir, 'source-claims.sqlite'))).toBe(false);
  } finally { plan.mockRestore(); }
});
