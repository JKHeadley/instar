/**
 * Console "What I've learned to do" (docs/specs/skill-learning-sentinel.md §3.10, on the Learned
 * page): every decision in the model on both sides (503 = not switched on here vs a failure = can't
 * tell vs a 200 without the lists = unreadable; a proposal with no verdict wants one, a decided one
 * shows its verdict; one plain line per learned skill with its numbers in words; the measured cost
 * line never estimates), the Home need source (pending proposals only; unreadable is never
 * "nothing"), and the shipped page in jsdom: proposals lead the page with Agree / Disagree + reason
 * on the first screen, drafter text is rendered as TEXT (an HTML-looking description creates no
 * element), the taps carry the PIN and the reason tag in that one request, and the empty/off states.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildLearnedSkillsView, proposalCardText, proposalPending, skillLine, costLine, proposalsNeedingVerdict,
  DISAGREE_REASONS, LEARNED_SKILLS_OFF, LEARNED_SKILLS_EMPTY,
} from '../../dashboard/console/learned-model.js';
import { NEED_SOURCES, surfacedNeeds } from '../../dashboard/console/needs-model.js';

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const NOW = Date.parse('2026-11-06T18:00:00Z');

const proposal = (over: Record<string, unknown> = {}) => ({
  name: 'weekly-ci-health', key: 'k1', arbiterOnly: false, createdAt: new Date(NOW - 7200_000).toISOString(),
  paraphrases: ['how is CI this week?', 'weekly CI health please'], description: 'Report the week’s CI health with the failing jobs named.', ...over,
});
const skill = (over: Record<string, unknown> = {}) => ({
  name: 'release-notes', state: 'learned', score: 0.8, uses: 5, accepted: 3, acceptedInferred: 1, corrected: 1, unknown: 2, weakPositive: 0,
  measurableRate: 0.8, misfires: 0, version: 1, locked: false, ...over,
});
const status = (over: Record<string, unknown> = {}) => ({
  machine: 'Studio', enabled: true, mode: 'shadow', counts: { requests: 9, verified: 9, keys: 2, proposals: 1, skills: 1 },
  channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' }, pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0,
  filtered: {}, skills: [skill()], proposals: [proposal()], pending: [], retired: [], llmSpendCentsToday: 3, ...over,
});

describe('the view from GET /skills/learned', () => {
  it('503 is "not switched on here"; a failure is "can’t tell"; a 200 without the lists is unreadable — none is an empty list', () => {
    expect(buildLearnedSkillsView(off())).toMatchObject({ ok: false, off: true, reason: LEARNED_SKILLS_OFF, pendingCount: 0 });
    expect(buildLearnedSkillsView(fail())).toMatchObject({ ok: false, off: false, reason: 'Can’t tell what I’ve learned to do: the server answered 500.' });
    expect(buildLearnedSkillsView(null)).toMatchObject({ ok: false, off: false });
    expect(buildLearnedSkillsView(ok({ mode: 'shadow' }))).toMatchObject({ ok: false, off: false, reason: 'Can’t tell what I’ve learned to do: the answer had no list.' });
  });
  it('nothing learned yet is the empty state, not an error', () => {
    const v = buildLearnedSkillsView(ok(status({ skills: [], proposals: [] })));
    expect(v).toMatchObject({ ok: true, empty: LEARNED_SKILLS_EMPTY, pendingCount: 0, proposals: [], skills: [] });
  });
  it('proposals come first with the pending ones ahead of decided ones; skills get one plain line each; the mode and cost lines come from the answer', () => {
    const decided = proposal({ name: 'standup-digest', description: 'Digest the standup.', verdict: { by: 'operator', verdict: 'disagree', reason: 'wrong steps', at: new Date(NOW - 60_000).toISOString() } });
    const v = buildLearnedSkillsView(ok(status({ proposals: [decided, proposal()] })));
    expect(v.ok).toBe(true);
    expect(v.proposals.map((p: { name: string; pending: boolean }) => [p.name, p.pending])).toEqual([['weekly-ci-health', true], ['standup-digest', false]]);
    expect(v.pendingCount).toBe(1);
    expect(v.proposals[1].decided).toMatch(/^You disagreed \(wrong steps\) · /);
    expect(v.skills).toEqual([{ key: 'skill:release-notes', name: 'release-notes', text: 'release-notes — 4 runs accepted, 1 corrected, 2 unknown', state: 'learned', locked: false }]);
    expect(v.modeWords).toBe('Watching only: I draft proposals here and write nothing until you agree.');
    expect(v.costWords).toBe('Cost today: $0.03 measured.');
    expect(v.machine).toBe('Studio');
    expect(v.empty).toBeNull();
  });
  it('a skill still in the proposal state is not listed twice, and rows without a name are dropped', () => {
    const v = buildLearnedSkillsView(ok(status({ skills: [skill({ state: 'proposal' }), { accepted: 1 }], proposals: [{ description: 'no name' }] })));
    expect(v.skills).toEqual([]);
    expect(v.proposals).toEqual([]);
  });
});

describe('words', () => {
  it('skill line: accepted includes inferred; singular run; misfires, locked and retired are named', () => {
    expect(skillLine(skill({ accepted: 1, acceptedInferred: 0, corrected: 0, unknown: 0 })).text).toBe('release-notes — 1 run accepted, 0 corrected, 0 unknown');
    expect(skillLine(skill({ misfires: 1, state: 'locked', locked: true })).text).toBe('release-notes — 4 runs accepted, 1 corrected, 2 unknown · 1 misfire · locked');
    expect(skillLine(skill({ misfires: 2, state: 'retired' })).text).toBe('release-notes — 4 runs accepted, 1 corrected, 2 unknown · 2 misfires · retired');
    expect(skillLine({ name: 'x', accepted: NaN }).text).toBe('x — 0 runs accepted, 0 corrected, 0 unknown');
  });
  it('cost line: measured, nothing spent, or not measured — never estimated', () => {
    expect(costLine({ llmSpendCentsToday: 125 })).toBe('Cost today: $1.25 measured.');
    expect(costLine({ llmSpendCentsToday: 0 })).toBe('Cost today: nothing spent.');
    expect(costLine({})).toBe('Cost today: not measured yet.');
    expect(costLine({ llmSpendCentsToday: 'lots' })).toBe('Cost today: not measured yet.');
  });
  it('proposal card: description, paraphrases (capped, cleaned), name + drafted-when; a one-family draft says what settles it; a missing description still reads', () => {
    const t = proposalCardText(proposal({ paraphrases: ['a\u0007b', '', ...Array(8).fill('again')], pendingReason: 'one-family' }));
    expect(t.description).toBe('Report the week’s CI health with the failing jobs named.');
    expect(t.paraphrases).toHaveLength(6);
    expect(t.paraphrases[0]).toBe('ab');
    expect(t.waiting).toContain('Only one reviewer family');
    expect(t.pending).toBe(true);
    expect(t.createdWords).toMatch(/^Drafted /);
    expect(proposalCardText({ name: 'bare' }).description).toBe('A skill I think I have learned (bare).');
    expect(proposalPending(proposal())).toBe(true);
    expect(proposalPending(proposal({ verdict: { by: 'operator', verdict: 'agree', at: 'x' } }))).toBe(false);
    expect(proposalPending(null)).toBe(false);
  });
  it('the disagree reasons are the four tags the route records', () => {
    expect(DISAGREE_REASONS.map((r) => r.value)).toEqual(['not something I do', 'wrong steps', 'already have a skill for this', 'other']);
  });
});

describe('Home counts pending proposals (needs-model source skill-learning-proposals)', () => {
  const source = NEED_SOURCES.find((s: { id: string }) => s.id === 'skill-learning-proposals');
  it('is registered on the Learned page and reads /skills/learned', () => {
    expect(source).toMatchObject({ page: 'settings/learned', reads: { status: '/skills/learned' } });
  });
  it('one row per proposal without a verdict, linking to the section; decided ones do not count', () => {
    const decided = proposal({ name: 'standup-digest', verdict: { by: 'operator', verdict: 'agree', at: 'x' } });
    const rows = source.rows({ status: ok(status({ proposals: [decided, proposal()] })) }, NOW);
    expect(rows).toEqual([{ key: 'need:skill-proposal:weekly-ci-health', main: 'I think I’ve learned to: Report the week’s CI health with the failing jobs named.', sub: 'Agree, or disagree with a reason, on the Learned page', tone: 'attn', refs: ['weekly-ci-health'], action: { kind: 'href', href: '#/settings/learned?s=skills' } }]);
    expect(proposalsNeedingVerdict({ proposals: [] })).toEqual([]);
  });
  it('an unreadable 200 is never "nothing waiting"; 503 is off, not failed', () => {
    expect(source.rows({ status: ok({ nope: true }) }, NOW)).toBeNull();
    const failed = surfacedNeeds({ 'skill-learning-proposals': { results: { status: ok({ nope: true }) } } }, NOW);
    expect(failed.failed).toContain('skill-learning-proposals');
    const isOff = surfacedNeeds({ 'skill-learning-proposals': { results: { status: off() } } }, NOW);
    expect(isOff.failed).not.toContain('skill-learning-proposals');
    expect(isOff.rows).toEqual([]);
  });
});

describe('the Learned page in a DOM', () => {
  let dom: JSDOM;
  let reads: Record<string, unknown>;
  let posts: Array<{ url: string; body: unknown }>;
  const answer = (p: string) => (p in reads ? reads[p] : fail());
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body></html>', { url: 'http://localhost/dashboard/console/#/settings/learned', pretendToBeVisual: true });
    const w: any = dom.window;
    for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']) if (k in w) (globalThis as any)[k] = w[k];
    (globalThis as any).window = w;
    (globalThis as any).localStorage = w.localStorage;
    (globalThis as any).sessionStorage = w.sessionStorage;
    // askPin asks /dashboard/unlock-check first; an unreadable check falls back to the PIN box.
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }));
    w.scrollTo = vi.fn();
    w.HTMLElement.prototype.scrollIntoView = vi.fn();
    reads = { '/preferences/session-context': ok({ present: false }), '/corrections?limit=20': ok({ records: [], count: 0, totalRecords: 0, nextBefore: null }), '/state/conflicts': off(), '/pool': ok({ enabled: false, machines: [] }) };
    posts = [];
  });
  async function render(skillsRes: unknown, postResult: unknown = { ok: true, data: { ok: true } }) {
    reads['/skills/learned'] = skillsRes;
    const { renderLearned, _resetLearnedState } = await import('../../dashboard/console/learned.js');
    _resetLearnedState();
    const main = document.createElement('main'); main.id = 'main'; document.body.replaceChildren(main);
    const ctx = { get: vi.fn(async (p: string) => answer(p)), post: vi.fn(async (url: string, body: unknown) => { posts.push({ url, body: JSON.parse(JSON.stringify(body)) }); return postResult; }), getCommitments: vi.fn(async () => fail()) };
    await renderLearned(main, ctx);
    await new Promise((r) => setTimeout(r, 0));
    return main;
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('a pending proposal leads the page: description, paraphrases, Agree and Disagree with its reason, before the preferences section', async () => {
    const main = await render(ok(status()));
    const sections = [...main.querySelectorAll('.list-section')].map((s) => s.id);
    expect(sections[0]).toBe('sec-skills');
    expect(sections).toContain('sec-prefs');
    const card = main.querySelector('#sec-skills .skill-proposal')!;
    expect(main.querySelector('#sec-skills')!.getAttribute('data-operator-need')).toBe('skill-learning-proposals');
    expect(card.querySelector('.need-title')!.textContent).toBe('Report the week’s CI health with the failing jobs named.');
    expect([...card.querySelectorAll('.skill-paraphrases li')].map((n) => n.textContent)).toEqual(['“how is CI this week?”', '“weekly CI health please”']);
    expect(card.querySelector('button[data-agree]')!.textContent).toBe('Agree');
    expect(card.querySelector('button[data-disagree]')!.textContent).toBe('Disagree');
    expect([...card.querySelectorAll('select[data-reason] option')].map((o) => (o as HTMLOptionElement).value)).toEqual(DISAGREE_REASONS.map((r) => r.value));
    expect(main.querySelector('#sec-skills .skill-line')!.textContent).toBe('release-notes — 4 runs accepted, 1 corrected, 2 unknown');
    expect(main.querySelector('#sec-skills .skill-cost')!.textContent).toBe('Cost today: $0.03 measured.');
    expect(main.querySelector('#sec-skills .list-count')!.textContent).toBe('1');
  });

  it('drafter text is text: an HTML-looking description and paraphrase create no element', async () => {
    const main = await render(ok(status({ proposals: [proposal({ description: '<img src=x onerror=alert(1)> <b>bold</b>', paraphrases: ['<script>x</script>'] })] })));
    const card = main.querySelector('#sec-skills .skill-proposal')!;
    expect(card.querySelector('img, b, script')).toBeNull();
    expect(card.querySelector('.need-title')!.textContent).toBe('<img src=x onerror=alert(1)> <b>bold</b>');
    expect(card.querySelector('.skill-paraphrases li')!.textContent).toBe('“<script>x</script>”');
  });

  it('with nothing pending the section follows the preferences and is not marked as a need; a decided proposal shows its verdict without buttons', async () => {
    const main = await render(ok(status({ proposals: [proposal({ verdict: { by: 'operator', verdict: 'agree', at: new Date(NOW).toISOString() } })] })));
    const sections = [...main.querySelectorAll('.list-section')].map((s) => s.id);
    expect(sections.indexOf('sec-skills')).toBeGreaterThan(sections.indexOf('sec-prefs'));
    expect(main.querySelector('#sec-skills')!.hasAttribute('data-operator-need')).toBe(false);
    expect(main.querySelector('#sec-skills button')).toBeNull();
    expect(main.querySelector('#sec-skills .skill-proposal')!.textContent).toContain('You agreed');
  });

  it('empty and off states: "Nothing learned yet." / "Not switched on here."; a failed read says can’t tell, and the rest of the page still renders', async () => {
    expect((await render(ok(status({ proposals: [], skills: [] })))).querySelector('#sec-skills .empty-line')!.textContent).toBe('Nothing learned yet.');
    expect((await render(off())).querySelector('#sec-skills .empty-line')!.textContent).toBe('Not switched on here.');
    const failed = await render(fail());
    expect(failed.querySelector('#sec-skills')!.textContent).toContain('Can’t tell what I’ve learned to do');
    expect(failed.querySelector('#sec-prefs')).not.toBeNull();
    expect(posts).toEqual([]);
  });

  it('Agree asks for the PIN and sends it in that one request; Disagree sends the chosen reason tag too; a refusal shows the server’s words', async () => {
    const main = await render(ok(status()));
    (main.querySelector('button[data-agree]') as HTMLButtonElement).click();
    await tick(); await tick();
    const pin = document.querySelector('.sheet .pin-input') as HTMLInputElement;
    expect(pin).not.toBeNull();
    pin.value = '246810';
    (document.querySelector('.sheet form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
    expect(posts).toEqual([{ url: '/skills/learned/proposals/weekly-ci-health/agree', body: { pin: '246810' } }]);
    expect(main.querySelector('.skill-proposal .action-status')!.textContent).toBe('Agreed. Noted for the next review.');

    const again = await render(ok(status()), { ok: false, reason: 'Incorrect PIN' });
    (again.querySelector('select[data-reason]') as HTMLSelectElement).value = 'wrong steps';
    (again.querySelector('button[data-disagree]') as HTMLButtonElement).click();
    await tick(); await tick();
    const pin2 = document.querySelector('.sheet .pin-input') as HTMLInputElement;
    pin2.value = '000000';
    (document.querySelector('.sheet form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
    expect(posts[1]).toEqual({ url: '/skills/learned/proposals/weekly-ci-health/disagree', body: { pin: '000000', reason: 'wrong steps' } });
    expect(again.querySelector('.skill-proposal .action-status')!.textContent).toBe('Incorrect PIN');
    expect((again.querySelector('button[data-agree]') as HTMLButtonElement).disabled).toBe(false); // can try again
  });
});

describe('proposalCardText — disagreement label (spec §3.3)', () => {
  it('names the dissenting rung in plain words for both directions and stays silent when they agreed', () => {
    const base = { name: 'weekly-ci-health', description: 'd', paraphrases: [], createdAt: new Date().toISOString() };
    expect(proposalCardText({ ...base, disagreement: 'arbiter-only' }).dissent).toMatch(/My judgment drafted this/);
    expect(proposalCardText({ ...base, disagreement: 'default-only' }).dissent).toMatch(/fixed rule drafted this/);
    expect(proposalCardText({ ...base, disagreement: null }).dissent).toBeNull();
    expect(proposalCardText({ ...base, arbiterOnly: true }).dissent).toMatch(/My judgment drafted this/);
  });
});
