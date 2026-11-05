/**
 * Owner recovery from the fixed reply. Spec: docs/specs/memory-privacy.md, "Owner recovery".
 * The boundary is the point: only the owner hears the cause, and only in private.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryPrivacy, type ReachableLists } from '../../src/users/MemoryPrivacy.js';
import {
  MemoryInboundTracker, MEMORY_PRIVACY_OWNER_CHANNEL_REPLY, MEMORY_PRIVACY_RETRY_REPLY, MEMORY_PRIVACY_UNAVAILABLE_REPLY, type InboundFacts,
} from '../../src/users/MemoryInboundTracker.js';
import {
  memoryFixText, MemoryPrivacyRecovery, RECOVERY_LINK_TTL_MS, RECOVERY_NOTICE_GAP_MS, type RecoveryFacts,
} from '../../src/users/MemoryPrivacyRecovery.js';
import { whatsappSpeakerJid } from '../../src/users/MemoryAudience.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOO_OLD: RecoveryFacts = {
  blocker: 'claude-too-old', platform: 'darwin', floor: '2.1.316', haveVersion: '2.1.300', candidate: '/opt/homebrew/bin/claude',
};
const tokenIn = (text: string) => /fix\/([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? '';

describe('memoryFixText', () => {
  it('names the real cause on a Mac instead of saying the platform has no sandbox', () => {
    const text = memoryFixText(TOO_OLD);
    expect(text).toContain('2.1.300');
    expect(text).toContain('2.1.316');
    expect(text).toContain('/opt/homebrew/bin/claude');
    expect(text).not.toMatch(/no supported sandbox/);
  });

  it('asks for an update when nothing on the machine qualifies', () => {
    expect(memoryFixText({ ...TOO_OLD, candidate: null })).toMatch(/Update Claude Code/);
    expect(memoryFixText({ ...TOO_OLD, blocker: 'claude-missing', candidate: null })).toMatch(/will not run/);
  });

  it('leaves paths out of what can leave the machine', () => {
    expect(memoryFixText(TOO_OLD, true)).not.toContain('/opt/homebrew');
    expect(memoryFixText(TOO_OLD, true)).toContain('2.1.316');
  });

  it('does not give a Mac answer on a platform with no sandbox', () => {
    const text = memoryFixText({ ...TOO_OLD, blocker: 'sandbox', platform: 'win32' });
    expect(text).toMatch(/no supported sandbox/);
    expect(text).not.toMatch(/macOS/);
  });

  it('gives each platform its own sandbox advice', () => {
    expect(memoryFixText({ ...TOO_OLD, blocker: 'sandbox', platform: 'linux' })).toMatch(/bubblewrap/);
    expect(memoryFixText({ ...TOO_OLD, blocker: 'sandbox', platform: 'darwin' })).toMatch(/macOS sandbox/);
  });
});

describe('MemoryPrivacyRecovery', () => {
  let now: number;
  let facts: RecoveryFacts | null;
  const repair = vi.fn(async () => true);
  const make = (linkFor: (p: string) => string | null = (p) => `https://t.example${p}`) =>
    new MemoryPrivacyRecovery({ facts: () => facts, repair, linkFor, now: () => now });
  beforeEach(() => { now = 1_000; facts = TOO_OLD; repair.mockClear(); repair.mockResolvedValue(true); });

  it('gives the owner a link when one click can fix it', () => {
    expect(tokenIn(make().ownerMessage())).toHaveLength(43);
  });

  it.each([
    ['sandbox', { ...TOO_OLD, blocker: 'sandbox' as const, candidate: null }],
    ['no working Claude on the machine', { ...TOO_OLD, candidate: null }],
  ])('every cause gets a link to the solution: %s, with no repair on offer', async (_name, cause) => {
    facts = cause;
    const r = make();
    const message = r.ownerMessage();
    const token = tokenIn(message);
    expect(token).toHaveLength(43);
    expect(message).toContain('What to do:');
    expect(r.canRepair(token)).toBe(false);
    expect(await r.redeem(token)).toBe('not-fixed');
    expect(repair).not.toHaveBeenCalled();
    expect(r.linkIsLive(token)).toBe(true);
  });

  it('a framework limit also links to its solution, and its page explains that limit', () => {
    facts = null;
    const r = make();
    const token = tokenIn(r.ownerMessage('framework'));
    expect(token).toHaveLength(43);
    expect(r.describe(token)).toMatch(/needs Claude Code/);
    expect(r.canRepair(token)).toBe(false);
  });

  it('never sends a localhost link: with no public address it says so', () => {
    facts = { ...TOO_OLD, blocker: 'sandbox', candidate: null };
    const text = make(() => null).ownerMessage();
    expect(text).toContain('no public address');
    expect(text).not.toContain('localhost');
  });

  it('gives the manual step when there is no address to link to', () => {
    expect(make(() => null).ownerMessage()).toContain('sessions.claudePath');
  });

  it('reading a link does not spend it, as a link preview must not fix anything', async () => {
    const r = make();
    const token = tokenIn(r.ownerMessage());
    expect(r.linkIsLive(token)).toBe(true);
    expect(r.linkIsLive(token)).toBe(true);
    expect(repair).not.toHaveBeenCalled();
    expect(await r.redeem(token)).toBe('fixed');
  });

  it('works once', async () => {
    const r = make();
    const token = tokenIn(r.ownerMessage());
    expect(await r.redeem(token)).toBe('fixed');
    expect(await r.redeem(token)).toBe('expired');
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('expires', async () => {
    const r = make();
    const token = tokenIn(r.ownerMessage());
    now += RECOVERY_LINK_TTL_MS;
    expect(await r.redeem(token)).toBe('expired');
    expect(repair).not.toHaveBeenCalled();
  });

  it('refuses a guessed token and an empty one', async () => {
    const r = make();
    r.ownerMessage();
    expect(await r.redeem('x'.repeat(43))).toBe('expired');
    expect(await r.redeem('')).toBe('expired');
  });

  it('reports a repair that did not take', async () => {
    repair.mockResolvedValue(false);
    const r = make();
    expect(await r.redeem(tokenIn(r.ownerMessage()))).toBe('not-fixed');
  });

  it('does not repair once the cause has gone away', async () => {
    const r = make();
    const token = tokenIn(r.ownerMessage());
    facts = null;
    expect(await r.redeem(token)).toBe('not-fixed');
    expect(repair).not.toHaveBeenCalled();
  });

  it('a repair that throws is reported, not raised, so it cannot end the server', async () => {
    repair.mockRejectedValue(new Error('disk full'));
    const r = make();
    expect(await r.redeem(tokenIn(r.ownerMessage()))).toBe('not-fixed');
  });

  it('a reused link states the time it really has left', () => {
    const r = make();
    r.ownerMessage();
    now += 20 * 60_000;
    expect(r.ownerMessage()).toContain('next 10 minutes');
  });

  it('counts one notice per gap, from a message that went', () => {
    const r = make();
    expect(r.noticeIsRecent()).toBe(false);
    r.markNoticeSent();
    expect(r.noticeIsRecent()).toBe(true);
    now += RECOVERY_NOTICE_GAP_MS;
    expect(r.noticeIsRecent()).toBe(false);
  });
});

describe('whatsappSpeakerJid', () => {
  it('names the speaker in a group, as the adapter reports it, and the chat in a 1:1', () => {
    expect(whatsappSpeakerJid({ isGroup: true, participant: '1@s.whatsapp.net' }, 'g@g.us')).toBe('1@s.whatsapp.net');
    expect(whatsappSpeakerJid({}, '2@s.whatsapp.net')).toBe('2@s.whatsapp.net');
    expect(whatsappSpeakerJid(undefined, '2@s.whatsapp.net')).toBe('2@s.whatsapp.net');
  });
});

describe('MemoryInboundTracker.refuse', () => {
  let root: string;
  let framework: string;
  let causeFacts: RecoveryFacts | null;
  let sent: string[];
  const send = async (text: string) => { sent.push(text); return true; };
  const build = (
    ownerUserId: string,
    reachable: ReachableLists = { slackAuthorizedIds: ['U1', 'U2'], slackBotUserId: 'B' },
    people: unknown[] = [{ id: 'justin', slackUserId: 'U1' }, { id: 'vince', slackUserId: 'U2' }],
  ) => {
    const privacy = new MemoryPrivacy({
      stateDir: path.join(root, 'a'), instarRoot: root, agentId: 'x', config: () => ({ ownerUserId }),
      users: () => people as never, reachable: () => reachable,
    });
    const recovery = new MemoryPrivacyRecovery({ facts: () => causeFacts, repair: async () => true, linkFor: (p) => `https://t.example${p}` });
    const tracker = new MemoryInboundTracker({
      privacy, recovery, framework: () => framework, sandboxReady: () => false,
      retireSessions: async () => [], retireSessionUnlessAudience: async () => true,
    });
    return { privacy, recovery, tracker };
  };
  const make = (ownerUserId = 'justin') => build(ownerUserId).tracker;
  const facts = (over: Partial<InboundFacts>): InboundFacts => ({
    placeKey: 'slack:C1', placeKind: 'shared', senderKey: 'user:justin', personId: 'justin', ...over,
  });
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recovery-')); framework = 'claude-code'; causeFacts = TOO_OLD; sent = []; });
  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/memory-privacy-recovery.test.ts' }));

  it('owner in a private channel: nothing about the cause reaches the channel, the link goes private', async () => {
    const reply = await make().refuse(facts({}), send);
    expect(reply).toBe(MEMORY_PRIVACY_OWNER_CHANNEL_REPLY);
    expect(reply).not.toMatch(/claude|\/opt|fix\//i);
    expect(sent[0]).toContain('/memory-privacy/fix/');
  });

  it('owner asking again in a channel gets the same reply and no second message', async () => {
    const t = make();
    await t.refuse(facts({}), send);
    expect(await t.refuse(facts({}), send)).toBe(MEMORY_PRIVACY_OWNER_CHANNEL_REPLY);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['throws', async () => { throw new Error('no route'); }],
    ['reports it did not go', async () => false],
  ])('when the private send %s, the channel claims nothing, and a retry sends again', async (_name, failing) => {
    const t = make();
    expect(await t.refuse(facts({}), failing)).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    expect(await t.refuse(facts({}), send)).toBe(MEMORY_PRIVACY_OWNER_CHANNEL_REPLY);
    expect(sent).toHaveLength(1);
  });

  it('with no private route, the owner gets the fixed reply', async () => {
    expect(await make().refuse(facts({}))).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
  });

  it('during the boot probe there is no cause yet: no notice spent, and no wrong claim', async () => {
    causeFacts = null;
    const t = make();
    expect(await t.refuse(facts({}), send)).toBe(MEMORY_PRIVACY_RETRY_REPLY);
    causeFacts = TOO_OLD;
    expect(await t.refuse(facts({}), send)).toBe(MEMORY_PRIVACY_OWNER_CHANNEL_REPLY);
    expect(sent).toHaveLength(1);
  });

  it('a refusal in the owner own private chat blames nothing and mints no link', async () => {
    const { privacy, recovery, tracker } = build('justin');
    privacy.recordPlace('imessage:me', 'private', 'justin');
    const reply = await tracker.refuse(facts({ placeKey: 'imessage:me', placeKind: 'private', scopedUnsupported: true }), send);
    expect(reply).toBe(MEMORY_PRIVACY_RETRY_REPLY);
    expect(recovery.linkIsLive('')).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['someone else in a channel', { senderKey: 'user:vince', personId: 'vince' }],
    ['someone else in a direct message', { senderKey: 'user:vince', personId: 'vince', placeKind: 'private' as const }],
    ['an unverified sender', { senderKey: null, personId: null, placeKind: 'private' as const }],
    ['an unknown id', { senderKey: 'slack:U9', personId: null, placeKind: 'private' as const }],
  ])('%s gets only the fixed reply', async (_name, over) => {
    expect(await make().refuse(facts(over), send)).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    expect(sent).toHaveLength(0);
  });

  it('the Telegram owner in a group gets the link, with no profile needed', async () => {
    const { tracker } = build('', { telegramOwnerId: 42 });
    const inGroup = { placeKey: 'telegram:-100', senderKey: 'telegram:42', personId: null };
    expect(await tracker.refuse(facts(inGroup), send)).toBe(MEMORY_PRIVACY_OWNER_CHANNEL_REPLY);
    expect(sent[0]).toContain('/memory-privacy/fix/');
  });

  it('a named owner wins: the Telegram owner id is not enough when someone else is named', async () => {
    const { tracker } = build('justin', { telegramOwnerId: 42 });
    expect(await tracker.refuse(facts({ placeKey: 'telegram:-100', senderKey: 'telegram:42', personId: null }), send)).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    expect(sent).toHaveLength(0);
  });

  it('an owner found by role wins too: the Telegram id alone does not pass', async () => {
    const { tracker } = build('', { telegramOwnerId: 42 }, [{ id: 'pat', orgRole: 'owner', permissions: [] }]);
    expect(await tracker.refuse(facts({ placeKey: 'telegram:-100', senderKey: 'telegram:42', personId: null }), send)).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    expect(sent).toHaveLength(0);
  });

  it('someone else in that Telegram group does not', async () => {
    const { tracker } = build('', { telegramOwnerId: 42 });
    expect(await tracker.refuse(facts({ placeKey: 'telegram:-100', senderKey: 'telegram:7', personId: null }), send)).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    expect(sent).toHaveLength(0);
  });

  it('an inferred operator id is not the owner: a colleague at baseline learns nothing', async () => {
    const { privacy, tracker } = build('justin', { slackAuthorizedIds: ['UCOLLEAGUE'], slackBotUserId: 'B' }, [{ id: 'justin' }]);
    privacy.establishBaseline({ force: true });
    expect(privacy.isOperator('slack:UCOLLEAGUE')).toBe(true);
    for (const placeKind of ['private', 'shared'] as const) {
      expect(await tracker.refuse(facts({ senderKey: 'slack:UCOLLEAGUE', personId: null, placeKind }), send)).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    }
    expect(sent).toHaveLength(0);
  });

  it('with no owner set, nobody gets the link', async () => {
    expect(await make('').refuse(facts({}), send)).toBe(MEMORY_PRIVACY_UNAVAILABLE_REPLY);
    expect(sent).toHaveLength(0);
  });

  it('owner on another framework hears that, with a link', async () => {
    framework = 'codex-cli';
    await make().refuse(facts({}), send);
    expect(sent[0]).toMatch(/needs Claude Code/);
    expect(sent[0]).toContain('/memory-privacy/fix/');
  });
});
