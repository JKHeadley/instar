/**
 * Slack from the app (docs/specs/mobile-native-conversations.md §4.9, increment 4) — the pure
 * pieces: the v2 receipt that binds a Slack send (whose path names a machine-local alias) to the
 * canonical key it was stored under, on both sides of every check; the store keeping the v2
 * receipt fields; the id/owner/title helpers; the production bridge over a stub Slack adapter and
 * a real slack-messages.jsonl (thread filtering, ring merge, list activity, dispatch shape, pause);
 * and the CLAUDE.md section's migration (added once).
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  verifyRecordedOrigin, signReceipt, signerKeyHashOf, deviceKeyHashOf, isSlackStoreKey,
  type LedgerKey, type MachineKeyLookup, type MachineSigner, type StoredDeviceOrigin, type VerifiableRecord,
} from '../../src/core/AppRecordSignatures.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { validateAppEvent } from '../../src/core/AppConversationStore.js';
import {
  buildMobileSlackBridge, parseSlackConversationId, slackConversationTitle, slackListRows, slackOwnerUserId,
  type SlackAdapterLike, type SlackAppConversation,
} from '../../src/server/mobileSlackRoutes.js';
import { mergeConversationPages } from '../../src/server/mobileConversationRoutes.js';
import { PostUpdateMigrator, SLACK_FROM_APP_CLAUDEMD_MARKER, SLACK_FROM_APP_CLAUDEMD_SECTION, SLACK_OWNER_READ_AUTHORITY_LINE } from '../../src/core/PostUpdateMigrator.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { AppConversationService } from '../../src/core/AppConversationService.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { MobileChatRequestStore } from '../../src/core/MobileChatRequests.js';
import { derivedEventId } from '../../src/core/appConversationText.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-slack-from-app.test.ts' }); });
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const HOST = 'echo.example.dev';
const DEVICE_ID = 'dev-0001-aaaa';
const SLACK_KEY = 'slack:T0ABC:C0123ABC';
const THREAD_KEY = 'slack:T0ABC:C0123ABC:1730000000.000100';
const T0 = Date.parse('2026-11-02T12:00:00.000Z');

function fakeMachine(machineId = 'm_alpha') {
  const kp = generateSigningKeyPair();
  const hash = signerKeyHashOf(kp.publicKey);
  const signer: MachineSigner = {
    machineId: () => machineId, signerKeyHash: () => hash,
    sign: (payload) => ({ machineId, signerKeyHash: hash, sig: edSign(payload, kp.privateKey) }),
  };
  const lookup: MachineKeyLookup = (mid, h) => (mid === machineId && h === hash ? { status: 'ok', publicKeyPem: kp.publicKey } : { status: 'unknown' });
  return { signer, lookup };
}

function slackRecord(opts: { key?: string; path?: string; receiptKey?: string | null; recordKey?: string } = {}) {
  const dev = makeDevice();
  const machine = fakeMachine();
  const text = 'Ship it after lunch';
  const raw = Buffer.from(JSON.stringify({ text, requestId: `${T0}-abc` }));
  const p = opts.path ?? '/mobile/chat/slack/-4242';
  const receivedMs = T0 + 5_000;
  const time = String(receivedMs);
  const sig = dev.sign(canonicalString(DEVICE_ID, HOST, 'POST', p, time, raw));
  const bodySha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const receivedAt = new Date(receivedMs).toISOString();
  const base = { kind: 'device-signed' as const, v: 1 as const, deviceId: DEVICE_ID, keyHash: deviceKeyHashOf(dev.publicKey), publicKey: dev.publicKey, host: HOST, method: 'POST', pathWithQuery: p, timeMs: time, bodySha256, sig };
  const origin: StoredDeviceOrigin = { ...base, bodyB64: raw.toString('base64') };
  const key = opts.key ?? SLACK_KEY;
  const receipt = opts.receiptKey === null ? signReceipt(machine.signer, base, receivedAt) : signReceipt(machine.signer, base, receivedAt, opts.receiptKey ?? key);
  const record: VerifiableRecord = { conversationKey: opts.recordKey ?? key, text, origin, receivedAt, receipt };
  const entry: LedgerKey = { keyHash: base.keyHash, publicKey: dev.publicKey, deviceId: DEVICE_ID, host: HOST, approvedVia: 'telegram-dm', activatedAt: new Date(T0).toISOString(), revokedAt: null };
  return { record, ledger: new Map([[`${base.keyHash}|${DEVICE_ID}`, entry]]), lookup: machine.lookup };
}

describe('v2 receipts bind a Slack send to its canonical key', () => {
  it('verified for a channel and for a thread conversation, whatever the alias in the path', () => {
    for (const key of [SLACK_KEY, THREAD_KEY]) {
      const b = slackRecord({ key, path: '/mobile/chat/slack/-9007199254' });
      expect(verifyRecordedOrigin(b.record, b.ledger, b.lookup)).toBe('verified');
    }
    expect(isSlackStoreKey(SLACK_KEY)).toBe(true);
    expect(isSlackStoreKey('slack:_:D0XYZ')).toBe(true);
    expect(isSlackStoreKey('telegram:7')).toBe(false);
  });

  it('failed when the record is moved to another conversation (the receipt names the original)', () => {
    const b = slackRecord({ recordKey: 'slack:T0ABC:C0OTHER' });
    expect(verifyRecordedOrigin(b.record, b.ledger, b.lookup)).toBe('failed');
  });

  it('failed when a Slack record carries only a v1 receipt (nothing binds its alias path)', () => {
    const b = slackRecord({ receiptKey: null });
    expect(verifyRecordedOrigin(b.record, b.ledger, b.lookup)).toBe('failed');
  });

  it('failed when the receipt fields are edited to name the record (the signature covers the key)', () => {
    const b = slackRecord({ receiptKey: 'slack:T0ABC:C0OTHER' });
    const forged = { ...b.record, receipt: { ...b.record.receipt!, conversationKey: SLACK_KEY } };
    expect(verifyRecordedOrigin(forged, b.ledger, b.lookup)).toBe('failed');
  });

  it('failed when a Slack record was signed for a non-Slack path, or an app path is reused for Slack', () => {
    const b = slackRecord({ path: '/mobile/chat/77' });
    expect(verifyRecordedOrigin(b.record, b.ledger, b.lookup)).toBe('failed');
    const c = slackRecord({ path: '/mobile/chat/slack/-0' });
    expect(verifyRecordedOrigin(c.record, c.ledger, c.lookup)).toBe('failed');
  });

  it('the store keeps a v2 receipt with its key, and drops a v2 receipt without one', () => {
    const base = { eventId: 'e1', kind: 'message', conversationKey: SLACK_KEY, messageId: 'm1', role: 'operator', text: 'hi', at: new Date(T0).toISOString(), machineId: 'm1' };
    const kept = validateAppEvent({ ...base, receipt: { machineId: 'm1', signerKeyHash: 'h', sig: 's', v: 2, conversationKey: SLACK_KEY } }) as { receipt?: Record<string, unknown> };
    expect(kept.receipt).toEqual({ machineId: 'm1', signerKeyHash: 'h', sig: 's', v: 2, conversationKey: SLACK_KEY });
    const dropped = validateAppEvent({ ...base, receipt: { machineId: 'm1', signerKeyHash: 'h', sig: 's', v: 2 } }) as { receipt?: unknown };
    expect(dropped.receipt).toBeUndefined();
    const v1 = validateAppEvent({ ...base, receipt: { machineId: 'm1', signerKeyHash: 'h', sig: 's' } }) as { receipt?: unknown };
    expect(v1.receipt).toEqual({ machineId: 'm1', signerKeyHash: 'h', sig: 's' });
  });
});

describe('helpers', () => {
  it('parses only strict negative ids', () => {
    expect(parseSlackConversationId('-42')).toBe(-42);
    for (const bad of ['42', '-0', '-042', '-4a', '', '-99999999999999999999']) expect(parseSlackConversationId(bad)).toBeNull();
  });

  it('reads the owner id only when it is a Slack user id', () => {
    expect(slackOwnerUserId({ mobilePairing: { slackOwnerUserId: 'U0ABC123' } } as never)).toBe('U0ABC123');
    expect(slackOwnerUserId({ mobilePairing: { slackOwnerUserId: 'justin' } } as never)).toBeNull();
    expect(slackOwnerUserId({} as never)).toBeNull();
  });

  it('titles a conversation by its label, else its channel, and says when it is a thread', () => {
    const c: SlackAppConversation = { id: -1, key: SLACK_KEY, channelId: 'C0123ABC', threadTs: null, label: null, mintedAt: null };
    expect(slackConversationTitle(c)).toBe('#C0123ABC');
    expect(slackConversationTitle({ ...c, label: 'general\u0000' })).toBe('#general');
    expect(slackConversationTitle({ ...c, threadTs: '1730000000.000100' })).toBe('#C0123ABC (thread)');
  });

  it('Slack rows page on the same cursor as app and Telegram rows', () => {
    const rows = [
      { id: -5, platform: 'slack' as const, title: 's', lastActivity: '2026-11-02T10:00:00.000Z', lastPreview: null },
      { id: 7, platform: 'telegram' as const, title: 't', lastActivity: '2026-11-02T11:00:00.000Z', lastPreview: null },
    ];
    const first = mergeConversationPages([{ rows: [rows[1]!], more: false }, { rows: [rows[0]!], more: false }], 1);
    expect(first.rows.map((r) => r.platform)).toEqual(['telegram']);
    expect(first.nextCursor).toBe('2026-11-02T11:00:00.000Z|telegram:7');
  });
});

function stubAdapter(dir: string, ring: Array<{ ts: string; user?: string; text: string; thread_ts?: string }> = []) {
  const logPath = path.join(dir, 'slack-messages.jsonl');
  const posted: Array<{ channelId: string; text: string; threadTs?: string }> = [];
  const logged: unknown[] = [];
  const adapter: SlackAdapterLike = {
    getChannelMessages: () => ring,
    getBotUserId: () => 'UBOT',
    getLogPath: () => logPath,
    logMessage: (e) => { logged.push(e); fs.appendFileSync(logPath, `${JSON.stringify({ ...e, timestamp: new Date().toISOString(), platform: 'slack' })}\n`); },
    sendToChannel: async (channelId, text, o) => { posted.push({ channelId, text, threadTs: o?.thread_ts }); return '1730000001.000001'; },
    getSessionForChannel: (k) => (k === 'C0123ABC' ? 'sess-slack' : null),
    isAuthorized: (u) => u === 'U0ABC123',
  };
  return { adapter, logPath, posted, logged };
}

function stubRegistry() {
  const entries = [
    { key: SLACK_KEY, entry: { id: -11, channelId: 'C0123ABC', threadTs: null, origin: 'minted-probed', mintedAt: '2026-11-01T00:00:00.000Z', label: 'general' } },
    { key: THREAD_KEY, entry: { id: -12, channelId: 'C0123ABC', threadTs: '1730000000.000100', origin: 'minted-probed', mintedAt: '2026-11-01T00:00:00.000Z' } },
    { key: 'slack:T0ABC:C0REPL', entry: { id: -13, channelId: 'C0REPL', threadTs: null, origin: 'replicated', mintedAt: '2026-11-01T00:00:00.000Z' } },
  ];
  return {
    list: () => entries,
    resolve: (id: number) => {
      const e = entries.find((x) => x.entry.id === id);
      return e ? { platform: 'slack', id, key: e.key, channelId: e.entry.channelId, threadTs: e.entry.threadTs, origin: e.entry.origin, label: (e.entry as { label?: string }).label } : null;
    },
  };
}

describe('the production bridge', () => {
  it('reads one channel or thread from the log tail and the ring, and lists local conversations only', () => {
    const dir = tmp('slackbridge-');
    const s = stubAdapter(dir, [{ ts: '1793615400.000000', user: 'UBOT', text: 'bot reply from the API' }]);
    const rows = [
      { messageId: '1730000010.000000', channelId: 'C0123ABC', text: 'channel hello', fromUser: true, timestamp: '2026-11-02T10:00:00.000Z', senderName: 'Justin' },
      { messageId: '1730000020.000000', channelId: 'C0123ABC', threadTs: '1730000000.000100', text: 'in the thread', fromUser: true, timestamp: '2026-11-02T10:01:00.000Z' },
      { messageId: '1730000030.000000', channelId: 'C0OTHER', text: 'elsewhere', fromUser: true, timestamp: '2026-11-02T10:02:00.000Z' },
    ];
    fs.writeFileSync(s.logPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
    let killed = false;
    const escaped: string[] = [];
    const bridge = buildMobileSlackBridge({
      adapter: s.adapter, registry: stubRegistry(), dispatch: () => null, killAllSessions: () => { killed = true; return true; },
      sendEscape: (sess) => escaped.push(sess), holdsLease: () => true,
    });
    expect(bridge.conversations().map((c) => c.id)).toEqual([-11, -12]);
    expect(bridge.resolve(-13)).toBeNull();
    expect(bridge.resolve(-99)).toBeNull();
    const chan = bridge.resolve(-11)!;
    const thread = bridge.resolve(-12)!;
    expect(bridge.history(chan, 50).map((r) => r.text)).toEqual(['channel hello', 'bot reply from the API']);
    expect(bridge.history(chan, 50).find((r) => r.text.startsWith('bot'))!.fromUser).toBe(false);
    expect(bridge.history(thread, 50).map((r) => r.text)).toEqual(['in the thread']);
    const list = slackListRows(bridge);
    expect(list.find((r) => r.id === -11)).toMatchObject({ title: '#general', lastActivity: '2026-11-02T10:00:00.000Z', lastPreview: 'channel hello' });
    expect(list.find((r) => r.id === -12)).toMatchObject({ title: '#C0123ABC (thread)', lastPreview: 'in the thread' });
    expect(bridge.emergencyStop()).toEqual({ stopped: true });
    expect(killed).toBe(true);
    expect(bridge.pause(chan)).toBe(true);
    expect(bridge.pause(thread)).toBe(false);
    expect(escaped).toEqual(['sess-slack']);
  });

  it('dispatches as the operator, in the thread, with the verdict for the tag; no dispatch wired is a refusal', async () => {
    const dir = tmp('slackbridge-');
    const s = stubAdapter(dir);
    const seen: Array<Record<string, unknown>> = [];
    const bridge = buildMobileSlackBridge({
      adapter: s.adapter, registry: stubRegistry(), killAllSessions: () => false, sendEscape: () => undefined, holdsLease: () => true,
      dispatch: () => async (m) => { seen.push(m as unknown as Record<string, unknown>); return 'delivered'; },
    });
    const thread = bridge.resolve(-12)!;
    expect(await bridge.dispatch({ conv: thread, text: 'hi', ownerName: 'Justin', ownerUserId: 'U0ABC123', messageId: 'mid1', originVerdict: 'verified' })).toBe('delivered');
    expect(seen[0]).toMatchObject({ userId: 'U0ABC123', content: 'hi', channel: { type: 'slack', identifier: 'C0123ABC' } });
    expect(seen[0]!.metadata).toMatchObject({ slackUserId: 'U0ABC123', senderName: 'Justin', threadTs: '1730000000.000100', appOrigin: 'verified', ts: 'app-mid1' });
    await bridge.post(thread, 'mirror');
    expect(s.posted).toEqual([{ channelId: 'C0123ABC', text: 'mirror', threadTs: '1730000000.000100' }]);
    bridge.logAppMessage(thread, { messageId: 'app-mid1', text: 'hi', senderName: 'Justin', ownerUserId: 'U0ABC123', eventId: 'ev1', deviceId: 'd1' });
    expect(bridge.history(thread, 10)[0]).toMatchObject({ eventId: 'ev1', text: 'hi' });
    const none = buildMobileSlackBridge({ adapter: s.adapter, registry: stubRegistry(), dispatch: () => null, killAllSessions: () => false, sendEscape: () => undefined, holdsLease: () => true });
    expect(await none.dispatch({ conv: thread, text: 'x', ownerName: 'J', ownerUserId: 'U0ABC123', messageId: 'm', originVerdict: 'none' })).toBe('refused');
  });
});

describe('boot recovery of an interrupted Slack send (crash between persist and dispatch)', () => {
  it('the saved message gets an unknown delivery and the request answers outcome-unknown; never re-dispatched', async () => {
    const dir = tmp('slackrecover-');
    let t = Date.now();
    const boot = () => {
      const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm1' });
      const requests = new MobileChatRequestStore(dir, () => t);
      const svc = new AppConversationService({ stateDir: dir, machineId: () => 'm1', registry, requests, holdsLease: () => true, ownerName: () => 'Justin', dispatch: () => null, now: () => t });
      return { svc, registry, requests };
    };
    const a = boot();
    const requestId = `${t}-0b3c8a3e-1b2c-4d5e-8f90-1234567890ab`;
    const messageId = derivedEventId('msg', 'seed');
    expect(a.requests.reserve('dev1', requestId, 'h', 0, { op: 'send', conversationKey: SLACK_KEY, messageId }).kind).toBe('reserved');
    a.svc.store.append({ eventId: 'op-1', kind: 'message', conversationKey: SLACK_KEY, messageId, role: 'operator', text: 'hi', at: new Date(t).toISOString(), machineId: 'm1' });
    a.svc.stop();
    await a.registry.close();
    t += 6 * 60_000;
    const b = boot();
    expect(b.requests.lookup('dev1', requestId, 'h')).toEqual({ kind: 'outcome-unknown' });
    expect(b.svc.store.deliveryState(messageId)).toBe('unknown');
    expect(b.svc.store.browseMessages(SLACK_KEY, null, 10).messages[0]).toMatchObject({ text: 'hi', deliveryState: 'unknown' });
    b.svc.stop();
    await b.registry.close();
  });
});

describe('agent awareness migration', () => {
  it('refreshes installed owner-history guidance once without replacing custom text', () => {
    const dir = tmp('slack-owner-read-mig-');
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n' + SLACK_FROM_APP_CLAUDEMD_MARKER + '\nCustom operator instruction.\n');
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4321, hasTelegram: false, projectName: 'x' } as never);
    const run = () => (m as unknown as { migrateClaudeMd(r: unknown): void })
      .migrateClaudeMd({ upgraded: [], errors: [], skipped: [] });
    run();
    const once = fs.readFileSync(file, 'utf8');
    run();
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
    expect(once.split(SLACK_OWNER_READ_AUTHORITY_LINE)).toHaveLength(2);
    expect(once).toContain('Custom operator instruction.');
    expect(SLACK_FROM_APP_CLAUDEMD_SECTION(4321)).toContain(SLACK_OWNER_READ_AUTHORITY_LINE);
  });

  it('adds the Slack-from-the-app section once', () => {
    const dir = tmp('slackmig-');
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Agent\n\nNative app conversations\n');
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir, port: 4321, hasTelegram: false, projectName: 'x' } as never);
    const run = () => (m as unknown as { migrateClaudeMd(r: { upgraded: string[]; errors: string[]; skipped: string[] }): void }).migrateClaudeMd({ upgraded: [], errors: [], skipped: [] });
    run(); run();
    const content = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(content.split(SLACK_FROM_APP_CLAUDEMD_MARKER).length - 1).toBe(1);
    expect(content).toContain('mobilePairing.slackOwnerUserId');
    expect(SLACK_FROM_APP_CLAUDEMD_SECTION(4321)).toContain('http://localhost:4321/mobile/chat/slack/CONVERSATION_ID/messages?machine=MACHINE');
  });
});
