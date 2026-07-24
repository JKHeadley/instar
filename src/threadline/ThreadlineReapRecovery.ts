import type { MessageEnvelope } from '../messaging/types.js';
import type { MessageStore } from '../messaging/MessageStore.js';
import type { ResumeQueueEntry } from '../monitoring/ResumeQueue.js';
import type { AgentTrustLevel } from './AgentTrustManager.js';
import type { ListenerSessionManager } from './ListenerSessionManager.js';
import type { ThreadLog } from './ThreadLog.js';
import type { ThreadLogEntry } from './ThreadLog.js';
import type { ThreadlineRouter } from './ThreadlineRouter.js';
import { contentDigest } from './threadDigest.js';

// canonical-migration-consumer: threadline-inbound-canonical-store@1

interface RecoverableInbound {
  id: string;
  threadId: string;
  from: string;
  senderName: string;
  trustLevel: AgentTrustLevel;
  text: string;
  timestamp: string;
}

type CanonicalInbound =
  | { kind: 'resolved'; inbound: RecoverableInbound }
  | { kind: 'stored'; entry: ThreadLogEntry & { textRef: { kind: 'store'; messageStoreId: string } } };

export function createThreadlineReapRecovery(deps: {
  localAgent: string;
  manager: () => ListenerSessionManager | null;
  threadLog?: () => Pick<ThreadLog, 'isPathConfined' | 'read'> | null;
  messageStore?: () => Pick<MessageStore, 'get'> | null;
  router: () => ThreadlineRouter | null;
}) {
  const readCanonicalInbound = (threadId: string, messageId: string): CanonicalInbound | null => {
    const legacy = deps.manager()?.readCanonicalInboxEntry(messageId);
    if (legacy?.threadId === threadId) return { kind: 'resolved', inbound: legacy as RecoverableInbound };
    const log = deps.threadLog?.();
    if (!log?.isPathConfined(threadId)) return null;
    let afterSeq = -1;
    do {
      const page = log.read(threadId, { limit: 1000, afterSeq });
      const entry = page.entries.find((candidate) =>
        candidate.messageId === messageId && candidate.direction === 'inbound');
      if (entry) {
        if (entry.textRef.kind === 'store') {
          return { kind: 'stored', entry: entry as ThreadLogEntry & { textRef: { kind: 'store'; messageStoreId: string } } };
        }
        const from = entry.peerFingerprint ?? entry.author.agentFingerprint;
        if (!from) return null;
        return { kind: 'resolved', inbound: {
          id: entry.messageId, threadId: entry.threadId, from, senderName: from,
          trustLevel: 'untrusted', text: entry.textRef.text, timestamp: entry.createdAt,
        } };
      }
      if (!page.hasMore || page.entries.length === 0) return null;
      afterSeq = page.entries[page.entries.length - 1].seq;
    } while (true);
  };

  const resolveCanonicalInbound = async (candidate: CanonicalInbound): Promise<RecoverableInbound | null> => {
    if (candidate.kind === 'resolved') return candidate.inbound;
    const store = deps.messageStore?.();
    if (!store) return null;
    const envelope = await store.get(candidate.entry.textRef.messageStoreId);
    const message = envelope?.message;
    if (!message || message.id !== candidate.entry.messageId || message.threadId !== candidate.entry.threadId
      || message.createdAt !== candidate.entry.createdAt || typeof message.body !== 'string') return null;
    if (contentDigest({
      threadId: message.threadId, messageId: message.id, body: message.body, createdAt: message.createdAt,
    }) !== candidate.entry.contentDigest) return null;
    const from = candidate.entry.peerFingerprint ?? candidate.entry.author.agentFingerprint;
    if (!from) return null;
    return {
      id: message.id, threadId: message.threadId, from, senderName: from,
      trustLevel: 'untrusted', text: message.body, timestamp: message.createdAt,
    };
  };

  const pending = (entry: ResumeQueueEntry): boolean => {
    const manager = deps.manager();
    if (!manager || !entry.threadlineMessageId || !entry.threadId) return false;
    const candidate = readCanonicalInbound(entry.threadId, entry.threadlineMessageId);
    const inboundId = candidate?.kind === 'resolved' ? candidate.inbound.id : candidate?.entry.messageId;
    return !!inboundId && !manager.hasReplyClaim(inboundId)
      && !manager.hasCanonicalReplyFor(entry.threadId, inboundId);
  };

  const respawn = async (entry: ResumeQueueEntry): Promise<string> => {
    const manager = deps.manager();
    const router = deps.router();
    if (!manager || !router || !entry.threadlineMessageId || !entry.threadId) {
      throw new Error('Threadline recovery wiring unavailable');
    }
    const candidate = readCanonicalInbound(entry.threadId, entry.threadlineMessageId);
    const inbound = candidate ? await resolveCanonicalInbound(candidate) : null;
    if (!inbound || inbound.threadId !== entry.threadId || manager.hasCanonicalReplyFor(entry.threadId, inbound.id)) {
      throw new Error('Threadline inbound already settled or unavailable');
    }
    const claimOwner = `reap-redrive:${entry.id}`;
    if (!manager.tryClaimReply(inbound.id, claimOwner)) throw new Error('Threadline reply already in flight');
    const now = new Date().toISOString();
    const envelope = {
      schemaVersion: 1,
      message: {
        id: inbound.id,
        from: { agent: inbound.from, session: 'relay-recovery', machine: 'relay' },
        to: { agent: deps.localAgent, session: 'best', machine: 'local' },
        subject: 'Relay message recovery', body: inbound.text, type: 'query', priority: 'medium',
        threadId: inbound.threadId, createdAt: inbound.timestamp, ttlMinutes: 60,
      },
      transport: {
        protocol: 'relay', origin: { agent: inbound.from, machine: 'relay' },
        nonce: `reap-redrive:${inbound.id}`, timestamp: now,
      },
      delivery: { status: 'delivered', attempts: 2, lastAttempt: now },
    } as unknown as MessageEnvelope;
    try {
      const result = await router.handleInboundMessage(envelope, {
        trust: { kind: 'plaintext-tofu', senderFingerprint: inbound.from },
        senderFingerprint: inbound.from, senderName: inbound.senderName,
        trustLevel: inbound.trustLevel as AgentTrustLevel, preferWarmSession: false,
      });
      if (result.error || !result.handled || !result.sessionName) {
        throw new Error(result.error ?? 'Threadline router did not start recovery');
      }
      if (!manager.transferReplyClaim(inbound.id, claimOwner, result.sessionName)) {
        throw new Error('Threadline recovery claim transfer failed');
      }
      return result.sessionName;
    } catch (err) {
      manager.releaseReplyClaim(inbound.id, claimOwner);
      throw err;
    }
  };

  return { pending, respawn };
}
