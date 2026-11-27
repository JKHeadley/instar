/**
 * A Slack conversation stays with its Slack connection
 * (docs/specs/slack-conversations-stay-with-connection.md §2.1).
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionDrainRunner, type SessionDrainRunnerDeps } from '../../src/core/SessionDrainRunner.js';
import { isSlackConversationKey, isSlackSessionKey } from '../../src/core/SlackForwardBridge.js';
import type { OwnershipAction, SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

function harness(sessionKey: string) {
  const casCalls: OwnershipAction[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const terminate = vi.fn(async () => ({ terminated: true }));
  const suspend = vi.fn(() => ({ suspended: true }));
  const rec: SessionOwnershipRecord = { sessionKey, ownerMachineId: 'm_self', ownershipEpoch: 4, status: 'active', nonce: 'n', timestamp: 1, updatedAt: new Date(1).toISOString() };
  let now = 1;
  const deps: SessionDrainRunnerDeps = {
    selfMachineId: 'm_self',
    readOwnership: () => rec,
    cas: (a) => { casCalls.push(a); return { ok: true }; },
    suspendAutonomousRun: suspend,
    sessionQuiet: () => true,
    emergencyStopActive: () => false,
    terminateSession: terminate,
    markInterrupted: vi.fn(),
    notifyInterrupted: vi.fn(),
    audit: (e) => audits.push(e),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    nonce: () => 'n',
  };
  return { runner: new SessionDrainRunner(deps, { drainBoundMs: 5_000, pollMs: 1_000 }), casCalls, audits, terminate, suspend };
}

describe('Slack conversation keys', () => {
  it('recognises the raw routing key and the slack: profile form, and nothing else', () => {
    for (const k of ['C0ABC123', 'D0ABC123', 'G0ABC123', 'C0ABC123:1730000000.000100', 'slack:C0ABC123', 'slack:C0ABC123:1730000000.000100']) {
      expect(isSlackConversationKey(k), k).toBe(true);
    }
    for (const k of ['13481', 'app:0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f', 'telegram:5', 'c0abc', 'slack:', 'X0ABC123']) {
      expect(isSlackConversationKey(k), k).toBe(false);
    }
    // The older test still calls every non-numeric key Slack; the drain uses the exact one.
    expect(isSlackSessionKey('app:0f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f')).toBe(true);
  });
});

describe('the drain refuses a Slack conversation before anything happens', () => {
  for (const key of ['C0ABC123', 'C0ABC123:1730000000.000100', 'slack:C0ABC123']) {
    it(`${key}: no fence, no CAS, no suspend, no close`, async () => {
      const h = harness(key);
      const out = await h.runner.run({ sessionKey: key, target: 'm_mini', senderObservedEpoch: 4 });
      expect(out).toEqual({ status: 'refused-slack-stays', autonomousRunSuspended: false });
      expect(h.casCalls).toEqual([]);
      expect(h.suspend).not.toHaveBeenCalled();
      expect(h.terminate).not.toHaveBeenCalled();
      expect(h.audits).toEqual([{ event: 'drain-refused', sessionKey: key, target: 'm_mini', reason: 'slack-stays-with-connection' }]);
    });
  }
  it('a Telegram topic drains as before', async () => {
    const h = harness('13481');
    const out = await h.runner.run({ sessionKey: '13481', target: 'm_mini', senderObservedEpoch: 4 });
    expect(out.status).toBe('drained');
    expect(h.casCalls[0]).toEqual({ type: 'transfer', to: 'm_mini', drain: true });
  });
});
