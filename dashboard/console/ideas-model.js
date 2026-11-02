// Ecosystem ideas page: pure wording (docs/specs/ecosystem-idea-pipeline.md §9–§10).
// Every string that came from a model or another project is written with textContent by the view.

export const BANDS = [
  { id: 'now', label: 'Ready to act on', note: 'Checked by two AI families, clear fit, evidence available or cheap.' },
  { id: 'plan', label: 'Worth planning', note: 'Real value, with evidence still to gather.' },
  { id: 'watch', label: 'Watching', note: 'Promising, but young or unproven where it came from.' },
  { id: 'unranked', label: 'Not ranked', note: 'Still in review, or the checks disagreed.' },
  { id: 'stopped', label: 'Stopped', note: 'Kept on record so the same idea is not argued twice.' },
];

export function ideasInBand(ideas, band) { return ideas.filter((i) => i.band === band); }

export function headline(summary) {
  if (summary.neverRun) return 'The weekly review has not run yet.';
  const f = summary.funnel;
  if (f.bands.now > 0) return `${f.bands.now} idea${f.bands.now === 1 ? ' is' : 's are'} ready to act on.`;
  return `Nothing is ready to act on. ${f.seen} seen so far, ${f.adopted} adopted.`;
}

export function funnelLine(f) {
  const last = f.lastAdoptionAt ? `last adopted ${f.lastAdoptionAt.slice(0, 10)}` : 'nothing adopted yet';
  const audit = f.audited ? `, ${f.overturnedInAudit} of ${f.audited} rechecked verdicts overturned` : '';
  return `Seen ${f.seen}, verified ${f.verified}, decided ${f.decided}, adopted ${f.adopted}; ${last}${audit}.`;
}

export function admissionLine(admission) {
  if (!admission.length) return 'No AI service has been tested yet.';
  return admission.map((a) => `${a.framework}: ${a.admitted ? 'allowed to read outside text' : 'refused'}`).join(' · ');
}

const CLASS_WORDS = {
  'additive-dark': 'New and off by default',
  'behaviour-changing': 'Changes what agents do',
  'reduces-capability': 'Takes something away, so it needs a blind trial',
};
export function classWords(c) { return CLASS_WORDS[c] || 'Risk not judged yet'; }

export function projectLine(w) {
  if (w.stalled) return `Stalled after three failed weeks. ${w.lastError || ''}`.trim();
  if (w.lastError) return `Last try failed, and it will try again. ${w.lastError}`;
  if (!w.lastCheckedAt) return 'Not checked yet.';
  return `Checked ${w.lastCheckedAt.slice(0, 10)}.`;
}

export function planRequest(action, idea, extra = {}) {
  return { action, ...(idea ? { ideaId: idea.id } : {}), ...extra };
}
