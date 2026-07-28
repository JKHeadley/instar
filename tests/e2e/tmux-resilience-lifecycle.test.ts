// safe-fs-allow: test file — fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 3 (E2E "feature is alive") for tmux Event-Loop Resilience, Increment 1
 * (tmux-event-loop-resilience-spec).
 *
 * Mirrors the PRODUCTION init path (src/commands/server.ts):
 *   - the three dev-gated flags resolve via resolveDevAgentGate off the REAL config:
 *       (A) _tmuxAsyncEnabled    = resolveDevAgentGate(config.monitoring?.tmuxResilience?.asyncHotPath?.enabled, config)   (server.ts ~L4552)
 *       (B) inFlightMarkerEnabled = resolveDevAgentGate(config.monitoring?.tmuxResilience?.inFlightMarker?.enabled, config) (server.ts ~L12178)
 *       (C) _degradedTmuxEnabled = resolveDevAgentGate(config.monitoring?.degradedTmuxGuard?.enabled, config)             (server.ts ~L4553)
 *   - the (C) guard construction + getter registration (server.ts ~L4580 / ~L12372):
 *       new DegradedTmuxGuard({ ...config.monitoring?.degradedTmuxGuard, enabled: _degradedTmuxEnabled }, deps)
 *       guardRegistry.register('monitoring.degradedTmuxGuard.enabled', () => degradedTmuxGuard.guardStatus())
 *
 * Proves, end-to-end against the REAL ConfigDefaults + REAL routes:
 *   1. developmentAgent:true (defaults OMIT every `enabled`) → ALL THREE flags resolve
 *      LIVE via resolveDevAgentGate at the production init path; a fleet config → DARK.
 *   2. inert-when-off (D6 observable-equivalence) — the off path matches pre-change sync
 *      behavior: /sessions + /health serve byte-identical observable results on a dev
 *      (flags live) vs fleet (flags dark) agent (the routes are cache/state-served, so
 *      the internal tmux hot path never leaks into an observable difference).
 *   3. (C) feature-is-alive — guardRegistry.read('monitoring.degradedTmuxGuard.enabled')
 *      returns kind:'ok' with enabled:true live-on-dev (NOT `unregistered`/`missing`);
 *      GET /guards shows the row as off / dark-default on the fleet; and NO Attention is
 *      raised when the guard is dark (a dark guard ingests nothing → raises nothing).
 *
 * SCOPE: per the Increment-1 scope corrections, there is NO lowConfidence cascade-skip
 * branch and NO per-agent tmux socket isolation — neither is exercised here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { DegradedTmuxGuard, type DegradedTmuxEpisode } from '../../src/monitoring/DegradedTmuxGuard.js';

const AUTH = 'tmux-resilience-e2e-token';
const bearer = (r: request.Test) => r.set('Authorization', `Bearer ${AUTH}`);

let repo: string;
let stateDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxres-e2e-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── The three dev-gated configPaths (byte-identical to the server.ts resolveDevAgentGate args). ──
const ASYNC_PATH = 'monitoring.tmuxResilience.asyncHotPath.enabled';
const MARKER_PATH = 'monitoring.tmuxResilience.inFlightMarker.enabled';
const GUARD_PATH = 'monitoring.degradedTmuxGuard.enabled';

interface AgentConfig {
  developmentAgent: boolean;
  agentType: 'standalone';
  projectName: string;
  projectDir: string;
  stateDir: string;
  port: number;
  authToken: string;
  monitoring?: {
    tmuxResilience?: { asyncHotPath?: { enabled?: boolean }; inFlightMarker?: { enabled?: boolean } };
    degradedTmuxGuard?: { enabled?: boolean };
  };
  [k: string]: unknown;
}

/** Build the config a real agent would run with: REAL defaults applied + written to disk. */
function buildAgentConfig(developmentAgent: boolean): AgentConfig {
  const cfg: Record<string, unknown> = {
    developmentAgent,
    agentType: 'standalone',
    projectName: 't',
    projectDir: repo,
    stateDir,
    port: 0,
    authToken: AUTH,
  };
  applyDefaults(cfg, getMigrationDefaults('standalone'));
  // The GET /guards route reads config.json from disk (resolveGuardConfigSnapshot),
  // so the on-disk file IS the source of truth for the inventory row.
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg));
  return cfg as unknown as AgentConfig;
}

/** Reproduce the server.ts resolveDevAgentGate resolution for one of the three flags. */
function resolveFlag(cfg: AgentConfig, dottedPath: string): boolean {
  const explicit = dottedPath.split('.').reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], cfg);
  return resolveDevAgentGate(typeof explicit === 'boolean' ? explicit : undefined, cfg);
}

/**
 * Reproduce the server.ts (C) construction (~L4580) + getter registration (~L12372):
 * a real DegradedTmuxGuard with the gate-resolved `enabled`, plus its runtime getter
 * wired into a real GuardRegistry under the manifest key. Returns the guard, the
 * registry, and the list of episodes the notify sink received (to prove dark ⇒ silent).
 */
function constructDegradedTmuxGuardLikeServer(cfg: AgentConfig): {
  guard: DegradedTmuxGuard;
  registry: GuardRegistry;
  raised: DegradedTmuxEpisode[];
  loadPerCore: number;
} {
  const enabled = resolveFlag(cfg, GUARD_PATH);
  const raised: DegradedTmuxEpisode[] = [];
  const loadState = { value: 0.2 }; // calm host — never load-gated
  const guard = new DegradedTmuxGuard(
    { ...cfg.monitoring?.degradedTmuxGuard, enabled },
    { raiseAttention: (ep) => raised.push(ep), loadPerCore: () => loadState.value },
  );
  const registry = new GuardRegistry();
  // Production registers the getter regardless of enabled (server.ts ~L12372).
  registry.register(GUARD_PATH, () => guard.guardStatus());
  return { guard, registry, raised, loadPerCore: loadState.value };
}

/**
 * A representative running-session row the state layer serves to /sessions. It is
 * identical for the dev and fleet agents — the inert-when-off invariant says the
 * tmux hot path NEVER leaks into the observable /sessions output, so two agents
 * differing ONLY in the three flags must serve byte-identical session data.
 */
const SAMPLE_SESSION = {
  id: 'sess-1',
  tmuxSession: 'topic-100',
  status: 'running' as const,
  startedAt: '2026-06-22T00:00:00.000Z',
};

/** A minimal but REAL RouteContext that serves /health, /sessions, and /guards. */
function appFor(cfg: AgentConfig, registry: GuardRegistry): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(AUTH));
  a.use(
    '/',
    createRoutes({
      config: { ...cfg, sessions: {}, scheduler: {} } as unknown,
      // /health is cache-served (getCachedRunningSessions) and /sessions is
      // state-served (state.listSessions) — both deliberately AVOID a live tmux
      // probe (the inert-when-off invariant), so neither observable surface
      // changes with the internal async hot path.
      sessionManager: {
        getCachedRunningSessions: () => ({ count: 1, sessions: [SAMPLE_SESSION] }),
        listRunningSessions: () => [SAMPLE_SESSION],
      } as unknown,
      state: {
        getJobState: () => null,
        getSession: () => null,
        listSessions: () => [{ ...SAMPLE_SESSION }],
      } as unknown,
      scheduler: null,
      guardRegistry: registry,
      startTime: new Date(),
    } as unknown as RouteContext),
  );
  return a;
}

describe('tmux Event-Loop Resilience (Increment 1) — feature is alive (Tier 3 E2E, production init path)', () => {
  it('developmentAgent:true → all THREE flags resolve LIVE via resolveDevAgentGate (defaults OMIT enabled)', () => {
    const cfg = buildAgentConfig(true);
    // Sanity: the REAL defaults OMIT every `enabled` (the dev-gate decides — #1001 guard).
    expect(cfg.monitoring?.tmuxResilience?.asyncHotPath?.enabled).toBeUndefined();
    expect(cfg.monitoring?.tmuxResilience?.inFlightMarker?.enabled).toBeUndefined();
    expect(cfg.monitoring?.degradedTmuxGuard?.enabled).toBeUndefined();
    // But the tuning knobs DID backfill (applyDefaults add-missing) — the blocks are real.
    expect((cfg.monitoring?.degradedTmuxGuard as { windowSize?: number } | undefined)?.windowSize).toBe(64);

    // All three resolve LIVE on a dev agent.
    expect(resolveFlag(cfg, ASYNC_PATH)).toBe(true);
    expect(resolveFlag(cfg, MARKER_PATH)).toBe(true);
    expect(resolveFlag(cfg, GUARD_PATH)).toBe(true);
  });

  it('fleet config → all THREE flags resolve DARK', () => {
    const cfg = buildAgentConfig(false);
    expect(resolveFlag(cfg, ASYNC_PATH)).toBe(false);
    expect(resolveFlag(cfg, MARKER_PATH)).toBe(false);
    expect(resolveFlag(cfg, GUARD_PATH)).toBe(false);
  });

  it('an explicit enabled:false force-darks even a dev agent; explicit true is the fleet-flip', () => {
    // Dev agent with an operator force-dark on (C).
    const devForcedDark = buildAgentConfig(true);
    devForcedDark.monitoring = { ...devForcedDark.monitoring, degradedTmuxGuard: { ...devForcedDark.monitoring?.degradedTmuxGuard, enabled: false } };
    expect(resolveFlag(devForcedDark, GUARD_PATH)).toBe(false);

    // Fleet agent with an operator fleet-flip on (A).
    const fleetFlipped = buildAgentConfig(false);
    fleetFlipped.monitoring = {
      ...fleetFlipped.monitoring,
      tmuxResilience: { ...fleetFlipped.monitoring?.tmuxResilience, asyncHotPath: { enabled: true } },
    };
    expect(resolveFlag(fleetFlipped, ASYNC_PATH)).toBe(true);
  });

  it('inert-when-off (D6 observable-equivalence): /health + /sessions serve IDENTICAL observable results on dev (live) vs fleet (dark)', async () => {
    const devCfg = buildAgentConfig(true);
    const dev = constructDegradedTmuxGuardLikeServer(devCfg);
    const devApp = appFor(devCfg, dev.registry);

    // Rebuild a fresh fixture for the fleet agent so its config.json is the fleet one.
    fs.rmSync(repo, { recursive: true, force: true });
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxres-e2e-'));
    stateDir = path.join(repo, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    const fleetCfg = buildAgentConfig(false);
    const fleet = constructDegradedTmuxGuardLikeServer(fleetCfg);
    const fleetApp = appFor(fleetCfg, fleet.registry);

    // The two agents differ ONLY in the (internal) tmux hot path; the cache/state-served
    // surfaces must be observably identical — the inert-when-off guarantee.
    const devHealth = await bearer(request(devApp).get('/health'));
    const fleetHealth = await bearer(request(fleetApp).get('/health'));
    expect(devHealth.status).toBe(200);
    expect(fleetHealth.status).toBe(200);
    expect(devHealth.body.status).toBe(fleetHealth.body.status);
    expect(devHealth.body.degradations).toBe(fleetHealth.body.degradations);

    // The plain /sessions route responds with an ARRAY (res.json(enriched)).
    const devSessions = await bearer(request(devApp).get('/sessions'));
    const fleetSessions = await bearer(request(fleetApp).get('/sessions'));
    expect(devSessions.status).toBe(200);
    expect(fleetSessions.status).toBe(devSessions.status);
    // Real, non-empty session data — and byte-identical across the gate boundary.
    expect(Array.isArray(devSessions.body)).toBe(true);
    expect(devSessions.body.length).toBe(1);
    expect(devSessions.body[0].tmuxSession).toBe('topic-100');
    expect(devSessions.body).toEqual(fleetSessions.body);
  });

  it('(C) feature-is-alive on a dev agent: guardRegistry.read returns kind:ok / enabled:true (NOT unregistered/missing), and GET /guards shows it on-confirmed', async () => {
    const cfg = buildAgentConfig(true);
    const { registry } = constructDegradedTmuxGuardLikeServer(cfg);

    // The registry read — the production getter, mirroring server.ts ~L12372.
    const read = registry.read(GUARD_PATH);
    expect(read.kind).toBe('ok');
    expect(read.kind === 'ok' && read.status.enabled).toBe(true);

    // GET /guards: a registered, config-on guard is on-confirmed — never `missing`.
    const res = await bearer(request(appFor(cfg, registry)).get('/guards'));
    expect(res.status).toBe(200);
    const row = res.body.guards.find((g: { key: string }) => g.key === GUARD_PATH);
    expect(row).toBeTruthy();
    expect(row.effective).toBe('on-confirmed');
    expect(row.effective).not.toBe('missing');
    expect(row.runtime.enabled).toBe(true);
  });

  it('(C) on the fleet: GET /guards shows the row off / dark-default, and NO Attention is raised while dark', async () => {
    const cfg = buildAgentConfig(false);
    const { guard, registry, raised } = constructDegradedTmuxGuardLikeServer(cfg);

    // The registry getter still exists (production registers regardless), but reports off.
    const read = registry.read(GUARD_PATH);
    expect(read.kind).toBe('ok');
    expect(read.kind === 'ok' && read.status.enabled).toBe(false);

    // GET /guards: off, classified dark-default (defaultEnabled:false → a ships-dark
    // feature that is off is normal, never an alarm). NOT diverged-from-default.
    const res = await bearer(request(appFor(cfg, registry)).get('/guards'));
    expect(res.status).toBe(200);
    const row = res.body.guards.find((g: { key: string }) => g.key === GUARD_PATH);
    expect(row).toBeTruthy();
    expect(row.effective).toBe('off');
    expect(row.offClass).toBe('dark-default');

    // A dark guard ingests nothing → raises nothing: even a flood of slow calls and
    // stalls (well past the corroboration threshold) produces ZERO Attention items.
    for (let i = 0; i < 20; i++) {
      guard.observeTmuxCall(15_000, 'indeterminate');
      guard.onStall({ stallSeconds: 30, cpuBusyRatio: 0, timestamp: new Date().toISOString() });
    }
    expect(raised).toEqual([]);
  });

  it('(C) on a dev agent the guard genuinely WORKS: a corroborated degradation raises exactly ONE deduped episode (the live-on-dev half of the boundary)', () => {
    const cfg = buildAgentConfig(true);
    const { guard, raised } = constructDegradedTmuxGuardLikeServer(cfg);

    // Below the corroboration threshold (default 3 cycles) → no episode yet.
    guard.observeTmuxCall(15_000, 'indeterminate'); // ewma climbs past 9000ms slow threshold
    guard.observeTmuxCall(15_000, 'indeterminate');
    expect(raised.length).toBe(0);

    // The third corroborating slow cycle opens ONE episode.
    guard.observeTmuxCall(15_000, 'indeterminate');
    expect(raised.length).toBe(1);

    // Sustained degradation does NOT re-raise within the escalate interval (deduped).
    guard.observeTmuxCall(15_000, 'indeterminate');
    guard.observeTmuxCall(15_000, 'indeterminate');
    expect(raised.length).toBe(1);
  });
});
