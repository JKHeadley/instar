/** Disk reads share transport admission and health, preserving resolver URL keys. */
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from '../../server/poolPeerFetch.js';

export interface DiskStewardPeer extends Omit<PoolPeerTarget, 'url'> {
  url: string | null;
  allowed: boolean;
  refusals?: unknown[];
}

/** Return the registered address that answered, so a subsequent ack needs only one attempt. */
export async function readPeerDiskStatus(
  record: RopeResultRecorder | undefined,
  peer: PoolPeerTarget,
  authToken: string | undefined,
): Promise<{ response: Response; readUrl: string }> {
  const route = '/disk-steward';
  let readUrl = peer.url;
  const response = await poolPeerFetch(record, peer, route, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  }, async (input, init) => {
    // The helper passes the raw registered base plus route. Normalize only the
    // actual dial; comparison and health reporting retain the resolver's raw key.
    const base = String(input).slice(0, -route.length);
    const result = await fetch(`${base.replace(/\/+$/, '')}${route}`, init);
    if (result.ok) readUrl = base;
    return result;
  });
  return { response, readUrl };
}
