// Accounts page — pure view-model (docs/specs/console-features/capacity.md, "Accounts").
//
// /subscription-pool?scope=pool returns one row per account per machine. The page
// shows each account once (its freshest reading), the machines it works on as
// chips, and every account×machine cell that needs a sign-in as one "Needs you" item.

import { ago } from './home-model.js';

export const READING_STALE_MS = 60 * 60 * 1000;
const NEEDS_SIGN_IN = new Set(['needs-reauth', 'signed-out', 'expired', 'broken']);
const FRAMEWORK_WORDS = { 'claude-code': 'Claude', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', 'grok-build': 'Grok', 'pi-cli': 'Pi' };

export function frameworkName(f) { return FRAMEWORK_WORDS[f] || f || 'Other'; }

const REPAIR_RUNNING = new Set(['approved', 'starting', 'running', 'in-progress', 'navigating', 'awaiting-code']);
const REPAIR_WAITS_ON_TAP = new Set(['suggested', 'failed']);

/**
 * A cell's state in words, from the pool row (and its repair episode, when any).
 *   working — an automatic repair is signing it in: NOT something you need to do
 *   attn    — a repair is waiting for your tap (approve it, or try again after it stopped)
 *   expired — the sign-in has expired and no repair is running; you can sign in when you want it back
 */
export function cellState(row, episode) {
  if (episode && REPAIR_RUNNING.has(episode.state)) return { state: 'working', label: 'signing in' };
  if (NEEDS_SIGN_IN.has(row.status)) {
    if (episode && REPAIR_WAITS_ON_TAP.has(episode.state)) return { state: 'attn', label: episode.state === 'failed' ? 'repair stopped; needs your tap' : 'repair ready; needs your tap' };
    return { state: 'expired', label: 'sign-in expired' };
  }
  if (row.status === 'active' && row.loginCheck === 'ok') return { state: 'ok', label: 'signed in' };
  if (row.status === 'active') return { state: 'ok', label: 'signed in (not re-checked)' };
  return { state: 'unknown', label: String(row.status || 'unknown').replace(/-/g, ' ') };
}

/** The tightest usage window on a reading: { pct, label, resetsAt, second }. */
export function tightest(q) {
  if (!q) return null;
  const wins = [['fiveHour', '5-hour'], ['sevenDay', 'weekly'], ['fable', 'Fable weekly'], ['primary', '5-hour'], ['secondary', 'weekly']]
    .map(([k, label]) => {
      const w = q[k];
      if (!w) return null;
      const pct = Number(w.utilizationPct ?? w.usedPercent);
      if (!Number.isFinite(pct)) return null;
      return { pct, label, resetsAt: w.resetsAt || w.resetsAtIso || null };
    }).filter(Boolean);
  if (!wins.length) return null;
  wins.sort((a, b) => b.pct - a.pct);
  return { ...wins[0], second: wins[1] || null };
}

export function resetWords(ts, now = Date.now()) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || t <= now) return null;
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return `resets ${sameDay ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' '}${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Build the page. episodes: /subscription-relogin?scope=pool episodes (optional).
 * Returns { ok, needs, accounts, headline, sub, facts, partial }.
 */
function listWords(items) { return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`; }

/** One row per account for the Needs you / Expired lists: the machines it waits on, in words. */
export function groupNeeds(items) {
  const by = new Map();
  for (const n of items) {
    const g = by.get(n.accountId) || { accountId: n.accountId, label: n.label, machines: [], actions: new Set() };
    g.machines.push(n); g.actions.add(n.action);
    by.set(n.accountId, g);
  }
  return [...by.values()].map((g) => {
    const names = g.machines.map((m) => m.machine);
    const waits = g.machines.some((m) => m.action !== 'start');
    const sub = waits
      ? (g.machines.length === 1 ? g.machines[0].sub : `A repair is waiting for your tap on ${listWords(names)}.`)
      : `Expired on ${listWords(names)}; no repair is running.`;
    return { key: `acct:${g.accountId}`, accountId: g.accountId, label: g.label, sub, machines: g.machines, single: g.machines.length === 1 ? g.machines[0] : null, action: g.machines.length === 1 ? g.machines[0].action : 'open' };
  });
}

export function buildAccountsPage(res, now = Date.now(), { episodes = [], inUse = null, names: extraNames = {}, self = null } = {}) {
  if (!res.ok) return { ok: false, reason: `Couldn't read accounts: ${res.reason}.` };
  if (res.data && res.data.enabled === false) return { ok: false, reason: 'The account pool is not set up on this agent.' };
  const rows = Array.isArray(res.data && res.data.accounts) ? res.data.accounts : null;
  if (!rows) return { ok: false, reason: 'The account pool answered without accounts.' };
  const failed = res.data.pool && Array.isArray(res.data.pool.failed) ? res.data.pool.failed : [];

  const epFor = (accountId, machineId) => episodes
    .filter((e) => e.accountId === accountId && e.machineId === machineId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;

  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.id) continue;
    const g = byId.get(r.id) || { id: r.id, name: r.nickname || r.id, email: r.email || null, framework: r.framework, cells: [], reading: null, readingAt: 0 };
    const ep = epFor(r.id, r.machineId);
    g.cells.push({ machineId: r.machineId, machine: r.machineNickname || 'a machine with no name yet', ...cellState(r, ep), episode: ep, row: r });
    const at = Date.parse(r.lastQuota && r.lastQuota.measuredAt);
    if (r.lastQuota && Number.isFinite(at) && at > g.readingAt) { g.reading = r.lastQuota; g.readingAt = at; }
    byId.set(r.id, g);
  }
  const accounts = [...byId.values()].map((g) => {
    const t = tightest(g.reading);
    const stale = g.readingAt && now - g.readingAt > READING_STALE_MS;
    return {
      ...g, tight: t, stale,
      inUse: Boolean(inUse && inUse.activeAccountId === g.id),
      readingAge: g.readingAt ? ago(g.readingAt, now) : null,
      line: !t ? (g.framework === 'grok-build' ? "Usage isn't readable for this kind of account." : 'No reading yet.')
        : `${Math.round(t.pct)}% of ${t.label}${resetWords(t.resetsAt, now) ? ' · ' + resetWords(t.resetsAt, now) : ''}`,
      second: t && t.second ? `${t.second.label} ${Math.round(t.second.pct)}%` : null,
      tone: t && t.pct >= 90 ? 'bad' : t && t.pct >= 75 ? 'attn' : null,
    };
  }).sort((a, b) => (frameworkName(a.framework)).localeCompare(frameworkName(b.framework)) || (b.tight ? b.tight.pct : -1) - (a.tight ? a.tight.pct : -1));

  // Needs you = a repair waiting for your tap. Expired = a sign-in that lapsed with no repair
  // running (you CAN sign in, nothing is asking you to). A repair the agent is running is neither.
  const needs = []; const expired = [];
  for (const a of accounts) for (const c of a.cells) {
    if (c.state !== 'attn' && c.state !== 'expired') continue;
    const ep = c.episode;
    const item = {
      key: `${a.id}::${c.machineId}`, accountId: a.id, machineId: c.machineId, machine: c.machine,
      title: `Sign in ${frameworkName(a.framework)} (${a.email || a.name}) on ${c.machine}`,
      label: `${frameworkName(a.framework)} · ${a.email || a.name}`,
      sub: c.state === 'attn' ? (ep.state === 'failed' ? `The last automatic repair on ${c.machine} stopped safely; you can try again.` : `An automatic repair is ready to run on ${c.machine}.`) : `Its sign-in on ${c.machine} has expired; no repair is running.`,
      action: c.state === 'attn' ? (ep.state === 'failed' ? 'retry' : 'approve') : 'start',
      episodeId: ep ? ep.id : null,
      remote: Boolean(c.row.remote),
    };
    (c.state === 'attn' ? needs : expired).push(item);
  }
  // Scope words: "usable on <this machine>" when we know which machine this is, else "usable somewhere".
  const selfId = self && self.machineId ? self.machineId : null;
  const selfName = (self && self.nickname) || (selfId && (extraNames[selfId])) || null;
  const usableHere = selfId ? accounts.filter((a) => a.cells.some((c) => c.machineId === selfId && c.state === 'ok')).length : null;
  const usableAnywhere = accounts.filter((a) => a.cells.some((c) => c.state === 'ok')).length;
  const lapsed = [...needs, ...expired];
  const lapsedElsewhere = selfId ? lapsed.filter((x) => x.machineId !== selfId).length : null;
  const busiest = accounts.filter((a) => a.tight).sort((a, b) => b.tight.pct - a.tight.pct)[0];
  const near = accounts.filter((a) => a.tight && a.tight.pct >= 90 && a.cells.some((c) => c.state === 'ok'));
  let headline;
  if (needs.length) headline = needs.length === 1 ? '1 sign-in needs you.' : `${needs.length} sign-ins need you.`;
  else if (near.length && near.length === accounts.filter((a) => a.tight).length) headline = 'Every account is nearly out.';
  else if (busiest) headline = busiest.tight.pct >= 90 ? `${busiest.name} is nearly out; others have room.` : `Plenty left: the busiest account is at ${Math.round(busiest.tight.pct)}%.`;
  else headline = 'No usage readings yet.';
  const lapsedLabel = lapsedElsewhere !== null && lapsedElsewhere === lapsed.length ? 'expired elsewhere' : 'sign-ins expired';
  const facts = [
    needs.length ? { n: needs.length, label: needs.length === 1 ? 'needs your tap' : 'need your tap', tone: 'attn', href: '#/capacity/accounts?s=needs' } : null,
    usableHere !== null ? { n: usableHere, label: `usable on ${selfName || 'this machine'}` } : { n: usableAnywhere, label: 'usable somewhere' },
    lapsed.length ? { n: lapsed.length, label: lapsedLabel, tone: needs.length ? 'attn' : 'unknown', href: '#/capacity/accounts?s=expired' } : null,
    busiest ? { n: busiest.name, label: busiest.tight.pct >= 100 ? `most used: all of its ${busiest.tight.label} limit` : `most used: ${Math.round(busiest.tight.pct)}% of its ${busiest.tight.label} limit`, tone: busiest.tone } : null,
    inUse && inUse.activeAccountId ? { n: (byId.get(inUse.activeAccountId) || {}).name || inUse.activeAccountId, label: 'in use here' } : null,
  ].filter(Boolean);
  const scopeSentence = lapsed.length && selfId
    ? `${usableHere} ${usableHere === 1 ? 'account is' : 'accounts are'} usable on ${selfName || 'this machine'}; ${lapsed.length} ${lapsed.length === 1 ? 'sign-in has' : 'sign-ins have'} expired ${lapsedElsewhere === lapsed.length ? 'on other machines' : 'across machines'}${needs.length ? `, ${needs.length} waiting for your tap` : ', none waiting on you'}.`
    : null;
  const machineNames = {};
  for (const r of rows) if (r && r.machineId && r.machineNickname) machineNames[r.machineId] = r.machineNickname;
  for (const [k, v] of Object.entries(extraNames || {})) if (!machineNames[k]) machineNames[k] = v;
  const partial = failed.length ? `No answer from ${failed.map((f) => f.nickname || f.machineNickname || machineNames[f.machineId] || 'a machine with no name yet').join(', ')}; its accounts may be out of date.` : null;
  // Keep the sub line short: more than two names at 90%+ is a count, not a list (the rows carry the names).
  const nearSentence = !near.length ? null : near.length <= 2 ? `${near.map((a) => a.name).join(' and ')} ${near.length === 1 ? 'is' : 'are'} at 90% or more of a limit.` : `${near.length} accounts are at 90% or more of a limit.`;
  const sub = [scopeSentence, nearSentence].filter(Boolean).join(' ');
  return { ok: true, needs, expired, needsRows: groupNeeds(needs), expiredRows: groupNeeds(expired), accounts, headline, sub, facts, partial, tone: needs.length ? 'attn' : 'ok', self: { machineId: selfId, name: selfName } };
}
