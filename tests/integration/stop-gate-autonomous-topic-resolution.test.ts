/**
 * Integration test — GAP-B (autonomous-run-registration-guarantee) PR1.
 *
 * Drives the stop-gate hot-path HTTP route through the FULL server-side
 * topic-resolution chain: Claude sessionId(UUID) → tmux name (via a stubbed
 * SessionManager record) → topicId (via topic-session-registry.json
 * inversion) → per-topic autonomous-state file. Asserts the correct
 * `autonomousActive` verdict for each path variant in the D1 precedence
 * chain AND the no-silent-fallback unresolved-topic case (D2).
 *
 * Mirrors the production handler in src/server/routes.ts
 * (/internal/stop-gate/hot-path + resolveTopicForStopGate) WITHOUT spinning
 * up the full AgentServer — the harness pattern used by
 * tests/unit/routes-stopGate.test.ts, extended with the registry +
 * SessionManager stub the production callsite depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getHotPathState,
  resolveTopicForTmux,
  _resetForTests,
} from '../../src/server/stopGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface FakeSession {
  tmuxSession: string;
  claudeSessionId?: string;
}

/**
 * Build an Express app whose /internal/stop-gate/hot-path handler is a
 * faithful copy of the production wiring: it resolves topic from the Claude
 * sessionId via a (stubbed) running-session list + the on-disk registry,
 * then asks getHotPathState to read the D1 precedence chain rooted at the
 * provided agent home.
 */
function buildApp(opts: {
  stateRoot: string; // agent home (contains .instar/ and .claude/)
  runningSessions: FakeSession[];
}): { server: Server; port: number } {
  const stateDir = path.join(opts.stateRoot, '.instar');
  const registryPath = path.join(stateDir, 'topic-session-registry.json');

  const resolveTopicForStopGate = (sessionId: string): string | undefined => {
    if (!sessionId) return undefined;
    let tmuxSession: string | null = null;
    try {
      const match = opts.runningSessions.find((s) => s.claudeSessionId === sessionId);
      tmuxSession = match?.tmuxSession ?? null;
    } catch {
      tmuxSession = null;
    }
    if (!tmuxSession) return undefined;
    return resolveTopicForTmux(registryPath, tmuxSession) ?? undefined;
  };

  const app = express();
  app.use(express.json());
  const router = Router();
  router.get('/internal/stop-gate/hot-path', (req, res) => {
    const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
    const state = getHotPathState({
      sessionId: sessionId || undefined,
      topicId: resolveTopicForStopGate(sessionId),
      stateRoot: opts.stateRoot,
      recoveryScriptPath: '/no/such/path/for/test',
    });
    res.json(state);
  });
  app.use(router);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe('integration: stop-gate hot-path autonomous topic resolution (GAP-B PR1)', () => {
  let root: string;
  let handle: { server: Server; port: number } | null = null;

  const CLAUDE_UUID = '11111111-2222-3333-4444-555555555555';
  const TMUX = 'echo-autonomous-mode';
  const TOPIC = '6931';

  const writeRegistry = () => {
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'topic-session-registry.json'),
      JSON.stringify({ topicToSession: { [TOPIC]: TMUX, '12143': 'echo-other' } }),
    );
  };
  const writePerTopic = () => {
    const dir = path.join(root, '.instar', 'autonomous');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${TOPIC}.local.md`), 'active: true\n');
  };
  const writeLegacyInstar = () => {
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(root, '.instar', 'autonomous-state.local.md'), 'active: true\n');
  };
  const writeLegacyClaude = () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'autonomous-state.local.md'), 'active: true\n');
  };

  const fetchActive = async (sessionId: string): Promise<boolean> => {
    const res = await fetch(
      `http://127.0.0.1:${handle!.port}/internal/stop-gate/hot-path?session=${encodeURIComponent(sessionId)}`,
    );
    expect(res.status).toBe(200);
    return (await res.json()).autonomousActive as boolean;
  };

  beforeEach(() => {
    _resetForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gapb-int-'));
    writeRegistry();
  });
  afterEach(() => {
    if (handle) handle.server.close();
    handle = null;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/stop-gate-autonomous-topic-resolution.test.ts' });
  });

  it('resolves UUID→tmux→topic and reads the per-topic registration (canonical path)', async () => {
    writePerTopic();
    handle = buildApp({ stateRoot: root, runningSessions: [{ tmuxSession: TMUX, claudeSessionId: CLAUDE_UUID }] });
    expect(await fetchActive(CLAUDE_UUID)).toBe(true);
  });

  it('per-topic ABSENT but .instar legacy present → active (D1 fallthrough)', async () => {
    writeLegacyInstar();
    handle = buildApp({ stateRoot: root, runningSessions: [{ tmuxSession: TMUX, claudeSessionId: CLAUDE_UUID }] });
    expect(await fetchActive(CLAUDE_UUID)).toBe(true);
  });

  it('only the oldest .claude legacy present → active (D1 fallthrough)', async () => {
    writeLegacyClaude();
    handle = buildApp({ stateRoot: root, runningSessions: [{ tmuxSession: TMUX, claudeSessionId: CLAUDE_UUID }] });
    expect(await fetchActive(CLAUDE_UUID)).toBe(true);
  });

  it('no registration anywhere → inactive', async () => {
    handle = buildApp({ stateRoot: root, runningSessions: [{ tmuxSession: TMUX, claudeSessionId: CLAUDE_UUID }] });
    expect(await fetchActive(CLAUDE_UUID)).toBe(false);
  });

  it('UNRESOLVED topic (no session record) + legacy file → does NOT silently return false', async () => {
    // The no-silent-fallback boundary, end-to-end: the sessionId maps to no
    // running session, so topic resolution misses — but a legacy
    // registration exists and MUST still surface as active.
    writeLegacyInstar();
    handle = buildApp({ stateRoot: root, runningSessions: [] }); // empty → UUID won't resolve
    expect(await fetchActive(CLAUDE_UUID)).toBe(true);
  });

  it('UNRESOLVED topic (session has no tmux match in registry) + per-topic file for a DIFFERENT topic → inactive', async () => {
    // Session resolves to a tmux name absent from the registry → topic miss.
    // The per-topic file is for TOPIC (6931), but this session is not 6931,
    // and there is no legacy file → correctly inactive (no false positive).
    writePerTopic();
    handle = buildApp({
      stateRoot: root,
      runningSessions: [{ tmuxSession: 'echo-unregistered-tmux', claudeSessionId: CLAUDE_UUID }],
    });
    expect(await fetchActive(CLAUDE_UUID)).toBe(false);
  });

  it('UNRESOLVED topic + no legacy file → inactive (genuinely-inactive case)', async () => {
    handle = buildApp({ stateRoot: root, runningSessions: [] });
    expect(await fetchActive(CLAUDE_UUID)).toBe(false);
  });
});
