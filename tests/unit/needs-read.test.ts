/**
 * The Needs-you read (docs/specs/work-front-doors.md decision 2, §7 stage 1): one server answer built
 * from exactly what Home counts, filtered per viewer, honest about what it could not check.
 */
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { summarizeHealth } from '../../src/monitoring/healthIssues.js';
import { describe, it, expect } from 'vitest';
import { mountNeedsRoutes, needsViewer, teamMayReadBoard, NeedsCanary, NEEDS_CANARY_MISSES_TO_NOTICE, createNeedsComposer, consoleResult, NEED_SOURCE_LABELS, NEED_SOURCE_POSTURE, resolveConsoleDir, NEEDS_MAX_ITEMS, type NeedsSelfRead } from '../../src/server/needsRoutes.js';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const NOW = Date.parse('2026-11-15T05:00:00Z');
const iso = (mins: number) => new Date(NOW + mins * 60000).toISOString();

const board = (cards: Array<{ id: string; title: string }>) => ({
  lanes: [
    { lane: 'waiting-on-you', cards: cards.map((c) => ({ id: c.id, title: c.title, needLine: 'Needs your approval before the agent starts', lane: 'waiting-on-you', status: 'needs-approval' })) },
    { lane: 'with-agent', cards: [] }, { lane: 'waiting-on-others', cards: [] }, { lane: 'done', cards: [], total: 0 }, { lane: 'archived', cards: [] },
  ],
  waitingOnYou: cards.length, policy: 'every-agent-card', behind: null, settings: { softOpenCards: 30 },
});

/** Every Home read answers 503 (switched off) unless named here. */
function reader(over: Record<string, NeedsSelfRead>, seen: string[] = []) {
  return async (p: string): Promise<NeedsSelfRead> => { seen.push(p); return over[p] ?? { status: 503, body: { error: 'off' } }; };
}
const composer = (over: Record<string, NeedsSelfRead>, seen?: string[]) => createNeedsComposer({ read: reader(over, seen), consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self', now: () => NOW });

const attention = (items: unknown[]) => ({ status: 200, body: { items } });

describe('needs read: the console models run on the server', () => {
  it('finds the console directory from the source layout', () => {
    expect(resolveConsoleDir()).toBe(CONSOLE);
  });

  it('every source and Home read has a plain label and a declared multi-machine posture', async () => {
    const { NEED_SOURCES } = await import(path.join(CONSOLE, 'needs-model.js'));
    for (const s of NEED_SOURCES) {
      expect(NEED_SOURCE_LABELS[s.id], `label for ${s.id}`).toBeTruthy();
      expect(NEED_SOURCE_POSTURE[s.id], `posture for ${s.id}`).toBeTruthy();
      expect(NEED_SOURCE_POSTURE[s.id].why.length).toBeGreaterThan(10);
    }
    for (const id of ['attention', 'promises']) expect(NEED_SOURCE_POSTURE[id]).toBeTruthy();
  });

  it('maps a self-read to the console result shape (503 = off, 0 = unreachable)', () => {
    expect(consoleResult({ status: 503, body: {} })).toEqual({ ok: false, reason: 'switched off on this agent' });
    expect(consoleResult({ status: 0, body: null })).toMatchObject({ ok: false });
    expect(consoleResult({ status: 500, body: {} })).toEqual({ ok: false, reason: 'the server answered 500' });
    expect(consoleResult({ status: 200, body: { a: 1 } })).toEqual({ ok: true, data: { a: 1 } });
  });
});

describe('needs read: the owner', () => {
  it('counts only admitted owner cards and emits one in-place action without navigation', async () => {
    const work = board([
      { id: 'wc_0123456789abcdef', title: 'One real approval' },
      { id: 'wc_1111111111111111', title: 'Agent cleanup' },
      { id: 'wc_2222222222222222', title: 'Dashboard referral' },
      { id: 'wc_3333333333333333', title: 'Open the dashboard to finish' },
    ]);
    const read = reader({ '/work-board': { status: 200, body: work } });
    let owned = true;
    const strict = createNeedsComposer({
      read, consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self',
      ownerCardCandidate: item => ({
        responsibility: item.title === 'Agent cleanup' ? 'agent' : 'owner-required',
        ownerAction: 'approve',
        actions: [{ kind: 'approval', requestId: 'approval-1' }],
        presentation: item.title === 'One real approval' ? 'trust-change' : undefined,
        verifiesCurrentOwnerRequest: action => owned && action.kind === 'approval' && action.requestId === 'approval-1',
        handoffs: item.title === 'Dashboard referral' ? ['/dashboard'] : [],
      }),
    });
    const result = await strict.owner();
    expect(result.count).toBe(1);
    expect(result.divertedCount).toBe(1);
    expect(result.notes).toContain('Some requests are temporarily unavailable.');
    expect(result.complete).toBe(false);
    expect(result.items[0]).toMatchObject({ title: 'Review a trust change', ownerAction: 'approve', action: { kind: 'approval', requestId: 'approval-1' } });
    expect(result.items[0]).not.toHaveProperty('card');
    expect(result.items[0]).not.toHaveProperty('alsoOpens');
    expect(JSON.stringify(result.items)).not.toContain('#/');
    owned = false;
    const reassigned = await strict.owner();
    expect(reassigned.items).toEqual([]);
    expect(reassigned.count).toBe(0);
    expect(reassigned.divertedCount).toBe(1);
  });

  it('does not admit an internal Work Board row carrying a typed no-action declaration', async () => {
    const work = board([{ id: 'wc_0123456789abcdef', title: 'Legacy recommendation' }]);
    Object.assign(work.lanes[0].cards[0], { ownerAction: false });
    const strict = createNeedsComposer({
      read: reader({ '/work-board': { status: 200, body: work } }),
      consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self',
      ownerCardCandidate: () => ({
        responsibility: 'owner-required', ownerAction: 'approve',
        actions: [{ kind: 'approval', requestId: 'unexpected' }],
        handoffs: [], presentation: 'trust-change', verifiesCurrentOwnerRequest: () => true,
      }),
    });
    expect(await strict.owner()).toMatchObject({ count: 0, items: [], divertedCount: 1 });
  });

  it('counts repository inventory as agent work without trying to turn it into an approval', async () => {
    const repo = { key: 'repos:no-remote:m_self', machineId: 'm_self', title: 'Repository without a backup copy', kind: 'no-remote', repos: ['example'] };
    let calls = 0;
    const strict = createNeedsComposer({
      read: reader({ '/repos?scope=pool': { status: 200, body: { defects: [repo] } } }),
      consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self',
      ownerCardCandidate: () => { calls++; return undefined; },
    });
    expect(await strict.owner()).toMatchObject({ count: 0, items: [], divertedCount: 1 });
    expect(calls).toBe(0);
  });

  it('admits the current same-source row after an earlier copy was held', async () => {
    const id = 'wc_0123456789abcdef';
    const strict = createNeedsComposer({
      read: reader({ '/work-board': { status: 200, body: board([{ id, title: 'Earlier ask' }, { id, title: 'Current ask' }]) } }),
      consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self',
      ownerCardCandidate: item => ({
        responsibility: 'owner-required', ownerAction: 'approve',
        actions: [{ kind: 'approval', requestId: item.title === 'Current ask' ? 'current' : 'earlier' }],
        handoffs: [], presentation: 'trust-change',
        verifiesCurrentOwnerRequest: action => action.kind === 'approval' && action.requestId === 'current',
      }),
    });
    const result = await strict.owner();
    expect(result.items).toEqual([expect.objectContaining({ action: { kind: 'approval', requestId: 'current' } })]);
    expect(result.divertedCount).toBe(0);
  });

  it('reports unavailable peer promises even when the local count is finite', async () => {
    const strict = createNeedsComposer({
      read: reader({
        '/commitments?scope=mesh': { status: 200, body: { scope: 'mesh', commitments: [] } },
        '/pool': { status: 200, body: { selfMachineId: 'm_self', machines: [{ machineId: 'm_peer' }] } },
      }),
      consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self', ownerCardCandidate: () => null,
    });
    const result = await strict.owner();
    expect(result.count).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.couldNotCheck).toContain('promises on other machines');
  });

  it('resolves concurrent in-place reads separately for each request', async () => {
    const app = express();
    const work = board([{ id: 'wc_0123456789abcdef', title: 'Approval requiring a device' }]);
    mountNeedsRoutes(app, {
      read: reader({ '/work-board': { status: 200, body: work } }),
      bearerOk: () => true,
      boardFor: () => { throw new Error('unexpected team read'); },
      consoleDir: CONSOLE,
      agentName: () => 'Echo',
      machineId: () => 'm_self',
      ownerCardCandidate: async (_item, req) => {
        const fixture = req?.get('X-Fixture-Principal');
        if (fixture === 'other-device') return null;
        return {
          responsibility: 'owner-required',
          ownerAction: 'approve',
          actions: [{ kind: 'approval', requestId: 'current-approval' }],
          handoffs: [],
          presentation: 'trust-change',
          verifiesCurrentOwnerRequest: action => {
            if (fixture === 'source-failure') throw new Error('fixture source unavailable');
            return fixture !== 'stale' && action.kind === 'approval' && action.requestId === 'current-approval';
          },
        };
      },
    });
    const read = (principal: string) => request(app).get('/needs')
      .set('X-Instar-Needs-Contract', 'in-place-v1').set('X-Fixture-Principal', principal);
    const [eligible, other] = await Promise.all([read('eligible-device'), read('other-device')]);
    expect(eligible.status).toBe(200);
    expect(eligible.body.items).toEqual([expect.objectContaining({ title: 'Review a trust change' })]);
    expect(other.status).toBe(200);
    expect(other.body.items).toEqual([]);
    expect(other.body.divertedCount).toBe(0);
    const [stale, failed] = await Promise.all([read('stale'), read('source-failure')]);
    expect(stale.body.items).toEqual([]);
    expect(stale.body.notes).not.toContain('Some requests are temporarily unavailable.');
    expect(stale.body.couldNotCheckApprovalCount).toBe(0);
    expect(failed.body.items).toEqual([]);
    expect(failed.body.notes).toContain("Couldn't check one approval.");
    expect(failed.body.couldNotCheckApprovalCount).toBe(1);
    expect(failed.body.divertedCount).toBe(0);
  });

  it('reports scheduled launches and explicit asks but no approval for unscheduled tracking', async () => {
    const base = { kind: 'project', status: 'active', autoAdvance: false, lastTouchedAt: iso(0),
      phases: [], currentPhaseIndex: 0, rounds: [{ name: 'First step', status: 'pending', itemIds: [] }] };
    const items = [
      { ...base, id: 'tracking', title: 'Tracking only' },
      { ...base, id: 'scheduled', title: 'Scheduled launch', rounds: [{ ...base.rounds[0], autoAdvanceAt: iso(5) }] },
      { ...base, id: 'explicit', title: 'Choose the layout', needsUser: true, needsUserReason: 'Pick a layout' },
    ];
    const result = await composer({ '/initiatives': { status: 200, body: { items, count: items.length } }, '/blockers': { status: 200, body: { entries: [], total: 0 } } }).owner();
    const plans = result.items.filter(r => r.source === 'plans');
    expect(plans.map(r => r.title)).toEqual(expect.arrayContaining(['Scheduled launch', 'Choose the layout']));
    expect(plans).toHaveLength(2);
    expect(plans.find(r => r.title === 'Choose the layout')?.why).toContain('Pick a layout');
  });

  it('a complete read with nothing waiting is complete and zero (the only case a strip may hide)', async () => {
    const a = await composer({ '/attention?scope=pool&status=OPEN': attention([]), '/commitments?scope=mesh': { status: 200, body: { commitments: [], scope: 'mesh' } }, '/pool': { status: 200, body: { machines: [], selfMachineId: 'm_self' } } }).owner();
    expect(a.count).toBe(0);
    expect(a.items).toEqual([]);
    expect(a.complete).toBe(true);
    expect(a.couldNotCheck).toEqual([]);
    expect(a.schemaVersion).toBe(1);
    expect(a.agent.name).toBe('Echo');
  });

  it('lists an undelivered trust request as a stable owner need and keeps expiry and closed states honest', async () => {
    const pending = { requestId: 'tr-board-policy', changeKind: 'board-policy', status: 'open', adapter: 'telegram', delivered: false, summary: ['Start internal Work Board cards.'], expiresAt: iso(60) };
    const a = await composer({ '/trust/requests': { status: 200, body: { requests: [pending, { ...pending, requestId: 'old', expiresAt: iso(-1) }, { ...pending, requestId: 'closed', status: 'consumed' }], approvalDelivery: { state: 'accepted', message: 'Review this in Changes to approve in Instar.' } } } }).owner();
    expect(a.items.filter(i => i.source === 'trust-requests')).toHaveLength(1);
    expect(a.items.find(i => i.source === 'trust-requests')).toMatchObject({ id: 'need:trust:tr-board-policy',
      title: 'Review how the agent starts work cards', action: { kind: 'href', href: '#/settings/allowed?s=approvals&request=tr-board-policy' } });
    expect(a.items.find(i => i.source === 'trust-requests')!.why).toContain('unconfirmed');
    expect(a.sources.find(i => i.id === 'trust-requests')).toMatchObject({ posture: 'replicated', state: 'ok' });
  });

  it('does not let an undeclared attention row mask an exact trust approval', async () => {
    const source = {
      requestId: 'tr-board-policy', changeKind: 'board-policy', status: 'open', adapter: 'device',
      delivered: true, summary: ['Start internal Work Board cards.'], expiresAt: iso(60),
    };
    const responses = {
      '/attention?scope=pool&status=OPEN': attention([
        { id: 'maintenance', title: 'Maintenance related to tr-board-policy', priority: 'URGENT', status: 'OPEN', updatedAt: iso(-1) },
      ]),
      '/trust/requests': { status: 200, body: { requests: [source] } },
    };
    const result = await createNeedsComposer({
      read: reader(responses), consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self', now: () => NOW,
      ownerCardCandidate: item => item.source === 'trust-requests' ? {
        responsibility: 'owner-required', ownerAction: 'approve',
        actions: [{ kind: 'approval', requestId: source.requestId }],
        handoffs: [], presentation: 'trust-change', verifiesCurrentOwnerRequest: () => true,
      } : undefined,
    }).owner();
    expect(result.divertedCount).toBe(1);
    expect(result.items).toEqual([expect.objectContaining({
      source: 'trust-requests', action: { kind: 'approval', requestId: source.requestId },
    })]);
  });

  it('an unreadable trust source is named rather than silently empty', async () => {
    for (const result of [{ status: 500, body: {} }, { status: 200, body: {} }]) {
      const a = await composer({ '/trust/requests': result }).owner();
      expect(a.complete).toBe(false);
      expect(a.couldNotCheck).toContain('changes waiting for approval');
    }
  });

  it('a failed source is never a zero: the read is incomplete and names it', async () => {
    const a = await composer({
      '/attention?scope=pool&status=OPEN': attention([]), '/commitments?scope=mesh': { status: 200, body: { commitments: [] } },
      '/work-board': { status: 500, body: {} },
    }).owner();
    expect(a.count).toBe(0);
    expect(a.complete).toBe(false);
    expect(a.couldNotCheck).toContain('the work board');
    expect(a.sources.find((s) => s.id === 'workBoard')).toMatchObject({ state: 'failed', posture: 'replicated' });
  });

  it('plan tracking switched off is nothing waiting, not "could not check", even when blockers answer', async () => {
    const a = await composer({ '/attention?scope=pool&status=OPEN': attention([]), '/commitments?scope=mesh': { status: 200, body: { commitments: [] } }, '/blockers': { status: 200, body: { entries: [], total: 0 } } }).owner();
    expect(a.couldNotCheck).not.toContain('plans');
    expect(a.sources.find((s) => s.id === 'plans')?.state).not.toBe('failed');
  });

  it('the attention queue failing is incomplete too', async () => {
    const a = await composer({ '/attention?scope=pool&status=OPEN': { status: 0, body: null } }).owner();
    expect(a.complete).toBe(false);
    expect(a.couldNotCheck).toContain('the attention queue');
  });

  it('a Chief of Staff wait and its wait card are one item that opens the card, counted once (needs-one-list)', async () => {
    const cos = { status: 200, body: { lease: { live: true, expiresAt: iso(60 * 24 * 5) }, projects: [
      { conversationKey: 'telegram:134088', title: 'Instar App', lastVerdict: 'waiting-on-user' },
      { conversationKey: 'telegram:555', title: 'No card yet', lastVerdict: 'waiting-on-user' },
    ] } };
    const wb = board([]);
    wb.lanes[0].cards = [{ id: 'wc_a02a192893e38e60', title: 'Instar App looks done and needs your OK', needLine: 'Yours to do', lane: 'waiting-on-you', status: 'with-person', covers: ['cos:waiting:telegram:134088'], serverOwned: true, createdAt: iso(-30) } as never];
    const a = await composer({
      '/attention?scope=pool&status=OPEN': attention([]), '/commitments?scope=mesh': { status: 200, body: { commitments: [] } },
      '/chief-of-staff': cos, '/work-board': { status: 200, body: wb },
    }).owner();
    expect(a.count).toBe(2);
    const app = a.items.find((i) => i.id === 'need:cos:waiting:telegram:134088')!;
    expect(app).toMatchObject({ source: 'chief-of-staff', title: 'Instar App looks done and needs your OK',
      action: { kind: 'href', href: '#/work/board?card=wc_a02a192893e38e60' },
      card: { id: 'wc_a02a192893e38e60', href: '#/work/board?card=wc_a02a192893e38e60' },
      alsoOpens: { href: '#/work/chats?c=telegram%3A134088' } });
    expect(a.items.find((i) => i.source === 'workBoard')).toBeUndefined();
    const plain = a.items.find((i) => i.id === 'need:cos:waiting:telegram:555')!;
    expect(plain).toMatchObject({ title: 'No card yet is waiting on you', action: { kind: 'href', href: '#/work/chats?c=telegram%3A555' } });
    expect(plain.card).toBeUndefined();
    expect(plain.alsoOpens).toBeUndefined();
  });

  it('carries queue items, work cards and promises, each once, with an action and a reason', async () => {
    const a = await composer({
      '/attention?scope=pool&status=OPEN': attention([{ id: 'x1', status: 'OPEN', priority: 'HIGH', source: 'agent', category: 'decision', title: 'Pick a logo', updatedAt: iso(-5), topicId: 4242 }]),
      '/commitments?scope=mesh': { status: 200, body: { scope: 'mesh', commitments: [{ id: 'CMT-1', status: 'pending', blockedOn: 'user-input', userRequest: 'Renew the domain', agentResponse: 'I will renew it', createdAt: iso(-60), hardDeadlineAt: iso(120), updatedAt: iso(-1) }] } },
      '/work-board': { status: 200, body: board([{ id: 'wc_0123456789abcdef', title: 'Ship the strip' }]) },
    }).owner();
    const work = a.items.find((i) => i.source === 'workBoard')!;
    expect(work).toMatchObject({ title: 'Ship the strip', action: { kind: 'href', href: '#/work/board?card=wc_0123456789abcdef' }, sourceLabel: 'the work board' });
    expect(work.why).toMatch(/approval/);
    const q = a.items.find((i) => i.source === 'attention')!;
    expect(q).toMatchObject({ title: 'Pick a logo', action: { kind: 'topic', topicId: 4242 } });
    expect(q.why.length).toBeGreaterThan(0);
    expect(a.items.find((i) => i.source === 'promises')).toMatchObject({ action: { kind: 'promise', id: 'CMT-1' } });
    expect(a.count).toBe(a.items.length);
    expect(new Set(a.items.map((i) => i.id)).size).toBe(a.items.length);
  });

  it('no source reads the list itself (the server can never read itself in a loop)', async () => {
    const { NEED_SOURCES } = await import(path.join(CONSOLE, 'needs-model.js'));
    for (const s of NEED_SOURCES) for (const p of Object.values(s.reads) as string[]) expect(p.startsWith('/needs'), `${s.id} reads ${p}`).toBe(false);
  });

  it('a pooled read that a machine did not answer is incomplete even when it found nothing, and names the machine', async () => {
    const a = await composer({
      '/attention?scope=pool&status=OPEN': { status: 200, body: { items: [], pool: { failed: [{ machineId: 'm_peer', nickname: 'Mac Mini' }] } } },
      '/commitments?scope=mesh': { status: 200, body: { commitments: [] } },
    }).owner();
    expect(a.count).toBe(0);
    expect(a.complete).toBe(false);
    expect(a.couldNotCheck).toContain('the attention queue on Mac Mini');
  });

  it('an account store never set up is complete, not a missing machine; this machine\'s own failure is named as this machine', async () => {
    const base = { '/attention?scope=pool&status=OPEN': attention([]), '/commitments?scope=mesh': { status: 200, body: { commitments: [] } } };
    const unconfigured = await composer({ ...base, '/subscription-pool?scope=pool': { status: 200, body: { enabled: true, accounts: [], pool: { failed: [{ machineId: 'm_self', error: 'peer-pool-unconfigured' }] } } } }).owner();
    expect(unconfigured.couldNotCheck.filter((c) => c.startsWith('accounts'))).toEqual([]);
    const ownFailure = await composer({ ...base, '/subscription-pool?scope=pool': { status: 200, body: { enabled: true, accounts: [], pool: { failed: [{ machineId: 'm_self', error: 'peer-pool-unavailable' }] } } } }).owner();
    expect(ownFailure.couldNotCheck).toContain('accounts and sign-ins on this machine');
    // An agent with no mesh id names itself 'self' in the pool view.
    const noMesh = await composer({ ...base, '/subscription-pool?scope=pool': { status: 200, body: { enabled: true, accounts: [], pool: { failed: [{ machineId: 'self', error: 'peer-pool-invalid' }] } } } }).owner();
    expect(noMesh.couldNotCheck).toContain('accounts and sign-ins on this machine');
  });

  it('a feature that is still starting is not "off": the read is incomplete', async () => {
    const a = await composer({
      '/attention?scope=pool&status=OPEN': attention([]), '/commitments?scope=mesh': { status: 200, body: { commitments: [] } },
      '/work-board': { status: 503, body: { error: 'work-board-starting' } },
    }).owner();
    expect(a.complete).toBe(false);
    expect(a.couldNotCheck).toContain('the work board');
  });

  it('a 503 that says the feature is disabled is off even when it also says "not initialized"', () => {
    expect(consoleResult({ status: 503, body: { error: 'BlockerLedger not initialized (monitoring.blockerLedger.enabled is false)' } })).toEqual({ ok: false, reason: 'switched off on this agent' });
    expect(consoleResult({ status: 503, body: { error: 'work-board-disabled' } })).toEqual({ ok: false, reason: 'switched off on this agent' });
    expect(consoleResult({ status: 503, body: { error: 'work-board-starting' } })).toEqual({ ok: false, reason: 'still starting' });
  });

  it('reads each route once even when two sources share it', async () => {
    const seen: string[] = [];
    await composer({}, seen).owner();
    expect(seen.filter((p) => p === '/skills/learned')).toHaveLength(1);
    expect(seen.filter((p) => p === '/green-pr-automerge')).toHaveLength(1);
  });

  it('never reads the conditional feedback source on an agent whose merge watcher is off', async () => {
    const seen: string[] = [];
    const a = await composer({}, seen).owner();
    expect(seen.some((p) => p.startsWith('/feedback-factory'))).toBe(false);
    expect(a.sources.some((s) => s.id === 'feedback')).toBe(false);
  });

  it('scrubs a credential out of a row before any screen sees it', async () => {
    const a = await composer({ '/attention?scope=pool&status=OPEN': attention([{ id: 'x', status: 'OPEN', priority: 'URGENT', category: 'decision', title: 'Token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123456789 leaked', updatedAt: iso(-1) }]) }).owner();
    expect(JSON.stringify(a.items)).not.toContain('sk-ant-api03-ABCDEFGHIJ');
  });

  it('caps the rows it sends but still counts them all', async () => {
    const many = Array.from({ length: NEEDS_MAX_ITEMS + 5 }, (_, i) => ({ id: `x${i}`, status: 'OPEN', priority: 'HIGH', category: 'decision', title: `Decide ${i}`, updatedAt: iso(-i) }));
    const a = await composer({ '/attention?scope=pool&status=OPEN': attention(many) }).owner();
    expect(a.items).toHaveLength(NEEDS_MAX_ITEMS);
    expect(a.count).toBe(NEEDS_MAX_ITEMS + 5);
    expect(a.truncated).toBe(true);
  });
});

describe('owner page navigation', () => {
  it('shares the first page build and rechecks the ordered list for each continuation', async () => {
    const many = Array.from({ length: 205 }, (_, i) => ({ id: `x${i}`, topicId: 1000 + i, status: 'OPEN', priority: 'HIGH', category: 'decision', title: `Decide ${i}`, updatedAt: iso(-i) }));
    const source = '/attention?scope=pool&status=OPEN';
    const seen: string[] = [];
    const app = express();
    const now = { value: NOW };
    const canary = new NeedsCanary({ read: async (url) => {
      const response = await request(app).get(url);
      expect(response.body.items).toHaveLength(100);
      expect(response.body.count).toBe(206);
      return { status: response.status, body: response.body };
    }, notice: () => {} });
    mountNeedsRoutes(app, { read: reader({ [source]: attention(many) }, seen), bearerOk: () => true,
      boardFor: () => { throw new Error('unexpected team read'); }, agentName: () => 'Echo', machineId: () => 'm1', now: () => now.value, canary });
    const get = async (cursor?: string) => request(app).get('/needs').query(cursor === undefined ? {} : { cursor });
    const [a, b] = await Promise.all([get(), get()]);
    expect(a.body).toEqual(b.body);
    expect(a.body).toMatchObject({ count: 205, continuation: { start: 0, previousCursor: null } });
    expect(seen.filter((p) => p === source)).toHaveLength(1);
    const malformed = await get('invalid');
    expect(malformed.status).toBe(400);
    expect(seen.filter((p) => p === source)).toHaveLength(1);
    const second = await get(a.body.continuation.nextCursor);
    const third = await get(second.body.continuation.nextCursor);
    expect(third.body).toMatchObject({ count: 205, continuation: { start: 200, nextCursor: null } });
    expect(third.body.items).toHaveLength(5);
    expect(new Set([...a.body.items, ...second.body.items, ...third.body.items].map((item) => item.id)).size).toBe(205);
    expect((await get(third.body.continuation.previousCursor)).body.items).toEqual(second.body.items);
    expect((await get(second.body.continuation.previousCursor)).body.items).toEqual(a.body.items);
    expect(seen.filter((p) => p === source)).toHaveLength(5);
    expect(await canary.tick()).toBe(true);
    expect((await get()).body.items).toEqual(a.body.items);
    const original = a.body.items[0];
    expect(original.action).toEqual({ kind: 'topic', topicId: 1000 });
    many[0].topicId = 9001;
    const stale = await get(a.body.continuation.nextCursor);
    expect(stale.status).toBe(409);
    const refreshed = await get();
    expect(refreshed.body.count).toBe(205);
    expect(refreshed.body.items[0]).toMatchObject({ id: original.id, action: { kind: 'topic', topicId: 9001 } });
    expect(stale.body).toEqual({ error: 'needs-cursor-stale' });
    many.splice(5);
    now.value += 10_000;
    const small = await get();
    expect(small.body).toMatchObject({ count: 5, truncated: false });
    expect(small.body).not.toHaveProperty('continuation');
  });
});

describe('needs read: a team person (member or guest)', () => {
  it('sees only the work board, read as them; owner-only sources are not-for-viewer, never "could not check"', async () => {
    const seen: string[] = [];
    const a = await composer({}, seen).team({ status: 200, body: board([{ id: 'wc_00000000000000aa', title: 'A shared card' }]) });
    expect(seen).toEqual([]); // nothing read with the agent's own token
    expect(a.items.map((i) => i.title)).toEqual(['A shared card']);
    expect(a.complete).toBe(true);
    expect(a.couldNotCheck).toEqual([]);
    expect(a.sources.find((s) => s.id === 'accounts')?.state).toBe('not-for-viewer');
  });

  it('a phone the board refuses gets an empty, complete list, with the board not-for-viewer', async () => {
    const a = await composer({}).team(null);
    expect(a).toMatchObject({ count: 0, complete: true, items: [] });
    expect(a.sources.find((s) => s.id === 'workBoard')?.state).toBe('not-for-viewer');
  });

  it('a failed board read is incomplete', async () => {
    const a = await composer({}).team({ status: 500, body: null });
    expect(a.complete).toBe(false);
    expect(a.couldNotCheck).toEqual(['the work board']);
  });
});

describe('needs read: the canary', () => {
  /** A fake read that answers like the route: the synthetic row comes back only for the nonce the canary registered. */
  const routeLike = (canary: () => NeedsCanary, broken = { on: false }) => async (p: string) => {
    if (broken.on) return { status: 500, body: null };
    const nonce = new URL(`http://x${p}`).searchParams.get('canary');
    const row = canary().synthetic(nonce);
    return { status: 200, body: { count: row ? 1 : 0, items: row ? [row] : [] } };
  };

  it('a round trip comes back, is counted, and is never reusable', async () => {
    const notices: string[] = [];
    let c!: NeedsCanary;
    c = new NeedsCanary({ read: routeLike(() => c), notice: (w) => notices.push(w) });
    expect(await c.tick()).toBe(true);
    expect(c.status()).toMatchObject({ consecutiveMisses: 0, noticeRaised: false });
    expect(c.synthetic('anything')).toBeNull(); // no live nonce outside a tick
    expect(notices).toEqual([]);
  });

  it('misses twice in a row raise exactly one notice, which clears on the next good trip', async () => {
    const notices: string[] = []; let cleared = 0;
    const broken = { on: true };
    let c!: NeedsCanary;
    c = new NeedsCanary({ read: routeLike(() => c, broken), notice: (w) => notices.push(w), cleared: () => { cleared++; } });
    for (let i = 0; i < NEEDS_CANARY_MISSES_TO_NOTICE + 2; i++) await c.tick();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/answered 500/);
    broken.on = false;
    expect(await c.tick()).toBe(true);
    expect(cleared).toBe(1);
    expect(c.status().noticeRaised).toBe(false);
  });

  it('a list that answers without the synthetic need is a miss', async () => {
    const notices: string[] = [];
    const c = new NeedsCanary({ read: async () => ({ status: 200, body: { count: 0, items: [] } }), notice: (w) => notices.push(w) });
    await c.tick(); await c.tick();
    expect(notices).toEqual(['the synthetic need did not come back in the list']);
  });
});

describe('needs read: who is asking', () => {
  const bearerOk = (req: { headers: Record<string, string> }) => req.headers.authorization === 'Bearer good';
  const device = (person: Record<string, unknown> | null) => ({ headers: {}, instarPrincipal: { kind: 'device', deviceId: 'd1' }, ...(person ? { instarDevicePerson: { ok: true, userId: 'u', name: 'P', telegramUserId: null, ...person } } : {}) }) as never;

  it('the bearer and the owner phone are the owner; a wrong bearer is nobody', () => {
    expect(needsViewer({ headers: { authorization: 'Bearer good' } } as never, bearerOk as never)).toBe('owner');
    expect(needsViewer({ headers: { authorization: 'Bearer bad' } } as never, bearerOk as never)).toBeNull();
    expect(needsViewer(device({ role: 'owner' }), bearerOk as never)).toBe('owner');
  });

  it('a member, a guest and a shared-machine user are never the owner', () => {
    expect(needsViewer(device({ role: 'team', tier: 'member' }), bearerOk as never)).toBe('member');
    expect(needsViewer(device({ role: 'team', tier: 'guest' }), bearerOk as never)).toBe('guest');
    expect(needsViewer(device({ role: 'msp' }), bearerOk as never)).toBe('msp');
    expect(needsViewer(device(null), bearerOk as never)).toBeNull();
  });

  it('a team phone reads the board only when the board\'s own device rule admits it (guest and up)', () => {
    expect(teamMayReadBoard(device({ role: 'team', tier: 'member' }))).toBe(true);
    expect(teamMayReadBoard(device({ role: 'team', tier: 'guest' }))).toBe(true);
    expect(teamMayReadBoard(device({ role: 'team' }))).toBe(false); // no tier: refused, as the middleware does
    expect(teamMayReadBoard(device(null))).toBe(false);
    // A shared-machine (msp) phone passes the board's rule (no owner-only flag, not a team tier).
    expect(teamMayReadBoard(device({ role: 'msp' }))).toBe(true);
  });
});

describe('needs read: the phone rule', () => {
  it('a member\'s and a guest\'s phone may ask for the list (named for team phones at guest)', async () => {
    const { DEVICE_ALLOWLIST } = await import('../../src/server/mobilePairingRoutes.js');
    const rule = DEVICE_ALLOWLIST.find((r) => r.method === 'GET' && r.re.test('/mobile/needs'))!;
    expect(rule).toBeTruthy();
    expect(rule.tier).toBe('guest');
    expect(rule.ownerOnly).toBeFalsy();
    expect(rule.bucket).toBe('needs-reads');
    // The canary's state is not a phone route.
    expect(DEVICE_ALLOWLIST.some((r) => r.re.test('/needs/canary'))).toBe(false);
  });
});

it('the shared owner read excludes a real capacity wait while retaining a real required action', async () => {
 const body = summarizeHealth({status:'degraded',sessions:{current:25,max:25}}, [{feature:'iMessage',timestamp:new Date(NOW).toISOString(),narrative:'Disconnected'}]);
 const res = await composer({'/mobile/health-issues':{status:200,body}}).owner();
 expect(res.sources.find(s=>s.id==='health')?.state).toBe('ok');
 expect(res.items.filter(i=>i.source==='health').map(i=>i.title)).toEqual(['iMessage isn’t connected']);
 expect(res.count).toBe(1);
});

it('counts an agent-owned Health incident without exposing it as an owner action', async () => {
  const body = summarizeHealth({ status: 'degraded', sessions: { current: 25, max: 25 } }, []);
  const result = await createNeedsComposer({
    read: reader({ '/mobile/health-issues': { status: 200, body } }),
    consoleDir: CONSOLE, agentName: () => 'Echo', machineId: () => 'm_self',
    ownerCardCandidate: () => { throw new Error('The explicit agent classification should not query owner authority'); },
  }).owner();
  expect(body.issues).toEqual([expect.objectContaining({ id: 'health:sessions-full', requiresUserAction: false })]);
  expect(result).toMatchObject({ count: 0, items: [], divertedCount: 1 });
  expect(result.sources.find(source => source.id === 'health')?.state).toBe('ok');
});
