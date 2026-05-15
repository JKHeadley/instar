/**
 * HardKill: retires the underlying pool session.
 */

import type { HardKill, HardKillOptions } from '../../../primitives/control/hardKill.js';
import type { SessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnsupportedCapabilityError } from '../../../errors.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';
import type { InteractivePool } from '../pool.js';
import { poolSessionForHandle } from '../transport/warmSessionInbox.js';

class InteractivePoolHardKill implements HardKill {
  readonly capability = CapabilityFlag.HardKill;

  constructor(private readonly pool: InteractivePool) {}

  async kill(session: SessionHandle, _options?: HardKillOptions): Promise<void> {
    const poolSession = poolSessionForHandle(session);
    if (!poolSession) {
      throw new UnsupportedCapabilityError(
        `Unknown handle (not from interactive pool): ${session}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    await this.pool.hardKill(poolSession);
  }
}

export function createHardKill(pool: InteractivePool): HardKill {
  return new InteractivePoolHardKill(pool);
}
