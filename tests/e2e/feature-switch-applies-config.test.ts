// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" (spec feature-transition-applies-action §6):
 * the production AgentServer path, with the FeatureRegistry built the way
 * src/commands/server.ts builds it. A real operator (dashboard PIN unlock)
 * switches a real feature on; a real config.json key flips; the shown state
 * tells the truth; and a restart keeps the switch on instead of resetting it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';
import { FeatureRegistry } from '../../src/core/FeatureRegistry.js';
import { BUILTIN_FEATURES } from '../../src/core/FeatureDefinitions.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('feature switch applies config — E2E on the production init path', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let baseUrl: string;
  let registry: FeatureRegistry;
  let operatorProof = '';
  const AUTH = 'test-e2e-feature-switch';
  const PIN = '246810';
  const configPath = () => path.join(stateDir, 'config.json');
  const readConfig = () => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  const auth = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json', ...extra });

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-switch-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    // Publishing is default-on; start it explicitly OFF so switching it on is a real change.
    fs.writeFileSync(configPath(), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E', publishing: { enabled: false } }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, publishing: { enabled: false },
    } as unknown as InstarConfig;

    // As server.ts builds it: open, register the built-ins, bootstrap from config.
    registry = new FeatureRegistry(stateDir);
    await registry.open();
    for (const def of BUILTIN_FEATURES) registry.register(def);
    registry.bootstrap(config as unknown as Record<string, unknown>);

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      handshakeManager: new HandshakeManager(stateDir, 'e2e'),
      featureRegistry: registry,
    } as any);
    await server.start();
    const port = ((server as unknown as { server: { address(): { port: number } } }).server.address()).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    registry.close();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/feature-switch-applies-config.test.ts' });
  });

  it('the feature routes are alive (200, never 503) and already carry the honest state', async () => {
    const r = await fetch(`${baseUrl}/features/publishing-telegraph`, { headers: auth() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.effective).toMatchObject({ recorded: false, configured: false, atBoot: false, status: 'off' });
    const all = await (await fetch(`${baseUrl}/features`, { headers: auth() })).json();
    expect(all.features.length).toBe(BUILTIN_FEATURES.length);
    expect(all.features.every((f: { effective?: { status?: string } }) => typeof f.effective?.status === 'string')).toBe(true);
  });

  it('a real PIN unlock issues the operator proof', async () => {
    const r = await fetch(`${baseUrl}/dashboard/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
    expect(r.status).toBe(200);
    operatorProof = (await r.json()).operatorSessionToken;
    expect(operatorProof).toBeTruthy();
  });

  it('without the proof the agent path is unchanged: undiscovered → enabled is refused and config is untouched', async () => {
    const r = await fetch(`${baseUrl}/features/publishing-telegraph/transition`, { method: 'POST', headers: auth(), body: JSON.stringify({ to: 'enabled' }) });
    expect(r.status).toBe(422);
    expect(readConfig().publishing).toEqual({ enabled: false });
  });

  it("the operator's switch flips the real config key through the real PATCH /config, and the shown state says 'saved, after restart'", async () => {
    const r = await fetch(`${baseUrl}/features/publishing-telegraph/transition`, {
      method: 'POST', headers: auth({ 'X-Instar-Operator-Session': operatorProof }), body: JSON.stringify({ to: 'enabled' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.viaOperatorSwitch).toBe(true);
    expect(body.apply).toMatchObject({ direction: 'enable', outcome: 'applied', httpStatus: 200 });
    expect(readConfig().publishing).toEqual({ enabled: true });
    expect(body.effective).toMatchObject({ recorded: true, configured: true, atBoot: false, status: 'on-after-restart' });
    expect(body.effective.summary).not.toMatch(/running/i);
    // The event trail shows the apply beside the transition.
    const events = await (await fetch(`${baseUrl}/features/events?featureId=publishing-telegraph`, { headers: auth() })).json();
    expect(events.events.some((e: { context?: string }) => e.context === 'apply:applied')).toBe(true);
  });

  it('a restart (fresh registry bootstrapped from the saved config) keeps the switch ON — the old silent reset is gone', async () => {
    const again = new FeatureRegistry(stateDir);
    await again.open();
    for (const def of BUILTIN_FEATURES) again.register(def);
    again.bootstrap(readConfig());
    const st = again.getState('publishing-telegraph')!;
    expect(st.discoveryState).toBe('enabled');
    expect(st.enabled).toBe(true);
    expect(st.lastApply!.outcome).toBe('applied');
    expect(again.getEffectiveState('publishing-telegraph', 'default', again.readMergedConfig({}))!.status).toBe('on');
    again.close();
  });

  it('switching off applies too, and reads as "saved as off; may keep running until restart" only when it booted on', async () => {
    const r = await fetch(`${baseUrl}/features/publishing-telegraph/transition`, {
      method: 'POST', headers: auth({ 'X-Instar-Operator-Session': operatorProof }), body: JSON.stringify({ to: 'disabled' }),
    });
    const body = await r.json();
    expect(body.apply.outcome).toBe('applied');
    expect(readConfig().publishing).toEqual({ enabled: false });
    // This process booted with publishing OFF, so off is simply off.
    expect(body.effective).toMatchObject({ recorded: false, configured: false, atBoot: false, status: 'off' });
  });
});
