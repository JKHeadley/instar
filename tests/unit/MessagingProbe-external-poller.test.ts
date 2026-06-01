/**
 * Regression (Codey gap-run F003): the Telegram messaging probes reported a
 * health FAILURE whenever the in-server adapter wasn't "started" — but in
 * lifeline-owned polling mode the adapter is intentionally send-only and the
 * lifeline process owns polling. The probe was eroding trust by reporting
 * "Telegram broken" while the user-visible relay was fully working.
 *
 * The fix adds an optional `externalPollerActive` dep: when it returns true and
 * the adapter isn't started, the probe passes (lifeline owns polling). When it's
 * absent or false, the original failure behavior is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { createMessagingProbes, type MessagingProbeDeps } from '../../src/monitoring/probes/MessagingProbe.js';

function deps(started: boolean, externalPollerActive?: () => boolean): MessagingProbeDeps {
  return {
    getStatus: () => ({
      started,
      uptime: started ? 60_000 : null,
      pendingStalls: 0,
      pendingPromises: 0,
      topicMappings: 0,
      lastError: null,
      fatalReason: null,
      stoppedAt: null,
    }),
    messageLogPath: '/tmp/does-not-matter.jsonl',
    isConfigured: () => true,
    externalPollerActive,
  };
}

// Only the started-dependent probes are affected by the fix.
const AFFECTED = ['instar.messaging.connected', 'instar.messaging.polling'];

async function runAffected(d: MessagingProbeDeps) {
  const probes = createMessagingProbes(d).filter(p => AFFECTED.includes(p.id));
  expect(probes).toHaveLength(2);
  return Promise.all(probes.map(p => p.run()));
}

describe('MessagingProbe — lifeline-owned polling (externalPollerActive)', () => {
  it('connected + polling PASS when the adapter is send-only and the lifeline owns polling', async () => {
    const results = await runAffected(deps(false, () => true));
    expect(results.every(r => r.passed)).toBe(true);
    expect(results.every(r => /lifeline-owned/i.test(r.description ?? ''))).toBe(true);
  });

  it('connected + polling FAIL when the adapter is not started and no external poller is active', async () => {
    const results = await runAffected(deps(false, () => false));
    expect(results.every(r => !r.passed)).toBe(true);
  });

  it('preserves the original failure when externalPollerActive is not provided', async () => {
    const results = await runAffected(deps(false));
    expect(results.every(r => !r.passed)).toBe(true);
  });

  it('pass normally when the adapter IS started (poller flag irrelevant)', async () => {
    const results = await runAffected(deps(true, () => false));
    expect(results.every(r => r.passed)).toBe(true);
  });
});
