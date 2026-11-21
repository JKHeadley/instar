// safe-fs-allow: isolated temporary fixture cleanup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramLifeline } from '../../src/lifeline/TelegramLifeline.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { writePollIntent } from '../../src/core/pollIntent.js';

const dirs: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/lifeline-standby-boot-lifecycle.test.ts' }); });
function boot(mm: Record<string, unknown>, identity = true) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n72-boot-')); dirs.push(stateDir);
  if (identity) { fs.mkdirSync(path.join(stateDir, 'machine')); fs.writeFileSync(path.join(stateDir, 'machine/identity.json'), '{}'); }
  // Exercise the real production startup composition without constructing unrelated
  // credential, notification or registry clients. Only Telegram network boundaries are replaced.
  const l = Object.create(TelegramLifeline.prototype) as any;
  Object.assign(l, {
    projectConfig: { stateDir, multiMachine: mm }, polling: false, bootPollHeldSinceMs: 0,
    pollIntentAwakeSinceMs: 0, pollStartPending: false, pollStartGen: 0, pollLoopId: 0,
    consecutive409s: 0, last409AtMs: 0, flushStaleConnection: vi.fn(async () => {}), poll: vi.fn(),
  });
  return { l, stateDir, intent: (shouldPoll: boolean) => writePollIntent(stateDir, { shouldPoll, serverPid: process.pid, bootId: 'n72-test', ts: Date.now(), leaseEpoch: 8, role: shouldPoll ? 'awake' : 'standby' }) };
}
const live = { pollFollowsLease: { enabled: true, dryRun: false } };
describe('production lifeline polling startup composition', () => {
  it.each([{}, live])('observe-only never flushes or polls, including the old boot deadline (%j)', async (mode) => {
    const { l } = boot({ ...mode, leaseSelfHeal: { leaseRole: 'observe-only' } });
    await l.startPollingAtBoot();
    vi.advanceTimersByTime(240_000); l.reconcilePolling();
    expect(l.flushStaleConnection).not.toHaveBeenCalled(); expect(l.poll).not.toHaveBeenCalled(); expect(l.polling).toBe(false);
  });
  it.each([[{}, false], [live, false], [{ ...live, coordinationMode: 'independent' }, true]])('single-machine or independent startup retains polling (%j, identity %s)', async (mm, identity) => {
    const { l } = boot(mm, identity as boolean); await l.startPollingAtBoot();
    expect(l.flushStaleConnection).toHaveBeenCalledOnce(); expect(l.poll).toHaveBeenCalledOnce(); expect(l.polling).toBe(true);
  });
  it('a coordinated boot waits past the old bound, then a legitimate positive intent starts after debounce', async () => {
    const { l, intent } = boot(live); await l.startPollingAtBoot();
    vi.advanceTimersByTime(240_000); l.reconcilePolling();
    expect(l.flushStaleConnection).not.toHaveBeenCalled(); expect(l.polling).toBe(false);
    intent(false); l.reconcilePolling(); expect(l.polling).toBe(false);
    intent(true); l.reconcilePolling(); vi.advanceTimersByTime(20_001); l.reconcilePolling();
    await Promise.resolve(); await Promise.resolve();
    expect(l.flushStaleConnection).toHaveBeenCalledOnce(); expect(l.poll).toHaveBeenCalledOnce(); expect(l.polling).toBe(true);
  });
  it.each([false, null])('lost or unknown ownership during flush (%s) cannot become a blind start', async (nextIntent) => {
    const { l, intent } = boot(live); await l.startPollingAtBoot(); intent(true); l.reconcilePolling();
    l.flushStaleConnection.mockImplementation(async () => {
      if (nextIntent === false) intent(false);
      else fs.writeFileSync(path.join(l.projectConfig.stateDir, 'telegram-poll-intent.json'), '{}');
    });
    vi.advanceTimersByTime(20_001); l.reconcilePolling(); await Promise.resolve(); await Promise.resolve();
    expect(l.flushStaleConnection).toHaveBeenCalledOnce(); expect(l.poll).not.toHaveBeenCalled(); expect(l.polling).toBe(false);
  });
  it.each([['conflict409Stuck', true], ['noForwardStuck', true], ['consecutiveFailures', false]])('the production watchdog targets the correct process for %s', (signal, keepServer) => {
    const { l } = boot(live); l.initiateRestart = vi.fn();
    l.restartForWatchdog({ primary: signal, tripped: [signal], snapshot: {} });
    expect(l.initiateRestart).toHaveBeenCalledWith('watchdog', signal, expect.any(Object), keepServer);
  });
  it('forward failures retain server recovery even when a simultaneous conflict is primary', () => {
    const { l } = boot(live); l.initiateRestart = vi.fn();
    l.restartForWatchdog({ primary: 'conflict409Stuck', tripped: ['conflict409Stuck', 'consecutiveFailures'], snapshot: {} });
    expect(l.initiateRestart.mock.calls[0][3]).toBe(false);
  });
});
