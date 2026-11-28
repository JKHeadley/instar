/**
 * Chief of Staff wait cards (docs/specs/work-board-cards-appear.md §1): one card per project, opened when the
 * Chief of Staff records a wait, edited only on change, closed on the record that clears it (never on unknown or
 * absence), reopened by a new wait, fenced by the record it mirrors, respectful of a person's hold and archive.
 * Real WorkBoardService, real Chief of Staff record builders.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ChiefOfStaffLoop, CHIEF_OF_STAFF_LOOP_DEFAULTS } from '../../src/core/ChiefOfStaffLoop.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { WorkBoardService, resolveWorkBoardSettings, type WorkPrincipal } from '../../src/core/WorkBoardService.js';
import { workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';
import { buildBindingPut, buildCheckEvent, buildOwnerPauseEvent, buildLifecycleEvent, buildLastTick, foldProjectCheckState, type ProjectCheckState, type CosVerdict } from '../../src/core/ChiefOfStaffStore.js';
import { ChiefOfStaffWaitCards, resolveOwnerNeedsWaitIdentity, waitCardId, composeWaitCard, inertText, waitAsk, humanTimeUtc, WAIT_CARD_ITEM, type WaitCardProject } from '../../src/core/ChiefOfStaffWaitCards.js';
import { cardJson } from '../../src/core/workBoardViews.js';

const OWNER: WorkPrincipal = { kind: 'person', personKey: 'justin', proof: 'pin', isOwner: true };
const CK = 'telegram:135786';

function rig(opts: { softOpenCards?: number; maxAgentCardsPerDay?: number; enabled?: boolean } = {}) {
  let clock = Date.parse('2026-11-18T03:00:00Z');
  let logical = 0;
  const tick = () => ({ physical: clock, logical: logical++, node: 'm_a' } as HlcTimestamp);
  const board: UnionEntry[] = [];
  const settings = resolveWorkBoardSettings({ softOpenCards: opts.softOpenCards ?? 30, maxAgentCardsPerDay: opts.maxAgentCardsPerDay ?? 200 });
  const svc = new WorkBoardService({
    machineId: 'm_a',
    emit: (_key, build) => {
      const hlc = tick();
      const data = build(hlc, 'm_a');
      if (!data) return { outcome: 'skipped' };
      if (!workCardRecordStoreSchema.validate(data, { countDroppedField: () => {}, countJailReject: () => {} } as never)) return { outcome: 'dropped:invalid' };
      board.push({ data, origin: 'm_a' });
      return { outcome: 'emitted', seq: board.length, hlc };
    },
    loadUnion: () => board, now: () => clock, settings: () => settings, ownerPersonKey: () => 'justin',
    detectCredential: () => null,
    dayOf: (ms) => ({ day: new Date(ms).toISOString().slice(0, 10), resetsAt: new Date(Math.ceil(ms / 86_400_000) * 86_400_000).toISOString() }),
    displayName: (k) => k,
  });
  const cos: UnionEntry[] = [];
  const add = (build: (h: HlcTimestamp, o: string) => Record<string, unknown> | null) => { const d = build(tick(), 'm_a'); if (!d) throw new Error('build'); cos.push({ data: d, origin: 'm_a' }); return d; };
  const binding = add(buildBindingPut({ conversationKey: CK, goal: 'Agent creation: recommend services', doneDefinition: [{ id: 'j1', kind: 'judgment', text: 'Justin is happy with it' } as never, { id: 'p1', kind: 'deterministic', text: 'PR 1 merged' } as never], checkCadenceHours: 24, linked: {}, confirmedBy: 'owner', confirmedAt: new Date(clock).toISOString() }));
  const bindingHlc = binding.hlc as HlcTimestamp;
  const project: WaitCardProject = { conversationKey: CK, title: 'Instar Agent Creation', goal: 'Agent creation: recommend services', doneDefinition: [{ id: 'j1', kind: 'judgment', text: 'Justin is happy with it' }, { id: 'p1', kind: 'deterministic', text: 'PR 1 merged' }] };
  const check = (verdict: CosVerdict, note = 'The spec waits for your yes.', doneItems: Record<string, 'pass' | 'fail' | 'unknown'> = { p1: 'fail' }) => {
    clock += 60_000;
    return add(buildCheckEvent({ conversationKey: CK, verdict, evidenceHash: 'x'.repeat(64), evidenceIds: [], progressSeen: false, machine: 'm_a', at: new Date(clock).toISOString(), note, doneItems }));
  };
  const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
  let conversations = 0;
  const wc = new ChiefOfStaffWaitCards({ enabled: () => opts.enabled ?? true, board: () => svc, ensureConversation: () => { conversations++; }, log: (event, detail) => logs.push({ event, detail }) });
  const states = (): Map<string, ProjectCheckState> => new Map([[CK, foldProjectCheckState(cos, CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(clock))]]);
  const sync = (projects: WaitCardProject[] = [project]) => wc.sync({ union: cos, projects, states: states() });
  const card = () => svc.view(waitCardId(CK));
  return { svc, cos, board, add, check, sync, card, logs, project, bindingHlc, advance: (ms: number) => { clock += ms; }, conversations: () => conversations, now: () => clock };
}

describe('exact wait identity from coordinator records', () => {
  it('preserves carry-forward identity and distinguishes changes, reverts and new episodes', () => {
    const t = rig();
    const disclosure = { revision: 'd1', action: 'approve' };
    const identity = () => resolveOwnerNeedsWaitIdentity(t.cos, CK, disclosure);
    expect(identity()).toBeNull();

    t.check('waiting-on-user', 'Please approve.');
    const original = identity()!;
    expect(original).not.toBeNull();
    t.check('waiting-on-user', 'no new evidence');
    t.check('waiting-on-user', 'Please approve.');
    expect(identity()).toEqual(original);
    t.check('waiting-on-user', 'Please approve with the new evidence.');
    expect(identity()).toMatchObject({ episode: original.episode });
    expect(identity()?.requestVersion).not.toBe(original.requestVersion);
    t.check('waiting-on-user', 'Please approve.');
    expect(identity()?.requestVersion).not.toBe(original.requestVersion);
    expect(resolveOwnerNeedsWaitIdentity(t.cos, CK, { revision: 'd2', action: 'decline' })).not.toEqual(identity());
    expect(resolveOwnerNeedsWaitIdentity(t.cos, CK, { revision: 'd3', action: 'approve' })).not.toEqual(identity());
    expect(resolveOwnerNeedsWaitIdentity(t.cos, CK, { revision: '', action: 'approve' })).toBeNull();

    t.check('moving');
    expect(identity()).toBeNull();
    t.check('waiting-on-user', 'Please approve.');
    expect(identity()?.episode).not.toBe(original.episode);
    t.add(buildLifecycleEvent(CK, 'closed', t.bindingHlc, 'owner-tap', new Date(t.now()).toISOString()));
    expect(identity()).toBeNull();
  });
});

describe('Chief of Staff wait cards — open', () => {
  it('opens one owner-carried card for a recorded wait, with recommendation, why-you, project link and no Approve step', () => {
    const t = rig();
    t.check('waiting-on-user');
    const r = t.sync();
    expect(r.opened).toEqual([waitCardId(CK)]);
    const v = t.card()!;
    expect(v.card.title).toBe('Instar Agent Creation is waiting on you');
    expect(v.card.recommendation).toMatch(/Reply in the project's conversation/);
    expect(v.card.whyYou).toMatch(/does not decide for you/);
    expect(v.card.projectKey).toBe(CK);
    expect(v.card.carrier).toEqual({ personKey: 'justin' });
    expect(v.card.outward).toBe(false);
    expect(v.card.covers).toEqual([`cos:waiting:${CK}`]);
    expect(v.card.need).toContain('The spec waits for your yes.');
    expect(v.card.need).toContain('See the project conversation for this completion check. (fails)');
    expect(v.card.approvalRequired).toBe(false);
    expect(v.status).toBe('with-person');
    expect(t.svc.lane(v, { isOwner: true, personKey: 'justin' })).toBe('waiting-on-you');
    expect(t.conversations()).toBe(1);
  });
  it('an unchanged wait writes nothing; a second sync does not duplicate', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const n = t.board.length;
    t.check('waiting-on-user'); // same note, same items
    const r = t.sync();
    expect(r.opened).toEqual([]); expect(r.edited).toEqual([]);
    expect(t.board.length).toBe(n);
  });
  it('a changed done-item state edits the card once, keeping the opening note and wait start', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const before = t.card()!.card;
    t.check('waiting-on-user', 'a different, later note', { p1: 'pass' });
    const r = t.sync();
    expect(r.edited).toEqual([waitCardId(CK)]);
    const after = t.card()!.card;
    expect(after.need).toContain('The spec waits for your yes.');
    expect(after.need).not.toContain('a different, later note');
    expect(after.mirror?.waitSince).toBe(before.mirror?.waitSince);
  });
  it('a confirm wait (every automatic item passes, judgment pending) reads as needing your OK', () => {
    const t = rig();
    t.check('waiting-on-user', 'All checks pass.', { p1: 'pass' });
    t.sync();
    expect(t.card()!.card.title).toBe('Instar Agent Creation looks done and needs your OK');
    expect(t.card()!.card.recommendation).toMatch(/Confirm done on the Chief of Staff/);
  });
  it('the switch off writes nothing', () => {
    const t = rig({ enabled: false });
    t.check('waiting-on-user');
    expect(t.sync().opened).toEqual([]);
    expect(t.board.length).toBe(0);
  });
  it('at the soft cap no card opens, and it is retried only on a newer Chief of Staff record', () => {
    const t = rig({ softOpenCards: 1 });
    t.svc.createCard(OWNER, { title: 'Already waiting', need: 'x', doneWhen: [{ id: 'd', text: 'y' }], carrier: { personKey: 'justin' }, outward: false });
    t.check('waiting-on-user');
    expect(t.sync().skipped[0]?.reason).toBe('soft-open-cards');
    expect(t.sync().skipped[0]?.reason).toBe('waiting-for-a-newer-record');
    expect(t.logs.filter((l) => l.event === 'cos-wait-card-not-opened')).toHaveLength(1);
  });
  it('wait cards count toward the daily ceiling', () => {
    const t = rig({ maxAgentCardsPerDay: 1 });
    t.svc.createCard({ kind: 'agent' }, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z' }], outward: false });
    t.check('waiting-on-user');
    expect(t.sync().skipped[0]?.reason).toBe('daily-card-ceiling');
  });
  it('the note renders as plain text: no backslash escapes, while link, image and tag syntax stays inert', () => {
    expect(inertText('Keep the best features each engine (Claude Code, Codex, ...) offers_now *x*')).toBe('Keep the best features each engine (Claude Code, Codex, ...) offers_now *x*');
    const out = inertText('[click](https://evil.example) <b>x</b> ![img](y)');
    expect(out).not.toContain('\\');
    expect(out).not.toMatch(/\]\(/);
    expect(out).not.toMatch(/!\[/);
    expect(out).not.toMatch(/<[A-Za-z/]/);
  });
  it('the time reads as a person reads it, the same on every machine', () => {
    expect(humanTimeUtc('2026-11-17T22:15:31.000Z')).toBe('Nov 17, 2026, 10:15 PM UTC');
    expect(humanTimeUtc('2026-01-02T00:05:00Z')).toBe('Jan 2, 2026, 12:05 AM UTC');
    expect(humanTimeUtc('not a time')).toBe('a recorded time');
  });
});

describe('Chief of Staff wait cards — the brief and a clean need', () => {
  const ENGINE: WaitCardProject = {
    conversationKey: 'telegram:141868', title: 'Engine Feature Optimization',
    goal: 'Keep Instar using the best features each engine (Claude Code, Codex, ...) offers, as an ongoing effort.',
    doneDefinition: [
      { id: 'd1', kind: 'deterministic', text: 'Each newly found engine feature is either adopted or recorded with the reason not to.' },
      { id: 'j1', kind: 'judgment', text: 'Justin is happy with the review routine.' },
    ],
  };
  const NOTE = 'The agent is waiting for the owner to choose whether to run all three experiments, run only the guard test, or wait.';
  it('keeps internal project language out of the visible wait card', () => {
    const project = {
      ...ENGINE, title: 'Complete CMT-123', goal: 'Finish PR 3642',
      doneDefinition: [{ id: 'd1', kind: 'deterministic', text: 'requestApproved is set' }],
    };
    const card = composeWaitCard(project, 'answer', null, 'The owner must choose a worktree.', '2026-11-17T22:15:31.000Z', 'r');
    expect(JSON.stringify(card)).not.toMatch(/CMT-123|PR 3642|requestApproved|worktree/);
    expect(card.brief.ask).toBe('Read the decision in the project conversation and reply there.');
    expect(card.brief.chiefSaid).toBeUndefined();
    expect(card.brief.checks?.[0].text).toBe('See the project conversation for this completion check.');
  });

  it('the screenshot card: need has no escapes, no wait id, no raw UTC, no glued status; brief carries the structure', () => {
    const c = composeWaitCard(ENGINE, 'answer', null, NOTE, '2026-11-17T22:15:31.000Z', 'check:c5c23e80');
    expect(c.need).not.toContain('\\');
    expect(c.need).not.toMatch(/\(wait [0-9a-f]{8}\)/);
    expect(c.need).not.toContain('2026-11-17 22:15:31');
    expect(c.need).not.toMatch(/\.: /);
    expect(c.need).toContain('Goal: Keep Instar using the best features each engine (Claude Code, Codex, ...) offers');
    expect(c.need).toContain('- Justin is happy with the review routine. (needs your judgment)');
    expect(c.need).toContain('Waiting on you since Nov 17, 2026, 10:15 PM UTC.');
    expect(c.brief).toEqual({
      ask: 'Choose whether to run all three experiments, run only the guard test, or wait.',
      goal: 'Keep Instar using the best features each engine (Claude Code, Codex, ...) offers, as an ongoing effort.',
      checks: [
        { text: 'Each newly found engine feature is either adopted or recorded with the reason not to.', status: 'unknown' },
        { text: 'Justin is happy with the review routine.', status: 'needs-you' },
      ],
      chiefSaid: NOTE,
      waitingSince: '2026-11-17T22:15:31.000Z',
    });
  });
  it('the ask: a named decision, else a fixed sentence per kind', () => {
    expect(waitAsk('answer', 'Blocked until you decide whether to ship it now.')).toBe('Decide whether to ship it now.');
    expect(waitAsk('answer', 'This needs your decision on the domain name.')).toBe('Decide on the domain name.');
    expect(waitAsk('answer', 'The build is red.')).toBe('Answer what the project needs next.');
    expect(waitAsk('answer', null)).toBe('Answer what the project needs next.');
    expect(waitAsk('confirm', NOTE)).toBe('Confirm this project is done.');
  });
  it('check statuses map passes / fails / unknown / needs-you; empty parts are left out', () => {
    const c = composeWaitCard({ ...ENGINE, goal: ' ', doneDefinition: [{ id: 'a', kind: 'deterministic', text: 'A' }, { id: 'b', kind: 'deterministic', text: 'B' }] }, 'answer', { a: 'pass', b: 'fail' }, null, '2026-11-17T22:15:31Z', 'r');
    expect(c.brief.checks).toEqual([{ text: 'A', status: 'passes' }, { text: 'B', status: 'fails' }]);
    expect(c.brief.goal).toBeUndefined();
    expect(c.brief.chiefSaid).toBeUndefined();
  });
  it('a synced card carries the brief in the store and in the served card JSON; the brief is not material', () => {
    const t = rig();
    t.check('waiting-on-user', NOTE); t.sync();
    const v = t.card()!;
    expect(v.card.brief?.ask).toBe('Choose whether to run all three experiments, run only the guard test, or wait.');
    expect(v.card.brief?.waitingSince).toBe(v.card.mirror?.waitSince);
    const json = cardJson(t.svc, v, { personKey: 'justin', isOwner: true, isAgent: false }, (k) => k);
    expect(json.brief).toEqual(v.card.brief);
    const hash = v.card.materialHash;
    const r = t.svc.edit({ kind: 'agent', server: true }, waitCardId(CK), { brief: { ...v.card.brief!, ask: 'Something else.' } });
    expect(r.ok).toBe(true);
    expect(t.card()!.card.materialHash).toBe(hash);
  });
  it('only the server writer may set a brief', () => {
    const t = rig();
    const brief = { ask: 'x' };
    expect(t.svc.createCard({ kind: 'agent' }, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z' }], outward: false, brief })).toMatchObject({ ok: false, error: 'brief-not-allowed' });
    expect(t.svc.createCard(OWNER, { title: 'x', need: 'y', doneWhen: [{ id: 'd', text: 'z' }], outward: false, brief })).toMatchObject({ ok: false, error: 'brief-not-allowed' });
  });
  it('an existing card written before the brief gets it, once, on the next newer check; a finished one without reopening', () => {
    const t = rig();
    t.check('waiting-on-user', NOTE); t.sync();
    const id = waitCardId(CK);
    // Simulate a card written by the previous build: no brief, the old need.
    expect(t.svc.edit({ kind: 'agent', server: true }, id, { brief: null, need: 'The project is waiting for an answer.' }).ok).toBe(true);
    t.check('waiting-on-user', 'no new evidence');
    expect(t.sync().edited).toEqual([id]);
    expect(t.card()!.card.brief?.ask).toMatch(/^Choose whether/);
    expect(t.card()!.card.need).not.toContain('(wait ');
    const n = t.board.length;
    t.check('waiting-on-user', 'no new evidence'); t.sync();
    expect(t.board.length).toBe(n);
    // Finished while the same wait continues: a brief-only write, the card stays finished.
    t.svc.addEvidence({ kind: 'agent', server: true }, id, { itemId: WAIT_CARD_ITEM, text: 'owner settled it' });
    expect(t.svc.claimDone({ kind: 'agent', server: true }, id).ok).toBe(true);
    expect(t.svc.edit({ kind: 'agent', server: true }, id, { brief: null }).ok).toBe(true);
    t.check('waiting-on-user', 'no new evidence');
    expect(t.sync().edited).toEqual([id]);
    expect(t.card()!.card.done).toBe(true);
    expect(t.card()!.card.brief).not.toBeNull();
  });
  it('a new wait on a finished card that reads word for word like the old one still changes the material', () => {
    const t = rig();
    const id = waitCardId(CK);
    t.check('waiting-on-user'); t.sync();
    // Finish it, then the same wait text comes back as a NEW episode at the same minute.
    t.svc.addEvidence({ kind: 'agent', server: true }, id, { itemId: WAIT_CARD_ITEM, text: 'settled' });
    expect(t.svc.claimDone({ kind: 'agent', server: true }, id).ok).toBe(true);
    const doneHash = t.card()!.card.materialHash;
    t.advance(-60_000); // the next check lands in the same minute as the first wait started
    t.check('moving'); t.advance(-60_000); t.check('waiting-on-user');
    t.sync();
    const v = t.card()!;
    expect(v.card.done).toBe(false);
    expect(v.card.materialHash).not.toBe(doneHash);
    expect(v.card.need).toContain('Waiting on you again since');
  });
});

describe('Chief of Staff wait cards — where a wait starts', () => {
  it('a card opened mid-wait shows when the wait started, not the newest check', () => {
    const t = rig();
    t.check('moving');
    const first = t.check('waiting-on-user', 'first waiting note');
    t.check('waiting-on-user', 'no new evidence');
    t.check('unknown');
    t.check('waiting-on-user', 'no new evidence');
    t.sync();
    const c = t.card()!.card;
    expect(c.mirror?.waitSince).toBe(first.at);
    expect(c.mirror?.waitRef).toBe(first.recordKey);
    expect(c.need).toContain('first waiting note');
  });
  it('a redelivered owner pause (an ask already decided) is not a clearing record', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const rec = { who: 'Justin', at: new Date(t.now()).toISOString(), quote: 'pause', messageRef: 'tg:1' };
    t.add(buildOwnerPauseEvent(CK, 'owner-pause', t.bindingHlc, rec, 'ask1'));
    t.add(buildOwnerPauseEvent(CK, 'owner-resume', t.bindingHlc, rec, 'ask2'));
    t.sync(); // pause then resume: the card closed on the pause, then the resume leaves the check waiting -> a new wait
    const sinceAfterResume = t.card()!.card.mirror?.waitSince;
    t.add(buildOwnerPauseEvent(CK, 'owner-pause', t.bindingHlc, rec, 'ask1')); // the same ask, delivered again
    t.check('waiting-on-user');
    t.sync();
    expect(t.card()!.card.done).toBe(false);
    expect(t.card()!.card.mirror?.waitSince).toBe(sinceAfterResume);
  });
});

describe('Chief of Staff wait cards — close and reopen', () => {
  it('closes on a later clearing verdict, citing it; done on the agent\'s own evidence', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    t.check('moving');
    const r = t.sync();
    expect(r.closed).toEqual([waitCardId(CK)]);
    const v = t.card()!;
    expect(v.card.done).toBe(true);
    expect(v.card.doneByAgentOwnEvidence).toBe(true);
    expect(v.card.evidence.find((e) => e.itemId === WAIT_CARD_ITEM)?.text).toMatch(/no longer marks it waiting on you \(it reads moving\)/);
    expect(v.card.mirror?.cleared).toBe(true);
    // Later clearing checks write nothing.
    const n = t.board.length;
    t.check('moving', 'still moving'); t.sync();
    expect(t.board.length).toBe(n);
  });
  it('never closes on unknown, nor on a project the read does not hold', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    t.check('unknown');
    expect(t.sync().closed).toEqual([]);
    expect(t.card()!.card.done).toBe(false);
    t.check('moving');
    expect(t.sync([]).closed).toEqual([]); // the project is absent from this read
    expect(t.card()!.card.done).toBe(false);
  });
  it('closes on the owner\'s pause and on the binding\'s close', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    t.add(buildOwnerPauseEvent(CK, 'owner-pause', t.bindingHlc, { who: 'Justin', at: new Date(t.now()).toISOString(), quote: 'pause it', messageRef: 'tg:1' }, 'ask1'));
    expect(t.sync().closed).toEqual([waitCardId(CK)]);
    expect(t.card()!.card.evidence.at(-1)?.text).toMatch(/You paused this project/);

    const u = rig();
    u.check('waiting-on-user'); u.sync();
    u.add(buildLifecycleEvent(CK, 'closed', u.bindingHlc, 'chief-of-staff', new Date(u.now()).toISOString()));
    expect(u.sync([]).closed).toEqual([waitCardId(CK)]);
    expect(u.card()!.card.evidence.at(-1)?.text).toMatch(/The project was closed/);
  });
  it('a new wait after a close reopens the same card with new material; the old finish no longer counts', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    t.check('moving'); t.sync();
    const oldHash = t.card()!.card.materialHash;
    t.check('waiting-on-user', 'Now it needs the domain choice.');
    const r = t.sync();
    expect(r.reopened).toEqual([waitCardId(CK)]);
    const v = t.card()!;
    expect(v.card.done).toBe(false);
    expect(v.card.materialHash).not.toBe(oldHash);
    expect(v.card.need).toContain('Now it needs the domain choice.');
    expect(v.status).toBe('with-person');
  });
  it('a wait that cleared and came back between syncs is a new wait', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const since = t.card()!.card.mirror?.waitSince;
    t.check('moving'); t.check('waiting-on-user', 'back again');
    t.sync();
    expect(t.card()!.card.mirror?.waitSince).not.toBe(since);
    expect(t.card()!.card.need).toContain('back again');
  });
  it('a crash between evidence and claim resumes to one claim', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    t.check('moving');
    // First attempt: evidence lands, the claim does not (simulated by writing evidence alone with the same key the sync uses).
    const realClaim = t.svc.claimDone.bind(t.svc);
    let fail = true;
    t.svc.claimDone = ((p, id, o) => (fail ? ({ ok: false, status: 503, error: 'store-unavailable' }) : realClaim(p, id, o))) as typeof t.svc.claimDone;
    expect(t.sync().closed).toEqual([]);
    fail = false;
    expect(t.sync().closed).toEqual([waitCardId(CK)]);
    expect(t.card()!.card.evidence.filter((e) => e.itemId === WAIT_CARD_ITEM)).toHaveLength(1);
    expect(t.card()!.card.claims).toHaveLength(1);
  });
  it('after the owner reopens a closed card, the next close waits for the owner\'s Confirm done', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    t.check('moving'); t.sync();
    const claim = t.card()!.card.claims[0];
    expect(t.svc.tap(OWNER, waitCardId(CK), { action: 'reopen', claimId: claim.id }).ok).toBe(true);
    t.check('moving', 'moving again'); t.sync();
    const v = t.card()!;
    expect(v.card.done).toBe(false);
    expect(v.status).toBe('claims-done');
  });
});

describe('Chief of Staff wait cards — park, confirm while waiting, repair', () => {
  it('park, then unpark, then wait: the card reopens with a new wait', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const wc = new ChiefOfStaffWaitCards({ enabled: () => true, board: () => t.svc });
    const parked = (union: typeof t.cos) => new Map([[CK, { ...foldProjectCheckState(union, CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(t.now())), parked: true }]]);
    t.check('waiting-on-user', 'still waiting while parked');
    expect(wc.sync({ union: t.cos, projects: [t.project], states: parked(t.cos) }).closed).toEqual([waitCardId(CK)]);
    const doneHash = t.card()!.card.materialHash;
    t.add(buildLifecycleEvent(CK, 'unpark', t.bindingHlc, 'owner-tap' as never, new Date(t.now()).toISOString()));
    t.check('waiting-on-user', 'after the unpark');
    const r = t.sync();
    expect(r.reopened).toEqual([waitCardId(CK)]);
    expect(t.card()!.card.done).toBe(false);
    expect(t.card()!.card.materialHash).not.toBe(doneHash);
  });
  it('a card finished while the same wait continues is not rewritten on each later check', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const v = t.card()!;
    // Finished outside the clearing path (no cleared mirror), while the Chief of Staff still records the same wait.
    t.svc.addEvidence({ kind: 'agent', server: true }, waitCardId(CK), { itemId: WAIT_CARD_ITEM, text: 'owner settled it' });
    const c = t.svc.claimDone({ kind: 'agent', server: true }, waitCardId(CK)); if (!c.ok) throw new Error(c.error);
    expect(t.card()!.card.done).toBe(true);
    void v;
    const n = t.board.length;
    t.check('waiting-on-user'); t.check('waiting-on-user');
    t.sync(); t.sync();
    expect(t.board.length).toBe(n);
  });
});

describe('Chief of Staff wait cards — fence and a person\'s word', () => {
  it('a holder behind the card\'s mirror writes nothing', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const stale = t.cos.slice(); // a holder that has not seen the next records
    t.check('waiting-on-user', 'later', { p1: 'pass' }); t.sync(); // the up-to-date holder edits, mirror moves on
    const n = t.board.length;
    const wc = new ChiefOfStaffWaitCards({ enabled: () => true, board: () => t.svc });
    wc.sync({ union: stale, projects: [t.project], states: new Map([[CK, foldProjectCheckState(stale, CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(t.now()))]]) });
    expect(t.board.length).toBe(n);
  });
  it('never edits, closes or reopens a held or archived card', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    expect(t.svc.tap(OWNER, waitCardId(CK), { action: 'hold' }).ok).toBe(true);
    t.check('moving');
    expect(t.sync().closed).toEqual([]);
    expect(t.card()!.card.done).toBe(false);
  });
  it('a session or the owner cannot write the server-owned card; taps still work', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const id = waitCardId(CK);
    expect(t.svc.edit({ kind: 'agent' }, id, { need: 'changed' })).toMatchObject({ ok: false, error: 'server-owned-card' });
    expect(t.svc.edit(OWNER, id, { need: 'changed' })).toMatchObject({ ok: false, error: 'server-owned-card' });
    expect(t.svc.claimDone({ kind: 'agent' }, id)).toMatchObject({ ok: false, error: 'server-owned-card' });
    expect(t.svc.addEvidence({ kind: 'agent' }, id, { itemId: WAIT_CARD_ITEM, text: 'x' })).toMatchObject({ ok: false, error: 'server-owned-card' });
    expect(t.svc.tap(OWNER, id, { action: 'archive' }).ok).toBe(true);
  });
  it('a parked project closes its wait card (its own Needs-you row asks to unpark)', () => {
    const t = rig();
    t.check('waiting-on-user'); t.sync();
    const st = new Map([[CK, { ...foldProjectCheckState(t.cos, CK, { checkCadenceHours: 24, maxRestartsWithoutProgress: 3, breakerRestartsPerWeek: 5 }, new Date(t.now())), parked: true }]]);
    t.check('waiting-on-user', 'still waiting');
    const wc = new ChiefOfStaffWaitCards({ enabled: () => true, board: () => t.svc });
    const r = wc.sync({ union: t.cos, projects: [t.project], states: st });
    expect(r.closed).toEqual([waitCardId(CK)]);
  });
});

describe('Chief of Staff wait cards — wiring (the loop calls sync; never on the grace tick; the server wires a real board)', () => {
  const loopWith = (union: UnionEntry[], calls: unknown[]) => new ChiefOfStaffLoop({
    now: () => Date.parse('2026-11-18T09:00:00Z'), machineId: 'm_a', enabled: () => true, holdsLease: () => true, config: () => CHIEF_OF_STAFF_LOOP_DEFAULTS,
    journal: { emit: () => ({ outcome: 'emitted', seq: 1 }), loadUnion: () => union },
    verifyRenewal: () => false, gather: async () => { throw new Error('n/a'); }, judge: async () => null,
    protocol: { claim: async () => ({ outcome: 'rejected', reason: 'n/a' }), standDown: () => null, settleOpenIntent: async () => 'lost', operatorLeaseLive: () => false } as never,
    mirrorInitiativeStatus: () => {}, sendNote: async () => {}, sendImmediate: async () => {}, statusUrl: () => null, localHour: () => 0,
    waitCards: { sync: (input) => { calls.push(input); return { opened: [], edited: [], reopened: [], closed: [], skipped: [] }; } },
  });
  it('a tick on the lease holder syncs the wait cards with the fresh union', async () => {
    const calls: unknown[] = [];
    await loopWith([], calls).tick();
    expect(calls).toHaveLength(1);
  });
  it('the first tick after another machine held the lease (the grace tick) does not', async () => {
    const calls: unknown[] = [];
    const union: UnionEntry[] = [{ data: buildLastTick('m_b', '2026-11-18T08:45:00.000Z')({ physical: 1, logical: 0, node: 'm_b' }, 'm_b')!, origin: 'm_b' }];
    await loopWith(union, calls).tick();
    expect(calls).toHaveLength(0);
  });
  it('server boot gives the loop a wait-card writer over the real board, dev-gated by workBoard.chiefOfStaffCards', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(src).toContain("waitCards: new (await import('../core/ChiefOfStaffWaitCards.js')).ChiefOfStaffWaitCards({");
    expect(src).toContain("resolveDevAgentGate(liveConfig.get<boolean | undefined>('workBoard.chiefOfStaffCards', undefined), config)");
    expect(src).toContain('board: () => _workBoardRuntime?.svc ?? null,');
  });
});
