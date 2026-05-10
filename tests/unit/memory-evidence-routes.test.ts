/**
 * WikiClaim Phase 4 — Tests for the inverse-traceability HTTP endpoints.
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md § Phase 4
 * (line 343) + § Storage and Privacy (line 310). Real SQLite, no mocks —
 * the whole point is exercising the storage-layer viewer-scope filter.
 *
 * Endpoints under test:
 *   - GET /memory/evidence/by-entity/:id?viewerScope=...
 *   - GET /memory/entities/by-evidence?kind=...&sourceId=...&viewerScope=...
 *
 * Coverage:
 *   - by-entity returns viewer-scope filtered evidence
 *   - by-evidence works with kind+sourceId
 *   - auth required (401 without bearer)
 *   - 404 on unknown entity
 *   - 400 on missing/invalid query params
 *   - empty array on no-citations match
 *   - cross-product privacy: viewer at shared-project cannot see private-tier
 *     evidence in either endpoint (entity nor evidence row)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';
import type { MemoryEvidence } from '../../src/core/types.js';

const AUTH_TOKEN = 'test-token-abc-123';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

interface Setup {
  dir: string;
  memory: SemanticMemory;
  server: TestServer;
  cleanup: () => Promise<void>;
}

async function buildSetup(): Promise<Setup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-evidence-routes-test-'));
  const dbPath = path.join(dir, 'semantic.db');
  const memory = new SemanticMemory({
    dbPath,
    decayHalfLifeDays: 30,
    lessonDecayHalfLifeDays: 90,
    staleThreshold: 0.2,
  });
  await memory.open();

  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));

  const ctx: any = {
    config: { authToken: AUTH_TOKEN, stateDir: dir, port: 0 },
    semanticMemory: memory,
  };
  app.use(createRoutes(ctx));

  const server = await listen(app);
  return {
    dir,
    memory,
    server,
    cleanup: async () => {
      await server.close();
      memory.close();
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/memory-evidence-routes.test.ts',
      });
    },
  };
}

async function get(
  server: TestServer,
  url: string,
  opts: { auth?: boolean } = { auth: true },
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }
  const r = await fetch(server.url + url, { headers });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

const ev = (over: Partial<MemoryEvidence> = {}): MemoryEvidence => ({
  kind: 'feedback',
  sourceId: 'fb_default',
  updatedAt: '2026-05-09T00:00:00Z',
  weight: 0.7,
  confidence: 0.8,
  ...over,
});

describe('GET /memory/evidence/by-entity/:id', () => {
  let s: Setup;
  beforeEach(async () => { s = await buildSetup(); });
  afterEach(async () => { await s.cleanup(); });

  it('returns 401 without bearer token', async () => {
    const r = await get(s.server, '/memory/evidence/by-entity/whatever', { auth: false });
    expect(r.status).toBe(401);
  });

  it('returns 404 on unknown entity', async () => {
    const r = await get(s.server, '/memory/evidence/by-entity/does-not-exist');
    expect(r.status).toBe(404);
  });

  it('returns the entity evidence array, viewer-scope filtered', async () => {
    const id = s.memory.rememberWithEvidence(
      {
        type: 'pattern',
        name: 'route-test-pattern',
        content: 'phase4 route test',
        confidence: 0.9,
        lastVerified: '2026-05-09T00:00:00Z',
        source: 'cluster-builder',
        tags: ['phase4'],
        privacyScope: 'shared-project',
      },
      [
        ev({ sourceId: 'fb_a', privacyTier: 'shared-project' }),
        ev({ sourceId: 'fb_b', privacyTier: 'shared-project' }),
      ],
      'EvolutionManager',
    );

    const r = await get(s.server, `/memory/evidence/by-entity/${id}?viewerScope=shared-project`);
    expect(r.status).toBe(200);
    expect(r.body.entityId).toBe(id);
    expect(r.body.viewerScope).toBe('shared-project');
    expect(Array.isArray(r.body.evidence)).toBe(true);
    expect(r.body.evidence.length).toBe(2);
    const ids = r.body.evidence.map((e: any) => e.sourceId).sort();
    expect(ids).toEqual(['fb_a', 'fb_b']);
  });

  it('cross-product: viewer at shared-project cannot see private-tier evidence', async () => {
    const id = s.memory.rememberWithEvidence(
      {
        type: 'pattern',
        name: 'mixed-tier-entity',
        content: 'private evidence on a shared-project entity',
        confidence: 0.9,
        lastVerified: '2026-05-09T00:00:00Z',
        source: 'cluster-builder',
        tags: [],
        privacyScope: 'shared-project',
      },
      [
        ev({ sourceId: 'fb_shared', privacyTier: 'shared-project' }),
        ev({ sourceId: 'fb_private', privacyTier: 'private' }),
        ev({ sourceId: 'fb_sensitive', privacyTier: 'sensitive' }),
      ],
      'EvolutionManager',
    );

    // shared-project viewer: should see ONLY the shared-project tier, not
    // private or sensitive (the entity is shared-project but evidence rows
    // can be tagged narrower per spec narrowing-only constraint).
    const narrow = await get(s.server, `/memory/evidence/by-entity/${id}?viewerScope=shared-project`);
    expect(narrow.status).toBe(200);
    const narrowSourceIds = narrow.body.evidence.map((e: any) => e.sourceId).sort();
    expect(narrowSourceIds).toEqual(['fb_shared']);

    // private viewer: should see the shared-project + private rows; sensitive
    // is still narrower than private (`sensitive` is the most-restrictive
    // tier per EvidenceRenderer's ordering).
    const wide = await get(s.server, `/memory/evidence/by-entity/${id}?viewerScope=private`);
    expect(wide.status).toBe(200);
    const wideSourceIds = wide.body.evidence.map((e: any) => e.sourceId).sort();
    expect(wideSourceIds).toEqual(['fb_private', 'fb_shared']);
  });

  it('defaults viewerScope to private when query param is absent', async () => {
    const id = s.memory.rememberWithEvidence(
      {
        type: 'pattern',
        name: 'default-scope',
        content: 'default scope test',
        confidence: 0.9,
        lastVerified: '2026-05-09T00:00:00Z',
        source: 'cluster-builder',
        tags: [],
        privacyScope: 'private',
      },
      [ev({ sourceId: 'fb_priv', privacyTier: 'private' })],
      'EvolutionManager',
    );
    const r = await get(s.server, `/memory/evidence/by-entity/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.viewerScope).toBe('private');
    expect(r.body.evidence.length).toBe(1);
  });

  it('returns 404 (non-leaky) when a private entity is requested at shared-project scope', async () => {
    // Spec § Storage and Privacy line 316: inverse-query non-leak rule.
    // A direct fetch must not 200-empty when the entity exists but is
    // hidden from the viewer — that would leak existence by diffing.
    const id = s.memory.rememberWithEvidence(
      {
        type: 'pattern',
        name: 'private-only-entity',
        content: 'private payload',
        confidence: 0.9,
        lastVerified: '2026-05-09T00:00:00Z',
        source: 'cluster-builder',
        tags: [],
        privacyScope: 'private',
      },
      [ev({ sourceId: 'fb_hidden', privacyTier: 'private' })],
      'EvolutionManager',
    );
    const r = await get(s.server, `/memory/evidence/by-entity/${id}?viewerScope=shared-project`);
    expect(r.status).toBe(404);
  });
});

describe('GET /memory/entities/by-evidence', () => {
  let s: Setup;
  beforeEach(async () => { s = await buildSetup(); });
  afterEach(async () => { await s.cleanup(); });

  it('returns 401 without bearer token', async () => {
    const r = await get(
      s.server,
      '/memory/entities/by-evidence?kind=feedback&sourceId=fb_x',
      { auth: false },
    );
    expect(r.status).toBe(401);
  });

  it('returns 400 when kind is missing', async () => {
    const r = await get(s.server, '/memory/entities/by-evidence?sourceId=fb_x');
    expect(r.status).toBe(400);
  });

  it('returns 400 when sourceId is missing', async () => {
    const r = await get(s.server, '/memory/entities/by-evidence?kind=feedback');
    expect(r.status).toBe(400);
  });

  it('returns 400 on invalid kind', async () => {
    const r = await get(s.server, '/memory/entities/by-evidence?kind=bogus&sourceId=fb_x');
    expect(r.status).toBe(400);
  });

  it('returns empty array when no entities cite the source', async () => {
    const r = await get(s.server, '/memory/entities/by-evidence?kind=feedback&sourceId=fb_never_seen');
    expect(r.status).toBe(200);
    expect(r.body.entities).toEqual([]);
    expect(r.body.totalResults).toBe(0);
    expect(r.body.viewerScope).toBe('private');
  });

  it('returns entities citing (kind, sourceId) viewer-scope filtered', async () => {
    // Two entities cite the same (kind, sourceId), one is shared-project and
    // one is private.
    const sharedId = s.memory.rememberWithEvidence(
      {
        type: 'pattern',
        name: 'shared-project-citer',
        content: 'cites fb_target at shared-project tier',
        confidence: 0.9,
        lastVerified: '2026-05-09T00:00:00Z',
        source: 'cluster-builder',
        tags: [],
        privacyScope: 'shared-project',
      },
      [ev({ sourceId: 'fb_target', privacyTier: 'shared-project' })],
      'EvolutionManager',
    );
    const privateId = s.memory.rememberWithEvidence(
      {
        type: 'pattern',
        name: 'private-citer',
        content: 'cites fb_target at private tier',
        confidence: 0.9,
        lastVerified: '2026-05-09T00:00:00Z',
        source: 'cluster-builder',
        tags: [],
        privacyScope: 'private',
      },
      [ev({ sourceId: 'fb_target', privacyTier: 'private' })],
      'EvolutionManager',
    );

    // viewer=private — sees both
    const wide = await get(
      s.server,
      '/memory/entities/by-evidence?kind=feedback&sourceId=fb_target&viewerScope=private',
    );
    expect(wide.status).toBe(200);
    const wideIds = wide.body.entities.map((e: any) => e.id).sort();
    expect(wideIds).toEqual([sharedId, privateId].sort());

    // viewer=shared-project — sees only the shared-project entity
    const narrow = await get(
      s.server,
      '/memory/entities/by-evidence?kind=feedback&sourceId=fb_target&viewerScope=shared-project',
    );
    expect(narrow.status).toBe(200);
    const narrowIds = narrow.body.entities.map((e: any) => e.id);
    expect(narrowIds).toEqual([sharedId]);
  });

  it('cross-product: shared-project viewer cannot see private-tier evidence inverse query (even on shared-project entity)', async () => {
    // Entity is shared-project but the evidence row is private-tier.
    // findCitations filters by BOTH entity scope AND evidence tier per spec
    // line 316 — this is the "no inverse leak" guarantee.
    const id = s.memory.rememberWithEvidence(
      {
        type: 'pattern',
        name: 'shared-entity-private-evidence',
        content: 'leaky shape',
        confidence: 0.9,
        lastVerified: '2026-05-09T00:00:00Z',
        source: 'cluster-builder',
        tags: [],
        privacyScope: 'shared-project',
      },
      [ev({ sourceId: 'fb_leaktest', privacyTier: 'private' })],
      'EvolutionManager',
    );

    // viewer=private sees the citation
    const wide = await get(
      s.server,
      '/memory/entities/by-evidence?kind=feedback&sourceId=fb_leaktest&viewerScope=private',
    );
    expect(wide.status).toBe(200);
    expect(wide.body.entities.map((e: any) => e.id)).toEqual([id]);

    // viewer=shared-project does NOT see the citation — the evidence row's
    // private tier is wider than the viewer.
    const narrow = await get(
      s.server,
      '/memory/entities/by-evidence?kind=feedback&sourceId=fb_leaktest&viewerScope=shared-project',
    );
    expect(narrow.status).toBe(200);
    expect(narrow.body.entities).toEqual([]);
  });

  it('echoes the kind/sourceId/viewerScope in the response shape', async () => {
    const r = await get(
      s.server,
      '/memory/entities/by-evidence?kind=commit&sourceId=sha_zzz&viewerScope=shared-topic',
    );
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('commit');
    expect(r.body.sourceId).toBe('sha_zzz');
    expect(r.body.viewerScope).toBe('shared-topic');
  });
});
