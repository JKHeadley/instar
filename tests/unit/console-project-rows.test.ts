/**
 * The console's project rows that say something (docs/specs/work-door-project-rows.md §3.1, §3.2; server side PR #3396).
 * Rows are built by the server's own composeProjects, so the console reads the real shape: the latest report, why it waits
 * on the owner, why it stopped, when it was and will be checked, each done item's words, Ask for an update (no PIN), and a
 * plain pointer to the phone for Pause / Mark checked / Finish (Face ID taps the console PIN cannot stand in for, decisions
 * 6 and 8). A row from an older server (no `actions`) shows none of it.
 */
// @ts-nocheck — the console modules are browser-native ESM (.js), no types.
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { composeProjects, type CosProjectRow } from '../../src/server/workProjectsRoutes.js';
import { projectsView, checkAnswerWords } from '../../dashboard/console/projects-model.js';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const CK = 'telegram:144900';
const T0 = Date.parse('2026-11-18T08:05:00Z');
const MIN = 60_000;
const ctxNow = { here: true, tickMs: 14 * MIN, now: T0 + 5 * MIN };
const row = (over: Partial<CosProjectRow> = {}): CosProjectRow => ({
  conversationKey: CK, title: 'Rows', goal: 'Project rows that say something.', lastVerdict: 'waiting-on-user', lastCheckAt: new Date(T0).toISOString(), parked: false,
  doneDefinition: [{ id: 'pr', text: 'PR merged', kind: 'deterministic' }, { id: 'feel', text: 'Feels right on a phone', kind: 'judgment', certify: 'owner-confirms' }],
  doneItems: { pr: 'pass' }, nextCheckAt: new Date(T0 + 24 * 60 * MIN).toISOString(), breakerTripped: false, restartsWithoutProgress: 0, ownerChecks: {}, bindingRef: '5.0.m_a',
  lastReport: { at: new Date(T0).toISOString(), note: 'every deterministic done item passes; judgment items pending', verdict: 'waiting-on-user' }, ...over,
} as CosProjectRow);
const viewOf = (r: CosProjectRow) => projectsView(composeProjects([r], null, ctxNow), ctxNow.now).active[0];

describe('a row that says something', () => {
  it('waiting on you: says why, marks the judged item as waiting (never failed), and points to the phone', () => {
    const v = viewOf(row());
    expect(v.waitingLine).toBe('Every automatic check passes. It needs you to check 1 item.');
    expect(v.doneItems.map((i) => [i.text, i.mark, i.words])).toEqual([['PR merged', 'pass', 'Passes'], ['Feels right on a phone', 'waiting', 'Waiting for you to check']]);
    expect(v.phoneLine).toBe('On your phone you can pause it and check the items only you can judge (each needs Face ID).');
    expect(v.finishWhy).toBe('1 item still needs your check.');
    expect(v.checkNow).toEqual({ allowed: true, why: null });
    expect(v.checksLine).toMatch(/^Last checked .+ · next check /);
  });
  it('once the owner checked the rest, the phone line offers Finish and the item reads as done', () => {
    const v = viewOf(row({ ownerChecks: { feel: { at: new Date(T0).toISOString(), who: 'owner' } } }));
    expect(v.doneItems[1]).toMatchObject({ mark: 'pass', words: 'Checked by you' });
    expect(v.phoneLine).toBe('On your phone you can pause it and finish it (each needs Face ID).');
    expect(v.finishWhy).toBeNull();
  });
  it('a moving project shows its latest report, unconfirmed reports say so', () => {
    const v = viewOf(row({ lastVerdict: 'unknown', lastReport: { at: new Date(T0).toISOString(), note: 'It looks stalled.', verdict: 'unknown' } }));
    expect(v.waitingLine).toBeNull();
    expect(v.reportLine).toMatch(/^Not confirmed: It looks stalled\.$/);
  });
  it('a stopped project says why it stopped', () => {
    const v = viewOf(row({ parked: true, lastVerdict: 'stalled', restartsWithoutProgress: 3 }));
    expect(v.stoppedLine).toMatch(/^I restarted it 3 times without progress, so I stopped\./);
  });
  it('the phone line names an item check only when the phone can make one', () => {
    const dup = { conversationKey: CK, doneDefinition: [{ id: 'pr', text: 'PR merged', kind: 'deterministic' }, { id: 'feel', text: 'Feels right', kind: 'judgment' }, { id: 'feel', text: 'Reads well', kind: 'judgment' }] };
    expect(viewOf(row(dup)).phoneLine).not.toMatch(/check the items/);
    const deleg = { doneDefinition: [{ id: 'pr', text: 'PR merged', kind: 'deterministic' }, { id: 'docs', text: 'Docs read well', kind: 'judgment', certify: 'agent-may-certify' }] };
    expect(viewOf(row(deleg)).phoneLine).toMatch(/check the items only you can judge/);
  });
  it('a paused project: the phone can resume it, Ask is refused with the server\'s reason, the pause says where it came from', () => {
    const v = viewOf(row({ pausedBy: { who: 'owner', at: new Date(T0).toISOString(), quote: 'Paused in the Instar app.', messageRef: 'instar-app:dev1' } }));
    expect(v.state).toBe('paused');
    expect(v.phoneLine).toMatch(/^On your phone you can resume it/);
    expect(v.checkNow).toEqual({ allowed: false, why: 'It is paused.' });
    expect(v.pausedLine).toMatch(/in the Instar app: "Paused in the Instar app\."$/);
  });
  it('a row from an older server (no actions) keeps its old shape and adds nothing', () => {
    const old = { projects: [{ key: CK, title: 'Rows', state: 'moving', stateWords: 'Moving', done: { items: [{ text: 'PR merged', state: 'pass' }], met: 1, total: 1 } }] };
    const v = projectsView(old).active[0];
    expect([v.reportLine, v.waitingLine, v.stoppedLine, v.checksLine, v.checkNow, v.phoneLine, v.finishWhy]).toEqual([null, null, null, null, null, null, null]);
    expect(v.doneItems[0]).toMatchObject({ mark: 'pass', words: null });
  });
});

describe('what Ask for an update answered', () => {
  it('checked now, queued with the server\'s words, or the refusal\'s words', () => {
    expect(checkAnswerWords(200, { ok: true, queued: false })).toEqual({ ok: true, words: 'Checked just now.' });
    expect(checkAnswerWords(202, { ok: true, queued: true, words: 'The Chief of Staff will check it on its next round, within about 30 minutes.' }).words).toMatch(/within about 30 minutes/);
    expect(checkAnswerWords(409, { error: 'paused', detail: 'It is paused.' })).toEqual({ ok: false, words: 'It is paused.' });
    expect(checkAnswerWords(0, {})).toEqual({ ok: false, words: 'The server could not be reached. Nothing was asked.' });
  });
});

// ── the shipped section in jsdom ──────────────────────────────────────────────
let posts: { url: string; body: any }[] = [];
let answer: any = { status: 200, data: { ok: true, queued: false } };
function installDom() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/dashboard/console/#/work/board', pretendToBeVisual: true });
  const w: any = dom.window;
  for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']) if (k in w) (globalThis as any)[k] = w[k];
  (globalThis as any).window = w;
  (globalThis as any).localStorage = w.localStorage;
  (globalThis as any).fetch = vi.fn(async (url: string, opts: any = {}) => {
    if (opts.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(opts.body) }); return { ok: answer.status < 300, status: answer.status, json: async () => answer.data }; }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the section', () => {
  beforeEach(() => { installDom(); posts = []; answer = { status: 200, data: { ok: true, queued: false } }; });
  async function section(r = row()) {
    const { projectsSection } = await import(path.join(CONSOLE, 'projects.js'));
    const s = projectsSection(composeProjects([r], null, ctxNow));
    document.body.replaceChildren(s);
    return s;
  }
  it('the folded row says why it waits on you; the opened row has the checks, the items\' words and the phone pointer', async () => {
    const s = await section();
    const summary = s.querySelector('.project-summary');
    expect(summary.textContent).toContain('Every automatic check passes. It needs you to check 1 item.');
    const body = s.querySelector('.project-body').textContent;
    expect(body).toContain('Waiting for you to check');
    expect(body).toMatch(/Last checked .+ · next check /);
    expect(body).toContain('On your phone you can pause it and check the items only you can judge (each needs Face ID).');
    expect([...s.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Ask for an update']); // no Pause / Finish here
    // Said once, nothing lost: the folded line is not repeated, and the report is added because it is not that line.
    expect(s.textContent.split('It needs you to check 1 item.').length - 1).toBe(1);
    expect(body).toContain('Latest report: Every automatic check passes; the items only you can judge are waiting for you.');
  });
  it('a stopped project: the reason folded, the report once opened; a paused one shows the refusal in place of the button', async () => {
    const s = await section(row({ parked: true, lastVerdict: 'stalled', restartsWithoutProgress: 3, lastReport: { at: new Date(T0).toISOString(), note: 'The build fails at signing.', verdict: 'stalled' } }));
    expect(s.querySelector('.project-report').textContent).toMatch(/^I restarted it 3 times/);
    expect(s.querySelector('.project-body').textContent).toContain('Latest report: The build fails at signing.');
    const p = await section(row({ pausedBy: { who: 'owner', at: new Date(T0).toISOString(), quote: 'Hold it.', messageRef: '[source: x]' } }));
    expect(p.querySelector('.project-check-now')).toBeNull();
    expect(p.querySelector('.project-checks').textContent).toContain('It is paused.');
  });

  it('Ask for an update sends the key with no PIN and says what happened', async () => {
    answer = { status: 202, data: { ok: true, queued: true, words: 'The Chief of Staff will check it on its next round, within about 30 minutes.' } };
    const s = await section();
    s.querySelector('.project-check-now').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(posts).toEqual([{ url: '/work/projects/check', body: { key: CK } }]);
    expect(s.querySelector('.project-check-status').textContent).toMatch(/within about 30 minutes/);
  });
  it('a refusal is said in the server\'s words', async () => {
    answer = { status: 409, data: { error: 'paused', detail: 'It is paused.' } };
    const s = await section();
    s.querySelector('.project-check-now').click();
    for (let i = 0; i < 4; i++) await tick();
    expect(s.querySelector('.project-check-status').textContent).toBe('It is paused.');
  });
});

describe('after Ask for an update the section refreshes', () => {
  beforeEach(() => { installDom(); posts = []; });
  it('the answer and an open Finished fold survive the refresh', async () => {
    const done = { schemaVersion: 1, projects: [{ ...composeProjects([row()], null, ctxNow).projects[0], state: 'done', stateWords: 'Done' }], notInProject: [], sources: [], complete: true, couldNotCheck: [] };
    answer = { status: 200, data: { ok: true, queued: false } };
    (globalThis as any).fetch = vi.fn(async (url: string, opts: any = {}) => {
      if (opts.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => answer.data }; }
      return { ok: true, status: 200, json: async () => done };
    });
    const { projectsSection } = await import(path.join(CONSOLE, 'projects.js'));
    document.body.replaceChildren(projectsSection(done));
    const fold = document.querySelector('.projects-finished') as any;
    fold.open = true; fold.dispatchEvent(new (window as any).Event('toggle'));
    document.querySelector('.project-check-now').dispatchEvent(new (window as any).MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1700));
    for (let i = 0; i < 4; i++) await tick();
    expect((document.querySelector('.projects-finished') as any).open).toBe(true);
    expect(document.querySelector('.project-check-status').textContent).toBe('Checked just now.');
  });
});
