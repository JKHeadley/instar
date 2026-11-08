// safe-git-allow: test file — fs.rmSync is per-test tmpdir cleanup only.
/**
 * Slack names instead of raw ids (fb-4db533fa-9d9, found by the live proof of #2966).
 *
 * Root cause: users.info, conversations.info, conversations.replies, conversations.members and
 * files.info do not read a JSON body (live API, 2026-11-08: `user_not_found` / `invalid_arguments`
 * with application/json, ok with form encoding), so every name lookup failed and the id stood in.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeSlackRequest, FORM_ENCODED_METHODS } from '../../src/messaging/slack/SlackApiClient.js';
import { buildMobileSlackBridge, slackListRows, slackConversationTitle, type SlackAdapterLike } from '../../src/server/mobileSlackRoutes.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('encodeSlackRequest', () => {
  it('form-encodes the methods that do not read JSON', () => {
    expect([...FORM_ENCODED_METHODS].sort()).toEqual(['conversations.info', 'conversations.members', 'conversations.replies', 'files.info', 'users.info']);
    const u = encodeSlackRequest('users.info', { user: 'U0CFA03N5QF' });
    expect(u.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(u.body).toBe('user=U0CFA03N5QF');
    const c = encodeSlackRequest('conversations.info', { channel: 'C0CG1C62HUL', include_num_members: true, skip: undefined });
    expect(new URLSearchParams(c.body).get('include_num_members')).toBe('true');
    expect(new URLSearchParams(c.body).has('skip')).toBe(false);
  });
  it('keeps JSON for everything else (byte-identical to before)', () => {
    const p = { channel: 'C1', text: 'hi', blocks: [{ type: 'section' }] };
    expect(encodeSlackRequest('chat.postMessage', p)).toEqual({ contentType: 'application/json; charset=utf-8', body: JSON.stringify(p) });
  });
});

function stub(names: Record<string, string>, channelNames: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-names-'));
  dirs.push(dir);
  const logPath = path.join(dir, 'slack-messages.jsonl');
  // The owner's message as the adapter logged it when the lookup failed: the id as the name.
  fs.writeFileSync(logPath, `${JSON.stringify({ messageId: '1794162258.166899', channelId: 'C0CG1C62HUL', text: '[TEST] inbound', fromUser: true, senderName: 'U0CER2ZL62Y', platformUserId: 'U0CER2ZL62Y', timestamp: '2026-11-08T18:24:18.000Z' })}\n`);
  const adapter: SlackAdapterLike = {
    // A second person's message only in the ring (never logged): no name of its own.
    getChannelMessages: () => [{ ts: '1794162858.289019', user: 'U0CFA03N5QF', text: '[TEST] Second person' }, { ts: '1794162859.000001', user: 'UBOT', text: 'bot line' }],
    getBotUserId: () => 'UBOT',
    getLogPath: () => logPath,
    logMessage: () => undefined,
    sendToChannel: async () => '1',
    getSessionForChannel: () => null,
    isAuthorized: () => true,
    cachedUserName: (u) => names[u] ?? null,
    cachedChannelName: (c) => channelNames[c] ?? null,
  };
  const registry = {
    list: () => [{ key: 'slack:T0CEF50NAR1:C0CG1C62HUL', entry: { id: -126660833, channelId: 'C0CG1C62HUL', threadTs: null, origin: 'minted-probed', mintedAt: '2026-11-08T18:24:18.000Z' } }],
    resolve: (id: number) => (id === -126660833 ? { platform: 'slack', id, key: 'slack:T0CEF50NAR1:C0CG1C62HUL', channelId: 'C0CG1C62HUL', threadTs: null, origin: 'minted-probed' } : null),
  };
  return buildMobileSlackBridge({ adapter, registry, dispatch: () => null, killAllSessions: () => false, sendEscape: () => undefined, holdsLease: () => true });
}

describe('the Slack bridge shows names and channel titles', () => {
  it('a logged id-as-name and a ring row with no name both get the cached display name; the bot keeps none', () => {
    const bridge = stub({ U0CER2ZL62Y: 'Echo Headley', U0CFA03N5QF: 'Gear Test' }, { C0CG1C62HUL: 'dcproof-test' });
    const rows = bridge.history(bridge.resolve(-126660833)!, 50);
    expect(rows.find((r) => r.text === '[TEST] inbound')!.senderName).toBe('Echo Headley');
    expect(rows.find((r) => r.text === '[TEST] Second person')!.senderName).toBe('Gear Test');
    expect(rows.find((r) => r.text === 'bot line')!.senderName).toBeNull();
  });
  it('the list title is the channel name, not the id', () => {
    const bridge = stub({}, { C0CG1C62HUL: 'dcproof-test' });
    expect(slackListRows(bridge)[0]!.title).toBe('#dcproof-test');
    expect(slackConversationTitle(bridge.resolve(-126660833)!)).toBe('#dcproof-test');
  });
  it('while a name is unknown the row and title fall back (the adapter logs why)', () => {
    const bridge = stub({}, {});
    const rows = bridge.history(bridge.resolve(-126660833)!, 50);
    expect(rows.find((r) => r.text === '[TEST] inbound')!.senderName).toBe('U0CER2ZL62Y');
    expect(rows.find((r) => r.text === '[TEST] Second person')!.senderName).toBeNull();
    expect(slackListRows(bridge)[0]!.title).toBe('#C0CG1C62HUL');
  });
  it('a label still wins over the channel name', () => {
    expect(slackConversationTitle({ id: -1, key: 'k', channelId: 'C1', threadTs: null, label: 'Ops', mintedAt: null, channelName: 'ops-room' })).toBe('Ops');
  });
});

describe('SlackAdapter cached lookups', () => {
  function adapter() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-names-adapter-'));
    dirs.push(dir);
    const a = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U0CER2ZL62Y'] } as never, dir);
    (a as unknown as { started: boolean }).started = true;
    return a;
  }
  it('a miss starts one lookup and the next read has the name (users.info real_name, conversations.info name)', async () => {
    const a = adapter();
    const calls: string[] = [];
    (a as unknown as { apiClient: { call: (m: string, p: Record<string, unknown>) => Promise<unknown> } }).apiClient.call = async (m, p) => {
      calls.push(m);
      if (m === 'users.info') return { ok: true, user: { id: p.user, name: 'gearfinity3d', real_name: 'Gear Test' } };
      if (m === 'conversations.info') return { ok: true, channel: { id: p.channel, name: 'dcproof-test' } };
      throw new Error(`unexpected ${m}`);
    };
    expect(a.cachedUserName('U0CFA03N5QF')).toBeNull();
    expect(a.cachedChannelName('C0CG1C62HUL')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(a.cachedUserName('U0CFA03N5QF')).toBe('Gear Test');
    expect(a.cachedChannelName('C0CG1C62HUL')).toBe('dcproof-test');
    expect(calls.filter((c) => c === 'users.info')).toHaveLength(1);
  });
  it('a failed lookup is logged with its reason, once, never silently', async () => {
    const a = adapter();
    (a as unknown as { apiClient: { call: () => Promise<unknown> } }).apiClient.call = async () => { throw new Error('user_not_found'); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    a.cachedUserName('U0CFA03N5QF');
    await new Promise((r) => setTimeout(r, 20));
    a.cachedUserName('U0CFA03N5QF');
    await new Promise((r) => setTimeout(r, 20));
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('could not resolve the user name of U0CFA03N5QF'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('user_not_found');
    warn.mockRestore();
  });
});
