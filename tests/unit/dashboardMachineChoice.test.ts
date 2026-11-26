import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator, type MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveCreateMachineChoice, hasMachinePick, startTopicOnMachine, parseDashboardCreatePayload, safeMachineLabel, classifyDeliverReply, type StartTopicOnMachineDeps } from '../../src/core/dashboardMachineChoice.js';

const SELF = 'm_studio';
const caps = [
  { machineId: 'm_studio', nickname: 'Mac Studio', online: true, quotaState: { blocked: false } },
  { machineId: 'm_laptop', nickname: 'Laptop', online: true, quotaState: { blocked: false } },
  { machineId: 'm_mini', nickname: 'Mac Mini', online: false },
  { machineId: 'm_pc', nickname: 'Mama PC', online: true, quotaState: { blocked: true } },
];
const resolve = (machine: unknown, capacities = caps, selfMachineId: string | null = SELF) =>
  resolveCreateMachineChoice({ machine, selfMachineId, capacities });

describe('hasMachinePick', () => {
  it('treats absent, empty and "auto" as Automatic', () => {
    for (const m of [undefined, null, '', '   ', 'auto', 'AUTO', ' Auto ']) expect(hasMachinePick(m)).toBe(false);
  });
  it('treats any other value (including a non-string) as a pick', () => {
    for (const m of ['Laptop', 'm_laptop', 42, {}, true]) expect(hasMachinePick(m)).toBe(true);
  });
});

describe('resolveCreateMachineChoice', () => {
  it('Automatic resolves to auto', () => {
    expect(resolve(undefined)).toEqual({ kind: 'auto' });
    expect(resolve('auto')).toEqual({ kind: 'auto' });
  });

  it('resolves a nickname case-insensitively to a remote machine', () => {
    expect(resolve('laptop')).toEqual({ kind: 'remote', machineId: 'm_laptop', nickname: 'Laptop', quotaBlocked: false });
    expect(resolve('  LAPTOP ')).toMatchObject({ kind: 'remote', machineId: 'm_laptop' });
  });

  it('resolves a raw machineId', () => {
    expect(resolve('m_laptop')).toMatchObject({ kind: 'remote', machineId: 'm_laptop', nickname: 'Laptop' });
  });

  it('resolves this machine (by nickname or id) to self', () => {
    expect(resolve('Mac Studio')).toEqual({ kind: 'self', machineId: SELF, nickname: 'Mac Studio' });
    expect(resolve(SELF)).toEqual({ kind: 'self', machineId: SELF, nickname: 'Mac Studio' });
  });

  it('resolves self even when the capacity view omits this machine', () => {
    const noSelf = caps.filter((c) => c.machineId !== SELF);
    expect(resolve(SELF, noSelf)).toMatchObject({ kind: 'self', machineId: SELF });
  });

  it('refuses an unknown machine with 404 and the known names', () => {
    const r = resolve('Toaster');
    expect(r).toMatchObject({ kind: 'error', status: 404, code: 'unknown-machine' });
    if (r.kind === 'error') expect(r.known).toEqual(['Mac Studio', 'Laptop', 'Mac Mini', 'Mama PC']);
  });

  it('refuses an offline machine with 409 and names it', () => {
    const r = resolve('Mac Mini');
    expect(r).toMatchObject({ kind: 'error', status: 409, code: 'machine-offline' });
    if (r.kind === 'error') expect(r.error).toContain('Mac Mini');
  });

  it('treats a machine with no online flag as offline (never assumed reachable)', () => {
    const r = resolve('Laptop', [{ machineId: 'm_laptop', nickname: 'Laptop' }]);
    expect(r).toMatchObject({ kind: 'error', code: 'machine-offline' });
  });

  it('allows a quota-blocked machine and flags it', () => {
    expect(resolve('Mama PC')).toEqual({ kind: 'remote', machineId: 'm_pc', nickname: 'Mama PC', quotaBlocked: true });
  });

  it('refuses a non-string or oversized pick with 400', () => {
    expect(resolve(42)).toMatchObject({ kind: 'error', status: 400, code: 'machine-invalid' });
    expect(resolve('x'.repeat(129))).toMatchObject({ kind: 'error', status: 400, code: 'machine-invalid' });
  });
});

// ── place → checked deliver → claim (spec §3.4 step 3) ───────────────────

function ownership(initial: { status: string; ownerMachineId: string | null; ownershipEpoch: number } | null) {
  let rec = initial;
  const log: string[] = [];
  const deps = (deliver: StartTopicOnMachineDeps['deliver']): StartTopicOnMachineDeps => ({
    readOwnership: () => rec,
    cas: (_k, a) => {
      log.push(a.type);
      const epoch = (rec?.ownershipEpoch ?? 0) + 1;
      if (a.type === 'place') {
        if (rec && rec.status !== 'released') return { ok: false, epoch: rec.ownershipEpoch, reason: 'already-placed' };
        rec = { status: 'placing', ownerMachineId: a.machineId, ownershipEpoch: epoch };
      } else if (a.type === 'claim') {
        if (rec?.status !== 'placing' || rec.ownerMachineId !== a.machineId) return { ok: false, epoch: rec?.ownershipEpoch ?? 0 };
        rec = { status: 'active', ownerMachineId: a.machineId, ownershipEpoch: epoch };
      } else {
        if (rec?.status !== 'active') return { ok: false, epoch: rec?.ownershipEpoch ?? 0 };
        rec = { status: 'released', ownerMachineId: rec.ownerMachineId, ownershipEpoch: epoch };
      }
      return { ok: true, epoch };
    },
    deliver,
    nonce: () => 'n1',
  });
  return { deps, log, rec: () => rec, setRec: (x: typeof rec) => { rec = x; } };
}
const START = { framework: 'codex-cli', model: 'gpt-6-astra', source: 'dashboard-create' as const, machineNickname: 'Laptop' };

describe('startTopicOnMachine', () => {
  it('success: place, deliver with the placed epoch and a dashboard-create id, then claim → active@target', async () => {
    const o = ownership(null);
    const sent: unknown[] = [];
    const r = await startTopicOnMachine(o.deps(async (_t, env) => { sent.push(env); return { kind: 'accepted' as const }; }), '501', 'm_laptop', START);
    expect(r).toEqual({ ok: true, epoch: 2, settled: true });
    expect(o.log).toEqual(['place', 'claim']);
    expect(o.rec()).toMatchObject({ status: 'active', ownerMachineId: 'm_laptop' });
    expect(sent).toEqual([{ sessionKey: '501', messageId: 'dashboard-create:501:n1', payload: { dashboardCreate: START }, ownershipEpoch: 1 }]);
  });

  it('the pin is written after the claim on an accepted or unknown start — NEVER on a refused one (released + unpinned)', async () => {
    for (const out of [{ kind: 'accepted' as const }, { kind: 'unknown' as const, detail: 'y' }]) {
      const o = ownership(null);
      await startTopicOnMachine(o.deps(async () => out), '501', 'm_laptop', START, () => { o.log.push('pin'); return true; });
      expect(o.log).toEqual(['place', 'claim', 'pin']);
    }
    const rejected = ownership(null);
    await startTopicOnMachine(rejected.deps(async () => ({ kind: 'rejected' as const, detail: 'x' })), '501', 'm_laptop', START, () => { rejected.log.push('pin'); return true; });
    expect(rejected.log).toEqual(['place', 'claim', 'release']);
    expect(rejected.rec()?.status).toBe('released');
    const refused = ownership({ status: 'active', ownerMachineId: 'm_mini', ownershipEpoch: 4 });
    await startTopicOnMachine(refused.deps(async () => ({ kind: 'accepted' as const })), '501', 'm_laptop', START, () => { refused.log.push('pin'); return true; });
    expect(refused.log).toEqual([]);
  });

  it('a definitive rejection ⇒ claim then release: the record rests released, never placing', async () => {
    const o = ownership(null);
    const r = await startTopicOnMachine(o.deps(async () => ({ kind: 'rejected' as const, detail: '403 not-router' })), '501', 'm_laptop', START);
    expect(r).toEqual({ ok: false, code: 'start-failed', error: '403 not-router', released: true, settled: true });
    expect(o.log).toEqual(['place', 'claim', 'release']);
    expect(o.rec()?.status).toBe('released');
  });

  it('the claim lost to ANOTHER owner ⇒ start-superseded: no pin, nothing released, the new owner stands', async () => {
    const o = ownership(null);
    const pins: string[] = [];
    // Deliver succeeds, but during the round trip the registry moved the record to the mini.
    const r = await startTopicOnMachine(o.deps(async () => {
      // simulate the move: the record now reads active@m_mini at a higher epoch
      (o as unknown as { setRec: (x: unknown) => void }).setRec({ status: 'active', ownerMachineId: 'm_mini', ownershipEpoch: 9 });
      return { kind: 'accepted' as const };
    }), '501', 'm_laptop', START, () => { pins.push('pin'); return true; });
    expect(r).toEqual({ ok: false, code: 'start-superseded', delivered: 'accepted', ownerNow: 'm_mini', epochNow: 9, statusNow: 'active' });
    expect(pins).toEqual([]);
    expect(o.rec()).toMatchObject({ status: 'active', ownerMachineId: 'm_mini' });
  });

  it('a NEWER placement onto the SAME target (another epoch) is superseded too — never released or pinned by a late rejection', async () => {
    const o = ownership(null);
    const pins: string[] = [];
    const r = await startTopicOnMachine(o.deps(async () => {
      // re-placed + claimed onto the same target at a later generation during our round trip
      (o as unknown as { setRec: (x: unknown) => void }).setRec({ status: 'active', ownerMachineId: 'm_laptop', ownershipEpoch: 4 });
      return { kind: 'rejected' as const, detail: '403 late' };
    }), '501', 'm_laptop', START, () => { pins.push('pin'); return true; });
    expect(r).toMatchObject({ ok: false, code: 'start-superseded', delivered: 'rejected', ownerNow: 'm_laptop', epochNow: 4, statusNow: 'active', error: '403 late' });
    expect(pins).toEqual([]);
    expect(o.log).toEqual(['place', 'claim']); // no release of a generation that is not ours
    expect(o.rec()).toMatchObject({ status: 'active', ownerMachineId: 'm_laptop', ownershipEpoch: 4 });
  });

  it('a refused start whose claim lost but whose record reads active@target is still released', async () => {
    const o = ownership(null);
    let claims = 0;
    const base = o.deps(async () => ({ kind: 'rejected' as const, detail: '403' }));
    const deps = { ...base, cas: (k: string, a: Parameters<typeof base.cas>[1]) => {
      if (a.type === 'claim' && claims++ === 0) {
        // the router's concurrent confirm already made it active@target at THIS
        // placement's generation (place landed at 1, so the confirming claim is 2)
        (o as unknown as { setRec: (x: unknown) => void }).setRec({ status: 'active', ownerMachineId: 'm_laptop', ownershipEpoch: 2 });
        return { ok: false, epoch: 2 };
      }
      return base.cas(k, a);
    } };
    const r = await startTopicOnMachine(deps, '501', 'm_laptop', START);
    expect(r).toMatchObject({ ok: false, code: 'start-failed', released: true, settled: true });
    expect(o.rec()?.status).toBe('released');
  });

  it('a THROWN deliver is retried with the SAME messageId (bounded); a reply that reached the target is not', async () => {
    const o = ownership(null);
    const ids: string[] = [];
    let n = 0;
    const r = await startTopicOnMachine(o.deps(async (_t, env) => { ids.push(env.messageId); if (n++ === 0) throw new Error('aborted'); return { kind: 'accepted' as const }; }), '501', 'm_laptop', START);
    expect(r).toMatchObject({ ok: true, settled: true });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    // a 5xx-class reply (unknown, but it REACHED the target) is settled at once
    const p = ownership(null);
    let sends = 0;
    const u = await startTopicOnMachine(p.deps(async () => { sends++; return { kind: 'unknown' as const, detail: '503' }; }), '501', 'm_laptop', START);
    expect(u).toMatchObject({ ok: false, code: 'start-unknown' });
    expect(sends).toBe(1);
  });

  it('an unknown outcome (throw / timeout / no ack) ⇒ claim and KEEP — the target may be running it', async () => {
    for (const deliver of [
      async () => { throw new Error('aborted'); },
      async () => ({ kind: 'unknown' as const, detail: 'no ack' }),
    ]) {
      const o = ownership(null);
      const r = await startTopicOnMachine(o.deps(deliver), '501', 'm_laptop', START);
      expect(r).toMatchObject({ ok: false, code: 'start-unknown', settled: true });
      expect(o.log).toEqual(['place', 'claim']);
      expect(o.rec()).toMatchObject({ status: 'active', ownerMachineId: 'm_laptop' });
    }
  });

  it('a lost claim CAS is retried once; if it still fails the result says settled:false', async () => {
    const o = ownership(null);
    const base = o.deps(async () => ({ kind: 'accepted' as const }));
    let claimTries = 0;
    const flaky: StartTopicOnMachineDeps = { ...base, cas: (k, a) => (a.type === 'claim' && ++claimTries === 1 ? { ok: false, epoch: 1 } : base.cas(k, a)) };
    expect(await startTopicOnMachine(flaky, '501', 'm_laptop', START)).toEqual({ ok: true, epoch: 2, settled: true });
    expect(claimTries).toBe(2);
    const o2 = ownership(null);
    const base2 = o2.deps(async () => ({ kind: 'accepted' as const }));
    const dead: StartTopicOnMachineDeps = { ...base2, cas: (k, a) => (a.type === 'claim' ? { ok: false, epoch: 1 } : base2.cas(k, a)) };
    expect(await startTopicOnMachine(dead, '501', 'm_laptop', START)).toMatchObject({ ok: true, settled: false });
  });

  it('an existing live record ⇒ refused before anything is sent', async () => {
    const o = ownership({ status: 'active', ownerMachineId: 'm_mini', ownershipEpoch: 4 });
    let called = false;
    const r = await startTopicOnMachine(o.deps(async () => { called = true; return { kind: 'accepted' as const }; }), '501', 'm_laptop', START);
    expect(r).toMatchObject({ ok: false, code: 'topic-owned-elsewhere' });
    expect(called).toBe(false);
    expect(o.log).toEqual([]);
  });
});

describe('parseDashboardCreatePayload', () => {
  it('accepts only the exact object shape', () => {
    expect(parseDashboardCreatePayload({ dashboardCreate: START })).toEqual(START);
    expect(parseDashboardCreatePayload({ dashboardCreate: { framework: null, model: null, source: null, machineNickname: 'Laptop' } }))
      .toEqual({ framework: null, model: null, source: null, machineNickname: 'Laptop' });
  });
  it('never a string (a queued or typed JSON is conversation text), never with text or extra keys', () => {
    expect(parseDashboardCreatePayload(JSON.stringify({ dashboardCreate: START }))).toBeNull();
    expect(parseDashboardCreatePayload({ dashboardCreate: START, text: 'hi' })).toBeNull();
    expect(parseDashboardCreatePayload({ dashboardCreate: START, extra: 1 })).toBeNull();
    expect(parseDashboardCreatePayload(null)).toBeNull();
    expect(parseDashboardCreatePayload([{ dashboardCreate: START }])).toBeNull();
  });
  it('refuses a framework without a known source, and malformed fields', () => {
    expect(parseDashboardCreatePayload({ dashboardCreate: { ...START, source: 'chat' } })).toBeNull();
    expect(parseDashboardCreatePayload({ dashboardCreate: { ...START, framework: 7 } })).toBeNull();
    expect(parseDashboardCreatePayload({ dashboardCreate: { ...START, model: 'x'.repeat(200) } })).toBeNull();
  });
});

describe('safeMachineLabel', () => {
  it('keeps a well-formed nickname and falls back to the id otherwise', () => {
    expect(safeMachineLabel('Mac Studio', 'm_1')).toBe('Mac Studio');
    expect(safeMachineLabel('[click](http://x)', 'm_1')).toBe('m_1');
    expect(safeMachineLabel('', 'm_1')).toBe('m_1');
    expect(safeMachineLabel(null, 'm_1')).toBe('m_1');
  });
});

describe('classifyDeliverReply', () => {
  it('queued / duplicate are accepted', () => {
    expect(classifyDeliverReply({ ok: true, status: 200, result: { accepted: 'queued' } })).toEqual({ kind: 'accepted' });
    expect(classifyDeliverReply({ ok: true, status: 200, result: { accepted: 'duplicate' } })).toEqual({ kind: 'accepted' });
  });
  it('a 4xx gate answer and a stale/sender refusal are definitive rejections', () => {
    expect(classifyDeliverReply({ ok: false, status: 403, reason: 'not-router' })).toEqual({ kind: 'rejected', detail: '403 not-router' });
    expect(classifyDeliverReply({ ok: true, status: 200, result: { accepted: 'stale-ownership' } })).toMatchObject({ kind: 'rejected' });
  });
  it('5xx, a throw, no reply, or a missing ack are unknown — never read as "did not start"', () => {
    expect(classifyDeliverReply({ ok: false, status: 500, reason: 'boom' })).toMatchObject({ kind: 'unknown' });
    expect(classifyDeliverReply({ ok: false, status: 408, reason: 'proxy timeout' })).toMatchObject({ kind: 'unknown' });
    expect(classifyDeliverReply(null, new Error('aborted'))).toEqual({ kind: 'unknown', detail: 'aborted' });
    expect(classifyDeliverReply(null)).toMatchObject({ kind: 'unknown' });
    expect(classifyDeliverReply({ ok: true, status: 200, result: {} })).toEqual({ kind: 'unknown', detail: 'no ack' });
  });
});

describe('agent awareness + migration parity', () => {
  const MARKER = '- **Dashboard machine choice**';
  const run = (projectDir: string): MigrationResult => {
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const m = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    (m as unknown as { migrateClaudeMd: (r: MigrationResult) => void }).migrateClaudeMd(result);
    return result;
  };

  it('the template carries the line right after the door + model line', () => {
    const md = generateClaudeMd('test', 'TestAgent', 4042, false);
    const door = md.indexOf('- **Dashboard door + model controls**');
    const line = md.indexOf(MARKER);
    expect(door).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(door);
    expect(md.slice(door, line).split('\n').length).toBe(2);
    expect(md).toContain('"machine":"<nickname|machineId>"');
  });

  it('migrateClaudeMd inserts it after the door line on an existing agent, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmc-migrate-'));
    try {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Agent\n\n- **Dashboard door + model controls** (Sessions tab): old line.\n- next bullet\n');
      const r1 = run(dir);
      expect(r1.upgraded).toContain('CLAUDE.md: added dashboard machine choice line to Topic Profile section');
      const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
      expect(md.indexOf(MARKER)).toBeGreaterThan(md.indexOf('old line.'));
      expect(md.indexOf(MARKER)).toBeLessThan(md.indexOf('- next bullet'));
      const r2 = run(dir);
      expect(r2.upgraded).not.toContain('CLAUDE.md: added dashboard machine choice line to Topic Profile section');
      expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8').split(MARKER).length).toBe(2);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/dashboardMachineChoice:cleanup' });
    }
  });
});
