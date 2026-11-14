import { describe, expect, it } from 'vitest';
import { localVerifyAttentionItem } from '../../../src/localVerify/localVerifyWiring.js';

describe('localVerifyAttentionItem (the signal → attention-item mapping server.ts uses)', () => {
  it('a starved PR is an UPSERT (a later queue episode reopens the same per-PR item) with plain wording', () => {
    const i = localVerifyAttentionItem('local-verify:starved:2350', { pr: 2350, headSha: 'a'.repeat(40), waitedMinutes: 150, reason: 'interrupted', interruptions: 2 });
    expect(i).toMatchObject({ id: 'local-verify:starved:2350', mode: 'upsert', priority: 'MEDIUM', title: 'Local Verify: PR #2350 cannot finish its check' });
    expect(i.summary).toBe("Server restarts killed this PR's check 2 times before it could finish (waiting 150 min). The merge line is stuck behind it.");
    const w = localVerifyAttentionItem('local-verify:starved:7', { pr: 7, waitedMinutes: 181, reason: 'waited', interruptions: 0 });
    expect(w.summary).toContain('has waited 181 min');
  });
  it('every other signal keeps create-once semantics, its key and its priority', () => {
    expect(localVerifyAttentionItem('local-verify:main-red', { head: 'x' })).toMatchObject({ id: 'local-verify:main-red', mode: 'create', priority: 'HIGH' });
    expect(localVerifyAttentionItem('local-verify:mirror-pending', { head: 'abc' })).toMatchObject({ id: 'local-verify:mirror-pending:abc', mode: 'create', priority: 'MEDIUM' });
    expect(localVerifyAttentionItem('local-verify:verifier-hold', { heldMs: 1 }).title).toBe('local-verify: verifier-hold');
  });
});
