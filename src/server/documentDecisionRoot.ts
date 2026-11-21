/**
 * The approval root an owner device decides on (docs/specs/document-decisions.md §3.2): follow `approvedBy`
 * through this machine's own device records to the first device not approved by another phone. Refused
 * (null) when the deciding phone is not a document device (identity A4: a home-address or at-computer phone),
 * when any device on the way is a computer, a browser or missing, or when the root is an agent-introduced or
 * local-install approval, or a PIN approval on an agent that has a Telegram owner.
 *
 * The A4 check applies to the deciding phone only: a Telegram-approved home-address phone may approve an
 * ordinary phone (the phone approval route accepts it), and that phone keeps its own Telegram root through
 * it (GPT review 4).
 */
import { isBrowserDevice, type DeviceRecord } from '../core/MobileDeviceKeys.js';
import { notADocumentDevice } from './documentPageRoutes.js';

export interface DecisionRootDeps {
  device: (id: string) => DeviceRecord | null;
  /** In production `activeOwnerPhone(svc, id) && mayApprove(svc, id)`: an active owner phone whose presence key
   *  the approver module accepts (identity piece 3a; only that module reads presence keys). */
  activeOwnerPhone: (id: string) => boolean;
  agentHasTelegramOwner: () => boolean;
}

export function documentDecisionRootOf(deps: DecisionRootDeps, deviceId: string): 'telegram' | 'pin' | null {
  let d = deps.device(deviceId);
  if (!d || !deps.activeOwnerPhone(deviceId)) return null; // piece 3a: the approver check covers the presence key
  if (notADocumentDevice(d)) return null;
  for (let depth = 0; depth < 8 && d; depth++) {
    if (isBrowserDevice(d) || d.deviceKind === 'computer') return null;
    const via = d.approvedVia ?? 'telegram-dm';
    if (via === 'owner-phone') { d = d.approvedBy ? deps.device(d.approvedBy) : null; continue; }
    if (via === 'telegram-dm') return 'telegram';
    if (via === 'dashboard-pin') return deps.agentHasTelegramOwner() ? null : 'pin';
    return null;
  }
  return null;
}
