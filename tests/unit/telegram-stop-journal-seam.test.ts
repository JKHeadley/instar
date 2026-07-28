// safe-git-allow: test sandbox teardown only (tmpdir scratch dirs).
// safe-fs-allow: test sandbox teardown only (tmpdir scratch dirs).
/**
 * Seam-plumbing test for the TelegramAdapter emergency-stop coherence-journal
 * wiring (COHERENCE-JOURNAL-SPEC §3.3, P1.2 Deliverable 2).
 *
 * The adapter holds no StateManager, so its sentinel emergency-stop path's
 * `stopAutonomousTopic(...)` call cannot reach the wired journal on its own.
 * `setCoherenceJournalSeam(seam)` injects an `AutonomousJournalSeam`; the call
 * site at the emergency-stop branch threads it through so a sentinel-driven
 * stop emits the autonomous-run `stopped` event like every other stop funnel.
 *
 * We exercise the REAL emergency-stop code path (`processUpdate` →
 * onSentinelIntercept(emergency-stop) → stopAutonomousTopic with the stored
 * seam), with an independent capture seam as the oracle — never the journal's
 * own read path. Telegram network sends (sendToTopic) no-op on the tokenless
 * adapter and are swallowed by the call site's `.catch(() => {})`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { autonomousRunId, type AutonomousJournalSeam } from '../../src/core/AutonomousSessions.js';

let tmpDir: string;
let adapter: TelegramAdapter;
let emitted: Array<{ topic: number; data: { action: string; runId: string; artifactPaths: string[] } }>;

/** Capture seam standing in for the journal — emits recorded, nothing else. */
function captureSeam(): AutonomousJournalSeam {
  return {
    emitAutonomousRun: (topic, data) => emitted.push({ topic, data }),
  };
}

/** Write a per-topic autonomous job file so stopAutonomousTopic has something to clear. */
function writeAutonomousJob(topic: number, startedAt: string): void {
  const dir = path.join(tmpDir, 'autonomous');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${topic}.local.md`),
    [
      '---',
      'active: true',
      'paused: false',
      `started_at: "${startedAt}"`,
      `report_topic: "${topic}"`,
      'goal: "test job"',
      '---',
      'body',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** Minimal Telegram text update for one topic. */
function textUpdate(topic: number, text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      message_thread_id: topic,
      date: Math.floor(Date.now() / 1000),
      text,
      from: { id: 4242, first_name: 'Op', username: 'op' },
      chat: { id: -1001, type: 'supergroup' },
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cj-seam-'));
  emitted = [];
  // Tokenless adapter: no polling, sendToTopic no-ops — but processUpdate runs.
  adapter = new TelegramAdapter({ token: '' } as never, tmpDir);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort sandbox teardown */
  }
});

describe('TelegramAdapter emergency-stop → coherence-journal seam', () => {
  it('threads the injected seam into stopAutonomousTopic on a sentinel emergency-stop', async () => {
    const topic = 13481;
    const startedAt = '2026-06-05T00:00:00.000Z';
    writeAutonomousJob(topic, startedAt);

    adapter.setCoherenceJournalSeam(captureSeam());

    // The emergency-stop branch requires a bound session for this topic.
    (adapter as unknown as { topicToSession: Map<number, string> }).topicToSession.set(topic, 'tmux-sess');
    adapter.onSentinelKillSession = () => true;
    adapter.onSentinelIntercept = async () => ({
      category: 'emergency-stop' as const,
      action: { type: 'kill' },
      reason: 'stop everything',
    });

    await (adapter as unknown as { processUpdate: (u: unknown) => Promise<void> }).processUpdate(
      textUpdate(topic, 'stop everything'),
    );

    // The autonomous file is gone (stop happened) AND the seam saw a `stopped`
    // emit with the scanner-matching runId — proving the seam was threaded.
    expect(fs.existsSync(path.join(tmpDir, 'autonomous', `${topic}.local.md`))).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].topic).toBe(topic);
    expect(emitted[0].data.action).toBe('stopped');
    expect(emitted[0].data.runId).toBe(autonomousRunId(startedAt, String(topic)));
  });

  it('does not throw when no seam is injected (seam is optional)', async () => {
    const topic = 9984;
    writeAutonomousJob(topic, '2026-06-05T01:00:00.000Z');

    // No setCoherenceJournalSeam call — seam stays undefined.
    (adapter as unknown as { topicToSession: Map<number, string> }).topicToSession.set(topic, 'tmux-sess');
    adapter.onSentinelKillSession = () => true;
    adapter.onSentinelIntercept = async () => ({
      category: 'emergency-stop' as const,
      action: { type: 'kill' },
      reason: 'stop',
    });

    await expect(
      (adapter as unknown as { processUpdate: (u: unknown) => Promise<void> }).processUpdate(
        textUpdate(topic, 'stop'),
      ),
    ).resolves.toBeUndefined();

    // The stop still happened; no emit because no seam.
    expect(fs.existsSync(path.join(tmpDir, 'autonomous', `${topic}.local.md`))).toBe(false);
    expect(emitted).toHaveLength(0);
  });
});
