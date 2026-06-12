// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 3 (E2E "feature is alive") test for the cartographer-doc-freshness sweep
 * (cartographer-conformance spec #2).
 *
 * This proves the freshness sweep is GENUINELY ALIVE — not a no-op:
 *
 *   PART A (the core proof): the REAL CartographerSweepEngine + CartographerSweepPoller
 *   run over a REAL temp git repo and a REAL CartographerTree. We exercise the full
 *   author lifecycle — never-authored → runPass() authors it fresh (with `sweep`
 *   provenance) → a real code change + commit flips it stale → the NEXT runPass()
 *   re-authors it fresh. Only the router / LLM queue / pressure / lease are injected
 *   stubs; staleness, committed-content reads, and setSummary go through real git +
 *   the real tree. A no-op or mis-wired engine fails this immediately.
 *
 *   PART B (route alive): mirroring the spec #1 E2E server-boot harness, with the
 *   freshness sweep ENABLED in config, the spec #2 routes answer 200 (not 503):
 *   POST /cartographer/node/refresh writes a summary, and GET /cartographer/health
 *   returns the spec #2 `freshness` backlog metric object.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import {
  CartographerSweepEngine,
  type SweepEngineConfig,
  type SweepRouterLike,
  type SweepLlmQueueLike,
} from '../../src/core/CartographerSweepEngine.js';
import { CartographerSweepPoller } from '../../src/monitoring/CartographerSweepPoller.js';
import type { PressureReading, PressureTier } from '../../src/monitoring/SessionReaper.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

const AUTH = 'test-bearer-token';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}
function commitAll(repo: string, msg: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
}

let repo: string;
let stateDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-fresh-e2e-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
  // Distinctive camelCase symbols so the deterministic symbol-presence quality bar
  // has teeth — the author stub must NAME one of these or the summary is rejected.
  fs.writeFileSync(path.join(repo, 'src', 'core', 'Widget.ts'), 'export function computeWidgetTotal() { return 0; }\n');
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export function bootstrapApp() { return 1; }\n');
  commitAll(repo, 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function tree(): CartographerTree {
  return new CartographerTree({ projectDir: repo, stateDir });
}

function sweepConfig(over: Partial<SweepEngineConfig> = {}): SweepEngineConfig {
  return {
    maxNodesPerPass: 25,
    maxCentsPerPass: 25,
    estCentsPerAuthor: 1,
    maxLeafBytes: 24576,
    minSummaryChars: 10,
    maxSummaryChars: 600,
    allowClaudeFallback: false,
    nodeFailQuarantineThreshold: 3,
    maxDeferredPasses: 5,
    revalidateSamplePerPass: 0,
    minNodesUnderPressure: 3,
    // fix instar#1069: this E2E exercises the author lifecycle, not the worker — run
    // the SAME bounded detect synchronously (the worker-from-dist path has its own
    // dist-backed integration test). Tier-3 stays green without a build step here.
    detectInWorker: false,
    ...over,
  };
}

/**
 * Router stub: routes OFF-Claude (codex-cli, available) so the engine's L5 routing
 * probe passes, and returns a summary that NAMES a distinctive symbol present in the
 * covered code (branch on the prompt's file path) so the deterministic quality bar
 * accepts it.
 */
function routerStub(): SweepRouterLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    defaultFramework: 'claude-code',
    for: () => ({ component: 'CartographerSweep', category: 'job', framework: 'codex-cli', available: true }),
    evaluate: async (prompt: string) => {
      calls.push(prompt);
      if (prompt.includes('Widget.ts')) return 'Implements computeWidgetTotal to total widgets.';
      if (prompt.includes('index.ts')) return 'Provides bootstrapApp to start the app.';
      return 'Summarizes a directory containing computeWidgetTotal and bootstrapApp.';
    },
  };
}

function queueStub(): SweepLlmQueueLike {
  return { enqueue: (_lane, fn) => fn(new AbortController().signal) };
}

const normalPressure = (): PressureReading => ({ tier: 'normal' as PressureTier });

function engineFor(t: CartographerTree, router: SweepRouterLike): CartographerSweepEngine {
  return new CartographerSweepEngine({
    tree: t,
    router,
    llmQueue: queueStub(),
    pressure: normalPressure,
    holdsLease: () => true,
    config: sweepConfig(),
    stateDir,
  });
}

describe('Cartographer doc-freshness sweep — feature is alive (Tier 3 E2E)', () => {
  // ── PART A — the in-process sweep lifecycle (the core "alive" proof) ─────────
  it('PART A: sweep lifecycle — never-authored → runPass authors fresh → code change → stale → re-author fresh', async () => {
    const LEAF = 'src/core/Widget.ts';
    const t = tree();
    t.scaffold();
    const router = routerStub();
    const engine = engineFor(t, router);

    // 1) After scaffold the leaf is never-authored, and few nodes are authored.
    expect(t.computeStaleness(LEAF)).toBe('never-authored');
    const h0 = t.health();
    expect(h0.authoredCount).toBe(0);
    expect(h0.neverAuthoredCount).toBeGreaterThan(0);
    const fh0 = t.freshnessHealth({ graceMs: 0 });
    expect(fh0.freshCount).toBe(0);
    expect(fh0.neverAuthoredCount).toBeGreaterThan(0);

    // 2) ONE runPass authors the leaf for real, off-Claude, with `sweep` provenance.
    const r1 = await engine.runPass();
    expect(r1.ranAuthorPath).toBe(true);
    expect(r1.refused).toBe(false);
    expect(r1.authored).toBeGreaterThan(0);
    expect(router.calls.length).toBeGreaterThan(0); // the real router was actually called

    const authoredLeaf = t.getNode(LEAF);
    expect(authoredLeaf?.summary).toContain('computeWidgetTotal');
    expect(authoredLeaf?.provenance?.source).toBe('sweep');
    expect(authoredLeaf?.lastAuthoredBy).toBe('sweep:codex-cli');
    expect(t.computeStaleness(LEAF)).toBe('fresh');

    const fh1 = t.freshnessHealth({ graceMs: 0 });
    expect(fh1.freshCount).toBeGreaterThan(fh0.freshCount);
    // No node is `stale` at this point — everything authored this pass is fingerprint-current.
    expect(fh1.staleCount).toBe(0);

    // 3) Mutate the covered code + commit → the leaf's git oid changes → stale.
    fs.writeFileSync(path.join(repo, 'src', 'core', 'Widget.ts'), 'export function computeWidgetTotal() { return 42; }\n');
    commitAll(repo, 'change widget');
    expect(t.computeStaleness(LEAF)).toBe('stale');

    // 4) The NEXT runPass re-authors the now-stale leaf back to fresh.
    const callsBefore = router.calls.length;
    const r2 = await engine.runPass();
    expect(r2.ranAuthorPath).toBe(true);
    expect(r2.authored).toBeGreaterThan(0);
    expect(router.calls.length).toBeGreaterThan(callsBefore); // re-authored via a real router call
    expect(t.computeStaleness(LEAF)).toBe('fresh');
  });

  it('PART A (smoke): the poller constructs, ticks, and stops without throwing', async () => {
    const t = tree();
    t.scaffold();
    const engine = engineFor(t, routerStub());
    const poller = new CartographerSweepPoller({ engine, cadenceMs: 50, idleCadenceMs: 50 });
    expect(poller.isBreakerOpen()).toBe(false);
    poller.start();
    // Let at least one cadence tick fire.
    await new Promise((resolve) => setTimeout(resolve, 150));
    poller.stop();
    // A healthy author tick must NOT have tripped the degradation breaker.
    expect(poller.isBreakerOpen()).toBe(false);
    // The poller drove the real engine, which authored real nodes.
    expect(t.computeStaleness('src/core/Widget.ts')).toBe('fresh');
  });

  // ── PART B — the spec #2 routes are alive (200, not 503) through the server ──
  function app(carto: CartographerTree): express.Express {
    const a = express();
    a.use(express.json());
    a.use(authMiddleware(() => AUTH, 'test'));
    a.use('/', createRoutes({
      config: {
        projectName: 't', projectDir: repo, stateDir, port: 0, authToken: AUTH,
        sessions: {} as unknown, scheduler: {} as unknown,
        // spec #2 gate enabled — the freshness routes are live.
        cartographer: {
          enabled: true,
          freshnessSweep: { enabled: true, egressAcknowledged: true, minSummaryChars: 10, maxSummaryChars: 600, maxLeafBytes: 24576 },
        },
      } as unknown as RouteContext['config'],
      cartographer: carto,
      startTime: new Date(),
    } as unknown as RouteContext));
    return a;
  }
  const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

  it('PART B: /cartographer/health is alive (200) and returns the spec #2 freshness backlog metric', async () => {
    const carto = tree();
    const res = await bearer(request(app(carto)).get('/cartographer/health'));
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.sweepEnabled).toBe(true);
    // The spec #2 backlog object must be present with its real shape.
    expect(res.body.freshness).toBeDefined();
    expect(typeof res.body.freshness.freshRatio).toBe('number');
    expect(typeof res.body.freshness.authorableCount).toBe('number');
    expect(res.body.freshness).toHaveProperty('neverAuthoredPastGrace');
    expect(res.body.freshness).toHaveProperty('staleCount');
  });

  it('PART B: POST /cartographer/node/refresh is alive (200, not 503) and writes a summary when enabled', async () => {
    const carto = tree();
    carto.scaffold();
    const a = app(carto);

    const res = await bearer(request(a).post('/cartographer/node/refresh'))
      .send({ path: 'src/core/Widget.ts', summary: 'Implements computeWidgetTotal to total widgets for the app.' });

    expect(res.status).not.toBe(503); // route is wired, not gated off
    expect(res.status).toBe(200);
    expect(res.body.refreshed).toBe(true);
    expect(res.body.status).toBe('fresh');

    // The write landed in the real tree with inline-agent provenance.
    const node = carto.getNode('src/core/Widget.ts');
    expect(node?.summary).toContain('computeWidgetTotal');
    expect(node?.provenance?.source).toBe('inline-agent');
  });
});
