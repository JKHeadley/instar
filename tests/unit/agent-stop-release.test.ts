/**
 * Tier-1 tests for agent-class green-PR stops (green-pr-agent-stop-release).
 * Both sides of every boundary: a claim, a stored origin, the release condition,
 * and the surfacing pass that keeps an unreleased stop from being orphaned.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  AgentStopSurfacer, CONSOLE_STOP_REASON, bodyCitesMarker, evaluateReleaseCondition, markerFor, parseAgentStopClaim, readStoredOrigin,
  type AgentStopFacts, type AgentStopOrigin, type CitingPr, type StopView, type TagContainment,
} from '../../src/monitoring/agentStopRelease.js';
import { GH_PR_JSON_FIELDS, AGENT_STOP_PR_JSON_FIELDS } from '../../src/monitoring/greenPrAutomergeWiring.js';

const NOW = '2026-11-03T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const CAUSE = 'The old watcher merged PR 2648 before hosted CI finished.';
const validClaim = { topicId: 18330, sessionId: 's1', cause: CAUSE, release: { kind: 'fix-pr-released' } };
const origin = (over: Partial<AgentStopOrigin> = {}): AgentStopOrigin => ({ class: 'agent', topicId: 18330, cause: CAUSE, release: { kind: 'fix-pr-released' }, stoppedAt: NOW, ...over });
const LATCH = 'm1:212';
const MARKER = markerFor(LATCH);
const citing = (over: Partial<CitingPr> = {}): CitingPr => ({ number: 2700, body: `Fix. Resolves ${MARKER}.`, state: 'MERGED', mergedAt: '2026-11-03T13:00:00Z', baseRefName: 'main', mergeCommitOid: 'abc1234', ...over });
const facts = (prs: CitingPr[] | null, tag: TagContainment = 'contained'): AgentStopFacts => ({ mergedPrsCiting: async () => prs, commitInReleaseTag: async () => tag });

describe('parseAgentStopClaim', () => {
  it('accepts a complete claim and stamps the stop time itself', () => {
    const r = parseAgentStopClaim({ ...validClaim, stoppedAt: '1999-01-01T00:00:00Z' }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.origin).toEqual({ class: 'agent', topicId: 18330, sessionId: 's1', cause: CAUSE, release: { kind: 'fix-pr-released' }, stoppedAt: NOW });
  });
  it.each([
    ['not an object', 'agent', /object/],
    ['an array', [], /object/],
    ['no topic', { ...validClaim, topicId: undefined }, /topicId/],
    ['a zero topic', { ...validClaim, topicId: 0 }, /topicId/],
    ['a string topic', { ...validClaim, topicId: '18330' }, /topicId/],
    ['a junk session id', { ...validClaim, sessionId: 7 }, /sessionId/],
    ['no cause', { ...validClaim, cause: undefined }, /cause/],
    ['a stub cause', { ...validClaim, cause: 'oops' }, /cause/],
    ['an oversized cause', { ...validClaim, cause: 'x'.repeat(4001) }, /cause/],
    ['no condition', { ...validClaim, release: undefined }, /release/],
    ['a free-text condition', { ...validClaim, release: { kind: 'when I think it is fine' } }, /release/],
  ])('rejects %s', (_n, raw, why) => {
    const r = parseAgentStopClaim(raw, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(why);
  });
  it('keeps the whole cause, past the 80 characters the journal reason is cut to', () => {
    const cause = 'c'.repeat(300);
    const r = parseAgentStopClaim({ ...validClaim, cause }, NOW);
    expect(r.ok && r.origin.cause).toBe(cause);
  });
});

describe('readStoredOrigin', () => {
  it('reads a valid origin', () => { expect(readStoredOrigin(origin())).toEqual(origin()); });
  it.each([
    ['absent', undefined],
    ['operator class', { ...origin(), class: 'operator' }],
    ['no class', { ...origin(), class: undefined }],
    ['a bad topic', { ...origin(), topicId: -1 }],
    ['an empty cause', { ...origin(), cause: '' }],
    ['a bad time', { ...origin(), stoppedAt: 'soon' }],
    ['an unknown condition', { ...origin(), release: { kind: 'other' } }],
    ['a string', 'agent'],
  ])('reads %s as no origin', (_n, raw) => { expect(readStoredOrigin(raw)).toBeNull(); });
});

describe('marker', () => {
  it('has no colon, so a search can find it', () => { expect(markerFor('m_abc:212')).toBe('agent-stop-m_abc-212'); });
  it('matches exactly: -21 never matches -212, and the reverse', () => {
    expect(bodyCitesMarker('Resolves agent-stop-m1-212.', 'agent-stop-m1-212')).toBe(true);
    expect(bodyCitesMarker('Resolves agent-stop-m1-212.', 'agent-stop-m1-21')).toBe(false);
    expect(bodyCitesMarker('Resolves agent-stop-m1-21.', 'agent-stop-m1-212')).toBe(false);
    expect(bodyCitesMarker(null, 'agent-stop-m1-212')).toBe(false);
  });
  it('the candidate read asks gh only for real fields', () => {
    for (const f of AGENT_STOP_PR_JSON_FIELDS) expect(GH_PR_JSON_FIELDS).toContain(f);
  });
});

describe('evaluateReleaseCondition', () => {
  const run = (f: AgentStopFacts, runningVersion: string | null = '1.3.1640') =>
    evaluateReleaseCondition({ latchId: LATCH, origin: origin(), runningVersion, facts: f });

  it('is met when a citing PR merged after the stop is in the running release', async () => {
    const v = await run(facts([citing()]));
    expect(v.met).toBe(true);
    expect(v.evidence).toMatchObject({ pr: 2700, running: '1.3.1640' });
  });
  it('a merged fix that is not in the running release is not met', async () => {
    const v = await run(facts([citing()], 'not-contained'));
    expect(v).toMatchObject({ met: false, unverifiable: false });
  });
  it.each([
    ['merged before the stop', { mergedAt: '2026-11-03T11:59:00Z' }],
    ['merged at the same instant', { mergedAt: NOW }],
    ['no merge time', { mergedAt: null }],
    ['into another branch', { baseRefName: 'release-x' }],
    ['not merged', { state: 'OPEN' }],
    ['no merge commit', { mergeCommitOid: null }],
    ['a near-miss marker', { body: `Resolves ${MARKER}9` }],
    ['no marker (search only nominates)', { body: 'unrelated' }],
  ])('a PR %s does not count', async (_n, over) => {
    const v = await run(facts([citing(over as Partial<CitingPr>)]));
    expect(v).toMatchObject({ met: false, unverifiable: false });
  });
  it('no citing PR is not met', async () => { expect(await run(facts([]))).toMatchObject({ met: false, unverifiable: false }); });
  it('any qualifying PR is enough', async () => {
    const f: AgentStopFacts = { mergedPrsCiting: async () => [citing({ number: 1, mergeCommitOid: 'a' }), citing({ number: 2, mergeCommitOid: 'b' })], commitInReleaseTag: async (c) => (c === 'b' ? 'contained' : 'not-contained') };
    expect((await run(f)).evidence).toMatchObject({ pr: 2 });
  });
  it('a failed search is unverifiable, never met', async () => { expect(await run(facts(null))).toMatchObject({ met: false, unverifiable: true }); });
  it('a failed tag read is unverifiable, never met', async () => { expect(await run(facts([citing()], 'unreadable'))).toMatchObject({ met: false, unverifiable: true }); });
  it.each([[null], ['dev'], ['1.3']])('an unreadable running version (%s) is unverifiable', async (ver) => {
    expect(await run(facts([citing()]), ver as string | null)).toMatchObject({ met: false, unverifiable: true });
  });
});

describe('AgentStopSurfacer', () => {
  let dir: string;
  let now: number;
  let stops: StopView[];
  let posted: Array<{ id: string; priority: string; summary: string; sourceContext: string }>;
  let closed: string[];
  let woken: Array<{ topicId: number; brief: string }>;
  let commits: Array<{ id: string; externalKey?: string; status?: string }>;
  let deliver: ReturnType<typeof vi.fn>;
  let withdraw: ReturnType<typeof vi.fn>;
  let f: AgentStopFacts;

  const agentStop = (latchId = LATCH): StopView => ({ latchId, class: 'agent', origin: origin() });
  const surfacer = (over: object = {}) => new AgentStopSurfacer({
    stateDir: dir,
    listRollbackStops: () => stops,
    facts: f,
    runningVersion: () => '1.3.1640',
    now: () => now,
    commitments: {
      record: (input) => {
        const key = input.externalKey as string;
        const existing = commits.find((c) => c.externalKey === key);
        if (existing) return existing;
        const c = { id: `CMT-${commits.length + 1}`, externalKey: key };
        commits.push(c);
        return c;
      },
      getActive: () => commits,
      deliver,
      withdraw,
    },
    raiseAttention: async (item) => { posted.push(item); },
    closeAttention: (id) => { closed.push(id); },
    wakeTopic: async (topicId, brief) => { woken.push({ topicId, brief }); },
    ...over,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stop-'));
    now = NOW_MS + 60_000;
    stops = [];
    posted = [];
    closed = [];
    woken = [];
    commits = [];
    deliver = vi.fn((id: string) => { commits = commits.filter((c) => c.id !== id); });
    withdraw = vi.fn((id: string) => { commits = commits.filter((c) => c.id !== id); });
    f = facts([]);
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'agent-stop-release.test.ts' }); });

  it('repairs a missing commitment from the durable latch, and does not double it', async () => {
    stops = [agentStop()];
    const s = surfacer();
    await s.pass(); await s.pass();
    expect(commits).toHaveLength(1);
    expect(commits[0].externalKey).toBe(`green-pr-agent-stop:${LATCH}`);
  });

  it('a failing commitment store never throws out of ensureCommitment', () => {
    const s = surfacer({ commitments: { record: () => { throw new Error('disk'); }, getActive: () => [], deliver, withdraw } });
    expect(s.ensureCommitment(LATCH, origin())).toBeNull();
  });

  it('posts one agent-sourced notice on first sight and not again within a day', async () => {
    stops = [agentStop()];
    const s = surfacer();
    await s.pass(); await s.pass();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: `green-pr-agent-stop:${LATCH}`, priority: 'NORMAL', sourceContext: 'agent' });
    expect(posted[0].summary).toContain(CAUSE);
    now += 24 * 3_600_000 + 1;
    await s.pass();
    expect(posted).toHaveLength(2);
    expect(posted[1].summary).toMatch(/1 day/);
  });

  it('wakes the owning topic once when the condition is met, with no cause in the brief', async () => {
    stops = [agentStop()];
    f = facts([citing()]);
    const s = surfacer();
    await s.pass(); await s.pass();
    expect(woken).toHaveLength(1);
    expect(woken[0].topicId).toBe(18330);
    expect(woken[0].brief).toContain('/green-pr-automerge/release');
    expect(woken[0].brief).not.toContain(CAUSE);
    now += 24 * 3_600_000 + 1;
    await s.pass();
    expect(woken).toHaveLength(2);
  });

  it('does not wake a young unmet stop, wakes one at six hours, then daily', async () => {
    stops = [agentStop()];
    const s = surfacer();
    await s.pass();
    expect(woken).toHaveLength(0);
    now = NOW_MS + 6 * 3_600_000;
    await s.pass();
    expect(woken).toHaveLength(1);
    expect(woken[0].brief).toContain(MARKER);
    now += 3_600_000;
    await s.pass();
    expect(woken).toHaveLength(1);
    now += 24 * 3_600_000;
    await s.pass();
    expect(woken).toHaveLength(2);
  });

  it('turning met wakes at once even just after an unmet wake', async () => {
    stops = [agentStop()];
    now = NOW_MS + 6 * 3_600_000;
    const s = surfacer();
    await s.pass();
    expect(woken).toHaveLength(1);
    now += 60_000;
    (s as unknown as { deps: { facts: AgentStopFacts } }).deps.facts = facts([citing()]);
    await s.pass();
    expect(woken).toHaveLength(2);
    expect(woken[1].brief).toMatch(/now reads as resolved/);
  });

  it('a failed wake retries in an hour, not every pass', async () => {
    stops = [agentStop()];
    f = facts([citing()]);
    let calls = 0;
    const s = surfacer({ wakeTopic: async () => { calls += 1; throw new Error('spawn cap'); } });
    await s.pass();
    now += 10 * 60_000;
    await s.pass();
    expect(calls).toBe(1);
    now += 51 * 60_000;
    await s.pass();
    expect(calls).toBe(2);
  });

  it('a GitHub blip keeps the last known answer: no second wake, no restarted clock', async () => {
    stops = [agentStop()];
    let current = facts([citing()]);
    const s = surfacer({ facts: { mergedPrsCiting: (m: string) => current.mergedPrsCiting(m), commitInReleaseTag: (c: string, v: string) => current.commitInReleaseTag(c, v) } });
    await s.pass();
    expect(woken).toHaveLength(1);
    current = facts(null);
    now += 10 * 60_000;
    await s.pass();
    expect(s.conditionOf(LATCH).conditionMet).toBe(true);
    current = facts([citing()]);
    now += 10 * 60_000;
    await s.pass();
    expect(woken).toHaveLength(1);
    now += 45 * 60_000; // over an hour since it first read as met, blip included
    await s.pass();
    expect(posted.filter((p) => p.priority === 'HIGH')).toHaveLength(1);
  });

  it('a release during a pass does not reopen the notice or wake anyone', async () => {
    stops = [agentStop()];
    let finish: (v: CitingPr[]) => void = () => {};
    const s = surfacer({ facts: { mergedPrsCiting: () => new Promise<CitingPr[]>((r) => { finish = r; }), commitInReleaseTag: async () => 'contained' } });
    const running = s.pass();
    await new Promise((r) => setImmediate(r));
    s.onReleased(LATCH);
    finish([citing()]);
    await running;
    expect(woken).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('raises to HIGH only after the condition has read as met for an hour', async () => {
    stops = [agentStop()];
    f = facts([citing()]);
    const s = surfacer();
    await s.pass();
    now += 30 * 60_000;
    await s.pass();
    expect(posted.filter((p) => p.priority === 'HIGH')).toHaveLength(0);
    now += 31 * 60_000;
    await s.pass(); await s.pass();
    expect(posted.filter((p) => p.priority === 'HIGH')).toHaveLength(1);
  });

  it('posts an operator stop once, with the PIN, and gives it no commitment or wake', async () => {
    stops = [{ latchId: 'm1:5', class: 'operator', reason: 'bad merge' }];
    const s = surfacer();
    await s.pass();
    now += 3 * 24 * 3_600_000;
    await s.pass();
    expect(posted).toHaveLength(1);
    expect(posted[0].summary).toMatch(/PIN/);
    expect(commits).toHaveLength(0);
    expect(woken).toHaveLength(0);
  });

  it('says nothing about the console stop: the operator just pressed it', async () => {
    stops = [{ latchId: 'm1:6', class: 'operator', reason: CONSOLE_STOP_REASON }];
    await surfacer().pass();
    expect(posted).toHaveLength(0);
  });

  it('a stop that goes inactive has its loop closed', async () => {
    stops = [agentStop()];
    const s = surfacer();
    await s.pass();
    stops = [];
    await s.pass();
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(closed).toContain(`green-pr-agent-stop:${LATCH}`);
    expect(commits).toHaveLength(0);
  });

  it('a stray commitment for a stop that is gone gets withdrawn', async () => {
    commits = [{ id: 'CMT-9', externalKey: 'green-pr-agent-stop:m1:99' }, { id: 'CMT-10', externalKey: 'something-else' }];
    await surfacer().pass();
    expect(withdraw).toHaveBeenCalledWith('CMT-9', expect.any(String));
    expect(commits.map((c) => c.id)).toEqual(['CMT-10']);
  });

  it('release delivers the commitment; the PIN withdraws it', async () => {
    stops = [agentStop('m1:1'), agentStop('m1:2')];
    const s = surfacer();
    await s.pass();
    s.onReleased('m1:1');
    expect(deliver).toHaveBeenCalledTimes(1);
    s.onEnabled(['m1:2']);
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it('reports the last condition read without any network', async () => {
    stops = [agentStop()];
    f = facts([citing()]);
    const s = surfacer();
    expect(s.conditionOf(LATCH).conditionMet).toBeNull();
    await s.pass();
    expect(s.conditionOf(LATCH)).toMatchObject({ conditionMet: true, conditionEvidence: { pr: 2700 } });
  });

  it('a read that never returns neither hangs the pass nor stacks another', async () => {
    vi.useFakeTimers();
    try {
      stops = [agentStop()];
      let reads = 0;
      const never: AgentStopFacts = { mergedPrsCiting: () => { reads += 1; return new Promise(() => {}); }, commitInReleaseTag: async () => 'contained' };
      const s = surfacer({ facts: never });
      const first = s.pass();
      await vi.advanceTimersByTimeAsync(21_000);
      await first; // bounded: it resolved
      await s.pass(); // skipped, not stacked
      expect(reads).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('one stop\'s fault does not strand the next, and a long cause still posts', async () => {
    stops = [
      { latchId: 'm1:1', class: 'agent', origin: origin({ cause: 'x'.repeat(4000) }) },
      { latchId: 'm1:2', class: 'agent', origin: origin() },
    ];
    let calls = 0;
    const s = surfacer({ raiseAttention: async (item: { id: string; summary: string }) => { calls += 1; if (calls === 1) throw new Error('hub down'); posted.push(item as never); } });
    await s.pass();
    expect(posted.map((p) => p.id)).toEqual(['green-pr-agent-stop:m1:2']);
    await s.pass();
    expect(posted.map((p) => p.id)).toContain('green-pr-agent-stop:m1:1');
    expect(posted.find((p) => p.id.endsWith('m1:1'))!.summary.length).toBeLessThan(1000);
  });

  it('a throwing stop list never rejects the pass', async () => {
    await expect(surfacer({ listRollbackStops: () => { throw new Error('boom'); } }).pass()).resolves.toBeUndefined();
  });

  it('cadence memory survives a restart', async () => {
    stops = [agentStop()];
    await surfacer().pass();
    await surfacer().pass();
    expect(posted).toHaveLength(1);
  });
});
