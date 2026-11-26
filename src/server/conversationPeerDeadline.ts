import { performance } from 'node:perf_hooks';

export const CONVERSATION_PEER_DEADLINE_MS = 2000;

/** One history budget covers the signed read and any permitted legacy fallback. */
export async function withConversationPeerDeadline<T>(
  read: (signal: AbortSignal, remainingMs: () => number) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadline = performance.now() + CONVERSATION_PEER_DEADLINE_MS;
  const reason = new DOMException('Peer read deadline exceeded', 'TimeoutError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(reason);
      reject(reason);
    }, CONVERSATION_PEER_DEADLINE_MS);
  });
  try {
    return await Promise.race([timeout, read(controller.signal, () => Math.max(1, Math.ceil(deadline - performance.now())))]);
  } finally {
    clearTimeout(timer);
  }
}
