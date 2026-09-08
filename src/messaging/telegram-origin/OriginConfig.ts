import { DEFAULT_ORIGIN_DISPLAY } from './OriginPresentation.js';

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
    if (origin.display === undefined) { origin.display = {}; changed = true; }
    if (!origin.display || typeof origin.display !== 'object' || Array.isArray(origin.display)) continue;
    for (const [key, value] of Object.entries(DEFAULT_ORIGIN_DISPLAY)) {
      if (origin.display[key] === undefined) { origin.display[key] = value; changed = true; }
    }
  }
  return changed;
}
