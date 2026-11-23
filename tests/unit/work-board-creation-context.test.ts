import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkBoardRuntime, type WorkBoardRuntimeSeams } from '../../src/core/WorkBoardRuntime.js';
import { cardConversationKey, workCardRecordStoreSchema, type UnionEntry } from '../../src/core/WorkCardStore.js';
import type { WorkPrincipal } from '../../src/core/WorkBoardService.js';
import type { AppCreationContext } from '../../src/core/AppCreationContext.js';

const AGENT: WorkPrincipal = { kind: 'agent' };
const CARD = 'wc_1234567890abcdef';
const runtimes: WorkBoardRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.stop(); });

function machine(options: { machineId?: string; initial?: UnionEntry[]; existing?: boolean; start?: boolean; sourceConversationKey?: string; store?: AppConversationStore } = {}) {
  const machineId = options.machineId ?? 'm_origin';
  const journal: UnionEntry[] = [...(options.initial ?? [])];
  const creates: Array<{ cardId: string; key: string; title: string; context?: AppCreationContext }> = [];
  const existing = new Set<string>(options.existing ? [cardConversationKey(CARD)] : []);
  let tick = 0;
  let loads = 0;
  let enabled = true;
  const seams: WorkBoardRuntimeSeams = {
    machineId, enabled: () => enabled, rawSettings: () => ({}), saveSettings: () => true,
    emit: (key, build) => {
      const hlc = { physical: 1_790_000_000_000 + tick++, logical: 0, node: machineId };
      const raw = build(hlc, machineId);
      if (!raw || !workCardRecordStoreSchema.validate(raw, { countDroppedField: () => {} } as never)) return { outcome: 'dropped:invalid' };
      const data = { ...raw, recordKey: key, hlc, origin: machineId };
      journal.push({ data, origin: machineId });
      return { outcome: 'emitted', seq: journal.length, hlc };
    },
    awaitDurable: async () => {}, loadUnion: () => { loads++; return journal; }, journalBytes: () => 0,
    conversation: {
      create: (cardId, key, title, context) => { options.store?.append({ kind: 'created', eventId: `card:${cardId}`, conversationKey: key, title, at: '2026-11-22T00:00:00.000Z', machineId, ...(context ? { creationContext: context } : {}) }); creates.push({ cardId, key, title, context }); existing.add(key); },
      exists: (key) => existing.has(key), appendSystemLine: () => {}, remove: () => {},
      serves: () => true, aliasFor: () => 7, hasLiveSession: () => false,
      dispatchSystem: async () => ({ outcome: 'refused' }), injectLive: () => false,
      attachment: () => null, lastPersonMessageAt: () => null,
    },
    relayReady: () => false, capacityProbe: () => ({ ok: false, reason: 'fixture' }),
    ownerPersonKey: () => 'owner', displayName: () => 'Owner', timezone: () => 'UTC',
    detectCredential: () => null, ledgerNote: () => {}, degradation: () => {}, leaseHolder: () => machineId,
    now: () => 1_790_000_000_000 + tick,
  };
  const runtime = new WorkBoardRuntime(seams); runtimes.push(runtime);
  if (options.start !== false) runtime.start();
  const create = () => {
    const result = runtime.svc.createCard(AGENT, {
      title: 'A generated chat', need: 'Keep it with its origin', outward: false,
      doneWhen: [{ id: 'd1', text: 'Context recorded', certify: 'agent-may-certify' }],
      source: { conversationKey: options.sourceConversationKey ?? 'telegram:42', messageId: '100' }, projectKey: 'telegram:42',
    }, { cardId: CARD });
    expect(result.ok).toBe(true);
    return result;
  };
  return { runtime, journal, creates, existing, create, loads: () => loads, setEnabled: (next: boolean) => { enabled = next; } };
}

describe('Work Board immutable creation context', () => {
  it('creates a real backing chat when legacy card source contains invalid optional reference characters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-context-store-'));
    const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm_origin' });
    try {
      const m = machine({ sourceConversationKey: 'telegram:42\n', store }); m.create(); m.runtime.ensureConversation(CARD);
      expect(store.getConversation(cardConversationKey(CARD))).not.toBeNull();
      expect(store.getCreationRecord(cardConversationKey(CARD))?.creationContext?.source).toEqual({ kind: 'work-board-card', cardId: CARD, originMachineId: 'm_origin', projectKey: 'telegram:42' });
    } finally { store.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-wb-invalid-source-context' }); }
  });

  it('passes the recorded card source and original project as the fourth create argument', () => {
    const m = machine(); m.create();
    const edited = m.runtime.svc.edit(AGENT, CARD, { projectKey: 'telegram:99', title: 'A later title' });
    expect(edited.ok).toBe(true);
    m.runtime.ensureConversation(CARD);
    expect(m.creates).toHaveLength(1);
    expect(m.creates[0]).toMatchObject({ cardId: CARD, key: cardConversationKey(CARD), title: 'A later title', context: {
      v: 1, source: { kind: 'work-board-card', cardId: CARD, originMachineId: 'm_origin', sourceConversationKey: 'telegram:42', projectKey: 'telegram:42' },
    } });
    expect(m.creates[0]!.context).not.toHaveProperty('parentConversationKey');
  });

  it('leaves existing App chats untouched but supplies exact read-only legacy card binding', () => {
    const m = machine({ existing: true }); m.create();
    const beforeRecords = m.journal.length;
    const beforeLoads = m.loads();
    m.runtime.ensureConversation(CARD);
    const evidence = m.runtime.creationEvidenceForConversation(`app:${cardConversationKey(CARD)}`);
    expect(evidence).toMatchObject({ conversationKey: cardConversationKey(CARD), cardId: CARD, conflict: false });
    expect(m.runtime.creationEvidenceForConversation('not-the-card')).toBeNull();
    for (let i = 0; i < 3; i++) expect(m.runtime.creationEvidenceSnapshot().items).toEqual([evidence]);
    expect(m.creates).toHaveLength(0);
    expect(m.journal).toHaveLength(beforeRecords);
    expect(m.loads()).toBe(beforeLoads);
  });

  it('rebuilds immutable origin evidence on another machine and after restart without editing old chats', () => {
    const origin = machine(); origin.create();
    const copy = machine({ machineId: 'm_replica', initial: origin.journal, existing: true });
    const evidence = copy.runtime.creationEvidenceForConversation(cardConversationKey(CARD));
    expect(evidence!.creationContext.source.originMachineId).toBe('m_origin');
    expect(copy.creates).toHaveLength(0);
    copy.runtime.stop(); copy.runtime.start();
    expect(copy.runtime.creationEvidenceSnapshot()).toMatchObject({ complete: true, items: [evidence] });
    expect(copy.creates).toHaveLength(0);
  });

  it('keeps a cheap generation stable for edits and read-only accesses', () => {
    const m = machine(); m.create();
    const generation = m.runtime.creationEvidenceGeneration();
    const items = m.runtime.creationEvidenceSnapshot().items;
    expect(m.runtime.svc.edit(AGENT, CARD, { projectKey: 'telegram:99' }).ok).toBe(true);
    m.runtime.ensureConversation(CARD);
    expect(m.runtime.creationEvidenceGeneration()).toBe(generation);
    expect(m.runtime.creationEvidenceSnapshot().items).toBe(items);
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(items[0]!.creationContext.source)).toBe(true);
  });

  it('reports unavailable snapshots before start, after stop and while the board is disabled', () => {
    const m = machine({ start: false });
    expect(m.runtime.creationEvidenceSnapshot().complete).toBe(false);
    m.runtime.start(); m.create();
    expect(m.runtime.creationEvidenceSnapshot().complete).toBe(true);
    m.setEnabled(false);
    expect(m.runtime.creationEvidenceSnapshot().complete).toBe(false);
    m.setEnabled(true); m.runtime.stop();
    expect(m.runtime.creationEvidenceSnapshot().complete).toBe(false);
  });

  it('refreshes received evidence while disabled without creating any conversation', () => {
    const origin = machine(); origin.create();
    const replica = machine({ machineId: 'm_replica' }); replica.setEnabled(false);
    replica.runtime.onCommitted(origin.journal.map((entry) => ({ data: entry.data })), 'm_origin');
    expect(replica.runtime.creationEvidenceForConversation(cardConversationKey(CARD))!.creationContext.source.projectKey).toBe('telegram:42');
    expect(replica.creates).toHaveLength(0);
    expect(replica.runtime.creationEvidenceSnapshot().complete).toBe(false);
  });

  it('removes a redacted card from read-only metadata without deleting its existing chat', () => {
    const m = machine({ existing: true }); m.create();
    const generation = m.runtime.creationEvidenceGeneration();
    expect(m.runtime.svc.tap({ kind: 'person', personKey: 'owner', proof: 'pin', isOwner: true }, CARD, { action: 'redact' }).ok).toBe(true);
    expect(m.runtime.creationEvidenceForConversation(cardConversationKey(CARD))).toBeNull();
    expect(m.runtime.creationEvidenceSnapshot().items).toEqual([]);
    expect(m.runtime.creationEvidenceGeneration()).toBeGreaterThan(generation);
    expect(m.existing.has(cardConversationKey(CARD))).toBe(true);
    expect(m.creates).toHaveLength(0);
  });

  it('clears cached evidence if a subsequent complete rebuild has no cards', () => {
    const m = machine({ existing: true }); m.create();
    m.runtime.stop(); m.journal.splice(0); m.runtime.start();
    expect(m.runtime.creationEvidenceSnapshot()).toMatchObject({ complete: true, items: [] });
    expect(m.runtime.creationEvidenceForConversation(cardConversationKey(CARD))).toBeNull();
    expect(m.creates).toHaveLength(0);
  });

  it('exposes observable competing source claims as uncertain instead of choosing a new parent', () => {
    const m = machine({ existing: true }); m.create();
    const original = m.journal[0]!;
    const changed = { ...original.data, hlc: { physical: 1_790_000_000_999, logical: 0, node: 'm_other' }, origin: 'm_other', source: { conversationKey: 'telegram:99', messageId: '200' } };
    m.runtime.onCommitted([{ data: changed }], 'm_other');
    const evidence = m.runtime.creationEvidenceForConversation(cardConversationKey(CARD));
    expect(evidence!.conflict).toBe(true);
    expect(evidence!.creationContext).not.toHaveProperty('parentConversationKey');
    expect(m.creates).toHaveLength(0);
  });
});
