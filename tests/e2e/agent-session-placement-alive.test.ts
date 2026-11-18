/**
 * Tier-3 "feature is alive" E2E for agent-sessions-placed-by-load Step 1: through the REAL
 * AgentServer stack (auth middleware, real SessionManager/StateManager, real
 * MachinePoolRegistry), a development agent's router wires the placement service (not
 * null), registers it for the pool tick, writes the shadow row for an agent-started spawn,
 * and answers an opt-in spawn with a placement outcome, not a 503. Also checks the
 * awareness entry and the dev-gate registration that reach every agent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import { AgentSessionPlacementService, getActiveAgentSessionPlacement, setActiveAgentSessionPlacement } from '../../src/core/agentSessionPlacement.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { COHERENCE_MANIFEST_EXCLUSIONS } from '../../src/core/machineCoherenceManifest.js';
import { JOURNAL_KINDS } from '../../src/core/CoherenceJournal.js';

const GIB = 1024 ** 3;
function report(cores: number, loadPerCore: number, verdict: MachineLoadReport['verdict'] = 'ok'): MachineLoadReport {
  return {
    bootId: 'boot', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores, totalMemBytes: 64 * GIB, loadPerCore,
    cpuIdlePct: 40, memAvailablePct: 40, memPressureNative: 'normal', eventLoopLagP99Ms: 5, sessionsActive: 1, sessionsMax: 25,
    spawnCapSaturated: false, testRunnerSaturated: false, verdict, uptimeS: 1000,
  };
}

describe('E2E: agent-session placement is ALIVE through the real AgentServer', () => {
  const TOKEN = 'e2e-token';
  let dir: string;
  let server: AgentServer;
  let base: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-alive-e2e-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    const stateDir = path.join(dir, '.instar');
    const registry = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm_studio', nickname: 'Mac Studio' }, { machineId: 'm_m5', nickname: 'Mac M5 Pro' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    const beat = (machineId: string, r: MachineLoadReport) =>
      registry.recordHeartbeat({ machineId, selfReportedLastSeen: new Date().toISOString(), loadAvg: r.loadPerCore! * r.cores!, loadReport: r } as never);
    beat('m_studio', report(16, 1.6, 'saturated'));
    beat('m_m5', report(18, 0.3));
    const config = { projectName: 'asp-alive-e2e', projectDir: dir, stateDir, port: 0, authToken: TOKEN, developmentAgent: true } as unknown as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: 0 }),
      state: new StateManager(stateDir),
      machinePoolRegistry: registry,
      meshSelfId: 'm_studio',
      // No address for the peer: an opt-in spawn decides, sends nothing, and starts here.
      resolvePeerUrls: () => [],
      // Placement Step 2: topic 4242 is owned by the peer; every other topic is unowned.
      sessionOwnershipRegistry: {
        read: (k: string) => (k === '4242' ? { status: 'active', ownerMachineId: 'm_m5', ownershipEpoch: 3 } : null),
        ownerOf: (k: string) => (k === '4242' ? 'm_m5' : null),
      },
    } as never);
    await server.start();
    base = boundAgentServerBase(server);
  }, 20000);

  afterAll(async () => {
    await server?.stop();
    setActiveAgentSessionPlacement(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/agent-session-placement-alive.test.ts' });
  });

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('the production router wires a real placement service and registers it for the pool tick', () => {
    const svc = getActiveAgentSessionPlacement();
    expect(svc).toBeInstanceOf(AgentSessionPlacementService);
    expect(typeof svc!.tick).toBe('function');
    expect(typeof svc!.deps.readPeerSessions).toBe('function');
  });

  it('POST /sessions/spawn with placement:"auto" is ALIVE: it decides the peer, finds no address, and answers with a placement outcome (not 503)', async () => {
    const res = await fetch(`${base}/sessions/spawn`, {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'asp-alive-helper', prompt: 'echo hi', placement: 'auto' }),
    });
    expect(res.status).not.toBe(503);
    const body = await res.json();
    // The decision picked the peer; with no address nothing was sent, so it fell back here.
    // The local start itself may succeed (201) or fail on a host without tmux; either way the
    // placement layer ran, and the shadow row below proves it.
    if (res.status === 201) expect(body).toMatchObject({ placementOutcome: 'local-fallback', placementReason: 'target-unreachable' });
    const log = fs.readFileSync(path.join(dir, 'logs', 'agent-session-placement.jsonl'), 'utf8');
    expect(log).toContain('"name":"asp-alive-helper"');
    expect(log).toContain('"wouldPlaceOn":"m_m5"');
    expect(log).not.toContain('echo hi');
  });

  it('a bad placement value is refused by the real route (400)', async () => {
    const res = await fetch(`${base}/sessions/spawn`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'x', prompt: 'p', placement: 'all' }) });
    expect(res.status).toBe(400);
  });

  it('Step 2 (topicBound, dev-gated live here): a topic-bound spawn into a peer-owned topic is ALIVE and answers 409 topic-owned-elsewhere', async () => {
    const res = await fetch(`${base}/sessions/spawn`, {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'asp-topic-owned', prompt: 'p', topicId: 4242 }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ placementOutcome: 'topic-owned-elsewhere', owner: { machineId: 'm_m5' }, topicId: 4242 });
  });

  it('Step 2: a topic spawn with placement:"auto" on a machine without the pool lease runs the topic path and stays local (not-router), with its ownership state logged', async () => {
    const res = await fetch(`${base}/sessions/spawn`, {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'asp-topic-auto', prompt: 'echo hi', topicId: 5151, placement: 'auto' }),
    });
    expect(res.status).not.toBe(503);
    if (res.status === 201) expect(await res.json()).toMatchObject({ placementOutcome: 'local', placementReason: 'not-router' });
    const rows = fs.readFileSync(path.join(dir, 'logs', 'agent-session-placement.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.find((r: Record<string, unknown>) => r.name === 'asp-topic-auto')).toMatchObject({ topicBound: true, topicId: 5151, topicOwnership: 'none', outcome: 'local', why: 'not-router' });
  });

  it('Step 2 reaches every agent: dev-gated, coherence decision recorded, replicated kind registered, awareness entry', () => {
    expect(DEV_GATED_FEATURES.find((f) => f.configPath === 'multiMachine.placement.agentSessions.topicBound')).toBeTruthy();
    expect(COHERENCE_MANIFEST_EXCLUSIONS.find((e) => e.configPath === 'multiMachine.placement.agentSessions.topicBound')).toBeTruthy();
    expect(JOURNAL_KINDS).toContain('topic-spawn-brief');
    const entry = fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'awareness', 'agent-sessions-placed-by-load.md'), 'utf8');
    expect(entry).toContain('topic-owned-elsewhere');
    expect(entry).toContain('agent-brief@1');
  });

  it('reaches every agent: dev-gated (live here, dark on the fleet), coherence decision recorded, awareness entry present', () => {
    expect(DEV_GATED_FEATURES.find((f) => f.configPath === 'multiMachine.placement.agentSessions.enabled')).toBeTruthy();
    expect(COHERENCE_MANIFEST_EXCLUSIONS.find((e) => e.configPath === 'multiMachine.placement.agentSessions.enabled')).toBeTruthy();
    const entry = fs.readFileSync(path.join(process.cwd(), 'src', 'data', 'awareness', 'agent-sessions-placed-by-load.md'), 'utf8');
    expect(entry).toContain('"placement": "auto"');
    expect(entry).toContain('placed-on-peer');
  });
});
