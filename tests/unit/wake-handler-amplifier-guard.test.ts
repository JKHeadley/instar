// safe-fs-allow: test file writes ONLY into a per-test os.tmpdir() sandbox it creates + cleans.
// safe-git-allow: test file — no git calls.

/**
 * Tests for amplifier #1 (spec §A.5): the wake-handler recovery guard in
 * src/commands/server.ts (`sleepWakeDetector.on('wake', …)`).
 *
 * SCOPE (AS CORRECTED): the lowConfidence cascade-skip branch was REMOVED from the
 * handler (no lowConfidence producer exists in SleepWakeDetector), so there is NO
 * low-confidence case to assert. The amplifier-1 guard is now:
 *   (1) the MARKER SHORT-CIRCUIT — when the (A) gate is LIVE, a sync subprocess op
 *       in flight at handler entry (the cross-process mirror reports inFlight) means
 *       this "wake" is an event-loop BLOCK, not a suspend → early return BEFORE any
 *       recovery cascade (no tunnel.forceStop, no tmux re-validation); and
 *   (2) the async-9000+SIGKILL conversion of the tmux re-validation when the cascade
 *       DOES run (no marker) — bounded so a wedged tmux can't re-block the event loop,
 *       informational only (a timeout/reject is swallowed).
 *
 * The handler is an inline closure in server.ts (not separately exported), so this
 * file exercises the guard two honest ways:
 *   A. The REAL `defaultInflightMarkerReader` over a REAL mirror file — proving the
 *      exact predicate the short-circuit branches on (its decision is the guard).
 *   B. A faithful harness that reconstructs the handler's guard sequence verbatim
 *      from server.ts, wiring the REAL reader + REAL resolveDevAgentGate + injected
 *      tunnel/execFileAsync/notify stubs, then asserting both sides of every branch.
 *   C. Source-grounded structural assertions binding the harness to the live handler
 *      (so a drift in server.ts breaks this test).
 *
 * No assertion here asserts a lowConfidence case (that branch does not exist).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultInflightMarkerReader,
  MARKER_FILENAME,
  DEFAULT_SYNC_OP_TIMEOUT_MS,
  STALE_TTL_FACTOR,
} from '../../src/core/InFlightSyncOpMarker.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';

// ── mirror-file helpers (the REAL cross-process contract { depth, setAtMs, timeoutMs }) ──
function writeMarker(stateDir: string, payload: { depth: number; setAtMs: number | null; timeoutMs?: number }): void {
  const dir = path.join(stateDir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MARKER_FILENAME),
    JSON.stringify({ timeoutMs: DEFAULT_SYNC_OP_TIMEOUT_MS, ...payload }),
  );
}

/**
 * A faithful reconstruction of the server.ts wake handler's GUARD sequence
 * (the parts amplifier #1 governs), kept verbatim with the live handler. Each
 * injected dep mirrors the real one; the section-C source assertions below
 * keep this in lock-step with src/commands/server.ts. It deliberately does NOT
 * reproduce the unrelated WAL-checkpoint / Slack / scheduler bodies — only the
 * marker short-circuit, the bounded tmux re-validation, and the DIGEST notify.
 */
async function runWakeGuard(opts: {
  gateLive: boolean; // resolveDevAgentGate(config…asyncHotPath.enabled, config)
  stateDir: string | null;
  event: { sleepDurationSeconds: number; timestamp: string };
  tmuxPath: string | null;
  // injected effect sinks (spies)
  tunnelForceStop: (() => Promise<void>) | null;
  execFileAsync: (file: string, args: string[], o: Record<string, unknown>) => Promise<{ stdout: string }>;
  execFileSyncLegacy: (file: string, args: string[], o: Record<string, unknown>) => string;
  notify: (lane: string, source: string, text: string) => void;
}): Promise<{ shortCircuited: boolean }> {
  const _tmuxAsyncHotPathWakeGuard = opts.gateLive;

  // (A.5) Marker short-circuit (residual guard) — verbatim from server.ts.
  if (_tmuxAsyncHotPathWakeGuard) {
    try {
      const marker = defaultInflightMarkerReader(opts.stateDir)();
      if (marker?.inFlight) {
        return { shortCircuited: true }; // early return BEFORE any recovery cascade
      }
    } catch {
      /* a marker-read failure falls through to the normal handler */
    }
  }

  // tmux re-validation — bounded async (9000 + SIGKILL) under the guard; informational,
  // so a timeout/reject is swallowed. OFF path = legacy sync (5000).
  try {
    if (opts.tmuxPath) {
      if (_tmuxAsyncHotPathWakeGuard) {
        const { stdout } = await opts.execFileAsync(opts.tmuxPath, ['list-sessions'], {
          encoding: 'utf-8',
          timeout: 9000,
          killSignal: 'SIGKILL',
        });
        void stdout;
      } else {
        opts.execFileSyncLegacy(opts.tmuxPath, ['list-sessions'], { encoding: 'utf-8', timeout: 5000 });
      }
    }
  } catch {
    /* swallowed — informational only */
  }

  // Tunnel recovery cascade (the heavy block the short-circuit avoids).
  if (opts.tunnelForceStop) {
    try {
      await opts.tunnelForceStop();
    } catch {
      /* swallowed */
    }
  }

  // DIGEST notify for real long sleeps (>300s). Must still fire on a high-confidence sleep.
  if (opts.event.sleepDurationSeconds > 300) {
    opts.notify('DIGEST', 'system', 'Machine woke up after a long sleep.');
  }

  return { shortCircuited: false };
}

describe('wake-handler amplifier #1 — REAL defaultInflightMarkerReader predicate (A)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-marker-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('reports inFlight:true for a fresh in-flight mirror (the short-circuit fires)', () => {
    writeMarker(stateDir, { depth: 1, setAtMs: Date.now() });
    const m = defaultInflightMarkerReader(stateDir)();
    expect(m?.inFlight).toBe(true);
  });

  it('reports inFlight:false for an idle mirror (depth 0) — the cascade runs', () => {
    writeMarker(stateDir, { depth: 0, setAtMs: null });
    const m = defaultInflightMarkerReader(stateDir)();
    expect(m?.inFlight).toBe(false);
  });

  it('reports inFlight:false + stale for a marker older than 2× the timeout (TTL self-heal)', () => {
    const ancient = Date.now() - (STALE_TTL_FACTOR * DEFAULT_SYNC_OP_TIMEOUT_MS + 60_000);
    writeMarker(stateDir, { depth: 1, setAtMs: ancient });
    const m = defaultInflightMarkerReader(stateDir)();
    expect(m?.stale).toBe(true);
    expect(m?.inFlight).toBe(false);
  });

  it('returns null when the mirror file is absent (fail-open — the cascade runs)', () => {
    const m = defaultInflightMarkerReader(stateDir)();
    expect(m).toBeNull();
  });

  it('returns null on an unparseable mirror file (fail-open — the cascade runs)', () => {
    const dir = path.join(stateDir, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MARKER_FILENAME), '{ not json');
    const m = defaultInflightMarkerReader(stateDir)();
    expect(m).toBeNull();
  });

  it('a null stateDir reads null (no marker context — fail-open)', () => {
    expect(defaultInflightMarkerReader(null)()).toBeNull();
  });
});

describe('wake-handler amplifier #1 — guard behavior via the faithful harness (B)', () => {
  let stateDir: string;
  let tunnelForceStop: ReturnType<typeof vi.fn>;
  let execFileAsync: ReturnType<typeof vi.fn>;
  let execFileSyncLegacy: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-guard-'));
    tunnelForceStop = vi.fn(async () => {});
    execFileAsync = vi.fn(async () => ({ stdout: 'srv: 1 windows\n' }));
    execFileSyncLegacy = vi.fn(() => 'srv: 1 windows');
    notify = vi.fn();
  });
  afterEach(() => {
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    vi.restoreAllMocks();
  });

  const base = (over: Partial<Parameters<typeof runWakeGuard>[0]> = {}) => ({
    gateLive: true,
    stateDir,
    event: { sleepDurationSeconds: 30, timestamp: new Date().toISOString() },
    tmuxPath: '/usr/bin/tmux',
    tunnelForceStop,
    execFileAsync,
    execFileSyncLegacy,
    notify,
    ...over,
  });

  it('SHORT-CIRCUITS at entry when a marker is in flight (gate LIVE) — no tunnel.forceStop, no tmux exec', async () => {
    writeMarker(stateDir, { depth: 1, setAtMs: Date.now() });
    const r = await runWakeGuard(base());
    expect(r.shortCircuited).toBe(true);
    expect(tunnelForceStop).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
    expect(execFileSyncLegacy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('runs the FULL cascade when NO marker is set (gate LIVE) — tunnel.forceStop + async tmux re-validation', async () => {
    // no marker file → reader returns null → !marker?.inFlight → cascade runs
    const r = await runWakeGuard(base());
    expect(r.shortCircuited).toBe(false);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(tunnelForceStop).toHaveBeenCalledTimes(1);
  });

  it('runs the cascade when the marker is STALE (gate LIVE) — a stale marker never short-circuits', async () => {
    const ancient = Date.now() - (STALE_TTL_FACTOR * DEFAULT_SYNC_OP_TIMEOUT_MS + 60_000);
    writeMarker(stateDir, { depth: 1, setAtMs: ancient });
    const r = await runWakeGuard(base());
    expect(r.shortCircuited).toBe(false);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(tunnelForceStop).toHaveBeenCalledTimes(1);
  });

  it('the tmux re-validation (when it runs) uses async timeout:9000 + killSignal:SIGKILL', async () => {
    await runWakeGuard(base());
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    const [file, args, optsArg] = execFileAsync.mock.calls[0];
    expect(file).toBe('/usr/bin/tmux');
    expect(args).toEqual(['list-sessions']);
    expect(optsArg).toMatchObject({ timeout: 9000, killSignal: 'SIGKILL' });
  });

  it('a REJECTING tmux re-validation is swallowed — the handler still finishes the cascade', async () => {
    execFileAsync.mockRejectedValueOnce(new Error('tmux SIGKILLed after 9s'));
    const r = await runWakeGuard(base());
    expect(r.shortCircuited).toBe(false);
    // the reject did NOT propagate, and the cascade proceeded past it
    expect(tunnelForceStop).toHaveBeenCalledTimes(1);
  });

  it('a high-confidence >300s sleep runs the cascade AND fires notify(DIGEST)', async () => {
    const r = await runWakeGuard(base({ event: { sleepDurationSeconds: 600, timestamp: new Date().toISOString() } }));
    expect(r.shortCircuited).toBe(false);
    expect(tunnelForceStop).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('DIGEST');
  });

  it('a short (<=300s) sleep does NOT fire notify(DIGEST) — only long sleeps are surfaced', async () => {
    await runWakeGuard(base({ event: { sleepDurationSeconds: 120, timestamp: new Date().toISOString() } }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('a >300s sleep that SHORT-CIRCUITS (marker in flight) does NOT notify — the block isn\'t a real sleep', async () => {
    writeMarker(stateDir, { depth: 1, setAtMs: Date.now() });
    const r = await runWakeGuard(base({ event: { sleepDurationSeconds: 600, timestamp: new Date().toISOString() } }));
    expect(r.shortCircuited).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('flag OFF → exact legacy path: NO marker read, sync list-sessions (timeout 5000), NEVER the async 9000 call', async () => {
    writeMarker(stateDir, { depth: 1, setAtMs: Date.now() }); // even with an in-flight marker present...
    const r = await runWakeGuard(base({ gateLive: false }));
    // ...the gate is off, so the marker is never consulted and nothing short-circuits
    expect(r.shortCircuited).toBe(false);
    expect(execFileAsync).not.toHaveBeenCalled(); // never the bounded async path
    expect(execFileSyncLegacy).toHaveBeenCalledTimes(1); // the legacy sync path
    const [, , legacyOpts] = execFileSyncLegacy.mock.calls[0];
    expect(legacyOpts).toMatchObject({ timeout: 5000 });
    expect(tunnelForceStop).toHaveBeenCalledTimes(1); // full cascade still runs when off
  });

  it('a marker-read that THROWS inside the reader (gate LIVE) falls through to the normal handler, never crashing the cascade', async () => {
    // Force the REAL reader's readFileSync to throw EISDIR by making the marker
    // path a DIRECTORY. The reader catches it → returns null → no short-circuit →
    // the cascade runs (the safe direction). This exercises the reader's real
    // catch branch, not a mocked null.
    fs.mkdirSync(path.join(stateDir, 'state', MARKER_FILENAME), { recursive: true });
    const r = await runWakeGuard(base());
    expect(r.shortCircuited).toBe(false);
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(tunnelForceStop).toHaveBeenCalledTimes(1);
  });
});

describe('wake-handler amplifier #1 — source-grounded wiring assertions (C)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

  it('the (A) gate is resolved for the wake guard via resolveDevAgentGate(...asyncHotPath.enabled, config)', () => {
    expect(src).toMatch(/_tmuxAsyncHotPathWakeGuard\s*=\s*resolveDevAgentGate\(/);
    expect(src).toMatch(/tmuxResilience\?\.asyncHotPath\?\.enabled/);
  });

  it('the handler short-circuits on an in-flight marker via defaultInflightMarkerReader(config.stateDir)', () => {
    expect(src).toMatch(/defaultInflightMarkerReader\(config\.stateDir\)\(\)/);
    expect(src).toMatch(/if \(marker\?\.inFlight\)[\s\S]{0,400}return;/);
    // the short-circuit is itself gated behind the (A) flag
    expect(src).toMatch(/if \(_tmuxAsyncHotPathWakeGuard\)\s*\{[\s\S]{0,200}defaultInflightMarkerReader/);
  });

  it('the tmux re-validation uses async execFileAsync with timeout:9000 + killSignal:SIGKILL under the guard', () => {
    expect(src).toMatch(/execFileAsync\(tmuxPath, \['list-sessions'\][\s\S]{0,160}timeout: 9000[\s\S]{0,80}killSignal: 'SIGKILL'/);
  });

  it('the OFF path keeps the legacy sync execFileSync list-sessions with timeout 5000', () => {
    expect(src).toMatch(/execFileSync\(tmuxPath, \['list-sessions'\][\s\S]{0,120}timeout: 5000/);
  });

  it('the removed lowConfidence cascade-skip branch is NOT present (corrected scope — no producer)', () => {
    // No `event.lowConfidence` is BRANCHED ON to skip the recovery cascade. The only
    // permitted lowConfidence use is the inbound-queue wake-confidence hint, not a guard.
    expect(src).not.toMatch(/event\.lowConfidence\s*===\s*true/);
    expect(src).not.toMatch(/if \(event\.lowConfidence\)[\s\S]{0,120}(skip|return)/i);
  });

  it('notify(DIGEST,…) still fires for real long sleeps (>300s) — not gated behind any low-confidence skip', () => {
    expect(src).toMatch(/sleepDurationSeconds > 300/);
    expect(src).toMatch(/notify\('DIGEST'/);
  });
});
