/**
 * promiseHandoff — the stateful edge helpers of promise keeping
 * (docs/specs/promise-keeping-before-the-deadline.md §3.1, §3.6).
 *
 * - `makePickUp`: hand a promise to the topic's session. A RUNNING session
 *   gets the notice through the paste-notification inject (no response
 *   tracking). With none running, a start is LAUNCHED through the direct
 *   spawn path (`spawnPromiseWork`, never the inbound message pipeline) and
 *   reported `pending`; its result arrives later through `onSettled`. A start
 *   is only launched on the lease holder, inside the shared automatic-start
 *   gate, below `maxSessions`, and when the pass's start budget allows.
 * - `makeLateEpochStore`: the write-once "first live pass" timestamp that
 *   bounds the backlog window, one file per machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PickupOutcome, PickupRequest } from './promiseKeepingPass.js';

export interface PromiseWorkRuntime {
  /** The tmux session mapped to a topic on THIS machine, or null. */
  getSessionForTopic: (topicId: number) => string | null;
  isSessionAlive: (session: string) => boolean;
  /** SessionManager.injectPasteNotificationObserved. */
  injectObserved: (session: string, text: string) => Promise<{ state: string }>;
  /** Lease holder (single-machine agents count as the holder). */
  holdsLease: () => boolean;
  /** The ResumeQueue already owns this topic's restart. */
  resumeQueueOwns: (topicId: number) => boolean;
  /** The shared automatic-start gate plus "running sessions below maxSessions". */
  capacity: () => { ok: true } | { ok: false; reason: string };
  /** spawnSessionForTopic with systemNotice, quiet, admissionKind 'automatic', triggeredBy. */
  spawnPromiseWork: (topicId: number, bootstrap: string, triggeredBy: string) => Promise<string>;
  /** Session record facts for a running tmux session (null = unknown). `idleSince` = idle at its prompt with no running child process since then. */
  sessionInfo?: (tmuxSession: string) => { idleSince?: string; triggeredBy?: string; startedAt?: string; topicId?: number } | null;
  /** The person wrote in this topic at or after sinceMs? null = history does not reach back that far (unknown). */
  personWroteSince?: (topicId: number, sinceMs: number) => boolean | null;
  /** In the configured protected-session list. */
  isProtected?: (tmuxSession: string) => boolean;
  /** End a session (SessionManager.killSessionByTmuxName). Every guard is the caller's. */
  release?: (tmuxSession: string) => boolean;
  log?: (line: string) => void;
}

/**
 * A promise-work session this feature may end (§3.6 release rule): started by
 * promise follow-through, not protected, and the person has NOT written in its
 * conversation since it started. Any unknown clause → false (never ended).
 */
export function isReleasablePromiseWork(rt: PromiseWorkRuntime, tmuxSession: string): boolean {
  const info = rt.sessionInfo?.(tmuxSession);
  if (!info || typeof info.triggeredBy !== 'string' || !info.triggeredBy.startsWith('promise-work:')) return false;
  if (!rt.isProtected || rt.isProtected(tmuxSession)) return false;
  if (typeof info.topicId !== 'number' || !info.startedAt) return false;
  const wrote = rt.personWroteSince?.(info.topicId, Date.parse(info.startedAt));
  return wrote === false;
}

/** Build the pickup function the pass calls (§3.1 typed outcomes). */
export function makePickUp(rt: PromiseWorkRuntime): (req: PickupRequest) => Promise<PickupOutcome> {
  const log = rt.log ?? console.warn;
  return async (req) => {
    let bound = rt.getSessionForTopic(req.topicId);
    // §3.1 a live but stuck session: idle at its prompt with no child process since the first
    // notice means it did not take the work. A releasable promise-work session is ended and a
    // fresh one started; any other session is left alone and the attempt counts as failed.
    if (bound && rt.isSessionAlive(bound) && req.stuckIfIdleSince) {
      const info = rt.sessionInfo?.(bound);
      const idle = Date.parse(info?.idleSince ?? '');
      if (Number.isFinite(idle) && idle <= Date.parse(req.stuckIfIdleSince)) {
        if (isReleasablePromiseWork(rt, bound) && rt.release?.(bound)) {
          log(`[promise-pickup] released stuck promise-work session ${bound} for topic ${req.topicId}`);
          bound = null;
        } else {
          return { kind: 'failed', error: 'session-stuck' };
        }
      }
    }
    if (bound && rt.isSessionAlive(bound)) {
      try {
        const r = await rt.injectObserved(bound, req.bootstrap);
        return r.state === 'submitted' || r.state === 'queued-busy' ? { kind: 'notified' } : { kind: 'failed', error: `inject ${r.state}` };
      } catch (err) {
        return { kind: 'failed', error: `inject: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (!rt.holdsLease()) return { kind: 'held', reason: 'not-holder' };
    if (rt.resumeQueueOwns(req.topicId)) return { kind: 'held', reason: 'resume-queue-owns' };
    if (!req.mayStart) return { kind: 'held', reason: 'promise-limit' };
    const cap = rt.capacity();
    if (!cap.ok) return { kind: 'held', reason: 'capacity' };
    // Launch, never await: a spawn that never settles cannot stall the pass.
    let settled = false;
    const settle = (o: Exclude<PickupOutcome, { kind: 'pending' }>) => { if (!settled) { settled = true; req.onSettled(o); } };
    try {
      void rt.spawnPromiseWork(req.topicId, req.bootstrap, req.triggeredBy).then(
        (session) => settle(session ? { kind: 'started', session } : { kind: 'failed', error: 'spawn returned no session' }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`[promise-pickup] start for topic ${req.topicId} failed: ${msg}`);
          settle({ kind: 'failed', error: msg });
        },
      );
    } catch (err) {
      return { kind: 'failed', error: `spawn: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { kind: 'pending' };
  };
}

export const LATE_EPOCH_FILE = 'late-notice-epoch.json';

export function makeLateEpochStore(stateDir: string): { read: () => number | null; writeOnce: (ms: number) => number } {
  const file = path.join(stateDir, 'state', LATE_EPOCH_FILE);
  const read = (): number | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { epoch?: unknown };
      const ms = typeof raw.epoch === 'string' ? Date.parse(raw.epoch) : NaN;
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null; // @silent-fallback-ok — absent/corrupt means "no live pass yet"; writeOnce re-creates it
    }
  };
  const writeOnce = (ms: number): number => {
    const existing = read();
    if (existing !== null) return existing;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 'wx' makes the write exclusive: a racing writer loses and we re-read its value.
      fs.writeFileSync(file, JSON.stringify({ epoch: new Date(ms).toISOString() }) + '\n', { flag: 'wx' });
      return ms;
    } catch {
      return read() ?? ms; // @silent-fallback-ok — lost the race or read-only disk: use what is there, else this pass's time
    }
  };
  return { read, writeOnce };
}
