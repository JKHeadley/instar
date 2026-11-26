/**
 * heavyWorkPlacement (docs/specs/resource-aware-placement.md §6) + the load-report
 * fields it rides (§1/§3): refusal classification (typed and legacy message formats),
 * the single-URL forwarder's three outcomes, and the read-only preview.
 */
import { describe, it, expect } from 'vitest';
import { classifySpawnRefusal, classifySpawnRefusalMessage, forwardHeavySpawn, previewPlacement } from '../../src/core/heavyWorkPlacement.js';
import { AdmissionRefusedError } from '../../src/core/workAdmission.js';
import { SessionCapacityRefusedError } from '../../src/core/sessionCapacityRefusedError.js';
import { clampLoadReport, MachineLoadSampler } from '../../src/core/machineLoadReport.js';
import type { MachineCapacity } from '../../src/core/types.js';

const GIB = 1024 ** 3;

describe('classifySpawnRefusal', () => {
  it('typed errors map to their existing codes', () => {
    expect(classifySpawnRefusal(new AdmissionRefusedError('overloaded', 'x'))).toBe('admission-refused');
    expect(classifySpawnRefusal(new SessionCapacityRefusedError(5, 5))).toBe('session-capacity-refused');
    expect(classifySpawnRefusal(new Error('tmux session "proj-helper" already exists'))).toBe('session-exists');
  });
  it('legacy 500 bodies (message only) are recognised by their exact formats', () => {
    expect(classifySpawnRefusalMessage(new AdmissionRefusedError('overloaded', 'machine closed').message)).toBe('admission-refused');
    expect(classifySpawnRefusalMessage(new SessionCapacityRefusedError(10, 10).message)).toBe('session-capacity-refused');
    expect(classifySpawnRefusalMessage('tmux session "echo-build" already exists')).toBe('session-exists');
  });
  it('anything else is not a definite refusal', () => {
    expect(classifySpawnRefusal(new Error('spawn failed: ENOENT'))).toBeNull();
    expect(classifySpawnRefusalMessage('Internal error, admission-refused somewhere')).toBeNull();
  });
});

function stubFetch(status: number, body: unknown, opts: { throws?: Error } = {}): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (opts.throws) throw opts.throws;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe('forwardHeavySpawn — one URL, three outcomes', () => {
  const base = { url: 'http://peer:4042/', authHeader: 'Bearer t', body: { name: 'h', prompt: 'p', workWeight: 'heavy' } };

  it('201 → started, POSTed once to /sessions/spawn with the body', async () => {
    const s = stubFetch(201, { tmuxSession: 'proj-h' });
    const out = await forwardHeavySpawn({ ...base, fetchImpl: s.fetch });
    expect(out.kind).toBe('started');
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe('http://peer:4042/sessions/spawn');
    expect(JSON.parse(String(s.calls[0].init.body))).toMatchObject({ name: 'h', workWeight: 'heavy' });
  });
  it('4xx → refused (with the target code)', async () => {
    const out = await forwardHeavySpawn({ ...base, fetchImpl: stubFetch(409, { code: 'admission-refused', error: 'x' }).fetch });
    expect(out).toMatchObject({ kind: 'refused', status: 409, code: 'admission-refused' });
  });
  it('a legacy 500 carrying a known refusal message → refused', async () => {
    const out = await forwardHeavySpawn({ ...base, fetchImpl: stubFetch(500, { error: 'Max sessions (10) reached with 10 running' }).fetch });
    expect(out).toMatchObject({ kind: 'refused', code: 'session-capacity-refused' });
  });
  it('any other 5xx → unconfirmed (a launch can fail after tmux started)', async () => {
    const out = await forwardHeavySpawn({ ...base, fetchImpl: stubFetch(500, { error: 'boom after start' }).fetch });
    expect(out).toMatchObject({ kind: 'unconfirmed', status: 500 });
  });
  it('a refused connection (nothing reached the target) → refused', async () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const out = await forwardHeavySpawn({ ...base, fetchImpl: stubFetch(0, {}, { throws: err }).fetch });
    expect(out).toMatchObject({ kind: 'refused', code: 'connection-refused' });
  });
  it('extra headers and a dial override are used', async () => {
    const seen: RequestInit[] = [];
    const out = await forwardHeavySpawn({ ...base, headers: { 'X-Instar-AgentId': 'echo' }, dial: async (init) => { seen.push(init); return new Response('{}', { status: 201 }); } });
    expect(out.kind).toBe('started');
    expect((seen[0].headers as Record<string, string>)['X-Instar-AgentId']).toBe('echo');
    expect(seen[0].method).toBe('POST');
  });
  it('a timeout / dropped connection → unconfirmed, never refused', async () => {
    const err = new Error('The operation was aborted due to timeout'); err.name = 'TimeoutError';
    const out = await forwardHeavySpawn({ ...base, fetchImpl: stubFetch(0, {}, { throws: err }).fetch });
    expect(out).toMatchObject({ kind: 'unconfirmed', status: null });
  });
});

function row(id: string, cores: number, memGiB: number, lpc: number, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId: id, nickname: id, online: true, clockSkewStatus: 'ok', activeSessionCount: 1, maxSessions: 10,
    loadReport: { bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores, totalMemBytes: memGiB * GIB, loadPerCore: lpc, cpuIdlePct: 50, memAvailablePct: 50, memPressureNative: 'normal', eventLoopLagP99Ms: 1, sessionsActive: 1, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false, verdict: 'ok', uptimeS: 10 },
    loadReportAgeMs: 5_000, loadVerdict: 'ok', ...over,
  } as MachineCapacity;
}

describe('previewPlacement — read-only dry run with evidence rows', () => {
  const caps = [row('studio', 16, 64, 1.5, { loadVerdict: 'saturated' }), row('m5pro', 18, 48, 0.7), row('mini', 10, 16, 0.2)];

  it('heavy: chooses the big machine with room and says why the others were not chosen', () => {
    const p = previewPlacement({ capacities: caps, selfMachineId: 'studio', workWeight: 'heavy' });
    expect(p.answeredBy).toEqual({ machineId: 'studio', nickname: 'studio' });
    expect(p.decision).toMatchObject({ chosenMachine: 'm5pro', chosenNickname: 'm5pro', outcome: 'placed' });
    const why = Object.fromEntries(p.machines.map((r) => [r.machineId, r.why]));
    expect(why).toEqual({ studio: 'machine-busy', m5pro: 'fits', mini: 'machine-too-small' });
    expect(p.machines.find((r) => r.machineId === 'mini')).toMatchObject({ cores: 10, memGiB: 16, heavyCapable: false, self: false });
  });
  it('light: the small idle machine is eligible and wins', () => {
    const p = previewPlacement({ capacities: caps, selfMachineId: 'studio', workWeight: 'light' });
    expect(p.decision.chosenMachine).toBe('mini');
    expect(p.machines.every((r) => r.eligible)).toBe(true);
  });
  it('command adds only the signal-only guess (label, never the input)', () => {
    const p = previewPlacement({ capacities: caps, selfMachineId: 'studio', workWeight: 'heavy', command: 'TOKEN=zzz xcodebuild -scheme App' });
    expect(p.inferred).toEqual({ weight: 'heavy', matched: 'xcodebuild' });
    expect(JSON.stringify(p)).not.toContain('zzz');
  });
});

describe('load report — heavyWork + heavyPending', () => {
  const minimal = { bootId: 'b', seq: 1, sampleAgeMs: 0 };
  it('clamp keeps only allow/deny and a bounded positive count', () => {
    expect(clampLoadReport({ ...minimal, heavyWork: 'allow', heavyPending: 2 })).toMatchObject({ heavyWork: 'allow', heavyPending: 2 });
    expect(clampLoadReport({ ...minimal, heavyWork: 'yes', heavyPending: -1 })).not.toHaveProperty('heavyWork');
    expect(clampLoadReport({ ...minimal, heavyPending: -1 })).not.toHaveProperty('heavyPending');
    expect(clampLoadReport({ ...minimal, heavyPending: 1e9 })).toMatchObject({ heavyPending: 1000 });
    expect(clampLoadReport({ ...minimal })).not.toHaveProperty('heavyWork');
  });
  it('the sampler advertises the live override and count, and omits auto / zero', async () => {
    let mode: 'auto' | 'allow' | 'deny' = 'deny';
    let n = 3;
    const s = new MachineLoadSampler({
      platform: 'darwin', cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }], loadavg: () => [0.5, 0, 0], totalmem: () => 16 * GIB,
      readMemAvailablePct: async () => 50, readNativePressure: async () => 'normal', intervalMs: 3_600_000,
      heavyWork: () => mode, heavyPending: () => n,
    });
    await s.start();
    try {
      expect(s.read()).toMatchObject({ heavyWork: 'deny', heavyPending: 3 });
      mode = 'auto'; n = 0;
      const r = s.read()!;
      expect(r).not.toHaveProperty('heavyWork');
      expect(r).not.toHaveProperty('heavyPending');
    } finally {
      s.stop?.();
    }
  });
});
