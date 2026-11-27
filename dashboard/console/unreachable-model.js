// "Couldn't reach <machine>" notices, said the same way on every page (CMT-1541, operator 2026-11-09):
// each one says HOW LONG the machine has been out of reach and WHETHER anything is working to fix it.
// Pure: reads the GET /pool machine row (liveness, ropeCondition, ropeAllDownSince, reconnect) and
// the failed entry of a pooled read ({ machineId, error|reason }). Never invents a duration: with no
// evidence it says the time is not known.

/** "12 min" / "3 hours" / "2 days". */
export function spanWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** The /pool row for a machine id, or null. `pool` is a console get() result or its data. */
export function poolMachine(pool, machineId) {
  const data = pool && pool.data !== undefined ? (pool.ok ? pool.data : null) : pool;
  const list = data && Array.isArray(data.machines) ? data.machines : [];
  return list.find((m) => m && m.machineId === machineId) || null;
}

/**
 * When this machine last actually reached it (epoch ms), or null. Only a direct contact counts
 * (this machine's own check, or a saved record of one); a relayed heartbeat file is not "reached".
 * Falls back to the moment every connection went down.
 */
export function lastReachedAt(machine) {
  const l = machine && machine.liveness;
  if (l && (l.source === 'direct' || l.source === 'saved')) {
    const t = Date.parse(l.evidenceAt);
    if (Number.isFinite(t)) return t;
  }
  const down = machine && Date.parse(machine.ropeAllDownSince);
  return Number.isFinite(down) ? down : null;
}

/** How long, in words: "for 12 min", "just now", or null when not known. */
export function sinceWords(machine, now = Date.now()) {
  const t = lastReachedAt(machine);
  if (t === null) return null;
  if (now - t < 2 * 60_000) return 'just now';
  const span = spanWords(now - t);
  return span ? `for ${span}` : null;
}

/** Is anything fixing it? One plain clause. */
export function fixWords(machine, failure, now = Date.now()) {
  const err = failure && (failure.error || failure.reason);
  if (err === 'unauthorized') return 'it answered but refused this machine, so this will not fix itself';
  const cond = machine && machine.ropeCondition;
  if (cond === 'auth-rejected') return 'it is refusing this machine’s signature, so this will not fix itself';
  if (cond === 'peer-offline') return 'it looks switched off or asleep; it reconnects by itself when it wakes, but nothing here can wake it';
  const r = machine && machine.reconnect;
  const next = r && Date.parse(r.nextTryAt);
  const nextWords = Number.isFinite(next) ? (next - now <= 60_000 ? ' (next try within a minute)' : ` (next try in ${spanWords(next - now)})`) : '';
  if (cond === 'urgent') return `it is running but cut off from this machine; ${r && r.state === 'retrying' ? `this machine keeps retrying${nextWords}, ` : ''}nothing has fixed it yet`;
  if (r && r.state === 'retrying') return `reconnecting by itself${nextWords}`;
  if (r && r.state === 'retrying-slowly') return `retrying by itself at a slow rate${nextWords}, but nothing has worked yet`;
  if (r && r.state === 'connected') return 'its connection works, so it may just be busy; the next refresh asks again';
  return 'not known whether anything is fixing it';
}

/** "Couldn't reach Laptop for 12 min; reconnecting by itself." (Home bars the "No answer from" wording, #2404.) */
export function unreachableSentence(name, machine, failure, now = Date.now()) {
  const since = sinceWords(machine, now);
  const head = `Couldn't reach ${name || 'a machine with no name yet'}${since ? ` ${since}` : ' (for how long is not known)'}`;
  return `${head}; ${fixWords(machine, failure, now)}.`;
}

/** For a line already headed by the machine's name: "not answering for 3 hours; reconnecting by itself". */
export function unreachableClause(machine, failure, now = Date.now()) {
  const since = sinceWords(machine, now);
  return `not answering ${since || '(for how long is not known)'}; ${fixWords(machine, failure, now)}`;
}
