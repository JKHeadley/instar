// Outside services, on "What I'm allowed to do" — pure view-model
// (docs/specs/recommended-services.md, Surfaces). Read only: every word about a service comes
// from the server's catalog, and a backup is never described as stronger than its status.

const BACKUP_WORDS = {
  exercised: 'Proven: a drill switched this service off and the backup worked.',
  specified: 'Built, but not yet proven by switching this service off.',
  gap: 'Not complete yet.',
};

function choiceWord(s) {
  if (s.stopped) return 'Switched off';
  if (s.switchingOff) return 'Switching off';
  if (s.stalled) return 'Setup stopped';
  if (s.verified && s.verified.result === 'pass') return 'Working';
  if (s.choice === 'yes') return 'You said yes';
  if (s.choice === 'no' || s.legacyDeclined) return 'You said no';
  return s.available ? 'Not decided' : 'Not available yet';
}

function backupText(s) {
  const status = BACKUP_WORDS[s.backupStatus] || 'Unknown.';
  const what = s.backup || 'None yet.';
  return `${what} ${status}${s.gapWhen ? ` ${s.gapWhen}` : ''}`;
}

/** GET /recommended-services → the rows, or the reason there are none. */
export function buildServices(res) {
  if (!res || !res.ok) return { ok: false, reason: `Can’t tell which outside services are set up: ${(res && res.reason) || 'the server did not answer'}.` };
  const list = res.data && Array.isArray(res.data.services) ? res.data.services : null;
  if (!list) return { ok: false, reason: 'Can’t tell which outside services are set up: the answer had no list.' };
  const rows = list.map((s) => ({
    key: s.service,
    main: s.name || s.service,
    sub: s.benefit || '',
    end: choiceWord(s),
    // The same page takes a yes or a no. A yes on another machine, or one a later no cancelled, leaves
    // this machine still needing its own, so the choice alone doesn't decide this.
    action: s.available ? { href: `/dashboard/service-yes?service=${encodeURIComponent(s.service)}`, label: s.grantedHere ? 'Change my answer' : 'Yes or no' } : null,
    lines: [
      { label: 'What you get', text: s.benefit },
      { label: 'What leaves this machine', text: s.dataLeaves },
      { label: 'Cost', text: s.cost },
      { label: 'Account', text: s.account },
      { label: 'If you say no', text: backupText(s) },
    ].filter((l) => l.text),
  }));
  const available = list.filter((s) => s.available).length;
  const note = available ? null : 'I can’t set any of these up for you yet. Each one becomes available once I’ve proven its setup works. You don’t need to do anything.';
  return { ok: true, rows, available, note };
}
