/**
 * Trust-journey 6a, corrupt or missing state: the server starts, every setting and restriction is
 * rebuilt from the committed change log, a raise without its recorded approval falls back, and a key
 * with unreadable history is unavailable (blocked). Also: an admitted governed effect gets an outcome
 * row labelled "not yet checked".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { createTrustJourneyRuntime } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { issueOperatorProofForTesting } from '../../src/core/TrustRaiseGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-corrupt-')); fs.writeFileSync(path.join(dir, 'config.json'), '{}'); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/trust-journey-corrupt-state.test.ts' }); });

const mk = (trust: AdaptiveTrust) => createTrustJourneyRuntime({
  stateDir: dir, configPath: path.join(dir, 'config.json'), runtimeConfig: {}, installationId: 'x', machineId: 'm1',
  adaptiveTrust: trust, autonomyManager: null, trustRecovery: null, telegram: null, slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
});

describe('corrupt trust profile at startup', () => {
  it('rebuilds narrowings and proven raises from the log; an unproven raise falls back', async () => {
    const t1 = new AdaptiveTrust({ stateDir: dir });
    const r1 = mk(t1);
    t1.grantTrust('gmail', 'delete', 'blocked', 'never');
    t1.grantTrust('gmail', 'write', 'approve-always', 'ask first');
    t1.grantTrust('gmail', 'write', 'log', 'x', issueOperatorProofForTesting({ kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'log' }));
    await new Promise((r) => setTimeout(r, 50));
    const proven = fs.readFileSync(path.join(dir, 'state', 'trust-profile.json'), 'utf8');
    expect(proven).toContain('"log"');
    fs.writeFileSync(path.join(dir, 'state', 'trust-profile.json'), '{ this is not json');
    // Without the consumption record the raise is unproven: it falls back to approve-always.
    const t2 = new AdaptiveTrust({ stateDir: dir });
    expect(t2.corruptAtLoad).toBe(true);
    await mk(t2).checkAtLoad();
    expect(t2.getTrustLevel('gmail', 'delete').level).toBe('blocked');
    expect(t2.getTrustLevel('gmail', 'write').level).toBe('approve-always');
    // With it recorded, the same raise is rebuilt.
    await r1.store.write('consumption', { consumptionId: 'test-receipt', requestId: 'r', receiptId: 'rc', acceptanceId: 'a', proposalHash: 'h', principal: 'owner' });
    fs.writeFileSync(path.join(dir, 'state', 'trust-profile.json'), 'garbage again');
    const t3 = new AdaptiveTrust({ stateDir: dir });
    await mk(t3).checkAtLoad();
    expect(t3.getTrustLevel('gmail', 'write').level).toBe('log');
  });

  it('an unreadable change record makes that kind unavailable, never merely ask', async () => {
    const t1 = new AdaptiveTrust({ stateDir: dir });
    const r1 = mk(t1);
    t1.grantTrust('gmail', 'modify', 'approve-always', 'ask');
    await new Promise((r) => setTimeout(r, 50));
    await r1.store.write('change', { changeId: 'n', key: 'gmail.modify', from: 'approve-always', to: 'autonomous', direction: 'raise', source: 'x', minReader: 3 });
    fs.writeFileSync(path.join(dir, 'state', 'trust-profile.json'), 'garbage');
    const t2 = new AdaptiveTrust({ stateDir: dir });
    await mk(t2).checkAtLoad();
    expect(t2.getTrustLevel('gmail', 'modify').level).toBe('blocked');
  });

  it('a readable profile is not treated as corrupt', () => {
    const t1 = new AdaptiveTrust({ stateDir: dir });
    t1.grantTrust('gmail', 'delete', 'blocked', 'never');
    expect(new AdaptiveTrust({ stateDir: dir }).corruptAtLoad).toBe(false);
  });
});

describe('outcome rows', () => {
  it('an effect admitted once gets a "not yet checked" outcome row', async () => {
    const t = new AdaptiveTrust({ stateDir: dir });
    const r = mk(t);
    const { deriveEffect } = await import('../../src/data/effect-kinds.js');
    const e = deriveEffect('mcp__svc__send_note', { a: 1 })!;
    await r.store.write('action-approval', { approvalId: 'ap1', actionIdentity: e.actionIdentity, consumptionId: 'c1' });
    const res = await r.admit('mcp__svc__send_note', { a: 1 });
    expect(res.decision.verdict).toBe('proceed-once');
    const rows = fs.readFileSync(path.join(dir, 'state', 'trust-journey-outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('not-yet-checked');
    expect(rows[0].sourceType).toBe('admitted-once');
  });
});
