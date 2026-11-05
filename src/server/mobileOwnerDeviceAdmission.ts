/** Reusable live owner-phone authorization for asynchronous private reads. */
import type { Request } from 'express';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { isOwnerProfile } from '../core/MobilePeople.js';
import { deviceAdmissionIdentity, deviceAdmittedAt, devicePersonOf, isMobileNativeEnabled,
  type MobileDeviceAdmissionIdentity, type MobilePairingService } from './mobilePairingRoutes.js';

export interface MobileOwnerDeviceAdmission {
  readonly deviceId: string;
  /** Immutable identity used by signature verification, never a route-time replacement. */
  readonly identity: MobileDeviceAdmissionIdentity;
  /** Rereads live authority; call before every dial and immediately before emitting private bytes. */
  isCurrent(): boolean;
}

/**
 * Only an actual signature admission supplies the key/person snapshot. A later registry read
 * must never become the baseline: a key rotated between authentication and routing is different.
 * Notify tokens, bearer callers and MSP grants do not create owner-phone authority.
 */
export function mobileOwnerDeviceAdmission(pairing: MobilePairingService, req: Request): MobileOwnerDeviceAdmission | null {
  const principal = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
  const admitted = deviceAdmissionIdentity(req);
  const person = devicePersonOf(req);
  if (principal?.kind !== 'device' || !principal.deviceId || !admitted
    || !deviceAdmittedAt(req) || admitted.role !== 'owner' || person?.role !== 'owner') return null;
  const deviceId = principal.deviceId;
  const isCurrent = (): boolean => {
    try {
      if (!pairing.keyLedger || !pairing.enabled() || !pairing.nativeOn || !isMobileNativeEnabled(pairing.deps.config)) return false;
      const device = pairing.devices.get(deviceId);
      if (!device || device.status !== 'active' || !device.publicKey
        || deviceKeyHashOf(device.publicKey) !== admitted.keyHash
        || (device.userId ?? null) !== admitted.userId || (device.role ?? 'owner') !== admitted.role
        || pairing.keyLedger.isRevoked(admitted.keyHash, deviceId)) return false;
      const current = pairing.personOfDevice(device);
      if (!current.ok || current.role !== 'owner' || current.userId !== admitted.userId || person.userId !== current.userId) return false;
      if (current.userId) {
        const profile = pairing.people()?.getUser(current.userId);
        if (!profile || !isOwnerProfile(profile, pairing.ownerIdentity())) return false;
      }
      return true;
    } catch { return false; } // @silent-fallback-ok — unreadable private-read authority always refuses
  };
  return isCurrent() ? Object.freeze({ deviceId, identity: admitted, isCurrent }) : null;
}
