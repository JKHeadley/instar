// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * Integration tests — GET /test-runner-limiter + POST /test-runner-limiter/prune
 * (docs/specs/test-runner-concurrency-bound.md §5 Integration, §2.7 route contract).
 *
 * Through the REAL routes pipeline (createRoutes behind the real authMiddleware):
 *  - 200 with Bearer; 401 without / 403 wrong token (both routes).
 *  - No-lie constraint (H1): cap + posture + ttlSignalArmed resolve via the
 *    CHOKEPOINT resolvers (env → tuning file → code default), NEVER from
 *    intelligence.testRunnerCap — a config-set maxConcurrent must NOT change
 *    the reported cap; a tuning-file value MUST (the positive control).
 *  - admittedOpen reflects live (pid-alive) witness records; dead-pid witness
 *    rows are excluded.
 *  - Per-lane honesty: targeted lane full + suite lane free ⇒
 *    targeted.saturated true AND suite.saturated false (round-4 integration).
 *  - PURE read: the holders file is byte-identical after a GET (dead/expired
 *    rows are excluded from the display as a VIRTUAL prune only), no ledger
 *    write, and no signal side-effects (a live fixture child referenced by
 *    held + past-grace terminating rows survives the GET).
 *  - POST /prune: reclaims a dead-pid row and enumerates it; immediate second
 *    call is rate-limited (429, rateLimited:true, wouldBeReclaimed still
 *    enumerated); single-flight (an in-flight pass coalesces to 429).
 *  - Tombstone completion is gated on the ARMED signal arm: an unarmed
 *    authority (and an env-only INSTAR_HOST_TEST_TTL_SIGNAL=1 — env can only
 *    DISARM) drops the tombstone WITHOUT a SIGKILL; tuning-file
 *    {ttlSignal:true, enforcing:true} completes the SIGKILL on the
 *    corroborated fixture target.
 *
 * ALL fixture state lives in a per-test mkdtemp base dir via the module's
 * INSTAR_HOST_TEST_BASE_DIR env seam (resolveTestRunnerPaths) — never the real
 * ~/.instar. Every spawned fixture pid is killed in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import {
  HostTestRunnerSemaphore,
  resolveTestRunnerPaths,
  writeTuningFile,
  _resetHostTestRunnerSemaphoreForTest,
  HOST_TEST_SUITE_CAP_DEFAULT,
  HOST_TEST_TARGETED_CAP_DEFAULT,
  HOST_TEST_TTL_DEFAULT_MS,
  TOMBSTONE_GRACE_MS,
  type TestRunnerHolderRow,
  type TestRunnerPaths,
} from '../../src/core/hostTestRunnerSemaphore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-runner-limiter-int-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

/** Every public lever env var the resolvers read — saved/cleared per test so a
 *  host shell export can never contaminate a resolver assertion. */
const LEVER_ENV_KEYS = [
  'INSTAR_HOST_TEST_BASE_DIR',
  'INSTAR_HOST_TEST_MAX',
  'INSTAR_HOST_TEST_TARGETED_MAX',
  'INSTAR_HOST_TEST_ENFORCE',
  'INSTAR_HOST_TEST_TTL_SIGNAL',
  'INSTAR_HOST_TEST_SEMAPHORE',
  'INSTAR_HOST_TEST_TTL_MS',
  'INSTAR_HOST_TEST_ACQUIRE_MS',
  'INSTAR_HOST_TEST_ACQUIRE_MS_INTERACTIVE',
  'INSTAR_HOST_TEST_TARGETED_ACQUIRE_MS',
  'INSTAR_HOST_TEST_POLL_MS',
] as const;

let savedEnv: Record<string, string | undefined> = {};
let baseDir: string;
let paths: TestRunnerPaths;
let fixtureChildren: ChildProcess[] = [];

/** The prune single-flight/rate-limit statics persist across singleton resets
 *  (class-level by design) — reset them so each test starts un-throttled. */
function resetPruneStatics(): void {
  const statics = HostTestRunnerSemaphore as unknown as {
    _pruneInFlight: boolean;
    _lastPruneAt: number;
  };
  statics._pruneInFlight = false;
  statics._lastPruneAt = 0;
}

beforeEach(() => {
  savedEnv = {};
  for (const k of LEVER_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trl-route-'));
  process.env.INSTAR_HOST_TEST_BASE_DIR = baseDir;
  paths = resolveTestRunnerPaths(process.env);
  // The route uses the process-wide singleton; a reset forces the next route
  // call to re-resolve paths from the env seam (the per-test temp universe).
  _resetHostTestRunnerSemaphoreForTest();
  resetPruneStatics();
});

afterEach(() => {
  // Kill every spawned fixture pid (idempotent — an already-exited child is a no-op).
  for (const child of fixtureChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  fixtureChildren = [];
  _resetHostTestRunnerSemaphoreForTest();
  resetPruneStatics();
  for (const k of LEVER_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    SafeFsExecutor.safeRmSync(baseDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/test-runner-limiter-route.test.ts:afterEach',
    });
  } catch {
    /* best-effort cleanup */
  }
});

// ── App assembly (the real routes pipeline behind the real auth middleware) ──

function ctxWith(configExtra: Record<string, unknown> = {}): RouteContext {
  return {
    config: {
      projectName: 'trl-int',
      projectDir: '/tmp',
      stateDir: '/tmp/.instar',
      port: 0,
      authToken: AUTH,
      sessions: {},
      scheduler: {},
      ...configExtra,
    },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    discoveryEvaluator: null,
    tokenLedger: null,
    featureMetricsLedger: null,
    resourceLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext = ctxWith()): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

// ── Fixture helpers (per-test temp universe only) ─────────────────────────

let idSeq = 0;
function holderRow(over: Partial<TestRunnerHolderRow> = {}): TestRunnerHolderRow {
  return {
    v: 1,
    id: `int-${++idSeq}`,
    lane: 'suite',
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: Date.now() - 1_000,
    startedAt: '',
    cmd: 'node vitest run fixture.test.ts',
    ttlMs: HOST_TEST_TTL_DEFAULT_MS,
    state: 'held',
    ...over,
  };
}

function seedHolders(rows: TestRunnerHolderRow[]): void {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(paths.holders, JSON.stringify({ v: 1, holders: rows }));
}

function seedWitness(name: string, record: Record<string, unknown>): void {
  fs.mkdirSync(paths.witnessDir, { recursive: true });
  fs.writeFileSync(path.join(paths.witnessDir, name), JSON.stringify(record));
}

/** A live disposable fixture process (killed in afterEach). */
function spawnFixtureChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
  });
  fixtureChildren.push(child);
  return child;
}

/** A pid that is PROVABLY dead: spawnSync returns only after the child exited. */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return res.pid;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── GET /test-runner-limiter ───────────────────────────────────────────────

describe('GET /test-runner-limiter (integration — real routes pipeline)', () => {
  it('Bearer required: 401 without a token; 403 with a wrong one; 200 with the right one', async () => {
    const app = appWith();
    expect((await request(app).get('/test-runner-limiter')).status).toBe(401);
    expect(
      (await request(app).get('/test-runner-limiter').set({ Authorization: 'Bearer wrong' })).status,
    ).toBe(403);
    const res = await request(app).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200);
    // The frozen top-level shape (§2.7).
    for (const field of [
      'cap',
      'targetedCap',
      'posture',
      'ttlSignalArmed',
      'liveHolders',
      'targetedHolders',
      'admittedOpen',
      'suite',
      'targeted',
      'recentEvents',
      'skipHistogram',
    ]) {
      expect(res.body, `frozen shape field ${field}`).toHaveProperty(field);
    }
  });

  it('H1 no-lie: a config-set intelligence.testRunnerCap.maxConcurrent does NOT change the reported cap (chokepoint resolvers only)', async () => {
    // The test server's config carries a DIFFERENT cap than the chokepoint
    // authority — the route must report the code default, not the config.
    const configCap = HOST_TEST_SUITE_CAP_DEFAULT + 2;
    const app = appWith(
      ctxWith({
        intelligence: { testRunnerCap: { enabled: true, maxConcurrent: configCap, acquireWaitMs: 123 } },
      }),
    );
    const res = await request(app).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.cap).toBe(HOST_TEST_SUITE_CAP_DEFAULT);
    expect(res.body.cap).not.toBe(configCap);
    expect(res.body.targetedCap).toBe(HOST_TEST_TARGETED_CAP_DEFAULT);
    // Shipped defaults through the same resolvers: dry-run posture, arm off.
    expect(res.body.posture).toBe('dry-run');
    expect(res.body.ttlSignalArmed).toBe(false);
  });

  it('H1 positive control: the tuning file (the chokepoint authority) DOES change cap + posture + ttlSignalArmed', async () => {
    writeTuningFile(paths, {
      v: 1,
      maxConcurrent: 2,
      enforcing: true,
      ttlSignal: true,
      flippedAt: new Date().toISOString(),
      by: 'integration-test',
    });
    const res = await request(appWith()).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.cap).toBe(2); // env → TUNING FILE → default
    expect(res.body.posture).toBe('enforcing');
    expect(res.body.ttlSignalArmed).toBe(true);
  });

  it('ttlSignalArmed resolves through the ASYMMETRIC arm resolver: env=1 against an unarmed authority reports false', async () => {
    process.env.INSTAR_HOST_TEST_TTL_SIGNAL = '1'; // env can only DISARM (§2.9)
    const res = await request(appWith()).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ttlSignalArmed).toBe(false);
  });

  it('admittedOpen reflects LIVE witness records: a live-pid witness appears, a dead-pid witness is excluded', async () => {
    const dead = deadPid();
    const liveAt = Date.now() - 5_000;
    seedWitness('w-live.json', { v: 1, pid: process.pid, hostname: os.hostname(), acquiredAt: liveAt });
    seedWitness('w-dead.json', { v: 1, pid: dead, hostname: os.hostname(), acquiredAt: Date.now() - 5_000 });
    const res = await request(appWith()).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200);
    const pids = (res.body.admittedOpen as Array<{ pid: number; acquiredAt: number }>).map((w) => w.pid);
    expect(pids).toContain(process.pid);
    expect(pids).not.toContain(dead);
    const live = (res.body.admittedOpen as Array<{ pid: number; acquiredAt: number }>).find(
      (w) => w.pid === process.pid,
    );
    expect(live?.acquiredAt).toBe(liveAt);
  });

  it('per-lane honesty: targeted lane FULL + suite lane free ⇒ targeted.saturated true AND suite.saturated false', async () => {
    // Fill the targeted lane to its cap with live-pid holder rows.
    seedHolders(
      Array.from({ length: HOST_TEST_TARGETED_CAP_DEFAULT }, () => holderRow({ lane: 'targeted' })),
    );
    const res = await request(appWith()).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.targeted.saturated).toBe(true);
    expect(res.body.targeted.available).toBe(0);
    expect(res.body.suite.saturated).toBe(false);
    expect(res.body.suite.available).toBe(HOST_TEST_SUITE_CAP_DEFAULT);
    expect(res.body.targetedHolders).toHaveLength(HOST_TEST_TARGETED_CAP_DEFAULT);
    expect(res.body.liveHolders).toHaveLength(0);
  });

  it('PURE read: holders file byte-identical after GET; dead/TTL-expired rows are excluded as a VIRTUAL prune only; no ledger write; no signal side-effects', async () => {
    const child = spawnFixtureChild();
    const now = Date.now();
    seedHolders([
      // (a) live fresh holder — the only row the display should count.
      holderRow({ pid: child.pid!, acquiredAt: now - 1_000 }),
      // (b) past-grace terminating tombstone for the SAME live child — a GET
      //     must never complete it (no SIGKILL from a read, §2.7).
      holderRow({
        pid: child.pid!,
        state: 'terminating',
        acquiredAt: now - 120_000,
        signaledAt: now - TOMBSTONE_GRACE_MS - 10_000,
      }),
      // (c) dead-pid holder — virtually pruned from the display, never the file.
      holderRow({ pid: deadPid() }),
      // (d) TTL-expired live holder — virtually pruned from the display too.
      holderRow({ acquiredAt: now - HOST_TEST_TTL_DEFAULT_MS - 60_000 }),
    ]);
    const before = fs.readFileSync(paths.holders);

    const res = await request(appWith()).get('/test-runner-limiter').set(auth());
    expect(res.status).toBe(200);
    // The VIRTUAL prune: only the live fresh holder is displayed…
    expect(res.body.liveHolders).toHaveLength(1);
    expect(res.body.liveHolders[0].pid).toBe(child.pid);
    // …but the file is byte-identical (nothing was physically pruned).
    const after = fs.readFileSync(paths.holders);
    expect(after.equals(before)).toBe(true);
    // Write-free: the GET appended nothing to the ledger.
    expect(fs.existsSync(paths.ledger)).toBe(false);
    // Signal-free: the fixture child referenced by a past-grace terminating
    // tombstone is STILL ALIVE after the GET.
    expect(pidAlive(child.pid!)).toBe(true);
  });
});

// ── POST /test-runner-limiter/prune ────────────────────────────────────────

describe('POST /test-runner-limiter/prune (integration — real routes pipeline)', () => {
  it('Bearer required: 401 without a token; 403 with a wrong one', async () => {
    const app = appWith();
    expect((await request(app).post('/test-runner-limiter/prune')).status).toBe(401);
    expect(
      (await request(app).post('/test-runner-limiter/prune').set({ Authorization: 'Bearer wrong' }))
        .status,
    ).toBe(403);
  });

  it('reclaims a dead-pid row and ENUMERATES it in the response; live rows are kept', async () => {
    const dead = deadPid();
    seedHolders([holderRow({ pid: dead }), holderRow({ pid: process.pid, lane: 'suite' })]);
    const res = await request(appWith()).post('/test-runner-limiter/prune').set(auth());
    expect(res.status).toBe(200);
    const reclaimed = res.body.reclaimed as Array<{ pid: number; lane?: string; reason: string }>;
    expect(reclaimed).toContainEqual({ pid: dead, lane: 'suite', reason: 'pid-dead' });
    // The live holder survived the pass and is counted.
    expect(res.body.liveSuite).toBe(1);
    // Everything reclaimable was just reclaimed — nothing left to enumerate.
    expect(res.body.wouldBeReclaimed).toEqual([]);
    // The dead row is physically gone from the holders file.
    const holders = JSON.parse(fs.readFileSync(paths.holders, 'utf-8')).holders as TestRunnerHolderRow[];
    expect(holders.map((h) => h.pid)).not.toContain(dead);
    expect(holders.map((h) => h.pid)).toContain(process.pid);
  });

  it('rate-limit: an immediate second call answers 429 with rateLimited:true and wouldBeReclaimed STILL enumerated', async () => {
    const app = appWith();
    const first = await request(app).post('/test-runner-limiter/prune').set(auth());
    expect(first.status).toBe(200);
    // Seed a NEW dead-pid row after the first pass — the throttled response
    // must still enumerate it virtually (never empty-and-mute, §2.7).
    const dead = deadPid();
    seedHolders([holderRow({ pid: dead })]);
    const second = await request(app).post('/test-runner-limiter/prune').set(auth());
    expect(second.status).toBe(429);
    expect(second.body.rateLimited).toBe(true);
    expect(second.body.reclaimed).toEqual([]);
    const would = second.body.wouldBeReclaimed as Array<{ pid: number; reason: string }>;
    expect(would).toContainEqual({ pid: dead, lane: 'suite', reason: 'pid-dead' });
    // The throttled call performed no physical reclaim.
    const holders = JSON.parse(fs.readFileSync(paths.holders, 'utf-8')).holders as TestRunnerHolderRow[];
    expect(holders.map((h) => h.pid)).toContain(dead);
  });

  it('single-flight: a concurrent in-flight pass coalesces to 429 (and clears once the pass finishes)', async () => {
    const app = appWith();
    const statics = HostTestRunnerSemaphore as unknown as {
      _pruneInFlight: boolean;
      _lastPruneAt: number;
    };
    statics._pruneInFlight = true; // simulate a pass currently holding the flight lock
    statics._lastPruneAt = 0;
    const coalesced = await request(app).post('/test-runner-limiter/prune').set(auth());
    expect(coalesced.status).toBe(429);
    expect(coalesced.body.rateLimited).toBe(true);
    // Once the in-flight pass finishes, the next call proceeds normally.
    statics._pruneInFlight = false;
    statics._lastPruneAt = 0;
    const next = await request(app).post('/test-runner-limiter/prune').set(auth());
    expect(next.status).toBe(200);
  });

  describe('tombstone completion is gated on the ARMED signal arm (§2.4/§5)', () => {
    function seedTerminating(pid: number): void {
      const now = Date.now();
      seedHolders([
        holderRow({
          pid,
          state: 'terminating',
          // acquiredAt recent enough that a just-spawned fixture's REAL start
          // time corroborates (start ≤ acquiredAt + 120s skew).
          acquiredAt: now - 60_000,
          // Past the 30s grace so a completer would fire NOW if permitted.
          signaledAt: now - TOMBSTONE_GRACE_MS - 5_000,
        }),
      ]);
    }

    it('UNARMED authority: prune drops the past-grace tombstone WITHOUT a SIGKILL — the target stays alive', async () => {
      const child = spawnFixtureChild();
      seedTerminating(child.pid!);
      const res = await request(appWith()).post('/test-runner-limiter/prune').set(auth());
      expect(res.status).toBe(200);
      // The obligation is void with the arm off — tombstone dropped, no signal.
      expect(res.body.tombstonesCompleted).toBe(1);
      expect(pidAlive(child.pid!)).toBe(true);
      const holders = JSON.parse(fs.readFileSync(paths.holders, 'utf-8')).holders as TestRunnerHolderRow[];
      expect(holders).toHaveLength(0);
    });

    it('env INSTAR_HOST_TEST_TTL_SIGNAL=1 against an UNARMED authority still does NOT SIGKILL (env can only disarm)', async () => {
      process.env.INSTAR_HOST_TEST_TTL_SIGNAL = '1';
      process.env.INSTAR_HOST_TEST_ENFORCE = '1'; // even with per-process enforcing posture
      const child = spawnFixtureChild();
      seedTerminating(child.pid!);
      const res = await request(appWith()).post('/test-runner-limiter/prune').set(auth());
      expect(res.status).toBe(200);
      expect(pidAlive(child.pid!)).toBe(true);
    });

    it('ARMED via the tuning file (ttlSignal:true + enforcing): prune COMPLETES the SIGKILL on the corroborated target', async () => {
      writeTuningFile(paths, {
        v: 1,
        enforcing: true,
        ttlSignal: true,
        flippedAt: new Date().toISOString(),
        by: 'integration-test',
      });
      const child = spawnFixtureChild();
      const exited = new Promise<NodeJS.Signals | null>((resolve) => {
        child.once('exit', (_code, signal) => resolve(signal));
      });
      seedTerminating(child.pid!);
      const res = await request(appWith()).post('/test-runner-limiter/prune').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.tombstonesCompleted).toBe(1);
      // The fixture target actually received the kill.
      const signal = await Promise.race([
        exited,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
      ]);
      expect(signal).toBe('SIGKILL');
      const holders = JSON.parse(fs.readFileSync(paths.holders, 'utf-8')).holders as TestRunnerHolderRow[];
      expect(holders).toHaveLength(0);
    });
  });
});
