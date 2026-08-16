/**
 * HardKill implementation for grok-build.
 *
 * SIGTERM→SIGKILL escalation on a process pid — the framework-agnostic
 * process-level kill (mirrors pi-cli/control/piHardKill.ts). The one-shot
 * body runs spawns directly; the honest unit of force-termination is the
 * child process pid, encoded in the SessionHandle as `grok-build/pid-<n>`
 * (see observability/sessionId.pidHandle).
 *
 * A handle that is not a pid handle resolves to a no-op (nothing to kill) —
 * the adapter never claims to kill a session it has no process for.
 *
 * NOTE deliberately NOT killed here: grok's leader process
 * (`$GROK_HOME/leader.sock`). It is shared machine-level state serving OTHER
 * grok sessions; killing it to stop one call would be collateral damage.
 * A wedged leader is a stall class (grok-build-stall-coverage.md), handled
 * by recovery, not by this primitive.
 */

import type { SessionHandle } from '../../../types.js';
import type { HardKill, HardKillOptions } from '../../../primitives/control/hardKill.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { GROK_BUILD_ID } from '../errors.js';

const PID_PREFIX = `${GROK_BUILD_ID}/pid-`;

/** Extract the pid from a `grok-build/pid-<n>` handle, or null. */
export function pidFromHandle(session: SessionHandle): number | null {
  const s = String(session);
  if (!s.startsWith(PID_PREFIX)) return null;
  const n = Number(s.slice(PID_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class GrokBuildHardKill implements HardKill {
  readonly capability = CapabilityFlag.HardKill;

  async kill(session: SessionHandle, options?: HardKillOptions): Promise<void> {
    const pid = pidFromHandle(session);
    if (pid === null) {
      // No process bound to this handle — nothing to kill (honest no-op).
      return;
    }
    const graceMs = options?.graceMs ?? 5000;

    if (!isAlive(pid)) return;

    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone between the liveness check and the signal — fine.
      return;
    }

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, graceMs);
      t.unref?.();
    });

    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Raced to death — fine.
      }
    }
  }
}

export function createHardKill(): HardKill {
  return new GrokBuildHardKill();
}
