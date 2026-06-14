// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 3 (E2E "feature is alive") for DEV-AGENT-DARK-GATE-ENFORCEMENT.
 *
 * Mirrors the PRODUCTION init path (src/commands/server.ts ~L8415 + ~L8435):
 *   - cartographer construction:  resolveDevAgentGate(config.cartographer?.enabled, config)
 *   - sweep-start predicate:      fsCfg?.enabled && sharedLlmQueue   (no egressAcknowledged)
 *
 * Proves, end-to-end against the REAL ConfigDefaults + REAL routes:
 *   1. A developmentAgent:true agent (defaults OMIT cartographer.enabled) constructs
 *      a real CartographerTree → /cartographer/health is 200 (the zero-cost read
 *      surface is LIVE — Justin's actual complaint, that cartographer was dark on Echo).
 *   2. A fleet agent gets null → 503.
 *   3. The cost-bearing sweep poller is NOT started in EITHER case without an
 *      explicit freshnessSweep.enabled:true (the cost surface is never auto-armed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import { runDetect, writeSnapshot } from '../../src/core/cartographerDetect.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';

const AUTH = 'test-bearer-token';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

let repo: string;
let stateDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-devgate-e2e-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const a = 1;\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/** Build the config a real agent would run with: REAL defaults applied. */
function buildAgentConfig(developmentAgent: boolean): Record<string, unknown> {
  const cfg: Record<string, unknown> = { developmentAgent, projectName: 't', projectDir: repo, stateDir, port: 0, authToken: AUTH };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  return cfg;
}

/** Reproduce server.ts ~L8415: construct (or not) the CartographerTree. */
function constructCartographerLikeServer(config: Record<string, unknown>): CartographerTree | null {
  const cartographerEnabled = resolveDevAgentGate(
    (config as { cartographer?: { enabled?: boolean } }).cartographer?.enabled,
    config as { developmentAgent?: boolean },
  );
  return cartographerEnabled ? new CartographerTree({ projectDir: repo, stateDir }) : null;
}

/** Reproduce server.ts ~L8435: would the sweep poller start? */
function sweepWouldStart(config: Record<string, unknown>, hasLlmQueue: boolean): boolean {
  const cartographer = constructCartographerLikeServer(config);
  if (!cartographer) return false;
  const fsCfg = (config as { cartographer?: { freshnessSweep?: { enabled?: boolean } } }).cartographer?.freshnessSweep;
  return Boolean(fsCfg?.enabled && hasLlmQueue);
}

function appFor(config: Record<string, unknown>): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'test'));
  a.use('/', createRoutes({
    config: { ...config, sessions: {} as any, scheduler: {} as any } as any,
    cartographer: constructCartographerLikeServer(config),
    startTime: new Date(),
  } as unknown as RouteContext));
  return a;
}
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

describe('Cartographer dev-gate — feature is alive (Tier 3 E2E, production init path)', () => {
  it('developmentAgent:true → the zero-cost read surface is LIVE: /cartographer/health 200 (not 503)', async () => {
    const cfg = buildAgentConfig(true);
    // Sanity: the REAL defaults OMIT cartographer.enabled (dev-gate decides).
    expect((cfg.cartographer as { enabled?: unknown })?.enabled).toBeUndefined();

    // fix instar#1069: /health serves the per-host snapshot, never a lazy scaffold.
    // Before any detect has run, the LIVE surface answers 200 with snapshot:'absent'
    // (honest empty) — proving the route is wired, with no event-loop walk.
    let res = await bearer(request(appFor(cfg)).get('/cartographer/health'));
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.snapshot).toBe('absent');

    // With the index built (boot scaffold's job) + a detect snapshot (the sweep's
    // job), the same route serves real counts — the full aliveness proof.
    const t = new CartographerTree({ projectDir: repo, stateDir });
    t.scaffold();
    const r = runDetect({
      indexPath: t.indexFilePath(), projectDir: repo, maxIndexBytes: 256 * 1024 * 1024,
      maxCandidates: 100, maxNodesPerPass: 25, maxDeferredPasses: 5, revalidateSamplePerPass: 0,
      graceMs: 0, gitMaxBuffer: 64 * 1024 * 1024, snapshotSampleMax: 500, nowMs: Date.now(),
    });
    writeSnapshot(t.snapshotPath(), {
      generatedAt: new Date().toISOString(), headSha: r.counts.headSha, counts: r.counts,
      freshness: r.freshness, staleSample: r.staleSample, staleTotal: r.staleTotal,
      staleSampleTruncated: r.staleSample.length < r.staleTotal,
      lastDetectStatus: 'ok', lastDetectAt: new Date().toISOString(), durationMs: r.durationMs,
    });
    res = await bearer(request(appFor(cfg)).get('/cartographer/health'));
    expect(res.status).toBe(200);
    expect(res.body.snapshot).toBe('present');
    expect(res.body.nodeCount).toBeGreaterThanOrEqual(1);
  });

  it('fleet config → cartographer is null: /cartographer/health 503', async () => {
    const cfg = buildAgentConfig(false);
    const res = await bearer(request(appFor(cfg)).get('/cartographer/health'));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  it('the cost-bearing sweep poller is NOT started without explicit freshnessSweep.enabled:true (no auto-arm), on dev OR fleet', () => {
    // dev agent, default freshnessSweep.enabled:false → no sweep even with an LLM queue.
    expect(sweepWouldStart(buildAgentConfig(true), /* hasLlmQueue */ true)).toBe(false);
    // fleet agent → no cartographer at all → no sweep.
    expect(sweepWouldStart(buildAgentConfig(false), true)).toBe(false);

    // Only an EXPLICIT freshnessSweep.enabled:true (plus an LLM queue) starts it,
    // even on a dev agent — and crucially WITHOUT egressAcknowledged (removed in A3).
    const dev = buildAgentConfig(true);
    (dev.cartographer as { freshnessSweep: { enabled: boolean } }).freshnessSweep.enabled = true;
    expect(sweepWouldStart(dev, true)).toBe(true);
    // No egressAcknowledged was set — the A3 removal of that second gate is proven.
    expect((dev.cartographer as { freshnessSweep: { egressAcknowledged?: unknown } }).freshnessSweep.egressAcknowledged).toBe(false);
  });
});
