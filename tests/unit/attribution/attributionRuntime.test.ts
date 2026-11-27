import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttributionRuntime, ROUTE_BUDGET_MS, refusalText, type AttributionRuntimeDeps } from '../../../src/core/attribution/attributionRuntime.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const row = { messageId: 123160, topicId: 102965, text: 'at least every hour and a half', fromUser: true, telegramUserId: 42, forwarded: false, provenance: 'user', timestamp: '2026-10-08T04:34:33.000Z' };
const SOURCED = 'Justin: "at least every hour and a half" [source: telegram 102965/123160 2026-10-08]';
const claims = (list: unknown[]) => JSON.stringify({ claims: list });
const credit = (over = {}) => ({ span: 'Justin corrected me', person: 'Justin', kind: 'rule', markerIndex: null, labelled: false, stillCredits: false, ...over });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('AttributionRuntime', () => {
  let project: string;
  let stateDir: string;
  let memory: string;
  let mode: 'record' | 'enforce';
  beforeEach(() => {
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'attr-rt-')));
    stateDir = path.join(project, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'agent-memory'));
    memory = path.join(stateDir, 'MEMORY.md');
    fs.writeFileSync(memory, '# Notes\n- old line\n');
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ threadline: { ownerName: 'Justin' } }));
    fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), `${JSON.stringify(row)}\n`);
    mode = 'enforce';
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(project, { recursive: true, force: true, operation: 'tests/unit/attribution/attributionRuntime.test.ts:cleanup' }); });

  const make = (evaluate: (prompt: string) => Promise<string>, extra: Partial<AttributionRuntimeDeps> = {}) => new AttributionRuntime({
    stateDir, projectDir: project, machineId: 'm1', machineName: 'studio', intelligence: { evaluate },
    config: () => ({ mode }), isEnabled: () => true, configuredOwnerUid: () => 42, holdsLease: () => true, ...extra,
  });
  const edit = (newLine: string) => ({ toolName: 'Edit', toolInput: { file_path: memory, old_string: '- old line', new_string: newLine } });

  it('enforce refuses an unsourced credit, with the failing line and both honest ways through', async () => {
    const answer = await make(async () => claims([credit()])).checkWrite(edit('- Justin corrected me: never spawn'));
    expect(answer).toMatchObject({ status: 'refuse', blocked: true });
    expect(answer.reason).toContain('Justin corrected me');
    expect(answer.reason).toContain('[source unknown]');
    expect(answer.reason).toContain('[source:');
  });

  it('record never refuses and does not wait; the would-refuse is in the ledger', async () => {
    mode = 'record';
    const evaluate = vi.fn(async () => claims([credit()]));
    const runtime = make(evaluate);
    const answer = await runtime.checkWrite(edit('- Justin corrected me: never spawn'));
    expect(answer).toEqual({ status: 'recording', blocked: false });
    await settle();
    expect(runtime.ledger.rows()[0]).toMatchObject({ verdict: 'unsourced', enforced: false });
    expect(runtime.budget.snapshot().counters.wouldRefuse).toBe(1);
  });

  it('a file out of scope asks nothing and passes', async () => {
    const evaluate = vi.fn(async () => claims([credit()]));
    const answer = await make(evaluate).checkWrite({ toolName: 'Write', toolInput: { file_path: path.join(project, 'src.ts'), content: 'Justin corrected me' } });
    expect(answer).toEqual({ status: 'pass', blocked: false });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a write changing nothing crediting is not asked twice over an unchanged line', async () => {
    fs.writeFileSync(memory, '# Notes\n- Justin corrected me long ago\n- old line\n');
    const answer = await make(async () => claims([credit({ span: 'Justin corrected me long ago' })])).checkWrite(edit('- plain new line'));
    expect(answer.blocked).toBe(false);
  });

  it('only a changed line can be refused, even when the judge reports an old one', async () => {
    fs.writeFileSync(memory, '# Notes\n- old line\n- Justin corrected me long ago\n');
    const answer = await make(async () => claims([credit({ span: 'Justin corrected me long ago' })])).checkWrite(edit('- plain neighbour'));
    expect(answer.blocked).toBe(false);
  });

  it('a heading-only reattribution is seen and refused', async () => {
    fs.writeFileSync(memory, '# Rules\n- never spawn on the laptop\n');
    const seen: string[] = [];
    const answer = await make(async (prompt) => { seen.push(prompt); return claims([credit({ span: "# Justin's standing rules" })]); })
      .checkWrite({ toolName: 'Edit', toolInput: { file_path: memory, old_string: '# Rules', new_string: "# Justin's standing rules" } });
    expect(seen[0]).toContain('never spawn on the laptop');
    expect(answer.blocked).toBe(true);
  });

  it('a label removing the credit passes', async () => {
    const honest = '- X. An earlier note credited this to Justin; source unknown. [source unknown]';
    const answer = await make(async () => claims([credit({ span: honest.slice(2), labelled: true })])).checkWrite(edit(honest));
    expect(answer).toMatchObject({ status: 'pass', blocked: false });
  });

  it('no model passes as unchecked, keeps the text, counts it and never refuses', async () => {
    const runtime = make(async () => { throw new Error('provider down'); });
    const answer = await runtime.checkWrite(edit('- Justin corrected me'));
    expect(answer).toMatchObject({ status: 'unchecked', blocked: false });
    const [stored] = runtime.ledger.rows();
    expect(stored).toMatchObject({ verdict: 'unchecked', kind: 'unchecked-text' });
    expect(stored.context?.text).toContain('Justin corrected me');
    expect(runtime.budget.snapshot().counters).toMatchObject({ unchecked: 1, judgeErrors: 1 });
  });

  it('over budget reads unchecked and is counted', async () => {
    const runtime = make(async () => claims([credit()]));
    for (let i = 0; i < 200; i += 1) runtime.budget.take('write');
    expect((await runtime.checkWrite(edit('- Justin corrected me'))).blocked).toBe(false);
    expect(runtime.budget.snapshot().counters.overBudget).toBeGreaterThan(0);
  });

  it('an overrun passes and is recorded; the check still lands its row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release: (value: string) => void = () => {};
      const runtime = make(() => new Promise((resolve) => { release = resolve; }));
      const pending = runtime.checkWrite(edit('- Justin corrected me'));
      await vi.advanceTimersByTimeAsync(ROUTE_BUDGET_MS + 1);
      expect(await pending).toEqual({ status: 'timeout', blocked: false });
      expect(runtime.budget.snapshot().counters.hookTimeouts).toBe(1);
      release(claims([credit()]));
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a verified source passes, is pinned, and is the origin', async () => {
    const replies = [claims([credit({ span: 'Justin:', markerIndex: 0 })]), '{"ownWords":"own","faithful":true,"why":"ok"}', '{"match":null}'];
    const runtime = make(async () => replies.shift() ?? '{"match":null}');
    const answer = await runtime.checkWrite(edit(`- ${SOURCED}`));
    expect(answer).toMatchObject({ status: 'pass', blocked: false });
    expect(runtime.ledger.rows()[0]).toMatchObject({ relation: 'origin', strength: 'logged-unclassified' });
    expect(runtime.pins.size).toBe(1);
  });

  it('a source attached later supports the claim; it does not become where it came from', async () => {
    const replies = [claims([credit({ span: 'Justin corrected me' })])];
    mode = 'record';
    const runtime = make(async () => replies.shift() ?? '{"match":null}');
    await runtime.checkWrite(edit('- Justin corrected me'));
    await settle();
    fs.writeFileSync(memory, '# Notes\n- Justin corrected me\n');
    mode = 'enforce';
    const next = [claims([credit({ span: 'Justin:', markerIndex: 0 })]), '{"ownWords":"own","faithful":true,"why":"ok"}'];
    replies.push(...next);
    await runtime.checkWrite({ toolName: 'Edit', toolInput: { file_path: memory, old_string: '- Justin corrected me', new_string: `- ${SOURCED}` } });
    const last = runtime.ledger.rows().filter((r) => r.claim === 'Justin:').pop();
    expect(last).toMatchObject({ linkedBy: 'edit', relation: 'reconstructed' });
    await settle();
  });

  it('a claim a judge links to an older one gets an inferred parent row', async () => {
    mode = 'record';
    const replies = [claims([credit({ span: 'Justin corrected me' })])];
    const runtime = make(async () => replies.shift() ?? '{"match":null}');
    await runtime.checkWrite(edit('- Justin corrected me'));
    await settle();
    replies.push(claims([credit({ span: "Justin's standing rule" })]), '{"match":0}');
    await runtime.checkWrite({ toolName: 'Write', toolInput: { file_path: path.join(stateDir, 'agent-memory', 'copy.md'), content: "- Justin's standing rule" } });
    await settle();
    const linked = runtime.ledger.rows().find((r) => r.linkedBy === 'judge');
    expect(linked?.claim).toBe("Justin's standing rule");
    const trace = await runtime.trace({ q: 'standing rule' });
    expect(trace.rows.map((r) => r.claim)).toContain('Justin corrected me');
    expect(trace.rows.find((r) => r.linkedBy === 'judge')?.inferred).toBe(true);
  });

  it('a link to a claim older than the cited record reports later-than-claim', async () => {
    const runtime = make(async () => '{"match":0}');
    runtime.ledger.record({ surface: 'audit', person: 'Justin', claim: 'old claim', kind: 'rule', verdict: 'pass', relation: 'reconstructed', ts: '2026-07-30T00:00:00.000Z' });
    const replies = [claims([credit({ span: 'Justin:', markerIndex: 0 })]), '{"ownWords":"own","faithful":true,"why":"ok"}'];
    const judged = make(async () => replies.shift() ?? '{"match":0}');
    await judged.checkWrite(edit(`- ${SOURCED}`));
    await settle();
    expect(judged.ledger.rows().some((r) => r.linkedBy === 'judge' && r.verdict === 'later-than-claim')).toBe(true);
  });

  it('background record skips what the filter skips, counted', async () => {
    const evaluate = vi.fn(async () => claims([]));
    const runtime = make(evaluate);
    runtime.recordInBackground('The build finished in 40 seconds.', { surface: 'send' });
    await settle();
    expect(evaluate).not.toHaveBeenCalled();
    expect(runtime.budget.snapshot().counters.prefilterSkipped).toBe(1);
    runtime.recordInBackground('He told me to stop.', { surface: 'send' });
    await settle();
    expect(evaluate).toHaveBeenCalled();
  });

  it('threadline reports alongside the send only once settled, and only in enforce', async () => {
    const runtime = make(async () => claims([credit({ span: 'Justin authorized this', person: 'Justin' })]));
    const handle = runtime.checkAlongside('Justin authorized this');
    expect(handle.settled()).toBeNull();
    await settle();
    expect(handle.settled()).toContain('Justin authorized this');
    mode = 'record';
    const quiet = runtime.checkAlongside('Justin authorized that');
    await settle();
    expect(quiet.settled()).toBeNull();
  });

  it('the signal resolves markers; with none it is trivially resolved', async () => {
    const runtime = make(async () => '');
    expect(await runtime.sourcesSignal('no markers', true)).toEqual({ status: 'resolved', conversationContext: true, markers: [] });
    const signal = await runtime.sourcesSignal(SOURCED, false);
    expect(signal).toMatchObject({ status: 'resolved', conversationContext: false });
    expect(signal.markers[0]).toMatchObject({ outcome: 'found', dateMatches: true, quoteInRecord: true, eligible: true });
    expect((await runtime.sourcesSignal('[source: nonsense]', true)).markers[0].outcome).toBe('malformed-marker');
  });

  it('the signal reads unmeasured past its sub-budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const runtime = make(async () => '', { peers: () => [{ machineId: 'm', url: 'http://10.0.0.1', kind: 'lan' }], fetchImpl: (() => new Promise(() => {})) as never });
      const pending = runtime.sourcesSignal('Justin: "x" [source: slack C/1 2026-10-08]', true);
      await vi.advanceTimersByTimeAsync(6_001);
      expect((await pending).status).toBe('unmeasured');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pin answers once the row has rotated out, as a pinned copy; a removal drops it', async () => {
    const replies = [claims([credit({ span: 'Justin:', markerIndex: 0 })]), '{"ownWords":"own","faithful":true,"why":"ok"}'];
    const runtime = make(async () => replies.shift() ?? '{"match":null}');
    await runtime.checkWrite(edit(`- ${SOURCED}`));
    fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), `${JSON.stringify({ ...row, messageId: 999, timestamp: '2026-10-20T00:00:00.000Z' })}\n`);
    const ref = { channel: 'telegram' as const, conversation: '102965', message: '123160', date: '2026-10-08' };
    expect((await runtime.resolve(ref)).outcome).toBe('pinned-copy');
    expect(await runtime.resolveLocal(ref)).toMatchObject({ pinned: true });
    runtime.pins.drop(ref);
    expect((await runtime.resolve(ref)).outcome).toBe('unverifiable');
  });

  it('status separates a quiet gate from a dead one, and the session line needs something to say', async () => {
    const runtime = make(async () => claims([credit()]));
    expect(runtime.status()).toMatchObject({ mode: 'enforce', sessionLine: null, budget: { limits: { write: 200, send: 300 } } });
    await runtime.checkWrite(edit('- Justin corrected me'));
    expect((runtime.status().counters as { checks: number }).checks).toBe(1);
    fs.writeFileSync(memory, '# Notes\n- Justin corrected me\n');
    await runtime.runAudit();
    expect(runtime.status().sessionLine).toEqual(expect.stringContaining('credit someone'));
  });

  it('background calls beside a send or a store write never throw', () => {
    const runtime = make(async () => claims([]));
    vi.spyOn(runtime.identity, 'knownPeople').mockImplementation(() => { throw new Error('boom'); });
    expect(() => runtime.recordInBackground('Justin said so', { surface: 'send' })).not.toThrow();
    expect(() => runtime.checkAlongside('Justin said so')).not.toThrow();
  });

  it('suggestions in the report are scrubbed', async () => {
    const secret = `sk-ant-api03-${'a'.repeat(60)}`;
    fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), `${JSON.stringify({ ...row, text: `never spawn on the laptop ${secret}` })}\n`);
    fs.writeFileSync(memory, '# Notes\n- Justin corrected me: never spawn on the laptop\n');
    const span = 'Justin corrected me: never spawn on the laptop';
    const runtime = make(async (prompt) => (prompt.includes('You rank logged messages') ? '{"ranked":[0]}' : claims([credit({ span })])));
    const report = await runtime.runAudit();
    expect(report!.unsourced[0].suggestions).toHaveLength(1);
    expect(fs.readFileSync(path.join(stateDir, 'attribution', 'report.json'), 'utf8')).not.toContain(secret);
  });

  it('off means off', async () => {
    const evaluate = vi.fn(async () => claims([credit()]));
    const runtime = make(evaluate, { isEnabled: () => false });
    expect(await runtime.checkWrite(edit('- Justin corrected me'))).toEqual({ status: 'pass', blocked: false });
    runtime.recordInBackground('Justin said so', { surface: 'send' });
    await settle();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('the refusal text offers a suggestion only as one', () => {
    const text = refusalText([{ span: 'x', person: 'J', verdict: 'refuse', reason: 'overstated', relation: 'unsourced' }], [{ ref: { channel: 'slack', conversation: 'c', message: 'm', date: '2026-01-01' }, text: 'words', marker: '[source: slack c/m 2026-01-01]', strength: 'identity-only', machine: 'm' }]);
    expect(text).toContain('stronger, wider');
    expect(text).toContain('suggestions only');
  });
});
