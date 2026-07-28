/**
 * Wiring-integrity for the false-positive fix (live incident 2026-06-24). A guard
 * that compiles but is wired to a no-op (always-recoverable) would silently keep the
 * bug. These assert server.ts:
 *   1. derives isSessionRecoverable from the REAL running-set (listRunningSessions),
 *      not a `() => true` stub;
 *   2. hands that SAME guard to BOTH sentinels;
 *   3. clears BOTH sentinels on sessionComplete (the cleanup that never existed).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('isSessionRecoverable wiring integrity', () => {
  it('derives the guard from the real running set, not a stub', () => {
    // Must reference listRunningSessions in the guard — a `() => true` would be the
    // "shipped inert" failure mode.
    expect(SERVER_SRC).toMatch(/const isSessionRecoverable[\s\S]{0,200}listRunningSessions/);
    expect(SERVER_SRC).not.toMatch(/isSessionRecoverable\s*=\s*\(\s*\)\s*=>\s*true/);
  });

  it('passes the guard to BOTH the compaction and rate-limit sentinels', () => {
    // The dep name appears at least twice (one per sentinel deps object).
    const occurrences = (SERVER_SRC.match(/\bisSessionRecoverable\b/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3); // 1 definition + 2 wirings
  });

  it('clears BOTH sentinels on sessionComplete (the missing completion cleanup)', () => {
    // The handler must call clear() on both — without it a finished session lingers
    // as a recovery target (and clear() previously had ZERO callers).
    const block = SERVER_SRC.match(/sessionManager\.on\('sessionComplete'[\s\S]{0,400}?\}\);/g) ?? [];
    const joined = block.join('\n');
    expect(joined).toContain('rateLimitSentinel.clear');
    expect(joined).toContain('compactionSentinel.clear');
  });
});
