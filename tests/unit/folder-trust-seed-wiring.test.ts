/**
 * Wiring integrity for the per-project folder-trust seed.
 *
 * The seeding util is only as good as the callers that ask it to do the job.
 * `ensureInteractiveReady` seeds the folder-trust entry ONLY when handed a
 * `projectDir`; a caller that omits it gets the old behaviour — a home that
 * reports "already interactive-ready" and still kills every session it
 * launches at "Do you trust the files in this folder?" (Mac Mini, 2026-10-20:
 * three sessions, each dead in 16 seconds, 35 minutes of apparent silence).
 *
 * So every live caller must pass it, and that includes the PostUpdateMigrator
 * sweep — an agent already deployed receives this fix through no other path
 * (Migration Parity Standard).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function src(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}

/** The `ensureInteractiveReady(` call plus enough of what follows to see its options. */
function callsWithProjectDir(source: string): boolean[] {
  const results: boolean[] = [];
  let idx = source.indexOf('ensureInteractiveReady(');
  while (idx !== -1) {
    results.push(source.slice(idx, idx + 400).includes('projectDir'));
    idx = source.indexOf('ensureInteractiveReady(', idx + 1);
  }
  return results;
}

describe('every live caller seeds folder trust', () => {
  it('SessionManager passes the agent directory', () => {
    const calls = callsWithProjectDir(src('src/core/SessionManager.ts'));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(Boolean)).toBe(true);
  });

  it('SessionRefresh passes it for the account-swap target', () => {
    const calls = callsWithProjectDir(src('src/core/SessionRefresh.ts'));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(Boolean)).toBe(true);
  });

  it('PostUpdateMigrator passes it — the only path a deployed agent gets this through', () => {
    const calls = callsWithProjectDir(src('src/core/PostUpdateMigrator.ts'));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(Boolean)).toBe(true);
  });

  it('SessionManager exposes the agent directory for callers that only hold it', () => {
    expect(src('src/core/SessionManager.ts')).toContain('agentProjectDir()');
  });
});
