import { canonicalOrigin } from './CanonicalOrigin.js';
import type { OutagePolicyProjection } from './TelegramOriginOutageNotifier.js';

/** Independently observed Instar application policy. Personal Telegram client
 * preferences and actual destination existence are not observations we claim. */
export type OriginNoticeDestinationPolicy = Pick<OutagePolicyProjection,
  'destination' | 'authorized' | 'optedOut' | 'clientPreferences' |
  'observerHealthy' | 'observedAt' | 'validUntil' | 'version'>;

export function projectOriginNoticePolicy(input: {
  id: string; destination: OutagePolicyProjection['destination']; configObservedAt: number;
  enabled: boolean; ownershipValid: boolean; display: OutagePolicyProjection['display'];
  source: OriginNoticeDestinationPolicy | null; now?: number;
}): OutagePolicyProjection | null {
  try {
    const source = input.source ? structuredClone(input.source) : null, now = input.now ?? Date.now();
    if (!source || canonicalOrigin(source.destination) !== canonicalOrigin(input.destination) ||
      source.clientPreferences !== 'telegram-managed' ||
      !['authorized', 'optedOut', 'observerHealthy'].every(key =>
        typeof source[key as keyof OriginNoticeDestinationPolicy] === 'boolean') || !source.observerHealthy ||
      !Number.isSafeInteger(source.observedAt) || !Number.isSafeInteger(source.validUntil) ||
      !Number.isSafeInteger(input.configObservedAt) || source.observedAt > now || input.configObservedAt > now ||
      now - source.observedAt > 30_000 || now - input.configObservedAt > 30_000 || source.validUntil <= now ||
      typeof source.version !== 'string' || !source.version || source.version.length > 256) return null;
    return { ...source, alertDestinationId: input.id, authorized: input.enabled && source.authorized,
      ownershipValid: input.ownershipValid, display: structuredClone(input.display),
      observedAt: Math.min(source.observedAt, input.configObservedAt),
      validUntil: Math.min(source.validUntil, source.observedAt + 30_000, input.configObservedAt + 30_000) };
  } catch { return null; }
}
