/**
 * Anything that needs the operator is on the first screen, counted, and never pointed at
 * (docs/specs/operator-needs-first-screen.md; operator, topic 136706, 2026-11-03).
 *
 * Operator-Surface Quality rule 1 was enforced only by a written answer at commit time, and
 * the Development page broke it with every gate green. This renders each SHIPPED page in the
 * state that needs the operator and fails if the need is not first, has no action, is folded
 * away, or is missing from Home's count. jsdom has no layout: the viewport half is proved in a
 * real browser before shipping, and this file says so rather than implying otherwise.
 */
// @ts-nocheck — the modules are browser-native ESM (.js), no types.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const CONSOLE = path.resolve(__dirname, '../../dashboard/console');
const NOW = Date.now();
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const minsAgo = (m: number) => NOW - m * 60000;
const iso = (mins: number) => new Date(NOW + mins * 60000).toISOString();

const watcher = (over: Record<string, unknown> = {}) => ({ lastTickAt: minsAgo(1), lastSuccessfulListAt: minsAgo(1), breaker: { open: false }, invariantOk: true, gate: { rollback: [] }, snapshot: { at: minsAgo(1), entries: [] }, episodes: [], armed: [], armedCount: 0, stuckRed: [], ...over });

/** source id → the page, and the reads that put it in the state that needs the operator. */
const FIXTURES: Record<string, { render: [string, string]; reads: Record<string, unknown> }> = {
  merging: { render: ['development.js', 'renderDevelopment'], reads: { '/green-pr-automerge': ok(watcher({ gate: { rollback: [{ by: 'agent', at: minsAgo(9) }] } })) } },
  'shipping-approvals': { render: ['development.js', 'renderDevelopment'], reads: { '/green-pr-automerge': ok(watcher({ snapshot: { at: minsAgo(1), entries: [{ pr: 2391, headRefName: 'x', headRefOid: 'abc', kind: 'code-owner-review' }] } })) } },
  feedback: { render: ['development.js', 'renderDevelopment'], reads: { '/green-pr-automerge': ok(watcher()), '/feedback-factory/execute/status': ok({ reason: 'approver-not-independent', attempts: [] }) } },
  accounts: { render: ['accounts.js', 'renderAccounts'], reads: { '/subscription-pool?scope=pool': ok({ enabled: true, accounts: [{ id: 'luna', nickname: 'Luna', email: 'luna@x.io', framework: 'claude-code', status: 'needs-reauth', loginCheck: 'ok', machineId: 'm1', machineNickname: 'Mac Studio' }] }) } },
  agents: { render: ['agents.js', 'renderAgents'], reads: { '/threadline/pairing': ok({ pairings: [] }), '/threadline/pairing/invites': ok({ invites: [], pendingAccepts: [{ iid: 'i1', claimedAgent: 'PP', acceptorFp: 'abcdef', claimedAt: iso(-1), expiresAt: iso(30) }], knownPeers: [], restartNotices: [], handshake: [] }) } },
  approvals: { render: ['mandates.js', 'renderMandates'], reads: { '/authorization-requests?status=pending': ok({ requests: [{ id: 'r1', status: 'pending', headline: 'Let PP sign code reviews', reason: 'it asked', createdByAgent: 'Echo', heldOnThisMachine: true, requestExpiresAt: iso(60) }] }) } },
  plans: { render: ['plans.js', 'renderPlans'], reads: { '/initiatives': ok({ items: [{ id: 'i1', title: 'Pick a name', description: 'd', status: 'active', kind: 'task', currentPhaseIndex: 0, phases: [], lastTouchedAt: minsAgo(60), needsUser: true, needsUserReason: 'pick a name', blockers: [], links: [], createdAt: iso(-999), updatedAt: iso(-60) }], count: 1 }) } },
  secrets: { render: ['secrets.js', 'renderSecrets'], reads: { '/secrets/pending': ok({ pending: [{ token: 'tok1', label: 'OpenAI API key', createdAt: minsAgo(4), expiresAt: NOW + 660000, expired: false, localUrl: '/secrets/drop/tok1' }] }) } },
  health: { render: ['health.js', 'renderHealth'], reads: { '/mobile/health-issues': ok({ verdict: 'attention', headline: 'iMessage isn’t connected.', uptime: '2h', counts: { userAffecting: 1, internal: 0, unclassified: 0 }, truncated: false, issues: [{ id: 'iMessage', impact: 'user-affecting', title: 'iMessage isn’t connected', detail: 'Messages through iMessage won’t reach me.', evidence: null, count: 1, lastAt: null, action: null, ask: 'What happened?' }] }) } },
  spending: { render: ['costs.js', 'renderCosts'], reads: { '/routing-spend/enable-status': ok({ lifecycleState: 'probe-failed', enforcementReady: false }) } },
  'skill-learning-proposals': { render: ['learned.js', 'renderLearned'], reads: { '/skills/learned': ok({ machine: 'Studio', enabled: true, mode: 'shadow', counts: { requests: 9, verified: 9, keys: 2, proposals: 1, skills: 0 }, channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' }, pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0, filtered: {}, skills: [], proposals: [{ name: 'weekly-ci-health', key: 'k1', arbiterOnly: false, createdAt: iso(-120), paraphrases: ['how is CI this week?'], description: 'Report the week’s CI health with the failing jobs named.' }], pending: [], retired: [], llmSpendCentsToday: 3 }) } },
  // Chief of Staff (chief-of-staff-topic.md §1.4/§5): a parked project needs the owner; the conversations page leads with it.
  'chief-of-staff': { render: ['chats.js', 'renderChats'], reads: { '/chief-of-staff': ok({ lease: { live: true, expiresAt: iso(60 * 48) }, conversationKey: 'telegram:900', displayName: 'Chief of Staff', projects: [{ conversationKey: 'telegram:1', goal: 'Ship the thing', lastVerdict: 'stalled', parked: true, breakerTripped: false, restartsWithoutProgress: 3 }] }), '/mobile/conversations/status': ok({ native: 'off' }) } },
  // Work board (work-board-asks.md §7): a card the agent wrote waits for the owner's approval; the board leads with it.
  workBoard: { render: ['work.js', 'renderWork'], reads: { '/work-board': ok({ lanes: [{ lane: 'waiting-on-you', cards: [{ id: 'wc_0123456789abcdef', conversationKey: '0b0c0d0e-0f10-5111-8213-141516171819', status: 'needs-approval', lane: 'waiting-on-you', needLine: 'Needs your approval before the agent starts', title: 'Renew the domain', titleHash: 'a'.repeat(64), need: 'Renew it for a year.', doneWhen: [{ id: 'd1', text: 'Renewed', certify: 'owner-confirms' }], carrier: 'agent', outward: true, outwardWords: 'This sends something outside your team or spends money', links: [], materialHash: 'b'.repeat(64), approvalRequired: true, approved: false, questions: [], evidence: [], claim: null, holds: [], archives: [], carrierTrail: [], taps: [], retryOf: null, repliedAfterQuestion: false }] }, { lane: 'with-agent', cards: [] }, { lane: 'waiting-on-others', cards: [] }, { lane: 'done', cards: [], total: 0 }, { lane: 'archived', cards: [] }], waitingOnYou: 1, policy: 'every-agent-card', behind: null, settings: { softOpenCards: 30 } }) } },
  // Slice 2: a skill written in live mode that waits for the confirm/reject tap, with a proposal beside it (the pending one must still lead).
  'learned-pending': { render: ['learned.js', 'renderLearned'], reads: { '/skills/learned': ok({ machine: 'Studio', enabled: true, mode: 'live', counts: { requests: 9, verified: 9, keys: 2, proposals: 1, skills: 0 }, channels: { telegram: 'measured', slack: 'support-only', app: 'unmeasurable' }, pendingBacklog: 0, classifierFailures24h: 0, abortedUnreachable24h: 0, filtered: {}, skills: [], proposals: [{ name: 'weekly-ci-health', key: 'k1', arbiterOnly: false, createdAt: iso(-120), paraphrases: ['how is CI this week?'], description: 'Report the week’s CI health with the failing jobs named.' }], pending: [{ name: 'ci-health-report', description: 'Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status.', paraphrases: ['weekly CI health'], reviewerFamily: 'openai', pendingReason: 'rung-unproven', fileHash: 'abc', createdAt: iso(-60), version: 1 }], retired: [], llmSpendCentsToday: 3 }) } },
};

let dom: JSDOM;
let reads: Record<string, unknown> = {};
const answer = (p: string) => (p in reads ? reads[p] : { ok: false, status: 500, reason: 'the server answered 500' });

function installDom() {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/dashboard/console/#/home', pretendToBeVisual: true });
  const w: any = dom.window;
  for (const k of ['document', 'location', 'history', 'HTMLElement', 'Node', 'CSS', 'MutationObserver', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']) if (k in w) (globalThis as any)[k] = w[k];
  (globalThis as any).window = w;
  (globalThis as any).localStorage = w.localStorage;
  (globalThis as any).sessionStorage = w.sessionStorage;
  (globalThis as any).WebSocket = class { close() {} addEventListener() {} send() {} };
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    const a: any = answer(String(url).replace('http://localhost', ''));
    return { ok: Boolean(a.ok), status: a.status || (a.ok ? 200 : 500), json: async () => a.data || {}, text: async () => '' };
  });
  w.scrollTo = vi.fn();
  w.HTMLElement.prototype.scrollIntoView = vi.fn();
}
function mainNode() { const m = document.createElement('main'); m.id = 'main'; document.body.replaceChildren(m); return m; }

beforeAll(installDom);
beforeEach(() => { installDom(); reads = {}; });

const hiddenByFold = (n: Element) => { for (let e: Element | null = n; e; e = e.parentElement) { if (e.hasAttribute('hidden')) return true; if (e.tagName === 'DETAILS' && !(e as any).open && !e.matches(':scope > summary')) return true; } return false; };
const HEAD_TEXT_CAP = 500;

/**
 * The floor, in one place so the negative controls exercise exactly what the pages face.
 * Returns what is wrong with this page for this need; an empty list means it complies.
 */
function firstScreenViolations(main: Element, id: string): string[] {
  const out: string[] = [];
  const need = main.querySelector(`[data-operator-need="${id}"]`);
  if (!need) return [`nothing is marked as needing the operator (${id})`];
  if (hiddenByFold(need)) out.push('it is inside a closed fold or hidden element');
  const self = need.matches('button, a') ? [need] : [...need.querySelectorAll('button, a')];
  const actions = self.filter((a: any) => !a.disabled && !hiddenByFold(a) && (a.tagName === 'BUTTON' || (a.getAttribute('href') && !a.getAttribute('href').startsWith('#sec-'))));
  if (!actions.length) out.push('it offers no action');
  const all = [...main.querySelectorAll('*')];
  const at = all.indexOf(need);
  let before = '';
  for (const n of all.slice(0, at)) {
    if (n.contains(need) || n.closest('[data-operator-need]')) continue;
    if (n.matches('.list-section, details, .card, .tiles')) out.push(`a section comes before it: ${n.id || n.className}`);
    if (!n.children.length) before += `${n.textContent} `;
  }
  if (before.length > HEAD_TEXT_CAP) out.push(`${before.length} characters of text come before it`);
  return out;
}

describe('every source: the shipped page leads with the need, its action in place', () => {
  it.each(Object.keys(FIXTURES))('%s', async (id: string) => {
    const f = FIXTURES[id];
    reads = f.reads;
    const mod = await import(path.join(CONSOLE, f.render[0]));
    const main = mainNode();
    const ctx = { get: vi.fn(async (p: string) => answer(p)), post: vi.fn(async () => ({ ok: false, reason: 'x' })), getCommitments: vi.fn(async () => answer('/commitments')) };
    await mod[f.render[1]](main, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(firstScreenViolations(main, id)).toEqual([]);
  }, 30000);
});

describe('Home: every source reaches the count and the headline', () => {
  const quietQueue = { count: 0, rows: [], all: [], state: 'ok', line: 'The queue is clear.' };
  const noPromises = { state: 'ok', count: 0, all: [], rows: [] };

  it.each(Object.keys(FIXTURES))('%s', async (id: string) => {
    const { NEED_SOURCES, surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const { combineNeeds, headline } = await import(path.join(CONSOLE, 'home-model.js'));
    const known: any = {};
    reads = FIXTURES[id].reads;
    for (const s of NEED_SOURCES) known[s.id] = { results: Object.fromEntries(Object.entries(s.reads).map(([k, p]) => [k, answer(p as string).ok ? answer(p as string) : { ok: false, status: 503, reason: 'switched off on this agent' }])) };
    const surfaced = surfacedNeeds(known, NOW);
    const model = combineNeeds(quietQueue, noPromises, surfaced);
    expect(model.count).toBeGreaterThanOrEqual(1);
    expect(model.all.some((r: any) => r.action && r.action.kind === 'href' && r.action.href)).toBe(true);
    const h = headline({ needs: model, promised: noPromises });
    expect(h.tone).toBe('attn');
    expect(h.text).not.toMatch(/quiet|nothing needs/i);
  }, 30000);

  it('a stopped merge names itself in the headline, with a link to act on it', async () => {
    const { surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const { combineNeeds, headline } = await import(path.join(CONSOLE, 'home-model.js'));
    const s = surfacedNeeds({ merging: { results: { watcher: FIXTURES.merging.reads['/green-pr-automerge'] } } }, NOW);
    const h = headline({ needs: combineNeeds(quietQueue, noPromises, s), promised: noPromises });
    expect(h.text).toBe('Automatic merging is stopped');
    expect(h.action).toEqual({ kind: 'href', href: '#/work/development' });
  });

  it('never says quiet before a source has answered, or when one failed', async () => {
    const { surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const { combineNeeds, headline } = await import(path.join(CONSOLE, 'home-model.js'));
    const unread = combineNeeds(quietQueue, noPromises, surfacedNeeds({}, NOW));
    expect(headline({ needs: unread, promised: noPromises }).text).toMatch(/Checking in/);
    const failedAll: any = {};
    const { NEED_SOURCES } = await import(path.join(CONSOLE, 'needs-model.js'));
    for (const s of NEED_SOURCES) failedAll[s.id] = { results: Object.fromEntries(Object.keys(s.reads).map((k) => [k, { ok: false, status: 500, reason: 'the server answered 500' }])) };
    const failed = combineNeeds(quietQueue, noPromises, surfacedNeeds(failedAll, NOW));
    expect(failed.state).toBe('partial');
    expect(headline({ needs: failed, promised: noPromises }).text).toBe('Nothing needs you that I can see.');
  });

  it('503 is off, not failed: a feature switched off does not leave Home partial', async () => {
    const { NEED_SOURCES, surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const known: any = {};
    for (const s of NEED_SOURCES) known[s.id] = { results: Object.fromEntries(Object.keys(s.reads).map((k) => [k, { ok: false, status: 503, reason: 'switched off on this agent' }])) };
    expect(surfacedNeeds(known, NOW)).toMatchObject({ rows: [], failed: [], pending: [] });
  });

  it('a failed read keeps its last good rows for a while, then drops them', async () => {
    const { surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const known: any = { merging: { results: { watcher: FIXTURES.merging.reads['/green-pr-automerge'] } } };
    expect(surfacedNeeds(known, NOW).rows).toHaveLength(1);
    known.merging.results = { watcher: { ok: false, status: 500, reason: 'x' } };
    expect(surfacedNeeds(known, NOW + 1000).rows).toHaveLength(1);
    expect(surfacedNeeds(known, NOW + 300000).rows).toHaveLength(0);
  });

  it('a slow queue cannot hide a surfaced need', async () => {
    const { combineNeeds, headline } = await import(path.join(CONSOLE, 'home-model.js'));
    const rows = [{ key: 'k', main: 'Automatic merging is stopped', tone: 'attn', action: { kind: 'href', href: '#/x' } }];
    const m = combineNeeds({ state: 'loading' }, { state: 'loading' }, { rows, pending: [], failed: [] });
    expect(m.count).toBe(1);
    expect(headline({ needs: m, promised: { state: 'loading' } }).text).toBe('Automatic merging is stopped');
  });

  it('dedupes by identity only: one sign-in item does not hide another account', async () => {
    const { combineNeeds } = await import(path.join(CONSOLE, 'home-model.js'));
    const queue = { count: 1, rows: [{ key: 'q', main: 'Sign in luna@x.io', tone: 'attn' }], all: [{ key: 'q', main: 'Sign in luna@x.io', tone: 'attn' }], state: 'attn', line: 'Waiting on you.' };
    const row = (email: string) => ({ key: email, main: `Sign in ${email}`, tone: 'attn', refs: [email], action: { kind: 'href', href: '#/x' } });
    const m = combineNeeds(queue, noPromises, { rows: [row('luna@x.io'), row('sol@x.io')], pending: [], failed: [] });
    expect(m.count).toBe(2);
    expect(m.all.map((r: any) => r.main).sort()).toEqual(['Sign in luna@x.io', 'Sign in sol@x.io']);
    const near = combineNeeds({ ...queue, all: [{ key: 'q', main: 'PR #26789 waits', tone: 'attn' }] }, noPromises, { rows: [{ key: 'p', main: 'PR', tone: 'attn', refs: ['#2678'], action: { kind: 'href', href: '#/x' } }], pending: [], failed: [] });
    expect(near.count).toBe(2);
  });

  it('a 200 with the wrong shape is not "nothing waiting"', async () => {
    const { surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const s = surfacedNeeds({ approvals: { results: { approvals: ok({ nope: 1 }) } }, secrets: { results: { pending: ok({}) } }, plans: { results: { initiatives: ok({ nope: 1 }), blockers: ok({}) } } }, NOW);
    expect(s.failed).toEqual(expect.arrayContaining(['approvals', 'secrets', 'plans']));
  });

  it('accounts switched off (enabled: false) is off, not failed', async () => {
    const { surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const s = surfacedNeeds({ accounts: { results: { pool: ok({ enabled: false }), relogin: ok({}) } } }, NOW);
    expect(s.failed).not.toContain('accounts');
  });

  it('the conditional feedback source never holds the headline at "Checking in"', async () => {
    const { NEED_SOURCES, surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const known: any = {};
    for (const s of NEED_SOURCES) if (s.id !== 'feedback') known[s.id] = { results: Object.fromEntries(Object.keys(s.reads).map((k) => [k, s.id === 'merging' ? ok(watcher()) : { ok: false, status: 503, reason: 'switched off on this agent' }])) };
    expect(surfacedNeeds(known, NOW).pending).toEqual([]);
  });

  it('a stop only the agent holds asks nothing of the operator; a mixed stop does', async () => {
    const { surfacedNeeds } = await import(path.join(CONSOLE, 'needs-model.js'));
    const w = (stops: unknown[]) => ({ merging: { results: { watcher: ok(watcher({ gate: { rollback: [{ by: 'x' }], rollbackStops: stops } })) } } });
    expect(surfacedNeeds(w([{ class: 'agent' }]), NOW).rows).toHaveLength(0);
    expect(surfacedNeeds(w([{ class: 'agent' }, { class: 'operator' }]), NOW).rows).toHaveLength(1);
  });

  it('secret rows carry no one-time token', async () => {
    const { NEED_SOURCES } = await import(path.join(CONSOLE, 'needs-model.js'));
    const src = NEED_SOURCES.find((s: any) => s.id === 'secrets');
    const [r] = src.rows({ pending: FIXTURES.secrets.reads['/secrets/pending'] }, NOW);
    expect(JSON.stringify(r)).not.toContain('tok1');
  });
});

// ── console-wide scans ─────────────────────────────────────────────────────
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).map((l) => l.replace(/(^|\s)\/\/ .*$/, '$1')).join('\n');
const FORBIDDEN = /\b(below|further down|scroll down|at the bottom)\b/i;
const NEED_WORDS = /\b(needs? you|waiting on you|your approval)\b/i;
const consoleFiles = () => fs.readdirSync(CONSOLE).filter((f) => f.endsWith('.js'));
const read = (f: string) => stripComments(fs.readFileSync(path.join(CONSOLE, f), 'utf8'));

function pointerLines(src: string) { return stripComments(src).split('\n').filter((l) => FORBIDDEN.test(l)); }
function unregisteredNeedLines(file: string, src: string, ownFiles: Set<string>, exempt: { file: string; phrase: string }[]) {
  if (ownFiles.has(file)) return [];
  return stripComments(src).split('\n').filter((l) => NEED_WORDS.test(l) && !exempt.some((x) => x.file === file && (!x.phrase || l.includes(x.phrase))));
}

describe('copy never points at a place', () => {
  it.each(consoleFiles())('%s', (f: string) => { expect(pointerLines(fs.readFileSync(path.join(CONSOLE, f), 'utf8'))).toEqual([]); });
});

describe('population floors', () => {
  it('the registry has not shrunk, and every source has a fixture', async () => {
    const { NEED_SOURCES } = await import(path.join(CONSOLE, 'needs-model.js'));
    expect(NEED_SOURCES.length).toBeGreaterThanOrEqual(9);
    expect(NEED_SOURCES.map((s: any) => s.id).sort()).toEqual(Object.keys(FIXTURES).sort());
  });
  it('sees the whole console', () => { expect(consoleFiles().length).toBeGreaterThanOrEqual(45); });
  it('every source page is a real registered route', async () => {
    const { NEED_SOURCES } = await import(path.join(CONSOLE, 'needs-model.js'));
    const src = fs.readFileSync(path.join(CONSOLE, 'console.js'), 'utf8');
    for (const s of NEED_SOURCES) expect(src).toContain(`'${s.page}'`);
  });
  it('a file that says "needs you" is registered, or names its exact phrase and reason', async () => {
    const { NEED_SOURCES, NEED_EXEMPT } = await import(path.join(CONSOLE, 'needs-model.js'));
    const own = new Set<string>(['needs-model.js']);
    const pageFile: Record<string, string> = { 'work/development': 'development', 'capacity/health': 'health', 'capacity/accounts': 'accounts', 'people/agents': 'agents', 'people/mandates': 'mandates', 'work/plans': 'plans', 'people/secrets': 'secrets', 'work/chats': 'chats', 'capacity/costs': 'costs', 'settings/learned': 'learned', 'work/board': 'work' };
    for (const s of NEED_SOURCES) { own.add(`${pageFile[s.page]}.js`); own.add(`${pageFile[s.page]}-model.js`); }
    const bad = consoleFiles().flatMap((f) => unregisteredNeedLines(f, fs.readFileSync(path.join(CONSOLE, f), 'utf8'), own, NEED_EXEMPT).map((l) => `${f}: ${l.trim().slice(0, 110)}`));
    expect(bad).toEqual([]);
    for (const x of NEED_EXEMPT) expect(x.why.length, x.file).toBeGreaterThan(10);
  });
});

describe('NEGATIVE CONTROLS: the same checks catch each fault', () => {
  const page = (html: string) => { const m = mainNode(); m.innerHTML = html; return m; };
  const head = '<section class="hero page-hero"><h1>x</h1></section>';
  it('a compliant page passes (the control itself is sound)', () => {
    expect(firstScreenViolations(page(`${head}<div class="need-card" data-operator-need="n"><button>Go</button></div><section class="list-section">a</section>`), 'n')).toEqual([]);
  });
  it('nothing marked', () => { expect(firstScreenViolations(page(head), 'n').join()).toContain('nothing is marked'); });
  it('buried below a section', () => {
    expect(firstScreenViolations(page(`${head}<section class="list-section" id="sec-a">a</section><div data-operator-need="n"><button>Go</button></div>`), 'n').join()).toContain('section comes before');
  });
  it('no action', () => { expect(firstScreenViolations(page(`${head}<div data-operator-need="n"><p>Turn it on</p></div>`), 'n').join()).toContain('no action'); });
  it('a disabled action is no action', () => { expect(firstScreenViolations(page(`${head}<div data-operator-need="n"><button disabled>Go</button></div>`), 'n').join()).toContain('no action'); });
  it('in a closed fold', () => { expect(firstScreenViolations(page(`${head}<details><summary>More</summary><div data-operator-need="n"><button>Go</button></div></details>`), 'n').join()).toContain('closed fold'); });
  it('a head so tall it pushes the need off screen', () => {
    expect(firstScreenViolations(page(`<section class="hero"><p>${'word '.repeat(200)}</p></section><div data-operator-need="n"><button>Go</button></div>`), 'n').join()).toContain('characters of text');
  });
  it('a notice saying "below"', () => {
    expect(pointerLines("note('Turn it back on below.');\n")).toHaveLength(1);
    expect(pointerLines("// a comment saying below\nnote('Turn it back on.');\n")).toHaveLength(0);
  });
  it('a new page saying "needs you", unregistered and unexempt', () => {
    expect(unregisteredNeedLines('new.js', "note('This needs you');\n", new Set(), [])).toHaveLength(1);
    expect(unregisteredNeedLines('new.js', "note('This needs you');\n", new Set(['new.js']), [])).toHaveLength(0);
    expect(unregisteredNeedLines('old.js', "note('This needs you');\n", new Set(), [{ file: 'old.js', phrase: 'something else' }])).toHaveLength(1);
  });
  it('a surfaced row with no refs is never dropped', async () => {
    const { combineNeeds } = await import(path.join(CONSOLE, 'home-model.js'));
    const q = { count: 1, rows: [{ main: 'Automatic merging is stopped', tone: 'attn' }], all: [{ main: 'Automatic merging is stopped', tone: 'attn' }], state: 'attn', line: 'x' };
    expect(combineNeeds(q, { state: 'ok', count: 0, all: [] }, { rows: [{ main: 'Automatic merging is stopped', tone: 'attn', action: { kind: 'href', href: '#/x' } }], pending: [], failed: [] }).count).toBe(2);
  });
});
