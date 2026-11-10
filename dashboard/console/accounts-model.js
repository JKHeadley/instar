// Accounts page — pure view-model (docs/specs/console-features/capacity.md, "Accounts").
//
// /subscription-pool?scope=pool returns one row per account per machine. The page
// shows each account once (its freshest reading), the machines it works on as
// chips, and every account×machine cell that needs a sign-in as one "Needs you" item.

import { ago } from './home-model.js';
import { verifiedDisplayName } from './display-identity.js';
import { unreachableSentence, poolMachine } from './unreachable-model.js';

export const READING_STALE_MS = 60 * 60 * 1000;
const NEEDS_SIGN_IN = new Set(['needs-reauth', 'signed-out', 'expired', 'broken']);
const FRAMEWORK_WORDS = { 'claude-code': 'Claude', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', 'grok-build': 'Grok', 'pi-cli': 'Pi' };

export function frameworkName(f) { return FRAMEWORK_WORDS[f] || f || 'Other'; }

/** The one blocker that is a decision only the operator can make (which accounts live on this machine). */
const OPERATOR_BLOCKERS = new Set(['device-limit-benched']);

// A wrong login can correct itself on a later poll; after a day it has stopped doing that.
export const WRONG_LOGIN_SETTLE_MS = 24 * 60 * 60 * 1000;

/**
 * A slot proven to hold another account's login: 'sign-in' is an owner re-login (the login is gone
 * here), 'settling' may still correct itself, and 'stuck' will not without a new sign-in.
 */
function wrongLogin(row, now) {
  if (row.identityDrifted !== true) return null;
  const drift = row.identityDrift || {};
  if (drift.actualAccountId === 'missing-local-login' || drift.repairState === 'owner-relogin-required') return { kind: 'sign-in' };
  const at = Date.parse(drift.detectedAt);
  const settling = drift.repairState === 'repairing' || (Number.isFinite(at) && now - at < WRONG_LOGIN_SETTLE_MS);
  return { kind: settling ? 'settling' : 'stuck', who: verifiedDisplayName(drift.actualEmail, drift.actualAccountId) || null };
}

/**
 * A cell's state in words, from the pool row, its repair episode and its repair blocker (when any).
 * `waiting` means a warning with nothing only the operator can do: it is shown, but it is not "needs you".
 */
export function cellState(row, episode, blocker, now = Date.now()) {
  if (episode && ['approved', 'starting', 'running', 'in-progress', 'navigating', 'awaiting-code'].includes(episode.state)) return { state: 'working', label: 'signing in' };
  const wrong = wrongLogin(row, now);
  if (wrong && wrong.kind === 'settling') return { state: 'waiting', label: "holds another account's login; checking if it corrects itself" };
  // warning-path: row
  if (wrong && wrong.kind === 'stuck') return { state: 'attn', label: wrong.who ? `holds ${wrong.who}'s login` : "holds another account's login", wrongLogin: true, wrongLoginWho: wrong.who };
  // warning-path: row
  if (wrong) return { state: 'attn', label: 'needs sign-in' };
  if (NEEDS_SIGN_IN.has(row.status) && blocker && !OPERATOR_BLOCKERS.has(blocker.reason)) {
    return blocker.reason === 'no-open-incident'
      ? { state: 'waiting', label: 'sign-in not confirmed; still checking' }
      : { state: 'waiting', label: "automatic repair can't start yet" };
  }
  // warning-path: row
  if (NEEDS_SIGN_IN.has(row.status)) return { state: 'attn', label: 'needs sign-in' };
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

/** A usage window at or over this share is "nearly out" (the rows' red tone uses the same line). */
export const NEAR_OUT_PCT = 90;

/** Every usage window on a reading: [{ pct, resetsAt }]. */
function windowsOf(q) {
  if (!q) return [];
  const seen = new Set();
  const out = [];
  for (const [k, label] of [['fiveHour', '5-hour'], ['sevenDay', 'weekly'], ['fable', 'Fable weekly'], ['primary', '5-hour'], ['secondary', 'weekly']]) {
    const w = q[k];
    if (!w || seen.has(label)) continue;
    const pct = Number(w.utilizationPct ?? w.usedPercent);
    if (!Number.isFinite(pct)) continue;
    seen.add(label);
    out.push({ pct, resetsAt: w.resetsAt || w.resetsAtIso || null });
  }
  return out;
}

/**
 * The page's notice spot: only what needs the person or changes what they can do, and nothing at all
 * otherwise. Same rules as the phone's (src/server/mobileCapacityRoutes.ts accountNotices). Sign-ins are
 * the "Needs you" card and its count, so they are not repeated here. One account full while others have
 * room is on its row and is never a notice.
 *  - a machine with no signed-in account, where a sign-in would fix it;
 *  - every usable account, or every usable account of one kind, at or over the line, with when room returns.
 * Returns [{ key, tone, title, returnsAt, action: { kind: 'sign-in' } | { kind: 'ask', about } }].
 * Reads each cell's `actionable` (set by buildAccountsPage) to choose the machine notice's action.
 */
export function accountNotices(accounts, { partial = false, now = Date.now() } = {}) {
  const scope = partial ? ' (on the machines that answered)' : '';
  const byMachine = new Map();
  for (const a of accounts) for (const c of a.cells) {
    const g = byMachine.get(c.machineId) || { name: c.machine, states: [], canSignIn: false };
    g.states.push(c.state);
    if (c.state === 'attn' && c.actionable) g.canSignIn = true;
    byMachine.set(c.machineId, g);
  }
  const machine = [];
  for (const [id, g] of byMachine) {
    if (g.states.some((s) => s === 'ok' || s === 'working') || !g.states.includes('attn')) continue;
    const title = `${g.name} has no signed-in account, so nothing can run there.`;
    // The sign-in is on the "Needs you" card when it can be started from here; otherwise ask the agent.
    // warning-path: inline
    machine.push({ key: `machine:${id}`, tone: 'bad', title, returnsAt: null, action: g.canSignIn ? { kind: 'sign-in' } : { kind: 'ask', about: title } });
  }
  const usable = accounts.filter((a) => a.cells.some((c) => c.state === 'ok'));
  const kinds = [...new Set(usable.map((a) => frameworkName(a.framework)))].sort();
  const outKinds = [];
  for (const kind of kinds) {
    const list = usable.filter((a) => frameworkName(a.framework) === kind);
    if (list.some((a) => !a.tight)) continue; // one we can't read may have room
    if (list.every((a) => a.tight.pct >= NEAR_OUT_PCT)) outKinds.push({ kind, list });
  }
  const returnsAt = (a) => {
    let latest = 0;
    for (const w of windowsOf(a.reading).filter((x) => x.pct >= NEAR_OUT_PCT)) {
      const t = Date.parse(w.resetsAt);
      if (!Number.isFinite(t) || t <= now) return null;
      latest = Math.max(latest, t);
    }
    return latest || null;
  };
  const room = (list, kind) => {
    const usedUp = list.every((a) => a.tight.pct >= 100);
    const state = usedUp ? 'used up' : 'nearly out';
    const noun = kind ? `${kind} account` : 'account';
    const title = list.length === 1 ? `The only ${noun} is ${state}${scope}.` : `All ${list.length} ${noun}s are ${state}${scope}.`;
    const times = list.map(returnsAt).filter((t) => t !== null);
    // warning-path: inline
    return { key: `room:${kind || '*'}`, tone: usedUp ? 'bad' : 'attn', title, returnsAt: times.length ? new Date(Math.min(...times)).toISOString() : null, action: { kind: 'ask', about: title } };
  };
  const rooms = outKinds.length && outKinds.length === kinds.length
    ? [room(outKinds.flatMap((k) => k.list), kinds.length === 1 ? kinds[0] : null)]
    : outKinds.map((k) => room(k.list, k.kind));
  return [...machine, ...rooms].sort((a, b) => Number(b.tone === 'bad') - Number(a.tone === 'bad'));
}

/**
 * Build the page. episodes: /subscription-relogin?scope=pool episodes (optional).
 * Returns { ok, needs, notices, accounts, headline, sub, facts, partial, tone }.
 */
export function buildAccountsPage(res, now = Date.now(), { episodes = [], blockers = [], inUse = null, names: extraNames = {}, poolMachines = null } = {}) {
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
    const email = verifiedDisplayName(r.email, r.id);
    const g = byId.get(r.id) || { id: r.id, name: verifiedDisplayName(r.nickname, r.id) || email || 'Account name unavailable', email, framework: r.framework, cells: [], reading: null, readingAt: 0 };
    if (g.name === 'Account name unavailable') g.name = verifiedDisplayName(r.nickname, r.id) || email || g.name;
    if (!g.email && email) g.email = email;
    const ep = epFor(r.id, r.machineId);
    const blocker = blockers.find((b) => b && b.accountId === r.id && b.machineId === r.machineId) || null;
    g.cells.push({ machineId: r.machineId, machine: verifiedDisplayName(r.machineNickname, r.machineId) || 'Machine name unavailable', ...cellState(r, ep, blocker, now), episode: ep, row: r });
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
      // warning-path: row
      tone: t && t.pct >= 90 ? 'bad' : t && t.pct >= 75 ? 'attn' : null,
    };
  }).sort((a, b) => (frameworkName(a.framework)).localeCompare(frameworkName(b.framework)) || (b.tight ? b.tight.pct : -1) - (a.tight ? a.tight.pct : -1));

  const accountKeys = accounts.map((a) => verifiedDisplayName(a.name, a.id)
    ? `${a.name.toLocaleLowerCase()}\u0000${(a.email || '').toLocaleLowerCase()}` : null);
  const machineById = new Map();
  for (const a of accounts) for (const c of a.cells) machineById.set(c.machineId, c.machine);
  const machineCounts = new Map();
  for (const [id, name] of machineById) if (verifiedDisplayName(name, id)) {
    const key = name.toLocaleLowerCase();
    machineCounts.set(key, (machineCounts.get(key) || 0) + 1);
  }
  for (let i = 0; i < accounts.length; i++) for (const c of accounts[i].cells) {
    const accountKey = accountKeys[i];
    c.actionable = Boolean(accountKey && accountKeys.indexOf(accountKey) === accountKeys.lastIndexOf(accountKey)
      && verifiedDisplayName(c.machine, c.machineId) && machineCounts.get(c.machine.toLocaleLowerCase()) === 1);
  }

  const needs = [];
  for (const a of accounts) for (const c of a.cells) {
    if (c.state !== 'attn' || !c.actionable) continue;
    const ep = c.episode;
    const repairable = !c.wrongLogin && ep && (ep.state === 'suggested' || ep.state === 'failed');
    needs.push({
      key: `${a.id}::${c.machineId}`, accountId: a.id, machineId: c.machineId, machine: c.machine,
      title: `Sign in ${frameworkName(a.framework)} (${a.email || a.name}) on ${c.machine}`,
      label: `${frameworkName(a.framework)} · ${a.email || a.name}`,
      sub: !c.actionable ? 'A unique account and machine name are needed before you can act here.' : c.wrongLogin ? `This slot holds ${c.wrongLoginWho || "another account"}'s login, so this account can't run on ${c.machine}.` : repairable ? (ep.state === 'failed' ? 'The last automatic repair stopped safely; you can try again.' : 'An automatic repair is ready to run.') : 'Its sign-in has expired.',
      actionable: c.actionable,
      action: repairable ? (ep.state === 'failed' ? 'retry' : 'approve') : 'start',
      episodeId: ep ? ep.id : null,
      remote: Boolean(c.row.remote),
    });
  }
  // A waiting sign-in (unconfirmed, or repair the agent owns) shows on its row only: a line saying
  // there is nothing to do is not worth the space (operator rule 2026-11-06, topic 134088).
  const usable = accounts.filter((a) => a.cells.some((c) => c.state === 'ok')).length;
  const busiest = accounts.filter((a) => a.tight).sort((a, b) => b.tight.pct - a.tight.pct)[0];
  const notices = accountNotices(accounts, { partial: failed.length > 0, now });
  // The title says what needs the person; otherwise it is just the page name and the notices
  // (each with its own action) sit under it.
  const headline = needs.length ? (needs.length === 1 ? '1 sign-in needs you.' : `${needs.length} sign-ins need you.`) : 'Accounts';
  const facts = [
    // warning-path: inline
    needs.length ? { n: needs.length, label: 'need you', tone: 'attn', href: '#/capacity/accounts?s=needs' } : null,
    // A routine number: one full account among others with room is not a warning (the notices say when it is).
    busiest ? { n: `${Math.round(busiest.tight.pct)}%`, label: `most used · ${busiest.name}` } : null,
    { n: `${usable}/${accounts.length}`, label: 'accounts usable' },
    inUse && inUse.activeAccountId ? { n: (byId.get(inUse.activeAccountId) || {}).name || 'Account name unavailable', label: 'in use here' } : null,
  ].filter(Boolean);
  const machineNames = {};
  for (const r of rows) if (r && r.machineId && r.machineNickname) machineNames[r.machineId] = verifiedDisplayName(r.machineNickname, r.machineId) || machineNames[r.machineId];
  for (const [k, v] of Object.entries(extraNames || {})) if (!machineNames[k]) machineNames[k] = verifiedDisplayName(v, k);
  // Each unreachable machine says how long and whether anything is fixing it (CMT-1541).
  const partial = failed.length ? `${failed.map((f) => unreachableSentence(verifiedDisplayName(f.nickname, f.machineId) || verifiedDisplayName(f.machineNickname, f.machineId) || machineNames[f.machineId] || null,
    poolMachine(poolMachines, f.machineId), f, now)).join(' ')} ${failed.length === 1 ? 'Its accounts' : 'Their accounts'} may be out of date.` : null;
  // warning-path: pageHead
  return { ok: true, needs, notices, accounts, headline, sub: '', facts, partial, tone: needs.length ? 'attn' : 'ok' };
}
