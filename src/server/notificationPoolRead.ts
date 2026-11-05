import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import type { RouteContext } from './routes.js';
import type { QuietNotification } from '../messaging/QuietNotificationStore.js';
export type NotificationPoolContext = Pick<RouteContext, 'config' | 'resolvePeerUrls' | 'recordRopeResult'>;
/** Bounded, credential-guarded pull; absent peers remain explicitly unknown. */
export async function readPeerNotifications(ctx: NotificationPoolContext, query: URLSearchParams, cursors: Record<string, string> = {}): Promise<{ items: QuietNotification[]; unavailable: string[]; unread: number }> {
  const items: QuietNotification[] = [], unavailable: string[] = [];
  let unread = 0;
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
  await Promise.all(peers.map(async peer => {
    if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: peer.kind }, allow).ok) { unavailable.push(peer.machineId); return; }
    try {
      const peerQuery = new URLSearchParams(query); if (cursors[peer.machineId]) peerQuery.set('before', cursors[peer.machineId]);
      const response = await poolPeerFetch(ctx.recordRopeResult ?? undefined, peer, '/notifications/quiet?' + peerQuery.toString(), {
        headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(1800),
      });
      if (!response.ok) throw new Error('Peer unavailable');
      const text = await response.text(); if (text.length > 1024 * 1024) throw new Error('Peer page too large');
      const data = JSON.parse(text);
      unread += Math.min(1000000000, Math.max(0, Number(data.unread) || 0));
      for (const raw of Array.isArray(data.items) ? data.items.slice(0, 200) : []) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.text !== 'string' || typeof raw.category !== 'string' || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) continue;
        if (query.get('category') && raw.category !== query.get('category') || query.get('topicId') && raw.topicId !== Number(query.get('topicId')) || query.get('unread') === 'true' && raw.read === true) continue;
        items.push({ id: raw.id.slice(0, 200), machineId: peer.machineId, category: raw.category.slice(0, 80), sourceContext: String(raw.sourceContext ?? '').slice(0, 160),
          text: raw.text.slice(0, 16000), count: Math.min(1000000000, Math.max(1, Number(raw.count) || 1)), read: raw.read === true,
          createdAt: raw.createdAt, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : raw.createdAt,
          ...(Number.isSafeInteger(raw.topicId) ? { topicId: raw.topicId } : {}),
        });
      }
    } catch { unavailable.push(peer.machineId); }
  }));
  return { items, unavailable, unread };
}
