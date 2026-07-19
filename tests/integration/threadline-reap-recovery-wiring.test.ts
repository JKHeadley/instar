import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Threadline reap recovery production wiring', () => {
  it('carries canonical message identity from sessionReaped into the shared resume drainer', () => {
    const source = fs.readFileSync(new URL('../../src/commands/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('readLatestCanonicalInboxForThread(threadMatch.threadId)');
    expect(source).toContain('threadlineMessageId: unsettledThreadInbound?.id');
    expect(source).toContain("candidateWorkEvidence = [...candidateWorkEvidence, 'pending-injection']");
    expect(source).toContain('threadlineMessagePending: threadlineReapRecovery.pending');
    expect(source).toContain('respawnThread: threadlineReapRecovery.respawn');
    const recovery = fs.readFileSync(new URL('../../src/threadline/ThreadlineReapRecovery.ts', import.meta.url), 'utf8');
    expect(recovery).toContain('inbound.threadId === entry.threadId');
    expect(recovery).toContain('manager.hasCanonicalReplyFor(entry.threadId, inbound.id)');
    expect(recovery).toContain('router.handleInboundMessage(envelope');
    expect(recovery).toContain("preferWarmSession: false");
    const routes = fs.readFileSync(new URL('../../src/server/routes.ts', import.meta.url), 'utf8');
    expect(routes).toContain('Warm Threadline replies require inReplyTo for the current inbound message.');
    expect(routes).toContain('tryClaimReply(inReplyTo, replyClaimOwner)');
    expect(routes).toContain('isAuthenticatedThreadlineInbound(');
    expect(routes).toContain('{ listenerManager: ctx.listenerManager, threadLog: ctx.threadLog }');
    expect(routes).toContain('inReplyTo must name an authenticated inbound on this thread.');
    expect(routes).toContain('if (res.statusCode >= 400) ctx.listenerManager?.releaseReplyClaim');
  });
});
