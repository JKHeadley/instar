/** A tunnel is trusted only when its connection to this server is local. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1'
    || address.startsWith('127.') || address.startsWith('::ffff:127.');
}
