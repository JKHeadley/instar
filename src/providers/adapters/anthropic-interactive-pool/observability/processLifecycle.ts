/**
 * ProcessLifecycle for the interactive pool: reports PID/alive/startedAt
 * for the underlying `claude` REPL process owned by a pool session.
 *
 * Liveness comes from two sources:
 *   1. The pool's in-memory state ('ready' / 'busy' / 'retiring' / 'dead')
 *   2. tmux list-panes for the underlying tmuxName
 *
 * Both must agree before we declare the session alive — a pool session that
 * the pool thinks is alive but whose tmux pane is gone has crashed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ProcessLifecycle,
  ProcessState,
  ProcessStateChange,
} from '../../../primitives/observability/processLifecycle.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnsupportedCapabilityError } from '../../../errors.js';
import type { InteractivePoolConfig } from '../config.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';
import { poolSessionForHandle } from '../transport/warmSessionInbox.js';

const execFileAsync = promisify(execFile);

class InteractivePoolProcessLifecycle implements ProcessLifecycle {
  readonly capability = CapabilityFlag.ProcessLifecycle;

  constructor(private readonly config: InteractivePoolConfig) {}

  async state(session: SessionHandle): Promise<ProcessState> {
    const ps = poolSessionForHandle(session);
    if (!ps) {
      throw new UnsupportedCapabilityError(
        `Unknown handle (not from interactive pool): ${session}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    // Default to dead — promote to alive only if tmux confirms.
    let alive = false;
    let pids: number[] = [];
    let startedAt = new Date(ps.spawnedAt).toISOString();
    try {
      const { stdout } = await execFileAsync(
        this.config.tmuxPath,
        ['list-panes', '-t', `=${ps.tmuxName}:`, '-F', '#{pane_pid} #{session_created}'],
        { timeout: 5000 },
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        // Only consider alive if the pool also thinks the session is live.
        alive = ps.state !== 'dead' && ps.state !== 'retiring';
        pids = lines.map((line) => parseInt(line.split(' ')[0]!, 10)).filter((p) => !Number.isNaN(p));
        const created = parseInt(lines[0]!.split(' ')[1]!, 10);
        if (!Number.isNaN(created)) {
          startedAt = new Date(created * 1000).toISOString();
        }
      }
    } catch {
      // tmux says not found — definitively dead, even if pool state lags
    }
    return { alive, pids, startedAt };
  }

  subscribe(session: SessionHandle): AsyncIterable<ProcessStateChange> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let lastAlive: boolean | null = null;
        while (true) {
          let state: ProcessState;
          try {
            state = await self.state(session);
          } catch {
            return;
          }
          if (lastAlive !== null && lastAlive !== state.alive) {
            yield {
              session,
              kind: state.alive ? 'restarted' : 'died',
              state,
              timestamp: new Date().toISOString(),
            };
          }
          lastAlive = state.alive;
          if (!state.alive) return;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      },
    };
  }
}

export function createProcessLifecycle(config: InteractivePoolConfig): ProcessLifecycle {
  return new InteractivePoolProcessLifecycle(config);
}
