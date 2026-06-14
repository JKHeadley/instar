// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Honest Session Recycle — wiring/integration (honest-session-recycle-spec).
 *
 * Composes the REAL `autonomousRunRemainingForTopic` helper with the REAL
 * ReapNotifier over a temp stateDir — proving the two production pieces wire
 * together (the dep is non-null and delegates to the real run-window read), not
 * a mock-against-mock. This is the wiring-integrity tier for the additive
 * `autonomousRunActiveFor` dep the server provides in `commands/server.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReapNotifier } from '../../src/monitoring/ReapNotifier.js';
import { autonomousRunRemainingForTopic } from '../../src/core/AutonomousSessions.js';

let stateDir: string;

function writeRun(topic: string, durationSeconds: number, startedAt: string) {
  fs.mkdirSync(path.join(stateDir, 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'autonomous', `${topic}.local.md`),
    `---\nactive: true\npaused: false\niteration: 5\ngoal: "run ${topic}"\nstarted_at: "${startedAt}"\nduration_seconds: ${durationSeconds}\nreport_topic: "${topic}"\n---\n\ntask\n`,
  );
}

/** Build a notifier wired EXACTLY as server.ts wires it: the autonomousRunActiveFor
 *  dep delegates to the real helper via a topic resolver. */
function makeWiredNotifier(topicForSession: Record<string, number>) {
  const rows: Array<{ topic_id: number; text: string }> = [];
  const n = new ReapNotifier(
    {
      resolveTopic: (tmux) => topicForSession[tmux] ?? null,
      lifelineTopic: () => 999,
      send: () => {},
      enqueueNotice: (input) => { rows.push({ topic_id: input.topic_id, text: input.text }); return true; },
      recordNotify: () => {},
      summaryReleaseAt: (now) => now + 10 * 60_000,
      // The production wiring (server.ts): topic → real run-window read.
      autonomousRunActiveFor: (tmux) => {
        const topic = topicForSession[tmux];
        if (topic == null) return null;
        return autonomousRunRemainingForTopic(stateDir, topic);
      },
      now: () => new Date('2026-06-14T06:57:00Z').getTime(),
    },
    { enabled: true, coalesceWindowMs: 60_000, maxBuffer: 100, perTopic: true, maxImmediatePerFlush: 5, drainEnabled: true },
  );
  return { n, rows };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Pin the system clock so BOTH the notifier's now() AND the real helper's
  // internal Date.now() (the production wiring passes no nowMs) agree.
  vi.setSystemTime(new Date('2026-06-14T06:57:00Z'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-recycle-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('Honest Session Recycle — real helper composed with real notifier', () => {
  it('age-limit reap of a topic with a real in-flight run renders the honest recycle copy', async () => {
    writeRun('13481', 86400, '2026-06-13T18:40:00Z'); // ~11h43m left at the frozen now
    const { n, rows } = makeWiredNotifier({ 'echo-instar-exo': 13481 });
    n.onReaped({ session: { name: 'instar-exo', tmuxSession: 'echo-instar-exo' }, reason: 'age-limit', disposition: 'terminal' });
    await n.flush();
    expect(rows).toHaveLength(1);
    expect(rows[0].topic_id).toBe(13481);
    expect(rows[0].text).toContain('🔄');
    expect(rows[0].text).toContain('recycled');
    expect(rows[0].text).toMatch(/11h 4\dm left/); // real computed remaining
    expect(rows[0].text).not.toContain('maximum allowed runtime');
  });

  it('age-limit reap of a topic with NO autonomous run file gets the terminal death copy', async () => {
    // No run written for topic 555.
    const { n, rows } = makeWiredNotifier({ 'echo-bg': 555 });
    n.onReaped({ session: { name: 'bg', tmuxSession: 'echo-bg' }, reason: 'age-limit', disposition: 'terminal' });
    await n.flush();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain('🪦');
    expect(rows[0].text).toContain('maximum allowed runtime');
  });
});
