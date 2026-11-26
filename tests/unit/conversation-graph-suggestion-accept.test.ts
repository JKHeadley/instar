/**
 * The one server Accept step (docs/specs/conversation-groups-phone.md §2), driven against a fake owner-change
 * pipeline that answers exactly as ConversationGraphOwnerChanges does. These are the dashboard's former
 * client-side step tests, now on the server both surfaces share:
 * - creates, names, previews and moves each conversation, then records the acceptance, in one call;
 * - a step still saving answers `working`; the next call resumes with the SAME request ids (one group, ever);
 * - a refused step stops the Accept and changes nothing after it;
 * - an existing name is kept, a conversation placed elsewhere is skipped (the owner's placement wins);
 * - a project's conversation becomes the front door, and one already inside another group creates nothing;
 * - a revoked owner gets `not-owner`; a finished Accept answers its result again; a rejected one is unknown.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationGraphSuggestionService, SUGGESTIONS_STATE_FILE, acceptRequestId } from '../../src/server/ConversationGraphSuggestionService.js';
import { suggestionCreateRequestId } from '../../src/core/ConversationGraphSuggestions.js';
import { runSuggestionAccept, type SuggestionAcceptPort } from '../../src/server/ConversationGraphSuggestionAccept.js';
import { nodeKey, type ConversationRef, type EffortRef, type NodeRef } from '../../src/core/conversationGraph.js';

const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId });
const effort: EffortRef = { kind: 'effort', id: '012fdaec-70de-4324-9ef3-22b616fc83ce' };
const viewer = { principalKey: 'owner:echo', grantVersion: 'g1', mayView: () => true, hasFullCorrectionScope: () => true };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-accept-')); });

function seed(suggestions: Array<{ id: string; title: string; members: ConversationRef[]; frontDoor?: ConversationRef }>, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(dir, SUGGESTIONS_STATE_FILE), JSON.stringify({ v: 1, builtAt: null, lastAttemptAt: new Date().toISOString(), lastFailure: null, rejected: {}, accepted: {}, accepting: {},
    suggestions: suggestions.map((s) => ({ id: s.id, title: s.title, reason: 'r', memberKeys: s.members.map(nodeKey), ...(s.frontDoor ? { frontDoorKey: nodeKey(s.frontDoor) } : {}),
      members: s.members.map((m) => ({ key: nodeKey(m), ref: m, title: 'x' })) })), ...extra }));
  return new ConversationGraphSuggestionService({ stateDir: dir, intelligence: null, evidence: () => ({ project: null, text: '' }) });
}

/** A small graph that commits each owner change at once unless `pending` says otherwise. */
function fakeGraph(opts: { ineligible?: number[]; placedElsewhere?: Record<number, EffortRef>; named?: boolean; pendingUntil?: (kind: string) => number; refuse?: (change: any) => any } = {}) {
  const parent = new Map<string, NodeRef>();
  for (const [t, e] of Object.entries(opts.placedElsewhere ?? {})) parent.set(nodeKey(tg(Number(t))), e);
  let headerVersion = opts.named ? 1 : 0; let frontDoor: ConversationRef | null = null; let created = false;
  const calls: Array<{ op: string; requestId?: string; change?: any }> = [];
  const polls = new Map<string, number>(); const changes = new Map<string, any>();
  const apply = (change: any) => {
    if (change.kind === 'create-effort') created = true;
    if (change.kind === 'set-effort-title') headerVersion = 1;
    if (change.kind === 'set-primary-placement') parent.set(nodeKey(change.subject), change.parent);
    if (change.kind === 'set-front-door') frontDoor = change.conversation;
  };
  const answer = (requestId: string) => {
    const change = changes.get(requestId);
    const n = polls.get(requestId) ?? 0;
    if (n < (opts.pendingUntil?.(change.kind) ?? 0)) return { status: 202, body: { state: 'saved-pending', requestId, waitingMachines: [{ machineId: 'm_laptop', name: 'Laptop' }] } };
    apply(change);
    return { status: 200, body: { state: 'committed', requestId, ...(change.kind === 'create-effort' ? { effort } : {}) } };
  };
  let owner = true;
  const port: SuggestionAcceptPort = {
    viewer: () => owner ? viewer : null,
    node: (ref) => {
      calls.push({ op: 'node' });
      if (!owner) return { status: 403, body: { code: 'hierarchy-owner-only' } };
      if (ref.kind === 'effort') return created ? { status: 200, body: { node: { ref, title: 'x', ...(frontDoor ? { frontDoor } : {}) }, path: [], children: { items: [] },
        correction: { moveEligible: true, replacesPlacementEventIds: [], headerVersion, headerForgotten: false, replacesFrontDoorEventIds: [] } } } : { status: 404, body: { code: 'not-found' } };
      const p = parent.get(nodeKey(ref));
      return { status: 200, body: { node: { ref, title: 'x' }, path: p ? [{ ref: p, title: 'g' }] : [], children: { items: [] },
        correction: { moveEligible: !(opts.ineligible ?? []).includes((ref as any).topicId), replacesPlacementEventIds: [`place-head-${(ref as any).topicId}`] } } };
    },
    submit: async (requestId, change) => {
      calls.push({ op: 'submit', requestId, change });
      const refused = opts.refuse?.(change); if (refused) return refused;
      if (!changes.has(requestId)) changes.set(requestId, change);
      return answer(requestId);
    },
    status: async (requestId) => {
      calls.push({ op: 'status', requestId });
      if (!changes.has(requestId)) return { status: 404, body: { code: 'request-not-found', requestState: 'not-recorded' } };
      polls.set(requestId, (polls.get(requestId) ?? 0) + 1); return answer(requestId);
    },
    preview: (change: any) => { calls.push({ op: 'preview', change }); return { status: 200, body: { eligible: !(opts.ineligible ?? []).includes(change.subject.topicId) } }; },
  };
  return { port, calls, revoke: () => { owner = false; }, frontDoorOf: () => frontDoor };
}

const instant = { sleep: async () => {}, pollMs: 1000 };
/** A clock that moves forward only when the accept sleeps, so the budget is exact. */
function clock() { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; }, pollMs: 1000 }; }

describe('runSuggestionAccept', () => {
  it('creates, names, previews and moves each conversation, then records the acceptance, in one call', async () => {
    const svc = seed([{ id: 'sg-0123456789abcdef0123', title: 'Conversations rollout', members: [tg(5), tg(6)] }]);
    const g = fakeGraph({ ineligible: [6] });
    const out = await runSuggestionAccept('sg-0123456789abcdef0123', svc, g.port, instant);
    expect(out).toEqual({ kind: 'accepted', group: effort, moved: 1, skipped: 1, placedElsewhere: false });
    const submitted = g.calls.filter((c) => c.op === 'submit').map((c) => c.change);
    expect(submitted).toEqual([
      { kind: 'create-effort', projectScope: [] },
      { kind: 'set-effort-title', effort, baseVersion: 0, title: 'Conversations rollout' },
      { kind: 'set-primary-placement', subject: tg(5), parent: effort, replacesPlacementEventIds: ['place-head-5'] },
    ]);
    expect(g.calls.filter((c) => c.op === 'preview')).toHaveLength(1); // the one the node read calls immovable is skipped unpreviewed
    // The create used the request id DERIVED from the suggestion, the same on every machine.
    expect(g.calls.find((c) => c.change?.kind === 'create-effort')!.requestId).toBe(acceptRequestId('sg-0123456789abcdef0123', 'create'));
    expect(svc.acceptTarget('sg-0123456789abcdef0123')).toEqual({ finished: { group: effort, moved: 1, skipped: 1, placedElsewhere: false } });
    // A second call answers the same result instead of "unknown".
    expect(await runSuggestionAccept('sg-0123456789abcdef0123', svc, g.port, instant)).toMatchObject({ kind: 'accepted', group: effort, moved: 1 });
  });

  it('answers working while a step is saving, and the next call resumes with the same request ids', async () => {
    const svc = seed([{ id: 'sg-0123456789abcdef0124', title: 'Secret group name', members: [tg(5), tg(7)] }]);
    let titleWaits = 100;
    const g = fakeGraph({ pendingUntil: (kind) => kind === 'set-effort-title' ? titleWaits : 0 });
    const c = clock();
    const first = await runSuggestionAccept('sg-0123456789abcdef0124', svc, g.port, { ...c, budgetMs: 5000 });
    expect(first).toMatchObject({ kind: 'working', step: 'naming', agentNotAnswering: false, waitingMachines: [{ machineId: 'm_laptop', name: 'Laptop' }] });
    expect((first as any).text).toBe('Naming it… Saved here. Waiting for Laptop to confirm.');
    const progress = svc.acceptProgress('sg-0123456789abcdef0124')!;
    expect(progress.effort).toEqual(effort);
    expect(JSON.stringify(progress)).not.toContain('Secret group name'); // only opaque ids and refs are kept
    titleWaits = 0;
    const second = await runSuggestionAccept('sg-0123456789abcdef0124', svc, g.port, { ...c, budgetMs: 5000 });
    expect(second).toMatchObject({ kind: 'accepted', moved: 2 });
    const submits = g.calls.filter((x) => x.op === 'submit');
    expect(submits.filter((x) => x.change.kind === 'create-effort')).toHaveLength(1);
    const titles = submits.filter((x) => x.change.kind === 'set-effort-title');
    expect(new Set(titles.map((x) => x.requestId)).size).toBe(1); // the resumed name reuses its request id
  });

  it('a refused step stops the Accept and changes nothing after it', async () => {
    const svc = seed([{ id: 'sg-0123456789abcdef0125', title: 'X', members: [tg(5), tg(6)] }]);
    const g = fakeGraph({ refuse: (change) => change.kind === 'create-effort' ? { status: 409, body: { code: 'project-scope-conflict', requestState: 'not-recorded' } } : null });
    const out = await runSuggestionAccept('sg-0123456789abcdef0125', svc, g.port, instant);
    expect(out).toMatchObject({ kind: 'refused', step: 'creating', code: 'project-scope-conflict' });
    expect(g.calls.filter((c) => c.op === 'submit')).toHaveLength(1);
    expect(g.calls.some((c) => c.op === 'preview')).toBe(false);
  });

  it('keeps an existing name and skips a conversation the owner placed elsewhere', async () => {
    const other: EffortRef = { kind: 'effort', id: '77777777-70de-4324-9ef3-22b616fc83ce' };
    const svc = seed([{ id: 'sg-0123456789abcdef0126', title: 'Y', members: [tg(5), tg(6)] }]);
    const g = fakeGraph({ named: true, placedElsewhere: { 6: other } });
    const out = await runSuggestionAccept('sg-0123456789abcdef0126', svc, g.port, instant);
    expect(out).toMatchObject({ kind: 'accepted', moved: 1, skipped: 1 });
    expect(g.calls.some((c) => c.change?.kind === 'set-effort-title')).toBe(false);
    expect(g.calls.some((c) => c.change?.kind === 'set-primary-placement' && c.change.subject.topicId === 6)).toBe(false);
  });

  it('a project: its conversation is moved in and becomes the front door', async () => {
    const svc = seed([{ id: 'sg-0123456789abcdef0127', title: 'Project: C', members: [tg(12)], frontDoor: tg(12) }]);
    const g = fakeGraph();
    const out = await runSuggestionAccept('sg-0123456789abcdef0127', svc, g.port, instant);
    expect(out).toMatchObject({ kind: 'accepted', group: effort, moved: 1, placedElsewhere: false });
    expect(g.frontDoorOf()).toEqual(tg(12));
    const fd = g.calls.find((c) => c.change?.kind === 'set-front-door')!.change;
    expect(fd).toEqual({ kind: 'set-front-door', effort, conversation: tg(12), replacesFrontDoorEventIds: [], observedPlacementEventIds: ['place-head-12'] });
  });

  it('a project whose conversation is already inside another group creates nothing', async () => {
    const other: EffortRef = { kind: 'effort', id: '77777777-70de-4324-9ef3-22b616fc83ce' };
    const svc = seed([{ id: 'sg-0123456789abcdef0128', title: 'Project: B', members: [tg(11)], frontDoor: tg(11) }]);
    const g = fakeGraph({ placedElsewhere: { 11: other } });
    const out = await runSuggestionAccept('sg-0123456789abcdef0128', svc, g.port, instant);
    expect(out).toEqual({ kind: 'accepted', group: null, moved: 0, skipped: 1, placedElsewhere: true });
    expect(g.calls.some((c) => c.op === 'submit')).toBe(false);
    expect(svc.acceptProgress('sg-0123456789abcdef0128')).toBeNull();
  });

  it('refuses a revoked owner, and treats a rejected or unknown suggestion as unknown', async () => {
    const svc = seed([{ id: 'sg-0123456789abcdef0129', title: 'Z', members: [tg(1), tg(2)] }]);
    const g = fakeGraph(); g.revoke();
    expect(await runSuggestionAccept('sg-0123456789abcdef0129', svc, g.port, instant)).toEqual({ kind: 'not-owner' });
    const g2 = fakeGraph();
    expect(svc.reject('sg-0123456789abcdef0129')).toBe(true);
    expect(await runSuggestionAccept('sg-0123456789abcdef0129', svc, g2.port, instant)).toEqual({ kind: 'unknown' });
    expect(await runSuggestionAccept('sg-ffffffffffffffffffff', svc, g2.port, instant)).toEqual({ kind: 'unknown' });
    expect(g2.calls.some((c) => c.op === 'submit')).toBe(false);
  });

  it('an agent that does not answer is a wait, never a refusal', async () => {
    const svc = seed([{ id: 'sg-0123456789abcdef012a', title: 'W', members: [tg(1), tg(2)] }]);
    const g = fakeGraph();
    g.port.submit = async () => ({ status: 503, body: { code: 'conversation-graph-unavailable' } });
    g.port.status = async () => ({ status: 503, body: { code: 'conversation-graph-unavailable' } });
    const c = clock();
    const out = await runSuggestionAccept('sg-0123456789abcdef012a', svc, g.port, { ...c, budgetMs: 3000 });
    expect(out).toMatchObject({ kind: 'working', step: 'creating', agentNotAnswering: true });
    // The create was sent, so Reject is refused from here on (the group may exist on a machine that did answer).
    expect(svc.acceptStarted('sg-0123456789abcdef012a')).toBe(true);
  });

  it('a handed-back Accept stays handed back even when an Accept row reappears (replicated decisions), until the owner Accepts again', async () => {
    const id = 'sg-0123456789abcdef0a4e';
    const svc = seed([{ id, title: 'W', members: [tg(1)] }]);
    expect(acceptRequestId(id, 'create')).toBe(suggestionCreateRequestId(id)); // the id CMT-1650 (#3345) derives too
    svc.beginAccept(id);
    svc.dropAccept(id);
    expect(svc.acceptStarted(id)).toBe(false);
    // Another machine's shared Accept row shows up in this machine's view (#3345's overlay):
    const file = path.join(dir, SUGGESTIONS_STATE_FILE);
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    st.accepting[id] = { createRequestId: suggestionCreateRequestId(id), startedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(st));
    expect(svc.acceptStarted(id)).toBe(false); // Reject still works
    svc.beginAccept(id); // the owner taps Accept again
    expect(svc.acceptStarted(id)).toBe(true);
  });

  it('two machines with separate state files send the SAME owner requests for the same suggestion', async () => {
    const id = 'sg-0123456789abcdef0bbb';
    const a = seed([{ id, title: 'W', members: [tg(1), tg(2)] }]);
    const ga = fakeGraph({ pendingUntil: (kind) => kind === 'set-primary-placement' ? 99 : 0 });
    await runSuggestionAccept(id, a, ga.port, { ...clock(), budgetMs: 2500 });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-accept-b-'));
    const b = seed([{ id, title: 'W', members: [tg(1), tg(2)] }]);
    const gb = fakeGraph({ pendingUntil: (kind) => kind === 'set-primary-placement' ? 99 : 0 });
    await runSuggestionAccept(id, b, gb.port, { ...clock(), budgetMs: 2500 });
    const ids = (g: ReturnType<typeof fakeGraph>) => g.calls.filter((c) => c.op === 'submit').map((c) => c.requestId);
    expect(ids(ga).length).toBeGreaterThan(1);
    expect(ids(gb)).toEqual(ids(ga));
  });

  it('a submit that never returns still answers working inside the budget', async () => {
    const svc = seed([{ id: 'sg-0123456789abcdef0ccc', title: 'W', members: [tg(1)] }]);
    const g = fakeGraph();
    g.port.submit = () => new Promise(() => {});
    const started = Date.now();
    const out = await runSuggestionAccept('sg-0123456789abcdef0ccc', svc, g.port, { budgetMs: 200, pollMs: 50 });
    expect(out).toMatchObject({ kind: 'working', step: 'creating' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a group removed before the Accept finished closes the suggestion instead of waiting forever', async () => {
    const id = 'sg-0123456789abcdef0ddd';
    const svc = seed([{ id, title: 'W', members: [tg(1)] }]);
    const g = fakeGraph();
    const realNode = g.port.node;
    let erased = false;
    g.port.node = (ref) => (erased && ref.kind === 'effort' ? { status: 404, body: { code: 'not-found' } } : realNode(ref));
    const realSubmit = g.port.submit;
    g.port.submit = async (rid, change) => { const r = await realSubmit(rid, change); if (change.kind === 'create-effort') erased = true; return r; };
    // Never seen on this machine: a missing group is not proof of removal. It waits; after 3 misses spanning
    // 30 s the owner gets the decision back (Accept again or Reject), and nothing is closed.
    const c = clock();
    expect(await runSuggestionAccept(id, svc, g.port, c)).toMatchObject({ kind: 'working' });
    expect(await runSuggestionAccept(id, svc, g.port, c)).toMatchObject({ kind: 'working' });
    expect(await runSuggestionAccept(id, svc, g.port, c)).toMatchObject({ kind: 'working' }); // 3 misses, but not yet 30 s
    await c.sleep(31_000);
    expect(await runSuggestionAccept(id, svc, g.port, c)).toMatchObject({ kind: 'refused', code: 'group-not-found' });
    expect(svc.acceptStarted(id)).toBe(false); // Reject works again
    expect(svc.acceptTarget(id)).not.toBeNull(); // still offered: nothing was closed on a missing read
  });

  it('a create the owner erased closes the suggestion; any other refused create lets Reject work again', async () => {
    const a = seed([{ id: 'sg-0123456789abcdef0a0a', title: 'W', members: [tg(1)] }]);
    const ga = fakeGraph({ refuse: (change) => change.kind === 'create-effort' ? { status: 200, body: { state: 'erased' } } : null });
    expect(await runSuggestionAccept('sg-0123456789abcdef0a0a', a, ga.port, instant)).toMatchObject({ kind: 'refused', code: 'group-gone' });
    expect(a.acceptTarget('sg-0123456789abcdef0a0a')).toBeNull();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-accept-c-'));
    const b = seed([{ id: 'sg-0123456789abcdef0b0b', title: 'W', members: [tg(1)] }]);
    const gb = fakeGraph({ refuse: (change) => change.kind === 'create-effort' ? { status: 409, body: { code: 'project-scope-conflict' } } : null });
    expect(await runSuggestionAccept('sg-0123456789abcdef0b0b', b, gb.port, instant)).toMatchObject({ kind: 'refused', step: 'creating' });
    expect(b.acceptStarted('sg-0123456789abcdef0b0b')).toBe(false);
  });

  it('keeps a front door the owner chose, and skips it when its conversation left the group', async () => {
    const id = 'sg-0123456789abcdef0c0c';
    const svc = seed([{ id, title: 'P', members: [tg(5)], frontDoor: tg(5) }]);
    const g = fakeGraph();
    const realNode = g.port.node;
    const other = tg(9);
    g.port.node = (ref) => {
      const r = realNode(ref);
      if (ref.kind === 'effort' && r.status === 200) return { ...r, body: { ...r.body, node: { ...(r.body.node as object), frontDoor: other } } };
      return r;
    };
    const out = await runSuggestionAccept(id, svc, g.port, instant);
    expect(out).toMatchObject({ kind: 'accepted', moved: 1 });
    expect(g.calls.some((c) => c.change?.kind === 'set-front-door')).toBe(false);
  });

  it('a submit that never settles is not joined forever: a later call sends a fresh one', async () => {
    const id = 'sg-0123456789abcdef0e0f';
    const svc = seed([{ id, title: 'W', members: [tg(1)] }]);
    const g = fakeGraph();
    const realSubmit = g.port.submit;
    let first = true;
    g.port.submit = (rid, change) => { if (first) { first = false; return new Promise(() => {}); } return realSubmit(rid, change); };
    const spy = vi.spyOn(Date, 'now');
    const t0 = Date.now();
    spy.mockReturnValue(t0);
    expect(await runSuggestionAccept(id, svc, g.port, { budgetMs: 100, pollMs: 20 })).toMatchObject({ kind: 'working' });
    spy.mockReturnValue(t0 + 61_000);
    const out = await runSuggestionAccept(id, svc, g.port, { ...instant, now: () => 0 });
    spy.mockRestore();
    expect(out).toMatchObject({ kind: 'accepted' });
  });

  it('a group removed after it was named is caught on the next call, never recorded as accepted', async () => {
    const id = 'sg-0123456789abcdef0d0d';
    const svc = seed([{ id, title: 'W', members: [tg(1), tg(2)] }]);
    const g = fakeGraph({ pendingUntil: (kind) => kind === 'set-primary-placement' ? 99 : 0 });
    expect(await runSuggestionAccept(id, svc, g.port, { ...clock(), budgetMs: 2500 })).toMatchObject({ kind: 'working', step: 'moving' });
    const realNode = g.port.node;
    g.port.node = (ref) => (ref.kind === 'effort' ? { status: 404, body: { code: 'not-found' } } : realNode(ref));
    // A missing read alone is not removal: only the pipeline saying the create was erased closes it.
    expect(await runSuggestionAccept(id, svc, g.port, { ...clock(), budgetMs: 2500 })).toMatchObject({ kind: 'working' });
    const realStatus = g.port.status;
    g.port.status = async (rid) => rid === acceptRequestId(id, 'create') ? { status: 200, body: { state: 'erased', requestId: rid } } : realStatus(rid);
    expect(await runSuggestionAccept(id, svc, g.port, instant)).toMatchObject({ kind: 'refused', code: 'group-gone' });
    expect(svc.acceptTarget(id)).toBeNull();
  });

  it('a refused name or front door does not strand the group: the Accept finishes without it', async () => {
    const id = 'sg-0123456789abcdef0a1b';
    const svc = seed([{ id, title: 'P', members: [tg(5)], frontDoor: tg(5) }]);
    const g = fakeGraph({ refuse: (change) => change.kind === 'set-effort-title' || change.kind === 'set-front-door' ? { status: 409, body: { code: 'front-door-ineligible', requestState: 'not-recorded' } } : null });
    expect(await runSuggestionAccept(id, svc, g.port, instant)).toMatchObject({ kind: 'accepted', moved: 1 });
  });

  it('after 5 minutes without a step finishing it says so plainly, keeping progress for Continue', async () => {
    const id = 'sg-0123456789abcdef0a2c';
    const svc = seed([{ id, title: 'W', members: [tg(1)] }]);
    const g = fakeGraph({ pendingUntil: (kind) => kind === 'set-primary-placement' ? 9999 : 0 });
    const c = clock();
    // The client keeps calling every 3 s; no step finishes.
    let out = await runSuggestionAccept(id, svc, g.port, { ...c, budgetMs: 2500 });
    expect(out).toMatchObject({ kind: 'working', step: 'moving' });
    for (let i = 0; i < 200 && out.kind === 'working'; i++) { await c.sleep(3000); out = await runSuggestionAccept(id, svc, g.port, { ...c, budgetMs: 2500 }); }
    expect(out).toMatchObject({ kind: 'refused', code: 'still-saving' });
    expect(svc.acceptStarted(id)).toBe(true); // progress kept: Continue resumes
    // Time away does not count: the owner comes back an hour later and the clock starts again.
    await c.sleep(60 * 60_000);
    expect(await runSuggestionAccept(id, svc, g.port, { ...c, budgetMs: 2500 })).toMatchObject({ kind: 'working' });
  });

  it('a project whose conversation sits in THIS suggestion\'s own group (another machine got that far) is resumed, not called placed elsewhere', async () => {
    const id = 'sg-0123456789abcdef0a3d';
    const a = seed([{ id, title: 'P', members: [tg(5), tg(6)], frontDoor: tg(5) }]);
    const g = fakeGraph({ pendingUntil: (kind) => kind === 'set-primary-placement' ? 0 : 0 });
    // Machine A creates the group and moves the project's conversation, then stops.
    await runSuggestionAccept(id, a, g.port, instant);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-accept-d-'));
    const b = seed([{ id, title: 'P', members: [tg(5), tg(6)], frontDoor: tg(5) }]);
    const out = await runSuggestionAccept(id, b, g.port, instant);
    expect(out).toMatchObject({ kind: 'accepted', group: effort, placedElsewhere: false });
  });

  it('a project already placed elsewhere is recorded, so a repeat answers the same', async () => {
    const id = 'sg-0123456789abcdef0f0f';
    const svc = seed([{ id, title: 'P', members: [tg(7)], frontDoor: tg(7) }]);
    const g = fakeGraph({ placedElsewhere: { 7: { kind: 'effort', id: '11111111-2222-4333-8444-555555555555' } } });
    expect(await runSuggestionAccept(id, svc, g.port, instant)).toMatchObject({ kind: 'accepted', placedElsewhere: true });
    expect(svc.acceptTarget(id)).toEqual({ finished: { group: null, moved: 0, skipped: 1, placedElsewhere: true } });
  });

  it('a refused move that another path already made counts as moved, not skipped', async () => {
    const id = 'sg-0123456789abcdef0eee';
    const svc = seed([{ id, title: 'W', members: [tg(1)] }]);
    let g: ReturnType<typeof fakeGraph>;
    g = fakeGraph({ refuse: (change) => {
      if (change.kind !== 'set-primary-placement') return null;
      // Another tab put it in the group first; this request is refused as stale.
      (g as any).landed = true;
      return { status: 409, body: { code: 'stale-placement', requestState: 'not-recorded' } };
    } });
    const realNode = g.port.node;
    g.port.node = (ref) => {
      if ((g as any).landed && ref.kind === 'conversation') return { status: 200, body: { node: { ref, title: 'x' }, path: [{ ref: effort, title: 'W' }], children: { items: [] }, correction: { moveEligible: true, replacesPlacementEventIds: ['p'] } } };
      return realNode(ref);
    };
    expect(await runSuggestionAccept(id, svc, g.port, instant)).toMatchObject({ kind: 'accepted', moved: 1, skipped: 0 });
  });
});
