/**
 * Which network this computer is on, as far as it can tell (identity A4, point 4;
 * docs/specs/identity-security-piece3e-same-network-first-phone.md §3.4).
 *
 * The same-network listener is open only on a network connection the owner allowed at the computer.
 * A network is "the same" only when its interface, default router and address range all match a
 * recorded one. That does not prove a network is the owner's home (a network can be made to look
 * like another); it keeps the listener from following a laptop onto a cafe, office or VPN network
 * that looks different. Anything that cannot be read counts as "unknown", and unknown keeps the
 * listener closed.
 *
 * What is read, exactly:
 *   - Linux (not WSL): the default route in /proc/net/route (interface + router), and that
 *     interface's IPv4 address and netmask from os.networkInterfaces().
 *   - macOS: `route -n get default` (interface + router), and the same interface table.
 *   - WSL: nothing of the PC's networks. The Windows app, which owns the pass-through, observes and
 *     enforces the network rule (`observer: 'windows-app'`). The listener binds to WSL's own NAT
 *     address (`wslNatAddress`), which only the PC itself can reach: measured live on 2026-11-19
 *     (WSL 3.0.1, NAT mode, Windows 11), a listener bound to WSL's loopback is NOT reachable from
 *     Windows (only wildcard binds are forwarded), so loopback would leave the pass-through nothing
 *     to forward to. Outside NAT mode (mirrored, unknown) there is no such address and it stays closed.
 */
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

export interface ObservedNetwork {
  /** The interface the default route uses (e.g. `wlan0`, `en0`). */
  iface: string;
  /** The default router's IPv4 address. */
  router: string;
  /** This computer's IPv4 address on that interface. */
  address: string;
  /** The address range, `network/prefix` (e.g. `192.168.1.0/24`). */
  range: string;
}

export type NetworkObservation =
  | { kind: 'observed'; network: ObservedNetwork }
  | { kind: 'delegated'; observer: 'windows-app' }
  | { kind: 'unknown'; reason: string };

/** The identity two observations must share for the listener to open by itself. */
export function networkIdOf(n: ObservedNetwork): string {
  return `${n.iface}|${n.router}|${n.range}`;
}

export function isWsl(read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(read('/proc/version')); } catch { return false; } // @silent-fallback-ok — unreadable /proc means not provably WSL
}

/** The IPv4 default route's interface and router from a /proc/net/route table, or null. */
export function defaultRouteFromProcRoute(table: string): { iface: string; router: string } | null {
  let best: { iface: string; router: string; metric: number } | null = null;
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8 || cols[1] !== '00000000' || cols[7] !== '00000000') continue;
    // RTF_UP (0x1) and RTF_GATEWAY (0x2) both set: a live default route through a router.
    if ((parseInt(cols[3], 16) & 0x3) !== 0x3) continue;
    const hex = cols[2];
    if (!/^[0-9A-Fa-f]{8}$/.test(hex) || hex === '00000000') continue;
    const router = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
    const metric = Number(cols[6]) || 0;
    if (best && metric === best.metric && best.iface !== cols[0]) return null; // two equal default routes: cannot tell which network
    if (!best || metric < best.metric) best = { iface: cols[0], router, metric };
  }
  return best ? { iface: best.iface, router: best.router } : null;
}

/** `route -n get default` output → interface and router, or null. */
export function defaultRouteFromMacRoute(text: string): { iface: string; router: string } | null {
  const gw = /^\s*gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/m.exec(text);
  const ifc = /^\s*interface:\s*([A-Za-z0-9._-]+)\s*$/m.exec(text);
  return gw && ifc ? { iface: ifc[1], router: gw[1] } : null;
}

function prefixOf(netmask: string): number | null {
  const parts = netmask.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  const bits = parts.map((p) => p.toString(2).padStart(8, '0')).join('');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : null;
}

/** `address/netmask` → the network range `a.b.c.d/prefix`, or null. */
export function rangeOf(address: string, netmask: string): string | null {
  const prefix = prefixOf(netmask);
  if (prefix === null) return null;
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4) return null;
  return `${a.map((v, i) => v & m[i]).join('.')}/${prefix}`;
}

export interface ObserveDeps {
  platform?: NodeJS.Platform;
  wsl?: boolean;
  readFile?: (f: string) => string;
  interfaces?: () => ReturnType<typeof os.networkInterfaces>;
  macRoute?: () => Promise<string>;
}

function fromRoute(route: { iface: string; router: string } | null, interfaces: ReturnType<typeof os.networkInterfaces>): NetworkObservation {
  if (!route) return { kind: 'unknown', reason: 'no default route' };
  const addrs = (interfaces[route.iface] ?? []).filter((a) => a.family === 'IPv4' && !a.internal);
  if (addrs.length !== 1) return { kind: 'unknown', reason: addrs.length === 0 ? 'no address on the default interface' : 'more than one address on the default interface' };
  const range = rangeOf(addrs[0].address, addrs[0].netmask);
  if (!range) return { kind: 'unknown', reason: 'unreadable netmask' };
  return { kind: 'observed', network: { iface: route.iface, router: route.router, address: addrs[0].address, range } };
}

/** What this computer can tell about its current network. Never throws. */
export async function observeNetwork(deps: ObserveDeps = {}): Promise<NetworkObservation> {
  const platform = deps.platform ?? process.platform;
  const interfaces = (deps.interfaces ?? os.networkInterfaces)();
  try {
    if (platform === 'linux') {
      if (deps.wsl ?? isWsl(deps.readFile)) return { kind: 'delegated', observer: 'windows-app' };
      const table = (deps.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8')))('/proc/net/route');
      return fromRoute(defaultRouteFromProcRoute(table), interfaces);
    }
    if (platform === 'darwin') {
      const text = await (deps.macRoute ?? (() => new Promise<string>((resolve, reject) => {
        execFile('route', ['-n', 'get', 'default'], { timeout: 3_000, maxBuffer: 64 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out))));
      })))();
      return fromRoute(defaultRouteFromMacRoute(text), interfaces);
    }
    return { kind: 'unknown', reason: `not read on ${platform}` };
  } catch (err) {
    // @silent-fallback-ok — an unreadable network is 'unknown', which keeps the listener closed (the safe direction); the reason is surfaced in its status
    return { kind: 'unknown', reason: err instanceof Error ? err.message.slice(0, 120) : 'unreadable' };
  }
}

function inWslNatRange(ip: string): boolean {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p[0] === 172 && p[1] >= 16 && p[1] <= 31;
}

/**
 * Inside WSL in NAT mode: WSL's own address on its private virtual network (the PC can reach it; the
 * LAN cannot, because WSL's NAT is not exposed). Null when not provably NAT mode: the default route's
 * interface must have exactly one IPv4 address, it and the router must both sit in 172.16.0.0/12 and
 * share their first three octets' /20 network. In mirrored mode the address is the LAN's, so null.
 */
export function wslNatAddress(table: string, interfaces: ReturnType<typeof os.networkInterfaces>): string | null {
  const route = defaultRouteFromProcRoute(table);
  if (!route) return null;
  const addrs = (interfaces[route.iface] ?? []).filter((a) => a.family === 'IPv4' && !a.internal);
  if (addrs.length !== 1) return null;
  const a = addrs[0];
  if (!inWslNatRange(a.address) || !inWslNatRange(route.router)) return null;
  const net = rangeOf(a.address, a.netmask);
  const rnet = rangeOf(route.router, a.netmask);
  return net && net === rnet ? a.address : null;
}

/** This computer's current non-internal IPv4 addresses: hints only, never trusted. */
export function addressHints(interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out.slice(0, 4);
}
