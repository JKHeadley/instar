import { Router, type Request, type Response } from 'express';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { mayBeLocalArrival } from '../core/requestArrival.js';
import type { startHostedRelayRuntime } from '../hostedRelay/runtimeAdmission.js';
import { hasForwardingHeaders, isLoopbackHost } from './mobileBrowserDevices.js';
import { localBindingOk } from './mobileLocalOwnerDevice.js';
import { mobileOwnerDeviceAdmission } from './mobileOwnerDeviceAdmission.js';
import { deviceAdmissionIdentity, principalOf, type MobilePairingService } from './mobilePairingRoutes.js';

type RelayPairing = Pick<NonNullable<ReturnType<typeof startHostedRelayRuntime>>, 'available' | 'issuePairingCode'>;

function authorize(pairing: MobilePairingService, req: Request, res: Response): (() => boolean) | undefined {
  res.set('Cache-Control', 'no-store');
  if (!mayBeLocalArrival(req) || !isLoopbackPeer(req.socket.remoteAddress)
    || !isLoopbackHost(req.headers.host) || hasForwardingHeaders(req.headers)) {
    res.status(404).end();
    return undefined;
  }
  const principal = principalOf(req);
  const device = deviceAdmissionIdentity(req);
  if (principal.kind !== 'device' || !device) {
    res.status(401).json({ error: 'unauthenticated' });
    return undefined;
  }
  if (device.role !== 'owner') {
    res.status(403).json({ error: 'owner-required' });
    return undefined;
  }
  const admission = mobileOwnerDeviceAdmission(pairing, req);
  const isCurrent = () => {
    const record = admission && pairing.devices.get(admission.deviceId);
    return !!record && admission.isCurrent() && localBindingOk(record, req, pairing.deps.selfMachineId);
  };
  if (!isCurrent()) {
    res.status(401).json({ error: 'unauthenticated' });
    return undefined;
  }
  return isCurrent;
}

/** Mount after signed device middleware. Only the enrolled loopback origin is accepted. */
export function createDesktopRelayPairingRoutes(pairing: MobilePairingService, getRelay: () => RelayPairing | undefined): Router {
  const router = Router();
  router.get('/desktop/relay-pairing/capability', (req, res) => {
    if (!authorize(pairing, req, res)) return;
    res.json({ version: 1, available: getRelay()?.available() === true });
  });
  router.post('/desktop/relay-pairing/issue', async (req, res) => {
    const isCurrent = authorize(pairing, req, res);
    if (!isCurrent) return;
    if (!req.is('application/json') || !req.body || typeof req.body !== 'object'
      || Array.isArray(req.body) || Object.keys(req.body).length) {
      res.status(400).json({ error: 'invalid-request' });
      return;
    }
    const relay = getRelay();
    if (!relay) {
      res.status(409).json({ error: 'relay-unavailable' });
      return;
    }
    try {
      const { code, expiresInSeconds } = await relay.issuePairingCode();
      if (res.destroyed) return;
      if (!isCurrent()) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      res.status(201).json({ code, expiresInSeconds });
    } catch (error) {
      if (res.destroyed) return;
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'relay-unavailable') res.status(409).json({ error: reason });
      else if (reason === 'relay-busy') res.status(429).json({ error: reason });
      else res.status(503).json({ error: 'relay-unreachable' });
    }
  });
  return router;
}
