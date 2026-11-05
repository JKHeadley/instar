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

/**
 * `at` names when the injection fires:
 *   marker:<state>  the first time a marker is in that state
 *   after-create    a marker exists (any state)
 *   before-enter    all but the last characters posted (from the calibrated pace)
 *   after-enter     enterPendingAt written, plus 50 ms
 *   typing          the typist is running, mid-password
 *   sent            the viewer reported the password sent
 *   now             immediately after the grant opened
 * `final` is what the Mac must end as: locked | left-unlocked | unlocked-accepted-risk.
 */
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
  { id: '12.5a', gate: 'P12', title: 'Guard killed in owed', password: true, inject: [{ action: 'kill-guard', at: 'marker:owed' }], final: 'locked', markerEnd: ['relocked'], guardReplaced: true },
  { id: '12.5b', gate: 'P12', title: 'Guard killed in executing', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'kill-guard', at: 'marker:executing' }], final: 'locked', markerEnd: ['relocked'], guardReplaced: true },
  { id: '12.5c', gate: 'P12', title: 'Guard killed in watching', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'kill-guard', at: 'marker:watching' }], final: 'locked', markerEnd: ['relocked'], guardReplaced: true },
  { id: '12.6', gate: 'P12', title: 'Suspended Node with an unreaped helper and guard', password: true, before: ['serve-under-launchd'], inject: [{ action: 'stop-server', at: 'marker:owed' }, { action: 'kill-helper', at: 'marker:owed' }], cleanup: ['cont-server', 'end-launchd-serve', 'start-server'], final: 'locked' },
  { id: '12.7', gate: 'P12', title: 'Guard killed mid-watch after Stop, Node alive', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'kill-guard', at: 'marker:watching' }], final: 'locked', markerEnd: ['relocked'], watchStartUnchanged: true },
  { id: '12.8', gate: 'P12', title: 'relock-failed at watch end raises the security item within 10 s, no boot', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }], person: { text: 'Unlock the test account at the test Mac now, and again each time it locks, four times in two minutes. Leave it unlocked after the fourth.', until: 'marker:relock-failed', timeoutMs: 240_000 }, final: 'unlocked-accepted-risk', markerEnd: ['relock-failed'], securityItemWithinMs: 10_000, cleanup: ['lock-now'] },
  { id: '12.9', gate: 'P12', title: 'Typist and guard suspended through deadline admission recovery, typist then resumed', password: true, inject: [{ action: 'stop-typist', at: 'typing' }, { action: 'stop-guard', at: 'typing' }, { action: 'grant-other-agent', at: 'deadline-passed' }, { action: 'cont-typist', at: 'other-grant-tried' }], final: 'locked', markerEnd: ['relock-failed'], producerGone: true, noSubmissionAfterClose: true },
  { id: '12.10', gate: 'P12', title: 'Guard suspended across a takeover, resumed during the next grant', password: true, inject: [{ action: 'stop-guard', at: 'marker:owed' }, { action: 'open-next-grant', at: 'takeover' }, { action: 'cont-old-guard', at: 'next-grant-open' }], final: 'locked', oldGuardGone: true },
  { id: '12.11', gate: 'P12', title: 'Relock failing with Node down', password: true, inject: [{ action: 'kill-server', at: 'sent' }], person: { text: 'Unlock the test account at the test Mac now, and again each time it locks, four times in two minutes. Leave it unlocked after the fourth.', until: 'marker:relock-failed', timeoutMs: 300_000 }, then: ['start-server'], final: 'locked', markerEnd: ['relock-failed'], securityItemAfterBoot: true },
  { id: '12.12', gate: 'P12', title: 'User switch with the guard alive', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }], person: { text: 'At the test Mac, switch to your own account (your own password), wait 30 seconds, then switch back to the test account.', until: 'marker:closed-not-applicable', timeoutMs: 300_000 }, final: 'not-judged', markerEnd: ['closed-not-applicable'], noLockCall: true },
  { id: '12.13', gate: 'P12', title: 'Logout with the guard alive', password: true, inject: [{ action: 'logout-proof-user', at: 'marker:watching' }], person: { text: 'At the test Mac, log in to the test account again.', until: 'proof-user-console', timeoutMs: 300_000 }, final: 'not-judged', markerEnd: ['closed-not-applicable'], noLockCall: true },
  { id: '12.14a', gate: 'P12', title: 'Leave unlocked racing the guard: Leave first', password: true, inject: [{ action: 'leave-unlocked', at: 'unlocked' }, { action: 'revoke', at: 'unlocked' }], final: 'either', markerEnd: ['left-unlocked', 'relocked'] },
  { id: '12.14b', gate: 'P12', title: 'Leave unlocked racing the guard: Stop first', password: true, inject: [{ action: 'revoke', at: 'unlocked' }, { action: 'leave-unlocked', at: 'unlocked', delayMs: 150 }], final: 'either', markerEnd: ['left-unlocked', 'relocked'] },
  { id: '12.15', gate: 'P12', title: 'Leave unlocked followed by a crash', password: true, inject: [{ action: 'leave-unlocked', at: 'unlocked' }, { action: 'kill-server', at: 'marker:left-unlocked' }], then: ['start-server'], final: 'left-unlocked', markerEnd: ['left-unlocked'], typistGone: true, cleanup: ['lock-now'] },
  { id: '12.16', gate: 'P12', title: 'Next grant refused until the duty ends, across agents', password: true, inject: [{ action: 'stop-viewer', at: 'sent' }, { action: 'grant-other-agent', at: 'marker:watching', expectRefusal: 'relock-pending' }], final: 'locked', markerEnd: ['relocked'] },
  { id: '12.17', gate: 'P12', title: 'A stray letter at the shield leaves the grant alive', password: false, inject: [{ action: 'type-letter', at: 'now' }], final: 'locked', grantAlive: true },
  { id: '12.18', gate: 'P12', title: 'Typing refuses without the guard acknowledgement', password: true, inject: [{ action: 'stop-new-guards', at: 'now' }], cleanup: ['cont-guards'], final: 'locked', secretRefused: 'guard-not-alive', noSubmission: true },
  // ── P15: Stop tests ──
  { id: '15.1', gate: 'P15', title: 'Stop immediately before Enter', password: true, inject: [{ action: 'revoke', at: 'before-enter' }], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.2', gate: 'P15', title: 'Stop immediately after Enter', password: true, inject: [{ action: 'revoke', at: 'after-enter' }], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.3', gate: 'P15', title: 'Deadline immediately before Enter', password: true, timing: 'deadline', inject: [{ action: 'wait-deadline', at: 'before-enter' }], final: 'locked', noSubmissionAfterClose: true, timeoutMs: 900_000 },
  { id: '15.4', gate: 'P15', title: 'Deadline immediately after Enter', password: true, timing: 'deadline', inject: [{ action: 'wait-deadline', at: 'after-enter' }], final: 'locked', noSubmissionAfterClose: true, timeoutMs: 900_000 },
  { id: '15.5', gate: 'P15', title: 'Transport expiry immediately before Enter', password: true, inject: [{ action: 'drop-transport', at: 'before-enter' }], final: 'locked', relockAfterResumeWindow: true, noSubmissionAfterClose: true },
  { id: '15.6', gate: 'P15', title: 'Transport expiry immediately after Enter', password: true, inject: [{ action: 'drop-transport', at: 'after-enter' }], final: 'locked', relockAfterResumeWindow: true, noSubmissionAfterClose: true },
  { id: '15.7', gate: 'P15', title: 'Node kill immediately before Enter', password: true, inject: [{ action: 'kill-server', at: 'before-enter' }], then: ['start-server'], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.8', gate: 'P15', title: 'Node kill immediately after Enter', password: true, inject: [{ action: 'kill-server', at: 'after-enter' }], then: ['start-server'], final: 'locked', noSubmissionAfterClose: true },
  { id: '15.9', gate: 'P15', title: 'input-stream suspended mid-password', password: true, inject: [{ action: 'stop-typist', at: 'typing' }, { action: 'revoke', at: 'typing', delayMs: 2_000 }], final: 'locked', typistGone: true, fieldClearedBeforeNextEnter: true },
  { id: '15.10', gate: 'P15', title: 'Delayed completion inside the watch', password: true, wrongPassword: true, inject: [{ action: 'revoke', at: 'after-enter' }], person: { text: 'In about 30 seconds, when I say so, unlock the test account at the test Mac once and leave it.', cueAfterMs: 30_000, until: 'marker:relocked', timeoutMs: 180_000, mustUnlock: true }, final: 'locked', markerEnd: ['relocked'] },
  { id: '15.11', gate: 'P15', title: 'Delayed completion past the watch', password: true, wrongPassword: true, inject: [{ action: 'revoke', at: 'after-enter' }], person: { text: 'In about 2 minutes 10 seconds, when I say so, unlock the test account at the test Mac once and leave it.', cueAfterMs: 130_000, until: 'unlocked', timeoutMs: 300_000, mustUnlock: true }, final: 'unlocked-accepted-risk', markerEnd: ['relocked'], cleanup: ['lock-now'] },
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
    const injections = c.inject.map(i => `${i.action} at ${i.at}`).join('; ');
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
  if (at === 'typing') return snap.typistRunning === true;
  if (at === 'after-enter') return markers.some(m => typeof m.enterPendingAt === 'number' && snap.now - m.enterPendingAt >= 50);
  if (at === 'before-enter') return ctx.beforeEnterDue !== undefined && snap.now >= ctx.beforeEnterDue;
  return snap.events?.includes(at) === true;
}

/**
 * Run one case against a target. Every observation is kept as evidence; the
 * verdict compares the evidence with the case's expectation and nothing else.
 */
export async function runCase(c, target, { pollMs = 250, log = () => {} } = {}) {
  const evidence = { id: c.id, gate: c.gate, startedAt: target.now(), samples: [], fired: [], person: null, notes: [] };
  const sample = async () => {
    const snap = await target.snapshot();
    evidence.samples.push({ t: snap.now, lockState: snap.lockState, markers: snap.markers, dirty: snap.dirty, guard: snap.guardPid ?? null, typist: snap.typistRunning === true });
    return snap;
  };
  const pending = [...c.inject];
  try {
    await target.prepare(c);
    for (const step of c.before ?? []) evidence.fired.push({ action: step, at: 'before', t: target.now(), result: (await target.act(step, { case: c })) ?? null });
    const ctx = { sent: false, beforeEnterDue: undefined };
    const grant = await target.openGrant(c);
    evidence.grantOpenedAt = target.now();
    if (c.password) {
      const pace = target.calibration();
      if (pace) ctx.beforeEnterDue = target.now() + pace.reserveMs + pace.perCharMs * Math.max(0, pace.length - 2);
      void target.typePassword(c).then(
        r => { ctx.sent = r?.sent === true; evidence.secretResult = r ?? null; },
        err => { evidence.secretResult = { error: err instanceof Error ? err.message : String(err) }; });
    }
    let deadline = target.now() + (c.timeoutMs ?? WATCH_MS + GRANT_CEILING_MS / 4);
    let personCued = false;
    while (target.now() < deadline) {
      const snap = await sample();
      for (const step of [...pending]) {
        if (!matchAt(step.at, snap, ctx)) continue;
        if (step.delayMs) await target.sleep(step.delayMs);
        pending.splice(pending.indexOf(step), 1);
        const result = await target.act(step.action, { case: c, step, grant, snap });
        evidence.fired.push({ action: step.action, at: step.at, t: target.now(), result: result ?? null });
        log(`[${c.id}] ${step.action} (${step.at})`);
      }
      if (c.person && !personCued && pending.length === 0) {
        personCued = true;
        if (c.person.cueAfterMs) await target.sleep(c.person.cueAfterMs);
        evidence.person = { cuedAt: target.now(), text: c.person.text };
        await target.askPerson(c.person.text);
        deadline = Math.max(deadline, target.now() + (c.person.timeoutMs ?? 0));
      }
      // A person step is finished only when its result is seen. Asking is not doing.
      if (personCued && !evidence.person.doneAt && (!c.person.until || matchAt(c.person.until, snap, ctx))) evidence.person.doneAt = target.now();
      if (personCued && c.person.mustUnlock && snap.lockState === 'unlocked') evidence.person.sawUnlock = true;
      const settled = pending.length === 0 && (!c.person || (evidence.person?.doneAt && (!c.person.mustUnlock || evidence.person.sawUnlock))) && target.settled(snap, c);
      if (settled) break;
      await target.sleep(pollMs);
    }
    for (const step of c.then ?? []) await target.act(step, { case: c });
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

/** Measurements every target gets from its own samples (the target may add more). */
export function measured(ev) {
  const out = {};
  const drop = ev.fired.find(f => f.action === 'drop-transport');
  if (drop) {
    const closed = ev.samples.find(s => s.t >= drop.t && Object.values(s.markers ?? {}).length > 0
      && Object.values(s.markers).every(m => TERMINAL.includes(m.state)));
    if (closed) out.relockAfterDropMs = closed.t - drop.t;
  }
  const last = ev.samples[ev.samples.length - 1];
  if (last && typeof last.dirty === 'boolean') out.fieldDirtyAtEnd = last.dirty;
  return out;
}

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
  if (c.person && !ev.person?.doneAt) reasons.push(`person step never completed: ${c.person.until ?? 'no result seen'}`);
  if (c.person?.mustUnlock && !ev.person?.sawUnlock) reasons.push('no unlock was seen after the person was asked');
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
  if (c.securityItemWithinMs !== undefined && !(x.securityItemMs <= c.securityItemWithinMs)) reasons.push(`security item ${x.securityItemMs === undefined ? 'never raised' : `raised after ${x.securityItemMs} ms`}`);
  if (c.securityItemAfterBoot && !x.securityItemRaised) reasons.push('security item not raised after the server came back');
  if (c.producerGone && !x.producerGone) reasons.push('marker not recorded with producerGone');
  if (c.oldGuardGone && !x.oldGuardGone) reasons.push('the suspended guard was not killed before takeover');
  if (c.typistGone && !x.typistGone) reasons.push('typist not confirmed gone');
  if (c.grantAlive && !x.grantAlive) reasons.push('the grant ended after a stray letter');
  if (c.secretRefused && ev.secretResult?.refused !== c.secretRefused) reasons.push(`expected refusal ${c.secretRefused}, got ${JSON.stringify(ev.secretResult ?? null)}`);
  // An expectation with no measurement fails loudly: an unmeasured check is never a pass.
  if (c.noLockCall) {
    if (typeof x.lockCalls !== 'number') reasons.push('not measured: lock calls against another session (no observable source yet)');
    else if (x.lockCalls > 0) reasons.push(`${x.lockCalls} lock call(s) against another session`);
  }
  if (c.relockAfterResumeWindow) {
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
