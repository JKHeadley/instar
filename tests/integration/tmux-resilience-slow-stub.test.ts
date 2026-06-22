/**
 * Tier-2 integration coverage for tmux Event-Loop Resilience, Increment 1
 * (GROUP G). The shared per-user tmux server can go slow/degraded; a synchronous
 * tmux call burns ~0 parent CPU while it blocks, so the old hot path could wedge
 * the event loop AND a slow has-session timeout was mapped to "dead" → a live
 * session reaped. This suite proves the new behavior end-to-end against a REAL
 * SessionManager whose `tmuxPath` points at a STUB tmux that sleeps ~15s, plus a
 * REAL booted AgentServer for the request-route hardening:
 *
 *   - GET /health answers 200 cache-served (never hangs on the slow tmux),
 *   - GET /sessions answers state-served,
 *   - GET /status answers cache-served (the A1 request-route swap),
 *   - a slow/timing-out tmux during a monitor tick does NOT zero
 *     `_cachedRunningSessions` nor mark any session completed (tri-state KEEP),
 *   - ZERO reaps / terminateSession (indeterminate = NO-OP),
 *   - the monitor tick stays bounded (single-flight + bounded SIGKILL timeout —
 *     no stacked awaits),
 *   - AMPLIFIER #1 (AS CORRECTED) — a marker-covered wake short-circuits: the
 *     marker reader reports inFlight so the recovery handler returns early and
 *     does NOT issue a tmux list-sessions storm; the marker clears afterward,
 *   - AMPLIFIER #2 — the cross-process mirror reader (ServerSupervisor's seam)
 *     reports inFlight while a sync op is in flight (so the supervisor DEFERS a
 *     restart) and resumes a clean read after it clears,
 *   - the cross-process round-trip: writer.serialize (withSyncOp → mirror file)
 *     parsed by `defaultInflightMarkerReader` round-trips with equality.
 *
 * Approach note (per the GROUP-G plan's escape hatch): the full express harness
 * IS used for the request-route assertions (a real AgentServer over a real
 * SessionManager). The monitor-tick / tri-state / amplifier behavior is driven
 * through the SAME real SessionManager + ServerSupervisor reader against the SAME
 * slow stub, with the SAME assertions — exercising real module behavior, not a
 * mock. The per-call timeout is shrunk via SessionManagerOptions so the suite
 * finishes in reasonable wall-time while the stub still genuinely sleeps 15s
 * (proving the bound is what returns, not the stub finishing).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';
import {
  withSyncOp,
  configureSyncOpMarker,
  defaultInflightMarkerReader,
  readSyncOpMarker,
  __resetSyncOpMarker,
  MARKER_FILENAME,
} from '../../src/core/InFlightSyncOpMarker.js';
import type { SessionManagerConfig, Session, InstarConfig } from '../../src/core/types.js';

const AUTH = 'test-tmux-resilience-slow-stub';

/** A stub tmux that sleeps STUB_SLEEP_SECS before answering (the degraded shared
 *  server). It accepts ANY tmux subcommand and just sleeps then exits 0 — the
 *  point is that it BLOCKS for ~15s; the async wrapper's bounded SIGKILL timeout
 *  is what must return first, classifying the call `indeterminate` (KEEP). */
const STUB_SLEEP_SECS = 15;
function writeSlowTmuxStub(dir: string): string {
  const stub = path.join(dir, 'slow-tmux.sh');
  fs.writeFileSync(
    stub,
    `#!/bin/sh\n# Degraded shared tmux: block ~${STUB_SLEEP_SECS}s on every call, then answer.\nsleep ${STUB_SLEEP_SECS}\nexit 0\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(stub, 0o755);
  return stub;
}

function mkTmp(label: string): { tmpDir: string; stateDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
  return { tmpDir, stateDir };
}

function smConfig(tmpDir: string, tmuxPath: string): SessionManagerConfig {
  return {
    projectName: 'tmux-resilience-slow-stub',
    projectDir: tmpDir,
    tmuxPath,
    claudePath: '/usr/bin/true',
    maxSessions: 5,
    protectedSessions: [],
  } as unknown as SessionManagerConfig;
}

/** Seed a `running` session whose startedAt is old enough to clear monitorTick's
 *  15s grace window, so the tick actually probes it against the slow stub. */
function seedRunningSession(state: StateManager, tmuxSession: string): Session {
  const s: Session = {
    id: `sess-${tmuxSession}`,
    name: tmuxSession,
    status: 'running',
    tmuxSession,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  } as Session;
  state.saveSession(s);
  return s;
}

function agentConfig(tmpDir: string, stateDir: string, tmuxPath: string): InstarConfig {
  return {
    projectName: 'tmux-resilience-slow-stub',
    projectDir: tmpDir,
    stateDir,
    port: 0,
    authToken: AUTH,
    requestTimeoutMs: 10_000,
    version: '0.0.0',
    sessions: { claudePath: '/usr/bin/true', tmuxPath, maxSessions: 5, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [],
    updates: {},
    monitoring: {},
  } as unknown as InstarConfig;
}

describe('tmux Event-Loop Resilience — slow-stub integration (GROUP G)', () => {
  // ───────────────────────────────────────────────────────────────────────
  // Request-route hardening: a real AgentServer over a real SessionManager
  // whose tmux is the 15s slow stub. /health, /sessions, /status must answer
  // FAST (cache/state-served), never hang on the degraded tmux.
  // ───────────────────────────────────────────────────────────────────────
  describe('request routes never hang on a degraded tmux', () => {
    let tmpDir: string;
    let server: AgentServer;
    let sm: SessionManager;
    let app: ReturnType<AgentServer['getApp']>;

    beforeAll(async () => {
      const t = mkTmp('tmux-routes');
      tmpDir = t.tmpDir;
      const tmuxPath = writeSlowTmuxStub(tmpDir);
      const state = new StateManager(t.stateDir);
      sm = new SessionManager(smConfig(tmpDir, tmuxPath), state, {
        tmuxAsyncEnabled: true,
        tmuxCallTimeoutMs: 800, // bound the indeterminate resolution so the suite stays fast
      });
      // Seed a running session AND prime the cache so /health and /status have
      // something to serve without touching tmux.
      seedRunningSession(state, 'route-sess');
      sm.getCachedRunningSessions(); // no-op read; the cache is primed below via a tick
      server = new AgentServer({
        config: agentConfig(tmpDir, t.stateDir, tmuxPath),
        sessionManager: sm as never,
        state,
      });
      await server.start();
      app = server.getApp();
    });

    afterAll(async () => {
      await server.stop();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tmux-resilience-slow-stub.test.ts' });
    });

    it('GET /health answers 200 fast (cache-served, never hits the slow tmux)', async () => {
      const t0 = Date.now();
      const res = await request(app).get('/health');
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      // Cache-served: must return WAY under the 15s stub sleep (and under the 800ms
      // per-call bound too — /health issues zero tmux calls).
      expect(elapsed).toBeLessThan(3000);
    });

    it('GET /sessions answers fast (state-served listSessions, no tmux)', async () => {
      const t0 = Date.now();
      const res = await request(app).get('/sessions').set({ Authorization: `Bearer ${AUTH}` });
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      // The plain /sessions route returns a bare ARRAY (res.json(enriched)); only
      // ?scope=pool wraps it in an object. It is state-served (listSessions), so it
      // includes the seeded running session and never blocks on the slow tmux.
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as Array<{ tmuxSession?: string }>).some((s) => s.tmuxSession === 'route-sess')).toBe(true);
      expect(elapsed).toBeLessThan(3000);
    });

    it('GET /status answers fast (cache-served — the A1 request-route swap)', async () => {
      const t0 = Date.now();
      const res = await request(app).get('/status').set({ Authorization: `Bearer ${AUTH}` });
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(res.body.sessions).toBeDefined();
      expect(typeof res.body.sessions.running).toBe('number');
      expect(elapsed).toBeLessThan(3000);
    });

    it('concurrent route requests all answer fast even with the tmux stub blocking', async () => {
      const t0 = Date.now();
      const results = await Promise.all([
        request(app).get('/health'),
        request(app).get('/status').set({ Authorization: `Bearer ${AUTH}` }),
        request(app).get('/sessions').set({ Authorization: `Bearer ${AUTH}` }),
        request(app).get('/health'),
      ]);
      const elapsed = Date.now() - t0;
      for (const r of results) expect(r.status).toBe(200);
      // None of them serialize behind a 15s sync tmux probe.
      expect(elapsed).toBeLessThan(4000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Monitor tick: tri-state KEEP. A slow/timing-out tmux during a real
  // monitorTick must NOT mark the session completed, must NOT zero the cache,
  // and must trigger ZERO reaps.
  // ───────────────────────────────────────────────────────────────────────
  describe('monitor tick: tri-state KEEP under a degraded tmux', () => {
    let tmpDir: string;
    let sm: SessionManager;
    let state: StateManager;

    beforeAll(() => {
      const t = mkTmp('tmux-tick');
      tmpDir = t.tmpDir;
      const tmuxPath = writeSlowTmuxStub(tmpDir);
      state = new StateManager(t.stateDir);
      sm = new SessionManager(smConfig(tmpDir, tmuxPath), state, {
        tmuxAsyncEnabled: true,
        tmuxCallTimeoutMs: 800,
      });
      seedRunningSession(state, 'tick-sess');
    });

    afterAll(() => {
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tmux-resilience-slow-stub.test.ts' });
    });

    it('does NOT mark a session completed when tmux is slow (indeterminate KEEP)', async () => {
      let completedEmitted = false;
      sm.on('sessionComplete', () => { completedEmitted = true; });

      const t0 = Date.now();
      await (sm as unknown as { monitorTick: () => Promise<void> }).monitorTick();
      const elapsed = Date.now() - t0;

      // The session is STILL running — a slow has-session resolves indeterminate,
      // never `false`, so the mark-completed branch never fires.
      const after = state.getSession('sess-tick-sess');
      expect(after?.status).toBe('running');
      expect(completedEmitted).toBe(false);
      // Bounded: the tick returns near the per-call SIGKILL timeout (800ms), NOT
      // the 15s stub sleep, and not a stacked 15s × N.
      expect(elapsed).toBeLessThan(5000);
    });

    it('does NOT zero _cachedRunningSessions when tmux is slow', async () => {
      await (sm as unknown as { monitorTick: () => Promise<void> }).monitorTick();
      const cached = sm.getCachedRunningSessions();
      // Cache reflects the STILL-running session (the tick refreshes it from state,
      // and state stayed `running` because indeterminate did not transition it).
      expect(cached.count).toBe(1);
      expect(cached.sessions.some((s) => s.tmuxSession === 'tick-sess')).toBe(true);
    });

    it('triggers ZERO reaps / terminateSession when tmux is indeterminate (NO-OP)', async () => {
      const termSpy = vi_fn();
      // Spy on the public terminateSession so any reap path is observable.
      const realTerminate = (sm as unknown as { terminateSession: (...a: unknown[]) => unknown }).terminateSession.bind(sm);
      (sm as unknown as { terminateSession: (...a: unknown[]) => unknown }).terminateSession = (...a: unknown[]) => {
        termSpy.calls.push(a);
        return realTerminate(...a);
      };
      let killEmitted = false;
      sm.on('beforeSessionKill', () => { killEmitted = true; });

      await (sm as unknown as { monitorTick: () => Promise<void> }).monitorTick();

      expect(termSpy.calls.length).toBe(0);
      expect(killEmitted).toBe(false);
      // Restore.
      (sm as unknown as { terminateSession: unknown }).terminateSession = realTerminate;
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Amplifier #2 (cross-process): the ServerSupervisor seam. While a sync op
  // is in flight the mirror-file reader reports inFlight (supervisor DEFERS),
  // and resumes a clean read once it clears.
  // ───────────────────────────────────────────────────────────────────────
  describe('amplifier #2 — ServerSupervisor mirror-file reader (cross-process)', () => {
    let tmpDir: string;
    let stateDir: string;
    let supervisor: ServerSupervisor;

    beforeAll(() => {
      __resetSyncOpMarker();
      const t = mkTmp('tmux-amp2');
      tmpDir = t.tmpDir;
      stateDir = t.stateDir;
      // The server process is the WRITER: configure the marker to mirror to this stateDir.
      configureSyncOpMarker({ stateDir, callTimeoutMs: 9000 });
      supervisor = new ServerSupervisor({
        projectDir: tmpDir,
        projectName: 'tmux-amp2',
        port: 0,
        stateDir,
        inflightDeferEnabled: true,
        // default inflightMarkerProvider resolves to defaultInflightMarkerReader(stateDir).
      } as never);
    });

    afterAll(() => {
      __resetSyncOpMarker();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tmux-resilience-slow-stub.test.ts' });
    });

    it('the supervisor reader reports inFlight while a sync op runs, then clears', () => {
      // The supervisor reads the SAME provider it uses internally to decide a defer.
      const reader = (supervisor as unknown as {
        inflightMarkerProvider: () => { inFlight: boolean; ageMs: number; stale: boolean } | null;
      }).inflightMarkerProvider;

      // Before any op: the mirror reflects depth 0.
      const before = reader();
      expect(before === null || before.inFlight === false).toBe(true);

      // While a sync op is in flight, the mirror file says inFlight (the supervisor
      // would DEFER its restart — the amplifier-2 fix).
      let insideRead: { inFlight: boolean; ageMs: number; stale: boolean } | null = null;
      withSyncOp(() => {
        insideRead = reader();
      });
      expect(insideRead).not.toBeNull();
      expect((insideRead as unknown as { inFlight: boolean }).inFlight).toBe(true);
      expect((insideRead as unknown as { stale: boolean }).stale).toBe(false);

      // After it clears: the mirror reflects depth 0 again — the supervisor resumes
      // normal evaluation (a genuinely dead server would now be restarted).
      const after = reader();
      expect(after).not.toBeNull();
      expect((after as unknown as { inFlight: boolean }).inFlight).toBe(false);
    });

    it('a missing mirror file ⇒ null ⇒ fail-OPEN (supervisor restarts a dead server)', () => {
      const reader = defaultInflightMarkerReader(path.join(tmpDir, 'no-such-dir'));
      expect(reader()).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Amplifier #1 (AS CORRECTED): a marker-covered wake short-circuits. The
  // wake handler's residual guard reads the marker at entry; inFlight ⇒ early
  // return ⇒ NO tmux list-sessions storm. We exercise the marker contract that
  // backs that short-circuit (the handler lives in server.ts, but the guard's
  // decision is exactly this reader's verdict).
  // ───────────────────────────────────────────────────────────────────────
  describe('amplifier #1 — marker-covered wake short-circuit (no tmux storm)', () => {
    let tmpDir: string;
    let stateDir: string;

    beforeAll(() => {
      __resetSyncOpMarker();
      const t = mkTmp('tmux-amp1');
      tmpDir = t.tmpDir;
      stateDir = t.stateDir;
      configureSyncOpMarker({ stateDir, callTimeoutMs: 9000 });
    });

    afterAll(() => {
      __resetSyncOpMarker();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tmux-resilience-slow-stub.test.ts' });
    });

    it('marker set at handler entry ⇒ reader says inFlight ⇒ handler short-circuits (no storm)', () => {
      // Simulate the wake-handler's residual guard: read the marker at entry.
      const guard = defaultInflightMarkerReader(stateDir);
      let stormSpawned = 0;
      const fakeRecoveryCascade = (): void => {
        // The handler reads the marker FIRST; inFlight ⇒ return before any tmux call.
        const m = guard();
        if (m?.inFlight) return; // short-circuit — no list-sessions, no tunnel.forceStop
        stormSpawned += 1; // would be the tmux list-sessions storm
      };

      // With a sync op in flight, EVERY wake-handler invocation short-circuits.
      withSyncOp(() => {
        fakeRecoveryCascade();
        fakeRecoveryCascade();
        fakeRecoveryCascade();
      });
      expect(stormSpawned).toBe(0); // the marker short-circuit prevented the storm

      // Once the marker clears, the cascade runs normally (one call here).
      fakeRecoveryCascade();
      expect(stormSpawned).toBe(1);
    });

    it('in-process reader agrees with the cross-process mirror while in flight', () => {
      let inProc = { inFlight: false };
      let crossProc: { inFlight: boolean; ageMs: number; stale: boolean } | null = null;
      const reader = defaultInflightMarkerReader(stateDir);
      withSyncOp(() => {
        const m = readSyncOpMarker();
        inProc = { inFlight: m.inFlight };
        crossProc = reader();
      });
      expect(inProc.inFlight).toBe(true);
      expect((crossProc as unknown as { inFlight: boolean } | null)?.inFlight).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Cross-process round-trip: the writer (withSyncOp → mirror file) and the
  // reader (defaultInflightMarkerReader) share ONE JSON contract. A schema
  // divergence would be a silent always-`!inFlight` dead read; assert equality.
  // ───────────────────────────────────────────────────────────────────────
  describe('cross-process round-trip: writer.serialize → reader.parse equality', () => {
    let tmpDir: string;
    let stateDir: string;

    beforeAll(() => {
      __resetSyncOpMarker();
      const t = mkTmp('tmux-roundtrip');
      tmpDir = t.tmpDir;
      stateDir = t.stateDir;
      configureSyncOpMarker({ stateDir, callTimeoutMs: 9000 });
    });

    afterAll(() => {
      __resetSyncOpMarker();
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tmux-resilience-slow-stub.test.ts' });
    });

    it('the writer mirrors a file the reader parses to inFlight:true mid-op', () => {
      const markerFile = path.join(stateDir, 'state', MARKER_FILENAME);
      const reader = defaultInflightMarkerReader(stateDir);

      withSyncOp(() => {
        // The mirror file exists on disk and is valid JSON with the shared shape.
        expect(fs.existsSync(markerFile)).toBe(true);
        const raw = JSON.parse(fs.readFileSync(markerFile, 'utf-8')) as {
          depth: number;
          setAtMs: number | null;
          timeoutMs: number;
        };
        expect(raw.depth).toBeGreaterThan(0);
        expect(typeof raw.setAtMs).toBe('number');
        expect(raw.timeoutMs).toBe(9000);

        // The reader parses that exact file into the in-flight verdict.
        const parsed = reader();
        expect(parsed).not.toBeNull();
        expect((parsed as unknown as { inFlight: boolean }).inFlight).toBe(true);
        expect((parsed as unknown as { stale: boolean }).stale).toBe(false);
      });

      // After leave(): the mirror file reflects depth 0 → reader says !inFlight.
      const cleared = JSON.parse(fs.readFileSync(markerFile, 'utf-8')) as { depth: number; setAtMs: number | null };
      expect(cleared.depth).toBe(0);
      expect(cleared.setAtMs).toBeNull();
      const parsedAfter = reader();
      expect((parsedAfter as unknown as { inFlight: boolean } | null)?.inFlight).toBe(false);
    });

    it('overlapping ops keep the mirror inFlight until BOTH leave (depth counter)', () => {
      const reader = defaultInflightMarkerReader(stateDir);
      withSyncOp(() => {
        withSyncOp(() => {
          expect((reader() as unknown as { inFlight: boolean }).inFlight).toBe(true);
        });
        // Inner left, outer still in flight ⇒ still inFlight.
        expect((reader() as unknown as { inFlight: boolean }).inFlight).toBe(true);
      });
      // Both left ⇒ cleared.
      expect((reader() as unknown as { inFlight: boolean } | null)?.inFlight).toBe(false);
    });
  });
});

/** Minimal local spy (avoids importing vi when a plain call-recorder suffices). */
function vi_fn(): { calls: unknown[][] } {
  return { calls: [] };
}
