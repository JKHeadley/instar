// "Automatic sign-in repair" section of the Accounts page (docs/specs/one-tap-unattended-repair.md §6).
// Pure: reads the /subscription-relogin?scope=pool body the page already fetched, touches no DOM.

import { verifiedDisplayName } from './display-identity.js';
import { unreachableSentence, poolMachine } from './unreachable-model.js';

/** An older machine that still refuses to be switched on from another machine's dashboard. */
export const NEEDS_UPDATE_TO_SWITCH_ON_WORDS = 'Not changed: that machine needs an Instar update before it can be switched on from here.';

const STATE_WORDS = {
  unattended: 'On, repairs without asking',
  approval: 'On, asks you first',
  observe: 'Watching only',
  off: 'Off',
};

const BLOCKER_WORDS = {
  'profile-unresolved': 'needs a sign-in profile here',
  'profile-directory-missing': 'its sign-in profile folder is missing here',
  'no-open-incident': 'the sign-in failure is not confirmed here yet',
  'device-limit-benched': 'it hit the provider’s device limit',
  'feature-unavailable': 'repair is not running on this machine',
};

/** One plain sentence per result code (the table in spec §6). */
export function resultWords(r) {
  if (!r) return 'No answer.';
  if (r.ok) {
    const base = r.mode === 'approval' ? STATE_WORDS.approval : r.mode === 'unattended' ? STATE_WORDS.unattended : 'Done';
    return r.restartRequested ? `${base} — restarting` : base;
  }
  switch (r.error) {
    case 'route-missing': case 'delivery-refused': return 'This machine refused; it may need an Instar update.';
    case 'target-unreachable': case 'delivery-failed': return 'Couldn’t reach this machine. Try again.';
    case 'stale-config': return 'Its setting changed meanwhile; check the row and tap again.';
    case 'outcome-unknown': return 'May have applied; checking again.';
    // 'owner-must-enable-here' is the answer of a machine on an older Instar; 'operator-unlock-missing'
    // the answer of a new machine to a tap issued by an older one.
    case 'owner-must-enable-here': return NEEDS_UPDATE_TO_SWITCH_ON_WORDS;
    case 'operator-unlock-missing': return 'Not changed: the machine you tapped on needs an Instar update before it can switch other machines on.';
    case 'identity-not-on-this-machine': return 'Not changed: an account on the list is not on that machine.';
    case 'pool-unreadable': return 'Not changed: that machine couldn’t read its own accounts.';
    case 'not-unattended': return 'Not changed: it isn’t set to repair without asking.';
    case 'config-mismatch': case 'not-authorized': return 'Not changed: that machine didn’t accept the permission. It may need an Instar update.';
    default: return 'Not changed: something went wrong on that machine.';
  }
}

function emailsOf(list) {
  return Array.isArray(list) ? list.filter((e) => typeof e === 'string' && e.includes('@')) : null;
}

/**
 * Build the rows. `relogin` is the console `get()` result ({ ok, data }); `names` maps machine id →
 * nickname. Never a raw machine id on screen.
 */
export function buildAutoRepair(relogin, { names = {}, blockers = [], poolMachines = null, now = Date.now() } = {}) {
  if (!relogin || !relogin.ok || !relogin.data) return { ok: false, rows: [] };
  const d = relogin.data;
  const configs = d.pool && Array.isArray(d.pool.configs) ? d.pool.configs : (d.config ? [{ ...d.config, remote: false }] : []);
  const missing = d.pool && Array.isArray(d.pool.configsMissing) ? d.pool.configsMissing : [];
  const failedRows = d.pool && Array.isArray(d.pool.failed) ? d.pool.failed.filter((f) => f && f.machineId) : [];
  const nameOf = (id, nick) => verifiedDisplayName(nick, id) || verifiedDisplayName(names[id], id) || 'A machine';
  const rows = [];
  const seen = new Set();
  for (const c of configs) {
    if (!c || typeof c.machineId !== 'string' || seen.has(c.machineId)) continue;
    seen.add(c.machineId);
    const self = c.remote === false;
    const mode = STATE_WORDS[c.mode] ? c.mode : 'off';
    const current = emailsOf(c.identities) || [];
    const pool = emailsOf(c.verifiedPoolEmails);
    const finalList = pool ? [...pool].sort() : null;
    const removals = finalList ? current.filter((e) => !finalList.includes(e)) : [];
    const uncovered = finalList ? finalList.filter((e) => !current.includes(e)) : [];
    const mins = [Number(c.minimumSuccessfulRepairs) || 0, Number(c.minimumEvidenceDays) || 0];
    const machineBlockers = (Array.isArray(blockers) ? blockers : []).filter((b) => b && b.machineId === c.machineId);
    const stillAsk = machineBlockers.map((b) => BLOCKER_WORDS[b.reason] || 'it can’t be repaired here yet');
    // Any readable machine with accounts can be ticked from any machine's dashboard (operator rule
    // 2026-11-10: every action for the agent from any dashboard).
    const canTurnOn = finalList !== null && finalList.length > 0;
    let blockedWhy = null;
    if (finalList === null) blockedWhy = 'Couldn’t read this machine’s accounts.';
    else if (finalList.length === 0) blockedWhy = 'No accounts on this machine yet.';
    rows.push({
      machineId: c.machineId, name: nameOf(c.machineId, c.machineNickname), self, mode,
      stateWords: STATE_WORDS[mode], revision: typeof c.revision === 'string' ? c.revision : null,
      activationPending: c.activationPending === true,
      identities: current, finalList, removals, uncovered, minimums: mins,
      stillAsk, stillAskTotal: finalList ? finalList.length : 0,
      canTurnOn, canSwitchBack: mode === 'unattended', defaultTick: mode === 'unattended' && canTurnOn,
      blockedWhy,
      waitsLine: mode === 'unattended' && (mins[0] > 0 || mins[1] > 0)
        ? `Will still ask until ${mins[0]} repairs / ${mins[1]} days have passed on each account.` : null,
    });
  }
  for (const id of missing) if (!seen.has(id)) { seen.add(id); rows.push({ machineId: id, name: nameOf(id), unreadable: 'Needs an Instar update first' }); }
  for (const f of failedRows) if (!seen.has(f.machineId)) {
    seen.add(f.machineId);
    // How long it has been out of reach and whether anything is fixing it (CMT-1541).
    const name = nameOf(f.machineId);
    rows.push({ machineId: f.machineId, name, unreadable: unreachableSentence(verifiedDisplayName(names[f.machineId], f.machineId), poolMachine(poolMachines, f.machineId), f, now) });
  }
  rows.sort((a, b) => (b.self === true) - (a.self === true) || String(a.name).localeCompare(String(b.name)));
  return { ok: true, rows };
}

/** The exact request for the tapped button and the ticked rows (spec §2). */
export function configurePayload(rows, ticked, mode) {
  const targets = rows.filter((r) => ticked.has(r.machineId) && r.revision && (mode === 'unattended' ? r.canTurnOn : r.canSwitchBack))
    .map((r) => mode === 'unattended'
      ? { machineId: r.machineId, expectedRevision: r.revision, identities: r.finalList,
          // Turning a machine on (this one or another) sets no waits; a machine already
          // "without asking" keeps its waits.
          minimumSuccessfulRepairs: r.mode !== 'unattended' ? 0 : r.minimums[0],
          minimumEvidenceDays: r.mode !== 'unattended' ? 0 : r.minimums[1] }
      : { machineId: r.machineId, expectedRevision: r.revision, identities: r.identities,
          minimumSuccessfulRepairs: r.minimums[0], minimumEvidenceDays: r.minimums[1] });
  return { mode, targets };
}

/** Is a row confirmed after a write? Revision matches what the write returned and activation is done. */
export function confirmation(row, written) {
  if (!row || !written || !written.revision) return 'unknown';
  if (row.revision !== written.revision) return 'superseded';
  return row.activationPending ? 'pending' : 'confirmed';
}
