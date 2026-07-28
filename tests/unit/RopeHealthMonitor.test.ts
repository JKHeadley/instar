// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * U4.5 — RopeHealthMonitor unit tier (u4-5-rope-health-alerts §6).
 *
 * Locks in the converged classifier semantics:
 *   - the R-r3-1 heartbeat discriminator PINNED (post-onset beat + all-down ⇒
 *     urgent; a FRESH-LOOKING but PRE-onset beat right after a lid-close ⇒
 *     peer-offline, NEVER urgent — the load-bearing false-alarm arm;
 *     heartbeat-stopped ⇒ peer-offline; between-heartbeats death ⇒ peer-offline
 *     then a LATE upgrade)
 *   - self-wake grace: suppressed until re-observation post-wake, and BOUNDED by
 *     wakeGraceMaxMs (P1-A7: SleepWakeDetector emits FALSE wakes — a spurious
 *     sleep signal coinciding with a REAL partition must still alert within the
 *     bound; docs/audits/multi-machine-seamless-ux-audit-2026-07.md)
 *   - absent snapshot record ⇒ NOT-urgent; episodeKey determinism + adjacent-
 *     window grouping; time-pinned debounce; sustained-clear; split-brain-item
 *     suppression; transition-only state writes; content scrub; state-file
 *     round-trip across restart; detected-not-notified retry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  RopeHealthMonitor,
  computeEpisodeKey,
  episodeKeysGroup,
  type RopeHealthMetricEvent,
  type RopeHealthMonitorDeps,
} from '../../src/monitoring/RopeHealthMonitor.js';
import type { RopeHealthSnapshotRow } from '../../src/core/PeerEndpointResolver.js';

const MIN = 60_000;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/RopeHealthMonitor.test.ts' }); } catch { /* ignore */ }
  }
  dirs = [];
  vi.restoreAllMocks();
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rope-health-'));
  dirs.push(d);
  return d;
}

function row(peer: string, kind: 'tailscale' | 'lan' | 'cloudflare', dead: boolean, over: Partial<RopeHealthSnapshotRow> = {}): RopeHealthSnapshotRow {
  return {
    peer,
    kind,
    dead,
    consecutiveFailures: dead ? 3 : 0,
    recoveryStreak: 0,
    lastKnownGood: !dead,
    lastOkAt: dead ? 0 : 1,
    lastFailAt: dead ? 1 : 0,
    ewmaFailRate: dead ? 1 : 0,
    ewmaLatencyMs: 30,
    ...over,
  };
}

interface Harness {
  monitor: RopeHealthMonitor;
  setNow: (ms: number) => void;
  now: () => number;
  rows: RopeHealthSnapshotRow[];
  setHeartbeat: (id: string, atMs: number | null) => void;
  raised: Array<{ id: string; title: string; body: string }>;
  metrics: RopeHealthMetricEvent[];
  stateFile: string;
  setRegistryOnline: (id: string, online: boolean) => void;
  setSplitBrain: (open: boolean) => void;
  failRaise: { on: boolean };
}

function mkMonitor(over: Partial<Parameters<typeof RopeHealthMonitor.prototype.evaluate>> & {
  cfg?: Partial<ConstructorParameters<typeof RopeHealthMonitor>[1]>;
  stateFile?: string;
} = {}): Harness {
  let nowMs = 10 * 60 * MIN;
  const rows: RopeHealthSnapshotRow[] = [];
  const heartbeats = new Map<string, number | null>();
  const online = new Map<string, boolean>();
  const raised: Array<{ id: string; title: string; body: string }> = [];
  const metrics: RopeHealthMetricEvent[] = [];
  const stateFile = over.stateFile ?? path.join(tmp(), 'state', 'rope-health.json');
  let splitBrain = false;
  const failRaise = { on: false };
  const deps: RopeHealthMonitorDeps = {
    snapshot: () => rows.map((r) => ({ ...r })),
    selfMachineId: 'm_self',
    listPeers: () => {
      const ids = new Set(rows.map((r) => r.peer));
      for (const id of online.keys()) ids.add(id);
      return [...ids].map((machineId) => ({
        machineId,
        nickname: machineId === 'm_peer' ? 'the mini' : machineId,
        registryOnline: online.get(machineId) ?? true,
      }));
    },
    readHeartbeatAtMs: (id) => heartbeats.get(id) ?? null,
    raiseAttention: (item) => {
      if (failRaise.on) throw new Error('attention sink down');
      raised.push(item);
      return undefined;
    },
    splitBrainItemOpen: () => splitBrain,
    stateFilePath: stateFile,
    recordMetric: (e) => metrics.push(e),
    now: () => nowMs,
  };
  const monitor = new RopeHealthMonitor(deps, {
    urgentDebounceMs: 60_000,
    clearSustainMs: 10 * MIN,
    wakeGraceMaxMs: 5 * MIN,
    writeDebounceMs: 0,
    ...(over.cfg ?? {}),
  });
  return {
    monitor,
    setNow: (ms) => { nowMs = ms; },
    now: () => nowMs,
    rows,
    setHeartbeat: (id, atMs) => heartbeats.set(id, atMs),
    raised,
    metrics,
    stateFile,
    setRegistryOnline: (id, o) => online.set(id, o),
    setSplitBrain: (open) => { splitBrain = open; },
    failRaise,
  };
}

/** Advance through enough evaluations for the debounce (2+ observations, ≥60s). */
function settleAllDown(h: Harness, stepMs = 30_000, steps = 4): void {
  for (let i = 0; i < steps; i++) {
    h.monitor.evaluate();
    h.setNow(h.now() + stepMs);
  }
  h.monitor.evaluate();
}

describe('RopeHealthMonitor — classifier (R-r2-1 / R-r3-1 heartbeat discriminator)', () => {
  it('all healthy ⇒ ok; some dead + one alive ⇒ degraded (digest-only, no item)', () => {
    const h = mkMonitor();
    h.rows.push(row('m_peer', 'tailscale', false), row('m_peer', 'cloudflare', false));
    h.monitor.evaluate();
    expect(h.monitor.status().peers[0].condition).toBe('ok');

    h.rows[0].dead = true;
    h.monitor.evaluate();
    expect(h.monitor.status().peers[0].condition).toBe('degraded');
    expect(h.raised).toHaveLength(0);
  });

  it('URGENT: all ropes down + a POST-onset heartbeat (advancement-since-onset) ⇒ ONE HIGH item per episode', () => {
    const h = mkMonitor();
    h.rows.push(row('m_peer', 'tailscale', true), row('m_peer', 'cloudflare', true));
    const onset = h.now();
    h.monitor.evaluate(); // onset recorded
    // A beat NEWER than the onset lands (the peer is alive yet unreachable).
    h.setHeartbeat('m_peer', onset + 30_000);
    settleAllDown(h);
    expect(h.monitor.status().peers[0].condition).toBe('urgent');
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].id).toMatch(/^rope-health-urgent:/);
    expect(h.metrics).toContain('urgent-episode');
    // Further evaluations: still ONE item (episode dedup).
    settleAllDown(h);
    expect(h.raised).toHaveLength(1);
  });

  it('LID-CLOSE (load-bearing false-alarm arm): a FRESH-LOOKING but PRE-onset beat ⇒ peer-offline, NEVER urgent', () => {
    const h = mkMonitor();
    const onset = h.now();
    // The peer's last beat was written 2 min BEFORE the lid-close — it still
    // looks fresh by any freshness-window reading, which is exactly the
    // rejected semantics. Advancement-since-onset must classify peer-offline.
    h.setHeartbeat('m_peer', onset - 2 * MIN);
    h.rows.push(row('m_peer', 'tailscale', true), row('m_peer', 'cloudflare', true));
    settleAllDown(h, MIN, 10); // 10+ minutes of all-down — plenty past any debounce
    expect(h.monitor.status().peers[0].condition).toBe('peer-offline');
    expect(h.raised).toHaveLength(0);
  });

  it('heartbeat STOPPED (no beat at all) ⇒ peer-offline', () => {
    const h = mkMonitor();
    h.setHeartbeat('m_peer', null);
    h.rows.push(row('m_peer', 'tailscale', true));
    settleAllDown(h);
    expect(h.monitor.status().peers[0].condition).toBe('peer-offline');
    expect(h.raised).toHaveLength(0);
  });

  it('BETWEEN-heartbeats death: peer-offline first, then a LATE honest upgrade to urgent when a post-onset beat lands', () => {
    const h = mkMonitor();
    const onset = h.now();
    h.setHeartbeat('m_peer', onset - 20 * MIN); // pre-onset — offline reading
    h.rows.push(row('m_peer', 'tailscale', true), row('m_peer', 'lan', true));
    settleAllDown(h);
    expect(h.monitor.status().peers[0].condition).toBe('peer-offline');
    expect(h.raised).toHaveLength(0);
    // ~35 min later the (actually alive, partitioned) peer's next coarse beat
    // syncs over git — NEWER than the onset. Late-but-honest upgrade.
    h.setHeartbeat('m_peer', onset + 35 * MIN);
    h.setNow(onset + 40 * MIN);
    h.monitor.evaluate();
    expect(h.monitor.status().peers[0].condition).toBe('urgent');
    expect(h.raised).toHaveLength(1);
  });

  it('registry already marks the peer offline (WS4.2 offline-since) ⇒ peer-offline even with a post-onset beat', () => {
    const h = mkMonitor();
    h.setRegistryOnline('m_peer', false);
    const onset = h.now();
    h.rows.push(row('m_peer', 'tailscale', true));
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', onset + MIN);
    settleAllDown(h);
    expect(h.monitor.status().peers[0].condition).toBe('peer-offline');
    expect(h.raised).toHaveLength(0);
  });

  it('ABSENT snapshot records (R-r2-minor): a peer with no rows is UNKNOWN — fails toward NOT-urgent', () => {
    const h = mkMonitor();
    h.setRegistryOnline('m_ghost', true);
    h.setHeartbeat('m_ghost', h.now() + MIN);
    settleAllDown(h);
    const ghost = h.monitor.status().peers.find((p) => p.machineId === 'm_ghost')!;
    expect(ghost.condition).toBe('unknown');
    expect(h.raised).toHaveLength(0);
  });

  it('urgentEnabled:false ⇒ classification still visible, no item ever raised', () => {
    const h = mkMonitor({ cfg: { urgentEnabled: false } });
    h.rows.push(row('m_peer', 'tailscale', true));
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', h.now() + 1);
    settleAllDown(h);
    expect(h.monitor.status().peers[0].condition).toBe('urgent');
    expect(h.raised).toHaveLength(0);
  });
});

describe('RopeHealthMonitor — time-pinned debounce + sustained clear (R-r2-2 / U1 shape)', () => {
  it('a second evaluation INSIDE urgentDebounceMs does not fire', () => {
    const h = mkMonitor();
    const onset = h.now();
    h.rows.push(row('m_peer', 'tailscale', true));
    h.monitor.evaluate(); // onset
    h.setHeartbeat('m_peer', onset + 1_000);
    h.setNow(onset + 30_000); // inside the 60s debounce
    h.monitor.evaluate();
    expect(h.raised).toHaveLength(0);
    // Once the debounce elapses (and ≥2 observations), it fires.
    h.setNow(onset + 90_000);
    h.monitor.evaluate();
    expect(h.raised).toHaveLength(1);
  });

  it('P1-A7 hazard: a SPURIOUS sleep/wake signal coinciding with a REAL partition delays urgent by AT MOST wakeGraceMaxMs — never a veto', () => {
    const h = mkMonitor(); // wakeGraceMaxMs 5 min
    const onset = h.now();
    h.rows.push(
      // Rope rows whose last observation predates the "wake" — the exact shape
      // a false wake event (event-loop stall misread as sleep) produces while
      // the ropes are genuinely all-down.
      row('m_peer', 'tailscale', true, { lastFailAt: onset - MIN, lastOkAt: 0 }),
      row('m_peer', 'cloudflare', true, { lastFailAt: onset - MIN, lastOkAt: 0 }),
    );
    h.monitor.evaluate(); // onset
    h.setHeartbeat('m_peer', onset + 1_000); // post-onset beat — genuinely urgent
    h.monitor.noteOwnWake(onset + 10_000); // the SPURIOUS wake signal
    // Inside the grace window with rows not re-observed: suppressed (counted).
    h.setNow(onset + 2 * MIN);
    h.monitor.evaluate();
    expect(h.raised).toHaveLength(0);
    expect(h.metrics).toContain('suppressed-by-sleep-gate');
    // Past the BOUNDED grace cap (still never re-observed — the stall case):
    // the alert fires anyway, within the spec's honest latency bound.
    h.setNow(onset + 10_000 + 5 * MIN + 30_000);
    h.monitor.evaluate();
    expect(h.raised).toHaveLength(1);
  });

  it('self-wake grace lifts EARLY once every rope has been re-observed post-wake', () => {
    const h = mkMonitor();
    const onset = h.now();
    h.rows.push(row('m_peer', 'tailscale', true, { lastFailAt: onset - MIN, lastOkAt: 0 }));
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', onset + 1_000);
    const wakeAt = onset + 10_000;
    h.monitor.noteOwnWake(wakeAt);
    // Re-observation lands (the lease tick re-dialed the rope post-wake).
    h.rows[0].lastFailAt = wakeAt + 5_000;
    h.setNow(onset + 2 * MIN);
    h.monitor.evaluate();
    expect(h.raised).toHaveLength(1); // no suppression — re-observed
  });

  it('sustained-clear: a health BLIP does not end the episode (no re-fire); sustained health does', () => {
    const h = mkMonitor();
    h.rows.push(row('m_peer', 'tailscale', true));
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', h.now() + 1);
    settleAllDown(h);
    expect(h.raised).toHaveLength(1);
    const episodeKey = h.monitor.status().peers[0].episodeKey!;

    // Blip: rope comes back for ONE evaluation (< clearSustainMs)...
    h.rows[0].dead = false;
    h.monitor.evaluate();
    // ...then dies again. Same episode — no second item.
    h.rows[0].dead = true;
    h.setNow(h.now() + MIN);
    settleAllDown(h);
    expect(h.monitor.status().peers[0].episodeKey).toBe(episodeKey);
    expect(h.raised).toHaveLength(1);

    // Sustained health (≥ clearSustainMs) ends the episode.
    h.rows[0].dead = false;
    h.monitor.evaluate();
    h.setNow(h.now() + 11 * MIN);
    h.monitor.evaluate();
    expect(h.monitor.status().peers[0].episodeKey).toBeNull();
    // A NEW all-down later is a NEW episode → a second item is legitimate.
    h.rows[0].dead = true;
    h.setNow(h.now() + MIN);
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', h.now() + 1);
    settleAllDown(h);
    expect(h.raised).toHaveLength(2);
    expect(h.raised[1].id).not.toBe(h.raised[0].id);
  });

  it('split-brain-item suppression: an open split-brain episode wins — no second ask', () => {
    const h = mkMonitor();
    h.setSplitBrain(true);
    h.rows.push(row('m_peer', 'tailscale', true));
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', h.now() + 1);
    settleAllDown(h);
    expect(h.raised).toHaveLength(0);
    expect(h.metrics).toContain('suppressed-by-split-brain');
    // The split-brain item resolves → the monitor may now raise its own.
    h.setSplitBrain(false);
    h.setNow(h.now() + MIN);
    h.monitor.evaluate();
    expect(h.raised).toHaveLength(1);
  });
});

describe('RopeHealthMonitor — episodeKey (deterministic + adjacent-window grouping, R-r2-5)', () => {
  it('both sides compute the SAME key (sorted pair + quantized onset)', () => {
    const onset = 1_700_000_123_456;
    expect(computeEpisodeKey('m_a', 'm_b', onset)).toBe(computeEpisodeKey('m_b', 'm_a', onset));
    // Same quantization window ⇒ same key even at different detect instants.
    expect(computeEpisodeKey('m_a', 'm_b', onset)).toBe(computeEpisodeKey('m_a', 'm_b', onset + 60_000));
  });

  it('adjacent quantization windows GROUP (boundary skew); beyond one quantum degrades to two groups', () => {
    const q = 15 * MIN;
    const w0 = Math.floor(1_700_000_000_000 / q) * q;
    const a = computeEpisodeKey('m_a', 'm_b', w0 + q - 1_000, q); // just before the boundary
    const b = computeEpisodeKey('m_a', 'm_b', w0 + q + 1_000, q); // just after
    expect(a).not.toBe(b);
    expect(episodeKeysGroup(a, b, q)).toBe(true);
    const far = computeEpisodeKey('m_a', 'm_b', w0 + 3 * q, q);
    expect(episodeKeysGroup(a, far, q)).toBe(false);
    // Different pair never groups.
    expect(episodeKeysGroup(a, computeEpisodeKey('m_a', 'm_c', w0 + q - 1_000, q), q)).toBe(false);
  });
});

describe('RopeHealthMonitor — durable state (R-r2-4)', () => {
  it('TRANSITION-ONLY writes: steady-state evaluations never touch disk', () => {
    const h = mkMonitor();
    h.rows.push(row('m_peer', 'tailscale', false));
    h.monitor.evaluate(); // unknown→ok transition → one write
    const spy = vi.spyOn(fs, 'writeFileSync');
    for (let i = 0; i < 20; i++) {
      h.setNow(h.now() + 30_000);
      h.monitor.evaluate(); // steady ok — no transitions
    }
    const stateWrites = spy.mock.calls.filter((c) => String(c[0]).includes('rope-health.json'));
    expect(stateWrites).toHaveLength(0);
  });

  it('round-trips across a restart: episode + raised marker survive (no duplicate item), counters re-debounce', () => {
    const h = mkMonitor();
    h.rows.push(row('m_peer', 'tailscale', true));
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', h.now() + 1);
    settleAllDown(h);
    expect(h.raised).toHaveLength(1);
    h.monitor.stop(); // flush

    // "Restart": a new monitor over the SAME state file + same world.
    const h2 = mkMonitor({ stateFile: h.stateFile });
    h2.setNow(h.now() + MIN);
    h2.rows.push(row('m_peer', 'tailscale', true));
    h2.setHeartbeat('m_peer', h.now() + 1);
    settleAllDown(h2);
    // The persisted episode + urgentRaisedAt suppress a duplicate item.
    expect(h2.raised).toHaveLength(0);
    expect(h2.monitor.status().peers[0].episodeKey).toBe(h.monitor.status().peers[0].episodeKey);
  });

  it('a corrupt state file is treated as missing (re-debounce), never a construction failure', () => {
    const stateFile = path.join(tmp(), 'state', 'rope-health.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, '{not json');
    const h = mkMonitor({ stateFile });
    h.rows.push(row('m_peer', 'tailscale', false));
    h.monitor.evaluate();
    expect(h.monitor.status().peers[0].condition).toBe('ok');
  });
});

describe('RopeHealthMonitor — alert delivery honesty (detected-not-notified)', () => {
  it('a failed attention delivery is recorded and RETRIED by the next evaluation — detected-but-silent is impossible', () => {
    const h = mkMonitor();
    h.failRaise.on = true;
    h.rows.push(row('m_peer', 'tailscale', true));
    h.monitor.evaluate();
    h.setHeartbeat('m_peer', h.now() + 1);
    settleAllDown(h);
    expect(h.raised).toHaveLength(0);
    expect(h.monitor.status().peers[0].detectedNotNotified).toBe(true);
    // Delivery recovers → the next evaluation re-raises. ONE urgent-episode total.
    h.failRaise.on = false;
    h.setNow(h.now() + MIN);
    h.monitor.evaluate();
    expect(h.raised).toHaveLength(1);
    expect(h.monitor.status().peers[0].detectedNotNotified).toBe(false);
    expect(h.metrics.filter((m) => m === 'urgent-episode')).toHaveLength(1);
  });
});

describe('RopeHealthMonitor — key-expiry tier (R-r2-3) + content scrub + digest', () => {
  it('absent CLI ⇒ tier silently absent (available:false, ONE debug line, no error state)', async () => {
    const logs: string[] = [];
    const h = mkMonitor();
    // Rebuild with an exec seam returning null (CLI absent) + a logger.
    const monitor = new RopeHealthMonitor(
      {
        snapshot: () => [],
        selfMachineId: 'm_self',
        listPeers: () => [],
        readHeartbeatAtMs: () => null,
        raiseAttention: () => undefined,
        execTailscaleStatusJson: async () => null,
        stateFilePath: h.stateFile,
        logger: (m) => logs.push(m),
        now: Date.now,
      },
      { keyExpiryCheckIntervalMs: 0, writeDebounceMs: 0 },
    );
    monitor.evaluate();
    await new Promise((r) => setTimeout(r, 10));
    monitor.evaluate();
    await new Promise((r) => setTimeout(r, 10));
    expect(monitor.status().keyExpiry.available).toBe(false);
    expect(logs.filter((l) => l.includes('key-expiry tier silently absent'))).toHaveLength(1); // latched
  });

  it('a key expiring inside keyExpiryWarnDays warns in the digest — scrubbed (no IP/email/tailnet from the raw JSON)', async () => {
    const nowMs = Date.parse('2026-07-02T00:00:00Z');
    const raw = JSON.stringify({
      BackendState: 'Running',
      MagicDNSSuffix: 'tailaaaaaa.ts.net',
      Self: { HostName: 'secret-host', TailscaleIPs: ['100.64.0.9'], KeyExpiry: '2026-07-10T00:00:00Z' },
      Peer: { k1: { HostName: 'peer-host', KeyExpiry: '2026-12-01T00:00:00Z', LoginName: 'user@example.com' } },
    });
    const monitor = new RopeHealthMonitor(
      {
        snapshot: () => [],
        selfMachineId: 'm_self',
        listPeers: () => [],
        readHeartbeatAtMs: () => null,
        raiseAttention: () => undefined,
        execTailscaleStatusJson: async () => raw,
        stateFilePath: path.join(tmp(), 'state', 'rope-health.json'),
        now: () => nowMs,
      },
      { keyExpiryCheckIntervalMs: 0, writeDebounceMs: 0 },
    );
    monitor.evaluate();
    await new Promise((r) => setTimeout(r, 10));
    const status = monitor.status();
    expect(status.keyExpiry.available).toBe(true);
    expect(status.keyExpiry.warn).toBe(true);
    expect(status.keyExpiry.soonest!.role).toBe('self');
    const digest = monitor.composeDigest()!;
    expect(digest).toContain('Tailscale key');
    // The hard scrub rule: nothing identifying leaves the parser/monitor.
    const everything = JSON.stringify(status) + digest;
    expect(everything).not.toContain('secret-host');
    expect(everything).not.toContain('peer-host');
    expect(everything).not.toContain('@');
    expect(everything).not.toContain('ts.net');
    expect(everything).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it('digest: null when everything is ok; ≤3 sentences, machine-NAMED (nickname), when not', () => {
    const h = mkMonitor();
    h.rows.push(row('m_peer', 'tailscale', false));
    h.monitor.evaluate();
    expect(h.monitor.composeDigest()).toBeNull();

    h.rows[0].dead = true;
    h.rows.push(row('m_peer', 'cloudflare', false));
    h.monitor.evaluate();
    const digest = h.monitor.composeDigest()!;
    expect(digest).toContain('the mini'); // nickname, never a URL/IP
    expect(digest).toContain('tailscale');
    expect((digest.match(/\./g) ?? []).length).toBeLessThanOrEqual(4);
  });
});
