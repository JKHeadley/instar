/**
 * SessionId implementation for gemini-cli.
 *
 * Gemini assigns a UUID to each session (the `"sessionId"` field in its
 * on-disk session file). The adapter's SessionHandle binds to that
 * gemini-side session UUID. This primitive provides the binding both
 * directions.
 *
 * Mirrors openai-codex/observability/sessionId.ts: an in-memory bidirectional
 * map, populated when the adapter observes a session's id, plus a synthetic
 * handle for a known session id without a live process.
 */

import type { CancellationOptions, SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import type { SessionId } from '../../../primitives/observability/sessionId.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { GEMINI_CLI_ID } from '../errors.js';

const handleToSession = new Map<SessionHandle, string>();
const sessionToHandle = new Map<string, SessionHandle>();

class GeminiCliSessionId implements SessionId {
  readonly capability = CapabilityFlag.SessionId;

  async providerIdFor(session: SessionHandle, _options?: CancellationOptions): Promise<string | null> {
    return handleToSession.get(session) ?? null;
  }

  async handleFor(providerSessionId: string, _options?: CancellationOptions): Promise<SessionHandle | null> {
    return sessionToHandle.get(providerSessionId) ?? null;
  }
}

/** Bind a Gemini session UUID to a SessionHandle. */
export function bindGeminiSessionId(handle: SessionHandle, sessionId: string): void {
  handleToSession.set(handle, sessionId);
  sessionToHandle.set(sessionId, handle);
}

/** Look up the SessionHandle for a Gemini session UUID. */
export function handleForGeminiSession(sessionId: string): SessionHandle | null {
  return sessionToHandle.get(sessionId) ?? null;
}

/** Construct a session handle for a known gemini session without a live process. */
export function syntheticHandleForGeminiSession(sessionId: string): SessionHandle {
  return sessionHandle(`${GEMINI_CLI_ID}/session-${sessionId}`);
}

/** Construct a process-pid handle for a live one-shot spawn (used by HardKill). */
export function pidHandle(pid: number): SessionHandle {
  return sessionHandle(`${GEMINI_CLI_ID}/pid-${pid}`);
}

export function createSessionId(): SessionId {
  return new GeminiCliSessionId();
}

/** Test-only: clear the in-memory session-id binding maps. */
export function _resetGeminiSessionIdMaps(): void {
  handleToSession.clear();
  sessionToHandle.clear();
}
