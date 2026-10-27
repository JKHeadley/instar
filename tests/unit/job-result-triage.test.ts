// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * JobResultTriage (job-cost-reduction §5.6.2, §12 "Triage (JobResultTriage)").
 * Jev is faked through an injected fetch; the
 * scheduler is a fake port that records spawnProjectedSession calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  JobResultTriage, evaluateFloor, triageEvidenceFor, isBareRun, reasonSetOf, buildScriptTriageConfigGetter,
  buildTriageProviders, readTriageAudit, TRIAGE_TOOLS, type ScriptTriageConfig, type TriageSchedulerPort, type ProjectedSessionEnd,
} from '../../src/scheduler/JobResultTriage.js';
import { JobTriageStateStore } from '../../src/scheduler/JobTriageStateStore.js';
import { JobTriageBackupCheck } from '../../src/scheduler/JobTriageBackupCheck.js';
import type { ScriptRunContext } from '../../src/scheduler/scriptRunObservers.js';
import type { ParsedScriptRun, ParsedAnomaly } from '../../src/scheduler/jobScriptProtocol.js';
import type { JobRun } from '../../src/scheduler/JobRunHistory.js';
import type { IntelligenceProvider, JobDefinition } from '../../src/core/types.js';

const MACHINE = 'm-1';

function job(over: Partial<Record<string, unknown>> = {}): JobDefinition {
  return {
    slug: 'health-check', name: 'Health check', description: 'Checks the server', schedule: '*/5 * * * *',
    priority: 'high', expectedDurationMinutes: 5, model: 'haiku', enabled: true, execute: { type: 'agentmd' },
    scriptSupervision: 'triage', triageEvidence: 'full', triageBareOk: ['healthy'], triageBareSkipped: ['feature-dark'],
    body: 'Run the health check and report.', ...over,
  } as unknown as JobDefinition;
}

function parsed(over: Partial<ParsedScriptRun> = {}): ParsedScriptRun {
  return { result: 'success', reason: '', reasonCode: '', summary: 'healthy', anomalies: [], ignoredAnomalies: 0, fields: {}, droppedFields: 0, missingResultLine: false, overCap: false, ...over };
}

let runSeq = 0;
function ctx(over: Partial<ScriptRunContext> & { p?: Partial<ParsedScriptRun>; j?: JobDefinition } = {}): ScriptRunContext {
  const { p, j, ...rest } = over;
  runSeq++;
  return {
    job: j ?? job(), runId: `run-${runSeq}`, machineId: MACHINE, parsed: parsed(p), scrubbedOutput: 'some output line\nmore output',
    startedAt: '2026-10-26T10:00:00.000Z', finishedAt: new Date(Date.UTC(2026, 9, 26, 10, 0, runSeq)).toISOString(), canary: false, lockTrust: 'trusted', ...rest,
  };
}

const crit: ParsedAnomaly = { kind: 'disk-critical', severity: 3, evidence: 'disk 2% free', class: 'critical' };
const recov: ParsedAnomaly = { kind: 'disk-low', severity: 2, evidence: 'disk 8% free', class: 'recoverable' };

function jevReply(pNeeds: number, label?: string, labelRev?: string, model = 'jev-1.13.0') {
  const l = label ?? (pNeeds >= 0.5 ? 'needs_session' : 'routine');
  return {
    model, usage: { input_tokens: 500 },
    answers: {
      triage: { choice: l, probabilities: { needs_session: pNeeds, routine: 1 - pNeeds } },
      triage_rev: { choice: labelRev ?? l, probabilities: { needs_session: pNeeds, routine: 1 - pNeeds } },
    },
  };
}

interface Harness {
  triage: JobResultTriage;
  spawns: Array<{ job: JobDefinition; opts: Parameters<TriageSchedulerPort['spawnProjectedSession']>[1] }>;
  jevBodies: Array<{ state: string; model: string }>;
  attention: Array<{ conditionKey: string; body: string }>;
  metrics: Array<Record<string, unknown>>;
  runs: JobRun[];
  end: (ev: ProjectedSessionEnd) => void;
  state: JobTriageStateStore;
  setJev: (fn: () => Promise<Response> | Response) => void;
  cfg: ScriptTriageConfig;
  clock: { t: number };
}

function makeHarness(dir: string, o: { cfg?: ScriptTriageConfig; key?: string | null; apiKey?: boolean; admission?: () => string | null; pool?: () => Promise<boolean | null>; singleMachine?: boolean; episode?: (c: ScriptRunContext) => string | undefined; random?: () => number } = {}): Harness {
  const spawns: Harness['spawns'] = [];
  const jevBodies: Harness['jevBodies'] = [];
  const attention: Harness['attention'] = [];
  const metrics: Harness['metrics'] = [];
  const runs: JobRun[] = [];
  let listener: ((ev: ProjectedSessionEnd) => void) | null = null;
  let jevFn: () => Promise<Response> | Response = () => new Response(JSON.stringify(jevReply(0.05)), { status: 200 });
  let spawnSeq = 0;
  const cfg: ScriptTriageConfig = o.cfg ?? { enabled: true, jev: { enabled: true } };
  const clock = { t: Date.parse('2026-10-26T12:00:00.000Z') };
  const scheduler: TriageSchedulerPort = {
    getLocalRunsForSlug: () => runs,
    listScriptJobs: () => [job()],
    spawnProjectedSession: (j, opts) => { spawns.push({ job: j, opts }); return { sessionName: `triage-${j.slug}-${++spawnSeq}` }; },
    addProjectedSessionListener: (l) => { listener = l; },
  };
  const state = new JobTriageStateStore({ file: path.join(dir, 'state', 'job-triage-state.json') });
  const triage = new JobResultTriage({
    getConfig: () => cfg,
    scheduler,
    state,
    machineId: MACHINE,
    isSingleMachine: () => o.singleMachine ?? false,
    readKey: () => (o.key === undefined ? 'ts-key' : o.key),
    auditPath: path.join(dir, 'logs', 'job-triage.jsonl'),
    raiseAttention: (item) => attention.push({ conditionKey: item.conditionKey, body: item.body }),
    admissionCheck: o.admission,
    poolCooldownCheck: o.pool,
    anthropicApiKeyPresent: () => o.apiKey === true,
    episodeIdFor: o.episode,
    metrics: { record: (r) => metrics.push(r) },
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body ?? '{}'));
      jevBodies.push({ state: b.state, model: b.model });
      return jevFn();
    }) as unknown as typeof fetch,
    now: () => clock.t,
    random: o.random ?? (() => 0.99),
  });
  return {
    triage, spawns, jevBodies, attention, metrics, runs, state, cfg, clock,
    end: (ev) => listener?.(ev),
    setJev: (fn) => { jevFn = fn; },
  };
}

async function feed(h: Harness, c: ScriptRunContext): Promise<void> {
  h.triage.onScriptRunCompleted(c);
  await h.triage.whenIdle();
}

function failedRow(runId: string, machineId: string | undefined = MACHINE, extra: Record<string, unknown> = {}): JobRun {
  return { runId, slug: 'health-check', sessionId: '', trigger: 'scheduled', startedAt: '2026-10-26T09:00:00Z', result: 'failure', ...(machineId ? { machineId } : {}), ...extra } as JobRun;
}
function okRow(runId: string): JobRun {
  return { runId, slug: 'health-check', sessionId: '', trigger: 'scheduled', startedAt: '2026-10-26T09:00:00Z', result: 'success', machineId: MACHINE } as JobRun;
}

describe('JobResultTriage', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-job-triage-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-result-triage.test.ts' }); });

  it('exposes Jev outage and recovery so the slower model runs only as a replacement', async () => {
    const h = makeHarness(dir);
    expect(h.triage.isJevAvailable()).toBe(true);
    h.setJev(() => new Response('', { status: 503 }));
    await feed(h, ctx({ p: { summary: 'needs review' } }));
    expect(h.triage.isJevAvailable()).toBe(false);
    h.setJev(() => new Response(JSON.stringify(jevReply(0.05)), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'reviewed result' }, scrubbedOutput: 'different output' }));
    expect(h.triage.isJevAvailable()).toBe(true);
    expect(makeHarness(dir, { key: null }).triage.isJevAvailable()).toBe(false);
  });

  it('does not start outage backup while a Jev recovery request is unresolved', async () => {
    const h = makeHarness(dir);
    h.setJev(() => new Response('', { status: 503 }));
    await feed(h, ctx({ p: { summary: 'outage result' } }));
    expect(h.triage.isJevAvailable()).toBe(false);
    let finishRecovery: ((response: Response) => void) | undefined;
    h.setJev(() => new Promise<Response>(resolve => { finishRecovery = resolve; }));
    h.triage.onScriptRunCompleted(ctx({ p: { summary: 'recovery result' }, scrubbedOutput: 'distinct recovery evidence' }));
    for (let i = 0; i < 20 && !finishRecovery; i++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(finishRecovery).toBeTypeOf('function');
    let backupCalls = 0;
    const backup = new JobTriageBackupCheck({
      getConfig: () => h.cfg,
      jevAvailable: () => h.triage.isJevAvailable(),
      tryAcquireBackup: () => h.triage.tryAcquireBackup(),
      releaseBackup: () => h.triage.releaseBackup(),
      state: h.state,
      provider: { evaluate: async () => { backupCalls++; return '{}'; } },
      listTriageJobs: () => [job()],
      machineId: MACHINE,
      requestSession: async () => 'spawned',
      auditPath: path.join(dir, 'logs', 'backup.jsonl'),
      now: () => h.clock.t,
    });
    expect(await backup.tick()).toMatchObject({ ran: false, reason: 'jev-in-flight' });
    expect(backupCalls).toBe(0);
    finishRecovery!(new Response(JSON.stringify(jevReply(0.05)), { status: 200 }));
    await h.triage.whenIdle();
    expect(h.triage.isJevAvailable()).toBe(true);
    expect(await backup.tick()).toBeNull();
  });

  it('stores only routine decisions made during a Jev outage for replacement review', async () => {
    const h = makeHarness(dir);
    const healthy = ctx({ p: { summary: 'inspect status' }, scrubbedOutput: 'healthy-jev-evidence' });
    await feed(h, healthy);
    expect(h.state.snapshot().backup.routine['health-check']).toBeUndefined();
    h.setJev(() => new Response('', { status: 503 }));
    const outage = ctx({ p: { summary: 'unusual status' }, scrubbedOutput: 'outage-evidence' });
    await feed(h, outage);
    expect(h.state.snapshot().backup.routine['health-check']?.map(e => e.runId)).toEqual([outage.runId]);
    await feed(h, ctx({ p: { summary: 'healthy' }, scrubbedOutput: 'bare-evidence' }));
    expect(h.state.snapshot().backup.routine['health-check']?.map(e => e.runId)).toEqual([outage.runId]);
  });

  // ── pure pieces ───────────────────────────────────────────────

  describe('floor (both sides)', () => {
    it('a critical anomaly ⇒ needs_session; a recoverable one ⇒ routine', () => {
      expect(evaluateFloor(ctx({ p: { anomalies: [crit] } }), [], { singleMachine: false }).needsSession).toBe(true);
      expect(evaluateFloor(ctx({ p: { anomalies: [recov] } }), [], { singleMachine: false }).needsSession).toBe(false);
    });
    it('a second consecutive local failure ⇒ needs_session; a first failure ⇒ routine', () => {
      const c = ctx({ p: { result: 'failure', reasonCode: 'timeout' } });
      expect(evaluateFloor(c, [failedRow(c.runId), okRow('prev')], { singleMachine: false }).needsSession).toBe(false);
      expect(evaluateFloor(c, [failedRow(c.runId), failedRow('prev')], { singleMachine: false }).needsSession).toBe(true);
    });
    it('skips skipped, script-canary and origin:triage rows when finding the previous run', () => {
      const c = ctx({ p: { result: 'failure' } });
      const rows = [
        { ...okRow('s'), result: 'skipped' } as unknown as JobRun,
        { ...okRow('c'), trigger: 'script-canary' } as JobRun,
        { ...okRow('t'), origin: 'triage' } as unknown as JobRun,
        failedRow('prev'),
      ];
      expect(evaluateFloor(c, rows, { singleMachine: false }).needsSession).toBe(true);
    });
    it('the streak is this machine\'s own rows (a standby fixture): another machine\'s failure does not count', () => {
      const c = ctx({ p: { result: 'failure' } });
      expect(evaluateFloor(c, [failedRow('other', 'm-2'), okRow('mine')], { singleMachine: false }).needsSession).toBe(false);
      // a row without machineId counts only on a single-machine agent
      expect(evaluateFloor(c, [failedRow('legacy', '')], { singleMachine: false }).needsSession).toBe(false);
      expect(evaluateFloor(c, [failedRow('legacy', '')], { singleMachine: true }).needsSession).toBe(true);
    });
  });

  it('bare-ok and bare-skipped are recognised; any anomaly or other summary is not bare', () => {
    expect(isBareRun(ctx())).toBe('bare-ok');
    expect(isBareRun(ctx({ p: { result: 'skipped', reasonCode: 'feature-dark', summary: 'feature-dark' } }))).toBe('bare-skipped');
    expect(isBareRun(ctx({ p: { anomalies: [recov] } }))).toBeNull();
    expect(isBareRun(ctx({ p: { summary: 'healthy but slow' } }))).toBeNull();
  });

  it('reason set: sorted anomaly ids, else failure:<reason>', () => {
    expect(reasonSetOf(ctx({ p: { anomalies: [recov, crit] } }))).toBe('disk-critical,disk-low');
    expect(reasonSetOf(ctx({ p: { result: 'failure', reasonCode: 'unreachable' } }))).toBe('failure:unreachable');
  });

  it('the evidence is scrubbed then clamped; structured-only never carries free text', () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const full = triageEvidenceFor(ctx({ scrubbedOutput: `${'x'.repeat(5000)} token ${secret} end` }))!;
    expect(full.text).not.toContain(secret);
    expect(Array.from(full.text).length).toBeLessThanOrEqual(2000);
    expect(full.text.endsWith('end')).toBe(true); // the TAIL is kept
    const so = triageEvidenceFor(ctx({
      j: job({ slug: 'feedback-factory-triage', triageEvidence: 'structured-only', triageFields: ['count'] }),
      p: { result: 'failure', reasonCode: 'authority-lapsed', reason: 'authority-lapsed user wrote: PRIVATE TEXT', fields: { count: '3', secretField: 'nope' } },
      scrubbedOutput: 'fleet user report text PRIVATE TEXT',
    }))!;
    expect(so.structuredOnly).toBe(true);
    expect(so.text).not.toContain('PRIVATE TEXT');
    expect(so.text).toContain('field count: 3');
    expect(so.text).not.toContain('secretField');
    expect(so.text).toContain('reasonCode: authority-lapsed');
  });

  // ── routing ───────────────────────────────────────────────────

  it('deterministic-class jobs and canary runs are never triaged; script-untrusted never starts a session', async () => {
    const h = makeHarness(dir);
    await feed(h, ctx({ j: job({ scriptSupervision: 'deterministic' }), p: { anomalies: [crit] } }));
    await feed(h, ctx({ canary: true, p: { anomalies: [crit] } }));
    h.runs.push(failedRow('prev'));
    for (let i = 0; i < 3; i++) await feed(h, ctx({ p: { result: 'failure', reasonCode: 'script-untrusted' } }));
    expect(h.spawns).toHaveLength(0);
    expect(h.jevBodies).toHaveLength(0);
    expect(readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl'))).toHaveLength(0);
  });

  it('bare-ok runs are never sent', async () => {
    const h = makeHarness(dir);
    await feed(h, ctx());
    expect(h.jevBodies).toHaveLength(0);
    const rows = readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl'));
    expect(rows[0]).toMatchObject({ decider: 'bare', decision: 'routine' });
  });

  it('jobs.scriptTriage.enabled:false makes no call of any kind', async () => {
    const h = makeHarness(dir, { cfg: { enabled: false, jev: { enabled: true } } });
    h.runs.push(failedRow('prev'));
    await feed(h, ctx({ p: { result: 'failure', anomalies: [crit] } }));
    await feed(h, ctx({ p: { summary: 'odd' } }));
    expect(h.jevBodies).toHaveLength(0);
    expect(h.spawns).toHaveLength(0);
    expect(await h.triage.requestHealAttempt({ episodeId: 'e1', slug: 'health-check' })).toBe('disabled');
  });

  it('a confident Jev routine is taken; a confident needs_session is taken', async () => {
    const h = makeHarness(dir);
    h.setJev(() => new Response(JSON.stringify(jevReply(0.05)), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'healthy, 3 sessions' } }));
    expect(h.spawns).toHaveLength(0);
    h.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'healthy, 9 zombie sessions' } }));
    expect(h.spawns).toHaveLength(1);
    const rows = readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl'));
    expect(rows.map((r) => r.decider)).toEqual(['jev', 'jev']);
    expect(h.metrics[0]).toMatchObject({ feature: 'job-result-triage', framework: 'typesafe-api' });
  });

  it('an unsure Jev answer starts a bounded investigator without calling a second model', async () => {
    const h = makeHarness(dir);
    h.setJev(() => new Response(JSON.stringify(jevReply(0.5)), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'a' } }));
    expect(h.spawns).toHaveLength(1);
    h.setJev(() => new Response(JSON.stringify(jevReply(0.1, 'cannot_tell')), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'b' } }));
    h.setJev(() => new Response(JSON.stringify(jevReply(0.1, 'routine', 'needs_session')), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'c' } }));
    const rows = readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl'));
    expect(rows.slice(-2).map((r) => r.escalation)).toEqual(['cannot_tell', 'order-disagreement']);
    expect(rows.map((r) => r.decision)).toEqual(['needs_session', 'needs_session', 'needs_session']);
    expect(rows.map((r) => r.decider)).toEqual(['jev', 'jev', 'jev']);
  });

  it('served-model mismatch, HTTP error, timeout, no key and the daily cap fall to the floor', async () => {
    const cases: Array<[string, (h: Harness) => void, Record<string, unknown>]> = [
      ['model-mismatch', (h) => h.setJev(() => new Response(JSON.stringify(jevReply(0.95, undefined, undefined, 'jev-2')), { status: 200 })), {}],
      ['http-error', (h) => h.setJev(() => new Response('no', { status: 500 })), {}],
      ['timeout', (h) => h.setJev(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }), {}],
    ];
    for (const [reason, setup] of cases) {
      const h = makeHarness(fs.mkdtempSync(path.join(dir, 'c-')));
      setup(h);
      await feed(h, ctx({ p: { summary: 'odd' } }));
      expect(h.spawns, reason).toHaveLength(0);
    }
    const noKey = makeHarness(fs.mkdtempSync(path.join(dir, 'k-')), { key: null });
    await feed(noKey, ctx({ p: { summary: 'odd' } }));
    expect(noKey.jevBodies).toHaveLength(0);
    // the floor still decides with no Jev: second failure ⇒ session
    noKey.runs.push(failedRow('prev'));
    await feed(noKey, ctx({ p: { result: 'failure', reasonCode: 'x' } }));
    expect(noKey.spawns).toHaveLength(1);

    const cap = makeHarness(fs.mkdtempSync(path.join(dir, 'cap-')), { cfg: { enabled: true, jev: { enabled: true, maxChecksPerDay: 1 } } });
    cap.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(cap, ctx({ p: { summary: 'a' } }));
    await feed(cap, ctx({ p: { summary: 'b' } }));
    expect(cap.jevBodies).toHaveLength(1);
    const rows = readTriageAudit(path.join(cap.state.file, '..', '..', 'logs', 'job-triage.jsonl'));
    expect(rows.at(-1)).toMatchObject({ jev: 'daily-cap', decider: 'floor' });
  });

  it('the Jev daily cap survives a restart (seeded from audit rows)', async () => {
    const cfg = { enabled: true, jev: { enabled: true, maxChecksPerDay: 1 } };
    const h1 = makeHarness(dir, { cfg });
    await feed(h1, ctx({ p: { summary: 'a' } }));
    const h2 = makeHarness(dir, { cfg });
    await feed(h2, ctx({ p: { summary: 'b' } }));
    expect(h2.jevBodies).toHaveLength(0);
  });

  it('does not call Jev while the outage backup owns the decision lane', async () => {
    const h = makeHarness(dir);
    expect(h.triage.tryAcquireBackup()).toBe(true);
    await feed(h, ctx({ p: { summary: 'unusual during outage' } }));
    expect(h.jevBodies).toHaveLength(0);
    expect(readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl')).at(-1))
      .toMatchObject({ jev: 'backup-owns-outage', decider: 'floor' });
    h.triage.releaseBackup();
    await feed(h, ctx({ p: { summary: 'unusual after outage' } }));
    expect(h.jevBodies).toHaveLength(1);
  });

  it('a confident Jev answer never calls a second model, even on an old audit sample', async () => {
    const h = makeHarness(dir, { random: () => 0.001 });
    h.setJev(() => new Response(JSON.stringify(jevReply(0.05)), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'a' } }));
    expect(h.spawns).toHaveLength(0);
    expect(readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl'))[0]).toMatchObject({ decider: 'jev', decision: 'routine' });
  });

  it('the floor is additive: a confident Jev routine with a critical anomaly or second failure still starts a session (Jev is not even asked)', async () => {
    const h = makeHarness(dir);
    h.setJev(() => new Response(JSON.stringify(jevReply(0.01)), { status: 200 }));
    await feed(h, ctx({ p: { anomalies: [crit] } }));
    expect(h.spawns).toHaveLength(1);
    expect(h.jevBodies).toHaveLength(0);
    const h2 = makeHarness(fs.mkdtempSync(path.join(dir, 'b-')));
    h2.setJev(() => new Response(JSON.stringify(jevReply(0.01)), { status: 200 }));
    h2.runs.push(failedRow('prev'));
    await feed(h2, ctx({ p: { result: 'failure', reasonCode: 'boom' } }));
    expect(h2.spawns).toHaveLength(1);
  });

  it('a repeated fingerprint reuses the cascade answer; identical output on a first and second failure still gives the second its session', async () => {
    const h = makeHarness(dir);
    h.setJev(() => new Response(JSON.stringify(jevReply(0.05)), { status: 200 }));
    const first = ctx({ p: { result: 'failure', reasonCode: 'boom' } });
    await feed(h, first);
    expect(h.jevBodies).toHaveLength(1);
    expect(h.spawns).toHaveLength(0);
    // a second identical (non-failure) output reuses the answer, no call
    await feed(h, ctx({ p: { summary: 'x' }, scrubbedOutput: 'other' }));
    await feed(h, ctx({ p: { summary: 'x' }, scrubbedOutput: 'other' }));
    expect(h.jevBodies).toHaveLength(2);
    expect(readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl')).at(-1)).toMatchObject({ decider: 'fingerprint-reuse' });
    // identical failure output, now second in a row ⇒ the floor still requires a session
    h.runs.push(failedRow(first.runId));
    await feed(h, ctx({ p: { result: 'failure', reasonCode: 'boom' } }));
    expect(h.spawns).toHaveLength(1);
  });

  it('a floor-required run is not displaced by a later healthy run in the queue', async () => {
    const h = makeHarness(dir, { admission: () => null });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // hold the pool check so the pending item is in flight while healthy runs arrive
    const h2 = makeHarness(fs.mkdtempSync(path.join(dir, 'p-')), { pool: async () => { await gate; return false; } });
    h2.runs.push(failedRow('prev'));
    h2.triage.onScriptRunCompleted(ctx({ p: { result: 'failure', reasonCode: 'boom' } }));
    h2.triage.onScriptRunCompleted(ctx());
    h2.triage.onScriptRunCompleted(ctx({ p: { summary: 'odd' } }));
    release();
    await h2.triage.whenIdle();
    expect(h2.spawns).toHaveLength(1);
    expect(h.spawns).toHaveLength(0);
  });

  // ── sessions ──────────────────────────────────────────────────

  it('needs_session spawns an agentmd projection: investigator prompt, fixed allowlist, triage:<slug>, omitAuthEnv, agent default model, bounded duration, no telegram', async () => {
    const h = makeHarness(dir);
    await feed(h, ctx({ p: { anomalies: [crit] }, j: job({ expectedDurationMinutes: 20 }) }));
    expect(h.spawns).toHaveLength(1);
    const { opts } = h.spawns[0];
    expect(opts.slugTag).toBe('triage:health-check');
    expect(opts.allowlist).toEqual([...TRIAGE_TOOLS]);
    expect(opts.confinedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(opts.allowlist).not.toBe('template');
    expect(opts.omitAuthEnv).toBe(true);
    expect(opts.modelOverride).toBe('agent-default');
    expect(opts.maxDurationMinutes).toBe(30);
    expect(opts.telegramNotify).toBe(false);
    expect(opts.origin).toBe('triage');
    expect(opts.trigger).toMatch(/^triage:run-/);
    expect(opts.prompt).toContain('Find out why this happened and fix what you can.');
    expect(opts.prompt).toContain('Do not re-run this job\'s trigger or call its endpoint.');
    expect(opts.prompt).toContain('<<<EVIDENCE');
    expect(opts.prompt).toContain('<<<JOB_BODY');
  });

  it('a structured-only slug\'s free text never reaches the session prompt or Jev', async () => {
    const h = makeHarness(dir);
    const j = job({ slug: 'feedback-factory-triage', triageEvidence: 'structured-only', triageFields: [], body: 'BODY SECRET TEXT' });
    h.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(h, ctx({ j, p: { summary: 'x', reason: 'user wrote FLEET TEXT' }, scrubbedOutput: 'FLEET TEXT' }));
    expect(h.jevBodies[0].state).not.toContain('FLEET TEXT');
    expect(h.spawns[0].opts.prompt).not.toContain('FLEET TEXT');
    expect(h.spawns[0].opts.prompt).not.toContain('BODY SECRET TEXT');
  });

  it('in-flight, cooldown and the daily caps each suppress; the cap raises one calm item per day', async () => {
    const h = makeHarness(dir, { cfg: { enabled: true, maxSessionsPerSlugPerDay: 2, jev: { enabled: true } } });
    await feed(h, ctx({ p: { anomalies: [crit] } }));
    await feed(h, ctx({ p: { anomalies: [crit] } })); // in flight
    expect(h.spawns).toHaveLength(1);
    h.end({ slugTag: 'triage:health-check', sessionName: 'triage-health-check-1', trigger: 'triage:x', output: 'fixed it' });
    // cooldown: same reason set; critical bypasses once per day
    await feed(h, ctx({ p: { anomalies: [crit] } }));
    expect(h.spawns).toHaveLength(2);
    h.end({ slugTag: 'triage:health-check', sessionName: 'triage-health-check-2', trigger: 'triage:x', output: 'again' });
    // per-slug cap (2) reached
    await feed(h, ctx({ p: { anomalies: [{ ...crit, kind: 'other-critical' }] } }));
    await feed(h, ctx({ p: { anomalies: [{ ...crit, kind: 'third-critical' }] } }));
    expect(h.spawns).toHaveLength(2);
    expect(h.attention.filter((a) => a.conditionKey === `job-triage-cap:${MACHINE}`)).toHaveLength(1);
    const actions = readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl')).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['spawned', 'suppressed-inflight', 'spawned:critical-bypass', 'suppressed-cap']));

    // a non-critical reason within its cooldown is suppressed
    const c = makeHarness(fs.mkdtempSync(path.join(dir, 'cd-')));
    c.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(c, ctx({ p: { summary: 's1', anomalies: [recov] } }));
    c.end({ slugTag: 'triage:health-check', sessionName: 'triage-health-check-1', trigger: 'triage:x', output: 'ok' });
    await feed(c, ctx({ p: { summary: 's2', anomalies: [recov] } }));
    expect(c.spawns).toHaveLength(1);
    expect(readTriageAudit(path.join(c.state.file, '..', '..', 'logs', 'job-triage.jsonl')).at(-1)).toMatchObject({ action: 'suppressed-cooldown' });
  });

  it('serializes simultaneous floor and backup admission against the machine daily cap', async () => {
    const h = makeHarness(dir, { cfg: { enabled: true, jev: { enabled: true }, maxSessionsPerDay: 1 }, pool: async () => false });
    h.triage.onScriptRunCompleted(ctx({ p: { anomalies: [crit] } }));
    const backup = h.triage.spawnForBackupEntry(job({ slug: 'other-check' }), { runId: 'backup-1', evidence: 'unusual result' });
    await Promise.all([h.triage.whenIdle(), backup]);
    expect(h.spawns).toHaveLength(1);
    expect(h.state.snapshot().daily.machine).toBe(1);
  });

  it('the daily cap and cooldown survive a restart (seeded from state)', async () => {
    const h1 = makeHarness(dir);
    h1.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(h1, ctx({ p: { summary: 's1', anomalies: [recov] } }));
    expect(h1.spawns).toHaveLength(1);
    const h2 = makeHarness(dir);
    h2.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(h2, ctx({ p: { summary: 's2', anomalies: [recov] } }));
    expect(h2.spawns).toHaveLength(0);
    expect(h2.state.snapshot().daily.machine).toBe(1);
  });

  it('the pool cooldown suppresses; a failing pool read falls back to the local check', async () => {
    const h = makeHarness(dir, { pool: async () => true });
    h.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(h, ctx({ p: { summary: 'x', anomalies: [recov] } }));
    expect(h.spawns).toHaveLength(0);
    const f = makeHarness(fs.mkdtempSync(path.join(dir, 'pf-')), { pool: async () => { throw new Error('peer down'); } });
    f.setJev(() => new Response(JSON.stringify(jevReply(0.95)), { status: 200 }));
    await feed(f, ctx({ p: { summary: 'x', anomalies: [recov] } }));
    expect(f.spawns).toHaveLength(1);
  });

  it('an env-token agent records refused:env-token-auth; admission refusals are logged and never queued', async () => {
    const h = makeHarness(dir, { apiKey: true });
    await feed(h, ctx({ p: { anomalies: [crit] } }));
    expect(h.spawns).toHaveLength(0);
    expect(readTriageAudit(path.join(dir, 'logs', 'job-triage.jsonl'))[0]).toMatchObject({ action: 'refused:env-token-auth', floor: true });
    const a = makeHarness(fs.mkdtempSync(path.join(dir, 'ad-')), { admission: () => 'quota' });
    await feed(a, ctx({ p: { anomalies: [crit] } }));
    expect(a.spawns).toHaveLength(0);
    expect(readTriageAudit(path.join(a.state.file, '..', '..', 'logs', 'job-triage.jsonl'))[0]).toMatchObject({ action: 'refused:quota' });
  });

  it('a persistent critical episode gets one triage session, not one per run after each session ends', async () => {
    const h = makeHarness(dir, { episode: () => 'ep-1' });
    for (let i = 0; i < 4; i++) {
      await feed(h, ctx({ p: { anomalies: [crit] } }));
      h.end({ slugTag: 'triage:health-check', sessionName: `triage-health-check-${h.spawns.length}`, trigger: 'triage:x', output: 'tried' });
    }
    expect(h.spawns).toHaveLength(1);
    // the heal attempt for the same episode counts the existing session
    expect(await h.triage.requestHealAttempt({ episodeId: 'ep-1', slug: 'health-check' })).toBe('ran');
    expect(h.spawns).toHaveLength(1);
  });

  it('requestHealAttempt: one session per episode, or its refusal named', async () => {
    const h = makeHarness(dir);
    let settled = false;
    const first = h.triage.requestHealAttempt({ episodeId: 'ep-9', slug: 'health-check', reasons: ['disk-low'] });
    void first.then(() => { settled = true; });
    await vi.waitFor(() => expect(h.spawns).toHaveLength(1));
    expect(settled).toBe(false); // a spawn is not a completed investigation
    h.end({ slugTag: 'triage:health-check', sessionName: 'triage-health-check-1', trigger: 'triage:heal:ep-9', output: 'investigated', result: 'success' });
    expect(await first).toBe('ran');
    expect(await h.triage.requestHealAttempt({ episodeId: 'ep-9', slug: 'health-check', reasons: ['disk-low'] })).toBe('ran');
    expect(h.spawns).toHaveLength(1);
    const r = makeHarness(fs.mkdtempSync(path.join(dir, 'h-')), { apiKey: true });
    expect(await r.triage.requestHealAttempt({ episodeId: 'ep-2', slug: 'health-check' })).toBe('refused:env-token-auth');
  });

  it('session end attaches the scrubbed, clamped output and raises one calm item; the audit row carries no output text', async () => {
    const h = makeHarness(dir);
    await feed(h, ctx({ p: { anomalies: [crit] } }));
    const secret = 'ghp_' + 'B'.repeat(36);
    h.end({ slugTag: 'triage:health-check', sessionName: 'triage-health-check-1', trigger: 'triage:run-x', output: `${'y'.repeat(3000)} ${secret} DONE` });
    await h.triage.whenIdle();
    const rec = h.state.snapshot().sessions[0];
    expect(rec.output).toBeDefined();
    expect(rec.output!).not.toContain(secret);
    expect(Array.from(rec.output!).length).toBeLessThanOrEqual(2000);
    expect(h.attention.find((a) => a.conditionKey === `job-triage:${MACHINE}:health-check`)).toBeDefined();
    const raw = fs.readFileSync(path.join(dir, 'logs', 'job-triage.jsonl'), 'utf-8');
    expect(raw).not.toContain('DONE');
    expect(raw).not.toContain('some output line');
    // in-flight is cleared
    expect(h.triage.inFlightCount()).toBe(0);
  });

  it('audit readiness keeps live Jev triage closed on dev and fleet even with saved opt-in', () => {
    const dev = buildScriptTriageConfigGetter({ readLiveJobs: () => ({ scriptTriage: { enabled: true } }), developmentAgent: true })();
    const fleet = buildScriptTriageConfigGetter({ readLiveJobs: () => ({ scriptTriage: {} }), developmentAgent: false })();
    const off = buildScriptTriageConfigGetter({ readLiveJobs: () => ({ scriptTriage: { jev: { enabled: false } } }), developmentAgent: true })();
    expect(dev.jev?.enabled).toBe(false);
    expect(dev.enabled).toBe(false);
    expect(fleet.jev?.enabled).toBe(false);
    expect(fleet.enabled).toBe(false);
    expect(off.jev?.enabled).toBe(false);
  });

  it('buildTriageProviders: Codex when available, else the default; only an outage backup is created', () => {
    const codex: IntelligenceProvider = { evaluate: async () => 'c' };
    const def: IntelligenceProvider = { evaluate: async () => 'd' };
    const a = buildTriageProviders({ codexProvider: codex, defaultProvider: def });
    expect(a.source).toBe('codex');
    expect(a.backup).not.toBeNull();
    expect(buildTriageProviders({ defaultProvider: def }).source).toBe('default');
    expect(buildTriageProviders({}).backup).toBeNull();
  });
});
