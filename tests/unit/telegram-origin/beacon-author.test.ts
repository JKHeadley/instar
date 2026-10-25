import { afterEach, describe, expect, it } from 'vitest';
import { PromiseBeacon, type PromiseBeaconConfig } from '../../../src/monitoring/PromiseBeacon.js';
import { CommitmentTracker } from '../../../src/monitoring/CommitmentTracker.js';
import { LlmQueue } from '../../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../../src/monitoring/ProxyCoordinator.js';
import { LiveConfig } from '../../../src/config/LiveConfig.js';
import { composeAutomationAuthors, deterministicAutomationAuthor, OriginAuthorCall,
  type OriginAutomationAuthor } from '../../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { createConversationDelivery } from '../../../src/core/deliverToConversation.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';

const beacons: PromiseBeacon[] = [];
afterEach(() => { for (const beacon of beacons.splice(0)) beacon.stop(); });
function fixture(extra: Partial<PromiseBeaconConfig> = {}, stateDir = temporaryState()) {
  const tracker = new CommitmentTracker({ stateDir, liveConfig: new LiveConfig(stateDir) });
  const sent: OriginAutomationAuthor[] = [];
  const delivery = createConversationDelivery({ registry: {} as never, followThrough: () => ({ enabled: true, dryRun: false }),
    sendTelegram: async (_topic, _text, opts) => { sent.push(opts!.originAuthor!); return true; } });
  const beacon = new PromiseBeacon({ userOutputEnabled: true, stateDir, commitmentTracker: tracker,
    llmQueue: new LlmQueue({ maxDailyCents: 100 }), proxyCoordinator: new ProxyCoordinator(),
    captureSessionOutput: () => 'New build output is available.', getSessionForTopic: () => 'session', isSessionAlive: () => true,
    sendMessage: async () => { throw new Error('funnel bypass'); }, deliverMessage: (topic, text, opts) => delivery(topic, text, { ...opts, tier: String(opts.tier) }),
    aggregateByTopic: false, ...extra });
  beacons.push(beacon); beacon.start();
  const record = (label: string) => tracker.record({ type: 'one-time-action', userRequest: label, agentResponse: label,
    topicId: 42, beaconEnabled: true, cadenceMs: 60_000, nextUpdateDueAt: '2099-01-01T00:00:00Z' });
  return { beacon, sent, record, stateDir };
}
describe('PromiseBeacon author evidence through delivery and durable aggregation', () => {
  it.each(['template', 'authored', 'unbound', 'discarded', 'classifier'] as const)('keeps %s authorship honest', async mode => {
    const h = fixture(mode === 'template' ? {} : {
      generateStatusLine: async (_promise, _output, _signal, call) => {
        if (mode !== 'unbound') call!.options({}).onModel!({ model: 'author-model', framework: 'codex-cli' });
        if (mode === 'discarded') throw new Error('discarded generation');
        return 'The build completed.';
      },
      ...(mode === 'classifier' ? { classifyProgress: async () => 'stalled' as const } : {}),
    });
    await h.beacon.fire(h.record('Build the change').id);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].model.status).toBe(mode === 'authored' ? 'configured' : mode === 'unbound' ? 'unknown' : 'not-applicable');
    expect(h.sent[0].model.value).toBe(mode === 'authored' ? 'author-model' : null);
  });
  it('preserves mixed authors through a durable aggregate restart', async () => {
    let now = Date.now();
    const h = fixture({ aggregateByTopic: true, now: () => now, generateStatusLine: async (promise, _output, _signal, call) => {
      call!.options({}).onModel!({ model: promise, framework: 'codex-cli' }); return 'The build completed.';
    } });
    await h.beacon.fire(h.record('first-author').id);
    await h.beacon.fire(h.record('second-author').id);
    await h.beacon.fire(h.record('third-author').id);
    h.beacon.stop(); now += 60_000;
    const restarted = fixture({ aggregateByTopic: true, now: () => now }, h.stateDir);
    await restarted.beacon.flushTopicAggregate(42);
    expect(restarted.sent).toHaveLength(1);
    expect(restarted.sent[0].model).toMatchObject({ status: 'unknown', reason: 'multiple-or-unknown-author-calls' });
    expect(restarted.sent[0].harness).toMatchObject({ value: 'codex-cli', status: 'configured' });
    expect(restarted.sent[0].authorContributors!.map(author => author.model.value)).toEqual(['second-author', 'third-author']);
  });
  it('bounds contributor evidence and never presents a partial set as complete', () => {
    const authors = Array.from({ length: 130 }, () => {
      const call = new OriginAuthorCall(); call.options({}).onModel!({ model: 'same-model', framework: 'codex-cli' }); return call.snapshot();
    });
    expect(composeAutomationAuthors(authors)).toMatchObject({ omittedAuthorContributors: 2, model: { status: 'unknown' } });
    expect(composeAutomationAuthors(authors).authorContributors).toHaveLength(128);
    expect(composeAutomationAuthors([deterministicAutomationAuthor(), deterministicAutomationAuthor()]).model.status).toBe('not-applicable');
    expect(composeAutomationAuthors(authors.slice(0, 2)).model).toMatchObject({ value: 'same-model', status: 'configured' });
  });
});
