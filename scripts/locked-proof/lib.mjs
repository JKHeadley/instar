import { nativeWatch, measureNativeCalls, watchPopulationProblem } from './native-observation.mjs';
/**
 * Locked-Mac proof run (docs/specs/desktop-locked-screen.md, proof rows P12 and P15):
 * the case table, the expected-results record, the runner and the verdict.
 *
 * Pure of any Mac: the runner talks to a `target` object. driver.mjs supplies the
 * real one (a throwaway macOS user on the proof Mac) or a fake one (tests).
 *
 * Who types the password: the AGENT, through the real remote-desktop viewer page,
 * using the throwaway test user's password from its own vault. The person only
 * does what software cannot: the two macOS permission grants in the test account,
 * and a few local actions at the Mac (unlock locally, switch user, log in again).
 */
import crypto from 'node:crypto';

export const TERMINAL = ['relocked', 'relock-failed', 'left-unlocked', 'closed-not-applicable'];
export const BLOCKING = ['owed', 'executing', 'watching'];
export const PROOF_USER = 'instarproof';
export const VAULT_KEY = 'locked_proof_user_password';
export const WATCH_MS = 120_000;
export const GRANT_CEILING_MS = 600_000;
/** How far ahead of the expected Enter a before-enter step starts: about three characters. */
export const BEFORE_ENTER_LEAD_MS = 170;
/** Poll pace while a before-enter case waits for its duty to appear, so the aim starts early. */
export const FAST_POLL_MS = 50;

/**
 * Why a run cannot start these cases with this calibration, or null. Before-enter steps aim from
 * the duty's creation time, and deadline cases aim their typing at the grant's limit; without a
 * calibration both silently test something else (15.4 "passed" typing at once, Mac open 600 s).
 */
export function calibrationProblem(cases, cal) {
  const needsEnter = cases.filter(c => (c.inject ?? []).some(x => x.at === 'before-enter') && c.timing !== 'deadline').map(c => c.id);
  const needsPace = cases.filter(c => c.timing === 'deadline').map(c => c.id);
  if (!needsEnter.length && !needsPace.length) return null;
  if (!cal) return `no calibration.json in the --out folder; run "calibrate" first (needed by ${[...needsEnter, ...needsPace].join(', ')})`;
  if (needsEnter.length && typeof cal.createToEnterMs !== 'number') return `calibration.json predates createToEnterMs; run "calibrate" again (needed by ${needsEnter.join(', ')})`;
  return null;
}

/**
 * `at` names when the injection fires:
 *   marker:<state>  the first time a marker is in that state
 *   after-create    a marker exists (any state)
 *   before-enter    a few characters before Enter: the duty's own createdAt plus the calibrated
 *                   create-to-Enter time, less BEFORE_ENTER_LEAD_MS (aimed, not polled)
 *   after-enter     enterPendingAt written, plus 50 ms
 *   typing          the typist is running, mid-password
 *   sent            the viewer reported the password sent
 *   now             immediately after the grant opened
 * `final` is what the Mac must end as: locked | left-unlocked | unlocked-accepted-risk.
 */
// 12.9 freezes the owning server as well as the typist and the first guard. With that server
// alive its 10 s sweep replaces a frozen guard, the replacement relocks at the deadline, and the
// other agent is rightly refused: the deadline-based recovery by another agent is never reached.
// 12.5a ends the session once the replacement guard has taken the duty over. While a grant is
// live and its server alive, an owed duty stays owed and the Mac stays open for the person using
// it, so without that step the case could only time out with the Mac unlocked.
export const CASES = [
  // ── P12: crash tests ──
  { id: '12.1', gate: 'P12', title: 'Node suspended with descriptors open', password: true, before: ['serve-under-launchd'], inject: [{ action: 'stop-server', at: 'marker:owed' }], cleanup: ['cont-server', 'end-launchd-serve', 'start-server'], final: 'locked', markerEnd: ['relocked'] },
  { id: '12.2a', gate: 'P12', title: 'Node killed right after marker-create', password: true, inject: [{ action: 'kill-server', at: 'after-create' }], then: ['start-server'], final: 'locked', noSubmission: true },
  { id: '12.2b', gate: 'P12', title: 'Node killed after the first lease write', password: true, inject: [{ action: 'kill-server', at: 'lease-written' }], then: ['start-server'], final: 'locked', noSubmission: true },
  { id: '12.2c', gate: 'P12', title: 'Node killed after guard spawn, before its heartbeat', password: true, inject: [{ action: 'kill-server', at: 'guard-spawned' }], then: ['start-server'], final: 'locked', noSubmission: true },
  { id: '12.2d', gate: 'P12', title: 'Node killed after the ack, before the first character', password: true, inject: [{ action: 'kill-server', at: 'guard-acked' }], then: ['start-server'], final: 'locked' },
  { id: '12.2e', gate: 'P12', title: 'Node killed mid-typing', password: true, inject: [{ action: 'kill-server', at: 'typing' }], then: ['start-server'], final: 'locked' },
  { id: '12.3', gate: 'P12', title: 'tmux killed', password: true, inject: [{ action: 'kill-tmux', at: 'marker:owed' }], then: ['start-server'], final: 'locked' },
  { id: '12.4', gate: 'P12', title: 'launchd kill of the server', password: true, before: ['serve-under-launchd'], inject: [{ action: 'launchd-kill', at: 'guard-acked' }], then: ['end-launchd-serve', 'start-server'], final: 'locked' },
  { id: '12.5a', gate: 'P12', title: 'Guard killed in owed', password: true, inject: [{ action: 'kill-guard', at: 'marker:owed' }, { action: 'stop-viewer', at: 'takeover' }], final: 'locked', markerEnd: ['relocked'], guardReplaced: true },
  { id: '12.5b', gate: 'P12', title: 'Guard killed in executing', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'kill-guard', at: 'marker:executing' }], final: 'locked', markerEnd: ['relocked'], guardReplaced: true },
  { id: '12.5c', gate: 'P12', title: 'Guard killed in watching', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'kill-guard', at: 'marker:watching' }], final: 'locked', markerEnd: ['relocked'], guardReplaced: true },
  { id: '12.6', gate: 'P12', title: 'Suspended Node with an unreaped helper and guard', password: true, before: ['serve-under-launchd'], inject: [{ action: 'stop-server', at: 'marker:owed' }, { action: 'kill-helper', at: 'marker:owed' }], cleanup: ['cont-server', 'end-launchd-serve', 'start-server'], final: 'locked' },
  { id: '12.7', gate: 'P12', title: 'Guard killed mid-watch after Stop, Node alive', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'kill-guard', at: 'marker:watching' }], final: 'locked', markerEnd: ['relocked'], watchStartUnchanged: true },
  { id: '12.8', gate: 'P12', title: 'relock-failed at watch end raises the security item within 10 s, no boot', password: true, before: ['serve-under-launchd'], inject: [{ action: 'stop-viewer', at: 'sent' }], watchEndFault: true, person: { text: 'Unlock the test account at the test Mac now, once, and leave it unlocked. Its test guard is paused until the two-minute watch ends; the independent recovery will lock it afterward.', until: 'marker:relock-failed', requireWatching: true, mustUnlock: true, beforeCue: 'freeze-watch-end', afterFirstAction: 'resume-watch-end', timeoutMs: 240_000 }, final: 'unlocked-accepted-risk', markerEnd: ['relock-failed'], securityItemWithinMs: 10_000 },
  { id: '12.9', gate: 'P12', title: 'Typist and guard suspended through deadline admission recovery, typist then resumed', password: true, before: ['serve-under-launchd'], inject: [{ action: 'stop-typist', at: 'typing' }, { action: 'stop-guard', at: 'typing' }, { action: 'stop-server', at: 'typing' }, { action: 'grant-other-agent', at: 'deadline-passed' }, { action: 'cont-typist', at: 'other-grant-tried' }], final: 'locked', markerEnd: ['relock-failed'], producerGone: true, noSubmissionAfterClose: true, timeoutMs: 840_000, cleanup: ['cont-server', 'end-launchd-serve', 'start-server'] },
  { id: '12.10', gate: 'P12', title: 'Guard suspended across a takeover, resumed during the next grant', password: true, inject: [{ action: 'stop-guard', at: 'marker:owed' }, { action: 'open-next-grant', at: 'takeover' }, { action: 'cont-old-guard', at: 'next-grant-open' }], final: 'locked', oldGuardGone: true },
  { id: '12.11', gate: 'P12', title: 'Relock failing with Node down', password: true, inject: [{ action: 'kill-server', at: 'sent' }], person: { text: 'Unlock the test account at the test Mac now, and again each time it locks, four times in two minutes. Leave it unlocked after the fourth.', until: 'marker:relock-failed', requireWatching: true, mustUnlock: true, timeoutMs: 300_000 }, then: ['start-server'], final: 'locked', markerEnd: ['relock-failed'], securityItemAfterBoot: true },
  { id: '12.12', gate: 'P12', title: 'User switch with the guard alive', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }], person: { text: 'At the test Mac, switch to your own account (your own password), wait 30 seconds, then switch back to the test account.', until: 'marker:closed-not-applicable', consoleRoundTrip: true, minAwayMs: 30_000, timeoutMs: 300_000 }, final: 'not-judged', markerEnd: ['closed-not-applicable'], noLockCall: true },
  { id: '12.13', gate: 'P12', title: 'Logout with the guard alive', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'logout-proof-user', at: 'marker:watching' }], person: { text: 'At the test Mac, log in to the test account again.', until: 'proof-user-console', consoleRoundTrip: true, departureAction: 'logout-proof-user', minAwayMs: 0, timeoutMs: 300_000 }, final: 'not-judged', markerEnd: ['closed-not-applicable'], noLockCall: true },
  { id: '12.14a', gate: 'P12', title: 'Leave unlocked racing the guard: Leave first', password: true, inject: [{ action: 'leave-unlocked', at: 'unlocked' }, { action: 'revoke', at: 'unlocked' }], final: 'either', markerEnd: ['left-unlocked', 'relocked'] },
  { id: '12.14b', gate: 'P12', title: 'Leave unlocked racing the guard: Stop first', password: true, inject: [{ action: 'revoke', at: 'unlocked' }, { action: 'leave-unlocked', at: 'unlocked', delayMs: 150 }], final: 'either', markerEnd: ['left-unlocked', 'relocked'] },
  { id: '12.15', gate: 'P12', title: 'Leave unlocked followed by a crash', password: true, inject: [{ action: 'leave-unlocked', at: 'unlocked' }, { action: 'kill-server', at: 'marker:left-unlocked' }], then: ['start-server'], final: 'left-unlocked', markerEnd: ['left-unlocked'], typistGone: true, cleanup: ['lock-now'] },
  { id: '12.16', gate: 'P12', title: 'Next grant refused until the duty ends, across agents', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'grant-other-agent', at: 'marker:watching', expectRefusal: 'relock-pending' }], final: 'locked', markerEnd: ['relocked'] },
  { id: '12.17', gate: 'P12', title: 'A stray letter at the shield leaves the grant alive', password: false, inject: [{ action: 'type-letter', at: 'now' }], final: 'locked', grantAlive: true },
  { id: '12.18', gate: 'P12', title: 'Typing refuses when the real guard cannot publish a fresh acknowledgement', password: true, afterGrant: ['block-guard-heartbeat'], inject: [], guardAckFault: true, final: 'locked', secretRefused: 'guard-not-alive', noSubmission: true },
  // ── P15: Stop tests ──
  { id: '15.1', gate: 'P15', title: 'Stop immediately before Enter', password: true, inject: [{ action: 'revoke', at: 'before-enter' }], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.2', gate: 'P15', title: 'Stop immediately after Enter', password: true, inject: [{ action: 'revoke', at: 'after-enter' }], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.3', gate: 'P15', title: 'Deadline immediately before Enter', password: true, timing: 'deadline', inject: [{ action: 'wait-deadline', at: 'before-enter' }], final: 'locked', noSubmissionAfterClose: true, timeoutMs: 900_000 },
  { id: '15.4', gate: 'P15', title: 'Deadline immediately after Enter', password: true, timing: 'deadline', inject: [{ action: 'wait-deadline', at: 'after-enter' }], final: 'locked', noSubmissionAfterClose: true, timeoutMs: 900_000 },
  { id: '15.5', gate: 'P15', title: 'Transport expiry immediately before Enter', password: true, inject: [{ action: 'drop-transport', at: 'before-enter' }], final: 'locked', relockAfterResumeWindow: true, noSubmissionAfterClose: true },
  { id: '15.6', gate: 'P15', title: 'Transport expiry immediately after Enter', password: true, inject: [{ action: 'drop-transport', at: 'after-enter' }], final: 'locked', relockAfterResumeWindow: true, noSubmissionAfterClose: true },
  { id: '15.7', gate: 'P15', title: 'Node kill immediately before Enter', password: true, inject: [{ action: 'kill-server', at: 'before-enter' }], then: ['start-server'], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.8', gate: 'P15', title: 'Node kill immediately after Enter', password: true, inject: [{ action: 'kill-server', at: 'after-enter' }], then: ['start-server'], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.9', gate: 'P15', title: 'input-stream suspended mid-password', password: true, inject: [{ action: 'stop-typist', at: 'typing' }, { action: 'revoke', at: 'typing', delayMs: 2_000 }], then: ['next-helper-clears-field'], final: 'locked', typistGone: true, fieldClearedBeforeNextEnter: true },
  { id: '15.10', gate: 'P15', title: 'Delayed completion inside the watch', password: true, wrongPassword: true, inject: [{ action: 'revoke', at: 'after-enter' }], person: { text: 'Unlock the test account at the test Mac now, once, and leave it.', cueFromWatchMs: 30_000, until: 'marker:relocked', timeoutMs: 180_000, mustUnlock: true }, final: 'locked', markerEnd: ['relocked'] },
  { id: '15.11', gate: 'P15', title: 'Delayed completion past the watch', password: true, wrongPassword: true, inject: [{ action: 'revoke', at: 'after-enter' }], person: { text: 'Unlock the test account at the test Mac now, once, and leave it.', cueFromWatchMs: 130_000, until: 'unlocked', timeoutMs: 300_000, mustUnlock: true }, final: 'unlocked-accepted-risk', markerEnd: ['relocked'], cleanup: ['lock-now'] },
];

export function selectCases(ids) {
  if (!ids || ids.length === 0) return CASES;
  const wanted = new Set(ids);
  const picked = CASES.filter(c => wanted.has(c.id) || wanted.has(c.gate));
  const unknown = [...wanted].filter(id => !CASES.some(c => c.id === id || c.gate === id));
  if (unknown.length) throw new Error(`unknown case(s): ${unknown.join(', ')}`);
  return picked;
}

/** The record written and committed BEFORE any run (plan step S5). */
export function renderExpected(cases = CASES) {
  const lines = ['| Case | Gate | What happens | Person | Mac must end | Marker must end |', '|---|---|---|---|---|---|'];
  for (const c of cases) {
    const injections = [...(c.afterGrant ?? []).map(action => `${action} after grant, before password`), ...c.inject.map(i => `${i.action} at ${i.at}`)].join('; ');
    lines.push(`| ${c.id} | ${c.gate} | ${c.title}: ${injections} | ${c.person ? c.person.text : 'none'} | ${c.final} | ${(c.markerEnd ?? ['any terminal']).join(' or ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A throwaway password: typeable on any layout (lowercase letters and digits only,
 * no characters that move between keyboard layouts), 20 characters, never logged.
 */
export function generateProofPassword(random = crypto.randomBytes) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = random(40);
  let out = '';
  for (let i = 0; out.length < 20 && i < bytes.length; i++) {
    if (bytes[i] < 248) out += alphabet[bytes[i] % alphabet.length];
  }
  if (out.length < 20) throw new Error('not enough random bytes');
  return out;
}

/** The attempt counter, reset between batches (plan 4.4); refused while a duty is open. */
export function resetAttempts(state, today) {
  const markers = state?.markers ?? {};
  const open = Object.entries(markers).filter(([, m]) => BLOCKING.includes(m?.state));
  if (open.length) throw new Error(`refusing to reset attempts while duty ${open[0][0]} is ${open[0][1].state}`);
  return { ...state, attempts: { day: today, count: 0, perRequest: {} } };
}

/** Refuse to act anywhere but a proof install. */
export function assertProofTarget({ user, version }) {
  if (user !== PROOF_USER) throw new Error(`target user must be "${PROOF_USER}", got "${user}"`);
  if (typeof version !== 'string' || !/-lockedproof\.\d+$/.test(version)) {
    throw new Error(`target agent must run a -lockedproof.N test build, got "${version}"`);
  }
}

function matchAt(at, snap, ctx) {
  if (at === 'now') return true;
  const markers = Object.values(snap.markers ?? {});
  if (at.startsWith('marker:')) return markers.some(m => m.state === at.slice(7));
  if (at === 'after-create') return markers.length > 0;
  if (at === 'unlocked') return snap.lockState === 'unlocked';
  if (at === 'sent') return ctx.sent === true;
  // The input helper runs for the whole grant, so "it is running" is true before any password
  // is sent. Typing means a duty exists for this password and Enter has not been pressed yet.
  if (at === 'typing') return snap.typistRunning === true && markers.some(m => m.state === 'owed' && typeof m.enterPendingAt !== 'number');
  if (at === 'after-enter') return markers.some(m => typeof m.enterPendingAt === 'number' && snap.now - m.enterPendingAt >= 50);
  if (at === 'before-enter') return ctx.beforeEnterDue !== undefined && snap.now >= ctx.beforeEnterDue;
  return snap.events?.includes(at) === true;
}

export const PERSON_START_WINDOW_MS = 30_000;

/** Human-visible expiry only: Telegram may retain and deliver this text later. */
export function personCue(c, runId, now, watchStart) {
  const insideWatch = c.person.requireWatching || (c.person.cueFromWatchMs !== undefined && c.person.cueFromWatchMs < WATCH_MS);
  const validUntil = Math.min(now + PERSON_START_WINDOW_MS, insideWatch ? watchStart + WATCH_MS - 1_000 : Infinity);
  if (!Number.isFinite(validUntil) || validUntil - now < 5_000) throw new Error('no safe start window remains for the person cue');
  const utc = new Date(validUntil).toISOString();
  const local = new Date(validUntil).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'long' });
  return { caseId: c.id, runId, validUntil, validUntilUtc: utc,
    text: `Case ${c.id}, run ${runId}. START BY ${local} (UTC ${utc}). If that time has passed, or this run has stopped, do not act. ${c.person.text}` };
}

/**
 * Run one case against a target. Every observation is kept as evidence; the
 * verdict compares the evidence with the case's expectation and nothing else.
 */
export async function runCase(c, target, { pollMs = 250, log = () => {} } = {}) {
  const evidence = { id: c.id, runId: crypto.randomUUID(), gate: c.gate, startedAt: target.now(), samples: [], fired: [], person: null, notes: [] };
  const sample = async () => {
    const snap = await target.snapshot();
    evidence.samples.push({ t: snap.now, lockState: snap.lockState, serverLockState: snap.serverLockState, markers: snap.markers, guardPopulation: snap.guardPopulation, dirty: snap.dirty, consoleOwner: snap.consoleOwner, guard: snap.guardPid ?? null, typist: snap.typistRunning === true });
    if (c.noLockCall && !evidence.guardCheckpoint) {
      const witness = nativeWatch(snap);
      if (witness && !watchPopulationProblem(evidence.guardBaseline, snap.guardPopulation, witness)) evidence.guardCheckpoint = { t: snap.now, witness };
    }
    return snap;
  };
  const pending = [...c.inject];
  try {
    await target.prepare(c);
    for (const step of c.before ?? []) evidence.fired.push({ action: step, at: 'before', t: target.now(), result: (await target.act(step, { case: c })) ?? null });
    const ctx = { sent: false, beforeEnterDue: undefined };
    const aimsBeforeEnter = c.timing !== 'deadline' && pending.some(s => s.at === 'before-enter');
    if (c.noLockCall) {
      if (!target.beginGuardObservation) throw new Error('native observation baseline unavailable');
      evidence.guardBaseline = await target.beginGuardObservation();
    }
    const grant = await target.openGrant(c);
    evidence.grantOpenedAt = target.now();
    evidence.grantRequestId = grant?.requestId ?? grant?.id ?? null;
    evidence.grantExpiresAt = grant?.expiresAt ?? null; // the server's own end time for the grant, when the page was told it
    for (const action of c.afterGrant ?? []) {
      const result = await target.act(action, { case: c, grant });
      evidence.fired.push({ action, at: 'after-grant', t: target.now(), result: result ?? null });
    }
    if (c.password) {
      // Deadline cases aim their typing at the grant's limit instead (driver typePassword); the step
      // then fires as soon as the case starts waiting, as before.
      if (c.timing === 'deadline') ctx.beforeEnterDue = target.now();
      evidence.secretStartedAt = target.now();
      const secret = target.typePassword(c).then(
        r => { ctx.sent = r?.sent === true; evidence.secretResult = r ?? null; },
        err => { evidence.secretResult = { error: err instanceof Error ? err.message : String(err) }; });
      // This fault must be observed and removed before normal snapshots can delay cleanup.
      // Await the whole attempt: no orphan secret promise outlives fixture recovery.
      if (c.guardAckFault) {
        await secret;
        if (evidence.secretResult?.error) throw new Error(evidence.secretResult.error);
      }
    }
    let deadline = target.now() + (c.timeoutMs ?? WATCH_MS + GRANT_CEILING_MS / 4);
    let personCued = false;
    while (target.now() < deadline) {
      let snap = await sample();
      if (aimsBeforeEnter && ctx.beforeEnterDue === undefined) {
        // Aim from the duty itself: Enter follows its creation by a calibrated, steady time. Aiming
        // from the grant opening (the old way) landed 15 to 890 ms AFTER Enter (fb-fcb17087-521).
        const pace = target.calibration();
        const duty = Object.values(snap.markers ?? {}).find(m => m.state === 'owed' && typeof m.createdAt === 'number' && m.createdAt >= evidence.grantOpenedAt - 1_000);
        if (duty && typeof pace?.createToEnterMs === 'number') ctx.beforeEnterDue = duty.createdAt + pace.createToEnterMs - BEFORE_ENTER_LEAD_MS;
      }
      // Wait for the aim point itself rather than the next poll, which could be 250 ms late.
      if (aimsBeforeEnter && ctx.beforeEnterDue !== undefined && pending.some(s => s.at === 'before-enter')
          && snap.now < ctx.beforeEnterDue && ctx.beforeEnterDue - snap.now <= pollMs) {
        await target.sleep(ctx.beforeEnterDue - snap.now);
        snap = { ...snap, now: target.now() };
      }
      for (const step of [...pending]) {
        if (!matchAt(step.at, snap, ctx)) continue;
        if (c.noLockCall && step.action === c.person?.departureAction) {
          const watch = nativeWatch(snap);
          if (!evidence.guardCheckpoint || !watch || watch.attemptId !== evidence.guardCheckpoint.witness.attemptId
              || watchPopulationProblem(evidence.guardBaseline, snap.guardPopulation, watch)) continue;
        }
        if (step.delayMs) await target.sleep(step.delayMs);
        pending.splice(pending.indexOf(step), 1);
        const startedAt = target.now();
        const result = await target.act(step.action, { case: c, step, grant, snap });
        evidence.fired.push({ action: step.action, at: step.at, startedAt, t: target.now(), result: result ?? null });
        log(`[${c.id}] ${step.action} (${step.at})`);
      }
      if (c.person && !personCued && pending.length === 0 && (!c.noLockCall || evidence.guardCheckpoint)) {
        // The injection can log out or revoke the grant: never reuse its earlier snapshot.
        snap = await sample();
        if (c.noLockCall) {
          const problem = watchPopulationProblem(evidence.guardBaseline, snap.guardPopulation, evidence.guardCheckpoint.witness);
          if (problem) throw new Error(`native observation before cue: ${problem}`);
          if (!c.person.departureAction && !nativeWatch(snap)) { await target.sleep(pollMs); continue; }
        }
        let watchStart;
        if (c.person.requireWatching) {
          const watching = Object.values(snap.markers ?? {}).filter(m => m.state === 'watching' && Number.isFinite(m.watchStart));
          if (watching.length !== 1 || !['locked', 'locked-in-session'].includes(snap.lockState)) { await target.sleep(pollMs); continue; }
          watchStart = watching[0].watchStart;
        }
        if (c.person.cueFromWatchMs !== undefined) {
          const starts = [...new Set(Object.values(snap.markers ?? {}).map(m => m.watchStart).filter(Number.isFinite))];
          if (starts.length !== 1) { await target.sleep(pollMs); continue; }
          watchStart = starts[0];
          const due = watchStart + c.person.cueFromWatchMs;
          if (target.now() < due) { await target.sleep(Math.min(pollMs, due - target.now())); continue; }
          if (c.person.cueFromWatchMs < WATCH_MS && target.now() >= watchStart + WATCH_MS) {
            throw new Error('the inside-watch cue missed the watch window');
          }
        }
        if (c.person.mustUnlock && !['locked', 'locked-in-session'].includes(snap.lockState)) {
          throw new Error('Mac was not confirmed locked immediately before the unlock cue');
        }
        const departure = c.person.departureAction
          ? evidence.fired.find(f => f.action === c.person.departureAction)?.result : null;
        if (c.person.departureAction && (departure?.departed !== true || departure?.producersGone !== true
            || !Number.isFinite(departure.departedAt))) throw new Error('logout departure and old producer exit were not confirmed');
        if (departure && (typeof snap.consoleOwner !== 'string' || !snap.consoleOwner || snap.consoleOwner === PROOF_USER)) {
          throw new Error('proof account departure was not still observed before the login cue');
        }
        if (c.person.consoleRoundTrip && !departure && snap.consoleOwner !== PROOF_USER) {
          throw new Error('proof account was not on console before the switch cue');
        }
        if (c.person.beforeCue) {
          const result = await target.act(c.person.beforeCue, { case: c, snap });
          if (c.watchEndFault && (result?.armed !== true || result?.frozen !== true)) throw new Error('watch-end setup was not confirmed before cue');
          evidence.fired.push({ action: c.person.beforeCue, at: 'before-person', t: target.now(), result });
          snap = await sample();
          if (!['locked', 'locked-in-session'].includes(snap.lockState)) throw new Error('proof Mac no longer locked after person-step setup');
        }
        const cue = personCue(c, evidence.runId, target.now(), watchStart);
        personCued = true;
        evidence.person = { ...cue, cuedAt: target.now(),
          ...(c.person.requireWatching ? { watchReadyAt: snap.now } : {}),
          ...(watchStart !== undefined ? { watchStart, cueDueAt: watchStart + (c.person.cueFromWatchMs ?? 0) } : {}),
          ...(departure ? { awayAt: departure.departedAt, awayObservedAt: departure.departedAt, departureConfirmed: true } : {}) };
        const delivery = await target.askPerson(cue.text, cue);
        evidence.person.delivery = delivery;
        if (!(delivery?.channel === 'console' && delivery.outcome === 'console-only' && delivery.sent === false)
            && !(delivery?.channel === 'telegram' && delivery.outcome === 'confirmed' && delivery.sent === true)) {
          throw new Error('person cue has no confirmed delivery or explicit console-only outcome');
        }
        if (target.now() >= cue.validUntil) throw new Error('person cue completed after its start-by deadline');
        evidence.person.cueCompletedAt = target.now();
        deadline = Math.max(deadline, target.now() + (c.person.timeoutMs ?? 0));
        snap = await sample();
      }
      if (personCued && snap.now >= evidence.person.cueCompletedAt) {
        const person = evidence.person;
        if (c.person.consoleRoundTrip && !person.returnedAt) {
          const owner = snap.consoleOwner;
          // Unknown readings break dwell evidence; they are never evidence of departure.
          const away = typeof owner === 'string' && owner.length > 0 && owner !== PROOF_USER
            && (c.person.departureAction || !['root', 'loginwindow'].includes(owner));
          if (away) {
            person.awayAt ??= snap.now; person.awayObservedAt = snap.now;
            if (!c.person.departureAction) person.actionAt ??= snap.now;
            if (snap.now - person.awayAt >= (c.person.minAwayMs ?? 0)) person.dwellCompletedAt ??= snap.now;
          }
          else if (owner === PROOF_USER && person.awayAt !== undefined) {
            if ((c.person.minAwayMs ?? 0) > 0 && person.dwellCompletedAt === undefined) throw new Error('returned before the required time away');
            person.returnedAt = snap.now;
            if (c.person.departureAction) person.actionAt ??= snap.now;
          } else if (!c.person.departureAction && person.dwellCompletedAt === undefined) { delete person.awayAt; delete person.awayObservedAt; delete person.actionAt; }
        }
        if (c.person.mustUnlock && snap.lockState === 'unlocked') {
          person.sawUnlock = true;
          person.unlockAt ??= snap.now;
          person.actionAt ??= snap.now;
        }
        if ((Number.isFinite(person.actionAt) && person.actionAt >= person.validUntil)
            || (!Number.isFinite(person.actionAt) && snap.now >= person.validUntil)) {
          throw new Error('required human action was not observed before the start-by deadline');
        }
        if (Number.isFinite(person.actionAt) && c.person.afterFirstAction && !person.afterActionDone) {
          const result = await target.act(c.person.afterFirstAction, { case: c, snap });
          evidence.fired.push({ action: c.person.afterFirstAction, at: 'after-person-action', t: target.now(), result });
          person.afterActionDone = true;
          snap = await sample();
        }
        const humanDone = !c.person.consoleRoundTrip || person.returnedAt !== undefined;
        if (!person.doneAt && humanDone && (!c.person.until || matchAt(c.person.until, snap, ctx))) person.doneAt = snap.now;
      }
      const settled = pending.length === 0 && (!c.person || (evidence.person?.doneAt && (!c.person.mustUnlock || evidence.person.sawUnlock))) && target.settled(snap, c);
      if (settled) break;
      await target.sleep(aimsBeforeEnter && ctx.beforeEnterDue === undefined ? Math.min(pollMs, FAST_POLL_MS) : pollMs);
    }
    // Kept as evidence like any other step: what a follow-on step found is part of the result.
    for (const step of c.then ?? []) evidence.fired.push({ action: step, at: 'then', t: target.now(), result: (await target.act(step, { case: c })) ?? null });
    const final = await sample();
    evidence.final = { lockState: final.lockState, markers: final.markers, processesGone: final.processesGone !== false };
    evidence.extra = { ...measured(evidence), ...(await target.extraEvidence(c, evidence)) };
    for (const step of c.cleanup ?? []) await target.act(step, { case: c });
  } catch (err) {
    evidence.error = err instanceof Error ? err.message : String(err);
  } finally {
    // Whatever happened: resume every process this case stopped, then lock the proof session.
    const problems = (await target.recover?.(c).catch(e => [String(e)])) ?? ['target has no recover()'];
    if (problems.length) evidence.recoveryProblems = problems;
    if (c.watchEndFault) evidence.watchEndRecovery = target.watchEndRecoveryEvidence?.() ?? null;
  }
  evidence.endedAt = target.now();
  evidence.unfired = pending.map(s => `${s.action} at ${s.at}`);
  evidence.verdict = judge(c, evidence);
  return evidence;
}

export const RESUME_WINDOW_MS = 30_000;

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The launchd job for the launchd-kill case: the real server in the foreground, directly
 * under launchd. No KeepAlive, so a kill leaves it dead until the case starts it again.
 */
export function launchdServePlist({ label, node, cli, dir, pathEnv, log }) {
  const args = [node, cli, 'server', 'start', '--foreground', '--dir', dir].map(a => `<string>${xml(a)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(dir)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

/** A missing Enter marker is unknown, including an aborted UI result: native writes can fail. */
export function beforeEnterTiming(ev, expectedAction) {
  const unknown = reason => ({ measured: false, reason });
  const steps = (ev.fired ?? []).filter(f => f.at === 'before-enter');
  if (steps.length !== 1 || (expectedAction !== undefined && steps[0].action !== expectedAction)) return unknown('missing or ambiguous injection');
  if (typeof ev.grantRequestId !== 'string' || !ev.grantRequestId || !Number.isFinite(ev.grantOpenedAt)) return unknown('missing grant identity');
  const duties = new Map();
  for (const sample of [...(ev.samples ?? []), ...(ev.final ? [ev.final] : [])]) {
    for (const [key, marker] of Object.entries(sample.markers ?? {})) {
      if (marker.requestId === ev.grantRequestId) {
        if (!duties.has(key)) duties.set(key, []);
        duties.get(key).push(marker);
      }
    }
  }
  if (duties.size !== 1) return unknown('missing or ambiguous same-grant duty');
  const [key, observations] = [...duties.entries()][0];
  // A reused key or inconsistent creation time cannot bind Enter to this password.
  const all = [...(ev.samples ?? []), ...(ev.final ? [ev.final] : [])].flatMap(s => s.markers?.[key] ? [s.markers[key]] : []);
  if (all.some(m => m.requestId !== ev.grantRequestId)) return unknown('duty identity changed');
  const createdAt = observations[0].createdAt;
  if (!Number.isFinite(createdAt) || createdAt < ev.grantOpenedAt - 1_000
      || observations.some(m => m.createdAt !== createdAt)) return unknown('missing or inconsistent duty creation');
  const enters = observations.filter(m => Object.hasOwn(m, 'enterPendingAt')).map(m => m.enterPendingAt);
  if (!enters.length || enters.some(t => !Number.isFinite(t) || t < createdAt || t !== enters[0])) return unknown('missing or inconsistent same-duty Enter');
  // Historical timing cannot complete a proof whose final retained duty is missing.
  const retained = ev.final?.markers?.[key];
  if (!retained || retained.requestId !== ev.grantRequestId || retained.createdAt !== createdAt
      || retained.enterPendingAt !== enters[0] || !TERMINAL.includes(retained.state)) return unknown('same-duty terminal Enter record not retained at the end');
  const deadline = steps[0].action === 'wait-deadline';
  // Completion is a conservative upper bound: starting a revoke before Enter does not
  // establish that its awaited response (or the transport-offline action) preceded Enter.
  const eventAt = deadline ? ev.grantExpiresAt : steps[0].t;
  if (!deadline && (!Number.isFinite(steps[0].startedAt) || steps[0].startedAt < createdAt
      || !Number.isFinite(eventAt) || steps[0].startedAt > eventAt)) return unknown('missing or invalid interruption interval');
  const gap = eventAt - enters[0];
  if (!Number.isFinite(eventAt) || eventAt < createdAt || !Number.isFinite(gap)) return unknown('missing or invalid interruption time');
  return { measured: true, deadline, enterAt: enters[0], gap, dutyKey: key };
}

/** Measurements every target gets from its own samples (the target may add more). */
export function measured(ev) {
  const out = {};
  const drop = ev.fired.find(f => f.action === 'drop-transport');
  if (drop) {
    const closed = ev.samples.find(s => s.t >= drop.t && Object.values(s.markers ?? {}).length > 0
      && Object.values(s.markers).every(m => TERMINAL.includes(m.state)));
    if (closed) out.relockAfterDropMs = closed.t - drop.t;
  }
  // Diagnostic only; judge recomputes this from raw evidence, never extraEvidence.
  const timing = beforeEnterTiming(ev);
  if (timing.measured) {
    out.enterAt = timing.enterAt;
    out[timing.deadline ? 'limitMinusEnterMs' : 'injectMinusEnterMs'] = timing.gap;
  }
  const last = ev.samples[ev.samples.length - 1];
  if (last && typeof last.dirty === 'boolean') out.fieldDirtyAtEnd = last.dirty;
  return out;
}

const x0 = ev => ev.extra ?? {};

/** Expected versus actual. Returns { pass, reasons[] }; a reason is a failed expectation. */
export function judge(c, ev) {
  const reasons = [];
  if (ev.error) reasons.push(`case stopped with an error: ${ev.error}`);
  if (ev.recoveryProblems?.length) reasons.push(`recovery problems: ${ev.recoveryProblems.join('; ')}`);
  if (ev.unfired?.length) reasons.push(`injection never fired: ${ev.unfired.join(', ')}`);
  const markers = Object.values(ev.final?.markers ?? {});
  const terminal = markers.filter(m => TERMINAL.includes(m.state));
  if (markers.some(m => BLOCKING.includes(m.state))) reasons.push('a duty is still open at the end');
  if (c.markerEnd && !terminal.some(m => c.markerEnd.includes(m.state))) {
    reasons.push(`marker ended ${markers.map(m => m.state).join(',') || 'absent'}, expected ${c.markerEnd.join(' or ')}`);
  }
  const lock = ev.final?.lockState;
  const hadDuty = markers.length > 0 || (ev.samples ?? []).some(x => Object.keys(x.markers ?? {}).length > 0);
  if (c.password && !c.secretRefused && !hadDuty) reasons.push('no duty was ever opened: the password never reached the Mac');
  // A case that lands on typing or Enter tested nothing if the helper refused before typing.
  const landsOnTyping = (c.inject ?? []).some(x => ['before-enter', 'after-enter', 'typing', 'sent'].includes(x.at));
  const typed = (ev.samples ?? []).some(x => x.dirty === true || Object.values(x.markers ?? {}).some(m => typeof m.enterPendingAt === 'number'));
  const refusedWord = ev.secretResult?.refused;
  const typingRefused = !!refusedWord && !['aborted', 'no-result-within-60s'].includes(refusedWord);
  if (landsOnTyping && !c.secretRefused && (!typed || typingRefused)) reasons.push(`the password was never typed${refusedWord ? ` (${refusedWord})` : ''}`);
  const beforeSteps = (c.inject ?? []).filter(step => step.at === 'before-enter');
  if (beforeSteps.length) {
    const timing = beforeEnterTiming(ev, beforeSteps[0].action);
    if (beforeSteps.length !== 1 || !timing.measured) reasons.push(`before-enter timing unmeasured: ${timing.reason ?? 'ambiguous case injection'}`);
    else if (timing.gap >= 0) reasons.push(timing.deadline
      ? `grant limit arrived ${timing.gap} ms after Enter`
      : `before-enter step completed ${timing.gap} ms after Enter`);
  }
  if (c.person && !ev.person?.doneAt) reasons.push(`person step never completed: ${c.person.until ?? 'no result seen'}`);
  if (c.person) {
    const p = ev.person, d = p?.delivery;
    if (!Number.isFinite(p?.validUntil) || !Number.isFinite(p?.cueCompletedAt) || p.cueCompletedAt >= p.validUntil
        || !((d?.channel === 'console' && d.outcome === 'console-only' && d.sent === false)
          || (d?.channel === 'telegram' && d.outcome === 'confirmed' && d.sent === true))) {
      reasons.push('person cue was not confirmed before its start-by deadline');
    }
    const actionAt = c.person.consoleRoundTrip ? (c.person.departureAction ? p?.returnedAt : p?.awayAt) : p?.unlockAt;
    if (!Number.isFinite(actionAt) || actionAt < p?.cueCompletedAt || actionAt >= p?.validUntil) {
      reasons.push('required human action was not observed before the start-by deadline');
    }
    if (c.person.requireWatching && (!Number.isFinite(p?.watchReadyAt) || !Number.isFinite(p?.watchStart)
        || !(ev.samples ?? []).some(sample => sample.t === p.watchReadyAt && ['locked', 'locked-in-session'].includes(sample.lockState)
          && Object.values(sample.markers ?? {}).some(m => m.state === 'watching' && m.watchStart === p.watchStart)))) {
      reasons.push('locked watch was not observed before the repeated-unlock cue');
    }
  }
  if (c.person?.mustUnlock && !ev.person?.sawUnlock) reasons.push('no unlock was seen after the person was asked');
  if (c.person?.consoleRoundTrip) {
    const p = ev.person;
    if (!Number.isFinite(p?.awayAt) || !Number.isFinite(p?.returnedAt) || !Number.isFinite(p?.cueCompletedAt)
        || p.returnedAt < p.cueCompletedAt || p.returnedAt - p.awayAt < c.person.minAwayMs
        || (c.person.minAwayMs > 0 && (!Number.isFinite(p.dwellCompletedAt) || p.dwellCompletedAt - p.awayAt < c.person.minAwayMs))
        || (c.person.departureAction && p.departureConfirmed !== true)) reasons.push('required console departure, dwell and return were not observed');
  }
  if (c.person?.cueFromWatchMs !== undefined) {
    const p = ev.person;
    if (!Number.isFinite(p?.watchStart) || !Number.isFinite(p?.unlockAt) || !Number.isFinite(p?.cuedAt)
        || !Number.isFinite(p?.cueCompletedAt) || p.cuedAt < p.watchStart + c.person.cueFromWatchMs
        || p.unlockAt < p.cueCompletedAt
        || (c.person.cueFromWatchMs < WATCH_MS ? p.unlockAt >= p.watchStart + WATCH_MS : p.unlockAt <= p.watchStart + WATCH_MS)) {
      reasons.push('unlock was not observed after its cue on the required side of the watch');
    }
  }
  if (c.final === 'unlocked-accepted-risk' && lock !== 'unlocked') reasons.push(`Mac ended ${lock}, expected unlocked with the risk recorded`);
  if (c.final === 'locked' && lock !== 'locked-in-session' && lock !== 'locked') reasons.push(`Mac ended ${lock}, expected locked`);
  if (c.final === 'left-unlocked' && !terminal.some(m => m.state === 'left-unlocked')) reasons.push('Leave unlocked was not the recorded outcome');
  if (c.final === 'either') {
    const ok = terminal.some(m => m.state === 'left-unlocked') || lock === 'locked-in-session' || lock === 'locked';
    if (!ok) reasons.push(`neither left-unlocked nor locked (ended ${lock})`);
  }
  if (ev.final?.processesGone === false) reasons.push('guard or typist still running after the duty closed');
  const x = ev.extra ?? {};
  if (c.noSubmission && x.submissions > 0) reasons.push(`${x.submissions} password submission(s) where none was allowed`);
  if ((c.noSubmissionAfterClose || c.noSubmission) && x.submissionsAfterClose > 0) reasons.push(`${x.submissionsAfterClose} submission(s) after the duty closed`);
  if (c.guardReplaced && !x.guardReplaced) reasons.push('the killed guard was not replaced');
  if (c.watchStartUnchanged && x.watchStartChanged) reasons.push('the replacement guard restarted the watch');
  if (c.watchEndFault) {
    const f = x.watchEnd, r = ev.watchEndRecovery;
    const completeIdentity = i => i && Number.isInteger(i.pid) && i.pid > 1
      && Number.isInteger(i.uid) && i.uid >= 0
      && typeof i.start === 'string' && i.start.trim().length > 0
      && typeof i.command === 'string' && i.command.trim().length > 0;
    const fields = ['watchStart', 'readyAt', 'frozenAt', 'guardResumedAt', 'failureAt', 'nodeResumedAt', 'attentionAt'];
    if (!f || fields.some(key => !Number.isFinite(f[key])) || f.readyAt > f.frozenAt || f.frozenAt < f.watchStart || f.guardResumedAt > f.failureAt
        || f.guardResumedAt < f.watchStart + WATCH_MS || f.failureAt < f.watchStart + WATCH_MS
        || f.nodeResumedAt < f.failureAt || f.attentionAt < f.failureAt || f.attentionAt - f.failureAt > 10_000
        || f.sameNode !== true || !completeIdentity(f.receipt?.server)
        || !completeIdentity(f.receipt?.guard) || !completeIdentity(f.resumedServer)
        || ['pid', 'uid', 'start', 'command'].some(k => f.receipt.server[k] !== f.resumedServer[k])
        || !f.agentId || ev.final?.markers?.[f.key]?.agentId !== f.agentId
        || ev.final?.markers?.[f.key]?.guardPid !== f.receipt?.guard?.pid
        || ev.final?.markers?.[f.key]?.guardStart !== f.receipt?.guard?.start
        || f.attentionId !== `agent:desktop-relock-failed:${f.key}`
        || !(ev.final?.markers?.[f.key]?.state === 'relock-failed'
          && ev.final.markers[f.key].watchStart === f.watchStart && ev.final.markers[f.key].guardAt === f.failureAt)) {
      reasons.push('native watch-end failure and same-Node timely security report were not confirmed');
    }
    if (r?.state !== 'recovered' || r.results?.lock?.locked !== true || r.recoveryProblems?.length
        || typeof f?.receipt?.nonce !== 'string' || !f.receipt.nonce.trim()
        || r.nonce !== f.receipt.nonce || typeof f?.key !== 'string' || !f.key.trim()
        || f.receipt.key !== f.key || r.key !== f.key) {
      reasons.push('independent watch-end recovery was not confirmed');
    }
  }
  if (c.securityItemWithinMs !== undefined && !(x.securityItemMs <= c.securityItemWithinMs)) reasons.push(`security item ${x.securityItemMs === undefined ? 'never raised' : `raised after ${x.securityItemMs} ms`}`);
  if (c.securityItemAfterBoot && !x.securityItemRaised) reasons.push('security item not raised after the server came back');
  if (c.producerGone && !x.producerGone) reasons.push('marker not recorded with producerGone');
  if (c.oldGuardGone && !x.oldGuardGone) reasons.push('the suspended guard was not killed before takeover');
  if ((c.inject ?? []).some(s => s.action === 'open-next-grant')
      && !(ev.fired ?? []).some(f => f.action === 'open-next-grant' && f.result?.opened === true)) {
    reasons.push('the next grant was not confirmed open');
  }
  if (c.typistGone && !x.typistGone) reasons.push('typist not confirmed gone');
  if (c.grantAlive && !x.grantAlive) reasons.push('the grant ended after a stray letter');
  if (c.secretRefused && ev.secretResult?.refused !== c.secretRefused) reasons.push(`expected refusal ${c.secretRefused}, got ${JSON.stringify(ev.secretResult ?? null)}`);
  if (c.guardAckFault) {
    const armed = (ev.fired ?? []).find(f => f.action === 'block-guard-heartbeat');
    const fault = ev.secretResult?.guardAckFault;
    const observed = fault?.observed;
    const restored = fault?.restored;
    if (armed?.result?.armed !== true || armed.result.frozen !== true
        || !Number.isFinite(armed.result.ageMs) || !(armed.result.ageMs > 5_000)
        || armed.result.mtimeNs !== '1000000000' || armed.result.marker !== null
        || !Number.isFinite(ev.secretStartedAt)
        || !(ev.secretStartedAt >= armed.t)) reasons.push('heartbeat fault was not armed before the password attempt');
    if (!observed || observed.key !== armed?.result?.key || observed.frozen !== true
        || !Number.isFinite(observed.ageMs) || !(observed.ageMs > 5_000) || observed.mtimeNs !== armed?.result?.mtimeNs
        || observed.guardAlive !== true || !Number.isSafeInteger(observed.marker?.guardPid)
        || !(observed.marker.guardPid > 0) || typeof observed.marker.guardStart !== 'string' || !observed.marker.guardStart
        || `${observed.marker.requestId}.0` !== observed.key) reasons.push('missing real guard and unchanged stale acknowledgement evidence');
    if (observed?.dirty !== false || observed?.marker?.enterPendingAt != null
        || x.submissions !== 0 || x.submissionsAfterClose !== 0) reasons.push('password non-submission was not confirmed');
    if (restored?.released !== true || restored.key !== armed?.result?.key
        || restored.boundary !== 'revoked' || fault?.grantEnded !== true) reasons.push('heartbeat fault cleanup and grant termination were not confirmed');
  }
  // An expectation with no measurement fails loudly: an unmeasured check is never a pass.
  if (c.noLockCall) {
    const measured = measureNativeCalls(ev, x.guardFinalPopulation);
    if (!measured.complete) reasons.push(`not measured: lock calls against another session (${measured.reason})`);
    else if (measured.lockCalls > 0) reasons.push(`${measured.lockCalls} lock call(s) during the watched interval`);
  }
  if (c.relockAfterResumeWindow) {
    // The driver timestamps the disconnect. The server owns expiry after the resume window.
    reasons.push('not measured: actual transport expiry relative to Enter');
    if (typeof x.relockAfterDropMs !== 'number') reasons.push('not measured: relock time after the transport drop');
    else if (x.relockAfterDropMs < RESUME_WINDOW_MS - 1_000) reasons.push(`duty closed ${x.relockAfterDropMs} ms after the drop, inside the ${RESUME_WINDOW_MS} ms resume window`);
  }
  if (c.fieldClearedBeforeNextEnter) {
    if (typeof x.fieldDirtyAtEnd !== 'boolean') reasons.push('not measured: password field state at the end');
    else if (x.fieldDirtyAtEnd) reasons.push('password field left dirty at the end');
  }
  for (const f of ev.fired ?? []) {
    const want = c.inject.find(s => s.action === f.action && s.expectRefusal)?.expectRefusal;
    if (want && f.result?.refused !== want) reasons.push(`${f.action}: expected refusal ${want}, got ${f.result?.refused ?? 'none'}`);
  }
  return { pass: reasons.length === 0, reasons: [...new Set(reasons)] };
}
