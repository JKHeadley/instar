// Machines page — pure view-model (docs/specs/console-features/capacity.md, "Machines").
//
// Machine states use Home's machineState() (the "estimated" mapping) until the
// server's liveness field ships; when a row carries `liveness`, it wins. The
// word "offline" is never used: only positive evidence earns a hard state.

import { machineState, ago } from './home-model.js';
import { verifiedDisplayName } from './display-identity.js';

const STATE_ORDER = { bad: 0, attn: 1, stale: 2, unknown: 3, ok: 4 };

export function loadVerdict(perCore) {
  if (typeof perCore !== 'number' || !Number.isFinite(perCore)) return null;
  if (perCore > 2) return 'overloaded';
  if (perCore > 1) return 'busy';
  return 'ok';
}

/** The state from the server's liveness block when present, else the estimate. */
export function stateOf(m, now = Date.now()) {
  const lv = m && m.liveness;
  if (lv && typeof lv.state === 'string') {
    const map = { live: 'ok', struggling: 'attn', refusing: 'attn', silent: 'bad', stale: 'stale', unknown: 'unknown' };
    const age = lv.evidenceAt ? ago(lv.evidenceAt, now) : null;
    return { state: map[lv.state] || 'unknown', label: lv.state, age, estimated: false, source: lv.source || null };
  }
  return { ...machineState(m, now), estimated: true };
}

/**
 * Build the page from /pool (+ optional /health for single-machine installs).
 * Returns { ok, machines:[...], headline, sub, facts, single }.
 */
export function buildMachinesPage(poolRes, healthRes, now = Date.now(), extras = {}) {
  if (!poolRes.ok) return { ok: false, reason: `Couldn't read the machine pool: ${poolRes.reason}.` };
  const d = poolRes.data || {};
  let machines = Array.isArray(d.machines) ? d.machines : null;
  const single = !machines || machines.length === 0;
  if (single) {
    // A single-machine agent still gets one card (the pool can be off).
    machines = [{ machineId: 'self', nickname: 'Your machine', isSelf: true, online: true, routerReceivedAt: new Date(now).toISOString() }];
  }
  const selfId = d.selfMachineId;
  const routerId = d.router && (d.router.machineId || d.router.holder || d.router);
  const rows = machines.map((m) => {
    const st = stateOf(m, now);
    const isSelf = Boolean(m.isSelf || (selfId && m.machineId === selfId));
    const verdict = loadVerdict(st.perCore);
    const sessions = extras.sessionsByMachine ? extras.sessionsByMachine[m.machineId] : undefined;
    return {
      id: m.machineId, name: verifiedDisplayName(m.nickname, m.machineId) || 'a machine with no name yet', isSelf, ...st, verdict,
      leading: Boolean(routerId && routerId === m.machineId),
      sessions,
      hardware: m.hardware || null,
      rope: m.ropeCondition || null,
      record: m,
    };
  // Order never depends on which machine served the page: trouble first, then the leading machine.
  }).sort((a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || Number(b.leading) - Number(a.leading) || a.name.localeCompare(b.name));

  const total = rows.length;
  const answering = rows.filter((r) => r.state === 'ok' || r.state === 'attn').length;
  const struggling = rows.filter((r) => r.state === 'attn');
  const dark = rows.filter((r) => r.state === 'bad');
  const unclear = rows.filter((r) => r.state === 'stale' || r.state === 'unknown');
  let headline;
  if (single) headline = 'One machine, answering.';
  else if (dark.length) headline = dark.length === 1 ? `${dark[0].name} isn't answering.` : `${dark.length} machines aren't answering.`;
  else if (struggling.length) headline = struggling.length === 1 ? `${struggling[0].name} is struggling.` : `${struggling.length} machines are struggling.`;
  else if (unclear.length) headline = unclear.length === 1 ? `I can't see ${unclear[0].name} clearly right now.` : `I can't see ${unclear.length} machines clearly right now.`;
  else headline = total === 2 ? 'Both machines are answering.' : `All ${total} machines are answering.`;
  const subParts = [];
  if (dark.length) subParts.push(dark.map((r) => `${r.name}: last heard ${r.age || 'never since the agent last started'}`).join('; ') + '.');
  if (struggling.length) subParts.push(struggling.map((r) => `${r.name} is ${r.verdict === 'overloaded' ? 'overloaded' : 'slow to answer'}`).join('; ') + '.');
  if (rows.some((r) => r.estimated) && !single) subParts.push('States are estimated from heartbeat age and load until the new live checks ship.');
  const busiest = rows.filter((r) => typeof r.perCore === 'number').sort((a, b) => b.perCore - a.perCore)[0];
  const leader = rows.find((r) => r.leading);
  const facts = [
    // warning-path: pageHead
    { n: `${answering}/${total}`, label: 'answering', tone: answering < total ? 'attn' : null },
    // warning-path: pageHead
    busiest ? { n: busiest.name, label: `busiest · ${busiest.verdict}`, tone: busiest.verdict === 'overloaded' ? 'attn' : null } : null,
    leader ? { n: leader.name, label: 'leading' } : null,
    // warning-path: inline
    extras.needsLook ? { n: extras.needsLook, label: 'need a look', tone: 'attn', href: '#/settings/allowed' } : null,
  ].filter(Boolean);
  // warning-path: pageHead
  return { ok: true, single, machines: rows, headline, sub: subParts.join(' '), facts, tone: dark.length ? 'bad' : struggling.length || unclear.length ? 'attn' : 'ok' };
}

/** Ropes (connections) to one peer, from /health multiMachine.syncStatus.ropeHealth. */
const ROPE_WORDS = { tailscale: 'Tailscale', lan: 'Local network', cloudflare: 'Tunnel' };
export function ropesFor(peerId, healthRes, now = Date.now()) {
  const list = healthRes && healthRes.ok && healthRes.data && healthRes.data.multiMachine && healthRes.data.multiMachine.syncStatus && healthRes.data.multiMachine.syncStatus.ropeHealth;
  if (!Array.isArray(list)) return null;
  return list.filter((r) => r.peer === peerId).map((r) => ({
    kind: ROPE_WORDS[r.kind] || r.kind,
    // A rope never actually exercised is unknown, whatever its default label says.
    // warning-path: askLink
    state: !r.lastResultAt || r.state === 'unknown' ? 'unknown' : r.state === 'healthy' ? 'ok' : 'bad',
    label: !r.lastResultAt ? 'not checked yet' : r.state === 'healthy' ? `working · ${ago(r.lastResultAt, now)}` : `failing · ${r.consecutiveFailures} in a row`,
  }));
}

/** This machine's subsystems from /systems/status, in words. */
export function healthOf(res) {
  if (!res || !res.ok) return { ok: false, reason: res ? res.reason : 'not read' };
  const d = res.data || {};
  const caps = Array.isArray(d.activeCapabilities) ? d.activeCapabilities : [];
  const issues = Array.isArray(d.issues) ? d.issues : null;
  if (!issues) return { ok: false, reason: 'the health check answered without its issue list' };
  const notActive = caps.filter((c) => c && c.status && c.status !== 'active');
  return {
    ok: true,
    summary: issues.length || notActive.length ? `${issues.length + notActive.length} ${issues.length + notActive.length === 1 ? 'part needs' : 'parts need'} a look.` : `All ${caps.length} parts working.`,
    rows: [
      // warning-path: askLink
      ...issues.map((i) => ({ main: i.title || i.message || i.label || 'An issue', sub: i.detail || i.description || '', tone: 'attn' })),
      // warning-path: askLink
      ...notActive.map((c) => ({ main: c.label, sub: c.status, tone: 'attn' })),
      ...caps.filter((c) => c && c.status === 'active').map((c) => ({ main: c.label, sub: c.metric || '' })),
    ],
  };
}

/** What is using this machine, from /resources/summary. */
export function usageOf(res, sessionNames = {}) {
  if (!res || !res.ok) return { ok: false, reason: res ? res.reason : 'not read' };
  const src = Array.isArray(res.data && res.data.sources) ? res.data.sources : null;
  if (!src) return { ok: false, reason: 'the resource summary answered without sources' };
  const gb = (b) => (Number.isFinite(b) ? `${(b / 1e9).toFixed(1)} GB` : '—');
  const agg = src.find((s) => s.source === 'aggregate');
  const server = src.find((s) => s.source === 'agent-server');
  const sessions = src.filter((s) => String(s.source).startsWith('session:')).sort((a, b) => (b.currentCpuPercent || 0) - (a.currentCpuPercent || 0));
  return {
    ok: true,
    summary: agg ? `Instar is using ${Math.round(agg.currentCpuPercent || 0)}% CPU and ${gb(agg.currentRssBytes)} of memory now (peak ${Math.round(agg.peakCpuPercent || 0)}% in the last hour).` : 'No total reading yet.',
    rows: [
      server ? { main: 'The agent server', sub: `${Math.round(server.currentCpuPercent || 0)}% CPU · ${gb(server.currentRssBytes)}` } : null,
      ...sessions.slice(0, 5).map((s) => ({ main: sessionNames[String(s.source).slice(8)] || 'A session', sub: `${Math.round(s.currentCpuPercent || 0)}% CPU · ${gb(s.currentRssBytes)}` })),
    ].filter(Boolean),
  };
}

/**
 * Resource use on every machine, from the pooled GET /mobile/resources (the same read the phone
 * uses). Returns { ok, summary, busiest, byName: {name: {line, state, rows}} }. An older server
 * answers its own machine only (no `machines`): that is shown as the one machine it is.
 */
export function poolUsageOf(res) {
  if (!res || !res.ok || !res.data) return { ok: false, reason: res ? res.reason : 'not read' };
  const d = res.data;
  const gb = (b) => (Number.isFinite(b) ? `${(b / 1e9).toFixed(1)} GB` : '—');
  const rowOf = (p) => ({ main: p.name || 'A session', sub: p.ended ? 'ended' : `${Math.round(p.cpuPercent || 0)}% CPU · ${gb(p.memoryBytes)}` });
  if (!Array.isArray(d.machines)) {
    if (typeof d.headline !== 'string') return { ok: false, reason: 'the resource answer had no headline' };
    const rows = [d.server ? rowOf(d.server) : null, ...(Array.isArray(d.sessions) ? d.sessions.slice(0, 5).map(rowOf) : [])].filter(Boolean);
    return { ok: true, pooled: false, summary: d.headline, busiest: null, byName: d.machine ? { [d.machine]: { line: d.headline, state: d.enabled ? 'answering' : 'off', rows } } : {} };
  }
  const byName = {};
  for (const m of d.machines) {
    if (!m || typeof m.name !== 'string') continue;
    byName[m.name] = { line: m.line, state: m.state, rows: [m.server ? rowOf(m.server) : null, ...(Array.isArray(m.sessions) ? m.sessions.map(rowOf) : [])].filter(Boolean) };
  }
  const c = d.combined || {};
  return { ok: true, pooled: true, summary: c.headline || '', busiest: c.busiest || null, notAnswering: Array.isArray(c.notAnswering) ? c.notAnswering : [], byName };
}

/** One line for this machine's care status. Watch-only, so it never implies a restart will happen. */
export function machineCareLine(r) {
  if (!r || !r.ok || !r.data) return null;
  const d = r.data;
  const uptime = typeof d.uptimeDays === 'number' ? `Up ${d.uptimeDays} days` : 'Uptime unread';
  const held = (Array.isArray(d.safetyHolds) ? d.safetyHolds : []).filter((h) => h.active).map((h) => h.label);
  const night = d.lastRehearsal;
  const last = !night ? 'No practice run yet'
    : night.outcome === 'would-restart' ? 'Last practice run: would have restarted'
    : night.outcome === 'would-roll' ? 'Last practice run: would have waited a night'
    : night.outcome === 'would-hold' ? 'Last practice run: would have been held'
    : 'Last practice run: outcome unknown';
  return [`Restart care is watching only, nothing restarts.`, uptime, last, held.length ? `Holding now: ${held.join(', ')}` : null].filter(Boolean).join(' · ');
}

const CARE_FAILED = {
  offline: 'offline',
  'not-enabled': 'not turned on there',
  'route-missing': 'on an older version',
  unauthorized: 'did not accept this machine',
  'url-rejected': 'no safe connection',
  'peer-unreachable': 'did not answer',
  'read-failed': 'its reading failed',
};

/** One short care line for one machine's state (no repeated "watching only" preface). */
function careShort(d) {
  const uptime = typeof d.uptimeDays === 'number' ? `Up ${d.uptimeDays} days` : 'Uptime unread';
  const held = (Array.isArray(d.safetyHolds) ? d.safetyHolds : []).filter((h) => h && h.active).map((h) => h.label);
  const night = d.lastRehearsal;
  const last = !night ? 'no practice run yet'
    : night.outcome === 'would-restart' ? 'practice run: would have restarted'
    : night.outcome === 'would-roll' ? 'practice run: would have waited a night'
    : night.outcome === 'would-hold' ? 'practice run: would have been held'
    : 'practice run: outcome unknown';
  return [uptime, last, held.length ? `holding: ${held.join(', ')}` : null].filter(Boolean).join(' · ');
}

/**
 * Restart care across the pool (GET /machine-maintenance?scope=pool, CMT-1199).
 * Returns { header, byMachine: {machineId: line}, selfLine, missing: [line] } or null.
 * An older server ignores scope and answers its own status only: treated as self.
 */
export function machineCarePool(r) {
  if (!r || !r.ok || !r.data) return null;
  const d = r.data;
  const header = 'Restart care is watching only, nothing restarts.';
  if (!Array.isArray(d.machines)) {
    return { header, byMachine: {}, selfLine: careShort(d), missing: [] };
  }
  const byMachine = {};
  let selfLine = null;
  for (const m of d.machines) {
    if (!m || !m.state) continue;
    const line = careShort(m.state);
    byMachine[m.machineId] = line;
    if (m.self) selfLine = line;
  }
  const failed = d.pool && Array.isArray(d.pool.failed) ? d.pool.failed : [];
  const missing = failed.map((f) => `${f.machineNickname || 'a machine with no name yet'}: can’t tell, ${CARE_FAILED[f.reason] || 'no answer'}`);
  return { header, byMachine, selfLine, missing };
}
