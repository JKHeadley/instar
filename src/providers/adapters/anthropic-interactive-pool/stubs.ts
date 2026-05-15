/**
 * Stub-primitive factory — same pattern as anthropic-headless.
 */

import { UnsupportedCapabilityError } from '../../errors.js';
import type { CapabilityFlag } from '../../capabilities.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from './errors.js';

export function createStubPrimitive(capability: CapabilityFlag): { capability: typeof capability } {
  return new Proxy(
    { capability },
    {
      get(target, prop) {
        if (prop === 'capability') {
          return target.capability;
        }
        return (..._args: unknown[]) => {
          throw new UnsupportedCapabilityError(
            `${String(capability)}.${String(prop)} (not yet implemented in anthropic-interactive-pool adapter)`,
            ANTHROPIC_INTERACTIVE_POOL_ID,
          );
        };
      },
    },
  ) as { capability: typeof capability };
}
