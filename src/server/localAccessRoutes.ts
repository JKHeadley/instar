/**
 * The one-time local dashboard link: server routes (docs/specs/identity-security-piece1a-local-link.md).
 *
 * Mounted before the auth middleware. Every route answers only a loopback peer with no forwarding
 * header, so tunnel traffic is never local (umbrella §4.6). Minting is authenticated by an HMAC
 * over a private key only the agent's OS account can read (`local-access/listener.key`), never by
 * the bearer token, and every mint response carries an HMAC the CLI checks before using anything.
 *
 * The local credential this creates has one consumer: `verifyUnlockLocalAccess`, which the
 * dashboard unlock route calls first to choose the verified-local PIN budget. It grants nothing
 * else.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Application, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { mayBeLocalArrival } from '../core/requestArrival.js';
import { isLoopbackPeer } from '../core/desktopTransport.js';
import { hasForwardingHeaders, verifyP256 } from './mobileBrowserDevices.js';
import { parseDevicePublicKey } from '../core/MobileDeviceKeys.js';
import {
  LOCAL_ACCESS_DIR, LocalAccessStore, MAX_REQUEST_BYTES, ensurePrivateDir, type StartedBy,
} from '../core/LocalAccessStore.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const LOCAL_ACCESS_PREFIX = '/local-access/v1';
export const LOCAL_ACCESS_FEATURE = 'security.localAccessLink';
export const MINT_WINDOW_MS = 60_000;
export const LAUNCH_SUBDIR = 'launch';
const LAUNCH_NAME = /^[A-Za-z0-9_-]{22}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export const EXCHANGE_PAGE_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The text the CLI's mint HMAC covers. */
export function mintProofText(agentName: string, port: number, browserPort: number, startedBy: string, timeMs: number, clientNonce: string): string {
  return `instar-local-mint-v1\n${agentName}\n${port}\n${browserPort}\n${startedBy}\n${timeMs}\n${clientNonce}`;
}

/** The text the server's mint-response HMAC covers. */
export function mintResponseText(clientNonce: string, id: string, secretDigest: string, expiresAt: number, launchName: string, origin: string): string {
  return `instar-local-mint-response-v1\n${clientNonce}\n${id}\n${secretDigest}\n${expiresAt}\n${launchName}\n${origin}`;
}

export const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

export function hmac(key: Buffer, text: string): string {
  return crypto.createHmac('sha256', key).update(text).digest('base64url');
}

function sameB64(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Read or create the private listener key: directory 0700, file 0600, exclusive create. A
 * symlinked or foreign-owned file is refused rather than repaired.
 */
export function ensureListenerKey(stateDir: string): Buffer {
  const dir = path.join(stateDir, LOCAL_ACCESS_DIR);
  ensurePrivateDir(dir);
  const file = path.join(dir, 'listener.key');
  try {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, crypto.randomBytes(32)); } finally { fs.closeSync(fd); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return readListenerKey(stateDir);
}

/** Read the listener key, refusing anything but this user's private regular 32-byte file. */
export function readListenerKey(stateDir: string): Buffer {
  const file = path.join(stateDir, LOCAL_ACCESS_DIR, 'listener.key');
  const st = fs.lstatSync(file);
  const uid = process.getuid?.();
  if (!st.isFile() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077)) throw new Error('local-access-key-ownership-invalid');
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('local-access-key-invalid');
  return key;
}

/**
 * Whether the listening socket covers 127.0.0.1 at its port: bound to 127.0.0.1, the IPv4
 * wildcard, or a dual-stack IPv6 wildcard. Read from `server.address()`, never from config.
 */
export function coversLoopbackV4(addr: AddressInfo | string | null | undefined): boolean {
  if (!addr || typeof addr === 'string') return false;
  return addr.address === '127.0.0.1' || addr.address === '0.0.0.0' || addr.address === '::';
}

/** The budget key for a verified-local unlock (spec §5), with fallbacks for missing ids. */
export function verifiedLocalBudgetKey(machineId: string | null | undefined, pinGeneration: string | number | null | undefined): string {
  const m = machineId && /^[A-Za-z0-9_.:-]{1,128}$/.test(machineId) ? machineId : 'single';
  const g = pinGeneration === null || pinGeneration === undefined || pinGeneration === '' ? 'none' : String(pinGeneration);
  return `local-verified:${m}:${g}`;
}

export interface LocalAccessDeps {
  stateDir: string;
  agentName: () => string;
  /** The resolved switch (dev-gated), read live. */
  enabled: () => boolean;
  /** The listening socket's address, once listening. */
  boundAddress: () => AddressInfo | string | null | undefined;
  /** The packaged dashboard folder (holds local-access-open.js). */
  dashboardDir: string;
  now?: () => number;
}

function requestHost(req: Request): string {
  return typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
}

/**
 * Arrived on this server's 127.0.0.1 socket (so a program holding 127.0.0.1:<port> has no second
 * path in to relay through), from a loopback peer, with no forwarding header.
 */
export function localPeer(req: Pick<Request, 'socket' | 'headers'>): boolean {
  if (!mayBeLocalArrival(req)) return false;
  const la = req.socket.localAddress;
  if (la !== '127.0.0.1' && la !== '::ffff:127.0.0.1') return false;
  return isLoopbackPeer(req.socket.remoteAddress) && !hasForwardingHeaders(req.headers as Record<string, unknown>);
}

export class LocalAccessService {
  private store: LocalAccessStore | null = null;
  private key: Buffer | null = null;
  private storeError: string | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  /**
   * When this process began listening (set by startSweeps, which runs in the listen callback). A
   * mint stamped earlier is refused: it may have been captured while another program held the port.
   */
  private listeningSince: number | null = null;
  readonly deps: LocalAccessDeps;

  constructor(deps: LocalAccessDeps) { this.deps = deps; }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private dir(): string { return path.join(this.deps.stateDir, LOCAL_ACCESS_DIR); }
  private launchDir(): string { return path.join(this.dir(), LAUNCH_SUBDIR); }

  /** Lazily open the store and key; a failure is remembered and reported, never thrown at callers. */
  private ready(): { store: LocalAccessStore; key: Buffer } | null {
    if (this.store && this.key) return { store: this.store, key: this.key };
    try {
      this.key = ensureListenerKey(this.deps.stateDir);
      this.store = new LocalAccessStore({ dir: this.dir(), agentName: this.deps.agentName(), now: this.deps.now });
      ensurePrivateDir(this.launchDir());
      this.storeError = null;
      return { store: this.store, key: this.key };
    } catch (err) {
      const firstForThisCause = this.storeError !== (err as Error).message;
      this.storeError = (err as Error).message;
      featureEvidence.recordAtMostEvery(LOCAL_ACCESS_FEATURE, 'store-unavailable', 10 * 60_000, { kind: 'error', reason: `local access store unavailable: ${this.storeError}` });
      // Reported once per distinct cause (ready() runs per request), never per request.
      if (firstForThisCause) DegradationReporter.getInstance().report({
        feature: 'LocalAccessLink.store',
        primary: 'The one-time local dashboard link is unavailable on this machine',
        fallback: 'Dashboard unlock follows its usual rules; the PIN, a browser unlocked before and the paired phone app still work',
        reason: `The local link's private folder could not be opened: ${this.storeError}`,
        impact: 'A person at this computer cannot use the one-time link until the folder is fixed.',
      });
      return null;
    }
  }

  /** Why the link is unavailable on this run, or null when it is available. */
  unavailableReason(): string | null {
    if (!this.deps.enabled()) return 'off';
    if (!coversLoopbackV4(this.deps.boundAddress())) return 'not-listening-on-127.0.0.1';
    if (!this.ready()) return 'store-unavailable';
    return null;
  }

  port(): number | null {
    const a = this.deps.boundAddress();
    return a && typeof a !== 'string' ? a.port : null;
  }

  /** Delete a launch document by its server-chosen name: only a regular non-symlink file in the launch dir. */
  deleteLaunch(name: string): void {
    if (!LAUNCH_NAME.test(name)) return;
    const file = path.join(this.launchDir(), `${name}.html`);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) return;
      SafeFsExecutor.safeUnlinkSync(file, { operation: 'src/server/localAccessRoutes.ts:deleteLaunch' });
    } catch { /* @silent-fallback-ok — an absent launch document is the expected case after the CLI never wrote it */ }
  }

  /**
   * Start-up sweep: remove launch documents no live ticket owns. Runs even with the switch off,
   * so turning the link off leaves no secret-bearing file behind.
   */
  sweepLaunchDocuments(): void {
    let names: string[];
    try {
      const st = fs.lstatSync(this.launchDir());
      if (!st.isDirectory() || st.isSymbolicLink()) return; // never follow a planted link
      names = fs.readdirSync(this.launchDir());
    } catch { return; } // @silent-fallback-ok — no launch dir means nothing to sweep
    let live = new Set<string>();
    if (this.deps.enabled()) {
      const r = this.ready();
      if (r) { r.store.prune().forEach((n) => this.deleteLaunch(n)); live = r.store.liveLaunchNames(); }
    }
    for (const f of names) {
      const name = f.endsWith('.html') ? f.slice(0, -5) : '';
      if (LAUNCH_NAME.test(name) && !live.has(name)) this.deleteLaunch(name);
    }
  }

  /** The launcher every message that offers the link prints (spec §3). */
  launcherPath(): string { return path.join(this.deps.stateDir, 'bin', 'dashboard-open'); }

  /**
   * Write `<stateDir>/bin/dashboard-open` (0700): runs this agent's own installed CLI with
   * `dashboard open --dir <agent folder>`. Rewritten at every start so it follows updates; the
   * `instar` command itself is not on the PATH on a standard install.
   */
  writeLauncher(cliEntry: string | undefined = process.argv[1], nodePath: string = process.execPath): boolean {
    if (!cliEntry || !/cli\.(js|mjs|cjs)$/.test(cliEntry)) return false;
    const q = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;
    const projectDir = path.dirname(this.deps.stateDir);
    const body = `#!/bin/sh\n# Opens this agent's dashboard through a one-time local link (instar dashboard open).\n# Written by the agent's server at every start; do not edit.\nexec ${q(nodePath)} ${q(cliEntry)} dashboard open --dir ${q(projectDir)} "$@"\n`;
    fs.mkdirSync(path.dirname(this.launcherPath()), { recursive: true, mode: 0o700 });
    SafeFsExecutor.atomicWriteFileSync(this.launcherPath(), body, { operation: 'src/server/localAccessRoutes.ts:writeLauncher', mode: 0o700 });
    return true;
  }

  startSweeps(): void {
    this.listeningSince = this.now();
    if (this.deps.enabled()) {
      const r = this.ready();
      if (r) r.store.revokeUnredeemedAtStart().forEach((n) => this.deleteLaunch(n));
      try { this.writeLauncher(); } catch (err) { featureEvidence.recordAtMostEvery(LOCAL_ACCESS_FEATURE, 'launcher-write', 10 * 60_000, { kind: 'held', reason: `launcher not written: ${(err as Error).message}` }); }
    }
    this.sweepLaunchDocuments();
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      if (!this.deps.enabled() || !this.store) return;
      try { this.store.prune().forEach((n) => this.deleteLaunch(n)); this.sweepLaunchDocuments(); } catch { /* @silent-fallback-ok — the next tick retries */ }
    }, 60_000);
    this.sweepTimer.unref?.();
  }

  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.store?.close();
    this.store = null;
  }

  /**
   * The unlock route's check (spec §5): a live credential, loopback peer, no forwarding header,
   * Host and Origin equal to the credential's origin, and a single-use challenge signed by the
   * bound key. True only when all hold; any error is "not verified" (today's rules apply).
   */
  verifyUnlockLocalAccess(req: Request): boolean {
    try {
      if (this.unavailableReason()) return false;
      const la = (req.body as { localAccess?: unknown } | undefined)?.localAccess as { credentialId?: unknown; challenge?: unknown; signature?: unknown } | undefined;
      if (!la || typeof la !== 'object') return false;
      if (typeof la.credentialId !== 'string' || typeof la.challenge !== 'string') return false;
      if (!localPeer(req)) return false;
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      if (!origin || `http://${requestHost(req)}` !== origin) return false;
      const store = this.store;
      if (!store) return false;
      const cred = store.verifyUse({
        credentialId: la.credentialId, action: 'dashboard-unlock', challenge: la.challenge, origin,
        methodPath: 'POST /dashboard/unlock', verify: (pub, text) => verifyP256(pub, text, la.signature),
      });
      return !!cred;
    } catch {
      return false; // @silent-fallback-ok — an unreadable store is "not verified": today's rules apply
    }
  }

  mount(app: Application): void {
    const json = express.json({ limit: MAX_REQUEST_BYTES });
    const P = LOCAL_ACCESS_PREFIX;
    const notFound = (res: Response): void => { res.status(404).json({ error: 'not-found' }); };
    const guard = (req: Request, res: Response): boolean => {
      res.setHeader('Cache-Control', 'no-store');
      if (!this.deps.enabled() || !localPeer(req)) { notFound(res); return false; }
      return true;
    };
    /** Host and Origin must name the ticket's origin; returns the origin or null. */
    const originOf = (req: Request): string | null => {
      const host = requestHost(req);
      if (!/^127\.0\.0\.1:\d{1,5}$/.test(host)) return null;
      const origin = `http://${host}`;
      return req.headers.origin === origin ? origin : null;
    };
    const jsonOnly = (req: Request): boolean => (req.headers['content-type'] ?? '').toString().toLowerCase().startsWith('application/json');

    app.post(`${P}/mint`, json, (req, res) => {
      if (!guard(req, res)) return;
      const why = this.unavailableReason();
      if (why) { res.status(503).json({ error: 'unavailable', reason: why }); return; }
      const port = req.socket.localPort ?? 0;
      if (requestHost(req) !== `127.0.0.1:${port}`) { notFound(res); return; }
      const r = this.ready();
      if (!r) { res.status(503).json({ error: 'unavailable', reason: 'store-unavailable' }); return; }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const browserPort = b.browserPort === undefined ? port : Number(b.browserPort);
      const startedBy: StartedBy = b.startedBy === 'session' ? 'session' : 'terminal';
      const timeMs = Number(b.timeMs);
      const clientNonce = typeof b.clientNonce === 'string' ? b.clientNonce : '';
      const now = this.now();
      if (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535 || !Number.isFinite(timeMs)
        || Math.abs(now - timeMs) > MINT_WINDOW_MS || this.listeningSince === null || timeMs < this.listeningSince || !NONCE.test(clientNonce) || (b.startedBy !== 'session' && b.startedBy !== 'terminal')) {
        res.status(400).json({ error: 'bad-request' }); return;
      }
      const expected = hmac(r.key, mintProofText(this.deps.agentName(), port, browserPort, startedBy, timeMs, clientNonce));
      if (!sameB64(b.proof, expected)) { res.status(403).json({ error: 'bad-proof' }); return; }
      if (!r.store.rememberNonce(clientNonce, timeMs + MINT_WINDOW_MS)) { res.status(409).json({ error: 'replayed' }); return; }
      const origin = `http://127.0.0.1:${browserPort}`;
      const m = r.store.mint({ origin, startedBy });
      m.endedLaunchNames.forEach((n) => this.deleteLaunch(n));
      featureEvidence.record(LOCAL_ACCESS_FEATURE, { kind: 'fired', reason: 'local link minted', context: { startedBy, printMode: browserPort !== port } });
      res.json({
        id: m.id, secret: m.secret, expiresAt: m.expiresAt, launchName: m.launchName, origin,
        responseProof: hmac(r.key, mintResponseText(clientNonce, m.id, sha256Hex(m.secret), m.expiresAt, m.launchName, origin)),
      });
    });

    app.get(`${P}/open`, (req, res) => {
      if (!guard(req, res)) return;
      res.setHeader('Content-Security-Policy', EXCHANGE_PAGE_CSP);
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('html').send(OPEN_PAGE_HTML);
    });
    app.get(`${P}/open.js`, (req, res) => {
      if (!guard(req, res)) return;
      res.setHeader('Content-Security-Policy', EXCHANGE_PAGE_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.type('application/javascript').sendFile(path.join(this.dashboardDir(), 'local-access-open.js'), { cacheControl: false });
    });

    const preflight = (req: Request, res: Response): { store: LocalAccessStore; origin: string } | null => {
      if (!guard(req, res)) return null;
      if (!jsonOnly(req)) { res.status(415).json({ error: 'json-only' }); return null; }
      const origin = originOf(req);
      if (!origin) { res.status(403).json({ error: 'origin-mismatch' }); return null; }
      if (this.unavailableReason()) { res.status(503).json({ error: 'unavailable' }); return null; }
      const r = this.ready();
      if (!r) { res.status(503).json({ error: 'unavailable' }); return null; }
      return { store: r.store, origin };
    };

    app.post(`${P}/challenge`, json, (req, res) => {
      const p = preflight(req, res); if (!p) return;
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (!parseDevicePublicKey(b.publicKey)) { res.status(400).json({ error: 'bad-key' }); return; }
      const out = p.store.exchangeChallenge({ ticketId: String(b.ticketId ?? ''), secretProof: String(b.secretProof ?? ''), publicKey: String(b.publicKey), origin: p.origin });
      if (!out.ok) { res.status(out.reason === 'too-many-challenges' ? 429 : 403).json({ error: out.reason }); return; }
      // The link has reached a browser: its launch document is no longer needed.
      const launch = p.store.takeLaunchName(String(b.ticketId ?? ''));
      if (launch) this.deleteLaunch(launch);
      res.json({ challenge: out.challenge, expiresAt: out.expiresAt, agentName: this.deps.agentName() });
    });

    app.post(`${P}/exchange`, json, (req, res) => {
      const p = preflight(req, res); if (!p) return;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const publicKey = String(b.publicKey ?? '');
      if (!parseDevicePublicKey(publicKey)) { res.status(400).json({ error: 'bad-key' }); return; }
      const out = p.store.exchange({
        ticketId: String(b.ticketId ?? ''), secret: String(b.secret ?? ''), publicKey, challenge: String(b.challenge ?? ''),
        origin: p.origin, verify: (text) => verifyP256(publicKey, text, b.signature),
      });
      if (!out.ok) { res.status(403).json({ error: out.reason }); return; }
      out.endedLaunchNames.forEach((n) => this.deleteLaunch(n));
      if (!out.repeated) featureEvidence.record(LOCAL_ACCESS_FEATURE, { kind: 'fired', reason: 'local link redeemed' });
      res.json({ credentialId: out.credential.credentialId, expiresAt: out.credential.expiresAt });
    });

    app.post(`${P}/use-challenge`, json, (req, res) => {
      const p = preflight(req, res); if (!p) return;
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.action !== 'dashboard-unlock') { res.status(400).json({ error: 'bad-action' }); return; }
      const out = p.store.useChallenge({ credentialId: String(b.credentialId ?? ''), action: 'dashboard-unlock', origin: p.origin });
      if (!out.ok) { res.status(out.reason === 'too-many-challenges' ? 429 : 403).json({ error: out.reason }); return; }
      res.json({ challenge: out.challenge, expiresAt: out.expiresAt });
    });
  }

  private dashboardDir(): string { return this.deps.dashboardDir; }
}

/** The fixed exchange page: no inline script, one same-origin script. */
export const OPEN_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Opening your dashboard</title></head>
<body><main><h1>Opening your dashboard…</h1><p id="status">Checking the one-time link.</p></main>
<script type="module" src="${LOCAL_ACCESS_PREFIX}/open.js"></script></body></html>`;
