import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { advanceBrowserRecovery } from '../../../src/messaging/telegram-origin/OriginBrowserRecovery.js';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
describe('durable browser recovery episode', () => {
  it('persists the activation floor and attention episode through worker restart', async () => {
    const config = { stateDir: temporaryState(), agentId: 'echo' };
    const first = await OriginStore.open(config, worker); stores.push(first);
    const profileId = 'managed-telegram', now = Date.now();
    expect((await first.browserRecovery({ profileId, now, action: { kind: 'begin', fence: 'first' } })).allowed).toBe(true);
    expect((await first.browserRecovery({ profileId, now, action: { kind: 'failure', fence: 'first', buildId: 'build-1', final: false } })).state.attentionId).toBeNull();
    const failed = await first.browserRecovery({ profileId, now, action: { kind: 'failure', fence: 'first', buildId: 'build-2', final: true } });
    expect(failed.state.failedBuilds).toEqual(['build-1', 'build-2']);
    expect(failed.state.attentionId).toBeTruthy();
    await first.close();
    const second = await OriginStore.open(config, worker); stores.push(second);
    const blocked = await second.browserRecovery({ profileId, now: now + 899_999, action: { kind: 'begin', fence: 'second' } });
    expect(blocked.allowed).toBe(false); expect(blocked.state.attentionId).toBe(failed.state.attentionId);
    const granted = await second.browserRecovery({ profileId, now: now + 900_000, action: { kind: 'begin', fence: 'second' } });
    expect(granted.allowed).toBe(true);
    expect((await second.browserRecovery({ profileId, now: now + 900_001, action: { kind: 'success', fence: 'first' } })).allowed).toBe(false);
    const retryFailure = await second.browserRecovery({ profileId, now: now + 900_001, action: { kind: 'failure', fence: 'second', buildId: 'build-2', final: true } });
    expect(retryFailure.state.attentionId).toBe(failed.state.attentionId);
    const recovered = await second.browserRecovery({ profileId, now: now + 900_002, action: { kind: 'success', fence: 'second' } });
    expect(recovered.state).toMatchObject({ attentionId: null, nextAllowedAt: 0, failedBuilds: [], latch: { failures: 0 } });
  });
  it('re-arms the floor when a previously healthy cached process becomes unsupported', () => {
    let state = advanceBrowserRecovery(null, { kind: 'begin', fence: 'active' }, 0).state;
    state = advanceBrowserRecovery(state, { kind: 'success', fence: 'active' }, 1).state;
    state = advanceBrowserRecovery(state, { kind: 'failure', fence: 'active', buildId: 'changed', final: false }, 5000).state;
    expect(advanceBrowserRecovery(state, { kind: 'begin', fence: 'racing' }, 5001).allowed).toBe(false);
    expect(state.nextAllowedAt).toBe(905000);
  });
});
