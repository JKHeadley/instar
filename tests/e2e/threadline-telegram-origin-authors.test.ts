import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { OriginAuthorCall } from '../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { withThreadlineTelegramAuthor } from '../../src/threadline/TelegramOriginAttribution.js';
import { createA2ACheckInScheduler } from '../../src/threadline/A2ACheckInScheduler.js';
import { TelegramBridge } from '../../src/threadline/TelegramBridge.js';
import { TelegramBridgeConfig } from '../../src/threadline/TelegramBridgeConfig.js';
import { TopicLinkageHandler } from '../../src/threadline/TopicLinkageHandler.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { ThreadResumeMap } from '../../src/threadline/ThreadResumeMap.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { SalienceGate } from '../../src/threadline/SalienceGate.js';
import { temporaryState, compileOriginWorker } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
describe('Threadline Telegram authors using production origin initialization', () => {
  it('records generated authors while keeping inbound peer prose unknown and retaining an outbound parent', async () => {
    const stateDir = temporaryState();
    const config = { stateDir, projectDir: stateDir, projectName: 'echo', port: 0, authToken: 'fixture',
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:fixture', chatId: '-100123' } }] };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
    // Finish fixture configuration before the origin observer acquires its
    // revision. This test exercises authorship, not post-edit invalidation.
    const live = new LiveConfig(stateDir); close.push(async () => live.stop());
    const bridgeConfig = new TelegramBridgeConfig(live); bridgeConfig.update({ enabled: true, autoCreateTopics: true, mirrorExisting: true });
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:fixture', noticeOwner: false, workerUrl: worker,
      holdsLease: () => true, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    close.push(boot.close);
    const service = boot.runtime.service;
    const sink = async (topicId: number, text: string) => {
      const operation = service.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: topicId, text } });
      await service.admit(operation); return { messageId: 1 };
    };
    let now = 0;
    const scheduler = createA2ACheckInScheduler({ listActiveThreads: () => [{ threadId: 'summary-thread', peerName: 'Dawn', topicId: 42 }],
      summarize: async (_prompt, call) => { call.options({ model: 'fast' }).onModel!({ model: 'actual-summary-model', framework: 'codex-cli' }); return 'Dawn says the review is nearly finished.'; },
      surface: async ({ topicId, body, originAuthor }) => { await withThreadlineTelegramAuthor(service, 'a2a-checkin', topicId!, body, originAuthor, () => sink(topicId!, body)); },
      getHistory: () => 'Dawn: reviewing', now: () => now, config: { enabled: true, heartbeatEnabled: true, heartbeatIntervalMs: 1 } });
    await scheduler.tick(); now = 2; await scheduler.tick();

    const bridge = new TelegramBridge({ stateDir, localAgentName: 'Echo', config: bridgeConfig, originService: service,
      telegram: { findOrCreateForumTopic: async name => ({ topicId: 43, name, reused: false }), sendToTopic: sink } });
    const parent = new OriginAuthorCall(); parent.options({}).onModel!({ model: 'submitting-parent-model', framework: 'claude-code' });
    await service.runAsAuthoredAutomation('telegram-server', parent.snapshot(), async () => {
      await bridge.mirrorInbound({ threadId: 'bridge-thread', remoteAgent: 'Dawn', text: 'Peer original words' });
      await bridge.mirrorInbound({ threadId: 'bridge-thread', remoteAgent: 'Dawn', text: 'A second peer message' });
      await bridge.mirrorOutbound({ threadId: 'bridge-thread', remoteAgent: 'Dawn', text: 'Local parent reply' });
    });
    await bridge.mirrorOutbound({ threadId: 'bridge-thread', remoteAgent: 'Dawn', text: 'Unbound prior local reply' });

    const tracker = new CommitmentTracker({ stateDir, liveConfig: live });
    const linkage = new TopicLinkageHandler({ originService: service, topicResumeMap: new TopicResumeMap(stateDir, stateDir),
      threadResumeMap: new ThreadResumeMap(stateDir, stateDir), commitmentTracker: tracker, salienceGate: new SalienceGate(),
      localAgent: 'echo', getSessionForTopic: () => 'dormant-topic', isSessionAlive: () => false,
      injectIntoSession: () => false, sendTelegramToTopic: sink });
    await service.runAsAuthoredAutomation('telegram-server', parent.snapshot(), () => linkage.tryRouteReplyToTopic({
      envelope: { message: { id: 'peer-message', threadId: 'linked-thread', from: { agent: 'Dawn' }, to: { agent: 'echo' },
        body: 'The peer completed the review.', subject: 'Review', type: 'response', priority: 'medium', createdAt: new Date().toISOString() } } as never,
      threadEntry: { originTopicId: 44, remoteAgent: 'Dawn', originSessionName: 'dormant-topic' } }));
    const records = (await boot.runtime.store.listOrigins()).records.map(row => JSON.parse(row.record.envelopeJson));
    expect(records).toHaveLength(6);
    expect(records.find(row => row.producerId === 'a2a-checkin')).toMatchObject({ model: { value: 'actual-summary-model', status: 'configured' } });
    expect(records.filter(row => row.producerId === 'threadline-peer-relay')).toHaveLength(3);
    for (const row of records.filter(row => row.producerId === 'threadline-peer-relay')) {
      expect(row.model).toMatchObject({ value: null, status: 'unknown', reason: 'forwarded-peer-author-unavailable' });
    }
    expect(records.find(row => row.producerId === 'telegram-server')).toMatchObject({ model: { value: 'submitting-parent-model', status: 'configured' } });
    expect(records.find(row => row.producerId === 'threadline-outbound-relay')).toMatchObject({ model: { value: null, status: 'unknown', reason: 'forwarded-source-author-unavailable' } });
  });
});
