import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { NotificationBatcher } from '../messaging/NotificationBatcher.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';

export type TelegramStartupMode = 'send-only' | 'server-polling';

export interface TelegramStartupTopologyInput {
  telegramConfigured: boolean;
  skipTelegram: boolean;
  coordinatorAwake: boolean;
  lifelineOwnsPolling: boolean;
}

export interface TelegramStartupTopology {
  mode: TelegramStartupMode;
  /** Threadline mirroring owns durable bindings, so only the awake owner may arm it. */
  bridgeOwner: boolean;
}

/**
 * Resolve the production Telegram topology once, before either construction
 * branch. The result carries both inbound poll ownership and the independent
 * one-voice verdict for the stateful Threadline bridge.
 */
export function resolveTelegramStartupTopology(
  input: TelegramStartupTopologyInput,
): TelegramStartupTopology | undefined {
  if (!input.telegramConfigured) return undefined;
  const mode = input.skipTelegram || !input.coordinatorAwake || input.lifelineOwnsPolling
    ? 'send-only'
    : 'server-polling';
  return { mode, bridgeOwner: input.coordinatorAwake };
}

export interface TelegramSendSideDeps {
  mode: TelegramStartupMode;
  telegram: TelegramAdapter;
  scheduler?: JobScheduler;
  notificationBatcher: NotificationBatcher;
}

export interface TelegramSendSideResult {
  mode: TelegramStartupMode;
  schedulerAttached: boolean;
  batcherAttached: true;
}

/**
 * Poll ownership controls only who calls getUpdates. Every TelegramAdapter can
 * send, so all send-side dependency handoffs converge here after the ownership
 * branches. Keeping this seam outside those branches makes an omitted handoff
 * structurally difficult instead of relying on duplicated branch discipline.
 */
export function wireTelegramSendSide(deps: TelegramSendSideDeps): TelegramSendSideResult {
  if (deps.scheduler) {
    deps.scheduler.setMessenger(deps.telegram);
    deps.scheduler.setTelegram(deps.telegram);
  }

  deps.notificationBatcher.setSendFunction(async (topicId, text) => {
    await deps.telegram.sendToTopic(topicId, text);
    return { messageId: 0 };
  });
  deps.notificationBatcher.start();

  return {
    mode: deps.mode,
    schedulerAttached: deps.scheduler != null,
    batcherAttached: true,
  };
}
