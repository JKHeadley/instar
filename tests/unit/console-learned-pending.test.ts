/**
 * Console "Waiting for your OK" (docs/specs/skill-learning-sentinel.md §3.5 / §3.10, slice 2): a
 * learned skill written in live mode but not switched on until the operator's confirm/reject tap.
 * The model on both sides (503 = off, a failure = can't tell, a 200 without the `pending` list =
 * unreadable, never "nothing waiting"; rows without a name dropped; the reason it waits in words),
 * the Home need source (one row per pending skill; UNREADABLE on a malformed 200; off is not
 * failed), and the shipped page in jsdom: the pending section leads the page ABOVE the proposals
 * with the description, the paraphrases and the reason on the first screen; drafter text is
 * rendered as TEXT (an HTML-looking body creates no element); Confirm and Reject ask for the PIN,
 * send `{ pin }` in that one request body and zero it after; a refusal shows the server's words.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildPending, pendingCardText, pendingReasonWords, PENDING_OK_EMPTY, LEARNED_SKILLS_OFF } from '../../dashboard/console/learned-model.js';
import { NEED_SOURCES, surfacedNeeds } from '../../dashboard/console/needs-model.js';

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const NOW = Date.parse('2026-11-06T18:00:00Z');

const pending = (over: Record<string, unknown> = {}) => ({
  name: 'ci-health-report', description: 'Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status.',
  paraphrases: ['weekly CI health', 'how is CI this week?'], reviewerFamily: 'openai', pendingReason: 'rung-unproven', fileHash: 'abc', createdAt: new Date(NOW - 3600_000).toISOString(), version: 1, ...over,
});
const proposal = () => ({ name: 'weekly-ci-health', key: 'k1', arbiterOnly: false, createdAt: new Date(NOW - 7200_000).toISOString(), paraphrases: ['how is CI this week?'], description: 'Report the week’s CI health with the failing jobs named.' });
const status = (over: Record<string, unknown> = {}) => ({
  machine: 'Studio', enabled: true, mode: 'live', counts: { requests: 9, verified: 9, keys: 2, proposals: 1, skills: 0 },
  channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' }, pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0,
  filtered: {}, skills: [], proposals: [proposal()], pending: [pending()], retired: [], llmSpendCentsToday: 3, ...over,
});

describe('buildPending — the view from GET /skills/learned', () => {
  it('503 is off; a failure is can’t tell; a 200 without the pending list is unreadable — none is an empty list', () => {
    expect(buildPending(off())).toMatchObject({ ok: false, off: true, reason: LEARNED_SKILLS_OFF, rows: [] });
    expect(buildPending(fail())).toMatchObject({ ok: false, off: false, reason: 'Can’t tell what is waiting for your OK: the server answered 500.', rows: [] });
    expect(buildPending(null)).toMatchObject({ ok: false, off: false, rows: [] });
    expect(buildPending(ok({ proposals: [], skills: [] }))).toMatchObject({ ok: false, off: false, reason: 'Can’t tell what is waiting for your OK: the answer had no list.' });
    expect(buildPending(ok({ pending: 'nope' }))).toMatchObject({ ok: false, off: false });
  });
  it('nothing pending is the empty state; rows carry name, body, paraphrases, reviewer family and the reason as text', () => {
    expect(buildPending(ok(status({ pending: [] })))).toMatchObject({ ok: true, rows: [], empty: PENDING_OK_EMPTY });
    const v = buildPending(ok(status()));
    expect(v.ok).toBe(true);
    expect(v.empty).toBeNull();
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0]).toMatchObject({ name: 'ci-health-report', body: 'Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status.', paraphrases: ['weekly CI health', 'how is CI this week?'], reviewerFamily: 'openai', pendingReason: 'rung-unproven', version: 1, reviewedWords: 'reviewed by openai' });
    expect(v.rows[0].reasonWords).toBe(pendingReasonWords('rung-unproven'));
    expect(v.rows[0].createdWords).toMatch(/^Written /);
  });
  it('rows without a name are dropped; control characters are cleaned; paraphrases are capped at six; unknown reasons still say it waits', () => {
    const v = buildPending(ok(status({ pending: [{ description: 'no name' }, pending({ paraphrases: ['a\u0007b', '', ...Array(8).fill('again')], pendingReason: 'something-else', reviewerFamily: undefined })] })));
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].paraphrases).toHaveLength(6);
    expect(v.rows[0].paraphrases[0]).toBe('ab');
    expect(v.rows[0].pendingReason).toBeNull();
    expect(v.rows[0].reasonWords).toBe('Waiting for your OK before I use it.');
    expect(v.rows[0].reviewedWords).toBeNull();
    expect(pendingCardText({ name: 'bare' }).body).toBe('A skill I have written but not switched on yet (bare).');
  });
  it('the two spec reasons have their own words', () => {
    expect(pendingReasonWords('one-family')).toContain('Only one reviewer family');
    expect(pendingReasonWords('rung-unproven')).toContain('automatic gate');
    expect(pendingReasonWords('rung-unproven').length).toBeLessThan(90); // it must fit a phone's first screen beside the description
  });
});

describe('Home counts pending skills (needs-model source learned-pending)', () => {
  const source = NEED_SOURCES.find((s: { id: string }) => s.id === 'learned-pending');
  it('is registered on the Learned page and reads /skills/learned', () => {
    expect(source).toMatchObject({ page: 'settings/learned', reads: { status: '/skills/learned' } });
  });
  it('one row per pending skill, naming it and linking to the section', () => {
    const rows = source.rows({ status: ok(status({ pending: [pending(), pending({ name: 'release-notes', description: 'Write the release notes.' })] })) }, NOW);
    expect(rows).toEqual([
      { key: 'need:learned-pending:ci-health-report', main: 'A new skill waits for your OK: Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status.', sub: 'Confirm or reject it on the Learned page', tone: 'attn', refs: ['ci-health-report'], action: { kind: 'href', href: '#/settings/learned?s=pending' } },
      { key: 'need:learned-pending:release-notes', main: 'A new skill waits for your OK: Write the release notes.', sub: 'Confirm or reject it on the Learned page', tone: 'attn', refs: ['release-notes'], action: { kind: 'href', href: '#/settings/learned?s=pending' } },
    ]);
    expect(source.rows({ status: ok(status({ pending: [] })) }, NOW)).toEqual([]);
  });
  it('a malformed 200 is UNREADABLE (Home goes partial, never "nothing waiting"); 503 is off, not failed', () => {
    expect(source.rows({ status: ok({ proposals: [], skills: [] }) }, NOW)).toBeNull();
    expect(source.rows({ status: ok({ pending: {} }) }, NOW)).toBeNull();
    const failed = surfacedNeeds({ 'learned-pending': { results: { status: ok({ nope: true }) } } }, NOW);
    expect(failed.failed).toContain('learned-pending');
    expect(failed.rows).toEqual([]);
    const isOff = surfacedNeeds({ 'learned-pending': { results: { status: off() } } }, NOW);
    expect(isOff.failed).not.toContain('learned-pending');
    expect(isOff.rows).toEqual([]);
    expect(source.rows({ status: off() }, NOW)).toEqual([]);
  });
  it('the pending source and the proposal source count separately from the same answer', () => {
    const known = { 'learned-pending': { results: { status: ok(status()) } }, 'skill-learning-proposals': { results: { status: ok(status()) } } };
    const s = surfacedNeeds(known, NOW);
    expect(s.rows.map((r: { key: string }) => r.key).sort()).toEqual(['need:learned-pending:ci-health-report', 'need:skill-proposal:weekly-ci-health']);
  });
});

describe('the Learned page in a DOM — Waiting for your OK', () => {
  let dom: JSDOM;
  let reads: Record<string, unknown>;
  let posts: Array<{ url: string; body: Record<string, unknown>; sent: Record<string, unknown> }>;
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
    const ctx = {
      get: vi.fn(async (p: string) => answer(p)),
      // Keeps the SAME body object the page handed over (`body`) beside a copy taken at send time (`sent`), so zeroing after the send is observable.
      post: vi.fn(async (url: string, body: Record<string, unknown>) => { posts.push({ url, body, sent: JSON.parse(JSON.stringify(body)) }); return postResult; }),
      getCommitments: vi.fn(async () => fail()),
    };
    await renderLearned(main, ctx);
    await new Promise((r) => setTimeout(r, 0));
    return main;
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  async function typePin(pin: string) {
    await tick(); await tick();
    const input = document.querySelector('.sheet .pin-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = pin;
    (document.querySelector('.sheet form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
  }

  it('the pending skill leads the page above the proposals: description, paraphrases, the reason it waits, Confirm and Reject, before any other section', async () => {
    const main = await render(ok(status()));
    const sections = [...main.querySelectorAll('.list-section')].map((s) => s.id);
    expect(sections.slice(0, 2)).toEqual(['sec-pending', 'sec-skills']);
    const sec = main.querySelector('#sec-pending')!;
    expect(sec.getAttribute('data-operator-need')).toBe('learned-pending');
    expect(sec.querySelector('.list-count')!.textContent).toBe('1');
    const card = sec.querySelector('.skill-pending')!;
    expect(card.getAttribute('data-pending')).toBe('ci-health-report');
    expect(card.querySelector('.need-title')!.textContent).toBe('Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status.');
    expect([...card.querySelectorAll('.skill-paraphrases li')].map((n) => n.textContent)).toEqual(['“weekly CI health”', '“how is CI this week?”']);
    expect(card.querySelector('.skill-pending-why')!.textContent).toBe(pendingReasonWords('rung-unproven'));
    expect(card.textContent).toMatch(/ci-health-report · Written [^·]+ · reviewed by openai/);
    expect(card.querySelector('button[data-confirm]')!.textContent).toBe('Confirm');
    expect(card.querySelector('button[data-confirm]')!.className).toContain('btn-primary');
    expect(card.querySelector('button[data-reject]')!.textContent).toBe('Reject');
    expect(card.querySelector('button[data-reject]')!.className).toContain('btn-quiet');
    // The proposal section is still there, marked as its own need, after the pending one.
    expect(main.querySelector('#sec-skills')!.getAttribute('data-operator-need')).toBe('skill-learning-proposals');
    expect(main.querySelector('#sec-skills .skill-proposal')).not.toBeNull();
  });

  it('drafter text is text: an HTML-looking body and paraphrase create no element', async () => {
    const main = await render(ok(status({ pending: [pending({ description: '<img src=x onerror=alert(1)> <b>bold</b>', paraphrases: ['<script>x</script>'] })] })));
    const card = main.querySelector('#sec-pending .skill-pending')!;
    expect(card.querySelector('img, b, script')).toBeNull();
    expect(card.querySelector('.need-title')!.textContent).toBe('<img src=x onerror=alert(1)> <b>bold</b>');
    expect(card.querySelector('.skill-paraphrases li')!.textContent).toBe('“<script>x</script>”');
  });

  it('with nothing pending there is no pending section; off / failed answers are said once, in the skills section; a list of skills with no pending list says can’t tell here', async () => {
    expect((await render(ok(status({ pending: [], proposals: [] })))).querySelector('#sec-pending')).toBeNull();
    const dark = await render(off());
    expect(dark.querySelector('#sec-pending')).toBeNull();
    expect(dark.querySelector('#sec-skills .empty-line')!.textContent).toBe('Not switched on here.');
    const failed = await render(fail());
    expect(failed.querySelector('#sec-pending')).toBeNull();
    expect(failed.querySelector('#sec-skills')!.textContent).toContain('Can’t tell what I’ve learned to do');
    const noList = await render(ok({ proposals: [], skills: [] }));
    expect(noList.querySelector('#sec-pending')!.textContent).toContain('Can’t tell what is waiting for your OK');
    expect(noList.querySelector('#sec-pending button')).toBeNull();
    expect(noList.querySelector('#sec-pending')!.hasAttribute('data-operator-need')).toBe(false);
    expect(posts).toEqual([]);
  });

  it('Confirm asks for the PIN, sends exactly { pin } to the confirm route in that one request, and zeroes the PIN after', async () => {
    const main = await render(ok(status()));
    (main.querySelector('button[data-confirm]') as HTMLButtonElement).click();
    await typePin('246810');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/skills/learned/pending/ci-health-report/confirm');
    expect(posts[0].sent).toEqual({ pin: '246810' });
    expect(posts[0].body).toEqual({ pin: '' }); // zeroed after the send
    expect((document.querySelector('.sheet .pin-input') as HTMLInputElement | null)?.value ?? '').toBe('');
    expect(main.querySelector('.skill-pending .action-status')!.textContent).toBe('Confirmed. I will use it from the next conversation.');
    expect((main.querySelector('button[data-confirm]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Reject sends { pin } to the reject route; a refusal shows the server’s words and the buttons come back', async () => {
    const main = await render(ok(status()), { ok: false, reason: 'Incorrect PIN' });
    (main.querySelector('button[data-reject]') as HTMLButtonElement).click();
    await typePin('000000');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/skills/learned/pending/ci-health-report/reject');
    expect(posts[0].sent).toEqual({ pin: '000000' });
    expect(posts[0].body).toEqual({ pin: '' });
    expect(main.querySelector('.skill-pending .action-status')!.textContent).toBe('Incorrect PIN');
    expect((main.querySelector('button[data-confirm]') as HTMLButtonElement).disabled).toBe(false);
    expect((main.querySelector('button[data-reject]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('closing the PIN sheet sends nothing', async () => {
    const main = await render(ok(status()));
    (main.querySelector('button[data-confirm]') as HTMLButtonElement).click();
    await tick(); await tick();
    const { closeSheet } = await import('../../dashboard/console/ui.js');
    closeSheet();
    await tick(); await tick();
    expect(posts).toEqual([]);
    expect((main.querySelector('button[data-confirm]') as HTMLButtonElement).disabled).toBe(false);
  });
});
