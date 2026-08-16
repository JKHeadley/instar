/**
 * SessionId implementation for grok-build.
 *
 * Grok assigns a session id to each run (the `sessionId` field of the
 * one-shot JSON envelope; sessions persist under `$GROK_HOME/sessions`).
 * The adapter's SessionHandle binds to that grok-side session id. Mirrors
 * pi-cli/observability/sessionId.ts: an in-memory bidirectional map plus a
 * synthetic handle for a known session id without a live process.
 */

import type { CancellationOptions, SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import type { SessionId } from '../../../primitives/observability/sessionId.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { GROK_BUILD_ID } from '../errors.js';

const handleToSession = new Map<SessionHandle, string>();
const sessionToHandle = new Map<string, SessionHandle>();

class GrokBuildSessionId implements SessionId {
  readonly capability = CapabilityFlag.SessionId;

  async providerIdFor(session: SessionHandle, _options?: CancellationOptions): Promise<string | null> {
    return handleToSession.get(session) ?? null;
  }

  async handleFor(providerSessionId: string, _options?: CancellationOptions): Promise<SessionHandle | null> {
    return sessionToHandle.get(providerSessionId) ?? null;
  }
}

/** Bind a grok session id to a SessionHandle. */
export function bindGrokSessionId(handle: SessionHandle, sessionId: string): void {
  handleToSession.set(handle, sessionId);
  sessionToHandle.set(sessionId, handle);
}

/** Construct a session handle for a known grok session without a live process. */
export function syntheticHandleForGrokSession(sessionId: string): SessionHandle {
  return sessionHandle(`${GROK_BUILD_ID}/session-${sessionId}`);
}

/** Construct a process-pid handle for a live one-shot spawn (used by HardKill). */
export function pidHandle(pid: number): SessionHandle {
  return sessionHandle(`${GROK_BUILD_ID}/pid-${pid}`);
}

export function createSessionId(): SessionId {
  return new GrokBuildSessionId();
}

/** Test-only: clear the in-memory session-id binding maps. */
export function _resetGrokSessionIdMaps(): void {
  handleToSession.clear();
  sessionToHandle.clear();
}
