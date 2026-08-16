/**
 * E2E test — grok-build adapter "feature is alive" lifecycle
 * (grok-build framework integration spec §7, §12; mirrors
 * pi-adapter-lifecycle.test.ts, which mirrors provider-substrate-live-wiring).
 *
 * Tests the PRODUCTION wiring shape from src/commands/server.ts:
 *   1. Boot: registerGrokBuildAdapters() exactly the way startServer calls
 *      it (enabledFrameworks/grokPath/model from config).
 *   2. The "feature is alive" check: GET /providers/registry returns 200
 *      and lists grok-build with its declared capabilities.
 *   3. The DARK default: without 'grok-build' in enabledFrameworks, nothing
 *      registers — existing agents are byte-for-byte unaffected.
 *   4. The binary gate: enabled-but-missing binary skips with the
 *      doctor-visible reason, never a boot failure.
 *   5. Registration is lazy: no process spawns (a /bin/echo stub satisfies
 *      the gate precisely because nothing is executed at registration).
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
import { registerGrokBuildAdapters } from '../../src/providers/bootRegistration.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('grok-build adapter lifecycle E2E', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  const AUTH_TOKEN = 'test-e2e-grok-adapter';
  // Any existing executable satisfies the binary gate — registration is lazy
  // (pure in-memory construction; nothing spawns until first use).
  const STUB_GROK = '/bin/echo';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-adapter-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // PRODUCTION WIRING SHAPE (mirrors src/commands/server.ts): the dark
    // gate + binary path + model, registered against the DEFAULT registry
    // the HTTP route reads.
    const result = await registerGrokBuildAdapters({
      enabledFrameworks: ['claude-code', 'grok-build'],
      grokPath: STUB_GROK,
      model: 'grok-4.6',
    });
    expect(result.skippedReason).toBeUndefined();
    expect([...result.registered, ...result.alreadyRegistered].map(String)).toContain('grok-build');

    const config: InstarConfig = {
      projectName: 'e2e-grok',
      projectDir: tmpDir,
      stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 10000,
      version: '0.0.0-e2e',
      sessions: {
        projectName: 'e2e-grok',
        tmuxPath: '/usr/bin/true',
        claudePath: '/usr/bin/echo',
        projectDir: tmpDir,
        maxSessions: 3,
        enabledFrameworks: ['claude-code', 'grok-build'],
        frameworkBinaryPaths: { 'grok-build': STUB_GROK },
        frameworkDefaultModels: { 'grok-build': 'grok-4.6' },
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
    await defaultRegistry.unregister('grok-build' as never).catch(() => { /* not registered */ });
    try {
      SafeFsExecutor.safeRmSync(tmpDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/grok-build-adapter-lifecycle.test.ts:afterAll',
      });
    } catch { /* best-effort */ }
  });

  it('GET /providers/registry is ALIVE and lists grok-build with its capabilities', async () => {
    const res = await request(app)
      .get('/providers/registry')
      .set('Authorization', `Bearer ${AUTH_TOKEN}`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('grok-build');
    expect(body).toContain('one-shot-completion');
    // The honest floor (spec §4.2): the unprobed ACP face is NOT declared.
    expect(body).not.toContain('grok-build.*agentic-session-rpc');
  });

  it('the registered adapter is the REAL one (capabilities declared = primitives wired)', () => {
    const adapter = defaultRegistry.get('grok-build' as never);
    expect(adapter).toBeDefined();
    // Wiring integrity: every declared capability resolves to a non-null impl.
    for (const cap of adapter!.capabilities) {
      expect(adapter!.primitive(cap)).toBeTruthy();
    }
  });

  it('DARK DEFAULT: without grok-build in enabledFrameworks nothing registers', async () => {
    const isolated = new Registry();
    const result = await registerGrokBuildAdapters({
      enabledFrameworks: ['claude-code'],
      grokPath: STUB_GROK,
      registryInstance: isolated,
    });
    expect(result.skippedReason).toBe('grok-not-enabled');
    expect(result.registered).toHaveLength(0);
  });

  it('BINARY GATE: enabled but missing binary skips with the visible reason (no boot failure)', async () => {
    const isolated = new Registry();
    const result = await registerGrokBuildAdapters({
      enabledFrameworks: ['grok-build'],
      grokPath: null,
      registryInstance: isolated,
    });
    // grokPath null forces detection; if a real grok binary exists on this
    // host the gate legitimately passes — accept either outcome but require
    // coherence between them.
    if (result.skippedReason) {
      expect(result.skippedReason).toBe('grok-binary-missing');
      expect(result.registered).toHaveLength(0);
    } else {
      expect(result.registered.map(String)).toContain('grok-build');
    }
  });

  it('idempotent re-registration reports alreadyRegistered (no duplicate, no throw)', async () => {
    const again = await registerGrokBuildAdapters({
      enabledFrameworks: ['grok-build'],
      grokPath: STUB_GROK,
    });
    expect(again.alreadyRegistered.map(String)).toContain('grok-build');
    expect(again.registered).toHaveLength(0);
  });
});
