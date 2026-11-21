/**
 * conversation-list-offthread-scan, the Chief of Staff's unread rule (in doubt a message counts as
 * unread): a phone with no read position yet, whose baseline cannot be set because the first marker
 * catch-up has not settled, sees replies after its admission as unread; and the baseline set once
 * catch-up settles is that admission cutoff, never a later time that would mark a reply in between
 * as read.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationReadMarkerStore } from '../../src/core/ConversationReadMarkers.js';
import { ConversationUnreadService } from '../../src/core/ConversationUnreadService.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { BrowsedMessage } from '../../src/core/AppConversationStore.js';
import type { ResolvedPerson } from '../../src/core/MobilePeople.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/unread-admission-cutoff.test.ts' }); });

const KEY = '11111111-1111-4111-8111-111111111111';
const iso = (ms: number) => new Date(ms).toISOString();
const msg = (id: string, ms: number): BrowsedMessage => ({ eventId: id, messageId: id, role: 'agent', text: id, at: iso(ms) } as unknown as BrowsedMessage);

function setup(onBrowse?: () => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unread-cutoff-'));
  dirs.push(dir);
  const store = new ConversationReadMarkerStore({ stateDir: dir, flushIntervalMs: 5 });
  const messages: BrowsedMessage[] = [msg('m1', 1_000)];
  let clock = 2_000;
  const owner = { kind: 'owner', role: 'owner', name: 'Owner' } as unknown as ResolvedPerson;
  const svc = new ConversationUnreadService({
    store, enabled: () => true, machineId: () => 'm1', now: () => clock,
    app: {
      getConversation: () => ({ conversationKey: KEY, tombstoned: false }) as never,
      browseMessages: () => { onBrowse?.(); return { messages: [...messages], nextBefore: null }; },
      listConversations: () => ({ conversations: [], nextCursor: null }),
      eventAt: (_k: string, id: string) => messages.find((m) => m.eventId === id)?.at ?? null,
      newestIngestSeq: () => messages.length,
    } as never,
    ownerIdentity: () => ({}) as never,
    personOfReaderKey: () => owner,
    mayUse: () => true,
    authToken: () => '',
  });
  const reader = { key: 'owner', person: owner, viaDevice: true };
  const row = () => ({ platform: 'app' as const, id: KEY, lastActivity: messages[messages.length - 1].at });
  return { store, svc, reader, messages, row, setClock: (t: number) => { clock = t; } };
}

describe('a phone with no read position yet, while marker catch-up is pending', () => {
  it('sees a reply saved after its admission as unread, and the later baseline never marks it read', () => {
    const { store, svc, reader, messages, row, setClock } = setup();
    expect(store.catchUpSettled()).toBe(false);
    svc.touchBaseline(reader as never); // admission at 2,000: catch-up pending, no baseline possible
    expect(store.hasBaseline(reader.key)).toBe(false);
    messages.push(msg('reply', 3_000)); // a reply saved after admission
    const first = svc.rowFields(reader as never, row())!;
    expect(first.hasUnread).toBe(true);
    expect(first.unreadCount).toBe(1);
    // Catch-up settles; the next request (at 4,000) sets the baseline at the first admission, not now.
    store.markCatchUpSettled();
    setClock(4_000);
    svc.touchBaseline(reader as never);
    expect(store.hasBaseline(reader.key)).toBe(true);
    // The cutoff is only an extra unread-from-here line, never the saved read position.
    expect(store.baselineFor(reader.key)).toBe(4_000);
    const next = svc.rowFields(reader as never, row())!;
    expect(next.hasUnread).toBe(true);
    expect(next.unreadCount).toBe(1);
  });

  it('a conversation the activity pre-check would skip is not read for the extra count', () => {
    let reads = 0;
    const { svc, reader, row, setClock } = setup(() => { reads++; });
    setClock(10_000);
    svc.touchBaseline(reader as never); // cutoff at 10,000; the conversation's last activity is 1,000
    expect(svc.rowFields(reader as never, row())).toMatchObject({ hasUnread: false, unreadCount: 0 });
    expect(reads).toBe(0); // the old code would not read it either
  });

  it('the cutoff is dropped when syncing delivers the phone\'s baseline from another machine', () => {
    const { store, svc, reader } = setup();
    const count = () => (svc as unknown as { admissionCutoffCount(): number }).admissionCutoffCount();
    svc.touchBaseline(reader as never);
    expect(count()).toBe(1);
    store.setBaseline(reader.key, 5_000); // arrives by the marker catch-up from another machine
    store.markCatchUpSettled();
    svc.touchBaseline(reader as never);
    expect(count()).toBe(0);
  });

  it('the cutoff list is capped: one entry per phone at most, oldest out first', () => {
    const { svc } = setup();
    const count = () => (svc as unknown as { admissionCutoffCount(): number }).admissionCutoffCount();
    for (let i = 0; i < 1_050; i++) svc.touchBaseline({ key: `phone-${i}`, person: null, viaDevice: true } as never);
    expect(count()).toBe(1_000);
    svc.touchBaseline({ key: 'phone-1049', person: null, viaDevice: true } as never); // a repeat adds nothing
    expect(count()).toBe(1_000);
  });

  it('with catch-up already settled, the baseline is set at admission as before', () => {
    const { store, svc, reader, messages, row } = setup();
    store.markCatchUpSettled();
    svc.touchBaseline(reader as never);
    messages.push(msg('reply', 3_000));
    expect(svc.rowFields(reader as never, row())).toMatchObject({ hasUnread: true, unreadCount: 1 });
  });
});
