import { expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { MachineIdentityManager, sign, verify } from '../../src/core/MachineIdentity.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { makeDevice } from '../helpers/mobileDevice.js';

it('production app chat records a real lease lapse while preserving its refusal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-serving-audit-'));
  let server: AgentServer | undefined;
  let coordinator: MultiMachineCoordinator | undefined;
  const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const stateDir = path.join(dir, '.instar');
    const state = new StateManager(stateDir);
    const idManager = new MachineIdentityManager(stateDir);
    const identity = await idManager.generateIdentity({ name: 'audit fixture' });
    const key = idManager.loadSigningKey();
    const publicKey = idManager.getSigningPublicKeyPem(identity.machineId);
    if (!publicKey) throw new Error('fixture signing public key unavailable');
    let clock = 1_000;
    const lease = new LeaseCoordinator({
      lease: new FencedLease({
        selfMachineId: identity.machineId,
        sign: (value) => sign(value, key),
        verify: (value, signature, holder) => holder === identity.machineId && verify(value, signature, publicKey),
      }, { leaseTtlMs: 60_000, failoverThresholdMs: 900_000 }),
      store: new LocalLeaseStore({ filePath: path.join(stateDir, 'serving-lease.json') }),
      presumedDeadHolders: () => new Set(), now: () => clock, monotonicNow: () => clock,
    });
    coordinator = new MultiMachineCoordinator(state, { stateDir });
    coordinator.start();
    coordinator.attachLeaseCoordinator(lease);
    expect(await lease.acquireIfEligible()).toBe(true);
    const config = {
      projectName: 'audit-fixture', projectDir: dir, stateDir, port: 0, authToken: 'test-auth', developmentAgent: true,
      mobilePairing: { multiRoute: { enabled: false } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5_000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {},
    } as unknown as InstarConfig;
    const telegram = Object.create(TelegramAdapter.prototype) as TelegramAdapter;
    Object.assign(telegram, { getOwnerUserId: () => 4242, getVerifiedOwner: () => 4242, createAttentionItem: async () => undefined });
    const sessionManager = createMockSessionManager() as any;
    sessionManager.on = () => undefined;
    server = new AgentServer({ config, sessionManager, state, initiativeTracker: new InitiativeTracker(stateDir), coordinator, telegram });
    const svc = server.mobilePairing!;
    expect(svc).not.toBeNull();
    expect(svc.deps.leaseFreshness!()).toMatchObject({ verdict: 'holding', ttlMs: 60_000 });
    // Change the real lease clock after construction: the production callback
    // must read live state, rather than a boot-time snapshot or no-op.
    clock += 60_001;
    expect(svc.holdsLease()).toBe(false);
    expect(svc.deps.leaseFreshness!()).toMatchObject({ verdict: 'renewal-lapsed', msSinceConfirmedRenewal: 60_001 });
    const dev = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'fixture phone', label: null, publicKey: dev.publicKey, host: 'audit.example.dev' });
    if (!created.ok) throw new Error('fixture device creation failed');
    svc.devices.applyConfirm(created.device.id, { ok: true });
    const route = '/mobile/chat/42';
    const raw = Buffer.from(JSON.stringify({ text: 'private-message', requestId: `${Date.now()}-${crypto.randomUUID()}` }));
    const time = String(Date.now());
    const signature = dev.sign(canonicalString(created.device.id, 'audit.example.dev', 'POST', route, time, raw));
    const response = await request(server.getApp()).post(route).set('Host', 'audit.example.dev').set('Content-Type', 'application/json')
      .set('X-Instar-Device', created.device.id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', signature).send(raw.toString());
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('not-serving');
    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('mobile-chat-not-serving'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ observedLeaseVerdict: 'renewal-lapsed', ttlMs: 60_000, msSinceConfirmedRenewal: 60_001 });
    expect(lines[0]).not.toContain('private-message');
    expect(lines[0]).not.toContain(created.device.id);
  } finally {
    await server?.stop();
    coordinator?.stop();
    log.mockRestore();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'mobile-chat-serving-audit-alive fixture teardown' });
  }
});
