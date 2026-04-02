/**
 * PresenceProxy session idle detection — validates that when a session
 * completes work and reaches an idle prompt, standby tiers 2/3 are
 * suppressed to avoid noise after the agent has finished.
 *
 * Root cause: When an agent completes work but doesn't relay its response
 * to Telegram, the PresenceProxy would fire all three tiers — tier 1
 * (useful summary), tier 2 (redundant "still working"), and tier 3
 * (false "appears stuck"). The agent finished; further updates are noise.
 */

import { describe, it, expect } from 'vitest';
import { detectSessionIdle } from '../../src/monitoring/PresenceProxy.js';

describe('Session idle detection', () => {
  it('detects standard Claude Code idle prompt (❯)', () => {
    const snapshot = `⏺ Analysis complete. Here are the findings.

────────────────────────────────────────
❯
────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;
    expect(detectSessionIdle(snapshot)).toBe(true);
  });

  it('detects > prompt', () => {
    const snapshot = `Done with the task.
> `;
    expect(detectSessionIdle(snapshot)).toBe(true);
  });

  it('detects $ prompt', () => {
    const snapshot = `Build complete.
$ `;
    expect(detectSessionIdle(snapshot)).toBe(true);
  });

  it('detects bypass permissions line without explicit prompt', () => {
    const snapshot = `Some output
bypass permissions on (shift+tab to cycle)`;
    expect(detectSessionIdle(snapshot)).toBe(true);
  });

  it('returns false for active output (no prompt)', () => {
    const snapshot = `Reading file src/index.ts
Editing src/components/Header.tsx
Running npm test...
All 42 tests passed
Creating new commit with changes`;
    expect(detectSessionIdle(snapshot)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(detectSessionIdle('')).toBe(false);
  });

  it('returns false when prompt is NOT in last 5 lines', () => {
    const snapshot = `❯
line 1
line 2
line 3
line 4
line 5
still working on something`;
    expect(detectSessionIdle(snapshot)).toBe(false);
  });

  it('returns true when prompt is within last 5 lines', () => {
    const snapshot = `some earlier output
more output
❯
────────────────────────────────────────`;
    expect(detectSessionIdle(snapshot)).toBe(true);
  });
});
