/**
 * Mobile pairing links (docs/specs/mobile-pairing-link.md).
 *
 * Public (registered before the bearer gate, each by an exact path+method):
 *   POST /mobile/pairing-codes/redeem   one-time code → the agent's API token (never an operator session)
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
  PairingCodeStore, PairedDeviceLog, NONCE_PATTERN, buildPairLink, cleanText, codeTtlMs, pingAnswer, stableOrigin,
  type MobilePairingConfig,
} from '../core/MobilePairing.js';
import type { InstarConfig } from '../core/types.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import type { RouteContext } from './routes.js';

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
  reportDegradation?: (what: string, err: unknown) => void;
}

type PoolCtx = Pick<RouteContext, 'config' | 'resolvePeerUrls' | 'recordRopeResult'>;
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

export class MobilePairingService {
  readonly codes: PairingCodeStore;
  readonly devices: PairedDeviceLog;
  private selfNonces = new Map<string, number>();
  private pingTimes: number[] = [];

  constructor(readonly deps: MobilePairingDeps, now: () => number = Date.now) {
    this.codes = new PairingCodeStore(now);
    this.devices = new PairedDeviceLog(deps.stateDir);
    this.now = now;
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
      } catch (err) {
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

  app.post(MOBILE_REDEEM_PATH, (req: Request, res: Response) => {
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
    // Take-and-delete happens synchronously inside redeem(), before any async work.
    const r = svc.codes.redeem(body.code, token);
    if (!r.ok) {
      if (r.reason === 'too-many-attempts') { res.status(429).json({ error: 'too-many-attempts' }); return; }
      res.status(403).json({ error: 'That link has expired or was already used.' });
      return;
    }
    try {
      svc.devices.append({ deviceName: cleanText(body.deviceName), label: r.label });
    } catch (err) {
      // The code is already consumed; the operator still gets paired. Visibility only.
      svc.deps.reportDegradation?.('MobilePairing.deviceLog', err);
    }
    res.json({ token, agentName: svc.deps.config.projectName });
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
    res.json({ code: m.code, expiresAt: new Date(m.expiresAt).toISOString(), link: buildPairLink(origin, m.code) });
  });

  router.get('/mobile/devices', async (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const machine = deps.selfMachineId ?? null;
    const local = svc.devices.list().map((d) => ({ ...d, machine }));
    if (req.query.scope !== 'pool' || !poolCtx) { res.json({ devices: local }); return; }
    const pool = await fetchPoolDevices(poolCtx);
    const devices = [...local, ...pool.rows].sort((a, b) => String(b.pairedAt).localeCompare(String(a.pairedAt)));
    res.json({ devices, pool: { failed: pool.failed } });
  });

  return router;
}
