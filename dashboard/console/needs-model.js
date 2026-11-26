// The one list of states that need the operator (docs/specs/operator-needs-first-screen.md).
// The Needs-you list (GET /needs, work-front-doors.md decision 2) and Home's headline come from it,
// and every state's own page leads with it, so neither can miss one. Pure: it reads nothing itself and touches no DOM. Rows are built with
// each page's own model, so Home and the page cannot disagree.

import { buildShipping, stoppedLead, operatorTodos, sourceState, agentOwnedStop } from './development-model.js';
import { buildAccountsPage } from './accounts-model.js';
import { pairingModel, waitingCards } from './agents-model.js';
import { buildTrustRequests } from './allowed-model.js';
import { buildApprovals } from './mandates-model.js';
import { buildPlansPage } from './plans-model.js';
import { buildRequests } from './secrets-model.js';
import { spendingNeed } from './costs-model.js';
import { healthNeedRows } from './health-model.js';
import { proposalsNeedingVerdict, buildPending } from './learned-model.js';
import { contextNeeds } from './context-model.js';
import { workBoardNeedRows } from './work-model.js';
import { repoNeedRows, REPOS_READ } from './repos-model.js';

// warning-path: inline
const row = (key, main, sub, href, refs = []) => ({ key: `need:${key}`, main, sub: sub || '', tone: 'attn', refs, action: { kind: 'href', href } });

/** Needs-you rows for documents that ask the owner to decide (document-decisions.md §3.7). */
export function documentDecisionNeedRows(res) {
  if (!res) return UNREADABLE;
  if (!res.ok) return sourceState(res) === 'off' ? [] : UNREADABLE;
  const docs = res.data && Array.isArray(res.data.documents) ? res.data.documents : null;
  if (!docs) return UNREADABLE;
  return docs.filter((d) => d && typeof d.id === 'string').map((d) => row(`doc-decision:${d.id}`, `Decide: ${d.title || 'a document'}`,
    d.question ? `${d.question}${d.versionLabel ? ` (version ${d.versionLabel})` : ''}` : 'Open it on your phone to approve or decline.', `/docs/${d.id}`, [d.id]));
}

/** Current approval requests share the Allowed page's exact pending-request model. */
export function trustRequestNeedRows(trust, now) {
  if (sourceState(trust) === 'off') return [];
  const requests = buildTrustRequests(trust, now);
  return requests.ok ? requests.rows.map((r) => row(r.key, r.main, r.sub, '#/settings/allowed?s=approvals', [r.requestId])) : UNREADABLE;
}

/** A 200 that does not have the expected shape: it told us nothing, so never read it as "nothing waiting". */
const UNREADABLE = null;

/** Collapse whitespace and cut at a word boundary (never mid-word), with an ellipsis when anything was cut.
 *  The same rule as `cutAtWord` in src/core/ChiefOfStaffLoop.ts (tests/unit/console-chief-of-staff-needs.test.ts keeps them equal). */
export function cutAtWord(text, max) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const room = t.slice(0, Math.max(1, max - 1));
  const sp = t[room.length] === ' ' ? room.length : room.lastIndexOf(' ');
  const base = (sp >= Math.floor(max / 3) ? room.slice(0, sp) : room).replace(/[\s,;:.\-–—(]+$/, '');
  return `${base}…`;
}

/**
 * The rows the Conversations page's Chief of Staff card shows. Where the Needs-you list is on screen it
 * already lists every project's wait, so the card keeps only what that list cannot do on this page: the
 * check-in for a Chief of Staff that is paused or about to pause (2026-11-20 dashboard audit: two stacked
 * boxes repeated the same waits and pushed the page below the first screen on a phone).
 */
export function chiefOfStaffCardRows(rows, { stripShown = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return stripShown ? list.filter((r) => r && (r.key === 'need:cos:paused' || r.key === 'need:cos:expiring')) : list;
}

/** A short project name from its goal, the same rule as `shortProjectTitle` in src/core/ChiefOfStaffLoop.ts. */
export function shortProjectTitle(goal, max = 60) {
  const g = String(goal == null ? '' : goal).replace(/\s+/g, ' ').trim();
  if (!g) return 'Untitled project';
  const m = /^(.{3,}?)(?::\s|\s[—–-]\s|[.!?]\s)/.exec(g);
  return cutAtWord(m && m[1].length <= max ? m[1] : g, max);
}

/** Chief of Staff rows: parked / breaker-tripped projects, projects waiting on the owner, a paused or soon-expiring check-in lease. */
export function chiefOfStaffNeedRows(cos, now) {
  // Off (503) arrives as `{ ok: false, reason: 'switched off…' }` from the console's reader (no status); a real failure is unreadable.
  if (!cos || !cos.ok) return cos && (cos.status === 503 || /switched off/i.test(String(cos.reason || ''))) ? [] : UNREADABLE;
  const d = cos.data;
  if (!d || typeof d !== 'object' || !d.lease || typeof d.lease !== 'object' || !Array.isArray(d.projects)) return UNREADABLE;
  const out = [];
  const href = '#/work/chats';
  // Each project row opens that project's own conversation; the lease rows open the Chief of Staff page.
  const projectHref = (p) => (typeof p.conversationKey === 'string' && /^(app|telegram|slack):[A-Za-z0-9-]+$/.test(p.conversationKey) ? `#/work/chats?c=${encodeURIComponent(p.conversationKey)}` : href);
  // The server's short name (initiative title / conversation name / goal lead) when it sends one; else the same rule here.
  const title = (p) => (typeof p.title === 'string' && p.title.trim() ? cutAtWord(p.title, 60)
    : typeof p.goal === 'string' && p.goal.trim() ? shortProjectTitle(p.goal, 60) : String(p.conversationKey || 'a project'));
  for (const p of d.projects) {
    if (!p || typeof p !== 'object') continue;
    // The owner paused it (spec cos-owner-pause-record §3.3): they already decided, so it asks nothing of them.
    if (p.pausedBy) continue;
    if (p.breakerTripped) out.push(row(`cos:breaker:${p.conversationKey}`, `${title(p)} hit its weekly restart limit`, 'Unpark it or close it.', projectHref(p)));
    else if (p.parked) out.push(row(`cos:parked:${p.conversationKey}`, `${title(p)} is parked after ${p.restartsWithoutProgress || 0} restarts without progress`, 'Unpark it or close it.', projectHref(p)));
    else if (p.lastVerdict === 'waiting-on-user') out.push(row(`cos:waiting:${p.conversationKey}`, `${title(p)} is waiting on you`, '', projectHref(p)));
  }
  if (d.projects.length) {
    if (!d.lease.live) out.push(row('cos:paused', 'Your Chief of Staff is paused until you check in', 'Say anything in its conversation.', href));
    else if (typeof d.lease.expiresAt === 'string') {
      const left = Date.parse(d.lease.expiresAt) - (typeof now === 'number' ? now : Date.now());
      if (Number.isFinite(left) && left > 0 && left <= 24 * 3600 * 1000) out.push(row('cos:expiring', 'Your Chief of Staff pauses within a day unless you check in', '', href));
    }
  }
  return out;
}

export const NEED_SOURCES = [
  // First, so a real problem leads the Needs-you list. Only what affects the person. Internal notes stay on the Health page and never raise this count.
  { id: 'health', page: 'capacity/health', reads: { issues: '/mobile/health-issues' },
    rows: ({ issues }, _now, { raw = false } = {}) => {
      const rows = healthNeedRows(issues, { includeAgentWork: raw });
      return rows === null ? UNREADABLE : rows.map(r => ({
        ...row(`health:${r.key}`, r.title, r.detail, r.href), ...(r.ownerAction === false ? { ownerAction: false } : {}),
      }));
    } },
  // Work that exists on only one machine (no-data-loss-on-machine-death.md §1.4): a repository with no remote, or
  // unpushed work past the grace window. One row per machine per kind. 503 = the registry is off here = nothing waiting.
  { id: 'repos', page: 'capacity/repos', reads: { repos: REPOS_READ },
    // warning-path: inline
    rows: ({ repos }) => { const rows = repoNeedRows(repos); return rows === null ? UNREADABLE : rows.map((r) => ({ ...row(r.key, r.main, r.sub, r.href, r.refs), ownerAction: false, tone: r.kind === 'unknown' ? 'unknown' : 'bad' })); } },
  { id: 'merging', page: 'work/development', reads: { watcher: '/green-pr-automerge' },
    rows: ({ watcher }, now) => {
      if (agentOwnedStop(watcher.data)) return []; // the agent releases this itself; the page still shows it
      const lead = stoppedLead(buildShipping({ watcher }, now, {}));
      return lead ? [row('merging', lead.title, lead.detail, '#/work/development')] : [];
    } },
  { id: 'shipping-approvals', page: 'work/development', reads: { watcher: '/green-pr-automerge' },
    rows: ({ watcher }, now) => buildShipping({ watcher }, now, {}).rows.filter((r) => r.group === 'needs')
      .map((r) => row(`pr:${r.pr}`, `Pull request #${r.pr} needs your approval on GitHub`, '', '#/work/development?s=shipping', [`#${r.pr}`, `PR ${r.pr}`])) },
  // Four reads, on a slower beat, and only where the merge watcher says this is a maintainer's agent.
  { id: 'feedback', page: 'work/development', everyTicks: 4, when: (known) => sourceState(known.merging && known.merging.results && known.merging.results.watcher) === 'ok',
    reads: { readiness: '/feedback-factory/readiness-authorities/proposal', triageProposal: '/feedback-factory/triage/authority/proposal', execute: '/feedback-factory/execute/status', queue: '/feedback-factory/triage/queue' },
    rows: (r) => operatorTodos(r).map((t, i) => row(`feedback:${t.action || t.kind}:${i}`, t.sentence, t.detail, '#/work/development?s=feedback')) },
  { id: 'accounts', page: 'capacity/accounts', reads: { pool: '/subscription-pool?scope=pool', relogin: '/subscription-relogin?scope=pool' },
    rows: ({ pool, relogin }, now) => {
      const episodes = relogin.ok && Array.isArray(relogin.data && relogin.data.episodes) ? relogin.data.episodes : [];
      const blockers = relogin.ok && Array.isArray(relogin.data && relogin.data.blockers) ? relogin.data.blockers : [];
      const page = buildAccountsPage(pool, now, { episodes, blockers });
      if (!page.ok) return pool.data && pool.data.enabled === false ? [] : UNREADABLE;
      // A pool repair episode describes operations, not an authenticated request to this owner.
      return page.needs.map((n) => ({
        ...row(`account:${n.key}`, n.title, n.sub, '#/capacity/accounts?s=needs', [String(n.label || '').split(' · ').pop()].filter(Boolean)),
        ownerAction: false,
      }));
    } },
  { id: 'agents', page: 'people/agents', reads: { pairing: '/threadline/pairing', invites: '/threadline/pairing/invites' },
    rows: ({ pairing, invites }, now) => waitingCards(pairingModel(pairing, invites, undefined, now), now)
      .map((c, i) => row(`agent:${c.kind}:${c.iid || c.id || i}`, c.title, '', '#/people/agents')) },
  { id: 'trust-requests', page: 'settings/allowed', reads: { trust: '/trust/requests' },
    rows: ({ trust }, now) => trustRequestNeedRows(trust, now) },
  { id: 'approvals', page: 'people/mandates', reads: { approvals: '/authorization-requests?status=pending' },
    rows: ({ approvals }) => { const a = buildApprovals(approvals); return a.ok ? a.rows.map((r) => row(r.key, r.headline, r.reason, '#/people/mandates?s=waiting')) : UNREADABLE; } },
  { id: 'plans', page: 'work/plans', reads: { initiatives: '/initiatives', blockers: '/blockers' },
    rows: ({ initiatives, blockers }, now) => {
      // Plan tracking switched off here (503) means no plan is waiting, even when /blockers answers.
      if (sourceState(initiatives) === 'off') return [];
      const page = buildPlansPage({ initiatives, blockers }, now);
      if (!page.ok) return UNREADABLE;
      return page.sections.needsYou.map((r) => row(`plan:${r.key}`, r.main, r.needs, '#/work/plans?s=needsYou'));
    } },
  // Chief of Staff (chief-of-staff-topic.md §5): what its projects need from the owner. 503 = feature off = nothing waiting.
  { id: 'chief-of-staff', page: 'work/chats', reads: { cos: '/chief-of-staff' },
    rows: ({ cos }, now) => chiefOfStaffNeedRows(cos, now) },
  // Work board (work-board-asks.md §7 Home, Detectors "Waiting on you"): one row per card waiting on the owner. 503 = feature off = nothing waiting.
  { id: 'workBoard', page: 'work/board', reads: { wb: '/work-board' },
    rows: ({ wb }, now) => { const rows = workBoardNeedRows(wb, now); return rows === null ? UNREADABLE : rows.map((r) => ({ ...row(r.key, r.main, r.sub, r.href), ...(r.ownerAction === false ? { ownerAction: false } : {}), ...(r.cardId ? { board: { cardId: r.cardId, href: r.href, covers: r.covers || [], linkable: !!r.linkable, serverOwned: !!r.serverOwned, createdAt: r.createdAt || '' } } : {}) })); } },
  // Documents that ask the owner for a decision (document-decisions.md §3.7). 503 = documents off here = nothing waiting.
  { id: 'document-decisions', page: 'work/documents', reads: { waiting: '/docs/decisions/waiting' },
    rows: ({ waiting }) => documentDecisionNeedRows(waiting) },
  { id: 'secrets', page: 'people/secrets', reads: { pending: '/secrets/pending' },
    // Never the card's own key or link: both carry the one-time drop token.
    rows: ({ pending }, now) => {
      const reqs = buildRequests(pending, { now, names: {}, origin: '' });
      if (!reqs.ok) return UNREADABLE;
      return reqs.waiting.map((c, i) => row(`secret:${i}`, `Waiting for you to supply: ${c.label}`, c.leftWords, '#/people/secrets?s=waiting'));
    } },
  { id: 'spending', page: 'capacity/costs', reads: { status: '/routing-spend/enable-status' },
    rows: ({ status }) => { const n = spendingNeed(status); return n ? [row('spending', n.title, n.why, '#/capacity/costs')] : []; } },
  // Skill-learning proposals without a verdict (docs/specs/skill-learning-sentinel.md §3.10); 503 = the sentinel is off here.
  { id: 'skill-learning-proposals', page: 'settings/learned', reads: { status: '/skills/learned' },
    rows: ({ status }) => {
      const pending = proposalsNeedingVerdict(status.data);
      if (pending === null) return UNREADABLE;
      return pending.map((p) => row(`skill-proposal:${p.name}`, `I think I’ve learned to: ${p.description}`, 'Agree, or disagree with a reason, on the Learned page', '#/settings/learned?s=skills', [p.name]));
    } },
  // A learned skill written but not switched on until the operator's confirm/reject tap (skill-learning-sentinel.md §3.5, rung 2); 503 = the sentinel is off here.
  { id: 'learned-pending', page: 'settings/learned', reads: { status: '/skills/learned' },
    rows: ({ status }) => {
      const p = buildPending(status);
      if (!p.ok) return p.off ? [] : UNREADABLE;
      return p.rows.map((r) => row(`learned-pending:${r.name}`, `A new skill waits for your OK: ${r.body}`, 'Confirm or reject it on the Learned page', '#/settings/learned?s=pending', [r.name]));
    } },
  // Context budget (context-budget-layered-summaries.md §11): a memory refresh stuck past the watcher's own
  // settling time, an unreadable refresh record, or compression recovery that stopped working (one row per
  // machine). 503 = off here; a stale watcher heartbeat is "can't tell", never "nothing".
  // Read from the watcher's status only (cheap); the conversation names stay on the page itself.
  { id: 'context', page: 'settings/context', reads: { sentinel: '/context-budget/sentinel' },
    rows: ({ sentinel }, now, { raw = false } = {}) => {
      const needs = contextNeeds(sentinel.data, {}, now);
      if (needs === null) return UNREADABLE;
      // Keep the agent-owned diagnostic in the raw input so the gate can count it.
      return needs.filter(n => raw || n.requiresUserAction !== false).map(n => ({
        ...row(`context:${n.key}`, n.title, n.detail, '#/settings/context', n.ref ? [n.ref] : []),
        ...(n.requiresUserAction === false ? { ownerAction: false } : {}),
      }));
    } },
];

/**
 * Where a console file says a state needs the operator and it is NOT one of the sources.
 * Exact phrases, each with its reason, so a real need added to one of these pages still
 * fails the floor. `file` + `phrase` must both match the line.
 */
export const NEED_EXEMPT = [
  { file: 'home-model.js', phrase: '', why: 'Home itself: the card the sources feed, which the Needs-you list draws.' },
  { file: 'console.js', phrase: 'What needs you', why: 'Home itself: the card title.' },
  { file: 'needs-strip.js', phrase: '', why: 'The Needs-you strip itself: it draws GET /needs, which these sources feed.' },
  { file: 'nav-model.js', phrase: 'waiting', why: 'A navigation description of the page, not a state.' },
  { file: 'promises-model.js', phrase: '', why: 'Already in the Needs-you list; the operator decided 2026-11-02 that only promises due within 24 hours count.' },
  { file: 'promises.js', phrase: '', why: 'As promises-model.js.' },
  { file: 'allowed-model.js', phrase: 'will wait for your approval', why: 'Describes what a safety profile means, not something waiting now.' },
  { file: 'pace-model.js', phrase: 'waiting on you', why: 'A verdict on queue pace; the items themselves appear in their own sources.' },
  { file: 'sessions-model.js', phrase: 'Waiting on you', why: 'A comment-like note that sessions do not report this; nothing waits.' },
  { file: 'projects.js', phrase: 'Your agent suggests', why: 'Project app offers are optional suggestions shown on the project\'s Work row, not needs (docs/specs/project-apps.md §3.5); an unanswered offer waits for nothing.' },
  { file: 'projects-model.js', phrase: 'Your agent suggests', why: 'As projects.js: the words of an optional project app suggestion, never a Needs-you row.' },
  { file: 'projects-model.js', phrase: 'Waiting for your approval', why: 'A custom project app with no approved version mirrors its version card, which is already a Needs-you row through the Work board source (docs/specs/project-apps-sandbox.md §3.4); the project row only says why it has no Open button.' },
];

const failedRead = (res) => sourceState(res) === 'failed';

/** Plain words a linked row shows for its card: fixed, never the agent's own title (work-board-cards-appear §3). */
export const HAS_CARD_LABEL = 'Has a card on the work board';
/** The fixed label of a row that IS its card (needs-one-list): the card opens from the row itself. */
export const IS_CARD_LABEL = 'Opens its card on the work board';
/** The fixed words of the source's own link kept on a row that became its card. */
export const ALSO_OPENS_LABEL = 'Open the project conversation';
/** The covers namespace only the server writes (work-board-cards-appear §2: reserved `cos:`). */
const SERVER_COVERS = /^cos:/;

/**
 * Each need once (docs/specs/work-board-cards-appear.md §3, as amended 2026-11-18 "One row per Chief of Staff wait"). A card in the owner's shown
 * "Waiting on you" slice that says it is about other rows (`covers`) stands in for them in one of two ways:
 *
 * - The Chief of Staff's own wait card (server-owned, covering a row in the server-only `cos:` namespace) BECOMES that
 *   row: one row, with the card's title and words, whose action opens the card, whatever the card asks (an open wait or
 *   a Confirm done). The row keeps its key and source; the source's own action stays on it as `alsoOpens`. The card's
 *   own row is dropped. Both texts are the server's, so no agent text replaces a source's words.
 * - Any other card that only waits on the person to act (with the person, no Approve, no Confirm done, no open question,
 *   nothing outward) links the rows it covers: each keeps its own words, source and action and gains `card`. An agent
 *   session's card keeps its own row too, so an agent's card can never take over another source's button.
 *
 * Two cards on one row: the older card (creation time, then id) takes it. A card none of whose rows is present, or
 * that asks for Approve, an answer or something outward (other than the Chief of Staff's own), keeps its own row.
 * Pure: returns new rows, mutates none.
 */
export function linkCoveredRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const becomes = (c, k) => !!(c.board.serverOwned && SERVER_COVERS.test(k));
  const cards = list.filter((r) => r && r.board && Array.isArray(r.board.covers) && r.board.covers.length && (r.board.linkable || r.board.serverOwned))
    .sort((a, b) => String(a.board.createdAt).localeCompare(String(b.board.createdAt)) || String(a.board.cardId).localeCompare(String(b.board.cardId)));
  if (!cards.length) return list;
  // The plans source keys its rows `plan:` + the plan model's own key, which already reads `plan:<id>`; a card names `plan:<id>`.
  const keyOf = (r) => String(r && r.key || '').replace(/^need:/, '').replace(/^plan:plan:/, 'plan:');
  const present = new Map(list.filter((r) => r && !r.board).map((r) => [keyOf(r), r]));
  const linkedBy = new Map(); // row key -> card row
  const standsIn = new Set();
  for (const c of cards) {
    let any = false;
    for (const k of c.board.covers) {
      if (!present.has(k) || linkedBy.has(k)) continue;
      // A card that asks for more than the person's own act links a row only when it is the Chief of Staff's own mirror of it.
      if (!c.board.linkable && !becomes(c, k)) continue;
      linkedBy.set(k, c); any = true;
    }
    // Only a server-owned card (the Chief of Staff's mirror of its own row) drops its own row; an agent session's
    // card keeps its row, so an ask can never be made less visible by covering another item.
    if (any && c.board.serverOwned) standsIn.add(c);
  }
  if (!linkedBy.size) return list;
  const out = [];
  for (const r of list) {
    if (standsIn.has(r)) continue;
    const k = r && !r.board ? keyOf(r) : null;
    const c = k ? linkedBy.get(k) : null;
    if (!c) { out.push(r); continue; }
    if (becomes(c, k)) {
      // Only a link to the project's own conversation is kept (a malformed key falls back to the chats list, which is not it).
      const src = r.action && r.action.kind === 'href' && typeof r.action.href === 'string' && /^#\/work\/chats\?c=/.test(r.action.href) ? r.action.href : null;
      out.push({ ...r, main: c.main || r.main, sub: c.sub || r.sub, action: { kind: 'href', href: c.board.href },
        card: { id: c.board.cardId, href: c.board.href, label: IS_CARD_LABEL },
        ...(src && src !== c.board.href ? { alsoOpens: { href: src, label: ALSO_OPENS_LABEL } } : {}) });
    } else out.push({ ...r, card: { id: c.board.cardId, href: c.board.href, label: HAS_CARD_LABEL } });
  }
  return out;
}

/**
 * known: id → { results, rows?, rowsAt? }, Home's reads so far. Returns the rows that need the
 * operator, plus which sources are unread (say "checking", never "quiet") or failed (say
 * partial, never "quiet"). A failed read keeps its last good rows for graceMs. 503 means off.
 */
export function surfacedNeeds(known, now = Date.now(), graceMs = 120000, { raw = false } = {}) {
  const out = { rows: [], pending: [], failed: [] };
  const add = (source, rows) => out.rows.push(...(raw ? rows.map(row => ({ ...row, source })) : rows));
  for (const s of NEED_SOURCES) {
    const k = known && known[s.id];
    if (s.when && !s.when(known || {})) continue;
    if (!k || !k.results) { if (!s.when) out.pending.push(s.id); continue; } // a conditional source is read on a later tick and never holds the headline
    const reads = Object.values(k.results);
    if (reads.every((r) => sourceState(r) === 'off')) continue; // switched off here; a page's builder handles one optional read being off
    if (reads.some(failedRead)) {
      out.failed.push(s.id);
      if (k.rows && now - (k.rowsAt || 0) <= graceMs) add(s.id, k.rows);
      continue;
    }
    const rows = s.rows(k.results, now, { raw });
    if (rows === UNREADABLE) { out.failed.push(s.id); if (k.rows && now - (k.rowsAt || 0) <= graceMs) add(s.id, k.rows); continue; }
    k.rows = rows;
    k.rowsAt = now;
    add(s.id, rows);
  }
  if (!raw) out.rows = linkCoveredRows(out.rows);
  return out;
}
