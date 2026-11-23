/**
 * The server side of approving a trust raise from the Instar app (docs/specs/app-trust-approval.md):
 * how the trust journey reads the paired-device registry, and the narrow port the phone routes in
 * mobilePermissionsRoutes.ts use. The routes own the write gate and the presence proof; the account
 * path service owns every decision.
 */
import type { Request } from 'express';
import type { AccountPathService, DeviceDirectory, DeviceSnapshot } from '../core/trustJourney/AccountPathService.js';
import type { TrustAccountPathRuntime } from '../core/trustJourney/TrustJourneyRuntime.js';
import { deviceFingerprint, keyHashOf, type DeviceRecord, deviceKeyOf } from '../core/MobileDeviceKeys.js';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { mayBeLocalArrival } from '../core/requestArrival.js';
import { activeOwnerPhone } from './mobileConsoleTicket.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

export interface MobileTrustPort {
  readonly service: AccountPathService;
  /** Only the serving-lease holder decides device approvals and acceptances. */
  holdsLease(): boolean;
  readonly devices: DeviceDirectory;
  /** The local override's key replacement (DeviceRegistry.replacePresenceKey). */
  replacePresenceKey(deviceId: string, publicKey: string): 'replaced' | 'same' | 'conflict' | 'not-active';
  /** The device record carries a local binding to THIS machine (the Instar app on the agent's computer paired it). */
  localBindingHere(deviceId: string): boolean;
}

type LocalFields = { approvedVia?: string; localBinding?: { machineId?: string | null } | null };

/**
 * Paired by the app on the agent's own computer (mac-app-creates-agent §A): `approvedVia: 'local-install'`
 * with a `localBinding`. Read loosely: the registry's type gains these fields with that pairing path.
 */
export function pairedLocally(d: DeviceRecord | null | undefined): boolean {
  const x = d as unknown as LocalFields | null | undefined;
  return !!x && x.approvedVia === 'local-install' && !!x.localBinding && typeof x.localBinding === 'object';
}

/** The device as the trust journey reads it, fresh from the registry. */
export function deviceSnapshot(svc: MobilePairingService | null, deviceId: string): DeviceSnapshot | null {
  if (!svc) return null;
  const d = svc.devices.get(deviceId);
  if (!d) return null;
  return {
    deviceId: d.id,
    name: d.deviceName ?? d.label ?? null,
    active: activeOwnerPhone(svc, d.id),
    // Through the one device-key reader (browser-device §4.1); a browser is never an approving device (activeOwnerPhone).
    // E2E-PAIRING: EXEMPT — reads the same key through deviceKeyOf (refactor); tests/e2e/trust-app-approval-alive.test.ts covers these routes.
    keyFingerprint: deviceKeyOf(d) ? (d.fingerprint ?? deviceFingerprint(deviceKeyOf(d)!)) : null,
    presenceKeyHash: d.presenceKey ? keyHashOf(d.presenceKey) : null,
    deviceKind: d.deviceKind === 'computer' ? 'computer' : 'phone',
    localInstall: pairedLocally(d),
    firstPairing: pairedLocally(d) || (typeof d.approvedBy === 'string' && pairedLocally(svc.devices.get(d.approvedBy))),
  };
}

export function createMobileTrustPort(runtime: TrustAccountPathRuntime, pairing: () => MobilePairingService | null, selfMachineId: () => string | null, enabled: () => boolean = () => true): MobileTrustPort {
  const devices: DeviceDirectory = {
    enabled,
    get: (id) => deviceSnapshot(pairing(), id),
    notify: (subject, dedupeKey) => { pairing()?.push?.notifyHere({ kind: 'notice', subject, dedupeKey }); },
  };
  return {
    service: runtime.service,
    holdsLease: () => runtime.holdsLease(),
    devices,
    replacePresenceKey: (id, key) => pairing()?.devices.replacePresenceKey(id, key) ?? 'not-active',
    localBindingHere: (id) => {
      const d = pairing()?.devices.get(id) ?? null;
      if (!pairedLocally(d)) return false;
      const bound = (d as unknown as LocalFields).localBinding!.machineId ?? null;
      const self = selfMachineId();
      return !bound || !self || bound === self;
    },
  };
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];

/**
 * The local override's transport (app-trust-approval §D): loopback with no forwarding header, so a
 * request through the tunnel connector (which also arrives on loopback) is never local. A remote
 * device can never replace a key.
 */
export function arrivedLocallyUnforwarded(req: Pick<Request, 'headers' | 'socket'>): boolean {
  if (!mayBeLocalArrival(req) || !isLoopbackPeer(req.socket.remoteAddress)) return false;
  return !FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
}

/** The HTTP status for a service answer. */
export function trustAnswerStatus(r: { status: string; reason?: string }): number {
  switch (r.status) {
    case 'applied': case 'not-applied': case 'unknown': case 'recorded': case 'already-accepted': return 200;
    case 'already-approved': case 'not-holder': return 409;
    case 'not-recorded': return 503;
    default:
      if (r.reason === 'unknown-request') return 404;
      if (r.reason === 'devices-unavailable') return 503;
      if (r.reason?.startsWith('request-') || r.reason === 'proposal-changed' || r.reason === 'approval-used') return 409;
      if (r.reason?.startsWith('bad-')) return 400;
      return 403;
  }
}
