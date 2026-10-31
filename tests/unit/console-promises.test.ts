/**
 * Console Promises page (docs/specs/console-features/work.md, "Promises"): the
 * sections, Home agreement, coverage honesty, the story, the actions, and the
 * shipped page in jsdom (sections, detail sheet, conversation link, deliver).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildPromisesPage, storyOf, backstoryOf, updateQuestionOf, nextStepOf, actionsFor, until, nextDue } from '../../dashboard/console/promises-model.js';
import { buildPromised } from '../../dashboard/console/home-model.js';
import { topicLink, renderPromises } from '../../dashboard/console/promises.js';
import { promiseActionLinks } from '../../dashboard/console/promise-actions.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const inMins = (m: number) => new Date(NOW + m * 60_000).toISOString();
const c = (over: Record<string, unknown>) => ({ id: `CMT-${Math.random().toString(36).slice(2, 7)}`, status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: minsAgo(60), agentResponse: 'Do X', userRequest: 'Please X', viewSource: 'own', originMachineId: 'm1', ...over });
const mesh = (rows: unknown[]) => ok({ enabled: true, scope: 'mesh', commitments: rows });

describe('promises page model', () => {
  it('fails honestly', () => {
    expect(buildPromisesPage({ ok: false, reason: 'no answer within 8 seconds' }, NOW).ok).toBe(false);
    expect(buildPromisesPage(ok({ enabled: false, commitments: [] }), NOW).reason).toContain('switched off');
  });

  it('separates missed dates from failed checks with no due date', () => {
    const rows = [
      c({ blockedOn: 'user-input' }),
      c({ status: 'violated' }),
      c({ hardDeadlineAt: minsAgo(5) }),
      c({ nextUpdateDueAt: inMins(120) }),
      c({}),
      c({ createdAt: minsAgo(60 * 24 * 30) }),
      c({ status: 'delivered', resolvedAt: minsAgo(60) }),
      c({ status: 'delivered', resolvedAt: minsAgo(60 * 24 * 10) }),
    ];
    const p = buildPromisesPage(mesh(rows), NOW, { expectedPeers: 0 });
    expect(p.counts).toEqual({ waiting: 1, missed: 0, review: 0, dueSoon: 0, carrying: 4, handled: 1, closed: 1 });
    expect(p.headline).toBe('1 promise is waiting on you.');
  });

  it('an old Echo-owned miss stays available in the collapsed audit, not the default list', () => {
    const p = buildPromisesPage(mesh([c({ status: 'violated', hardDeadlineAt: minsAgo(60 * 24 * 91), createdAt: minsAgo(60 * 24 * 90) })]), NOW, { expectedPeers: 0 });
    expect(p.counts.missed).toBe(0);
    expect(p.counts.handled).toBe(1);
  });

  it('keeps a genuine operator dependency visible even when the record is old', () => {
    const p = buildPromisesPage(mesh([c({ owner: 'user', blockedOn: 'user-input', createdAt: minsAgo(60 * 24 * 30) })]), NOW, { expectedPeers: 0 });
    expect(p.counts.waiting).toBe(1);
    expect(p.counts.handled).toBe(0);
  });

  it('keeps an internal pipeline wake out of operator attention and states its outcome is unknown', () => {
    const internal = c({ id: 'CMT-1079', source: 'pipeline-wake-2026-10-27T17:50:02Z',
      blockedOn: 'external', hardDeadlineAt: minsAgo(60),
      userRequest: 'Pipeline wake: restore a usable fallback', agentResponse: 'Echo will check the login after reset' });
    const home = buildPromised(mesh([internal]), NOW, 0);
    const page = buildPromisesPage(mesh([internal]), NOW, { expectedPeers: 0 });
    expect(home.missedCount).toBe(0);
    expect(home.state).not.toBe('bad');
    expect(page.counts.missed).toBe(0);
    expect(page.sections.carrying[0].sub).toContain('outcome unverified');
    const lines = storyOf(internal, NOW);
    expect(lines).toContainEqual({ label: 'Internal follow-up', text: internal.userRequest });
    expect(lines.some((l) => l.label === 'You asked' || l.label === 'Due date missed')).toBe(false);
    expect(lines.find((l) => l.label === 'Current status')?.text).toContain('does not confirm');
    expect(nextStepOf(internal, NOW)).toContain('Echo owns');
  });

  it('agrees with Home on what is waiting on the operator', () => {
    const rows = [c({ blockedOn: 'user-input' }), c({ owner: 'user', blockedOn: 'user-authorization', actionClass: 'deploy' }), c({ blockedOn: 'user-input', createdAt: minsAgo(60 * 24 * 20) })];
    expect(buildPromisesPage(mesh(rows), NOW, { expectedPeers: 0 }).counts.waiting).toBe(buildPromised(mesh(rows), NOW, 0).count);
  });

  it('says when other machines are not covered', () => {
    expect(buildPromisesPage(mesh([c({})]), NOW).coverage).toContain('Only this machine');
    expect(buildPromisesPage(mesh([c({ viewSource: 'replica', originMachineId: 'm2' })]), NOW, { expectedPeers: 1 }).coverage).toContain('out of date');
    expect(buildPromisesPage(mesh([c({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 })]), NOW, { expectedPeers: 1 }).coverage).toBeNull();
  });

  it('names the machine a replica row came from', () => {
    const p = buildPromisesPage(mesh([c({ viewSource: 'replica', originMachineId: 'm2', stalenessMs: 120_000 })]), NOW, { expectedPeers: 1, names: { m2: 'Mac Mini' } });
    expect(p.sections.carrying[0].sub).toContain('from Mac Mini · updated 2 min ago');
  });

  it('tells the story in plain sentences', () => {
    const lines = storyOf(c({ blockedOn: 'user-authorization', actionClass: 'prod-deploy', hardDeadlineAt: inMins(60) }), NOW);
    expect(lines.map((l) => l.label)).toEqual(['You asked', 'Echo promised', 'Waiting on', 'Due date']);
    expect(lines[2].text).toBe('your approval');
    const flagged = c({ status: 'violated', blockedOn: 'external', verificationMethod: 'freeform check description' });
    const plain = storyOf(flagged, NOW);
    expect(plain).toContainEqual({ label: 'Due date', text: 'No due date was recorded.' });
    expect(plain.map((l) => l.text).join(' ')).not.toContain('freeform check description');
    expect(nextStepOf(flagged, NOW)).toContain('No action is needed from you');
    const late = c({ hardDeadlineAt: minsAgo(60) });
    expect(storyOf(late, NOW).find((l) => l.label === 'Due date passed')?.text).toContain('Oct 25');
    expect(nextStepOf(late, NOW)).toContain('No action is needed from you');
  });

  it('shows a factual backstory and a specific update question', () => {
    const record = c({ userRequest: 'Make builds go live promptly', agentResponse: 'Remove the daily delay',
      hardDeadlineAt: minsAgo(60), lastProbe: { at: minsAgo(5), checked: 'Build queue', readinessSignal: 'Still delayed' } });
    const backstory = backstoryOf(record, NOW);
    expect(backstory.some((line) => line.label === 'Since then' && line.text.includes('due date passed'))).toBe(true);
    expect(backstory.some((line) => line.text.includes('Build queue — Still delayed'))).toBe(true);
    expect(updateQuestionOf(record, NOW)).toContain('Make builds go live promptly');
    expect(updateQuestionOf(record, NOW)).toContain('realistic new date');
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

  it('opens the verified GitHub review pages for the older rulebook request', () => {
    const record = c({ id: 'CMT-1043', originMachineId: 'm_03b30f5b32c6ef3eb0afd3ca7054e252',
      userRequest: 'Approve rulebook changes (2.0 PR 182, 1.x PR 2380)' });
    expect(promiseActionLinks(record)).toEqual([
      { label: 'Review 1.x PR 2380 on GitHub', href: 'https://github.com/JKHeadley/instar/pull/2380/files', primary: true },
      { label: 'View merged 2.0 PR 182', href: 'https://github.com/JKHeadley/instar-2/pull/182/files' },
    ]);
    expect(promiseActionLinks({ ...record, originMachineId: 'another-agent' })).toEqual([]);
    expect(promiseActionLinks({ ...record, userRequest: 'A different request' })).toEqual([]);
    expect(promiseActionLinks({ ...record, id: 'CMT-1122',
      userRequest: 'Confirm reworded-correction grouping after server update; land 1.x rulebook PR 2380' })).toEqual([
      { label: 'Review 1.x PR 2380 on GitHub', href: 'https://github.com/JKHeadley/instar/pull/2380/files', primary: true },
    ]);
  });

  it('accepts exact source links and refuses unsafe or guessed destinations', () => {
    const record = c({ actionLinks: [
      { label: 'Review PR', href: 'https://github.com/example/project/pull/12/files', primary: true },
      { label: 'Unsafe', href: 'javascript:alert(1)' },
      { label: 'Search results', href: 'https://github.com/pulls?q=12' },
    ] });
    expect(promiseActionLinks(record)).toEqual([{ label: 'Review PR', href: 'https://github.com/example/project/pull/12/files', primary: true }]);
  });
});

describe('promises page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());
  it('does not ask the operator to complete an internal follow-up', async () => {
    dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/promises' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location,
      history: dom.window.history, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    const internal = c({ id: 'CMT-1079', source: 'pipeline-wake-2026-10-27T17:50:02Z',
      hardDeadlineAt: minsAgo(60), blockedOn: 'external', topicId: 52075,
      userRequest: 'Pipeline wake: restore a usable fallback' });
    const main = dom.window.document.querySelector('main')!;
    await renderPromises(main, {
      getCommitments: async () => mesh([internal]),
      get: async () => ok({ selfMachineId: 'm1', machines: [{ machineId: 'm1', servesChannels: { telegram: { chatIds: ['-1003742343280'] } } }] }),
      post: async () => { throw new Error('An internal follow-up must not offer an operator completion action'); },
    });
    expect(main.querySelector('#sec-missed')).toBeNull();
    (main.querySelector('#sec-carrying button.row') as HTMLButtonElement).click();
    const sheet = dom.window.document.querySelector('.sheet')!;
    expect(sheet.textContent).toContain('Echo follow-up');
    expect(sheet.textContent).toContain('Internal follow-up');
    expect(sheet.textContent).toContain('Due date passed');
    expect(sheet.textContent).not.toContain('You asked');
    expect(sheet.textContent).not.toContain('Ask for an update');
    expect(sheet.querySelector('.sheet-actions button')).toBeNull();
    expect(sheet.querySelector('.sheet-actions a')?.textContent).toBe('View source conversation');
    expect(sheet.querySelector('.promise-backstory summary')?.textContent).toBe('How this came about');
  });
  it('tells the operator that a failed read is still being retried', async () => {
    dom = new JSDOM('<!doctype html><html><body><main></main></body></html>');
    Object.assign(globalThis, { document: dom.window.document, window: dom.window, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    const main = dom.window.document.querySelector('main')!;
    await renderPromises(main, {
      getCommitments: async () => ({ ok: false, reason: 'no answer within 25 seconds' }),
      get: async () => ({ ok: true, data: { machines: [] } }),
      post: async () => ({ ok: false, reason: 'unused' }),
    });
    expect(main.querySelector('.page-title')!.textContent).toBe('Still checking promises');
    expect(main.textContent).toContain('Trying again automatically while this page is open.');
    expect(main.textContent).toContain('no answer within 25 seconds');
  });

  it('opens an active deep link once, then clears it when the promise is handled', async () => {
    const posted: string[] = [];
    const rows = [c({ id: 'CMT-1', blockedOn: 'user-input', topicId: 9210, agentResponse: 'Need your pick' }), c({ id: 'CMT-2' }),
      c({ id: 'CMT-3', status: 'violated', blockedOn: 'external', topicId: 9210, verificationMethod: 'freeform text' })];
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/promises?id=CMT-1&origin=m1' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts?: { method?: string }) => {
      if (opts && opts.method === 'POST') {
        posted.push(url);
        rows[0].status = 'delivered';
        rows[0].resolvedAt = new Date().toISOString();
        return { ok: true, status: 200, json: async () => ({ delivered: true }) };
      }
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
    expect(doc.querySelector('.sheet')).not.toBeNull();
    const link = doc.querySelector('.sheet-actions a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://t.me/c/3742343280/9210');
    const done = [...doc.querySelectorAll('.sheet-actions button')].find((b) => b.textContent === 'I handled this') as HTMLButtonElement;
    done.click();
    const confirmGo = [...doc.querySelectorAll('.confirm-row button')].find((b) => b.textContent === 'I handled this') as HTMLButtonElement;
    confirmGo.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(posted).toEqual(['/commitments/CMT-1/deliver']);
    expect(doc.querySelector('.action-status')!.textContent).toBe('Marked as done.');
    await new Promise((r) => setTimeout(r, 750));
    expect(dom.window.location.hash).toBe('#/work/promises');
    expect(doc.querySelector('.sheet')).toBeNull();
    expect(doc.querySelector('#sec-waiting button.row')).toBeNull();
    dom.window.location.hash = '#/work/promises?id=CMT-1&origin=m1';
    dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
    await new Promise((r) => setTimeout(r, 100));
    expect(doc.querySelector('.sheet')).toBeNull();
    expect(dom.window.location.hash).toBe('#/work/promises');
    ([...doc.querySelectorAll('#sec-carrying button.row')].find((b) => b.textContent?.includes('needs an update')) as HTMLButtonElement).click();
    const review = doc.querySelector('.sheet')!;
    expect(review.textContent).toContain('Echo follow-up');
    expect(review.textContent).toContain('No due date was recorded.');
    expect(review.textContent).toContain('No action is needed from you');
    expect(review.querySelector('.raw')).toBeNull();
    expect(review.textContent).not.toContain('verificationMethod');
    expect(review.querySelector('.promise-backstory')).not.toBeNull();
    expect(review.querySelector('.sheet-actions a')?.textContent).toBe('Optional: copy a question and open chat');
    (review.querySelector('.sheet-actions a') as HTMLAnchorElement).click();
    expect((review.querySelector('.promise-question-wrap') as HTMLElement).hidden).toBe(false);
    expect((review.querySelector('.promise-question') as HTMLTextAreaElement).value).toContain('What is the current status');
  });
});
