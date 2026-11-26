/**
 * Unit: the phone's schedule, promises and machines summaries (docs/specs/mobile-native-ops-screens.md)
 * and the owner-or-bearer check, both sides of every rule.
 */
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { summarizeJobs, summarizeCommitments, summarizeMachines, evidenceLine, machineKey, ownerOrBearer, phoneText, scheduleWords, LATE_GRACE_MS, MAX_JOBS } from '../../src/server/mobileOpsRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-11-03T22:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const job = (slug: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ slug, name: slug, schedule: '0 * * * *', enabled: true, runsOnThisMachine: true, state, ...extra });

describe('summarizeJobs', () => {
  it('late = recorded next run more than 10 min past and not running; 10 min is not late', () => {
    const r = summarizeJobs({ jobs: [
      job('late', { nextScheduled: at(-LATE_GRACE_MS - 60_000), consecutiveFailures: 0 }),
      job('edge', { nextScheduled: at(-LATE_GRACE_MS + 60_000), consecutiveFailures: 0 }),
    ] }, NOW).jobs;
    expect(r.find((j) => j.slug === 'late')).toMatchObject({ status: 'late', needsLook: true });
    expect(r.find((j) => j.slug === 'edge')!.status).toBe('ok');
  });
  it('a job that does not run here is never late', () => {
    const r = summarizeJobs({ jobs: [job('x', { nextScheduled: at(-3_600_000) }, { runsOnThisMachine: false })] }, NOW).jobs;
    expect(r[0].status).toBe('elsewhere');
  });
  it('failing beats late; off and running are their own states; no next time is "unknown"', () => {
    const r = summarizeJobs({ jobs: [
      job('ok', { nextScheduled: at(3_600_000) }),
      job('off', { nextScheduled: at(-3_600_000) }, { enabled: false }),
      job('run', { lastResult: 'pending', lastRun: at(-120_000) }),
      job('unk', {}),
      job('fail', { consecutiveFailures: 1, nextScheduled: at(-3_600_000) }),
    ] }, NOW).jobs;
    expect(r.map((j) => [j.slug, j.status])).toEqual([['fail', 'failing'], ['run', 'running'], ['unk', 'next-unknown'], ['ok', 'ok'], ['off', 'off']]);
    expect(r[0].statusLine).toContain('Failed its last run');
    expect(r[0].statusLine).toContain('past its next-run time');
    expect(r[1].statusLine).toBe('Running for 2 min');
  });
  it('a retry running after failures stays failing', () => {
    const r = summarizeJobs({ jobs: [job('x', { lastResult: 'pending', lastRun: at(-60_000), consecutiveFailures: 2 })] }, NOW).jobs;
    expect(r[0]).toMatchObject({ status: 'failing', needsLook: true, statusLine: 'Running for 1 min · failed its last 2 runs' });
  });
  it('one row per slug across machines; worst status wins and shows its own times', () => {
    const r = summarizeJobs({ jobs: [
      job('a', { nextScheduled: at(300_000) }, { machineId: 'm1', machineNickname: 'Studio' }),
      job('a', { consecutiveFailures: 3, nextScheduled: at(600_000) }, { machineId: 'm2', machineNickname: 'Mac Mini', remote: true }),
    ] }, NOW).jobs;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: 'failing', machines: ['Mac Mini'], nextRunAt: at(600_000), consecutiveFailures: 3 });
  });
  it('placement decides first: a non-running machine\'s old failures never outrank the machine that runs it', () => {
    const r = summarizeJobs({ jobs: [
      job('a', { consecutiveFailures: 4, nextScheduled: at(-3_600_000) }, { machineId: 'm2', machineNickname: 'Mac Mini', runsOnThisMachine: false, remote: true }),
      job('a', { nextScheduled: at(300_000) }, { machineId: 'm1', machineNickname: 'Studio' }),
    ] }, NOW).jobs;
    expect(r[0]).toMatchObject({ status: 'ok', machines: ['Studio'] });
  });
  it('a late row shows its overdue time, never a healthy peer\'s future run', () => {
    const r = summarizeJobs({ jobs: [
      job('a', { nextScheduled: at(-3_600_000) }, { machineId: 'm1', machineNickname: 'Studio' }),
      job('a', { nextScheduled: at(300_000) }, { machineId: 'm2', machineNickname: 'Mac Mini', remote: true }),
    ] }, NOW).jobs;
    expect(r[0]).toMatchObject({ status: 'late', machines: ['Studio'], nextRunAt: at(-3_600_000) });
  });
  it('an older peer row without runsOnThisMachine is never late; a local one without it is', () => {
    const old = { slug: 'p', name: 'p', schedule: '0 * * * *', enabled: true, remote: true, state: { nextScheduled: at(-3_600_000) } };
    expect(summarizeJobs({ jobs: [old] }, NOW).jobs[0].status).toBe('elsewhere');
    const { remote: _r, ...local } = old;
    expect(summarizeJobs({ jobs: [local] }, NOW).jobs[0].status).toBe('late');
  });
  it('never carries execute, paths or unverified machine ids; caps the list', () => {
    const r = summarizeJobs({ jobs: [job('a', {}, { execute: { value: 'PROMPT' }, resolvedPath: '/x', machineId: 'm_abcdefabcdef12', machineNickname: 'm_abcdefabcdef12' })] }, NOW);
    const t = JSON.stringify(r);
    expect(t).not.toContain('PROMPT');
    expect(t).not.toContain('resolvedPath');
    expect(r.jobs[0].machines).toEqual([]);
    const many = summarizeJobs({ jobs: Array.from({ length: MAX_JOBS + 5 }, (_, i) => job(`j${i}`, {})) }, NOW);
    expect(many.jobs).toHaveLength(MAX_JOBS);
    expect(many.truncated).toBe(true);
  });
  it('every emitted string field is scrubbed or validated: slug, schedule, fallback name', () => {
    const tok = `token=${'q'.repeat(20)}`;
    const r = summarizeJobs({ jobs: [
      { slug: '../../etc/passwd', name: 'bad', state: {} },
      { slug: 'ok-job', schedule: tok, state: {} },
    ] }, NOW).jobs;
    expect(r.map((j) => j.slug)).toEqual(['ok-job']);
    expect(JSON.stringify(r)).not.toContain('q'.repeat(20));
    expect(r[0].name).toBe('ok-job');
  });
  it('a malformed payload answers an empty list', () => {
    expect(summarizeJobs(null, NOW).jobs).toEqual([]);
    expect(summarizeJobs({ jobs: [null, 5, { name: 'no slug' }] }, NOW).jobs).toEqual([]);
  });
});

describe('summarizeCommitments', () => {
  const c = (id: string, extra: Record<string, unknown>) => ({ id, userRequest: `req ${id}`, agentResponse: `promise ${id}`, status: 'pending', createdAt: at(-86_400_000), ...extra });
  it('open first: overdue, then soonest due; closed within 7 days after; older closed left out', () => {
    const r = summarizeCommitments([
      c('later', { checkInAt: at(7_200_000) }),
      c('soon', { nextUpdateDueAt: at(600_000) }),
      c('overdue', { hardDeadlineAt: at(-60_000) }),
      c('closed-recent', { status: 'delivered', resolvedAt: at(-86_400_000) }),
      c('closed-old', { status: 'delivered', resolvedAt: at(-8 * 86_400_000) }),
    ], NOW).commitments;
    expect(r.map((x) => x.id)).toEqual(['overdue', 'soon', 'later', 'closed-recent']);
    expect(r[0]).toMatchObject({ overdue: true, open: true });
    expect(r[3]).toMatchObject({ open: false, overdue: false, waitingOn: null });
  });
  it('waiting on: owner user = "you"; blockedOn words; replica rows name a verified machine only', () => {
    const r = summarizeCommitments([
      c('a', { owner: 'user' }),
      c('b', { blockedOn: 'user-authorization' }),
      c('d', { viewSource: 'replica', originMachineId: 'm2' }),
    ], NOW, (id) => (id === 'm2' ? 'Mac Mini' : null)).commitments;
    expect(r.find((x) => x.id === 'a')!.waitingOn).toBe('you');
    expect(r.find((x) => x.id === 'b')!.waitingOn).toBe('your approval');
    expect(r.find((x) => x.id === 'd')!.machine).toBe('Mac Mini');
  });
  it('replica rows older than 15 min, or of unknown age, are stale; own rows never', () => {
    const r = summarizeCommitments([
      c('own', {}),
      c('fresh', { viewSource: 'replica', originMachineId: 'm2', stalenessMs: 60_000 }),
      c('old', { viewSource: 'replica', originMachineId: 'm2', stalenessMs: 16 * 60_000 }),
      c('unknown', { viewSource: 'replica', originMachineId: 'm2' }),
    ], NOW).commitments;
    expect(Object.fromEntries(r.map((x) => [x.id, x.stale]))).toEqual({ own: false, fresh: false, old: true, unknown: true });
  });
  it('text is scrubbed and capped; config paths and rules never appear', () => {
    const r = summarizeCommitments([c('s', { agentResponse: `use token=${'z'.repeat(20)} ${'x'.repeat(400)}`, configPath: '/etc/secret', behavioralRule: 'RULE' })], NOW).commitments;
    expect(r[0].text).not.toContain('z'.repeat(20));
    expect(r[0].text.length).toBeLessThanOrEqual(280);
    expect(JSON.stringify(r)).not.toMatch(/\/etc\/secret|RULE/);
  });
});

describe('summarizeMachines', () => {
  it('single-machine agent (pool off): one row, named without "this machine"', () => {
    const r = summarizeMachines({ enabled: false, machines: [] }, '1.0.0');
    expect(r).toMatchObject({ single: true, inventoryKnown: true, headline: 'One machine, answering.' });
    expect(r.machines[0]).toMatchObject({ name: 'Your machine', isSelf: true, version: '1.0.0', statusLine: 'Live' });
    const named = summarizeMachines({ enabled: true, selfMachineId: 'm_1', machines: [] }, null, () => 'Mac Studio');
    expect(named.machines[0].name).toBe('Mac Studio');
    expect(named.headline).toBe("Mac Studio is answering, but I can't read the list of your other machines right now.");
  });
  it('an enabled pool with no usable rows is "can\'t read the list", never "one machine"', () => {
    for (const pool of [{ enabled: true, machines: [] }, { enabled: true }, { enabled: true, machines: [{ nickname: 'no id' }] }, {}, null]) {
      const r = summarizeMachines(pool, null);
      expect(r).toMatchObject({ single: false, inventoryKnown: false });
      expect(r.headline).toContain("can't read");
    }
  });
  it('the self row keeps its key whether or not the pool list could be read', () => {
    const empty = summarizeMachines({ enabled: true, selfMachineId: 'm1', machines: [] }, null);
    const full = summarizeMachines({ enabled: true, selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'Studio', online: true }] }, null);
    expect(empty.machines[0].key).toBe(full.machines[0].key);
  });
  it('headline says "appear to be answering (estimated)" when a peer has no liveness evidence', () => {
    const r = summarizeMachines({ enabled: true, selfMachineId: 'm1', machines: [
      { machineId: 'm1', nickname: 'Studio', liveness: { state: 'live' } },
      { machineId: 'm2', nickname: 'Mini', online: true },
    ] }, null);
    expect(r.headline).toBe('Both machines appear to be answering (estimated from heartbeats).');
  });
  it('an enabled pool with one row is "one known machine", not a proven single machine', () => {
    const r = summarizeMachines({ enabled: true, selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'Studio', liveness: { state: 'live' } }] }, null);
    expect(r).toMatchObject({ single: false, inventoryKnown: true, headline: 'One known machine, answering.' });
  });
  it('row keys are stable across reorderings and do not contain the machine id', () => {
    const a = summarizeMachines({ selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'Studio', online: true }, { machineId: 'm2', nickname: 'Mini', online: true }] }, null);
    const b = summarizeMachines({ selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'Studio', online: true }, { machineId: 'm2', nickname: 'Mini', online: false }] }, null);
    const key = (r: typeof a, n: string) => r.machines.find((m) => m.name === n)!.key;
    expect(key(a, 'Mini')).toBe(key(b, 'Mini'));
    expect(key(a, 'Mini')).not.toBe(key(a, 'Studio'));
    expect(key(a, 'Mini')).not.toContain('m2');
  });
  it('liveness decides the state; unreachable first; headline names it', () => {
    const r = summarizeMachines({ selfMachineId: 'm1', router: { holder: 'm1' }, machines: [
      { machineId: 'm1', nickname: 'Studio', liveness: { state: 'live' }, livenessLine: 'live (this machine)', loadVerdict: 'saturated' },
      { machineId: 'm2', nickname: 'Mac Mini', liveness: { state: 'unreachable', shape: 'silent' }, livenessLine: 'unreachable (silent), last evidence 3 min ago from heartbeat' },
    ] }, null);
    expect(r.machines.map((m) => [m.name, m.state])).toEqual([['Mac Mini', 'unreachable'], ['Studio', 'struggling']]);
    expect(r.headline).toBe("Mac Mini isn't answering.");
    expect(r.machines[0].statusLine).toBe('Not answering');
    expect(r.machines[1]).toMatchObject({ leading: true, statusLine: 'Live · overloaded' });
  });
  it('wording never depends on which machine answered (Justin 2026-11-06: the app is agnostic)', () => {
    const pool = (self: string) => ({ selfMachineId: self, router: { holder: 'm1' }, machines: [
      { machineId: 'm1', nickname: 'Mac Studio', liveness: { state: 'live', source: self === 'm1' ? 'self' : 'direct', evidenceAgeMs: 3000 }, livenessLine: 'live (this machine)', loadVerdict: 'elevated', activeSessionCount: 14, maxSessions: 25 },
      { machineId: 'm2', nickname: 'Laptop', liveness: { state: 'live', source: self === 'm2' ? 'self' : 'direct', evidenceAgeMs: 3000, peerSighting: { observerMachineId: 'm3', ageMs: 9000 } }, livenessLine: 'live, last evidence 3 s ago from a direct check from this machine; Mac M5 Pro reached it 9 s ago', loadVerdict: 'ok' },
      { machineId: 'm3', nickname: 'Mac M5 Pro', liveness: { state: 'live', source: self === 'm3' ? 'self' : 'direct', evidenceAgeMs: 1000 }, loadVerdict: 'ok' },
    ] });
    const a = summarizeMachines(pool('m1'), null);
    const b = summarizeMachines(pool('m2'), null);
    for (const r of [a, b]) {
      expect(JSON.stringify(r.machines.map((m) => [m.statusLine, m.evidenceLine]))).not.toMatch(/this machine|this one/i);
    }
    expect(a.machines.map((m) => m.statusLine)).toEqual(b.machines.map((m) => m.statusLine));
    expect(a.machines.find((m) => m.name === 'Laptop')).toMatchObject({ statusLine: 'Live · load normal', evidenceLine: 'Checked 3 s ago by Mac Studio. Mac M5 Pro reached it 9 s ago.' });
    expect(a.machines.find((m) => m.name === 'Mac Studio')).toMatchObject({ statusLine: 'Live · busy', evidenceLine: 'Answered the app directly.', leading: true });
    // The leading machine sorts first among equals, whichever machine answered.
    expect(b.machines[0].name).toBe('Mac Studio');
  });
  it('machineKey is pinned: the iPhone app recomputes it to open Remote Desktop on the chosen machine', () => {
    // apps/instar-ios OpsDataTests.testDesktopPreferenceMatchesTheMachinesRowKey pins the same value.
    expect(machineKey('m_abc')).toBe('8a03f2e055f543da');
  });
  it('evidenceLine is null without a liveness block, and names no unverified observer', () => {
    expect(evidenceLine({}, 'Studio', () => null)).toBeNull();
    expect(evidenceLine({ liveness: { source: 'direct', evidenceAgeMs: 120_000, peerSighting: { observerMachineId: 'mx', ageMs: 1 } } }, null, () => null))
      .toBe('Checked 2 min ago by the machine the app reached.');
    expect(evidenceLine({ liveness: { source: 'none' } }, 'Studio', () => null)).toBe('No contact on record yet.');
  });
  it('without liveness, online is an estimate; an unverified nickname is not shown', () => {
    const r = summarizeMachines({ selfMachineId: 'm1', machines: [
      { machineId: 'm1', nickname: 'Studio', online: true },
      { machineId: 'm2', nickname: 'm2', online: false },
    ] }, null);
    const m2 = r.machines.find((m) => !m.isSelf)!;
    expect(m2).toMatchObject({ name: 'A machine with no name yet', state: 'stale' });
    expect(m2.statusLine).toContain('estimated');
    expect(JSON.stringify(r)).not.toContain('m2');
    expect(r.headline).toContain("can't see");
  });
});

describe('ownerOrBearer', () => {
  const req = (principal?: unknown, person?: unknown) => ({ instarPrincipal: principal, instarDevicePerson: person } as unknown as Request);
  const yes = () => true; const no = () => false;
  it('the bearer token passes only when it is checked; owner phones pass', () => {
    expect(ownerOrBearer(req(), yes)).toBe(true);
    expect(ownerOrBearer(req({ kind: 'token' }), yes)).toBe(true);
    expect(ownerOrBearer(req({ kind: 'device', deviceId: 'd' }, { ok: true, role: 'owner', name: 'J' }), no)).toBe(true);
  });
  it('a missing principal without the bearer token fails closed', () => {
    expect(ownerOrBearer(req(), no)).toBe(false);
    expect(ownerOrBearer(req({ kind: 'token' }), no)).toBe(false);
  });
  it('MSP phones, unresolved people and the notify token are refused', () => {
    expect(ownerOrBearer(req({ kind: 'device', deviceId: 'd' }, { ok: true, role: 'msp', name: 'J' }), yes)).toBe(false);
    expect(ownerOrBearer(req({ kind: 'device', deviceId: 'd' }), yes)).toBe(false);
    expect(ownerOrBearer(req({ kind: 'device', deviceId: 'd' }, { ok: false, role: 'msp' }), yes)).toBe(false);
    expect(ownerOrBearer(req({ kind: 'device-notify', deviceId: 'd' }, { ok: true, role: 'owner' }), yes)).toBe(false);
  });
});

describe('words and allowlist', () => {
  it('scheduleWords and phoneText', () => {
    expect(scheduleWords('*/5 * * * *')).toBe('Every 5 minutes');
    expect(scheduleWords('30 9 * * 1-5')).toBe('Weekdays at 9:30 am');
    expect(scheduleWords('weird')).toBe('weird');
    expect(phoneText('  a\n b  ', 10)).toBe('a b');
    expect(phoneText('', 10)).toBeNull();
  });
  it('phoneText cuts long text before scrubbing, so one huge peer string cannot stall the server', () => {
    const started = Date.now();
    const out = phoneText('a-'.repeat(240_000), 120);
    expect(out!.length).toBeLessThanOrEqual(120);
    // Unbounded this took minutes; the cut makes it milliseconds, with room for a loaded machine.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it('exactly three new read-only device entries; the raw Bearer routes are not allowlisted', () => {
    for (const p of ['/mobile/jobs', '/mobile/commitments', '/mobile/machines']) {
      const rules = DEVICE_ALLOWLIST.filter((x) => x.re.test(p));
      expect(rules.map((x) => x.method)).toEqual(['GET']);
    }
    for (const p of ['/jobs', '/commitments', '/pool', '/machines', '/systems/status', '/guards']) expect(DEVICE_ALLOWLIST.some((x) => x.re.test(p)), p).toBe(false);
  });
});

describe('Agent Awareness + Migration Parity', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { PostUpdateMigrator, MOBILE_OPS_SCREENS_MARKER, MOBILE_ROUTES_CLAUDEMD_SECTION, MOBILE_OPS_SCREENS_LINE } = await import('../../src/core/PostUpdateMigrator.js');
  const { generateClaudeMd } = await import('../../src/scaffold/templates.js');
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const count = (s: string) => s.split(MOBILE_OPS_SCREENS_MARKER).length - 1;

  it('new agents get the line once', () => {
    expect(count(generateClaudeMd('test', 'Test', 4042, false))).toBe(1);
  });

  it('an existing Mobile app routes block gets the line once, after the route-list bullet; idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mops-md-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const file = path.join(dir, 'CLAUDE.md');
    const oldBlock = MOBILE_ROUTES_CLAUDEMD_SECTION(4042).split('\n').filter((l) => !l.includes(MOBILE_OPS_SCREENS_MARKER)).join('\n');
    fs.writeFileSync(file, `# CLAUDE.md\n${oldBlock}`);
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
    expect(run().upgraded).toContain('CLAUDE.md: added the native Schedule, Promises and Machines line');
    run();
    const after = fs.readFileSync(file, 'utf8');
    expect(count(after)).toBe(1);
    const lines = after.split('\n');
    const at = lines.indexOf(MOBILE_OPS_SCREENS_LINE(4042));
    expect(lines[at - 1]).toMatch(/^- The app reads its route list from/);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-native-ops-screens.test.ts' });
  });
});
