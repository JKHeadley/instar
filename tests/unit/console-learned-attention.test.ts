/**
 * Console Learned page — open skill-learning attention items inline (docs/specs/skill-learning-sentinel.md §3.10,
 * slice 3): `buildSkillAttention` reads the queue the page already fetches (GET /attention?scope=pool&status=OPEN),
 * keeps only open `skill-learning` rows, puts the ones waiting for the operator first, and says nothing on a bad
 * answer (Home owns "the queue is unreadable"). In jsdom: the rows render as text inside the skills section, and a
 * failed read leaves the page without the block.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSkillAttention } from '../../dashboard/console/learned.js';

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });

const item = (over: Record<string, unknown> = {}) => ({
  id: 'skill-learning:1:bad-skill', conditionKey: 'skill-learning:1:bad-skill', category: 'skill-learning', priority: 'HIGH', status: 'OPEN',
  title: 'I retired the skill "bad-skill" for harm and could not safely revert it', summary: 'Version 3 of "bad-skill" was retired. I tried the fix three times over a day and it did not hold.',
  needsUser: true, silent: false, sourceContext: 'skill-learning-sentinel', createdAt: '2026-11-06T12:00:00Z', updatedAt: '2026-11-06T12:00:00Z', machineNickname: 'Studio', ...over,
});

describe('buildSkillAttention', () => {
  it('keeps only open skill-learning rows, operator-facing first, and reads the item number out of the id', () => {
    const view = buildSkillAttention(ok({ items: [
      item({ id: 'skill-learning:6:growth', priority: 'NORMAL', needsUser: false, silent: true, title: '5 skills drafted in 7 days', updatedAt: '2026-11-06T13:00:00Z' }),
      item(),
      item({ id: 'other:1', category: 'ci', title: 'CI red' }),
      item({ id: 'skill-learning:5:split-brain.alpha', status: 'DONE', closedBy: 'cause-cleared' }),
    ], count: 4 }));
    expect(view.ok).toBe(true);
    expect(view.rows.map((r: { id: string }) => r.id)).toEqual(['skill-learning:1:bad-skill', 'skill-learning:6:growth']);
    expect(view.rows[0]).toMatchObject({ item: 1, needsUser: true, priority: 'HIGH', machine: 'Studio' });
    expect(view.rows[1]).toMatchObject({ item: 6, needsUser: false, silent: true });
  });

  it('a failed read, a 503, or a 200 without a list is `ok: false` with no rows — never an empty "nothing waiting"', () => {
    expect(buildSkillAttention(fail())).toEqual({ ok: false, rows: [] });
    expect(buildSkillAttention({ ok: false, status: 503, reason: 'off' })).toEqual({ ok: false, rows: [] });
    expect(buildSkillAttention(ok({ count: 0 }))).toEqual({ ok: false, rows: [] });
    expect(buildSkillAttention(ok({ items: [], count: 0 }))).toEqual({ ok: true, rows: [] });
  });
});

describe('the Learned page shows open skill-learning items inline', () => {
  let dom: JSDOM;
  let reads: Record<string, unknown> = {};
  const answer = (p: string) => (p in reads ? reads[p] : fail());
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body></html>', { url: 'http://localhost/dashboard/console/#/settings/learned', pretendToBeVisual: true });
    const w: any = dom.window;
    for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']) if (k in w) (globalThis as any)[k] = w[k];
    (globalThis as any).window = w;
    (globalThis as any).sessionStorage = w.sessionStorage;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }));
    w.scrollTo = vi.fn();
    w.HTMLElement.prototype.scrollIntoView = vi.fn();
    reads = {
      '/preferences/session-context': ok({ present: false }), '/corrections?limit=20': ok({ records: [], count: 0, totalRecords: 0, nextBefore: null }),
      '/state/conflicts': { ok: false, status: 503, reason: 'off' }, '/pool': ok({ enabled: false, machines: [] }),
      '/skills/learned': ok({ machine: 'Studio', enabled: true, mode: 'shadow', counts: { requests: 0, verified: 0, keys: 0, proposals: 0, skills: 0 }, channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' }, pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0, filtered: {}, skills: [], proposals: [], pending: [], retired: [], llmSpendCentsToday: 0 }),
    };
  });
  async function render() {
    const { renderLearned, _resetLearnedState } = await import('../../dashboard/console/learned.js');
    _resetLearnedState();
    const main = document.createElement('main'); main.id = 'main'; document.body.replaceChildren(main);
    await renderLearned(main, { get: vi.fn(async (p: string) => answer(p)), post: vi.fn(async () => ({ ok: true })), getCommitments: vi.fn(async () => fail()) });
    await new Promise((r) => setTimeout(r, 0));
    return main;
  }

  it('renders each open item as text (an HTML-looking title creates no element) inside the skills section, operator-facing ones marked', async () => {
    reads['/attention?scope=pool&status=OPEN'] = ok({ items: [item({ title: '<b>bad</b> skill retired' }), item({ id: 'skill-learning:6:growth', needsUser: false, silent: true, priority: 'NORMAL', title: '5 skills drafted in 7 days' })], count: 2 });
    const main = await render();
    const block = main.querySelector('#sec-skills #sec-skill-attention');
    expect(block).not.toBeNull();
    const rows = Array.from(block!.querySelectorAll('.skill-attention-item'));
    expect(rows.map((r) => r.getAttribute('data-attention'))).toEqual(['skill-learning:1:bad-skill', 'skill-learning:6:growth']);
    expect(rows[0].classList.contains('needs-user')).toBe(true);
    expect(rows[0].querySelector('b')).toBeNull();
    expect(rows[0].textContent).toContain('<b>bad</b> skill retired');
    expect(rows[0].textContent).toContain('Waiting for you');
    expect(rows[1].textContent).toContain('For your eyes only');
  });

  it('a failed attention read or no open items leaves the page without the block', async () => {
    const main = await render();                                              // '/attention…' answers fail()
    expect(main.querySelector('#sec-skill-attention')).toBeNull();
    reads['/attention?scope=pool&status=OPEN'] = ok({ items: [item({ category: 'ci' })], count: 1 });
    expect((await render()).querySelector('#sec-skill-attention')).toBeNull();
  });
});
