/** Reusable live owner-phone authorization for asynchronous private reads. */
// E2E-PAIRING: tests/e2e/conversation-graph-surface-alive.test.ts — actual
// AgentServer signature admission and owner snapshot use. The helper now has
// graph callers; it is no longer a no-caller exemption. Proxy coverage remains
// tests/e2e/mobile-slack-holder-proxy-alive.test.ts in its owning branch.
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

/** Why a retained owner admission no longer holds. */
export type OwnerSnapshotRefusal =
  | 'malformed-snapshot' | 'not-owner-role' | 'pairing-off' | 'native-off' | 'key-ledger-missing'
  | 'device-missing' | 'device-inactive' | 'key-changed' | 'key-revoked'
  | 'person-changed' | 'person-not-owner' | 'profile-not-owner' | 'unreadable';

/**
 * The one current-owner policy. Both the live helper and the queued-snapshot validator call it,
 * so the two can never disagree. `routePerson` is the live helper's extra route-time person
 * check (always compared when present, whatever its userId); the queued path passes null.
 */
function ownerAdmissionRefusal(pairing: MobilePairingService, deviceId: string,
  admitted: MobileDeviceAdmissionIdentity, routePerson: { readonly userId: unknown } | null): OwnerSnapshotRefusal | null {
  try {
    if (!pairing.enabled()) return 'pairing-off';
    if (!pairing.nativeOn || !isMobileNativeEnabled(pairing.deps.config)) return 'native-off';
    if (!pairing.keyLedger) return 'key-ledger-missing';
    const device = pairing.devices.get(deviceId);
    if (!device) return 'device-missing';
    if (device.status !== 'active' || !device.publicKey) return 'device-inactive';
    if (deviceKeyHashOf(device.publicKey) !== admitted.keyHash) return 'key-changed';
    if (pairing.keyLedger.isRevoked(admitted.keyHash, deviceId)) return 'key-revoked';
    if ((device.userId ?? null) !== admitted.userId || (device.role ?? 'owner') !== admitted.role) return 'person-changed';
    const current = pairing.personOfDevice(device);
    if (!current.ok || current.role !== 'owner' || current.userId !== admitted.userId
      || (routePerson !== null && routePerson.userId !== current.userId)) return 'person-not-owner';
    if (current.userId) {
      const profile = pairing.people()?.getUser(current.userId);
      if (!profile || !isOwnerProfile(profile, pairing.ownerIdentity())) return 'profile-not-owner';
    }
    return null;
  } catch { return 'unreadable'; } // @silent-fallback-ok — unreadable private-read authority always refuses
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
  const isCurrent = (): boolean => ownerAdmissionRefusal(pairing, deviceId, admitted, person) === null;
  return isCurrent() ? Object.freeze({ deviceId, identity: admitted, isCurrent }) : null;
}

/** The original admission as it was durably queued: what deviceAuthenticator admitted, nothing more. */
export interface QueuedOwnerAdmissionSnapshot {
  readonly deviceId: string;
  readonly identity: MobileDeviceAdmissionIdentity;
}

export type OwnerSnapshotVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: OwnerSnapshotRefusal };

const refuse = (reason: OwnerSnapshotRefusal): OwnerSnapshotVerdict => Object.freeze({ ok: false as const, reason });

/**
 * HISTORICAL SNAPSHOT VALIDATION, NOT AUTHENTICATION. Rechecks a previously admitted owner
 * snapshot against current state with the same policy as `mobileOwnerDeviceAdmission`.
 * It cannot tell a real admission from a forged one: the caller must already have verified the
 * snapshot's provenance (for example, a decrypted, machine-signed sealed queue intent).
 * Never fed from an HTTP header, body or later registry read. Pure read; never mutates.
 */
export function revalidateQueuedOwnerAdmissionSnapshot(pairing: MobilePairingService,
  snapshot: QueuedOwnerAdmissionSnapshot): OwnerSnapshotVerdict {
  let deviceId: unknown, keyHash: unknown, userId: unknown, role: unknown;
  try {
    // Read each field exactly once, so a getter cannot answer differently later.
    deviceId = snapshot?.deviceId;
    const identity = snapshot?.identity;
    if (!identity || typeof identity !== 'object') return refuse('malformed-snapshot');
    ({ keyHash, userId, role } = identity);
  } catch { return refuse('malformed-snapshot'); }
  if (typeof deviceId !== 'string' || !deviceId || typeof keyHash !== 'string' || !keyHash
    || !(userId === null || (typeof userId === 'string' && userId))) return refuse('malformed-snapshot');
  if (role !== 'owner') return refuse('not-owner-role');
  const reason = ownerAdmissionRefusal(pairing, deviceId, Object.freeze({ keyHash, userId, role }), null);
  return reason ? refuse(reason) : Object.freeze({ ok: true as const });
}
