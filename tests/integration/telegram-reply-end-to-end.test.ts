// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Layer 2 integration test — telegram-reply.sh ↔ /events/delivery-failed
 * end-to-end.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 2.
 *
 * What this test asserts (NO MOCKS for the substrate layer):
 *   1. A real Express app on an ephemeral port mounts the auth middleware
 *      AND the /events/delivery-failed route exactly as the production
 *      AgentServer does.
 *   2. The deployed telegram-reply.sh template, fed a 503 from
 *      /telegram/reply, writes a row to the per-agent SQLite queue.
 *   3. The script then POSTs the structured failure event to the SAME
 *      port (cross-tenant safety per spec § 2c) with both Authorization
 *      and X-Instar-AgentId headers.
 *   4. The endpoint validates auth, accepts the event, and emits it to
 *      the in-process listener.
 *
 * This is the bug-fix evidence test for Layer 2.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { authMiddleware } from '../../src/server/middleware.js';
import { createDeliveryFailedHandler } from '../../src/server/routes.js';

const TEMPLATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/templates/scripts/telegram-reply.sh',
);

interface ServerHandle {
  port: number;
  events: Array<Record<string, unknown>>;
  replyHits: Array<{ agentIdHeader: string | undefined; authHeader: string | undefined }>;
  close: () => Promise<void>;
}

function buildServer(opts: {
  agentId: string;
  authToken: string;
  replyStatus: number;
  replyBody: string;
}): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use(authMiddleware(opts.authToken, opts.agentId));

    const events: Array<Record<string, unknown>> = [];
    const replyHits: Array<{ agentIdHeader: string | undefined; authHeader: string | undefined }> = [];

    // Stand-in for /telegram/reply. The real handler runs the tone gate +
    // Telegram API; we just want to force-return a chosen status so the
    // script enters the recoverable-class path. Auth middleware above
    // governs the real auth check.
    app.post('/telegram/reply/:topicId', (req, res) => {
      replyHits.push({
        agentIdHeader: req.header('x-instar-agentid'),
        authHeader: req.header('authorization'),
      });
      res.status(opts.replyStatus).type('application/json').send(opts.replyBody);
    });

    app.post(
      '/events/delivery-failed',
      createDeliveryFailedHandler({
        agentId: opts.agentId,
        emit: (event) => {
          events.push(event);
        },
      }),
    );

    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) throw new Error('no addr');
      resolve({
        port: addr.port,
        events,
        replyHits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let projectDir: string;

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reply-e2e-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude', 'scripts'), { recursive: true });
  const dest = path.join(projectDir, '.claude', 'scripts', 'telegram-reply.sh');
  fs.copyFileSync(TEMPLATE_PATH, dest);
  fs.chmodSync(dest, 0o755);
});

afterAll(() => {
  try {
    fs.rmSync(projectDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('telegram-reply.sh ↔ /events/delivery-failed end-to-end', () => {
  it('on a 503 the script enqueues SQLite + posts to /events/delivery-failed with full auth', async () => {
    const server = await buildServer({
      agentId: 'echo',
      authToken: 'tok-secret',
      replyStatus: 503,
      replyBody: JSON.stringify({ error: 'upstream' }),
    });

    fs.writeFileSync(
      path.join(projectDir, '.instar', 'config.json'),
      JSON.stringify({
        port: server.port,
        projectName: 'echo',
        authToken: 'tok-secret',
      }),
    );

    // Spawn async — must not block the event loop, since the in-process
    // Express app dispatches request handlers on the same loop.
    const exit = await new Promise<number>((resolve) => {
      const child = spawn(
        'bash',
        [path.join(projectDir, '.claude', 'scripts', 'telegram-reply.sh'), '50', 'a recoverable message'],
        {
          cwd: projectDir,
          env: { ...process.env, INSTAR_PORT: '' },
        },
      );
      child.stdout.on('data', () => {/* swallow */});
      child.stderr.on('data', () => {/* swallow */});
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

    await server.close();

    // 1. Script exits 1 (recoverable failure visible to the agent).
    expect(exit).toBe(1);

    // 2. The /telegram/reply hit carried both auth headers.
    expect(server.replyHits.length).toBeGreaterThanOrEqual(1);
    expect(server.replyHits[0].authHeader).toBe('Bearer tok-secret');
    expect(server.replyHits[0].agentIdHeader).toBe('echo');

    // 3. The SQLite row was written to the per-agent queue.
    const dbPath = path.join(projectDir, '.instar', 'state', 'pending-relay.echo.sqlite');
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT * FROM entries').all() as Array<{
        delivery_id: string;
        topic_id: number;
        http_code: number;
        attempted_port: number;
        state: string;
        text: Buffer;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0].topic_id).toBe(50);
      expect(rows[0].http_code).toBe(503);
      expect(rows[0].attempted_port).toBe(server.port);
      expect(rows[0].state).toBe('queued');
      expect(Buffer.from(rows[0].text).toString('utf-8')).toBe('a recoverable message');
    } finally {
      db.close();
    }

    // 4. The /events/delivery-failed listener saw a delivery_failed event
    // matching the SQLite row.
    expect(server.events.length).toBe(1);
    const ev = server.events[0];
    expect(ev.type).toBe('delivery_failed');
    expect(ev.agentId).toBe('echo');
    expect(ev.topic_id).toBe(50);
    expect(ev.http_code).toBe(503);
    expect(ev.attempted_port).toBe(server.port);
  }, 30_000);
});
