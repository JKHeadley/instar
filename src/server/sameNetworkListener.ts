/**
 * The same-network listener (identity A4; docs/specs/identity-security-piece3e-same-network-first-phone.md §3).
 *
 * A second HTTPS listener, off until the owner asks at the computer ("Add your phone", then "At
 * home only"). It speaks TLS 1.3 with the agent's own certificate, whose public-key hash the phone
 * pins from the QR code on the computer's screen. It is NOT the dashboard: a gate in front of every
 * request serves only the pairing link's redeem and ping, a bare health answer, and the routes a
 * phone paired on this address signs with its device key. Everything else is answered as if no
 * route existed.
 *
 * Nothing that arrives here is local: each socket is marked when it is accepted
 * (src/core/requestArrival.ts), before any byte of HTTP is read.
 *
 * Open only on a network the owner allowed (src/core/SameNetworkNetwork.ts). Whether it is open, its
 * port and the allowed networks are kept in `state/same-network.json`, so it survives a restart;
 * after a restart or a network change it reopens by itself only on a network observably the same
 * as an allowed one, and otherwise stays closed until the owner allows the network at the computer.
 *
 * Inside WSL it binds to WSL's own NAT address, which only the PC itself can reach: the Windows app's
 * pass-through is the only way to it from the network, and that pass-through observes the PC's
 * networks and limits each caller address. (WSL's loopback is not reachable from Windows; measured.)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { markSameNetworkSocket } from '../core/requestArrival.js';
import { loadOrCreateSameNetworkIdentity, type SameNetworkIdentity } from '../core/SameNetworkCert.js';
import { addressHints, isWsl, networkIdOf, observeNetwork, wslNatAddress, type NetworkObservation, type ObservedNetwork } from '../core/SameNetworkNetwork.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

export const SAME_NETWORK_STATE_FILE = 'state/same-network.json';
const FEATURE = 'mobilePairing.sameNetwork';
/** The total bound on open connections, set before the listener opens (A4 point 9). */
export const SAME_NETWORK_MAX_CONNECTIONS = 32;
/** Where the agent listens directly: open connections and new connections a minute, per address. */
export const SAME_NETWORK_PER_ADDRESS_OPEN = 6;
export const SAME_NETWORK_PER_ADDRESS_PER_MIN = 40;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONCILE_MS = 15_000;

export interface AllowedNetwork {
  id: string;
  observer: 'agent' | 'windows-app';
  network?: ObservedNetwork;
  allowedAt: string;
}

export interface SameNetworkStateFile {
  version: 1;
  /** The owner asked for the listener (it may still be held closed by the network rule). */
  open: boolean;
  port: number | null;
  /** The announced name, kept once chosen so a renamed computer does not move paired phones. */
  name?: string;
  allowed: AllowedNetwork[];
  openedAt?: string;
}

export type HeldReason = 'network-unknown' | 'network-not-allowed' | 'port-unavailable' | null;

export interface SameNetworkStatus {
  wanted: boolean;
  listening: boolean;
  held: HeldReason;
  /** `<name>.local:<port>`: the address a phone stores and signs. Null before a port is known. */
  host: string | null;
  name: string;
  port: number | null;
  bind: string | null;
  spkiHash: string | null;
  observer: 'agent' | 'windows-app';
  network: ObservedNetwork | null;
  hints: string[];
  allowed: AllowedNetwork[];
}

export interface SameNetworkListenerDeps {
  stateDir: string;
  agentName: string;
  machineName?: string;
  /** The main listener's port; the default same-network port is this plus 1000. */
  mainPort: number;
  /** The full app, reached only through `gate`. */
  app: (req: IncomingMessage, res: ServerResponse) => void;
  /** Returns true to pass the request on; otherwise it has already answered. */
  gate: (req: IncomingMessage, res: ServerResponse) => boolean;
  observe?: () => Promise<NetworkObservation>;
  wsl?: boolean;
  /** The first port to try when none is stored yet (tests use 0 for an OS-chosen one); default main + 1000. */
  port?: number;
  /** Override the bind address (tests: 127.0.0.1). */
  bindHost?: string;
  /** Inside WSL, the address to bind (default: WSL's own NAT address, read live). */
  wslBindAddress?: () => string | null;
  announce?: boolean;
  /**
   * Whether anything uses the home address: an open setup, or a phone paired on it (active or
   * waiting). Checked at boot and on every reconcile tick: when nothing does, the listener closes
   * itself and forgets the wish, so it is never left open with nothing behind it.
   */
  inUse?: () => boolean;
  now?: () => number;
  reportDegradation?: (what: string, err: unknown) => void;
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'agent';
}

/** `<agent>-<machine>`, the name announced on the network and stored by the phone (without `.local`). */
export function sameNetworkName(agentName: string, machineName: string): string {
  return `${slug(agentName)}-${slug(machineName)}`.slice(0, 63).replace(/-+$/, '');
}

export class SameNetworkListener {
  private server: https.Server | null = null;
  private identity: (SameNetworkIdentity & { created: boolean }) | null = null;
  private state: SameNetworkStateFile;
  private held: HeldReason = null;
  private lastObservation: NetworkObservation | null = null;
  private timer: NodeJS.Timeout | null = null;
  private announcer: ChildProcess | null = null;
  private boundPort: number | null = null;
  private boundHost: string | null = null;
  private readonly perAddress = new Map<string, { open: number; times: number[] }>();
  private reconciling: Promise<void> | null = null;
  /** Set by stop(): nothing opens after it, even an open already in flight. */
  private stopped = false;
  readonly name: string;
  private readonly wsl: boolean;

  constructor(private readonly deps: SameNetworkListenerDeps) {
    this.wsl = deps.wsl ?? isWsl();
    this.state = this.readState();
    this.name = this.state.name ?? sameNetworkName(deps.agentName, deps.machineName ?? os.hostname());
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private file(): string { return path.join(this.deps.stateDir, SAME_NETWORK_STATE_FILE); }

  private readState(): SameNetworkStateFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Partial<SameNetworkStateFile>;
      if (raw && raw.version === 1 && Array.isArray(raw.allowed)) {
        return { version: 1, open: raw.open === true, port: typeof raw.port === 'number' ? raw.port : null,
          ...(typeof raw.name === 'string' && /^[a-z0-9-]{1,63}$/.test(raw.name) ? { name: raw.name } : {}), allowed: raw.allowed.filter((a) => a && typeof a.id === 'string').slice(0, 16), ...(raw.openedAt ? { openedAt: raw.openedAt } : {}) };
      }
    } catch {
      // @silent-fallback-ok — no state file means the listener was never asked for: closed, the safe default.
    }
    return { version: 1, open: false, port: null, allowed: [] };
  }

  private writeState(): void {
    const f = this.file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  /** The address a phone stores and signs, once a port is known. */
  host(): string | null {
    const port = this.boundPort ?? this.state.port;
    return port ? `${this.name}.local:${port}` : null;
  }

  /** The pinned value, available once the identity was loaded (the listener opened at least once). */
  spkiHash(): string | null { return this.identity?.spkiHash ?? null; }

  listening(): boolean { return this.server !== null && this.server.listening; }

  status(): SameNetworkStatus {
    const obs = this.lastObservation;
    return {
      wanted: this.state.open, listening: this.listening(), held: this.state.open ? this.held : null,
      host: this.host(), name: this.name, port: this.boundPort ?? this.state.port, bind: this.boundHost,
      spkiHash: this.spkiHash(), observer: this.wsl ? 'windows-app' : 'agent',
      network: obs?.kind === 'observed' ? obs.network : null,
      hints: this.wsl ? [] : addressHints(), allowed: this.state.allowed.map((a) => ({ ...a })),
    };
  }

  private async observeNow(): Promise<NetworkObservation> {
    const obs = await (this.deps.observe ?? (() => observeNetwork({ wsl: this.wsl })))();
    this.lastObservation = obs;
    return obs;
  }

  private allowedMatch(obs: NetworkObservation): boolean {
    if (obs.kind === 'delegated') return this.state.allowed.some((a) => a.observer === 'windows-app');
    if (obs.kind !== 'observed') return false;
    const id = networkIdOf(obs.network);
    return this.state.allowed.some((a) => a.observer === 'agent' && a.id === id);
  }

  /**
   * The owner asked at the computer (the caller ran the fresh check). Allows the network this
   * computer is on now, records the wish, and opens. Refused (and nothing recorded) when the
   * network cannot be read.
   */
  async openForOwner(): Promise<{ ok: true; status: SameNetworkStatus } | { ok: false; reason: 'network-unknown' | 'port-unavailable'; detail: string }> {
    const obs = await this.observeNow();
    if (obs.kind === 'unknown') return { ok: false, reason: 'network-unknown', detail: `This computer cannot tell which network it is on (${obs.reason}), so the home address stays closed.` };
    this.allowObservation(obs);
    this.state.open = true;
    this.state.name = this.name;
    this.state.openedAt = new Date(this.now()).toISOString();
    this.writeState();
    await this.reconcile();
    if (!this.listening()) {
      return { ok: false, reason: 'port-unavailable', detail: 'The home address could not start on this computer. Another program may be using its port.' };
    }
    featureEvidence.record(FEATURE, { kind: 'fired', reason: 'opened by the owner at the computer', context: { observer: obs.kind === 'delegated' ? 'windows-app' : 'agent' } });
    return { ok: true, status: this.status() };
  }

  /** The owner allowed the current network at the computer (one tap, after the fresh check). */
  async allowCurrentNetwork(): Promise<{ ok: boolean; status: SameNetworkStatus; detail?: string }> {
    const obs = await this.observeNow();
    if (obs.kind === 'unknown') return { ok: false, status: this.status(), detail: 'This computer cannot tell which network it is on.' };
    this.allowObservation(obs);
    this.writeState();
    await this.reconcile();
    return { ok: true, status: this.status() };
  }

  private allowObservation(obs: NetworkObservation): void {
    if (obs.kind === 'delegated') {
      if (!this.state.allowed.some((a) => a.observer === 'windows-app')) this.state.allowed.push({ id: 'windows-app', observer: 'windows-app', allowedAt: new Date(this.now()).toISOString() });
      return;
    }
    if (obs.kind !== 'observed') return;
    const id = networkIdOf(obs.network);
    if (!this.state.allowed.some((a) => a.id === id)) {
      this.state.allowed.push({ id, observer: 'agent', network: obs.network, allowedAt: new Date(this.now()).toISOString() });
      this.state.allowed = this.state.allowed.slice(-16);
    }
  }

  /** The owner closed the home address. Phones paired on it can no longer reach the agent. */
  async close(): Promise<void> {
    this.state.open = false;
    this.writeState();
    if (this.reconciling) await this.reconciling.catch(() => { /* @silent-fallback-ok — closing below either way */ });
    await this.stopServer();
    this.held = null;
    featureEvidence.record(FEATURE, { kind: 'fired', reason: 'closed by the owner' });
  }

  /** Boot: reopen only if the owner had asked for it and the network is an allowed one. */
  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.reconcile(true); }, RECONCILE_MS);
    this.timer.unref?.();
    await this.reconcile(true);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.reconciling) await this.reconciling.catch(() => { /* @silent-fallback-ok — closing below either way */ });
    await this.stopServer();
  }

  /** Bring the listener in line with the state file and the observed network. Serialized. */
  async reconcile(checkUse = false): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      try {
        if (this.state.open && checkUse && this.deps.inUse && !this.deps.inUse()) {
          // Nothing uses the home address (a setup ended, a restart dropped it, the only home phone
          // was removed): close it, so it is never open with nothing behind it.
          this.state.open = false;
          this.writeState();
          featureEvidence.record(FEATURE, { kind: 'fired', reason: 'closed: nothing uses the home address' });
        }
        if (!this.state.open || this.stopped) { this.held = null; await this.stopServer(); return; }
        const obs = await this.observeNow();
        if (!this.allowedMatch(obs)) {
          this.held = obs.kind === 'unknown' ? 'network-unknown' : 'network-not-allowed';
          if (this.listening()) featureEvidence.record(FEATURE, { kind: 'held', reason: `closed: ${this.held}` });
          await this.stopServer();
          return;
        }
        const bind = this.deps.bindHost ?? (obs.kind === 'observed' ? obs.network.address : this.wslBind());
        if (!bind) {
          // WSL outside NAT mode (mirrored, or unreadable): no address only the PC can reach, so closed.
          this.held = 'network-unknown';
          await this.stopServer();
          return;
        }
        if (this.listening() && this.boundHost === bind) { this.held = null; return; }
        await this.stopServer();
        const ok = await this.startServer(bind);
        this.held = ok ? null : 'port-unavailable';
      } catch (err) {
        this.deps.reportDegradation?.('SameNetworkListener.reconcile', err);
        this.held = 'network-unknown';
        await this.stopServer().catch(() => { /* @silent-fallback-ok — already reported; a closed listener is the safe state */ });
      } finally {
        this.reconciling = null;
      }
    })();
    return this.reconciling;
  }

  private wslBind(): string | null {
    if (this.deps.wslBindAddress) return this.deps.wslBindAddress();
    try { return wslNatAddress(fs.readFileSync('/proc/net/route', 'utf8'), os.networkInterfaces()); } catch { return null; } // @silent-fallback-ok — unreadable means not provably NAT: the listener stays closed
  }

  private perAddressOk(addr: string): boolean {
    // Inside WSL every caller arrives from loopback through the pass-through, which limits each address itself.
    if (this.wsl || this.boundHost === '127.0.0.1') return true; // one caller address: the pass-through limits each real caller
    const t = this.now();
    // Forget addresses with nothing open and nothing in the last minute, so the map stays small.
    if (this.perAddress.size > 256) for (const [k, v] of this.perAddress) if (v.open === 0 && v.times.every((x) => t - x >= 60_000)) this.perAddress.delete(k);
    const e = this.perAddress.get(addr) ?? { open: 0, times: [] };
    e.times = e.times.filter((x) => t - x < 60_000);
    if (e.open >= SAME_NETWORK_PER_ADDRESS_OPEN || e.times.length >= SAME_NETWORK_PER_ADDRESS_PER_MIN) { this.perAddress.set(addr, e); return false; }
    e.open += 1; e.times.push(t);
    this.perAddress.set(addr, e);
    return true;
  }

  private async startServer(bind: string): Promise<boolean> {
    if (this.stopped) return false;
    const name = this.name;
    this.identity = loadOrCreateSameNetworkIdentity(this.deps.stateDir, `${name}.local`);
    if (this.identity.created) featureEvidence.record(FEATURE, { kind: 'fired', reason: 'made a new certificate key (phones paired on an earlier key pair again)' });
    const server = https.createServer({
      key: this.identity.keyPem, cert: this.identity.certPem, minVersion: 'TLSv1.3', handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    }, (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      // Marked again here (idempotent), so the mark never depends on listener order.
      markSameNetworkSocket(req.socket);
      if (!this.deps.gate(req, res)) return;
      this.deps.app(req, res);
    });
    server.maxConnections = SAME_NETWORK_MAX_CONNECTIONS;
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.on('connection', (socket: Socket) => {
      const addr = String(socket.remoteAddress ?? '');
      if (!this.perAddressOk(addr)) { socket.destroy(); return; }
      socket.once('close', () => { const e = this.perAddress.get(addr); if (e) e.open = Math.max(0, e.open - 1); });
    });
    // Marked when TLS completes, before the HTTP parser hands any request to the gate.
    server.on('secureConnection', (tlsSocket: TLSSocket) => { markSameNetworkSocket(tlsSocket); });
    // No live socket upgrades on this listener.
    server.on('upgrade', (_req: IncomingMessage, socket: Socket) => { socket.destroy(); });
    server.on('tlsClientError', () => { /* @silent-fallback-ok — a failed handshake is a closed socket, nothing to report per caller */ });
    const want = this.state.port ?? this.deps.port ?? (this.deps.mainPort + 1000);
    const listenOn = (port: number): Promise<number | null> => new Promise((resolve) => {
      const onErr = (): void => { server.removeListener('listening', onOk); resolve(null); };
      const onOk = (): void => { server.removeListener('error', onErr); const a = server.address(); resolve(a && typeof a === 'object' ? a.port : null); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, bind);
    });
    let port = await listenOn(want);
    // The first open may take another free port; after that the stored port is kept (the
    // Windows pass-through forwards to one fixed port and stops if it changes).
    if (port === null && this.state.port === null) port = await listenOn(0);
    if (port === null) { this.deps.reportDegradation?.('SameNetworkListener.listen', new Error(`could not listen on ${bind}:${want}`)); return false; }
    if (this.stopped) { server.close(); return false; }
    this.server = server;
    this.boundPort = port;
    this.boundHost = bind;
    if (this.state.port !== port) { this.state.port = port; this.writeState(); }
    this.startAnnouncer(bind, port);
    return true;
  }

  private async stopServer(): Promise<void> {
    this.stopAnnouncer();
    const s = this.server;
    this.server = null;
    this.boundHost = null;
    this.perAddress.clear();
    if (!s) return;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  /**
   * Announce `<name>.local` on the allowed network: macOS through its own `dns-sd`, Linux through
   * `avahi-publish` where it is installed. The Windows app announces for an agent in WSL. The
   * announcement only helps the phone find an address; the pinned hash decides whether it is the agent.
   */
  private startAnnouncer(bind: string, port: number): void {
    if (this.deps.announce === false || this.wsl || bind === '127.0.0.1' || process.env.VITEST) return;
    const args = process.platform === 'darwin'
      ? ['dns-sd', ['-P', this.name, '_instar._tcp', 'local', String(port), `${this.name}.local`, bind]] as const
      : process.platform === 'linux' ? ['avahi-publish', ['-a', '-R', `${this.name}.local`, bind]] as const : null;
    if (!args) return;
    try {
      const child = spawn(args[0], [...args[1]], { stdio: 'ignore', detached: false });
      child.on('error', () => { /* @silent-fallback-ok — no announcer on this system: the phone uses the address hints, then a rescan */ });
      this.announcer = child;
    } catch {
      // @silent-fallback-ok — see the error handler above
      this.announcer = null;
    }
  }

  private stopAnnouncer(): void {
    const a = this.announcer;
    this.announcer = null;
    if (a?.pid) { try { process.kill(a.pid); } catch { /* @silent-fallback-ok — already gone */ } }
  }
}
