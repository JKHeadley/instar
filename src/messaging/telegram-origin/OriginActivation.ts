/** Rolling activation is a conjunction of independently observed obligations.
 * These are internal observations, never operator-supplied HTTP assertions. */
export const ORIGIN_ACTIVATION_OBLIGATIONS = [
  'storage-readers', 'bot-writers', 'automation-authors', 'lifeline', 'sessions',
  'installed-scripts', 'tool-guards', 'browser-profiles', 'peers', 'sender-census',
  'notice-policy', 'send-policy', 'development-trials',
] as const;
export type OriginActivationObligation = typeof ORIGIN_ACTIVATION_OBLIGATIONS[number];
export interface OriginActivationObservation {
  obligation: OriginActivationObligation;
  subject: string;
  state: 'ready' | 'held' | 'unknown' | 'not-applicable';
  reason: string;
  observedAt: number;
  validUntil: number;
}
export interface OriginEnrollmentSnapshot {
  /** Census completeness includes enabled sessions, processes, profiles and peers. */
  inventoryComplete: boolean;
  observations: OriginActivationObservation[];
}
export function assessOriginActivation(snapshot: OriginEnrollmentSnapshot | null, now = Date.now()) {
  const observations: OriginActivationObservation[] = [];
  const seen = new Set<string>();
  let malformed = !snapshot || !Array.isArray(snapshot.observations) || snapshot.observations.length > 1000;
  if (!malformed) for (const item of snapshot!.observations) {
    const key = `${item.obligation}:${item.subject}`;
    if (!ORIGIN_ACTIVATION_OBLIGATIONS.includes(item.obligation) || typeof item.subject !== 'string' ||
      !item.subject || item.subject.length > 128 || typeof item.reason !== 'string' || item.reason.length > 256 ||
      !['ready', 'held', 'unknown', 'not-applicable'].includes(item.state) || seen.has(key)) { malformed = true; break; }
    seen.add(key);
    const fresh = Number.isSafeInteger(item.observedAt) && Number.isSafeInteger(item.validUntil) &&
      item.observedAt <= now && now - item.observedAt <= 30_000 && item.validUntil > now;
    observations.push({ ...item, ...(fresh ? {} : { state: 'unknown' as const, reason: 'enrollment-observation-expired' }) });
  }
  if (malformed) observations.length = 0;
  for (const obligation of ORIGIN_ACTIVATION_OBLIGATIONS) {
    if (!observations.some(item => item.obligation === obligation)) observations.push({ obligation, subject: 'coverage',
      state: 'unknown', reason: 'enrollment-observation-missing', observedAt: now, validUntil: now });
  }
  const complete = !malformed && snapshot!.inventoryComplete === true && observations.every(item => ['ready', 'not-applicable'].includes(item.state));
  return { complete, state: complete ? 'ready' as const : 'incomplete' as const,
    inventoryComplete: !malformed && snapshot!.inventoryComplete === true,
    observations, assessedAt: now };
}
