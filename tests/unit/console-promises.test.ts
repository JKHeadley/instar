/**
 * Console Promises page (docs/specs/console-features/work.md, "Promises"): the
 * sections, Home agreement, coverage honesty, the story, the actions, and the
 * shipped page in jsdom (sections, detail sheet, conversation link, deliver).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildPromisesPage, storyOf, actionsFor, until, nextDue, dedupeRows, looksLikePromise, replicaWords, toRow } from '../../dashboard/console/promises-model.js';
import { buildPromised } from '../../dashboard/console/home-model.js';
import { topicLink } from '../../dashboard/console/promises.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const inMins = (m: number) => new Date(NOW + m * 60_000).toISOString();
const c = (over: Record<string, unknown>) => ({ id: `CMT-${Math.random().toString(36).slice(2, 7)}`, status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: minsAgo(60), agentResponse: "I'll do X and report back.", userRequest: 'Please X', viewSource: 'own', originMachineId: 'm1', ...over });
const mesh = (rows: unknown[]) => ok({ enabled: true, scope: 'mesh', commitments: rows });

describe('promises page model', () => {
  it('fails honestly', () => {
    expect(buildPromisesPage({ ok: false, reason: 'no answer within 8 seconds' }, NOW).ok).toBe(false);
    expect(buildPromisesPage(ok({ enabled: false, commitments: [] }), NOW).reason).toContain('switched off');
  });

  it('sorts into waiting, missed, due soon, carrying, handled and closed', () => {
    const rows = [
      c({ blockedOn: 'user-input' }),
      c({ status: 'violated' }),
      c({ hardDeadlineAt: minsAgo(5), agentResponse: "I'll send the summary by tonight." }), // distinct wording: not a duplicate of the one above
      c({ nextUpdateDueAt: inMins(120) }),
      c({}),
      c({ createdAt: minsAgo(60 * 24 * 30) }),
      c({ status: 'delivered', resolvedAt: minsAgo(60) }),
      c({ status: 'delivered', resolvedAt: minsAgo(60 * 24 * 10) }),
    ];
    const p = buildPromisesPage(mesh(rows), NOW, { expectedPeers: 0 });
    // `open` is THE open total (waiting + missed + missedUnclear + dueSoon + carrying); the 14-day-old one is `older`, out of it.
    expect(p.counts).toEqual({ waiting: 1, missed: 2, missedUnclear: 0, dueSoon: 1, carrying: 1, handled: 1, closed: 1, open: 5, older: 1, olderWaiting: 0 });
    expect(p.headline).toBe('1 promise is waiting on you.');
    expect(p.sub).toBe("5 open in all: 1 waiting on you, 2 missed, 2 I'm carrying (1 due within a day).");
  });

  it('a missed promise stays in Missed at any age (age is not evidence it was handled)', () => {
    const p = buildPromisesPage(mesh([c({ status: 'violated', createdAt: minsAgo(60 * 24 * 90) })]), NOW, { expectedPeers: 0 });
    expect(p.counts.missed).toBe(1);
    expect(p.counts.handled).toBe(0);
  });

  it('agrees with Home on what is waiting on the operator', () => {
    const rows = [c({ blockedOn: 'user-input' }), c({ owner: 'user', blockedOn: 'user-authorization', actionClass: 'deploy' }), c({ blockedOn: 'user-input', createdAt: minsAgo(60 * 24 * 20) })];
    expect(buildPromisesPage(mesh(rows), NOW, { expectedPeers: 0 }).counts.waiting).toBe(buildPromised(mesh(rows), NOW, 0).waitingCount);
  });

  it('says when other machines are not covered', () => {
    expect(buildPromisesPage(mesh([c({})]), NOW).coverage).toContain('Only this machine');
    expect(buildPromisesPage(mesh([c({ viewSource: 'replica', originMachineId: 'm2' })]), NOW, { expectedPeers: 1 }).coverage).toContain('out of date');
    expect(buildPromisesPage(mesh([c({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 })]), NOW, { expectedPeers: 1 }).coverage).toBeNull();
  });

  it('names the machine a replica row came from', () => {
    const p = buildPromisesPage(mesh([c({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 120_000 })]), NOW, { expectedPeers: 1, names: { m2: 'Mac Mini' } });
    expect(p.sections.carrying[0].sub).toContain('from Mac Mini, 2 min old');
  });

  it('tells the story in plain sentences', () => {
    const lines = storyOf(c({ blockedOn: 'user-authorization', actionClass: 'prod-deploy', hardDeadlineAt: inMins(60) }), NOW);
    expect(lines.map((l) => l.label)).toEqual(['You asked', 'I said', 'Waiting on', 'Next check']);
    expect(lines[2].text).toBe('your approval (prod deploy)');
  });

  it('offers deliver and drop on open promises, resume on paused ones, nothing on closed', () => {
    expect(actionsFor(c({}))).toEqual(['deliver', 'withdraw']);
    expect(actionsFor(c({ beaconPaused: true }))).toContain('resume');
    expect(actionsFor(c({ status: 'delivered' }))).toEqual([]);
    // The server refuses delivery of a verified promise and accepts dropping a missed one.
    expect(actionsFor(c({ status: 'verified' }))).toEqual(['withdraw']);
    expect(actionsFor(c({ status: 'violated' }))).toEqual(['withdraw']);
  });

  it('formats due times and picks the soonest real date', () => {
    expect(until(NOW + 30 * 60_000, NOW)).toBe('in 30 min');
    expect(until(NOW + 5 * 3600_000, NOW)).toBe('in 5 h');
    expect(nextDue(c({ nextUpdateDueAt: inMins(90), hardDeadlineAt: inMins(30) }))).toBe(NOW + 30 * 60_000);
  });

  it('links a main-group topic to Telegram, never an issue topic', () => {
    expect(topicLink('-1003742343280', 9210)).toBe('https://t.me/c/3742343280/9210');
    expect(topicLink('-1003742343280', 10000000850)).toBeNull();
    expect(topicLink(null, 9210)).toBeNull();
  });
});

describe('promises page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('renders sections, opens a sheet with the conversation link, and marks a promise done', async () => {
    const posted: string[] = [];
    const rows = [c({ id: 'CMT-1', blockedOn: 'user-input', topicId: 9210, agentResponse: 'Need your pick' }), c({ id: 'CMT-2' })];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/promises' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts?: { method?: string }) => {
      if (opts && opts.method === 'POST') { posted.push(url); return { ok: true, status: 200, json: async () => ({ delivered: true }) }; }
      const table: Record<string, unknown> = {
        '/sessions': { sessions: [] },
        '/health': { project: { name: 'echo' } },
        '/commitments?scope=mesh': { enabled: true, scope: 'mesh', commitments: rows },
        '/pool': { selfMachineId: 'm1', machines: [{ machineId: 'm1', nickname: 'Mac Studio', servesChannels: { telegram: { chatIds: ['-1003742343280'] } } }] },
      };
      const body = table[url];
      return body === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    expect(doc.querySelector('.page-title')!.textContent).toBe('1 promise is waiting on you.');
    expect(doc.querySelectorAll('#sec-waiting button.row')).toHaveLength(1);
    expect(doc.querySelector('#sec-carrying .list-rows')!.hasAttribute('hidden')).toBe(true);
    (doc.querySelector('#sec-waiting button.row') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    const link = doc.querySelector('.sheet-actions a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://t.me/c/3742343280/9210');
    const done = [...doc.querySelectorAll('.sheet-actions button')].find((b) => b.textContent === 'Mark as done') as HTMLButtonElement;
    done.click();
    const confirmGo = [...doc.querySelectorAll('.confirm-row button')].find((b) => b.textContent === 'Mark as done') as HTMLButtonElement;
    confirmGo.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(posted).toEqual(['/commitments/CMT-1/deliver']);
    expect(doc.querySelector('.action-status')!.textContent).toBe('Marked as done.');
  });
});


describe('QA content fixes — Promises › Missed', () => {
  it('collapses word-for-word duplicates into one row that says how many times it was said; the count and the fact agree', () => {
    const text = 'On it. Deleting the leftover fake message first, then opening the leak fix as a pull request. I’ll report back as each lands.';
    const rows = [
      c({ id: 'CMT-1', status: 'violated', agentResponse: text, createdAt: minsAgo(60 * 24 * 66) }),
      c({ id: 'CMT-2', status: 'violated', agentResponse: text, createdAt: minsAgo(60 * 24 * 66 + 5) }),
      c({ id: 'CMT-3', status: 'violated', agentResponse: text.toUpperCase(), createdAt: minsAgo(60 * 24 * 66 + 9) }),
      c({ id: 'CMT-4', status: 'violated', agentResponse: 'I’ll check every credential against Bitwarden and report back.', createdAt: minsAgo(60 * 24 * 33) }),
    ];
    const p = buildPromisesPage(mesh(rows), NOW, { expectedPeers: 0 });
    expect(p.counts.missed).toBe(2);
    expect(p.headline).toBe('2 promises were missed.');
    expect(p.sections.missed.map((r: { id: string }) => r.id)).toEqual(['CMT-4', 'CMT-1']); // newest first; the newest copy stands for its duplicates
    const dup = p.sections.missed[1];
    expect(dup.sub).toBe('missed · said 3 times');
    expect(dup.dupes.map((d: { id: string }) => d.id)).toEqual(['CMT-2', 'CMT-3']);
    expect(p.sections.missed[0].dupes).toEqual([]);
    expect(dedupeRows([{ key: 'a', main: 'x', sub: 'missed' }, { key: 'b', main: 'y', sub: 'missed' }])).toHaveLength(2);
    // Same first sentence, different promise: kept apart (the title is only a brief).
    const twins = buildPromisesPage(mesh([
      c({ status: 'violated', agentResponse: 'On it. I will merge PR 1 and report back.' }),
      c({ status: 'violated', agentResponse: 'On it. I will rewrite the spec and report back.' }),
    ]), NOW, { expectedPeers: 0 });
    expect(twins.counts.missed).toBe(2);
  });
  it('a missed record with no promise language is set apart as "maybe not a promise", never dropped and never counted as missed', () => {
    const rows = [
      c({ status: 'violated', agentResponse: 'Changing the schedule now' }),
      c({ status: 'violated', agentResponse: 'Exactly what you asked for, and the pull request is down to those two lines.' }),
      c({ status: 'violated', agentResponse: 'Moving the switch to now so builds go live as soon as they’re ready. Back shortly.' }),
    ];
    const p = buildPromisesPage(mesh(rows), NOW, { expectedPeers: 0 });
    expect(p.counts.missed).toBe(1);
    expect(p.counts.missedUnclear).toBe(2);
    expect(p.sections.missed[0].record.agentResponse).toMatch(/Back shortly/);
    expect(looksLikePromise({ agentResponse: 'Changing the schedule now' })).toBe(false);
    expect(looksLikePromise({ agentResponse: 'I will send the summary tonight.' })).toBe(true);
    expect(looksLikePromise({ agentResponse: 'Got it — checking the live state now. Back shortly with the real list.' })).toBe(true);
    expect(looksLikePromise({ agentResponse: '' })).toBe(false);
  });
  it('a replica row says "current", an age, or "age unknown" — never "just now old"', () => {
    const names = { m2: 'Laptop' };
    expect(replicaWords({ originMachineId: 'm2', stalenessMs: 1000 }, names, NOW)).toBe('from Laptop, current');
    expect(replicaWords({ originMachineId: 'm2', stalenessMs: 18 * 3600000 }, names, NOW)).toBe('from Laptop, 18 h old');
    expect(replicaWords({ originMachineId: 'm2', stalenessMs: null }, names, NOW)).toBe('from Laptop, age unknown');
    const row = toRow(c({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 5000 }), NOW, names);
    expect(row.sub).not.toMatch(/just now old/);
    expect(row.sub).toContain('from Laptop, current');
  });
});
