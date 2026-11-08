/**
 * Console "Retired" / "Locked" / retire-all (docs/specs/skill-learning-sentinel.md §3.8 / §3.10, slice 3B): the
 * model on both sides (503 = off, a failure = can't tell, a 200 without the list = unreadable, never "nothing
 * retired"; the reason and the archive location in words; a locked skill's conflict in words and "still rendered
 * on <machine>" while lockLeftRendering lists it; retire-all's re-arm date), and the shipped page in jsdom: the
 * retired section with Restore (PIN in that one request, zeroed after), the locked section with Unlock, the
 * de-emphasised retire-all control, a restored pending card showing the harm reason. Drafter/reviewer text is text.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildRetired, buildLocked, retiredCardText, lockedCardText, retireAllWords, archivedWords, pendingReasonWords, pendingCardText, RETIRED_EMPTY, LEARNED_SKILLS_OFF } from '../../dashboard/console/learned-model.js';

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500') => ({ ok: false, status: 500, reason });
const NOW = Date.parse('2026-11-06T18:00:00Z');
const DAY = 86_400_000;

const retired = (over: Record<string, unknown> = {}) => ({
  name: 'ci-health-report', reason: 'its runs were corrected four times in a row', kind: 'score', retiredAt: new Date(NOW - 2 * DAY).toISOString(), harm: true, by: 'reviewer', version: 3,
  reviewerFamily: 'openai', authorFamily: 'anthropic', renderingsArchived: { Studio: ['claude', 'agents'], Laptop: ['claude'] }, archiveDir: 'skill-learning/retired/ci-health-report', ...over,
});
const lockedSkill = (over: Record<string, unknown> = {}) => ({ name: 'release-notes', state: 'locked', locked: true, score: 0.8, uses: 5, accepted: 4, acceptedInferred: 0, corrected: 1, unknown: 0, weakPositive: 0, measurableRate: 1, misfires: 0, version: 2, operatorEdited: 0, isNew: false, ...over });
const status = (over: Record<string, unknown> = {}) => ({
  machine: 'Studio', enabled: true, mode: 'live', counts: { requests: 9, verified: 9, keys: 2, proposals: 0, skills: 1 },
  channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' }, pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0,
  filtered: {}, skills: [lockedSkill()], proposals: [], pending: [], retired: [retired()], lockLeftRendering: [{ name: 'release-notes', layouts: ['claude'] }], retireBlocked: [], retireAll: null, llmSpendCentsToday: 3, ...over,
});

describe('buildRetired — the view from GET /skills/learned', () => {
  it('503 is off; a failure is can’t tell; a 200 without the retired list is unreadable — none is an empty list', () => {
    expect(buildRetired(off())).toMatchObject({ ok: false, off: true, reason: LEARNED_SKILLS_OFF, rows: [] });
    expect(buildRetired(fail())).toMatchObject({ ok: false, off: false, reason: 'Can’t tell what I’ve retired: the server answered 500.' });
    expect(buildRetired(ok({ skills: [], proposals: [], pending: [] }))).toMatchObject({ ok: false, off: false, reason: 'Can’t tell what I’ve retired: the answer had no list.' });
    expect(buildRetired(ok(status({ retired: [] })))).toMatchObject({ ok: true, rows: [], empty: RETIRED_EMPTY });
  });
  it('a row says why in words (kind + reason + when), that it was harm, who judged, where the bytes are and which machines archived a copy', () => {
    const v = buildRetired(ok(status()), NOW);
    expect(v.rows).toHaveLength(1);
    const r = v.rows[0];
    expect(r.name).toBe('ci-health-report');
    expect(r.whyWords).toBe('Retired because its runs kept getting corrected 2 d ago: its runs were corrected four times in a row');
    expect(r.harm).toBe(true);
    expect(r.harmWords).toContain('doing harm');
    expect(r.byWords).toBe('Judged by my reviewer (openai).');
    expect(r.whereWords).toBe('Its files are kept under skill-learning/retired/ci-health-report. Rendering copies kept from: Laptop (claude), Studio (claude, agents).');
    expect(r.stillActiveWords).toBeNull();
  });
  it('an interrupted retire (retireBlocked layout "aside", no retired row) is its own card with no Restore', async () => {
    const v = buildRetired(ok(status({ retired: [], retireBlocked: [{ name: 'deploy-digest', layout: 'aside', reason: 'archives set aside at skill-learning/retired/deploy-digest.aside-1a2b3c4d while a retire was in flight; the next check puts them back' }] })), NOW);
    expect(v.rows).toMatchObject([{ name: 'deploy-digest', aside: true }]);
    expect(v.rows[0].whyWords).toMatch(/^Retire interrupted: archives set aside/);
  });
  it('retireBlocked names the machine-local block on the card; a default-rung verdict and an operator retire have their own words; rows without a name are dropped', () => {
    const v = buildRetired(ok(status({ retireBlocked: [{ name: 'ci-health-report', layout: 'claude', reason: 'EACCES: removal refused' }] })), NOW);
    expect(v.rows[0].stillActiveWords).toBe('Still active on this machine: I could not archive its rendering (claude: EACCES: removal refused). I will keep trying; nothing was deleted.');
    expect(retiredCardText(retired({ by: 'default-rung', kind: 'unused', harm: false, renderingsArchived: {} }), [], NOW).byWords).toBe('Judged by the fixed rule (my reviewer was not available).');
    expect(retiredCardText(retired({ by: 'operator', kind: 'operator', harm: false }), [], NOW).whyWords).toMatch(/^Retired because you retired it/);
    expect(retiredCardText(retired({ kind: 'weird' }), [], NOW).whyWords).toMatch(/^Retired 2 d ago:/);
    expect(archivedWords({})).toBe('No machine has archived a rendering copy yet.');
    expect(buildRetired(ok(status({ retired: [{ reason: 'no name' }, retired({ reason: '<b>x</b>\u0007' })] })), NOW).rows.map((r) => r.whyWords)).toEqual(['Retired because its runs kept getting corrected 2 d ago: <b>x</b>']);
  });
});

describe('buildLocked — locked skills with the leftover-rendering state', () => {
  it('the conflict in words; "still rendered on <machine>" while lockLeftRendering lists it, else where the archive is', () => {
    const v = buildLocked(ok(status()));
    expect(v.ok).toBe(true);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].conflictWords).toBe('Locked: you own this one. I will not patch it; it still counts its runs, and I can still retire it if it does harm.');
    expect(v.rows[0].renderedWords).toBe('Still rendered on Studio (claude) — it comes off at the next check, and the copy goes under .instar/skill-learning/retired/release-notes/renderings/.');
    expect(v.rows[0].stillRendered).toBe(true);
    expect(v.rows[0].line).toContain('release-notes — 4 runs accepted, 1 corrected, 0 unknown · locked');
    const gone = buildLocked(ok(status({ lockLeftRendering: [] })));
    expect(gone.rows[0].renderedWords).toBe('Its rendering is archived under .instar/skill-learning/retired/release-notes/renderings/ — the coding tools no longer see it.');
    expect(gone.rows[0].stillRendered).toBe(false);
    expect(lockedCardText({ name: 'x' }, [{ name: 'x', layouts: ['agents'] }], null).renderedWords).toContain('Still rendered on this machine (agents)');
  });
  it('503 is off; a failure is can’t tell; no skills list is unreadable; unlocked skills are not rows', () => {
    expect(buildLocked(off())).toMatchObject({ ok: false, off: true, rows: [] });
    expect(buildLocked(fail())).toMatchObject({ ok: false, off: false, rows: [] });
    expect(buildLocked(ok({ retired: [] }))).toMatchObject({ ok: false, off: false });
    expect(buildLocked(ok(status({ skills: [lockedSkill({ state: 'learned', locked: false })] }))).rows).toEqual([]);
  });
});

describe('retireAllWords — the re-arm date after a retire-all', () => {
  it('null when never used or malformed; the actor, count and review date while the hold is in force; the ended wording after it', () => {
    expect(retireAllWords(status())).toBeNull();
    expect(retireAllWords({ retireAll: { at: 'x' } })).toBeNull();
    const rec = { at: new Date(NOW - DAY).toISOString(), actor: 'operator', reArmReviewAt: new Date(NOW + 13 * DAY).toISOString(), retired: 3 };
    const words = retireAllWords({ retireAll: rec }, NOW)!;
    expect(words).toMatch(/^Every learned skill was retired 24 h ago by operator \(3\)\. I draft nothing new until .+, when this is reviewed\.$/);
    expect(retireAllWords({ retireAll: rec }, NOW + 5 * DAY)).toMatch(/retired 6 d ago/);
    const ended = retireAllWords({ retireAll: { ...rec, reArmReviewAt: new Date(NOW - DAY).toISOString() } }, NOW)!;
    expect(ended).toMatch(/the pause on new skills ended/);
  });
});

describe('a restored pending card', () => {
  it('says it was restored and shows the harm reason as text', () => {
    expect(pendingReasonWords('restored')).toContain('Restored from retirement');
    const card = pendingCardText({ name: 'ci-health-report', description: 'Use when … Not for …', paraphrases: [], pendingReason: 'restored', harmReason: 'its runs were corrected', createdAt: new Date(NOW).toISOString(), version: 4 });
    expect(card.pendingReason).toBe('restored');
    expect(card.harmWords).toBe('Before it was retired it was doing harm: its runs were corrected');
    expect(pendingCardText({ name: 'x', pendingReason: 'rung-unproven' }).harmWords).toBeNull();
  });
});

describe('the Learned page in a DOM — Retired, Locked, retire-all', () => {
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

  it('the locked and retired sections follow the skills section: the conflict in words, "still rendered on Studio", the reason, the harm line, where the archive is, Restore and Unlock', async () => {
    const main = await render(ok(status()));
    const ids = [...main.querySelectorAll('.list-section')].map((s) => s.id);
    expect(ids.indexOf('sec-locked')).toBeGreaterThan(ids.indexOf('sec-skills'));
    expect(ids.indexOf('sec-retired')).toBeGreaterThan(ids.indexOf('sec-locked'));
    const locked = main.querySelector('#sec-locked .skill-locked')!;
    expect(locked.getAttribute('data-locked')).toBe('release-notes');
    expect(locked.textContent).toContain('Locked: you own this one. I will not patch it');
    expect(locked.querySelector('.skill-still-rendered')!.textContent).toContain('Still rendered on Studio (claude)');
    expect(locked.querySelector('button[data-unlock]')!.textContent).toBe('Unlock');
    const card = main.querySelector('#sec-retired .skill-retired')!;
    expect(card.getAttribute('data-retired')).toBe('ci-health-report');
    expect(card.querySelector('.need-title')!.textContent).toContain('ci-health-report — Retired because its runs kept getting corrected');
    expect(card.querySelector('.skill-harm')!.textContent).toContain('doing harm');
    expect(card.querySelector('.skill-retired-where')!.textContent).toContain('Rendering copies kept from: Laptop (claude), Studio (claude, agents)');
    expect(card.querySelector('button[data-restore]')!.textContent).toBe('Restore');
    expect(card.querySelector('button[data-restore]')!.className).toContain('btn-quiet');
    // The retired section is not an operator need (nothing waits on the operator).
    expect(main.querySelector('#sec-retired')!.hasAttribute('data-operator-need')).toBe(false);
    // Reviewer/sentinel text is text: an HTML-looking reason creates no element.
    const hostile = await render(ok(status({ retired: [retired({ reason: '<img src=x onerror=alert(1)>' })] })));
    expect(hostile.querySelector('#sec-retired img')).toBeNull();
    expect(hostile.querySelector('#sec-retired .need-title')!.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('Restore asks for the PIN, sends exactly { pin } to the restore route, zeroes it after; a refusal shows the server’s words', async () => {
    const main = await render(ok(status()));
    (main.querySelector('button[data-restore]') as HTMLButtonElement).click();
    await typePin('246810');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('/skills/learned/ci-health-report/restore');
    expect(posts[0].sent).toEqual({ pin: '246810' });
    expect(posts[0].body).toEqual({ pin: '' });
    expect(main.querySelector('.skill-retired .action-status')!.textContent).toBe('Restored. It waits for your OK above before I use it.');
    const refused = await render(ok(status()), { ok: false, status: 409, reason: 'review-refused: the second step is ungrounded' });
    (refused.querySelector('button[data-restore]') as HTMLButtonElement).click();
    await typePin('246810');
    expect(refused.querySelector('.skill-retired .action-status')!.textContent).toBe('review-refused: the second step is ungrounded');
    expect((refused.querySelector('button[data-restore]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Unlock posts to the unlock route with the PIN; retire-all is a de-emphasised link under the skills that posts to retire-all and shows the re-arm line after', async () => {
    const main = await render(ok(status()));
    (main.querySelector('button[data-unlock]') as HTMLButtonElement).click();
    await typePin('246810');
    expect(posts.map((p) => p.url)).toEqual(['/skills/learned/release-notes/unlock']);
    expect(posts[0].sent).toEqual({ pin: '246810' });
    const all = main.querySelector('#sec-retire-all button[data-retire-all]')!;
    expect(main.querySelector('#sec-skills button[data-retire-all]')).toBeNull(); // never inside the skills section
    expect(all.className).toContain('link-btn'); // de-emphasised: a link, not a primary button
    expect(all.textContent).toBe('Retire every learned skill…');
    (all as HTMLButtonElement).click();
    await typePin('246810');
    expect(posts[1].url).toBe('/skills/learned/retire-all');
    expect(posts[1].sent).toEqual({ pin: '246810' });
    expect(posts[1].body).toEqual({ pin: '' });
    const held = await render(ok(status({ retireAll: { at: new Date(Date.now() - DAY).toISOString(), actor: 'operator', reArmReviewAt: new Date(Date.now() + 13 * DAY).toISOString(), retired: 3 } })));
    expect(held.querySelector('#sec-retire-all')!.textContent).toMatch(/I draft nothing new until .+, when this is reviewed\./);
  });

  it('an interrupted retire renders as a card without a Restore button', async () => {
    const main = await render(ok(status({ retired: [], retireBlocked: [{ name: 'deploy-digest', layout: 'aside', reason: 'archives set aside while a retire was in flight' }] })));
    const card = main.querySelector('#sec-retired .skill-retired')!;
    expect(card.getAttribute('data-retired')).toBe('deploy-digest');
    expect(card.textContent).toContain('Retire interrupted');
    expect(card.querySelector('button')).toBeNull();
  });

  it('with nothing retired or locked there are no such sections; a 200 without the retired list says can’t tell in the retired section', async () => {
    const none = await render(ok(status({ retired: [], skills: [lockedSkill({ state: 'learned', locked: false })], lockLeftRendering: [] })));
    expect(none.querySelector('#sec-retired')).toBeNull();
    expect(none.querySelector('#sec-locked')).toBeNull();
    const noList = await render(ok({ proposals: [], skills: [], pending: [] }));
    expect(noList.querySelector('#sec-retired')!.textContent).toContain('Can’t tell what I’ve retired');
    expect(noList.querySelector('#sec-retired button')).toBeNull();
    expect(posts).toEqual([]);
  });

  it('a restored pending card shows the harm reason on the first screen', async () => {
    const main = await render(ok(status({ retired: [], pending: [{ name: 'ci-health-report', description: 'Use when the operator asks for CI health. Not for deploys.', paraphrases: [], pendingReason: 'restored', harmReason: 'its runs were corrected', fileHash: 'h', createdAt: new Date(NOW).toISOString(), version: 4 }] })));
    const card = main.querySelector('#sec-pending .skill-pending')!;
    expect(card.querySelector('.skill-pending-why')!.textContent).toBe(pendingReasonWords('restored'));
    expect(card.querySelector('.skill-harm')!.textContent).toBe('Before it was retired it was doing harm: its runs were corrected');
  });
});
