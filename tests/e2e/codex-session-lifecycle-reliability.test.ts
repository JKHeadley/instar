import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { detectTmuxPath } from '../../src/core/Config.js';
import {
  InboundDeliveryStore, InboundDeliveryStoreUnavailableError, loadOrCreateDeliveryHmacKey,
} from '../../src/core/InboundDeliveryStore.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RecoveryActuationAuthority } from '../../src/core/RecoveryActuationAuthority.js';
import { SessionRecoveryChannel } from '../../src/core/SessionRecoveryChannel.js';
import {
  createInboundDeliveryTransferHandler, createInboundDeliveryTransferStep,
  createProductionSessionRecoveryConsumer, stageCActivationLeaseIsLive, writeStageCActivationLease,
} from '../../src/core/CodexLifecycleProductionComposition.js';
import type { InstarConfig } from '../../src/core/types.js';
import {
  canonicalStageBRcArtifact, resolveStageBProductionActivation, stageBConfigSha256,
  type StageBRcArtifact, type StageBActivationStatus,
} from '../../src/core/StageBActivationGate.js';
import { waitFor } from '../helpers/setup.js';

const tmuxPath = detectTmuxPath();
const describeMaybe = tmuxPath ? describe : describe.skip;
const AUTH = 'codex-lifecycle-e2e-token';
let ACTIVE: StageBActivationStatus;

describeMaybe('Codex session lifecycle reliability — production AgentServer path', () => {
  let projectDir: string;
  let stateDir: string;
  let config: InstarConfig;
  let state: StateManager;
  let manager: SessionManager;
  let server: AgentServer;
  let tmuxSession = '';
  let rolloutPath = '';
  let bootstrapRolloutPath = '';

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lifecycle-e2e-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    const mockCodex = path.join(projectDir, 'mock-codex.sh');
    fs.writeFileSync(mockCodex, '#!/bin/bash\necho READY\nwhile IFS= read -r line; do echo "RECEIVED:$line"; done\n');
    fs.chmodSync(mockCodex, 0o755);
    config = {
      projectName: 'codex-lifecycle-e2e', projectDir, stateDir, port: 0, authToken: AUTH,
      sessions: {
        tmuxPath: tmuxPath!, claudePath: mockCodex, projectDir, maxSessions: 2,
        protectedSessions: [], completionPatterns: [], framework: 'codex-cli',
        frameworkBinaryPaths: { 'codex-cli': mockCodex },
      },
      scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false },
      codexSessionLifecycle: { ledgerObserverEnabled: true, stageBPendingActivation: true },
    } as InstarConfig;
    const signing = crypto.generateKeyPairSync('ed25519');
    const packageVersion = 'e2e-production-build';
    const gitCommit = 'e2e-production-commit';
    const echoMachineId = 'studio';
    const configSha256 = stageBConfigSha256(config.codexSessionLifecycle);
    const unsigned: Omit<StageBRcArtifact, 'signature'> = {
      schemaVersion: 1, packageVersion, gitCommit, configSha256, echoMachineId,
      startedAt: 1_000, endedAt: 1_000 + 2 * 60 * 60 * 1_000,
      deliveryCount: 50,
      caseCounts: { identical: 1, multiline: 1, 'active-turn': 1, resize: 1, outage: 1, transfer: 1 },
      failures: { falseUnknown: 0, falseExhaustion: 0, duplicateKeyOwnership: 0, lostInbound: 0, staleOwnerAction: 0 },
      rawEvidenceDigests: ['a'.repeat(64)], reviewerDecision: 'approved',
    };
    const artifact: StageBRcArtifact = {
      ...unsigned,
      signature: crypto.sign(null, Buffer.from(canonicalStageBRcArtifact(unsigned)), signing.privateKey).toString('base64'),
    };
    fs.writeFileSync(path.join(stateDir, 'state', 'codex-stage-b-rc.json'), JSON.stringify(artifact));
    ACTIVE = resolveStageBProductionActivation({
      stateDir, config: config.codexSessionLifecycle, packageVersion, gitCommit, echoMachineId,
      echoPublicKeyPem: signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    expect(ACTIVE).toMatchObject({ active: true, reason: 'active', configured: true, pendingActivation: true });
    state = new StateManager(stateDir);
    rolloutPath = path.join(projectDir, 'captured-codex-rollout.jsonl');
    fs.writeFileSync(rolloutPath, JSON.stringify({ type: 'session_meta', payload: { id: 'e2e-thread' } }) + '\n');
    manager = new SessionManager(config.sessions, state, {
      stageBActivation: ACTIVE,
      stageCRecoveryEnabled: false,
      localMachineId: () => 'studio',
      ownerEpochForConversation: () => 7,
      codexRolloutPathForSession: (session) => session.claudeSessionId === 'bootstrap-thread'
        ? bootstrapRolloutPath
        : (session.claudeSessionId ? rolloutPath : null),
    });
    server = new AgentServer({ config, sessionManager: manager, state });
    tmuxSession = await manager.spawnInteractiveSession(undefined, 'codex-lifecycle-live', {
      framework: 'codex-cli', telegramTopicId: 59199,
    });
    const spawned = state.listSessions().find((session) => session.tmuxSession === tmuxSession);
    if (!spawned) throw new Error('spawned lifecycle session was not persisted');
    state.saveSession({ ...spawned, claudeSessionId: 'e2e-thread' });
    manager.startMonitoring(100);
  });

  afterAll(async () => {
    if (tmuxSession && tmuxPath) {
      try { execFileSync(tmuxPath, ['kill-session', '-t', `=${tmuxSession}`], { timeout: 5_000 }); } catch { /* already gone */ }
    }
    await server?.stop();
    manager?.stopMonitoring();
    if (projectDir) SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'codex lifecycle e2e cleanup' });
  });

  it('injects through real tmux and exposes only authenticated privacy-safe lifecycle status', async () => {
    await waitFor(() => manager.captureOutput(tmuxSession, 20)?.includes('READY') ?? false, 5_000);
    expect(manager.sendInput(tmuxSession, 'private-e2e-message-59199')).toBe(true);
    await waitFor(() => manager.captureOutput(tmuxSession, 30)?.includes('private-e2e-message-59199') ?? false, 8_000);
    const turnId = 'e2e-turn-59199';
    fs.appendFileSync(rolloutPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private-e2e-message-59199' }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'received' }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await waitFor(() => manager.inboundDeliveryStatus().deliveriesByState.responded === 1, 5_000);

    expect((await request(server.getApp()).get('/sessions/inbound-delivery-status')).status).toBe(401);
    const status = await request(server.getApp()).get('/sessions/inbound-delivery-status')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, durability: 'sqlite-full', blindReplay: false });
    expect(status.body.deliveriesByState.responded).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(status.body)).not.toContain('private-e2e-message-59199');
    expect(fs.existsSync(path.join(stateDir, 'state', 'codex-lifecycle-downgrade-floor.json'))).toBe(true);
    const projected = fs.readdirSync(path.join(stateDir, 'state', 'pending-injects'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'pending-injects', name), 'utf8')))
      .find((row) => row.tombstone === true);
    expect(projected).toMatchObject({ doNotReplay: true, deliveryId: expect.any(String), initialMessage: '' });
  });

  it('runs the internal /compact control primitive under Stage B without minting a delivery row', async () => {
    const before = manager.inboundDeliveryStatus();
    expect('unavailable' in before).toBe(false);
    const logicalRowsBefore = 'unavailable' in before ? -1 : before.logicalRows;

    expect(manager.injectInternalControlCommand(tmuxSession, '59199', '/compact')).toBe(true);
    await waitFor(() => manager.captureOutput(tmuxSession, 30)?.includes('RECEIVED:/compact') ?? false, 8_000);

    const after = manager.inboundDeliveryStatus();
    expect('unavailable' in after).toBe(false);
    if (!('unavailable' in after)) expect(after.logicalRows).toBe(logicalRowsBefore);
  });

  it('converges a production-wired response after more than one non-aligned observer byte budget', async () => {
    const text = 'large-valid-backlog-e2e';
    const before = manager.inboundDeliveryStatus();
    if ('unavailable' in before) throw new Error('Stage B unexpectedly unavailable');
    expect(manager.sendInput(tmuxSession, text)).toBe(true);
    const padding = JSON.stringify({
      type: 'turn_context', payload: { type: 'turn_context', padding: 'x'.repeat(700) },
    }) + '\n';
    // Default observer row budget is 256 KiB. End the first bounded read in
    // the middle of an otherwise valid JSONL event, reproducing the live busy-
    // session false-unknown condition rather than an exact-newline fixture.
    fs.appendFileSync(rolloutPath, padding.repeat(400));
    const turnId = 'large-backlog-turn';
    fs.appendFileSync(rolloutPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    for (let index = 0; index < 4; index++) await manager.sweepInboundDeliveryObserverForTesting();
    const after = manager.inboundDeliveryStatus();
    if ('unavailable' in after) throw new Error('Stage B unexpectedly unavailable');
    expect(after.deliveriesByState.responded).toBe((before.deliveriesByState.responded ?? 0) + 1);
    expect(after.deliveriesByState['effect-unknown'] ?? 0).toBe(before.deliveriesByState['effect-unknown'] ?? 0);
  });

  it('tracks the first fresh Codex bootstrap before a rollout exists and binds it from offset zero', async () => {
    const bootstrapText = 'fresh-bootstrap-e2e';
    const managerWithReadySeam = manager as unknown as {
      waitForClaudeReadyWithRetry(session: string, timeout: number): Promise<boolean>;
    };
    const originalReady = managerWithReadySeam.waitForClaudeReadyWithRetry.bind(manager);
    managerWithReadySeam.waitForClaudeReadyWithRetry = async () => true;
    let bootstrapTmux = '';
    try {
      bootstrapTmux = await manager.spawnInteractiveSession(bootstrapText, 'fresh-bootstrap-live', {
        framework: 'codex-cli', telegramTopicId: 959198, awaitInitialInjection: true,
      });
      await waitFor(() => manager.captureOutput(bootstrapTmux, 30)?.includes(bootstrapText) ?? false, 8_000);
      const store = InboundDeliveryStore.open(stateDir);
      const row = store.dispatchablePrepared(Number.MAX_SAFE_INTEGER)
        .find((candidate) => candidate.incarnation === bootstrapTmux)
        ?? store.observableDeliveries(100).find((candidate) => candidate.incarnation === bootstrapTmux);
      expect(row).toMatchObject({ rolloutPath: null, baselineOffset: -1, transportState: 'dispatched' });
      bootstrapRolloutPath = path.join(projectDir, 'fresh-bootstrap-rollout.jsonl');
      fs.writeFileSync(bootstrapRolloutPath, [
        { type: 'session_meta', payload: { id: 'bootstrap-thread' } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: 'bootstrap-turn' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: bootstrapText }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'bootstrap-turn' } },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n');
      const session = state.listSessions().find((candidate) => candidate.tmuxSession === bootstrapTmux)!;
      state.saveSession({ ...session, claudeSessionId: 'bootstrap-thread' });
      await manager.sweepInboundDeliveryObserverForTesting();
      expect(store.get(row!.conversationId, row!.deliveryId)).toMatchObject({
        baselineOffset: 0, transcriptState: 'responded', turnId: 'bootstrap-turn',
      });
      const rowsBeforeRefusal = store.status().logicalRows;
      const rebound = state.listSessions().find((candidate) => candidate.tmuxSession === bootstrapTmux)!;
      state.saveSession({ ...rebound, claudeSessionId: undefined });
      expect(manager.sendInput(bootstrapTmux, 'must remain with owning ingress')).toBe(false);
      expect(store.status().logicalRows).toBe(rowsBeforeRefusal);
      store.close();
    } finally {
      managerWithReadySeam.waitForClaudeReadyWithRetry = originalReady;
      if (bootstrapTmux) {
        try { execFileSync(tmuxPath!, ['kill-session', '-t', `=${bootstrapTmux}`], { timeout: 5_000 }); } catch { /* already gone */ }
      }
    }
  });

  it('reconciles a crash-open production ledger row to permanent uncertainty on manager restart', () => {
    const store = InboundDeliveryStore.open(stateDir);
    const key = loadOrCreateDeliveryHmacKey(stateDir);
    const row = store.prepare({
      conversationId: '59199', deliveryId: 'crash-open-e2e', incarnation: tmuxSession,
      framework: 'codex-cli', envelope: 'never replay this ambiguous body', hmacKey: key,
      ownerMachineId: 'studio', ownerEpoch: 7,
    });
    store.transition('59199', row.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('59199', row.deliveryId, 'dispatch-armed', 'dispatch-started');

    const restarted = new SessionManager(config.sessions, state, {
      stageBActivation: ACTIVE, localMachineId: () => 'studio', ownerEpochForConversation: () => 7,
      codexRolloutPathForSession: () => rolloutPath,
    });
    expect(restarted.inboundDeliveryStatus()).toMatchObject({
      uncertainEffects: expect.any(Number),
      deliveriesByState: { 'effect-unknown': expect.any(Number) },
    });
    expect(store.get('59199', row.deliveryId)?.transportState).toBe('effect-unknown');
    expect(store.transition('59199', row.deliveryId, 'effect-unknown', 'dispatched')).toBe(false);
  });

  it('retains later inbound as durable prepared FIFO and dispatches it only after its predecessor responds', async () => {
    const store = InboundDeliveryStore.open(stateDir);
    const key = loadOrCreateDeliveryHmacKey(stateDir);
    for (let index = 0; index < 4; index++) {
      store.prepare({
        conversationId: `dead-${index}`, deliveryId: `dead-${index}`, incarnation: `dead-codex-${index}`,
        framework: 'codex-cli', envelope: `dead ${index}`, hmacKey: key,
        ownerMachineId: 'studio', ownerEpoch: 7,
      });
      store.prepare({
        conversationId: `stale-${index}`, deliveryId: `stale-${index}`, incarnation: tmuxSession,
        framework: 'codex-cli', envelope: `stale ${index}`, hmacKey: key,
        ownerMachineId: 'former-owner', ownerEpoch: 6,
      });
    }
    const first = 'fifo-first-e2e';
    const second = 'fifo-second-e2e';
    expect(manager.sendInput(tmuxSession, first)).toBe(true);
    expect(manager.sendInput(tmuxSession, second)).toBe(true);
    await waitFor(() => manager.captureOutput(tmuxSession, 40)?.includes(first) ?? false, 8_000);
    expect(manager.captureOutput(tmuxSession, 40)).not.toContain(second);
    const appendTurn = (turnId: string, text: string) => fs.appendFileSync(rolloutPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    appendTurn('fifo-turn-one', first);
    await waitFor(() => manager.captureOutput(tmuxSession, 50)?.includes(second) ?? false, 8_000);
    appendTurn('fifo-turn-two', second);
    await waitFor(() => manager.inboundDeliveryStatus().verification?.responded >= 3, 5_000);
  });

  it('reports Stage C honestly dark unless its independent durable authority gate is enabled', async () => {
    const status = await request(server.getApp()).get('/sessions/inbound-delivery-status')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(status.body.scopedRefreshRecovery).toEqual({ enabled: false, mode: 'dark' });
  });

  it('keeps Stage B typed-dark when the actual production writer cannot verify FULL durability', () => {
    const unavailable = new SessionManager(config.sessions, state, {
      stageBActivation: ACTIVE,
      openInboundDeliveryStoreForTesting: () => {
        throw new InboundDeliveryStoreUnavailableError('startup-full-failed', 'injected production handle drift');
      },
    });
    expect(unavailable.inboundDeliveryStatus()).toMatchObject({
      unavailable: true,
      activation: { active: false, reason: 'startup-full-failed' },
    });
  });

  it('moves encrypted live custody through the production transfer/handler composition with epoch fencing', async () => {
    const targetState = path.join(projectDir, '.instar-target');
    const source = InboundDeliveryStore.open(stateDir);
    const targetKeys = crypto.generateKeyPairSync('x25519');
    const row = source.prepare({
      conversationId: '59199', deliveryId: 'transfer-e2e', incarnation: tmuxSession,
      framework: 'codex-cli', envelope: 'encrypted handoff body', hmacKey: 'source-hmac',
      ownerMachineId: 'studio', ownerEpoch: 7,
    });
    const sourceRollout = path.join(projectDir, 'transfer-source.jsonl');
    fs.writeFileSync(sourceRollout, JSON.stringify({ type: 'session_meta', payload: { id: 'source-rollout' } }) + '\n');
    source.bindRolloutBaseline('59199', row.deliveryId, sourceRollout, 'source-rollout', fs.statSync(sourceRollout).size);
    source.transition('59199', row.deliveryId, 'prepared', 'dispatch-armed');
    source.transition('59199', row.deliveryId, 'dispatch-armed', 'dispatch-started');
    source.transition('59199', row.deliveryId, 'dispatch-started', 'dispatched');
    const successor = path.join(projectDir, 'transfer-successor.jsonl');
    fs.writeFileSync(successor, JSON.stringify({ type: 'session_meta', payload: { id: 'source-rollout' } }) + '\n');
    fs.mkdirSync(path.join(targetState, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(targetState, 'state', 'jobs'), { recursive: true });
    const targetStateManager = new StateManager(targetState);
    const sourceSession = state.listSessions().find((session) => session.tmuxSession === tmuxSession)!;
    targetStateManager.saveSession({
      ...sourceSession, id: 'mini-successor-id', tmuxSession: 'mini-successor',
      claudeSessionId: 'source-rollout', status: 'running',
    });
    targetStateManager.saveSession({
      ...sourceSession, id: 'unrelated-same-topic-id', tmuxSession: 'unrelated-session',
      claudeSessionId: 'unrelated-rollout', status: 'running',
    });
    const targetManager = new SessionManager(config.sessions, targetStateManager, {
      stageBActivation: ACTIVE, localMachineId: () => 'mini', ownerEpochForConversation: () => 9,
      codexRolloutPathForSession: () => successor,
    });
    const registry = path.join(targetState, 'topic-session-registry.json');
    fs.writeFileSync(registry, JSON.stringify({ topicToSession: { '59199': 'mini-successor' }, topicToName: { '59199': 'transfer' } }));
    targetManager.setInputGuard({} as never, registry);
    const targetPublic = (targetKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const receive = createInboundDeliveryTransferHandler({
      selfMachineId: 'mini',
      readOwnership: () => ({ ownerMachineId: 'studio', status: 'transferring', ownershipEpoch: 8, transferTo: 'mini' }),
      ownEncryptionPrivateKey: () => targetKeys.privateKey,
      importTransfer: (input) => targetManager.importInboundDeliveryTransfer(input),
    });
    let wirePayload = '';
    const transferStep = createInboundDeliveryTransferStep({
      selfMachineId: 'studio', activationActive: () => true,
      targetEncryptionPublicKey: () => targetPublic,
      exportTransfer: (input) => source.exportLiveRows({ ...input, localHmacKey: 'source-hmac' }),
      sendTransfer: async (_target, session, sourceEpoch, transferEpoch, transfer) => {
        wirePayload = JSON.stringify(transfer);
        const response = receive({ session, sourceEpoch, transferEpoch, transfer }, 'studio');
        return response.accepted ? { ok: true } : { ok: false, reason: response.reason };
      },
    });
    expect(await transferStep({ sessionKey: '59199', target: 'mini', sourceEpoch: 7, transferEpoch: 8, activeEpoch: 9 }))
      .toEqual({ ok: true });
    expect(wirePayload).not.toContain('encrypted handoff body');
    expect(source.ownsLiveDelivery('59199', row.deliveryId, 'studio', 7)).toBe(false);
    const target = InboundDeliveryStore.open(targetState);
    expect(target.ownsLiveDelivery('59199', row.deliveryId, 'mini', 9)).toBe(true);
    expect(target.status()).not.toHaveProperty('envelope');
    await targetManager.sweepInboundDeliveryObserverForTesting();
    expect(target.get('59199', row.deliveryId)).toMatchObject({
      incarnation: 'mini-successor', rolloutId: 'source-rollout', rolloutPath: successor,
    });
    const turnId = 'transfer-successor-turn';
    fs.appendFileSync(successor, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'encrypted handoff body' }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'continued on target' }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n');
    await targetManager.sweepInboundDeliveryObserverForTesting();
    expect(target.get('59199', row.deliveryId)?.transcriptState).toBe('responded');
    target.close();
  });

  it('publishes Stage C once through durable authority and the real lifeline consumer', async () => {
    const channel = new SessionRecoveryChannel(stateDir);
    const authority = RecoveryActuationAuthority.open(stateDir);
    const authorized = authority.authorize({
      conversationId: 'recovery:59199', deliveryId: 'exhausted-e2e',
      operatorStopEpoch: 1, observedOperatorStopEpoch: 1,
      ownerEpoch: 7, observedOwnerEpoch: 7, latestOrdinal: 3, deliveryOrdinal: 3,
      sessionActive: false, incarnation: tmuxSession, observedIncarnation: tmuxSession,
      deliveryExhausted: true, breakerOpen: false,
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) throw new Error(authorized.reason);
    const published = authority.publish(authorized.capability.id, () => channel.requestRecovery({
      sessionId: tmuxSession, tier: 'server-restart-replay', reason: 'e2e exhausted',
      observedAt: new Date().toISOString(), attemptId: 'stage-c-e2e-1', requestedBy: 'RecoveryActuationAuthority',
    }));
    expect(published).toEqual({ ok: true, requested: true });
    let restarts = 0;
    let replays = 0;
    const consumer = createProductionSessionRecoveryConsumer({
      stateDir, dryRun: false, restartCooldownMs: 600_000,
      actuationEnabled: () => true,
      restart: async () => { restarts += 1; return true; }, replay: () => { replays += 1; }, log: () => {},
    });
    await consumer.tick();
    await consumer.tick();
    expect({ restarts, replays }).toEqual({ restarts: 1, replays: 1 });
    expect(channel.readAck(tmuxSession)).toMatchObject({ attemptId: 'stage-c-e2e-1', outcome: 'recovered' });
    const reopened = RecoveryActuationAuthority.open(stateDir);
    expect(reopened.authorize({
      conversationId: 'recovery:59199', deliveryId: 'exhausted-e2e',
      operatorStopEpoch: 1, observedOperatorStopEpoch: 1,
      ownerEpoch: 7, observedOwnerEpoch: 7, latestOrdinal: 3, deliveryOrdinal: 3,
      sessionActive: false, incarnation: tmuxSession, observedIncarnation: tmuxSession,
      deliveryExhausted: true, breakerOpen: false,
    })).toEqual({ ok: false, reason: 'recovery-already-recorded' });
  });

  it('refuses a pending Stage C request when the production activation lease is dark', async () => {
    const darkState = path.join(projectDir, '.instar-stage-c-dark');
    const channel = new SessionRecoveryChannel(darkState);
    channel.requestRecovery({
      sessionId: 'dark-stage-c', tier: 'server-restart-replay', reason: 'stale request',
      observedAt: new Date().toISOString(), attemptId: 'dark-1', requestedBy: 'e2e',
    });
    writeStageCActivationLease(darkState, false);
    const wedgeEnabled = true;
    const stageCRecoveryEnabled = false;
    let restarts = 0;
    let replays = 0;
    const consumer = createProductionSessionRecoveryConsumer({
      stateDir: darkState, dryRun: false, restartCooldownMs: 600_000,
      actuationEnabled: () => wedgeEnabled && stageCRecoveryEnabled && stageCActivationLeaseIsLive(darkState),
      restart: async () => { restarts += 1; return true; }, replay: () => { replays += 1; }, log: () => {},
    });
    await consumer.tick();
    expect({ restarts, replays }).toEqual({ restarts: 0, replays: 0 });
    expect(channel.readAck('dark-stage-c')).toMatchObject({ outcome: 'failed' });
  });

  it('refuses a stale enabled Stage C lease when its PID has been reused', async () => {
    const staleState = path.join(projectDir, '.instar-stage-c-pid-reuse');
    const channel = new SessionRecoveryChannel(staleState);
    channel.requestRecovery({
      sessionId: 'stale-stage-c', tier: 'server-restart-replay', reason: 'stale enabled request',
      observedAt: new Date().toISOString(), attemptId: 'stale-1', requestedBy: 'e2e',
    });
    writeStageCActivationLease(staleState, true, 4242, () => 'Fri Aug 28 15:00:00 2026');
    let restarts = 0;
    let replays = 0;
    const consumer = createProductionSessionRecoveryConsumer({
      stateDir: staleState, dryRun: false, restartCooldownMs: 600_000,
      actuationEnabled: () => stageCActivationLeaseIsLive(staleState, () => 'Fri Aug 28 15:01:00 2026'),
      restart: async () => { restarts += 1; return true; }, replay: () => { replays += 1; }, log: () => {},
    });
    await consumer.tick();
    expect({ restarts, replays }).toEqual({ restarts: 0, replays: 0 });
    expect(channel.readAck('stale-stage-c')).toMatchObject({ outcome: 'failed' });
  });
});
