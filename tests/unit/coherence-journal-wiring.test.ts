// safe-git-allow: test sandbox teardown only (tmpdir scratch dirs).
// safe-fs-allow: test sandbox teardown only (tmpdir scratch dirs).
/**
 * Wiring-integrity tests for the P1.1 coherence-journal emission funnels
 * (COHERENCE-JOURNAL-SPEC §3.3/§6) — with INDEPENDENT oracles: assertions
 * compare journal emits against the session records / files on disk, never
 * against the journal's own read path (the journal must not verify itself).
 *
 * The CAS-call-site pairing is enforced structurally by
 * scripts/lint-cas-emit-placement.js (8 sites, all paired); these tests cover
 * the two funnels whose logic lives in importable modules:
 *  - StateManager.saveSession status-diff funnel (session-lifecycle)
 *  - AutonomousSessions stop funnels (autonomous-run 'stopped')
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StateManager } from '../../src/core/StateManager.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import {
  stopAutonomousTopic,
  stopAllAutonomousJobs,
  autonomousRunId,
} from '../../src/core/AutonomousSessions.js';
import type { Session } from '../../src/core/types.js';

let tmpDir: string;
let sm: StateManager;
let emitted: Array<{ kind: string; topic?: number; data: Record<string, unknown> }>;

/** Capture seam standing in for the journal — emits recorded, nothing else. */
function captureJournal(): CoherenceJournal {
  return {
    emitLifecycle: (data: Record<string, unknown>, topic?: number) =>
      emitted.push({ kind: 'session-lifecycle', topic, data }),
    emitPlacement: (topic: number, data: Record<string, unknown>) =>
      emitted.push({ kind: 'topic-placement', topic, data }),
    emitAutonomousRun: (topic: number, data: Record<string, unknown>) =>
      emitted.push({ kind: 'autonomous-run', topic, data }),
  } as unknown as CoherenceJournal;
}

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: over.id ?? 'sess-1',
    name: over.name ?? 'telegram-13481',
    status: over.status ?? 'running',
    tmuxSession: 'tmux-x',
    startedAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-wiring-'));
  sm = new StateManager(tmpDir);
  emitted = [];
  sm.setCoherenceJournal(captureJournal());
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('saveSession lifecycle funnel (§3.3)', () => {
  it('first save with running status emits created, with the topic parsed from the name', () => {
    sm.saveSession(mkSession());
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: 'session-lifecycle',
      topic: 13481,
      data: { sessionId: 'sess-1', status: 'created' },
    });
    // Independent oracle: the session record itself exists on disk with the status.
    expect(sm.getSession('sess-1')?.status).toBe('running');
  });

  it('emits per terminal transition type: completed / killed / failed', () => {
    for (const [id, status] of [
      ['s-completed', 'completed'],
      ['s-killed', 'killed'],
      ['s-failed', 'failed'],
    ] as const) {
      sm.saveSession(mkSession({ id, status: 'running', name: `topic-7-${id}` }));
      sm.saveSession(mkSession({ id, status, name: `topic-7-${id}`, endedReason: 'test-reason' }));
      const last = emitted[emitted.length - 1];
      expect(last.kind).toBe('session-lifecycle');
      expect(last.data.status).toBe(status);
      expect(last.data.sessionId).toBe(id);
      expect(last.data.reapReason).toBe('test-reason');
      // Oracle: disk record agrees.
      expect(sm.getSession(id)?.status).toBe(status);
    }
  });

  it('does NOT emit on a metadata-only save (same status)', () => {
    sm.saveSession(mkSession());
    const count = emitted.length;
    sm.saveSession(mkSession({ model: 'opus' }));
    expect(emitted.length).toBe(count); // no transition, no emit
  });

  it("does NOT emit 'reaped' from the funnel (the reaper emits it explicitly)", () => {
    sm.saveSession(mkSession());
    sm.saveSession(mkSession({ status: 'killed', endedReason: 'reaped-idle' }));
    expect(emitted.every((e) => e.data.status !== 'reaped')).toBe(true);
  });

  it('a session without a topic-coded name emits without a topic', () => {
    sm.saveSession(mkSession({ id: 's-plain', name: 'job-runner' }));
    const last = emitted[emitted.length - 1];
    expect(last.topic).toBeUndefined();
  });

  it('journal absence is a zero-cost no-op; a throwing journal never breaks saveSession', () => {
    sm.setCoherenceJournal(undefined);
    expect(() => sm.saveSession(mkSession({ id: 's-nojournal' }))).not.toThrow();
    sm.setCoherenceJournal({
      emitLifecycle: () => {
        throw new Error('boom');
      },
    } as unknown as CoherenceJournal);
    expect(() => sm.saveSession(mkSession({ id: 's-throwing' }))).not.toThrow();
    // Oracle: both records landed regardless.
    expect(sm.getSession('s-nojournal')).not.toBeNull();
    expect(sm.getSession('s-throwing')).not.toBeNull();
  });
});

describe('autonomous stop funnels (§3.3)', () => {
  function writeRun(topic: string, startedAt: string): string {
    const dir = path.join(tmpDir, 'autonomous');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${topic}.local.md`);
    fs.writeFileSync(
      f,
      `---\nactive: true\niteration: 1\nstarted_at: "${startedAt}"\nduration_seconds: 3600\ngoal: "test"\n---\n# run\n`,
    );
    return f;
  }

  it('stopAutonomousTopic emits stopped with the scanner-compatible runId BEFORE removing the file', () => {
    const startedAt = '2026-06-06T03:00:00Z';
    const file = writeRun('13481', startedAt);
    const ok = stopAutonomousTopic(tmpDir, '13481', captureJournal2());
    expect(ok).toBe(true);
    // Oracle: the file is genuinely gone.
    expect(fs.existsSync(file)).toBe(false);
    const stops = emitted.filter((e) => e.kind === 'autonomous-run');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      topic: 13481,
      data: { action: 'stopped', runId: autonomousRunId(startedAt, '13481') },
    });
    expect((stops[0].data.artifactPaths as string[])[0]).toBe(file);
  });

  it('stopAllAutonomousJobs emits one stopped per topic-scoped run', () => {
    writeRun('100', '2026-06-06T03:00:00Z');
    writeRun('200', '2026-06-06T03:01:00Z');
    const result = stopAllAutonomousJobs(tmpDir, captureJournal2());
    expect(result.stoppedTopics.sort()).toEqual(['100', '200']);
    const stops = emitted.filter((e) => e.kind === 'autonomous-run');
    expect(stops.map((s) => s.topic).sort()).toEqual([100, 200]);
  });

  it('a missing journal seam is a clean no-op (no emit, stop still works)', () => {
    writeRun('300', '2026-06-06T03:02:00Z');
    expect(stopAutonomousTopic(tmpDir, '300')).toBe(true);
    expect(emitted.filter((e) => e.kind === 'autonomous-run')).toHaveLength(0);
  });

  function captureJournal2() {
    return {
      emitAutonomousRun: (topic: number, data: Record<string, unknown>) =>
        emitted.push({ kind: 'autonomous-run', topic, data }),
    };
  }
});
