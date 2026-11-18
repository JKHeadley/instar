import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { composeProjects, projectState, mountProjectsRoutes, PROJECT_STATE_WORDS, PROJECTS_MAX_CARDS_PER_PROJECT, type CosProjectRow } from '../../src/server/workProjectsRoutes.js';

const proj = (over: Partial<CosProjectRow> = {}): CosProjectRow => ({
  conversationKey: 'telegram:142909', title: 'Android app', goal: 'An Android app at the iPhone level.', lastVerdict: 'moving', lastCheckAt: '2026-11-16T08:30:50.653Z', parked: false,
  doneDefinition: [{ id: 'a', text: 'Pairs end to end' }, { id: 'b', text: 'On a Play testing track' }], doneItems: { a: 'pass', b: 'unknown' }, ...over,
});
const board = (cards: Array<Record<string, unknown>>, lane = 'waiting-on-you') => ({ status: 200, body: { lanes: [{ lane, cards }, { lane: 'archived', cards: [{ id: 'wc_arch', title: 'old', projectKey: 'telegram:142909' }] }] } });

describe('projectState', () => {
  it('maps every Chief of Staff verdict to one plain state', () => {
    expect(projectState({ lastVerdict: 'done-verified', parked: false })).toBe('done');
    expect(projectState({ lastVerdict: 'claims-done', parked: false })).toBe('claims-done');
    expect(projectState({ lastVerdict: 'waiting-on-user', parked: false })).toBe('waiting-on-you');
    expect(projectState({ lastVerdict: 'moving', parked: false })).toBe('moving');
    expect(projectState({ lastVerdict: 'moving-under-existing-owner', parked: false })).toBe('moving');
    expect(projectState({ lastVerdict: 'stalled', parked: false })).toBe('stalled');
    expect(projectState({ lastVerdict: 'drifting', parked: false })).toBe('drifting');
    expect(projectState({ lastVerdict: 'unknown', parked: false })).toBe('unknown');
    expect(projectState({ lastVerdict: null, parked: false })).toBe('unknown');
  });
  it('a project the loop gave up on reads "I stopped retrying", never paused by the owner; done still wins', () => {
    expect(projectState({ lastVerdict: 'stalled', parked: true })).toBe('stopped-retrying');
    expect(PROJECT_STATE_WORDS['stopped-retrying']).toBe('I stopped retrying: needs a look');
    expect(PROJECT_STATE_WORDS['stopped-retrying']).not.toMatch(/paused/i);
    expect(projectState({ lastVerdict: 'done-verified', parked: true })).toBe('done');
  });
});

describe('the owner pause', () => {
  const pause = { who: 'owner', at: '2026-11-13T16:52:00Z', quote: 'lets pause the Instar 2.0 work again', messageRef: 'telegram:102965:1' };
  it('reads "Paused by you" ahead of the verdict, with the owner\'s own words', () => {
    expect(projectState({ lastVerdict: 'stalled', parked: true, pausedBy: pause })).toBe('paused');
    const a = composeProjects([proj({ lastVerdict: 'unknown', pausedBy: pause })], board([]));
    expect(a.projects[0]).toMatchObject({ state: 'paused', stateWords: 'Paused by you', paused: { at: pause.at, quote: pause.quote } });
  });
  it('without a pause record nothing reads as paused; a finished project stays Done', () => {
    expect(projectState({ lastVerdict: 'unknown', parked: false, pausedBy: null })).toBe('unknown');
    expect(composeProjects([proj()], board([])).projects[0].paused).toBeNull();
    expect(projectState({ lastVerdict: 'done-verified', parked: false, pausedBy: pause })).toBe('done');
  });
  it('the loop reads only a complete pause record from the binding', async () => {
    const { ownerPause } = await import('../../src/core/ChiefOfStaffLoop.js');
    expect(ownerPause({ pausedBy: pause })).toEqual(pause);
    expect(ownerPause({ pausedBy: { ...pause, messageRef: '' } })).toBeNull();
    expect(ownerPause({ pausedBy: 'yes' })).toBeNull();
    expect(ownerPause({})).toBeNull();
    expect(ownerPause(null)).toBeNull();
  });
});

describe('composeProjects', () => {
  it('joins cards to their project by projectKey, lists the rest apart, and skips archived cards', () => {
    const a = composeProjects([proj()], board([
      { id: 'wc_1', title: 'Pick the launch date', lane: 'waiting-on-you', needLine: 'Needs your approval', conversationKey: 'c1', projectKey: 'telegram:142909' },
      { id: 'wc_2', title: 'Loose card', lane: 'with-agent', needLine: null, conversationKey: 'c2', projectKey: null },
      { id: 'wc_3', title: 'Unknown project', lane: 'with-agent', conversationKey: 'c3', projectKey: 'telegram:999' },
    ]));
    expect(a.projects).toHaveLength(1);
    expect(a.projects[0].cards.map((c) => c.id)).toEqual(['wc_1']);
    expect(a.notInProject.map((c) => c.id)).toEqual(['wc_2', 'wc_3']);
    expect(JSON.stringify(a)).not.toContain('wc_arch');
    expect(a.projects[0].done).toMatchObject({ met: 1, total: 2 });
    expect(a.projects[0].stateWords).toBe('Moving');
    expect(a.complete).toBe(true);
  });
  it('orders what needs the person first and finished projects last', () => {
    const a = composeProjects([
      proj({ conversationKey: 'telegram:1', title: 'B done', lastVerdict: 'done-verified' }),
      proj({ conversationKey: 'telegram:2', title: 'A moving' }),
      proj({ conversationKey: 'telegram:3', title: 'C waiting', lastVerdict: 'waiting-on-user' }),
    ], board([]));
    expect(a.projects.map((p) => p.state)).toEqual(['waiting-on-you', 'moving', 'done']);
  });
  it('names a source it could not read instead of showing no projects', () => {
    const failed = composeProjects('failed', board([]));
    expect(failed.complete).toBe(false);
    expect(failed.couldNotCheck).toEqual(['the projects']);
    const boardDown = composeProjects([proj()], { status: 500, body: { error: 'boom' } });
    expect(boardDown.couldNotCheck).toEqual(['the work board']);
    expect(boardDown.projects).toHaveLength(1);
  });
  it('a feature switched off is off, not "could not check"', () => {
    const a = composeProjects(null, { status: 503, body: { error: 'work-board-disabled' } });
    expect(a.complete).toBe(true);
    expect(a.sources.map((s) => s.state)).toEqual(['off', 'off']);
    expect(a.projects).toEqual([]);
  });
  it('caps the cards per project and says how many more', () => {
    const many = Array.from({ length: PROJECTS_MAX_CARDS_PER_PROJECT + 3 }, (_, i) => ({ id: `wc_${i}`, title: `c${i}`, lane: 'done', projectKey: 'telegram:142909' }));
    const a = composeProjects([proj()], board(many, 'done'));
    expect(a.projects[0].cards).toHaveLength(PROJECTS_MAX_CARDS_PER_PROJECT);
    expect(a.projects[0].moreCards).toBe(3);
  });
});

describe('the projects routes', () => {
  const app = (projects: () => CosProjectRow[] | null | 'failed') => {
    const a = express();
    const r = express.Router();
    mountProjectsRoutes(r, { projects, boardFor: () => board([]), bearerOk: (req) => req.headers.authorization === 'Bearer t' });
    a.use(r);
    return a;
  };
  it('the owner (bearer) gets the projects; an unknown caller is refused', async () => {
    const ok = await request(app(() => [proj()])).get('/work/projects').set('Authorization', 'Bearer t');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ schemaVersion: 1, viewer: { role: 'owner' }, complete: true });
    expect(ok.body.projects[0].title).toBe('Android app');
    expect((await request(app(() => [proj()])).get('/work/projects')).status).toBe(403);
  });
  it('a Chief of Staff read that throws is "could not check the projects", not a 500', async () => {
    const r = await request(app(() => { throw new Error('journal unreadable'); })).get('/work/projects').set('Authorization', 'Bearer t');
    expect(r.status).toBe(200);
    expect(r.body.couldNotCheck).toEqual(['the projects']);
  });
});

describe('the console Projects model', () => {
  it('keeps routing identifiers in links instead of presenting them as project names', async () => {
    const { projectsView } = await import('../../dashboard/console/projects-model.js');
    for (const title of ['', '   ', 'telegram:142909', '142909', 'Topic 142909']) {
      const view = projectsView(composeProjects([proj({ title })], board([])));
      expect(view.active[0].title).toBe('Project name unavailable');
      expect(view.active[0].key).toBe('telegram:142909');
      expect(view.active[0].chatHref).toBe('#/work/chats?c=telegram%3A142909');
    }
    const view = projectsView(composeProjects([proj({ title: '  Android app  ' })], board([])));
    expect(view.active[0].title).toBe('Android app');
  });

  it('shapes rows with links, keeps Done apart, and never says "no projects" on an incomplete read', async () => {
    const { projectsView, conversationHref } = await import('../../dashboard/console/projects-model.js');
    const a = composeProjects([
      proj({ conversationKey: 'telegram:1', title: 'Live', lastVerdict: 'waiting-on-user' }),
      proj({ conversationKey: 'telegram:2', title: 'Shipped', lastVerdict: 'done-verified' }),
    ], board([{ id: 'wc_1', title: 'Pick the date', lane: 'waiting-on-you', needLine: 'Needs your approval', conversationKey: '0b0c0d0e-0f10-5111-8213-141516171819', projectKey: 'telegram:1' }]));
    const v = projectsView(a);
    expect(v.ok).toBe(true);
    expect(v.active.map((p: { title: string }) => p.title)).toEqual(['Live']);
    expect(v.finished.map((p: { title: string }) => p.title)).toEqual(['Shipped']);
    expect(v.active[0]).toMatchObject({ stateWords: 'Waiting on you', tone: 'attn', doneLine: '1 of 2 done', cardsLine: '1 card', chatHref: '#/work/chats?c=telegram%3A1' });
    expect(v.active[0].cards[0]).toMatchObject({ href: '#/work/board?card=wc_1', chatHref: '#/work/chats?c=app%3A0b0c0d0e-0f10-5111-8213-141516171819' });
    expect(conversationHref('')).toBeNull();
    const partial = projectsView(composeProjects('failed', board([])));
    expect(partial.empty).toBe(false);
    expect(partial.line).toBe('Could not check the projects, so this may not be everything.');
    expect(projectsView(composeProjects([], board([]))).empty).toBe(true);
    expect(projectsView(null).ok).toBe(false);
    const unchecked = projectsView(composeProjects([proj({ doneItems: null })], board([])));
    expect(unchecked.active[0].doneLine).toBe('2 to finish, not checked yet');
  });
});

describe('second-pass findings', () => {
  it('a board lane that arrives cut names the gap instead of reading complete', () => {
    const a = composeProjects([proj()], { status: 200, body: { lanes: [{ lane: 'waiting-on-you', cards: [{ id: 'wc_1', projectKey: 'telegram:142909' }], more: 4 }, { lane: 'done', cards: [], total: 0 }] } });
    expect(a.complete).toBe(false);
    expect(a.couldNotCheck).toEqual(['every card on the work board']);
    expect(a.projects[0].cards.map((c) => c.id)).toEqual(['wc_1']);
    const doneCut = composeProjects([proj()], { status: 200, body: { lanes: [{ lane: 'done', cards: [{ id: 'wc_2' }], total: 25 }] } });
    expect(doneCut.complete).toBe(false);
  });
  it('project tracking switched off says so, never "no projects"', async () => {
    const { projectsView } = await import('../../dashboard/console/projects-model.js');
    const v = projectsView(composeProjects(null, board([])));
    expect(v.off).toBe(true);
    expect(v.empty).toBe(false);
  });
  it('the board view gives every card when asked for the full read', async () => {
    const src = (await import('node:fs')).readFileSync('src/core/workBoardViews.ts', 'utf8');
    expect(src).toContain('opts.full ? waiting : waiting.slice(0, opts.softOpenCards)');
    expect(src).toContain('opts.full ? lanes.done :');
    expect((await import('node:fs')).readFileSync('src/server/routes.ts', 'utf8')).toContain('workBoardReadAs(req, { full: true })');
  });
});

describe('why a project is not known', () => {
  it('shows the tracker\'s last note, shortened, only for "Not known yet"', async () => {
    const { shortNote, PROJECT_WHY_MAX } = await import('../../src/server/workProjectsRoutes.js');
    const note = 'Merge status unreadable: none of the done items can be checked because the binding names no repos or branches, so the judge cannot see whether the fixes landed on main or are still open.';
    const a = composeProjects([proj({ lastVerdict: 'unknown', lastNote: note }), proj({ conversationKey: 'telegram:2', lastNote: note })], board([]));
    const unknown = a.projects.find((p) => p.state === 'unknown')!;
    expect(unknown.why!.length).toBeLessThanOrEqual(PROJECT_WHY_MAX + 1);
    expect(unknown.why!.endsWith('…')).toBe(true);
    expect(a.projects.find((p) => p.state === 'moving')!.why).toBeNull();
    expect(shortNote('Short   note.')).toBe('Short note.');
    expect(shortNote('judge-unavailable')).toBe("The tracker's last check could not run.");
    expect(composeProjects([proj({ lastVerdict: null, lastNote: null })], board([])).projects[0].why).toBeNull();
    const { projectsView } = await import('../../dashboard/console/projects-model.js');
    expect(projectsView(a).active.find((r: { state: string }) => r.state === 'unknown').whyLine).toMatch(/^Why it's not known: Merge status unreadable/);
  });
});
