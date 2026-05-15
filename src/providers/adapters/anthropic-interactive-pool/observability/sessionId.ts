/**
 * SessionId: bridge between SessionHandle and the underlying Claude session
 * UUID for the interactive-pool adapter.
 *
 * Unlike anthropic-headless (where the Claude UUID is observed via a hook
 * event when the per-call subprocess starts), interactive-pool sessions are
 * long-lived REPLs. The Claude UUID is bound to the pool session itself
 * (via `bindClaudeSessionId(poolSessionId, uuid)`) — typically by a hook
 * receiver wired to the pool. We then map a warm-inbox handle to its pool
 * session and surface the bound UUID.
 *
 * Reverse lookup returns the currently-active warm-inbox handle that owns
 * the pool session bearing that UUID, or null if no live reservation
 * matches.
 */

import type { SessionId } from '../../../primitives/observability/sessionId.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import type { InteractivePool } from '../pool.js';
import { poolSessionForHandle } from '../transport/warmSessionInbox.js';

const poolIdToUuid = new Map<string, string>();
const uuidToPoolId = new Map<string, string>();

/** Bind a Claude session UUID to a pool session id (called by hook receiver). */
export function bindClaudeSessionId(poolSessionId: string, claudeSessionId: string): void {
  poolIdToUuid.set(poolSessionId, claudeSessionId);
  uuidToPoolId.set(claudeSessionId, poolSessionId);
}

/** Clear the binding for a pool session (called on retire). */
export function unbindClaudeSessionId(poolSessionId: string): void {
  const uuid = poolIdToUuid.get(poolSessionId);
  if (uuid) {
    uuidToPoolId.delete(uuid);
  }
  poolIdToUuid.delete(poolSessionId);
}

class InteractivePoolSessionId implements SessionId {
  readonly capability = CapabilityFlag.SessionId;

  constructor(private readonly pool: InteractivePool) {}

  async providerIdFor(session: SessionHandle): Promise<string | null> {
    const ps = poolSessionForHandle(session);
    if (!ps) return null;
    // Prefer the binding map; fall back to the pool session's own cached uuid.
    return poolIdToUuid.get(ps.id) ?? ps.claudeSessionId ?? null;
  }

  async handleFor(_providerSessionId: string): Promise<SessionHandle | null> {
    // Reverse lookup: pool sessions don't track warm-inbox handles directly.
    // Consumers using this primarily care about the forward direction
    // (handle → UUID for log/event correlation); reverse lookup returns null
    // unless a future revision tracks warm-inbox handles by uuid.
    return null;
  }
}

export function createSessionId(pool: InteractivePool): SessionId {
  return new InteractivePoolSessionId(pool);
}
