/** Real factory + real HTTP lifecycle, with owned fake-CLI admission state. */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';
import { getHostSpawnSemaphore, _resetHostSpawnSemaphoreForTest } from '../../src/core/hostSpawnSemaphore.js';
import { RateLimitError, LlmCircuitOpenError, __resetLlmCircuitBreakerSingleton } from '../../src/core/LlmCircuitBreaker.js';
import { clearClaudeForbidden } from '../../src/core/claudeForbiddenGuard.js';
import { createMockSessionManager } from '../helpers/setup.js';

let dir: string;
let server: AgentServer;
let fakeClaude: string;
let counter: string;
const token = 'owned-circuit-breaker-lifecycle';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cb-alive-'));
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  _resetHostSpawnSemaphoreForTest();
  __resetLlmCircuitBreakerSingleton();
  clearClaudeForbidden();
  const stateDir = path.join(dir, '.instar');
  for (const sub of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
  counter = path.join(dir, 'spawns');
  fakeClaude = path.join(dir, 'fake-claude');
  fs.writeFileSync(fakeClaude, `#!/bin/sh\nprintf 'x' >> "${counter}"\necho "Claude AI usage limit reached. Your limit will reset later." >&2\nexit 1\n`, { mode: 0o755 });
  server = new AgentServer({
    config: { agentName: 'owned-circuit-breaker', projectDir: dir, stateDir, claudePath: fakeClaude, authToken: token },
    stateManager: new StateManager(stateDir),
    sessionManager: createMockSessionManager() as any,
  });
});

afterEach(async () => {
  try { await server?.stop(); }
  finally {
    _resetHostSpawnSemaphoreForTest();
    __resetLlmCircuitBreakerSingleton();
    vi.restoreAllMocks();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'circuit-breaker-alive:owned-cleanup' });
  }
});

describe('circuit breaker admission — production factory and server lifecycle', () => {
  it('keeps the limiter alive and releases owned admission after rate-limit while the shared breaker prevents a second spawn', async () => {
    const app = server.getApp();
    const before = await request(app).get('/spawn-limiter').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(before.body.cap).toBe(getHostSpawnSemaphore().getCap());
    expect(before.body.liveHolders).toBe(0);
    expect(getHostSpawnSemaphore().status().holdersPath).toBe(path.join(dir, '.instar', 'host-spawn-holders.json'));

    const first = buildIntelligenceProvider({ framework: 'claude-code', binaryPath: fakeClaude })!;
    const second = buildIntelligenceProvider({ framework: 'claude-code', binaryPath: fakeClaude })!;
    await expect(first.evaluate('owned fake rate-limit')).rejects.toBeInstanceOf(RateLimitError);
    await expect(second.evaluate('must not spawn')).rejects.toBeInstanceOf(LlmCircuitOpenError);
    expect(fs.readFileSync(counter, 'utf8')).toBe('x');

    const after = await request(app).get('/spawn-limiter').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.liveHolders).toBe(0);
    expect(after.body.cap).toBe(before.body.cap);
  });
});
