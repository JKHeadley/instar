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
export function dashboardUnlockRefused(desktopOn: boolean, secure: boolean, remoteAddress: string | undefined): boolean {
  return desktopOn && !secure && !isLoopbackPeer(remoteAddress);
}
