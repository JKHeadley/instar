import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryPrivacy, type ReachableLists } from '../../src/users/MemoryPrivacy.js';
import { MemoryInboundTracker } from '../../src/users/MemoryInboundTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('MemoryInboundTracker', () => {
  let root: string;
  let lists: ReachableLists;
  let sandbox: boolean;
  let framework: string;
  const retire = vi.fn(async () => [] as string[]);
  const retireOne = vi.fn(async (_name: string, _audience: string) => true);
  const make = () => {
    const privacy = new MemoryPrivacy({
      stateDir: path.join(root, 'a'), instarRoot: root, agentId: 'x',
      config: () => ({}), users: () => [], reachable: () => lists,
    });
    return { privacy, tracker: new MemoryInboundTracker({ privacy, retireSessions: retire, retireSessionUnlessAudience: retireOne, sandboxReady: () => sandbox, framework: () => framework }) };
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-inbound-'));
    lists = {}; sandbox = true; framework = 'claude-code'; retire.mockClear(); retireOne.mockClear();
  });
  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/memory-inbound-tracker.test.ts' }));

  const dm = (id: string) => ({ placeKey: `slack:D${id}`, placeKind: 'private' as const, senderKey: `slack:U${id}`, personId: null });

  it('retires sessions before delivery when a second person first appears', async () => {
    const { tracker } = make();
    await tracker.onInbound(dm('1'));
    expect(retire).not.toHaveBeenCalled();
    await tracker.onInbound(dm('2'));
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('reads a failed reader count as shared', async () => {
    lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
    const { tracker, privacy } = make();
    await tracker.onInbound({ placeKey: 'slack:G1', placeKind: 'shared', senderKey: 'slack:U1', personId: 'p', readerCount: async () => { throw new Error('rate limited'); } });
    expect(privacy.audienceFor(privacy.placeFor({ memoryPlaceKey: 'slack:G1' }, null)).kind).toBe('place');
  });

  it('retires sessions when a private place gains a reader', async () => {
    lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
    const { tracker } = make();
    const facts = { placeKey: 'slack:G1', placeKind: 'shared' as const, senderKey: 'slack:U1', personId: 'p' };
    await tracker.onInbound({ ...facts, readerCount: async () => 1 });
    expect(retire).not.toHaveBeenCalled();
    await tracker.onInbound({ ...facts, readerCount: async () => 2 });
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it('refuses rather than run a scoped session with no sandbox', async () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
    sandbox = false;
    const { tracker } = make();
    expect(await tracker.onInbound(dm('2'))).toBe('unavailable');
  });

  it('refuses a channel that cannot reply from inside the boundary', async () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
    const { tracker } = make();
    expect(await tracker.onInbound({ placeKey: 'imessage:x', placeKind: 'private', senderKey: 'imessage:x', personId: null, scopedUnsupported: true })).toBe('unavailable');
  });

  it('ends a confirmed group as soon as someone other than the operator speaks in it', async () => {
    lists = { telegramAuthorizedIds: [] };
    const { tracker, privacy } = make();
    privacy.establishBaseline();
    privacy.confirmExistingGroup('telegram:-1');
    const say = (who: string) => tracker.onInbound({ placeKey: 'telegram:-1', placeKind: 'shared', senderKey: who, personId: null, readerCount: async () => 3 });
    await say('telegram:1');
    expect(privacy.audienceFor(privacy.placeFor({ memoryPlaceKey: 'telegram:-1' }, null)).kind).toBe('open');
    await say('telegram:2');
    expect(retire).toHaveBeenCalled();
    expect(privacy.audienceFor(privacy.placeFor({ memoryPlaceKey: 'telegram:-1' }, null)).kind).toBe('place');
  });

  it('checks the live session before the message reaches it, so a session from before an update cannot answer', async () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
    const { tracker } = make();
    await tracker.onInbound({ ...dm('2'), liveSession: () => 'old-session' });
    expect(retireOne).toHaveBeenCalledWith('old-session', 'place:slack:D2');
  });

  it('does not deliver to a session that could not be ended', async () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
    retireOne.mockResolvedValueOnce(false);
    const { tracker } = make();
    expect(await tracker.onInbound({ ...dm('2'), liveSession: () => 'held' })).toBe('unavailable');
  });

  it('refuses on a framework with no adapter', async () => {
    lists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' };
    framework = 'codex-cli';
    const { tracker } = make();
    expect(await tracker.onInbound(dm('2'))).toBe('unavailable');
  });

  it('delivers on a one-person agent in private with no sandbox at all', async () => {
    lists = { slackAuthorizedIds: ['U1'], slackBotUserId: 'B' };
    sandbox = false;
    const { tracker } = make();
    expect(await tracker.onInbound({ ...dm('1'), senderKey: null })).toBe('deliver');
  });
});
