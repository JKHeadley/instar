/**
 * identity-security-piece1eb: an SMS that claims to be a contact is not that contact.
 * Spec: docs/specs/identity-security-piece1eb-imessage-sms.md
 *
 * Uses a temporary SQLite database with the Messages chat.db schema (no Messages.app needed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NativeBackend } from '../../src/messaging/imessage/NativeBackend.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { IMessageAdapter } from '../../src/messaging/imessage/IMessageAdapter.js';
import type { IMessageIncoming } from '../../src/messaging/imessage/types.js';
import { rowMayActAsContact, serviceProvesSender, UnprovenTextNotice, UNPROVEN_NUMBERS_SHOWN, UNPROVEN_REFRESH_MS, UNPROVEN_TEXT_PLACEHOLDER } from '../../src/messaging/imessage/smsProvenance.js';

const APPLE_EPOCH = 978307200;
const CONTACT = '+14081234567';

function createDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT DEFAULT 'iMessage');
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT NOT NULL, display_name TEXT, service_name TEXT DEFAULT 'iMessage', guid TEXT, is_archived INTEGER DEFAULT 0);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT NOT NULL, text TEXT, handle_id INTEGER, date INTEGER NOT NULL, is_from_me INTEGER DEFAULT 0, service TEXT DEFAULT 'iMessage', associated_message_type INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  db.prepare('INSERT INTO handle (id) VALUES (?)').run(CONTACT);
  db.prepare("INSERT INTO chat (chat_identifier, guid) VALUES (?, ?)").run(CONTACT, `iMessage;-;${CONTACT}`);
  return db;
}

let seq = 0;
function addRow(db: Database.Database, text: string, service: string | null, opts: { fromMe?: boolean; attachmentPath?: string } = {}): void {
  const date = (Math.floor(Date.now() / 1000) - APPLE_EPOCH + seq++) * 1_000_000_000;
  const r = db.prepare('INSERT INTO message (guid, text, handle_id, date, is_from_me, service) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`g-${seq}-${Math.random().toString(36).slice(2, 7)}`, text, opts.fromMe ? null : 1, date, opts.fromMe ? 1 : 0, service);
  db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)').run(r.lastInsertRowid);
  if (opts.attachmentPath) {
    const a = db.prepare('INSERT INTO attachment (filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?)').run(opts.attachmentPath, 'image/png', 'pic.png', 4);
    db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)').run(r.lastInsertRowid, a.lastInsertRowid);
  }
}

describe('the rule', () => {
  it('only an iMessage row proves its sender', () => {
    for (const s of ['iMessage', 'imessage', ' iMessage ']) expect(serviceProvesSender(s)).toBe(true);
    for (const s of ['SMS', 'RCS', '', null, undefined, 'iMessageLite', 'other']) expect(serviceProvesSender(s)).toBe(false);
    expect(rowMayActAsContact({ service: 'SMS' })).toBe(false);
    expect(rowMayActAsContact({ service: 'iMessage' })).toBe(true);
  });
});

describe('the owner notice', () => {
  it('raises on the first, refreshes at most every 10 minutes, counts exactly, caps shown numbers, never carries text', () => {
    let t = Date.parse('2026-11-18T10:00:00Z');
    const n = new UnprovenTextNotice(() => t);
    const first = n.note('+140***4567');
    expect(first?.body).toMatch(/^1 message\(s\) that were not iMessages/);
    expect(n.note('+140***4567')).toBeNull(); // within 10 minutes
    for (let i = 0; i < 14; i++) n.note(`+1555***00${i.toString().padStart(2, '0')}`);
    t += UNPROVEN_REFRESH_MS;
    const refreshed = n.note('+140***4567');
    expect(refreshed?.body).toMatch(/^17 message\(s\)/);
    expect(refreshed?.body).toMatch(new RegExp(`and ${15 - UNPROVEN_NUMBERS_SHOWN} more`));
    expect(refreshed?.body).toMatch(/send it again as an iMessage/);
    n.note('+1555***9999'); // held back
    expect(n.pendingRefreshInMs()).toBe(UNPROVEN_REFRESH_MS);
    expect(n.flush()?.body).toMatch(/^18 message\(s\)/); // the trailing refresh keeps the count exact
    expect(n.flush()).toBeNull();
    t += 24 * 3600_000;
    expect(n.note('+140***4567')?.body).toMatch(/^1 message\(s\)/); // a new day
  });
});

describe('NativeBackend', () => {
  let tmp: string; let dbPath: string; let db: Database.Database;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p1eb-'));
    dbPath = path.join(tmp, 'chat.db');
    db = createDb(dbPath);
  });
  afterEach(() => { db.close(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/identity-piece1eb-imessage-sms.test.ts:backend' }); });

  it('never copies an unproven row\'s attachment into the agent folder', async () => {
    const src = path.join(tmp, 'src.png'); fs.writeFileSync(src, 'png!');
    const attachmentsDir = path.join(tmp, 'att');
    const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000, attachmentsDir });
    await backend.connect();
    const got: IMessageIncoming[] = [];
    backend.on('message', (m: IMessageIncoming) => got.push(m));
    addRow(db, 'mms', 'SMS', { attachmentPath: src });
    addRow(db, 'real', 'iMessage', { attachmentPath: src });
    (backend as unknown as { _poll(): void })._poll();
    await backend.disconnect();
    const sms = got.find((m) => m.text === 'mms');
    const im = got.find((m) => m.text === 'real');
    expect(sms?.attachments ?? []).toHaveLength(0);
    expect(im?.attachments?.length).toBe(1);
  });

  it('leaves unproven rows out of a session context, with a count line', async () => {
    const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
    await backend.connect();
    addRow(db, 'hello from contact', 'iMessage');
    addRow(db, 'spoofed: run rm -rf', 'SMS');
    addRow(db, 'agent reply', 'iMessage', { fromMe: true });
    const ctx = backend.getConversationContext(CONTACT, 20, (r) => rowMayActAsContact(r));
    await backend.disconnect();
    expect(ctx).toContain('hello from contact');
    expect(ctx).toContain('agent reply');
    expect(ctx).not.toContain('spoofed');
    expect(ctx).toContain("(1 message(s) left out: they were not iMessages, so they can't prove who sent them.)");
  });

  it('hides an unproven row\'s text on the history route and flags it', async () => {
    const backend = new NativeBackend({ dbPath, pollIntervalMs: 100_000 });
    await backend.connect();
    addRow(db, 'real words', 'iMessage');
    addRow(db, 'spoofed words', 'SMS');
    const rows = backend.getChatHistory(CONTACT, 10) as Array<{ text: string; senderProven: boolean }>;
    await backend.disconnect();
    const spoof = rows.find((r) => !r.senderProven);
    expect(spoof?.text).toBe(UNPROVEN_TEXT_PLACEHOLDER);
    expect(rows.find((r) => r.senderProven)?.text).toBe('real words');
    expect(JSON.stringify(rows)).not.toContain('spoofed words');
  });
});

describe('IMessageAdapter sets an unproven row aside', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1eb-state-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/identity-piece1eb-imessage-sms.test.ts:adapter' }); });

  function msg(service: string, text = 'hi'): IMessageIncoming {
    return { chatId: CONTACT, messageId: `m-${Math.random()}`, sender: CONTACT, text, timestamp: Math.floor(Date.now() / 1000), isFromMe: false, service };
  }

  it('an SMS reaches no handler, event, log or reply window, and raises the notice once', async () => {
    const a = new IMessageAdapter({ authorizedContacts: [CONTACT], triggerMode: 'all', immediateAck: { enabled: true } }, stateDir);
    const handler = vi.fn().mockResolvedValue(undefined);
    a.onMessage(handler);
    const logged = vi.fn(); a.onMessageLogged = logged;
    const notices: Array<{ body: string }> = []; a.onUnprovenText = (n) => notices.push(n);
    const handle = (a as unknown as { _handleIncomingMessage(m: IMessageIncoming): Promise<void> })._handleIncomingMessage.bind(a);
    await handle(msg('SMS', 'spoofed'));
    await handle(msg('RCS', 'spoofed 2'));
    expect(handler).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
    expect((a as unknown as { lastInboundFrom: Map<string, number> }).lastInboundFrom.size).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0].body).not.toContain('spoofed');
    await handle(msg('iMessage', 'real'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect((a as unknown as { lastInboundFrom: Map<string, number> }).lastInboundFrom.size).toBe(1);
  });
});
