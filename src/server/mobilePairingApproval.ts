/**
 * Approve a waiting phone from an already paired owner phone (docs/specs/mobile-pairing-approve.md §3.4).
 *
 * Device-signed routes on the mobile-pairing router. The same gate as a Face ID permission slip: an
 * active owner phone, over local TLS, with its presence key on file. Each answer carries a
 * single-use challenge bound to this approver, this Host and one exact line naming the waiting phone
 * and its key (the store's composite key). The waiting phone must be held by this machine: a pending pairing lives in the
 * machine-local registry and nothing here is forwarded (spec §6).
 */
import { deviceClientOf } from '../core/deviceClientWording.js';
import type { Request, Response, Router } from 'express';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import type { DeviceRecord } from '../core/MobileDeviceKeys.js';
import { isBrowserDevice } from '../core/MobileDeviceKeys.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { BoundSecretStore, activeOwnerPhone, signedHost, verifyPresenceSignature } from './mobileConsoleTicket.js';
import { approveAnswer, isPairingApproveEnabled, personFields, type MobilePairingService } from './mobilePairingRoutes.js';

export const PAIRING_APPROVE_VERSION = 'instar-pairing-approve-v1';

export type PairingApproveAction = 'approve' | 'decline';

/** The exact line naming the waiting phone: a swapped id or a swapped key can never verify. */
export function pairingApproveLine(action: PairingApproveAction, deviceId: string, fingerprint: string): string {
  return `${action} ${deviceId} ${fingerprint}`;
}

/** The exact bytes the presence key signs for one answer. */
export function pairingApproveMessage(approverDeviceId: string, host: string, challenge: string, line: string): string {
  return `${PAIRING_APPROVE_VERSION}\n${approverDeviceId}\n${host.toLowerCase()}\n${challenge}\n${line}`;
}

const ENDED_DETAIL = 'That phone is no longer waiting: it was paired, declined, or its link expired.';
/** The browser wording of ENDED_DETAIL (dashboard-conversations-browser-device §4.7). */
const ENDED_DETAIL_BROWSER = 'That browser is no longer waiting: it was set up, declined, or its approval window ran out.';
/** A decline that arrives after the approval already started (§4.1): never answered as declined. */
export const ALREADY_APPROVED_DETAIL = 'Already approved — remove it in People > Phones if this wasn\'t you.';

/** The fields a browser record adds (§4.1), read loosely so this file does not depend on their declaration order. */
type BrowserFields = { client?: unknown; setupState?: unknown; activating?: unknown };

export function mountPairingApprovalDeviceRoutes(router: Router, svc: MobilePairingService, now: () => number = Date.now): void {
  const challenges = new BoundSecretStore(now);

  /** Answers and returns null on refusal; every refusal of a real device leaves a trace. */
  const gate = (req: Request, res: Response): string | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled() || !isPairingApproveEnabled(svc.deps.config)) { res.status(503).json({ error: 'pairing-approve-off', detail: 'Approving phones from the app is turned off on this agent.' }); return null; }
    const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
    if (!p || p.kind !== 'device' || typeof p.deviceId !== 'string') { res.status(403).json({ error: 'device-signature-required', detail: 'Only the owner\'s paired phone can do this here.' }); return null; }
    const approver = p.deviceId;
    const refuse = (status: number, error: string): null => {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: `phone approval refused: ${error}`, context: { approver } });
      res.status(status).json({ error });
      return null;
    };
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) return refuse(403, 'secure-transport-required');
    if (!activeOwnerPhone(svc, approver)) return refuse(403, 'owner-phone-required');
    return approver;
  };

  const waitingRow = (id: string): DeviceRecord | null => {
    const d = svc.devices.get(id);
    if (!d || d.status !== 'pending' || !d.fingerprint) return null;
    const b = d as DeviceRecord & BrowserFields;
    // §4.1: a record whose approval already started is not waiting; a browser waits only once its
    // approval message was delivered (`awaiting`), so nothing can approve one still `notifying`.
    if (b.activating) return null;
    if (b.client === 'browser' && b.setupState !== 'awaiting') return null;
    return d;
  };
  const ended = (res: Response, approver: string, target: string): void => {
    featureEvidence.record('mobilePairing', { kind: 'held', reason: 'phone approval refused: pairing-ended', context: { approver, deviceId: target } });
    const client = deviceClientOf(svc.devices.get(target) as (DeviceRecord & BrowserFields) | null | undefined);
    res.status(409).json({ error: 'pairing-ended', detail: client === 'browser' ? ENDED_DETAIL_BROWSER : ENDED_DETAIL });
  };
  /** A pending record whose approval already started (§4.1 "Decline never races an approval"). */
  const alreadyApproving = (id: string): boolean => {
    const d = svc.devices.get(id) as (DeviceRecord & BrowserFields) | null | undefined;
    return !!d && (d.status === 'active' || (d.status === 'pending' && !!d.activating));
  };

  router.get('/mobile/pairing-requests', (req: Request, res: Response) => {
    const approver = gate(req, res);
    if (!approver) return;
    res.json({
      presenceKey: !!svc.devices.get(approver)?.presenceKey,
      waiting: svc.waitingPhones().map((d) => ({
        deviceId: d.id, client: isBrowserDevice(d) ? 'browser' : 'phone', deviceName: d.deviceName, label: d.label, fingerprint: d.fingerprint ?? null, requestedAt: d.pairedAt, expiresAt: d.expiresAt ?? null, canApprove: svc.approvable(d), ...personFields(d, svc),
      })),
    });
  });

  router.post('/mobile/pairing-requests/:id/challenge', (req: Request, res: Response) => {
    const approver = gate(req, res);
    if (!approver) return;
    if (!svc.devices.get(approver)?.presenceKey) { res.status(409).json({ error: 'presence-key-missing' }); return; }
    const action = (req.body as Record<string, unknown> | undefined)?.action;
    if (action !== 'approve' && action !== 'decline') { res.status(400).json({ error: 'bad-action', detail: 'action must be "approve" or "decline".' }); return; }
    const id = String(req.params.id);
    const d = waitingRow(id);
    if (!d) { ended(res, approver, id); return; }
    const c = challenges.issue(`${approver}\n${pairingApproveLine(action, d.id, d.fingerprint!)}`, signedHost(req, svc, approver));
    res.json({ challenge: c.secret, expiresAt: new Date(c.expiresAt).toISOString() });
  });

  /** The challenge (deleted before it is judged) and the presence signature, for one exact line. */
  const proven = (req: Request, res: Response, approver: string, action: PairingApproveAction, d: DeviceRecord): boolean => {
    const key = svc.devices.get(approver)?.presenceKey;
    if (!key) { res.status(409).json({ error: 'presence-key-missing' }); return false; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const line = pairingApproveLine(action, d.id, d.fingerprint!);
    const host = signedHost(req, svc, approver);
    const c = challenges.consume(b.challenge);
    if (!c || c.deviceId !== `${approver}\n${line}` || c.host !== host) {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: 'phone approval refused: challenge-invalid', context: { approver, deviceId: d.id } });
      res.status(401).json({ error: 'challenge-invalid' });
      return false;
    }
    if (!verifyPresenceSignature(key, pairingApproveMessage(approver, host, b.challenge as string, line), b.presenceSig)) {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: 'phone approval refused: presence-invalid', context: { approver, deviceId: d.id } });
      res.status(401).json({ error: 'presence-invalid' });
      return false;
    }
    return true;
  };

  router.post('/mobile/pairing-requests/:id/approve', (req: Request, res: Response) => {
    const approver = gate(req, res);
    if (!approver) return;
    const id = String(req.params.id);
    const d = waitingRow(id);
    if (!d) { ended(res, approver, id); return; }
    if (!proven(req, res, approver, 'approve', d)) return;
    const outcome = svc.approvePending(id, 'owner-phone', { approvedBy: approver });
    if (outcome === 'approved') svc.tellOwnerPhoneApproved(approver, d);
    approveAnswer(res, outcome, id);
  });

  router.post('/mobile/pairing-requests/:id/decline', (req: Request, res: Response) => {
    const approver = gate(req, res);
    if (!approver) return;
    const id = String(req.params.id);
    const d = waitingRow(id);
    if (!d) {
      if (alreadyApproving(id)) { res.status(409).json({ error: 'already-approved', detail: ALREADY_APPROVED_DETAIL }); return; }
      ended(res, approver, id);
      return;
    }
    if (!proven(req, res, approver, 'decline', d)) return;
    // The decline is one synchronous registry write; when an approval wrote first it reports so
    // (DeviceRegistry.decline → 'already-approved') and this answer is never `declined: true`.
    const r: unknown = svc.declinePending(id);
    if (r === 'already-approved' || alreadyApproving(id)) { res.status(409).json({ error: 'already-approved', detail: ALREADY_APPROVED_DETAIL }); return; }
    featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'declined by owner phone', context: { approver, deviceId: id } });
    res.json({ declined: true });
  });
}
