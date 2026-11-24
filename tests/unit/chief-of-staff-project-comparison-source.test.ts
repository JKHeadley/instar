import { describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from '../../src/core/AppConversationStore.js';
import { createChiefOfStaffProjectComparisonSource } from '../../src/core/ChiefOfStaffProjectComparisonSource.js';

const PRIMARY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const createdAt = '2030-06-01T12:00:00.000Z';
const binding = (key: string, hasInitiativePointer = false) => ({
  conversationKey: `app:${key}`, hasInitiativePointer,
});

function summary(key: string, title: string, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationKey: key, canonicalKey: `app:${key}`, title, createdAt,
    lastActivity: null, lastPreview: 'private message contents', tombstoned: false, ownerPerson: null,
    ...overrides,
  };
}

function fixture(keys = [binding(PRIMARY)], maxBindings?: number) {
  const rows = new Map<string, ConversationSummary>([
    [PRIMARY, summary(PRIMARY, 'Current owner title')],
    [OTHER, summary(OTHER, 'Other title')],
  ]);
  const denied = new Set<string>();
  const liveConversation = vi.fn((key: string) => rows.get(key) ?? null);
  const mayReadNativeOwnerApp = vi.fn((key: string) => !denied.has(key));
  const home = { current: true, enrolled: true, journalCurrent: true };
  const release = vi.fn(() => home.journalCurrent);
  const read = vi.fn(async (_signal: AbortSignal) => ({ keys, release }));
  const source = createChiefOfStaffProjectComparisonSource({
    journal: { read },
    ownerBoundary: () => home.enrolled ? {
      app: { liveConversation }, mayReadNativeOwnerApp, isCurrent: () => home.current,
    } : null,
    maxBindings,
  });
  return { rows, denied, liveConversation, mayReadNativeOwnerApp, home, read, release, source };
}

describe('approved native App project visibility projection', () => {
  it('uses live owner App titles and represents only a proven absent pointer', async () => {
    const f = fixture([binding(PRIMARY), binding(OTHER, true)]);
    const result = await f.source.read(new AbortController().signal);
    expect(f.liveConversation.mock.calls).toEqual([[PRIMARY], [OTHER]]);
    expect(result?.snapshot).toEqual({
      coverage: 'complete', relationsComplete: false,
      items: [
        { id: `app:${PRIMARY}`, title: 'Current owner title', relation: { state: 'none' } },
        { id: `app:${OTHER}`, title: 'Other title' },
      ],
    });
    expect(result?.release()).toBe(true);
    expect(JSON.stringify(result?.snapshot)).not.toContain('private message contents');
  });

  it('never reads a denied title and omits deleted or non-owner conversations', async () => {
    const f = fixture([binding(PRIMARY, true), binding(OTHER)]);
    f.denied.add(PRIMARY);
    f.rows.set(OTHER, summary(OTHER, 'Erased title', { tombstoned: true }));
    expect((await f.source.read(new AbortController().signal))?.snapshot).toEqual({
      coverage: 'complete', relationsComplete: true, items: [],
    });
    expect(f.liveConversation.mock.calls).toEqual([[OTHER]]);
    f.rows.set(OTHER, summary(OTHER, 'Someone else title', { ownerPerson: { machineId: 'other', userId: 'member' } }));
    expect((await f.source.read(new AbortController().signal))?.snapshot.items).toEqual([]);
  });

  it('keeps relationship coverage unchecked if an eligible live row lacks a readable native title', async () => {
    const f = fixture([binding(PRIMARY), binding(OTHER)]);
    f.rows.set(OTHER, summary(OTHER, '', { title: null }));
    const result = await f.source.read(new AbortController().signal);
    expect(result?.snapshot).toEqual({
      coverage: 'partial', relationsComplete: false,
      items: [{ id: `app:${PRIMARY}`, title: 'Current owner title', relation: { state: 'none' } }],
    });
    expect(result?.release()).toBe(true);
    f.rows.set(OTHER, summary(OTHER, 'Now known'));
    expect(result?.release()).toBe(false);
  });

  it('withholds an earlier result on title change, deletion, ACL loss and loss of fixture or journal proof', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const before = await f.source.read(signal);
    expect(before?.release()).toBe(true);
    f.rows.set(PRIMARY, summary(PRIMARY, 'Renamed'));
    expect(before?.release()).toBe(false);
    const renamed = await f.source.read(signal);
    expect(renamed?.snapshot.items[0].title).toBe('Renamed');
    f.rows.delete(PRIMARY);
    expect(renamed?.release()).toBe(false);
    f.rows.set(PRIMARY, summary(PRIMARY, 'Renamed'));
    f.denied.add(PRIMARY);
    expect(renamed?.release()).toBe(false);
    f.denied.clear();
    f.home.journalCurrent = false;
    expect(renamed?.release()).toBe(false);
    f.home.journalCurrent = true;
    f.home.current = false;
    expect(renamed?.release()).toBe(false);
  });

  it('requires the preread owner boundary and rejects unsupported or excessive binding work', async () => {
    const noBoundary = fixture();
    noBoundary.home.enrolled = false;
    expect(await noBoundary.source.read(new AbortController().signal)).toBeNull();
    expect(noBoundary.read).not.toHaveBeenCalled();
    const unsupported = fixture([{ conversationKey: 'telegram:12345', hasInitiativePointer: false }]);
    expect(await unsupported.source.read(new AbortController().signal)).toBeNull();
    expect(unsupported.liveConversation).not.toHaveBeenCalled();
    const excessive = fixture([binding(PRIMARY), binding(OTHER)], 1);
    expect(await excessive.source.read(new AbortController().signal)).toBeNull();
    expect(excessive.liveConversation).not.toHaveBeenCalled();
  });

  it('retains worker lifetime after abort and opens no source title if authorization changed during the read', async () => {
    const f = fixture();
    const controller = new AbortController();
    let finish!: (read: Awaited<ReturnType<typeof f.read>>) => void;
    f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.source.read(controller.signal);
    controller.abort();
    let exited = false;
    void pending.then(() => { exited = true; });
    await Promise.resolve();
    expect(exited).toBe(false);
    finish({ keys: [binding(PRIMARY)], release: () => true });
    expect(await pending).toBeNull();
    expect(f.liveConversation).not.toHaveBeenCalled();

    f.read.mockImplementationOnce(async () => {
      f.home.current = false;
      return { keys: [binding(PRIMARY)], release: () => true };
    });
    expect(await f.source.read(new AbortController().signal)).toBeNull();
    expect(f.liveConversation).not.toHaveBeenCalled();
  });
});
