// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e (context-budget-layered-summaries §14 skew rule): the layer kind is ALIVE
 * on the production init path. The registry is built and the kind registered
 * the way server.ts does it (dynamic import of the registration), the fold
 * coordinator is built with server.ts's own `layerKindPresent` expression, and:
 *  - with the kind registered, a fold is NOT refused for `layers-not-replicated`
 *    (it proceeds and takes the lock);
 *  - on a build without the kind (an older holder), the fold is refused with
 *    exactly `layers-not-replicated`;
 *  - a record emitted through a real CoherenceJournal on this path lands.
 * Plus a WIRED source check that server.ts uses this exact path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-layer-kind-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = '141133';

describe('context layer kind — alive on the production init path', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  async function boot(registerKind: boolean) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-layer-alive-'));
    dirs.push(stateDir);
    const replicatedKindRegistry = new ReplicatedKindRegistry();
    if (registerKind) {
      // Exactly server.ts's registration statement.
      const { CONTEXT_LAYER_KIND_REGISTRATION } = await import('../../src/monitoring/contextLayerKind.js');
      replicatedKindRegistry.register(CONTEXT_LAYER_KIND_REGISTRATION);
    }
    const built = buildFoldCoordinator({
      stateDir,
      runningTopicSessions: () => [{ topicKey: TOPIC }],
      poolPlacementLive: () => false,
      inboundQueueLive: () => true,
      topicRowsPresent: () => true,
      sentinelHeartbeatFresh: () => true,
      // Exactly server.ts's expression.
      layerKindPresent: () => replicatedKindRegistry.isReplicatedKind('context-layer-record'),
    });
    return { stateDir, replicatedKindRegistry, coordinator: built.coordinator };
  }

  it('with the kind registered, the fold proceeds past the skew rule and takes the lock', async () => {
    const { coordinator } = await boot(true);
    const r = coordinator.begin(TOPIC);
    expect(r.ok).toBe(true);
  });

  it('on a build without the kind, the fold is refused with layers-not-replicated', async () => {
    const { coordinator } = await boot(false);
    expect(coordinator.begin(TOPIC)).toEqual({ ok: false, reason: 'layers-not-replicated' });
  });

  it('a layer record emitted through a real journal on this registry lands on disk', async () => {
    const { stateDir, replicatedKindRegistry } = await boot(true);
    const { buildContextLayerPut, CONTEXT_LAYER_RECORD_KIND } = await import('../../src/monitoring/contextLayerKind.js');
    const journal = new CoherenceJournal({ stateDir, machineId: 'm_e2e', flushIntervalMs: 1_000_000 });
    journal.open();
    journal.setReplicatedKindRegistry(replicatedKindRegistry);
    try {
      const b = buildContextLayerPut({ recordType: 'anchor', topicKey: TOPIC, entryKey: 'a', body: 'goal' });
      if (!b.ok) throw new Error(b.reason);
      expect(journal.emitReplicatedRecord(CONTEXT_LAYER_RECORD_KIND, b.build({ physical: 1, logical: 0, node: 'm_e2e' }, 'm_e2e'))).toBe('accepted');
      journal.flush();
      expect(journal.readTail(CONTEXT_LAYER_RECORD_KIND, 10).entries).toHaveLength(1);
    } finally { journal.close(); }
  });

  it('with production\'s Phase 0 dependencies (no sentinel heartbeat yet at boot, no topic rows) a fold is still refused, kind or not', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-layer-prod-')); dirs.push(stateDir);
    const replicatedKindRegistry = new ReplicatedKindRegistry();
    const { CONTEXT_LAYER_KIND_REGISTRATION } = await import('../../src/monitoring/contextLayerKind.js');
    replicatedKindRegistry.register(CONTEXT_LAYER_KIND_REGISTRATION);
    // The same dependency set server.ts passes at boot: no sentinel heartbeat yet, and no rows present for the topic.
    const { coordinator } = buildFoldCoordinator({
      stateDir, runningTopicSessions: () => [{ topicKey: TOPIC }], poolPlacementLive: () => false, inboundQueueLive: () => true,
      topicRowsPresent: () => false,
      layerKindPresent: () => replicatedKindRegistry.isReplicatedKind('context-layer-record'),
    });
    expect(coordinator.begin(TOPIC)).toEqual({ ok: false, reason: 'no-sentinel' });
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const build = src.indexOf('const built = buildFoldCoordinator({');
    const call = src.slice(build, src.indexOf('});', build));
    // The heartbeat is read lazily from the sentinel, which is built after the sweep and has not ticked at boot.
    expect(call).toContain('sentinelHeartbeatFresh: () => _contextBudgetSentinel?.heartbeatFresh() ?? false');
    // S3: the precondition reads the relay-path carrier's watermark (false until rows are present).
    expect(call).toContain('topicRowsPresent: (topicKey) => _topicRowCarrier?.rowsPresent(topicKey) ?? false');
  });

  it('WIRED: server.ts registers the kind before building the coordinator and passes the registry check', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const reg = src.indexOf('replicatedKindRegistry.register(CONTEXT_LAYER_KIND_REGISTRATION)');
    const build = src.indexOf('const built = buildFoldCoordinator({');
    expect(reg).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(reg);
    expect(src.slice(build, build + 3000)).toContain("layerKindPresent: () => replicatedKindRegistry.isReplicatedKind('context-layer-record')");
  });
});
