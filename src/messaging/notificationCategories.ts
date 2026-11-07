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

/** The job slug rule, minus names that would address an object's own shape. */
export function isNotificationJobSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
}
/** The scheduler's own mark: a jobSlug alone can be supplied by anyone who spawns a session. */
export function scheduledJobSlug(session: { jobSlug?: string; triggeredBy?: string } | null | undefined): string | undefined {
  return session?.jobSlug && session.triggeredBy?.startsWith('scheduler:') ? session.jobSlug : undefined;
}
/** Advice carried by job creation. It informs the agent; the choice stays the operator's. */
export function jobReportChoice(slug: string, state: { enforcing: boolean; categoryPush: boolean }) {
  const route = `POST /notifications/jobs/${slug}/push`;
  const ask = `If this job reports to the user, ask whether they want to see its reports. On a yes, send ${route} with enabled true, confirmedBy "operator-conversational-confirm", the topicId, and the id of their message (GET /telegram/topics/TOPIC/messages) as confirmingMessageId. No answer means quiet. Never grant this yourself.`;
  if (state.categoryPush) return { default: 'quiet' as const, effective: 'pushed-by-category' as const, route,
    agentAction: `All scheduled job reports are currently pushed, so "${slug}" will reach the user. Tell them so, and offer to change that if they want only some jobs.` };
  if (!state.enforcing) return { default: 'quiet' as const, effective: 'delivered-while-observing' as const, route,
    agentAction: `Quiet by Default is only observing here, so reports from "${slug}" still reach the user for now. ${ask}` };
  return { default: 'quiet' as const, effective: 'quiet' as const, route, agentAction: `Reports from "${slug}" stay in the Notifications feed. ${ask}` };
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
