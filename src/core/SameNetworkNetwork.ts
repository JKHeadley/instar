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
 *     enforces the network rule (`observer: 'windows-app'`). WSL's networking mode is READ
 *     (`readWslNetworkingMode`: wslinfo, else the Windows user's .wslconfig and WSL 2's default),
 *     never inferred from an address range, and `wslBindPlan` decides the bind and fails closed. In
 *     NAT mode the listener binds to WSL's own NAT address (`wslNatAddress`), which only the PC itself
 *     can reach: measured live on 2026-11-19 (WSL 3.0.1, NAT mode, Windows 11), a listener bound to
 *     WSL's loopback is NOT reachable from Windows in NAT mode (only wildcard binds are forwarded).
 *     Mirrored mode opens only on the Windows app's word, on loopback, with the per-address limit on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
 * LAN cannot, because WSL's NAT is not exposed). This is a SHAPE check only, never the evidence of NAT
 * mode: a mirrored WSL on a 172.16-31.x home network has the same shape. The mode itself is read by
 * `readWslNetworkingMode` and decided by `wslBindPlan`. Null when the shape does not fit: the default
 * route's interface must have exactly one IPv4 address, and it and the router must both sit in
 * 172.16.0.0/12 on the same network.
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

/**
 * WSL's networking mode, read rather than guessed (identity A4 WSL bind). The modes WSL 2 knows are
 * NAT (the default), mirrored, virtioproxy and none (bridged is the older name for an external
 * switch). WSL 1 has no virtual network at all: it shares Windows' own network stack.
 */
export type WslNetworkingMode = 'nat' | 'mirrored' | 'other' | 'unknown';

export interface WslModeReading {
  mode: WslNetworkingMode;
  /** Where the answer came from. */
  source: 'wslinfo' | 'wslconfig' | 'default' | 'wsl1' | 'none';
  /** The raw value or why it is unknown (shown in status, never trusted). */
  detail: string;
}

export interface WslModeDeps {
  /** `wslinfo --networking-mode` output; rejects when the command is missing or fails. */
  wslinfo?: () => Promise<string>;
  /** /proc/version text. */
  procVersion?: () => string;
  /** The Windows user's profile folder as a Linux path (e.g. /mnt/c/Users/x), or null when unknown. */
  windowsProfile?: () => Promise<string | null>;
  readFile?: (f: string) => string;
  /** mtime (ms) of a file; throws ENOENT when it does not exist. */
  mtimeMs?: (f: string) => number;
  /** When the WSL virtual machine started (ms), or null when unreadable. */
  bootTimeMs?: () => number | null;
}

/** The mode named by a `wslinfo --networking-mode` answer or a `.wslconfig` value. */
export function parseWslMode(value: string): WslNetworkingMode | null {
  const v = value.trim().toLowerCase();
  if (v === 'nat') return 'nat';
  if (v === 'mirrored') return 'mirrored';
  if (v === 'virtioproxy' || v === 'none' || v === 'bridged') return 'other';
  return null;
}

/**
 * The `networkingMode` a `.wslconfig` sets for WSL 2: the `[wsl2]` key, else the older
 * `[experimental]` key (mirrored mode began there). Undefined when neither sets it (the default
 * applies); null when it is set to a value this code does not know (unknown, refused).
 */
export function wslconfigNetworkingMode(text: string): WslNetworkingMode | null | undefined {
  let section = '';
  const found: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const sec = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    const kv = /^([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1].toLowerCase() === 'networkingmode' && (section === 'wsl2' || section === 'experimental')) found[section] = kv[2].replace(/^["']|["']$/g, '');
  }
  const value = found.wsl2 ?? found.experimental;
  if (value === undefined) return undefined;
  return parseWslMode(value);
}

const execText = (cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, ...(opts.cwd ? { cwd: opts.cwd } : {}) }, (err, out) => (err ? reject(err) : resolve(String(out))));
});

async function defaultWindowsProfile(): Promise<string | null> {
  // Through WSL's Windows interop: cmd.exe prints %USERPROFILE%, wslpath turns it into a Linux path.
  const cmd = '/mnt/c/Windows/System32/cmd.exe';
  if (!fs.existsSync(cmd)) return null;
  const win = (await execText(cmd, ['/d', '/c', 'echo %USERPROFILE%'], { cwd: '/mnt/c' })).trim();
  if (!/^[A-Za-z]:\\/.test(win)) return null;
  const linux = (await execText('wslpath', ['-u', win])).trim();
  return linux.startsWith('/') ? linux : null;
}

/** How long before WSL's start a .wslconfig must have last changed to count as in effect (clock drift). */
export const WSLCONFIG_CLOCK_MARGIN_MS = 10 * 60_000;

function defaultBootTimeMs(): number | null {
  const up = Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
  return Number.isFinite(up) ? Date.now() - up * 1000 : null;
}

/**
 * WSL's networking mode, in order of trust:
 *  1. WSL 1 (no virtual network) is never NAT.
 *  2. `wslinfo --networking-mode` (WSL 2.0 and later): the running mode, authoritative.
 *  3. Otherwise the Windows user's `.wslconfig`: its `[wsl2] networkingMode` (or the older
 *     `[experimental]` key), else WSL 2's default, NAT. A `.wslconfig` changed after this WSL started
 *     (or within WSLCONFIG_CLOCK_MARGIN_MS before it, for clock drift) is not trusted (unknown). With
 *     no `.wslconfig` at all the mode is unknown, not the default: a file removed after a mirrored WSL
 *     started leaves no trace.
 * Anything that cannot be read is 'unknown'. Never throws.
 */
export async function readWslNetworkingMode(deps: WslModeDeps = {}): Promise<WslModeReading> {
  const read = deps.readFile ?? ((f: string) => fs.readFileSync(f, 'utf8'));
  try {
    const version = (deps.procVersion ?? (() => read('/proc/version')))();
    // WSL 2 kernels say "microsoft-standard" (and "WSL2"); WSL 1 reports Windows' build, "...-Microsoft".
    if (!/microsoft-standard|WSL2/i.test(version)) {
      return /microsoft/i.test(version) ? { mode: 'other', source: 'wsl1', detail: 'WSL 1 shares Windows\' network' } : { mode: 'unknown', source: 'none', detail: 'not a WSL kernel' };
    }
  } catch {
    return { mode: 'unknown', source: 'none', detail: 'kernel version unreadable' }; // @silent-fallback-ok — unknown keeps the home address closed
  }
  let wslinfoAnswer: string | null = null;
  try { wslinfoAnswer = await (deps.wslinfo ?? (() => execText('wslinfo', ['--networking-mode'])))(); } catch { wslinfoAnswer = null; } // @silent-fallback-ok — an older WSL without wslinfo: the .wslconfig is read next
  if (wslinfoAnswer !== null) {
    const m = parseWslMode(wslinfoAnswer);
    // wslinfo answered: that answer stands, even one this code does not know (then unknown, refused).
    return m ? { mode: m, source: 'wslinfo', detail: wslinfoAnswer.trim().slice(0, 40) } : { mode: 'unknown', source: 'wslinfo', detail: `unrecognised: ${wslinfoAnswer.trim().slice(0, 40)}` };
  }
  try {
    const profile = await (deps.windowsProfile ?? defaultWindowsProfile)();
    if (!profile) return { mode: 'unknown', source: 'none', detail: 'the Windows user folder could not be found' };
    const file = path.join(profile, '.wslconfig');
    let mtime: number;
    try { mtime = (deps.mtimeMs ?? ((f: string) => fs.statSync(f).mtimeMs))(file); } catch (err) {
      // WSL 2's default is NAT, but a missing file cannot be told from one removed after this WSL
      // started in mirrored mode (no timestamp survives a removal), so it is not trusted.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'unknown', source: 'default', detail: 'no .wslconfig and no wslinfo: the running mode cannot be read' };
      return { mode: 'unknown', source: 'none', detail: '.wslconfig unreadable' };
    }
    const boot = (deps.bootTimeMs ?? defaultBootTimeMs)();
    if (boot === null) return { mode: 'unknown', source: 'none', detail: 'WSL start time unreadable' };
    // A margin for clock drift between WSL and Windows: a file changed close to WSL's start is not trusted.
    if (mtime > boot - WSLCONFIG_CLOCK_MARGIN_MS) return { mode: 'unknown', source: 'wslconfig', detail: '.wslconfig changed after (or just before) WSL started' };
    const m = wslconfigNetworkingMode(read(file));
    // The file changed before WSL started (with a margin) and names no mode: the default, NAT, was in
    // effect at start, and a later change would have moved the file's time.
    if (m === undefined) return { mode: 'nat', source: 'default', detail: '.wslconfig sets no networkingMode: WSL 2 default' };
    if (m === null) return { mode: 'unknown', source: 'wslconfig', detail: 'unrecognised networkingMode' };
    return { mode: m, source: 'wslconfig', detail: m };
  } catch (err) {
    // @silent-fallback-ok — unknown keeps the home address closed (the safe direction); the reason is shown in status
    return { mode: 'unknown', source: 'none', detail: err instanceof Error ? err.message.slice(0, 120) : 'unreadable' };
  }
}

export type WslBindPlan =
  | { ok: true; bind: string; mode: 'nat' | 'mirrored'; perAddressLimit: boolean }
  | { ok: false; mode: WslNetworkingMode; reason: string };

/**
 * Where the listener binds inside WSL, and whether it limits each caller address itself. Fails closed:
 *  - NAT (read, not guessed) with WSL's own NAT address: bind that address. Only the PC reaches it;
 *    every caller arrives from the Windows pass-through's one address, and the pass-through limits
 *    each real caller, so the per-address limit here would count everyone as one (left to it).
 *  - mirrored: WSL shares the PC's addresses, so a bind on the LAN address would be reachable from
 *    the network directly. Refused, unless the Windows app said it handles the network rule; then
 *    bind WSL's loopback (shared with Windows in mirrored mode, never the LAN) and STILL apply the
 *    per-address limit here.
 *  - anything else (unknown, WSL 1, virtioproxy, none, bridged): refused.
 */
export function wslBindPlan(reading: WslModeReading, natAddress: string | null, windowsAppHandlesNetworkRule: boolean): WslBindPlan {
  if (reading.mode === 'nat') {
    if (!natAddress) return { ok: false, mode: 'nat', reason: 'WSL is in NAT mode but its own NAT address could not be read' };
    return { ok: true, bind: natAddress, mode: 'nat', perAddressLimit: false };
  }
  if (reading.mode === 'mirrored') {
    if (!windowsAppHandlesNetworkRule) return { ok: false, mode: 'mirrored', reason: 'WSL shares this PC\'s network (mirrored mode), and no Windows app said it handles the network rule' };
    return { ok: true, bind: '127.0.0.1', mode: 'mirrored', perAddressLimit: true };
  }
  return { ok: false, mode: reading.mode, reason: reading.mode === 'unknown' ? `WSL's networking mode could not be read (${reading.detail})` : `WSL's networking mode is not supported here (${reading.detail})` };
}

/** This computer's current non-internal IPv4 addresses: hints only, never trusted. */
export function addressHints(interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out.slice(0, 4);
}
