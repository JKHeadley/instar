import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrialExecutionScope, reconcileTrialScopes, type TrialScopeSeams } from '../../../src/localVerify/trialExecutionScope.js';

const attemptId = 'ba'.repeat(16);
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-scope-test-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation:'trialExecutionScope.test.ts' }); });

function fixture() {
  const events: string[] = [];
  const state = { job: null as {pid: number; coalition: string} | null, pids: [42], boot: 'boot-1' };
  const seams: TrialScopeSeams = {
    boot: () => state.boot, job: () => state.job,
    identify: () => '223',
    members: () => {
      events.push('members');
      return state.pids.map(pid => ({pid, generation: 76, rssBytes: 4096}));
    },
    signal: (_id, sig) => { events.push(sig); if (sig === 'KILL') state.pids = []; },
    bootout: () => { events.push('bootout'); state.job = null; },
    wait: async () => {},
  };
  const prepare = () => {
    TrialExecutionScope.prepare(dir, attemptId, seams);
    state.job = { pid: 42, coalition: '223' };
  };
  const capture = () => TrialExecutionScope.capture({ stateDir: dir, attemptId, rootPid: 42 }, seams);
  return {events,state,seams,prepare,capture};
}

describe('dedicated launchd trial scope', () => {
  it('requires an exclusive coalition before admitting code', () => {
    const f = fixture(); f.prepare(); f.state.pids.push(222);
    expect(f.capture).toThrow(/exclusive/);
  });

  it('refuses duplicate attempt intent and rejects a kernel versus job mismatch', () => {
    const f = fixture(); f.prepare();
    expect(() => TrialExecutionScope.prepare(dir, attemptId, f.seams)).toThrow();
    f.seams.identify = () => '224';
    expect(f.capture).toThrow(/disagree/);
  });

  it('accounts for workers by coalition and disables relaunch before proving empty', async () => {
    const f = fixture(); f.prepare(); const scope = f.capture();
    f.state.pids.push(99);
    expect(scope.sample().rssBytes).toBe(8192);
    f.events.length = 0;
    await scope.stop();
    expect(f.events.indexOf('bootout')).toBeLessThan(f.events.indexOf('members'));
    expect(f.events).toContain('KILL');
    await reconcileTrialScopes(dir, f.seams);
    expect(f.events.filter(e => e === 'bootout')).toHaveLength(1);
  });

  it('recovers a captured attempt after restart even if launchd no longer lists the job', async () => {
    const f = fixture(); f.prepare(); f.capture();
    f.state.job = null; f.state.pids = [99];
    await reconcileTrialScopes(dir, f.seams);
    expect(f.state.pids).toEqual([]);
  });

  it('recovers a job still waiting for scope capture', async () => {
    const f = fixture(); f.prepare();
    await reconcileTrialScopes(dir, f.seams);
    expect(f.state.job).toBeNull();
    expect(f.state.pids).toEqual([]);
  });

  it('retains custody if bootout does not remove the service', async () => {
    const f = fixture(); f.prepare(); f.capture();
    f.seams.bootout = vi.fn();
    await expect(reconcileTrialScopes(dir, f.seams)).rejects.toThrow(/still registered/);
    await expect(reconcileTrialScopes(dir, f.seams)).rejects.toThrow(/still registered/);
  });

  it('refuses to touch a replacement label after reboot', async () => {
    const f = fixture(); f.prepare(); f.capture(); f.state.boot = 'boot-2';
    await expect(reconcileTrialScopes(dir, f.seams)).rejects.toThrow(/after host reboot/);
    expect(f.events).not.toContain('TERM');
  });
});
