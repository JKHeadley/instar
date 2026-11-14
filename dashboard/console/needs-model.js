// The one list of states that need the operator (docs/specs/operator-needs-first-screen.md).
// Home's count and headline come from it, and every state's own page leads with it, so
// neither can miss one. Pure: it reads nothing itself and touches no DOM. Rows are built with
// each page's own model, so Home and the page cannot disagree.

import { buildShipping, stoppedLead, operatorTodos, sourceState, agentOwnedStop } from './development-model.js';
import { buildAccountsPage } from './accounts-model.js';
import { pairingModel, waitingCards } from './agents-model.js';
import { buildApprovals } from './mandates-model.js';
import { buildPlansPage } from './plans-model.js';
import { buildRequests } from './secrets-model.js';
import { spendingNeed } from './costs-model.js';
import { healthNeedRows } from './health-model.js';
import { proposalsNeedingVerdict, buildPending } from './learned-model.js';

// warning-path: inline
const row = (key, main, sub, href, refs = []) => ({ key: `need:${key}`, main, sub: sub || '', tone: 'attn', refs, action: { kind: 'href', href } });

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
  // First, so a real problem leads Home. Only what affects the person. Internal notes stay on the Health page and never raise this count.
  { id: 'health', page: 'capacity/health', reads: { issues: '/mobile/health-issues' },
    rows: ({ issues }) => { const rows = healthNeedRows(issues); return rows === null ? UNREADABLE : rows.map((r) => row(`health:${r.key}`, r.title, r.detail, r.href)); } },
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
      return page.needs.map((n) => row(`account:${n.key}`, n.title, n.sub, '#/capacity/accounts?s=needs', [String(n.label || '').split(' · ').pop()].filter(Boolean)));
    } },
  { id: 'agents', page: 'people/agents', reads: { pairing: '/threadline/pairing', invites: '/threadline/pairing/invites' },
    rows: ({ pairing, invites }, now) => waitingCards(pairingModel(pairing, invites, undefined, now), now)
      .map((c, i) => row(`agent:${c.kind}:${c.iid || c.id || i}`, c.title, '', '#/people/agents')) },
  { id: 'approvals', page: 'people/mandates', reads: { approvals: '/authorization-requests?status=pending' },
    rows: ({ approvals }) => { const a = buildApprovals(approvals); return a.ok ? a.rows.map((r) => row(r.key, r.headline, r.reason, '#/people/mandates?s=waiting')) : UNREADABLE; } },
  { id: 'plans', page: 'work/plans', reads: { initiatives: '/initiatives', blockers: '/blockers' },
    rows: ({ initiatives, blockers }, now) => {
      const page = buildPlansPage({ initiatives, blockers }, now);
      if (!page.ok) return UNREADABLE;
      return page.sections.needsYou.map((r) => row(`plan:${r.key}`, r.main, r.needs, '#/work/plans?s=needsYou'));
    } },
  // Chief of Staff (chief-of-staff-topic.md §5): what its projects need from the owner. 503 = feature off = nothing waiting.
  { id: 'chief-of-staff', page: 'work/chats', reads: { cos: '/chief-of-staff' },
    rows: ({ cos }, now) => chiefOfStaffNeedRows(cos, now) },
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
];

/**
 * Where a console file says a state needs the operator and it is NOT one of the sources.
 * Exact phrases, each with its reason, so a real need added to one of these pages still
 * fails the floor. `file` + `phrase` must both match the line.
 */
export const NEED_EXEMPT = [
  { file: 'home-model.js', phrase: '', why: 'Home itself: this is the card the sources feed.' },
  { file: 'console.js', phrase: 'What needs you', why: 'Home itself: the card title.' },
  { file: 'nav-model.js', phrase: 'waiting', why: 'A navigation description of the page, not a state.' },
  { file: 'promises-model.js', phrase: '', why: 'Already on Home; the operator decided 2026-11-02 that only promises due within 24 hours count.' },
  { file: 'promises.js', phrase: '', why: 'As promises-model.js.' },
  { file: 'allowed-model.js', phrase: 'will wait for your approval', why: 'Describes what a safety profile means, not something waiting now.' },
  { file: 'pace-model.js', phrase: 'waiting on you', why: 'A verdict on queue pace; the items themselves appear in their own sources.' },
  { file: 'sessions-model.js', phrase: 'Waiting on you', why: 'A comment-like note that sessions do not report this; nothing waits.' },
];

const failedRead = (res) => sourceState(res) === 'failed';

/**
 * known: id → { results, rows?, rowsAt? }, Home's reads so far. Returns the rows that need the
 * operator, plus which sources are unread (say "checking", never "quiet") or failed (say
 * partial, never "quiet"). A failed read keeps its last good rows for graceMs. 503 means off.
 */
export function surfacedNeeds(known, now = Date.now(), graceMs = 120000) {
  const out = { rows: [], pending: [], failed: [] };
  for (const s of NEED_SOURCES) {
    const k = known && known[s.id];
    if (s.when && !s.when(known || {})) continue;
    if (!k || !k.results) { if (!s.when) out.pending.push(s.id); continue; } // a conditional source is read on a later tick and never holds the headline
    const reads = Object.values(k.results);
    if (reads.every((r) => sourceState(r) === 'off')) continue; // switched off here; a page's builder handles one optional read being off
    if (reads.some(failedRead)) {
      out.failed.push(s.id);
      if (k.rows && now - (k.rowsAt || 0) <= graceMs) out.rows.push(...k.rows);
      continue;
    }
    const rows = s.rows(k.results, now);
    if (rows === UNREADABLE) { out.failed.push(s.id); if (k.rows && now - (k.rowsAt || 0) <= graceMs) out.rows.push(...k.rows); continue; }
    k.rows = rows;
    k.rowsAt = now;
    out.rows.push(...rows);
  }
  return out;
}
