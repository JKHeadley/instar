import fs from 'node:fs';
import path from 'node:path';
import { parseUserAnnouncement, userFacingEntries } from '../core/upgradeAnnouncement.js';
/** Reviewed structural delivery policy. Priority and message text confer no push authority. */
export const notificationCategories = [
  ['attention-item', 'Attention items'], ['agent-health', 'Agent health'], ['job-status', 'Scheduled job reports'],
  ['sentinel-escalation', 'Monitoring findings'], ['reap-notice', 'Session housekeeping'],
  ['resume-queue-notice', 'Conversation recovery'], ['commitment-deadletter', 'Commitment recovery'],
  ['spend-alert', 'Usage reports'], ['mesh-alert', 'Machine connectivity'], ['tunnel-notice', 'Connection notices'],
  ['advisory-escalation', 'Messaging observations'], ['autonomous-heartbeat', 'Background progress'],
  ['update-announcement', 'Software updates'], ['selectivity-digest', 'Quiet notification digest'],
  ['presence-standby', 'Waiting for a reply'], ['cold-start-fallback', 'Conversation availability'],
  ['message-loss-notice', 'Message delivery problems'], ['command-response', 'Command responses'],
  ['uncategorized', 'Other automated notices'],
] as const;
export type NotificationCategoryId = typeof notificationCategories[number][0];
export type SignificantClass = 'security-incident' | 'data-loss' | 'agent-cannot-operate';
export const CONVERSATION_CATEGORIES = new Set<NotificationCategoryId>([
  'presence-standby', 'cold-start-fallback', 'message-loss-notice', 'command-response',
]);
export const SIGNIFICANT_TABLE: Readonly<Partial<Record<NotificationCategoryId, readonly SignificantClass[]>>> = {
  // These classes require trusted wiring; arbitrary HTTP metadata cannot grant them.
  'attention-item': ['security-incident', 'data-loss', 'agent-cannot-operate'],
};
export function isNotificationCategory(value: unknown): value is NotificationCategoryId {
  return notificationCategories.some(([id]) => id === value);
}

/** Existing default-false delivery switches remain the same operator choice. */
export const LEGACY_NOTIFICATION_GATES = {
  'sentinel-escalation': 'monitoring.sentinelTelegramEscalation',
} as const;
/** Authenticated automation-producer ids, never caller-supplied message text. */
export const PRODUCER_NOTIFICATION_CATEGORIES: Readonly<Record<string, NotificationCategoryId>> = {
  'presence-proxy': 'presence-standby',
  'promise-beacon': 'commitment-deadletter',
  'promise-beacon-escalation': 'commitment-deadletter',
  'autonomous-heartbeat': 'autonomous-heartbeat',
  'auto-updater': 'update-announcement',
  'post-update': 'update-announcement',
  'advisory-escalation': 'advisory-escalation',
  'outbound-advisory': 'advisory-escalation',
  'resume-queue': 'resume-queue-notice',
  'reap-notice-drain': 'reap-notice',
  'session-monitor': 'reap-notice',
  'quota-notifier': 'spend-alert',
  'reap-notifier': 'reap-notice',
};
export function categoryForProducer(producerId: string | undefined, jobSlug?: string): NotificationCategoryId {
  return producerId && PRODUCER_NOTIFICATION_CATEGORIES[producerId] || (jobSlug ? 'job-status' : 'uncategorized');
}
/** Composite attention producer retains its structured source family. */
export function categoryForAttention(source: string | undefined, lane?: string): NotificationCategoryId {
  if (lane === 'agent-health') return 'agent-health';
  const families: Readonly<Record<string, NotificationCategoryId>> = {
    'resume-queue': 'resume-queue-notice',
    'promise-beacon-escalation': 'commitment-deadletter',
    'outbound-advisory': 'advisory-escalation',
    'outbound-advisory-escalation': 'advisory-escalation',
    'machine-coherence': 'mesh-alert',
    'machine-coherence-guard': 'mesh-alert',
    'rope-recovery-probe': 'mesh-alert',
    'rope-health': 'mesh-alert',
  };
  return source && families[source] || 'attention-item';
}

/** Existing PA-5 authority: only a real upgrade-notify job and promoted release guide. */
export function hasPromotedUpgradeAnnouncement(stateDir: string, jobSlug: string | undefined): boolean {
  if (jobSlug !== 'upgrade-notify') return false;
  try {
    const file = path.join(stateDir, 'state', 'pending-upgrade-guide.md');
    if (fs.statSync(file).size > 256 * 1024) return false;
    return userFacingEntries(parseUserAnnouncement(fs.readFileSync(file, 'utf8'))).length > 0;
  } catch { return false; /* @silent-fallback-ok: absent or unreadable promotion never grants push */ }
}
