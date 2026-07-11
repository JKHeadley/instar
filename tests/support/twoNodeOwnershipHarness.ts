// safe-fs-allow: harness teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Two-node ownership harness — the Increment-2 entry-gate substrate
 * (ownership-gated-spawn-and-judgment-within-floors §4/§5: "the two-node
 * replication harness green in CI"; "a real two-node harness in which the
 * replication hop is NOT stubbed").
 *
 * Fuses three proven patterns:
 *  - journal-sync-roundtrip.test.ts — the un-stubbed signed replication hop
 *    (CoherenceJournal → JournalSyncApplier serve → signed MeshRpc envelope →
 *    peer JournalSyncApplier receive → CoherenceJournalReader replica);
 *  - mesh-failover-2server.test.ts — two real HTTP servers in one process;
 *  - ownership-gated-spawn-alive.test.ts — the REAL AgentServer (real auth
 *    middleware — the PR #1295 lesson) with injected ownership components.
 *
 * Each node runs the DURABLE substrate (LocalSessionOwnershipStore — the
 * §3.2.0 precondition, unlike the fleet-default in-memory store), a real
 * SessionOwnershipRegistry, a CoherenceJournal writer, both halves of the
 * journal-sync applier, an OwnershipApplier (peer-record materialization),
 * and a real AgentServer serving `/sessions` + `/pool/ownership-view` over
 * real Bearer auth.
 *
 * Everything is CALLER-PACED (no wall-clock waits): `replicate(from, to)`
 * pushes one signed serve-batch over real HTTP; `applierTick(node)`
 * materializes whatever has landed. Wall-clock cost stays well inside the
 * 60s e2e timeout.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MeshRpcDispatcher, type MeshCommand, type MeshEnvelope } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier, type ApplyBatchStream } from '../../src/core/JournalSyncApplier.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { OwnershipApplier } from '../../src/core/OwnershipApplier.js';
import { LocalSessionOwnershipStore } from '../../src/core/LocalSessionOwnershipStore.js';
import { SessionOwnershipRegistry } from '../../src/core/SessionOwnershipRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

export const HARNESS_AUTH = 'two-node-harness-bearer';

/** A live conversation-bound session on a node (drives GET /sessions). */
export interface HarnessLiveSession {
  tmuxSession: string;
  topicId: number;
}

export interface HarnessNode {
  machineId: string;
  url: string;
  stateDir: string;
  /** The DURABLE store (§3.2.0 substrate precondition). */
  store: LocalSessionOwnershipStore;
  registry: SessionOwnershipRegistry;
  journal: CoherenceJournal;
  reader: CoherenceJournalReader;
  syncApplier: JournalSyncApplier;
  ownershipApplier: OwnershipApplier;
  state: StateManager;
  /**
   * Register a LIVE conversation-bound session on this node — lands in the
   * REAL StateManager registry (what GET /sessions serves) plus the telegram
   * mock's session→topic map (what the route's platform enrichment reads).
   */
  addLiveSession: (topicId: number) => HarnessLiveSession;
  /** Close a session (status completed) — it drops out of the default listing. */
  endSession: (tmux: string) => void;
  server: AgentServer;
  /** Journal-hop latency samples (FD15 calibration input), ms per replicate. */
  hopLatenciesMs: number[];
  stop: () => Promise<void>;
}

export interface TwoNodeHarness {
  a: HarnessNode;
  b: HarnessNode;
  /**
   * ONE un-stubbed replication hop: build `from`'s own-stream serve batch and
   * deliver it to `to` as a signed, recipient-bound `journal-sync` envelope
   * over `to`'s REAL /mesh/rpc route. Returns the applier result.
   */
  replicate: (from: HarnessNode, to: HarnessNode) => Promise<{ applied: number; forgedEntries: number }>;
  /** Materialize whatever replicated placements have landed on `node`. */
  applierTick: (node: HarnessNode) => { examined: number; materialized: number };
  teardown: () => Promise<void>;
}

function baseConfig(stateDir: string, projectDir: string): InstarConfig {
  return {
    projectName: 'two-node-e2e', projectDir, stateDir, port: 0, authToken: HARNESS_AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
}

export async function makeTwoNodeHarness(): Promise<TwoNodeHarness> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'two-node-ownership-'));
  const keys: Record<string, { priv: string; pub: string }> = {};
  const seenNonces = new Set<string>();
  let nonceSeq = 0;

  async function makeNode(machineId: string): Promise<HarnessNode> {
    const stateDir = path.join(tmpRoot, machineId);
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'two-node-e2e', agentName: 'E2E' }));
    const kp = generateSigningKeyPair();
    keys[machineId] = { priv: kp.privateKey, pub: kp.publicKey };

    const store = new LocalSessionOwnershipStore({ dir: path.join(stateDir, 'state', 'ownership') });
    const casNonces = new Set<string>();
    const registry = new SessionOwnershipRegistry({
      store,
      seenNonce: (k) => casNonces.has(k),
      recordNonce: (k) => casNonces.add(k),
    });
    const journal = new CoherenceJournal({ stateDir, machineId, flushIntervalMs: 1_000_000 /* manual flush */ });
    journal.open();
    const syncApplier = new JournalSyncApplier({ stateDir });
    const reader = new CoherenceJournalReader({ stateDir });
    const ownershipApplier = new OwnershipApplier({
      reader,
      store,
      selfMachineId: machineId,
    });

    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: machineId,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, nn) => seenNonces.has(`${machineId}:${s}:${nn}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, nn) => seenNonces.add(`${machineId}:${s}:${nn}`),
      handlers: {
        'journal-sync': (cmd: MeshCommand, _sender: string, env: MeshEnvelope) => {
          const c = cmd as MeshCommand & { type: 'journal-sync'; batch?: ApplyBatchStream[] };
          if (c.batch) {
            // First-hop sender binding — bind to the AUTHENTICATED envelope sender.
            const r = syncApplier.apply(env.sender, c.batch);
            return { ok: true, result: r };
          }
          return { ok: true };
        },
      },
    });

    const state = new StateManager(stateDir);
    // The /sessions route's platform enrichment reads the telegram adapter's
    // session→topic map (optional-chained) — a two-method mock suffices.
    const sessionTopic = new Map<string, number>();
    const telegramMock = {
      getTopicForSession: (tmux: string) => sessionTopic.get(tmux) ?? null,
      getTopicName: () => null,
    };
    const server = new AgentServer({
      config: baseConfig(stateDir, tmpRoot),
      sessionManager: {
        listRunningSessions: () => [],
        getSession: () => null,
      } as never,
      state,
      telegram: telegramMock as never,
      sessionOwnershipRegistry: registry,
      meshRpcDispatcher: dispatcher,
    });
    await server.start();
    const app = server.getApp();
    const httpServer = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const srv = app.listen(0, () => {
        const addr = srv.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
      });
    });

    let sessionSeq = 0;
    const addLiveSession = (topicId: number): HarnessLiveSession => {
      const tmux = `${machineId}-s${++sessionSeq}`;
      state.saveSession({
        id: tmux,
        name: tmux,
        status: 'running',
        tmuxSession: tmux,
        startedAt: new Date().toISOString(),
      });
      sessionTopic.set(tmux, topicId);
      return { tmuxSession: tmux, topicId };
    };
    const endSession = (tmux: string): void => {
      const existing = state.listSessions().find((x) => x.tmuxSession === tmux);
      if (existing) state.saveSession({ ...existing, status: 'completed', endedAt: new Date().toISOString() });
    };
    return {
      machineId,
      url: httpServer.url,
      stateDir,
      store,
      registry,
      journal,
      reader,
      syncApplier,
      ownershipApplier,
      state,
      addLiveSession,
      endSession,
      server,
      hopLatenciesMs: [],
      stop: async () => {
        try { journal.close(); } catch { /* teardown best-effort */ }
        await httpServer.close();
        await server.stop();
      },
    };
  }

  const a = await makeNode('m_node_a');
  const b = await makeNode('m_node_b');

  /** Track per-(from,to,kind) replication cursors so repeat hops serve deltas. */
  const cursors = new Map<string, number>();

  async function replicate(from: HarnessNode, to: HarnessNode): Promise<{ applied: number; forgedEntries: number }> {
    const t0 = Date.now();
    from.journal.flush();
    const key = `${from.machineId}->${to.machineId}:topic-placement`;
    const fromSeq = cursors.get(key) ?? 0;
    const served = from.syncApplier.buildServeBatch('topic-placement', fromSeq, from.machineId);
    const client = new MeshRpcClient({
      selfMachineId: from.machineId,
      sign: (c) => sign(c, keys[from.machineId].priv),
      nonce: () => `hop-${++nonceSeq}`,
      now: () => Date.now(),
    });
    const res = await client.send(
      { machineId: to.machineId, url: to.url },
      { type: 'journal-sync', batch: [served] } as unknown as MeshCommand,
      0,
    );
    if (!(res as { ok?: boolean }).ok) {
      throw new Error(`replication hop refused: ${JSON.stringify(res)}`);
    }
    const lastSeq = served.entries.reduce((m, e) => Math.max(m, (e as { seq?: number }).seq ?? 0), fromSeq);
    cursors.set(key, lastSeq);
    const result = (res as { result?: { result?: { applied: number; forgedEntries: number } } }).result?.result ?? { applied: 0, forgedEntries: 0 };
    to.hopLatenciesMs.push(Date.now() - t0);
    return result;
  }

  function applierTick(node: HarnessNode): { examined: number; materialized: number } {
    return node.ownershipApplier.tick();
  }

  return {
    a,
    b,
    replicate,
    applierTick,
    teardown: async () => {
      await a.stop();
      await b.stop();
      SafeFsExecutor.safeRmSync(tmpRoot, { recursive: true, force: true, operation: 'tests/support/twoNodeOwnershipHarness.ts:teardown' });
    },
  };
}
