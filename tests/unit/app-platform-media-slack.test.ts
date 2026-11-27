/**
 * Slack media in the app's history (docs/specs/mobile-native-chat-media.md §4.9, Slack half):
 * Slack canonical keys (including the registry's `_` workspace placeholder) in `platform-media`
 * events, the per-file platform message id, the conversation key from the real registry mint,
 * "held locally" for downloads, the lookup of every file of one message (also under the earlier
 * placeholder key), the device text with no server path, and the SlackAdapter hook (one call per
 * file, under the tag the session received; a shared text file inlined is not copied; a failing
 * or never-settling hook never stops delivery; standalone `file_shared` files too).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore, platformMediaMessageId, validateAppEvent, type AppEvent } from '../../src/core/AppConversationStore.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';
import { attachmentIdFor } from '../../src/core/appMediaTypes.js';
import {
  recordPlatformMedia, slackConversationHeldLocally, slackDeviceText, slackMediaConversationKey, slackMediaKeys,
  slackPlatformMediaFor, slackPlatformMessageId,
} from '../../src/core/appPlatformMedia.js';
import type { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { SlackAdapter, type SlackInboundMedia } from '../../src/messaging/slack/SlackAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/app-platform-media-slack.test.ts' }); });

const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const jpeg = (n = 300) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const TS = '1793600123.000200';

function pmEvent(key: string, pmid: string): AppEvent {
  const messageId = platformMediaMessageId(key, pmid);
  return {
    eventId: messageId, kind: 'platform-media', conversationKey: key, messageId, platformMessageId: pmid,
    attachments: [{ attachmentId: attachmentIdFor(messageId, 0), index: 0, sha256: 'b'.repeat(64), size: 10, declaredKind: 'file', kind: 'file', mediaType: 'application/pdf', declaredType: 'application/pdf', filename: 'r.pdf' }],
    at: new Date().toISOString(), machineId: 'm1',
  } as AppEvent;
}

function setup() {
  const dir = tmp('pmedia-slack-');
  const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' });
  const media = new AppMediaStore({ stateDir: dir, store, maxStoreBytes: () => 1e9, diskSpace: () => ({ free: 1e12, total: 2e12 }) });
  const svc = { store, media, deps: { machineId: () => 'm1' } } as unknown as AppConversationService;
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1', isRecordingEnabled: () => true });
  const file = (name: string, bytes: Buffer) => { const p = path.join(dir, 'slack-files', name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
  return { dir, store, media, svc, registry, file };
}

describe('Slack keys in platform-media events', () => {
  it('accepts the registry placeholder workspace, a concrete workspace and a thread; refuses a malformed Slack key', () => {
    expect(validateAppEvent(pmEvent('slack:_:C0123ABC', TS))).toMatchObject({ kind: 'platform-media' });
    expect(validateAppEvent(pmEvent('slack:T01WORK:C0123ABC', TS))).toMatchObject({ kind: 'platform-media' });
    expect(validateAppEvent(pmEvent('slack:_:C0123ABC:1793600000.000100', `${TS}:2`))).toMatchObject({ kind: 'platform-media', platformMessageId: `${TS}:2` });
    expect(validateAppEvent(pmEvent('slack:_:', TS))).toBeNull();
    expect(validateAppEvent(pmEvent('slack:a b:C1', TS))).toBeNull();
  });

  it('per-file platform ids and the placeholder variant of a key', () => {
    expect(slackPlatformMessageId(TS, 0)).toBe(TS);
    expect(slackPlatformMessageId(TS, 3)).toBe(`${TS}:3`);
    expect(slackMediaKeys('slack:_:C1')).toEqual(['slack:_:C1']);
    expect(slackMediaKeys('slack:T01:C1:1793600000.000100')).toEqual(['slack:T01:C1:1793600000.000100', 'slack:_:C1:1793600000.000100']);
  });
});

describe('the conversation a Slack file belongs to', () => {
  it('is the registry key for the routing key (channel, thread); an unparseable routing key has none', () => {
    const { registry } = setup();
    const channelKey = slackMediaConversationKey(registry, 'C0123ABC');
    expect(channelKey).toBe('slack:_:C0123ABC');
    // The same key the app store uses for that conversation: what resolve(id) returns.
    const id = registry.mintForInbound('C0123ABC').id!;
    expect((registry.resolve(id) as { key: string }).key).toBe(channelKey);
    expect(slackMediaConversationKey(registry, 'C0123ABC:1793600000.000100')).toBe('slack:_:C0123ABC:1793600000.000100');
    expect(slackMediaConversationKey(registry, 'not a key!')).toBeNull();
    expect(slackMediaConversationKey({ mintForInbound: () => { throw new Error('x'); }, resolve: () => null, resolveByKey: () => null }, 'C1')).toBeNull();
  });

  it('is held locally only by its current key, minted here (not unknown, not replicated, not stale)', () => {
    const { registry } = setup();
    registry.mintForInbound('C0123ABC');
    expect(slackConversationHeldLocally(registry, 'slack:_:C0123ABC')).toBe(true);
    expect(slackConversationHeldLocally(registry, 'slack:_:C0999ZZZ')).toBe(false);
    expect(slackConversationHeldLocally(registry, 'telegram:5')).toBe(false);
    // A replicated entry (minted by another machine) is not held here.
    expect(slackConversationHeldLocally({ resolveByKey: () => ({ platform: 'slack', key: 'slack:_:C1', origin: 'replicated' }) }, 'slack:_:C1')).toBe(false);
    // A stale placeholder ref for a conversation whose workspace is now known is not its current key.
    expect(slackConversationHeldLocally({ resolveByKey: () => ({ platform: 'slack', key: 'slack:T01:C1', origin: 'inbound' }) }, 'slack:_:C1')).toBe(false);
    expect(slackConversationHeldLocally({ resolveByKey: () => { throw new Error('x'); } }, 'slack:_:C1')).toBe(false);
  });
});

describe('recording and reading every file of a Slack message', () => {
  it('records each file under its own id, finds them in order, also under the earlier placeholder key', async () => {
    const e = setup();
    const key = 'slack:_:C0123ABC';
    const photo = jpeg();
    const pdf = Buffer.from('%PDF-1.7 slack');
    const r0 = await recordPlatformMedia(e.svc, { conversationKey: key, platformMessageId: slackPlatformMessageId(TS, 0), filePath: e.file('a.pdf', pdf), declaredKind: 'file', filename: 'Plan.pdf', declaredType: 'application/pdf', at: '' });
    const r2 = await recordPlatformMedia(e.svc, { conversationKey: key, platformMessageId: slackPlatformMessageId(TS, 2), filePath: e.file('b.jpg', photo), declaredKind: 'photo', filename: 'shot.jpg', declaredType: 'image/jpeg', at: '' });
    expect(r0.recorded && r2.recorded).toBe(true);
    const found = slackPlatformMediaFor(e.store, key, TS)!;
    expect(found.map((a) => a.filename)).toEqual(['Plan.pdf', 'shot.jpg']);
    expect(found[1]).toMatchObject({ kind: 'photo', sha256: sha(photo) });
    // Once the registry learns the workspace the key changes; the files recorded before still show.
    expect(slackPlatformMediaFor(e.store, 'slack:T01WORK:C0123ABC', TS)!.map((a) => a.filename)).toEqual(['Plan.pdf', 'shot.jpg']);
    expect(slackPlatformMediaFor(e.store, key, '1793600999.000001')).toBeNull();
    // A re-delivered message appends nothing.
    expect(await recordPlatformMedia(e.svc, { conversationKey: key, platformMessageId: TS, filePath: e.file('c.pdf', pdf), declaredKind: 'file', filename: 'x', declaredType: 'x', at: '' })).toMatchObject({ recorded: false, reason: 'duplicate' });
  });

  it('the device text names files and never shows a path', () => {
    const atts = [{ declaredKind: 'file', filename: 'Plan.pdf' }] as never;
    expect(slackDeviceText('see [document:/Users/me/.instar/slack-files/file-1-F1.pdf] [image:/Users/me/.instar/slack-files/photo-1-F2.png]', atts)).toBe('see [file: Plan.pdf] [photo]');
    expect(slackDeviceText('[User shared "notes" but the content could not be retrieved — file may require manual review at /Users/me/.instar/slack-files/file-1.txt]'))
      .toBe('[User shared "notes" but the content could not be retrieved — file may require manual review on the agent\'s machine]');
    expect(slackDeviceText('abc\n... [truncated, full content saved to /Users/me/.instar/slack-files/file-2.txt]')).toBe('abc\n... [truncated, full content saved on the agent\'s machine]');
    expect(slackDeviceText('[voice] hello')).toBe('[voice] hello');
  });
});

describe('SlackAdapter inbound media hook', () => {
  function adapter() {
    const dir = tmp('pmedia-slackad-');
    fs.mkdirSync(path.join(dir, 'slack-files'), { recursive: true });
    const a = new SlackAdapter({ botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: ['U_TEST'], workspaceMode: 'dedicated' } as never, dir);
    const delivered: string[] = [];
    a.onMessage(async (m) => { delivered.push(m.content); });
    const internals = a as unknown as {
      getUserInfo: () => Promise<{ name: string }>;
      apiClient: { call: (m: string, p: Record<string, unknown>) => Promise<Record<string, unknown>> };
      fileHandler: { downloadDir: string; downloadFile: (u: string, d: string) => Promise<string> };
      _handleMessage: (e: Record<string, unknown>) => Promise<void>;
      _handleFileShared: (e: Record<string, unknown>) => Promise<void>;
    };
    internals.getUserInfo = async () => ({ name: 'tester' });
    const png = Buffer.alloc(200); png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
    internals.fileHandler.downloadFile = async (url, dest) => {
      fs.writeFileSync(dest, url.endsWith('.png') ? png : url.endsWith('.txt') ? 'plain notes' : '%PDF-1.7');
      return dest;
    };
    internals.apiClient.call = async (method) => (method === 'files.info'
      ? { ok: true, file: { id: 'F0SOLO1', name: 'solo.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/solo.pdf' } }
      : { ok: true });
    return { a, internals, delivered };
  }
  const msg = (files: Array<Record<string, unknown>>) => ({ user: 'U_TEST', text: 'files', channel: 'D0TEST1', ts: TS, files, subtype: 'file_share' });

  it('one call per file, under the tag the session got; an inlined text file is not copied', async () => {
    const { a, internals, delivered } = adapter();
    const seen: Array<SlackInboundMedia & { existed: boolean }> = [];
    a.setInboundMediaHook(async (info) => { seen.push({ ...info, existed: fs.existsSync(info.filePath) }); });
    await internals._handleMessage(msg([
      { id: 'F1', name: 'Plan.pdf', mimetype: 'application/pdf', url_private_download: 'https://x/plan.pdf' },
      { id: 'F2', name: 'notes.txt', mimetype: 'text/plain', url_private_download: 'https://x/notes.txt', preview: 'plain notes' },
      { id: 'F3', name: 'shot.png', mimetype: 'image/png', url_private_download: 'https://x/shot.png', original_w: 640, original_h: 480 },
    ]));
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered).toHaveLength(1);
    expect(seen.map((s) => [s.fileIndex, s.declaredKind, s.filename])).toEqual([[0, 'file', 'Plan.pdf'], [2, 'photo', 'shot.png']]);
    expect(seen[1]).toMatchObject({ channelId: 'D0TEST1', threadTs: null, platformMessageId: TS, width: 640, height: 480, declaredType: 'image/png', existed: true });
    expect(seen[0]!.at).toBe(new Date(parseFloat(TS) * 1000).toISOString());
  });

  it('a throwing hook, or one that never settles, never stops delivery', async () => {
    const { a, internals, delivered } = adapter();
    a.setInboundMediaHook(async () => { throw new Error('boom'); });
    await internals._handleMessage(msg([{ id: 'F1', name: 'Plan.pdf', mimetype: 'application/pdf', url_private_download: 'https://x/plan.pdf' }]));
    const stuck = adapter();
    stuck.a.setInboundMediaHook(() => new Promise<void>(() => undefined));
    await stuck.internals._handleMessage({ ...msg([{ id: 'F1', name: 'Plan.pdf', mimetype: 'application/pdf', url_private_download: 'https://x/plan.pdf' }]), ts: '1793600124.000300' });
    expect(delivered).toHaveLength(1);
    expect(stuck.delivered).toHaveLength(1);
  });

  it('with no hook set (media off) delivery is unchanged; a standalone file_shared file is handed over with its log id', async () => {
    const { internals, delivered } = adapter();
    await internals._handleMessage(msg([{ id: 'F1', name: 'Plan.pdf', mimetype: 'application/pdf', url_private_download: 'https://x/plan.pdf' }]));
    expect(delivered[0]).toMatch(/^files \[document:.*\.pdf\]$/);

    const solo = adapter();
    const seen: SlackInboundMedia[] = [];
    solo.a.setInboundMediaHook((info) => { seen.push(info); });
    await solo.internals._handleFileShared({ file_id: 'F0SOLO1', user_id: 'U_TEST', channel_id: 'C0SOLO1' });
    expect(solo.delivered).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ channelId: 'C0SOLO1', threadTs: null, fileIndex: 0, declaredKind: 'file', filename: 'solo.pdf' });
    expect(seen[0]!.platformMessageId).toMatch(/^file-F0SOLO1-\d+$/);
  });
});
