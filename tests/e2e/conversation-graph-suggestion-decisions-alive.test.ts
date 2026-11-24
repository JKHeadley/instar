// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e (docs/specs/conversation-graph-suggestions-replicated-decisions.md): the owner's suggestion decisions are
 * ALIVE on the production init path. The kind is registered the way server.ts does it, a real CoherenceJournal,
 * ReplicatedRecordEmitter (with the store's resolved flag) and ReplicatedPeerStreamReader carry it, the real boot
 * wiring builds the store, and:
 *  - a Reject through the service emits exactly one record into this machine's own stream;
 *  - that committed record, handed to a second machine's store the way the peer-commit observer does, hides the
 *    suggestion there;
 *  - a restart finds the row in the own stream and sends nothing again;
 *  - with the store's flag off (the kill switch path) nothing is emitted.
 * Plus WIRED source checks that server.ts registers the kind, forces the flag with the kill switch, lands peers'
 * commits, builds the store and hands it to AgentServer, and that AgentServer passes it to the service.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { ProjectionItem, ConversationRef } from '../../src/core/conversationGraph.js';
import { ConversationGraphSuggestionService } from '../../src/server/ConversationGraphSuggestionService.js';
import { SuggestionDecisionStore } from '../../src/core/ConversationGraphSuggestionDecisions.js';

const OP = 'tests/e2e/conversation-graph-suggestion-decisions-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIND = 'conversation-graph-suggestion-record';

const tg = (topicId: number): ConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-1001', topicId });
const item = (topicId: number): ProjectionItem => ({
  ref: tg(topicId), title: `Topic ${topicId}`, kind: 'conversation', role: 'unassigned', primaryPath: [], visibleChildCount: 0,
  digestVersion: null, sourceFreshness: `2026-11-11T10:${String(topicId % 60).padStart(2, '0')}:00.000Z`,
});
const inv = [item(11), item(12), item(13)];
const answer = JSON.stringify({ groups: [{ name: 'Rollout', members: ['c1', 'c2'] }] });

describe('suggestion decisions — alive on the production init path', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  async function boot(stateDir: string, storeOn = true) {
    const registry = new ReplicatedKindRegistry();
    // Exactly server.ts's registration statement.
    const { SUGGESTION_DECISIONS_KIND_REGISTRATION } = await import('../../src/core/ConversationGraphSuggestionDecisions.js');
    registry.register(SUGGESTION_DECISIONS_KIND_REGISTRATION);
    const journal = new CoherenceJournal({ stateDir, machineId: 'm_e2e', flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(registry);
    const reader = new ReplicatedPeerStreamReader({ stateDir, registry, selfMachineId: 'm_e2e' });
    let t = Date.parse('2026-11-17T12:00:00Z');
    const emitter = new ReplicatedRecordEmitter({
      journal, clock: new HybridLogicalClock({ node: 'm_e2e', now: () => (t += 1000) }), registry, origin: 'm_e2e',
      stores: () => (storeOn ? { conversationGraphSuggestions: { enabled: true } } : {}),
      loadWitness: (store, recordKey) => reader.loadWitness(store, recordKey),
    });
    const sd = await import('../../src/core/ConversationGraphSuggestionDecisions.js');
    const wired = sd.wireSuggestionDecisionStoreSafe({ enabled: true, stateDir, emitter, peerStreams: reader, ownMachineId: 'm_e2e', report: () => undefined, setTimer: () => ({}) })!;
    const service = new ConversationGraphSuggestionService({ stateDir, now: () => new Date('2026-11-17T20:00:00Z'), decisions: wired.store,
      intelligence: { evaluate: async () => answer }, evidence: () => ({ project: null, text: '' }) });
    return { journal, reader, wired, service };
  }

  it('a Reject emits one record into the own stream; a second machine landing it hides the suggestion; a restart sends nothing again', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-dec-alive-')); dirs.push(stateDir);
    const a = await boot(stateDir);
    a.service.view(inv); await a.service.settled();
    const id = a.service.view(inv).items[0].id;
    expect(a.service.reject(id)).toBe(true);
    a.journal.flush();
    const entries = a.journal.readTail(KIND as never, 10).entries;
    expect(entries).toHaveLength(1);
    expect((entries[0].data as { row: { suggestionId: string; decision: string } }).row).toMatchObject({ suggestionId: id, decision: 'rejected' });
    expect(a.wired.store.dueCount()).toBe(0);

    // The second machine: its store lands the committed entries exactly as the peer-commit observer line does.
    const bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-dec-alive-b-')); dirs.push(bDir);
    const bStore = new SuggestionDecisionStore({ stateDir: bDir });
    const bService = new ConversationGraphSuggestionService({ stateDir: bDir, now: () => new Date('2026-11-17T20:00:00Z'), decisions: bStore,
      intelligence: { evaluate: async () => answer }, evidence: () => ({ project: null, text: '' }) });
    bService.view(inv); await bService.settled();
    expect(bService.view(inv).items.map((i) => i.id)).toEqual([id]);
    bStore.ingestReplicatedAll(entries.map((e) => (e.data as { row?: unknown }).row));
    expect(bService.view(inv).items).toEqual([]);

    // Restart of the first machine: the boot check finds the row in the own stream.
    a.journal.close();
    const again = await boot(stateDir);
    try {
      again.service.view(inv);
      again.journal.flush();
      expect(again.journal.readTail(KIND as never, 10).entries).toHaveLength(1);
    } finally { again.journal.close(); }
  });

  it('with the store flag off nothing is emitted and the row stays unsent', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-dec-alive-off-')); dirs.push(stateDir);
    const a = await boot(stateDir, false);
    try {
      a.service.view(inv); await a.service.settled();
      a.service.reject(a.service.view(inv).items[0].id);
      a.journal.flush();
      expect(a.journal.readTail(KIND as never, 10).entries).toHaveLength(0);
      expect(a.wired.store.dueCount()).toBe(1);
    } finally { a.journal.close(); }
  });

  it('WIRED: server.ts registers the kind, resolves the flag with its kill switch, lands peers\' commits and hands the store to AgentServer', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain('replicatedKindRegistry.register(SUGGESTION_DECISIONS_KIND_REGISTRATION)');
    expect(src).toContain('const _suggestionDecisionsOn = !!coherenceJournal && _stateSyncStoresBase?.conversationGraphSuggestions?.enabled !== false;');
    expect(src).toContain('if (_suggestionDecisionsOn) s = { ...s, conversationGraphSuggestions: { enabled: true } };');
    expect(src).toContain("if (kind === 'conversation-graph-suggestion-record') _suggestionDecisions?.store.ingestReplicatedAll(");
    expect(src).toContain('_suggestionDecisions = sd.wireSuggestionDecisionStoreSafe({');
    expect(src).toContain('conversationGraphSuggestionDecisions: _suggestionDecisions?.store ?? undefined');
    const agent = fs.readFileSync(path.join(ROOT, 'src/server/AgentServer.ts'), 'utf-8');
    expect(agent).toContain('decisions:options.conversationGraphSuggestionDecisions??null');
    const surface = fs.readFileSync(path.join(ROOT, 'src/server/ConversationGraphSurface.ts'), 'utf-8');
    expect(surface).toContain('...(options.suggestions.decisions?{decisions:options.suggestions.decisions}:{})');
  });
});
