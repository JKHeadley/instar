/**
 * HardKill implementation for gemini-cli.
 *
 * SIGTERM→SIGKILL escalation on a process pid — the framework-agnostic
 * process-level kill (analog of openai-codex/control/hardKill.ts, but the
 * codex one targets a tmux session because codex's agentic path runs inside
 * tmux). The minimal Gemini body runs one-shot spawns directly (no tmux
 * REPL), so the honest unit of force-termination is the child process pid,
 * encoded in the SessionHandle as `gemini-cli/pid-<n>` (see sessionId.pidHandle).
 *
 * A handle that is not a pid handle resolves to a no-op (nothing to kill) —
 * the adapter never claims to kill a session it has no process for.
 */

import type { SessionHandle } from '../../../types.js';
import type { HardKill, HardKillOptions } from '../../../primitives/control/hardKill.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { GEMINI_CLI_ID } from '../errors.js';

const PID_PREFIX = `${GEMINI_CLI_ID}/pid-`;

/** Extract the pid from a `gemini-cli/pid-<n>` handle, or null. */
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

class GeminiCliHardKill implements HardKill {
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

    // Grace period, then verify + escalate.
    await new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref?.() ?? resolve());

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
  return new GeminiCliHardKill();
}
