/**
 * createThreadMessageRecorder — the ONE production composition of the canonical
 * thread-log recorder (server.ts calls it; the relay-ingress E2E calls the same
 * function, so tests exercise the wiring production runs rather than a copy).
 *
 * Composition: the real ThreadLog + ConversationStore, the server's attention
 * surface and log dir, the `threadline.canonicalHistory` knobs from config, the
 * real MessageStore as the resolvable backing for over-cap bodies, and the
 * peer-contact hook (attachPeerContactHook) wrapped around `record`, and the
 * close-only retention seam (installCanonicalRetentionSeam) on the store.
 */

import path from 'node:path';
import { ThreadMessageRecorder, type ThreadMessageRecorderDeps, type ThreadBodyStore } from './recordThreadMessage.js';
import { attachPeerContactHook } from './peerHomebaseBackfill.js';

export interface CreateThreadMessageRecorderOptions {
  /** The server config: `stateDir` and the optional `threadline.canonicalHistory` knobs. */
  config: { stateDir: string; threadline?: object };
  threadLog: ThreadMessageRecorderDeps['threadLog'];
  conversationStore: ThreadMessageRecorderDeps['conversationStore'];
  /** The resolvable over-cap body backing (production: the server's MessageStore). */
  messageStore: ThreadBodyStore;
  attention?: ThreadMessageRecorderDeps['attention'];
  /** Called for every NEW leg with a peer (the homebase backfill hook). */
  onContact: (peer: string) => void;
}

export function createThreadMessageRecorder(opts: CreateThreadMessageRecorderOptions): ThreadMessageRecorder {
  const canon = (opts.config.threadline as { canonicalHistory?: Record<string, number> } | undefined)?.canonicalHistory ?? {};
  const recorder = new ThreadMessageRecorder({
    threadLog: opts.threadLog,
    conversationStore: opts.conversationStore,
    attention: opts.attention ?? null,
    logDir: path.join(opts.config.stateDir, 'logs'),
    headCacheCoalesceMs: canon.headCacheCoalesceMs,
    appendFailureAlertThreshold: canon.appendFailureAlertThreshold,
    inlineMaxBytes: canon.inlineMaxBytes,
    // The resolvable backing for over-cap bodies (textRef kind 'store'), so a
    // logged reference always points at a written body.
    bodyStore: opts.messageStore,
  });
  installCanonicalRetentionSeam(opts.conversationStore, opts.threadLog, opts.messageStore);
  return attachPeerContactHook(recorder, opts.onContact);
}

/**
 * SA5/E1 close-only canonical retention, the ONE production seam: a non-pinned
 * conversation transitioning INTO resolved/failed deletes its log (ThreadLog.
 * deleteThread) AND its over-cap body partition (MessageStore.
 * deleteThreadBodiesSync — exactly that thread's bodies, including one whose log
 * append failed after the body write). Both via SafeFsExecutor; each step is
 * independent so one failure never strands the other. Pinned conversations and a
 * COLD archive/LRU eviction never fire this seam (ConversationStore decides).
 */
export function installCanonicalRetentionSeam(
  conversationStore: Pick<ThreadMessageRecorderDeps['conversationStore'], 'setLogRetentionSeam'>,
  threadLog: Pick<ThreadMessageRecorderDeps['threadLog'], 'deleteThread'>,
  bodyStore: Pick<ThreadBodyStore, 'deleteThreadBodiesSync'>,
): void {
  conversationStore.setLogRetentionSeam((threadId) => {
    try { threadLog.deleteThread(threadId); } catch { /* @silent-fallback-ok: best-effort post-commit retention; bodies still removed below */ }
    try { bodyStore.deleteThreadBodiesSync(threadId); } catch (err) {
      console.warn(`[canonical-retention] body partition delete failed for ${threadId}: ${(err as Error).message}`);
    }
  });
}
