/**
 * FollowMeCompletionWatcher — drives a follow-me sign-in to a TERMINAL state after
 * the operator's paste-back code was delivered.
 *
 * The defect it closes (operator report 2026-11-10, topic 33890): submit-code waits
 * two seconds for the credential, then answers `submitted` ("code sent; finishing
 * sign-in"). Nothing then finished the sign-in except a background sweep on a
 * five-minute tick, and nothing told the page what happened. The CLI had in fact
 * finished, but the login stayed `pending` and the account stayed `needs-reauth`
 * until it was completed by hand, while the dialog sat looking stalled.
 *
 * After a submitted code, the route calls `watch(id)`. The watcher polls on a short
 * interval through the SAME identity-verified completion the sweep uses
 * (`EnrollmentWizard.completeLanded`), and ends in exactly one terminal state:
 *  - `done`   — the login validated as the expected account; the pool row is active.
 *  - `failed` — with a plain reason: the wrong account signed in (held by the email
 *               gate), the sign-in window closed without a usable sign-in, the
 *               sign-in was cancelled or vanished, or the bounded wait ran out.
 * `get(id)` exposes the state so a page can poll it.
 *
 * Machine-local by design: the login pane and its credential slot live on this
 * machine. The fronting dashboard reads it through the completion relay route.
 * State is in memory; after a restart the route falls back to the durable
 * pending-login record.
 */

import type { PendingLogin } from './PendingLoginStore.js';
import type { EnrollmentWizard } from './EnrollmentWizard.js';

export type FollowMeCompletionState = 'finishing' | 'done' | 'failed';

export type FollowMeCompletionFailure =
  | 'wrong-account'
  | 'window-closed'
  | 'timed-out'
  | 'cancelled'
  | 'gone'
  | 'could-not-save';

export interface FollowMeCompletionSnapshot {
  id: string;
  state: FollowMeCompletionState;
  startedAt: string;
  deadlineAt: string;
  finishedAt?: string;
  email?: string;
  reason?: FollowMeCompletionFailure;
  /** The held reason from the email gate, when reason is wrong-account. */
  heldReason?: string;
  expected?: string | null;
  got?: string | null;
  /** One plain sentence for the page. */
  message: string;
}

export interface FollowMeCompletionWatcherDeps {
  wizard: Pick<EnrollmentWizard, 'completeLanded'>;
  /** Tri-state pane liveness for the login (true alive, false gone, null unknown). */
  paneAlive: (id: string) => boolean | null;
  /** Called inside the store's CAS on a validated completion (pool upsert). */
  onValidated: (login: PendingLogin, email: string) => void;
  /** Best-effort follow-up after a validated completion (fresh quota/identity read). */
  afterValidated?: (login: PendingLogin) => Promise<void>;
  targetMachineNickname?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
  /** After the window closes, keep checking the auth revision this long before the live probe. */
  windowClosedGraceMs?: number;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

const MESSAGES: Record<FollowMeCompletionFailure, string> = {
  'wrong-account': 'A different account signed in, so it was not added.',
  'window-closed': 'The sign-in window closed without a sign-in this machine could confirm.',
  'timed-out': 'The sign-in did not finish in time. If it finishes later, the account shows as signed in by itself.',
  cancelled: 'This sign-in was cancelled.',
  gone: 'This sign-in is no longer open.',
  'could-not-save': 'The sign-in finished, but the account could not be saved.',
};

export class FollowMeCompletionWatcher {
  private readonly states = new Map<string, FollowMeCompletionSnapshot>();
  private readonly running = new Map<string, Promise<FollowMeCompletionSnapshot>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly graceMs: number;

  constructor(private readonly deps: FollowMeCompletionWatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.pollMs = deps.pollMs ?? 2_000;
    this.timeoutMs = deps.timeoutMs ?? 150_000;
    this.graceMs = deps.windowClosedGraceMs ?? 6_000;
  }

  /** Start (or join) the watch for a submitted login. Returns the current snapshot. */
  watch(id: string): FollowMeCompletionSnapshot {
    this.prune();
    const existing = this.states.get(id);
    if (existing && existing.state === 'finishing' && this.running.has(id)) return { ...existing };
    const startedMs = this.now();
    const snap: FollowMeCompletionSnapshot = {
      id,
      state: 'finishing',
      startedAt: new Date(startedMs).toISOString(),
      deadlineAt: new Date(startedMs + this.timeoutMs).toISOString(),
      message: 'Finishing the sign-in…',
    };
    this.states.set(id, snap);
    const run = this.run(id, startedMs).finally(() => this.running.delete(id));
    this.running.set(id, run);
    return { ...snap };
  }

  /** Finished watches are kept for half an hour so a page can still read the answer, then dropped. */
  private prune(): void {
    const cutoff = this.now() - 30 * 60_000;
    for (const [id, snap] of this.states) {
      if (snap.state !== 'finishing' && snap.finishedAt && Date.parse(snap.finishedAt) < cutoff) this.states.delete(id);
    }
  }

  /** The current snapshot, or null when this watcher never saw the login. */
  get(id: string): FollowMeCompletionSnapshot | null {
    const s = this.states.get(id);
    return s ? { ...s } : null;
  }

  /** Test seam: await the in-flight watch for a login. */
  settled(id: string): Promise<FollowMeCompletionSnapshot | null> {
    return this.running.get(id) ?? Promise.resolve(this.get(id));
  }

  private finish(id: string, patch: Partial<FollowMeCompletionSnapshot> & { state: 'done' | 'failed' }): FollowMeCompletionSnapshot {
    const prior = this.states.get(id)!;
    const next: FollowMeCompletionSnapshot = { ...prior, ...patch, finishedAt: new Date(this.now()).toISOString() };
    this.states.set(id, next);
    const log = this.deps.logger;
    if (next.state === 'done') log?.log(`[follow-me] completion-watch outcome=done id=${id}`);
    else log?.warn(`[follow-me] completion-watch outcome=failed id=${id} reason=${next.reason}`);
    return { ...next };
  }

  private failed(id: string, reason: FollowMeCompletionFailure, extra: Partial<Omit<FollowMeCompletionSnapshot, 'state'>> = {}): FollowMeCompletionSnapshot {
    return this.finish(id, { state: 'failed', reason, message: MESSAGES[reason], ...extra });
  }

  private async done(id: string, login: PendingLogin, email: string): Promise<FollowMeCompletionSnapshot> {
    try { await this.deps.afterValidated?.(login); }
    catch { /* @silent-fallback-ok — the completion stands; the poll loop re-reads quota later */ }
    return this.finish(id, { state: 'done', email, message: `Signed in as ${email}.` });
  }

  private async attempt(id: string, proof: 'auth-revision' | 'live-identity') {
    return this.deps.wizard.completeLanded(id, {
      proof,
      onValidated: this.deps.onValidated,
      targetMachineNickname: this.deps.targetMachineNickname,
    });
  }

  /** Map a terminal wizard outcome to a terminal snapshot; null means keep waiting. */
  private async settle(
    id: string,
    r: Awaited<ReturnType<FollowMeCompletionWatcher['attempt']>>,
  ): Promise<FollowMeCompletionSnapshot | null> {
    switch (r.outcome) {
      case 'validated': return this.done(id, r.login, r.email);
      case 'held': return this.failed(id, 'wrong-account', { heldReason: r.reason, expected: r.expected, got: r.got });
      case 'finalize-failed': return this.failed(id, 'could-not-save');
      case 'not-pending':
        // Another path (the background sweep, a manual complete) may have finished it.
        if (r.status === 'completed') return this.finish(id, { state: 'done', message: 'Signed in.' });
        return this.failed(id, r.status === 'abandoned' ? 'cancelled' : 'gone');
      default: return null;
    }
  }

  private async run(id: string, startedMs: number): Promise<FollowMeCompletionSnapshot> {
    const deadline = startedMs + this.timeoutMs;
    let windowClosedAt: number | null = null;
    try {
      while (this.now() < deadline) {
        const terminal = await this.settle(id, await this.attempt(id, 'auth-revision'));
        if (terminal) return terminal;
        if (this.deps.paneAlive(id) === false) {
          windowClosedAt ??= this.now();
          if (this.now() - windowClosedAt >= this.graceMs) {
            // The window is gone and no new auth revision appeared: one live identity
            // probe decides. A working credential for the expected account is success;
            // anything else is a terminal failure with a reason.
            const live = await this.settle(id, await this.attempt(id, 'live-identity'));
            return live ?? this.failed(id, 'window-closed');
          }
        } else {
          windowClosedAt = null;
        }
        await this.sleep(this.pollMs);
      }
      const last = await this.settle(id, await this.attempt(id, 'auth-revision'));
      return last ?? this.failed(id, 'timed-out');
    } catch (err) {
      this.deps.logger?.warn(`[follow-me] completion-watch error id=${id}: ${err instanceof Error ? err.message : String(err)}`);
      return this.failed(id, 'timed-out');
    }
  }
}
