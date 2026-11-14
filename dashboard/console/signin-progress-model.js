// What the sign-in sheet shows after a code is sent (operator report 2026-11-10, topic 33890:
// "If the process is truly 'in progress' then the UI should change completely and the
// buttons should be disabled or go away"). Pure: one server answer in, one view out.
//
// Views:
//   { kind: 'working', title, sub }          the form is gone; a spinner and these words
//   { kind: 'done', title }                  signed in; one Done button
//   { kind: 'failed', title, sub }           one "Start the sign-in again" button
//   { kind: 'form', error, freshLogin? }     the code did not go through; the form comes back

const FAIL_WORDS = {
  'wrong-account': 'A different account signed in, so it was not added.',
  'window-closed': 'The sign-in window closed before the sign-in finished.',
  'timed-out': 'The sign-in did not finish in time. If it finishes later, the account shows as signed in by itself.',
  cancelled: 'This sign-in was cancelled.',
  gone: 'This sign-in is no longer open.',
  'could-not-save': 'The sign-in finished, but the account could not be saved.',
};

function heldWords(expected, got) {
  if (got && expected) return `It signed in as ${got}, but this account is ${expected}, so it was not added.`;
  if (got) return `It signed in as ${got}, which is not the account asked for, so it was not added.`;
  return 'The account that signed in could not be confirmed, so it was not added.';
}

export function workingView(machine, phase) {
  if (phase === 'sending') return { kind: 'working', title: 'Checking your code…', sub: `Sending it to ${machine}.` };
  return { kind: 'working', title: `Finishing the sign-in on ${machine}…`, sub: 'This usually takes under a minute. You can leave this open; it updates by itself.' };
}

function doneView(machine, email) {
  return { kind: 'done', title: email ? `Signed in as ${email} on ${machine}.` : `Signed in on ${machine}.` };
}

/** The view for the submit-code answer. */
export function submitView(r, machine) {
  const d = (r && r.data) || {};
  if (r && r.ok && d.outcome === 'validated') return doneView(machine, d.email || (d.account && d.account.email));
  if (r && r.ok && d.outcome === 'held') return { kind: 'failed', title: 'This sign-in was not added.', sub: heldWords(d.expected, d.got) };
  if (r && r.ok && d.outcome === 'submitted') return workingView(machine, 'finishing');
  return { kind: 'form', error: d.error || d.message || 'That code did not work. Check it and send it again.', ...(d.freshLogin ? { freshLogin: d.freshLogin } : {}) };
}

/**
 * The view for one completion poll. `null` means keep waiting (still finishing, or the
 * machine could not be reached this time).
 */
export function completionView(r, machine) {
  const c = r && r.ok && r.data ? r.data.completion : null;
  // Not final: still finishing, unreachable this time, or the machine has no live watch for it
  // (it restarted mid-finish; its background check can still complete the sign-in). The page
  // keeps asking until its own bound, then says no answer came back.
  if (!c || c.state === 'finishing' || c.state === 'waiting-for-code' || c.state === 'unknown') return null;
  if (c.state === 'done') return doneView(machine, c.email);
  if (c.state === 'failed') {
    if (c.reason === 'wrong-account') return { kind: 'failed', title: 'This sign-in was not added.', sub: heldWords(c.expected, c.got) };
    return { kind: 'failed', title: 'The sign-in did not finish.', sub: FAIL_WORDS[c.reason] || c.message || 'Something stopped it.' };
  }
  return null;
}

/** How long the page keeps asking before it gives up on its own (the server's bound is shorter). */
export const COMPLETION_POLL_MS = 2_000;
export const COMPLETION_GIVE_UP_MS = 4 * 60_000;
export const GIVE_UP_VIEW = { kind: 'failed', title: 'No answer yet.', sub: 'No answer came back in time. If the sign-in finishes later, the account shows as signed in by itself.' };
