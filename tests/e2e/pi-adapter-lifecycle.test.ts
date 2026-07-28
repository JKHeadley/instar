/**
 * E2E test — pi-cli adapter "feature is alive" lifecycle
 * (PI-HARNESS-INTEGRATION-SPEC §7; mirrors provider-substrate-live-wiring).
 *
 * Tests the PRODUCTION wiring shape from src/commands/server.ts:
 *   1. Boot: registerPiAdapters() exactly the way startServer calls it
 *      (enabledFrameworks/piPath/model/sessionDir from config).
 *   2. The "feature is alive" check: GET /providers/registry returns 200
 *      and lists pi-cli with its declared capabilities.
 *   3. The DARK default: without 'pi-cli' in enabledFrameworks, nothing
 *      registers — existing agents are byte-for-byte unaffected.
 *   4. The binary gate: enabled-but-missing binary skips with the
 *      doctor-visible reason, never a boot failure.
 *   5. Registration is lazy: no process spawns.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { Registry } from '../../src/providers/registry.js';
import { registry as defaultRegistry } from '../../src/providers/registry.js';
import { registerPiAdapters } from '../../src/providers/bootRegistration.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('pi-cli adapter lifecycle E2E', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-pi-adapter';
  // Any existing executable satisfies the binary gate — registration is lazy
  // (pure in-memory construction; nothing spawns until first use).
  const STUB_PI = '/bin/echo';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // PRODUCTION WIRING SHAPE (mirrors src/commands/server.ts): the dark
    // gate + binary path + model + sessionDir, registered against the
    // DEFAULT registry the HTTP route reads.
    const result = await registerPiAdapters({
      enabledFrameworks: ['claude-code', 'pi-cli'],
      piPath: STUB_PI,
      model: 'openai-codex/gpt-5.5',
      sessionDir: path.join(stateDir, 'state', 'pi-sessions'),
    });
    expect(result.skippedReason).toBeUndefined();
    expect([...result.registered, ...result.alreadyRegistered].map(String)).toContain('pi-cli');

    const config: InstarConfig = {
      projectName: 'e2e-pi',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.0.0-e2e',
      sessions: {
        projectName: 'e2e-pi',
        tmuxPath: '/usr/bin/true',
        claudePath: '/usr/bin/echo',
        projectDir: tmpDir,
        maxSessions: 3,
        enabledFrameworks: ['claude-code', 'pi-cli'],
        frameworkBinaryPaths: { 'pi-cli': STUB_PI },
        frameworkDefaultModels: { 'pi-cli': 'openai-codex/gpt-5.5' },
      } as InstarConfig['sessions'],
    } as InstarConfig;

    const state = new StateManager(stateDir);
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await defaultRegistry.unregister('pi-cli' as never).catch(() => { /* not registered */ });
    try {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/pi-adapter-lifecycle.test.ts:afterAll',
      });
    } catch { /* best-effort */ }
  });

  it('GET /providers/registry is ALIVE and lists pi-cli with its capabilities', async () => {
    const res = await request(app)
      .get('/providers/registry')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('pi-cli');
    expect(body).toContain('one-shot-completion');
    expect(body).toContain('agentic-session-rpc');
  });

  it('the registered adapter is the REAL one (capabilities declared = primitives wired)', () => {
    const adapter = defaultRegistry.get('pi-cli' as never);
    expect(adapter).toBeDefined();
    // Wiring integrity: every declared capability resolves to a non-null impl.
    for (const cap of adapter!.capabilities) {
      expect(adapter!.primitive(cap)).toBeTruthy();
    }
  });

  it('DARK DEFAULT: without pi-cli in enabledFrameworks nothing registers', async () => {
    const isolated = new Registry();
    const result = await registerPiAdapters({
      enabledFrameworks: ['claude-code'],
      piPath: STUB_PI,
      registryInstance: isolated,
    });
    expect(result.skippedReason).toBe('pi-not-enabled');
    expect(result.registered).toHaveLength(0);
  });

  it('BINARY GATE: enabled but missing binary skips with the visible reason (no boot failure)', async () => {
    const isolated = new Registry();
    const result = await registerPiAdapters({
      enabledFrameworks: ['pi-cli'],
      piPath: null,
      registryInstance: isolated,
    });
    // piPath null forces detection; if a real pi binary exists on this host
    // the gate legitimately passes — accept either outcome but require
    // coherence between them.
    if (result.skippedReason) {
      expect(result.skippedReason).toBe('pi-binary-missing');
      expect(result.registered).toHaveLength(0);
    } else {
      expect(result.registered.map(String)).toContain('pi-cli');
    }
  });

  it('idempotent re-registration reports alreadyRegistered (no duplicate, no throw)', async () => {
    const again = await registerPiAdapters({
      enabledFrameworks: ['pi-cli'],
      piPath: STUB_PI,
    });
    expect(again.alreadyRegistered.map(String)).toContain('pi-cli');
    expect(again.registered).toHaveLength(0);
  });
});
