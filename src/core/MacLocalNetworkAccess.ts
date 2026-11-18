/**
 * macOS Local Network access, detected and named (spun off from Accept all round 3, 2026-11-17).
 *
 * macOS 15+ gates every connection to the home network (RFC 1918, link-local) behind the
 * "Local Network" privacy permission, and the permission is held per program file. A server
 * started in the background (a LaunchAgent, or anything that outlives its ssh/terminal session)
 * is judged on its OWN node executable, and macOS cannot show it the permission prompt, so an
 * unapproved node fails every home-network connection at once with EHOSTUNREACH. The same
 * address answers from a terminal, from ssh, and from Apple's own tools, so the failure reads
 * like a dead peer. Seen on the M5: the server's node path had never been approved while a
 * byte-identical node at another path had, and conversation sync to the Studio flapped for hours.
 *
 * This is a SIGNAL, never an authority: it changes no routing, refuses nothing, and retries
 * nothing. It listens on undici's `undici:client:connectError` channel (every fetch in the
 * process, so no call site can be missed), and when a home-network connect fails with
 * EHOSTUNREACH on macOS it asks `/usr/bin/curl` (an Apple tool macOS does not gate) whether the
 * same address accepts a TCP connection. Only "node was refused but curl connected" is the
 * verdict `denied`; anything else stays unknown and says nothing. A denied verdict is reported
 * through the DegradationReporter with the fix in plain words, re-reported while it persists so
 * it stays on /health, and quietly ages out once the permission is given.
 */

import { execFile } from 'node:child_process';
import diagnosticsChannel from 'node:diagnostics_channel';
import fs from 'node:fs';

/** A home-network host macOS Local Network privacy gates (IPv4 private and link-local, IPv6 ULA and link-local). */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (h.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  return h.endsWith('.local');
}

export type ReachVerdict = 'reachable' | 'unreachable' | 'unknown';

/**
 * Ask Apple's curl whether the address accepts a TCP connection. `%{time_connect}` above zero
 * means the connection was made (whatever the HTTP or TLS outcome after it).
 */
export function curlReach(host: string, port: number, timeoutMs = 4000): Promise<ReachVerdict> {
  return new Promise((resolve) => {
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const secs = String(Math.max(1, Math.round(timeoutMs / 1000)));
    try {
      execFile('/usr/bin/curl', ['-s', '-k', '-o', '/dev/null', '--connect-timeout', secs, '-m', secs, '-w', '%{time_connect}', `http://${h}:${port}/`],
        { timeout: timeoutMs + 2000 }, (_err, stdout) => {
          const t = Number.parseFloat(String(stdout ?? '').trim());
          if (Number.isFinite(t)) resolve(t > 0 ? 'reachable' : 'unreachable');
          else resolve('unknown');
        });
    } catch {
      resolve('unknown'); // @silent-fallback-ok — no curl means no verdict, never a denial
    }
  });
}

export interface MacLocalNetworkReport {
  feature: string;
  primary: string;
  fallback: string;
  reason: string;
  impact: string;
}

export interface MacLocalNetworkDeps {
  platform?: NodeJS.Platform;
  /** The program macOS judges: this process's own executable, symlinks resolved. */
  execPath?: string;
  now?: () => number;
  confirm?: (host: string, port: number) => Promise<ReachVerdict>;
  report: (event: MacLocalNetworkReport) => void;
  log?: (line: string) => void;
}

export interface MacLocalNetworkState {
  platform: string;
  execPath: string;
  verdict: 'denied' | 'unknown';
  lastDeniedHost: string | null;
  lastDeniedAt: string | null;
  checks: number;
}

/** Re-check the same host at most this often. */
const CONFIRM_EVERY_MS = 10 * 60_000;
/** Re-report a persisting denial this often, so it stays inside /health's 30-minute window. */
const REPORT_EVERY_MS = 25 * 60_000;

export const MAC_LOCAL_NETWORK_FEATURE = 'MacLocalNetwork';

export function localNetworkReport(execPath: string, host: string): MacLocalNetworkReport {
  return {
    feature: MAC_LOCAL_NETWORK_FEATURE,
    primary: 'Reaching your other machines over your home network',
    fallback: 'Tailscale or Cloudflare routes where they are allowed',
    reason: `macOS Local Network privacy refuses this agent's program (${execPath}) a connection to ${host}, an address on your home network that answers other programs on this Mac. A background-started server cannot be shown the permission prompt, so macOS refuses it silently.`,
    impact: `This Mac can lose touch with your other machines (conversation sync, machine handover) whenever the home-network route is the one that works. To fix it, on this Mac open System Settings, then Privacy & Security, then Local Network, and turn on "node" (the program at ${execPath}). This warning clears by itself once a home-network call gets through. If "node" is not in that list, ask me and I will move the agent to a copy of node that macOS already allows`,
  };
}

export class MacLocalNetworkAccessMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly execPath: string;
  private readonly now: () => number;
  private readonly confirm: (host: string, port: number) => Promise<ReachVerdict>;
  private readonly report: (event: MacLocalNetworkReport) => void;
  private readonly log: (line: string) => void;
  private readonly lastConfirmAt = new Map<string, number>();
  private inFlight = false;
  private lastReportAt = 0;
  private state: MacLocalNetworkState;

  constructor(deps: MacLocalNetworkDeps) {
    this.platform = deps.platform ?? process.platform;
    this.execPath = deps.execPath ?? resolveExecPath(process.execPath);
    this.now = deps.now ?? Date.now;
    this.confirm = deps.confirm ?? ((h, p) => curlReach(h, p));
    this.report = deps.report;
    this.log = deps.log ?? (() => {});
    this.state = { platform: this.platform, execPath: this.execPath, verdict: 'unknown', lastDeniedHost: null, lastDeniedAt: null, checks: 0 };
  }

  getState(): MacLocalNetworkState {
    return { ...this.state };
  }

  /**
   * One failed connect. Returns the check's promise (tests await it); the channel subscriber
   * ignores it. Never throws.
   */
  async observe(host: string | undefined, port: number | string | undefined, code: string | undefined): Promise<'ignored' | 'denied' | 'not-denied'> {
    if (this.platform !== 'darwin' || code !== 'EHOSTUNREACH' || !host || !isLocalNetworkHost(host)) return 'ignored';
    const p = Number(port) || 80;
    const key = `${host}:${p}`;
    const nowMs = this.now();
    if (this.inFlight) return 'ignored';
    const last = this.lastConfirmAt.get(key);
    if (last !== undefined && nowMs - last < CONFIRM_EVERY_MS) {
      // Already confirmed recently: a persisting denial is re-reported on its own cadence.
      if (this.state.verdict === 'denied' && this.state.lastDeniedHost === host) this.maybeReport(host, nowMs);
      return 'ignored';
    }
    this.lastConfirmAt.set(key, nowMs);
    if (this.lastConfirmAt.size > 64) this.lastConfirmAt.delete(this.lastConfirmAt.keys().next().value as string);
    this.inFlight = true;
    try {
      this.state.checks += 1;
      const verdict = await this.confirm(host, p).catch(() => 'unknown' as const); // @silent-fallback-ok — an unreadable check is no verdict
      if (verdict !== 'reachable') return 'not-denied';
      this.state.verdict = 'denied';
      this.state.lastDeniedHost = host;
      this.state.lastDeniedAt = new Date(nowMs).toISOString();
      this.log(`macOS Local Network access refused for ${this.execPath} (${host} answers Apple's curl)`);
      this.maybeReport(host, nowMs);
      return 'denied';
    } finally {
      this.inFlight = false;
    }
  }

  /** A successful home-network connect: the permission is in place now. */
  noteConnected(host: string | undefined): void {
    if (!host || !isLocalNetworkHost(host) || this.state.verdict !== 'denied') return;
    this.state.verdict = 'unknown';
    this.lastReportAt = 0;
    this.lastConfirmAt.clear();
    this.log(`macOS Local Network access works again for ${this.execPath} (${host} connected)`);
  }

  private maybeReport(host: string, nowMs: number): void {
    if (this.lastReportAt && nowMs - this.lastReportAt < REPORT_EVERY_MS) return;
    this.lastReportAt = nowMs;
    try {
      this.report(localNetworkReport(this.execPath, host));
    } catch {
      /* @silent-fallback-ok — the reporter failing must never break a network call */
    }
  }
}

function resolveExecPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p; // @silent-fallback-ok — an unresolvable path is still the best name for the program
  }
}

let active: MacLocalNetworkAccessMonitor | null = null;
let subscribed = false;

/** The process-wide monitor, for status reads. Null until installed (and always on non-macOS). */
export function getMacLocalNetworkMonitor(): MacLocalNetworkAccessMonitor | null {
  return active;
}

interface ConnectMessage {
  connectParams?: { hostname?: string; host?: string; port?: number | string };
  error?: { code?: string };
}

/**
 * Install the process-wide listener (macOS only; a no-op elsewhere). Idempotent.
 */
export function installMacLocalNetworkMonitor(deps: MacLocalNetworkDeps): MacLocalNetworkAccessMonitor | null {
  if ((deps.platform ?? process.platform) !== 'darwin') return null;
  active = new MacLocalNetworkAccessMonitor(deps);
  if (!subscribed) {
    subscribed = true;
    diagnosticsChannel.subscribe('undici:client:connectError', (message) => {
      const m = message as ConnectMessage;
      void active?.observe(m.connectParams?.hostname ?? m.connectParams?.host, m.connectParams?.port, m.error?.code);
    });
    diagnosticsChannel.subscribe('undici:client:connected', (message) => {
      const m = message as ConnectMessage;
      active?.noteConnected(m.connectParams?.hostname ?? m.connectParams?.host);
    });
  }
  return active;
}
