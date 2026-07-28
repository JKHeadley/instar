import { describe, it, expect, vi } from 'vitest';
import { LiveTestRunner, LiveTestRunnerError } from '../../src/core/LiveTestRunner.js';
import type { LiveTestHarness } from '../../src/core/LiveTestHarness.js';

/** A fake harness that records the matrix it was asked to run and returns a canned result. */
function fakeHarness() {
  const run = vi.fn(async () => ({
    artifact: { featureId: 'f', runId: 'r', surfaces: [], riskCategories: [], scenarios: [], createdAt: 'now', runnerFingerprint: 'fp' },
    entry: { featureId: 'f', runId: 'r', contentHash: 'h', signature: 's', signerFingerprint: 'fp', surfaces: [], riskCategories: [], createdAt: 'now', prevEntryHash: null },
  }));
  return { run } as unknown as LiveTestHarness & { run: typeof run };
}

describe('LiveTestRunner.runMultiMachineTransferCapstone — seat-move-first honesty', () => {
  it('THROWS LiveTestRunnerError when the seat did NOT move (never records a misleading PASS)', async () => {
    const harness = fakeHarness();
    const runner = new LiveTestRunner({ harness });
    const transfer = vi.fn(async () => ({ seatMoved: false, detail: 'ownership did not transfer' }));

    await expect(
      runner.runMultiMachineTransferCapstone({ targetMachine: 'mini', telegramTopicId: '13481', transfer }),
    ).rejects.toBeInstanceOf(LiveTestRunnerError);

    // The harness must never have run — the capstone aborts BEFORE any send.
    expect(transfer).toHaveBeenCalledWith('13481', 'mini');
    expect((harness as unknown as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
  });

  it('moves the seat FIRST, then runs the harness when the seat genuinely moved', async () => {
    const harness = fakeHarness();
    const runner = new LiveTestRunner({ harness });
    const transfer = vi.fn(async () => ({ seatMoved: true }));

    const result = await runner.runMultiMachineTransferCapstone({
      targetMachine: 'mini', telegramTopicId: '13481', message: 'probe', transfer,
    });

    expect(transfer).toHaveBeenCalledTimes(1);
    const runMock = (harness as unknown as { run: ReturnType<typeof vi.fn> }).run;
    expect(runMock).toHaveBeenCalledTimes(1);
    // The matrix the runner built asserts the reply came FROM the target machine.
    const matrix = runMock.mock.calls[0][0];
    expect(matrix.scenarios[0].expect.responderMachine).toBe('mini');
    expect(result.artifact).toBeDefined();
  });

  it('adds a Slack channel-parity scenario when slackChannelId is given', async () => {
    const harness = fakeHarness();
    const runner = new LiveTestRunner({ harness });
    const transfer = vi.fn(async () => ({ seatMoved: true }));

    await runner.runMultiMachineTransferCapstone({
      targetMachine: 'mini', telegramTopicId: '13481', slackChannelId: 'C0DEMO', transfer,
    });

    const runMock = (harness as unknown as { run: ReturnType<typeof vi.fn> }).run;
    const matrix = runMock.mock.calls[0][0];
    expect(matrix.surfaces).toEqual(['telegram', 'slack']);
    expect(matrix.scenarios.some((s: { surface: string }) => s.surface === 'slack')).toBe(true);
  });
});
