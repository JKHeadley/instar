/**
 * SessionId implementation for pi-cli.
 *
 * Pi assigns a session id to each session (the `sessionId` field in its RPC
 * `get_state` response and in its on-disk session file under `--session-dir`).
 * Pi session ids are UUIDv7 strings drawn from pi's session files. The
 * adapter's SessionHandle binds to that pi-side session id. This primitive
 * provides the binding both directions.
 *
 * Mirrors gemini-cli/observability/sessionId.ts: an in-memory bidirectional
 * map, populated when the adapter observes a session's id, plus a synthetic
 * handle for a known session id without a live process.
 */

import type { CancellationOptions, SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import type { SessionId } from '../../../primitives/observability/sessionId.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { PI_CLI_ID } from '../errors.js';

const handleToSession = new Map<SessionHandle, string>();
const sessionToHandle = new Map<string, SessionHandle>();

class PiCliSessionId implements SessionId {
  readonly capability = CapabilityFlag.SessionId;

  async providerIdFor(session: SessionHandle, _options?: CancellationOptions): Promise<string | null> {
    return handleToSession.get(session) ?? null;
  }

  async handleFor(providerSessionId: string, _options?: CancellationOptions): Promise<SessionHandle | null> {
    return sessionToHandle.get(providerSessionId) ?? null;
  }
}

/** Bind a pi session id (UUIDv7) to a SessionHandle. */
export function bindPiSessionId(handle: SessionHandle, sessionId: string): void {
  handleToSession.set(handle, sessionId);
  sessionToHandle.set(sessionId, handle);
}

/** Look up the SessionHandle for a pi session id (UUIDv7). */
export function handleForPiSession(sessionId: string): SessionHandle | null {
  return sessionToHandle.get(sessionId) ?? null;
}

/** Construct a session handle for a known pi session without a live process. */
export function syntheticHandleForPiSession(sessionId: string): SessionHandle {
  return sessionHandle(`${PI_CLI_ID}/session-${sessionId}`);
}

/** Construct a process-pid handle for a live one-shot spawn (used by HardKill). */
export function pidHandle(pid: number): SessionHandle {
  return sessionHandle(`${PI_CLI_ID}/pid-${pid}`);
}

export function createSessionId(): SessionId {
  return new PiCliSessionId();
}

/** Test-only: clear the in-memory session-id binding maps. */
export function _resetPiSessionIdMaps(): void {
  handleToSession.clear();
  sessionToHandle.clear();
}
