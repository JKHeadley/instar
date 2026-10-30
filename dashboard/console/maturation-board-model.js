// Maturation board — pure view model (docs/specs/maturation-board.md §7).
// No DOM, no fetch: everything here is unit-tested. The board adds no verdict of
// its own: every verdict shown is the review's, labelled with its date.

export const VERDICTS = [
  { id: 'regressed', label: 'Regressed', tone: 'bad' },
  { id: 'stalled', label: 'Stalled', tone: 'warn' },
  { id: 'blind', label: 'Blind', tone: 'blind' },
  { id: 'on-track', label: 'On track', tone: 'track' },
  { id: 'ready', label: 'Ready', tone: 'ok' },
  { id: 'too-new', label: 'Too new', tone: 'muted' },
  { id: 'retire-pending', label: 'Retiring', tone: 'slate' },
  { id: 'live', label: 'Live', tone: 'ok' },
  { id: 'other', label: 'Other', tone: 'muted' },
  { id: 'not-reviewed', label: 'Not reviewed', tone: 'muted' },
];
const VERDICT_BY_ID = Object.fromEntries(VERDICTS.map((v) => [v.id, v]));
const ORDER = Object.fromEntries(VERDICTS.map((v, i) => [v.id, i]));
const SRB = new Set(['stalled', 'regressed', 'blind']);

export function verdictOf(f) { return f.review ? f.review.verdict : 'not-reviewed'; }
export function verdictInfo(id) { return VERDICT_BY_ID[id] || VERDICT_BY_ID.other; }

/** Date-only values mean that calendar day; show them without a timezone shift. */
export function fmtDate(s) {
  if (!s) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function nextOpenDeadline(f) {
  const open = (f.deadlines || []).filter((d) => d.open);
  return open.length ? open[0] : null;
}

export function pastDate(f) { return (f.deadlines || []).some((d) => d.overdueDays != null); }

/** One plain sentence, from response counts only. */
export function headline(board) {
  const c = board.counts || {};
  if (board.reviewState === 'unavailable') {
    return `The latest review can't be read right now: ${board.reviewMachine || 'the machine that holds it'} is not answering.`;
  }
  if (!board.reviewDate) {
    return `No maturation review has run on this agent yet. ${c.features || 0} features are tracked by live records.`;
  }
  const v = c.byVerdict || {};
  const parts = [];
  for (const id of ['stalled', 'regressed', 'blind']) if (v[id]) parts.push(`${v[id]} ${verdictInfo(id).label.toLowerCase()}`);
  const head = parts.length ? `${parts.join(', ')} of ${c.features}` : `None stalled, regressed or blind of ${c.features}`;
  const follow = c.stalledRegressedBlind
    ? `; ${c.stalledRegressedBlindNoFollowUp} of those have no linked follow-up${c.stalledRegressedBlindFollowUpUnknown ? ` and ${c.stalledRegressedBlindFollowUpUnknown} can't be checked` : ''}`
    : '';
  return `Per the ${fmtDate(board.reviewDate)} review: ${head}${follow}.`;
}

/** Context line: dates written down, missing machines, cached review. */
export function subline(board) {
  const c = board.counts || {};
  const bits = [`${c.withDate || 0} of ${c.features || 0} have a written date; ${c.pastDate || 0} are past it.`];
  const missing = (board.sources || []).find((s) => s.name === 'may-be-superseded');
  if (missing) bits.push(`May be out of date: ${missing.machine} did not answer.`);
  if (board.reviewState === 'cached') bits.push(`Review fetched ${fmtDate(board.reviewCachedAt)} from ${board.reviewMachine}; that machine is not answering now.`);
  return bits.join(' ');
}

/** The five first-view tiles (Dashboard UX Standard F10). Never a combined board word. */
export function tiles(board) {
  const c = board.counts || {};
  return [
    { id: 'srb', label: 'Stalled / regressed / blind (per review)', n: c.stalledRegressedBlind || 0, tone: c.stalledRegressedBlind ? 'attn' : 'ok', filter: { v: 'stalled,regressed,blind' } },
    { id: 'nofollow', label: 'No linked follow-up', n: c.stalledRegressedBlindNoFollowUp || 0, tone: c.stalledRegressedBlindNoFollowUp ? 'bad' : 'ok', filter: { v: 'stalled,regressed,blind', fu: 'none-linked' } },
    { id: 'past', label: 'Past a recorded date', n: c.pastDate || 0, tone: c.pastDate ? 'attn' : 'ok', filter: { past: '1' } },
    { id: 'conflict', label: 'Sources disagree', n: c.conflicts || 0, tone: c.conflicts ? 'attn' : 'ok', filter: { conflict: '1' } },
    { id: 'live', label: 'Live (per review)', n: c.live || 0, tone: 'ok', filter: { v: 'live' } },
  ];
}

export function verdictCounts(board) {
  const v = (board.counts && board.counts.byVerdict) || {};
  return VERDICTS.filter((x) => v[x.id]).map((x) => ({ ...x, n: v[x.id] }));
}

// ── URL state ──────────────────────────────────────────────────────────────
const KEYS = ['v', 'fu', 'past', 'conflict', 'flag', 'm', 'q', 'sort', 'dir', 'all'];

export function parseState(search) {
  const p = new URLSearchParams(search || '');
  const st = {};
  for (const k of KEYS) { const val = p.get(k); if (val) st[k] = val.slice(0, 200); }
  return st;
}

export function stateQuery(st) {
  const p = new URLSearchParams();
  for (const k of KEYS) if (st[k]) p.set(k, st[k]);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function tableOpen(st) { return KEYS.some((k) => k !== 'sort' && k !== 'dir' && st[k]); }

// ── filter + sort ──────────────────────────────────────────────────────────
export function filterRows(features, st) {
  let rows = features.slice();
  if (st.v) { const set = new Set(st.v.split(',')); rows = rows.filter((f) => set.has(verdictOf(f))); }
  if (st.fu) rows = rows.filter((f) => f.followUp && f.followUp.state === st.fu);
  if (st.past) rows = rows.filter(pastDate);
  if (st.conflict) rows = rows.filter((f) => (f.conflicts || []).length);
  if (st.flag) rows = rows.filter((f) => (f.flags || []).includes(st.flag));
  if (st.m) rows = rows.filter((f) => (f.owners || []).some((o) => o.machine === st.m));
  if (st.q) {
    const q = st.q.toLowerCase();
    rows = rows.filter((f) => [f.id, f.title, f.review && f.review.evidence, f.review && f.review.decision, f.review && f.review.action]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  return rows;
}

const SORTS = {
  feature: (f) => (f.title || f.id).toLowerCase(),
  verdict: (f) => ORDER[verdictOf(f)] ?? 99,
  followup: (f) => ({ 'none-linked': 0, unknown: 1, linked: 2 })[f.followUp ? f.followUp.state : 'unknown'],
  due: (f) => { const d = nextOpenDeadline(f); return d ? Date.parse(d.date) || Infinity : Infinity; },
  unchanged: (f) => -(f.unchangedReviews || 0),
};

export function sortRows(rows, key = 'verdict', dir = 'asc') {
  const fn = SORTS[key] || SORTS.verdict;
  const sign = dir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = fn(a); const y = fn(b);
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function machines(board) {
  const set = new Set();
  for (const f of board.features || []) for (const o of f.owners || []) set.add(o.machine);
  return [...set].sort();
}

// ── row text ───────────────────────────────────────────────────────────────
export function followUpText(f) {
  const fu = f.followUp || { state: 'unknown', items: [] };
  if (fu.state === 'none-linked') return { text: 'No linked follow-up', tone: SRB.has(verdictOf(f)) ? 'bad' : 'muted' };
  if (fu.state === 'unknown') return { text: "Can't tell", tone: 'unknown' };
  return { text: fu.items.map((i) => `${i.ref} · ${i.label}`).join(', '), tone: 'ok' };
}

export function deadlineText(f) {
  const d = nextOpenDeadline(f);
  if (!d) return { text: 'No date set', tone: 'muted' };
  if (d.overdueDays != null) {
    const fromReview = d.source === 'review';
    return { text: `${fmtDate(d.date)} · ${d.overdueDays} d past${fromReview ? " the review's date" : ''}`, tone: fromReview ? 'attn' : 'bad' };
  }
  return { text: fmtDate(d.date), tone: 'muted' };
}

/** Timeline points: shipped → dark-flag transitions → each review → deadlines → today. Recorded dates only. */
export function timeline(f, now) {
  const pts = [];
  if (f.shippedAt) pts.push({ at: f.shippedAt.date, kind: 'shipped', label: 'Shipped (per review)' });
  for (const t of f.transitions || []) pts.push({ at: t.at, kind: 'transition', label: `${t.to} (${t.machine})` });
  for (const h of f.history || []) pts.push({ at: h.date, kind: 'review', verdict: h.verdict, label: `${verdictInfo(h.verdict).label}${h.carried ? ' (carried)' : ''}` });
  for (const d of f.deadlines || []) pts.push({ at: d.date, kind: 'deadline', open: d.open, overdue: d.overdueDays != null, label: `${d.milestone} (${d.source})` });
  const dated = pts.filter((p) => Number.isFinite(Date.parse(p.at)));
  if (!dated.length) return { points: [], start: null, end: null, empty: true };
  const times = dated.map((p) => Date.parse(p.at));
  const start = Math.min(...times);
  const end = Math.max(now, ...times);
  const span = Math.max(end - start, 86_400_000);
  return {
    empty: false,
    start, end,
    todayPct: ((now - start) / span) * 100,
    points: dated.map((p) => ({ ...p, pct: ((Date.parse(p.at) - start) / span) * 100 })).sort((a, b) => a.pct - b.pct),
  };
}
