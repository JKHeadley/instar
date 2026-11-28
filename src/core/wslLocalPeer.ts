/**
 * identity-security-piece1g: under WSL (NAT mode), a Windows browser that reaches the agent through a
 * Windows-side forward arrives from the Windows host's gateway address, not loopback. The approved
 * umbrella (§4.6) accepts that address for redeeming the one-time local link, because the link's
 * single-use secret, not the address, is the credential. Spec: docs/specs/identity-security-piece1g-wsl-local-link.md
 *
 * Accepted only when ALL hold: WSL in NAT mode (confirmed positively), the peer is exactly the gateway,
 * the request arrived on WSL's own default-route address (not 127.0.0.1), with the gateway inside that
 * address's subnet. Headers and origin are checked by the caller.
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { Socket } from 'node:net';
import { mayBeLocalArrival } from './requestArrival.js';
import { defaultGatewayFromProcRoute } from './desktopTransport.js';

export interface WslNetProbe {
  isWsl: () => boolean;
  /** /proc/net/route contents (throws when unreadable). */
  routeTable: () => string;
  /** /proc/net/arp contents (throws when unreadable). */
  arpTable: () => string;
  /** IPv4 addresses of a named interface. */
  ifaceV4: (name: string) => Array<{ address: string; cidr: string | null }>;
  /** `wslinfo --networking-mode`, cached by the caller; null when not known (yet). */
  networkingMode: () => string | null;
}

const HYPERV_MAC_PREFIX = '00:15:5d';

/** The default route's interface name (column 0 of /proc/net/route), or null. */
export function defaultRouteInterface(table: string): string | null {
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 3 && cols[1] === '00000000') return cols[0] || null;
  }
  return null;
}

/** The MAC address /proc/net/arp lists for an IPv4 address, lowercased, or null. */
export function arpMacFor(table: string, ip: string): string | null {
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === ip && cols.length >= 4) return cols[3].toLowerCase();
  }
  return null;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Whether `ip` lies inside `cidr` (a.b.c.d/n). */
export function inCidr(ip: string, cidr: string | null): boolean {
  if (!cidr) return false;
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip); const b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 1 || bits > 32) return false;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (a & mask) === (b & mask);
}

const strip = (a: string | undefined): string => (a ?? '').replace(/^::ffff:/, '');

/** NAT mode, confirmed positively: wslinfo says nat, else the gateway's MAC is Hyper-V's. */
export function natModeConfirmed(probe: WslNetProbe, gateway: string): boolean {
  const mode = probe.networkingMode();
  if (mode !== null) return mode.trim().toLowerCase() === 'nat';
  try { return (arpMacFor(probe.arpTable(), gateway) ?? '').startsWith(HYPERV_MAC_PREFIX); } catch { return false; /* @silent-fallback-ok: unconfirmable means not accepted */ }
}

/** The socket facts that decide the gateway rule (headers and origin are the caller's). */
export function wslGatewayPeer(socket: Partial<Socket>, probe: WslNetProbe = defaultWslNetProbe()): boolean {
  try {
    if (!mayBeLocalArrival({ socket })) return false;
    const local = strip(socket.localAddress);
    if (!probe.isWsl()) return false;
    const table = probe.routeTable();
    const gateway = defaultGatewayFromProcRoute(table);
    const iface = defaultRouteInterface(table);
    if (!gateway || !iface) return false;
    if (strip(socket.remoteAddress) !== gateway) return false;
    const own = probe.ifaceV4(iface).find((a) => a.address === local);
    if (!own || !inCidr(gateway, own.cidr)) return false;
    return natModeConfirmed(probe, gateway);
  } catch {
    return false; // @silent-fallback-ok: anything unreadable means the gateway is not accepted (piece 1a's loopback rule still applies)
  }
}

let modeCache: { at: number; mode: string | null } | null = null;
let modeProbeRunning = false;
/** `wslinfo --networking-mode`, probed asynchronously and cached 10 minutes; null until known or when absent. */
function cachedNetworkingMode(): string | null {
  const now = Date.now();
  if ((!modeCache || now - modeCache.at > 600_000) && !modeProbeRunning) {
    modeProbeRunning = true;
    execFile('wslinfo', ['--networking-mode'], { timeout: 5_000 }, (err, stdout) => {
      modeProbeRunning = false;
      modeCache = { at: Date.now(), mode: err ? null : String(stdout).trim() || null };
    });
  }
  return modeCache?.mode ?? null;
}

export function defaultWslNetProbe(): WslNetProbe {
  return {
    isWsl: () => process.platform === 'linux' && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))),
    routeTable: () => fs.readFileSync('/proc/net/route', 'utf8'),
    arpTable: () => fs.readFileSync('/proc/net/arp', 'utf8'),
    ifaceV4: (name) => (os.networkInterfaces()[name] ?? []).filter((a) => a.family === 'IPv4').map((a) => ({ address: a.address, cidr: a.cidr ?? null })),
    networkingMode: cachedNetworkingMode,
  };
}
