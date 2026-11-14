/**
 * Hook-event consumers wired onto the HookEventReceiver (server.ts calls
 * these; tests call the SAME functions). Each consumer here is a row in
 * docs/specs/native-hook-events.md's D2 table, and the listener-enumeration
 * test counts the receiver's listeners after this wiring runs.
 */

import type { HookEventReceiver, HookEventPayload } from './HookEventReceiver.js';

export interface CompactionTriggerDeps {
  /** compactionSentinel.report */
  report: (sessionName: string, trigger: string) => void;
  /** The session manager's CURRENT running record for an incarnation id. */
  getSessionById: (instarSessionId: string) => { tmuxSession: string } | undefined;
  /** tmux names currently bound to a topic (today's intersection). null ⇒ no messaging ⇒ none. */
  topicSessionNames: () => Iterable<string> | null;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  delayMs?: number;
  log?: (msg: string) => void;
}

/**
 * Resolve which session a `PreCompact` event belongs to, or null. Synchronous
 * at receive time, so an event that waited in the queue across a respawn is
 * dropped (Triggers 2 and 3 cover it). Requires: the event's
 * `instar_session_id` is a current running record, that record's tmux name
 * equals the `instar_session` header (a delayed event from an earlier
 * incarnation of a reused name matches neither), and the session is a topic
 * session.
 */
export function resolvePreCompactTarget(payload: HookEventPayload, deps: CompactionTriggerDeps): string | null {
  const sid = typeof payload.instar_session_id === 'string' ? payload.instar_session_id : '';
  const name = typeof payload.instar_session === 'string' ? payload.instar_session : '';
  if (!sid || !name) return null;
  const session = deps.getSessionById(sid);
  if (!session || session.tmuxSession !== name) return null;
  const topics = deps.topicSessionNames();
  if (!topics) return null;
  for (const n of topics) {
    if (n === name) return name;
  }
  return null;
}

/** Compaction sentinel Trigger 1, scoped to the emitting session (D2). */
export function wireCompactionTrigger1(receiver: HookEventReceiver, deps: CompactionTriggerDeps): void {
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const delay = deps.delayMs ?? 10_000;
  receiver.on('PreCompact', (payload: HookEventPayload) => {
    const target = resolvePreCompactTarget(payload, deps);
    if (!target) return; // report nothing — Triggers 2 and 3 still cover it
    // Delay to let compaction + recovery hooks finish
    setT(() => deps.report(target, 'PreCompact'), delay);
  });
}

/** Pre-compaction memory flush (off by default; its own flag). */
export function wirePreCompactionFlush(
  receiver: HookEventReceiver,
  flush: { handle: (payload: never) => Promise<unknown> },
): void {
  receiver.on('PreCompact', (payload: HookEventPayload) => {
    flush.handle(payload as never).catch(() => {
      /* handle() owns its audit; never throws. */
    });
  });
}

/**
 * HelperWatchdog alert delivery, gated by `monitoring.helperWatchdog.injectAlerts`
 * (default FALSE, D2). Off: the alert is logged and counted, nothing is typed
 * into a session (this also keeps the subagent's last message out of the parent).
 */
export interface HelperAlertDelivery {
  deliver: (tmux: string | null, msg: string) => void;
  readonly counts: { logged: number; injected: number; injectFailed: number };
}

export function createHelperAlertDelivery(deps: {
  injectAlerts: boolean;
  inject: (tmux: string, msg: string) => void;
  log?: (msg: string) => void;
}): HelperAlertDelivery {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const counts = { logged: 0, injected: 0, injectFailed: 0 };
  return {
    counts,
    deliver(tmux: string | null, msg: string): void {
      counts.logged++;
      log(deps.injectAlerts ? msg : `${msg} [not injected: monitoring.helperWatchdog.injectAlerts is off; ${counts.logged} logged]`);
      if (!deps.injectAlerts || !tmux) return;
      try {
        deps.inject(tmux, msg);
        counts.injected++;
      } catch (err) {
        counts.injectFailed++;
        log(`[HelperWatchdog] inject failed for ${tmux}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
