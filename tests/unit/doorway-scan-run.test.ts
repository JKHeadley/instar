/**
 * doorway-scan main path: a run really probes, really writes scan-state and
 * delivers only confirmed changes (CMT-978). The other doorway tests cover the
 * pure pieces; this file drives them together, including the real script.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readDoorwayRegistry } from '../../src/core/DoorwayRegistryReader.js';
import * as P from '../../scripts/doorway-scan.mjs';

const REPO = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO, 'scripts/doorway-scan.mjs');
const MACHINE = 'm_test';

const door = (bin: string) => ({ probe: { kind: 'cli-version', bin, metered: false } });
const manifest = { doors: { alpha: door('alpha'), beta: door('beta') }, candidateDoorways: ['alpha', 'beta', 'gamma'] };

/** which/--version stand-in: `installed` lists the bins that exist. */
const fakeExec = (installed: string[]) => async (file: string, args: string[]) => {
  if (file === 'which' && !installed.includes(args[0])) throw new Error('not found');
  return { stdout: '1.0.0' };
};

function fakeServer(attentionStatus = 201) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
    const route = url.replace('http://server', '');
    calls.push({ method: init.method, url: route, body: init.body ? JSON.parse(init.body) : null });
    const status = route === '/attention' ? attentionStatus : route === '/view' ? 201 : 200;
    return { status, json: async () => (route === '/view' ? { id: '11111111-1111-4111-8111-111111111111' } : { url: null }) };
  };
  return { calls, ctx: { fetch: fetchImpl, baseUrl: 'http://server', token: 't', agentId: 'a' } };
}

describe('doorway-scan run', () => {
  let dir: string;
  let statePath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorway-run-'));
    statePath = path.join(dir, 'state', 'doorway-scan.json');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/doorway-scan-run.test.ts' }));

  const scan = (installed: string[], ctx: unknown) =>
    P.scanOnce({ manifest, scanStatePath: statePath, machineId: MACHINE, ctx, deps: { exec: fakeExec(installed) } });
  const onDisk = () => JSON.parse(fs.readFileSync(statePath, 'utf-8'));

  it('the first scan writes real state, seeds the baseline and surfaces nothing', async () => {
    const { calls, ctx } = fakeServer();
    const summary = await scan(['alpha'], ctx);
    const state = onDisk();
    expect(summary).toContain('scanned 3 doors, 1 answered, baseline seed');
    expect(Date.parse(state.lastScanAt)).toBeGreaterThan(0);
    expect(state.machineId).toBe(MACHINE);
    expect(state.doorways.map((d: { id: string; probeStatus: string }) => [d.id, d.probeStatus])).toEqual([
      ['alpha', 'ok'], ['beta', 'not-installed'], ['gamma', 'not-probed-this-scope'],
    ]);
    expect(state.surfacedBaseline.at).toBe(state.lastScanAt);
    expect(calls).toEqual([]);
  });

  it('a door that was never there does not raise "went unreachable"', async () => {
    const { calls, ctx } = fakeServer();
    for (let i = 0; i < 3; i++) await scan(['alpha'], ctx);
    expect(calls).toEqual([]);
    expect(onDisk().doorways.find((d: { id: string }) => d.id === 'beta').reachable).toBe(false);
  });

  it('a working door that disappears surfaces once, after two scans, on a confirmed delivery', async () => {
    const { calls, ctx } = fakeServer();
    await scan(['alpha', 'beta'], ctx);
    await scan(['alpha'], ctx);
    expect(calls).toEqual([]);
    await scan(['alpha'], ctx);
    const att = calls.filter((c) => c.url === '/attention');
    expect(att).toHaveLength(1);
    expect(att[0].body).toMatchObject({ id: `doorway-scan:changes:${MACHINE}`, sourceContext: `doorway-scan:${MACHINE}`, source: 'agent', priority: 'medium' });
    expect(String(att[0].body!.body)).not.toMatch(/localhost|127\.0\.0\.1|\.json|\.mjs/);
    await scan(['alpha'], ctx);
    expect(calls.filter((c) => c.url === '/attention')).toHaveLength(1);
  });

  it('a held notice keeps the baseline, marks the failure and comes back next scan', async () => {
    const held = fakeServer(422);
    await scan(['alpha', 'beta'], held.ctx);
    await scan(['alpha'], held.ctx);
    await scan(['alpha'], held.ctx);
    const after = onDisk();
    expect(after.lastDeliveryFailedAt).toBe(after.lastScanAt);
    expect(after.surfacedBaseline.doorways.find((d: { id: string }) => d.id === 'beta').reachable).toBe(true);

    const ok = fakeServer();
    await scan(['alpha'], ok.ctx);
    expect(ok.calls.filter((c) => c.url === '/attention')).toHaveLength(1);
    expect(onDisk().lastDeliveryFailedAt).toBe(null);
  });

  it('a door that flips and flips back before delivery clears the marker with no notice', async () => {
    const held = fakeServer(422);
    await scan(['alpha', 'beta'], held.ctx);
    await scan(['alpha'], held.ctx);
    await scan(['alpha'], held.ctx);
    const ok = fakeServer();
    await scan(['alpha', 'beta'], ok.ctx);
    expect(ok.calls).toEqual([]);
    expect(onDisk().lastDeliveryFailedAt).toBe(null);
  });

  it('a corrupt state file starts fresh instead of crashing', async () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{nope');
    const { ctx } = fakeServer();
    await scan(['alpha'], ctx);
    expect(onDisk().doorways).toHaveLength(3);
  });

  it('three scans with no door answering escalate exactly once; a recovery resets the count', async () => {
    const { calls, ctx } = fakeServer();
    for (let i = 0; i < 4; i++) await scan([], ctx);
    const zero = calls.filter((c) => String(c.body?.id).startsWith('doorway-scan:zero-doors'));
    expect(zero).toHaveLength(1);
    await scan(['alpha'], ctx);
    expect(onDisk().consecutiveCompleteFailures).toBe(0);
  });

  it('a door that recovers and later fails again surfaces the second outage too', async () => {
    const { calls, ctx } = fakeServer();
    await scan(['alpha', 'beta'], ctx);
    await scan(['alpha'], ctx);
    await scan(['alpha'], ctx);
    expect(calls.filter((c) => c.url === '/attention')).toHaveLength(1);
    await scan(['alpha', 'beta'], ctx);
    await scan(['alpha'], ctx);
    await scan(['alpha'], ctx);
    expect(calls.filter((c) => c.url === '/attention')).toHaveLength(2);
  });

  it('a door seeded as missing, then installed, then removed surfaces', async () => {
    const { calls, ctx } = fakeServer();
    await scan(['alpha'], ctx);
    await scan(['alpha', 'beta'], ctx);
    await scan(['alpha'], ctx);
    await scan(['alpha'], ctx);
    expect(calls.filter((c) => c.url === '/attention')).toHaveLength(1);
  });

  it('a failed breaker escalation is retried until it lands, then stops', async () => {
    const held = fakeServer(422);
    for (let i = 0; i < 3; i++) await scan([], held.ctx);
    expect(onDisk().escalationPending).toBe(true);
    const ok = fakeServer();
    await scan([], ok.ctx);
    await scan([], ok.ctx);
    expect(ok.calls.filter((c) => String(c.body?.id).startsWith('doorway-scan:zero-doors'))).toHaveLength(1);
  });

  it('a delivered escalation is not reposted while a change notice stays held', async () => {
    const posts: string[] = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      const id = init.body ? String(JSON.parse(init.body).id) : '';
      if (url.endsWith('/attention')) posts.push(id);
      const held = url.endsWith('/attention') && id.includes(':changes:');
      return { status: held ? 422 : 200, json: async () => ({ url: null }) };
    };
    const ctx = { fetch: fetchImpl, baseUrl: 'http://server', token: 't', agentId: 'a' };
    await scan(['alpha', 'beta'], ctx);
    for (let i = 0; i < 6; i++) await scan([], ctx);
    expect(posts.filter((p) => p.includes(':zero-doors:'))).toHaveLength(1);
    expect(onDisk().lastDeliveryFailedAt).toBe(onDisk().lastScanAt);
  });

  it('a door not started by the deadline is recorded, never omitted', async () => {
    let t = 1_000_000;
    const { state } = await P.runScan({
      manifest, prior: P.freshScanState(), machineId: MACHINE,
      deps: { exec: fakeExec(['alpha']), deadlineMs: 5 },
      now: () => new Date((t += 10)),
    });
    expect(state.doorways.map((d: { probeStatus: string }) => d.probeStatus)).toEqual(Array(3).fill('not-probed-this-run'));
  });

  it('a metered-only door is never probed on the free scope', async () => {
    const exec = async () => { throw new Error('must not run'); };
    expect(await P.probeDoorFree({ probe: { kind: 'cli-version', bin: 'x', metered: true } }, { exec })).toEqual({ probeStatus: 'not-probed-this-scope', topModels: [] });
    expect(await P.probeDoorFree({ probe: { kind: 'none' } }, { exec })).toEqual({ probeStatus: 'not-probed-this-scope', topModels: [] });
  });

  it('LIVE PATH: the real script scans a real PATH, and the /doorways reader reports it scanned', () => {
    const scripts = path.join(dir, 'scripts');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(scripts);
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'fakedoor'), '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
    fs.writeFileSync(path.join(scripts, 'model-registry-freshness.manifest.json'), JSON.stringify({
      doors: { fakedoor: door('fakedoor'), gone: door('no-such-binary-here') },
    }));
    const instar = path.join(dir, '.instar');
    expect(readDoorwayRegistry({ projectDir: dir, stateDir: instar })).toMatchObject({ body: { scanState: 'never-run' } });
    const r = spawnSync(process.execPath, [SCRIPT, '--scope', 'free-probes'], {
      cwd: dir, encoding: 'utf-8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, INSTAR_PORT: '1' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^doorway-scan: scope=free-probes/m);
    expect(r.stdout).toMatch(/scanned 2 doors, 1 answered/);
    const view = readDoorwayRegistry({ projectDir: dir, stateDir: instar });
    expect(view).toMatchObject({ status: 'ok', body: { scanState: 'scanned' } });
    const doors = (view as { body: { doorways: Array<{ doorId: string; reachable: boolean; probeStatus: string }> } }).body.doorways;
    expect(doors.map((d) => [d.doorId, d.reachable, d.probeStatus])).toEqual([['fakedoor', true, 'ok'], ['gone', false, 'not-installed']]);
  });

  it('MUST-FAIL: a run that cannot write its state exits non-zero', () => {
    const scripts = path.join(dir, 'scripts');
    fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, 'model-registry-freshness.manifest.json'), JSON.stringify({ doors: {} }));
    fs.writeFileSync(path.join(dir, '.instar'), 'a file where the state directory should be');
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: dir, INSTAR_PORT: '1' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/doorway-scan: fatal:/);
  });
});
