/**
 * Trust-journey stage 0, decision 4: a raise needs the person's proof; a narrowing never does.
 * Both sides of every classifier, plus the trust owners refusing an unproven raise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  boardPolicyRaises, configPatchRaises, evolutionRaises, externalOperationsRaises,
  isTrustLevelRaise, issueOperatorProofForTesting, profileRaises, proofCovers, proposalHashOf,
  slackRoleRaises, TrustRaiseRefusedError,
} from '../../src/core/TrustRaiseGuard.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import { TrustRecovery } from '../../src/core/TrustRecovery.js';
import { TrustElevationTracker } from '../../src/core/TrustElevationTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('proof', () => {
  it('a plain object with the right fields is not a proof', () => {
    const forged = { kind: 'accepted-account', proposalHash: proposalHashOf({ a: 1 }), receiptRef: 'r', acceptanceRef: 'a', principal: 'p' };
    expect(proofCovers(forged as never, proposalHashOf({ a: 1 }))).toBe(false);
  });
  it('an issued proof covers only its own exact change', () => {
    const p = issueOperatorProofForTesting({ kind: 'trust-grant', service: 's', operation: 'write', level: 'log' });
    expect(proofCovers(p, proposalHashOf({ kind: 'trust-grant', service: 's', operation: 'write', level: 'log' }))).toBe(true);
    expect(proofCovers(p, proposalHashOf({ kind: 'trust-grant', service: 's', operation: 'write', level: 'autonomous' }))).toBe(false);
    expect(proofCovers(null, proposalHashOf({}))).toBe(false);
  });
  it('the proposal hash ignores key order', () => {
    expect(proposalHashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(proposalHashOf({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe('trust levels', () => {
  it('raising is less restrictive; narrowing or staying is not a raise', () => {
    expect(isTrustLevelRaise('approve-always', 'log')).toBe(true);
    expect(isTrustLevelRaise('log', 'autonomous')).toBe(true);
    expect(isTrustLevelRaise('autonomous', 'blocked')).toBe(false);
    expect(isTrustLevelRaise('log', 'log')).toBe(false);
    expect(isTrustLevelRaise('log', 'approve-always')).toBe(false);
  });
});

describe('autonomy profiles', () => {
  it('a profile with wider permissions is a raise', () => {
    expect(profileRaises('supervised', 'collaborative').length).toBeGreaterThan(0);
    expect(profileRaises('collaborative', 'autonomous').length).toBe(3);
  });
  it('a stricter or permission-equal profile is not a raise', () => {
    expect(profileRaises('autonomous', 'cautious')).toEqual([]);
    expect(profileRaises('collaborative', 'supervised')).toEqual([]);
    // cautious → supervised changes updates and discovery only, which are not authority.
    expect(profileRaises('cautious', 'supervised')).toEqual([]);
  });
});

describe('PATCH /config: externalOperations', () => {
  const before = {
    enabled: true,
    sentinel: { enabled: true },
    services: { gmail: { permissions: ['read', 'write'], blocked: ['delete'], requireApproval: ['write'], batchLimit: 10 } },
    readOnlyServices: ['calendar'],
  };
  it('turning off the gate is a raise', () => {
    expect(externalOperationsRaises(before, { enabled: false })).toContain('turning off the external-operation gate');
  });
  it('replacing the services map (one-level merge) that drops a block is a raise', () => {
    const r = externalOperationsRaises(before, { services: { gmail: { permissions: ['read', 'write'] } } });
    expect(r).toContain('unblocking delete on gmail');
    expect(r).toContain('no longer asking before write on gmail');
    expect(r).toContain('a larger batch limit on gmail');
  });
  it('allowing a new operation or removing a permission limit is a raise', () => {
    expect(externalOperationsRaises(before, { services: { gmail: { ...before.services.gmail, permissions: ['read', 'write', 'modify'] } } }))
      .toContain('allowing modify on gmail');
    expect(externalOperationsRaises(before, { services: { gmail: { ...before.services.gmail, permissions: [] } } }))
      .toContain('removing the permission limit on gmail');
  });
  it('dropping a service from the map or from read-only is a raise', () => {
    expect(externalOperationsRaises(before, { services: {} })).toContain('removing the limits on gmail');
    expect(externalOperationsRaises(before, { readOnlyServices: [] })).toContain('letting calendar make changes (no longer read-only)');
  });
  it('turning off the sentinel or replacing the whole block is a raise', () => {
    expect(externalOperationsRaises(before, { sentinel: { enabled: false } })).toContain('turning off the emergency-stop sentinel');
    expect(externalOperationsRaises(before, null)).toEqual(['replacing the external-operation safety settings']);
  });
  it('changes toward more restriction are not raises', () => {
    expect(externalOperationsRaises(before, { enabled: true })).toEqual([]);
    expect(externalOperationsRaises(before, { readOnlyServices: ['calendar', 'slack'] })).toEqual([]);
    expect(externalOperationsRaises(before, { services: { ...before.services, slack: { permissions: ['read'] } } })).toEqual([]);
    expect(externalOperationsRaises(before, { services: { gmail: { ...before.services.gmail, blocked: ['delete', 'modify'], batchLimit: 5 } } })).toEqual([]);
    expect(externalOperationsRaises({ enabled: false }, { enabled: true })).toEqual([]);
  });
});

describe('PATCH /config: evolution and the whole patch', () => {
  it('self-approval or self-implementation is a raise; turning them off is not', () => {
    expect(evolutionRaises({}, { approvalMode: 'autonomous' }, 'collaborative')).toEqual(['approving its own evolution proposals']);
    expect(evolutionRaises({}, { autoImplement: true })).toEqual(['implementing evolution proposals on its own']);
    expect(evolutionRaises({ approvalMode: 'autonomous' }, { approvalMode: 'ai-assisted' })).toEqual([]);
    expect(evolutionRaises({ autoImplement: true }, { autoImplement: false })).toEqual([]);
  });
  it('a patch of keys this spec does not govern has no raises', () => {
    expect(configPatchRaises({ externalOperations: { enabled: true } }, { tunnel: { enabled: true }, publishing: {} })).toEqual([]);
  });
  it('a patch mixing a restriction and a raise reports the raise', () => {
    expect(configPatchRaises({ externalOperations: { enabled: true, readOnlyServices: ['a'] } },
      { externalOperations: { enabled: false, readOnlyServices: ['a', 'b'] } })).toEqual(['turning off the external-operation gate']);
  });
});

describe('security review findings (stage 0 PR A)', () => {
  it('resetting evolution.approvalMode to unset is a raise when the profile default is autonomous', () => {
    expect(evolutionRaises({ approvalMode: 'ai-assisted' }, { approvalMode: null }, 'autonomous')).toEqual(['approving its own evolution proposals']);
    expect(configPatchRaises({ evolution: { approvalMode: 'ai-assisted' } }, { evolution: { approvalMode: null } }, 'autonomous').length).toBe(1);
  });
  it('resetting it under a non-autonomous profile is not a raise; with no known profile it is', () => {
    expect(evolutionRaises({ approvalMode: 'ai-assisted' }, { approvalMode: null }, 'collaborative')).toEqual([]);
    expect(evolutionRaises({ approvalMode: 'ai-assisted' }, { approvalMode: null })).toEqual(['approving its own evolution proposals']);
  });
  it('a list given as a string is a raise (the gate would substring-match it)', () => {
    expect(externalOperationsRaises({ services: {} }, { services: { gmail: { permissions: 'read,write', blocked: [] } } }))
      .toContain('a permissions value for gmail that is not a list');
    expect(externalOperationsRaises({}, { readOnlyServices: 'calendar' })).toContain('a read-only service value that is not a list');
  });
  it('giving a permission list to an entry that had none (every call refused) is a raise', () => {
    expect(externalOperationsRaises({ services: { gmail: { blocked: ['delete'] } } }, { services: { gmail: { blocked: ['delete'], permissions: [] } } }))
      .toContain('making gmail usable (its entry had no permission list, so every call was refused)');
  });
});

describe('rubber-stamp signal (stage 0 PR A)', () => {
  let d: string;
  beforeEach(() => { d = fs.mkdtempSync(path.join(os.tmpdir(), 'rubber-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/TrustRaiseGuard.test.ts:rubber' }); });
  // `true` = a route-reported claim; `false` = a row the server wrote itself (evolution status).
  const ev = (id: string, latencyMs: number, fromRoute: boolean) => ({
    proposalId: id, proposedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
    decision: 'approved' as const, modified: false, latencyMs, agentReported: true,
    source: fromRoute ? 'route' as const : 'evolution-status' as const,
  });
  it('route-reported slow approvals cannot clear a pattern in server-written rows', () => {
    const t = new TrustElevationTracker({ stateDir: d, rubberStampConsecutive: 5, rubberStampLatencyMs: 5000 });
    for (let i = 0; i < 5; i++) t.recordApprovalEvent(ev(`o${i}`, 1000, false));
    expect(t.getRubberStampSignal().detected).toBe(true);
    for (let i = 0; i < 10; i++) t.recordApprovalEvent(ev(`a${i}`, 9e9, true));
    expect(t.getRubberStampSignal().detected).toBe(true);
  });
  it('route-reported fast approvals can still raise the caution', () => {
    const t = new TrustElevationTracker({ stateDir: d, rubberStampConsecutive: 5, rubberStampLatencyMs: 5000 });
    for (let i = 0; i < 5; i++) t.recordApprovalEvent(ev(`a${i}`, 1000, true));
    expect(t.getRubberStampSignal().detected).toBe(true);
  });
  it('a flood of route-reported events never pushes out server-written rows', () => {
    const t = new TrustElevationTracker({ stateDir: d });
    for (let i = 0; i < 3; i++) t.recordApprovalEvent(ev(`o${i}`, 60000, false));
    for (let i = 0; i < 400; i++) t.recordApprovalEvent(ev(`a${i}`, 60000, true));
    const kept = (t as unknown as { state: { approvalEvents: Array<{ proposalId: string }> } }).state.approvalEvents;
    expect(kept.length).toBe(200);
    expect(kept.filter((e) => e.proposalId.startsWith('o')).length).toBe(3);
  });
});

describe('Slack roles and board policy', () => {
  it('owner and admin are raises; other roles are not', () => {
    expect(slackRoleRaises('owner').length).toBe(1);
    expect(slackRoleRaises('admin').length).toBe(1);
    expect(slackRoleRaises('member')).toEqual([]);
    expect(slackRoleRaises('guest')).toEqual([]);
  });
  it('only every-agent-card is not a raise', () => {
    expect(boardPolicyRaises('every-agent-card')).toEqual([]);
    expect(boardPolicyRaises('outward-only').length).toBe(1);
  });
});

describe('the trust owners refuse an unproven raise', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-raise-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/TrustRaiseGuard.test.ts:cleanup' }); });

  it('AdaptiveTrust: raise refused and nothing written; narrowing applies; a proof for the exact change raises', () => {
    const t = new AdaptiveTrust({ stateDir: dir });
    expect(() => t.grantTrust('gmail', 'write', 'autonomous', 'go')).toThrow(TrustRaiseRefusedError);
    expect(t.getTrustLevel('gmail', 'write').source).toBe('default');
    t.grantTrust('gmail', 'write', 'approve-always', 'ask me first');
    expect(t.getTrustLevel('gmail', 'write').level).toBe('approve-always');
    const wrong = issueOperatorProofForTesting({ kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'log' });
    expect(() => t.grantTrust('gmail', 'write', 'autonomous', 'go', wrong)).toThrow(TrustRaiseRefusedError);
    const right = issueOperatorProofForTesting({ kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' });
    t.grantTrust('gmail', 'write', 'autonomous', 'go', right);
    expect(t.getTrustLevel('gmail', 'write').level).toBe('autonomous');
  });

  it('AdaptiveTrust.grantServiceTrust is all or nothing', () => {
    const t = new AdaptiveTrust({ stateDir: dir });
    expect(() => t.grantServiceTrust('calendar', 'autonomous', 'all')).toThrow(TrustRaiseRefusedError);
    expect(t.getProfile().services.calendar).toBeUndefined();
    t.grantServiceTrust('calendar', 'blocked', 'never');
    expect(t.getTrustLevel('calendar', 'delete').level).toBe('blocked');
  });

  it('AutonomyProfileManager: a wider profile is refused and unchanged; a stricter one applies', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    const m = new AutonomyProfileManager({ stateDir: dir, config: { stateDir: dir } as unknown as InstarConfig });
    const start = m.getProfile();
    expect(() => m.setProfile('autonomous', 'go')).toThrow(TrustRaiseRefusedError);
    expect(m.getProfile()).toBe(start);
    m.setProfile('cautious', 'careful');
    expect(m.getProfile()).toBe('cautious');
  });

  it('TrustRecovery.acceptRecovery needs a proof for that incident', () => {
    const r = new TrustRecovery({ stateDir: dir });
    const inc = r.recordIncident('gmail', 'write', 'log', 'approve-always', 'oops');
    expect(() => r.acceptRecovery(inc.id)).toThrow(TrustRaiseRefusedError);
    expect(r.getActiveIncidents().map((i) => i.id)).toContain(inc.id);
    expect(r.acceptRecovery(inc.id, issueOperatorProofForTesting({ kind: 'trust-recovery', incidentId: inc.id }))?.recovered).toBe(true);
  });
});
