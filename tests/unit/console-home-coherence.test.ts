/**
 * Console Home coherence invariant (operator report 2026-10-26: the headline said
 * "10 things need you." while the "What needs you" card directly below said
 * "Nothing needs you — 357 routine notices kept in the log.").
 *
 * The whole Home model is rendered over realistic source combinations and the
 * invariant is asserted on every one:
 *   1. the headline's number equals the "What needs you" card's count;
 *   2. no element says nothing / quiet while anything needs the operator;
 *   3. while a counting source is loading or has failed, neither the headline
 *      nor the card claims "nothing".
 * It also pins the operator's card-face rule: housekeeping (routine-notice
 * counts, "kept in the log", "listed separately", coverage notes) lives in the
 * card's Details fold, never on its face or in the headline.
 */
import { describe, it, expect } from 'vitest';
import {
  failure, buildReach, buildNeeds, combineNeeds, buildDoing, buildPromised, buildRunning, buildAllowed, headline,
  buildAccountNeeds, buildPrNeeds,
} from '../../dashboard/console/home-model.js';
import { guardsNeedingLook, groupFailures, needsOfKind, loadOf } from '../../dashboard/console/shared-counts.js';
import { buildPromisesPage } from '../../dashboard/console/promises-model.js';
import { buildMachinesPage, healthOf } from '../../dashboard/console/machines-model.js';
import { buildGuards, facts as allowedFacts } from '../../dashboard/console/allowed-model.js';
import { buildAccountsPage } from '../../dashboard/console/accounts-model.js';
import { buildShipping, developmentHeadline } from '../../dashboard/console/development-model.js';
import { buildProblems, insideHeadline, insideFacts } from '../../dashboard/console/inside-model.js';
import { secretsHeadline, secretsFacts } from '../../dashboard/console/secrets-model.js';
import { promisesAbout } from '../../dashboard/console/shared-counts.js';

const NOW = Date.parse('2026-10-26T18:00:00Z');
const ok = (data: unknown) => ({ ok: true, data });
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const LOADING = { state: 'loading' };

// ── realistic sources ──
const routine = Array.from({ length: 357 }, (_, n) => ({ id: `r${n}`, title: `Worktree scan ${n}`, status: 'OPEN', priority: 'LOW', category: 'worktree', createdAt: minsAgo(n) }));
const attentionEmpty = ok({ items: routine, pool: { failed: [] } });
const attentionTwo = ok({ items: [...routine,
  { id: 'a1', title: 'Approve the deploy', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: minsAgo(4) },
  { id: 'a2', title: 'Rotate the leaked token', status: 'OPEN', priority: 'URGENT', category: 'security', createdAt: minsAgo(40) },
], pool: { failed: [] } });
const attentionPartial = ok({ items: routine, pool: { failed: [{ nickname: 'Laptop' }] } });

const commitment = (n: number, over: Record<string, unknown> = {}) => ({
  id: `CMT-${n}`, status: 'pending', owner: 'user', blockedOn: 'user-input', createdAt: minsAgo(n * 30),
  agentResponse: `Waiting for your answer on question ${n}`, userRequest: `question ${n}`,
  viewSource: n % 2 ? 'replica' : 'own', originMachineId: n % 2 ? 'm2' : undefined, stalenessMs: n % 2 ? 60_000 : undefined, ...over,
});
const promisesTen = ok({ enabled: true, scope: 'mesh', commitments: [
  ...Array.from({ length: 10 }, (_, i) => commitment(i + 1)),
  commitment(20, { owner: 'agent', blockedOn: 'none', agentResponse: 'Report back on the build' }),
  commitment(21, { createdAt: minsAgo(60 * 24 * 30) }),   // stale: listed under See all, not counted
] });
const promisesNone = ok({ enabled: true, scope: 'mesh', commitments: [
  { id: 'CMT-9', status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: minsAgo(60), agentResponse: 'Report back', viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 },
] });

const others = () => ({
  reach: buildReach(ok({ telegramOrigin: { heldForward: { count: 0, observedAt: NOW - 1000, expiredUnreported: 0 } } }), NOW),
  doing: buildDoing(ok({ sessions: [{ name: 'Fix it', status: 'running', startedAt: minsAgo(20), machineNickname: 'Mac Studio' }], pool: { failed: [] } }), NOW),
  running: buildRunning(ok({ machines: [{ machineId: 'm1', nickname: 'Mac Studio', online: true, routerReceivedAt: minsAgo(0.5), loadAvg: 1, hardware: { cpuCores: 16 } }, { machineId: 'm2', nickname: 'Mac Mini', online: true, routerReceivedAt: minsAgo(0.5), loadAvg: 1, hardware: { cpuCores: 8 } }] }), NOW),
  allowed: buildAllowed(ok({ summary: { onConfirmed: 9, onUnverified: 0, onStale: 0, onBlind: 0, onDryRun: 2, offDeviant: 0, offDarkDefault: 3, offRuntimeDivergent: 0, errored: 0, missing: 0 }, guards: [] }), ok({ mandates: [] }), NOW),
});

type Card = { state: string; value?: string; line?: string; count?: number; pending?: boolean; details?: string[] };
function home(attnRes: unknown, promRes: unknown) {
  const attn = attnRes === 'loading' ? LOADING : buildNeeds(attnRes as never, NOW);
  const promised = promRes === 'loading' ? LOADING : buildPromised(promRes as never, NOW, 1);
  const cards: Record<string, Card> = { needs: combineNeeds(attn, promised), promised, ...others() };
  return { cards, h: headline(cards) };
}

const NOTHING = /\bnothing\b|\bquiet\b|\bidle\b/i;
const HOUSEKEEPING = /routine notice|kept in the log|listed separately|untouched for|only this machine|coverage/i;

function assertInvariant({ cards, h }: ReturnType<typeof home>) {
  const needs = cards.needs;
  const m = /^(\d+|One) things? needs? you\.$/.exec(h.text);
  if (needs.state === 'loading' || needs.pending) {
    expect(h.text).toBe('Checking in…');
  } else if (m) {
    expect(m[1] === 'One' ? 1 : Number(m[1])).toBe(needs.count);
  } else {
    expect(needs.count).toBe(0);
  }
  const needsSomething = (needs.count ?? 0) > 0;
  const faces = [h.text, h.sub || '', needs.value || '', needs.line || '', cards.promised.value || '', cards.promised.line || ''];
  if (needsSomething) for (const f of faces) expect(f, f).not.toMatch(NOTHING);
  // The face never carries housekeeping; the headline sub-line never does either.
  for (const c of Object.values(cards)) {
    expect(c.line || '', c.line).not.toMatch(HOUSEKEEPING);
    expect(c.value || '', c.value).not.toMatch(HOUSEKEEPING);
  }
  expect(h.sub || '').not.toMatch(HOUSEKEEPING);
}

describe('Home coherence: headline count === What needs you count', () => {
  it('attention empty (357 routine notices) + 10 promises waiting: the reported case', () => {
    const r = home(attentionEmpty, promisesTen);
    assertInvariant(r);
    expect(r.cards.needs.count).toBe(10);
    expect(r.h.text).toBe('10 things need you.');
    expect(r.cards.needs.value).toBe('10 things');
    expect(r.cards.promised.line).toBe('10 of them are waiting on you, listed under What needs you.');
    // Routine notices and the stale promise are one tap deeper.
    expect(r.cards.needs.details!.join(' ')).toContain('357 routine notices kept in the log');
    expect(r.cards.needs.details!.join(' ')).toContain('older promise');
  });

  it('the promise rows are plain, newest first, stale ones only under See all', () => {
    const { cards } = home(attentionEmpty, promisesTen);
    const n = cards.needs as unknown as { rows: { main: string; sub: string }[]; all: { main: string; sub: string; stale?: boolean }[] };
    expect(n.rows[0].main).toBe('Waiting for your answer on question 1');
    expect(n.rows[0].sub.startsWith('Needs your answer')).toBe(true);
    expect(n.all).toHaveLength(11);
    expect(n.all[10].stale).toBe(true);
  });

  it('attention items + no promises waiting', () => {
    const r = home(attentionTwo, promisesNone);
    assertInvariant(r);
    expect(r.h.text).toBe('2 things need you.');
  });

  it('both sources contribute to one count', () => {
    const r = home(attentionTwo, promisesTen);
    assertInvariant(r);
    expect(r.cards.needs.count).toBe(12);
    expect(r.h.text).toBe('12 things need you.');
  });

  it('nothing anywhere: a calm card with no housekeeping on its face', () => {
    const r = home(attentionEmpty, promisesNone);
    assertInvariant(r);
    expect(r.cards.needs.value).toBe('Nothing needs you');
    expect(r.cards.needs.line).toBe('');
    expect(r.h.text).toBe('All quiet.');
  });

  it('promises failed, attention empty: never "nothing needs you"', () => {
    const r = home(attentionEmpty, failure('the server answered 500'));
    assertInvariant(r);
    expect(r.cards.needs.value).not.toMatch(/Nothing needs you/);
    expect(r.h.text).not.toBe('All quiet.');
  });

  it('attention failed, promises waiting: the known promises still count, marked partial', () => {
    const r = home(failure('timeout'), promisesTen);
    assertInvariant(r);
    expect(r.cards.needs.count).toBe(10);
    expect(r.cards.needs.state).toBe('partial');
    expect(r.h.sub).toContain('There may be more');
  });

  it('both failed: "Can\'t tell", never "nothing"', () => {
    const r = home(failure('x'), failure('y'));
    assertInvariant(r);
    expect(r.cards.needs.value).toBe("Can't tell");
  });

  it('a source still loading: neither headline nor card claims anything', () => {
    for (const [a, p] of [['loading', promisesTen], [attentionEmpty, 'loading'], [attentionTwo, 'loading'], ['loading', 'loading']] as const) {
      const r = home(a, p);
      assertInvariant(r);
      expect(r.h.text).toBe('Checking in…');
      expect(r.cards.needs.value || '').not.toMatch(NOTHING);
    }
  });

  it('a peer that did not answer the attention read: nothing is not claimed', () => {
    const r = home(attentionPartial, promisesNone);
    assertInvariant(r);
    expect(r.cards.needs.value).toBe('Nothing I can see');
    expect(r.h.text).not.toBe('All quiet.');
  });
});

/**
 * Cross-page coherence (QA review 2026-10-26, the root cause behind most findings):
 * every page counted the same facts with its own formula, so Home disagreed with
 * the pages it opens. Every count now comes from dashboard/console/shared-counts.js;
 * this block renders Home AND each page over ONE realistic fixture set (modelled on
 * the live 2026-10-26 reads) and holds the invariants:
 *   1. Home's needs-you count == the attention + PR + sign-in-tap items plus the
 *      promises waiting on the operator that are not already one of those; each
 *      page's "needs you" tile == the items of ITS kind in that one list;
 *   2. Home's "N open promises" == the Promises page's open total; its See-all rows
 *      are exactly that page's missed + due-soon + carrying rows, newest first;
 *   3. the safety-check count is equal across Home, Machines and Allowed for the
 *      same scope, with "can't tell" machines named apart and never counted;
 *   4. one load reading per machine on Home and Machines; the machine sheet names
 *      the failing probe and reads the same safety-check count;
 *   5. no page says nothing / all / idle / none while another element shows an item
 *      of that kind.
 */
describe('Cross-page coherence: one shared source for every count', () => {
  const daysAgo = (d: number) => minsAgo(d * 1440);
  // ── promises: 10 waiting (3 about a PR / password / sign-in, 1 about an attention item), 22 missed, 148 carried (4 due soon), 600 older, 1 older waiting ──
  const promise = (n: number, over: Record<string, unknown> = {}) => ({ id: `CMT-${n}`, status: 'pending', owner: 'agent', blockedOn: 'none', createdAt: minsAgo(n * 17), agentResponse: `Report back on item ${n}`, userRequest: `item ${n}`, viewSource: 'own', ...over });
  const waitingTexts = [
    'Told Dawn I will report when the pairing reads mutual-verified; merge PR 2350 only after Justin confirms in topic 9210.',
    'After Justin approves attention item agent:echo-disk-cleanup-2026-10-23, clear the 51 reap-eligible worktrees (~27 GB).',
    'Asked Justin the one question I cannot decide: which of the four other agent servers on that laptop matter least.',
    'Sign the Claude login (luna@x.io) back in on the Laptop via a normal Chrome profile once you say go.',
    'Two low-usage accounts still hold an unused free reset. luna needs a password from Justin.',
    'Registering the check as REQUIRED in branch protection needs repository admin on GitHub; waiting on that.',
    'I will confirm whether indra actually answers him on Slack once he resends his calendar request.',
    'On Justin’s go-ahead, pause the-portal automation on the laptop and bring the process counts down.',
    'Proposal sent for giving each agent its own tmux host. The one decision that is Justin’s.',
    'Diagnosed: npm returned 404 because the token has no publish rights. Waiting on org rights.',
  ];
  const commitments = [
    ...waitingTexts.map((t, i) => promise(100 + i, { owner: 'user', blockedOn: i % 2 ? 'user-input' : 'user-authorization', agentResponse: t, createdAt: daysAgo(i + 1) })),
    ...Array.from({ length: 22 }, (_, i) => promise(200 + i, { status: 'violated', createdAt: daysAgo(i < 3 ? 4 + i : 60 + i) })),
    ...Array.from({ length: 144 }, (_, i) => promise(300 + i, { createdAt: daysAgo(((i * 7) % 13) + 0.5) })),
    ...Array.from({ length: 4 }, (_, i) => promise(500 + i, { nextUpdateDueAt: new Date(NOW + (i + 1) * 3_600_000).toISOString() })),
    ...Array.from({ length: 600 }, (_, i) => promise(600 + i, { createdAt: daysAgo(30 + (i % 40)) })),
    promise(1300, { owner: 'user', blockedOn: 'user-input', createdAt: daysAgo(20), agentResponse: 'An old question for you' }),
    ...Array.from({ length: 5 }, (_, i) => promise(1400 + i, { status: 'delivered', resolvedAt: daysAgo(i + 1) })),
  ];
  const promisesRes = ok({ enabled: true, scope: 'mesh', commitments });
  // ── attention: 293 routine HIGH notices + one agent-raised approval (the one a promise names) ──
  const attentionRes = ok({ items: [
    ...Array.from({ length: 293 }, (_, n) => ({ id: `n${n}`, title: `Worktree scan ${n}`, status: 'OPEN', priority: 'HIGH', createdAt: minsAgo(n) })),
    { id: 'agent:echo-disk-cleanup-2026-10-23', title: 'Approve clearing 51 reap-eligible worktrees (~27 GB)', status: 'OPEN', priority: 'HIGH', source: 'agent', createdAt: daysAgo(3) },
  ], pool: { failed: [] } });
  // ── accounts: 13 accounts × 4 machines; 11 expired cells (Mac Mini 5, Mama PC 6); ONE repair offered for a tap ──
  const machinesList = [['m1', 'Mac Studio'], ['m2', 'Mac Mini'], ['m3', 'Laptop'], ['m4', 'Mama PC']];
  const accountIds = ['sagemind-justin', 'gearfinity3d', 'luna', 'adriana', 'justin-gmail', 'sagemind-dawn', 'echo', 'sagemind-adriana', 'codex-1', 'codex-2', 'codex-3', 'codex-4', 'codex-5'];
  const expiredOn: Record<string, string[]> = { m2: accountIds.slice(0, 5), m4: accountIds.slice(0, 6) };
  const accountRows = accountIds.flatMap((id) => machinesList.map(([mid, nick]) => ({ id, nickname: id, email: `${id}@x.io`, framework: id.startsWith('codex') ? 'codex-cli' : 'claude-code', machineId: mid, machineNickname: nick,
    status: (expiredOn[mid] || []).includes(id) ? 'needs-reauth' : 'active', loginCheck: (expiredOn[mid] || []).includes(id) ? 'unavailable' : 'ok',
    lastQuota: { measuredAt: minsAgo(3), sevenDay: { utilizationPct: 76, resetsAt: new Date(NOW + 86_400_000).toISOString() } } })));
  const poolAccountsRes = ok({ enabled: true, accounts: accountRows, pool: { failed: [] } });
  const reloginRes = ok({ enabled: true, scope: 'pool', episodes: [
    { id: 'e1', accountId: 'luna', machineId: 'm2', state: 'suggested', mode: 'approval', updatedAt: minsAgo(30) },
    { id: 'e2', accountId: 'sagemind-justin', machineId: 'm2', state: 'failed', mode: 'approval', nextAttemptAt: new Date(NOW + 3_600_000).toISOString(), updatedAt: minsAgo(400) },
  ], pool: { failed: [], unavailable: [{ machineId: 'm4', reason: 'feature-unavailable' }] } });
  // ── PRs: one waiting for the code-owner review (the one a promise names), stuck and queued ones ──
  const greenPrRes = ok({ lastTickAt: NOW - 60_000, lastSuccessfulListAt: NOW - 60_000, snapshot: { at: NOW - 60_000, entries: [{ pr: 2350, kind: 'code-owner-review' }, { pr: 2357, kind: 'mergeable' }] },
    episodes: [{ pr: 2357, state: 'gave-up', attempts: 3, lastOutcome: 'refused:verify-failed', lastAttemptAt: NOW - 3_600_000 }], armed: [], stuckRed: [{ pr: 2363, redForMs: 7_200_000, failingChecks: ['decision-audit'] }], gate: {} });
  const verifyRes = ok({ queue: [{ pr: 2374 }, { pr: 0, kind: 'main' }, { pr: 2363 }], inFlight: null });
  // ── guards: this machine 100 checks (10 need a look); Mac Mini 15, Laptop 15; Mama PC cannot answer ──
  const guardSet = (prefix: string, deviant: number, missing: number, gaps: number, dark: number, dry: number, on: number, unverified: number) => [
    ...Array.from({ length: deviant }, (_, i) => ({ key: `monitoring.${prefix}dev${i}.enabled`, effective: 'off', offClass: 'diverged-from-default' })),
    ...Array.from({ length: missing }, (_, i) => ({ key: `monitoring.${prefix}miss${i}.enabled`, effective: 'missing' })),
    ...Array.from({ length: gaps }, (_, i) => ({ key: `multiMachine.${prefix}gap${i}.enabled`, effective: 'on-dry-run', loadBearing: true, loadBearingGap: true, criticalPath: `critical path ${prefix}${i}` })),
    ...Array.from({ length: dark }, (_, i) => ({ key: `monitoring.${prefix}dark${i}.enabled`, effective: 'off', offClass: 'dark-default' })),
    ...Array.from({ length: dry }, (_, i) => ({ key: `monitoring.${prefix}dry${i}.enabled`, effective: 'on-dry-run' })),
    ...Array.from({ length: on }, (_, i) => ({ key: `monitoring.${prefix}on${i}.enabled`, effective: 'on-confirmed' })),
    ...Array.from({ length: unverified }, (_, i) => ({ key: `monitoring.${prefix}unv${i}.enabled`, effective: 'on-unverified' })),
  ];
  const localGuards = guardSet('s', 7, 1, 2, 12, 6, 23, 49);
  const summary = { onConfirmed: 23, onUnverified: 49, onStale: 0, onBlind: 0, onDryRun: 8, off: 19, offDeviant: 7, offDarkDefault: 12, offRuntimeDivergent: 0, errored: 0, missing: 1, loadBearingGapKeys: ['multiMachine.sgap0.enabled', 'multiMachine.sgap1.enabled'] };
  const guardsLocalRes = ok({ machineId: 'm1', nickname: 'Mac Studio', guards: localGuards, summary });
  const guardsPoolRes = ok({ machineId: 'm1', nickname: 'Mac Studio', guards: localGuards, summary, pool: { machines: [
    { machineId: 'm2', nickname: 'Mac Mini', guards: guardSet('m', 7, 2, 6, 12, 6, 22, 41) },
    { machineId: 'm3', nickname: 'Laptop', guards: guardSet('l', 6, 3, 6, 9, 7, 23, 47) },
  ], failed: [{ machineId: 'm4', reason: 'no-known-url' }] } });
  // ── machines: a fresh server load report on three, a stale one on the Laptop (no reading) ──
  const machine = (id: string, nick: string, over: Record<string, unknown>) => ({ machineId: id, nickname: nick, online: true, routerReceivedAt: minsAgo(0.2), liveness: { state: 'live', evidenceAt: minsAgo(0.2), source: 'direct' }, isSelf: id === 'm1', ...over });
  const poolRes = ok({ enabled: true, selfMachineId: 'm1', router: { holder: 'm1' }, machines: [
    machine('m1', 'Mac Studio', { loadAvg: 17.6, hardware: { cpuCores: 16, cpuModel: 'Apple M4 Max', totalMemBytes: 64 * 2 ** 30 }, loadReport: { loadPerCore: 1.15, verdict: 'ok' }, loadReportAgeMs: 21_000, loadVerdict: 'ok' }),
    machine('m2', 'Mac Mini', { loadAvg: 2.0, hardware: { cpuCores: null }, loadReport: { loadPerCore: 0.2, verdict: 'ok' }, loadReportAgeMs: 21_000, loadVerdict: 'ok' }),
    machine('m3', 'Laptop', { loadAvg: 7.8, hardware: { cpuCores: null }, loadReport: { loadPerCore: 1.75, verdict: 'ok' }, loadReportAgeMs: 180_000, loadVerdict: 'unknown' }),
    machine('m4', 'Mama PC', { loadAvg: 0.05, hardware: { cpuCores: null }, loadReport: { loadPerCore: 0.004, verdict: 'ok' }, loadReportAgeMs: 17_000, loadVerdict: 'ok' }),
  ] });
  // ── this machine's parts, the failing probe, usage ──
  const systemsRes = ok({ issues: [], activeCapabilities: [
    { label: 'Session Recovery', status: 'active', metric: '5 recovered', processes: [] },
    { label: 'Health Monitoring', status: 'active', metric: '9 checks passed · 15/16 probes passed · Memory 62%', processes: [{ name: 'SystemReviewer', status: 'running', details: { status: 'degraded', message: '15/16 probes passed' } }] },
    { label: 'Safety & Trust', status: 'active', metric: 'All gates active', processes: [] },
    ...Array.from({ length: 9 }, (_, i) => ({ label: `Part ${i}`, status: 'active', metric: 'fine', processes: [] })),
  ] });
  const healthRes = ok({ telegramOrigin: { heldForward: { count: 0, observedAt: NOW - 1000, expiredUnreported: 0 } }, systemReview: { failedProbes: [{ probeId: 'instar.guard-posture.anomalies', name: 'Guard Posture Anomalies', error: 'Episode ep-1: 22 anomalies across machines' }] } });
  // ── problems: the same CI failure recorded several times, no confirmed pattern ──
  const failure_ = (id: string, summary: string, n: number, h: number) => ({ id, category: 'unknown', summary, status: 'open', occurrenceCount: n, detectedAt: minsAgo(h * 60), attribution: 'automatic', detail: { redacted: '' } });
  const failuresRes = ok({ failures: [failure_('a', 'CI CI failure', 1, 2), failure_('b', 'CI eli16-pr-gate failure', 1, 2), failure_('c', 'CI CI failure', 3, 3), failure_('d', 'CI Publish to npm failure', 5, 34), failure_('e', 'CI Publish to npm failure', 5, 58), failure_('f', 'CI eli16-pr-gate failure', 2, 70)] });
  const weekRes = ok({ total: 23, rollout: { stage: 'capture-only' } });

  // ── render everything once ──
  const promised = buildPromised(promisesRes, NOW, 3);
  const attn = buildNeeds(attentionRes, NOW);
  const accounts = buildAccountNeeds(poolAccountsRes, reloginRes, NOW);
  const prs = buildPrNeeds(greenPrRes, NOW);
  const needs = combineNeeds(attn, promised, { accounts, prs });
  const running = buildRunning(poolRes, NOW);
  const allowed = buildAllowed(guardsLocalRes, ok({ mandates: [] }), NOW);
  const cards = { needs, promised, running, allowed, ...others() };
  const h = headline(cards);
  const promisesPage = buildPromisesPage(promisesRes, NOW, { expectedPeers: 3 });
  const machinesPage = buildMachinesPage(poolRes, healthRes, NOW, { guards: guardsLocalRes });
  const allowedGuards = buildGuards(guardsPoolRes);
  const accountsPage = buildAccountsPage(poolAccountsRes, NOW, { episodes: reloginRes.data.episodes, unavailable: ['m4'], promises: commitments });
  const shipping = buildShipping({ watcher: greenPrRes, verify: verifyRes, release: { ok: false, status: 503, reason: 'switched off on this agent' } }, NOW, { repo: 'x/y', promises: commitments });
  const sheetHealth = healthOf(systemsRes, { health: healthRes, guards: guardsLocalRes });
  const problems = buildProblems({ insights: ok({ insights: [] }), pages: [failuresRes], week: weekRes, all: weekRes }, { now: NOW });
  const secretsPromised = promisesAbout(commitments, 'password', NOW);
  const secretsH = secretsHeadline({ requests: { ok: true, counts: { waiting: 0, soon: 0, expired: 0 } }, keys: { ok: true, names: ['a'] }, sync: { on: false, hidden: true }, promised: secretsPromised });

  it('1. needs-you: Home counts one deduplicated list; every page’s tile is its own kind of that list', () => {
    expect(promisesPage.ok && promisesPage.counts.waiting).toBe(10);
    // Of the 10 waiting promises, one names the attention item and one names PR 2350: folded, never counted twice.
    const folded = 2;
    expect(needs.fromQueue).toBe(1);
    expect(needs.fromPrs).toBe(1);
    expect(needs.fromAccounts).toBe(1);
    expect(needs.fromPromises).toBe(10 - folded);
    expect(needs.count).toBe(1 + 1 + 1 + 10 - folded);
    expect(h.text).toBe(`${needs.count} things need you.`);
    expect(needs.value).toBe(`${needs.count} things`);
    // A mixed list says what kinds, in one fixed order, on the card's own line.
    expect(needs.byKind).toEqual({ notice: 1, review: 1, 'sign-in': 1, approval: 4, answer: 4 });
    expect(needs.label).toBe('11 things: 1 notice, 1 review, 1 sign-in, 4 approvals, 4 answers');
    expect(needs.line).toContain('1 notice, 1 review, 1 sign-in, 4 approvals, 4 answers');
    // Development: PRs waiting on the operator + promises about a PR (the PR 2350 promise is folded into its PR row).
    const devNeeds = shipping.tiles.find((t) => t.key === 'needs')!.n;
    expect(devNeeds).toBe(needsOfKind(needs, (i: { kind: string; topic?: string }) => i.kind === 'pr' || (i.kind === 'promise' && i.topic === 'pr')).length);
    expect(devNeeds).toBe(2);
    expect(shipping.rows.find((r) => r.group === 'needs' && r.pr === 2350)!.sub).toContain('also a promise of mine');
    expect(developmentHeadline({ shipping, feedback: { todos: [], state: 'ok', line: '' } }).text).toBe('2 pull requests need your approval on GitHub.');
    // Accounts: the one repair waiting on a tap + the promise about a sign-in; the 11 expired logins are the agent's chore.
    expect(accountsPage.ok && accountsPage.needs.length).toBe(needsOfKind(needs, (i: { kind: string; topic?: string }) => i.kind === 'account' || (i.kind === 'promise' && i.topic === 'sign-in')).length);
    expect(accountsPage.ok && accountsPage.needs.length).toBe(2);
    expect(accountsPage.ok && accountsPage.expired.length).toBe(10);
    expect(accountsPage.ok && accountsPage.headline).toBe('2 sign-ins need you. 10 other sign-ins expired on Mac Mini and Mama PC, mine to repair.');
    expect(needs.details!.join(' ')).toContain('10 sign-ins expired on Mac Mini and Mama PC — mine to repair, not yours (1 repairing)');
    // Passwords & keys: the promise about a password shows there, never "Nothing is waiting".
    expect(secretsPromised.length).toBe(needsOfKind(needs, (i: { kind: string; topic?: string }) => i.kind === 'promise' && i.topic === 'password').length);
    // Two of the ten: the password one and the npm-token one (a token is a credential).
    expect(secretsPromised).toHaveLength(2);
    expect(secretsH).toEqual({ text: 'No request is open, but 2 promises of mine wait on a password from you.', tone: 'attn' });
    expect(secretsFacts({ requests: { ok: true, counts: { waiting: 0, soon: 0, expired: 0 } }, keys: { ok: true, names: ['a'] }, sync: { on: false, hidden: true }, promised: secretsPromised }).map((f) => f.label)).toContain('promised, waiting on you');
  });

  it('2. open promises: Home’s value is the Promises page’s open total; See all lists exactly its missed + due-soon + carrying rows, newest first', () => {
    expect(promisesPage.ok).toBe(true);
    if (!promisesPage.ok) return;
    expect(promisesPage.counts).toMatchObject({ waiting: 10, missed: 22, dueSoon: 4, carrying: 144, handled: 601, open: 180 });
    expect(promised.value).toBe('180 open promises');
    expect(promised.all).toHaveLength(22 + 4 + 144);
    expect(promised.line).toBe('10 of them are waiting on you, listed under What needs you. 22 missed.');
    expect(promisesPage.sub).toBe("180 open in all: 10 waiting on you, 22 missed, 148 I'm carrying (4 due within a day).");
    // Newest first: the card leads with the 4-day-old missed promise, never the 60-day ones.
    expect(promised.rows[0].end).toBe('4 d ago');
    expect(promised.all.slice(0, 22).map((r) => r.main)).toEqual(promisesPage.sections.missed.map((r) => r.main));
    expect(promised.details!.join(' ')).toContain('601 older ones untouched for 14+ days (1 waiting on you)');
  });

  it('3. safety checks: one count per scope across Home, Machines and Allowed; can’t-tell machines named apart', () => {
    const local = guardsNeedingLook(guardsLocalRes, { scope: 'local' });
    expect(local.count).toBe(10);
    expect(allowed.needLook).toBe(10);
    expect(allowed.rows[0].main).toBe('10 safety checks need a look on Mac Studio');
    expect(allowed.all).toHaveLength(10);
    expect(machinesPage.ok && machinesPage.facts.find((f) => /need a look/.test(f.label))).toEqual({ n: 10, label: 'need a look on Mac Studio', tone: 'attn', href: '#/settings/allowed?s=guards' });
    expect(allowedGuards.ok && allowedGuards.counts.look).toBe(40);
    expect(allowedGuards.ok && allowedGuards.look).toHaveLength(40);           // the list header shows rows.length: 40, not 41
    expect(allowedGuards.ok && allowedGuards.counts.cantTell).toBe(1);
    expect(allowedGuards.ok && allowedGuards.failed[0].main).toBe('a machine with no name yet');   // never a raw id
    expect(buildGuards(guardsPoolRes, { names: { m4: 'Mama PC' } }).failed[0].main).toBe('Mama PC');
    expect(allowedGuards.ok && allowedGuards.scopeWords).toBe('across 3 machines');
    expect(allowedFacts({ guards: allowedGuards })[0]).toMatchObject({ n: 40, label: 'checks need a look across 3 machines' });
    // The machine sheet reads the same list: never "All gates active" over 10 checks needing a look.
    expect(sheetHealth.ok && sheetHealth.rows.find((r) => r.main === 'Safety & Trust')!.sub).toBe('10 safety checks need a look on Mac Studio');
  });

  it('4. load and health: one load reading per machine on Home and Machines; the failing probe is named', () => {
    expect(machinesPage.ok).toBe(true);
    if (!machinesPage.ok) return;
    for (const hm of running.machines) {
      const pm = machinesPage.machines.find((m) => m.name === hm.name)!;
      expect(pm.perCore ?? null, hm.name).toBe(hm.perCore ?? null);
      expect(loadOf(poolRes.data.machines.find((m) => m.nickname === hm.name), NOW).perCore ?? null, hm.name).toBe(hm.perCore ?? null);
      // The same state word on Home's strip and the Machines card (the server's liveness, never Home's own estimate).
      expect([pm.state, pm.label], hm.name).toEqual([hm.state, hm.label]);
    }
    expect(running.value).toBe('4 of 4 live');
    expect(machinesPage.headline).toBe('All 4 machines are answering.');
    expect(machinesPage.machines.find((m) => m.name === 'Mac Studio')!.loadWords).toBe('ok · load 1.1 per core');
    expect(machinesPage.machines.find((m) => m.name === 'Laptop')!.loadWords).toBe('no load reading');
    expect(running.machines.find((m) => m.name === 'Laptop')!.perCore ?? null).toBeNull();
    expect(sheetHealth.ok && sheetHealth.summary).toBe('2 parts need a look: Health Monitoring, Safety & Trust. 10 of 12 working.');
    expect(sheetHealth.ok && sheetHealth.rows.find((r) => r.main === 'Health Monitoring')!.sub).toContain('failing: Guard Posture Anomalies');
  });

  it('5. nothing says "nothing / all / none" while another element shows an item of that kind', () => {
    const NOTHING = /\bnothing\b|\ball\b.*\bworking\b|\bnone needs\b|\bidle\b/i;
    // Inside: six records of three CI problems — two of them seen more than once — are not "Nothing repeating".
    expect(problems.ok && problems.repeatingCount).toBe(groupFailures(failuresRes.data.failures).repeating.length);
    expect(problems.ok && problems.repeatingCount).toBe(3);
    expect(problems.ok && problems.line).toBe('3 problems keep repeating; the first: CI Publish to npm failure (seen 10 times).');
    expect(problems.ok && problems.rows).toHaveLength(3);
    expect(insideHeadline({ problems }).text).not.toMatch(NOTHING);
    expect(insideFacts({ problems }).find((f) => f.label === 'repeating')!.n).toBe(3);
    // Accounts with a tap waiting never says none needs it; the machine sheet never says all parts work over a failed probe.
    expect(accountsPage.ok && accountsPage.headline).not.toMatch(NOTHING);
    expect(sheetHealth.ok && sheetHealth.summary).not.toMatch(NOTHING);
    expect(secretsH.text).not.toMatch(/^Nothing is waiting\.$/);
    // Home: every face with the count on it.
    for (const f of [h.text, needs.value, needs.line || '', promised.value]) expect(f, f).not.toMatch(NOTHING);
    // And the converse: with no items of a kind anywhere, the pages agree on calm.
    const calmPromises = ok({ enabled: true, scope: 'mesh', commitments: [promise(1, { status: 'delivered', resolvedAt: minsAgo(10), viewSource: 'replica', originMachineId: 'm2', stalenessMs: 1000 })] });
    const calmNeeds = combineNeeds(buildNeeds(ok({ items: [], pool: { failed: [] } }), NOW), buildPromised(calmPromises, NOW, 1), { accounts: buildAccountNeeds(ok({ enabled: true, accounts: accountRows.filter((r) => r.status === 'active'), pool: { failed: [] } }), ok({ enabled: true, episodes: [], pool: { failed: [], unavailable: [] } }), NOW), prs: buildPrNeeds({ ok: false, status: 503, reason: 'switched off on this agent' }, NOW) });
    expect(calmNeeds.value).toBe('Nothing needs you');
    expect(calmNeeds.count).toBe(0);
    const calmAccounts = buildAccountsPage(ok({ enabled: true, accounts: accountRows.filter((r) => r.status === 'active'), pool: { failed: [] } }), NOW, { promises: [] });
    expect(calmAccounts.ok && calmAccounts.needs).toEqual([]);
    expect(calmAccounts.ok && calmAccounts.expired).toEqual([]);
    const calmShipping = buildShipping({ watcher: ok({ ...greenPrRes.data, snapshot: { at: NOW - 60_000, entries: [] }, episodes: [], stuckRed: [] }), verify: verifyRes, release: { ok: false, status: 503, reason: 'switched off on this agent' } }, NOW, { repo: 'x/y', promises: [] });
    expect(calmShipping.tiles.find((t) => t.key === 'needs')!.n).toBe(0);
  });
});
