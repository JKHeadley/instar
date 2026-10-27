// Machines page — pure view-model (docs/specs/console-features/capacity.md, "Machines").
//
// Machine states use Home's machineState() (the "estimated" mapping) until the
// server's liveness field ships; when a row carries `liveness`, it wins. The
// word "offline" is never used: only positive evidence earns a hard state.
// The load reading and the safety-check count come from shared-counts.js, the
// same source Home reads, so the two pages never disagree on either.

import { ago } from './home-model.js';
import { liveState, loadVerdictOf, guardsNeedingLook, plural } from './shared-counts.js';

const STATE_ORDER = { bad: 0, attn: 1, stale: 2, unknown: 3, ok: 4 };

export function loadVerdict(perCore) { return loadVerdictOf(perCore); }

/** The state from the server's liveness block when present, else the estimate — shared-counts.liveState, the same Home reads. */
export function stateOf(m, now = Date.now()) { return liveState(m, now); }

/**
 * Build the page from /pool (+ optional /health for single-machine installs).
 * extras.guards is GET /guards (local scope): the "need a look" fact is the shared count.
 * Returns { ok, machines:[...], headline, sub, facts, single, look }.
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
    const verdict = st.load ? st.load.verdict : loadVerdict(st.perCore);
    const sessions = extras.sessionsByMachine ? extras.sessionsByMachine[m.machineId] : undefined;
    return {
      id: m.machineId, name: m.nickname || m.machineId, isSelf, ...st, verdict,
      loadWords: st.load ? st.load.words : 'no load reading',
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
  if (struggling.length) subParts.push(struggling.map((r) => `${r.name} is ${r.verdict === 'overloaded' || r.verdict === 'impaired' ? r.verdict : 'slow to answer'}`).join('; ') + '.');
  if (rows.some((r) => r.estimated) && !single) subParts.push('States are estimated from heartbeat age and load until the new live checks ship.');
  const busiest = rows.filter((r) => typeof r.perCore === 'number').sort((a, b) => b.perCore - a.perCore)[0];
  const leader = rows.find((r) => r.leading);
  // The safety-check count: the shared rule, this machine's list, scope stated.
  const look = extras.guards ? guardsNeedingLook(extras.guards, { scope: 'local' }) : (typeof extras.needsLook === 'number' ? { ok: true, count: extras.needsLook, scopeWords: 'on this machine' } : null);
  const facts = [
    { n: `${answering}/${total}`, label: 'answering', tone: answering < total ? 'attn' : null },
    busiest ? { n: busiest.name, label: `busiest · ${busiest.verdict}`, tone: busiest.verdict === 'overloaded' || busiest.verdict === 'impaired' ? 'attn' : null } : null,
    leader ? { n: leader.name, label: 'leading' } : null,
    look && look.ok && look.count ? { n: look.count, label: `need a look ${look.scopeWords}`, tone: 'attn', href: '#/settings/allowed?s=guards' } : null,
  ].filter(Boolean);
  return { ok: true, single, machines: rows, headline, sub: subParts.join(' '), facts, look, tone: dark.length ? 'bad' : struggling.length || unclear.length ? 'attn' : 'ok' };
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

const DEGRADED = new Set(['degraded', 'error', 'failed', 'failing']);

/**
 * This machine's subsystems from /systems/status, in words. A part whose own
 * status report says degraded is named with its reason (the failing probe comes
 * from /health systemReview.failedProbes); the "Safety & Trust" part reports the
 * shared safety-check count (never the server's blanket "All gates active").
 * opts: { health: GET /health, guards: GET /guards }.
 */
export function healthOf(res, opts = {}) {
  if (!res || !res.ok) return { ok: false, reason: res ? res.reason : 'not read' };
  const d = res.data || {};
  const caps = Array.isArray(d.activeCapabilities) ? d.activeCapabilities : [];
  const issues = Array.isArray(d.issues) ? d.issues : null;
  if (!issues) return { ok: false, reason: 'the health check answered without its issue list' };
  const hd = opts.health && opts.health.ok && opts.health.data ? opts.health.data : null;
  const failedProbes = hd && hd.systemReview && Array.isArray(hd.systemReview.failedProbes) ? hd.systemReview.failedProbes : [];
  const look = opts.guards ? guardsNeedingLook(opts.guards, { scope: 'local' }) : null;
  const partRows = caps.filter((c) => c && c.label).map((c) => {
    const procs = Array.isArray(c.processes) ? c.processes : [];
    const degradedProcs = procs.filter((p) => p && p.details && typeof p.details === 'object' && DEGRADED.has(String(p.details.status || '').toLowerCase()));
    const reasons = degradedProcs.map((p) => p.details.message || p.details.status).filter(Boolean);
    const probes = degradedProcs.some((p) => p.name === 'SystemReviewer') && failedProbes.length ? `failing: ${failedProbes.map((p) => p.name || p.probeId).join(', ')}` : null;
    if (c.label === 'Safety & Trust' && look && look.ok) {
      return look.count
        ? { main: c.label, sub: `${plural(look.count, 'safety check')} need${look.count === 1 ? 's' : ''} a look ${look.scopeWords}`, tone: 'attn', bad: true }
        : { main: c.label, sub: `every safety check that should be on is on ${look.scopeWords}` };
    }
    if (c.status && c.status !== 'active') return { main: c.label, sub: c.status, tone: 'attn', bad: true };
    if (degradedProcs.length) return { main: c.label, sub: [c.metric, ...reasons.filter((r) => !String(c.metric || '').includes(r)), probes].filter(Boolean).join(' · '), tone: 'attn', bad: true };
    return { main: c.label, sub: c.metric || '' };
  });
  const bad = partRows.filter((r) => r.bad);
  const working = partRows.length - bad.length;
  const n = issues.length + bad.length;
  const names = [...issues.map((i) => i.title || i.message || i.label || 'an issue'), ...bad.map((r) => r.main)];
  const summary = n
    ? `${plural(n, 'part needs', 'parts need')} a look: ${names.join(', ')}.${partRows.length ? ` ${working} of ${partRows.length} working.` : ''}`
    : `All ${partRows.length} parts working.`;
  return {
    ok: true, summary, working, total: partRows.length,
    failingProbes: failedProbes.map((p) => ({ name: p.name || p.probeId, error: p.error || '' })),
    rows: [
      ...issues.map((i) => ({ main: i.title || i.message || i.label || 'An issue', sub: i.detail || i.description || '', tone: 'attn' })),
      ...bad.map(({ bad: _b, ...r }) => r),
      ...partRows.filter((r) => !r.bad),
    ],
  };
}

/** The sampler keys a row `session:<id>` with the id cut short; match the whole id or its start. */
export function nameOf(shortId, names = {}) {
  if (names[shortId]) return names[shortId];
  if (shortId.length >= 8) { const k = Object.keys(names).find((key) => key.startsWith(shortId)); if (k) return names[k]; }
  return 'A session';
}

/**
 * What is using this machine, from /resources/summary. Every percentage is of ONE
 * core (a process can exceed 100%); the summary says so and names the core count.
 * opts.running: the ids of sessions running now (whole or cut-short ids) — a session no
 * longer running is folded into one line, its last sample never shown as "now".
 */
export function usageOf(res, sessionNames = {}, opts = {}) {
  if (!res || !res.ok) return { ok: false, reason: res ? res.reason : 'not read' };
  const src = Array.isArray(res.data && res.data.sources) ? res.data.sources : null;
  if (!src) return { ok: false, reason: 'the resource summary answered without sources' };
  const gb = (b) => (Number.isFinite(b) ? `${(b / 1e9).toFixed(1)} GB` : '—');
  const agg = src.find((s) => s.source === 'aggregate');
  const server = src.find((s) => s.source === 'agent-server');
  const running = opts.running instanceof Set ? opts.running : null;
  const sessionsAll = src.filter((s) => String(s.source).startsWith('session:'));
  const idOf = (s) => String(s.source).slice(8);
  // The sampler cuts ids short; a running session matches by its whole id or its start (as nameOf does).
  const isRunning = (id) => running.has(id) || (id.length >= 8 && [...running].some((k) => k.startsWith(id)));
  const live = running ? sessionsAll.filter((s) => isRunning(idOf(s))) : sessionsAll;
  const ended = running ? sessionsAll.filter((s) => !isRunning(idOf(s))) : [];
  live.sort((a, b) => (b.currentCpuPercent || 0) - (a.currentCpuPercent || 0));
  const cores = Number(opts.cores);
  const basis = `Percentages are of one core${cores > 0 ? ` (this machine has ${cores})` : ''}.`;
  return {
    ok: true,
    basis,
    summary: agg ? `Instar is using ${Math.round(agg.currentCpuPercent || 0)}% of one core and ${gb(agg.currentRssBytes)} of memory now (peak ${Math.round(agg.peakCpuPercent || 0)}% in the last hour). ${basis}` : `No total reading yet. ${basis}`,
    rows: [
      server ? { main: 'The agent server', sub: `${Math.round(server.currentCpuPercent || 0)}% of a core · ${gb(server.currentRssBytes)}` } : null,
      ...live.slice(0, 5).map((s) => ({ main: nameOf(idOf(s), sessionNames), sub: `${Math.round(s.currentCpuPercent || 0)}% of a core · ${gb(s.currentRssBytes)}` })),
      ended.length ? { main: `${plural(ended.length, 'session')} that ended in the last hour`, sub: 'no longer using anything', tone: 'unknown' } : null,
    ].filter(Boolean),
  };
}
