/**
 * WarmSessionInbox — the primary primitive of this adapter.
 *
 * A WarmSessionInbox handle = a dedicated pool session reserved for that
 * inbox. Messages sent to the inbox are run on that session in order.
 * The session is held until `retire(handle)` is called.
 *
 * Pattern:
 *   1. start(options) → allocate one pool session, mark it reserved
 *   2. send(handle, message) → runPrompt on the reserved session, emit
 *      events from the response
 *   3. retire(handle) → pool.retire (kills session and spawns replacement)
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type {
  WarmSessionInbox,
  WarmSessionInboxOptions,
  WarmSessionInboxHandle,
  WarmInboxMessage,
} from '../../../primitives/transport/warmSessionInbox.js';
import type { CanonicalEvent } from '../../../events.js';
import type { CancellationOptions, SessionHandle } from '../../../types.js';
import { sessionHandle } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { UnsupportedCapabilityError } from '../../../errors.js';
import { ANTHROPIC_INTERACTIVE_POOL_ID } from '../errors.js';
import type { InteractivePool, PoolSession } from '../pool.js';
import type { InteractivePoolConfig } from '../config.js';
import { runPrompt } from '../promptRunner.js';

interface ReservedSession {
  handle: SessionHandle;
  poolSession: PoolSession;
  messageCount: number;
  emitter: EventEmitter;
  retired: boolean;
}

const reservations = new Map<SessionHandle, ReservedSession>();

class InteractivePoolWarmSessionInbox implements WarmSessionInbox {
  readonly capability = CapabilityFlag.WarmSessionInbox;

  constructor(
    private readonly pool: InteractivePool,
    private readonly config: InteractivePoolConfig,
  ) {}

  async start(_options: WarmSessionInboxOptions): Promise<WarmSessionInboxHandle> {
    const poolSession = await this.pool.allocate();
    const id = `inbox-${randomBytes(6).toString('hex')}`;
    const handle = sessionHandle(`${ANTHROPIC_INTERACTIVE_POOL_ID}/${id}/${poolSession.id}`);
    const emitter = new EventEmitter();
    const reservation: ReservedSession = {
      handle,
      poolSession,
      messageCount: 0,
      emitter,
      retired: false,
    };
    reservations.set(handle, reservation);

    return {
      handle,
      events: this.eventStream(emitter),
      messageCount: () => reservation.messageCount,
      isReady: () => !reservation.retired && reservation.poolSession.state !== 'dead',
      providerSpecific: {
        [ANTHROPIC_INTERACTIVE_POOL_ID]: {
          poolSessionId: poolSession.id,
          tmuxName: poolSession.tmuxName,
        },
      },
    };
  }

  private eventStream(emitter: EventEmitter): AsyncIterable<CanonicalEvent> {
    return {
      async *[Symbol.asyncIterator]() {
        const queue: CanonicalEvent[] = [];
        let resolveNext: (() => void) | null = null;
        let closed = false;
        const onEvent = (ev: CanonicalEvent) => {
          queue.push(ev);
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        };
        const onClose = () => {
          closed = true;
          if (resolveNext) {
            resolveNext();
            resolveNext = null;
          }
        };
        emitter.on('event', onEvent);
        emitter.on('close', onClose);
        try {
          while (!closed) {
            while (queue.length > 0) yield queue.shift()!;
            if (closed) break;
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
            });
          }
        } finally {
          emitter.off('event', onEvent);
          emitter.off('close', onClose);
        }
      },
    };
  }

  async send(
    handle: SessionHandle,
    message: WarmInboxMessage,
    options?: CancellationOptions,
  ): Promise<{ correlationId: string; deliveredAt: string }> {
    const reservation = reservations.get(handle);
    if (!reservation) {
      throw new UnsupportedCapabilityError(
        `Unknown warm-inbox handle: ${handle}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    if (reservation.retired) {
      throw new UnsupportedCapabilityError(
        `Warm inbox already retired: ${handle}`,
        ANTHROPIC_INTERACTIVE_POOL_ID,
      );
    }
    const correlationId = `msg-${randomBytes(4).toString('hex')}`;

    // Format the message with sender context (when present)
    const prompt = message.fromAgent
      ? `[from ${message.fromAgent}] ${message.content}`
      : message.content;

    // Run async; emit events from the result
    void (async () => {
      try {
        const result = await runPrompt(this.pool, reservation.poolSession, prompt, this.config, {
          signal: options?.signal,
        });
        reservation.messageCount += 1;
        reservation.emitter.emit('event', {
          type: 'message-delta',
          timestamp: new Date().toISOString(),
          providerId: ANTHROPIC_INTERACTIVE_POOL_ID,
          delta: result.text,
          providerSpecific: { [ANTHROPIC_INTERACTIVE_POOL_ID]: { correlationId } },
        });
        reservation.emitter.emit('event', {
          type: 'turn-end',
          timestamp: new Date().toISOString(),
          providerId: ANTHROPIC_INTERACTIVE_POOL_ID,
          stopReason: 'end-of-turn',
          usage: null,
          providerSpecific: { [ANTHROPIC_INTERACTIVE_POOL_ID]: { correlationId, durationMs: result.durationMs } },
        });
      } catch (err) {
        reservation.emitter.emit('event', {
          type: 'error',
          timestamp: new Date().toISOString(),
          providerId: ANTHROPIC_INTERACTIVE_POOL_ID,
          message: (err as Error).message,
          recoverable: false,
          errorKind: 'unknown',
          providerSpecific: { [ANTHROPIC_INTERACTIVE_POOL_ID]: { correlationId } },
        });
      }
    })();

    return { correlationId, deliveredAt: new Date().toISOString() };
  }

  async retire(handle: SessionHandle, _options?: CancellationOptions): Promise<void> {
    const reservation = reservations.get(handle);
    if (!reservation) return;
    reservation.retired = true;
    reservation.emitter.emit('close');
    reservations.delete(handle);
    await this.pool.retire(reservation.poolSession);
  }
}

export function createWarmSessionInbox(
  pool: InteractivePool,
  config: InteractivePoolConfig,
): WarmSessionInbox {
  return new InteractivePoolWarmSessionInbox(pool, config);
}

/** Look up the underlying pool session for a warm-inbox handle. */
export function poolSessionForHandle(handle: SessionHandle): PoolSession | null {
  return reservations.get(handle)?.poolSession ?? null;
}
