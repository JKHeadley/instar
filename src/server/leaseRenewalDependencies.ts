/**
 * Which conversation surfaces on this agent admit work only while this machine holds
 * the serving lease, and so need the holder-only lease renewal carrier
 * (MultiMachineCoordinator.enrollLeaseRenewalDependency) even when the standalone
 * `leaseSelfHeal.resilientRenew` flag is omitted on a non-development agent.
 *
 * - `telegram-origin-writer`: an enabled Telegram adapter (origin egress holds sends
 *   without a current lease).
 * - `app-conversations`: native app conversations (POST /mobile/chat/app/:key answers
 *   503 owner-unavailable without a current lease). Without this entry a Telegram-free
 *   agent's lease lapsed at TTL and stayed lapsed until the next 2-minute heartbeat.
 * - `takeover-survivor`: the takeover switch (`leaseSelfHeal.soloCaptainHold`). A machine that
 *   takes over may have no conversation surface of its own: a join-built standby has none. It
 *   still has to keep what it took, or it is the holder for only 60 s of every 120 s and the
 *   epoch climbs each heartbeat (measured on a test pair: epoch 72 to 91 in 38 minutes).
 */
import type { InstarConfig } from '../core/types.js';
import { isMobileNativeEnabled } from './mobilePairingRoutes.js';

export function leaseRenewalDependencies(config: InstarConfig): string[] {
  const out: string[] = [];
  if ((config.messaging ?? []).some((m) => m.type === 'telegram' && m.enabled)) out.push('telegram-origin-writer');
  if (isMobileNativeEnabled(config)) out.push('app-conversations');
  if (config.multiMachine?.leaseSelfHeal?.soloCaptainHold?.enabled) out.push('takeover-survivor');
  return out;
}
