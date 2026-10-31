/**
 * MaturationBoard — a read-only view of where every maturing feature stands.
 *
 * Spec: docs/specs/maturation-board.md (Justin, topic 128732, 2026-10-30).
 *
 * This module is PURE: it validates review files, joins them with live owner
 * facts that the caller has already read, and computes display arithmetic
 * (deadlines, unchanged-review runs, the closed conflict table). It stores
 * nothing, calls nothing, and decides nothing. In particular:
 *
 *  - The progress verdict is the feature-maturation-review job's verdict,
 *    verbatim. The board has no verdict rule. Readiness stays D7's.
 *  - "Past a date" is arithmetic over recorded deadlines, never the D4
 *    stuck-dark judgement (feature-maturation-discipline D4 owns that).
 *  - Follow-up is three-valued (linked / none-linked / unknown) and counts
 *    ONLY explicit links. No text matching: a literal miss is not evidence
 *    that nothing is being done.
 *  - Owner facts are never merged across machines or sources into one value
 *    (D7's origin-local rule); each is a machine-tagged entry.
 */

export const BOARD_SCHEMA = 'maturation-board/1';
export const REVIEW_SCHEMA = 'maturation-review/1';

export const VERDICTS = [
  'ready', 'on-track', 'blind', 'stalled', 'regressed', 'too-new', 'live', 'retire-pending',
] as const;
export type KnownVerdict = typeof VERDICTS[number];
export type Verdict = KnownVerdict | 'other';

const MAX_FEATURES = 1024;
const MAX_TEXT = 4000;
const MAX_SHORT = 160;
const MAX_COMMITMENTS_PER_ROW = 16;
export const MAX_HISTORY = 52;
const DAY_MS = 86_400_000;

const ID_RE = /^[A-Za-z0-9._:+\-/ (),~]{1,160}$/; // compound review ids like `routingSpend (.money)` are real features
const CMT_RE = /^CMT-\d{1,8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const REVIEW_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(json|md)$/;

// ── Review rows ────────────────────────────────────────────────────────────

export interface ReviewRow {
  id: string;
  title: string | null;
  /** Plain one-word group, written by the review for the operator. */
  area: string | null;
  /** One plain sentence: what is going on right now (review-written, model-assessed). */
  summary: string | null;
  /** One plain sentence: what happens next. */
  nextStep: string | null;
  /** 80/20 plain fields (review-written): what it does, what must be true to move up, the plan, a one-line glance. */
  purpose: string | null;
  goal: string | null;
  plan: string | null;
  line: string | null;
  /** The one number that best shows how it is doing — only numbers the review read. */
  measure: PlainMeasure | null;
  stage: string | null;
  verdict: Verdict;
  verdictRaw: string;
  evidence: string | null;
  evidenceReadToday: boolean | null;
  measures: string | null;
  rule: string | null;
  decision: string | null;
  action: string | null;
  commitments: string[];
  expectedBy: string | null;
  shippedAt: string | null;
}

export interface PlainMeasure {
  what: string;
  now: string;
  target: string | null;
  before: string | null;
  trend: 'better' | 'worse' | 'flat' | 'unknown';
}

const TRENDS = new Set(['better', 'worse', 'flat', 'unknown']);
function parseMeasure(v: unknown): PlainMeasure | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const m = v as Record<string, unknown>;
  const what = clip(m.what, 60);
  const now = clip(m.now, 40);
  if (!what || !now) return 'invalid';
  const trend = typeof m.trend === 'string' && TRENDS.has(m.trend) ? m.trend as PlainMeasure['trend'] : 'unknown';
  return { what, now, target: clip(m.target, 40), before: clip(m.before, 40), trend };
}

export interface ParsedReview {
  date: string;
  format: 'json' | 'md';
  fileName: string;
  rows: ReviewRow[];
  duplicatesDropped: number;
  unparsedRows: number;
}

export type ReviewParseResult =
  | { ok: true; review: ParsedReview }
  | { ok: false; fileName: string; reason: string };

function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (DATE_RE.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function normalizeVerdict(raw: string): Verdict {
  const w = raw.trim().toLowerCase().replace(/^\*+|\*+$/g, '').split(/[\s(]/)[0] ?? '';
  if ((VERDICTS as readonly string[]).includes(w)) return w as KnownVerdict;
  if (w === 'retire') return 'retire-pending';
  return 'other';
}

/** Date-only strings mean that calendar day; compare at the END of it. */
export function dateMs(s: string): number {
  if (DATE_RE.test(s)) return Date.parse(`${s}T23:59:59.999Z`);
  return Date.parse(s);
}

/** The latest calendar day a review may carry: tomorrow, relative to `now`. */
function latestAllowedDate(now: number): string {
  return new Date(now + DAY_MS).toISOString().slice(0, 10);
}

/** Validate a `maturation-review/1` JSON document (spec §2). Rejected whole on any field failure. */
export function parseReviewJson(fileName: string, text: string, now: number): ReviewParseResult {
  const m = REVIEW_FILE_RE.exec(fileName);
  if (!m) return { ok: false, fileName, reason: 'file-name' };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, fileName, reason: 'invalid-json' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, fileName, reason: 'not-an-object' };
  const d = doc as Record<string, unknown>;
  if (d.schema !== REVIEW_SCHEMA) return { ok: false, fileName, reason: 'schema' };
  if (typeof d.date !== 'string' || !DATE_RE.test(d.date)) return { ok: false, fileName, reason: 'date' };
  if (d.date !== m[1]) return { ok: false, fileName, reason: 'date-mismatch' };
  if (d.date > latestAllowedDate(now)) return { ok: false, fileName, reason: 'date-in-future' };
  if (!Array.isArray(d.features) || d.features.length < 1 || d.features.length > MAX_FEATURES) {
    return { ok: false, fileName, reason: 'features' };
  }
  const seen = new Set<string>();
  const rows: ReviewRow[] = [];
  let duplicatesDropped = 0;
  for (let i = 0; i < d.features.length; i++) {
    const f = d.features[i] as Record<string, unknown>;
    if (!f || typeof f !== 'object') return { ok: false, fileName, reason: `features[${i}]` };
    if (typeof f.id !== 'string' || !ID_RE.test(f.id)) return { ok: false, fileName, reason: `features[${i}].id` };
    if (typeof f.verdict !== 'string' || !f.verdict.trim()) return { ok: false, fileName, reason: `features[${i}].verdict` };
    const commitments = f.commitments ?? [];
    if (!Array.isArray(commitments) || commitments.length > MAX_COMMITMENTS_PER_ROW
      || commitments.some(c => typeof c !== 'string' || !CMT_RE.test(c))) {
      return { ok: false, fileName, reason: `features[${i}].commitments` };
    }
    if (f.evidenceReadToday !== undefined && f.evidenceReadToday !== null && typeof f.evidenceReadToday !== 'boolean') {
      return { ok: false, fileName, reason: `features[${i}].evidenceReadToday` };
    }
    for (const k of ['expectedBy', 'shippedAt'] as const) {
      if (f[k] !== undefined && f[k] !== null && isoOrNull(f[k]) === null) {
        return { ok: false, fileName, reason: `features[${i}].${k}` };
      }
    }
    const measure = parseMeasure(f.measure);
    if (measure === 'invalid') return { ok: false, fileName, reason: `features[${i}].measure` };
    if (seen.has(f.id)) { duplicatesDropped++; continue; }
    seen.add(f.id);
    const verdictRaw = clip(f.verdict, 64) ?? '';
    rows.push({
      id: f.id,
      title: clip(f.title, MAX_SHORT),
      area: clip(f.area, 40),
      summary: clip(f.summary, 240),
      nextStep: clip(f.nextStep, 200),
      purpose: clip(f.purpose, 160),
      goal: clip(f.goal, 160),
      plan: clip(f.plan, 160),
      line: clip(f.line, 120),
      measure,
      stage: clip(f.stage, 32),
      verdict: normalizeVerdict(verdictRaw),
      verdictRaw,
      evidence: clip(f.evidence, MAX_TEXT),
      evidenceReadToday: typeof f.evidenceReadToday === 'boolean' ? f.evidenceReadToday : null,
      measures: clip(f.measures, MAX_TEXT),
      rule: clip(f.rule, MAX_TEXT),
      decision: clip(f.decision, MAX_TEXT),
      action: clip(f.action, MAX_TEXT),
      commitments: [...new Set(commitments as string[])],
      expectedBy: isoOrNull(f.expectedBy),
      shippedAt: isoOrNull(f.shippedAt),
    });
  }
  return { ok: true, review: { date: d.date, format: 'json', fileName, rows, duplicatesDropped, unparsedRows: 0 } };
}

/**
 * Read the `## Full table` of a markdown review (the format before 2026-10-30):
 * rows starting with a backticked id and exactly five cells. A row that does
 * not fit is counted as unparsed — never guessed.
 */
export function parseReviewMarkdown(fileName: string, text: string, now: number): ReviewParseResult {
  const m = REVIEW_FILE_RE.exec(fileName);
  if (!m) return { ok: false, fileName, reason: 'file-name' };
  const date = m[1];
  if (date > latestAllowedDate(now)) return { ok: false, fileName, reason: 'date-in-future' };
  const start = text.search(/^## Full table\s*$/m);
  if (start < 0) return { ok: false, fileName, reason: 'no-full-table' };
  const after = text.slice(start + 1);
  const next = after.search(/^## /m);
  const section = next >= 0 ? after.slice(0, next) : after;
  const seen = new Set<string>();
  const rows: ReviewRow[] = [];
  let duplicatesDropped = 0;
  let unparsedRows = 0;
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-/.test(line) || /^\|\s*Feature\s*\|/i.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const idCell = cells[0] ?? '';
    const idMatch = /^`([^`]+)`/.exec(idCell);
    if (cells.length !== 5 || !idMatch || !ID_RE.test(idMatch[1])) { unparsedRows++; continue; }
    const id = idMatch[1];
    if (seen.has(id)) { duplicatesDropped++; continue; }
    seen.add(id);
    const [, verdictCell, evidence, decision, action] = cells;
    const carried = /\(carried\)/i.test(line);
    rows.push({
      id,
      title: null,
      area: null,
      summary: null,
      nextStep: null,
      purpose: null,
      goal: null,
      plan: null,
      line: null,
      measure: null,
      stage: null,
      verdict: normalizeVerdict(verdictCell),
      verdictRaw: verdictCell.slice(0, 64),
      evidence: clip(evidence, MAX_TEXT),
      evidenceReadToday: !carried,
      measures: null,
      rule: null,
      decision: clip(decision, MAX_TEXT),
      action: clip(action, MAX_TEXT),
      commitments: [...new Set(action.match(/CMT-\d{1,8}/g) ?? [])].slice(0, MAX_COMMITMENTS_PER_ROW),
      expectedBy: null,
      shippedAt: null,
    });
    if (rows.length >= MAX_FEATURES) break;
  }
  if (rows.length === 0) return { ok: false, fileName, reason: 'no-rows' };
  return { ok: true, review: { date, format: 'md', fileName, rows, duplicatesDropped, unparsedRows } };
}

/** Newest valid review by date; ties prefer JSON. */
export function pickLatest(reviews: ParsedReview[]): ParsedReview | null {
  let best: ParsedReview | null = null;
  for (const r of reviews) {
    if (!best || r.date > best.date || (r.date === best.date && r.format === 'json' && best.format === 'md')) best = r;
  }
  return best;
}

/** One review per date (JSON wins a tie), oldest first, at most MAX_HISTORY. */
export function historySeries(reviews: ParsedReview[]): ParsedReview[] {
  const byDate = new Map<string, ParsedReview>();
  for (const r of reviews) {
    const cur = byDate.get(r.date);
    if (!cur || (r.format === 'json' && cur.format === 'md')) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-MAX_HISTORY);
}

// ── Live owner facts ───────────────────────────────────────────────────────

export type OwnerSource = 'd7' | 'rollout' | 'dark-flag' | 'guard';

export interface OwnerEntry {
  machine: string;
  source: OwnerSource;
  /** The owner's own id for this record (guard key, initiative id, D7 featureId). */
  ownerId: string;
  /** Extra ids this record may be known by (e.g. a rollout's flagPath). */
  aliases?: string[];
  facts: Record<string, string | number | boolean | null>;
  at: string | null;
  deadline?: { date: string; open: boolean; milestone: string } | null;
  transitions?: Array<{ at: string; from: string | null; to: string }>;
}

export interface CommitmentFact {
  id: string;
  status: string;
  createdAt: string | null;
  /** The promised date (CommitmentTracker `checkInAt`) — the only commitment field read as a deadline. */
  checkInAt: string | null;
  /** PromiseBeacon's moving nudge marker — shown as "next check-in", never as a deadline. */
  nextUpdateDueAt: string | null;
  resolvedAt: string | null;
}

export interface SourceStatus {
  name: string;
  machine: string | null;
  machineId?: string;
  machineIds?: string[];
  ok: boolean;
  reason?: string;
  at?: string | null;
}

export interface BoardInput {
  now: number;
  /** Valid reviews from the one chosen review machine. */
  reviews: ParsedReview[];
  reviewMachine: string | null;
  /** Live owner facts from every machine that answered. */
  owners: OwnerEntry[];
  /** Commitment projection from the review machine; null ⇒ unavailable (follow-up reads `unknown`). */
  commitments: Map<string, CommitmentFact> | null;
  /** Initiatives with an explicit link (id or rollout.flagPath) — from the review machine; null ⇒ unavailable. */
  linkedInitiatives: Array<{ id: string; flagPath: string | null; title: string; status: string; nextCheckAt: string | null }> | null;
  sources: SourceStatus[];
  scope: 'local' | 'pool';
  /** When the review rows could not be fetched (offline rule). */
  reviewUnavailable?: { machine: string; since: string | null } | null;
  /** When the review rows come from an in-memory cache (offline rule). */
  reviewCachedAt?: string | null;
}

export type FollowUpState = 'linked' | 'none-linked' | 'unknown';
export type BoardFlag = 'carried-evidence' | 'no-evidence' | 'ambiguous-join' | 'not-in-latest-review';

export interface BoardDeadline {
  date: string;
  source: 'review' | 'commitment' | 'dark-flag';
  ref: string;
  milestone: string;
  open: boolean;
  overdueDays: number | null;
  machine: string | null;
}

export interface BoardConflict { rule: 'C1' | 'C2' | 'C3' | 'C4'; machine: string; a: string; b: string }

export interface BoardFeature {
  id: string;
  title: string | null;
  review: null | {
    date: string;
    verdict: Verdict;
    verdictRaw: string;
    area: string | null;
    summary: string | null;
    nextStep: string | null;
    purpose: string | null;
    goal: string | null;
    plan: string | null;
    line: string | null;
    measure: PlainMeasure | null;
    stage: string | null;
    evidence: string | null;
    evidenceReadToday: boolean | null;
    measures: string | null;
    rule: string | null;
    decision: string | null;
    action: string | null;
    commitments: string[];
  };
  history: Array<{ date: string; verdict: Verdict; carried: boolean }>;
  unchangedReviews: number;
  shippedAt: { date: string; source: 'review' } | null;
  transitions: Array<{ at: string; from: string | null; to: string; source: 'dark-flag'; machine: string }>;
  owners: Array<{ machine: string; source: OwnerSource; ownerId: string; facts: OwnerEntry['facts']; at: string | null }>;
  deadlines: BoardDeadline[];
  followUp: { state: FollowUpState; items: Array<{ ref: string; kind: 'commitment' | 'initiative'; status: string; label: string; due: string | null; nextCheckIn: string | null }> };
  conflicts: BoardConflict[];
  flags: BoardFlag[];
}

export interface BoardCounts {
  features: number;
  reviewed: number;
  byVerdict: Record<string, number>;
  /** Rows whose review verdict is stalled, regressed or blind (named, never combined under a board word). */
  stalledRegressedBlind: number;
  stalledRegressedBlindNoFollowUp: number;
  stalledRegressedBlindFollowUpUnknown: number;
  withDate: number;
  pastDate: number;
  conflicts: number;
  live: number;
}

export interface MaturationBoardResponse {
  schema: typeof BOARD_SCHEMA;
  advisory: true;
  authority: 'none';
  generatedAt: string;
  scope: 'local' | 'pool';
  reviewDate: string | null;
  reviewMachine: string | null;
  reviewState: 'ok' | 'cached' | 'unavailable' | 'none';
  reviewCachedAt: string | null;
  sources: SourceStatus[];
  counts: BoardCounts;
  excluded: { ambiguousJoins: number; unparsedRows: number; duplicatesDropped: number };
  features: BoardFeature[];
}

const STALLED_REGRESSED_BLIND = new Set<Verdict>(['blind', 'stalled', 'regressed']);

/** Ids an owner record answers to. `x.enabled` also answers to `x`. */
function ownerKeys(o: OwnerEntry): string[] {
  const keys = new Set<string>([o.ownerId, ...(o.aliases ?? [])]);
  for (const k of [...keys]) if (k.endsWith('.enabled')) keys.add(k.slice(0, -'.enabled'.length));
  return [...keys];
}

/** CommitmentStatus: pending | verified | violated | expired | withdrawn | delivered. Only `pending` is open. */
function commitmentOpen(c: CommitmentFact): boolean {
  return !c.resolvedAt && c.status === 'pending';
}

/** A delivered commitment means the item was assigned — never that the fix landed. */
export function commitmentLabel(c: CommitmentFact): string {
  if (c.status === 'delivered') return 'handed off';
  return c.status;
}

function overdueDays(date: string, open: boolean, now: number): number | null {
  if (!open) return null;
  const t = dateMs(date);
  if (!Number.isFinite(t) || t >= now) return null;
  return Math.max(1, Math.floor((now - t) / DAY_MS));
}

/** Build the board. Pure: same input → same output. */
export function buildMaturationBoard(input: BoardInput): MaturationBoardResponse {
  const { now } = input;
  const series = historySeries(input.reviews);
  const latest = series.length ? series[series.length - 1] : null;
  const latestRows = new Map<string, ReviewRow>((latest?.rows ?? []).map(r => [r.id, r]));

  // Index owners by every key they answer to, per (machine, source) for ambiguity detection.
  const ownersByKey = new Map<string, OwnerEntry[]>();
  for (const o of input.owners) {
    for (const k of ownerKeys(o)) {
      const list = ownersByKey.get(k) ?? [];
      list.push(o);
      ownersByKey.set(k, list);
    }
  }

  // Universe: latest review rows, then owner records no reviewed row claimed.
  const claimed = new Set<OwnerEntry>();
  const ids: string[] = [...latestRows.keys()];
  for (const id of ids) for (const o of ownersByKey.get(id) ?? []) claimed.add(o);
  const extraIds = new Set<string>();
  for (const o of input.owners) {
    if (claimed.has(o)) continue;
    // A rollout or dark-flag/D7 record is a maturing feature; a bare guard row is not.
    if (o.source === 'guard') continue;
    const key = o.ownerId.endsWith('.enabled') ? o.ownerId.slice(0, -'.enabled'.length) : o.ownerId;
    extraIds.add(key);
  }
  for (const id of extraIds) if (!latestRows.has(id)) ids.push(id);

  let ambiguousJoins = 0;
  const features: BoardFeature[] = [];

  for (const id of ids) {
    const row = latestRows.get(id) ?? null;
    const flags: BoardFlag[] = [];
    const attached = ownersByKey.get(id) ?? [];

    // Ambiguity: the same (machine, source) offers two different owner ids for this key.
    const perSlot = new Map<string, Set<string>>();
    for (const o of attached) {
      const slot = `${o.machine}\u0000${o.source}`;
      const set = perSlot.get(slot) ?? new Set<string>();
      set.add(o.ownerId);
      perSlot.set(slot, set);
    }
    let ambiguous = [...perSlot.values()].some(s => s.size > 1);
    // …or one owner id that also aliases to a different reviewed id.
    if (!ambiguous) {
      ambiguous = attached.some(o => ownerKeys(o).some(k => k !== id && latestRows.has(k)));
    }
    if (ambiguous) { flags.push('ambiguous-join'); ambiguousJoins++; }

    // History over freshly-read and carried rows.
    const history: BoardFeature['history'] = [];
    for (const rev of series) {
      const r = rev.rows.find(x => x.id === id);
      if (r) history.push({ date: rev.date, verdict: r.verdict, carried: r.evidenceReadToday === false });
    }
    let unchangedReviews = 0;
    if (history.length) {
      const last = history[history.length - 1];
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.carried || h.verdict !== last.verdict) break;
        unchangedReviews++;
      }
    }

    if (row) {
      if (row.evidenceReadToday === false) flags.push('carried-evidence');
      if ((row.verdict === 'ready' || row.verdict === 'on-track' || row.verdict === 'live') && !row.evidence) flags.push('no-evidence');
    } else if (latest) {
      flags.push('not-in-latest-review');
    }

    // Deadlines.
    const deadlines: BoardDeadline[] = [];
    const reviewDone = row ? (row.verdict === 'live' || row.verdict === 'ready') : false;
    if (row?.expectedBy) {
      const open = !reviewDone;
      deadlines.push({ date: row.expectedBy, source: 'review', ref: latest!.date, milestone: 'review expected-by', open, overdueDays: overdueDays(row.expectedBy, open, now), machine: input.reviewMachine });
    }

    // Follow-up: explicit links only.
    const items: BoardFeature['followUp']['items'] = [];
    let unknown = false;
    for (const cid of row?.commitments ?? []) {
      if (!input.commitments) { unknown = true; continue; }
      const c = input.commitments.get(cid);
      if (!c) { items.push({ ref: cid, kind: 'commitment', status: 'unknown-id', label: 'unknown id', due: null, nextCheckIn: null }); continue; }
      const open = commitmentOpen(c);
      items.push({ ref: cid, kind: 'commitment', status: c.status, label: commitmentLabel(c), due: c.checkInAt, nextCheckIn: c.nextUpdateDueAt });
      if (c.checkInAt) {
        deadlines.push({ date: c.checkInAt, source: 'commitment', ref: cid, milestone: 'promised date', open, overdueDays: overdueDays(c.checkInAt, open, now), machine: input.reviewMachine });
      }
    }
    if (input.linkedInitiatives === null) {
      unknown = true;
    } else {
      for (const ini of input.linkedInitiatives) {
        if (ini.id === id || (ini.flagPath && (ini.flagPath === id || ini.flagPath === `${id}.enabled`))) {
          items.push({ ref: ini.id, kind: 'initiative', status: ini.status, label: ini.status, due: null, nextCheckIn: ini.nextCheckAt });
        }
      }
    }
    const followState: FollowUpState = items.length ? 'linked' : unknown ? 'unknown' : 'none-linked';

    // Owner entries, transitions, owner deadlines.
    const owners: BoardFeature['owners'] = [];
    const transitions: BoardFeature['transitions'] = [];
    for (const o of attached) {
      owners.push({ machine: o.machine, source: o.source, ownerId: o.ownerId, facts: o.facts, at: o.at });
      // Dated stage history exists only in the dark-flag registry (rollout records keep the current stage only).
      if (o.source === 'dark-flag') {
        for (const t of o.transitions ?? []) transitions.push({ ...t, source: 'dark-flag', machine: o.machine });
      }
      if (o.deadline && o.source === 'dark-flag') {
        deadlines.push({ date: o.deadline.date, source: 'dark-flag', ref: o.ownerId, milestone: o.deadline.milestone, open: o.deadline.open, overdueDays: overdueDays(o.deadline.date, o.deadline.open, now), machine: o.machine });
      }
    }
    transitions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    deadlines.sort((a, b) => dateMs(a.date) - dateMs(b.date));

    // Closed conflict table, per machine.
    const conflicts: BoardConflict[] = [];
    if (row) {
      for (const o of attached) {
        const f = o.facts;
        if (o.source === 'guard' && ['live', 'ready', 'on-track'].includes(row.verdict)
          && typeof f.effective === 'string' && ['errored', 'missing', 'off-runtime-divergent'].includes(f.effective)) {
          conflicts.push({ rule: 'C1', machine: o.machine, a: `review: ${row.verdict}`, b: `guard: ${f.effective}` });
        }
        if (o.source === 'rollout' && row.verdict === 'live' && f.stage === 'dark' && o.machine === input.reviewMachine) {
          conflicts.push({ rule: 'C2', machine: o.machine, a: 'review: live', b: 'rollout stage: dark' });
        }
        if (o.source === 'd7' && row.verdict === 'blind' && f.status === 'ready') {
          conflicts.push({ rule: 'C3', machine: o.machine, a: 'review: blind', b: 'D7: ready' });
        }
        if (o.source === 'd7' && row.verdict === 'ready' && typeof f.status === 'string'
          && ['hold', 'stale-evidence', 'insufficient-evidence'].includes(f.status)) {
          conflicts.push({ rule: 'C4', machine: o.machine, a: 'review: ready', b: `D7: ${f.status}` });
        }
      }
    }

    const title = row?.title ?? null;
    features.push({
      id,
      title,
      review: row ? {
        date: latest!.date,
        verdict: row.verdict,
        verdictRaw: row.verdictRaw,
        area: row.area,
        summary: row.summary,
        nextStep: row.nextStep,
        purpose: row.purpose,
        goal: row.goal,
        plan: row.plan,
        line: row.line,
        measure: row.measure,
        stage: row.stage,
        evidence: row.evidence,
        evidenceReadToday: row.evidenceReadToday,
        measures: row.measures,
        rule: row.rule,
        decision: row.decision,
        action: row.action,
        commitments: row.commitments,
      } : null,
      history,
      unchangedReviews,
      shippedAt: row?.shippedAt ? { date: row.shippedAt, source: 'review' } : null,
      transitions,
      owners,
      deadlines,
      followUp: { state: followState, items: items.slice(0, 16) },
      conflicts,
      flags,
    });
    if (features.length >= MAX_FEATURES) break;
  }

  const counts: BoardCounts = {
    features: features.length,
    reviewed: features.filter(f => f.review).length,
    byVerdict: {},
    stalledRegressedBlind: 0,
    stalledRegressedBlindNoFollowUp: 0,
    stalledRegressedBlindFollowUpUnknown: 0,
    withDate: 0,
    pastDate: 0,
    conflicts: 0,
    live: 0,
  };
  for (const f of features) {
    const v = f.review?.verdict ?? 'not-reviewed';
    counts.byVerdict[v] = (counts.byVerdict[v] ?? 0) + 1;
    if (f.review && STALLED_REGRESSED_BLIND.has(f.review.verdict)) {
      counts.stalledRegressedBlind++;
      if (f.followUp.state === 'none-linked') counts.stalledRegressedBlindNoFollowUp++;
      if (f.followUp.state === 'unknown') counts.stalledRegressedBlindFollowUpUnknown++;
    }
    if (f.deadlines.length) counts.withDate++;
    if (f.deadlines.some(d => d.overdueDays !== null)) counts.pastDate++;
    if (f.conflicts.length) counts.conflicts++;
    if (f.review?.verdict === 'live') counts.live++;
  }

  const reviewState: MaturationBoardResponse['reviewState'] = input.reviewUnavailable && !latest
    ? 'unavailable'
    : input.reviewCachedAt ? 'cached' : latest ? 'ok' : 'none';

  return {
    schema: BOARD_SCHEMA,
    advisory: true,
    authority: 'none',
    generatedAt: new Date(now).toISOString(),
    scope: input.scope,
    reviewDate: latest?.date ?? null,
    reviewMachine: input.reviewMachine,
    reviewState,
    reviewCachedAt: input.reviewCachedAt ?? null,
    sources: input.sources,
    counts,
    excluded: {
      ambiguousJoins,
      unparsedRows: latest?.unparsedRows ?? 0,
      duplicatesDropped: latest?.duplicatesDropped ?? 0,
    },
    features,
  };
}
