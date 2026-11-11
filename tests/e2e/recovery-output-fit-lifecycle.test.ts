// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e (context-budget-layered-summaries §9.1, Phase 0 results check 4): on the
 * real update path, `PostUpdateMigrator.migrate()` installs the recovery-output
 * fitter beside the hooks, and the INSTALLED session-start hook, given a
 * compaction start whose recovery seed is ~45 KB (the measured size), prints
 * at most 10,000 characters — the size Claude Code passes to the model whole —
 * keeping the recovery marker and the newest conversation, and saves the full
 * block where the session is told to read it. A second run (re-migration) is
 * idempotent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/recovery-output-fit-lifecycle.test.ts';

describe('recovery output fits the hook limit — installed by the real update path', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  it('migrate() installs the fitter, and the installed hook delivers a ≤10K block with the full one saved', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfit-e2e-')); dirs.push(projectDir);
    const stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 1, projectName: 'e2e' }));
    const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 1, authToken: 'test-token', agentName: 'e2e' } as never);
    migrator.migrate();
    migrator.migrate(); // idempotent re-run
    const hooks = path.join(stateDir, 'hooks', 'instar');
    expect(fs.existsSync(path.join(hooks, 'fit-recovery-output.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(hooks, 'session-start.sh'))).toBe(true);
    // Replace the recovery seed with a measured-size block (the real one needs a server).
    const lines = ['=== IDENTITY RECOVERY (post-compaction) ===', '--- CONVERSATION CONTEXT (Topic: 9, 40 total messages) ---'];
    for (let i = 0; i < 80; i++) lines.push(`[10:${i}] User: message ${i} ${'context '.repeat(10)}`);
    lines.push('LATEST-USER-LINE', '--- END CONVERSATION CONTEXT ---', '--- Your Identity (from .instar/AGENT.md) ---', 'x'.repeat(28_000), '--- End Identity ---', '=== END IDENTITY RECOVERY ===');
    const block = lines.join('\n');
    expect(block.length).toBeGreaterThan(30_000);
    const seed = path.join(projectDir, 'seed.txt');
    fs.writeFileSync(seed, block);
    fs.writeFileSync(path.join(hooks, 'compaction-recovery.sh'), `#!/bin/bash\ncat "${seed}"\n`, { mode: 0o755 });
    const r = spawnSync('bash', [path.join(hooks, 'session-start.sh')], {
      input: JSON.stringify({ source: 'compact', session_id: 'e2e-session' }),
      env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 30_000, encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(10_000);
    expect(r.stdout).toContain('=== IDENTITY RECOVERY (post-compaction) ===');
    expect(r.stdout).toContain('LATEST-USER-LINE');
    const saved = path.join(stateDir, 'state', 'context-layers', '_recovery', 'e2e-session.txt');
    expect(r.stdout).toContain(saved);
    expect(fs.readFileSync(saved, 'utf-8').trimEnd()).toBe(block.trimEnd());
  });
});
