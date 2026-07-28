/**
 * Observability for the server's relay connection.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-26 the agent could not send to a peer. The peer was healthy and
 * listening; this agent's relay was down. Diagnosing it was impossible from the
 * record, because the record could only ever say one thing:
 *
 *     Threadline: relay connected (fingerprint: …)
 *
 * `RelayClient` emits BOTH `disconnected` (socket close) and `displaced` (another
 * connection claimed the same identity). `ThreadlineBootstrap` subscribed to
 * `message`, `unknown-sender` and `auto-discovered` — and to NEITHER of those two.
 * So a connection that dropped after startup left the successful connect line as
 * the last word forever.
 *
 * THE PART THAT MAKES IT WORTH A MODULE. `displaced` sets `shouldReconnect = false`
 * permanently — deliberately, so two processes do not fight over one identity. That
 * is a *terminal* state: the exponential backoff that would otherwise recover the
 * connection is switched off and never re-armed for the life of the process. A
 * terminal state that is never recorded is the worst combination available: the
 * channel is gone for good and nothing says so.
 *
 * The bootstrap itself documents a known "displacement race" between the server's
 * client and the standalone listener daemon. Whether that race is what fired here
 * is UNKNOWN — and unknowable from the existing record, which is precisely the
 * defect. This module does not diagnose the cause; it makes the next occurrence
 * diagnosable.
 *
 * SCOPE — deliberately narrow. This RECORDS transitions. It does not reconnect,
 * does not re-arm anything, and never changes the client's behaviour. Any recovery
 * fix belongs after this, and would be unverifiable before it.
 */

import fs from 'node:fs';
import path from 'node:path';

/** One recorded relay-connection transition. */
export interface RelayConnectionEvent {
  ts: string;
  /**
   * `disconnected` — socket closed; the client's backoff will retry.
   * `displaced`    — another connection took this identity. TERMINAL: retry is
   *                  disarmed permanently and this process will not reconnect.
   */
  event: 'disconnected' | 'displaced';
  /** Reason string from the client, clamped. Never trusted as structured data. */
  reason: string;
  fingerprint: string;
  /**
   * True only for `displaced`. Recorded explicitly rather than left implicit,
   * because "will retry" and "will never retry" are the two states a reader
   * actually needs to tell apart, and they are otherwise indistinguishable.
   */
  terminal: boolean;
}

/** Minimal shape this module needs — keeps it testable without a real socket. */
export interface RelayEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly fingerprint?: string | null;
}

const MAX_REASON_CHARS = 300;

function clampReason(reason: unknown): string {
  const s = typeof reason === 'string' ? reason : String(reason ?? '');
  return s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS)}…` : s;
}

/**
 * Subscribe to the relay client's connection-loss events and record each one.
 *
 * Returns a getter for the most recent event so a status surface can report WHY
 * the connection is down rather than only that it is. Returns null until one
 * fires — which correctly distinguishes "never dropped" from "dropped, cause X".
 */
export function attachRelayObservability(
  client: RelayEventSource,
  opts: {
    /** Directory for the durable record. Created if absent. */
    logDir: string;
    /** Injected so tests capture output instead of writing to the console. */
    log?: (line: string) => void;
    /** Injected for the same reason. */
    logError?: (line: string) => void;
  },
): { getLastEvent: () => RelayConnectionEvent | null } {
  const log = opts.log ?? ((line: string) => console.log(line));
  const logError = opts.logError ?? ((line: string) => console.error(line));
  let lastEvent: RelayConnectionEvent | null = null;

  const record = (event: RelayConnectionEvent['event'], reason: unknown, terminal: boolean): void => {
    const entry: RelayConnectionEvent = {
      ts: new Date().toISOString(),
      event,
      reason: clampReason(reason),
      fingerprint: client.fingerprint ?? 'unknown',
      terminal,
    };
    lastEvent = entry;

    // Loud on the console FIRST. If the durable write fails, the operator still
    // sees the transition — the whole point is that this must not be silent.
    if (terminal) {
      logError(
        `Threadline: relay DISPLACED by another connection using this identity — ${entry.reason}. `
        + 'Reconnect is now disarmed for the life of this process; this agent cannot send or '
        + 'receive until it restarts.',
      );
    } else {
      log(`Threadline: relay disconnected — ${entry.reason}. Client will retry with backoff.`);
    }

    try {
      fs.mkdirSync(opts.logDir, { recursive: true });
      fs.appendFileSync(
        path.join(opts.logDir, 'threadline-relay-events.jsonl'),
        `${JSON.stringify(entry)}\n`,
        'utf-8',
      );
    } catch (err) {
      // Never throw out of an event handler — a failed audit write must not take
      // down the connection path it is observing.
      logError(`Threadline: failed to record relay ${event} — ${err instanceof Error ? err.message : err}`);
    }
  };

  client.on('disconnected', (reason: unknown) => record('disconnected', reason, false));
  client.on('displaced', (reason: unknown) => record('displaced', reason, true));

  return { getLastEvent: () => lastEvent };
}
