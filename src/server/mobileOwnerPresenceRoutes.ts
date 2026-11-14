/**
 * The owner's phone opens Remote Desktop with Face ID instead of the dashboard PIN, and can show
 * the PIN when a browser asks for it (docs/specs/mobile-owner-presence-pin.md).
 *
 *   POST /mobile/desktop-unlock/challenge   a single-use 60 s challenge for a Remote Desktop unlock
 *   POST /mobile/desktop-unlock             { challenge, presenceSig } → a phone desktop session
 *   POST /mobile/dashboard-pin/challenge    a single-use 60 s challenge for showing the PIN
 *   POST /mobile/dashboard-pin/reveal       { challenge, presenceSig } → { pin, machine }
 *
 * Every route: the switch on, a device-signed request over local TLS (or loopback, which is how the
 * tunnel arrives) from an active OWNER phone, a dashboard PIN set, a presence key enrolled. The
 * unlock and reveal also consume the challenge and verify a Face-ID-gated presence signature over
 * a purpose-specific message. The session minted here is desktop-scoped (PhoneDesktopSessionStore),
 * never the dashboard operator session. Secrets never reach the audit, a log or a notice.
 */
import type { Request, Response, Router } from 'express';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { DASHBOARD_PIN_PLACEHOLDER } from '../core/dashboardPin.js';
import type { InstarConfig } from '../core/types.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { BoundSecretStore, ConsoleTicketAudit, activeOwnerPhone, signedHost, verifyPresenceSignature } from './mobileConsoleTicket.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import type { PhoneDesktopSessionStore } from './PhoneDesktopSessionStore.js';

export const DESKTOP_UNLOCK_CHALLENGE_PATH = '/mobile/desktop-unlock/challenge';
export const DESKTOP_UNLOCK_PATH = '/mobile/desktop-unlock';
export const PIN_REVEAL_CHALLENGE_PATH = '/mobile/dashboard-pin/challenge';
export const PIN_REVEAL_PATH = '/mobile/dashboard-pin/reveal';
export const OWNER_PRESENCE_FEATURE = 'mobilePairing.ownerPresence';
export const DESKTOP_UNLOCK_VERSION = 'instar-desktop-unlock-v1';
export const PIN_REVEAL_VERSION = 'instar-pin-reveal-v1';
/** Repeated reveals on one phone within this window send one notice (spec §2.3). */
export const PIN_NOTICE_WINDOW_MS = 10 * 60_000;

/** `mobilePairing.ownerPresence.enabled`: omitted ⇒ live on a development agent, dark on the fleet. Read live. */
export function isOwnerPresenceEnabled(config: InstarConfig): boolean {
  const mp = config.mobilePairing as { ownerPresence?: { enabled?: boolean } } | undefined;
  return resolveDevAgentGate(mp?.ownerPresence?.enabled, config);
}

/**
 * The PIN exactly as this server's /dashboard/unlock compares it, or null. A placeholder or an
 * unresolved vault reference is never a PIN: it would be shown as one (the 2026-06-06 incident),
 * and a vault value this process doesn't compare against would not open the browser either.
 */
export function revealablePin(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim() === DASHBOARD_PIN_PLACEHOLDER) return null;
  return value;
}

/** The exact bytes the presence key signs for one purpose. The version keeps purposes apart. */
export function ownerPresenceMessage(version: typeof DESKTOP_UNLOCK_VERSION | typeof PIN_REVEAL_VERSION, deviceId: string, host: string, challenge: string): string {
  return `${version}\n${deviceId}\n${host.toLowerCase()}\n${challenge}`;
}

export interface OwnerPresenceDeps {
  pairing: () => MobilePairingService | null;
  config: () => InstarConfig;
  phoneSessions: PhoneDesktopSessionStore;
  /** Applies a pending PIN change to the session stores before a new session is issued. */
  syncPinVersion?: () => void;
  /** The verified name of the machine answering, for "the PIN for Mac Studio". */
  machineName: () => string | null;
  /** Tells the owner the PIN was shown, never what it is; resolves to a message id, or null when nothing went out.
   *  Absent: the owner's private chat, when a Telegram owner is reachable on this machine. */
  notifyOwner?: (text: string) => Promise<unknown>;
  now?: () => number;
}

type Refusal = { status: number; error: string; detail?: string };

export function mountOwnerPresenceRoutes(router: Router, deps: OwnerPresenceDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  // Separate stores: a challenge minted for one purpose can never be spent on the other.
  const desktopChallenges = new BoundSecretStore(now);
  const pinChallenges = new BoundSecretStore(now);
  let audit: ConsoleTicketAudit | null = null;
  const lastNotice = new Map<string, number>();
  const auditOf = (svc: MobilePairingService): ConsoleTicketAudit => {
    audit ??= new ConsoleTicketAudit(svc.deps.stateDir, now, (err) => {
      featureEvidence.record(OWNER_PRESENCE_FEATURE, { kind: 'error', reason: 'audit row not written' });
      svc.deps.reportDegradation?.('MobileOwnerPresence.audit', err);
    }, 'mobile-owner-presence-audit.jsonl');
    return audit;
  };
  const record = (svc: MobilePairingService, row: { event: 'minted' | 'refused'; deviceId?: string | null; reason: string; ticketRef?: string }) => {
    auditOf(svc).record({ event: row.event, ...(row.deviceId ? { deviceId: row.deviceId } : {}), reason: row.reason, ...(row.ticketRef ? { ticketRef: row.ticketRef } : {}) });
  };

  /** Gate steps 1–6 (spec §2.4). Answers and returns null on refusal; every refusal is recorded first. */
  const gate = (req: Request, res: Response, purpose: string): { svc: MobilePairingService; deviceId: string; host: string; presenceKey: string } | null => {
    res.setHeader('Cache-Control', 'no-store');
    const svc = deps.pairing();
    const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
    const deviceId = p && p.kind === 'device' && typeof p.deviceId === 'string' ? p.deviceId : null;
    const refuse = (r: Refusal): null => {
      if (svc) record(svc, { event: 'refused', deviceId, reason: `${purpose}:${r.error}` });
      res.status(r.status).json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}) });
      return null;
    };
    const config = deps.config();
    if (!svc || !svc.enabled() || !isOwnerPresenceEnabled(config)) return refuse({ status: 503, error: 'owner-presence-off', detail: 'Using Face ID here instead of the dashboard PIN is turned off on this agent.' });
    if (!deviceId) return refuse({ status: 403, error: 'device-signature-required' });
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) return refuse({ status: 403, error: 'secure-transport-required' });
    if (!activeOwnerPhone(svc, deviceId)) return refuse({ status: 403, error: 'owner-phone-required' });
    if (!revealablePin(config.dashboardPin)) return refuse({ status: 503, error: 'console-pin-not-set', detail: 'This agent has no dashboard PIN set right now.' });
    const d = svc.devices.get(deviceId);
    if (!d?.presenceKey) return refuse({ status: 409, error: 'presence-key-missing' });
    return { svc, deviceId, host: signedHost(req, svc, deviceId), presenceKey: d.presenceKey };
  };

  /** Gate steps 7–8: the challenge for this purpose, then the presence signature over this purpose's message. */
  const proven = (req: Request, res: Response, g: { svc: MobilePairingService; deviceId: string; host: string; presenceKey: string }, store: BoundSecretStore, version: typeof DESKTOP_UNLOCK_VERSION | typeof PIN_REVEAL_VERSION, purpose: string): string | null => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const c = store.consume(body.challenge);
    if (!c || c.deviceId !== g.deviceId || c.host !== g.host) {
      record(g.svc, { event: 'refused', deviceId: g.deviceId, reason: `${purpose}:challenge-invalid` });
      res.status(401).json({ error: 'challenge-invalid' });
      return null;
    }
    if (!verifyPresenceSignature(g.presenceKey, ownerPresenceMessage(version, g.deviceId, g.host, body.challenge as string), body.presenceSig)) {
      record(g.svc, { event: 'refused', deviceId: g.deviceId, reason: `${purpose}:presence-invalid`, ticketRef: c.ref });
      res.status(401).json({ error: 'presence-invalid' });
      return null;
    }
    return c.ref;
  };

  router.post(DESKTOP_UNLOCK_CHALLENGE_PATH, (req: Request, res: Response) => {
    const g = gate(req, res, 'desktop');
    if (!g) return;
    const c = desktopChallenges.issue(g.deviceId, g.host);
    res.json({ challenge: c.secret, expiresAt: new Date(c.expiresAt).toISOString() });
  });

  router.post(DESKTOP_UNLOCK_PATH, (req: Request, res: Response) => {
    const g = gate(req, res, 'desktop');
    if (!g) return;
    const ref = proven(req, res, g, desktopChallenges, DESKTOP_UNLOCK_VERSION, 'desktop');
    if (!ref) return;
    deps.syncPinVersion?.();
    const s = deps.phoneSessions.issue(g.deviceId);
    record(g.svc, { event: 'minted', deviceId: g.deviceId, reason: 'desktop-unlocked', ticketRef: ref });
    featureEvidence.record(OWNER_PRESENCE_FEATURE, { kind: 'fired', reason: 'desktop-unlocked' });
    // The same field names as /dashboard/unlock's session, so the desktop client is unchanged past this point.
    res.json({ operatorSessionToken: s.token, operatorSessionExpiresAt: s.expiresAtMs });
  });

  router.post(PIN_REVEAL_CHALLENGE_PATH, (req: Request, res: Response) => {
    const g = gate(req, res, 'pin');
    if (!g) return;
    const c = pinChallenges.issue(g.deviceId, g.host);
    res.json({ challenge: c.secret, expiresAt: new Date(c.expiresAt).toISOString() });
  });

  router.post(PIN_REVEAL_PATH, async (req: Request, res: Response) => {
    const g = gate(req, res, 'pin');
    if (!g) return;
    const ref = proven(req, res, g, pinChallenges, PIN_REVEAL_VERSION, 'pin');
    if (!ref) return;
    const pin = revealablePin(deps.config().dashboardPin);
    if (!pin) { record(g.svc, { event: 'refused', deviceId: g.deviceId, reason: 'pin:console-pin-not-set' }); res.status(503).json({ error: 'console-pin-not-set' }); return; }
    // The owner is told before the PIN is shown, wherever a private chat is reachable on this machine (spec §2.3).
    // A send that doesn't go out refuses this reveal (try again). An agent with no private chat at all still shows
    // the PIN, audited and said plainly: asking the agent already discloses it there, so refusing would protect nothing.
    const deps2 = g.svc.deps;
    const reachable = !!deps.notifyOwner || (!!deps2.ownerDM && (deps2.telegramOwnerPresent ? deps2.telegramOwnerPresent() : false));
    const notify: ((text: string) => Promise<unknown>) | null = deps.notifyOwner
      ?? (reachable ? (text: string) => Promise.resolve(deps2.ownerDM!(text, '')) : null);
    const machine = deps.machineName();
    let noticed = false;
    if (!notify) {
      record(g.svc, { event: 'minted', deviceId: g.deviceId, reason: 'pin-no-notice-channel', ticketRef: ref });
    } else if (now() - (lastNotice.get(g.deviceId) ?? -Infinity) < PIN_NOTICE_WINDOW_MS) {
      noticed = true;
      record(g.svc, { event: 'minted', deviceId: g.deviceId, reason: 'pin-notice-covered', ticketRef: ref });
    } else {
      const phone = g.svc.devices.get(g.deviceId)?.deviceName || 'your phone';
      let sent = false;
      try {
        const id = await notify(`Your dashboard PIN${machine ? ` for ${machine}` : ''} was shown in the Instar app on ${phone}. If that wasn't you, change the PIN from the dashboard and remove that phone on the Phones page.`);
        sent = id !== null && id !== undefined && id !== false;
      } catch (err) {
        g.svc.deps.reportDegradation?.('MobileOwnerPresence.notice', err);
      }
      if (!sent) {
        record(g.svc, { event: 'refused', deviceId: g.deviceId, reason: 'pin:notice-failed', ticketRef: ref });
        featureEvidence.record(OWNER_PRESENCE_FEATURE, { kind: 'error', reason: 'reveal notice not delivered' });
        res.status(409).json({ error: 'notice-failed', detail: 'I couldn\'t tell you privately that the PIN is being shown, so I didn\'t show it. Try again.' });
        return;
      }
      lastNotice.set(g.deviceId, now());
      noticed = true;
      record(g.svc, { event: 'minted', deviceId: g.deviceId, reason: 'pin-notice-sent', ticketRef: ref });
    }
    // The send was awaited: re-check everything that could have changed meanwhile before the PIN leaves.
    const after = revealablePin(deps.config().dashboardPin);
    if (!isOwnerPresenceEnabled(deps.config()) || !activeOwnerPhone(g.svc, g.deviceId) || after !== pin) {
      record(g.svc, { event: 'refused', deviceId: g.deviceId, reason: 'pin:changed-while-notifying', ticketRef: ref });
      res.status(409).json({ error: 'changed-while-notifying', detail: 'Something changed while I was telling you. Try again.' });
      return;
    }
    record(g.svc, { event: 'minted', deviceId: g.deviceId, reason: 'pin-revealed', ticketRef: ref });
    featureEvidence.record(OWNER_PRESENCE_FEATURE, { kind: 'fired', reason: 'pin-revealed' });
    res.json({ pin, machine, noticed });
  });
}

/**
 * Caller binding (spec §2.1): before every /desktop route, a presented phone desktop session must come on a
 * request signed by the phone that minted it. A bearer caller or another phone carrying it is refused.
 * A dashboard operator session, or no session, passes through to the route's own check unchanged.
 */
export function mountPhoneSessionBinding(router: Router, sessions: PhoneDesktopSessionStore): void {
  router.use('/desktop', (req: Request, res: Response, next: () => void) => {
    const presented = req.headers['x-instar-operator-session'];
    const owner = typeof presented === 'string' ? sessions.deviceOf(presented) : null;
    if (owner === null) { next(); return; }
    const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
    if (p?.kind === 'device' && p.deviceId === owner) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ error: 'Dashboard operator session required' });
  });
}
