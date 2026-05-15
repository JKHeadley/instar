/**
 * Interrupt: Ctrl-C via tmux send-keys.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Interrupt, InterruptOptions } from '../../../primitives/control/interrupt.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnexpectedError, UnsupportedCapabilityError } from '../../../errors.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';
import type { InteractivePoolConfig } from '../config.js';
import { poolSessionForHandle } from '../transport/warmSessionInbox.js';

const execFileAsync = promisify(execFile);

class InteractivePoolInterrupt implements Interrupt {
  readonly capability = CapabilityFlag.Interrupt;

  constructor(private readonly config: InteractivePoolConfig) {}

  async interrupt(session: SessionHandle, _options?: InterruptOptions): Promise<void> {
    const ps = poolSessionForHandle(session);
    if (!ps) {
      throw new UnsupportedCapabilityError(
        `Unknown handle: ${session}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    try {
      await execFileAsync(this.config.tmuxPath, ['send-keys', '-t', `=${ps.tmuxName}:`, 'C-c'], {
        timeout: 5000,
      });
    } catch (err) {
      throw new UnexpectedError(
        `Failed to interrupt: ${(err as Error).message}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
        err,
      );
    }
  }

  isNonDestructive(): boolean {
    return true;
  }
}

export function createInterrupt(config: InteractivePoolConfig): Interrupt {
  return new InteractivePoolInterrupt(config);
}
