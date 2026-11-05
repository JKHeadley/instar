/**
 * Production wiring for session-pool-move-nudge: a landed claim in the drain wrapper reaches the
 * sender, the verb's handler is registered and not a stub, and the puller and applier are bound
 * only behind the replication gate.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkCommandRBAC } from '../../src/core/MeshRpc.js';

const server = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');

describe('ownership nudge is alive in server boot', () => {
  it('the drain wrapper sends only after a landed claim, and after its journal record', () => {
    const emit = server.indexOf("_shedDrainTopics.has(c.sessionKey) ? 'reconcile' : 'user-move', prev);");
    const send = server.indexOf('sendOwnershipNudges({', emit);
    expect(emit).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(emit);
    expect(server.slice(emit, send)).toMatch(/action\.type === 'claim' && r\.ok/);
  });
  it('the verb has a real handler that hands off to the receiver and answers at once', () => {
    const at = server.indexOf("'ownership-nudge': (cmd, sender) =>");
    expect(at).toBeGreaterThan(0);
    expect(server.slice(at, at + 1400)).toMatch(/_ownershipNudgeReceiver\.receive\(sender, nudge\);\s*return \{ ok: true \};/);
  });
  it('the pull and the applier are bound, the pull only behind the replication gate', () => {
    expect(server).toMatch(/if \(_replicationEnabled\) \{\s*_ownershipNudgePull = async \(sender\) =>/);
    expect(server).toMatch(/_ownershipNudgeTick = \(\) => \{ ownershipApplier\.tick\(\); \};/);
  });
  it('the mesh knows the verb', () => {
    const deps = { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null };
    expect(checkCommandRBAC({ type: 'ownership-nudge', sessionKey: '1', epoch: 1, landedAt: 1 }, 'PEER', deps).ok).toBe(true);
  });
});
