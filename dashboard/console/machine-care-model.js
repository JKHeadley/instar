// Machine care page model (docs/specs/machine-self-maintenance.md, Part F surfaces, CMT-1203).
// Pure: turns GET /machine-maintenance?scope=pool into one plain sentence per machine and the
// controls that machine's row may show. Controls are offered only for THIS machine: a remote row
// needs a signed relay, which is a later slice, so it says where its controls are instead.

const DAY = 24 * 3600 * 1000;

const FAILED = {
  offline: 'it is offline',
  'not-enabled': 'machine care is not turned on there',
  'route-missing': 'it runs an older version',
  unauthorized: 'it did not accept this machine',
  'url-rejected': 'there is no safe connection to it',
  'peer-unreachable': 'it did not answer',
  timeout: 'it did not answer in time',
  'read-failed': 'its reading failed',
};

/** "HH:MM" for a clock time in ms, in the viewer's own time zone. */
export function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "3 days ago", "19 hours ago", "just now". */
export function ago(ms, now) {
  const diff = now - ms;
  if (!Number.isFinite(diff) || diff < 0) return null;
  if (diff < 3600 * 1000) return 'less than an hour ago';
  if (diff < DAY) { const h = Math.round(diff / 3600000); return `${h} ${h === 1 ? 'hour' : 'hours'} ago`; }
  const d = Math.round(diff / DAY);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

/** A day the owner will recognise: "Thursday 12:00". */
export function dayAndTime(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-US', { weekday: 'long' })} ${clock(ms)}`;
}

/** The plain sentence for one machine's state, and what its row may offer. */
export function careRow(state, { self = false, name = 'This machine', now = Date.now() } = {}) {
  const s = state || {};
  const parts = [];
  const enrol = s.enrolment && typeof s.enrolment === 'object' ? s.enrolment : null;
  const enrolled = Boolean(enrol && enrol.enrolled);
  const win = s.settings && s.settings.window;
  const winText = win && win.start && win.end ? `between ${win.start} and ${win.end}` : 'in the small hours';
  const skipped = Boolean(s.controls && s.controls.skipped);

  if (s.enabled === false) parts.push('Machine care is switched off here, so nothing restarts.');
  else if (!enrol) parts.push('I can’t tell whether this machine is signed up.');
  else if (!enrolled) {
    parts.push('Not signed up, so nothing restarts here.');
    if (enrol.refusal === 'other-user-active') parts.push('Someone else is signed in to it, so sign-up waits until they leave.');
    else if (enrol.refusal === 'not-owned') parts.push('It is marked as not mine to look after.');
    else if (enrol.readiness && enrol.readiness.mode === 'attended' && enrol.readiness.ownerStep) parts.push(`After a restart it would stop at the login screen. To fix: ${enrol.readiness.ownerStep}`);
  } else {
    parts.push(s.mode === 'watch-only'
      ? `Weekly restart ${winText} is practising only: nothing restarts on its own yet.`
      : `Restarts about weekly ${winText}.`);
  }

  const lastBoot = typeof s.lastBootAt === 'number' ? ago(s.lastBootAt, now) : null;
  if (lastBoot) parts.push(`Last start ${lastBoot}.`);
  else if (typeof s.uptimeDays === 'number') parts.push(`Up ${s.uptimeDays} days.`);
  if (skipped && typeof s.controls.skipUntil === 'number') parts.push(`Skipped until ${dayAndTime(s.controls.skipUntil)}.`);
  if (s.restartNow && typeof s.restartNow === 'object') parts.push('A restart countdown is running now.');

  const live = self && s.enabled !== false;
  return {
    name,
    self,
    sentence: parts.join(' '),
    window: win || null,
    ownWindow: Boolean(s.controls && s.controls.window),
    skipped,
    controls: live ? {
      signUp: Boolean(enrol && !enrolled && enrol.offerable),
      skip: !skipped,
      unskip: skipped,
      window: true,
      restartNow: enrolled && !s.restartNow,
    } : null,
  };
}

/**
 * The whole page from GET /machine-maintenance?scope=pool (or an older server's own status).
 * Returns { ok:false, reason } when the read failed: never a guessed "all fine".
 */
export function buildMachineCarePage(res, { now = Date.now() } = {}) {
  if (!res || !res.ok || !res.data) return { ok: false, reason: (res && res.reason) || 'the machine care reading did not answer' };
  const d = res.data;
  const rows = [];
  if (Array.isArray(d.machines)) {
    for (const m of d.machines) {
      if (!m || !m.state) continue;
      rows.push(careRow(m.state, { self: Boolean(m.self), name: m.machineNickname || 'A machine with no name yet', now }));
    }
  } else {
    rows.push(careRow(d, { self: true, name: 'This machine', now }));
  }
  rows.sort((a, b) => Number(b.self) - Number(a.self));
  const failed = d.pool && Array.isArray(d.pool.failed) ? d.pool.failed : [];
  const missing = failed.map((f) => `${f.machineNickname || 'A machine with no name yet'}: can’t tell, ${FAILED[f.reason] || 'no answer'}.`);
  const enrolledCount = rows.filter((r) => /practising|Restarts about weekly/.test(r.sentence)).length;
  const headline = enrolledCount === 0 ? 'No machine is signed up for restarts yet'
    : `${enrolledCount} ${enrolledCount === 1 ? 'machine is' : 'machines are'} signed up`;
  return { ok: true, headline, rows, missing };
}

/** Plain words for a control's answer from the server. */
export function controlAnswer(action, r) {
  if (r.status === 401) return { ok: false, message: 'That needs your dashboard PIN again.' };
  if (r.status === 503) return { ok: false, message: 'Machine care is not turned on on this machine.' };
  const d = r.data || {};
  if (!r.ok) {
    if (d.error === 'window-invalid') return { ok: false, message: 'Pick a start and an end at least 2 hours apart.' };
    if (d.error === 'host-store-busy') return { ok: false, message: 'Another change was being saved. Try again in a moment.' };
    if (action === 'restart' && d.result === 'refused') return { ok: false, message: d.reason || 'I won’t restart it right now.' };
    if (action === 'restart' && d.result === 'not-delivered') return { ok: false, message: 'I couldn’t send you the restart card. Try again in a minute.' };
    return { ok: false, message: typeof d.error === 'string' ? d.error : `The server answered ${r.status}.` };
  }
  if (action === 'skip') return { ok: true, message: d.controls && d.controls.skipUntil ? `Skipped. The next restart is after ${dayAndTime(d.controls.skipUntil)}.` : 'Skipped.' };
  if (action === 'unskip') return { ok: true, message: 'Skip undone. Restarts go back to the usual nights.' };
  if (action === 'window') return { ok: true, message: d.effectiveWindow ? `From the next night, restarts happen between ${d.effectiveWindow.start} and ${d.effectiveWindow.end}.` : 'Saved.' };
  if (action === 'restart') return { ok: true, message: 'I sent you a card in Telegram. Tap Restart now there to start the 5-minute countdown.' };
  if (action === 'sign-up') {
    const o = d.outcome;
    if (o === 'offered') return { ok: true, message: 'I sent you a card in Telegram. Tap Approve there to sign this machine up.' };
    if (o === 'already-offered') return { ok: true, message: 'The sign-up card is already in your Telegram. Tap Approve there.' };
    if (o === 'not-offerable') return { ok: false, message: 'This machine can’t be signed up right now. The line above says why.' };
    if (o === 'not-delivered') return { ok: false, message: 'I couldn’t send you the sign-up card. Try again in a minute.' };
    return { ok: false, message: 'I couldn’t tell whether the card was sent.' };
  }
  return { ok: true, message: 'Done.' };
}
