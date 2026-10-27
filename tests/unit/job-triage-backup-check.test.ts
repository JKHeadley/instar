// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** JobTriageBackupCheck (job-cost-reduction §5.6.3, §12 "The backup check"). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { JobTriageBackupCheck, parseBackupAnswer, selectBackupBatch } from '../../src/scheduler/JobTriageBackupCheck.js';
import { JobTriageStateStore, type RoutinePoolEntry } from '../../src/scheduler/JobTriageStateStore.js';
import type { IntelligenceProvider, JobDefinition } from '../../src/core/types.js';
import type { ScriptTriageConfig } from '../../src/scheduler/JobResultTriage.js';

const job = (slug = 'health-check', cls = 'triage') => ({ slug, name: slug, description: '', scriptSupervision: cls } as unknown as JobDefinition);

function entry(i: number, over: Partial<RoutinePoolEntry> = {}): RoutinePoolEntry {
  return { runId: `r${i}`, finishedAt: new Date(Date.UTC(2026, 9, 26, 6, i)).toISOString(), fp: `fp${i}`, priority: false, evidence: `evidence ${i} ${'z'.repeat(2000)}`, ...over };
}

function harness(dir: string, o: { reply?: (prompt: string) => Promise<string>; provider?: boolean; cfg?: ScriptTriageConfig; now?: () => number; jevAvailable?: () => boolean; tryAcquireBackup?: () => boolean; releaseBackup?: () => void } = {}) {
  const prompts: string[] = [];
  const sessions: string[] = [];
  const attention: string[] = [];
  const state = new JobTriageStateStore({ file: path.join(dir, 'state.json') });
  const provider: IntelligenceProvider = { evaluate: async (p) => { prompts.push(p); return (o.reply ?? (async () => '{}'))(p); } };
  const check = new JobTriageBackupCheck({
    getConfig: () => o.cfg ?? { enabled: true },
    jevAvailable: o.jevAvailable ?? (() => false),
    tryAcquireBackup: o.tryAcquireBackup ?? (() => true),
    releaseBackup: o.releaseBackup ?? (() => {}),
    state,
    provider: o.provider === false ? null : provider,
    listTriageJobs: () => [job(), job('mentor-onboarding', 'deterministic')],
    machineId: 'm-1',
    requestSession: async (_j, e) => { sessions.push(e.runId); return 'spawned'; },
    raiseAttention: (i) => attention.push(i.conditionKey),
    auditPath: path.join(dir, 'logs', 'job-triage.jsonl'),
    now: o.now,
  });
  return { check, state, prompts, sessions, attention };
}

const answerAll = (v: boolean, flag?: string) => async (prompt: string) => {
  const ids = JSON.parse(prompt.slice(prompt.lastIndexOf('['), prompt.lastIndexOf(']') + 1)) as string[];
  return JSON.stringify(Object.fromEntries(ids.map((id) => [id, flag ? id === flag : v])));
};

describe('JobTriageBackupCheck', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-backup-check-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/job-triage-backup-check.test.ts' }); });

  it('selection: at most 12, priority first, then oldest unseen; records unread', () => {
    const pool = Array.from({ length: 20 }, (_, i) => entry(i, { priority: i === 15 }));
    const { batch, considered } = selectBackupBatch(pool, undefined);
    expect(batch).toHaveLength(12);
    expect(batch[0].runId).toBe('r15');
    expect(batch[1].runId).toBe('r0');
    expect(considered).toHaveLength(20);
    expect(selectBackupBatch(pool, entry(17).finishedAt).considered.map((e) => e.runId)).toEqual(['r18', 'r19']);
  });

  it('strict parse: exactly the given ids with boolean values, else null', () => {
    expect(parseBackupAnswer('{"a":true,"b":false}', ['a', 'b'])).toEqual({ a: true, b: false });
    expect(parseBackupAnswer('{"a":true}', ['a', 'b'])).toBeNull();
    expect(parseBackupAnswer('{"a":true,"b":"no"}', ['a', 'b'])).toBeNull();
    expect(parseBackupAnswer('{"a":true,"b":false,"c":true}', ['a', 'b'])).toBeNull();
    expect(parseBackupAnswer('sure!', ['a'])).toBeNull();
  });

  it('runs at most every 6 h during a Jev outage; reads only triage-class slugs; each evidence clamped to 1,000 chars', async () => {
    let t = Date.parse('2026-10-26T12:00:00Z');
    let jevAvailable = true;
    const h = harness(dir, { reply: answerAll(false), now: () => t, jevAvailable: () => jevAvailable });
    h.state.update((s) => { s.backup.routine['health-check'] = [entry(1), entry(2)]; s.backup.routine['mentor-onboarding'] = [entry(3)]; s.backup.seen['health-check'] = 40; });
    expect(await h.check.tick()).toBeNull();
    expect((await h.check.runPass()).reason).toBe('jev-available');
    expect(h.prompts).toHaveLength(0);
    jevAvailable = false;
    const r1 = await h.check.tick();
    expect(r1?.ran).toBe(true);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).not.toContain('evidence 3');
    expect(h.prompts[0]).not.toContain('z'.repeat(1001));
    expect(r1!.slugs['health-check']).toMatchObject({ considered: 40, read: 2, unread: 0, outcome: 'ok' });
    t += 60 * 60_000;
    expect(await h.check.tick()).toBeNull();
    t += 6 * 60 * 60_000;
    h.state.update((s) => { s.backup.routine['health-check'] = [entry(30)]; });
    expect((await h.check.tick())?.ran).toBe(true);
    expect(h.prompts).toHaveLength(2);
    jevAvailable = true;
    t += 6 * 60 * 60_000;
    expect(await h.check.tick()).toBeNull();
    expect(h.prompts).toHaveLength(2);
  });

  it('disabled triage makes no call', async () => {
    const h = harness(dir, { cfg: { enabled: false }, reply: answerAll(false) });
    h.state.update((s) => { s.backup.routine['health-check'] = [entry(1)]; });
    expect(await h.check.tick()).toBeNull();
    expect(h.prompts).toHaveLength(0);
  });

  it('owns the outage lane only during the backup pass', async () => {
    const changes: boolean[] = [];
    const h = harness(dir, { reply: answerAll(false), tryAcquireBackup: () => { changes.push(true); return true; }, releaseBackup: () => changes.push(false) });
    h.state.update(s => { s.backup.routine['health-check'] = [entry(1)]; });
    await h.check.runPass();
    expect(changes).toEqual([true, false]);
  });

  it('does not start a replacement pass when Jev owns an in-flight request', async () => {
    const h = harness(dir, { reply: answerAll(false), tryAcquireBackup: () => false });
    h.state.update(s => { s.backup.routine['health-check'] = [entry(1)]; });
    expect(await h.check.runPass()).toMatchObject({ ran: false, reason: 'jev-in-flight' });
    expect(h.prompts).toHaveLength(0);
    expect(h.state.snapshot().backup.lastPassAt).toBeUndefined();
  });

  it('an empty outage poll leaves the cadence open for the first later run', async () => {
    let t = Date.parse('2026-10-26T12:00:00Z');
    const h = harness(dir, { reply: answerAll(false), now: () => t });
    expect((await h.check.tick())?.reason).toBe('nothing-new');
    expect(h.state.snapshot().backup.lastPassAt).toBeUndefined();
    t += 60_000;
    h.state.update(s => { s.backup.routine['health-check'] = [entry(1)]; });
    expect((await h.check.tick())?.slugs['health-check'].read).toBe(1);
    expect(h.state.snapshot().backup.lastPassAt).toBe(new Date(t).toISOString());
  });

  it('does not call the replacement if Jev recovers between the tick and a slug', async () => {
    let checks = 0;
    const h = harness(dir, { reply: answerAll(false), jevAvailable: () => ++checks >= 3 });
    h.state.update(s => { s.backup.routine['health-check'] = [entry(1)]; });
    expect((await h.check.tick())?.reason).toBe('jev-recovered');
    expect(h.prompts).toHaveLength(0);
    expect(h.state.snapshot().backup.lastPassAt).toBeUndefined();
  });

  it('a strict-parse failure is backup-failed and the same ids are retried; two failures in a row raise one item', async () => {
    const replies = ['not json', 'still not'];
    const h = harness(dir, { reply: async (p) => replies.shift() ?? (await answerAll(false)(p)) });
    h.state.update((s) => { s.backup.routine['health-check'] = Array.from({ length: 14 }, (_, i) => entry(i)); });
    const r1 = await h.check.runPass();
    expect(r1.slugs['health-check'].outcome).toBe('backup-failed');
    const ids1 = h.state.snapshot().backup.pending['health-check'];
    expect(ids1).toHaveLength(12);
    expect(h.attention).toHaveLength(0);
    await h.check.runPass();
    expect(h.attention).toEqual(['job-triage-backup:m-1']);
    const r3 = await h.check.runPass();
    expect(r3.slugs['health-check'].outcome).toBe('ok');
    // the retried pass read the previously pending ids
    const ids3 = JSON.parse(h.prompts[2].slice(h.prompts[2].lastIndexOf('['), h.prompts[2].lastIndexOf(']') + 1));
    expect(ids3).toEqual(ids1);
    expect(h.state.snapshot().backup.consecutiveFailures).toBe(0);
    expect(h.state.snapshot().backup.pending['health-check']).toBeUndefined();
  });

  it('a disagreement starts a bounded session and logs backup-disagrees', async () => {
    const h = harness(dir, { reply: answerAll(false, 'r2') });
    h.state.update((s) => { s.backup.routine['health-check'] = [entry(1), entry(2)]; });
    const r = await h.check.runPass();
    expect(h.sessions).toEqual(['r2']);
    expect(r.slugs['health-check'].disagreements).toBe(1);
    await h.check.flush();
    const rows = fs.readFileSync(path.join(dir, 'logs', 'job-triage.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.find((x) => x.note === 'backup-disagrees')).toMatchObject({ runId: 'r2', decider: 'backup', action: 'spawned' });
    expect(JSON.stringify(rows)).not.toContain('evidence 2');
  });

  it('with no provider the pass records it and the runs stay unread', async () => {
    const h = harness(dir, { provider: false });
    h.state.update((s) => { s.backup.routine['health-check'] = [entry(1)]; });
    const r = await h.check.runPass();
    expect(r.slugs['health-check']).toMatchObject({ outcome: 'no-provider', unread: 1 });
  });
});
