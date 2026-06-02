/**
 * Unit test — spinner-immune liveness signal (task #63).
 *
 * Bug: OutputActivityTracker hashed the raw captured pane. Claude/codex/gemini
 * "working" spinners tick an elapsed-time counter every second, so the hash
 * changed on every poll even when the turn produced no real output — keeping
 * `lastChangeAt` perpetually fresh and blinding ActiveWorkSilenceSentinel to a
 * stalled-but-spinning turn (the 26-min API-stall incident). Fix: hash a
 * spinner-immune view (stripVolatileStatus). Cross-model reviewed by Codey
 * (the silence nudge is non-destructive `Enter`, so a long-generation
 * false-positive is harmless; destructive Ctrl-C stays in SocketDisconnectSentinel
 * behind a positive error-string marker).
 */

import { describe, it, expect } from 'vitest';
import {
  stripVolatileStatus,
  OutputActivityTracker,
  type SentinelSessionSurface,
} from '../../src/monitoring/sentinelWiring.js';

describe('stripVolatileStatus — only real content survives', () => {
  it('two frames differing ONLY in the Claude spinner clock normalize-equal', () => {
    const a = 'Read(foo.ts)\n  reading...\n✻ Sautéed for 26m 16s · (esc to interrupt)';
    const b = 'Read(foo.ts)\n  reading...\n✻ Sautéed for 26m 59s · (esc to interrupt)';
    expect(stripVolatileStatus(a, 'claude-code')).toBe(stripVolatileStatus(b, 'claude-code'));
  });

  it('a frame with NEW real output normalizes-different', () => {
    const a = 'line one\n✻ Working (0m 06s · esc to interrupt)';
    const b = 'line one\nline two\n✻ Working (0m 07s · esc to interrupt)';
    expect(stripVolatileStatus(a, 'claude-code')).not.toBe(stripVolatileStatus(b, 'claude-code'));
  });

  it('codex "Working (Ns · esc to interrupt)" clock is normalized away', () => {
    const a = '• Ran tests\n• Working (12s · esc to interrupt)';
    const b = '• Ran tests\n• Working (47s · esc to interrupt)';
    expect(stripVolatileStatus(a, 'codex-cli')).toBe(stripVolatileStatus(b, 'codex-cli'));
  });

  it('does NOT over-strip benign content that merely contains a number+s', () => {
    const out = 'Build completed in 5s\nAll 12 tests passed';
    expect(stripVolatileStatus(out, 'claude-code')).toContain('completed in 5s');
    expect(stripVolatileStatus(out, 'claude-code')).toContain('12 tests passed');
  });

  it('empty input is returned unchanged', () => {
    expect(stripVolatileStatus('', 'claude-code')).toBe('');
  });
});

describe('OutputActivityTracker — spinner ticks no longer fake activity', () => {
  function harness(framework: 'claude-code' | 'codex-cli' | 'gemini-cli' = 'claude-code') {
    let frame = '';
    let now = 0;
    const sessions: SentinelSessionSurface = {
      listRunningSessions: () => [{ tmuxSession: 'sess', framework }],
      captureOutput: () => frame,
    };
    const tracker = new OutputActivityTracker(sessions, () => now);
    return {
      step: (f: string, t: number) => {
        frame = f;
        now = t;
        return tracker.snapshot()[0];
      },
    };
  }

  const spin = (body: string, clock: string) => `${body}\n✻ Working (${clock} · esc to interrupt)`;

  it('holds lastOutputAt across spinner-only ticks, advances on real output', () => {
    const h = harness();
    // tick 1: first sighting → baseline only (lastOutputAt 0, "frozen before watched" guard)
    expect(h.step(spin('content X', '0m 05s'), 1000).lastOutputAt).toBe(0);
    // tick 2: real new output (line Y) → observed change → stamp now=2000
    expect(h.step(spin('content X\nline Y', '0m 06s'), 2000).lastOutputAt).toBe(2000);
    // tick 3: ONLY the spinner clock advanced → no real change → HOLD 2000 (the fix)
    expect(h.step(spin('content X\nline Y', '0m 07s'), 3000).lastOutputAt).toBe(2000);
    // tick 4: spinner clock again → still HOLD 2000 → idle now measurably grows
    expect(h.step(spin('content X\nline Y', '0m 09s'), 5000).lastOutputAt).toBe(2000);
    // tick 5: genuine new output → advances (no regression for real work)
    expect(h.step(spin('content X\nline Y\nline Z', '0m 10s'), 6000).lastOutputAt).toBe(6000);
  });

  it('a spinning-but-frozen turn remains a silence candidate (not paused)', () => {
    const h = harness();
    h.step(spin('working', '0m 05s'), 1000);
    const entry = h.step(spin('working', '0m 06s'), 2000);
    // still "looks actively working" (spinner present) → not paused → silence-eligible
    expect(entry.paused).toBe(false);
  });
});
