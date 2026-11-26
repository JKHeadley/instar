/**
 * A machine with no signed-in account must stop being handed new conversations (CMT-1051).
 *
 * Live incident, 2026-10-26: every Claude login on the Mama PC was needs-reauth, yet the
 * "Increasing throughput" and "quota usage" topics were both placed there. Each session
 * started, showed "Not logged in", and sat silent while the operator waited. Nothing in the
 * placement-eligibility signal described "no account here can sign in".
 *
 * These tests pin the signal's three values (usable / none usable / unknown), the block it
 * produces, and the placement gate on both sides of the boundary.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeSelfQuotaState, computeSignedInUsable } from '../../src/core/selfQuotaState.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

const acct = (framework: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ framework, status, configHome: `/home/x/.claude-${status}`, ...extra });

describe('computeSignedInUsable', () => {
  it('false when every local account for the framework is signed out (the Mama PC case)', () => {
    const accounts = [acct('claude-code', 'needs-reauth'), acct('claude-code', 'needs-reauth'),
      acct('codex-cli', 'active')];
    expect(computeSignedInUsable(accounts, 'claude-code')).toBe(false);
  });

  it('true when at least one account for the framework is active', () => {
    const accounts = [acct('claude-code', 'needs-reauth'), acct('claude-code', 'active')];
    expect(computeSignedInUsable(accounts, 'claude-code')).toBe(true);
  });

  it('a warming account counts as usable; disabled and drifted ones do not', () => {
    expect(computeSignedInUsable([acct('claude-code', 'warming')], 'claude-code')).toBe(true);
    expect(computeSignedInUsable([acct('claude-code', 'disabled')], 'claude-code')).toBe(false);
    expect(computeSignedInUsable([acct('claude-code', 'active', { identityDrifted: true })], 'claude-code')).toBe(false);
  });

  it('other frameworks do not count: a machine with only Codex logins has no Claude login', () => {
    expect(computeSignedInUsable([acct('codex-cli', 'active'), acct('claude-code', 'needs-reauth')], 'claude-code')).toBe(false);
    expect(computeSignedInUsable([acct('codex-cli', 'needs-reauth'), acct('claude-code', 'active')], 'codex-cli')).toBe(false);
  });

  it('unknown (never false) with no pool, no accounts for the framework, or only remote projections', () => {
    expect(computeSignedInUsable(null, 'claude-code')).toBeUndefined();
    expect(computeSignedInUsable([], 'claude-code')).toBeUndefined();
    expect(computeSignedInUsable([acct('codex-cli', 'needs-reauth')], 'claude-code')).toBeUndefined();
    expect(computeSignedInUsable([{ framework: 'claude-code', status: 'needs-reauth', configHome: '' }], 'claude-code')).toBeUndefined();
  });
});

describe('computeSelfQuotaState — the signed-in signal', () => {
  it('a positive "none usable" blocks with its own reason', () => {
    expect(computeSelfQuotaState(null, true, 1000, null, { usable: false }))
      .toEqual({ blocked: true, reason: 'no-signed-in-account' });
  });

  it('usable or unknown leaves behaviour exactly as before', () => {
    expect(computeSelfQuotaState(null, true, 1000, null, { usable: true })).toBeUndefined();
    expect(computeSelfQuotaState(null, true, 1000, null, { usable: undefined })).toBeUndefined();
    expect(computeSelfQuotaState(null, true, 1000)).toBeUndefined();
    expect(computeSelfQuotaState({ fiveHourPercent: 10 }, true, 1000, null, { usable: true })).toEqual({ blocked: false });
  });
});

describe('PlacementExecutor — a machine with no signed-in account is skipped', () => {
  function machine(id: string, signedOut: boolean): MachineCapacity {
    return {
      machineId: id, online: true, activeSessionCount: 0, maxSessions: 5,
      loadAvg: signedOut ? 0 : 1, memPressure: 'low',
      ...(signedOut ? { quotaState: { blocked: true, reason: 'no-signed-in-account' } } : {}),
    } as MachineCapacity;
  }
  const executor = new PlacementExecutor();

  it('places a new conversation on the signed-in machine even when the signed-out one is less loaded', () => {
    const d = executor.decide({
      sessionKey: '130742', topicMetadata: {}, reason: 'new',
      machineRegistry: [machine('m_mama', true), machine('m_studio', false)],
    });
    expect(d.chosenMachine).toBe('m_studio');
    expect(d.outcome).toBe('placed');
  });

  it('still places somewhere when no machine has a signed-in account, and flags it', () => {
    const d = executor.decide({
      sessionKey: '130742', topicMetadata: {}, reason: 'new',
      machineRegistry: [machine('m_mama', true), machine('m_studio', true)],
    });
    expect(d.chosenMachine).not.toBeNull();
    expect(d.escalationReason).toBe('all-machines-quota-blocked');
  });

  it('a deliberate pin is honoured, and names the real cause', () => {
    const d = executor.decide({
      sessionKey: '130742', reason: 'new',
      topicMetadata: { pinned: true, preferredMachine: 'm_mama' },
      machineRegistry: [machine('m_mama', true), machine('m_studio', false)],
    });
    expect(d.chosenMachine).toBe('m_mama');
    expect(d.escalationReason).toBe('pinned-machine-not-signed-in');
  });
});

describe('wiring integrity — the heartbeat actually carries the signal', () => {
  const SERVER_SRC = readFileSync(join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('server.ts computes it from the pool for the default framework and passes it into the block', () => {
    expect(SERVER_SRC).toContain('computeSignedInUsable(subscriptionPool.list(), _defaultFramework)');
    expect(SERVER_SRC).toContain('startFailureTracker.state(), { usable: signedInUsable }');
  });
});
