/**
 * Tests for Telegram injection reliability improvements (PR #32):
 * - rawInject retry logic (≤2 attempts before giving up)
 * - Failed message persistence to stateDir (not world-readable /tmp)
 * - cleanupStaleSessions hard cap prunes oldest completed sessions first
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_MANAGER_SRC = path.join(process.cwd(), 'src/core/SessionManager.ts');
const ROUTES_SRC = path.join(process.cwd(), 'src/server/routes.ts');

describe('SessionManager — rawInject retry logic', () => {
  it('retries at most once (maxAttempts = 2)', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('private rawInject(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    expect(method).toContain('maxAttempts = 2');
    expect(method).toContain('attempt <= maxAttempts');
  });

  it('pauses between retry attempts', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('private rawInject(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    // Should sleep between attempts, not immediately retry
    expect(method).toContain('sleep');
    expect(method).toContain('attempt < maxAttempts');
  });

  it('returns false and reports degradation after all attempts fail', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('private rawInject(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    expect(method).toContain('DegradationReporter');
    expect(method).toContain('return false');
  });
});

describe('routes.ts — failed message persistence', () => {
  it('saves failed messages to stateDir, not /tmp', () => {
    const source = fs.readFileSync(ROUTES_SRC, 'utf-8');

    // Find the injection failure block
    const failBlock = source.slice(
      source.indexOf('Injection failed — save message'),
      source.indexOf('Injection failed — save message') + 400,
    );

    // Must use stateDir
    expect(failBlock).toContain('ctx.config.stateDir');
    // Must NOT use /tmp directly
    expect(failBlock).not.toContain("path.join('/tmp'");
  });

  it('stores under state/failed-messages subdirectory', () => {
    const source = fs.readFileSync(ROUTES_SRC, 'utf-8');
    expect(source).toContain("'state', 'failed-messages'");
  });
});

describe('SessionManager — cleanupStaleSessions hard cap', () => {
  it('prunes oldest completed sessions first when over the 50-session cap', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('cleanupStaleSessions(): string[]');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    // Hard cap constant
    expect(method).toContain('MAX_COMPLETED');
    expect(method).toContain('50');

    // Sort ascending by endedAt so oldest come first
    expect(method).toContain('a.endedAt - b.endedAt');

    // Slice the excess (oldest end of the sorted array)
    expect(method).toContain('slice(0, completed.length - MAX_COMPLETED)');
  });
});
