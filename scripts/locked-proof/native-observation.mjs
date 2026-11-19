/** Strict finite-interval proof. An empty process scan is never actor coverage. */
const integer = n => Number.isSafeInteger(n) && n >= 0;
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function ledgerProblem(snapshot) {
  const l = snapshot?.ledger;
  if (!l || l.schema !== 1 || l.available !== true || l.complete !== true || l.reason !== null
      || !uuid(l.instanceId) || !integer(l.nodePid) || l.nodePid === 0 || !integer(l.sequence) || !Array.isArray(l.entries)
      || l.sequence !== l.entries.length || l.entries.length > 128
      || snapshot.listener?.pid !== l.nodePid || !Number.isFinite(Date.parse(snapshot.listener?.start))) return 'incomplete server history';
  for (const [i, e] of l.entries.entries()) {
    if (e.sequence !== i + 1 || e.attemptId !== `${l.instanceId}:${i + 1}`
        || !/^[a-f0-9-]{36}\.\d+$/.test(e.key) || !integer(e.pid) || e.pid === 0
        || e.spawn !== 'spawned' || !['pending', 'exited'].includes(e.exit)) return 'unmatched spawn attempt';
  }
  return null;
}
export function populationProblem(p) {
  if (p?.isolated !== true || p?.complete !== true || !Array.isArray(p.servers) || p.servers.length !== 2
      || !/^[a-f0-9]{64}$/.test(p.storeId ?? '') || !Array.isArray(p.actors)) return 'isolated A+B population not established';
  if (new Set(p.servers.map(s => s.ledger?.instanceId)).size !== 2) return 'A+B identities are not distinct';
  for (const s of p.servers) { const error = ledgerProblem(s); if (error) return error; }
  const entries = p.servers.flatMap(s => s.ledger.entries);
  if (entries.some(e => e.storeId !== p.storeId)) return 'foreign guard store';
  if (p.actors.some(a => !entries.some(e => e.pid === a.pid && e.exit === 'pending'
      && a.command.split(/\s+/).includes(e.key)))) return 'unknown live guard';
  return null;
}
export function baselineProblem(p) {
  return populationProblem(p) || (p.actors.length || p.servers.some(s => s.ledger.entries.some(e => e.exit !== 'exited'))
    ? 'pre-baseline actors not positively exited' : null);
}
/** Admission for the human action, using the positive baseline rather than a process scan. */
export function watchPopulationProblem(base, population, witness) {
  const problem = baselineProblem(base) || populationProblem(population);
  if (problem) return problem;
  if (!witness || base.storeId !== population.storeId) return 'watch identity missing';
  for (let i = 0; i < 2; i++) {
    const before = base.servers[i], after = population.servers[i];
    if (!same(before.listener, after.listener) || before.ledger.instanceId !== after.ledger.instanceId
        || after.ledger.sequence < before.ledger.sequence
        || !same(before.ledger.entries, after.ledger.entries.slice(0, before.ledger.sequence))) return 'server history discontinuity';
  }
  const added = population.servers.flatMap((s, i) => s.ledger.entries.slice(base.servers[i].ledger.sequence));
  return added.length === 1 && added[0].attemptId === witness.attemptId && added[0].pid === witness.pid
    && added[0].key === witness.key ? null : 'single-guard population not established';
}
function readNativeWatch(snap) {
  if (populationProblem(snap.guardPopulation)) return null;
  for (const [key, m] of Object.entries(snap.markers ?? {})) {
    const w = m.guardWatchObservation;
    const actor = snap.guardPopulation?.actors?.find(a => a.pid === w?.pid);
    if (m.state === 'watching' && w?.schema === 1 && w.complete === true && w.phase === 'watch'
        && w.key === key && w.pid === m.guardPid && w.start === m.guardStart
        && integer(w.count) && w.checkpointCount === w.count && actor
        && Math.floor(Number(w.start)) === Math.floor(Date.parse(actor.start) / 1000)
        && actor.command.split(/\s+/).includes(key)
        && snap.guardPopulation.servers.some(s => s.ledger.entries.some(e => e.attemptId === w.attemptId && e.pid === w.pid && e.key === key))) return w;
  }
  return null;
}
function readNativeCalls(ev, finalPopulation) {
  const reject = reason => ({ method: 'native-watch-counter', complete: false, reason });
  const base = ev.guardBaseline;
  const error = baselineProblem(base) || populationProblem(finalPopulation);
  if (error) return reject(error);
  const end = ev.person?.doneAt;
  if (!Number.isFinite(end) || !Number.isFinite(ev.person?.returnedAt) || end < ev.person.returnedAt) return reject('human return not positively observed');
  if (finalPopulation.servers.some(s => !(s.readStartedAt >= end))) return reject('final server history predates human interval end');
  const checkpoints = ev.samples.map(s => ({ t: s.t, watch: nativeWatch(s) })).filter(s => s.watch);
  const first = checkpoints.find(s => s.t <= ev.person.cuedAt);
  if (!first) return reject('positive watch checkpoint before cue missing');
  const w = first.watch;
  if (!uuid(ev.grantRequestId) || w.key !== `${ev.grantRequestId}.0`) return reject('witness does not match the fresh grant');
  if (checkpoints.some(s => s.watch.attemptId !== w.attemptId || s.watch.count !== w.count)) return reject('watch identity changed');
  const all = [...ev.samples.map(s => s.guardPopulation), finalPopulation];
  let previous = base;
  for (const p of all) {
    const problem = populationProblem(p); if (problem) return reject(problem);
    if (p.storeId !== base.storeId) return reject('guard store changed');
    for (let i = 0; i < 2; i++) {
      const b = base.servers[i], current = p.servers[i];
      if (!same(b.listener, current.listener) || b.ledger.instanceId !== current.ledger.instanceId
          || current.ledger.sequence < b.ledger.sequence
          || !same(b.ledger.entries, current.ledger.entries.slice(0, b.ledger.sequence))) return reject('server history discontinuity');
      const prior = previous.servers[i].ledger;
      if (current.ledger.sequence < prior.sequence || prior.entries.some((old, j) => {
        const next = current.ledger.entries[j];
        return !next || ['sequence', 'attemptId', 'key', 'storeId', 'pid', 'spawn'].some(k => old[k] !== next[k])
          || (old.exit === 'exited' && !same(old, next));
      })) return reject('actor history regressed');
    }
    previous = p;
  }
  const added = finalPopulation.servers.flatMap((s, i) => s.ledger.entries.slice(base.servers[i].ledger.sequence));
  if (added.length !== 1) return reject('single-guard population not established');
  const actor = added[0];
  if (actor.attemptId !== w.attemptId || actor.key !== w.key || actor.pid !== w.pid || actor.exit !== 'exited'
      || actor.exitCode !== 0 || actor.signal !== null) return reject('exact guard clean exit missing');
  const m = ev.final?.markers?.[w.key], f = m?.guardFinalObservation;
  if (m?.state !== 'closed-not-applicable' || (m.guardReplacements ?? 0) !== 0
      || m.guardPid !== w.pid || m.guardStart !== w.start || f?.schema !== 1 || f.complete !== true
      || f.phase !== 'final' || f.terminal !== m.state || !integer(f.count) || f.count < w.count
      || f.attemptId !== w.attemptId || f.key !== w.key || f.pid !== w.pid || f.start !== w.start
      || f.checkpointCount !== w.count) return reject('matching native final witness missing');
  if (ev.id === '12.13' && (!base.servers[0].loginSession || !finalPopulation.servers[0].loginSession
      || base.servers[0].loginSession === finalPopulation.servers[0].loginSession
      || base.servers[1].loginSession !== base.servers[0].loginSession
      || finalPopulation.servers[1].loginSession !== finalPopulation.servers[0].loginSession)) return reject('new login session not observed');
  return { method: 'native-watch-counter', complete: true, intervalStart: first.t, intervalEnd: end,
    actor: { attemptId: w.attemptId, key: w.key, pid: w.pid, start: w.start },
    baselineCount: w.count, finalCount: f.count, lockCalls: f.count - w.count, exactExit: true,
    servers: finalPopulation.servers.map((s, i) => ({ instanceId: s.ledger.instanceId,
      baselineSequence: base.servers[i].ledger.sequence, finalSequence: s.ledger.sequence })) };
}

export function nativeWatch(snap) {
  try { return readNativeWatch(snap); } catch { return null; }
}
export function measureNativeCalls(ev, finalPopulation) {
  try { return readNativeCalls(ev, finalPopulation); }
  catch { return { method: 'native-watch-counter', complete: false, reason: 'malformed observation evidence' }; }
}
