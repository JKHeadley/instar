/**
 * Every Ask Is Actionable — the Telegram side (src/messaging/attentionAction.ts and
 * the Attention hub post). Both sides of each decision: an item with a console place
 * gets an inline URL button to /dashboard/console/#/…; an item with none, or no public
 * https base, posts without a button AND is recorded in logs/attention-unactionable.jsonl.
 * Exercises the REAL TelegramAdapter with only apiCall stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter, type TelegramConfig } from '../../src/messaging/TelegramAdapter.js';
import { attentionActionFor, consoleUrl, peerItemAction, validAction } from '../../src/messaging/attentionAction.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('attentionActionFor', () => {
  it('maps a sign-in item to the exact Accounts place, with the item id', () => {
    const a = attentionActionFor({ id: 'agent:account-follow-me-email:adriana:this-machine', category: 'account-follow-me', title: 'Account enrollment needs your check' });
    expect(a).toEqual({ kind: 'open', label: 'Open sign-in', href: '#/capacity/accounts?s=needs&item=agent%3Aaccount-follow-me-email%3Aadriana%3Athis-machine' });
  });
  it('maps held replies, feedback, safety checks, machines and duplicates to their pages', () => {
    expect(attentionActionFor({ id: 'telegram-origin-held:57692', category: 'telegram-origin' })!.href).toBe('#/people/messages?s=held&item=telegram-origin-held%3A57692');
    expect(attentionActionFor({ id: 'feedback-drain:readiness-paused:a:1', category: 'monitoring' })!.href).toMatch(/^#\/work\/development\?s=feedback&item=/);
    expect(attentionActionFor({ id: 'guard-posture-disabled:2026-10-19:x', category: 'monitoring' })!.href).toMatch(/^#\/settings\/allowed\?s=guards&item=/);
    expect(attentionActionFor({ id: 'machine-coherence:ep1', category: 'machine-coherence' })!.href).toMatch(/^#\/capacity\/machines\?item=/);
    expect(attentionActionFor({ id: 'dup-reconciler-breaker:telegram:1', category: 'system' })!.href).toMatch(/^#\/work\/sessions\?item=/);
  });
  it('an item with no console place has no action (it is the agent’s, not an ask)', () => {
    expect(attentionActionFor({ id: 'agent:kmem-202610141228', category: 'general', title: 'Studio kernel memory at 7 GB' })).toBeNull();
    expect(attentionActionFor({ id: '', category: 'account-follow-me' })).toBeNull();
    expect(attentionActionFor(null)).toBeNull();
  });
  it('honours a valid producer-supplied action and ignores an invalid one', () => {
    expect(attentionActionFor({ id: 'x', category: 'general', action: { kind: 'open', href: '#/people/mandates?s=waiting', label: 'Approve the slip' } }))
      .toEqual({ kind: 'open', href: '#/people/mandates?s=waiting', label: 'Approve the slip' });
    expect(validAction({ kind: 'open', href: 'javascript:alert(1)', label: 'x' })).toBe(false);
    expect(validAction({ kind: 'open', href: 'https://evil.example/', label: 'x' })).toBe(false);
    expect(validAction({ kind: 'open', href: '#/home', label: '' })).toBe(false);
    expect(attentionActionFor({ id: 'x', category: 'general', action: { kind: 'open', href: 'https://evil.example', label: 'Go' } })).toBeNull();
  });
});

describe('consoleUrl', () => {
  const a = { kind: 'open' as const, href: '#/capacity/accounts?s=needs', label: 'Open sign-in' };
  it('builds the public console link from an https tunnel', () => {
    expect(consoleUrl('https://echo-studio.dawn-tunnel.dev/', a)).toBe('https://echo-studio.dawn-tunnel.dev/dashboard/console/#/capacity/accounts?s=needs');
  });
  it('never links to localhost, plain http, or nothing', () => {
    expect(consoleUrl('http://echo.example', a)).toBeNull();
    expect(consoleUrl('https://localhost:4040', a)).toBeNull();
    expect(consoleUrl('https://127.0.0.1:4040', a)).toBeNull();
    expect(consoleUrl(null, a)).toBeNull();
    expect(consoleUrl('https://echo.example', null)).toBeNull();
  });
});

describe('Attention hub post carries the one tap', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;
  const HUB = 4242;
  function make(config: Partial<TelegramConfig> = {}): { sends: Array<Record<string, unknown>> } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-action-'));
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => HUB, ...config }, tmpDir);
    const sends: Array<Record<string, unknown>> = [];
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method === 'sendMessage') { sends.push({ ...params }); return { message_id: 100 + sends.length }; }
        return { ok: true };
      });
    return { sends };
  }
  const log = () => path.join(tmpDir, 'logs', 'attention-unactionable.jsonl');
  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'attention-action test cleanup' });
  });

  it('an item with a console place posts with an inline URL button to the exact place (tunnel URL, never localhost)', async () => {
    const { sends } = make();
    adapter.setPublicBaseUrlResolver(() => 'https://echo-studio.dawn-tunnel.dev');
    await adapter.createAttentionItem({ id: 'telegram-origin-held:57692', title: 'Reply to topic 57692 is held', summary: 'Held.', category: 'telegram-origin', priority: 'HIGH' });
    expect(sends).toHaveLength(1);
    expect(sends[0].message_thread_id).toBe(HUB);
    expect(sends[0].reply_markup).toEqual({ inline_keyboard: [[{ text: 'Review held replies', url: 'https://echo-studio.dawn-tunnel.dev/dashboard/console/#/people/messages?s=held&item=telegram-origin-held%3A57692' }]] });
    expect(fs.existsSync(log())).toBe(false);
  });

  it('an item with no possible action still posts, without a button, and is logged as unactionable', async () => {
    const { sends } = make();
    adapter.setPublicBaseUrlResolver(() => 'https://echo-studio.dawn-tunnel.dev');
    await adapter.createAttentionItem({ id: 'agent:kmem-1', title: 'Kernel memory is high', summary: 'Watch it.', category: 'general', priority: 'HIGH' });
    expect(sends).toHaveLength(1);
    expect(sends[0].reply_markup).toBeUndefined();
    const rows = fs.readFileSync(log(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([expect.objectContaining({ id: 'agent:kmem-1', reason: 'no-action', category: 'general' })]);
  });

  it('with an action but no public URL (no tunnel), the post goes out without a button and the log says why', async () => {
    const { sends } = make();
    await adapter.createAttentionItem({ id: 'telegram-origin-held:1', title: 'Reply held', summary: 'Held.', category: 'telegram-origin', priority: 'HIGH' });
    expect(sends[0].reply_markup).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(log(), 'utf-8').trim())).toMatchObject({ id: 'telegram-origin-held:1', reason: 'no-public-url' });
  });

  it('a relayed send (tokenless standby) cannot carry markup, so the button URL rides in the text', async () => {
    make({ token: undefined as unknown as string });
    const relayed: string[] = [];
    adapter.outboundRelay = async (_topic, text) => { relayed.push(text); return { messageId: 9 } as never; };
    await adapter.sendToTopic(HUB, 'Reply held', { urlButtons: [{ text: 'Review held replies', url: 'https://echo.example.dev/dashboard/console/#/people/messages' }] });
    expect(relayed).toEqual(['Reply held\n\nReview held replies: https://echo.example.dev/dashboard/console/#/people/messages']);
  });

  it('the config accessor works as the resolver too (server wiring is either path)', async () => {
    const { sends } = make({ getPublicBaseUrl: () => 'https://named.example.dev' });
    await adapter.createAttentionItem({ id: 'guard-posture-disabled:2026-10-26:x', title: '2 guards disabled', summary: 's', category: 'monitoring', priority: 'HIGH' });
    const kb = sends[0].reply_markup as { inline_keyboard: Array<Array<{ url: string }>> };
    expect(kb.inline_keyboard[0][0].url).toBe('https://named.example.dev/dashboard/console/#/settings/allowed?s=guards&item=guard-posture-disabled%3A2026-10-26%3Ax');
  });
});

describe('a refused button never costs the alert (fb-99bc2103-19b)', () => {
  let adapter: TelegramAdapter;
  let tmpDir: string;
  const HUB = 4242;
  function make(refuse: (p: Record<string, unknown>) => boolean): { calls: Array<Record<string, unknown>>; sends: Array<Record<string, unknown>> } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-btn-'));
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => HUB }, tmpDir);
    adapter.setPublicBaseUrlResolver(() => 'https://echo-studio.dawn-tunnel.dev');
    const calls: Array<Record<string, unknown>> = [];
    const sends: Array<Record<string, unknown>> = [];
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (method: string, params: Record<string, unknown>) => {
        if (method !== 'sendMessage') return { ok: true };
        calls.push({ ...params });
        if (refuse(params)) throw new Error('Telegram API error (400): Bad Request: BUTTON_URL_INVALID');
        sends.push({ ...params });
        return { message_id: 100 + calls.length };
      });
    return { calls, sends };
  }
  const log = () => path.join(tmpDir, 'logs', 'attention-unactionable.jsonl');
  afterEach(async () => {
    await adapter.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'attention-button test cleanup' });
  });

  it('Telegram refuses the button: the retry drops reply_markup, the post is delivered, and it is logged as button-refused', async () => {
    const { calls, sends } = make((p) => p.reply_markup !== undefined);
    const created = await adapter.createAttentionItem({ id: 'telegram-origin-held:57692', title: 'Reply held', summary: 'Held.', category: 'telegram-origin', priority: 'HIGH' });
    expect(created.topicId).toBe(HUB);
    expect(sends).toHaveLength(1);
    expect(sends[0].reply_markup).toBeUndefined();
    expect(sends[0].text).toContain('Reply held');
    expect(sends[0].message_thread_id).toBe(HUB);
    // The formatted text survives without the button (no visible tags).
    expect(sends[0].parse_mode).toBe('HTML');
    // Both refused attempts carried the button; only the delivered one did not.
    expect(calls.filter((c) => c.reply_markup !== undefined)).toHaveLength(2);
    const rows = fs.readFileSync(log(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([expect.objectContaining({ id: 'telegram-origin-held:57692', reason: 'button-refused' })]);
  });

  it('when even the formatted text is refused, the plain text without the button still goes out', async () => {
    const { sends } = make((p) => p.reply_markup !== undefined || p.parse_mode === 'HTML');
    await adapter.createAttentionItem({ id: 'telegram-origin-held:2', title: 'Reply held', summary: 'Held.', category: 'telegram-origin', priority: 'HIGH' });
    expect(sends).toHaveLength(1);
    expect(sends[0].reply_markup).toBeUndefined();
    expect(sends[0].parse_mode).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(log(), 'utf-8').trim())).toMatchObject({ reason: 'button-refused' });
  });

  it('a timeout (not a refusal) is NOT re-sent without the button: no duplicate risk beyond the old single retry', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-btn-'));
    adapter = new TelegramAdapter({ token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100 }, tmpDir);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(adapter as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
      .mockImplementation(async (_m: string, params: Record<string, unknown>) => { calls.push({ ...params }); throw new Error('The operation was aborted due to timeout'); });
    await expect(adapter.sendToTopic(HUB, '<b>x</b>', { formatMode: 'html', urlButtons: [{ text: 'Open', url: 'https://echo.example.dev/dashboard/console/#/home' }] })).rejects.toThrow(/timeout/);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.reply_markup !== undefined)).toBe(true);
  });

  it('button accepted: one send with the button, nothing logged (unchanged)', async () => {
    const { calls, sends } = make(() => false);
    await adapter.createAttentionItem({ id: 'telegram-origin-held:3', title: 'Reply held', summary: 'Held.', category: 'telegram-origin', priority: 'HIGH' });
    expect(calls).toHaveLength(1);
    expect(sends[0].reply_markup).toBeDefined();
    expect(fs.existsSync(log())).toBe(false);
  });

  it('a formatting failure with the button accepted keeps the button on the plain retry (unchanged)', async () => {
    const { sends } = make((p) => p.parse_mode === 'HTML');
    await adapter.createAttentionItem({ id: 'telegram-origin-held:4', title: 'Reply held', summary: 'Held.', category: 'telegram-origin', priority: 'HIGH' });
    expect(sends).toHaveLength(1);
    expect(sends[0].reply_markup).toBeDefined();
    expect(fs.existsSync(log())).toBe(false);
  });
});

describe('peerItemAction (items from another machine)', () => {
  let tmpDir: string;
  afterEach(() => { if (tmpDir) SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'peer-action test cleanup' }); });
  it('keeps a valid console action, refuses and logs a foreign one, keeps null, and stamps an older peer from the rules', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-peer-action-'));
    expect(peerItemAction({ id: 'a', action: { kind: 'open', href: '#/people/mandates?s=waiting', label: 'Open approvals' } }, tmpDir))
      .toEqual({ kind: 'open', href: '#/people/mandates?s=waiting', label: 'Open approvals' });
    expect(peerItemAction({ id: 'b', title: 'phish', action: { kind: 'open', href: 'https://evil.example', label: 'Go' } }, tmpDir)).toBeNull();
    expect(peerItemAction({ id: 'b', title: 'phish', action: { kind: 'open', href: 'https://evil.example', label: 'Go' } }, tmpDir)).toBeNull();
    expect(peerItemAction({ id: 'c', action: null }, tmpDir)).toBeNull();
    expect(peerItemAction({ id: 'telegram-origin-held:9', category: 'telegram-origin' }, tmpDir)).toMatchObject({ label: 'Review held replies' });
    const rows = fs.readFileSync(path.join(tmpDir, 'attention-unactionable.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    // Logged once, not once per poll.
    expect(rows).toEqual([expect.objectContaining({ id: 'b', reason: 'peer-action-invalid' })]);
  });
});
