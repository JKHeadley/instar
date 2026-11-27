/**
 * The Chief of Staff entry in the console's one list of operator needs (chief-of-staff-topic.md §1.4, §5):
 * parked / breaker / waiting-on-user projects and the lease state become rows on Home; 503 (feature off)
 * is nothing waiting; a 200 without the shape is unreadable (never "nothing waiting"); no projects ⇒
 * no lease nag.
 */
import { describe, it, expect } from 'vitest';
import { chiefOfStaffNeedRows, NEED_SOURCES, cutAtWord as cutJs, shortProjectTitle as shortJs } from '../../dashboard/console/needs-model.js';
import { cutAtWord as cutTs, shortProjectTitle as shortTs } from '../../src/core/ChiefOfStaffLoop.js';

const NOW = Date.parse('2026-11-10T08:00:00Z');
const ok = (data) => ({ ok: true, status: 200, data });

describe('chiefOfStaffNeedRows', () => {
  it('is registered as a need source reading GET /chief-of-staff', () => {
    const s = NEED_SOURCES.find((x) => x.id === 'chief-of-staff');
    expect(s?.reads).toEqual({ cos: '/chief-of-staff' });
  });
  it('503 (feature off) ⇒ nothing waiting; a 500 or a shapeless 200 ⇒ unreadable', () => {
    expect(chiefOfStaffNeedRows({ ok: false, reason: 'switched off on this agent' }, NOW)).toEqual([]);
    expect(chiefOfStaffNeedRows({ ok: false, status: 503 }, NOW)).toEqual([]);
    expect(chiefOfStaffNeedRows({ ok: false, status: 500 }, NOW)).toBeNull();
    expect(chiefOfStaffNeedRows(ok({ hello: 1 }), NOW)).toBeNull();
  });
  it('parked, breaker and waiting projects become rows; a live lease with time left adds nothing', () => {
    const rows = chiefOfStaffNeedRows(ok({ lease: { live: true, expiresAt: '2026-11-13T08:00:00Z' }, projects: [
      { conversationKey: 'telegram:1', goal: 'Ship the thing', parked: true, restartsWithoutProgress: 3 },
      { conversationKey: 'telegram:2', goal: 'Docs', breakerTripped: true, parked: true },
      { conversationKey: 'telegram:3', goal: 'Site', lastVerdict: 'waiting-on-user' },
      { conversationKey: 'telegram:4', goal: 'Quiet', lastVerdict: 'moving' },
    ] }), NOW);
    expect(rows.map((r) => r.key)).toEqual(['need:cos:parked:telegram:1', 'need:cos:breaker:telegram:2', 'need:cos:waiting:telegram:3']);
    expect(rows[0].main).toContain('Ship the thing'); expect(rows[0].main).toContain('3 restarts');
  });
  it('a paused lease is one row; a lease expiring within a day is one row; no projects ⇒ no lease row', () => {
    const paused = chiefOfStaffNeedRows(ok({ lease: { live: false, expiresAt: null }, projects: [{ conversationKey: 'telegram:1', goal: 'g', lastVerdict: 'moving' }] }), NOW);
    expect(paused.map((r) => r.key)).toEqual(['need:cos:paused']);
    const soon = chiefOfStaffNeedRows(ok({ lease: { live: true, expiresAt: '2026-11-10T20:00:00Z' }, projects: [{ conversationKey: 'telegram:1', goal: 'g', lastVerdict: 'moving' }] }), NOW);
    expect(soon.map((r) => r.key)).toEqual(['need:cos:expiring']);
    expect(chiefOfStaffNeedRows(ok({ lease: { live: false, expiresAt: null }, projects: [] }), NOW)).toEqual([]);
  });
  it('project names are short and never cut mid-word; the server title wins; each project row opens its own conversation', () => {
    const long = "Emily Ghosh's affiliate intelligence project: confirm the weekly affiliate report reaches Emily and she can act on it";
    const rows = chiefOfStaffNeedRows(ok({ lease: { live: true, expiresAt: '2026-11-13T08:00:00Z' }, projects: [
      { conversationKey: 'telegram:1', goal: long, lastVerdict: 'waiting-on-user' },
      { conversationKey: 'telegram:2', goal: long, title: 'Monroe launch', lastVerdict: 'waiting-on-user' },
      { conversationKey: 'telegram:3', goal: 'Keep every one of the customer onboarding flows working smoothly across all of the regions we serve', lastVerdict: 'waiting-on-user' },
    ] }), NOW);
    expect(rows[0].main).toBe("Emily Ghosh's affiliate intelligence project is waiting on you");
    expect(rows[1].main).toBe('Monroe launch is waiting on you');
    expect(rows[2].main).toBe('Keep every one of the customer onboarding flows working… is waiting on you');
    expect(rows[0].action.href).toBe('#/work/chats?c=telegram%3A1');
    expect(rows[0].sub).toBe('The project is waiting for your reply in its conversation.');
    for (const r of rows) expect(r.main).not.toMatch(/\w…\w/);
  });
  it('uses a plain fallback when a waiting project has no display name', () => {
    const rows = chiefOfStaffNeedRows(ok({ lease: { live: true }, projects: [
      { conversationKey: 'telegram:456', lastVerdict: 'waiting-on-user' },
    ] }), NOW);
    expect(rows[0].main).toBe('A project is waiting on you');
    expect(rows[0].action.href).toBe('#/work/chats?c=telegram%3A456');
  });
  it('the dashboard name rule matches the note rule exactly', () => {
    const goals = ["Emily Ghosh's affiliate intelligence project: confirm the weekly report", 'Get Monroe AI ready for public launch: DNS, chat rate limits', 'Billing cleanup — every invoice matched', 'Ship the iOS app. Then tell the beta group.', 'https://example.com goes live', 'Keep every one of the customer onboarding flows working smoothly across all of the regions we serve', '   ', 'Supercalifragilisticexpialidociousandthensome'];
    for (const g of goals) for (const max of [20, 40, 60]) { expect(shortJs(g, max)).toBe(shortTs(g, max)); expect(cutJs(g, max)).toBe(cutTs(g, max)); }
  });
});

describe('the Conversations card does not repeat the Needs-you list (2026-11-20 dashboard audit)', () => {
  it('with the list on screen only the check-in rows stay; without it every row shows', async () => {
    const { chiefOfStaffCardRows } = await import('../../dashboard/console/needs-model.js');
    const rows = [{ key: 'need:cos:waiting:telegram:1', main: 'A is waiting on you' }, { key: 'need:cos:parked:telegram:2', main: 'B is parked' }, { key: 'need:cos:expiring', main: 'Your Chief of Staff pauses within a day unless you check in' }];
    expect(chiefOfStaffCardRows(rows, { stripShown: true }).map((r) => r.key)).toEqual(['need:cos:expiring']);
    expect(chiefOfStaffCardRows(rows, { stripShown: false })).toHaveLength(3);
    expect(chiefOfStaffCardRows(rows.slice(0, 2), { stripShown: true })).toEqual([]);
    expect(chiefOfStaffCardRows(null)).toEqual([]);
  });
  it('the Conversations page reads whether the list is on screen (wiring)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../dashboard/console/chats.js', import.meta.url), 'utf8');
    expect(src).toContain("document.querySelector('#needsStrip:not([hidden])')");
    expect(src).toContain('chiefOfStaffCardRows(this.cosNeeds, { stripShown })');
  });
});
