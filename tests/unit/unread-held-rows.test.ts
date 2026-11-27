/**
 * Team access 2b × unread counts: a message held from a team member is not counted for her, so the
 * badge never announces a row she cannot open. A grant that shows it brings it into the count.
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
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/unread-held-rows.test.ts' }); });

const KEY = 'conv-shared';
const at = (ms: number) => new Date(ms).toISOString();
const msg = (id: string, ms: number): BrowsedMessage => ({ eventId: id, messageId: id, role: 'agent', text: id, at: at(ms) } as unknown as BrowsedMessage);

function setup(held: Set<string>, withCheck = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unread-held-'));
  dirs.push(dir);
  const store = new ConversationReadMarkerStore({ stateDir: dir, flushIntervalMs: 5 });
  const messages = [msg('m1', 1_000), msg('held', 2_000), msg('m3', 3_000)];
  const mia = { kind: 'team', userId: 'mia', role: 'team', name: 'Mia' } as unknown as ResolvedPerson;
  const svc = new ConversationUnreadService({
    store, enabled: () => true, machineId: () => 'm1',
    app: {
      getConversation: () => ({ conversationKey: KEY, tombstoned: false }) as never,
      browseMessages: () => ({ messages, nextBefore: null }),
      listConversations: () => ({ conversations: [], nextCursor: null }),
      eventAt: (_k: string, id: string) => messages.find((m) => m.eventId === id)?.at ?? null,
      newestIngestSeq: () => 3,
    } as never,
    ownerIdentity: () => ({}) as never,
    personOfReaderKey: () => mia,
    mayUse: () => true,
    ...(withCheck ? { mayReadMessage: (_p: ResolvedPerson, _k: string, m: BrowsedMessage) => !held.has(m.eventId) } : {}),
    authToken: () => '',
  });
  const reader = { key: 'person:mia', person: mia, viaDevice: true };
  store.setBaseline(reader.key, 0);
  return { svc, reader };
}

describe('unread counts respect rows held from a reader', () => {
  it('a held row is not counted, and showing it to her counts it', () => {
    const held = new Set(['held']);
    const { svc, reader } = setup(held);
    expect(svc.countFor(reader as never, `app:${KEY}`)!.count).toBe(2);
    held.delete('held'); // "Show to Mia": a grant that has seen the row
    expect(svc.countFor(reader as never, `app:${KEY}`)!.count).toBe(3);
  });

  it('without the check (no team access) every row counts, as before', () => {
    const { svc, reader } = setup(new Set(['held']), false);
    expect(svc.countFor(reader as never, `app:${KEY}`)!.count).toBe(3);
  });
});
