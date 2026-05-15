/**
 * OneShotCompletion for the interactive pool: allocate a pool session,
 * run the prompt, release.
 *
 * Each call serves on whichever session is currently ready. The pool
 * recycles sessions after a configurable number of messages so context
 * doesn't accumulate indefinitely.
 */

import type {
  OneShotCompletion,
  OneShotCompletionOptions,
  OneShotCompletionResult,
} from '../../../primitives/transport/oneShotCompletion.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';
import { runPrompt } from '../promptRunner.js';
import type { InteractivePool } from '../pool.js';
import type { InteractivePoolConfig } from '../config.js';

class InteractivePoolOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(
    private readonly pool: InteractivePool,
    private readonly config: InteractivePoolConfig,
  ) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const session = await this.pool.allocate();
    let healthy = false;
    try {
      const result = await runPrompt(this.pool, session, prompt, this.config, {
        signal: options?.signal,
        maxWaitSeconds: options?.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
      });
      healthy = true;
      return {
        text: result.text,
        usage: null,
        providerSpecific: {
          [ANTHROPIC_INTERACTIVE_POOL_ID]: {
            poolSessionId: session.id,
            tmuxName: session.tmuxName,
            durationMs: result.durationMs,
            raw: result.raw,
          },
        },
      };
    } finally {
      if (healthy) {
        await this.pool.release(session);
      } else {
        // runPrompt threw (timeout, abort, exec failure). The underlying
        // REPL may be wedged — partial prompt in the input buffer, still
        // streaming a response from a failed send-keys, residual idle
        // markers in the captured pane. Releasing it back to ready risks
        // a poisoned session being handed to the next caller, who would
        // receive whatever stale content was sitting in the pane as if it
        // were their response. Retire instead: the session is killed,
        // the pool's retry-with-backoff path schedules a replacement, and
        // the next allocate gets a clean session.
        await this.pool.retire(session);
      }
    }
  }
}

export function createOneShotCompletion(
  pool: InteractivePool,
  config: InteractivePoolConfig,
): OneShotCompletion {
  return new InteractivePoolOneShotCompletion(pool, config);
}
