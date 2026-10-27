import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  ScriptJobSupervisor, parseSupervisionOutput, SUPERVISION_INPUT_CLAMP_CHARS,
  type PoolJobsView, type ScriptJobSupervisorDeps,
} from '../../src/scheduler/ScriptJobSupervisor.js';
import { createScriptSupervisionRoutes } from '../../src/server/scriptSupervisionRoutes.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ScriptJobSupervisor.test.ts' }); });

function setup(view: PoolJobsView, answer: string | (() => Promise<string>), open: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-')); dirs.push(root);
  const raised: Array<Record<string, unknown>> = [];
  const cleared: string[] = [];
  const prompts: string[] = [];
  const options: unknown[] = [];
  const deps: ScriptJobSupervisorDeps = {
    fetchPoolJobs: async () => view,
    intelligence: { evaluate: async (p, o) => { prompts.push(p); options.push(o); return typeof answer === 'string' ? answer : answer(); } },
    machineId: 'm-1',
    logsDir: path.join(root, 'logs'),
    raiseAttention: (i) => { raised.push(i as never); },
    clearAttention: (k) => { cleared.push(k); },
    listOpenConditionKeys: () => open,
  };
  return { sup: new ScriptJobSupervisor(deps), raised, cleared, prompts, options, root };
}

const row = (slug: string, machineId = 'm-1', extra: Record<string, unknown> = {}) => ({ slug, machineId, runner: 'script', state: { lastResult: 'success' }, recentOutputs: ['ok'], ...extra });

describe('parseSupervisionOutput (strict)', () => {
  const known = { slugs: new Set(['a']), machines: new Set(['m-1']) };
  it('accepts the exact shape, and a single json fence', () => {
    expect(parseSupervisionOutput('{"flags":[]}', known)).toEqual([]);
    expect(parseSupervisionOutput('```json\n{"flags":[{"slug":"a","machineId":"m-1","reason":"r"}]}\n```', known)).toEqual([{ slug: 'a', machineId: 'm-1', reason: 'r' }]);
    expect(parseSupervisionOutput('{"flags":[{"slug":null,"machineId":null,"reason":"fleet"}]}', known)).toEqual([{ slug: null, machineId: null, reason: 'fleet' }]);
  });
  it('refuses prose, extra keys, unknown slugs/machines and empty reasons', () => {
    expect(parseSupervisionOutput('Here you go: {"flags":[]}', known)).toBeNull();
    expect(parseSupervisionOutput('{"flags":[],"note":"x"}', known)).toBeNull();
    expect(parseSupervisionOutput('{"flags":[{"slug":"zzz","reason":"r"}]}', known)).toBeNull();
    expect(parseSupervisionOutput('{"flags":[{"slug":"a","machineId":"evil","reason":"r"}]}', known)).toBeNull();
    expect(parseSupervisionOutput('{"flags":[{"slug":"a","reason":""}]}', known)).toBeNull();
    expect(parseSupervisionOutput('not json', known)).toBeNull();
  });
});

describe('ScriptJobSupervisor.pass', () => {
  it('is registered as a reflector component', () => {
    expect(COMPONENT_CATEGORY.ScriptJobSupervisor).toBe('reflector');
  });

  it('wraps job data as untrusted, makes one call, raises low items, and logs', async () => {
    const t = setup({ jobs: [row('a'), row('b', 'm-2'), { slug: 'agent-job', runner: 'agentmd' }] },
      '{"flags":[{"slug":"a","machineId":"m-1","reason":"triage keeps asking for sessions"},{"slug":null,"machineId":null,"reason":"m-3 missing"}]}');
    const r = await t.sup.pass();
    expect(r.ok).toBe(true);
    expect(r.reviewed).toBe(2);
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain('<untrusted-job-data>');
    expect(t.prompts[0]).not.toContain('agent-job');
    expect(t.options[0]).toMatchObject({ attribution: { component: 'ScriptJobSupervisor', category: 'reflector' } });
    expect(t.raised.map(i => i.conditionKey).sort()).toEqual(['script-supervision:fleet', 'script-supervision:m-1:a']);
    expect(t.raised.every(i => i.priority === 'LOW' && i.source === 'script-job-supervisor')).toBe(true);
    const log = fs.readFileSync(path.join(t.root, 'logs', 'script-job-supervisor.jsonl'), 'utf-8');
    expect(log).toContain('"ok":true');
  });

  it('clamps at 60,000 characters and names overflow rows "not reviewed today"', async () => {
    const big = 'x'.repeat(1000);
    const jobs = Array.from({ length: 30 }, (_, i) => row(`s${i}`, 'm-1', { recentOutputs: [big, big, big] }));
    const t = setup({ jobs }, '{"flags":[]}');
    const r = await t.sup.pass();
    expect(r.reviewed).toBeGreaterThan(0);
    expect(r.reviewed).toBeLessThan(30);
    expect(r.notReviewedToday.filter(n => n.why.includes('size limit'))).toHaveLength(30 - r.reviewed);
    const data = t.prompts[0].split('<untrusted-job-data>')[1].split('</untrusted-job-data>')[0];
    expect(data.length).toBeLessThanOrEqual(SUPERVISION_INPUT_CLAMP_CHARS + 2);
  });

  it('records pool.failed peers as not reviewed today', async () => {
    const t = setup({ jobs: [row('a')], pool: { failed: [{ machineId: 'm-9', reason: 'timeout' }] } }, '{"flags":[]}');
    const r = await t.sup.pass();
    expect(r.notReviewedToday).toEqual([{ machineId: 'm-9', why: 'machine unreachable (timeout)' }]);
    expect(t.prompts[0]).toContain('Not reviewed today');
  });

  it('clears items that no longer apply, but never a not-reviewed row and never on a bad answer', async () => {
    const open = ['script-supervision:m-1:a', 'script-supervision:m-1:gone-slug', 'script-supervision:fleet', 'script-supervision:m-1:b'];
    const t = setup({ jobs: [row('a'), row('b')] }, '{"flags":[{"slug":"b","machineId":"m-1","reason":"r"}]}', open);
    const r = await t.sup.pass();
    expect(r.cleared.sort()).toEqual(['script-supervision:fleet', 'script-supervision:m-1:a']);
    expect(t.cleared).not.toContain('script-supervision:m-1:b');
    expect(t.cleared).not.toContain('script-supervision:m-1:gone-slug');

    const bad = setup({ jobs: [row('a')] }, 'I think everything is fine.', ['script-supervision:m-1:a']);
    const r2 = await bad.sup.pass();
    expect(r2.ok).toBe(false);
    expect(bad.cleared).toEqual([]);
    expect(bad.raised).toEqual([]);
  });

  it('a failed call or fetch is ok:false and touches no item', async () => {
    const t = setup({ jobs: [row('a')] }, async () => { throw new Error('provider down'); }, ['script-supervision:m-1:a']);
    const r = await t.sup.pass();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('provider down');
    expect(t.cleared).toEqual([]);
  });
});

describe('POST /jobs/script-supervision/pass', () => {
  async function call(app: express.Express): Promise<{ status: number; body: Record<string, unknown> }> {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/jobs/script-supervision/pass`, { method: 'POST' });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    } finally { server.close(); }
  }
  it('503s when not wired, runs the pass when wired', async () => {
    const a = express(); a.use(createScriptSupervisionRoutes({ supervisor: null }));
    expect((await call(a)).status).toBe(503);
    const t = setup({ jobs: [row('a')] }, '{"flags":[]}');
    const b = express(); b.use(createScriptSupervisionRoutes({ supervisor: t.sup }));
    const r = await call(b);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});
