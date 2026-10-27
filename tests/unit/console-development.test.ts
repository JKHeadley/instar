/**
 * Console Development page (docs/specs/console-features/under-the-hood.md: Shipping ←
 * pr-pipeline, Feedback ← feedback-drain, Pace ← throughput): every decision in the
 * model on both sides, and the shipped page in jsdom driving one Feedback approval
 * through the shared PIN sheet (the PIN is sent once, in that request's body, and the
 * field is gone afterwards).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  maintainerMode, sourceState, buildShipping, watcherLine, releaseLine, holdWords, verifyWords, rollbackWords,
  buildPace, paceFailure, pacificDay, buildFeedback, operatorTodos, authorityCard, authorityStatusLine, progressLine, queueRow,
  readinessAuthorityRequest, triageAuthorityRequest, commitRequest, authorityResultWords, commitResultWords, developmentHeadline,
  WATCHER_CADENCE_MS, STALL_TICKS, DEV_TOOLS_KEY,
} from '../../dashboard/console/development-model.js';
import { NATIVE_PAGES, tabHref, GROUPS } from '../../dashboard/console/nav-model.js';

const NOW = Date.parse('2026-10-25T23:30:00Z');
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const off = () => ({ ok: false, status: 503, reason: 'switched off on this agent' });
const fail = (reason = 'the server answered 500', status = 500) => ({ ok: false, status, reason });
const minsAgo = (m: number) => NOW - m * 60000;

// A real readiness proposal shape (src/feedback-factory/drain/readinessAuthorityProposal.ts).
const proposal = (over: Record<string, unknown> = {}) => ({
  status: 'none', current: null,
  proposal: { authorityId: 'feedback-readiness-default', agentId: 'echo', ownerMachineId: 'studio', ownerEpoch: 7, provider: 'codex-cli', modelFamily: 'gpt-6-luna', promptVersion: 'p3', schemaVersion: 's2', decisionPointId: 'feedback-readiness', maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 },
  blockers: [], approveAction: 'create',
  summary: 'Let GPT-6 Luna (via Codex) decide which of up to 50 incoming reports a batch become work items, spending at most $5 a day.',
  pausedBecause: null, ...over,
});
const watcher = (over: Record<string, unknown> = {}) => ({
  lastTickAt: minsAgo(3), lastSuccessfulListAt: minsAgo(3), breaker: { open: false }, invariantOk: true, gate: { rollback: [], emergencyPause: [], poolArmed: true, mergeAllowed: true },
  snapshot: { at: minsAgo(3), entries: [{ pr: 2391, headRefName: 'echo/x', headRefOid: 'abc', kind: 'code-owner-review' }, { pr: 2380, headRefName: 'echo/y', headRefOid: 'def', kind: 'mergeable' }] },
  episodes: [{ pr: 2380, headRefOid: 'def', attempts: 1, rearmEpisodes: 0, state: 'active', lastOutcome: 'armed', armedAt: minsAgo(40) }, { pr: 2377, headRefOid: 'ghi', attempts: 2, rearmEpisodes: 0, state: 'active', lastOutcome: 'held' }],
  armed: [{ pr: 2380, armedAt: minsAgo(40), armedHead: 'def', overdue: false }], armedCount: 1, stuckRed: [], ...over,
});
const verify = (over: Record<string, unknown> = {}) => ({ queue: [{ id: 'q1', pr: 2388, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRefName: 'main', firstQueuedAt: minsAgo(10), attempts: 0, errorRetries: 0, starvedRaised: false, priority: 0 }], inFlight: null, blocked: false, records: 4, flakyFiles: {}, mergeLine: { wired: true, enabled: true, hold: null }, ...over });
const release = (over: Record<string, unknown> = {}) => ({ disabled: false, lastTickAt: minsAgo(10), openEpisodes: 0, oldestOpenSha: undefined, openAttentionId: undefined, ...over });
const series = (rows: unknown[], over: Record<string, unknown> = {}) => ({ repo: 'JKHeadley/instar', windowDays: 14, generatedAt: new Date(NOW).toISOString(), weights: { velocity: 0.4, speed: 0.2, quality: 0.25, output: 0.15 }, rows, ...over });
const day = (d: string, team: Record<string, number>, authors: Record<string, Record<string, number>> = {}) => ({ day: d, team: { merges: 0, medianLatencyH: 0, reworkLoops: 0, reverts: 0, medianPushIters: 0, medianLoc: 0, dayLoc: 0, index: 0, ...team }, authors });
const feedbackOk = (over: Record<string, unknown> = {}) => ({
  readiness: ok(proposal({ status: 'active', approveAction: null, current: { generation: 3, maxBatch: 50, maxDailySpendUsd: 5, matchesProposal: true } })),
  triageSummary: ok({ authority: 'active', counts: { untriaged: 4, queued: 10, work: 3, hold: 1, ignored: 0 }, callsUsedToday: 12, maxCallsPerDay: 200, quotaPause: null, ignoreBrake: { engaged: false }, ignoreLive: false, ignoreLiveRecommended: false }),
  triageProposal: ok({ status: 'active', approveAction: null, current: { generation: 2, maxBatch: 50, matchesProposal: true }, proposal: {}, blockers: [], summary: 's', pausedBecause: null }),
  execute: ok({ available: true, reason: 'ok', live: 1, openPrs: 2, startsToday: 1, attempts: [] }),
  queue: ok({ items: [{ rank: 1, initiativeId: 'i1', title: 'Telegram replies lost on restart', severity: 'serious', priority: 1, executionState: 'pr-open', prLink: 'https://github.com/JKHeadley/instar/pull/2400' }] }),
  drain: ok({ posture: { state: 'live', reason: 'live-healthy' }, restorePending: false, drain: { readiness: { collecting: 1, ready: 2 }, work: { queued: 3 } }, lastRun: { state: 'completed' }, authority: { authorityId: 'feedback-readiness-default', generation: 3, mode: 'active', revoked: false }, lastReadinessFailure: null, readinessProgress: { consecutiveFailedTicks: 0, stalledSince: null, lastSuccessAt: minsAgo(8) } }),
  ...over,
});

describe('maintainer mode is visibility only', () => {
  it('shows the tile when local verify or the merge watcher answers 200; hides it when both are 503; can’t tell on a failure', () => {
    expect(maintainerMode({ localVerify: ok({}), greenPr: off() })).toMatchObject({ visible: true, detected: 'yes', forced: false });
    expect(maintainerMode({ localVerify: off(), greenPr: ok({}) }).basis).toBe('the merge watcher answered on this agent');
    expect(maintainerMode({ localVerify: off(), greenPr: off() })).toMatchObject({ visible: false, detected: 'no' });
    const ct = maintainerMode({ localVerify: fail('no answer within 5 seconds'), greenPr: off() });
    expect(ct).toMatchObject({ visible: false, detected: 'cant-tell' });
    expect(ct.basis).toContain('no answer within 5 seconds');
  });
  it('the per-browser switch forces it on but never claims detection; the legacy tab ids land on their section', () => {
    expect(maintainerMode({ localVerify: off(), greenPr: off() }, 'on')).toMatchObject({ visible: true, detected: 'no', forced: true });
    expect(DEV_TOOLS_KEY).toBe('instar_console_dev_tools');
    expect(NATIVE_PAGES['pr-pipeline']).toBe('#/work/development?s=shipping');
    expect(tabHref('throughput')).toBe('#/work/development?s=pace');
    expect(tabHref('feedback-drain')).toBe('#/work/development?s=feedback');
    const hood = GROUPS.find((g) => g.id === 'settings')!.hood!;
    for (const id of ['pr-pipeline', 'throughput', 'feedback-drain']) expect(hood.find((t) => t.id === id)!.desc).toMatch(/^Now inside Development/);
    // The Development tile is NOT a legacy tab: it is added by the page module, so the registry check stays exact.
    expect(GROUPS.flatMap((g) => g.tabs).some((t) => t.id === 'development')).toBe(false);
  });
  it('a 503 is off, anything else is failed', () => {
    expect(sourceState(off())).toBe('off');
    expect(sourceState({ ok: false, reason: 'switched off on this agent' })).toBe('off');
    expect(sourceState(fail())).toBe('failed');
    expect(sourceState(undefined)).toBe('failed');
    expect(sourceState(ok({}))).toBe('ok');
  });
});

describe('Shipping', () => {
  it('reads needs-you, testing, armed, held and stuck from the three live systems, in that order', () => {
    const s = buildShipping({ watcher: ok(watcher()), verify: ok(verify()), release: ok(release()) }, NOW, { repo: 'JKHeadley/instar' });
    expect(s.state).toBe('ok');
    expect(s.headline).toBe('3 pull requests on the way. 1 needs your approval on GitHub.');
    expect(s.tone).toBe('attn');
    expect(s.tiles.map((t) => [t.key, t.n])).toEqual([['needs', 1], ['testing', 1], ['armed', 1], ['stuck', 0]]);
    expect(s.rows.map((r) => [r.group, r.pr])).toEqual([['needs', 2391], ['testing', 2388], ['armed', 2380], ['held', 2377]]);
    expect(s.rows[0].sub).toBe('waiting for your code-owner review on GitHub');
    expect(s.rows[0].href).toBe('https://github.com/JKHeadley/instar/pull/2391/files');
    expect(s.rows[1].sub).toBe('1st in line · about 45 min each');
    expect(s.rows[2].stage).toBe('set to merge');
    expect(s.rows[3].tone).toBe('unknown');
    expect(s.line).toBe('Shipping: 3 on the way, 1 needs you');
    expect(s.watcher).toMatchObject({ tone: 'ok' });
    expect(s.release.text).toBe('Release watchdog: nothing unresolved · last checked 10 min ago.');
  });
  it('armed past 24 h is overdue (amber); a gave-up episode and a stuck-red PR are stuck (red); approval-required is needs-you', () => {
    const w = watcher({ armed: [{ pr: 2380, armedAt: minsAgo(26 * 60), armedHead: 'def', overdue: true }],
      episodes: [{ pr: 2380, state: 'active', lastOutcome: 'armed', armedAt: minsAgo(26 * 60) }, { pr: 2300, state: 'gave-up', attempts: 5, lastOutcome: 'error:merge-failed', lastAttemptAt: minsAgo(90) }, { pr: 2301, state: 'active', lastOutcome: 'refused:approval-required', lastAttemptAt: minsAgo(5) }],
      stuckRed: [{ pr: 2299, redForMs: 3 * 3600000, failingChecks: ['unit', 'lint'] }], snapshot: { at: minsAgo(3), entries: [] } });
    const s = buildShipping({ watcher: ok(w), verify: ok(verify({ queue: [], inFlight: { pr: 2388, headSha: 'a'.repeat(40) } })), release: ok(release({ openEpisodes: 1, openAttentionId: 'ATT-9', oldestOpenSha: 'abc' })) }, NOW);
    expect(s.tiles.find((t) => t.key === 'armed')).toMatchObject({ n: 1, tone: 'attn', reason: '1 is overdue' });
    expect(s.rows.find((r) => r.pr === 2380)!.sub).toBe('set to merge, but waiting on checks for over a day');
    expect(s.tiles.find((t) => t.key === 'stuck')).toMatchObject({ n: 2, tone: 'bad' });
    expect(s.rows.find((r) => r.pr === 2299)!.sub).toBe('checks have been red for 3 h (unit, lint)');
    expect(s.rows.find((r) => r.pr === 2301)!.group).toBe('needs');
    expect(s.rows.find((r) => r.pr === 2388)!.sub).toBe('testing now · about 45 min');
    expect(s.headline).toBe('5 pull requests on the way. 1 needs your approval on GitHub. 2 are stuck.');
    expect(s.release).toMatchObject({ text: 'Release watchdog: 1 unresolved episode · last checked 10 min ago.', tone: 'attn', attentionId: 'ATT-9' });
    expect(s.rows.find((r) => r.pr === 2301)!.href).toBeNull(); // no repo known: no fabricated link
    expect(s.repoKnown).toBe(false);
  });
  it('off when both repo-gated reads are 503; partial when one source fails — its tile dashed, the others real; a standby names the holder', () => {
    const o = buildShipping({ watcher: off(), verify: off(), release: off() }, NOW);
    expect(o.state).toBe('off');
    expect(o.reason).toContain('aren’t set up on this machine');
    expect(o.release.tone).toBe('off');
    const p = buildShipping({ watcher: ok(watcher()), verify: fail('no answer within 5 seconds'), release: fail() }, NOW);
    expect(p.state).toBe('ok');
    expect(p.partial).toBe(true);
    expect(p.tiles.find((t) => t.key === 'testing')).toMatchObject({ n: 'Can’t tell', tone: 'unknown', reason: 'no answer within 5 seconds' });
    expect(p.tiles.find((t) => t.key === 'needs')!.n).toBe(1);
    expect(p.release.text).toBe('Release watchdog: can’t tell (the server answered 500).');
    const standby = buildShipping({ watcher: ok(watcher()), verify: { ok: false, status: 409, reason: 'the server answered 409', data: { error: 'not-lease-holder', holderMachineId: 'studio' } }, release: ok(release()) }, NOW);
    expect(standby.tiles.find((t) => t.key === 'testing')!.reason).toBe('testing runs on studio; open the console there for the queue');
    const noWatcher = buildShipping({ watcher: fail(), verify: ok(verify()), release: ok(release()) }, NOW);
    expect(noWatcher.headline).toBe('Can’t tell what is on the way to merge: the server answered 500.');
    expect(noWatcher.tiles.find((t) => t.key === 'testing')!.n).toBe(1);
  });
  it('a zero is "nothing on the way" only when the watcher’s last successful list is fresh; the watcher line tells slow, stuck, paused and stopped apart', () => {
    const empty = watcher({ snapshot: { at: minsAgo(3), entries: [] }, episodes: [], armed: [] });
    expect(buildShipping({ watcher: ok(empty), verify: ok(verify({ queue: [] })), release: ok(release()) }, NOW).headline).toBe('Nothing on the way to merge.');
    const stale = buildShipping({ watcher: ok({ ...empty, lastSuccessfulListAt: minsAgo(70), lastTickAt: minsAgo(70) }), verify: ok(verify({ queue: [] })), release: ok(release()) }, NOW);
    expect(stale.headline).toContain('last successful look was 1 h ago');
    expect(stale.tone).toBe('muted');
    expect(watcherLine({ lastTickAt: minsAgo(25) }, NOW)).toEqual({ text: 'Merge watcher last checked 25 min ago, usually every 10 min.', tone: 'attn' });
    expect(watcherLine({ lastTickAt: minsAgo(1), breaker: { open: true } }, NOW).tone).toBe('bad');
    expect(watcherLine({ lastTickAt: minsAgo(1), invariantOk: false }, NOW).text).toContain('safety invariant failed');
    expect(watcherLine({ lastTickAt: minsAgo(1), gate: { rollback: ['L1'] } }, NOW)).toMatchObject({ tone: 'attn', stopped: true });
    expect(watcherLine({}, NOW).text).toBe('Merge watcher has not checked yet.');
    expect(WATCHER_CADENCE_MS).toBe(600000);
    expect(releaseLine(ok(release({ disabled: true })), NOW)).toMatchObject({ tone: 'attn' });
  });
  it('the action words never claim more than the server did', () => {
    expect(holdWords(200, { ok: true, pr: 5 }).text).toContain('any in-flight merge was disarmed');
    expect(holdWords(502, { ok: false, pr: 5, detail: 'hold marker applied but could not disable the in-flight auto-merge — PR may still merge; disable it on GitHub directly' })).toMatchObject({ ok: false });
    expect(holdWords(502, { ok: false, pr: 5, detail: 'hold marker applied but could not disable the in-flight auto-merge' }).text).toContain('may still merge');
    expect(holdWords(404, { ok: false, pr: 5, detail: 'PR not eligible for hold' }).text).toBe('PR not eligible for hold');
    expect(verifyWords(202, { ok: true, status: 'queued', position: 1 }).text).toBe('Queued, 2nd in line. A full verify takes about 45 min.');
    expect(verifyWords(200, { ok: true, status: 'recorded', record: { verdict: 'pass' } }).text).toContain('Already verified');
    expect(verifyWords(409, { error: 'not-lease-holder', holderMachineId: 'studio' }).text).toBe('Testing runs on studio; ask there.');
    expect(verifyWords(429, { ok: false, code: 'queue-full' }).text).toContain('queue is full');
    const rb = rollbackWords(200, { ok: true, rolledBack: true, disarmed: [10], disarmFailed: [11] });
    expect(rb.text).toBe('Auto-merging is stopped; nothing new will be armed. Disarmed #10. Could NOT disarm #11 — disable it on GitHub directly.');
    expect(rollbackWords(503, { error: 'green-pr auto-merge not configured' }).ok).toBe(false);
  });
});

describe('Pace', () => {
  const rows = [
    day('2026-10-20', { merges: 3, medianLatencyH: 4, reworkLoops: 1, reverts: 0, medianPushIters: 3, medianLoc: 120, index: 70 }, { echo: { merges: 2, medianLatencyH: 5, reworkLoops: 1, reverts: 0, medianPushIters: 4, medianLoc: 200 } }),
    day('2026-10-22', { merges: 1, medianLatencyH: 10, reworkLoops: 0, reverts: 1, medianPushIters: 2, medianLoc: 40, index: 30 }, { codey: { merges: 1, medianLatencyH: 10, reworkLoops: 0, reverts: 1, medianPushIters: 2, medianLoc: 40 } }),
    day('2026-10-25', { merges: 2, medianLatencyH: 6, reworkLoops: 0, reverts: 0, medianPushIters: 1, medianLoc: 80, index: 55 }, { echo: { merges: 2, medianLatencyH: 6, reworkLoops: 0, reverts: 0, medianPushIters: 1, medianLoc: 80 } }),
  ];
  it('sums merges and redone over the window, labels medians as per-day values, and draws today hollow', () => {
    const p = buildPace(ok(series(rows)), { days: 14, person: 'team' }, NOW);
    expect(p.state).toBe('ok');
    expect(p.headline).toBe('Last 14 days: 6 merges, 1 revert.');
    expect(p.numbers.map((n) => [n.key, n.value])).toEqual([['merges', '6'], ['medianLatencyH', '6 h'], ['redone', '2'], ['medianLoc', '80 lines'], ['medianPushIters', '2']]);
    expect(p.numbers[1].note).toBe('a typical day (median of each day’s median)');
    expect(p.numbers[2].note).toBe('1 rework loop, 1 revert');
    expect(p.days.map((d) => d.isToday)).toEqual([false, false, pacificDay(NOW) === '2026-10-25']);
    expect(p.weightLines).toHaveLength(4);
    expect(p.line).toBe('Pace: 6 merges in 14 days');
    expect(JSON.stringify(p)).not.toMatch(/previous|earlier window|vs\./i); // no client-side comparison
  });
  it('a person filter uses that author’s own day metrics; a day without their merges counts nothing', () => {
    const p = buildPace(ok(series(rows)), { days: 7, person: 'echo' }, NOW);
    expect(p.headline).toBe('Last 7 days by Echo: 4 merges, 0 reverts.');
    expect(p.numbers[1].value).toBe('5.5 h');
    expect(p.days[1].values.merges).toBe(0);
    expect(buildPace(ok(series([])), { days: 30 }, NOW).headline).toBe('No merges in the last 30 days.');
  });
  it('the result cap and every other 503 are "can’t tell", never a partial figure; the auth 503 names the fix', () => {
    const cap = buildPace({ ok: false, status: 503, reason: 'switched off on this agent', code: 'github-throughput-result-cap-exceeded' }, { days: 30 }, NOW);
    expect(cap.state).toBe('cant-tell');
    expect(cap.reason).toBe('Too many pull requests in this window to count; try a shorter window.');
    expect(cap.numbers).toEqual([]);
    // The route folds the cap into one generic code (throughputRoutes.ts:206): the page says both possibilities, never a number.
    const generic = buildPace({ ok: false, status: 503, reason: 'switched off on this agent', code: 'throughput-series-unavailable' }, { days: 30 }, NOW);
    expect(generic.reason).toContain('too many pull requests to count');
    expect(generic.reason).toContain('shorter window');
    const auth = paceFailure({ ok: false, status: 503, code: 'github-auth-unavailable' });
    expect(auth.reason).toBe('Can’t reach GitHub from this machine: no GitHub sign-in found.');
    expect(auth.fix).toContain('Sign in with gh');
    expect(paceFailure({ ok: false, status: 400, code: 'invalid-throughput-window' }).reason).toContain('7, 14 or 30');
    expect(buildPace(fail('no answer within 15 seconds'), {}, NOW).reason).toBe('Couldn’t read the pace: no answer within 15 seconds.');
    expect(buildPace(ok({ repo: 'x' }), {}, NOW).reason).toContain('no day rows');
  });
});

describe('Feedback', () => {
  it('a pending readiness approval is the first to-do, built from the real proposal shape with the server’s summary verbatim', () => {
    const p = proposal();
    const f = buildFeedback(feedbackOk({ readiness: ok(p) }), NOW);
    expect(f.state).toBe('ok');
    expect(f.headline).toBe('Feedback is waiting on one approval from you.');
    expect(f.todos[0]).toMatchObject({ kind: 'readiness-authority', action: 'create', button: 'Approve' });
    const card = authorityCard('readiness', p);
    expect(card.summary).toBe(p.summary);
    expect(card.envelope).toEqual({ maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 });
    expect(card.boundTo).toBe('agent echo · machine studio (epoch 7) · model gpt-6-luna via codex-cli');
    expect(card.canRevoke).toBe(false);
    expect(f.tiles.find((t) => t.key === 'needs')).toMatchObject({ n: 2, tone: 'attn' });
    expect(f.line).toBe('Feedback: 2 things need you, 14 to sort');
    // The GitHub-approval to-do follows, from the queue.
    expect(f.todos[1]).toMatchObject({ kind: 'link', href: 'https://github.com/JKHeadley/instar/pull/2400' });
    expect(f.sub).toContain('After that, 1 more thing here needs you.');
  });
  it('paused, revoked and restore are told apart; "version" is never said', () => {
    const paused = proposal({ status: 'proposal-only', approveAction: 'replace', pausedBecause: 'the daily spend cap was reached.', current: { generation: 4, maxBatch: 50, maxDailySpendUsd: 5, matchesProposal: true } });
    expect(operatorTodos({ readiness: ok(paused) })[0].detail).toContain('It was paused: the daily spend cap was reached.');
    expect(authorityStatusLine('readiness', paused)).toBe('The sorting model is paused: the daily spend cap was reached. Only your approval restarts it.');
    const revoked = proposal({ status: 'revoked', approveAction: 'restore', current: { generation: 4, matchesProposal: false } });
    expect(authorityCard('readiness', revoked)).toMatchObject({ approveLabel: 'Approve (restore)', canRevoke: false });
    expect(authorityCard('readiness', revoked).restoreNote).toContain('Restore brings back');
    const active = proposal({ status: 'active', approveAction: null, current: { generation: 3, maxBatch: 50, maxDailySpendUsd: 5, matchesProposal: true } });
    expect(authorityStatusLine('readiness', active)).toBe('The sorting model is approved (generation 3): up to 50 reports a batch, $5 a day.');
    expect(authorityCard('readiness', active)).toMatchObject({ canSaveLimits: true, canRevoke: true, approveAction: null });
    expect(authorityStatusLine('triage', { status: 'none' })).toContain('No triage model is approved yet');
    for (const line of [authorityStatusLine('readiness', paused), authorityStatusLine('readiness', revoked), authorityStatusLine('readiness', active)]) expect(line).not.toMatch(/version/i);
  });
  it('the fix worker’s one-time OK and a held secret-shaped fix are plan to-dos with their attempt id', () => {
    const f = buildFeedback(feedbackOk({ execute: ok({ reason: 'approver-not-independent', live: 0, openPrs: 0, attempts: [{ attemptId: 'at-1', state: 'held', reason: 'needs-review-secret-shape', secretFiles: ['.env.example'] }] }) }), NOW);
    expect(f.todos.map((t) => [t.kind, t.action])).toEqual([['plan', 'accept-approver-dependence'], ['plan', 'publish-secret-shape'], ['link', undefined]]);
    expect(f.todos[1].attemptId).toBe('at-1');
    expect(f.todos[1].detail).toContain('.env.example');
    expect(f.settings.executor).toContain('waiting for your one-time OK');
  });
  it('any failed read that feeds the to-do list makes the headline "can’t tell", never "Nothing needs you"', () => {
    const f = buildFeedback(feedbackOk({ triageSummary: fail('no answer within 5 seconds') }), NOW);
    expect(f.state).toBe('cant-tell');
    expect(f.headline).toBe('I can’t tell whether feedback needs you: the triage summary didn’t answer (no answer within 5 seconds).');
    expect(f.headline).not.toMatch(/nothing needs you/i);
    expect(f.tiles.find((t) => t.key === 'sorting')).toMatchObject({ n: 'Can’t tell', tone: 'unknown' });
    // A to-do the other reads DID show is still listed under the can't-tell headline.
    expect(f.todos.length).toBe(1);
    expect(f.sub).toContain('listed below');
    const q = buildFeedback(feedbackOk({ queue: fail(), readiness: ok(proposal()) }), NOW);
    expect(q.state).toBe('cant-tell');
    expect(q.todos[0].kind).toBe('readiness-authority');
    // Only the drain status failing is a note, not a can't-tell headline (it does not feed the to-dos).
    const d = buildFeedback(feedbackOk({ drain: fail() }), NOW);
    expect(d.state).toBe('ok');
    expect(d.progress).toMatchObject({ tone: 'unknown', n: 'Can’t tell' });
  });
  it('all five off is "doesn’t run on this machine"; a 503 on one read is that read’s "off", not can’t tell', () => {
    const o = buildFeedback({ readiness: off(), triageSummary: off(), triageProposal: off(), execute: off(), queue: off(), drain: off() }, NOW);
    expect(o).toMatchObject({ state: 'off', headline: 'The feedback factory doesn’t run on this machine.', line: 'Feedback: not on this machine' });
    const e = buildFeedback(feedbackOk({ execute: off() }), NOW);
    expect(e.state).toBe('ok');
    expect(e.tiles.find((t) => t.key === 'fixing')).toMatchObject({ n: 'off', tone: 'off' });
    expect(e.settings.executor).toBe('The fix worker is off on this agent.');
  });
  it('nothing needs you only when every read answered; the calm line carries real counts', () => {
    const f = buildFeedback(feedbackOk({ queue: ok({ items: [] }) }), NOW);
    expect(f).toMatchObject({ state: 'ok', headline: 'Nothing needs you.', tone: 'ok' });
    expect(f.sub).toBe('Feedback is being sorted and fixed on its own: 3 items picked to work on, 14 waiting to be sorted, 2 fixes waiting for GitHub approval.');
    expect(f.tiles.map((t) => [t.key, t.n])).toEqual([['needs', 0], ['fixing', 3], ['sorting', 14], ['progress', '8 min ago']]);
    expect(f.settings.ignoreLive).toBe(false);
    expect(f.settings.triage.authorityWords).toBe('Triage is sorting.');
  });
  it('progress: stalled sorting (≥ 6 failed runs) is amber and says nothing is paused; a brake pause names the reason; no authority is "not set up"', () => {
    const stalled = ok({ posture: { state: 'live' }, readinessProgress: { consecutiveFailedTicks: 7, stalledSince: minsAgo(200), lastSuccessAt: minsAgo(400) }, lastReadinessFailure: { outcome: 'call-failed', at: minsAgo(20), diagnosis: { check: 'provider', message: 'HTTP 429' } } });
    const s = progressLine(stalled, ok(proposal({ status: 'active', approveAction: null })), NOW);
    expect(s.tone).toBe('attn');
    expect(s.text).toContain('hasn’t produced a usable answer since');
    expect(s.text).toContain('nothing is paused');
    expect(s.n).toBe('no answer for 7 runs');
    expect(STALL_TICKS).toBe(6);
    const f = buildFeedback(feedbackOk({ drain: stalled, readiness: ok(proposal({ status: 'active', approveAction: null, current: { generation: 3, matchesProposal: true } })) }), NOW);
    expect(f.technical!.lastReadinessFailure).toContain('provider: HTTP 429');
    const paused = progressLine(stalled, ok(proposal({ status: 'proposal-only', approveAction: 'replace', pausedBecause: 'a different model answered.' })), NOW);
    expect(paused).toMatchObject({ tone: 'attn', n: 'paused' });
    expect(paused.text).toBe('Sorting is paused: a different model answered. Only your approval restarts it.');
    expect(progressLine(ok({ readinessProgress: null }), off(), NOW).n).toBe('not set up');
    expect(progressLine(ok({ readinessProgress: { consecutiveFailedTicks: 2, stalledSince: minsAgo(30), lastSuccessAt: null } }), off(), NOW).text).toBe('No sorting run has produced an answer yet.');
    expect(progressLine(off(), off(), NOW).tone).toBe('off');
  });
  it('queue rows say severity and state in words; notes carry the quota pause and the ignore brake', () => {
    const r = queueRow({ rank: 2, initiativeId: 'i2', title: 'Slack thread loses its id', severity: 'high', priority: 2, executionState: 'running' });
    expect(r).toMatchObject({ main: 'Slack thread loses its id', sub: '2 · high · being worked on', end: 'P2', tone: 'attn', href: null });
    const f = buildFeedback(feedbackOk({ triageSummary: ok({ authority: 'paused', counts: {}, quotaPause: { at: minsAgo(5) }, ignoreBrake: { engaged: true }, ignoreLive: true, ignoreLiveRecommended: false }) }), NOW);
    expect(f.notes).toEqual(['Triage is paused for now: the account serving it is near its usage limit.', 'Ignores are braked: the ignore rate rose sharply, so new ignores are being held.']);
    expect(f.settings.ignoreLive).toBe(true);
  });
  it('request bodies match the routes: useProposal on create/replace, limits only when typed, planId + nonce bound with the PIN', () => {
    expect(readinessAuthorityRequest('create', { maxBatch: '40', maxTokens: '', maxDailySpendUsd: '5' }, '1234', 'ref')).toEqual({ action: 'create', pin: '1234', operatorDecisionRef: 'ref', useProposal: true, maxBatch: 40, maxDailySpendUsd: 5 });
    expect(readinessAuthorityRequest('revoke', { maxBatch: '40' }, '1234', 'ref')).toEqual({ action: 'revoke', pin: '1234', operatorDecisionRef: 'ref' });
    expect(triageAuthorityRequest('replace', { maxBatch: 20 }, '1', 'r')).toEqual({ action: 'replace', pin: '1', operatorDecisionRef: 'r', useProposal: true, maxBatch: 20 });
    expect(triageAuthorityRequest('restore', {}, '1', 'r')).toEqual({ action: 'restore', pin: '1', operatorDecisionRef: 'r' });
    expect(commitRequest({ planId: 'P', nonce: 'N', renderedText: 'x' }, '9')).toEqual({ pin: '9', planId: 'P', nonce: 'N' });
    expect(authorityResultWords('readiness', 200, { generation: 5 }).text).toBe('Approved (generation 5). The next run starts sorting.');
    expect(authorityResultWords('triage', 200, { generation: 5, revoked: true }).text).toContain('Revoked');
    expect(authorityResultWords('readiness', 403, { error: 'Operator PIN required' }).text).toBe('That PIN was not accepted. Nothing has changed.');
    expect(authorityResultWords('readiness', 429, { error: 'Too many attempts. Try again later.' }).text).toContain('Too many PIN attempts');
    expect(authorityResultWords('readiness', 503, { error: 'PIN authentication not available (no dashboardPin configured)' }).text).toContain('No dashboard PIN is configured');
    expect(authorityResultWords('readiness', 409, { error: 'authority proposal not approvable: x' }).text).toBe('Not applied: authority proposal not approvable: x. Nothing has changed.');
    expect(commitResultWords(200, { committed: true, action: 'ignore-live', ignoreLive: true }).text).toBe('Done: ignores are live.');
    expect(commitResultWords(200, { committed: true, action: 'publish-secret-shape', prNumber: 77 }).text).toBe('Done: published as pull request #77.');
    expect(commitResultWords(409, { error: 'plan expired' }).ok).toBe(false);
  });
});

describe('the combined headline', () => {
  it('leads with what needs the operator, then stuck work, then can’t tell, then quiet; all-off is honest', () => {
    const s = buildShipping({ watcher: ok(watcher()), verify: ok(verify()), release: ok(release()) }, NOW);
    const f = buildFeedback(feedbackOk({ readiness: ok(proposal()) }), NOW);
    expect(developmentHeadline({ shipping: s, feedback: f })).toMatchObject({ text: '3 things need you.', tone: 'attn' });
    const calm = buildFeedback(feedbackOk({ queue: ok({ items: [] }) }), NOW);
    expect(developmentHeadline({ shipping: s, feedback: calm }).text).toBe('One pull request needs your approval on GitHub.');
    const quietShip = buildShipping({ watcher: ok(watcher({ snapshot: { at: minsAgo(1), entries: [] }, episodes: [], armed: [] })), verify: ok(verify({ queue: [] })), release: ok(release()) }, NOW);
    expect(developmentHeadline({ shipping: quietShip, feedback: calm, pace: buildPace(ok(series([])), {}, NOW) })).toMatchObject({ text: 'Nothing here needs you.', tone: 'ok' });
    expect(developmentHeadline({ shipping: quietShip, feedback: buildFeedback(feedbackOk({ queue: fail() }), NOW) })).toMatchObject({ text: 'Can’t tell whether anything needs you.', tone: 'muted' });
    const offAll = developmentHeadline({ shipping: buildShipping({ watcher: off(), verify: off(), release: off() }, NOW), feedback: buildFeedback({ readiness: off(), triageSummary: off(), triageProposal: off(), execute: off(), queue: off(), drain: off() }, NOW) });
    expect(offAll.text).toBe('Development tools aren’t set up on this machine.');
  });
});

describe('development page in a DOM', () => {
  let dom: JSDOM;
  afterEach(() => dom?.window.close());

  it('boots the shipped console, puts the approval card first, and drives Approve through the PIN sheet: the PIN is sent once, in that body, and the field is gone', async () => {
    const posted: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const p = proposal();
    dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4040/dashboard/console/#/work/development' });
    const g = globalThis as Record<string, unknown>;
    Object.assign(g, { window: dom.window, document: dom.window.document, location: dom.window.location, history: dom.window.history, localStorage: dom.window.localStorage, requestAnimationFrame: (f: () => void) => setTimeout(f, 0) });
    dom.window.localStorage.setItem('instar_token', 't');
    g.fetch = async (url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      if (opts && opts.method === 'POST') {
        posted.push({ url, body: JSON.parse(opts.body || '{}'), headers: opts.headers || {} });
        return { ok: true, status: 200, json: async () => ({ authorityId: 'feedback-readiness-default', generation: 3, revoked: false }) };
      }
      const table: Record<string, { status?: number; body: unknown }> = {
        '/sessions': { body: { sessions: [] } },
        '/health': { body: { project: { name: 'echo' } } },
        '/green-pr-automerge': { body: watcher() },
        '/local-verify': { body: verify() },
        '/release-readiness': { body: release({ openEpisodes: 1, openAttentionId: 'ATT-1' }) },
        '/feedback-factory/readiness-authorities/proposal': { body: p },
        '/feedback-factory/triage/summary': { body: feedbackOk().triageSummary.data },
        '/feedback-factory/triage/authority/proposal': { body: feedbackOk().triageProposal.data },
        '/feedback-factory/execute/status': { status: 503, body: { error: 'feedback executor unavailable', reason: 'dark' } },
        '/feedback-factory/triage/queue': { body: { items: [] } },
        '/feedback-factory/drain/status': { body: feedbackOk().drain.data },
        '/throughput/series?days=14': { status: 503, body: { error: 'github-auth-unavailable' } },
      };
      const hit = table[url];
      if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'no such route in the test' }) };
      const status = hit.status || 200;
      return { ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(hit.body)) };
    };
    vi.resetModules();
    await import('../../dashboard/console/console.js');
    for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 20));
    const doc = dom.window.document;
    // One Feedback approval + one Shipping needs-you row.
    expect(doc.querySelector('.page-title')!.textContent).toBe('2 things need you.');
    // The approval card sits directly under the headline, before any section, with the server's summary verbatim.
    const page = doc.querySelector('.dev-page')!;
    expect(page.children[1].classList.contains('authority-card')).toBe(true);
    const card = page.children[1];
    expect(card.querySelector('.need-title')!.textContent).toBe('Approve which model sorts incoming reports');
    expect(card.querySelector('.plan-text')!.textContent).toBe(p.summary);
    expect(doc.querySelector('.pin-input')).toBeNull();
    // Feedback is the open fold (it has the to-do); Shipping and Pace are one-line summaries.
    expect(doc.querySelector('#sec-feedback .list-head')!.getAttribute('aria-expanded')).toBe('true');
    expect(doc.querySelector('#sec-shipping .fold-line')!.textContent).toBe('Shipping: 3 on the way, 1 needs you');
    expect(doc.querySelector('#sec-pace .fold-line')!.textContent).toBe('Pace: can’t tell');

    // Approve → the shared PIN sheet → one POST carrying the PIN → the field is gone.
    (card.querySelector('button[data-authority-action="create"]') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
    const pin = doc.querySelector('.sheet form.pin-form input.pin-input') as HTMLInputElement;
    expect(pin).toBeTruthy();
    expect(doc.querySelector('.sheet .confirm-text')!.textContent).toContain(p.summary);
    pin.value = '246810';
    pin.form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('/feedback-factory/readiness-authorities');
    expect(posted[0].headers['X-Instar-Request']).toBe('1');
    expect(posted[0].body).toMatchObject({ action: 'create', pin: '246810', useProposal: true, maxBatch: 50, maxTokens: 1200, maxDailySpendUsd: 5 });
    expect(String(posted[0].body.operatorDecisionRef)).toMatch(/^console-readiness:/);
    expect(doc.querySelector('.pin-input')).toBeNull();
    expect(doc.querySelector('.sheet')).toBeNull();
    expect(card.querySelector('.action-status')!.textContent).toBe('Approved (generation 3). The next run starts sorting.');

    // After the success refresh, the other two folds open in place: Shipping with its four tiles and PR rows, Pace honest about GitHub.
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 20));
    (doc.querySelector('#sec-shipping .list-head') as HTMLButtonElement).click();
    expect(doc.querySelectorAll('#sec-shipping .dev-tile')).toHaveLength(4);
    expect([...doc.querySelectorAll('#sec-shipping .dev-tile-label')].map((n) => n.textContent)).toEqual(['Needs you', 'Testing', 'Set to merge', 'Stuck']);
    expect(doc.querySelectorAll('#sec-shipping button.row')).toHaveLength(4);
    expect(doc.querySelector('#sec-shipping .tone-line[data-tone="attn"]')!.textContent).toContain('Release watchdog: 1 unresolved episode');
    expect(doc.querySelector('#sec-feedback .list-head')!.getAttribute('aria-expanded')).toBe('false'); // one open at a time
    (doc.querySelector('#sec-shipping button.row') as HTMLButtonElement).click();
    expect(doc.querySelector('.sheet .stage.current')!.textContent).toBe('passed');
    expect([...doc.querySelectorAll('.sheet button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Hold this pull request', 'Test it now']));
    expect(doc.querySelector('.sheet a.btn-inline')).toBeNull(); // no repository name was read, so no fabricated GitHub link
    (doc.querySelector('.sheet-close') as HTMLButtonElement).click();
    (doc.querySelector('#sec-pace .list-head') as HTMLButtonElement).click();
    expect(doc.querySelector('#sec-pace .card[data-state="unknown"] .card-line')!.textContent).toBe('Can’t reach GitHub from this machine: no GitHub sign-in found.');
    expect(doc.querySelectorAll('#sec-pace .fchip[aria-pressed="true"]')).toHaveLength(2);
  });
});


describe('QA content fixes — Development', () => {
  it('one row per PR: a PR known to the watcher AND the verifier keeps one main state by precedence (needs you > stuck > set to merge > testing > held) and the tiles split the total', () => {
    const w = watcher({
      snapshot: { at: minsAgo(3), entries: [] }, armed: [], armedCount: 0,
      stuckRed: [{ pr: 2350, redForMs: 18 * 3600000, failingChecks: ['E2E Tests'] }, { pr: 2364, redForMs: 3 * 3600000, failingChecks: ['Unit Tests'] }],
      episodes: [{ pr: 2370, headRefOid: 'x', attempts: 3, rearmEpisodes: 0, state: 'gave-up', lastOutcome: 'refused:verify-failed', lastAttemptAt: minsAgo(360) }],
    });
    const v = verify({ inFlight: { id: 'f', pr: 2364, kind: 'pr', headSha: 'c'.repeat(40) }, queue: [
      { id: 'q1', pr: 2374, firstQueuedAt: minsAgo(100) }, { id: 'q2', pr: 2350, firstQueuedAt: minsAgo(60) }, { id: 'q3', pr: 2370, firstQueuedAt: minsAgo(50) }, { id: 'q4', pr: 2378, firstQueuedAt: minsAgo(20) },
    ] });
    const s = buildShipping({ watcher: ok(w), verify: ok(v), release: ok(release()) }, NOW, { repo: 'JKHeadley/instar' });
    const prs = s.rows.map((r) => r.pr);
    expect(new Set(prs).size).toBe(prs.length);                       // one row per PR
    expect(s.rows.map((r) => [r.group, r.pr])).toEqual([['stuck', 2350], ['stuck', 2364], ['stuck', 2370], ['testing', 2374], ['testing', 2378]]);
    expect(s.rows[0].also).toEqual([expect.objectContaining({ group: 'testing', sub: '2nd in line · about 45 min each' })]);
    expect(s.rows[1].also[0].sub).toBe('testing now · about 45 min');
    expect(s.tiles.map((t) => [t.key, t.n])).toEqual([['needs', 0], ['testing', 2], ['armed', 0], ['stuck', 3]]);
    const sum = s.tiles.reduce((a, t) => a + (typeof t.n === 'number' ? t.n : 0), 0);
    expect(sum).toBe(s.counts.moving);                                 // the tiles partition "on the way"
    expect(s.headline).toBe('5 pull requests on the way. 3 are stuck.');
    expect(s.line).toBe('Shipping: 5 on the way, 3 stuck');
    expect(s.stuckWhy).toBe('2 have red checks; the merge watcher gave up on 1');
    const h = developmentHeadline({ shipping: s, feedback: { state: 'ok', todos: [], line: 'Feedback: nothing needs you' } });
    expect(h.text).toBe('3 pull requests are stuck.');
    expect(h.sub).toBe('Of 5 pull requests on the way: 2 have red checks; the merge watcher gave up on 1.');
    expect(h.sub).not.toMatch(/are stuck/);                             // the count is said once
  });
  it('a PR in exactly one system is unchanged; a held PR stays out of the count', () => {
    const s = buildShipping({ watcher: ok(watcher()), verify: ok(verify()), release: ok(release()) }, NOW);
    expect(s.rows.every((r) => r.also.length === 0)).toBe(true);
    expect(s.counts).toMatchObject({ needs: 1, stuck: 0, held: 1, moving: 3, testing: 1, armed: 1 });
  });
  it('the release line is "status unknown" until the watchdog has checked; a real check keeps its words', () => {
    expect(releaseLine(ok(release({ lastTickAt: null })), NOW)).toMatchObject({ text: 'Release status unknown: the release watchdog has not checked yet.', tone: 'unknown' });
    expect(releaseLine(ok(release()), NOW).text).toBe('Release watchdog: nothing unresolved · last checked 10 min ago.');
    expect(releaseLine(ok(release({ openEpisodes: 2 })), NOW).text).toBe('Release watchdog: 2 unresolved episodes · last checked 10 min ago.');
  });
});
