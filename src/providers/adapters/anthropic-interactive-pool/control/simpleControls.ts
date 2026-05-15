/**
 * Simple in-memory control primitives — same pattern as anthropic-headless.
 * Reused without duplication where logic is provider-agnostic.
 */

import type { TimeoutBound, TimeoutBoundOptions } from '../../../primitives/control/timeoutBound.js';
import type { IdleBound, IdlePolicy } from '../../../primitives/control/idleBound.js';
import type {
  StopGateInterceptor,
  StopGateHandler,
} from '../../../primitives/control/stopGateInterceptor.js';
import type { SessionHandle, CancellationOptions } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';

// ── TimeoutBound ──────────────────────────────────────────────────────
const deadlines = new Map<SessionHandle, { deadlineAt: string; expiryAction: string; reason?: string }>();
class IpTimeoutBound implements TimeoutBound {
  readonly capability = CapabilityFlag.TimeoutBound;
  async setDeadline(s: SessionHandle, mins: number, options?: TimeoutBoundOptions): Promise<void> {
    deadlines.set(s, {
      deadlineAt: new Date(Date.now() + mins * 60_000).toISOString(),
      expiryAction: options?.expiryAction ?? 'hard-kill',
      reason: options?.reason,
    });
  }
  async getDeadline(s: SessionHandle): Promise<{ deadlineAt: string; remainingMs: number } | null> {
    const r = deadlines.get(s);
    if (!r) return null;
    return { deadlineAt: r.deadlineAt, remainingMs: new Date(r.deadlineAt).getTime() - Date.now() };
  }
  async clearDeadline(s: SessionHandle): Promise<void> {
    deadlines.delete(s);
  }
}
export function createTimeoutBound(): TimeoutBound {
  return new IpTimeoutBound();
}

// ── IdleBound ─────────────────────────────────────────────────────────
const idlePolicies = new Map<SessionHandle, IdlePolicy>();
class IpIdleBound implements IdleBound {
  readonly capability = CapabilityFlag.IdleBound;
  async setIdlePolicy(s: SessionHandle, p: IdlePolicy): Promise<void> {
    idlePolicies.set(s, p);
  }
  async getIdlePolicy(s: SessionHandle): Promise<IdlePolicy | null> {
    return idlePolicies.get(s) ?? null;
  }
  async clearIdlePolicy(s: SessionHandle): Promise<void> {
    idlePolicies.delete(s);
  }
}
export function createIdleBound(): IdleBound {
  return new IpIdleBound();
}

// ── StopGateInterceptor ────────────────────────────────────────────────
const stopGateHandlers = new Map<SessionHandle, StopGateHandler>();
export function getStopGateHandler(s: SessionHandle): StopGateHandler | undefined {
  return stopGateHandlers.get(s);
}
class IpStopGateInterceptor implements StopGateInterceptor {
  readonly capability = CapabilityFlag.StopGateInterceptor;
  async register(
    s: SessionHandle,
    h: StopGateHandler,
    _options?: CancellationOptions,
  ): Promise<() => Promise<void>> {
    stopGateHandlers.set(s, h);
    return async () => {
      stopGateHandlers.delete(s);
    };
  }
}
export function createStopGateInterceptor(): StopGateInterceptor {
  return new IpStopGateInterceptor();
}
