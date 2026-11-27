import type { Request } from 'express';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { deviceKeyOf, isBrowserDevice } from '../core/MobileDeviceKeys.js';
import { deviceAdmissionIdentity, devicePersonOf, personOfReaderKey, principalOf, type MobilePairingService } from './mobilePairingRoutes.js';
import { mobileOwnerDeviceAdmission } from './mobileOwnerDeviceAdmission.js';

/** Resolve the current reader without replacing the identity that signed the request. */
export function exactMessageReader(pairing: MobilePairingService, req: Request) {
  const principal = principalOf(req);
  if (principal.kind === 'token') {
    const admitted = JSON.stringify(pairing.ownerIdentity());
    const original = personOfReaderKey(pairing, 'owner');
    return () => {
      const current = personOfReaderKey(pairing, 'owner');
      return original && current && JSON.stringify(pairing.ownerIdentity()) === admitted
        && current.role === original.role && current.userId === original.userId ? original : null;
    };
  }
  if (principal.kind !== 'device') return () => null;
  const admitted = deviceAdmissionIdentity(req);
  const original = devicePersonOf(req);
  if (!admitted || !original) return () => null;
  if (admitted.role === 'owner') {
    const owner = mobileOwnerDeviceAdmission(pairing, req);
    return () => owner?.isCurrent() ? original : null;
  }
  return () => {
    if (!pairing.enabled() || !pairing.keyLedger) return null;
    const device = pairing.devices.get(principal.deviceId);
    if (!device || device.status !== 'active' || device.role !== admitted.role || (device.userId ?? null) !== admitted.userId
      || (isBrowserDevice(device) && !pairing.browserOn())) return null;
    const key = deviceKeyOf(device);
    if (!key || deviceKeyHashOf(key) !== admitted.keyHash || pairing.keyLedger.isRevoked(admitted.keyHash, principal.deviceId)) return null;
    const current = pairing.personOfDevice(device);
    return current.ok && current.role === original.role && current.userId === original.userId ? current : null;
  };
}
