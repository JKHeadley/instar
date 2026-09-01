import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, EchoWindowLedgerStore, rollbackDigest, WINDOW_DRY_RUN_INVENTORY } from '../../src/core/WindowLifecycleObligationLedger.js';

describe('EchoWindowLedgerStore integration', () => {
  it('persists atomically under Echo home and rollback preserves the ledger', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-ledger-')); const store = new EchoWindowLedgerStore(home);
    const ledger = createLedger({ agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', compiled: { hashes: { tenets: 'a' }, byteLengths: {}, operativeLines: [], obligations: [] } });
    store.save(ledger); expect(store.load('echo', 'echo-window-lifecycle')?.windowId).toBe('w28');
    const backup = store.backupExisting('pre-compile', '2026-08-28T16:30:00.000Z');
    expect(backup).toMatch(/ledger\.2026-08-28T16-30-00-000Z\.pre-compile\.[a-f0-9]{16}\.json$/);
    expect(JSON.parse(fs.readFileSync(backup!, 'utf8')).lifecycleRunId).toBe(ledger.lifecycleRunId);
    const payload = { agentId: 'echo' as const, scope: 'echo-window-lifecycle' as const, windowId: 'w28', reason: 'dry-run failed', nonce: 'rollback-1', createdAt: '2026-08-28T16:00:00Z' }; const digest = rollbackDigest(payload); const request = { ...payload, digest, approvalCoordinates: { topicId: 36966, messageId: 9 } };
    const approval = { authority: 'verified-operator-approval' as const, agentId: 'echo', scope: 'echo-window-lifecycle', windowId: 'w28', obligationId: 'rollback', sourceHashes: ['a'], producer: 'telegram:7812716706', timestamp: '2026-08-28T17:00:00Z', nonce: 'approval-1', canonicalPayloadHash: 'a'.repeat(64), verifierPassed: true, verifiedPayload: `approve rollback ${digest}`, nativeCoordinates: { topicId: 36966, messageId: 9 } };
    const rolled = store.rollback('echo', 'echo-window-lifecycle', request, approval, { requery: record => record === approval ? approval : null }, '2026-08-28T17:00:00Z');
    expect(rolled.state).toBe('rolled_back'); expect(rolled.sourceHashes.tenets).toBe('a'); expect(rolled.rollback?.enforcementDisabled).toBe(true);
    expect(() => store.reenable('echo', 'echo-window-lifecycle', '')).toThrow('fault-fixed-evidence-required');
    const fixed = path.join(home, 'fixed-proof.txt'); fs.writeFileSync(fixed, 'fixed by commit abc'); expect(() => store.reenable('echo', 'echo-window-lifecycle', fixed)).toThrow('dry-run-runner-required');
    const inventory = [...WINDOW_DRY_RUN_INVENTORY];
    expect(() => store.reenable('echo', 'echo-window-lifecycle', fixed, () => ({ passed: true, command: 'fake', completedAt: '2026-08-28T16:30:00Z', outputHash: 'a'.repeat(64), testInventory: inventory }))).toThrow('dry-run-suite-required');
    expect(store.reenable('echo', 'echo-window-lifecycle', fixed, () => ({ passed: true, command: 'vitest run', completedAt: '2026-08-28T17:01:00Z', outputHash: 'a'.repeat(64), testInventory: inventory }), '2026-08-28T17:02:00Z').state).toBe('pre_start_gate');
  });

  it('rejects Codey and other scopes before reading or mutating state', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-ledger-scope-')); const store = new EchoWindowLedgerStore(home);
    expect(() => store.load('codey', 'echo-window-lifecycle')).toThrow('echo-scope-required');
    expect(() => store.load('echo', 'other')).toThrow('echo-scope-required');
    expect(fs.existsSync(path.join(home, 'window-lifecycle'))).toBe(false);
  });
});
