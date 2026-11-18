/** ConversationGraphReplicationRuntime.alive() is remembered only within one synchronous run: the readiness
 * pass called it once per manifest entry (registry and identity file reads plus a membership signature check
 * each time). A queued microtask clears it, so the first check after any await is fresh. Real method, stub this. */
import { describe, expect, it } from 'vitest';
import { ConversationGraphReplicationRuntime } from '../../src/server/ConversationGraphReplicationRuntime.js';

function stub(answer: () => boolean) {
  let checks = 0;
  const self = { stopped: false, aliveThisRun: null as boolean | null, options: { instanceLock: { revalidate: () => true } },
    trustedInstalledSet: () => { checks++; return answer(); } };
  const alive = () => (ConversationGraphReplicationRuntime.prototype as unknown as { alive: (this: unknown) => boolean }).alive.call(self);
  return { alive, checks: () => checks, self };
}

describe('alive() within one synchronous run', () => {
  it('checks once for many calls in the same run, and again after an await', async () => {
    const { alive, checks } = stub(() => true);
    for (let i = 0; i < 500; i++) expect(alive()).toBe(true);
    expect(checks()).toBe(1);
    await Promise.resolve();
    expect(alive()).toBe(true);
    expect(checks()).toBe(2);
  });

  it('sees a change after an await (a revoked membership stops the next run)', async () => {
    let ok = true; const { alive } = stub(() => ok);
    expect(alive()).toBe(true);
    ok = false;
    await Promise.resolve();
    expect(alive()).toBe(false);
  });

  it('a stopped runtime is not alive on the next run', async () => {
    const { alive, self } = stub(() => true);
    expect(alive()).toBe(true);
    self.stopped = true;
    await Promise.resolve();
    expect(alive()).toBe(false);
  });
});
