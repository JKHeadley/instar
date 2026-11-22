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
    const supervisor = src.indexOf('await this.supervisor.start()');
    const startup = src.indexOf('await this.startPollingAtBoot()');
    expect(supervisor).toBeGreaterThan(0);
    expect(startup).toBeGreaterThan(supervisor);
    expect(held).toBeGreaterThan(start);
    expect(firstPoll).toBeGreaterThan(src.indexOf('} else if (telegramPollingEnabled) {', held));
    expect(src.slice(held, src.indexOf('} else if (telegramPollingEnabled) {', held))).toContain('this.bootPollHeldSinceMs = Date.now()');
  });

  it('the reconcile holds before the normal decision and restores emergency polling only for an unmuted expired hold', () => {
    const step = src.indexOf('bootHoldStep({ heldSinceMs');
    const decide = src.indexOf('const action = decidePollAction({', step);
    expect(step).toBeGreaterThan(0);
    expect(decide).toBeGreaterThan(step);
    const block = src.slice(step, decide);
    expect(block).toContain("if (step === 'wait') return;");
    const expired = block.indexOf("if (step === 'expired') {");
    const muted = block.indexOf("if (override === 'force-mute') return;", expired);
    const emergency = block.indexOf('this.startPollAfterFlush(stateDir, forcePoll, true);', expired);
    expect(expired).toBeGreaterThan(0);
    expect(muted).toBeGreaterThan(expired);
    expect(emergency).toBeGreaterThan(muted);
    expect(block).not.toContain('this.polling = true;');
  });

  it('the hold reads the same gate the reconcile does', () => {
    expect(src).toContain('followsLeaseEnabled: this.leasePollIntentSupported() && resolveDevAgentGate(mmPoll?.pollFollowsLease?.enabled');
    const reconcile = src.slice(src.indexOf('private reconcilePolling(): void {'));
    expect(reconcile).toContain('const enabled = resolveDevAgentGate(mm?.pollFollowsLease?.enabled');
    expect(reconcile).toContain('if (!enabled || !this.leasePollIntentSupported()) return;');
  });
});
