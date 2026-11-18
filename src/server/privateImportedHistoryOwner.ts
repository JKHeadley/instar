import type { Request } from 'express';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { deviceKeyOf, isBrowserDevice } from '../core/MobileDeviceKeys.js';
import { mobileOwnerDeviceAdmission, revalidateQueuedOwnerAdmissionSnapshot } from './mobileOwnerDeviceAdmission.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

/** A machine-local store has no per-profile partition. Only its unambiguous current native owner may search it. */
export function privateImportedHistoryOwner(pairing: MobilePairingService | null | undefined, req: Request): boolean {
  if (!pairing) return false;
  try {
    const current = mobileOwnerDeviceAdmission(pairing, req);
    if (!current || isBrowserDevice(pairing.devices.get(current.deviceId))) return false;
    if (Object.values(pairing.grants.all()).some(grant => grant.ownerConversations)) return false;
    for (const device of pairing.devices.list()) {
      if (device.status !== 'active' || (device.role ?? 'owner') !== 'owner') continue;
      const userId = device.userId ?? null;
      if (userId === current.identity.userId) continue;
      const key = deviceKeyOf(device);
      if (key && revalidateQueuedOwnerAdmissionSnapshot(pairing, {
        deviceId: device.id, identity: { userId, role: 'owner', keyHash: deviceKeyHashOf(key) },
      }).ok) return false;
    }
    return true;
  } catch {
    return false; // Unavailable identity or grant records cannot authorize this private source.
  }
}
