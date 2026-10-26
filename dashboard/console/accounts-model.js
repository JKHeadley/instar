// Accounts page — pure view-model (docs/specs/console-features/capacity.md, "Accounts").
//
// /subscription-pool?scope=pool returns one row per account per machine. The page
// shows each account once (its freshest reading), the machines it works on as
// chips, and — from shared-counts.js, the same source as Home — the account×machine
// cells whose repair waits on the operator's TAP as "Needs you". An expired login
// the agent is repairing (or has yet to repair) is the agent's chore: listed under
// "Expired sign-ins — mine to repair", never counted as needing the operator.

import { ago } from './home-model.js';
import { cellRepair, accountNeeds, accountsHeadline, promisesAbout, plural } from './shared-counts.js';

export const READING_STALE_MS = 60 * 60 * 1000;
const FRAMEWORK_WORDS = { 'claude-code': 'Claude', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', 'grok-build': 'Grok', 'pi-cli': 'Pi' };

export function frameworkName(f) { return FRAMEWORK_WORDS[f] || f || 'Other'; }

/** A cell's state in words, from the pool row (and its repair episode, when any). */
export function cellState(row, episode, opts = {}) {
  const r = cellRepair(row, episode, opts);
  if (r.state === 'working') return { state: 'working', label: r.label, repair: r };
  if (r.expired) return { state: 'attn', label: r.needsTap ? r.label : 'needs sign-in', repair: r };
  return { state: r.state, label: r.label, repair: r };
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
 * Build the page. episodes: /subscription-relogin?scope=pool episodes (optional);
 * unavailable: machine ids where the repair feature is off; promises: the
 * /commitments?scope=mesh list (a promise about a sign-in waiting on the operator
 * shows under Needs you here too).
 * Returns { ok, needs, expired, accounts, headline, sub, facts, partial }.
 */
export function buildAccountsPage(res, now = Date.now(), { episodes = [], inUse = null, names: extraNames = {}, unavailable = [], promises = null } = {}) {
  if (!res.ok) return { ok: false, reason: `Couldn't read accounts: ${res.reason}.` };
  if (res.data && res.data.enabled === false) return { ok: false, reason: 'The account pool is not set up on this agent.' };
  const rows = Array.isArray(res.data && res.data.accounts) ? res.data.accounts : null;
  if (!rows) return { ok: false, reason: 'The account pool answered without accounts.' };
  const failed = res.data.pool && Array.isArray(res.data.pool.failed) ? res.data.pool.failed : [];

  const epFor = (accountId, machineId) => episodes
    .filter((e) => e.accountId === accountId && e.machineId === machineId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] || null;
  const off = new Set(unavailable || []);

  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.id) continue;
    const g = byId.get(r.id) || { id: r.id, name: r.nickname || r.id, email: r.email || null, framework: r.framework, cells: [], reading: null, readingAt: 0 };
    const ep = epFor(r.id, r.machineId);
    g.cells.push({ machineId: r.machineId, machine: r.machineNickname || 'a machine with no name yet', ...cellState(r, ep, { unavailable: off.has(r.machineId), now }), episode: ep, row: r });
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

  // THE sign-in count (shared-counts.accountNeeds): taps are the operator's, expired logins are the agent's.
  const sn = accountNeeds(rows, episodes, { unavailable, now });
  const cellItem = (c) => ({
    kind: 'account', key: c.key, accountId: c.accountId, machineId: c.machineId, machine: c.machine,
    title: `Sign in ${frameworkName(c.framework)} (${c.email || c.name}) on ${c.machine}`,
    label: `${frameworkName(c.framework)} · ${c.email || c.name}`,
    sub: c.repair.label, action: c.action, episodeId: c.episodeId, remote: c.remote, repair: c.repair,
  });
  const taps = sn.tap.map(cellItem);
  const expired = sn.expired.map(cellItem);
  // A promise about a sign-in that waits on the operator is the same thing, on its own page.
  const promised = Array.isArray(promises) ? promisesAbout(promises, 'sign-in', now).filter((p) => !taps.some((t) => t.machine && p.refs.emails.includes((t.label.split(' · ')[1] || '').toLowerCase()) && new RegExp(t.machine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(p.main))) : [];
  const needs = [...taps, ...promised.map((p) => ({ kind: 'promise', key: p.key, label: p.main, sub: p.subKind === 'approval' ? 'A promise of mine, waiting on your approval' : 'A promise of mine, waiting on your answer', action: 'promise', machine: 'A promise', promise: p }))];

  const usable = accounts.filter((a) => a.cells.some((c) => c.state === 'ok')).length;
  const busiest = accounts.filter((a) => a.tight).sort((a, b) => b.tight.pct - a.tight.pct)[0];
  const near = accounts.filter((a) => a.tight && a.tight.pct >= 90 && a.cells.some((c) => c.state === 'ok'));
  const where = sn.machines.length ? ` on ${sn.machines.join(' and ')}` : '';
  let headline;
  if (needs.length) {
    headline = `${plural(needs.length, 'sign-in')} need${needs.length === 1 ? 's' : ''} you.${expired.length ? ` ${plural(expired.length, 'other sign-in')} expired${where}, mine to repair.` : ''}`;
  } else if (expired.length) headline = accountsHeadline(sn);
  else if (near.length && near.length === accounts.filter((a) => a.tight).length) headline = 'Every account is nearly out.';
  else if (busiest) headline = busiest.tight.pct >= 90 ? `${busiest.name} is nearly out; others have room.` : `Plenty left: the busiest account is at ${Math.round(busiest.tight.pct)}%.`;
  else headline = 'No usage readings yet.';
  const facts = [
    needs.length ? { n: needs.length, label: 'need you', tone: 'attn', href: '#/capacity/accounts?s=needs' } : null,
    expired.length ? { n: expired.length, label: 'expired, mine to repair', href: '#/capacity/accounts?s=expired' } : null,
    busiest ? { n: `${Math.round(busiest.tight.pct)}%`, label: `most used · ${busiest.name}` , tone: busiest.tone } : null,
    { n: `${usable}/${accounts.length}`, label: 'accounts usable somewhere' },
    inUse && inUse.activeAccountId ? { n: (byId.get(inUse.activeAccountId) || {}).name || inUse.activeAccountId, label: 'in use here' } : null,
  ].filter(Boolean).slice(0, 4);
  const machineNames = {};
  for (const r of rows) if (r && r.machineId && r.machineNickname) machineNames[r.machineId] = r.machineNickname;
  for (const [k, v] of Object.entries(extraNames || {})) if (!machineNames[k]) machineNames[k] = v;
  const partial = failed.length ? `No answer from ${failed.map((f) => f.nickname || f.machineNickname || machineNames[f.machineId] || 'a machine with no name yet').join(', ')}; its accounts may be out of date.` : null;
  return { ok: true, needs, expired, repairing: sn.repairing, accounts, headline, sub: near.length ? `${near.map((a) => a.name).join(', ')} ${near.length === 1 ? 'is' : 'are'} at 90% or more of a limit.` : '', facts, partial, tone: needs.length ? 'attn' : 'ok' };
}
