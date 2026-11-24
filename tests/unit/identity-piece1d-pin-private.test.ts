// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * identity-security-piece1d: the dashboard PIN reaches the owner privately, never a group.
 * Spec: docs/specs/identity-security-piece1d-pin-private.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPinPrivate } from '../../src/server/dashboardPinPrivate.js';
import { PIN_DISCLOSURE_REWRITES, rewritePinDisclosure } from '../../src/core/pinDisclosureText.js';
import { PROTECTED_DELIVERY_CATEGORIES, isNotificationCategory } from '../../src/messaging/notificationCategories.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir = '';
afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/identity-piece1d-pin-private.test.ts:cleanup' }); dir = ''; });

function delivery(over: Partial<ConstructorParameters<typeof DashboardPinPrivate>[0]> = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-private-'));
  let gen = 'g1';
  const send = vi.fn().mockResolvedValue({ ok: true });
  const d = new DashboardPinPrivate({
    stateDir: dir, agentName: 'echo', machineId: () => 'm_1', machineLabel: () => 'studio',
    dashboardUrl: () => 'https://x.example/dashboard', pin: () => '482916', generation: () => gen,
    sendSecret: send, ...over,
  });
  return { d, send, setGen: (g: string) => { gen = g; } };
}

describe('private PIN delivery', () => {
  it('sends once per machine and PIN generation, recorded only on an accepted send', async () => {
    const { d, send, setGen } = delivery();
    expect(await d.deliver()).toEqual({ sent: true, machine: 'studio' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('482916');
    expect(send.mock.calls[0][0]).toContain('on studio');
    expect(await d.deliver()).toMatchObject({ sent: true });
    expect(send).toHaveBeenCalledTimes(1); // no repeat for the same generation
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'dashboard-pin-private.json'), 'utf-8'));
    rec.m_1.deliveredAt = new Date(Date.now() - 6 * 60_000).toISOString();
    fs.writeFileSync(path.join(dir, 'state', 'dashboard-pin-private.json'), JSON.stringify(rec));
    await d.deliver({ force: true });
    expect(send).toHaveBeenCalledTimes(2); // the owner or an agent asked, more than 5 minutes later
    setGen('g2');
    expect(d.deliveredForCurrent()).toBe(false);
    await d.deliver();
    expect(send).toHaveBeenCalledTimes(3); // a new PIN is sent again
  });

  it('a request within 5 minutes of a delivery answers "sent a moment ago" without sending again', async () => {
    const { d, send } = delivery();
    await d.deliver();
    expect(await d.deliver({ force: true })).toEqual({ sent: true, machine: 'studio', recent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatch(/\(Sent \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.\)/);
  });

  it('a failed send is not recorded as delivered, and the record never holds the PIN', async () => {
    const { d } = delivery({ sendSecret: vi.fn().mockResolvedValue({ ok: false, reason: 'no-private-chat' }) });
    expect(await d.deliver()).toEqual({ sent: false, reason: 'no-private-chat' });
    expect(d.deliveredForCurrent()).toBe(false);
    const raw = fs.readFileSync(path.join(dir, 'state', 'dashboard-pin-private.json'), 'utf-8');
    expect(raw).not.toContain('482916');
    expect(raw).toContain('g1');
  });

  it('no Telegram means no private channel; no PIN means nothing to send', async () => {
    expect(await delivery({ sendSecret: null }).d.deliver()).toEqual({ sent: false, reason: 'no-private-channel' });
    expect(await delivery({ pin: () => null }).d.deliver()).toEqual({ sent: false, reason: 'no-pin' });
  });

  it('the group may carry digits only on a definite "no private route", on the polling machine, with no other way in', () => {
    const { d } = delivery();
    expect(d.groupMayCarryDigits('no-owner')).toBe(true);
    expect(d.groupMayCarryDigits('no-private-chat')).toBe(true);
    expect(d.groupMayCarryDigits('held')).toBe(false);
    expect(delivery({ isStandby: () => true }).d.groupMayCarryDigits('no-owner')).toBe(false);
    expect(delivery({ ownerHasOtherWayIn: () => true }).d.groupMayCarryDigits('no-private-chat')).toBe(false);
  });
});

describe('the owner\'s private message resumes a pending delivery', () => {
  function adapter(owner: number | undefined, delivered = false) {
    const a = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    const deliver = vi.fn().mockResolvedValue({ sent: true, machine: 'studio' });
    (a as unknown as { config: unknown }).config = { ownerUserId: owner };
    a.setDashboardPinPrivacy({ deliver, deliveredForCurrent: () => delivered, groupMayCarryDigits: () => false });
    return { a, deliver };
  }
  it('only the configured owner, in their own private chat, not a forward or a bot', () => {
    const { a, deliver } = adapter(42);
    a.noteOwnerPrivateMessage({ chatType: 'private', chatId: 7, fromId: 7 }); // someone else
    a.noteOwnerPrivateMessage({ chatType: 'supergroup', chatId: -100, fromId: 42 }); // the group
    a.noteOwnerPrivateMessage({ chatType: 'private', chatId: 42, fromId: 42, forwarded: true });
    a.noteOwnerPrivateMessage({ chatType: 'private', chatId: 42, fromId: 42, isBot: true });
    expect(deliver).not.toHaveBeenCalled();
    a.noteOwnerPrivateMessage({ chatType: 'private', chatId: 42, fromId: 42 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('nothing happens with no configured owner, or when this PIN was already delivered', () => {
    const none = adapter(undefined);
    none.a.noteOwnerPrivateMessage({ chatType: 'private', chatId: 42, fromId: 42 });
    expect(none.deliver).not.toHaveBeenCalled();
    const done = adapter(42, true);
    done.a.noteOwnerPrivateMessage({ chatType: 'private', chatId: 42, fromId: 42 });
    expect(done.deliver).not.toHaveBeenCalled();
  });
});

describe('the pinned Dashboard message', () => {
  const fmt = (mode: 'private' | 'digits' | 'ask') =>
    (TelegramAdapter.prototype as unknown as { formatDashboardMessage: (u: string, p: string | null, n: boolean, m: string, b: string | null) => string })
      .formatDashboardMessage.call(Object.create(TelegramAdapter.prototype), 'https://x.example', '482916', true, mode, 'echo_bot');
  it('carries the digits only in the "no private route at all" mode', () => {
    expect(fmt('private')).not.toContain('482916');
    expect(fmt('private')).toContain('sent to you in your private chat');
    expect(fmt('ask')).not.toContain('482916');
    expect(fmt('ask')).toContain('t.me/echo\\_bot'); // escaped for legacy Markdown
    expect(fmt('digits')).toContain('482916');
    expect(fmt('digits')).toContain('open a private chat with me (t.me/echo\\_bot)');
  });
});

describe('instruction rewrites', () => {
  it('replaces each stock sentence, leaves custom prose, and is idempotent', () => {
    const before = ['custom: my own note about the PIN stays', ...PIN_DISCLOSURE_REWRITES.map(([from]) => `- ${from}`)].join('\n');
    const once = rewritePinDisclosure(before);
    expect(once.changed).toBe(true);
    for (const [from] of PIN_DISCLOSURE_REWRITES) expect(once.text).not.toContain(from);
    expect(once.text).toContain('custom: my own note about the PIN stays');
    expect(once.text).toContain('POST /dashboard/pin/send-private');
    expect(rewritePinDisclosure(once.text).changed).toBe(false);
  });

  it('the templates and the migrator carry none of the old sentences', () => {
    for (const f of ['src/scaffold/templates.ts', 'src/core/PostUpdateMigrator.ts']) {
      const text = fs.readFileSync(path.join(process.cwd(), f), 'utf-8').replace(/\\`/g, '`');
      for (const [from] of PIN_DISCLOSURE_REWRITES) expect(text.includes(from), `${f}: ${from}`).toBe(false);
    }
  });
});

describe('owner-secret notifications', () => {
  it('is a protected category (always delivered, never quiet-recorded)', () => {
    expect(isNotificationCategory('owner-secret')).toBe(true);
    expect(PROTECTED_DELIVERY_CATEGORIES.has('owner-secret')).toBe(true);
  });
  it('is stamped in exactly one place', () => {
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /category:\s*'owner-secret'/.test(fs.readFileSync(p, 'utf-8'))) hits.push(path.relative(process.cwd(), p));
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(hits).toEqual(['src/messaging/TelegramAdapter.ts']);
  });
});
