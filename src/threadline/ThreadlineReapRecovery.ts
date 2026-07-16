import type { MessageEnvelope } from '../messaging/types.js';
import type { ResumeQueueEntry } from '../monitoring/ResumeQueue.js';
import type { AgentTrustLevel } from './AgentTrustManager.js';
import type { ListenerSessionManager } from './ListenerSessionManager.js';
import type { ThreadlineRouter } from './ThreadlineRouter.js';

export function createThreadlineReapRecovery(deps: {
  localAgent: string;
  manager: () => ListenerSessionManager | null;
  router: () => ThreadlineRouter | null;
}) {
  const pending = (entry: ResumeQueueEntry): boolean => {
    const manager = deps.manager();
    if (!manager || !entry.threadlineMessageId || !entry.threadId) return false;
    const inbound = manager.readCanonicalInboxEntry(entry.threadlineMessageId);
    return !!inbound && inbound.threadId === entry.threadId && !manager.hasReplyClaim(inbound.id)
      && !manager.hasCanonicalReplyFor(entry.threadId, inbound.id);
  };

  const respawn = async (entry: ResumeQueueEntry): Promise<string> => {
    const manager = deps.manager();
    const router = deps.router();
    if (!manager || !router || !entry.threadlineMessageId || !entry.threadId) {
      throw new Error('Threadline recovery wiring unavailable');
    }
    const inbound = manager.readCanonicalInboxEntry(entry.threadlineMessageId);
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
