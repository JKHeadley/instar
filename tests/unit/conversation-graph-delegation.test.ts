import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationGraphDelegationSource, ConversationGraphDelegationIngress, validDelegationConversationRef,
  verifyGraphDelegationSource, verifyGraphDelegationAuthorization, verifyGraphDelegationCoreSource, type DelegationPlacementHead,
  type GraphDelegationConversationRef, type DelegationCaptureInput, type SignedGraphDelegationSource,
} from '../../src/core/ConversationGraphDelegation.js';
import { MachineIdentityManager, sign, verify } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { WriteAdmission } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NOW = Date.parse('2026-11-05T09:45:00Z');
const telegram = (topicId: number): GraphDelegationConversationRef => ({ kind: 'conversation', platform: 'telegram', chatId: '-100123', topicId });

describe('authenticated graph delegation ingress', () => {
  let ownershipMachine: string;
  let ownershipEpoch: number;
  let dir: string;
  let identity: MachineIdentityManager;
  let state: StateManager;
  let registry: ConversationRegistry;
  let admission: WriteAdmission;
  let capture: ConversationGraphDelegationSource;
  let ingress: ConversationGraphDelegationIngress;
  let input: DelegationCaptureInput;
  let heads: DelegationPlacementHead[];
  let scope: string[];
  let project: string;
  let readonly: boolean;
  let epoch: number;
  let lease: ReturnType<FencedLease['signLease']>;
  let fl: FencedLease;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-delegation-'));
    identity = new MachineIdentityManager(dir);
    const machine = await identity.generateIdentity({ name: 'delegation-test' });
    fl = new FencedLease({ selfMachineId: machine.machineId,
      sign: (bytes) => sign(bytes, identity.loadSigningKey()),
      verify: (bytes, signature, id) => { const key = identity.getSigningPublicKeyPem(id); return !!key && verify(bytes, signature, key); },
    }, { leaseTtlMs: 60000, failoverThresholdMs: 180000 });
    epoch = 4;
    lease = fl.signLease(epoch, new Date(NOW - 1000).toISOString(), new Date(NOW + 59000).toISOString(), 1);
    readonly = false;
    admission = new WriteAdmission({ thisMachineId: machine.machineId, isReadOnly: () => readonly, isPoolActive: () => true,
      registry: buildWriteDomainRegistry({ machineId: machine.machineId }), dryRun: false, disableTimers: true });
    const coordinator = { currentEpoch: () => epoch, currentLease: () => lease,
      holdsLease: () => fl.holdsValidLease(lease, epoch, NOW) };
    state = new StateManager(dir);
    state.saveSession({ id: 'parent-session', name: 'parent', tmuxSession: 'echo-parent', status: 'running', startedAt: new Date(NOW - 2000).toISOString(), telegramTopicId: 42 });
    state.saveSession({ id: 'worker-session', name: 'worker', tmuxSession: 'echo-worker', status: 'running', startedAt: new Date(NOW - 1000).toISOString(), telegramTopicId: 43 });
    registry = new ConversationRegistry({ stateDir: dir, machineId: () => machine.machineId });
    const bindAuth = createConversationBindAuth(dir);
    input = { sourceId: 'dispatch-source-1', parentSessionId: 'parent-session', workerSessionId: 'worker-session', parentRef: telegram(42), workerRef: telegram(43),
      parentBindToken: bindAuth.mint('echo-parent', [42]), workerBindToken: bindAuth.mint('echo-worker', [43]) };
    project = 'instar';
    heads = [];
    scope = ['instar'];
    ownershipMachine = machine.machineId; ownershipEpoch = 7;
    const common = { ownershipForConversation: (ref: GraphDelegationConversationRef) => ({ sessionKey: `telegram-${ref.platform === 'telegram' ? ref.topicId : 'other'}`, ownerMachineId: ownershipMachine, ownershipEpoch, status: 'active' as const, nonce: 'ownership', timestamp: NOW, updatedAt: new Date(NOW - 1000).toISOString() }), agentId: 'echo', identity, admission, coordinator, now: () => NOW };
    capture = new ConversationGraphDelegationSource({ ...common, state, bindAuth, conversations: registry,
      telegramChatId: '-100123', projectForConversation: () => project,
      conversationIdsForSession: (tmux) => tmux === 'echo-parent' ? [42] : tmux === 'echo-worker' ? [43] : [] });
    ingress = new ConversationGraphDelegationIngress({ ...common, stateDir: dir, verifiedHeadsFor: () => heads, parentProjectScope: () => scope,
      currentProjectForConversation: () => project });
  });
  afterEach(async () => {
    admission?.stop();
    await registry?.close();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-delegation-test-cleanup' });
    vi.useRealTimers();
  });

  function captured(): SignedGraphDelegationSource {
    const result = capture.captureSuccessfulSpawn(input);
    if (result.status !== 'captured-local') throw new Error(result.reason);
    return result.source;
  }

  it('refuses stale running bindings when ownership moved, and fences both signed ownership epochs', () => {
    ownershipMachine = 'other-machine';
    expect(capture.captureSuccessfulSpawn(input)).toMatchObject({ status: 'refused', reason: 'session-ownership-required' });
    ownershipMachine = identity.loadIdentity().machineId;
    const source = captured(); ownershipEpoch++;
    expect(ingress.prepare(source)).toMatchObject({ status: 'refused', reason: 'source-session-ownership-changed' });
  });
  it('rejects plaintext on an otherwise authentic signed placement core', () => {
    const source = captured(); const result = ingress.prepare(source); if (result.status !== 'proposed') throw new Error(result.status);
    const forged = { ...result.core, title: 'private plaintext' };
    expect(verifyGraphDelegationAuthorization(forged, result.authorizationReceipt, source, identity)).toBe(false);
    expect(verifyGraphDelegationCoreSource(forged, source, identity.getSigningPublicKeyPem(identity.loadIdentity().machineId)!, 'echo', identity.loadIdentity().machineId)).toBe(false);
    expect(verifyGraphDelegationSource({ ...source, parentOwnership: { ...source.parentOwnership, title: 'plaintext' } }, identity, 'echo').ok).toBe(false);
    expect(verifyGraphDelegationSource({ ...source, lease: { ...source.lease, released: 'plaintext' } }, identity, 'echo').ok).toBe(false);
  });

  it('captures a real persisted spawn with real machine signatures and proposes one narrow edge', () => {
    const source = captured();
    expect(verifyGraphDelegationSource(source, identity, 'echo').ok).toBe(true);
    const result = ingress.prepare(source);
    expect(result.status).toBe('proposed');
    if (result.status !== 'proposed') return;
    expect(result.core).toMatchObject({ op: 'set-primary-placement', relation: 'delegates-to', subject: telegram(43), parent: telegram(42), authority: 'delegation' });
    expect(verifyGraphDelegationAuthorization(result.core, result.authorizationReceipt, source, identity)).toBe(true);
    expect(JSON.stringify(source)).not.toContain(input.parentBindToken);
    expect(result).not.toHaveProperty('committed');
  });
  it('a generic API bearer, forged bootstrap capability or another session token cannot capture a source', () => {
    for (const token of ['api-bearer', input.workerBindToken, `${input.parentBindToken}bad`]) {
      expect(capture.captureSuccessfulSpawn({ ...input, parentBindToken: token })).toMatchObject({ status: 'refused', reason: 'session-bootstrap-proof-required' });
    }
    expect(fs.existsSync(path.join(dir, 'state', 'conversation-graph-delegation-sources'))).toBe(false);
  });
  it('does not accept a claimed source role, forged record, cross-agent record or changed typed ref', () => {
    const source = captured();
    expect(ingress.prepare({ ...source, workerRef: telegram(99) })).toMatchObject({ status: 'refused', reason: 'invalid-source-signature' });
    expect(ingress.prepare({ ...source, role: 'owner' })).toMatchObject({ status: 'refused', reason: 'invalid-source-record' });
    expect(ingress.prepare({ ...source, agentId: 'other' })).toMatchObject({ status: 'refused', reason: 'wrong-agent' });
    expect(ingress.prepare({ ...source, signature: Buffer.alloc(64).toString('base64') })).toMatchObject({ status: 'refused' });
  });
  it('owner placement wins even when delegation is causally later', () => {
    const source = captured();
    heads = [{ eventId: 'owner-head', authority: 'owner' }];
    expect(ingress.prepare(source)).toMatchObject({ status: 'suggestion', reason: 'owner-placement-exists' });
  });
  it('replaces only verified agent heads; import and inference remain suggestions', () => {
    const source = captured();
    heads = [{ eventId: 'agent-head', authority: 'delegation' }];
    const proposed = ingress.prepare(source);
    expect(proposed.status === 'proposed' && proposed.core.replacesPlacementEventIds).toEqual(['agent-head']);
    heads = [{ eventId: 'imported-head', authority: 'import' }];
    expect(ingress.prepare(source)).toMatchObject({ status: 'suggestion', reason: 'non-agent-placement-exists' });
  });
  it('a readonly or newly fenced writer cannot sign or accept a delegation', () => {
    const source = captured();
    readonly = true;
    expect(capture.captureSuccessfulSpawn(input)).toMatchObject({ status: 'refused', reason: 'write-admission-required' });
    expect(ingress.prepare(source)).toMatchObject({ status: 'refused', reason: 'write-admission-required' });
    readonly = false;
    epoch = 5;
    expect(ingress.prepare(source)).toMatchObject({ status: 'refused', reason: 'write-admission-required' });
    lease = fl.signLease(epoch, new Date(NOW - 1000).toISOString(), new Date(NOW + 59000).toISOString(), 2);
    expect(ingress.prepare(source)).toMatchObject({ status: 'refused', reason: 'source-epoch-fenced' });
    expect(verifyGraphDelegationSource(source, identity, 'echo').ok).toBe(true); // historical provenance remains verifiable
  });
  it('renewing the same epoch preserves both source and accepting lease evidence', () => {
    const source = captured();
    lease = fl.signLease(epoch, new Date(NOW - 500).toISOString(), new Date(NOW + 59500).toISOString(), 2);
    const result = ingress.prepare(source);
    expect(result.status).toBe('proposed');
    if (result.status === 'proposed') expect(verifyGraphDelegationAuthorization(result.core, result.authorizationReceipt, source, identity)).toBe(true);
  });
  it('source id replay returns identical evidence across source restarts and rejects changed intent', () => {
    const source = captured();
    expect(capture.captureSuccessfulSpawn(input)).toEqual({ status: 'captured-local', source });
    expect(capture.readCaptured(input.sourceId)).toEqual(source);
    state.saveSession({ ...state.getSession('worker-session')!, status: 'completed' });
    expect(capture.readCaptured(input.sourceId)).toEqual(source);
    expect(ingress.prepare(capture.readCaptured(input.sourceId))).toMatchObject({ status: 'proposed' });
  });
  it('freezes one core and receipt per source id across new heads, lease renewal and process reconstruction', () => {
    const source = captured();
    const first = ingress.prepare(source);
    expect(first.status).toBe('proposed');
    heads = [{ eventId: 'new-agent-head', authority: 'delegation' }];
    lease = fl.signLease(epoch, new Date(NOW - 500).toISOString(), new Date(NOW + 59500).toISOString(), 2);
    expect(ingress.prepare(source)).toEqual(first);
    expect(ingress.readPrepared(source.sourceId)).toEqual(first);
    heads = [{ eventId: 'new-owner-head', authority: 'owner' }];
    expect(ingress.prepare(source)).toMatchObject({ status: 'suggestion', reason: 'owner-placement-exists' });
  });
  it('cannot use an equal Telegram topic id in another group or invent a worker without a persisted spawn', () => {
    expect(capture.captureSuccessfulSpawn({ ...input, parentRef: { ...telegram(42), chatId: '-100999' } as GraphDelegationConversationRef })).toMatchObject({ status: 'refused', reason: 'session-bootstrap-proof-required' });
    expect(capture.captureSuccessfulSpawn({ ...input, workerSessionId: 'nonexistent-session' })).toMatchObject({ status: 'refused', reason: 'session-bootstrap-proof-required' });
  });
  it('captures headless sessions only after the adapter has bound their conversations', () => {
    const worker = state.getSession('worker-session')!;
    delete worker.telegramTopicId;
    state.saveSession(worker);
    expect(capture.captureSuccessfulSpawn(input)).toMatchObject({ status: 'captured-local' });
    state.saveSession({ ...worker, id: 'unbound-worker', tmuxSession: 'echo-unbound' });
    const auth = createConversationBindAuth(dir);
    expect(capture.captureSuccessfulSpawn({ ...input, workerSessionId: 'unbound-worker', workerBindToken: auth.mint('echo-unbound', [43]) }))
      .toMatchObject({ status: 'refused', reason: 'session-bootstrap-proof-required' });
  });
  it('rechecks current project scope before proposing a source with valid signatures', () => {
    const source = captured();
    scope = ['another-project'];
    expect(ingress.prepare(source)).toMatchObject({ status: 'refused', reason: 'project-scope-mismatch' });
    scope = []; // cross-project organizer grants no access, but is a valid placement scope
    expect(ingress.prepare(source)).toMatchObject({ status: 'proposed' });
    project = 'rebound-project';
    expect(ingress.prepare(source)).toMatchObject({ status: 'refused', reason: 'source-project-binding-changed' });
  });
  it('detects an altered core, receipt or lease instead of accepting source validity as graph authority', () => {
    const source = captured();
    const result = ingress.prepare(source);
    if (result.status !== 'proposed') throw new Error('expected proposal');
    expect(verifyGraphDelegationAuthorization({ ...result.core, parent: telegram(99) }, result.authorizationReceipt, source, identity)).toBe(false);
    expect(verifyGraphDelegationAuthorization(result.core, { ...result.authorizationReceipt, admissionEpoch: 99 }, source, identity)).toBe(false);
    expect(verifyGraphDelegationAuthorization(result.core, { ...result.authorizationReceipt, acceptingLease: { ...lease, nonce: 99 } }, source, identity)).toBe(false);
  });
  it('accepts only exact bounded typed conversation refs, never effort nodes or aliases', () => {
    expect(validDelegationConversationRef(telegram(42))).toBe(true);
    expect(validDelegationConversationRef({ kind: 'effort', id: 'e1' })).toBe(false);
    expect(validDelegationConversationRef({ ...telegram(42), title: 'injected title' })).toBe(false);
    expect(validDelegationConversationRef('telegram:42')).toBe(false);
    expect(validDelegationConversationRef({ kind: 'conversation', platform: 'slack', channelId: 'C123', threadTs: '1234.5678' })).toBe(true);
  });
});
