import { describe, it, expect, vi } from 'vitest';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { signMessage } from '../../src/core/agentSignatureProvenance.js';
import { TelegramBrowserBroker } from '../../src/messaging/telegram-origin/TelegramBrowserBroker.js';
import { browserOperationDigest, correlateBrowserReceipt, canonicalBrowserJson, type PreparedBrowserChild, type TelegramBrowserDriver } from '../../src/messaging/telegram-origin/BrowserTypes.js';
import { toMtprotoArguments, fromMtprotoResult } from '../../src/messaging/telegram-origin/EnrolledMtprotoWorker.js';
import { Api } from 'telegram';

const keys = generateIdentityKeyPair();
function child(at = Date.now()): PreparedBrowserChild {
  const args = { peer: { _: 'inputPeerChannel', channel_id: '999', access_hash: '111' },
    message: signMessage({ agentId: 'echo', topicId: 42, body: 'Exact 🌕 text\nMac Studio · Codex · Astra', privateKey: keys.privateKey, timestamp: Math.floor(at / 1000) }).text,
    random_id: '9223372036854775807', reply_to: { _: 'inputReplyToMessage', reply_to_msg_id: 42 } };
  return { childId: 'c1', originId: 'o1', claimFence: 'f1', method: 'messages.sendMessage', args,
    digest: browserOperationDigest('messages.sendMessage', args), accountId: '123', destination: { kind: 'channel', id: '999', topicId: 42 },
    deadlineMs: at + 5000, expectedAgentId: 'echo', expectedAspTopicId: 42 };
}
function harness(overrides: Partial<TelegramBrowserDriver> = {}, auth = vi.fn(async () => true)) {
  const driver: TelegramBrowserDriver = { canary: vi.fn(async () => ({ transport: 'web-k', buildId: 'test-build', supported: true, accountId: '123' })),
    readSnapshot: vi.fn(async () => ({ text: 'snapshot', accountId: '123' })),
    invoke: vi.fn(async () => ({ _: 'updateShortSentMessage', id: 321 })), close: vi.fn(async () => undefined), ...overrides };
  const broker = new TelegramBrowserBroker({ driverFactory: async () => driver, authorizePreparedChild: auth,
    resolveAgentPublicKey: () => keys.publicKey, isProfileExclusivelyOwned: () => true, clockSkewMs: () => 0 });
  return { broker, driver, auth };
}
describe('Telegram browser prepared-child boundary', () => {
  it('dispatches signed exact bytes and binds direct server receipt to account, full peer and topic', async () => {
    const { broker, driver, auth } = harness(); const c = child();
    expect(await broker.executePreparedChild(c)).toEqual({ state: 'accepted', receipt: { accountId: '123', destination: c.destination, messageId: 321, randomId: c.args.random_id, state: 'sent' } });
    expect(auth).toHaveBeenCalledWith(c); expect(driver.invoke).toHaveBeenCalledWith(c);
  });
  it('rejects counterfeit outbox claim even with a correct signature and digest', async () => {
    const { broker, driver } = harness({}, vi.fn(async () => false));
    expect(await broker.executePreparedChild(child())).toMatchObject({ state: 'known-failed', reason: 'prepared-child-not-authorized' });
    expect(driver.invoke).not.toHaveBeenCalled();
  });
  it.each(['message', 'peer', 'signature', 'expiry', 'agent', 'topic', 'random-id'])('rejects %s tampering before transport', async kind => {
    const { broker, driver } = harness(); const c = child();
    if (kind === 'message') c.args.message += '!';
    if (kind === 'peer') c.destination.id = '888';
    if (kind === 'signature') { c.args.message = 'unsigned'; c.digest = browserOperationDigest(c.method, c.args); }
    if (kind === 'expiry') c.deadlineMs = Date.now() - 1;
    if (kind === 'agent') c.expectedAgentId = 'other-agent';
    if (kind === 'topic') c.expectedAspTopicId = 43;
    if (kind === 'random-id') { c.args.random_id = '9223372036854775808'; c.digest = browserOperationDigest(c.method, c.args); }
    expect((await broker.executePreparedChild(c)).state).toBe('known-failed'); expect(driver.invoke).not.toHaveBeenCalled();
  });
  it('keeps the inbound 900-second ASP window but holds outbound after 780 seconds', async () => {
    const { broker, driver } = harness(); const c = child(Date.now() - 781_000); c.deadlineMs = Date.now() + 1000;
    expect(await broker.executePreparedChild(c)).toMatchObject({ reason: 'authorship-dispatch-expired' }); expect(driver.invoke).not.toHaveBeenCalled();
  });
  it('rechecks ownership after authorization yields', async () => {
    const c = child(); let owned = true; const driver = harness().driver;
    const broker = new TelegramBrowserBroker({ driverFactory: async () => driver, authorizePreparedChild: async () => { owned = false; return true; },
      resolveAgentPublicKey: () => keys.publicKey, isProfileExclusivelyOwned: () => owned, clockSkewMs: () => 0 });
    expect(await broker.executePreparedChild(c)).toMatchObject({ reason: 'browser-profile-not-exclusive' }); expect(driver.invoke).not.toHaveBeenCalled();
  });
  it('holds persistent unsupported builds and wrong accounts without submitting', async () => {
    for (const canary of [{ supported: false, accountId: '123' }, { supported: true, accountId: '124' }]) {
      const { broker, driver } = harness({ canary: async () => ({ transport: 'web-k', buildId: 'changed', ...canary }) });
      expect((await broker.executePreparedChild(child())).state).toBe('known-failed'); expect(driver.invoke).not.toHaveBeenCalled();
    }
  });
  it('retries one read-only canary in a fresh process and invokes only the recovered driver', async () => {
    const stale = harness({ canary: vi.fn(async () => ({ transport: 'web-k', buildId: 'stale', supported: false, accountId: '123' })) }).driver;
    const fresh = harness().driver;
    const factory = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const broker = new TelegramBrowserBroker({ driverFactory: factory, authorizePreparedChild: async () => true,
      resolveAgentPublicKey: () => keys.publicKey, isProfileExclusivelyOwned: () => true, clockSkewMs: () => 0 });
    expect((await broker.executePreparedChild(child())).state).toBe('accepted');
    expect(factory).toHaveBeenCalledTimes(2); expect(stale.close).toHaveBeenCalledOnce();
    expect(stale.invoke).not.toHaveBeenCalled(); expect(fresh.invoke).toHaveBeenCalledOnce();
    expect(broker.readStatus().publicTransportAlternative).toBe(false);
    await broker.close();
  });
  it('offers the public transport after two unsupported canaries and contains alert failure', async () => {
    const drivers = [0, 1].map(index => harness({ canary: vi.fn(async () => ({ transport: 'web-k', buildId: `changed-${index}`, supported: false, accountId: '123' })) }).driver);
    const factory = vi.fn().mockResolvedValueOnce(drivers[0]).mockResolvedValueOnce(drivers[1]);
    const broker = new TelegramBrowserBroker({ driverFactory: factory, authorizePreparedChild: async () => true,
      resolveAgentPublicKey: () => keys.publicKey, isProfileExclusivelyOwned: () => true, clockSkewMs: () => 0,
      onHeld: () => { throw new Error('attention store down'); } });
    expect(await broker.executePreparedChild(child())).toMatchObject({ state: 'known-failed', reason: 'unsupported-browser-build' });
    expect(factory).toHaveBeenCalledTimes(2); expect(broker.readStatus().publicTransportAlternative).toBe(true);
    for (const driver of drivers) { expect(driver.close).toHaveBeenCalledOnce(); expect(driver.invoke).not.toHaveBeenCalled(); }
  });
  it('retires a driver that arrives after dispatch timeout and never caches it for the next operation', async () => {
    let finish!: (driver: TelegramBrowserDriver) => void;
    const late = harness().driver; const fresh = harness().driver;
    const factory = vi.fn().mockImplementationOnce(() => new Promise<TelegramBrowserDriver>(resolve => { finish = resolve; })).mockResolvedValueOnce(fresh);
    const broker = new TelegramBrowserBroker({ driverFactory: factory, authorizePreparedChild: async () => true,
      resolveAgentPublicKey: () => keys.publicKey, isProfileExclusivelyOwned: () => true, clockSkewMs: () => 0, maxOperationMs: 30 });
    expect(await broker.executePreparedChild(child())).toMatchObject({ state: 'known-failed', reason: 'dispatch-deadline' });
    finish(late);
    await vi.waitFor(() => expect(late.close).toHaveBeenCalledOnce());
    expect((await broker.executePreparedChild(child())).state).toBe('accepted');
    expect(late.canary).not.toHaveBeenCalled(); expect(late.invoke).not.toHaveBeenCalled();
    expect(fresh.invoke).toHaveBeenCalledOnce(); await broker.close();
  });
  it('bounds snapshot waits and closes the stalled process before the next request', async () => {
    const stalled = harness({ readSnapshot: () => new Promise(() => undefined) }).driver;
    const broker = new TelegramBrowserBroker({ driverFactory: async () => stalled, authorizePreparedChild: async () => true,
      resolveAgentPublicKey: () => keys.publicKey, isProfileExclusivelyOwned: () => true, clockSkewMs: () => 0, maxOperationMs: 20 });
    await expect(broker.readSnapshot()).rejects.toThrow('browser-read-deadline');
    expect(stalled.close).toHaveBeenCalledOnce(); await broker.close();
  });
  it('closes owning process before returning unknown on deadline, no replacement random id', async () => {
    const { broker, driver } = harness({ invoke: vi.fn(() => new Promise(() => undefined)) });
    const c = child(); c.deadlineMs = Date.now() + 30;
    expect(await broker.executePreparedChild(c)).toEqual({ state: 'outcome-unknown', reason: 'dispatch-deadline' });
    expect(driver.close).toHaveBeenCalledOnce(); expect(driver.invoke).toHaveBeenCalledOnce();
    expect((driver.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0].args.random_id).toBe(c.args.random_id);
  });
  it('retains unknown for optimistic/local results and kills any outstanding worker retry', async () => {
    const { broker, driver } = harness({ invoke: async () => ({ message: 'same text', id: -1 }) });
    expect(await broker.executePreparedChild(child())).toEqual({ state: 'outcome-unknown', reason: 'uncorrelated-server-result' }); expect(driver.close).toHaveBeenCalledOnce();
  });
});
describe('server receipt correlation and public transport serialization', () => {
  function updates(c: PreparedBrowserChild) { return { _: 'updates', updates: [
    { _: 'updateMessageID', random_id: c.args.random_id, id: 7 },
    { _: 'updateNewChannelMessage', message: { id: 7, peer_id: { _: 'peerChannel', channel_id: '999' }, message: c.args.message, reply_to: { reply_to_top_id: 42 } } },
  ] }; }
  it('joins only matching random ID, server ID, peer, topic and exact final text', () => {
    const c = child(); expect(correlateBrowserReceipt(c, updates(c))).toMatchObject({ messageId: 7 });
    for (const mutation of ['random', 'peer', 'topic', 'text', 'id']) {
      const u = updates(c); const message = u.updates[1].message!;
      if (mutation === 'random') u.updates[0].random_id = '999';
      if (mutation === 'peer') message.peer_id.channel_id = '998';
      if (mutation === 'topic') message.reply_to.reply_to_top_id = 43;
      if (mutation === 'text') message.message += '!';
      if (mutation === 'id') message.id = 8;
      expect(correlateBrowserReceipt(c, u)).toBeUndefined();
    }
  });
  it('distinguishes accepted scheduled messages and correlated edits', () => {
    const c = child(); const u = updates(c); u.updates[1]._ = 'updateNewScheduledMessage'; c.args.schedule_date = 1900000000;
    expect(correlateBrowserReceipt(c, u)?.state).toBe('scheduled');
    expect(correlateBrowserReceipt(c, { _: 'updateShortSentMessage', id: 7 })).toBeUndefined();
    c.method = 'messages.editMessage'; c.args.id = 7; u.updates[1]._ = 'updateEditChannelMessage';
    expect(correlateBrowserReceipt(c, u)?.state).toBe('edited');
  });
  it('serializes real public TL constructor bytes without replacing the durable int64 or ASP text', () => {
    const c = child(); const args = toMtprotoArguments(c.args) as ConstructorParameters<typeof Api.messages.SendMessage>[0];
    const request = new Api.messages.SendMessage(args);
    expect(request.message).toBe(c.args.message); expect(String(request.randomId)).toBe(c.args.random_id);
    expect(request.getBytes().length).toBeGreaterThan(100);
    expect(fromMtprotoResult(new Api.UpdateShortSentMessage({ id: 22, pts: 1, ptsCount: 1, date: 1800000000 }))).toMatchObject({ _: 'updateShortSentMessage', id: 22 });
  });
  it('canonicalizes deterministically and rejects JSON values that lose identity', () => {
    expect(canonicalBrowserJson({ b: '🌕', a: 12 })).toBe('{"a":12,"b":"🌕"}');
    for (const v of [undefined, NaN, 1.5, -0, '\ud800', { a: undefined }, new Array(1)]) expect(() => canonicalBrowserJson(v)).toThrow();
  });
});
