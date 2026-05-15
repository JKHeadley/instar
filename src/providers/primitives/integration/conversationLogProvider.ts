/**
 * ConversationLogProvider — unified view of a session's log (read + tail).
 *
 * Composite primitive that bundles ConversationLogReader (post-hoc finite
 * read) and ConversationLogTailer (real-time growing tail) into a single
 * convenience interface. Callers that need both — i.e., "give me what's
 * already there and then keep delivering new entries" — use this.
 *
 * Adapters implementing this primitive MUST also implement both
 * conversationLogReader and conversationLogTailer; the composite is a
 * shorthand, not an independent capability.
 */

import type { CancellationOptions, SessionHandle } from '../../types.js';
import type { CanonicalEvent } from '../../events.js';
import { CapabilityFlag } from '../../capabilities.js';

export interface ConversationLogProvider {
  readonly capability: typeof CapabilityFlag.ConversationLogProvider;

  /**
   * Read existing events, then continue tailing new ones. Equivalent to
   * `conversationLogReader.readStream() then conversationLogTailer.tail()`
   * but the adapter handles the seamless handoff (no events dropped or
   * duplicated at the boundary).
   */
  readAndTail(
    session: SessionHandle,
    options?: ConversationLogProviderOptions,
  ): AsyncIterable<CanonicalEvent>;
}

export interface ConversationLogProviderOptions extends CancellationOptions {
  /** Filter by event type. */
  types?: ReadonlyArray<CanonicalEvent['type']>;
  /**
   * If set, skip existing events before this timestamp. Useful when
   * resuming a tail that previously got partway through.
   */
  since?: string;
}
