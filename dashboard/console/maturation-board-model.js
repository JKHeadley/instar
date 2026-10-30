// Maturation board — pure view model (docs/specs/maturation-board.md §7).
// No DOM, no fetch: everything here is unit-tested.
//
// Readability rules (Justin, 2026-10-30: the first version was "impossible to digest"):
//  - plain words only on the first screen: no ids, setting names, codes or log text;
//  - one answer sentence, one picture (a square per feature), then plain groups;
//  - technical detail exists, but only behind a tap.
// The board still adds no verdict of its own: each group is a plain name for the
// review's verdict, and every row is labelled as the review's assessment.

/** Plain groups, in the order they are shown. Each maps review verdicts to one plain word. */
export const GROUPS = [
  { id: 'broken', label: 'Broken', tone: 'bad', verdicts: ['regressed'], blurb: 'Was working, now isn’t.', open: true },
  { id: 'stuck', label: 'Stuck', tone: 'warn', verdicts: ['stalled'], blurb: 'Not moving forward.', open: true },
  { id: 'unmeasured', label: 'Not measured', tone: 'blind', verdicts: ['blind'], blurb: 'Nothing records whether it works.', open: false },
  { id: 'progressing', label: 'On its way', tone: 'track', verdicts: ['on-track', 'ready', 'too-new'], blurb: 'Collecting evidence, or ready to move up.', open: false },
  { id: 'working', label: 'Working', tone: 'ok', verdicts: ['live'], blurb: 'Switched on and healthy.', open: false },
  { id: 'leaving', label: 'Being retired', tone: 'slate', verdicts: ['retire-pending'], blurb: 'Decided to remove.', open: false },
  { id: 'other', label: 'Not reviewed', tone: 'muted', verdicts: ['other', 'not-reviewed'], blurb: 'The latest review didn’t grade it.', open: false },
];
const GROUP_BY_VERDICT = {};
for (const g of GROUPS) for (const v of g.verdicts) GROUP_BY_VERDICT[v] = g;
const ATTENTION = new Set(['broken', 'stuck', 'unmeasured']);

export function verdictOf(f) { return f.review ? f.review.verdict : 'not-reviewed'; }
export function groupOf(f) { return GROUP_BY_VERDICT[verdictOf(f)] || GROUP_BY_VERDICT.other; }
export function groupById(id) { return GROUPS.find((g) => g.id === id) || null; }

/** Date-only values mean that calendar day; show them without a timezone shift. */
export function fmtDate(s) {
  if (!s) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── plain names ────────────────────────────────────────────────────────────
const WORD_FIX = { llm: 'AI', mcp: 'MCP', a2a: 'agent-to-agent', jev: 'Jev', pr: 'PR', ui: 'UI', id: 'ID', url: 'link', e2e: 'end-to-end', codex: 'Codex', claude: 'Claude', telegram: 'Telegram', slack: 'Slack', imessage: 'iMessage' };

/** "sessionPool" → "session pool"; "failoverRunner" → "failover runner". */
function words(seg) {
  return seg
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => WORD_FIX[w] || w)
    .join(' ');
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/** A human name for a feature: the review's title, else derived from its id. */
export function humanName(f) {
  if (f.title) return f.title;
  if (f.review && f.review.title) return f.review.title;
  const base = String(f.id).replace(/\s*\(.*\)\s*$/, '').split('+')[0].trim();
  const segs = base.split(/[./]/).filter((x) => x && x !== 'enabled' && x !== 'monitoring' && x !== 'intelligence');
  if (!segs.length) return cap(words(base));
  return cap(words(segs[segs.length - 1]));
}

/** A plain area for a feature: the review's area, else the id's second-to-last part. */
export function humanArea(f) {
  if (f.review && f.review.area) return f.review.area;
  const segs = String(f.id).replace(/\s*\(.*\)\s*$/, '').split(/[./]/).filter((x) => x && x !== 'enabled');
  if (segs.length < 2) return '';
  return cap(words(segs[segs.length - 2]));
}

// ── follow-up in plain words ───────────────────────────────────────────────
/** "Fix underway" / "Nobody on it" / "Can't tell" — from explicit links only. */
export function ownerChip(f) {
  const fu = f.followUp || { state: 'unknown', items: [] };
  if (fu.state === 'unknown') return { text: 'Can’t tell', tone: 'muted' };
  if (fu.state === 'none-linked') return ATTENTION.has(groupOf(f).id) ? { text: 'Nobody on it', tone: 'bad' } : null;
  const open = fu.items.some((i) => i.status === 'pending' || i.kind === 'initiative');
  return open ? { text: 'Fix underway', tone: 'ok' } : { text: 'Fix assigned', tone: 'track' };
}

/** One short plain line under the name. Prefers the review's own plain summary. */
export function statusLine(f) {
  if (f.review && f.review.summary) return f.review.summary;
  const g = groupOf(f);
  const d = nextOpenDeadline(f);
  if (d && d.overdueDays != null) return `${d.overdueDays} days past its date.`;
  if (f.unchangedReviews > 1 && ATTENTION.has(g.id)) return `Same for ${f.unchangedReviews} reviews in a row.`;
  return ''; // never repeat the group's own blurb on every row
}

export function nextStep(f) {
  if (f.review && f.review.nextStep) return f.review.nextStep;
  const d = nextOpenDeadline(f);
  if (d) return `Next date: ${fmtDate(d.date)}.`;
  return '';
}

export function nextOpenDeadline(f) {
  const open = (f.deadlines || []).filter((d) => d.open);
  return open.length ? open[0] : null;
}

// ── the answer ─────────────────────────────────────────────────────────────
export function groupCounts(features) {
  const c = Object.fromEntries(GROUPS.map((g) => [g.id, 0]));
  for (const f of features) c[groupOf(f).id]++;
  return c;
}

export function attention(features) {
  const need = features.filter((f) => ATTENTION.has(groupOf(f).id));
  const nobody = need.filter((f) => f.followUp && f.followUp.state === 'none-linked').length;
  return { need: need.length, nobody };
}

/** The one-sentence answer. Plain words, no review jargon. */
export function headline(board) {
  if (board.reviewState === 'unavailable') return 'Can’t show the latest review right now: the machine that holds it isn’t answering.';
  const fs = board.features || [];
  if (!fs.length) return 'No features to show yet.';
  const c = groupCounts(fs);
  const a = attention(fs);
  return `${fs.length} features: ${c.working} working, ${a.need} need attention.`;
}

export function subline(board) {
  const fs = board.features || [];
  const a = attention(fs);
  const bits = [];
  if (a.need) bits.push(a.nobody ? `${a.nobody} of those have nobody on them.` : 'Each of those has someone on it.');
  if (board.reviewDate) bits.push(`From the ${fmtDate(board.reviewDate)} review.`);
  const missing = (board.sources || []).find((s) => s.name === 'may-be-superseded');
  if (missing) bits.push(`${missing.machine} didn’t answer, so this may be out of date.`);
  return bits.join(' ');
}

// ── URL state ──────────────────────────────────────────────────────────────
const KEYS = ['g', 'q', 'nobody', 'open', 'f'];

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

/** Which groups are expanded: those listed in `open`, else each group's default. */
export function openGroups(st) {
  if (st.open) return new Set(st.open.split(',').filter(Boolean));
  if (st.g) return new Set([st.g]);
  return new Set(GROUPS.filter((g) => g.open).map((g) => g.id));
}

// ── filter + order ─────────────────────────────────────────────────────────
export function filterRows(features, st) {
  let rows = features.slice();
  if (st.g) rows = rows.filter((f) => groupOf(f).id === st.g);
  if (st.nobody) rows = rows.filter((f) => f.followUp && f.followUp.state === 'none-linked');
  if (st.q) {
    const q = st.q.toLowerCase();
    rows = rows.filter((f) => [humanName(f), humanArea(f), f.id, f.review && f.review.summary, f.review && f.review.evidence]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }
  return rows;
}

/** Inside a group: nobody-on-it first, then longest unchanged, then name. */
export function orderInGroup(rows) {
  const rank = (f) => (f.followUp && f.followUp.state === 'none-linked' ? 0 : f.followUp && f.followUp.state === 'unknown' ? 1 : 2);
  return rows.slice().sort((a, b) => rank(a) - rank(b) || (b.unchangedReviews || 0) - (a.unchangedReviews || 0) || humanName(a).localeCompare(humanName(b)));
}

/** Squares for the map: one per feature, grouped in display order. */
export function squares(features) {
  const out = [];
  for (const g of GROUPS) {
    for (const f of orderInGroup(features.filter((x) => groupOf(x).id === g.id))) {
      out.push({ id: f.id, group: g.id, tone: g.tone, title: `${humanName(f)} · ${g.label}`, nobody: !!(f.followUp && f.followUp.state === 'none-linked' && ATTENTION.has(g.id)) });
    }
  }
  return out;
}

/** Timeline points from recorded dates only. */
export function timeline(f, now) {
  const pts = [];
  if (f.shippedAt) pts.push({ at: f.shippedAt.date, label: 'Shipped' });
  for (const t of f.transitions || []) pts.push({ at: t.at, label: `Switch: ${words(t.to)}` });
  for (const h of f.history || []) pts.push({ at: h.date, label: `Review: ${groupOf({ review: { verdict: h.verdict } }).label}` });
  for (const d of f.deadlines || []) pts.push({ at: d.date, label: d.overdueDays != null ? `Due (${d.overdueDays} days ago)` : 'Due', overdue: d.overdueDays != null });
  const dated = pts.filter((p) => Number.isFinite(Date.parse(p.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return dated.map((p) => ({ ...p, when: fmtDate(p.at), future: Date.parse(p.at) > now }));
}
