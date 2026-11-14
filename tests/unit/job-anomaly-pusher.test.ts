import { describe, it, expect, vi } from 'vitest';
import { JobAnomalyEpisodeStore } from '../../src/scheduler/JobAnomalyEpisodeStore.js';
import { JobAnomalyNarrator } from '../../src/scheduler/JobAnomalyNarrator.js';
import {
  JobAnomalyPusher, ADVISORY_ACK_REASON, cronIntervalMs,
  type JobAnomalyPusherDeps, type AttentionRaise, type HealAttemptResult,
} from '../../src/scheduler/JobAnomalyPusher.js';
import type { ParsedScriptRun, ParsedAnomaly } from '../../src/scheduler/jobScriptProtocol.js';
import type { JobDefinition } from '../../src/core/types.js';

const H = 60 * 60_000;
const INTERVAL = 15 * 60_000;

const job = {
  slug: 'health-check', name: 'Health Check', description: '', schedule: '*/15 * * * *', priority: 'low',
  enabled: true, execute: { type: 'script' }, body: 'Check the health of the server.',
  anomalies: [
    { kind: 'disk-low', class: 'recoverable' }, { kind: 'disk-critical', class: 'critical' },
    { kind: 'sessions-exhausted', class: 'recoverable' }, { kind: 'llm-unreliable', class: 'recoverable' },
    { kind: 'degradation:*', class: 'recoverable' },
  ],
} as unknown as JobDefinition;

function an(kind: string, cls: 'critical' | 'recoverable' = 'recoverable', evidence = `${kind} evidence`, severity: 1 | 2 | 3 = 2): ParsedAnomaly {
  return { kind, severity, evidence, class: cls };
}
function run(result: 'success' | 'failure' | 'skipped', anomalies: ParsedAnomaly[] = []): ParsedScriptRun {
  return { result, reason: '', reasonCode: '', summary: '', anomalies, ignoredAnomalies: 0, fields: {}, droppedFields: 0, missingResultLine: false, overCap: false };
}
function okResp(messageId = 42) {
  return { ok: true, status: 200, json: async () => ({ ok: true, messageId }) };
}
function resp(status: number, body: Record<string, unknown>) {
  return { ok: status < 400, status, json: async () => body };
}

interface Harness {
  pusher: JobAnomalyPusher; store: JobAnomalyEpisodeStore;
  raised: AttentionRaise[]; cleared: Array<[string, string]>;
  sends: Array<{ topicId: number; body: any; logicalSendId?: string }>;
  detSends: Array<{ topicId: number; text: string }>;
  views: Array<{ title: string; markdown: string }>;
  evaluate: ReturnType<typeof vi.fn>;
  audit: any[];
  setClock(t: number): void; advance(ms: number): void; now(): number;
  doRun(p: ParsedScriptRun): ReturnType<JobAnomalyPusher['processRun']>;
}

function harness(over: Partial<JobAnomalyPusherDeps> & { sendImpl?: (body: any) => any; heal?: () => Promise<HealAttemptResult>; noHeal?: boolean; tunnel?: string | null } = {}): Harness {
  let clock = Date.parse('2026-10-26T00:00:00Z');
  const now = () => clock;
  const store = new JobAnomalyEpisodeStore({ filePath: null, now });
  const evaluate = vi.fn(async (_p: string, o: any) => { o.onModel?.({ model: 'm-small', framework: 'codex-cli' }); return 'Narrated summary.'; });
  const narrator = new JobAnomalyNarrator({ intelligence: { evaluate }, now });
  const h: Partial<Harness> = { raised: [], cleared: [], sends: [], detSends: [], views: [], audit: [], store, evaluate };
  const deps: JobAnomalyPusherDeps = {
    store, narrator, machineId: 'm1', machineName: () => 'the mini', now,
    raiseAttention: (i) => { h.raised!.push(i); },
    clearAttention: (k, r) => { h.cleared!.push([k, r]); },
    sendAutomationReply: async (_p, topicId, body, _a, logicalSendId) => {
      h.sends!.push({ topicId, body, logicalSendId });
      return over.sendImpl ? over.sendImpl(body) : okResp();
    },
    sendDeterministicTopic: async (topicId, text) => { h.detSends!.push({ topicId, text }); return { messageId: 7 }; },
    createPrivateView: (title, markdown) => { h.views!.push({ title, markdown }); return { id: 'v1' }; },
    viewTunnelUrl: () => (over.tunnel === undefined ? 'https://t.example/view/v1?token=x' : over.tunnel),
    ensureJobTopic: async () => 100,
    requestHealAttempt: over.noHeal ? undefined : (over.heal ?? (async () => 'refused:cooldown-active' as HealAttemptResult)),
    intervalFor: () => INTERVAL,
    jobBySlug: () => job,
    audit: { append: (r) => h.audit!.push(r) },
    healInlineGraceMs: 5,
    log: () => {},
    ...over,
  };
  const pusher = new JobAnomalyPusher(deps);
  let n = 0;
  return Object.assign(h, {
    pusher, setClock: (t: number) => { clock = t; }, advance: (ms: number) => { clock += ms; }, now,
    doRun: (p: ParsedScriptRun) => pusher.processRun({ job, machineId: 'm1', runId: `r${++n}`, parsed: p }),
  }) as Harness;
}

describe('JobAnomalyPusher — anomaly path (§5.4, §12)', () => {
  it('a critical reason pushes on the same run, with no calm item', async () => {
    const h = harness();
    const r = await h.doRun(run('success', [an('disk-critical', 'critical', 'free 4%')]));
    expect(r.push?.outcome).toBe('delivered');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].body.text).toContain('disk-critical on the mini (critical)');
    expect(h.raised).toHaveLength(0);
    // pushed once per episode: next run with the same reason does not re-push
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-critical', 'critical', 'free 4%')]));
    expect(h.sends).toHaveLength(1);
  });

  it('a critical push goes out BEFORE the store write', async () => {
    const order: string[] = [];
    const h = harness({ sendImpl: () => { order.push('send'); return okResp(); } });
    const orig = h.store.save.bind(h.store);
    h.store.save = () => { order.push('save'); return orig(); };
    await h.doRun(run('success', [an('disk-critical', 'critical')]));
    expect(order[0]).toBe('send');
    expect(order).toContain('save');
  });

  it('observes a second critical run while the first delivery waits, and keeps old and new episodes distinct', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const h = harness({ sendImpl: async () => { if (++calls === 1) await gate; return okResp(); } });
    const first = h.doRun(run('success', [an('disk-critical', 'critical')]));
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    const firstId = h.store.listOpen()[0].id;
    h.advance(INTERVAL);
    const second = h.doRun(run('success', [an('disk-critical', 'critical')]));
    expect(h.store.listOpen()[0].id).toBe(firstId);
    for (let i = 0; i < 3; i++) {
      h.advance(INTERVAL);
      void h.doRun(run('success'));
    }
    expect(h.store.listOpen()).toHaveLength(0);
    h.advance(INTERVAL);
    const reopened = h.doRun(run('success', [an('disk-critical', 'critical')]));
    const newId = h.store.listOpen()[0].id;
    expect(newId).not.toBe(firstId);
    release();
    await Promise.all([first, second, reopened]);
    expect(h.sends.map(s => s.logicalSendId)).toEqual([`${firstId}:critical`, `${newId}:critical`]);
    expect(h.store.listOpen()[0].id).toBe(newId);
    expect(h.store.listOpen()[0].pushed).toBe(true);
  });

  it('a failing store write never blocks the push and the in-memory record keeps one push per episode', async () => {
    const h = harness();
    h.store.save = () => false;
    await h.doRun(run('success', [an('disk-critical', 'critical')]));
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-critical', 'critical')]));
    expect(h.sends).toHaveLength(1);
  });

  it('a recoverable reason raises one calm item first, then ONE push after 6 h of persistence', async () => {
    const h = harness({ noHeal: true });
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0]).toMatchObject({ priority: 'LOW', sourceContext: 'health-check', conditionKey: 'job-anomaly:m1:disk-low' });
    expect(h.raised[0].summary).toMatch(/^disk-low on the mini: seen since .+; owned by no owner$/);
    expect(h.sends).toHaveLength(0);
    for (let t = 0; t < 23; t++) { h.advance(INTERVAL); await h.doRun(run('success', [an('disk-low')])); }
    expect(h.sends).toHaveLength(0); // 5h45m
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].body.text).toContain('has persisted for 6 hours; an investigation could not start: triage-disabled');
    expect(h.raised).toHaveLength(1);
    for (let t = 0; t < 8; t++) { h.advance(INTERVAL); await h.doRun(run('success', [an('disk-low')])); }
    expect(h.sends).toHaveLength(1); // once per episode
  });

  it('retries a calm item after attention delivery fails instead of marking it sent', async () => {
    let calls = 0;
    const h = harness({ raiseAttention: async () => { if (++calls === 1) throw new Error('attention unavailable'); } });
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.store.get(h.store.key('m1', 'health-check', 'disk-low'))?.statusLineSent).toBe(false);
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low')]));
    expect(calls).toBe(2);
    expect(h.store.get(h.store.key('m1', 'health-check', 'disk-low'))?.statusLineSent).toBe(true);
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low')]));
    expect(calls).toBe(2);
  });

  it('triage disabled (live flag) records refused:triage-disabled and pushes at 6 h without calling the heal dep', async () => {
    const heal = vi.fn(async () => 'ran' as HealAttemptResult);
    const h = harness({ heal, triageEnabled: () => false });
    await h.doRun(run('success', [an('llm-unreliable')]));
    h.advance(6 * H);
    await h.doRun(run('success', [an('llm-unreliable')]));
    expect(heal).not.toHaveBeenCalled();
    expect(h.sends[0].body.text).toContain('could not start: triage-disabled');
  });

  it('heal attempt that ran → push on the next run, naming that it ran', async () => {
    const h = harness({ heal: async () => 'ran' });
    await h.doRun(run('success', [an('sessions-exhausted')]));
    h.advance(6 * H);
    await h.doRun(run('success', [an('sessions-exhausted')]));
    expect(h.sends).toHaveLength(0);
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('sessions-exhausted')]));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].body.text).toContain('an investigation ran and it is still present');
  });

  it('reconnects a persisted requested heal only after triage records completion', async () => {
    let terminal: HealAttemptResult | null = null;
    const h = harness({
      heal: () => new Promise<HealAttemptResult>(() => {}),
      readHealOutcome: () => terminal,
    });
    await h.doRun(run('success', [an('disk-low')]));
    h.advance(6 * H);
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.sends).toHaveLength(0);
    expect(h.store.listOpen('health-check')[0].heal.state).toBe('requested');
    terminal = 'ran';
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.store.listOpen('health-check')[0].heal.state).toBe('ran');
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.sends[0].body.text).toContain('an investigation ran and it is still present');
  });

  it('heal refused with a reason → push names it on the same run', async () => {
    const h = harness({ heal: async () => 'refused:daily-cap' });
    await h.doRun(run('success', [an('disk-low')]));
    h.advance(6 * H);
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.sends[0].body.text).toContain('could not start: daily-cap');
  });

  it('hard deadline: a heal that never settles pushes at 6 h + 30 min + one interval with "outcome unknown"', async () => {
    const h = harness({ heal: () => new Promise<HealAttemptResult>(() => {}) });
    await h.doRun(run('success', [an('disk-low')]));
    h.advance(6 * H);
    await h.doRun(run('success', [an('disk-low')]));
    h.advance(30 * 60_000);
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.sends).toHaveLength(0);
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low')]));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].body.text).toContain('investigation outcome unknown');
  });

  it("an owner's open item for the same condition does not suppress the persistence push", async () => {
    const h = harness({ noHeal: true });
    await h.doRun(run('success', [an('degradation:TopicMemory', 'recoverable', 'TopicMemory fell back to grep')]));
    // an owner raised its own item for the same condition — the pusher never consults it
    h.raised.push({ id: 'owner', title: 'TopicMemory degraded', summary: '', category: 'degradation', priority: 'HIGH', sourceContext: 'TopicMemory', conditionKey: 'degradation:TopicMemory' });
    h.advance(6 * H);
    await h.doRun(run('success', [an('degradation:TopicMemory', 'recoverable', 'TopicMemory fell back to grep')]));
    expect(h.sends).toHaveLength(1);
  });

  it('a skipped or failed run is neutral for the rolling window', async () => {
    const h = harness();
    await h.doRun(run('success', [an('disk-low')]));
    for (let i = 0; i < 5; i++) { h.advance(INTERVAL); await h.doRun(run(i % 2 ? 'skipped' : 'failure')); }
    expect(h.store.listOpen()).toHaveLength(1);
    expect(h.store.listOpen()[0].cleanStreak).toBe(0);
    // a problem present in 3 runs of 4 stays open
    for (let i = 0; i < 8; i++) { h.advance(INTERVAL); await h.doRun(run('success', i % 4 === 3 ? [] : [an('disk-low')])); }
    expect(h.store.listOpen()).toHaveLength(1);
  });

  it('a failed run never opens episodes even when it carries anomaly lines', async () => {
    const h = harness();
    await h.doRun(run('failure', [an('disk-critical', 'critical')]));
    expect(h.store.listOpen()).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  it('job-failure reasons (undeclared kinds) are excluded', async () => {
    const h = harness();
    await h.doRun(run('success', [an('consecutive-job-failures', 'critical'), an('health-unreachable', 'critical')]));
    expect(h.store.listOpen()).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  it('episodes close only after 3 clean runs in a row, and the calm item is cleared', async () => {
    const h = harness();
    await h.doRun(run('success', [an('disk-low')]));
    h.advance(INTERVAL); await h.doRun(run('success'));
    h.advance(INTERVAL); await h.doRun(run('success'));
    expect(h.store.listOpen()).toHaveLength(1);
    h.advance(INTERVAL); await h.doRun(run('success', [an('disk-low')])); // streak broken
    h.advance(INTERVAL); await h.doRun(run('success'));
    h.advance(INTERVAL); await h.doRun(run('success'));
    expect(h.store.listOpen()).toHaveLength(1);
    h.advance(INTERVAL); await h.doRun(run('success'));
    expect(h.store.listOpen()).toHaveLength(0);
    expect(h.cleared).toEqual([['job-anomaly:m1:disk-low', expect.stringContaining('3 clean runs')]]);
  });

  it('stale episodes expire on the tick and their calm items are cleared', async () => {
    const h = harness();
    await h.doRun(run('success', [an('disk-low')]));
    h.advance(3 * INTERVAL);
    expect(await h.pusher.tick()).toHaveLength(0);
    h.advance(1);
    expect(await h.pusher.tick()).toHaveLength(1);
    expect(h.cleared[0]).toEqual(['job-anomaly:m1:disk-low', 'stale: job no longer runs here']);
  });

  it('episode state persists across a restart (no second calm item, no second push)', async () => {
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jap-'));
    const file = path.join(dir, 'e.json');
    let clock = Date.parse('2026-10-26T00:00:00Z');
    const mk = () => {
      const store = new JobAnomalyEpisodeStore({ filePath: file, now: () => clock });
      const raised: AttentionRaise[] = []; const sends: any[] = [];
      const p = new JobAnomalyPusher({
        store, narrator: new JobAnomalyNarrator({ intelligence: null }), machineId: 'm1', now: () => clock,
        raiseAttention: (i) => { raised.push(i); }, clearAttention: () => {},
        sendAutomationReply: async (_a, _t, body) => { sends.push(body); return okResp(); },
        sendDeterministicTopic: async () => ({ messageId: 1 }), ensureJobTopic: async () => 1, intervalFor: () => INTERVAL,
      });
      return { p, raised, sends };
    };
    const a = mk();
    await a.p.processRun({ job, machineId: 'm1', runId: 'a', parsed: run('success', [an('disk-low'), an('disk-critical', 'critical')]) });
    expect(a.raised).toHaveLength(1); expect(a.sends).toHaveLength(1);
    const b = mk();
    clock += INTERVAL;
    await b.p.processRun({ job, machineId: 'm1', runId: 'b', parsed: run('success', [an('disk-low'), an('disk-critical', 'critical')]) });
    expect(b.raised).toHaveLength(0); expect(b.sends).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the evidence block is rendered verbatim and never sent through the model', async () => {
    const h = harness();
    const evidence = 'Degradation: messaging.toneGate.failClosedOnExhaustion fell back to heuristic (x=3)';
    await h.doRun(run('success', [an('disk-critical', 'critical', evidence)]));
    expect(h.sends[0].body.text).toContain(`- disk-critical: ${evidence}`);
    const prompt: string = h.evaluate.mock.calls[0][0];
    expect(prompt).not.toContain('failClosedOnExhaustion');
  });

  it('all pushes due on one run are combined into ONE message (one narration, one evidence block)', async () => {
    const h = harness();
    const two = { ...job, anomalies: [...(job as any).anomalies, { kind: 'degradation-critical:*', class: 'critical' }] } as unknown as JobDefinition;
    const r = await h.pusher.processRun({ job: two, machineId: 'm1', runId: 'c', parsed: run('success', [
      an('disk-critical', 'critical', 'a'), an('degradation-critical:X', 'critical', 'b'), an('degradation-critical:Y', 'critical', 'c'),
    ]) });
    expect(r.push?.kinds).toHaveLength(3);
    expect(h.sends).toHaveLength(1);
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    const text: string = h.sends[0].body.text;
    expect(text.match(/^Evidence:$/gm)).toHaveLength(1);
    for (const e of ['- disk-critical: a', '- degradation-critical:X: b', '- degradation-critical:Y: c']) expect(text).toContain(e);
  });

  it('a new reason on an open run gets its own episode, calm item and push slot; disk-low → disk-critical pushes at once', async () => {
    const h = harness();
    await h.doRun(run('success', [an('disk-low')]));
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low'), an('disk-critical', 'critical')]));
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].body.text).toContain('disk-critical');
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-low'), an('degradation:Foo')]));
    expect(h.raised.map(r => r.conditionKey)).toEqual(['job-anomaly:m1:disk-low', 'job-anomaly:m1:degradation:Foo']);
  });

  it('severity changes and new strings trigger re-narration; an unchanged retry reuses the narration', async () => {
    let fail = true;
    const h = harness({ sendImpl: () => (fail ? resp(503, { error: 'down' }) : okResp()) });
    await h.doRun(run('success', [an('disk-critical', 'critical', 'free 4%', 2)]));
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    h.advance(INTERVAL);
    await h.doRun(run('success', [an('disk-critical', 'critical', 'free 4%', 2)])); // retry, unchanged
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(h.sends).toHaveLength(2);
    h.advance(INTERVAL); await h.doRun(run('success', [an('disk-critical', 'critical', 'free 3%', 3)])); // spacing 2: not yet
    h.advance(INTERVAL); fail = false;
    await h.doRun(run('success', [an('disk-critical', 'critical', 'free 3%', 3)]));
    expect(h.evaluate).toHaveBeenCalledTimes(2);
    expect(h.sends.at(-1)!.body.text).toContain('free 3%');
  });

  it('recurrence: 3 episodes in 6 h push once, then mute for 24 h; critical is never muted', async () => {
    const h = harness();
    const cycle = async (kind: string, cls: 'critical' | 'recoverable') => {
      await h.doRun(run('success', [an(kind, cls)]));
      for (let i = 0; i < 3; i++) { h.advance(INTERVAL); await h.doRun(run('success')); }
      h.advance(INTERVAL);
    };
    await cycle('llm-unreliable', 'recoverable');
    await cycle('llm-unreliable', 'recoverable');
    expect(h.sends).toHaveLength(0);
    await cycle('llm-unreliable', 'recoverable');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].body.text).toContain('keeps recurring');
    await cycle('llm-unreliable', 'recoverable');
    await cycle('llm-unreliable', 'recoverable');
    expect(h.sends).toHaveLength(1); // muted
    // persistence muted too within 24 h
    await h.doRun(run('success', [an('llm-unreliable')]));
    h.advance(6 * H);
    await h.doRun(run('success', [an('llm-unreliable')]));
    expect(h.sends).toHaveLength(1);
    // critical: every new episode pushes
    const before = h.sends.length;
    for (let i = 0; i < 4; i++) await cycle('disk-critical', 'critical');
    expect(h.sends.length - before).toBe(4);
    // calm items continued for every recoverable episode
    expect(h.raised.filter(r => r.conditionKey.endsWith('llm-unreliable')).length).toBe(6);
  });

  it('push retry brakes: 1, 2, 4, 8 runs then hourly; the 6th failure raises ONE undelivered item', async () => {
    const h = harness({ sendImpl: () => resp(500, { error: 'x' }) });
    const attemptsAtRun: number[] = [];
    await h.doRun(run('success', [an('disk-critical', 'critical')]));
    attemptsAtRun.push(1);
    for (let i = 2; i <= 40; i++) {
      h.advance(60_000); // 1-minute runs so hourly isn't reached early
      const before = h.sends.length;
      await h.doRun(run('success', [an('disk-critical', 'critical')]));
      if (h.sends.length > before) attemptsAtRun.push(i);
    }
    // attempt 1 at run 1; +1 → 2; +2 → 4; +4 → 8; +8 → 16; then hourly
    expect(attemptsAtRun.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    expect(attemptsAtRun).toHaveLength(5);
    h.advance(60 * 60_000);
    await h.doRun(run('success', [an('disk-critical', 'critical')]));
    expect(h.sends).toHaveLength(6);
    const und = h.raised.filter(r => r.conditionKey === 'job-anomaly-undelivered:m1');
    expect(und).toHaveLength(1);
    expect(und[0]).toMatchObject({ priority: 'HIGH', sourceContext: 'agent' });
    h.advance(60 * 60_000);
    await h.doRun(run('success', [an('disk-critical', 'critical')]));
    expect(h.raised.filter(r => r.conditionKey === 'job-anomaly-undelivered:m1')).toHaveLength(1);
    // the same idempotency key every attempt
    expect(new Set(h.sends.map(s => s.logicalSendId)).size).toBe(1);
    expect(h.sends[0].logicalSendId).toMatch(/disk-critical:\d+:critical$/);
  });

  it('an unconfirmed send (ok but no message id) is not "pushed"', async () => {
    const h = harness({ sendImpl: () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) });
    const r = await h.doRun(run('success', [an('disk-critical', 'critical')]));
    expect(r.push?.outcome).toBe('not-delivered');
    expect(h.store.listOpen()[0].pushed).toBe(false);
  });

  it('the fixed template is sent when the model fails', async () => {
    const h = harness();
    h.evaluate.mockImplementationOnce(async () => { throw new Error('circuit open'); });
    await h.doRun(run('success', [an('disk-critical', 'critical', 'ev')]));
    expect(h.sends[0].body.text.startsWith('Health Check on the mini: disk-critical.')).toBe(true);
    expect(h.sends[0].body.text).toContain('- disk-critical: ev');
  });

  const configKeyEvidence = 'Degradation: config key monitoring.burnDetection.autoThrottle fell back';

  it('advisory (422 tone-gate-advisory) → re-sent once with the ack metadata', async () => {
    let n = 0;
    const h = harness({ sendImpl: () => (++n === 1 ? resp(422, { error: 'tone-gate-advisory', rule: 'B3_CONFIG_KEY', decisionRef: 'dq-123' }) : okResp()) });
    const r = await h.doRun(run('success', [an('degradation:BurnDetector', 'recoverable', configKeyEvidence), an('disk-critical', 'critical', configKeyEvidence)]));
    expect(r.push?.outcome).toBe('delivered');
    expect(r.push?.path).toBe('advisory-ack');
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1].body.text).toBe(h.sends[0].body.text);
    expect(h.sends[1].body.metadata).toMatchObject({ toneAdvisoryAck: 'B3_CONFIG_KEY', toneAdvisoryAckReason: ADVISORY_ACK_REASON, toneAdvisoryDecisionRef: 'dq-123' });
    expect(h.detSends).toHaveLength(0);
  });

  it('block (tone-gate-blocked) → evidence to a private view, fixed sentence + link on the deterministic path', async () => {
    const h = harness({ sendImpl: () => resp(422, { error: 'tone-gate-blocked', rule: 'B3_CONFIG_KEY' }) });
    const r = await h.doRun(run('success', [an('disk-critical', 'critical', configKeyEvidence)]));
    expect(r.push?.outcome).toBe('delivered');
    expect(r.push?.path).toBe('view-link');
    expect(h.views[0].markdown).toContain(configKeyEvidence);
    expect(h.detSends).toEqual([{ topicId: 100, text: 'Health Check on the mini: disk-critical. Details: https://t.example/view/v1?token=x' }]);
    expect(h.detSends[0].text).not.toContain('monitoring.burnDetection');
  });

  it('advisory ack that still blocks falls to the view path', async () => {
    let n = 0;
    const h = harness({ sendImpl: () => (++n === 1 ? resp(422, { error: 'tone-gate-advisory', rule: 'B2_FILE_PATH', decisionRef: 'd' }) : resp(422, { error: 'tone-gate-blocked', advisoryUnavailable: 'no-decision-ref' })) });
    const r = await h.doRun(run('success', [an('disk-critical', 'critical', configKeyEvidence)]));
    expect(r.push?.path).toBe('view-link');
    expect(h.sends).toHaveLength(2);
  });

  it('no tunnel → sentence ends "details on the Jobs tab"', async () => {
    const h = harness({ tunnel: null, sendImpl: () => resp(422, { error: 'tone-gate-blocked' }) });
    await h.doRun(run('success', [an('disk-critical', 'critical', configKeyEvidence)]));
    expect(h.detSends[0].text).toBe('Health Check on the mini: disk-critical; details on the Jobs tab.');
  });

  it('credential wall → no view is created, sentence points at the Jobs tab', async () => {
    const h = harness({ sendImpl: () => resp(422, { error: 'blocked', blockedBy: 'credential-exposure-guard', overridable: false }) });
    const r = await h.doRun(run('success', [an('disk-critical', 'critical', 'token sk-live-xxxx')]));
    expect(h.views).toHaveLength(0);
    expect(r.push?.path).toBe('jobs-tab');
    expect(h.detSends[0].text).toBe('Health Check on the mini: disk-critical; details on the Jobs tab.');
  });

  it('telegramNotify: false suppresses the push (recorded, never retried)', async () => {
    const h = harness();
    const quiet = { ...job, telegramNotify: false } as JobDefinition;
    const r = await h.pusher.processRun({ job: quiet, machineId: 'm1', runId: 'q', parsed: run('success', [an('disk-critical', 'critical')]) });
    expect(r.push?.outcome).toBe('suppressed');
    expect(h.sends).toHaveLength(0);
    await h.pusher.processRun({ job: quiet, machineId: 'm1', runId: 'q2', parsed: run('success', [an('disk-critical', 'critical')]) });
    expect(h.sends).toHaveLength(0);
  });

  it('observer ignores canary runs and jobs with no anomalies', async () => {
    const h = harness();
    const ctx = { job, runId: 'c', machineId: 'm1', parsed: run('success', [an('disk-critical', 'critical')]), scrubbedOutput: '', startedAt: '', finishedAt: '', canary: true, lockTrust: 'trusted' };
    await h.pusher.onScriptRunCompleted(ctx);
    await h.pusher.onScriptRunCompleted({ ...ctx, canary: false, job: { ...job, anomalies: [] } as unknown as JobDefinition });
    expect(h.store.listOpen()).toHaveLength(0);
    await h.pusher.onScriptRunCompleted({ ...ctx, canary: false });
    expect(h.sends).toHaveLength(1);
  });

  it('opens the episode synchronously before an asynchronous notification settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness({ sendImpl: async () => { await gate; return okResp(); } });
    const ctx = { job, runId: 'critical-now', machineId: 'm1', parsed: run('success', [an('disk-critical', 'critical')]),
      scrubbedOutput: '', startedAt: '', finishedAt: '', canary: false, lockTrust: 'trusted' };
    const delivery = h.pusher.onScriptRunCompleted(ctx);
    expect(h.store.listOpen()).toHaveLength(1);
    expect(h.store.listOpen()[0].reasonId).toBe('disk-critical');
    release();
    await delivery;
  });

  it('audit-only (canary) mode writes the push to the audit and never sends', async () => {
    const h = harness({ auditOnlyRunId: 'canary-run-1' });
    const r = await h.doRun(run('success', [an('disk-critical', 'critical')]));
    expect(r.push?.outcome).toBe('audit-only');
    expect(h.sends).toHaveLength(0);
    expect(h.audit.some(a => a.kind === 'push-audit-only' && a.runId === 'canary-run-1')).toBe(true);
  });

  it('audit rows never carry evidence text', async () => {
    const h = harness();
    await h.doRun(run('success', [an('disk-critical', 'critical', 'SECRET-EVIDENCE-TEXT')]));
    expect(JSON.stringify(h.audit)).not.toContain('SECRET-EVIDENCE-TEXT');
  });

  it('cronIntervalMs derives the interval from the schedule', () => {
    expect(cronIntervalMs('*/15 * * * *')).toBe(INTERVAL);
    expect(cronIntervalMs('not a cron')).toBeNull();
  });
});
