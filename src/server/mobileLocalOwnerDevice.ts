/**
 * The first owner device from the same Mac (docs/specs/mac-app-creates-agent.md §A).
 *
 * The Instar Mac app ran the installer on this Mac; the installer left a one-time ticket in the
 * agent's own state folder (0600). The app reads it, proves it holds its Secure Enclave device key,
 * and asks for exactly one thing: to be this agent's first owner device. The route answers 404 to
 * anyone off this Mac and to any agent with no fresh ticket, so it does not exist on an agent the
 * app did not just create.
 */
// E2E-PAIRING: EXEMPT — reader refactor (deviceKeyOf), behavior unchanged; covered by tests/e2e/mac-app-creates-agent-alive.test.ts
import { deviceKeyOf } from '../core/MobileDeviceKeys.js';
import crypto from 'node:crypto';
import type { Application, Request, Response } from 'express';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { DeviceRegistry, parseDevicePublicKey, type DeviceRecord } from '../core/MobileDeviceKeys.js';
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { noteLocalOwnerTicketFailure, readLocalOwnerTicket, removeLocalOwnerTicket, sameLocalOwnerTicket } from '../core/localOwnerTicket.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { hasForwardingHeaders, isLoopbackHost, verifyP256 } from './mobileBrowserDevices.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';

export const LOCAL_OWNER_PATH = '/mobile/local-owner-device';
export const LOCAL_OWNER_PROOF_VERSION = 'instar-local-owner-v1';
export const LOCAL_OWNER_RATE_LIMIT = 5;
export const LOCAL_OWNER_RATE_WINDOW_MS = 10 * 60_000;
const PROOF_WINDOW_MS = 60_000;
const FEATURE = 'mobilePairing.localOwnerDevice';

export function localOwnerProofMessage(host: string, publicKey: string, ticket: string, timeMs: string): string {
  const ticketHash = crypto.createHash('sha256').update(ticket).digest('hex');
  return `${LOCAL_OWNER_PROOF_VERSION}\n${host}\n${publicKey}\n${ticketHash}\n${timeMs}`;
}

/** The kill switch: `mobilePairing.localOwnerDevice.enabled === false` turns the route off. */
export function isLocalOwnerDeviceEnabled(svc: MobilePairingService): boolean {
  const c = (svc.deps.config.mobilePairing as { localOwnerDevice?: { enabled?: unknown } } | undefined)?.localOwnerDevice;
  return svc.enabled() && c?.enabled !== false;
}

/** This server's own loopback Host, exactly, from a loopback peer with no forwarding header; else null. */
export function sameMacHost(req: Pick<Request, 'headers' | 'socket'>, port: number): string | null {
  const raw = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (!isLoopbackPeer(req.socket.remoteAddress)) return null;
  if (hasForwardingHeaders(req.headers as Record<string, unknown>)) return null;
  // Only the numeric address: one spelling, so a retry always names the same host (second-pass review).
  if (raw !== `127.0.0.1:${port}`) return null;
  return raw;
}

/**
 * The signed-request rule for a `localBinding` record (§A): loopback peer, no forwarding header,
 * the exact stored Host, and the same machine when both machine ids are known.
 */
export function localBindingOk(d: Pick<DeviceRecord, 'host' | 'localBinding'>, req: Pick<Request, 'headers' | 'socket'>, selfMachineId: string | null | undefined): boolean {
  if (!d.localBinding || !isLoopbackHost(d.host)) return false;
  if (!isLoopbackPeer(req.socket.remoteAddress) || hasForwardingHeaders(req.headers as Record<string, unknown>)) return false;
  const raw = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (raw !== d.host) return false;
  const bound = d.localBinding.machineId;
  if (bound && selfMachineId && bound !== selfMachineId) return false;
  return true;
}

export interface LocalOwnerRouteOptions {
  /** The agent's name, returned to the app. */
  agentName: () => string;
  now?: () => number;
}

export function mountLocalOwnerDeviceRoute(app: Application, svc: MobilePairingService, opts: LocalOwnerRouteOptions): void {
  const now = opts.now ?? Date.now;
  const calls: number[] = [];
  const stateDir = svc.deps.stateDir;

  app.post(LOCAL_OWNER_PATH, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const notFound = (): void => { res.status(404).json({ error: 'not-found' }); };
    const refuse = (status: number, error: string, detail?: string): void => {
      featureEvidence.recordAtMostEvery(FEATURE, `refused|${error}`, 60_000, { kind: 'held', reason: `local owner device refused: ${error}` });
      res.status(status).json({ error, ...(detail ? { detail } : {}) });
    };
    // 1. Switches.
    if (!isLocalOwnerDeviceEnabled(svc)) { notFound(); return; }
    // 2. Same Mac, before anything touches the ticket: off this Mac it is simply not found.
    const port = Number(svc.deps.config.port);
    const host = sameMacHost(req, port);
    if (!host) { notFound(); return; }
    // 3. Ledger present; rate limit.
    const ledger = svc.keyLedger;
    if (!ledger) { refuse(503, 'ledger-unavailable', 'This agent cannot record new devices right now. Try again after it restarts.'); return; }
    const t = now();
    while (calls.length && t - calls[0] > LOCAL_OWNER_RATE_WINDOW_MS) calls.shift();
    if (calls.length >= LOCAL_OWNER_RATE_LIMIT) { refuse(429, 'rate-limited'); return; }
    calls.push(t);
    // 4. Ticket file.
    const ticket = readLocalOwnerTicket(stateDir);
    if (!ticket) { notFound(); return; }
    if (Date.parse(ticket.expiresAt) <= t) { removeLocalOwnerTicket(stateDir); notFound(); return; }
    // 5. Ticket compare.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const offered = typeof body.ticket === 'string' ? body.ticket : '';
    if (!offered || !sameLocalOwnerTicket(offered, ticket.ticket)) {
      noteLocalOwnerTicketFailure(stateDir, ticket);
      refuse(403, 'bad-ticket');
      return;
    }
    // 6. Proof of the device key.
    const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
    const timeMs = typeof body.timeMs === 'string' ? body.timeMs : typeof body.timeMs === 'number' ? String(body.timeMs) : '';
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) || null : null;
    if (!parseDevicePublicKey(publicKey) || !/^\d{10,16}$/.test(timeMs) || Math.abs(t - Number(timeMs)) > PROOF_WINDOW_MS
      || !verifyP256(publicKey, localOwnerProofMessage(host, publicKey, offered, timeMs), body.proof)) {
      refuse(400, 'proof-invalid', 'The app\'s request could not be checked. Check this Mac\'s clock and try again.');
      return;
    }
    const selfMachineId = svc.deps.selfMachineId ?? null;
    const replaced: string[] = [];
    const answer = (d: Pick<DeviceRecord, 'id' | 'host'>): void => {
      removeLocalOwnerTicket(stateDir);
      featureEvidence.record(FEATURE, { kind: 'fired', reason: 'local owner device enrolled', context: { deviceId: d.id, replaced: replaced.length } });
      if (replaced.length) {
        // Told only once the new key is enrolled, so a failed attempt never reads as "connected".
        svc.deps.raiseAttention?.('This Mac\'s Instar app was connected again', 'The Instar app on this Mac connected to your agent with a new key, and its earlier connection was removed. If you did not just reinstall or reset the app, check this Mac\'s devices in the app.');
      }
      res.status(200).json({ deviceId: d.id, host: d.host, agentName: opts.agentName(), ...(replaced.length ? { replaced } : {}) });
    };
    let devices: DeviceRecord[];
    try { devices = svc.devices.listLocalStrict(); } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.registryRead', err);
      refuse(503, 'registry-unreadable', 'This agent could not read its device list. Nothing was changed.');
      return;
    }
    // 7. Retry of the same enrollment. A revoked key is refused first, whatever the registry says.
    const kh = deviceKeyHashOf(publicKey);
    let rows;
    try { rows = ledger.rows(); } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.keyLedger', err);
      refuse(503, 'ledger-unreadable');
      return;
    }
    if (ledger.keyRevoked(kh) || devices.some((d) => deviceKeyOf(d) === publicKey && d.status === 'revoked')) { refuse(409, 'device-revoked'); return; }
    const mine = devices.find((d) => deviceKeyOf(d) === publicKey && d.localBinding);
    if (mine && mine.status === 'active') { answer(mine); return; }
    const at = new Date(t).toISOString();
    // 7a. Replace (instar install --app-ticket --replace-app-key): this Mac's own app lost its key. The
    // ticket names the earlier devices; each must be bound to THIS machine, and every active owner must
    // be among them. Every check that could refuse the new key runs first, so an owner is never revoked
    // for a key that then can't be enrolled. Revocation is ledger first, then registry (one retry), as
    // the revoke route does. The person is told.
    if (ticket.replaces?.length && DeviceRegistry.hasActiveOwner(devices)) {
      const named = new Set(ticket.replaces);
      const owners = devices.filter((d) => d.status === 'active' && (d.role === undefined || d.role === 'owner'));
      if (!selfMachineId) { removeLocalOwnerTicket(stateDir); refuse(409, 'machine-identity-missing', 'This agent does not know which computer it is on yet, so the earlier app connection cannot be replaced. Restart the agent and try again.'); return; }
      if (!owners.every((d) => named.has(d.id) && d.localBinding?.machineId === selfMachineId)) { removeLocalOwnerTicket(stateDir); refuse(409, 'owner-device-exists'); return; }
      // A held key keeps the ticket (the app may retry with a different key); the two refusals above
      // delete it, because no key can succeed with that ticket on this machine.
      if (svc.devices.holdsKey(publicKey) || rows.some((r) => r.keyHash === kh)) { refuse(409, 'duplicate-key'); return; }
      try {
        for (const d of owners) {
          try { ledger.recordRevocation(d, at); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.keyLedger', err); }
          try { svc.devices.revoke(d.id, at); } catch { svc.devices.revoke(d.id, at); } // @silent-fallback-ok — a second failure is reported below
          svc.confirm.drop(d.id);
          replaced.push(d.id);
        }
        devices = svc.devices.listLocalStrict();
      } catch (err) {
        svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
        refuse(503, 'registry-unreadable', 'This agent could not replace the earlier app connection. Try again with the same ticket.');
        return;
      }
      featureEvidence.record(FEATURE, { kind: 'fired', reason: 'earlier local app key replaced', context: { replaced: replaced.join(',') } });
    }
    const create = (id: string): ReturnType<DeviceRegistry['createActiveLocalOwner']> =>
      svc.devices.createActiveLocalOwner({ id, publicKey, host, label, machineId: selfMachineId, approvedAt: at });
    if (!devices.some((d) => deviceKeyOf(d) === publicKey)) {
      const row = rows.find((r) => r.type === 'activation' && r.keyHash === kh && r.approvedVia === 'local-install' && r.host === host
        && r.machineId === ledger.signerMachineId());
      if (row && row.type === 'activation') {
        // 7(b): the ledger row landed and the registry write did not; rebuild through the same first-owner check.
        let r;
        try { r = create(row.deviceId); } catch (err) {
          svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
          refuse(503, 'registry-unreadable');
          return;
        }
        if (r.ok) { answer(r.device); return; }
        revokeOrphan(svc, row.deviceId, publicKey, host, at);
        refuse(409, r.reason === 'owner-exists' ? 'owner-device-exists' : 'duplicate-key');
        return;
      }
    }
    // 8. First owner only.
    if (DeviceRegistry.hasActiveOwner(devices)) { removeLocalOwnerTicket(stateDir); refuse(409, 'owner-device-exists'); return; }
    // 9. Duplicate key.
    if (svc.devices.holdsKey(publicKey) || rows.some((r) => r.keyHash === kh)) { refuse(409, 'duplicate-key'); return; }
    // Enroll: ledger row first (the durable intent), then one registry write that creates the record active.
    const id = crypto.randomUUID();
    try {
      ledger.recordActivation({ id, publicKey, host } as DeviceRecord, 'local-install', at);
    } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.keyLedger', err);
      refuse(503, 'ledger-unavailable');
      return;
    }
    let r;
    try { r = create(id); } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
      refuse(503, 'registry-unreadable', 'This agent could not save the device. Try again.');
      return;
    }
    if (!r.ok) {
      revokeOrphan(svc, id, publicKey, host, at);
      refuse(409, r.reason === 'owner-exists' ? 'owner-device-exists' : 'duplicate-key');
      return;
    }
    answer(r.device);
  });
}

/** An activation row whose registry write was refused can never be rebuilt later (§A Enroll step 3). */
function revokeOrphan(svc: MobilePairingService, id: string, publicKey: string, host: string, at: string): void {
  try { svc.keyLedger?.recordRevocation({ id, publicKey, host } as DeviceRecord, at); } catch (err) {
    svc.deps.reportDegradation?.('MobilePairing.keyLedger', err);
  }
}

