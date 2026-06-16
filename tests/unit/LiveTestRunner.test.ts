import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveTestRunner, LiveTestRunnerError } from '../../src/core/LiveTestRunner.js';
import { LiveTestHarness, type ChannelDriver } from '../../src/core/LiveTestHarness.js';
import { LiveTestArtifactStore } from '../../src/core/LiveTestArtifactStore.js';

const sign = (d: string) => `sig:${d}`;
const verify = (d: string, s: string) => s === `sig:${d}`;

function makeHarness(driver: ChannelDriver) {
  const dir = mkdtempSync(join(tmpdir(), 'ltr-'));
  const store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'laptop', signerFingerprint: 'fp', sign, verify });
  return new LiveTestHarness({ store, driver, runnerFingerprint: 'fp', now: () => 1000, maxReplyRetries: 0 });
}

/** A fake driver whose reply always reports it was served by `responder`. */
function driverServedBy(responder: string, replyText = 'hello from the machine'): ChannelDriver {
  return {
    isDemoChannel: () => false,
    send: vi.fn(async () => ({ messageId: 'sent-1' })),
    awaitReply: vi.fn(async () => ({ text: replyText, messageId: 'r-1', responderMachineId: responder })),
  };
}

describe('LiveTestRunner', () => {
  it('throws (no harness run, no misleading PASS) when the seat did NOT move', async () => {
    const driver = driverServedBy('m_mini');
    const runner = new LiveTestRunner({ harness: makeHarness(driver) });
    const transfer = vi.fn(async () => ({ seatMoved: false, detail: 'placedOwnership=false' }));
    await expect(
      runner.runMultiMachineTransferCapstone({ targetMachine: 'm_mini', telegramTopicId: '999', transfer, runId: 'r' }),
    ).rejects.toBeInstanceOf(LiveTestRunnerError);
    // The channel was never driven — we refuse to run the scenario over a non-move.
    expect(driver.send).not.toHaveBeenCalled();
  });

  it('moves the seat then PASSES when the reply is served FROM the target machine', async () => {
    const driver = driverServedBy('m_mini');
    const runner = new LiveTestRunner({ harness: makeHarness(driver) });
    const transfer = vi.fn(async () => ({ seatMoved: true }));
    const { artifact } = await runner.runMultiMachineTransferCapstone({
      targetMachine: 'm_mini', telegramTopicId: '960021', transfer, runId: 'run-1',
    });
    expect(transfer).toHaveBeenCalledWith('960021', 'm_mini');
    expect(artifact.scenarios).toHaveLength(1);
    expect(artifact.scenarios[0].verdict).toBe('PASS');
    expect(artifact.scenarios[0].evidence?.responderMachineId).toBe('m_mini');
  });

  it('FAILS when the seat moved but the reply came from the WRONG machine (the bug this catches)', async () => {
    const driver = driverServedBy('m_laptop'); // reply still served by the laptop — seat didn't really serve
    const runner = new LiveTestRunner({ harness: makeHarness(driver) });
    const transfer = vi.fn(async () => ({ seatMoved: true }));
    const { artifact } = await runner.runMultiMachineTransferCapstone({
      targetMachine: 'm_mini', telegramTopicId: '960021', transfer,
    });
    expect(artifact.scenarios[0].verdict).toBe('FAIL');
    expect(artifact.scenarios[0].blockedReason).toMatch(/responder m_laptop ≠ expected m_mini/);
  });

  it('adds a Slack channel-parity scenario when slackChannelId is given', async () => {
    const driver = driverServedBy('m_mini');
    const runner = new LiveTestRunner({ harness: makeHarness(driver) });
    const transfer = vi.fn(async () => ({ seatMoved: true }));
    const { artifact } = await runner.runMultiMachineTransferCapstone({
      targetMachine: 'm_mini', telegramTopicId: '960021', slackChannelId: 'C123', transfer,
    });
    expect(artifact.surfaces).toEqual(['telegram', 'slack']);
    expect(artifact.scenarios.map(s => s.surface)).toEqual(['telegram', 'slack']);
    expect(artifact.scenarios.every(s => s.verdict === 'PASS')).toBe(true);
  });

  it('FAILS (empty reply) when the reply is empty even if from the right machine', async () => {
    const driver = driverServedBy('m_mini', '   ');
    const runner = new LiveTestRunner({ harness: makeHarness(driver) });
    const transfer = vi.fn(async () => ({ seatMoved: true }));
    const { artifact } = await runner.runMultiMachineTransferCapstone({
      targetMachine: 'm_mini', telegramTopicId: '1', transfer,
    });
    expect(artifact.scenarios[0].verdict).toBe('FAIL');
    expect(artifact.scenarios[0].blockedReason).toMatch(/empty/);
  });
});
