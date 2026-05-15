/**
 * CompactionLifecycle: especially relevant for interactive pool because
 * sessions hit context limits and need retirement. Polls the same marker
 * file as 3a; additionally exposes pool-side retirement signals.
 *
 * Phase 3b: same polling approach as 3a. The pool's own retire-on-message-
 * threshold logic complements this primitive (avoids most compactions by
 * proactively retiring before they happen).
 */

import { promises as fs } from 'node:fs';
import type {
  CompactionLifecycle,
  PreCompactNotice,
  PostCompactNotice,
} from '../../../primitives/control/compactionLifecycle.js';
import type { SessionHandle, CancellationOptions } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';

function markerPath(session: SessionHandle): string {
  const sid = String(session).split('/').pop() ?? String(session);
  return `/tmp/claude-session-${sid}/compacting`;
}

class InteractivePoolCompactionLifecycle implements CompactionLifecycle {
  readonly capability = CapabilityFlag.CompactionLifecycle;

  hasNativePreCompactHook(): boolean {
    return true;
  }

  subscribePreCompact(
    session: SessionHandle,
    options?: CancellationOptions,
  ): AsyncIterable<PreCompactNotice> {
    const target = markerPath(session);
    return {
      async *[Symbol.asyncIterator]() {
        let seen = false;
        while (!options?.signal?.aborted) {
          let exists = false;
          try {
            await fs.access(target);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists && !seen) {
            seen = true;
            yield {
              session,
              timestamp: new Date().toISOString(),
              source: 'native',
              providerSpecific: { [ANTHROPIC_INTERACTIVE_POOL_ID]: { markerPath: target } },
            } as PreCompactNotice;
          } else if (!exists) {
            seen = false;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
    };
  }

  subscribePostCompact(
    session: SessionHandle,
    options?: CancellationOptions,
  ): AsyncIterable<PostCompactNotice> {
    const target = markerPath(session);
    return {
      async *[Symbol.asyncIterator]() {
        let seen = false;
        while (!options?.signal?.aborted) {
          let exists = false;
          try {
            await fs.access(target);
            exists = true;
          } catch {
            exists = false;
          }
          if (seen && !exists) {
            seen = false;
            yield {
              session,
              timestamp: new Date().toISOString(),
              providerSpecific: { [ANTHROPIC_INTERACTIVE_POOL_ID]: { markerPath: target } },
            } as PostCompactNotice;
          } else if (exists) {
            seen = true;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
    };
  }

  async triggerCompact(_session: SessionHandle): Promise<void> {
    // Could send `/compact` via tmux send-keys; defer to user retirement.
    throw new Error('triggerCompact not supported; use pool.retire instead');
  }
}

export function createCompactionLifecycle(): CompactionLifecycle {
  return new InteractivePoolCompactionLifecycle();
}
