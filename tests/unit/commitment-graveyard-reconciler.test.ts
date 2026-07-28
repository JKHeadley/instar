/**
 * Unit tests for the C1+C2 evidence-gated graveyard reconciler
 * (CommitmentTracker.reconcileGraveyard — spec agent-owned-followthrough §4.5).
 *
 * The load-bearing safety rule: auto-close ONLY on objective evidence (a
 * `supersededBy` superseder that reached terminal-success), and NEVER close a
 * merely-stale row ("abandoned" is never an auto-close — CMT-1101 scar).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graveyard-recon-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}, null, 2));
  return { dir, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/commitment-graveyard-reconciler.test.ts' }) };
}

const base = { type: 'one-time-action' as const };

describe('CommitmentTracker.reconcileGraveyard (evidence-gated)', () => {
  let dir: string;
  let cleanup: () => void;
  let t: CommitmentTracker;
  beforeEach(() => {
    ({ dir, cleanup } = tmp());
    t = new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) });
  });
  afterEach(() => cleanup());

  it('closes a pending row whose superseder reached terminal-success', () => {
    const old = t.record({ ...base, userRequest: 'old plan', agentResponse: 'will do v1', supersededBy: 'CMT-002' });
    const neu = t.record({ ...base, userRequest: 'new plan', agentResponse: 'will do v2' });
    t.deliver(neu.id); // superseder → terminal-success
    const r = t.reconcileGraveyard();
    expect(r.closed).toContain(old.id);
    const after = t.get(old.id);
    expect(after?.status).toBe('withdrawn');
    expect(after?.resolution).toMatch(/superseded-by-CMT-002/);
  });

  it('does NOT close while the superseder is still pending (evidence absent)', () => {
    const old = t.record({ ...base, userRequest: 'o', agentResponse: 'a', supersededBy: 'CMT-002' });
    t.record({ ...base, userRequest: 'n', agentResponse: 'b' }); // CMT-002 stays pending
    const r = t.reconcileGraveyard();
    expect(r.closed).toHaveLength(0);
    expect(t.get(old.id)?.status).toBe('pending');
  });

  it('NEVER closes a merely-stale row with no supersededBy (abandoned ≠ auto-close)', () => {
    const stale = t.record({ ...base, userRequest: 'send code when I get it', agentResponse: 'will do' });
    const r = t.reconcileGraveyard();
    expect(r.closed).toHaveLength(0);
    expect(t.get(stale.id)?.status).toBe('pending');
  });

  it('dryRun computes the close set without mutating', () => {
    const old = t.record({ ...base, userRequest: 'o', agentResponse: 'a', supersededBy: 'CMT-002' });
    const neu = t.record({ ...base, userRequest: 'n', agentResponse: 'b' });
    t.deliver(neu.id);
    const r = t.reconcileGraveyard({ dryRun: true });
    expect(r.wouldClose).toContain(old.id);
    expect(r.closed).toHaveLength(0);
    expect(t.get(old.id)?.status).toBe('pending');
  });

  it('bounds closes by maxClosesPerPass', () => {
    // Two old rows superseded by one delivered superseder.
    const o1 = t.record({ ...base, userRequest: 'o1', agentResponse: 'a', supersededBy: 'CMT-003' });
    const o2 = t.record({ ...base, userRequest: 'o2', agentResponse: 'b', supersededBy: 'CMT-003' });
    const neu = t.record({ ...base, userRequest: 'n', agentResponse: 'c' }); // CMT-003
    t.deliver(neu.id);
    const r = t.reconcileGraveyard({ maxClosesPerPass: 1 });
    expect(r.closed).toHaveLength(1);
    // Exactly one of the two closed; the other remains for the next pass.
    const stillPending = [o1, o2].filter(o => t.get(o.id)?.status === 'pending');
    expect(stillPending).toHaveLength(1);
  });
});
