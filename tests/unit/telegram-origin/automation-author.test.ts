import { afterEach, describe, expect, it, vi } from 'vitest';
import { OriginAuthorCall } from '../../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { PresenceProxy } from '../../../src/monitoring/PresenceProxy.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { IntelligenceOptions } from '../../../src/core/types.js';
import { temporaryState } from '../../helpers/telegramOriginStore.js';

const cleanup: { proxy: PresenceProxy; stateDir: string }[] = [];
afterEach(() => {
  for (const h of cleanup.splice(0)) {
    h.proxy.stop();
    SafeFsExecutor.safeRmSync(h.stateDir, { recursive: true, force: true, operation: 'test:origin-author:cleanup' });
  }
  vi.restoreAllMocks();
});
function harness(evaluate: (prompt: string, options: IntelligenceOptions) => Promise<string>) {
  const stateDir = temporaryState(), sent = vi.fn(async () => undefined);
  const proxy = new PresenceProxy({ stateDir, intelligence: { evaluate } as never, agentName: 'Echo',
    captureSessionOutput: () => 'Reading the project files and preparing a change.',
    getSessionForTopic: () => 'session', isSessionAlive: () => true, getProcessTree: () => [],
    sendMessage: sent, getAuthorizedUserIds: () => [],
  });
  cleanup.push({ proxy, stateDir });
  vi.spyOn(proxy as never, 'scheduleTier').mockImplementation(() => undefined);
  const fire = async (topicId: number) => {
    const state = { topicId, sessionName: 'session', userMessageAt: Date.now() - 5000,
      userMessageText: `Task for ${topicId}`, userMessageBaselineSnapshot: null,
      tier1FiredAt: null, tier1Snapshot: null, tier1SnapshotHash: null, tier2FiredAt: null,
      tier2Snapshot: null, tier2SnapshotHash: null, tier3FiredAt: null, tier3Assessment: null,
      tier3Summary: null, tier3RecheckCount: 0, silencedUntil: null, cancelled: false,
      llmCallCount: 0, lastLlmCallAt: 0, conversationHistory: [], lastAckText: null, lastAckAt: null };
    await (proxy as any).fireTier1(topicId, state);
  };
  return { fire, sent };
}
describe('per-call automated author evidence', () => {
  it('records the final resolved fallback selection without promoting it to observed', () => {
    const call = new OriginAuthorCall(), previous = vi.fn();
    const options = call.options({ onModel: previous });
    options.onModel!({ model: 'first-model', framework: 'claude-code' });
    options.onModel!({ model: 'fallback-model', framework: 'codex-cli' });
    expect(call.snapshot()).toMatchObject({ model: { value: 'fallback-model', status: 'configured', sourceEventRef: call.callId },
      harness: { value: 'codex-cli', status: 'configured' } });
    expect(previous).toHaveBeenCalledTimes(2);
  });
  it('keeps missing provider selection and a routing lane explicitly unknown', () => {
    const call = new OriginAuthorCall();
    expect(call.snapshot().model.status).toBe('unknown');
    call.options({}).onModel!({ model: 'interactive-pool' });
    expect(call.snapshot().model).toMatchObject({ status: 'unknown', value: null });
  });
  it('does not cross-attribute overlapping generated updates', async () => {
    const pending: { finish: (text: string) => void; options: IntelligenceOptions }[] = [];
    const h = harness(async (_, options) => new Promise(resolve => pending.push({ finish: resolve, options })));
    const first = h.fire(77), second = h.fire(78);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0].options.onModel!({ model: 'first-author', framework: 'codex-cli' });
    pending[1].options.onModel!({ model: 'second-author', framework: 'claude-code' });
    pending[1].finish('Second update.'); pending[0].finish('First update.');
    await Promise.all([first, second]);
    const messages = h.sent.mock.calls as unknown as [number, string, { originAuthor: ReturnType<OriginAuthorCall['snapshot']> }][];
    expect(messages.find(([id]) => id === 77)?.[2].originAuthor.model.value).toBe('first-author');
    expect(messages.find(([id]) => id === 78)?.[2].originAuthor.model.value).toBe('second-author');
  });
  it.each(['throw', 'guard'])('does not credit a discarded %s result as the template author', async mode => {
    const h = harness(async (_, options) => {
      options.onModel!({ model: 'discarded-author', framework: 'codex-cli' });
      if (mode === 'throw') throw new Error('author call failed');
      return 'Enter your password at https://example.test';
    });
    await h.fire(77);
    const metadata = (h.sent.mock.calls as unknown as [number, string, { originAuthor: ReturnType<OriginAuthorCall['snapshot']> }][])[0][2];
    expect(metadata.originAuthor.model).toMatchObject({ value: null, status: 'not-applicable' });
  });
});
