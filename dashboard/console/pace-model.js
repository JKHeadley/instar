// Queue pace — pure view model (docs/specs/queue-pace.md §Surfaces).
// One plain line per queue, for a non-technical reader on a phone. No DOM here.
// Wording is frozen by the spec ("Feedback sorting: 120 a day in, 90 done — falling behind; speeding up").
import { verifiedDisplayName } from './display-identity.js';

const VERDICT_WORDS = {
  'falling-behind': 'falling behind',
  'catching-up': 'catching up',
  holding: 'holding steady',
  'shrinking-by-exits': 'shrinking, but not by finishing work',
  unknown: 'can’t tell yet',
  'owner-not-serving': 'not being worked on right now',
};

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** Colour per line: the verdict decides, except work waiting on a person, which is always neutral. */
export function toneOf(q) {
  if (!q) return 'unknown';
  if (q.bottleneck && q.bottleneck.kind === 'person') return 'muted';
  switch (q.verdict) {
    case 'falling-behind': return 'attn';
    case 'shrinking-by-exits': return 'attn';
    case 'catching-up':
    case 'holding': return 'ok';
    default: return 'unknown';
  }
}

export function fmtRate(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n >= 10) return String(Math.round(n));
  return String(Math.round(n * 10) / 10);
}

/** Why it is behind, in a few plain words (falling-behind only). */
export function reasonWords(q) {
  const b = q.bottleneck;
  if (!b) return null;
  const tuner = q.tuner && q.tuner.state;
  switch (b.kind) {
    case 'person': return b.detail || 'waiting for you';
    case 'worker':
      if (tuner === 'speeding-up') return 'speeding up';
      if (tuner === 'speeding-up-dry-run') return 'would speed up (trial mode, nothing changed)';
      return 'the sorting rounds keep running out of time';
    case 'cap': return `held back by a fixed limit: ${b.detail || 'a daily limit'}`;
    case 'quota': return 'paused by the account usage limit';
    default: return 'the reason isn’t clear yet';
  }
}

/** The one plain line for a queue. `showMachine` adds "(on <machine>)" when several machines answer. */
export function paceLine(q, showMachine = false) {
  const label = verifiedDisplayName(q.label, q.id) || 'Work queue';
  const where = showMachine && q.machine ? ` (on ${q.machine})` : '';
  const person = q.bottleneck && q.bottleneck.kind === 'person';
  let verdict = VERDICT_WORDS[q.verdict] || VERDICT_WORDS.unknown;
  // Work waiting on a person is information, not pressure: no "falling behind", no days-to-clear.
  if (person && q.verdict === 'falling-behind') verdict = 'waiting on you';
  if (q.verdict === 'catching-up' && typeof q.daysToClear === 'number' && !person) verdict += `, about ${fmtRate(q.daysToClear)} days to clear`;
  const inR = fmtRate(q.inflowPerDay), outR = fmtRate(q.outflowPerDay);
  const rates = inR !== null && outR !== null ? `${inR} a day in, ${outR} done — ` : '';
  let line = `${label}${where}: ${rates}${verdict}`;
  if (q.verdict === 'falling-behind') {
    const why = reasonWords(q);
    if (why && !(person && why === verdict)) line += `; ${why}`;
  } else if (q.rawVerdict === 'falling-behind') {
    line += ' (may be falling behind — checking again next hour)';
  }
  if (q.verdict === 'unknown' && q.coverage && !q.coverage.last3Ok) line += ' (not enough recent measurements)';
  return line;
}

/** PR links for a person bottleneck, built only from numbers and a validated repository. */
export function prLinks(q) {
  const b = q && q.bottleneck;
  if (!b || b.kind !== 'person' || !Array.isArray(b.prs) || typeof b.repo !== 'string' || !REPO_RE.test(b.repo)) return [];
  return b.prs.filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 20).map((n) => ({ n, href: `https://github.com/${b.repo}/pull/${n}` }));
}

/** The card's one-sentence summary. */
export function paceSummary(queues) {
  if (!queues || !queues.length) return 'Nothing is being measured on this agent yet.';
  const behind = queues.filter((q) => q.verdict === 'falling-behind' && !(q.bottleneck && q.bottleneck.kind === 'person')).length;
  const waiting = queues.filter((q) => q.bottleneck && q.bottleneck.kind === 'person').length;
  const parts = [];
  if (behind) parts.push(`${behind} ${behind === 1 ? 'pile is' : 'piles are'} growing faster than work gets done`);
  if (waiting) parts.push(`${waiting} ${waiting === 1 ? 'is' : 'are'} waiting for you`);
  if (!parts.length) return 'Every pile is keeping up, or there is not enough measurement yet to say.';
  return parts.join(', and ') + '.';
}

/** The maturation board's pace line for maturation fixes (null when not measured). */
export function maturationPaceLine(view) {
  const q = (view && view.queues || []).find((x) => x.id === 'maturation.fix');
  if (!q) return null;
  return paceLine({ ...q, label: 'Pace' });
}
