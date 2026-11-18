/**
 * promiseHandoff — the two small stateful helpers of overdue-promise follow-through
 * (docs/specs/overdue-promise-follow-through.md §3.2–§3.3).
 *
 * - `makeHandOffPromise`: hand a promise to the topic's RUNNING session as a
 *   system notice. It never spawns or respawns, never goes through the inbound
 *   user-message pipeline (no sender gates, acknowledgements, standby timers),
 *   and uses the paste-notification inject, which does no response tracking —
 *   so a session that dies later can never re-post the text as a user message.
 * - `makeLateEpochStore`: the write-once "first live pass" timestamp that
 *   bounds the backlog window, one file per machine.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface HandOffDeps {
  /** The tmux session mapped to a topic on THIS machine, or null. */
  getSessionForTopic: (topicId: number) => string | null;
  isSessionAlive: (session: string) => boolean;
  /** SessionManager.injectPasteNotificationObserved. */
  injectObserved: (session: string, text: string) => Promise<{ state: string }>;
  log?: (line: string) => void;
}

export function makeHandOffPromise(deps: HandOffDeps): (topicId: number, text: string) => Promise<boolean> {
  return async (topicId, text) => {
    const session = deps.getSessionForTopic(topicId);
    if (!session) return false;
    if (!deps.isSessionAlive(session)) return false;
    try {
      const r = await deps.injectObserved(session, text);
      return r.state === 'submitted' || r.state === 'queued-busy';
    } catch (err) {
      (deps.log ?? console.warn)(`[promise-handoff] inject into ${session} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
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
