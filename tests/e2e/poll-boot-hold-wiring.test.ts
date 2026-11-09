/**
 * Wiring for the poll boot hold: the lifeline's real start path and 15-second reconcile
 * use the decision, so a standby with poll-follows-lease live waits for the lease at boot.
 * The decision itself is covered in tests/unit/pollDecision.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'src/lifeline/TelegramLifeline.ts'), 'utf8');

describe('the boot hold is wired into the lifeline', () => {
  it('start asks holdPollAtBoot before it polls, and a held boot does not poll', () => {
    const start = src.indexOf('const holdForLease = holdPollAtBoot(');
    const held = src.indexOf('if (holdForLease) {', start);
    const firstPoll = src.indexOf('this.poll();', start);
    expect(start).toBeGreaterThan(0);
    expect(held).toBeGreaterThan(start);
    expect(firstPoll).toBeGreaterThan(src.indexOf('} else if (telegramPollingEnabled) {', held));
    expect(src.slice(held, src.indexOf('} else if (telegramPollingEnabled) {', held))).toContain('this.bootPollHeldSinceMs = Date.now()');
  });

  it('the reconcile steps the hold before the normal decision, and an expired hold starts the poll', () => {
    const step = src.indexOf('bootHoldStep({ heldSinceMs');
    const decide = src.indexOf('const action = decidePollAction({', step);
    expect(step).toBeGreaterThan(0);
    expect(decide).toBeGreaterThan(step);
    const block = src.slice(step, decide);
    expect(block).toContain("if (step === 'wait') return;");
    expect(block).toContain('this.startPollAfterFlush(stateDir)');
  });

  it('the hold reads the same gate the reconcile does', () => {
    expect(src).toContain('followsLeaseEnabled: resolveDevAgentGate(mmPoll?.pollFollowsLease?.enabled');
  });
});
