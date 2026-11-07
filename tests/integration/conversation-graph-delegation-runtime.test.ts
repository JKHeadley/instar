/** Actual isolated tmux bootstrap environment -> runtime hook -> signed,
 * fsynced delegation source+proposal. No live model, witness or central route
 * callback is claimed by this isolated integration. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConversationGraphDelegationRuntime } from '../../src/server/ConversationGraphDelegationRuntime.js';
import { ConversationGraphDelegationSource, type DelegationSourceDeps, type DelegationResult, type GraphDelegationConversationRef } from '../../src/core/ConversationGraphDelegation.js';
import { MachineIdentityManager, sign } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { WriteAdmission } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { validateGraphEvent, graphEventHash } from '../../src/core/conversationGraph.js';
import { canonicalHash } from '../../src/core/GraphWitnessTypes.js';

const run = promisify(execFile);
describe('successful local spawn runtime provenance with actual tmux bootstrap', () => {
  let dir: string, tmux: string;
  let source: DelegationSourceDeps;
  let token: string, workerToken: string;
  let prepared: Array<Extract<DelegationResult, { status: 'proposed' }>>;
  let runtime: ConversationGraphDelegationRuntime;
  let parentOwnershipEpoch: number;
  const parent = 'graph-parent', worker = 'graph-worker';
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-runtime-'));
    // One owned test socket. No command targets the user's normal tmux server.
    const socket = `graph-${crypto.randomUUID()}`;
    tmux = path.join(dir, 'tmux');
    fs.writeFileSync(tmux, `#!/bin/sh\nexec /opt/homebrew/bin/tmux -L '${socket}' "$@"\n`, { mode: 0o700 });
    const identity = new MachineIdentityManager(dir); const local = await identity.generateIdentity();
    const now = Date.now(); const state = new StateManager(dir); const auth = createConversationBindAuth(dir);
    const registry = new ConversationRegistry({ stateDir: dir, machineId: () => local.machineId });
    state.saveSession({ id: 'parent-session', name: 'parent', tmuxSession: parent, status: 'running', startedAt: new Date(now - 2000).toISOString() });
    state.saveSession({ id: 'worker-session', name: 'worker', tmuxSession: worker, status: 'running', startedAt: new Date(now - 1000).toISOString() });
    token = auth.mint(parent, [42]); workerToken = auth.mint(worker, [43]);
    await run(tmux, ['new-session', '-d', '-s', worker, '-e', `INSTAR_BIND_TOKEN=${workerToken}`, '-e', 'INSTAR_SESSION_ID=worker-session', 'sleep 60']);
    const fl = new FencedLease({ selfMachineId: local.machineId, sign: (bytes) => sign(bytes, identity.loadSigningKey()), verify: () => false }, { leaseTtlMs: 60000, failoverThresholdMs: 180000 });
    const lease = fl.signLease(7, new Date(now - 1000).toISOString(), new Date(now + 59000).toISOString(), 1);
    parentOwnershipEpoch = 3;
    const admission = new WriteAdmission({ thisMachineId: local.machineId, isReadOnly: () => false, isPoolActive: () => true,
      registry: buildWriteDomainRegistry({ machineId: local.machineId }), dryRun: false, disableTimers: true });
    source = { agentId: 'echo', identity, state, bindAuth: auth, conversations: registry, admission,
      coordinator: { holdsLease: () => true, currentEpoch: () => 7, currentLease: () => lease }, telegramChatId: '-100123',
      conversationIdsForSession: (tmuxSession) => tmuxSession === parent ? [42] : tmuxSession === worker ? [43] : [],
      projectForConversation: () => 'instar', ownershipForConversation: (ref: GraphDelegationConversationRef) => ({
        sessionKey: `telegram-${ref.platform === 'telegram' ? ref.topicId : 'other'}`, ownerMachineId: local.machineId,
        ownershipEpoch: parentOwnershipEpoch, status: 'active', nonce: 'n', timestamp: now, updatedAt: new Date(now - 1000).toISOString() }) };
    prepared = [];
    runtime = new ConversationGraphDelegationRuntime({ source, verifiedHeadsFor: () => [], parentProjectScope: () => ['instar'], tmuxPath: tmux,
      onPrepared: async (event) => { prepared.push(event); } });
  });
  afterEach(async () => {
    // Owned isolated test socket; no user session or production process is targeted.
    if (tmux) await run(tmux, ['kill-server']).catch(() => {});
    source?.admission.stop(); await source?.conversations.close();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-runtime-test-cleanup' });
  });
  it('reads the launched worker capability, derives both refs and freezes real pending source before notifying coordinator', async () => {
    const first = await runtime.afterSuccessfulSpawn(token, 'worker-session');
    expect(first).toMatchObject({ status: 'prepared-local', coordinatorNotified: true });
    expect(prepared).toHaveLength(1); expect(prepared[0].core).toMatchObject({ authority: 'delegation', relation: 'delegates-to',
      parent: { kind: 'conversation', platform: 'telegram', chatId: '-100123', topicId: 42 },
      subject: { kind: 'conversation', platform: 'telegram', chatId: '-100123', topicId: 43 } });
    expect(new ConversationGraphDelegationSource(source).readCaptured('spawn-worker-session')).toEqual(prepared[0].source);
    const exactEvent = validateGraphEvent(prepared[0].core);
    expect(exactEvent).not.toBeNull();
    expect(graphEventHash(exactEvent!)).toBe(canonicalHash(prepared[0].core));
    expect(JSON.stringify(prepared[0])).not.toContain(workerToken);
    expect(await runtime.afterSuccessfulSpawn(token, 'worker-session')).toEqual(first);
    expect(prepared[1]).toEqual(prepared[0]);
    expect(first).not.toHaveProperty('committed');
  });
  it('refuses generic bearer, mismatched actual child incarnation and invalid actual child HMAC', async () => {
    expect(await runtime.afterSuccessfulSpawn('bearer', 'worker-session')).toMatchObject({ status: 'refused' });
    await run(tmux, ['set-environment', '-t', `=${worker}`, 'INSTAR_SESSION_ID', 'reused-session-id']);
    expect(await runtime.afterSuccessfulSpawn(token, 'worker-session')).toMatchObject({ status: 'refused', reason: 'launched-worker-bootstrap-proof-required' });
    await run(tmux, ['set-environment', '-t', `=${worker}`, 'INSTAR_SESSION_ID', 'worker-session']);
    await run(tmux, ['set-environment', '-t', `=${worker}`, 'INSTAR_BIND_TOKEN', 'forged']);
    expect(await runtime.afterSuccessfulSpawn(token, 'worker-session')).toMatchObject({ status: 'refused', reason: 'launched-worker-bootstrap-proof-required' });
    expect(prepared).toHaveLength(0);
  });
  it('retains honest local pending provenance when coordinator is unavailable and refuses changed ownership on retry', async () => {
    runtime = new ConversationGraphDelegationRuntime({ source, verifiedHeadsFor: () => [], parentProjectScope: () => ['instar'], tmuxPath: tmux,
      onPrepared: async () => { throw new Error('fixture coordinator unavailable'); } });
    expect(await runtime.afterSuccessfulSpawn(token, 'worker-session')).toMatchObject({ status: 'prepared-local', coordinatorNotified: false });
    expect(new ConversationGraphDelegationSource(source).readCaptured('spawn-worker-session')).not.toBeNull();
    parentOwnershipEpoch++;
    expect(await runtime.afterSuccessfulSpawn(token, 'worker-session')).toMatchObject({ status: 'refused' });
  });
  it('replays original durable local capture after notification failure and holds changed actual ownership',async()=>{
    let calls=0;
    const unavailable=new ConversationGraphDelegationRuntime({source,verifiedHeadsFor:()=>[],parentProjectScope:()=>['instar'],tmuxPath:tmux,onPrepared:async()=>{throw new Error('outage');}});
    expect(await unavailable.afterSuccessfulSpawn(token,'worker-session')).toMatchObject({coordinatorNotified:false});
    const original=new ConversationGraphDelegationSource(source).readCaptured('spawn-worker-session');
    const restored=new ConversationGraphDelegationRuntime({source,verifiedHeadsFor:()=>[],parentProjectScope:()=>['instar'],tmuxPath:tmux,onPrepared:async value=>{calls++;expect(value.source).toEqual(original);}});
    await restored.replay();expect(calls).toBe(1);
    parentOwnershipEpoch++;await restored.replay();expect(calls).toBe(1);
    expect(new ConversationGraphDelegationSource(source).readCaptured('spawn-worker-session')).toEqual(original);
  });

});
