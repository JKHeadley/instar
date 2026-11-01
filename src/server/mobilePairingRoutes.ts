/**
 * Mobile pairing links (docs/specs/mobile-pairing-link.md).
 *
 * Device keys (docs/specs/mobile-device-keys.md): redeem registers the phone's Secure Enclave
 * public key as a PENDING device and sends a 6-digit code only to the owner's private Telegram
 * chat; the phone confirms with that code (device-signed) and from then on signs allowlisted
 * requests. Redeem never returns the API token.
 *
 * Public (registered before the bearer gate, each by an exact path+method):
 *   POST /mobile/pairing-codes/redeem   one-time code + device public key → a pending device
 *   GET  /mobile/pairing-codes/ping     self-probe answer: sha256(processSecret + nonce)
 * Bearer:
 *   POST /mobile/pairing-codes          mint a code + the v1 instar.sh link
 *   GET  /mobile/devices                the paired-phones log (scope=pool merges machines)
 *
 * Every route answers 503 while the feature gate (mobilePairing.enabled, dev-agent gated)
 * resolves off; the gate is read live from config.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response, type Application } from 'express';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import {
  PairingCodeStore, NONCE_PATTERN, buildPairLink, cleanText, codeTtlMs, pingAnswer, stableOrigin,
  type MobilePairingConfig,
} from '../core/MobilePairing.js';
import type { InstarConfig } from '../core/types.js';
import {
  ConfirmationCodes, DeviceRegistry, ReplayGuard, parseDevicePublicKey, verifyDeviceRequest,
  type DeviceRecord, type DeviceStatus,
} from '../core/MobileDeviceKeys.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import type { RouteContext } from './routes.js';
import { MobileChatRequestStore, payloadHash, requestIdAgeOk, requestIdTime } from '../core/MobileChatRequests.js';
import { detectOutboundCredential } from '../messaging/outbound-credential-guard.js';
import { PairingInviteTelegram } from '../threadline/PairingInviteTelegram.js';
import { APP_CONVERSATION_KEY_PATTERN } from '../core/appConversationText.js';

export const MOBILE_REDEEM_PATH = '/mobile/pairing-codes/redeem';
export const MOBILE_PING_PATH = '/mobile/pairing-codes/ping';
const PROBES = 8;
const PROBE_TIMEOUT_MS = 4000;
const PING_LIMIT_PER_MIN = 60;
const SELF_NONCE_TTL_MS = 60_000;

/** The slice of the tunnel manager these routes read. */
export interface PairingTunnelView {
  lifecycleState: { lastState: string; activeProvider: string | null };
}

/** Another machine of this agent, from the machine registry. */
export interface PairingSiblingView { machineId: string; name?: string; status?: string; lastKnownUrl?: string }

export interface MobilePairingDeps {
  config: InstarConfig;
  stateDir: string;
  tunnel?: () => PairingTunnelView | undefined;
  selfMachineId?: string | null;
  siblings?: () => PairingSiblingView[];
  /** Probe our own stable origin; injectable for tests. */
  fetchFn?: typeof fetch;
  /** Send the confirmation code to the owner's private chat with a Decline button; resolves to the Telegram message id, or null. */
  ownerDM?: (text: string, declineData: string) => Promise<number | null>;
  /** Whether this machine holds the serving lease (single machine: true). */
  holdsLease?: () => boolean;
  /** Raise one attention item (pairing paused by wrong codes). */
  raiseAttention?: (title: string, body: string) => void;
  reportDegradation?: (what: string, err: unknown) => void;
}

type PoolCtx = Pick<RouteContext, 'config' | 'resolvePeerUrls' | 'recordRopeResult'> & Partial<Pick<RouteContext, 'mobileInbound' | 'telegram'>>;
const PEER_TIMEOUT_MS = 5000;
const MAX_PEER_BYTES = 128 * 1024;

/** Re-validate a peer's device row: fixed fields only, text re-cleaned, untrusted data. */
function sanitizePeerDevice(raw: unknown, machineId: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || typeof d.pairedAt !== 'string' || Number.isNaN(Date.parse(d.pairedAt))) return null;
  return { id: d.id.slice(0, 64), deviceName: cleanText(d.deviceName), pairedAt: new Date(Date.parse(d.pairedAt)).toISOString(), label: cleanText(d.label), machine: machineId };
}

async function fetchPoolDevices(ctx: PoolCtx): Promise<{ rows: Array<Record<string, unknown>>; failed: Array<{ machineId: string; reason: string }> }> {
  const rows: Array<Record<string, unknown>> = [];
  const failed: Array<{ machineId: string; reason: string }> = [];
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  await Promise.all(peers.map(async (p) => {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) { failed.push({ machineId: p.machineId, reason: 'omitted-cap' }); return; }
    try {
      const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, '/mobile/devices', {
        headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!r.ok) { failed.push({ machineId: p.machineId, reason: r.status === 503 ? 'off' : `http-${r.status}` }); return; }
      const text = await r.text();
      if (Buffer.byteLength(text) > MAX_PEER_BYTES) { failed.push({ machineId: p.machineId, reason: 'too-large' }); return; }
      const body = JSON.parse(text) as { devices?: unknown };
      for (const raw of Array.isArray(body.devices) ? body.devices.slice(0, 200) : []) {
        const row = sanitizePeerDevice(raw, p.machineId);
        if (row) rows.push(row);
      }
    } catch (err) { // @silent-fallback-ok — the failure is a visible pool.failed row naming the machine
      failed.push({ machineId: p.machineId, reason: err instanceof Error && err.name === 'TimeoutError' ? 'deadline' : 'unreachable' });
    }
  }));
  return { rows, failed };
}

export function isMobilePairingEnabled(config: InstarConfig): boolean {
  return resolveDevAgentGate(config.mobilePairing?.enabled, config);
}

/** `mobilePairing.chat.enabled`, omitted ⇒ follows mobilePairing. Read live. */
export function isMobileChatEnabled(config: InstarConfig): boolean {
  if (!isMobilePairingEnabled(config)) return false;
  return config.mobilePairing?.chat?.enabled !== false;
}

/**
 * `mobilePairing.native.enabled` (docs/specs/mobile-native-conversations.md): omitted ⇒ the
 * development-agent gate; requires mobilePairing itself. Read ONCE at boot by AgentServer.
 */
export function isMobileNativeEnabled(config: InstarConfig): boolean {
  if (!isMobilePairingEnabled(config)) return false;
  return resolveDevAgentGate(config.mobilePairing?.native?.enabled, config);
}

export class MobilePairingService {
  /** Native app conversations resolved on at boot (set by AgentServer). Gates the send-route rate move. */
  nativeOn = false;
  readonly codes: PairingCodeStore;
  readonly devices: DeviceRegistry;
  readonly confirm: ConfirmationCodes;
  readonly replay: ReplayGuard;
  /** Decline-button nonce → device id (process memory). */
  readonly declineNonces = new Map<string, string>();
  private selfNonces = new Map<string, number>();
  private pingTimes: number[] = [];
  private deviceRate = new Map<string, number[]>();

  constructor(readonly deps: MobilePairingDeps, now: () => number = Date.now) {
    this.codes = new PairingCodeStore(now);
    this.devices = new DeviceRegistry(deps.stateDir, now);
    this.confirm = new ConfirmationCodes(now);
    this.replay = new ReplayGuard(now);
    this.now = now;
    // The confirmation-code key is per process: any device still pending from before
    // this boot can never be confirmed, so it is expired now (spec 2.2, Restarts).
    try { this.devices.expireAllPending(); } catch (err) { deps.reportDegradation?.('MobilePairing.bootExpiry', err); } // @silent-fallback-ok — reported through DegradationReporter
    // Lease watch (spec 2.2, Lease changes): the moment this machine is seen without the
    // serving lease, every live code is voided and pending devices expire, so a code issued
    // before a lease move can never confirm after the lease comes back.
    this.leaseTimer = setInterval(() => this.leaseTick(), 5_000);
    this.leaseTimer.unref?.();
  }
  private leaseTimer: ReturnType<typeof setInterval> | null = null;

  leaseTick(): void {
    this.confirm.prune();
    for (const [n, id] of this.declineNonces) { const d = this.devices.get(id); if (!d || d.status !== 'pending') this.declineNonces.delete(n); }
    if (!this.enabled() || this.holdsLease()) return;
    this.confirm.clearAll();
    this.declineNonces.clear();
    try { this.devices.expireAllPending(); } catch (err) { this.deps.reportDegradation?.('MobilePairing.leaseExpiry', err); } // @silent-fallback-ok — reported through DegradationReporter
  }

  stop(): void { if (this.leaseTimer) clearInterval(this.leaseTimer); this.leaseTimer = null; }

  holdsLease(): boolean { return this.deps.holdsLease?.() ?? true; }

  /**
   * The ONE request-id store for every app mutation on this machine (Telegram chat route and the
   * native conversation routes share it: two instances over the same file would overwrite each
   * other's records). Lazily created; `useChatRequests` installs one constructed elsewhere.
   */
  private chatRequestStore: MobileChatRequestStore | null = null;
  private chatRequestStoreError = false;
  chatRequests(): MobileChatRequestStore | null {
    if (this.chatRequestStore || this.chatRequestStoreError) return this.chatRequestStore;
    try { this.chatRequestStore = new MobileChatRequestStore(this.deps.stateDir); } catch (err) {
      this.chatRequestStoreError = true;
      this.deps.reportDegradation?.('MobileChat.requestStore', err);
    }
    return this.chatRequestStore;
  }
  useChatRequests(store: MobileChatRequestStore): void { this.chatRequestStore = store; this.chatRequestStoreError = false; }

  /** 120 device requests per minute per device. */
  deviceRateOk(deviceId: string): boolean {
    const t = this.now();
    const arr = (this.deviceRate.get(deviceId) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= 120) { this.deviceRate.set(deviceId, arr); return false; }
    arr.push(t); this.deviceRate.set(deviceId, arr);
    return true;
  }

  /** Inbound Telegram text: void any pending device whose live code appears in it. */
  scanInbound(text: unknown): string[] {
    if (typeof text !== 'string' || !this.enabled()) return [];
    const hits = this.confirm.leakedIn(text);
    for (const id of hits) {
      this.confirm.drop(id);
      try { this.devices.decline(id); } catch (err) { this.deps.reportDegradation?.('MobilePairing.leakDecline', err); }
      void this.deps.ownerDM?.('A pairing code was sent in a conversation, so I cancelled that pairing. Codes only go into the Instar app. Ask me for a new link if you were pairing a phone.', '');
    }
    return hits;
  }

  /** The owner's Decline button. */
  declineByNonce(nonce: string): 'declined' | 'unknown' {
    const id = this.declineNonces.get(nonce);
    if (!id) return 'unknown';
    this.declineNonces.delete(nonce);
    this.confirm.drop(id);
    try { this.devices.decline(id); } catch (err) { // @silent-fallback-ok — reported through DegradationReporter
      // The code is already gone, so the device can never confirm; it expires on its own.
      this.deps.reportDegradation?.('MobilePairing.declineWrite', err);
    }
    return 'declined';
  }
  private now: () => number;

  enabled(): boolean { return isMobilePairingEnabled(this.deps.config); }
  private cfg(): MobilePairingConfig | undefined { return this.deps.config.mobilePairing; }
  origin(): string | null { return stableOrigin(this.deps.config.tunnel as { type?: string; hostname?: string } | undefined); }

  namedTunnelActive(): boolean {
    const t = this.deps.tunnel?.();
    if (!t) return false;
    const l = t.lifecycleState;
    return l.lastState === 'active' && l.activeProvider === 'cloudflare-named';
  }

  /** Answer a ping. Self-issued nonces bypass the public budget. */
  ping(nonce: unknown): { status: number; body: Record<string, unknown> } {
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return { status: 400, body: { error: 'bad nonce' } };
    const t = this.now();
    for (const [n, at] of this.selfNonces) if (t - at > SELF_NONCE_TTL_MS) this.selfNonces.delete(n);
    if (this.selfNonces.has(nonce)) {
      this.selfNonces.delete(nonce);
    } else {
      this.pingTimes = this.pingTimes.filter((p) => t - p < 60_000);
      if (this.pingTimes.length >= PING_LIMIT_PER_MIN) return { status: 429, body: { error: 'too-many-requests' } };
      this.pingTimes.push(t);
    }
    return { status: 200, body: { h: pingAnswer(nonce) } };
  }

  /** The deterministic registry check, then eight self-probes. */
  async verifySoleServer(origin: string): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
    const host = new URL(origin).host;
    for (const m of this.deps.siblings?.() ?? []) {
      if (m.machineId === this.deps.selfMachineId || (m.status && m.status !== 'active') || !m.lastKnownUrl) continue;
      try {
        if (new URL(m.lastKnownUrl).host === host) {
          return { ok: false, error: 'not-the-tunnel-machine', detail: `Another of this agent's machines (${m.name ?? 'unnamed'}) also uses ${host}. Pairing needs that address served by one machine.` };
        }
      } catch { /* @silent-fallback-ok — an unparseable registry URL cannot match our host */ }
    }
    const f = this.deps.fetchFn ?? fetch;
    for (let i = 0; i < PROBES; i++) {
      const nonce = crypto.randomBytes(18).toString('base64url');
      this.selfNonces.set(nonce, this.now());
      let answer: unknown;
      try {
        const r = await f(`${origin}${MOBILE_PING_PATH}?n=${nonce}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' } as RequestInit);
        if (!r.ok) return { ok: false, error: 'address-unverified', detail: `Checking ${host} got an HTTP ${r.status} answer, so I could not confirm this machine serves it.` };
        answer = ((await r.json()) as { h?: unknown }).h;
      } catch (err) { // @silent-fallback-ok — not silent: the mint is refused 409 naming the unreachable address
        return { ok: false, error: 'address-unverified', detail: `Could not reach ${host} to confirm this machine serves it (${err instanceof Error ? err.name : 'error'}).` };
      }
      if (answer !== pingAnswer(nonce)) {
        return { ok: false, error: 'not-the-tunnel-machine', detail: `Another process answered on ${host}. Pairing needs that address served by this machine alone.` };
      }
    }
    return { ok: true };
  }
}

const json503 = (res: Response) => res.status(503).json({ error: 'Mobile pairing is turned off on this agent.' });

/** Public routes: registered on the app BEFORE the bearer middleware. */
export function mountPublicMobilePairingRoutes(app: Application, svc: MobilePairingService): void {
  app.get(MOBILE_PING_PATH, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const r = svc.ping(req.query.n);
    res.status(r.status).json(r.body);
  });

  app.post(MOBILE_REDEEM_PATH, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const token = svc.deps.config.authToken;
    if (!token) { res.status(503).json({ error: 'Pairing is not available yet. Try again shortly.' }); return; }
    const origin = svc.origin();
    const hostOk = !!origin && typeof req.headers.host === 'string' && req.headers.host.toLowerCase() === new URL(origin).host;
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto']) || !hostOk || !svc.namedTunnelActive()) {
      res.status(403).json({ error: 'Pairing only works over this agent\'s secure address.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publicKey = typeof body.devicePublicKey === 'string' ? body.devicePublicKey : '';
    if (!parseDevicePublicKey(publicKey)) { res.status(400).json({ error: 'A valid device public key is required.' }); return; }
    if (!svc.deps.ownerDM || !svc.holdsLease()) {
      res.status(409).json({ error: 'approval-unavailable', detail: 'This agent cannot send you the confirmation code right now (no Telegram owner chat on this machine).' });
      return;
    }
    if (svc.devices.pairingPaused()) { res.status(429).json({ error: 'pairing-paused' }); return; }
    // Take-and-delete happens synchronously inside redeem(), before any async work.
    const r = svc.codes.redeem(body.code, token);
    if (!r.ok) {
      if (r.reason === 'too-many-attempts') { res.status(429).json({ error: 'too-many-attempts' }); return; }
      res.status(403).json({ error: 'That link has expired or was already used.' });
      return;
    }
    let created: ReturnType<DeviceRegistry['createPending']>;
    try {
      created = svc.devices.createPending({ deviceName: cleanText(body.deviceName), label: r.label, publicKey, host: new URL(origin!).host });
    } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
      res.status(500).json({ error: 'Could not record the device. Ask for a new link.' });
      return;
    }
    if (!created.ok) {
      const status = created.reason === 'duplicate-key' ? 409 : 429;
      res.status(status).json({ error: created.reason });
      return;
    }
    const device = created.device;
    const code = svc.confirm.issue(device.id, Date.parse(device.expiresAt!));
    const nonce = crypto.randomBytes(12).toString('hex');
    svc.declineNonces.set(nonce, device.id);
    const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;
    const text = [
      `Your code to pair a phone with ${svc.deps.config.projectName} is ${pretty}.`,
      `Type it into the Instar app only if you are pairing a phone right now. If you did not start this, tap Decline. Don't send or show this message to anyone, including me.`,
      `Phone name: ${device.deviceName ?? '(none given)'}`,
    ].join('\n\n');
    let delivered: number | null = null;
    try {
      delivered = await Promise.race([
        svc.deps.ownerDM(text, `md:d:${nonce}`),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
    } catch { delivered = null; } // @silent-fallback-ok — treated as not delivered: the pending device is removed and the caller gets 409
    if (!delivered) {
      svc.confirm.drop(device.id);
      svc.declineNonces.delete(nonce);
      try { svc.devices.remove(device.id); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.registryWrite', err); }
      res.status(409).json({ error: 'approval-unavailable', detail: 'I could not send you the confirmation code in Telegram. Open a private chat with the bot and send it any message, then ask me for a new link.' });
      return;
    }
    res.json({ deviceId: device.id, agentName: svc.deps.config.projectName, status: 'pending' });
  });
}

/** Bearer routes: mounted on the authenticated router. */
export function createMobilePairingRouter(svc: MobilePairingService, deps: MobilePairingDeps, poolCtx?: PoolCtx): Router {
  const router = Router();

  router.post('/mobile/pairing-codes', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const t = deps.config.tunnel as { type?: string; hostname?: string } | undefined;
    if (t?.type === 'named' && !t.hostname) {
      res.status(409).json({ error: 'stable-address-required', detail: 'The named tunnel has no configured hostname.' });
      return;
    }
    const origin = svc.origin();
    if (!origin || !svc.namedTunnelActive()) {
      res.status(409).json({ error: 'stable-address-required', detail: 'The phone app needs a permanent address: a named tunnel with a hostname, currently running on this machine.' });
      return;
    }
    const sole = await svc.verifySoleServer(origin);
    if (!sole.ok) { res.status(409).json({ error: sole.error, detail: sole.detail }); return; }
    const label = cleanText((req.body as Record<string, unknown> | undefined)?.label);
    const m = svc.codes.mint(codeTtlMs(deps.config.mobilePairing), label, deps.config.authToken ?? '');
    if (!m.ok) { res.status(429).json({ error: m.reason }); return; }
    res.json({ code: m.code, expiresAt: new Date(m.expiresAt).toISOString(), link: buildPairLink(origin, m.code, deps.config.projectName) });
  });

  router.get('/mobile/devices', async (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const machine = deps.selfMachineId ?? null;
    const local = svc.devices.list().map((d) => publicDeviceView(d, machine));
    if (req.query.scope !== 'pool' || !poolCtx) { res.json({ devices: local }); return; }
    const pool = await fetchPoolDevices(poolCtx);
    const devices = [...local, ...pool.rows].sort((a, b) => String(b.pairedAt).localeCompare(String(a.pairedAt)));
    res.json({ devices, pool: { failed: pool.failed } });
  });

  // Device's own status (device-signed; any non-revoked status).
  router.get('/mobile/device', (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'device-signature-required' }); return; }
    const d = svc.devices.get(p.deviceId);
    if (!d) { res.status(404).json({ error: 'unknown-device' }); return; }
    res.json({ status: d.status, deviceName: d.deviceName, approvedAt: d.approvedAt ?? null });
  });

  // Confirm with the code from the owner's private chat (device-signed; pending or active).
  router.post('/mobile/device/confirm', (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'device-signature-required' }); return; }
    const d = svc.devices.get(p.deviceId);
    if (!d) { res.status(404).json({ error: 'unknown-device' }); return; }
    if (d.status === 'active') { res.json({ status: 'active' }); return; }
    if (d.status !== 'pending') { res.status(409).json({ error: d.status }); return; }
    if (!svc.holdsLease()) {
      try { svc.devices.expireAllPending(); } catch (err) { deps.reportDegradation?.('MobilePairing.registryWrite', err); }
      res.status(409).json({ error: 'approval-moved', detail: 'This pairing moved machines. Ask for a new link.' });
      return;
    }
    if (svc.devices.pairingPaused()) { res.status(429).json({ error: 'pairing-paused' }); return; }
    const check = svc.confirm.check(d.id, (req.body as Record<string, unknown> | undefined)?.code);
    if (check.result === 'none') { res.status(409).json({ error: 'expired' }); return; }
    let after: DeviceRecord | null;
    try {
      after = svc.devices.applyConfirm(d.id, check.result === 'ok' ? { ok: true } : { ok: false, wrongHmac: check.hmac });
    } catch (err) {
      deps.reportDegradation?.('MobilePairing.registryWrite', err);
      res.status(500).json({ error: 'Could not record the confirmation. Try again.' });
      return;
    }
    if (check.result === 'ok') {
      svc.confirm.drop(d.id); // consumed only after the activation was written
      for (const [n, id] of svc.declineNonces) if (id === d.id) svc.declineNonces.delete(n);
      res.json({ status: 'active' });
      return;
    }
    if (svc.devices.pairingPaused()) {
      deps.raiseAttention?.('Phone pairing paused', 'Ten wrong pairing codes were entered in the last 24 hours, so phone pairing is paused for now. If you were not pairing a phone, someone may be guessing.');
    }
    if (after?.status === 'declined') {
      svc.confirm.drop(d.id);
      void deps.ownerDM?.('Three wrong codes were typed for a phone pairing, so I cancelled it. If that was you, ask me for a new link. If not, someone may have your pairing link.', '');
      res.status(409).json({ error: 'declined' });
      return;
    }
    res.status(403).json({ error: 'wrong-code' });
  });

  // Revoke: bearer may revoke any device; a device only itself.
  router.post('/mobile/devices/:id/revoke', async (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const id = String(req.params.id);
    const p = principalOf(req);
    if (p.kind === 'device' && p.deviceId !== id) { res.status(403).json({ error: 'a device may only revoke itself' }); return; }
    let held: boolean;
    try { held = svc.devices.revoke(id); } catch (err) {
      deps.reportDegradation?.('MobilePairing.registryWrite', err);
      res.status(500).json({ error: 'Could not record the revocation. Try again.' });
      return;
    }
    if (held) { svc.confirm.drop(id); res.json({ revoked: true, machine: deps.selfMachineId ?? null }); return; }
    if (p.kind === 'device' || !poolCtx) { res.status(404).json({ error: 'unknown-device' }); return; }
    const r = await forwardRevoke(poolCtx, id);
    if (r.confirmedBy) { res.json({ revoked: true, machine: r.confirmedBy }); return; }
    res.status(202).json({ pending: true, detail: 'No machine holding this phone confirmed yet. Until one does, the phone may still have access. Revoke it on the machine that serves its address for an immediate effect.' });
  });

  // ── Native operator chat (docs/specs/mobile-operator-chat.md) ──
  // Order: authenticate → look up → preflight → reserve → core → mirror.
  const chatRate = new Map<string, number[]>();
  const chatStoreOf = (): MobileChatRequestStore | null => svc.chatRequests();
  router.post('/mobile/chat/:topicId', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'operator-device-required' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const topicId = Number(req.params.topicId);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const requestId = body.requestId;
    if (!Number.isSafeInteger(topicId) || topicId <= 0) { res.status(400).json({ error: 'bad-topic' }); return; }
    if (text.length < 1 || text.length > 4000) { res.status(400).json({ error: 'text must be 1-4000 characters' }); return; }
    if (typeof requestId !== 'string' || requestIdTime(requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return; }
    const store = chatStoreOf();
    if (!store) { res.status(503).json({ error: 'chat-unavailable', detail: 'The message record could not be read on this machine.' }); return; }
    const hash = payloadHash(topicId, text);
    const answer = (l: ReturnType<MobileChatRequestStore['lookup']>): boolean => {
      if (l.kind === 'done') { res.status(l.status).json(l.body); return true; }
      if (l.kind === 'in-progress') { res.status(202).json({ state: 'in-progress' }); return true; }
      if (l.kind === 'outcome-unknown') { res.status(409).json({ error: 'outcome-unknown', detail: 'This message may or may not have reached the agent. Check the conversation.' }); return true; }
      if (l.kind === 'request-id-reused') { res.status(409).json({ error: 'request-id-reused' }); return true; }
      return false;
    };
    // A request already on record gets its recorded answer, whatever the checks below say now.
    if (answer(store.lookup(p.deviceId, requestId, hash))) return;

    // Preflight: no effect on any session or history.
    if (!isMobileChatEnabled(deps.config)) { res.status(503).json({ error: 'Chat from the app is turned off on this agent.' }); return; }
    const tg = poolCtx?.telegram;
    const ingest = poolCtx?.mobileInbound?.ingest;
    const ownerId = tg?.getOwnerUserId?.();
    if (!tg || !ingest || !ownerId) { res.status(503).json({ error: 'chat-unavailable', detail: 'This agent has no Telegram owner to speak as.' }); return; }
    if (!svc.holdsLease()) { res.status(409).json({ error: 'not-serving', detail: 'This machine is not receiving messages right now. Try again shortly or use Telegram.' }); return; }
    const t = Date.now();
    const recent = (chatRate.get(p.deviceId) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= 20) { chatRate.set(p.deviceId, recent); res.status(429).json({ error: 'too-many-requests' }); return; }
    recent.push(t); chatRate.set(p.deviceId, recent);
    if (!tg.getAllTopicMappings().some((m) => m.topicId === topicId)) { res.status(404).json({ error: 'unknown-topic' }); return; }
    if (!requestIdAgeOk(requestId, t)) { res.status(400).json({ error: 'request-id-too-old' }); return; }
    svc.scanInbound(text); // may cancel a pending pairing; never refuses the message
    if (PairingInviteTelegram.carriesInvite(text) || /^\/desktop(?:\s|$)/i.test(text)) { res.status(422).json({ error: 'not-from-the-app' }); return; }
    if (detectOutboundCredential(text).detected) {
      res.status(422).json({ error: 'credential-refused', detail: 'This looks like a password or key, so it was not sent. Use a Secret Drop link for secrets.' });
      return;
    }

    // Reserve (synchronous with the decisive lookup).
    let r: ReturnType<MobileChatRequestStore['reserve']>;
    try { r = store.reserve(p.deviceId, requestId, hash, topicId); } catch (err) {
      deps.reportDegradation?.('MobileChat.requestStore', err);
      res.status(503).json({ error: 'chat-unavailable', detail: 'The message could not be recorded, so it was not sent. Try again.' });
      return;
    }
    if (r.kind === 'full') { res.status(429).json({ error: 'too-many-requests' }); return; }
    if (r.kind !== 'reserved') { answer(r); return; }

    // Core: the same inbound steps a Telegram message takes.
    const eventId = `mobile:${p.deviceId}:${requestId}`;
    const ownerName = cleanText(deps.config.threadline?.ownerName) || 'Operator';
    const captured: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
    const fakeRes = {
      status(code: number) { captured.status = code; return fakeRes; },
      json(b: unknown) { captured.body = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>; return fakeRes; },
      setHeader() { return fakeRes; },
    };
    const fakeReq = {
      headers: {},
      body: {
        topicId, text, messageId: 2 ** 52 + crypto.randomInt(0, 2 ** 47), timestamp: new Date(t).toISOString(),
        fromUserId: ownerId, fromFirstName: ownerName, forwarded: false,
      },
    };
    try {
      await ingest(fakeReq, fakeRes, { deviceId: p.deviceId, eventId });
    } catch (err) {
      store.markUnknown(p.deviceId, requestId);
      deps.reportDegradation?.('MobileChat.deliver', err);
      res.status(409).json({ error: 'outcome-unknown', eventId, detail: 'This message may or may not have reached the agent. Check the conversation.' });
      return;
    }
    const b = captured.body;
    // Only the core's early refusals (missing fields, the app refusal, the boot window) come before
    // any effect; those release the id. Any other failure answer is uncertain, never a refusal.
    const earlyRefusal = captured.status === 400 || captured.status === 422 || (captured.status === 503 && b.reason === 'server-boot-incomplete');
    if (earlyRefusal) {
      store.release(p.deviceId, requestId);
      res.status(captured.status).json(b);
      return;
    }
    if (captured.status >= 400 || b.ok === false) {
      store.markUnknown(p.deviceId, requestId);
      deps.reportDegradation?.('MobileChat.deliver', new Error(`inbound core answered ${captured.status} ${String(b.error ?? b.reason ?? '')}`));
      res.status(409).json({ error: 'outcome-unknown', eventId, detail: 'This message may or may not have reached the agent. Check the conversation.' });
      return;
    }
    const outcome = b.sentinel === 'emergency-stop' ? 'sentinel-kill'
      : b.sentinel === 'pause' ? 'sentinel-pause'
      : b.deduped ? 'deduped'
      : b.agentMessage ? 'a2a-handled'
      : 'delivered';

    // Mirror: best-effort, never decides delivery.
    let mirrored = false;
    try {
      await tg.sendToTopic(topicId, `📱 ${ownerName} (from the app): ${text}`, { silent: true, skipStallClear: true, operatorMirror: true });
      mirrored = true;
    } catch (err) {
      deps.reportDegradation?.('MobileChat.mirror', err);
    }
    const response = {
      ok: true, outcome, eventId, mirrored,
      ...(b.killed !== undefined ? { stopped: b.killed } : {}),
      ...(b.paused !== undefined ? { paused: b.paused } : {}),
    };
    if (!store.finish(p.deviceId, requestId, { status: 200, body: response })) {
      deps.reportDegradation?.('MobileChat.requestStore', new Error('could not record the finished request'));
    }
    res.json(response);
  });

  return router;
}

type Principal = { kind: 'device'; deviceId: string } | { kind: 'token' };
function principalOf(req: Request): Principal {
  return ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
}

function publicDeviceView(d: DeviceRecord, machine: string | null): Record<string, unknown> {
  const showFingerprint = d.status === 'active' || d.status === 'revoked';
  return {
    id: d.id, deviceName: d.deviceName, label: d.label, pairedAt: d.pairedAt, status: d.status,
    ...(showFingerprint && d.fingerprint ? { fingerprint: d.fingerprint } : {}),
    ...(d.approvedAt ? { approvedAt: d.approvedAt } : {}), ...(d.revokedAt ? { revokedAt: d.revokedAt } : {}),
    machine,
  };
}

async function forwardRevoke(ctx: PoolCtx, id: string): Promise<{ confirmedBy: string | null }> {
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  let confirmedBy: string | null = null;
  await Promise.all(peers.map(async (p) => {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) return;
    try {
      const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, `/mobile/devices/${encodeURIComponent(id)}/revoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${ctx.config.authToken}`, 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (r.ok) confirmedBy = p.machineId;
    } catch { /* @silent-fallback-ok — an unreachable peer is reported by the 202 pending answer */ }
  }));
  return { confirmedBy };
}

// ── Device authentication (wired into authMiddleware) ───────────────────────────────

/** Exact routes a device principal may use (spec 2.3); path lowercased, trailing slash removed. */
// `sendRoute`: a send route (Telegram, app). Its authentication-time device rate limit is skipped
// when native conversations are on: sends have their own limit in preflight, so the app's read
// polling can never use up the allowance an emergency stop needs (mobile-native-conversations §4.2).
const UUID = APP_CONVERSATION_KEY_PATTERN;
const DEVICE_ALLOWLIST: Array<{ method: string; re: RegExp; statuses: ReadonlySet<DeviceStatus>; sendRoute?: boolean }> = (() => {
  const active: ReadonlySet<DeviceStatus> = new Set(['active']);
  return [
    { method: 'GET', re: /^\/health$/, statuses: active },
    { method: 'GET', re: /^\/attention$/, statuses: active },
    { method: 'GET', re: /^\/sessions$/, statuses: active },
    { method: 'GET', re: /^\/telegram\/topics$/, statuses: active },
    // Topic recency for the app's conversation list (newest first); read-only.
    { method: 'GET', re: /^\/topic\/list$/, statuses: active },
    { method: 'GET', re: /^\/telegram\/topics\/[^/]+\/messages$/, statuses: active },
    { method: 'GET', re: /^\/mobile\/devices$/, statuses: active },
    { method: 'GET', re: /^\/mobile\/device$/, statuses: new Set(['pending', 'active', 'declined', 'expired']) },
    { method: 'POST', re: /^\/mobile\/device\/confirm$/, statuses: new Set(['pending', 'active']) },
    // Every POST, PATCH and DELETE below is idempotent through MobileChatRequestStore (requestId).
    { method: 'POST', re: /^\/mobile\/chat\/\d+$/, statuses: active, sendRoute: true },
    // Native app conversations (mobile-native-conversations §4.10), strict lowercase UUIDs.
    { method: 'GET', re: /^\/mobile\/conversations$/, statuses: active },
    { method: 'POST', re: /^\/mobile\/conversations$/, statuses: active },
    { method: 'PATCH', re: new RegExp(`^/mobile/conversations/${UUID}$`), statuses: active },
    { method: 'DELETE', re: new RegExp(`^/mobile/conversations/${UUID}$`), statuses: active },
    { method: 'POST', re: new RegExp(`^/mobile/chat/app/${UUID}$`), statuses: active, sendRoute: true },
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/messages$`), statuses: active },
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/events$`), statuses: active },
    { method: 'POST', re: /^\/mobile\/devices\/[^/]+\/revoke$/, statuses: new Set(['pending', 'active', 'declined', 'expired']) },
  ];
})();

/**
 * The device check for authMiddleware: returns 'none' when the request carries no device
 * headers (bearer rules apply), 'ok' after setting req.instarPrincipal, or 'refused' after
 * answering the request.
 */
export function deviceAuthenticator(svc: MobilePairingService) {
  return (req: Request, res: Response): 'none' | 'ok' | 'refused' => {
    const id = req.headers['x-instar-device'];
    if (id === undefined) return 'none';
    if (!svc.enabled()) return 'none'; // gate off: device headers authenticate nothing
    const refuse = (status: number, error: string): 'refused' => { res.status(status).json({ error }); return 'refused'; };
    const pathNorm = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    const rule = DEVICE_ALLOWLIST.find((r) => r.method === req.method && r.re.test(pathNorm));
    if (!rule) return refuse(403, 'device-not-allowed');
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if ((contentLength > 0 || req.headers['transfer-encoding'] !== undefined) && !raw) return refuse(415, 'device requests must send JSON');
    const v = verifyDeviceRequest(
      { deviceId: id, time: req.headers['x-instar-device-time'], sig: req.headers['x-instar-device-sig'], method: req.method, pathWithQuery: req.originalUrl, rawBody: raw },
      (deviceId) => {
        const d = svc.devices.get(deviceId);
        return d && d.publicKey && d.host && d.status !== 'legacy-token' ? { publicKey: d.publicKey, host: d.host, status: d.status as DeviceStatus } : null;
      },
      rule.statuses, svc.replay,
    );
    if (!v.ok) return refuse(v.reason === 'rate-limited' ? 429 : 401, v.reason === 'rate-limited' ? 'too-many-requests' : 'device-unauthorized');
    if (!(rule.sendRoute && svc.nativeOn) && !svc.deviceRateOk(v.deviceId)) return refuse(429, 'too-many-requests');
    (req as unknown as { instarPrincipal: Principal }).instarPrincipal = { kind: 'device', deviceId: v.deviceId };
    return 'ok';
  };
}

/** Private-view links carry a token-derived signature; a device never receives one. */
export function stripViewSignatures<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/([?&]sig=)[0-9a-fA-F]{16,}/g, '$1removed')) as T;
}
