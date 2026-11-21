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
 * Inside WSL the networking mode is READ (wslinfo, else the Windows user's .wslconfig), never guessed
 * from an address range (src/core/SameNetworkNetwork.ts wslBindPlan). In NAT mode it binds to WSL's own
 * NAT address, which only the PC itself can reach: the Windows app's pass-through is the only way to it
 * from the network, and that pass-through observes the PC's networks and limits each caller address.
 * (WSL's loopback is not reachable from Windows in NAT mode; measured.) In mirrored mode WSL shares the
 * PC's addresses, so it stays closed unless the Windows app said it handles the network rule; then it
 * binds loopback and still limits each caller address itself. Any other or unknown mode: closed.
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
import {
  addressHints, isWsl, networkIdOf, observeNetwork, readWslNetworkingMode, wslBindPlan, wslNatAddress,
  type NetworkObservation, type ObservedNetwork, type WslBindPlan, type WslModeReading,
} from '../core/SameNetworkNetwork.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { isFetchBlockedPort } from '../core/AgentRegistry.js';

export const SAME_NETWORK_STATE_FILE = 'state/same-network.json';
const FEATURE = 'mobilePairing.sameNetwork';
/** The total bound on open connections, set before the listener opens (A4 point 9). */
export const SAME_NETWORK_MAX_CONNECTIONS = 32;
/** Where the agent listens directly: open connections and new connections a minute, per address. */
export const SAME_NETWORK_PER_ADDRESS_OPEN = 6;
export const SAME_NETWORK_PER_ADDRESS_PER_MIN = 40;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The default home-network port is the main port plus this (4040 -> 24040, 4041 -> 24041, ...): one
 * port per agent, as the main ports are. Main + 1000 (5040) was taken on every Windows 10/11 PC by
 * Windows' Connected Devices Platform service (CDPSvc, svchost, 0.0.0.0:5040, exclusive), found live
 * by builder #39, so the Windows pass-through could not listen there. 24040-24099 is:
 *  - below every OS's ephemeral range (Linux 32768-60999, Windows and macOS 49152-65535), so an
 *    outgoing connection never holds it, and Hyper-V/WSL's reserved ranges (allocated inside the
 *    Windows dynamic range) do not cover it;
 *  - not a default listener on Windows 10/11 (135, 139, 445, 2179, 3389, 5040, 5357, 7680, 49664+),
 *    macOS (AirPlay 5000/7000, screen sharing 5900, rapportd 49152+) or common Linux desktops
 *    (22, 53, 631, 5353/udp); measured on a Windows 10 PC and a Windows 11 PC on 2026-11-19;
 *  - not a common development port (3000, 5173, 8000, 8080, ...) and not on the WHATWG fetch
 *    bad-ports list, which a phone's web stack refuses.
 * The caller may still ask for a specific port (the Windows app checks one is free on Windows first).
 */
export const SAME_NETWORK_PORT_OFFSET = 20_000;
/** Used when main + offset would leave the range below every ephemeral range. */
export const SAME_NETWORK_FALLBACK_PORT = 24_040;
/** The highest default: just below Linux's ephemeral range. */
export const SAME_NETWORK_DEFAULT_MAX = 32_767;

/** The default home-network port for an agent whose main listener is on `mainPort`. */
export function defaultSameNetworkPort(mainPort: number): number {
  const p = mainPort + SAME_NETWORK_PORT_OFFSET;
  return Number.isInteger(p) && p >= 1024 && p <= SAME_NETWORK_DEFAULT_MAX && !isFetchBlockedPort(p) ? p : SAME_NETWORK_FALLBACK_PORT;
}

/** A port a caller may ask for: an unprivileged TCP port that a phone's web stack will connect to. */
export function isRequestablePort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535 && !isFetchBlockedPort(p);
}
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
  /**
   * Inside WSL: the Windows app said, when the owner opened the address, that it enforces the network
   * rule itself. Needed only in mirrored mode (and even then the per-address limit stays on here).
   */
  windowsAppNetworkRule?: boolean;
}

export type HeldReason = 'network-unknown' | 'network-not-allowed' | 'port-unavailable' | 'wsl-networking-mode' | null;

export interface SameNetworkStatus {
  wanted: boolean;
  listening: boolean;
  held: HeldReason;
  /** `<name>.local:<port>`: the address a phone stores and signs. Null before a port is known. */
  host: string | null;
  name: string;
  port: number | null;
  /** The port the next open will use: the stored one, else the default. The app checks it is free first. */
  preferredPort: number;
  bind: string | null;
  spkiHash: string | null;
  observer: 'agent' | 'windows-app';
  /** Inside WSL: the networking mode as read, and where it was read from. Null outside WSL or before a read. */
  wslMode: WslModeReading | null;
  network: ObservedNetwork | null;
  hints: string[];
  allowed: AllowedNetwork[];
}

export type OpenResult =
  | { ok: true; status: SameNetworkStatus }
  | { ok: false; reason: 'network-unknown' | 'port-unavailable' | 'port-fixed' | 'wsl-networking-mode'; detail: string; port?: number; mode?: string };

export interface SameNetworkListenerDeps {
  stateDir: string;
  agentName: string;
  machineName?: string;
  /** The main listener's port; the default same-network port is derived from it (defaultSameNetworkPort). */
  mainPort: number;
  /** The full app, reached only through `gate`. */
  app: (req: IncomingMessage, res: ServerResponse) => void;
  /** Returns true to pass the request on; otherwise it has already answered. */
  gate: (req: IncomingMessage, res: ServerResponse) => boolean;
  observe?: () => Promise<NetworkObservation>;
  wsl?: boolean;
  /** The first port to try when none is stored yet (tests use 0 for an OS-chosen one); default defaultSameNetworkPort(mainPort). */
  port?: number;
  /** Override the bind address (tests: 127.0.0.1). */
  bindHost?: string;
  /** Inside WSL, the networking mode (default: readWslNetworkingMode). */
  wslMode?: () => Promise<WslModeReading>;
  /** Inside WSL, WSL's own NAT address (default: read live from the route table; a shape check only). */
  wslNatAddress?: () => string | null;
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

export interface OpenForOwnerOptions {
  port?: number;
  /** May the stored port move? A function is asked inside the serialized open, when the port moves. */
  mayMovePort?: boolean | (() => boolean);
  windowsAppHandlesNetworkRule?: boolean;
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
  /** Owner actions (open, allow, close) run one at a time, in the order asked. */
  private ownerQueue: Promise<unknown> = Promise.resolve();
  /** Whether this listener limits each caller address itself (decided with the bind). */
  private limitPerAddress = true;
  /** A definite WSL mode reading: the mode cannot change while this WSL (and so this process) runs. */
  private wslModeCache: WslModeReading | null = null;
  private lastWslMode: WslModeReading | null = null;
  /** A periodic reconcile is waiting in the owner queue. */
  private tickQueued = false;
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
          ...(typeof raw.name === 'string' && /^[a-z0-9-]{1,63}$/.test(raw.name) ? { name: raw.name } : {}), allowed: raw.allowed.filter((a) => a && typeof a.id === 'string').slice(0, 16), ...(raw.openedAt ? { openedAt: raw.openedAt } : {}),
          ...(raw.windowsAppNetworkRule === true ? { windowsAppNetworkRule: true } : {}) };
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

  /** The port the next open will use when the caller asks for none. */
  preferredPort(): number { return this.state.port ?? this.deps.port ?? defaultSameNetworkPort(this.deps.mainPort); }

  /** The pinned value, available once the identity was loaded (the listener opened at least once). */
  spkiHash(): string | null { return this.identity?.spkiHash ?? null; }

  listening(): boolean { return this.server !== null && this.server.listening; }

  status(): SameNetworkStatus {
    const obs = this.lastObservation;
    return {
      wanted: this.state.open, listening: this.listening(), held: this.state.open ? this.held : null,
      host: this.host(), name: this.name, port: this.boundPort ?? this.state.port, preferredPort: this.preferredPort(), bind: this.boundHost,
      spkiHash: this.spkiHash(), observer: this.wsl ? 'windows-app' : 'agent', wslMode: this.wsl ? this.lastWslMode : null,
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
   *
   * `port`: the caller asks for this exact port (the Windows app checked it is free on Windows). It
   * is taken only when no port is stored yet, when it is the stored one, or when `mayMovePort` (no
   * phone is paired on the home address, so no stored `<name>.local:<port>` breaks). An asked-for
   * port is never swapped for another: if it cannot be listened on, the open fails and the earlier
   * port is kept.
   *
   * `mayMovePort` may be a function: it is then asked inside this serialized open, at the moment the
   * port moves (after every wait), so a phone that paired on the stored port while this open waited
   * its turn is seen (GPT review 3). The old listener stops taking requests in that same step.
   */
  openForOwner(opts: OpenForOwnerOptions = {}): Promise<OpenResult> {
    return this.serial(() => this.openForOwnerNow(opts));
  }

  /** Run an owner action after every one asked before it has finished (a failed one does not block the next). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ownerQueue.then(fn, fn);
    this.ownerQueue = run.catch(() => { /* @silent-fallback-ok — the caller of this action gets its error; the queue only orders */ });
    return run;
  }

  /**
   * Inside WSL, whether the home address could open now, and where it would bind. Read before anything
   * is recorded or spent. Outside WSL (or with a test bind override) there is nothing to refuse here.
   */
  async wslPlan(windowsAppHandlesNetworkRule: boolean): Promise<WslBindPlan | null> {
    if (!this.wsl || this.deps.bindHost) return null;
    let reading = this.wslModeCache;
    if (!reading) {
      reading = await (this.deps.wslMode ?? (() => readWslNetworkingMode()))();
      if (reading.mode !== 'unknown') this.wslModeCache = reading;
    }
    this.lastWslMode = reading;
    const nat = reading.mode === 'nat' ? this.wslNat() : null;
    return wslBindPlan(reading, nat, windowsAppHandlesNetworkRule);
  }

  private async openForOwnerNow(opts: OpenForOwnerOptions): Promise<OpenResult> {
    const asked = opts.port;
    const before = this.state.port;
    const mayMove = (): boolean => (typeof opts.mayMovePort === 'function' ? opts.mayMovePort() : opts.mayMovePort === true);
    const portFixed = (port: number): OpenResult => ({ ok: false, reason: 'port-fixed', port, detail: `A phone is paired on this agent's home address at port ${port}, so its port cannot change. Use port ${port}.` });
    if (asked !== undefined && before !== null && asked !== before && !mayMove()) return portFixed(before);
    const obs = await this.observeNow();
    if (obs.kind === 'unknown') return { ok: false, reason: 'network-unknown', detail: `This computer cannot tell which network it is on (${obs.reason}), so the home address stays closed.` };
    const declared = opts.windowsAppHandlesNetworkRule === true;
    const plan = await this.wslPlan(declared);
    if (plan && !plan.ok) {
      featureEvidence.record(FEATURE, { kind: 'held', reason: `WSL networking mode refused: ${plan.mode}` });
      return { ok: false, reason: 'wsl-networking-mode', mode: plan.mode, detail: `The home address stays closed: ${plan.reason}.` };
    }
    // Moving: asked again now, after every wait above, and in the same synchronous step the old
    // listener stops taking requests (a redeem is synchronous from its code to its pending phone, so a
    // phone either paired before this check and is seen by it, or reaches no listener on the old port).
    if (asked !== undefined && asked !== before) {
      const stored = this.state.port;
      if (stored !== null && stored !== asked && !mayMove()) return portFixed(stored);
      const stopping = this.stopServer();
      this.state.port = asked;
      await stopping;
    }
    if (this.wsl) this.state.windowsAppNetworkRule = declared;
    this.allowObservation(obs);
    this.state.open = true;
    this.state.name = this.name;
    this.state.openedAt = new Date(this.now()).toISOString();
    this.writeState();
    await this.reconcile();
    // A reconcile already running when this began (the 15-second tick) is the one joined above, and it
    // may have read the earlier wish or bound the earlier port (and stored it back). Settle once more.
    if (asked !== undefined && this.state.port !== asked) { this.state.port = asked; this.writeState(); }
    if (!this.listening() || (asked !== undefined && this.boundPort !== asked)) await this.reconcile();
    if (!this.listening() || (asked !== undefined && this.boundPort !== asked)) {
      if (asked !== undefined && asked !== before) {
        // Back to the earlier port (and listening on it again, when one was stored).
        this.state.port = before; this.writeState();
        if (before !== null) await this.reconcile();
      }
      return { ok: false, reason: 'port-unavailable', ...(asked !== undefined ? { port: asked } : {}), detail: asked !== undefined
        ? `The home address could not start on port ${asked} on this computer. Another program may be using it.`
        : 'The home address could not start on this computer. Another program may be using its port.' };
    }
    featureEvidence.record(FEATURE, { kind: 'fired', reason: 'opened by the owner at the computer', context: { observer: obs.kind === 'delegated' ? 'windows-app' : 'agent' } });
    return { ok: true, status: this.status() };
  }

  /** The owner allowed the current network at the computer (one tap, after the fresh check). */
  allowCurrentNetwork(): Promise<{ ok: boolean; status: SameNetworkStatus; detail?: string }> {
    return this.serial(() => this.allowCurrentNetworkNow());
  }

  private async allowCurrentNetworkNow(): Promise<{ ok: boolean; status: SameNetworkStatus; detail?: string }> {
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

  /**
   * Close the home address if nothing uses it, judged INSIDE the owner queue (GPT review 4): a close asked
   * for while another setup's open waits its turn runs after that open, and then sees the new setup.
   * Returns whether it closed.
   */
  closeIfUnused(isUnused: () => boolean): Promise<boolean> {
    return this.serial(async () => {
      if (!this.state.open || !isUnused()) return false;
      await this.closeNow();
      return true;
    });
  }

  /** The owner closed the home address. Phones paired on it can no longer reach the agent. */
  close(): Promise<void> {
    return this.serial(() => this.closeNow());
  }

  private async closeNow(): Promise<void> {
    this.state.open = false;
    delete this.state.windowsAppNetworkRule;
    this.writeState();
    if (this.reconciling) await this.reconciling.catch(() => { /* @silent-fallback-ok — closing below either way */ });
    await this.stopServer();
    this.held = null;
    featureEvidence.record(FEATURE, { kind: 'fired', reason: 'closed by the owner' });
  }

  /** Boot: reopen only if the owner had asked for it and the network is an allowed one. */
  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { this.tick(); }, RECONCILE_MS);
    this.timer.unref?.();
    await this.serial(() => this.reconcile(true));
  }

  /**
   * The periodic reconcile runs in the owner queue, so an owner action never joins a tick that read
   * the state before it (GPT review 3). At most one tick waits in the queue at a time.
   */
  private tick(): void {
    if (this.tickQueued || this.stopped) return;
    this.tickQueued = true;
    void this.serial(async () => { this.tickQueued = false; await this.reconcile(true); });
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
          delete this.state.windowsAppNetworkRule;
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
        let bind: string | null; let limit: boolean;
        if (this.deps.bindHost) {
          // A test override. Loopback there has one caller address (the test), so no per-address limit.
          bind = this.deps.bindHost; limit = bind !== '127.0.0.1';
        } else if (this.wsl) {
          const plan = await this.wslPlan(this.state.windowsAppNetworkRule === true);
          if (!plan || !plan.ok) {
            // Not provably NAT, or mirrored without the Windows app's word: closed.
            this.held = 'wsl-networking-mode';
            if (this.listening()) featureEvidence.record(FEATURE, { kind: 'held', reason: 'closed: WSL networking mode' });
            await this.stopServer();
            return;
          }
          bind = plan.bind; limit = plan.perAddressLimit;
        } else {
          bind = obs.kind === 'observed' ? obs.network.address : null; limit = true;
        }
        if (!bind) { this.held = 'network-unknown'; await this.stopServer(); return; }
        if (this.listening() && this.boundHost === bind && this.limitPerAddress === limit && (this.state.port === null || this.boundPort === this.state.port)) { this.held = null; return; }
        await this.stopServer();
        this.limitPerAddress = limit;
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

  private wslNat(): string | null {
    if (this.deps.wslNatAddress) return this.deps.wslNatAddress();
    try { return wslNatAddress(fs.readFileSync('/proc/net/route', 'utf8'), os.networkInterfaces()); } catch { return null; } // @silent-fallback-ok — unreadable means no NAT address: the listener stays closed
  }

  /** Whether a new connection from `addr` is let through the per-address limit (where this listener applies it). */
  perAddressOk(addr: string): boolean {
    // Only where the bind plan says another program limits each real caller (WSL NAT: every caller
    // arrives from the pass-through's one address), or a test's loopback override. Never in mirrored mode.
    if (!this.limitPerAddress) return true;
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
    });
    const handle = (req: IncomingMessage, res: ServerResponse, expectsContinue: boolean): void => {
      res.setHeader('Cache-Control', 'no-store');
      // Marked again here (idempotent), so the mark never depends on listener order.
      markSameNetworkSocket(req.socket);
      if (!this.deps.gate(req, res)) return;
      // `Expect: 100-continue`: the interim answer is sent only after the gate let the request through.
      if (expectsContinue) res.writeContinue();
      this.deps.app(req, res);
    };
    server.on('request', (req: IncomingMessage, res: ServerResponse) => handle(req, res, false));
    // With this listener set, Node no longer sends `100 Continue` itself before the gate has run.
    server.on('checkContinue', (req: IncomingMessage, res: ServerResponse) => handle(req, res, true));
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
    const want = this.state.port ?? this.deps.port ?? defaultSameNetworkPort(this.deps.mainPort);
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
    this.boundPort = null;
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
