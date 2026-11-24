/**
 * TelegramAdapter.findLoggedMessages — exact-id lookup of logged messages
 * (docs/specs/waiting-on-you-links.md §3): one pass for all ids, bounded only by the log's own
 * retention, cancellable, and honest about a miss.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('findLoggedMessages', () => {
  let dir: string; let adapter: TelegramAdapter; let logPath: string;
  afterEach(async () => { await adapter?.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'find-logged-messages test cleanup' }); });

  function setup(lines: Array<Record<string, unknown>>): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-find-logged-'));
    adapter = new TelegramAdapter({ token: 't', chatId: '-100123', pollIntervalMs: 100 }, dir);
    logPath = (adapter as unknown as { messageLogPath: string }).messageLogPath;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const ts = '2026-11-18T22:46:00.000Z';

  it('finds several ids in one pass and reports who sent each, with the full text', async () => {
    setup([
      { messageId: 145001, topicId: 141385, text: 'Which screen lock should the Mini use: 5 or 15 minutes?', timestamp: ts, fromUser: false, sessionName: 's' },
      { messageId: 145002, topicId: 141385, text: 'ok thinking', timestamp: ts, fromUser: true, sessionName: null },
      { messageId: 77, topicId: 9, text: 'other topic', timestamp: ts, fromUser: false, sessionName: 's' },
    ]);
    const r = await adapter.findLoggedMessages([{ topicId: 141385, messageId: 145001 }, { topicId: 141385, messageId: 145002 }, { topicId: null, messageId: 77 }]);
    expect(r.map((m) => m.found)).toEqual([true, true, true]);
    expect(r[0].text).toBe('Which screen lock should the Mini use: 5 or 15 minutes?');
    expect(r[0].sentBy).not.toBe('person');
    expect(r[1].sentBy).toBe('person');
    expect(r[2].text).toBe('other topic'); // a General-form link carries no topic id
  });

  it('a link with no topic only matches a message in the group it named, and a team phone is not "the person"', async () => {
    setup([
      { messageId: 9, topicId: 10_000_000_001, text: 'issues general', timestamp: ts, fromUser: false, sessionName: 's' },
      { messageId: 9, topicId: 1, text: 'main general', timestamp: ts, fromUser: true, teamPhone: true, sessionName: null },
    ]);
    const main = await adapter.findLoggedMessages([{ topicId: null, messageId: 9 }]);
    expect(main[0].text).toBe('main general');
    expect(main[0].sentBy).toBe('team-member');
    const issues = await adapter.findLoggedMessages([{ topicId: null, messageId: 9, issues: true }]);
    expect(issues[0].text).toBe('issues general');
  });

  it('an absent id, or the right id in the wrong topic, is not found (never guessed)', async () => {
    setup([{ messageId: 145001, topicId: 141385, text: 'ask', timestamp: ts, fromUser: false, sessionName: 's' }]);
    const r = await adapter.findLoggedMessages([{ topicId: 141385, messageId: 999 }, { topicId: 5, messageId: 145001 }]);
    expect(r).toEqual([{ topicId: 141385, messageId: 999, found: false }, { topicId: 5, messageId: 145001, found: false }]);
  });

  it('an id that only appears as part of another id or inside message text is not matched', async () => {
    setup([
      { messageId: 1450019, topicId: 5, text: 'longer id', timestamp: ts, fromUser: false, sessionName: 's' },
      { messageId: 3, topicId: 5, text: 'this text mentions "messageId":145001 literally', timestamp: ts, fromUser: false, sessionName: 's' },
    ]);
    const r = await adapter.findLoggedMessages([{ topicId: 5, messageId: 145001 }]);
    expect(r[0].found).toBe(false);
  });

  it('a missing log reads as not found, and invalid ids are ignored', async () => {
    setup([]);
    SafeFsExecutor.safeRmSync(logPath, { force: true, operation: 'find-logged-messages test: remove log' });
    expect(await adapter.findLoggedMessages([{ topicId: 5, messageId: 1 }, { topicId: 5, messageId: -4 }])).toEqual([{ topicId: 5, messageId: 1, found: false }]);
  });

  it('a large log (about 90 MB, 95,000 lines) still answers for a recent id and for an absent id', async () => {
    setup([]);
    const filler = 'y'.repeat(900);
    const fd = fs.openSync(logPath, 'w');
    try {
      for (let block = 0; block < 95; block++) {
        let chunk = '';
        for (let i = 0; i < 1000; i++) {
          const id = block * 1000 + i + 1;
          chunk += JSON.stringify({ messageId: id, topicId: 5, text: `${id} ${filler}`, timestamp: ts, fromUser: false, sessionName: 's' }) + '\n';
        }
        fs.writeSync(fd, chunk);
      }
    } finally { fs.closeSync(fd); }
    expect(fs.statSync(logPath).size).toBeGreaterThan(85 * 1024 * 1024);
    const t0 = Date.now();
    const recent = await adapter.findLoggedMessages([{ topicId: 5, messageId: 94_990 }]);
    const recentMs = Date.now() - t0;
    expect(recent[0].found).toBe(true);
    expect(recent[0].text?.startsWith('94990 ')).toBe(true);
    const absent = await adapter.findLoggedMessages([{ topicId: 5, messageId: 5_000_000 }]);
    expect(absent[0].found).toBe(false);
    // a recent message is found in the first block or two, not after a full pass
    expect(recentMs).toBeLessThan(2000);
  }, 120_000);

  it('stops reading when the caller aborts (a timed-out lookup never keeps reading)', async () => {
    setup([]);
    const filler = 'z'.repeat(2000);
    fs.writeFileSync(logPath, Array.from({ length: 3000 }, (_, i) => JSON.stringify({ messageId: i + 1, topicId: 5, text: filler, timestamp: ts, fromUser: false, sessionName: 's' })).join('\n') + '\n');
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.findLoggedMessages([{ topicId: 5, messageId: 9_999_999 }], { signal: controller.signal })).rejects.toThrow('find-logged-messages-aborted');
  });
});
