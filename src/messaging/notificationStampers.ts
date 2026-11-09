import { notificationContext } from './NotificationSelectivityGate.js';
import type { OutboundEnvelope } from './NotificationSelectivityGate.js';
import type { NotificationCategoryId } from './notificationCategories.js';

/** Callsite-to-category capabilities are bound here and checked by the funnel lint. */
export const EMITTER_CATEGORIES = {
  "src/commands/server.ts": "uncategorized",
  "src/core/MentorVisibleEcho.ts": "uncategorized",
  "src/core/ScopeAccretionRatifier.ts": "uncategorized",
  "src/core/SpendAlertResolver.ts": "spend-alert",
  "src/core/TelegramSpendTopicChannel.ts": "spend-alert",
  "src/feedback-factory/triage/FeedbackTriageService.ts": "uncategorized",
  "src/feedback-factory/triage/buildFeedbackTriage.ts": "uncategorized",
  "src/lifeline/TelegramLifeline.ts": "uncategorized",
  "src/lifeline/droppedMessages.ts": "uncategorized",
  "src/messaging/TelegramAdapter.ts": "uncategorized",
  "src/messaging/shared/CrossPlatformAlerts.ts": "uncategorized",
  "src/messaging/telegram-origin/OriginDeterministicSend.ts": "uncategorized",
  "src/messaging/telegramSendSideComposition.ts": "uncategorized",
  "src/monitoring/BurnAlertDelivery.ts": "spend-alert",
  "src/monitoring/DiskStewardPoster.ts": "disk-steward",
  "src/monitoring/QuotaNotifier.ts": "spend-alert",
  "src/monitoring/ReapNoticeDrain.ts": "reap-notice",
  "src/monitoring/SessionMonitor.ts": "reap-notice",
  "src/monitoring/StallTriageNurse.ts": "uncategorized",
  "src/monitoring/TriageOrchestrator.ts": "uncategorized",
  "src/monitoring/machineCoherenceEffectsExecutor.ts": "mesh-alert",
  "src/monitoring/ropeSinkRouter.ts": "mesh-alert",
  "src/monitoring/sentinelConsolidatedSend.ts": "sentinel-escalation",
  "src/scheduler/JobScheduler.ts": "job-status",
  "src/server/AgentServer.ts": "uncategorized",
  "src/server/mobileMediaSend.ts": "uncategorized",
  "src/server/mobilePairingRoutes.ts": "uncategorized",
  "src/server/routes.ts": "uncategorized",
  "src/threadline/CollaborationSurfacer.ts": "uncategorized",
  "src/threadline/TelegramBridge.ts": "uncategorized",
  "src/threadline/hubCommands.ts": "uncategorized",
  "src/threadline/peerHomebaseRelay.ts": "uncategorized",
  "src/tunnel/TunnelManager.ts": "tunnel-notice"
} as const satisfies Record<string, NotificationCategoryId>;

/** A composite root names its producer explicitly instead of inheriting ambient authority. */
const NAMED_EMITTERS: Partial<Record<keyof typeof EMITTER_CATEGORIES, Partial<Record<'spend-alert-dispatcher' | 'quota-notifier' | 'reap-notifier', NotificationCategoryId>>>> = {
  'src/server/AgentServer.ts': { 'spend-alert-dispatcher': 'spend-alert' },
  'src/commands/server.ts': { 'reap-notifier': 'reap-notice' },
  'src/messaging/telegramSendSideComposition.ts': { 'quota-notifier': 'spend-alert', 'reap-notifier': 'reap-notice' },
};
export function notificationStamper(moduleId: keyof typeof EMITTER_CATEGORIES, producerId?: 'spend-alert-dispatcher' | 'quota-notifier' | 'reap-notifier'): () => OutboundEnvelope {
  const registered = producerId ? NAMED_EMITTERS[moduleId]?.[producerId] : EMITTER_CATEGORIES[moduleId];
  if (!registered) throw new Error('Unregistered notification producer capability');
  return () => ({ origin: 'automated', category: registered, sourceContext: producerId ? `${moduleId}#${producerId}` : moduleId });
}

export function withNotificationEnvelope<T>(envelope: OutboundEnvelope, send: () => T): T {
  return notificationContext.run(envelope, send);
}

/** Only explicit command/floor response callsites receive inbound authority. */
export function responseNotificationStamper(moduleId: keyof typeof EMITTER_CATEGORIES): () => OutboundEnvelope {
  const automated = notificationStamper(moduleId);
  return () => notificationContext.getStore() ?? automated();
}
