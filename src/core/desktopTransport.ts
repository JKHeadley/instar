import fs from 'node:fs';

/** A tunnel is trusted only when its connection to this server is local. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1'
    || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/**
 * Whether a dashboard PIN unlock is refused on this connection. Only an agent
 * with remote desktop on narrows unlock to a secure or local connection; the
 * console asks this before it shows a PIN box, so a box is never shown to fail.
 */
export function dashboardUnlockRefused(desktopOn: boolean, secure: boolean, remoteAddress: string | undefined, forwardedProto?: unknown, wslHost?: string | null): boolean {
  return desktopOn && !arrivedOverLocalTls(secure, remoteAddress, forwardedProto, wslHost === undefined ? wslWindowsHostAddress() : wslHost);
}

/**
 * WSL (Windows Subsystem for Linux) in NAT mode: a TLS front running on the
 * Windows side of the SAME machine (for example Tailscale serve) reaches this
 * server through Windows port forwarding, so the request arrives from the
 * Windows host's NAT address, not from loopback. That hop never leaves the
 * machine. Returns the Windows host address when this process runs under WSL,
 * else null. Cached; re-read at most once a minute (the address can change on
 * a WSL restart).
 */
let wslHostCache: { at: number; address: string | null } | null = null;
export function wslWindowsHostAddress(now = Date.now(), read: (file: string) => string = (f) => fs.readFileSync(f, 'utf8')): string | null {
  if (wslHostCache && now - wslHostCache.at < 60_000) return wslHostCache.address;
  let address: string | null = null;
  try {
    if (process.platform === 'linux' && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(read('/proc/version')))) {
      address = defaultGatewayFromProcRoute(read('/proc/net/route'));
    }
  } catch { address = null; }
  wslHostCache = { at: now, address };
  return address;
}

/** The IPv4 default gateway from /proc/net/route (little-endian hex), or null. */
export function defaultGatewayFromProcRoute(table: string): string | null {
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[1] !== '00000000') continue;
    const hex = cols[2];
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
    const bytes = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return bytes.join('.');
  }
  return null;
}

/**
 * The connection is the operator's TLS front on this same machine: a TLS
 * socket, or loopback, or (under WSL only) the Windows host forwarding a
 * request its local front received over https. A plain-http request through
 * the same Windows forwarding carries no `x-forwarded-proto: https` and is not
 * treated as secure.
 */
export function arrivedOverLocalTls(secure: boolean, remoteAddress: string | undefined, forwardedProto: unknown, wslHost: string | null = wslWindowsHostAddress()): boolean {
  if (secure || isLoopbackPeer(remoteAddress)) return true;
  if (!wslHost || forwardedProto !== 'https' || !remoteAddress) return false;
  const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
  return addr === wslHost;
}
