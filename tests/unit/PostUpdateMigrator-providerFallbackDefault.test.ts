/**
 * Verifies PostUpdateMigrator appends the Provider-Fallback Default Policy CLAUDE.md
 * subsection (Agent Awareness + Migration Parity, docs/specs/provider-fallback-default-policy.md §8).
 *
 * The migration is content-sniffed on the NEW marker `run off Claude by default` —
 * NOT the existing `Per-Component Framework Routing` heading (which is on every
 * deployed agent ⇒ would silently no-op and leave the stale "opt-in / heuristic"
 * text). This test pins exactly that: an agent that ALREADY has the old routing
 * heading still gets the corrective subsection appended.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Provider-Fallback Default Policy CLAUDE.md subsection', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-provfallback-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-providerFallbackDefault.test.ts:cleanup',
    });
  });

  it('appends the subsection (on the NEW marker) even when the old routing heading already exists', () => {
    // Simulate a DEPLOYED agent: it already has the old Per-Component Framework Routing
    // heading + the stale "opt-in" framing — the exact case the marker choice protects.
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Per-Component Framework Routing\n\nRouting is opt-in; with no config, everything stays on your default framework. pi-cli is the pi harness.\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('Provider-Fallback Default Policy'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('run off Claude by default');
    // names the chain, the {} rollback, and the swapAttemptTimeoutMs cap.
    expect(after).toContain('codex-cli → pi-cli → gemini-cli → claude-code');
    expect(after).toContain('swapAttemptTimeoutMs');
    expect(after).toContain('`{}`');
  });

  it('is idempotent — a second run does not re-append (marker already present)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n## Per-Component Framework Routing\n\nopt-in. pi-cli.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('Provider-Fallback Default Policy'))).toBe(false);
    // the subsection's bold heading appears exactly once (no duplicate append).
    expect(afterSecond.split('Internal components run off Claude by default (Provider-Fallback Default Policy)').length - 1).toBe(1);
  });

  it('does NOT collide with the pi-cli migration guard (the marker has no bare pi-cli token)', () => {
    // The migration must not be gated by the pi-cli guard at PostUpdateMigrator.ts:5525,
    // which keys on `!content.includes("pi-cli")`. Our marker is `run off Claude by
    // default` — it contains no bare `pi-cli` token, so an agent that already has the
    // pi-cli note still receives THIS subsection.
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Per-Component Framework Routing\n\nopt-in.\n\n**Pi framework (additive)** — `pi-cli` is a valid fourth framework value.\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(result.upgraded.some((u) => u.includes('Provider-Fallback Default Policy'))).toBe(true);
    expect(after).toContain('run off Claude by default');
  });
});
