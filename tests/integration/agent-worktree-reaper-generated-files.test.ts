/**
 * The worktree reaper's generated-files path over a REAL temporary git worktree
 * (docs/specs/reaper-generated-files-regenerable.md, Testing):
 *   - a merged checkout holding only the repo's generated files and a real husky
 *     install is reported eligible, with its projected residue and reclaim bytes;
 *   - the full remove path archives every residue file byte for byte and writes
 *     nothing into the target checkout's `.instar/audit/` (the executors log to
 *     their own audit location, INSTAR_AUDIT_LOG_DIR here);
 *   - INSTAR_AUDIT_LOG_DIR pointing inside the checkout keeps it.
 * Removal runs only on this test's own reaper instance; the shipped default stays dry-run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeAgentWorktreeReaperDeps, ARCHIVED_RESIDUE_FILES } from '../../src/monitoring/agentWorktreeGit.js';
import { AgentWorktreeReaper, DEFAULT_AGENT_WORKTREE_REAPER_CONFIG } from '../../src/monitoring/AgentWorktreeReaper.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/agent-worktree-reaper-generated-files.test.ts';
const HUSKY_INDEX = new URL('../../node_modules/husky/index.js', import.meta.url).href;

describe('AgentWorktreeReaper generated files over a real git worktree (integration)', () => {
  let root: string;
  let home: string;
  let worktreesDir: string;
  let merged: string;
  let auditOut: string;
  let archive: string;
  const savedAuditDir = process.env.INSTAR_AUDIT_LOG_DIR;
  const savedAuditOff = process.env.INSTAR_AUDIT_LOG_DISABLED;

  const g = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: OP });
  const write = (base: string, rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), body);
  };
  const filesUnder = (dir: string): Map<string, Buffer> => {
    const out = new Map<string, Buffer>();
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isFile()) out.set(e.name, fs.readFileSync(path.join(dir, e.name)));
    return out;
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awr-gen-int-')));
    home = path.join(root, 'agent-home');
    fs.mkdirSync(home);
    g(home, ['init', '-q', '-b', 'main']);
    g(home, ['config', 'user.email', 't@t.l']);
    g(home, ['config', 'user.name', 'T']);
    g(home, ['config', 'commit.gpgsign', 'false']);
    write(home, '.gitignore', [
      'src/data/standards-registry.md', 'src/data/standards-registry.meta.json', 'src/data/standards-guard-index.json',
      'src/data/standards-guard-index.meta.json', 'src/data/builtin-manifest.json', '.instar/audit/',
      '.instar/standards-coverage.json', '.instar/dup-build-cache.json', '.instar/docs-coverage.json', '.instar/docs-coverage.md',
      'logs/', 'node_modules', '',
    ].join('\n'));
    write(home, 'docs/STANDARDS-REGISTRY.md', '# Registry\n');
    write(home, 'src/data/README.md', 'data');
    write(home, '.instar/README.md', 'state');
    write(home, '.husky/pre-commit', 'exit 0\n');
    g(home, ['add', '-A']);
    g(home, ['commit', '-qm', 'init']);
    worktreesDir = path.join(home, '.worktrees');
    fs.mkdirSync(worktreesDir);
    merged = path.join(worktreesDir, 'merged');
    g(home, ['worktree', 'add', '-q', merged, '-b', 'feat-merged', 'HEAD']);
    // A real change, merged into main by fast-forward.
    write(merged, 'src/feature.ts', 'export const x = 1;\n');
    g(merged, ['add', 'src/feature.ts']);
    g(merged, ['commit', '-qm', 'feature']);
    g(home, ['merge', '-q', '--ff-only', 'feat-merged']);
    // What a build, `npm run prepare` (husky) and the executors leave behind.
    fs.copyFileSync(path.join(merged, 'docs', 'STANDARDS-REGISTRY.md'), path.join(merged, 'src', 'data', 'standards-registry.md'));
    for (const rel of Object.keys(ARCHIVED_RESIDUE_FILES)) write(merged, rel, `{"generated":"${rel}"}\n`);
    write(merged, '.instar/audit/destructive-ops.jsonl', '{"op":"safeUnlinkSync"}\n');
    write(merged, '.instar/audit/credential-resolution.jsonl', '{"kind":"resolution"}\n');
    const env = { ...process.env };
    delete env.HUSKY;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import h from ${JSON.stringify(HUSKY_INDEX)}; const r = h(); if (r) { console.error(r); process.exit(1); }`], { cwd: merged, env, stdio: 'pipe' });
    // Siblings that must stay: an unlisted ignored file, and a real node_modules.
    g(home, ['worktree', 'add', '-q', path.join(worktreesDir, 'with-logs'), '-b', 'feat-logs', 'HEAD']);
    write(path.join(worktreesDir, 'with-logs'), 'logs/run.log', 'unique');
    g(home, ['worktree', 'add', '-q', path.join(worktreesDir, 'real-nm'), '-b', 'feat-nm', 'HEAD']);
    write(path.join(worktreesDir, 'real-nm'), 'node_modules/dep/index.js', 'maybe patched');

    auditOut = path.join(root, 'audit-out');
    fs.mkdirSync(auditOut);
    archive = path.join(home, '.instar', 'instar-dev-decisions-archive');
    delete process.env.INSTAR_AUDIT_LOG_DISABLED;
  });

  afterEach(() => {
    if (savedAuditDir === undefined) delete process.env.INSTAR_AUDIT_LOG_DIR; else process.env.INSTAR_AUDIT_LOG_DIR = savedAuditDir;
    if (savedAuditOff === undefined) delete process.env.INSTAR_AUDIT_LOG_DISABLED; else process.env.INSTAR_AUDIT_LOG_DISABLED = savedAuditOff;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  const deps = () => makeAgentWorktreeReaperDeps({ instarRepo: home, worktreesDir, githubMergeCheck: false });

  it('ships dry-run, and a dry run reports the merged generated-files checkout eligible with its projection', async () => {
    expect(DEFAULT_AGENT_WORKTREE_REAPER_CONFIG.dryRun).toBe(true);
    const reaper = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true });
    const pass = await reaper.reap();
    const by = Object.fromEntries(pass.evaluations.map((e) => [path.basename(e.path), e]));
    expect(by.merged.verdict).toBe('reap-eligible');
    expect(by['with-logs'].reason).toBe('uncommitted-changes');
    expect(by['real-nm'].reason).toBe('uncommitted-changes');
    expect(by['real-nm'].nodeModules).toBe('real');
    expect(pass.reaped).toEqual([]);
    expect(fs.existsSync(merged)).toBe(true);
    expect(fs.existsSync(archive)).toBe(false);

    let residue = 0;
    for (const rel of Object.keys(ARCHIVED_RESIDUE_FILES)) residue += fs.statSync(path.join(merged, rel)).size;
    for (const d of ['.instar/audit', '.husky/_']) for (const [, b] of filesUnder(path.join(merged, d))) residue += b.length;
    expect(by.merged.projection?.residueBytes).toBe(residue);
    expect(by.merged.projection!.apparentBytes).toBeGreaterThan(residue);

    const snap = reaper.snapshot();
    expect(snap.reclaimable).toBe(1);
    expect(snap.projection).toEqual({ eligible: 1, measured: 1, residueBytes: residue, apparentBytes: by.merged.projection!.apparentBytes });
    expect(snap.nodeModules.keptForRealNodeModules).toBe(1);
    expect(snap.archiveBytes).toBe(0);
  });

  it('the full remove path archives every residue file and writes nothing into the checkout\'s .instar/audit/', async () => {
    process.env.INSTAR_AUDIT_LOG_DIR = auditOut;
    const auditBefore = filesUnder(path.join(merged, '.instar', 'audit'));
    const huskyBefore = filesUnder(path.join(merged, '.husky', '_'));
    expect(auditBefore.size).toBe(2);
    expect(huskyBefore.size).toBeGreaterThan(5);

    const reaper = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: false });
    const errors: unknown[] = [];
    reaper.on('error', (e) => errors.push(e));
    const pass = await reaper.reap();
    expect(errors).toEqual([]);
    expect(pass.reaped).toEqual([merged]);
    expect(fs.existsSync(merged)).toBe(false);
    expect(fs.existsSync(path.join(worktreesDir, 'with-logs', 'logs', 'run.log'))).toBe(true);
    expect(fs.existsSync(path.join(worktreesDir, 'real-nm', 'node_modules', 'dep', 'index.js'))).toBe(true);

    // The archived audit trail is exactly the checkout's audit trail before the
    // remove path ran: same names, same bytes, nothing added. The final re-check
    // compared these hashes against the checkout right before `git worktree remove`.
    const archivedAudit = filesUnder(path.join(archive, 'merged', '.instar', 'audit'));
    expect([...archivedAudit.keys()].sort()).toEqual([...auditBefore.keys()].sort());
    for (const [name, bytes] of auditBefore) expect(archivedAudit.get(name)!.equals(bytes), name).toBe(true);
    const archivedHusky = filesUnder(path.join(archive, 'merged', '.husky', '_'));
    expect([...archivedHusky.keys()].sort()).toEqual([...huskyBefore.keys()].sort());
    for (const rel of Object.keys(ARCHIVED_RESIDUE_FILES)) {
      expect(fs.readFileSync(path.join(archive, 'merged', rel), 'utf8')).toBe(`{"generated":"${rel}"}\n`);
    }
    // The executors logged the removal to their own audit location, not the checkout's.
    const log = fs.readFileSync(path.join(auditOut, 'destructive-ops.jsonl'), 'utf8');
    expect(log).toContain('agentWorktreeGit.ts:removeWorktree');
  });

  it('INSTAR_AUDIT_LOG_DIR pointing inside the checkout keeps it', async () => {
    // With the audit trail pointed into the checkout, the executors' own reads append
    // there during evaluation, so this is exactly the case removal must refuse.
    process.env.INSTAR_AUDIT_LOG_DIR = path.join(merged, '.instar', 'audit');
    const reaper = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: false });
    const errors: unknown[] = [];
    reaper.on('error', (e) => errors.push(e));
    const pass = await reaper.reap();
    expect(pass.reaped).toEqual([]);
    expect(String(errors[0])).toMatch(/INSTAR_AUDIT_LOG_DIR/);
    expect(fs.existsSync(merged)).toBe(true);
    expect(fs.existsSync(path.join(merged, '.instar', 'audit', 'destructive-ops.jsonl'))).toBe(true);
    expect(fs.existsSync(archive)).toBe(false); // refused before anything was copied or deleted
  });
});
