// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration test (THREADLINE-CONVERSATION-COHERENCE-SPEC §3.1/§6): the 4th
 * journal kind rides the EXISTING journal-sync transport end-to-end — store
 * lifecycle → journal → signed replication → the receiving machine's mesh
 * view names the holder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { JournalSyncApplier, type ApplyBatchStream } from '../../src/core/JournalSyncApplier.js';
import { ConversationStore, type Conversation } from '../../src/threadline/ConversationStore.js';
import { buildMeshConversationView } from '../../src/threadline/ConversationMeshView.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE_A = 'm_holder';

describe('threadline-conversation kind replication (§3.1 — the transport is kind-generic)', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'tlrep-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'tlrep-b-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/integration/threadline-conversation-replication.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/integration/threadline-conversation-replication.test.ts' });
  });

  it('store lifecycle on A → journaled → served → applied on B → B mesh view names A as holder with the binding', () => {
    // A: real store wired to a real journal (the server seam shape).
    const journalA = new CoherenceJournal({ stateDir: dirA, machineId: MACHINE_A, flushIntervalMs: 1_000_000 });
    journalA.open();
    const storeA = new ConversationStore(dirA);
    storeA.setCoherenceJournalSeam((d) => journalA.emitThreadlineConversation(d));

    storeA.mutateSync('dawn-thread', () => ({
      threadId: 'dawn-thread',
      state: 'active',
      participants: { peers: ['fp-dawn'] },
      boundTopicId: 13481,
      version: 0,
    } as Conversation));
    journalA.flush();

    // A serves its own stream; B applies under A's authenticated identity
    // (the journal-sync wire — kind-generic by construction).
    const applierA = new JournalSyncApplier({ stateDir: dirA });
    const served = applierA.buildServeBatch('threadline-conversation', 0, MACHINE_A);
    expect(served.entries.length).toBeGreaterThanOrEqual(2); // started + bound
    const applierB = new JournalSyncApplier({ stateDir: dirB });
    const applied = applierB.apply(MACHINE_A, [served] as ApplyBatchStream[]);
    expect(applied.applied).toBe(served.entries.length);
    expect(applied.forgedEntries).toBe(0);

    // B's mesh view: A named as holder, binding intact, content-free.
    const view = buildMeshConversationView({
      ownMachineId: 'm_reader',
      ownConversations: [],
      reader: new CoherenceJournalReader({ stateDir: dirB }),
    });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({
      kind: 'replica',
      conversationId: 'dawn-thread',
      peerFingerprint: 'fp-dawn',
      holderMachineId: MACHINE_A,
      boundTopicId: 13481,
      status: 'open',
    });

    // Close on A → B converges to closed on the next delta.
    storeA.mutateSync('dawn-thread', (c) => ({ ...c, state: 'resolved' as const }));
    journalA.flush();
    const delta = applierA.buildServeBatch('threadline-conversation', served.entries[served.entries.length - 1].seq, MACHINE_A);
    applierB.apply(MACHINE_A, [delta] as ApplyBatchStream[]);
    const view2 = buildMeshConversationView({
      ownMachineId: 'm_reader',
      ownConversations: [],
      reader: new CoherenceJournalReader({ stateDir: dirB }),
    });
    expect(view2.rows[0].status).toBe('closed');
    journalA.close();
  });
});
