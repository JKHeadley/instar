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

export function notificationStamper(moduleId: keyof typeof EMITTER_CATEGORIES): () => OutboundEnvelope {
  const category = EMITTER_CATEGORIES[moduleId];
  return () => ({ origin: 'automated', category, sourceContext: moduleId });
}

export function withNotificationEnvelope<T>(envelope: OutboundEnvelope, send: () => T): T {
  return notificationContext.run(envelope, send);
}

/** Only explicit command/floor response callsites receive inbound authority. */
export function responseNotificationStamper(moduleId: keyof typeof EMITTER_CATEGORIES): () => OutboundEnvelope {
  const automated = notificationStamper(moduleId);
  return () => notificationContext.getStore() ?? automated();
}
