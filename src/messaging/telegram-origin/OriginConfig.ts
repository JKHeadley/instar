import { DEFAULT_ORIGIN_DISPLAY } from './OriginPresentation.js';
import type { OriginDestination } from './types.js';

export interface BrowserSendAllowance {
  readonly profileId: string; readonly accountId: string; readonly chatId: string;
  readonly topicId: string | null; readonly decisionRef: string;
}

/** A singular, exact destination from operator-owned config. Malformed or broad
 * grants fail closed for the browser path without disabling ordinary bot sends. */
export function readBrowserSendAllowance(origin: unknown): BrowserSendAllowance | null {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const value = (origin as { browserSendAllowance?: unknown }).browserSendAllowance;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const grant = value as Record<string, unknown>;
  const keys = ['profileId', 'accountId', 'chatId', 'topicId', 'decisionRef'];
  if (Object.keys(grant).length !== keys.length || keys.some(key => !Object.hasOwn(grant, key)) ||
    typeof grant.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(grant.profileId) ||
    typeof grant.accountId !== 'string' || !/^[1-9][0-9]*$/.test(grant.accountId) ||
    typeof grant.chatId !== 'string' || !/^channel:[1-9][0-9]*$/.test(grant.chatId) ||
    !(grant.topicId === null || (typeof grant.topicId === 'string' && /^[1-9][0-9]*$/.test(grant.topicId))) ||
    typeof grant.decisionRef !== 'string' || grant.decisionRef.length < 8 || grant.decisionRef.length > 160) return null;
  return Object.freeze({ profileId: grant.profileId, accountId: grant.accountId,
    chatId: grant.chatId, topicId: grant.topicId, decisionRef: grant.decisionRef });
}

export function browserSendAllowanceMatches(grant: BrowserSendAllowance | null, profileId: string,
  enrolledAccountId: string, destination: OriginDestination): boolean {
  return !!grant && profileId === grant.profileId && enrolledAccountId === grant.accountId &&
    destination.transport === 'telegram-web' && destination.accountId === grant.accountId &&
    destination.chatId === grant.chatId && destination.topicId === grant.topicId &&
    destination.messageId === null && destination.inlineMessageId === null && destination.scheduledMessageId === null;
}

export const ORIGIN_DETECTOR_CANARY_INTERVAL_MS = 3_600_000;
export function originDetectorCanaryInterval(origin: unknown): number {
  if (origin === undefined) return ORIGIN_DETECTOR_CANARY_INTERVAL_MS;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) throw new Error('invalid-origin-canary-config');
  const canary = (origin as { detectorCanary?: unknown }).detectorCanary;
  if (canary === undefined) return ORIGIN_DETECTOR_CANARY_INTERVAL_MS;
  if (!canary || typeof canary !== 'object' || Array.isArray(canary) || Object.keys(canary).some(key => key !== 'intervalMs')) throw new Error('invalid-origin-canary-config');
  const rawInterval = (canary as { intervalMs?: unknown }).intervalMs;
  const interval = rawInterval === undefined ? ORIGIN_DETECTOR_CANARY_INTERVAL_MS : rawInterval;
  if (!Number.isSafeInteger(interval) || Number(interval) < 60_000 || Number(interval) > 604_800_000) throw new Error('invalid-origin-canary-interval');
  return Number(interval);
}

export function originOutageNoticeEnabled(origin: unknown): boolean {
  if (origin === undefined) return true;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) throw new Error('invalid-origin-notice-config');
  const notice = (origin as { outageNotice?: unknown }).outageNotice;
  if (notice === undefined) return true;
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) throw new Error('invalid-origin-notice-config');
  const enabled = (notice as { enabled?: unknown }).enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('invalid-origin-notice-config');
  return enabled ?? true;
}

/** a2a-single-agent-identity §4.3 — forward-to-holder kill switch. Omitted
 * means enabled (reachability is a safety floor; it ships live). Only the
 * FORWARD is switchable: a hold stays durable and reported either way. */
export function originForwardToHolderEnabled(origin: unknown): boolean {
  if (origin === undefined) return true;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) throw new Error('invalid-origin-forward-config');
  const forward = (origin as { forwardToHolder?: unknown }).forwardToHolder;
  if (forward === undefined) return true;
  if (!forward || typeof forward !== 'object' || Array.isArray(forward)) throw new Error('invalid-origin-forward-config');
  const enabled = (forward as { enabled?: unknown }).enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('invalid-origin-forward-config');
  return enabled ?? true;
}

/** Add only missing presentation/notice defaults. Never changes an operator's false,
 * creates an audit-off switch, or activates a writer without enrollment.
 */
export function migrateTelegramOriginDisplay(config: Record<string, unknown>): boolean {
  if (!Array.isArray(config.messaging)) return false;
  let changed = false;
  for (const entry of config.messaging) {
    if (!entry || entry.type !== 'telegram' || !entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)) continue;
    if (entry.config.messageOrigin === undefined) { entry.config.messageOrigin = {}; changed = true; }
    const origin = entry.config.messageOrigin;
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) continue;
    if (origin.detectorCanary === undefined) { origin.detectorCanary = { intervalMs: ORIGIN_DETECTOR_CANARY_INTERVAL_MS }; changed = true; }
    else if (origin.detectorCanary && typeof origin.detectorCanary === 'object' && !Array.isArray(origin.detectorCanary) && origin.detectorCanary.intervalMs === undefined) {
      origin.detectorCanary.intervalMs = ORIGIN_DETECTOR_CANARY_INTERVAL_MS; changed = true;
    }
    if (origin.outageNotice === undefined) { origin.outageNotice = { enabled: true }; changed = true; }
    else if (origin.outageNotice && typeof origin.outageNotice === 'object' && !Array.isArray(origin.outageNotice) && origin.outageNotice.enabled === undefined) {
      origin.outageNotice.enabled = true; changed = true;
    }
    if (origin.forwardToHolder === undefined) { origin.forwardToHolder = { enabled: true }; changed = true; }
    else if (origin.forwardToHolder && typeof origin.forwardToHolder === 'object' && !Array.isArray(origin.forwardToHolder) && origin.forwardToHolder.enabled === undefined) {
      origin.forwardToHolder.enabled = true; changed = true;
    }
    if (origin.display === undefined) { origin.display = {}; changed = true; }
    if (!origin.display || typeof origin.display !== 'object' || Array.isArray(origin.display)) continue;
    for (const [key, value] of Object.entries(DEFAULT_ORIGIN_DISPLAY)) {
      if (origin.display[key] === undefined) { origin.display[key] = value; changed = true; }
    }
  }
  return changed;
}
