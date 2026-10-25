/**
 * Tests for Telegram injection reliability improvements (PR #32):
 * - rawInject crash-safe effect journaling (no blind retry after mutation starts)
 * - Failed message persistence to stateDir (not world-readable /tmp)
 * - cleanupStaleSessions hard cap prunes oldest completed sessions first
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SESSION_MANAGER_SRC = path.join(process.cwd(), 'src/core/SessionManager.ts');
const ROUTES_SRC = path.join(process.cwd(), 'src/server/routes.ts');
const DISPATCHER_SRC = path.join(process.cwd(), 'src/core/TrackedPhysicalEffectDispatcher.ts');

describe('SessionManager — rawInject effect safety', () => {
  it('persists armed and started phases before the physical send', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('private rawInject(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    const dispatcher = fs.readFileSync(DISPATCHER_SRC, 'utf-8');
    expect(method).toContain('trackedPhysicalEffects!.dispatchSync');
    expect(dispatcher).toContain("'prepared', 'dispatch-armed'");
    expect(dispatcher).toContain("'dispatch-armed', 'dispatch-started'");
    expect(method).toContain('effect: () => this.performTmuxInjectionEffect');
  });

  it('does not blindly retry after an ambiguous physical mutation', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('private rawInject(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    const dispatcher = fs.readFileSync(DISPATCHER_SRC, 'utf-8');
    expect(dispatcher).toContain("'dispatch-started', 'effect-unknown'");
    expect(method).not.toContain('maxAttempts');
  });

  it('journals only sessions with the Codex acceptance observer', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('private rawInject(');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    expect(method).toContain("this.stageBActivation.active && framework === 'codex-cli'");
    expect(method).toContain('Refusing unverifiable Codex injection');
    expect(method).not.toContain("framework: framework ?? 'unknown'");
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
  it('prunes oldest terminal sessions first when over the maxFinished cap (default 50)', () => {
    const source = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');
    const methodStart = source.indexOf('cleanupStaleSessions(): string[]');
    const methodEnd = source.indexOf('\n  /**', methodStart + 1);
    const method = source.slice(methodStart, methodEnd > -1 ? methodEnd : undefined);

    // Hard cap (config-tunable via sessions.retention.maxFinished, default 50 —
    // session-listing hygiene, CMT-1936; behavioral coverage lives in
    // tests/unit/SessionManager-retention.test.ts)
    expect(method).toContain('MAX_FINISHED');
    expect(method).toContain("posNum(retention?.maxFinished, 50)");

    // Sort ascending by endedAt so oldest come first
    expect(method).toContain('a.endedAt - b.endedAt');

    // Slice the excess (oldest end of the sorted array)
    expect(method).toContain('slice(0, retained.length - MAX_FINISHED)');
  });
});
