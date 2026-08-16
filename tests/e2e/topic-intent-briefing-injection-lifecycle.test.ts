/**
 * E2E lifecycle (Tier 3) for the briefing-injection fix.
 *
 * The migrator installs telegram-topic-context.sh into a throwaway agent
 * dir; we boot a local Express server that mounts topicIntentRoutes AND a
 * stub /telegram/topics/:id/messages route, point the installed hook at
 * it via a per-invocation CLAUDE_PROJECT_DIR + config.json (port +
 * authToken), exec the hook with a [telegram:N] prompt on stdin, and
 * assert the hook's stdout contains the rendered topic-intent briefing
 * block AND the recent-messages block. Both surfaces preserved.
 *
 * Spec: docs/specs/topic-intent-briefing-injection.md (FAIL-mac-lan-001).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import express from 'express';
import type { Server } from 'node:http';
import {
  TopicIntentStore,
  buildEvent,
} from '../../src/core/TopicIntent.js';
import { createTopicIntentRoutes } from '../../src/server/topicIntentRoutes.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOPIC = 7777;
const SETTLED_REF = 'ref-mini-configured';
const SETTLED_TEXT =
  'The mac-mini is already configured and SSH-reachable; cross-machine work starts there.';
const AUTH_TOKEN = 'test-token-briefing-injection-e2e';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runMigrateHooks(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateHooks(r: MigrationResult): void }).migrateHooks(result);
  return result;
}

describe('E2E: telegram-topic-context hook injects topic-intent briefing', () => {
  let projectDir: string;
  let installedHookPath: string;
  let server: Server;
  let port = 0;
  let store: TopicIntentStore;
  let stateDir: string;

  beforeAll(async () => {
    // Boot Express with topicIntentRoutes + a stubbed messages endpoint
    // mirroring the live server's shape.
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-briefing-injection-e2e-state-'));
    store = new TopicIntentStore(stateDir);

    // Seed the SETTLED ref (extract-user + user-affirm → authoritative).
    store.appendEvidence(
      TOPIC,
      SETTLED_REF,
      buildEvent(SETTLED_REF, 'extract-user', 'seed-1'),
      { text: SETTLED_TEXT, kind: 'fact' },
    );
    store.appendEvidence(
      TOPIC,
      SETTLED_REF,
      buildEvent(SETTLED_REF, 'user-affirm', 'seed-2'),
    );

    const app = express();
    app.use(express.json());
    // Health (the hook checks this first; expects HTTP 200)
    app.get('/health', (_req, res) => {
      res.status(200).json({ status: 'ok' });
    });
    // Topic-intent routes (the new briefing-fetch path)
    app.use(createTopicIntentRoutes({ topicIntentStore: store }));
    // Stub the recent-messages endpoint that the hook also calls so we can
    // assert both surfaces in the hook's combined stdout.
    app.get('/telegram/topics/:topicId/messages', (req, res) => {
      const tid = Number(req.params.topicId);
      if (tid !== TOPIC) {
        res.json({ messages: [] });
        return;
      }
      res.json({
        messages: [
          {
            timestamp: '2026-05-28T20:00:00Z',
            fromUser: true,
            text: 'Quick check on the cross-machine plan.',
          },
        ],
      });
    });
    server = app.listen(0);
    await new Promise<void>(resolve => server.on('listening', resolve));
    const addr = server.address();
    if (addr && typeof addr === 'object') port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try {
      SafeFsExecutor.safeRmSync(stateDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/topic-intent-briefing-injection-lifecycle.test.ts',
      });
    } catch {
      /* best-effort */
    }
  });

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-briefing-injection-e2e-proj-'));
    // Install the canonical hook via the migrator (production install path).
    fs.mkdirSync(path.join(projectDir, '.instar', 'hooks', 'instar'), { recursive: true });
    // Compact JSON — the hook's port-grep does NOT tolerate whitespace
    // after `"port":`, mirroring the actual on-disk config format.
    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({ port, authToken: AUTH_TOKEN }),
    );
    const migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port,
      hasTelegram: false,
      projectName: 'briefing-injection-e2e',
    });
    runMigrateHooks(migrator);
    installedHookPath = path.join(
      projectDir,
      '.instar',
      'hooks',
      'instar',
      'telegram-topic-context.sh',
    );
    expect(fs.existsSync(installedHookPath)).toBe(true);
  });

  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(projectDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/topic-intent-briefing-injection-lifecycle.test.ts (proj)',
      });
    } catch {
      /* best-effort */
    }
  });

  it('the feature is alive: hook exits 0 and writes context to stdout', () => {
    const promptJson = JSON.stringify({ prompt: `[telegram:${TOPIC}] hello there` });
    const out = execSync(`bash ${installedHookPath}`, {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: promptJson,
      encoding: 'utf-8',
    });
    expect(out.length).toBeGreaterThan(0);
  });

  it('hook stdout contains the topic-intent briefing block when refs exist', () => {
    const promptJson = JSON.stringify({ prompt: `[telegram:${TOPIC}] checking in` });
    const out = execSync(`bash ${installedHookPath}`, {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: promptJson,
      encoding: 'utf-8',
    });
    // The briefing rendering uses this header per TopicIntentBriefing.ts.
    expect(out).toContain(`TOPIC ${TOPIC} INTENT BRIEFING`);
    // And it surfaces the SETTLED ref so the agent sees it.
    expect(out).toContain('mac-mini is already configured');
  });

  it('hook stdout ALSO contains the recent-messages block (no regression)', () => {
    const promptJson = JSON.stringify({ prompt: `[telegram:${TOPIC}] checking in` });
    const out = execSync(`bash ${installedHookPath}`, {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: promptJson,
      encoding: 'utf-8',
    });
    expect(out).toContain(`TOPIC ${TOPIC} RECENT HISTORY`);
    expect(out).toContain('cross-machine plan');
  });

  it('emits current wall-clock time even when no [telegram:N] prefix is present', () => {
    const promptJson = JSON.stringify({ prompt: 'just thinking out loud' });
    const out = execSync(`bash ${installedHookPath}`, {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: promptJson,
      encoding: 'utf-8',
    });
    expect(out).toContain('--- CURRENT TIME ---');
    // No topic-intent block when no topic in the prompt.
    expect(out).not.toContain('TOPIC INTENT BRIEFING');
  });

  it('degrades open when the briefing route returns empty (e.g. nothing tracked yet)', () => {
    // A second topic with no refs at all — the briefing endpoint returns empty.
    const promptJson = JSON.stringify({ prompt: `[telegram:99999] hello` });
    const out = execSync(`bash ${installedHookPath}`, {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      input: promptJson,
      encoding: 'utf-8',
    });
    // No briefing block (silently skipped), but the recent-messages and
    // time blocks still emit (recent will be empty here, but no crash).
    expect(out).toContain('--- CURRENT TIME ---');
    expect(out).not.toContain('INTENT BRIEFING');
  });
});
