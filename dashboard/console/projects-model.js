// Projects on the Work door (docs/specs/work-front-doors.md stage 2a): pure model for GET /work/projects.
// The server owns the state words; this only shapes rows and links. No DOM here (tested in node).

/** Tone per state: what needs the person stands out, finished and paused are quiet. */
const TONE = { 'waiting-on-you': 'attn', 'stopped-retrying': 'bad', stalled: 'bad', drifting: 'attn', 'claims-done': 'attn', moving: 'ok', unknown: 'unknown', paused: 'quiet', done: 'quiet' };

/** A conversation key ("telegram:142909", or a bare app conversation id) as the console's chat link. */
export function conversationHref(key) {
  const k = String(key || '');
  if (!k) return null;
  const ref = /^[a-z]+:/.test(k) ? k : `app:${k}`;
  return `#/work/chats?c=${encodeURIComponent(ref)}`;
}

export function cardHref(id) { return `#/work/board?card=${encodeURIComponent(String(id || ''))}`; }

function cardView(c) {
  return { id: String(c.id), title: String(c.title || 'Untitled card'), sub: c.needLine ? String(c.needLine) : null, href: cardHref(c.id), chatHref: conversationHref(c.conversationKey) };
}

function shortDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The section's model. `ok: false` when the answer cannot be read at all (the page says so, never "no projects").
 * `line` names what could not be checked; `empty` is said only on a complete read with no projects.
 */
export function projectsView(data) {
  if (!data || !Array.isArray(data.projects)) return { ok: false };
  const active = [], finished = [];
  for (const p of data.projects) {
    const state = String(p.state || 'unknown');
    const done = p.done && Number.isFinite(p.done.total) ? p.done : { items: [], met: 0, total: 0 };
    const row = {
      key: String(p.key), title: String(p.title || p.key), goal: String(p.goal || ''), state, stateWords: String(p.stateWords || ''), tone: TONE[state] || 'unknown',
      // Items nobody has checked yet are not "not done": say so instead of "0 of 3 done".
      doneLine: !done.total ? null : (done.items || []).every((i) => i.state !== 'pass' && i.state !== 'fail') ? `${done.total} to finish, not checked yet` : `${done.met} of ${done.total} done`,
      doneItems: (done.items || []).map((i) => ({ text: String(i.text), state: i.state === 'pass' ? 'pass' : i.state === 'fail' ? 'fail' : 'unknown' })),
      pausedLine: state === 'paused' && p.paused ? `You paused it on ${shortDate(p.paused.at)}: "${String(p.paused.quote)}"` : null,
      cards: (p.cards || []).map(cardView), moreCards: Number(p.moreCards) || 0,
      cardsLine: (p.cards || []).length ? `${(p.cards || []).length + (Number(p.moreCards) || 0)} card${(p.cards || []).length + (Number(p.moreCards) || 0) === 1 ? '' : 's'}` : null,
      chatHref: conversationHref(p.conversationKey || p.key),
    };
    (state === 'done' ? finished : active).push(row);
  }
  const couldNot = Array.isArray(data.couldNotCheck) ? data.couldNotCheck.map(String) : [];
  const line = couldNot.length ? `Could not check ${couldNot.join(' and ')}, so this may not be everything.` : null;
  const loose = (data.notInProject || []).map(cardView);
  // Project tracking switched off is said as such, never as "no projects" (it was not checked).
  const cos = Array.isArray(data.sources) ? data.sources.find((x) => x && x.id === 'chiefOfStaff') : null;
  const off = !!cos && cos.state === 'off' && !active.length && !finished.length;
  const empty = !off && !active.length && !finished.length && !couldNot.length;
  return { ok: true, active, finished, loose, line, empty, off, count: active.length + finished.length };
}
