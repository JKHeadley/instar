/**
 * Tier-2 route-integration tests for spec #4 (intelligent-working-set-lazy-sync) — the
 * "feature is alive" HTTP surface. Built on the minimal createRoutes(ctx) harness (same
 * pattern as localhost-link-guard-route.test.ts). Proves:
 *  - POST /coherence/working-set/record records an interactive artifact (pendingHash),
 *    rejects an unsafe relPath (400), excludes a conflict artifact (.from-*), and 503s when
 *    the manager is unwired (feature dark).
 *  - GET /coherence/working-set?topic=N reflects the recorded rows + their states.
 *  - GET /coherence/working-set/session-context?topic=N returns present:false until a row is
 *    READY, then the advisory <replicated-untrusted-data> grounding block.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { WorkingSetArtifactManager } from '../../src/core/WorkingSetArtifactManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOKEN = 't';

describe('working-set artifact routes — record / read / grounding', () => {
  let server: { url: string; close: () => Promise<void> };
  let stateDir: string;
  let manager: WorkingSetArtifactManager | null;

  async function boot(withManager: boolean) {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-art-route-'));
    manager = withManager ? new WorkingSetArtifactManager(stateDir) : null;
    const ctx: any = {
      config: { authToken: TOKEN, stateDir, port: 0 },
      stateDir,
      meshSelfId: 'm-A',
      workingSetArtifactManager: manager,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });
  }

  afterEach(async () => {
    if (server) await server.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/working-set-artifact-route.test.ts' });
  });

  const post = (body: unknown) =>
    fetch(`${server.url}/coherence/working-set/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
  const getRows = (topic: number | string) =>
    fetch(`${server.url}/coherence/working-set?topic=${topic}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const getCtxBlock = (topic: number | string) =>
    fetch(`${server.url}/coherence/working-set/session-context?topic=${topic}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

  describe('when the manager is unwired (feature dark)', () => {
    beforeEach(() => boot(false));
    it('503s on record, read, and grounding', async () => {
      expect((await post({ topicId: 1, relPath: 'reports/x.md' })).status).toBe(503);
      expect((await getRows(1)).status).toBe(503);
      expect((await getCtxBlock(1)).status).toBe(503);
    });
  });

  describe('when the manager is wired', () => {
    beforeEach(() => boot(true));

    it('records a valid interactive artifact (pendingHash) and reflects it in the read', async () => {
      const r = await post({ topicId: 42, relPath: 'reports/interactive.md' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ recorded: true });

      const rows = await (await getRows(42)).json();
      expect(rows.count).toBe(1);
      expect(rows.rows[0]).toMatchObject({ relPath: 'reports/interactive.md', state: 'pendingHash', fetchNominee: false, producerMachineId: 'm-A' });
      expect(rows.readyCount).toBe(0);
    });

    it('rejects an unsafe relPath (400) and never lands a jail-escape path', async () => {
      expect((await post({ topicId: 42, relPath: '/etc/passwd' })).status).toBe(400);
      expect((await post({ topicId: 42, relPath: '../escape.md' })).status).toBe(400);
      expect((await post({ topicId: 42, relPath: 'a\0b' })).status).toBe(400);
      expect((await (await getRows(42)).json()).count).toBe(0);
    });

    it('requires a numeric topicId', async () => {
      expect((await post({ relPath: 'reports/x.md' })).status).toBe(400);
      expect((await getRows('not-a-number')).status).toBe(400);
    });

    it('excludes a conflict artifact (.from-<machine>-<hash8>) without recording it', async () => {
      const r = await post({ topicId: 7, relPath: 'reports/analysis.from-mini-deadbeef.md' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ recorded: false, reason: 'conflict-artifact-excluded' });
      expect((await (await getRows(7)).json()).count).toBe(0);
    });

    it('grounding is present:false until a row is READY, then returns the advisory enveloped block', async () => {
      await post({ topicId: 99, relPath: 'reports/report.md' });
      // pendingHash ⇒ not a fetch-nominee ⇒ no grounding block
      expect(await (await getCtxBlock(99)).json()).toEqual({ present: false });

      // Transition to ready via the manager (the serve-boundary hash authority in prod).
      manager!.setState(99, 'reports/report.md', 'm-A', 'ready', 'deadbeef');
      const ctxBlock = await (await getCtxBlock(99)).json();
      expect(ctxBlock.present).toBe(true);
      expect(ctxBlock.block).toContain('replicated-untrusted-data source="working-set-artifacts"');
      expect(ctxBlock.block).toContain('reports/report.md');
      expect(ctxBlock.block).toContain('ADVISORY');
    });

    it('neutralizes markup in a filename in the grounding block (untrusted-data defense)', async () => {
      const evil = 'reports/<script>evil.md';
      manager!.record({ topicId: 5, relPath: evil, producerMachineId: 'm-A', state: 'ready', contentHash: 'aa' });
      const ctxBlock = await (await getCtxBlock(5)).json();
      expect(ctxBlock.present).toBe(true);
      // angle brackets stripped — the filename can't break the envelope or inject markup
      expect(ctxBlock.block).not.toContain('<script>');
      expect(ctxBlock.block).toContain('scriptevil.md');
    });
  });
});
