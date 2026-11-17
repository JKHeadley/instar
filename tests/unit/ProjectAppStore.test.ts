import { describe, it, expect } from 'vitest';
import {
  projectAppRecordStoreSchema as schema, buildOffer, buildAnswer, buildPinEvent, foldPairs, foldPins,
  nextPinAction, pinUncertain, pinOutOfDate, builtinApp, projectAppsEnabled, type UnionEntry,
} from '../../src/core/ProjectAppStore.js';

const CK = 'telegram:128732';
const REF = 'builtin:maturation-board';
const ctx = { countDroppedField() {}, countJailReject() {} };
let tick = 1_000;
const hlc = () => ({ physical: tick++, logical: 0, node: 'm_a' });
const entry = (build: ReturnType<typeof buildOffer>): UnionEntry => {
  const d = build(hlc(), 'm_a')!;
  return { data: d, origin: 'm_a' };
};
const at = '2026-11-17T01:00:00.000Z';

describe('project-app-record schema', () => {
  const v = (raw: Record<string, unknown>) => schema.validate(raw, ctx);
  it('accepts a good offer, answer and pin step', () => {
    expect(v({ recordType: 'project-app-offer', conversationKey: CK, appRef: REF, why: 'Same table four times.', at })).not.toBeNull();
    expect(v({ recordType: 'project-app-answer', conversationKey: CK, appRef: REF, answer: 'attach', by: 'owner', via: 'console', at })).not.toBeNull();
    expect(v({ recordType: 'project-app-pin', conversationKey: CK, appRef: REF, platform: 'telegram', state: 'posted', opId: 'abcdefgh12', messageId: '42', baseUrl: 'https://echo.example.dev', at })).not.toBeNull();
    expect(v({ recordType: 'project-app-pin', conversationKey: CK, appRef: REF, platform: 'telegram', state: 'act', act: 'attach', opId: 'abcdefgh12', at })).not.toBeNull();
  });
  it('refuses an owner answer made through a plain Bearer, and an agent that tries to attach', () => {
    expect(v({ recordType: 'project-app-answer', conversationKey: CK, appRef: REF, answer: 'attach', by: 'owner', via: 'bearer', at })).toBeNull();
    expect(v({ recordType: 'project-app-answer', conversationKey: CK, appRef: REF, answer: 'attach', by: 'agent', via: 'bearer', at })).toBeNull();
    expect(v({ recordType: 'project-app-answer', conversationKey: CK, appRef: REF, answer: 'withdraw', by: 'agent', via: 'bearer', at })).not.toBeNull();
  });
  it('refuses unknown types, bad app refs, URLs with paths, steps without message ids and acts without an act', () => {
    expect(v({ recordType: 'project-app-offer', conversationKey: CK, appRef: 'https://evil.example/', why: 'x', at })).toBeNull();
    expect(v({ recordType: 'project-app-pin', conversationKey: CK, appRef: REF, platform: 'telegram', state: 'posted', opId: 'abcdefgh12', messageId: '42', baseUrl: 'https://evil.example/phish', at })).toBeNull();
    expect(v({ recordType: 'project-app-pin', conversationKey: CK, appRef: REF, platform: 'telegram', state: 'pinned', opId: 'abcdefgh12', at })).toBeNull();
    expect(v({ recordType: 'project-app-pin', conversationKey: CK, appRef: REF, platform: 'telegram', state: 'act', opId: 'abcdefgh12', at })).toBeNull();
    expect(v({ recordType: 'project-app-pin', conversationKey: CK, appRef: REF, platform: 'telegram', state: 'pinned', act: 'attach', opId: 'abcdefgh12', messageId: '1', at })).toBeNull();
  });
  it('accepts record types from a later build as inert stubs, and (part 2) validates custom app refs like builtin ones', () => {
    expect(v({ recordType: 'project-app-summary', conversationKey: CK, appRef: 'custom:pa_0123456789abcdef', at, headline: 'x' })).toEqual({ recordType: 'project-app-summary' });
    expect(v({ recordType: 'project-app-later-thing', conversationKey: CK, at })).toEqual({ recordType: 'project-app-later-thing' });
    expect(v({ recordType: 'project-app-answer', conversationKey: CK, appRef: 'custom:pa_0123456789abcdef', answer: 'attach', by: 'owner', via: 'console', at })).toEqual({ recordType: 'project-app-answer', conversationKey: CK, appRef: 'custom:pa_0123456789abcdef', answer: 'attach', by: 'owner', via: 'console', at });
    expect(v({ recordType: 'project-app-answer', conversationKey: CK, appRef: 'custom:pa_XYZ', answer: 'attach', by: 'owner', via: 'console', at })).toBeNull();
    expect(v({ recordType: 'not-ours', conversationKey: CK, appRef: REF, at })).toBeNull();
  });
  it('knows the builtin list and the switch', () => {
    expect(builtinApp(REF)?.title).toBe('Feature maturation board');
    expect(builtinApp('builtin:nope')).toBeNull();
    expect(projectAppsEnabled({ developmentAgent: true })).toBe(true);
    expect(projectAppsEnabled({ developmentAgent: true, projectApps: { enabled: false } })).toBe(false);
    expect(projectAppsEnabled({ developmentAgent: false })).toBe(false);
    expect(projectAppsEnabled({ developmentAgent: true, chiefOfStaff: { enabled: false } })).toBe(false);
  });
});

describe('the attachment fold', () => {
  const offer = () => entry(buildOffer({ conversationKey: CK, appRef: REF, why: 'Same table.', at }));
  const ans = (answer: 'attach' | 'decline' | 'detach' | 'withdraw', by: 'owner' | 'agent' = 'owner') => entry(buildAnswer({ conversationKey: CK, appRef: REF, answer, by, via: by === 'owner' ? 'console' : 'bearer', at }));
  const state = (u: UnionEntry[]) => foldPairs(u).get(`${CK}\u0000${REF}`)!;
  it('offered → attached → detached, newest owner answer wins', () => {
    const u = [offer()];
    expect(state(u).state).toBe('offered');
    u.push(ans('attach')); expect(state(u).state).toBe('attached');
    u.push(ans('detach')); expect(state(u).state).toBe('detached');
    u.push(ans('attach')); expect(state(u).state).toBe('attached');
  });
  it("the agent's withdraw never undoes an owner's attach, whatever its time", () => {
    const u = [offer(), ans('attach'), ans('withdraw', 'agent')];
    expect(state(u).state).toBe('attached');
  });
  it('withdraw on an open offer marks it withdrawn and still blocks a second offer', () => {
    const s = state([offer(), ans('withdraw', 'agent')]);
    expect(s.state).toBe('withdrawn');
    expect(s.offerBlocked).toBe(true);
  });
  it('a decline blocks re-offers; an attach with no offer is valid', () => {
    expect(state([offer(), ans('decline')]).offerBlocked).toBe(true);
    expect(state([ans('attach')]).state).toBe('attached');
  });
});

describe('pin steps', () => {
  const BASE = 'https://echo.example.dev';
  const step = (state: string, extra: Record<string, unknown> = {}) => entry(buildPinEvent({ conversationKey: CK, appRef: REF, platform: 'telegram', state: state as 'posted', opId: 'op12345678', at, ...extra }));
  const pins = (u: UnionEntry[]) => foldPins(u, CK, REF);
  it('attach with nothing posted yet → post; a posted message is pinned by id, never sent again', () => {
    expect(nextPinAction('attach', true, null, BASE)).toEqual({ kind: 'post' });
    const u = [step('pending'), step('posted', { messageId: '42', baseUrl: BASE })];
    expect(nextPinAction(null, true, pins(u), BASE)).toEqual({ kind: 'pin', messageId: '42' });
    expect(nextPinAction('retry', true, pins(u), BASE)).toEqual({ kind: 'pin', messageId: '42' });
  });
  it('no act → never a new message', () => {
    expect(nextPinAction(null, true, null, BASE).kind).toBe('none');
  });
  it('a pending with no outcome is uncertain: only post-again sends', () => {
    const u = [step('pending')];
    expect(pinUncertain(pins(u))).toBe(true);
    expect(nextPinAction('retry', true, pins(u), BASE)).toEqual({ kind: 'none', why: 'uncertain' });
    expect(nextPinAction('post-again', true, pins(u), BASE).kind).toBe('post');
  });
  it('detached → unpin every live link; nothing live → nothing', () => {
    const u = [step('posted', { messageId: '42', baseUrl: BASE }), step('pinned', { messageId: '42' })];
    expect(nextPinAction(null, false, pins(u), BASE)).toEqual({ kind: 'unpin', messageId: '42' });
    u.push(step('unpinned', { messageId: '42' }));
    expect(nextPinAction(null, false, pins(u), BASE).kind).toBe('none');
  });
  it('address change → edit in place on its own; message-missing → Update link posts a replacement', () => {
    const OLD = 'https://old.example.dev';
    const u = [step('posted', { messageId: '42', baseUrl: OLD }), step('pinned', { messageId: '42' })];
    expect(pinOutOfDate(pins(u), BASE)).toBe(true);
    expect(nextPinAction(null, true, pins(u), BASE)).toEqual({ kind: 'edit', messageId: '42' });
    u.push(step('failed', { messageId: '42', reason: 'message-missing' }));
    expect(nextPinAction(null, true, pins(u), BASE).kind).toBe('none');
    expect(nextPinAction('update-link', true, pins(u), BASE)).toEqual({ kind: 'post', replacesMessageId: '42' });
  });
  it('a pinned fresh link plus an older one → unpin the older one', () => {
    const OLD = 'https://old.example.dev';
    const u = [step('posted', { messageId: '41', baseUrl: OLD }), step('pinned', { messageId: '41' }), step('posted', { messageId: '42', baseUrl: BASE }), step('pinned', { messageId: '42' })];
    expect(nextPinAction(null, true, pins(u), BASE)).toEqual({ kind: 'unpin', messageId: '41' });
  });
  it('after a failed pin, nothing runs on its own; an act retries once', () => {
    const u = [step('posted', { messageId: '42', baseUrl: BASE }), step('failed', { reason: 'not enough rights' })];
    expect(nextPinAction(null, true, pins(u), BASE).kind).toBe('none');
    expect(nextPinAction('retry', true, pins(u), BASE)).toEqual({ kind: 'pin', messageId: '42' });
  });
  it('no public address → nothing', () => {
    expect(nextPinAction('attach', true, null, null)).toEqual({ kind: 'none', why: 'no-public-address' });
  });
});
