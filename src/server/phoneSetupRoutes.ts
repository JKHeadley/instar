/**
 * "Add your phone" at the agent's own computer (identity A4; docs/specs/identity-security-piece3e-same-network-first-phone.md §4).
 *
 * The first phone of an agent with no Telegram owner, set up by the owner at the computer:
 *   1. On the local surface (the terminal, the Windows/Linux/Mac app on that computer), the owner
 *      asks to add a phone and passes the fresh check (the dashboard PIN). The same-network listener
 *      opens ("At home only") and one QR code is shown: the pairing link version 2, carrying the
 *      pairing code, the agent's `<name>.local:<port>`, its certificate's public-key hash and the
 *      computer's current addresses as hints.
 *   2. The phone, on the same network, connects, checks the certificate's public-key hash against
 *      the one it scanned, and only then redeems, sending the hash it pinned. It is WAITING, not let
 *      in. The agent issues it a random six-digit number, bound to this setup, this phone's key and
 *      the pinned hash.
 *   3. The owner types that number on the local surface, which names the phone and shows its key.
 *   4. The phone then signs its activation (device-signed, carrying the pinned hash again) within
 *      15 minutes; only then is it let in, with `approvedVia: 'at-computer'`.
 *
 * What this piece lets in is an ordinary owner phone for conversations. It does not make the phone
 * able to approve: the mark and the owner-record entry are piece 3b of the identity build order.
 *
 * Which agents take this route: one with no Telegram owner. With a Telegram owner the setup still
 * starts at the computer (the certificate hash comes from its screen), and the phone's confirmation
 * goes through the private chat as it does today. A Telegram owner that appears during a setup ends it.
 *
 * Only a first phone: while an owner phone is already active on this machine, setup at the
 * computer is refused, and that phone approves new ones as today.
 */
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response, Router } from 'express';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { SAME_NETWORK_PUBLIC_ROUTES, mayBeLocalArrival } from '../core/requestArrival.js';
import { buildPairLink, codeTtlMs, cleanText } from '../core/MobilePairing.js';
import { admittedAtComputer, deviceKeyOf, isBrowserDevice, keyHashOf, type DeviceRecord } from '../core/MobileDeviceKeys.js';
import { createMandatePinCheck, type MandatePinCheck } from './mandatePin.js';
import type { PinAttemptStore } from '../core/PinAttemptStore.js';
import { hasForwardingHeaders } from './mobileBrowserDevices.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { spendCeremonyCredential } from '../core/ceremonyCredential.js';
import { ownMachineId } from '../core/localOwnerTicket.js';
import { sameMacHost } from './mobileLocalOwnerDevice.js';
import { isRequestablePort } from './sameNetworkListener.js';

const FEATURE = 'mobilePairing.phoneSetup';
export const PHONE_SETUP_TTL_MS = 30 * 60_000;
/**
 * After the right number, the phone has this long to sign its activation (r3 security finding 3), and
 * never past its own pending expiry (the device registry's PENDING_TTL_MS from its redeem): the signing
 * window ends at the EARLIER of the two, so a phone is never told it may sign after the registry has
 * already expired it (GPT review 3).
 */
export const PHONE_SETUP_SIGN_WINDOW_MS = 15 * 60_000;
export const PHONE_SETUP_MAX_WRONG_NUMBERS = 3;
/**
 * The signing window closes this long before the phone's pending expiry, so the activation's two writes
 * (the key ledger, then the registry) never straddle the moment the registry expires the phone (GPT review 4).
 */
export const PHONE_SETUP_SIGN_MARGIN_MS = 5_000;
export const ACTIVATE_AT_COMPUTER_PATH = '/mobile/device/activate-at-computer';
export const PAIR_LINK_V2_BASE = 'https://instar.sh/pair';

export type SetupState = 'waiting-phone' | 'waiting-number' | 'number-accepted' | 'sent-to-chat' | 'done' | 'ended';

export interface PhoneSetup {
  id: string;
  createdAt: number;
  expiresAt: number;
  address: 'home' | 'anywhere';
  codeHash: string;
  host: string;
  kind: 'same-network' | 'tailscale' | 'cloudflare';
  spkiHash: string | null;
  approval: 'computer' | 'telegram';
  state: SetupState;
  endedReason?: string;
  deviceId?: string;
  deviceName?: string | null;
  fingerprint?: string | null;
  keyHash?: string;
  /** The waiting phone's pending expiry in the device registry (ms); the signing window never passes it. */
  phoneExpiresAt?: number;
  number?: string;
  wrongNumbers: number;
  acceptedAt?: number;
}

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The last moment the phone may sign its activation: 15 minutes after the number was accepted, or a few
 * seconds before its pending state ends (the registry expires it AT its `expiresAt`), whichever is earlier.
 * The setup itself ends then too, whether or not the phone ever asks again.
 */
export function signDeadline(s: Pick<PhoneSetup, 'acceptedAt' | 'phoneExpiresAt'>): number | null {
  if (s.acceptedAt === undefined) return null;
  const window = s.acceptedAt + PHONE_SETUP_SIGN_WINDOW_MS;
  return s.phoneExpiresAt === undefined ? window : Math.min(window, s.phoneExpiresAt - PHONE_SETUP_SIGN_MARGIN_MS);
}

/** Setups in this process only: a restart voids every waiting phone, as it voids pending devices. */
export class PhoneSetupStore {
  private readonly setups = new Map<string, PhoneSetup>();
  constructor(private readonly now: () => number = Date.now) {}

  create(row: Omit<PhoneSetup, 'id' | 'createdAt' | 'expiresAt' | 'state' | 'wrongNumbers' | 'codeHash'> & { code: string }): PhoneSetup {
    // One setup at a time: a new one ends any still open.
    for (const s of this.setups.values()) if (s.state !== 'done' && s.state !== 'ended' && s.state !== 'sent-to-chat') { s.state = 'ended'; s.endedReason = 'replaced'; }
    const t = this.now();
    const { code, ...rest } = row;
    const s: PhoneSetup = { ...rest, id: crypto.randomUUID(), createdAt: t, expiresAt: t + PHONE_SETUP_TTL_MS, state: 'waiting-phone', wrongNumbers: 0, codeHash: sha(code) };
    this.setups.set(s.id, s);
    this.prune();
    return s;
  }

  get(id: string): PhoneSetup | null {
    const s = this.setups.get(id) ?? null;
    if (s && s.state !== 'done' && s.state !== 'ended' && s.state !== 'sent-to-chat' && this.now() > s.expiresAt) { s.endedReason = s.state === 'number-accepted' ? 'sign-window-passed' : 'expired'; s.state = 'ended'; delete s.number; }
    return s;
  }

  /** The open setup a pairing code was minted for, if any (read before the code is taken). */
  byCode(code: unknown): PhoneSetup | null {
    if (typeof code !== 'string' || code.length > 64) return null;
    const h = sha(code);
    for (const s of this.setups.values()) if (s.codeHash === h) return this.get(s.id);
    return null;
  }

  byDevice(deviceId: string): PhoneSetup | null {
    for (const s of this.setups.values()) if (s.deviceId === deviceId) return this.get(s.id);
    return null;
  }

  /** The phone redeemed: the agent issues its number (random, held here with its bindings). */
  attachPhone(id: string, d: Pick<DeviceRecord, 'id' | 'deviceName' | 'fingerprint'> & { expiresAt?: string }, keyHash: string): string | null {
    const s = this.get(id);
    if (!s || s.state !== 'waiting-phone') return null;
    s.state = 'waiting-number';
    s.deviceId = d.id; s.deviceName = d.deviceName ?? null; s.fingerprint = d.fingerprint ?? null; s.keyHash = keyHash;
    const phoneExpiresAt = d.expiresAt ? Date.parse(d.expiresAt) : NaN;
    if (Number.isFinite(phoneExpiresAt)) s.phoneExpiresAt = phoneExpiresAt;
    s.number = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    return s.number;
  }

  /** The owner typed a number at the computer. */
  typeNumber(id: string, typed: unknown): 'ok' | 'wrong' | 'ended' | 'not-waiting' | 'bad-format' {
    const s = this.get(id);
    if (!s || s.state === 'ended' || s.state === 'done') return 'ended';
    if (s.state !== 'waiting-number' || !s.number) return 'not-waiting';
    const t = typeof typed === 'string' ? typed.replace(/[\s-]/g, '') : '';
    if (!/^\d{6}$/.test(t)) return 'bad-format';
    // The phone's pending state already lapsed: nothing it signs can let it in any more.
    if (s.phoneExpiresAt !== undefined && this.now() > s.phoneExpiresAt - PHONE_SETUP_SIGN_MARGIN_MS) { s.state = 'ended'; s.endedReason = 'phone-expired'; delete s.number; return 'ended'; }
    const a = Buffer.from(sha(t)); const b = Buffer.from(sha(s.number));
    if (crypto.timingSafeEqual(a, b)) {
      s.state = 'number-accepted'; s.acceptedAt = this.now();
      // The setup now lives exactly as long as its signing window (never past the phone's pending expiry),
      // and ends then even if the phone never asks again.
      s.expiresAt = signDeadline(s)!;
      return 'ok';
    }
    s.wrongNumbers += 1;
    if (s.wrongNumbers >= PHONE_SETUP_MAX_WRONG_NUMBERS) { s.state = 'ended'; s.endedReason = 'wrong-numbers'; return 'ended'; }
    return 'wrong';
  }

  /** May this phone be let in now? */
  activation(deviceId: string): { result: 'ok'; setup: PhoneSetup } | { result: 'waiting'; number: string | null } | { result: 'ended'; reason: string } {
    const s = this.byDevice(deviceId);
    if (!s) return { result: 'ended', reason: 'no-setup' };
    if (s.state === 'ended') return { result: 'ended', reason: s.endedReason ?? 'ended' };
    if (s.state === 'done') return { result: 'ended', reason: 'already-done' };
    if (s.state === 'waiting-number') return { result: 'waiting', number: s.number ?? null };
    if (s.state !== 'number-accepted' || s.acceptedAt === undefined) return { result: 'ended', reason: 'not-ready' };
    if (this.now() > signDeadline(s)!) { s.state = 'ended'; s.endedReason = 'sign-window-passed'; return { result: 'ended', reason: 'sign-window-passed' }; }
    return { result: 'ok', setup: s };
  }

  /** With a Telegram owner: the phone redeemed and its confirmation went to the private chat. */
  sentToChat(id: string, deviceId: string): void { const s = this.get(id); if (s && s.state === 'waiting-phone') { s.state = 'sent-to-chat'; s.deviceId = deviceId; } }

  finish(id: string): void { const s = this.setups.get(id); if (s) { s.state = 'done'; delete s.number; } }
  end(id: string, reason: string): void { const s = this.setups.get(id); if (s && s.state !== 'done') { s.state = 'ended'; s.endedReason = reason; delete s.number; } }

  /** Setups still open (not done and not ended). */
  openSetups(): PhoneSetup[] { return [...this.setups.values()].filter((s) => { const g = this.get(s.id); return !!g && g.state !== 'done' && g.state !== 'ended' && g.state !== 'sent-to-chat'; }); }
  anyOpen(): boolean { return this.openSetups().length > 0; }

  /** Is this pending device waiting for a number at the computer? (Its code path is closed.) */
  isAtComputerPending(deviceId: string): boolean {
    const s = this.byDevice(deviceId);
    return !!s && s.approval === 'computer' && (s.state === 'waiting-number' || s.state === 'number-accepted');
  }

  private prune(): void {
    const t = this.now();
    for (const [id, s] of this.setups) if (t - s.createdAt > 24 * 60 * 60_000) this.setups.delete(id);
  }
}

/** The pairing link version 2: shown only as a QR code on the local surface, never sent in any chat. */
export function buildPairLinkV2(p: { host: string; spkiHash: string; code: string; hints: string[]; agentName?: string | null }): string {
  const n = cleanText(p.agentName ?? null, 40);
  const a = p.hints.slice(0, 4).map((h) => encodeURIComponent(h)).join(',');
  return `${PAIR_LINK_V2_BASE}#v=2&h=${encodeURIComponent(p.host)}&k=${p.spkiHash}&c=${p.code}${a ? `&a=${a}` : ''}${n ? `&n=${encodeURIComponent(n)}` : ''}`;
}

/**
 * Is a phone paired on the home address, active or still waiting? A waiting phone counts until the
 * device registry expires it (its list() turns a lapsed pending row into `expired`).
 */
export function homeAddressHasPhone(svc: Pick<MobilePairingService, 'devices'>): boolean {
  return svc.devices.list().some((d) => d.addressKind === 'same-network' && (d.status === 'active' || d.status === 'pending'));
}

/** Does anything use the home address: an open setup, or a phone paired on it that is active or waiting? */
export function homeAddressInUse(svc: Pick<MobilePairingService, 'devices' | 'phoneSetups'>): boolean {
  return svc.phoneSetups.anyOpen() || homeAddressHasPhone(svc);
}

/**
 * Owner devices already let in on this machine: every active owner device except a browser and the app
 * on the agent's own computer (both told apart by fields only the server writes). The client-sent
 * `deviceKind` is display-only and is NOT read here (GPT review 3): a phone that calls itself a computer
 * still counts, and a computer paired by its own code is an owner device that approves new phones.
 */
export function activeOwnerPhones(svc: Pick<MobilePairingService, 'devices'>): DeviceRecord[] {
  return svc.devices.list().filter((d) => d.status === 'active' && !isBrowserDevice(d) && !d.localBinding && (d.role === undefined || d.role === 'owner'));
}

/**
 * The Instar app that the agent's own installer enrolled on THIS computer (A5 condition 2): an active
 * `local-install` computer record bound to this machine's id. A record with no machine id, or one bound
 * to another machine, is not it.
 */
export function creatingAppOnThisMachine(svc: Pick<MobilePairingService, 'devices'>, machineId: string | null): DeviceRecord | null {
  if (!machineId) return null;
  const apps = svc.devices.list().filter((d) => d.status === 'active' && d.approvedVia === 'local-install' && d.deviceKind === 'computer'
    && !!d.localBinding && d.localBinding.machineId === machineId);
  // Exactly one: where more than one could be it, none is taken to be it (A5).
  return apps.length === 1 ? apps[0]! : null;
}

// --- The gate in front of the same-network listener (A4 point 2) -------------------------------

const PUBLIC_ON_LISTENER = SAME_NETWORK_PUBLIC_ROUTES;
/** Headers that carry the agent's token, a local credential, a dashboard session, or a forwarding claim. */
const REFUSED_HEADERS = ['authorization', 'cookie', 'x-instar-step-up', 'x-instar-notify-token', 'x-instar-local-secret', 'x-instar-lifeline-secret', 'x-instar-machine-auth', 'forwarded'];
/**
 * A literal list (an import of the browser-device list would be read before that module finishes loading,
 * through an import cycle): it covers every prefix in FORWARDING_HEADER_PREFIXES, which a unit test checks.
 */
export const SAME_NETWORK_REFUSED_PREFIXES: ReadonlyArray<string> = ['x-forwarded-', 'forwarded', 'x-real-ip', 'true-client-ip', 'cf-', 'cdn-loop', 'tailscale-', 'x-instar-mesh'];
const REFUSED_PREFIXES = SAME_NETWORK_REFUSED_PREFIXES;
/** Never on this listener even for a signed request: the app on the agent's own computer and its key override. */
const NEVER_ON_LISTENER: ReadonlyArray<RegExp> = [/^\/mobile\/local-owner-device$/, /^\/dashboard(\/|$)/, /^\/mobile\/trust\/device-acceptance(\/|$)/];

export interface GateDeps {
  device: (id: string) => DeviceRecord | null;
  /** The device allow-list's own match (DEVICE_ALLOWLIST), injected to keep the import one-way. */
  deviceRoute: (method: string, pathNorm: string) => boolean;
  ownHost: () => string | null;
}

function notFound(res: ServerResponse): false {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'not-found' }));
  return false;
}

/**
 * Returns true to pass the request to the app. Refuses (404, as if no route existed): the
 * dashboard and its PIN unlock; any request carrying the agent's token, a cookie, a step-up proof or
 * a local credential; the route that enrols the app on the agent's own computer; any request for a
 * device bound to that computer, to loopback, or to another address; and anything not listed.
 */
export function sameNetworkGate(deps: GateDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = String(req.url ?? '/');
    const pathOnly = url.split('?')[0] ?? '/';
    const pathNorm = (pathOnly.toLowerCase().replace(/\/+$/, '') || '/');
    const method = String(req.method ?? 'GET').toUpperCase();
    const names = Object.keys(req.headers).map((h) => h.toLowerCase());
    if (names.some((h) => REFUSED_HEADERS.includes(h) || REFUSED_PREFIXES.some((p) => h.startsWith(p)))) return notFound(res);
    if (NEVER_ON_LISTENER.some((re) => re.test(pathNorm))) return notFound(res);
    // A bare health answer, from the gate itself: no version, no machine, no counts.
    if (method === 'GET' && pathNorm === '/health') {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok' }));
      return false;
    }
    const deviceId = req.headers['x-instar-device'];
    if (deviceId === undefined) return PUBLIC_ON_LISTENER.some(([m, re]) => m === method && re.test(pathNorm)) ? true : notFound(res);
    if (typeof deviceId !== 'string') return notFound(res);
    const d = deps.device(deviceId);
    const host = deps.ownHost();
    if (!d || !host || d.localBinding || isBrowserDevice(d) || d.addressKind !== 'same-network' || d.host !== host) return notFound(res);
    if (!deps.deviceRoute(method, pathNorm)) return notFound(res);
    return true;
  };
}

// --- Local-surface routes (bearer, on the main listener, from this computer only) ---------------

/** The request came from this computer: the main listener, a loopback peer, no forwarding header. */
export function fromThisComputer(req: Pick<Request, 'headers' | 'socket'>): boolean {
  return mayBeLocalArrival(req) && isLoopbackPeer(req.socket.remoteAddress) && !hasForwardingHeaders(req.headers as Record<string, unknown>);
}

export interface PhoneSetupRouteDeps {
  pinCheck?: MandatePinCheck;
  /** The dashboard's durable PIN lockout, shared so this route is no second PIN oracle. */
  pinAttemptStore?: () => PinAttemptStore | null;
}

function setupView(s: PhoneSetup): Record<string, unknown> {
  return {
    setupId: s.id, state: s.state, address: s.address, approval: s.approval, expiresAt: new Date(s.expiresAt).toISOString(),
    ...(s.endedReason ? { endedReason: s.endedReason } : {}),
    ...(s.deviceId ? { phone: { deviceId: s.deviceId, name: s.deviceName ?? null, key: s.fingerprint ?? null, nameNote: 'The phone chose this name, so do not rely on it. Check the key matches the one your phone shows.' } } : {}),
    ...(s.state === 'number-accepted' && s.acceptedAt ? { signBy: new Date(signDeadline(s)!).toISOString() } : {}),
  };
}

export function mountPhoneSetupRoutes(router: Router, svc: MobilePairingService, deps: PhoneSetupRouteDeps = {}): void {
  const pinCheck = deps.pinCheck ?? createMandatePinCheck({ dashboardPin: () => svc.deps.config.dashboardPin, pinAttemptStore: () => deps.pinAttemptStore?.() ?? null });
  /** Close the home address when nothing uses it: no setup open and no phone paired on it (closed until asked). */
  const closeIfUnused = async (): Promise<void> => {
    const ln = svc.sameNetwork;
    if (!ln || !ln.status().wanted) return;
    // A phone still waiting on the home address (another setup's, e.g. one sent to the Telegram chat)
    // keeps it open until the registry expires it (GPT review 3). Judged again inside the listener's
    // owner queue, so a setup started while this close waited keeps it open too (GPT review 4).
    if (homeAddressInUse(svc)) return;
    try { await ln.closeIfUnused(() => !homeAddressInUse(svc)); } catch (err) { svc.deps.reportDegradation?.('SameNetworkListener.close', err); } // @silent-fallback-ok — reported through deps.reportDegradation (DegradationReporter in production); the next reconcile closes an unused address
  };
  /** A setup that ended leaves no pending phone behind, and the address closes if unused. */
  const afterEnd = async (s: PhoneSetup): Promise<void> => {
    if (s.deviceId) { try { const d = svc.devices.get(s.deviceId); if (d?.status === 'pending') svc.devices.decline(s.deviceId); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.registryWrite', err); } } // @silent-fallback-ok — reported; an at-computer pending phone has no other way in and lapses on its own
    await closeIfUnused();
  };
  const localOnly = (req: Request, res: Response): boolean => {
    if (!svc.enabled()) { res.status(503).json({ error: 'Phone pairing is off on this agent.' }); return false; }
    if (!fromThisComputer(req)) { res.status(403).json({ error: 'at-the-computer-only', detail: 'A phone is added at the agent\'s own computer.' }); return false; }
    return true;
  };

  router.post('/mobile/phone-setup', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localOnly(req, res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const address = body.address === 'anywhere' ? 'anywhere' : 'home';
    // An asked-for home port (the Windows app checks it is free on Windows first). Checked before
    // anything is spent.
    if (body.port !== undefined && (address !== 'home' || !isRequestablePort(body.port) || body.port === Number(svc.deps.config.port))) {
      res.status(422).json({ error: 'bad-port', detail: 'A port may be asked for the home address only: a whole number from 1024 to 65535 that web browsers allow.' });
      return;
    }
    const askedPort = body.port as number | undefined;
    // Inside WSL: the Windows app says it enforces the network rule itself (needed only in mirrored mode).
    const windowsAppHandlesNetworkRule = body.windowsAppHandlesNetworkRule === true;
    const telegramOwner = svc.approvalPath() === 'telegram';
    // The port may move only while no phone is paired on the home address (its stored host carries the port).
    // Asked fresh each time: here for an early answer, and again inside the listener's serialized open at
    // the moment the port moves, since a phone can pair on the stored port while this request waits (GPT review 3).
    const mayMovePort = (): boolean => !homeAddressHasPhone(svc);
    if (Object.prototype.hasOwnProperty.call(body, 'ceremonyCredential')) {
      // A5: the app on the agent's own computer, with the one-time credential its command made inside
      // the agent's own system, in place of the PIN. Never falls back to the PIN: any refusal here is final.
      const refuse = (status: number, error: string, detail: string): void => {
        featureEvidence.record(FEATURE, { kind: 'held', reason: `ceremony credential refused: ${error}` });
        res.status(status).json({ error, detail });
      };
      // Only where the typed number is the confirmation (A5: "show the code and take the number").
      if (telegramOwner) { refuse(409, 'ceremony-credential-not-for-chat-owner', 'This agent has a Telegram owner chat. Add your phone with your dashboard PIN, and confirm it in that chat.'); return; }
      // The agent's own loopback address and port, exactly, as the app's own enrolment uses.
      if (!sameMacHost(req, Number(svc.deps.config.port))) { refuse(403, 'ceremony-credential-refused', 'This credential works only from the agent\'s own computer.'); return; }
      // The enrolment bound the app to the id the enrolment route uses; the credential was made under the
      // agent's own identity file, which is what the command reads. Each is checked against its own source.
      if (!creatingAppOnThisMachine(svc, svc.deps.selfMachineId ?? ownMachineId(svc.deps.stateDir))) { refuse(403, 'no-app-on-this-computer', 'Only the Instar app that created this agent on this computer can add a phone without the PIN.'); return; }
      if (activeOwnerPhones(svc).length > 0) { refuse(409, 'phone-already-paired', 'This agent already has a phone. To add a different phone here, remove that one first (from the phone itself, or on the dashboard\'s Phones page), then add the new one.'); return; }
      if (!svc.holdsLease()) { refuse(409, 'not-lease-holder', 'Add your first phone at the computer that is serving this agent right now.'); return; }
      // Refusals that can be known now come before the credential is spent.
      if (svc.devices.pairingPaused()) { res.status(429).json({ error: 'pairing-paused' }); return; }
      if (address === 'anywhere' && !svc.pairingOrigin()) { res.status(409).json({ error: 'stable-address-required', detail: 'This agent has no address that works away from home yet. Choose "At home only", or set up Tailscale first.' }); return; }
      if (address === 'home' && !svc.sameNetwork) { res.status(503).json({ error: 'home-address-unavailable', detail: 'This agent cannot open a home address.' }); return; }
      const storedPort = svc.sameNetwork?.status().port ?? null;
      if (address === 'home' && askedPort !== undefined && storedPort !== null && askedPort !== storedPort && !mayMovePort()) {
        res.status(409).json({ error: 'port-fixed', port: storedPort, detail: `A phone is paired on this agent's home address at port ${storedPort}, so its port cannot change. Use port ${storedPort}.` });
        return;
      }
      // Inside WSL, a networking mode the home address cannot open on is known before the credential is spent.
      if (address === 'home') {
        const plan = await svc.sameNetwork!.wslPlan(windowsAppHandlesNetworkRule);
        if (plan && !plan.ok) { res.status(409).json({ error: 'wsl-networking-mode', mode: plan.mode, detail: `The home address stays closed: ${plan.reason}.` }); return; }
      }
      const spent = spendCeremonyCredential(svc.deps.stateDir, body.ceremonyCredential, { scope: 'phone-setup', machineId: ownMachineId(svc.deps.stateDir) });
      if (!spent.ok) { refuse(403, 'ceremony-credential-refused', `This one-time credential cannot be used (${spent.reason}). Make a new one and try again.`); return; }
      featureEvidence.record(FEATURE, { kind: 'fired', reason: 'ceremony credential spent by the app on this computer' });
    } else {
      // The fresh check comes before any code is shown (A4 step 1). With no PIN set, the check is
      // never skipped: the owner sets one first (r3 security finding 6a).
      if (!svc.deps.config.dashboardPin) { res.status(409).json({ error: 'pin-required', detail: 'Set your dashboard PIN first. It is asked for before a phone is added at this computer.' }); return; }
      if (!pinCheck(req, res, { message: 'Type your dashboard PIN to add a phone at this computer.' })) return;
    }
    if (!telegramOwner && activeOwnerPhones(svc).length > 0) {
      res.status(409).json({ error: 'phone-already-paired', detail: 'This agent already has a phone. To add a different phone here, remove that one first (from the phone itself, or on the dashboard\'s Phones page), then add the new one.' });
      return;
    }
    if (!telegramOwner && !svc.holdsLease()) {
      res.status(409).json({ error: 'not-lease-holder', detail: 'Add your first phone at the computer that is serving this agent right now.' });
      return;
    }
    if (svc.devices.pairingPaused()) { res.status(429).json({ error: 'pairing-paused' }); return; }
    let host: string; let kind: PhoneSetup['kind']; let spkiHash: string | null = null; let hints: string[] = [];
    if (address === 'home') {
      const ln = svc.sameNetwork;
      if (!ln) { res.status(503).json({ error: 'home-address-unavailable', detail: 'This agent cannot open a home address.' }); return; }
      const opened = await ln.openForOwner({ ...(askedPort !== undefined ? { port: askedPort, mayMovePort } : {}), windowsAppHandlesNetworkRule });
      if (!opened.ok) { res.status(409).json({ error: opened.reason, detail: opened.detail, ...(opened.port !== undefined ? { port: opened.port } : {}), ...(opened.mode ? { mode: opened.mode } : {}) }); return; }
      const st = opened.status;
      if (!st.host || !st.spkiHash) { res.status(500).json({ error: 'home-address-unavailable' }); return; }
      host = st.host; kind = 'same-network'; spkiHash = st.spkiHash; hints = st.hints.map((h) => `${h}:${st.port}`);
    } else {
      const chosen = svc.pairingOrigin();
      if (!chosen) { res.status(409).json({ error: 'stable-address-required', detail: 'This agent has no address that works away from home yet. Choose "At home only", or set up Tailscale first.' }); return; }
      host = chosen.host; kind = chosen.kind;
    }
    const m = svc.codes.mint(Math.min(codeTtlMs(svc.deps.config.mobilePairing), PHONE_SETUP_TTL_MS), cleanText(body.label) ?? null, svc.deps.config.authToken ?? '', { host, kind }, null, null);
    if (!m.ok) { await closeIfUnused(); res.status(429).json({ error: m.reason }); return; }
    // A new setup replaces an open one: its waiting phone, if any, is declined.
    const replaced = svc.phoneSetups.openSetups();
    const setup = svc.phoneSetups.create({ code: m.code, address, host, kind, spkiHash, approval: telegramOwner ? 'telegram' : 'computer' });
    const link = kind === 'same-network'
      ? buildPairLinkV2({ host, spkiHash: spkiHash!, code: m.code, hints, agentName: svc.deps.config.projectName })
      : buildPairLink(`https://${host}`, m.code, svc.deps.config.projectName);
    for (const old of replaced) await afterEnd(old);
    featureEvidence.record(FEATURE, { kind: 'fired', reason: 'setup started at the computer', context: { address, approval: setup.approval, kind } });
    res.json({
      ...setupView(setup), link, linkVersion: kind === 'same-network' ? 2 : 1,
      address: { kind, host, ...(spkiHash ? { keyHash: spkiHash, hints } : {}) },
      showAs: 'qr',
      say: setup.approval === 'computer'
        ? 'Scan this code with the Instar app on your phone. Your phone will show six digits: type them here.'
        : 'Scan this code with the Instar app on your phone, then confirm the code I send you in Telegram.',
    });
  });

  router.get('/mobile/phone-setup/:id', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localOnly(req, res)) return;
    const s = svc.phoneSetups.get(String(req.params.id));
    if (!s) { res.status(404).json({ error: 'unknown-setup' }); return; }
    res.json(setupView(s));
  });

  router.post('/mobile/phone-setup/:id/number', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localOnly(req, res)) return;
    const s = svc.phoneSetups.get(String(req.params.id));
    if (!s) { res.status(404).json({ error: 'unknown-setup' }); return; }
    if (s.approval !== 'computer') { res.status(409).json({ error: 'confirm-in-telegram' }); return; }
    // The phone's live record, not only the expiry noted at its redeem: a lease move or restart may have
    // expired it since (GPT review 4). A phone no longer waiting ends the setup.
    if (s.deviceId && s.state === 'waiting-number' && svc.devices.get(s.deviceId)?.status !== 'pending') {
      svc.phoneSetups.end(s.id, 'phone-expired');
      await afterEnd(s);
      res.status(409).json({ error: 'setup-ended', reason: 'phone-expired', detail: 'This setup has ended. Start again to add your phone.' });
      return;
    }
    const r = svc.phoneSetups.typeNumber(s.id, (req.body as Record<string, unknown> | undefined)?.number);
    featureEvidence.record(FEATURE, { kind: r === 'ok' ? 'fired' : 'held', reason: `number at the computer: ${r}` });
    if (r === 'ok') { res.json(setupView(s)); return; }
    if (r === 'bad-format') { res.status(422).json({ error: 'bad-format', detail: 'Type the six digits your phone shows.' }); return; }
    if (r === 'wrong') { res.status(403).json({ error: 'wrong-number', detail: 'That is not the number on the phone.', triesLeft: PHONE_SETUP_MAX_WRONG_NUMBERS - s.wrongNumbers }); return; }
    if (r === 'ended') {
      await afterEnd(s);
      res.status(409).json({ error: 'setup-ended', reason: s.endedReason ?? 'ended', detail: 'This setup has ended. Start again to add your phone.' });
      return;
    }
    res.status(409).json({ error: 'no-phone-yet', detail: 'No phone has scanned the code yet.' });
  });

  router.post('/mobile/phone-setup/:id/cancel', async (req: Request, res: Response) => {
    if (!localOnly(req, res)) return;
    const s = svc.phoneSetups.get(String(req.params.id));
    if (!s) { res.status(404).json({ error: 'unknown-setup' }); return; }
    svc.phoneSetups.end(s.id, 'cancelled');
    await afterEnd(s);
    res.json(setupView(s));
  });

  router.get('/mobile/same-network', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localOnly(req, res)) return;
    const ln = svc.sameNetwork;
    // Inside WSL, read the networking mode now, so the app sees it before it opens anything.
    if (ln) await ln.wslPlan(false);
    res.json(ln ? ln.status() : { wanted: false, listening: false, available: false });
  });

  router.post('/mobile/same-network/allow-network', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localOnly(req, res)) return;
    const ln = svc.sameNetwork;
    if (!ln) { res.status(503).json({ error: 'home-address-unavailable' }); return; }
    if (!svc.deps.config.dashboardPin) { res.status(409).json({ error: 'pin-required', detail: 'Set your dashboard PIN first.' }); return; }
    if (!pinCheck(req, res, { message: 'Type your dashboard PIN to allow this network.' })) return;
    const r = await ln.allowCurrentNetwork();
    res.status(r.ok ? 200 : 409).json({ ...r.status, ...(r.detail ? { detail: r.detail } : {}) });
  });

  router.post('/mobile/same-network/close', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localOnly(req, res)) return;
    const ln = svc.sameNetwork;
    if (!ln) { res.status(503).json({ error: 'home-address-unavailable' }); return; }
    await ln.close();
    res.json(ln.status());
  });

  // The waiting phone signs its own activation (A4 step 6), on the address it paired on.
  router.post(ACTIVATE_AT_COMPUTER_PATH, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { res.status(503).json({ error: 'Phone pairing is off on this agent.' }); return; }
    const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
    if (!p || p.kind !== 'device' || !p.deviceId) { res.status(403).json({ error: 'device-signature-required' }); return; }
    const d = svc.devices.get(p.deviceId);
    if (!d) { res.status(404).json({ error: 'unknown-device' }); return; }
    // A retry after the phone was let in answers as the first success did.
    if (d.status === 'active') { res.json({ status: 'active', ...(admittedAtComputer(d) ? { approvedVia: 'at-computer', canApprove: false } : {}) }); return; }
    if (d.status !== 'pending') { res.status(409).json({ error: d.status }); return; }
    const a = svc.phoneSetups.activation(d.id);
    if (a.result === 'waiting') { res.status(409).json({ error: 'waiting-for-number', number: a.number, detail: 'Type this number on the agent\'s computer.' }); return; }
    if (a.result === 'ended') {
      // Nothing can let this phone in any more: decline it now rather than leave it waiting.
      try { svc.devices.decline(d.id); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.registryWrite', err); }
      res.status(409).json({ error: 'setup-ended', reason: a.reason, detail: 'This setup has ended. Scan a new code at the computer.' });
      return;
    }
    const setup = a.setup;
    const end = (status: number, error: string, detail: string): void => {
      svc.phoneSetups.end(setup.id, error);
      try { svc.devices.decline(d.id); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.registryWrite', err); }
      featureEvidence.record(FEATURE, { kind: 'held', reason: `activation refused: ${error}`, context: { deviceId: d.id } });
      res.status(status).json({ error, detail });
      // After the answer is written: closing the listener ends this very connection.
      let closing = false;
      const later = (): void => { if (!closing) { closing = true; void closeIfUnused(); } };
      res.once('finish', later);
      res.once('close', later);
    };
    if (setup.approval !== 'computer') { res.status(409).json({ error: 'confirm-in-telegram' }); return; }
    // A first phone is let in only where the lease is (a lease move already lapses the pending
    // phone; this is the same rule, checked at the moment of admission).
    if (!svc.holdsLease()) { end(409, 'approval-moved', 'This setup moved machines. Start again at the computer that serves this agent.'); return; }
    if (svc.devices.pairingPaused()) { res.status(429).json({ error: 'pairing-paused' }); return; }
    // The pinned hash, signed by the phone's key (the signature covers this body). The protection
    // against a relay is the PHONE's own check before it speaks (anyone on the network can read this
    // hash from a handshake); this server check is defence in depth against a phone-side bug.
    if (setup.kind === 'same-network') {
      const pinned = (req.body as Record<string, unknown> | undefined)?.pinnedKeyHash;
      if (typeof pinned !== 'string' || !setup.spkiHash || pinned !== setup.spkiHash || pinned !== svc.sameNetwork?.spkiHash()) {
        end(409, 'not-this-computer', 'This is not your agent\'s computer.');
        return;
      }
    }
    // Checked again just before the phone is let in (A4 "Which agents take this route").
    if (svc.approvalPath() === 'telegram') { end(409, 'telegram-owner-appeared', 'This agent now has a Telegram owner chat. Add your phone from that chat.'); return; }
    if (activeOwnerPhones(svc).length > 0) { end(409, 'phone-already-paired', 'This agent already has a phone. Approve new phones from that phone.'); return; }
    const key = deviceKeyOf(d);
    if (setup.keyHash && (!key || keyHashOf(key) !== setup.keyHash)) { end(409, 'wrong-device', 'This setup was for another phone.'); return; }
    // Only a phone admitted at the computer is let in this way (the store refuses a mismatch too); checked
    // before the key ledger records anything.
    if (d.admission !== 'at-computer') { end(409, 'not-at-computer', 'This phone was not added at the computer.'); return; } // at-computer-ratchet-ok: the admission field itself is the precondition here
    const approvedAt = new Date().toISOString();
    if (svc.keyLedger) {
      try { svc.keyLedger.recordActivation(d, 'at-computer', approvedAt); } catch (err) {
        svc.deps.reportDegradation?.('MobilePairing.keyLedger', err);
        res.status(500).json({ error: 'Could not record the phone. Try again.' });
        return;
      }
    }
    let after: DeviceRecord | null;
    try { after = svc.devices.applyConfirm(d.id, { ok: true, approvedVia: 'at-computer', approvedAt }); } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
      res.status(500).json({ error: 'Could not record the phone. Try again.' });
      return;
    }
    if (after?.status !== 'active') { res.status(409).json({ error: 'not-pending' }); return; }
    svc.phoneSetups.finish(setup.id);
    svc.noteActivated(d.id);
    try { svc.bindTeamPhones(); } catch (err) { svc.deps.reportDegradation?.('TeamAccess.bind', err); } // @silent-fallback-ok — reported; bound at the next boot
    featureEvidence.record(FEATURE, { kind: 'fired', reason: 'phone let in at the computer', context: { deviceId: d.id, address: setup.address } });
    res.json({ status: 'active', approvedVia: 'at-computer', canApprove: false });
  });
}
