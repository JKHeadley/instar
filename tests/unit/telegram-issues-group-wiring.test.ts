/**
 * Wiring integrity for the issues group (docs/specs/telegram-issues-group.md): every
 * Telegram edge translates. The lifeline is a heavy process class, so this reads its
 * source like the other lifeline wiring tests.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThan(-1);
  // up to the next method at class indentation
  const rest = src.slice(start + signature.length);
  const end = rest.search(/\n  (private |public |async |static )?[a-zA-Z#]+\(.*\)[^\n]*\{\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('issues group wiring', () => {
  const lifeline = read('src/lifeline/TelegramLifeline.ts');

  it('lifeline normalizes inbound messages before any topic read', () => {
    const b = body(lifeline, 'private async processUpdate(update: TelegramUpdate): Promise<void> {');
    const norm = b.indexOf('normalizeInboundThread(msg,');
    const firstRead = b.indexOf('msg.message_thread_id');
    expect(norm).toBeGreaterThan(-1);
    expect(firstRead === -1 || norm < firstRead).toBe(true);
  });

  it('lifeline translates outbound params before the network call', () => {
    const b = body(lifeline, 'private async apiCall(method: string, params: Record<string, unknown>, retryCount = 0): Promise<unknown> {');
    const tr = b.indexOf('toWireParams(params,');
    const net = b.indexOf('telegramFetch(');
    expect(tr).toBeGreaterThan(-1);
    expect(tr).toBeLessThan(net);
  });

  it('adapter translates in apiCall and normalizes inbound + callbacks', () => {
    const adapter = read('src/messaging/TelegramAdapter.ts');
    const api = body(adapter, 'private async apiCall(method: string, params: Record<string, unknown>, retryCount: number = 0): Promise<unknown> {');
    expect(api.indexOf('toWireParams(params, this.topicSpace())')).toBeGreaterThan(-1);
    expect(api.indexOf('toWireParams(')).toBeLessThan(api.indexOf('telegramFetch('));
    expect(adapter).toMatch(/normalizeInboundThread\(msg, this\.topicSpace\(\)\)/);
    expect(adapter).toMatch(/normalizeInboundThread\(query\.message/);
  });

  it('origin boot passes the translator and admits the issues chat', () => {
    const boot = read('src/messaging/telegram-origin/TelegramOriginBoot.ts');
    expect(boot).toMatch(/wireParams: params => toWireParams\(params, \{ mainChatId: snapshot\?\.chatId, issuesChatId: snapshot\?\.issuesChatId \}\)/);
    expect(boot).toMatch(/request\.destination\.chatId === snapshot!\.issuesChatId/);
    const runtime = read('src/messaging/telegram-origin/TelegramOriginRuntime.ts');
    expect(runtime).toMatch(/wireParams: options\.wireParams/);
  });
});
