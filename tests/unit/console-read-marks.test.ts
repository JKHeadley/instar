/**
 * Read marks from the dashboard (dashboard-read-markers): the position rule shared with the phone
 * (docs/specs/mobile-unread-messages.md §3.1) and the one mark the page sends for the newest message.
 */
import { describe, it, expect } from 'vitest';
import { positionOf, readRefOf, readMarkFor, bubble } from '../../dashboard/console/chats-model.js';

const AT = '2026-11-08T16:00:00.000Z';
const MS = Date.parse(AT);
const UUID = '3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B';

describe('positionOf — the same id rule as the phone', () => {
  it('app and Slack use eventId', () => {
    expect(positionOf('app', { eventId: 'e1', at: AT })).toEqual({ atMs: MS, id: 'e1' });
    expect(positionOf('slack', { eventId: 'slack:171.2', at: AT })).toEqual({ atMs: MS, id: 'slack:171.2' });
    expect(positionOf('app', { messageId: 'm1', at: AT })).toBeNull();
  });
  it('Telegram uses eventId when present, else in:/out: plus the message number', () => {
    expect(positionOf('telegram', { eventId: 'e9', messageId: 5, fromUser: true, timestamp: AT })).toEqual({ atMs: MS, id: 'e9' });
    expect(positionOf('telegram', { messageId: 5, fromUser: true, timestamp: AT })).toEqual({ atMs: MS, id: 'in:5' });
    expect(positionOf('telegram', { messageId: 6, fromUser: false, timestamp: AT })).toEqual({ atMs: MS, id: 'out:6' });
  });
  it('no time, no position', () => {
    expect(positionOf('app', { eventId: 'e1' })).toBeNull();
  });
  it('bubbles carry their position', () => {
    expect(bubble('app', { eventId: 'e1', role: 'agent', text: 'hi', at: AT })!.pos).toEqual({ atMs: MS, id: 'e1' });
  });
});

describe('readRefOf', () => {
  it('canonical refs; Slack needs the machine that holds it', () => {
    expect(readRefOf({ kind: 'app', id: UUID }, null)).toBe(`app:${UUID.toLowerCase()}`);
    expect(readRefOf({ kind: 'telegram', id: '42' }, null)).toBe('telegram:42');
    expect(readRefOf({ kind: 'slack', id: '-7' }, 'm1')).toBe('slack:m1:-7');
    expect(readRefOf({ kind: 'slack', id: '-7' }, null)).toBeNull();
  });
});

describe('readMarkFor — one mark, the newest message shown, only when it advances', () => {
  const list = [
    { id: 'e1', pos: { atMs: MS, id: 'e1' } },
    { id: 'e2', pos: { atMs: MS + 5, id: 'e2' } },
    { id: 'local:r1', pos: { atMs: MS + 99, id: 'local' } },
  ];
  it('picks the newest real message and names the machine', () => {
    expect(readMarkFor({ kind: 'app', id: UUID }, list, 'm1', null)).toEqual({ ref: `app:${UUID.toLowerCase()}`, id: 'e2', atMs: MS + 5, machine: 'm1' });
  });
  it('nothing newer than the last report → no mark', () => {
    expect(readMarkFor({ kind: 'app', id: UUID }, list, 'm1', { atMs: MS + 5, id: 'e2' })).toBeNull();
    expect(readMarkFor({ kind: 'app', id: UUID }, list, 'm1', { atMs: MS, id: 'e1' })).not.toBeNull();
  });
  it('an empty conversation sends nothing', () => {
    expect(readMarkFor({ kind: 'app', id: UUID }, [], 'm1', null)).toBeNull();
  });
});
