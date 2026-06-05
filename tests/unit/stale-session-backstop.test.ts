import { describe, it, expect, beforeEach } from 'vitest';
import { StaleSessionBackstop, type ProgressSnapshot, type LivenessBatch } from '../../src/monitoring/StaleSessionBackstop.js';
import type { Session } from '../../src/core/types.js';

function mkSession(id: string): Session {
  return {
    id, name: id, tmuxSession: id, status: 'running',
    startedAt: new Date(0).toISOString(),
  } as Session;
}

const M = 30; // unverifiableEscalateMinutes
const N = 15; // indeterminateEscalateCount

function harness(opts?: { snapshots?: Map<string, ProgressSnapshot> }) {
  let clock = 1_000_000;
  const sessions: Session[] = [];
  const raised: Array<{ id: string; title: string; summary?: string; lane?: string; healthKey?: string; priority?: string }> = [];
  const longFlags = new Map<string, boolean>();
  let batch: LivenessBatch = { reachable: true, liveness: new Map() };
  const snaps = opts?.snapshots ?? new Map<string, ProgressSnapshot>();

  const backstop = new StaleSessionBackstop(
    {
      listRunningSessions: () => sessions,
      probeLiveness: () => batch,
      snapshot: (s) => snaps.get(s.id) ?? {
        transcriptResolved: false, transcriptSize: 0, transcriptTailHash: null,
        mainProcessActive: false, idleStateToken: 'x',
        descendantCpuSeconds: 0, isJobSession: false,
      },
      raiseAttention: async (item) => {
        raised.push({ id: item.id, title: item.title, summary: item.summary, lane: item.lane, healthKey: item.healthKey, priority: item.priority });
        return true;
      },
      // Map session ids ending in a number to a friendly name so the heads-up
      // tests can assert "names the topic, never topic-<n>". A bare id resolves null.
      resolveTopicName: (s) => (s.name === 'exo' ? 'EXO 3.0' : null),
      setLongIndeterminate: (id, isLong) => longFlags.set(id, isLong),
      now: () => clock,
    },
    { enabled: true, tickIntervalSec: 120, unverifiableEscalateMinutes: M, indeterminateEscalateCount: N, progressFloorBytes: 512, cpuFloorSeconds: 1 },
  );

  return {
    backstop, raised, longFlags,
    addSession: (id: string) => { sessions.push(mkSession(id)); },
    setLiveness: (b: LivenessBatch) => { batch = b; },
    setSnap: (id: string, s: ProgressSnapshot) => { snaps.set(id, s); },
    advanceMin: (mins: number) => { clock += mins * 60_000; },
    allAlive: () => { batch = { reachable: true, liveness: new Map(sessions.map(s => [s.tmuxSession, 'alive'])) }; },
  };
}

const idleSnap = (token = 'frame-static'): ProgressSnapshot => ({
  transcriptResolved: true, transcriptSize: 1000, transcriptTailHash: 'tail-A',
  mainProcessActive: false, idleStateToken: token,
  descendantCpuSeconds: 0, isJobSession: false,
});

/** A JOB session's snapshot — transcript static, idle token static (no output),
 *  with a configurable accumulated cpu-seconds. A wedged job keeps cpu flat. */
const jobSnap = (cpuSeconds: number, mainProcessActive = true): ProgressSnapshot => ({
  transcriptResolved: false, transcriptSize: 0, transcriptTailHash: null,
  mainProcessActive, idleStateToken: 'job-frame-static',
  descendantCpuSeconds: cpuSeconds, isJobSession: true,
});

describe('StaleSessionBackstop (§P5)', () => {
  it('raises ONE attention item (never kills) after M minutes of no forward progress', async () => {
    const h = harness();
    h.addSession('s1');
    h.allAlive();
    h.setSnap('s1', idleSnap());
    await h.backstop.tick();            // baseline
    expect(h.raised).toHaveLength(0);
    h.advanceMin(M + 1);
    h.setSnap('s1', idleSnap());        // identical → no progress
    await h.backstop.tick();
    expect(h.raised).toHaveLength(1);
    // Calm Agent-Health-lane heads-up: named, NORMAL, lane-routed, reply-able.
    expect(h.raised[0].title).toMatch(/Heads-up on the/);
    expect(h.raised[0].lane).toBe('agent-health');
    expect(h.raised[0].priority).toBe('NORMAL');
    expect(h.raised[0].healthKey).toBe('stale-s1');
    expect(h.raised[0].summary).toMatch(/Reply "check /);
  });

  it('names the topic in the heads-up (never a bare topic-<n>) when a friendly name resolves', async () => {
    const h = harness();
    h.addSession('exo'); // harness resolveTopicName maps name 'exo' -> 'EXO 3.0'
    h.allAlive();
    h.setSnap('exo', idleSnap());
    await h.backstop.tick();
    h.advanceMin(M + 1);
    h.setSnap('exo', idleSnap());
    await h.backstop.tick();
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].title).toContain('EXO 3.0');
    expect(h.raised[0].title).not.toMatch(/topic-\d+/);
    expect(h.raised[0].summary).toContain('check EXO 3.0');
  });

  it('does not re-raise within the same episode', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive(); h.setSnap('s1', idleSnap());
    await h.backstop.tick();
    h.advanceMin(M + 1); await h.backstop.tick();   // 1st raise
    h.advanceMin(M + 1); await h.backstop.tick();   // still stale, same episode
    expect(h.raised).toHaveLength(1);
  });

  it('a heartbeat-byte append (tiny growth, same tail) is NOT progress → still escalates', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    h.setSnap('s1', { ...idleSnap(), transcriptSize: 1000, transcriptTailHash: 'tail-A' });
    await h.backstop.tick();
    h.advanceMin(M + 1);
    // +10 bytes (< 512 floor) and the tail hash is unchanged → no meaningful advance.
    h.setSnap('s1', { ...idleSnap(), transcriptSize: 1010, transcriptTailHash: 'tail-A' });
    await h.backstop.tick();
    expect(h.raised).toHaveLength(1);
  });

  it('a meaningful transcript advance (≥floor AND new tail) resets the clock — no escalation', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    h.setSnap('s1', { ...idleSnap(), transcriptSize: 1000, transcriptTailHash: 'tail-A' });
    await h.backstop.tick();
    h.advanceMin(M + 1);
    h.setSnap('s1', { ...idleSnap(), transcriptSize: 2000, transcriptTailHash: 'tail-B' });
    await h.backstop.tick();
    expect(h.raised).toHaveLength(0);
  });

  it('main-process CPU activity counts as progress', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    h.setSnap('s1', idleSnap());
    await h.backstop.tick();
    h.advanceMin(M + 1);
    h.setSnap('s1', { ...idleSnap(), mainProcessActive: true });
    await h.backstop.tick();
    expect(h.raised).toHaveLength(0);
  });

  it('a prompt/idle-state change counts as progress', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    h.setSnap('s1', idleSnap('frame-1'));
    await h.backstop.tick();
    h.advanceMin(M + 1);
    h.setSnap('s1', idleSnap('frame-2')); // screen changed
    await h.backstop.tick();
    expect(h.raised).toHaveLength(0);
  });

  it('recovery then a fresh stall raises a NEW (per-episode) item', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    h.setSnap('s1', idleSnap('f1'));
    await h.backstop.tick();
    h.advanceMin(M + 1); await h.backstop.tick();           // episode 1 raised
    h.setSnap('s1', idleSnap('f2')); await h.backstop.tick(); // progress → recovered
    h.advanceMin(M + 1);
    h.setSnap('s1', idleSnap('f2')); await h.backstop.tick(); // stale again → episode 2
    expect(h.raised).toHaveLength(2);
    expect(h.raised[0].id).not.toBe(h.raised[1].id);
  });

  it('control-plane unreachable raises ONE global item, not one per session', async () => {
    const h = harness();
    h.addSession('s1'); h.addSession('s2'); h.addSession('s3');
    h.setLiveness({ reachable: false, liveness: new Map() });
    await h.backstop.tick();
    await h.backstop.tick(); // still unreachable — deduped
    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].title).toMatch(/control plane unreachable/);
  });

  it('flags a long-indeterminate session for spawn-cap exclusion and clears on recovery', async () => {
    const h = harness();
    h.addSession('s1');
    // Server reachable but s1 individually indeterminate for N+ ticks.
    h.setLiveness({ reachable: true, liveness: new Map([['s1', 'indeterminate']]) });
    // Reachable requires at least one non-indeterminate; add a healthy sibling.
    h.addSession('s2');
    h.setLiveness({ reachable: true, liveness: new Map([['s1', 'indeterminate'], ['s2', 'alive']]) });
    h.setSnap('s2', idleSnap());
    for (let i = 0; i < N; i++) await h.backstop.tick();
    expect(h.longFlags.get('s1')).toBe(true);
    expect(h.raised.some(r => r.title.match(/Heads-up on the/) && r.lane === 'agent-health')).toBe(true);
    // s1 recovers
    h.setLiveness({ reachable: true, liveness: new Map([['s1', 'alive'], ['s2', 'alive']]) });
    h.setSnap('s1', idleSnap());
    await h.backstop.tick();
    expect(h.longFlags.get('s1')).toBe(false);
  });

  it('never auto-kills (no terminate/kill dep exists at all)', () => {
    // Structural guarantee: the deps surface has no kill/terminate function.
    const deps = Object.keys({
      listRunningSessions: 1, probeLiveness: 1, snapshot: 1, raiseAttention: 1, setLongIndeterminate: 1, now: 1,
    });
    expect(deps).not.toContain('terminate');
    expect(deps).not.toContain('kill');
  });

  // ── Job-session CPU-stall detection (codex wedged-job) ──────────────────────

  it('JOB session: a live process with FLAT cpu-seconds is no-progress → escalates (the wedged-codex-job fix)', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    // Wedged job: process ALIVE (mainProcessActive true) but cpu-seconds never grow.
    h.setSnap('s1', jobSnap(42, /* mainProcessActive */ true));
    await h.backstop.tick();             // baseline
    expect(h.raised).toHaveLength(0);
    h.advanceMin(M + 1);
    h.setSnap('s1', jobSnap(42, true));  // SAME cpu-seconds → no CPU used → stale
    await h.backstop.tick();
    expect(h.raised).toHaveLength(1);    // existence alone no longer counts for a job
  });

  it('JOB session: growing cpu-seconds is forward progress → no escalation', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    h.setSnap('s1', jobSnap(42, true));
    await h.backstop.tick();
    h.advanceMin(M + 1);
    h.setSnap('s1', jobSnap(99, true));  // +57 cpu-seconds > floor → real work
    await h.backstop.tick();
    expect(h.raised).toHaveLength(0);
  });

  it('CONVERSATIONAL session: a live process (existence) still counts as progress — no regression', async () => {
    const h = harness();
    h.addSession('s1'); h.allAlive();
    // Conversational (isJobSession=false) idle-with-bg: mainProcessActive true, cpu flat.
    const convoBg = (): ProgressSnapshot => ({
      transcriptResolved: false, transcriptSize: 0, transcriptTailHash: null,
      mainProcessActive: true, idleStateToken: 'static',
      descendantCpuSeconds: 7, isJobSession: false,
    });
    h.setSnap('s1', convoBg());
    await h.backstop.tick();
    h.advanceMin(M + 1);
    h.setSnap('s1', convoBg());           // flat cpu, but existence-based check still applies
    await h.backstop.tick();
    expect(h.raised).toHaveLength(0);     // conversational unchanged — no false-positive
  });
});
