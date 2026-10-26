// Machines page — pure view-model (docs/specs/console-features/capacity.md, "Machines").
//
// Machine states use Home's machineState() (the "estimated" mapping) until the
// server's liveness field ships; when a row carries `liveness`, it wins. The
// word "offline" is never used: only positive evidence earns a hard state.

import { machineState, ago } from './home-model.js';

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
    // A single-machine agent still gets a "This machine" card (the pool can be off).
    machines = [{ machineId: 'self', nickname: 'This machine', isSelf: true, online: true, routerReceivedAt: new Date(now).toISOString() }];
  }
  const selfId = d.selfMachineId;
  const routerId = d.router && (d.router.machineId || d.router.holder || d.router);
  const rows = machines.map((m) => {
    const st = stateOf(m, now);
    const isSelf = Boolean(m.isSelf || (selfId && m.machineId === selfId));
    const verdict = loadVerdict(st.perCore);
    const sessions = extras.sessionsByMachine ? extras.sessionsByMachine[m.machineId] : undefined;
    return {
      id: m.machineId, name: m.nickname || m.machineId, isSelf, ...st, verdict,
      leading: Boolean(routerId && routerId === m.machineId),
      sessions,
      hardware: m.hardware || null,
      rope: m.ropeCondition || null,
      record: m,
    };
  }).sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || a.name.localeCompare(b.name));

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
  if (dark.length) subParts.push(dark.map((r) => `${r.name}: last heard ${r.age || 'never since this server started'}`).join('; ') + '.');
  if (struggling.length) subParts.push(struggling.map((r) => `${r.name} is ${r.verdict === 'overloaded' ? 'overloaded' : 'slow to answer'}`).join('; ') + '.');
  if (rows.some((r) => r.estimated) && !single) subParts.push('States are estimated from heartbeat age and load until the new live checks ship.');
  const busiest = rows.filter((r) => typeof r.perCore === 'number').sort((a, b) => b.perCore - a.perCore)[0];
  const leader = rows.find((r) => r.leading);
  const facts = [
    { n: `${answering}/${total}`, label: 'answering', tone: answering < total ? 'attn' : null },
    busiest ? { n: busiest.name, label: `busiest · ${busiest.verdict}`, tone: busiest.verdict === 'overloaded' ? 'attn' : null } : null,
    leader ? { n: leader.name, label: 'leading' } : null,
    extras.needsLook ? { n: extras.needsLook, label: 'need a look', tone: 'attn' } : null,
  ].filter(Boolean);
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
      ...issues.map((i) => ({ main: i.title || i.message || i.label || 'An issue', sub: i.detail || i.description || '', tone: 'attn' })),
      ...notActive.map((c) => ({ main: c.label, sub: c.status, tone: 'attn' })),
      ...caps.filter((c) => c && c.status === 'active').map((c) => ({ main: c.label, sub: c.metric || '' })),
    ],
  };
}

/** The sampler keys a row `session:<id>` with the id cut short; match the whole id or its start. */
export function nameOf(shortId, names = {}) {
  if (names[shortId]) return names[shortId];
  if (shortId.length >= 8) { const k = Object.keys(names).find((key) => key.startsWith(shortId)); if (k) return names[k]; }
  return 'A session';
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
      ...sessions.slice(0, 5).map((s) => ({ main: nameOf(String(s.source).slice(8), sessionNames), sub: `${Math.round(s.currentCpuPercent || 0)}% CPU · ${gb(s.currentRssBytes)}` })),
    ].filter(Boolean),
  };
}
