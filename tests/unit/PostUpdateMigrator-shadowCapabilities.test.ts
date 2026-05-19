/**
 * Verifies the migrateFrameworkShadowCapabilities shim added for the
 * cross-framework portability audit (Gap 6 — operator-chosen "minimal shim"
 * approach). The shim mirrors capability-instruction sections from the
 * patched CLAUDE.md into AGENTS.md/GEMINI.md when those shadows exist,
 * so Codex/Gemini agents get the same "here's what you can do" instructions
 * as Claude Code (identity is already mirrored by Gap 1).
 *
 * Bodies are literally copied from CLAUDE.md, never duplicated in source,
 * so the two cannot drift.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function migrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test-agent',
  });
}

function runShadowCaps(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateFrameworkShadowCapabilities(r: MigrationResult): void }).migrateFrameworkShadowCapabilities(result);
  return result;
}

const CLAUDE_MD_FIXTURE = `# CLAUDE.md — instar

## What This Project Is

Intro text.

### Self-Discovery (Know Before You Claim)

Before claiming a missing capability, curl the live capabilities endpoint.

**Private Viewing** — Render markdown as auth-gated HTML.
Inline body.

**Dashboard** — Visual web interface.
More inline body.

### Coherence Gate (Pre-Action Verification)

Check coherence before high-risk actions.

## Threadline Network (Agent-to-Agent Communication)

Encrypted agent-to-agent messaging.
`;

describe('PostUpdateMigrator — migrateFrameworkShadowCapabilities (Gap 6 minimal shim)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-shadow-cap-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-shadowCapabilities.test.ts',
    });
  });

  it('appends missing capability sections to AGENTS.md from CLAUDE.md', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    fs.writeFileSync(
      path.join(projectDir, 'AGENTS.md'),
      '# Echo\n\nCanonical identity body (no capability sections yet).\n',
    );

    const result = runShadowCaps(migrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.startsWith('AGENTS.md:'))).toBe(true);

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('### Self-Discovery');
    expect(agents).toContain('**Private Viewing**');
    expect(agents).toContain('**Dashboard**');
    expect(agents).toContain('### Coherence Gate');
    expect(agents).toContain('## Threadline Network');
    // canonical identity preserved
    expect(agents).toContain('Canonical identity body');
  });

  it('is idempotent — second run does not re-append', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Echo\n\nidentity\n');

    runShadowCaps(migrator(projectDir));
    const first = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    const result2 = runShadowCaps(migrator(projectDir));
    const second = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');

    expect(second).toBe(first);
    expect(result2.upgraded.some(u => u.startsWith('AGENTS.md:'))).toBe(false);
    expect(result2.skipped.some(s => s.includes('already present'))).toBe(true);
  });

  it('mirrors into BOTH AGENTS.md and GEMINI.md when both exist', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# id\n');
    fs.writeFileSync(path.join(projectDir, 'GEMINI.md'), '# id\n');

    const result = runShadowCaps(migrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8')).toContain('### Self-Discovery');
    expect(fs.readFileSync(path.join(projectDir, 'GEMINI.md'), 'utf-8')).toContain('### Self-Discovery');
  });

  it('no-op when no shadow exists (Claude-only install)', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);

    const result = runShadowCaps(migrator(projectDir));

    expect(result.upgraded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('no-op (with note) when CLAUDE.md is absent', () => {
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# id\n');

    const result = runShadowCaps(migrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('CLAUDE.md absent'))).toBe(true);
  });

  it('preserves identity content above the appended sections', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), CLAUDE_MD_FIXTURE);
    const identity = '# Echo identity\n\n## Who I am\n\nThe Echo agent.\n';
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), identity);

    runShadowCaps(migrator(projectDir));

    const agents = fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf-8');
    expect(agents.startsWith(identity.trimEnd())).toBe(true);
  });
});
