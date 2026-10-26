// Shared counts — the ONE source every console page counts from.
//
// The four-perspective QA review of 2026-10-26 found the same root cause behind
// most findings: every page counted the same facts with its own formula, so Home
// disagreed with the pages it opened ("10 things need you" vs "11 sign-ins need
// you" vs "0 Needs you"; "784 open promises" vs 180; "8 safety checks off" vs
// "9 need a look" vs "40" vs "41"; "0.8/core" vs "no load reading"; "Nothing
// repeating" over rows "seen 5 times"). This module holds the definitions, as
// pure functions with no DOM access, and the page models import them. A summary
// number and the detail it summarises therefore come from one model, and the
// cross-page coherence test (tests/unit/console-cross-page-coherence.test.ts)
// holds that invariant over realistic fixtures.
//
// The operator's rules, in force here:
//   (c) "needs you" means ONLY a decision, approval or tap that the operator
//       alone can do. Sign-in repair, disk cleanup, merging the agent's own PRs,
//       re-minting invites are the agent's chores, never "need you".
//   (b) a summary number and its detail come from one model.
//
// Nothing here fetches: every function takes a fetch outcome
// ({ ok:true, data } | { ok:false, reason }) or plain records.

export const STALE_DAYS = 14;
export const DAY = 86400000;

export function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

/** "3 min ago", "2 h ago", "4 d ago". Returns null for unusable input. */
export function ago(ts, now = Date.now()) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** 'ok' when the read answered, 'off' when the route is switched off here (503), 'loading', else 'failed'. */
export function readState(res) {
  if (!res) return 'failed';
  if (res.state === 'loading') return 'loading';
  if (res.ok) return 'ok';
  return res.status === 503 || /switched off/.test(res.reason || '') ? 'off' : 'failed';
}

// ═══ Promises ══════════════════════════════════════════════════════════════
/** A promise the operator must answer or approve before the agent can move. */
export function waitsOnOperator(c) {
  return Boolean(c && (c.owner === 'user' || c.blockedOn === 'user-input' || c.blockedOn === 'user-authorization'));
}

/** The tracker's own active rule (CommitmentTracker.getActive), applied to every row. */
export function isActiveCommitment(c, now = Date.now()) {
  if (!c) return false;
  if (c.expiresAt && Date.parse(c.expiresAt) < now) return false;
  return c.status === 'pending' || c.status === 'verified' || c.status === 'violated';
}

/** When a promise was last touched (heartbeat, update or creation). */
export function lastTouched(c) {
  return Date.parse(c.lastHeartbeatAt || c.updatedAt || c.createdAt) || 0;
}

/** Missed: the tracker says violated, or a hard deadline passed while it was still open. */
export function isMissed(c, now = Date.now()) {
  if (!c) return false;
  if (c.status === 'violated') return true;
  const hard = Date.parse(c.hardDeadlineAt);
  return Number.isFinite(hard) && hard < now && isActiveCommitment(c, now);
}

/** Touched within the last 14 days. Older promises are listed under "Older, still open", out of every headline count. */
export function isFresh(c, now = Date.now()) { return now - lastTouched(c) <= STALE_DAYS * DAY; }

export const DUE_SOON_MS = DAY;
export const CLOSED_WINDOW_MS = 7 * DAY;

/** When this promise next expects something (the soonest real date it carries). */
export function nextDue(c) {
  const ts = [c.hardDeadlineAt, c.checkInAt, c.nextUpdateDueAt, c.softDeadlineAt]
    .map((t) => Date.parse(t)).filter(Number.isFinite);
  return ts.length ? Math.min(...ts) : null;
}

const byNewest = (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);

// A missed promise is a sentence that commits to a future action. A chat fragment with no
// such language ("Changing the schedule now", "Exactly what you asked for") is listed apart
// as "missedUnclear", never dropped: the model can only tell the wording, not whether anyone was waiting.
const PROMISE_LANGUAGE = /\b(?:I['’]ll|I will|we['’]ll|will|shortly|soon|back (?:with|in|shortly|soon|once|when|after)|report(?:ing)? back|going to|then I|once |when (?:it|that|the|I)|after (?:the|that|I|this)|next|by (?:morning|tonight|tomorrow|end of|EOD|\d)|coming|in (?:a|an|\d+) (?:minute|min|hour|day|few))\b/i;
export function looksLikePromise(c) {
  const text = String((c && (c.agentResponse || c.userRequest)) || '');
  if (!text.trim()) return false;
  return PROMISE_LANGUAGE.test(text) || /\b(?:deliver|send|post|merge|fix|check|confirm|finish|open|write|run|build|report|ship|land)\b/i.test(text) && /\b(?:I|me|my)\b/.test(text);
}
export const normText = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** One record per distinct FULL wording (newest kept); `repeats` maps a kept record to the records that said the same. */
function dedupeRecords(list, repeats) {
  const by = new Map();
  for (const c of list) {
    const k = normText(c.agentResponse || c.userRequest || c.id);
    const kept = by.get(k);
    if (!kept) { by.set(k, c); repeats.set(c, []); } else repeats.get(kept).push(c);
  }
  return [...by.values()];
}

/**
 * THE definition of "open" — one partition of every promise record, used by Home's
 * card, its "See all N" and the Promises page headline and sections:
 *   waiting      active, waits on the operator, touched within 14 days
 *   missed       violated or past its hard deadline, at any age (age is not evidence it was handled),
 *                worded as a promise; one entry per distinct wording
 *   missedUnclear the same, but the wording carries no promise language (listed apart, never dropped)
 *   dueSoon      active, carried by the agent, due within a day
 *   carrying     active, carried by the agent, touched within 14 days
 *   older        active, untouched for 14+ days (waiting or carried) — behind a tap, out of the counts
 *   closed       delivered / withdrawn / expired within the last 7 days
 * `open` = waiting + missed + missedUnclear + dueSoon + carrying. `olderWaiting` is the subset of older that waits on the operator.
 */
export function sortPromises(list, now = Date.now()) {
  const s = { waiting: [], missed: [], missedUnclear: [], dueSoon: [], carrying: [], older: [], closed: [] };
  for (const c of list || []) {
    if (!c) continue;
    if (isActiveCommitment(c, now) || c.status === 'violated') {
      if (isMissed(c, now) && !waitsOnOperator(c)) (looksLikePromise(c) ? s.missed : s.missedUnclear).push(c);
      else if (!isFresh(c, now)) s.older.push(c);
      else if (waitsOnOperator(c)) s.waiting.push(c);
      else {
        const due = nextDue(c);
        if (due && due > now && due - now <= DUE_SOON_MS) s.dueSoon.push(c);
        else s.carrying.push(c);
      }
    } else if (c.status === 'delivered' || c.status === 'withdrawn' || c.status === 'expired') {
      const r = Date.parse(c.resolvedAt);
      if (Number.isFinite(r) && now - r <= CLOSED_WINDOW_MS) s.closed.push(c);
    }
  }
  s.waiting.sort(byNewest); s.missed.sort(byNewest); s.missedUnclear.sort(byNewest); s.carrying.sort(byNewest);
  // Missed: one entry per distinct promise (the same sentence recorded several times is one miss).
  const repeats = new Map();
  s.missed = dedupeRecords(s.missed, repeats);
  s.missedUnclear = dedupeRecords(s.missedUnclear, repeats);
  s.dueSoon.sort((a, b) => nextDue(a) - nextDue(b));
  s.older.sort((a, b) => Number(waitsOnOperator(b)) - Number(waitsOnOperator(a)) || byNewest(a, b));
  s.closed.sort((a, b) => (Date.parse(b.resolvedAt) || 0) - (Date.parse(a.resolvedAt) || 0));
  const olderWaiting = s.older.filter(waitsOnOperator);
  const counts = {
    waiting: s.waiting.length, missed: s.missed.length, missedUnclear: s.missedUnclear.length, dueSoon: s.dueSoon.length, carrying: s.carrying.length,
    older: s.older.length, olderWaiting: olderWaiting.length, closed: s.closed.length,
    open: s.waiting.length + s.missed.length + s.missedUnclear.length + s.dueSoon.length + s.carrying.length,
  };
  return { ...s, olderWaiting, counts, repeats };
}

const PROMISE_TEXT = (c) => `${c.agentResponse || ''} ${c.userRequest || ''}`;
/**
 * What a promise waiting on the operator is about, so its own page can show it
 * too (a promise about a PR on Development, about a password on Passwords & keys,
 * about a sign-in on Accounts). Null when none of those.
 */
export function promiseTopic(c) {
  const t = PROMISE_TEXT(c);
  if (/\b(password|passphrase|secret drop|api key|credential|token)\b/i.test(t)) return 'password';
  if (/\b(sign[- ]?in|log[- ]?in|login|re-?auth)/i.test(t)) return 'sign-in';
  if (/\b(pull request|PRs?\b\s*#?\d|\bPR\b|merge|branch protection|code[- ]owner|github)/i.test(t)) return 'pr';
  return null;
}

/** Identifiers a promise names, for folding it into the item it is about. */
export function promiseRefs(c) {
  const t = PROMISE_TEXT(c);
  const prs = [...t.matchAll(/\b(?:PR|pull request)\s*#?\s*(\d{2,6})\b/gi)].map((m) => Number(m[1]));
  const attentionIds = [...t.matchAll(/attention item\s+([A-Za-z0-9_:.-]+)/g)].map((m) => m[1].replace(/[.,;:]+$/, ''));
  const emails = [...t.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0].toLowerCase());
  return { prs, attentionIds, emails };
}

/** The words for what a waiting promise needs: an answer or an approval. */
export function promiseKind(c) { return c.blockedOn === 'user-authorization' ? 'approval' : 'answer'; }

/** The full promise text behind a row's tap: what I said, what you asked, and the id. */
export function promiseFull(c) {
  return [c.agentResponse ? `I said: ${c.agentResponse}` : null, c.userRequest ? `You asked: ${c.userRequest}` : null, c.id ? `Promise ${c.id}` : null].filter(Boolean).join('\n\n');
}

/**
 * One needs-you item for a promise waiting on the operator. `brief` (home-model's
 * briefOf) turns the face into one plain sentence; the full text sits in `detail`.
 */
export function promiseNeed(c, now = Date.now(), { stale = false, brief = null } = {}) {
  const replica = c.viewSource === 'replica' && c.originMachineId
    ? `from another machine, ${Number.isFinite(Number(c.stalenessMs)) && c.stalenessMs !== null ? `as of ${ago(now - c.stalenessMs, now)}` : 'age unknown'}` : '';
  const kind = promiseKind(c);
  const text = c.agentResponse || c.userRequest || '';
  return {
    kind: 'promise', subKind: kind, topic: promiseTopic(c), refs: promiseRefs(c),
    key: `promise:${c.originMachineId || 'own'}:${c.id}`, id: c.id, stale,
    last: lastTouched(c), prio: 5,
    main: (brief ? brief(text) : text) || (brief ? 'A promise' : c.id),
    sub: [kind === 'approval' ? 'Needs your approval' : 'Needs your answer', replica, stale ? `untouched ${STALE_DAYS}+ days` : ''].filter(Boolean).join(' · '),
    end: ago(c.createdAt, now) || '',
    tone: stale ? 'unknown' : 'attn',
    detail: promiseFull(c),
    expandable: true,
    record: c,
  };
}

/** The waiting promises about one topic ('pr' | 'password' | 'sign-in'), as needs-you items; the page's own share of the one list. */
export function promisesAbout(list, topic, now = Date.now(), { brief = null } = {}) {
  const s = sortPromises(list, now);
  return s.waiting.filter((c) => promiseTopic(c) === topic).map((c) => promiseNeed(c, now, { brief }));
}

// ═══ Attention items ═══════════════════════════════════════════════════════
const PRIORITY = { URGENT: 0, HIGH: 1, MEDIUM: 2, NORMAL: 3, LOW: 4 };

/** Items the operator must act on, per the attention hub filter's own rule. */
export function needsOperator(item) {
  if (!item) return false;
  if (item.priority === 'URGENT') return true;
  if (item.source === 'agent') return true;
  const cat = String(item.category || '');
  return /decision|approval|review|security|sign-?in|relogin/i.test(cat);
}

/** Items that never age out of "needs you": security. Everything else, URGENT included, is marked stale after 14 untouched days. */
export function neverStale(i) { return /security/i.test(String(i.category || '')); }

/** The same notice raised again (or on several machines) is one thing to do. */
export function groupKey(i) {
  return `${String(i.category || '')}|${String(i.title || i.summary || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * Open attention items needing the operator, grouped: one needs-you item per group.
 * `brief` (home-model's briefOf) makes the face one plain sentence; the original
 * title, the description and the item id go behind the tap.
 */
export function attentionNeeds(items, now = Date.now(), { brief = null } = {}) {
  const open = (items || []).filter((i) => i && i.status === 'OPEN');
  const mine = open.filter(needsOperator);
  const groups = new Map();
  for (const i of mine) {
    const k = groupKey(i);
    const g = groups.get(k) || { items: [], last: 0, machines: new Set() };
    g.items.push(i);
    g.last = Math.max(g.last, Date.parse(i.updatedAt || i.createdAt) || 0);
    if (i.machineNickname) g.machines.add(i.machineNickname);
    groups.set(k, g);
  }
  const all = [...groups.values()].map((g) => {
    const top = g.items.slice().sort((a, b) => (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9))[0];
    const stale = !g.items.some(neverStale) && now - g.last > STALE_DAYS * DAY;
    const title = String(top.title || top.summary || '').trim();
    const main = (brief ? brief(title) : title) || 'Untitled item';
    return {
      kind: 'attention', ids: g.items.map((i) => i.id).filter(Boolean),
      key: `attention:${groupKey(top)}`, stale, last: g.last, prio: PRIORITY[top.priority] ?? 9,
      main,
      sub: [g.items.length > 1 ? `${g.items.length} copies` : null, [...g.machines].join(', ') || null, String(top.priority || '').toLowerCase()].filter(Boolean).join(' · '),
      end: ago(g.last, now) || '',
      tone: stale ? 'unknown' : (top.priority === 'URGENT' ? 'bad' : 'attn'),
      detail: brief
        ? [main !== title ? title : null, top.description || top.body || '', top.id ? `Item ${top.id}` : null].filter(Boolean).join('\n\n')
        : (top.description || top.body || ''),
      expandable: true,
    };
  }).sort((a, b) => Number(a.stale) - Number(b.stale) || a.prio - b.prio || b.last - a.last);
  return { all, current: all.filter((g) => !g.stale), stale: all.filter((g) => g.stale), routine: open.length - mine.length };
}

// ═══ Accounts (sign-ins) ═══════════════════════════════════════════════════
export const SIGN_IN_STATES = new Set(['needs-reauth', 'signed-out', 'expired', 'broken']);
const REPAIR_RUNNING = new Set(['approved', 'cli-starting', 'artifact-ready', 'browser-driving', 'cli-finishing', 'identity-verifying', 'auth-verifying', 'starting', 'running', 'in-progress', 'navigating', 'awaiting-code']);

/**
 * What one account×machine cell needs, from the pool row and its latest repair
 * episode. Only two states are the operator's: a repair OFFERED for approval
 * (`suggested`, approval mode — one tap) and a repair stopped at a step only a
 * person can do (`waiting-operator-only`). An expired login the agent is
 * repairing, has scheduled, or has not started is the agent's chore (rule c).
 */
export function cellRepair(row, episode, { unavailable = false, now = Date.now() } = {}) {
  const expired = SIGN_IN_STATES.has(row && row.status);
  if (episode && REPAIR_RUNNING.has(episode.state)) return { state: 'working', label: 'signing in', needsTap: false, expired: true };
  if (!expired) {
    if (row && row.status === 'active' && row.loginCheck === 'ok') return { state: 'ok', label: 'signed in', needsTap: false, expired: false };
    if (row && row.status === 'active') return { state: 'ok', label: 'signed in (not re-checked)', needsTap: false, expired: false };
    return { state: 'unknown', label: String((row && row.status) || 'unknown').replace(/-/g, ' '), needsTap: false, expired: false };
  }
  if (episode && episode.state === 'suggested') return { state: 'tap', label: 'repair ready; needs your tap', needsTap: true, expired: true, action: 'approve' };
  if (episode && episode.state === 'waiting-operator-only') return { state: 'tap', label: 'the repair needs a step only you can do', needsTap: true, expired: true, action: 'approve' };
  if (episode && episode.state === 'failed') {
    const next = Date.parse(episode.nextAttemptAt);
    if (Number.isFinite(next) && next > now && !episode.slowRetryHeld) return { state: 'scheduled', label: `expired; repair retries ${ago(next, now).replace(' ago', '') === 'just now' ? 'shortly' : 'at ' + new Date(next).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, needsTap: false, expired: true, action: 'retry' };
    return { state: 'stopped', label: 'expired; the automatic repair stopped — mine to restart', needsTap: false, expired: true, action: 'retry' };
  }
  if (unavailable) return { state: 'unavailable', label: 'expired; automatic repair isn’t available on that machine — mine to fix', needsTap: false, expired: true, action: 'start' };
  return { state: 'none', label: 'expired; no repair started yet — mine to fix', needsTap: false, expired: true, action: 'start' };
}

/**
 * Every account×machine cell with an expired sign-in, split into the ones that
 * need the operator's tap and the ones that are the agent's chore.
 * rows: /subscription-pool?scope=pool accounts; episodes: /subscription-relogin?scope=pool episodes;
 * unavailable: machine ids where the repair feature is off.
 */
export function accountNeeds(rows, episodes = [], { unavailable = [], now = Date.now() } = {}) {
  const epFor = (accountId, machineId) => (episodes || [])
    .filter((e) => e && e.accountId === accountId && e.machineId === machineId)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0] || null;
  const off = new Set(unavailable || []);
  const tap = [], expired = [];
  for (const r of rows || []) {
    if (!r || !r.id) continue;
    const ep = epFor(r.id, r.machineId);
    const st = cellRepair(r, ep, { unavailable: off.has(r.machineId), now });
    if (!st.expired) continue;
    const machine = r.machineNickname || 'a machine with no name yet';
    const item = {
      kind: 'account', key: `account:${r.id}:${r.machineId}`, accountId: r.id, machineId: r.machineId, machine,
      email: (r.email || '').toLowerCase() || null, name: r.nickname || r.id, framework: r.framework,
      repair: st, episode: ep, episodeId: ep ? ep.id : null, action: st.action || null, remote: Boolean(r.remote),
      last: Date.parse((ep && ep.updatedAt) || r.lastRefreshAt) || 0, prio: 4,
      main: `Sign in ${r.nickname || r.id} on ${machine}`,
      sub: st.label, end: '', tone: st.needsTap ? 'attn' : 'unknown', stale: false,
    };
    (st.needsTap ? tap : expired).push(item);
  }
  const machines = [...new Set([...tap, ...expired].map((c) => c.machine))];
  return {
    tap, expired, machines,
    repairing: expired.filter((c) => c.repair.state === 'working' || c.repair.state === 'scheduled').length,
    stopped: expired.filter((c) => c.repair.state === 'stopped' || c.repair.state === 'none' || c.repair.state === 'unavailable').length,
  };
}

/** The honest sign-in headline: taps are yours; expired logins are mine. */
export function accountsHeadline(needs) {
  const n = needs.tap.length, e = needs.expired.length;
  const where = needs.machines.length ? ` on ${needs.machines.join(' and ')}` : '';
  if (n && e) return `${plural(n, 'sign-in')} need${n === 1 ? 's' : ''} your tap; ${plural(e, 'other sign-in')} expired${where}, mine to repair.`;
  if (n) return `${plural(n, 'sign-in')} need${n === 1 ? 's' : ''} your tap.`;
  if (e) return `${plural(e, 'sign-in')} expired${where} — mine to repair${needs.repairing ? ` (${needs.repairing} repairing)` : ''}; none needs your tap.`;
  return null;
}

// ═══ Pull requests ═════════════════════════════════════════════════════════
/** PRs waiting for the operator's own review or approval on GitHub, from /green-pr-automerge. */
export function prsNeedingYou(w, now = Date.now()) {
  if (!w || typeof w !== 'object') return [];
  const out = [];
  const seen = new Set();
  const entries = Array.isArray(w.snapshot && w.snapshot.entries) ? w.snapshot.entries : [];
  for (const e of entries) if (e && e.kind === 'code-owner-review' && !seen.has(e.pr)) {
    seen.add(e.pr);
    out.push({ kind: 'pr', key: `pr:${e.pr}`, pr: e.pr, why: 'waiting for your code-owner review on GitHub', at: w.snapshot.at || null, record: e, last: Date.parse(w.snapshot.at) || 0, prio: 3, main: `Pull request #${e.pr}`, sub: 'Waiting for your code-owner review on GitHub', end: w.snapshot.at ? ago(w.snapshot.at, now) : '', tone: 'attn', stale: false });
  }
  for (const ep of Array.isArray(w.episodes) ? w.episodes : []) if (ep && ep.lastOutcome === 'refused:approval-required' && !seen.has(ep.pr)) {
    seen.add(ep.pr);
    out.push({ kind: 'pr', key: `pr:${ep.pr}`, pr: ep.pr, why: 'waiting for your approval on GitHub', at: ep.lastAttemptAt || null, record: ep, last: Date.parse(ep.lastAttemptAt) || 0, prio: 3, main: `Pull request #${ep.pr}`, sub: 'Waiting for your approval on GitHub', end: ep.lastAttemptAt ? ago(ep.lastAttemptAt, now) : '', tone: 'attn', stale: false });
  }
  return out;
}

// ═══ Safety checks (guards) ════════════════════════════════════════════════
export const GUARD_WORDS = {
  'on-confirmed': 'on', 'on-unverified': 'on, not confirmed', 'on-stale': 'on, gone quiet', 'on-blind': 'on, can’t see it working',
  'on-dry-run': 'watching only', off: 'off', 'diverged-pending-restart': 'changed, waiting for a restart', errored: 'errored',
  missing: 'missing', 'off-runtime-divergent': 'off while running',
};
const NEEDS_LOOK = new Set(['diverged-pending-restart', 'errored', 'missing', 'off-runtime-divergent']);

export function guardWord(g) {
  if (g.loadBearingAccepted) return 'risk accepted';
  if (g.loadBearingGap) return g.effective === 'on-dry-run' ? 'watching only, nothing guards it' : 'off, nothing guards it';
  if (g.loadBearingSoaking) return 'watching only, trial run';
  if (g.effective === 'off' && g.offClass === 'dark-default') return 'off by design';
  if (g.effective === 'off' && g.offClass === 'diverged-from-default') return 'off, should be on';
  return GUARD_WORDS[g.effective] || String(g.effective || 'unknown').replace(/-/g, ' ');
}

/**
 * Off where it should be on, broken, or guarding nothing. "On, not confirmed" is the
 * ordinary state of about half the checks (not instrumented) and is listed, not
 * counted; "off by design" and "watching only" are not findings.
 */
export function guardNeedsLook(g) {
  if (!g) return false;
  if (g.loadBearingAccepted) return false;
  if (g.loadBearingGap) return true;
  if (g.effective === 'off') return g.offClass === 'diverged-from-default';
  return NEEDS_LOOK.has(g.effective);
}

/** Which bucket a needs-look guard falls in, for the breakdown line. */
export function guardLookClass(g) {
  if (g.loadBearingGap) return 'gap';
  if (g.effective === 'off') return 'offShouldBeOn';
  if (g.effective === 'missing') return 'missing';
  if (g.effective === 'errored') return 'errored';
  if (g.effective === 'off-runtime-divergent') return 'offRuntime';
  if (g.effective === 'diverged-pending-restart') return 'pendingRestart';
  return 'other';
}
const LOOK_WORDS = { offShouldBeOn: 'off that should be on', missing: 'missing', errored: 'errored', offRuntime: 'off while running', pendingRestart: 'waiting for a restart', gap: 'guarding a critical path with nothing on', other: 'other' };

export const FAILED_PEER_WORDS = {
  'no-known-url': 'no address known for it', offline: 'it is offline', 'url-rejected': 'its address was refused',
  'route-missing': 'it needs an update to report', unauthorized: 'it refused the request', timeout: 'no answer in time',
  unreachable: 'it could not be reached', error: 'it answered with an error', 'no list': 'it answered without a list',
};

/**
 * THE safety-check count. `res` is GET /guards (with or without ?scope=pool).
 * scope 'local' counts this machine's list only; 'pool' adds every peer that
 * answered. Machines that could not answer are named apart in `cantTell` and
 * never inside the number. Returns { ok, count, rows, all, cantTell, machines,
 * scopeWords, byMachine, breakdown, breakdownWords, selfName, multi }.
 */
export function guardsNeedingLook(res, { scope = 'local', names = null } = {}) {
  if (!res || !res.ok) return { ok: false, reason: `Couldn't read the safety checks: ${(res && res.reason) || 'no answer'}.` };
  const d = res.data || {};
  if (!Array.isArray(d.guards)) return { ok: false, reason: 'The safety checks answered without their list.' };
  const pool = d.pool && typeof d.pool === 'object' ? d.pool : null;
  const peers = pool && Array.isArray(pool.machines) ? pool.machines : [];
  const failedPeers = pool && Array.isArray(pool.failed) ? [...pool.failed] : [];
  const multi = peers.length + failedPeers.length > 0;
  const selfName = d.nickname || (multi ? 'this machine' : null);
  const selfId = d.machineId || 'self';
  const row = (g, machine, local) => ({
    key: `${machine.id}:${g.key}`, guardKey: g.key, machineId: machine.id, machine: machine.name, local,
    main: g.criticalPath ? String(g.criticalPath) : humanKey(g.key), sub: [guardWord(g), machine.name].filter(Boolean).join(' · '),
    word: guardWord(g), needsLook: guardNeedsLook(g), lookClass: guardNeedsLook(g) ? guardLookClass(g) : null,
    tone: guardNeedsLook(g) ? 'attn' : g.loadBearingAccepted ? 'unknown' : undefined, record: g,
  });
  const all = d.guards.filter((g) => g && g.key).map((g) => row(g, { id: selfId, name: multi ? selfName : null }, true));
  const cantTell = [];
  let answered = 1;
  if (scope === 'pool') {
    for (const m of peers) {
      const name = m.nickname || m.machineId || 'another machine';
      if (!Array.isArray(m.guards)) { cantTell.push({ machineId: m.machineId, machine: name, reason: 'no list', words: FAILED_PEER_WORDS['no list'] }); continue; }
      answered++;
      for (const g of m.guards) if (g && g.key) all.push(row(g, { id: m.machineId, name }, false));
    }
    for (const f of failedPeers) cantTell.push({ machineId: f.machineId, machine: machineLabel(f, names), reason: f.reason, words: FAILED_PEER_WORDS[f.reason] || String(f.reason || 'no answer').replace(/-/g, ' ') });
  }
  const rows = all.filter((r) => r.needsLook);
  const byMachine = {};
  for (const r of rows) byMachine[r.machine || selfName || 'this machine'] = (byMachine[r.machine || selfName || 'this machine'] || 0) + 1;
  const breakdown = {};
  for (const r of rows) breakdown[r.lookClass] = (breakdown[r.lookClass] || 0) + 1;
  const breakdownWords = Object.entries(breakdown).map(([k, n]) => `${n} ${LOOK_WORDS[k] || k}`).join(' · ');
  const scopeWords = scope === 'pool' && multi ? `across ${plural(answered, 'machine')}` : (d.nickname ? `on ${d.nickname}` : 'on this machine');
  return {
    ok: true, scope: scope === 'pool' && multi ? 'pool' : 'local', count: rows.length, rows, all, others: all.filter((r) => !r.needsLook),
    accepted: all.filter((r) => r.record.loadBearingAccepted), cantTell, machines: answered, scopeWords, byMachine, breakdown, breakdownWords, selfName, multi,
    cantTellWords: cantTell.length ? `${cantTell.map((c) => c.machine).join(', ')} can’t tell` : null,
  };
}

// Plain names for the setting keys the guards are known by. Anything not listed is
// humanized: prefixes dropped, camelCase split and lower-cased, known acronyms kept upper.
const GUARD_NAMES = {
  'models.tierEscalation.dryRun': 'Model escalation (watch-only mode)',
  'models.tierEscalation.enabled': 'Model escalation for heavy work',
  'monitoring.autonomousHeartbeat.enabled': 'Autonomous-run heartbeat',
  'monitoring.collaborationRedrive.enabled': 'Collaboration re-drive',
  'monitoring.greenPrAutoMerge.enabled': 'Green PR auto-merge',
  'monitoring.orphanedWorkSentinel.enabled': 'Orphaned-work sentinel',
  'monitoring.reportExternalProcesses': 'Report external processes',
  'monitoring.staleBackstop.enabled': 'Stale backstop',
  'monitoring.burnDetection.enabled': 'Token-burn detection',
  'monitoring.crashLoopPauser.enabled': 'Crash-loop pauser',
  'monitoring.promptGate.enabled': 'Prompt gate',
  'multiMachine.peerExecution.enabled': 'Autonomous execution on a paired machine',
  'scheduler.enabled': 'Scheduled jobs',
};
const ACRONYMS = new Set(['pr', 'llm', 'cpu', 'gpu', 'mcp', 'ssh', 'a2a', 'api', 'ci', 'jsonl', 'json', 'tcc', 'url', 'http', 'https', 'tls', 'ws', 'sse', 'ui', 'ux', 'pin', 'id', 'oauth', 'otp', 'totp', 'aup', 'pid', 'io', 'os']);
export function guardName(key) {
  const k = String(key || '').trim();
  if (!k) return 'A safety check';
  if (GUARD_NAMES[k]) return GUARD_NAMES[k];
  const words = k.replace(/^(monitoring|intelligence|sessions|multiMachine|messaging|scheduler)\./, '').replace(/\.enabled$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[._\-\s]+/).filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}
export const humanKey = guardName;

// ═══ Machine load ══════════════════════════════════════════════════════════
export const LOAD_REPORT_MAX_AGE_MS = 60_000;
const VERDICT_WORDS = { ok: 'ok', elevated: 'busy', saturated: 'overloaded', impaired: 'impaired' };

/** A verdict from a bare load-per-core figure (the fallback when no report is fresh). */
export function loadVerdictOf(perCore) {
  if (typeof perCore !== 'number' || !Number.isFinite(perCore)) return null;
  if (perCore > 2) return 'overloaded';
  if (perCore > 1) return 'busy';
  return 'ok';
}

/**
 * THE load reading for a /pool machine row. The server's multi-signal load report
 * wins while it is fresh (≤ 60 s) — its `loadPerCore` and the server's own verdict;
 * else the plain load average over the core count, labelled an estimate; else null
 * ("no load reading"). Home and Machines both read this, so they can never show a
 * figure and "no load reading" for the same machine.
 */
export function loadOf(m, now = Date.now()) {
  if (!m) return { perCore: null, verdict: null, source: null, estimated: false, words: 'no load reading' };
  const lr = m.loadReport && typeof m.loadReport === 'object' ? m.loadReport : null;
  const age = Number.isFinite(Number(m.loadReportAgeMs)) ? Number(m.loadReportAgeMs)
    : (m.loadReportReceivedAt ? now - Date.parse(m.loadReportReceivedAt) : null);
  const fresh = lr && (age === null || age <= LOAD_REPORT_MAX_AGE_MS);
  if (fresh && Number.isFinite(Number(lr.loadPerCore))) {
    const perCore = Number(lr.loadPerCore);
    const sv = m.loadVerdict && m.loadVerdict !== 'unknown' ? m.loadVerdict : (lr.verdict && lr.verdict !== 'unknown' ? lr.verdict : null);
    const verdict = sv ? (VERDICT_WORDS[sv] || sv) : loadVerdictOf(perCore);
    return { perCore, verdict, source: 'report', estimated: false, words: `${verdict} · load ${perCore.toFixed(1)} per core` };
  }
  const cores = m.hardware && Number(m.hardware.cpuCores);
  if (cores > 0 && Number.isFinite(Number(m.loadAvg))) {
    const perCore = Number(m.loadAvg) / cores;
    const verdict = loadVerdictOf(perCore);
    return { perCore, verdict, source: 'estimate', estimated: true, words: `${verdict} · load ${perCore.toFixed(1)} per core (estimated)` };
  }
  return { perCore: null, verdict: null, source: null, estimated: false, words: 'no load reading' };
}

// ═══ Machine state ═════════════════════════════════════════════════════════
export const LIVE_MS = 2 * 60 * 1000;
export const STALE_MS = 15 * 60 * 1000;

/** A machine's name for a pool `failed` entry (never its raw id on a page). */
export function machineLabel(f, names = null) {
  if (!f) return 'a machine with no name yet';
  return f.nickname || f.machineNickname || (names && names[f.machineId]) || 'a machine with no name yet';
}

/**
 * The ESTIMATED machine state from the evidence /pool exposes (online,
 * routerReceivedAt/selfReportedLastSeen, load, ropeCondition), for rows that carry
 * no server liveness. Precedence, first match wins: an explicit peer-offline rope
 * signal; no timestamp at all; silent over 15 min; silent over 2 min (stale
 * evidence never supports a present-tense load diagnosis); adverse live evidence
 * (degraded or urgent rope, an overloaded or impaired load reading); otherwise live.
 */
export function machineState(m, now = Date.now()) {
  if (!m) return { state: 'unknown', label: 'unknown', age: null };
  const heard = Date.parse(m.routerReceivedAt || m.selfReportedLastSeen || m.lastSeen);
  const age = Number.isFinite(heard) ? ago(heard, now) : null;
  const rope = m.ropeCondition;
  if (rope === 'peer-offline') return { state: 'bad', label: 'unreachable', age };
  if (!Number.isFinite(heard)) return { state: 'unknown', label: 'no reading', age: null };
  const since = now - heard;
  if (since > STALE_MS) return { state: 'bad', label: 'not answering', age };
  if (since > LIVE_MS) return { state: 'stale', label: 'quiet', age };
  const load = loadOf(m, now);
  const perCore = load.perCore;
  const overloaded = load.verdict === 'overloaded' || load.verdict === 'impaired';
  if (rope === 'degraded' || rope === 'urgent' || overloaded) return { state: 'attn', label: 'struggling', age, perCore, load };
  if (m.online === false) return { state: 'unknown', label: 'no reading', age, load };
  return { state: 'ok', label: 'live', age, perCore, load };
}

/**
 * THE machine state every page shows: the server's liveness block when the row
 * carries one (its evidence age and source), else the estimate — with the one
 * shared load reading attached. A machine the server calls live but whose load
 * reading is overloaded or impaired is "struggling" on every page alike.
 */
export function liveState(m, now = Date.now()) {
  const lv = m && m.liveness;
  if (lv && typeof lv.state === 'string') {
    const load = loadOf(m, now);
    // The server's states (src/core/machineLiveness.ts): live / unreachable (shape struggling | refusing | silent) / stale / unknown.
    const map = { live: 'ok', unreachable: 'bad', struggling: 'attn', refusing: 'attn', silent: 'bad', stale: 'stale', unknown: 'unknown' };
    const age = lv.evidenceAt ? ago(lv.evidenceAt, now) : null;
    let state = map[lv.state] || 'unknown';
    let label = lv.state;
    if (lv.state === 'unreachable' && (lv.shape === 'struggling' || lv.shape === 'refusing')) { state = 'attn'; label = lv.shape === 'struggling' ? 'struggling' : 'refusing'; }
    if (state === 'ok' && (load.verdict === 'overloaded' || load.verdict === 'impaired')) { state = 'attn'; label = 'struggling'; }
    return { state, label, age, estimated: false, source: lv.source || null, perCore: load.perCore, load };
  }
  const est = machineState(m, now);
  return { ...est, estimated: true, load: est.load || loadOf(m, now) };
}

// ═══ Problems (failure ledger) ═════════════════════════════════════════════
/** The identity of a problem for the operator: its category and summary, never the commit it was keyed on. */
export function failureGroupKey(f) {
  return `${String(f.category || 'unknown')}|${String(f.summary || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
}
export function failureOpen(f) { return Boolean(f && (f.status === 'open' || f.status === 'reopened')); }

/**
 * Identical problems folded into one line each. A group is REPEATING when it was
 * seen more than once — the operator's ordinary meaning — whether by one record's
 * occurrence count or by several records of the same problem. Open groups first,
 * then by times seen, then newest.
 */
export function groupFailures(failures) {
  const groups = new Map();
  for (const f of failures || []) {
    if (!f || typeof f.id !== 'string') continue;
    const k = failureGroupKey(f);
    const g = groups.get(k) || { key: k, records: [], times: 0, open: false, newest: 0, oldest: Infinity };
    g.records.push(f);
    g.times += Math.max(1, Number(f.occurrenceCount) || 1);
    g.open = g.open || failureOpen(f);
    const t = Date.parse(f.detectedAt) || 0;
    g.newest = Math.max(g.newest, t); g.oldest = Math.min(g.oldest, t);
    groups.set(k, g);
  }
  const list = [...groups.values()].map((g) => ({ ...g, repeating: g.times > 1, top: g.records.slice().sort((a, b) => (Date.parse(b.detectedAt) || 0) - (Date.parse(a.detectedAt) || 0))[0] }))
    .sort((a, b) => Number(b.open) - Number(a.open) || b.times - a.times || b.newest - a.newest);
  return { groups: list, repeating: list.filter((g) => g.repeating), openGroups: list.filter((g) => g.open) };
}

// ═══ The one needs-you list ════════════════════════════════════════════════
export const KIND_ORDER = ['attention', 'pr', 'account', 'promise'];
const KIND_LABEL_ORDER = ['notice', 'review', 'sign-in', 'approval', 'answer'];
export const SOURCE_WORDS = { attention: 'the attention queue', promises: 'your promises', accounts: 'sign-in repairs', prs: 'the merge watcher' };

function kindLabel(item) {
  if (item.kind === 'promise') return item.subKind === 'approval' ? 'approval' : 'answer';
  if (item.kind === 'account') return 'sign-in';
  if (item.kind === 'pr') return 'review';
  return 'notice';
}

/**
 * ONE deduplicated list of everything that needs the operator, across sources:
 *   attention — attentionNeeds(...).all   (groups; `stale` marks 14+ untouched days)
 *   promises  — promiseNeed(...) items, current and stale
 *   accounts  — accountNeeds(...).tap
 *   prs       — prsNeedingYou(...)
 * Each source is { state: 'ok'|'loading'|'failed'|'off', items, reason? }. A promise
 * that names the PR, attention item or account another item already covers is
 * folded into that item (its `also` list), so the same thing is never counted twice.
 * Returns { count, items, stale, byKind, label, pending, failed, off, complete }.
 */
export function needsYou(sources = {}, now = Date.now()) {
  const src = (k) => sources[k] || { state: 'loading', items: [] };
  const state = (k) => src(k).state || (Array.isArray(src(k).items) ? 'ok' : 'loading');
  const items = (k) => (state(k) === 'ok' && Array.isArray(src(k).items) ? src(k).items : []);
  const current = [];
  const stale = [];
  const byKey = new Map();
  const add = (it) => { const slot = it.stale ? stale : current; slot.push(it); byKey.set(it.key, it); for (const id of it.ids || []) byKey.set(`attention:${id}`, it); if (it.kind === 'account' && it.email) byKey.set(`email:${it.email}:${String(it.machine || '').toLowerCase()}`, it); };
  for (const it of items('attention')) add(it);
  for (const it of items('prs')) add({ ...it, stale: false });
  for (const it of items('accounts')) add({ ...it, stale: false });
  for (const p of items('promises')) {
    const refs = p.refs || { prs: [], attentionIds: [], emails: [] };
    const keys = [...refs.prs.map((n) => `pr:${n}`), ...refs.attentionIds.map((id) => `attention:${id}`)];
    for (const e of refs.emails) for (const it of [...current, ...stale]) if (it.kind === 'account' && it.email === e && new RegExp(String(it.machine).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(p.main || '')) keys.push(it.key);
    const host = keys.map((k) => byKey.get(k)).find((it) => it && it.kind !== 'promise');
    if (host) { host.also = [...(host.also || []), p]; host.sub = [host.sub, 'also a promise of mine'].filter(Boolean).join(' · '); continue; }
    add(p);
  }
  const order = (a, b) => (a.kind === 'attention' && a.prio === 0 ? -1 : 0) - (b.kind === 'attention' && b.prio === 0 ? -1 : 0) || (b.last || 0) - (a.last || 0);
  current.sort(order); stale.sort(order);
  const byKind = {};
  for (const k of KIND_LABEL_ORDER) { const n = current.filter((it) => kindLabel(it) === k).length; if (n) byKind[k] = n; }
  const kinds = Object.entries(byKind);
  const label = current.length === 0 ? null
    : kinds.length > 1 ? `${plural(current.length, 'thing')}: ${kinds.map(([k, n]) => plural(n, k)).join(', ')}`
      : plural(current.length, 'thing');
  const pending = ['attention', 'promises', 'accounts', 'prs'].filter((k) => state(k) === 'loading');
  const failed = ['attention', 'promises', 'accounts', 'prs'].filter((k) => state(k) === 'failed').map((k) => ({ source: k, what: SOURCE_WORDS[k], why: src(k).reason || 'no answer' }));
  const off = ['attention', 'promises', 'accounts', 'prs'].filter((k) => state(k) === 'off');
  return { count: current.length, items: current, stale, byKind, label, pending, failed, off, complete: pending.length === 0 && failed.length === 0 };
}

/** The items of one page's kind from the one list (its tile says 0 only when this is empty). */
export function needsOfKind(list, pred) {
  const current = Array.isArray(list.items) ? list.items : Array.isArray(list.all) ? list.all : [];
  return [...current, ...(Array.isArray(list.items) && Array.isArray(list.stale) ? list.stale : [])].filter(pred);
}
