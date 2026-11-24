/** Monotonic worker lifetime and cleanup of one held BrowserServer. No process discovery. */
import { performance } from 'node:perf_hooks';
export class RendererCanceled extends Error {}
export function createRendererLifetime({ now = () => performance.now(), screenMs = 60_000, stepMs = 20 * 60_000, schedule = setTimeout, clear = clearTimeout, report = () => {}, startedAt } = {}) {
  const start = startedAt ?? now(), screenDeadline = start + screenMs, stepDeadline = start + stepMs;
  const events = [], reasons = [];
  let canceled = false, resolveCancel;
  const cancellation = new Promise(resolve => { resolveCancel = resolve; });
  const record = (event) => { const row = { elapsedMs: now() - start, ...event }; events.push(row); report(row); };
  const cancel = reason => { if (!reasons.includes(reason)) { reasons.push(reason); record({ kind: 'cancel', reason }); } if (!canceled) { canceled = true; resolveCancel(reason); } };
  const poll = () => { if (now() >= screenDeadline) cancel('screen-deadline'); if (now() >= stepDeadline) cancel('step-deadline'); };
  const check = () => { poll(); if (canceled) throw new RendererCanceled('Renderer lifetime canceled'); };
  const timer = schedule(() => cancel('screen-deadline'), Math.max(0, screenDeadline - now()));
  const stepTimer = schedule(() => cancel('step-deadline'), Math.max(0, stepDeadline - now()));
  async function phase(name, task) {
    check(); record({ kind: 'phase-start', name });
    const work = Promise.resolve().then(() => { check(); return task(); });
    try {
      const result = await Promise.race([work, cancellation.then(() => { throw new RendererCanceled('Renderer lifetime canceled'); })]);
      check(); record({ kind: 'phase-end', name, outcome: 'completed' }); return result;
    } catch (error) { record({ kind: 'phase-end', name, outcome: 'failed', canceled }); throw error; }
  }
  async function cleanupPhase(name, task, maxMs = Infinity) {
    const allowance = Math.max(0, Math.min(maxMs, stepDeadline - now()));
    record({ kind: 'cleanup-start', name, allowanceMs: allowance });
    let timeout;
    try {
      const result = await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timeout = schedule(() => reject(new RendererCanceled('Cleanup allowance elapsed')), allowance); })]);
      record({ kind: 'cleanup-end', name, outcome: 'completed' }); return result;
    } catch (error) { record({ kind: 'cleanup-end', name, outcome: 'unconfirmed' }); throw error; }
    finally { clear(timeout); }
  }
  return { phase, cleanupPhase, check, cancel, record,
    remainingScreen: () => Math.max(0, screenDeadline - now()), remainingStep: () => Math.max(0, stepDeadline - now()),
    snapshot: () => { poll(); return { canceled, reasons: [...reasons], elapsedMs: now() - start, overrunMs: Math.max(0, now() - screenDeadline), screenBudgetMs: screenMs, stepBudgetMs: stepMs, events: [...events] }; },
    dispose: () => { clear(timer); clear(stepTimer); } };
}

export function createOwnedCleanup({ lifetime, verifyServer, isAlive, report = () => {} }) {
  let launching, server, child, identity, identityError, launchStarted = false, requested = false;
  let cleanupPromise, actualPromise, exited = false, resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const facts = { status: 'not-started', exitObserved: false };
  const record = event => { lifetime.record(event); report(event); };
  function actualCleanup() {
    if (actualPromise) return actualPromise;
    actualPromise = (async () => {
      facts.status = 'cleanup-unconfirmed';
      try { await lifetime.cleanupPhase('official-close', () => server.close(), Math.min(30_000, lifetime.remainingScreen())); }
      catch { lifetime.cancel('graceful-close-incomplete'); }
      if (isAlive(child.pid)) {
        try {
          // Reconfirm held executable/profile identity immediately before the only forced fallback.
          const current = verifyServer(server);
          if (identityError || !identity || current.pid !== identity.pid || current.spawnfile !== identity.spawnfile || current.profileDir !== identity.profileDir) throw new Error('Owned browser identity changed');
          facts.forced = true;
          await lifetime.cleanupPhase('official-kill', () => server.kill());
        } catch { lifetime.cancel('cleanup-unconfirmed'); }
      }
      if (!exited && !identityError) { try { await lifetime.cleanupPhase('actual-exit', () => exit); } catch { lifetime.cancel('cleanup-unconfirmed'); } }
      facts.exitObserved = exited;
      facts.aliveAfterClose = isAlive(child.pid);
      facts.exitCode = child.exitCode; facts.signalCode = child.signalCode;
      facts.status = !identityError && exited && !facts.aliveAfterClose ? (facts.forced || child.signalCode ? 'closed-forced' : 'closed-gracefully') : 'cleanup-unconfirmed';
      if (facts.status === 'cleanup-unconfirmed') lifetime.cancel('cleanup-unconfirmed');
      record({ kind: 'browser-cleanup', ...facts });
      return { ...facts, identity };
    })();
    return actualPromise;
  }
  function registerLaunch(promise) {
    if (launchStarted) throw new Error('Only one owned browser launch is permitted');
    launchStarted = true;
    launching = Promise.resolve(promise).then(value => {
      server = value; child = server.process();
      child.once('exit', () => { exited = true; resolveExit(); record({ kind: 'owned-browser-exit', pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }); });
      if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined) { exited = true; resolveExit(); }
      try { identity = verifyServer(server); record({ kind: 'browser-owned', ...identity }); }
      catch (error) { identityError = error; lifetime.cancel('browser-identity-unconfirmed'); }
      if (requested) actualCleanup().catch(() => lifetime.cancel('cleanup-unconfirmed'));
      return server;
    });
    launching.catch(() => {});
    return launching;
  }
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    requested = true;
    cleanupPromise = (async () => {
      if (!launchStarted) return { status: 'no-browser-started', exitObserved: false };
      try { await lifetime.cleanupPhase('launch-settle', () => launching); }
      catch { lifetime.cancel('launch-cleanup-unconfirmed'); return { status: 'cleanup-unconfirmed', exitObserved: false, missingHandle: !server }; }
      return actualCleanup();
    })();
    return cleanupPromise;
  }
  return { registerLaunch, cleanup, facts: () => ({ ...facts, identity, missingHandle: launchStarted && !server }) };
}
