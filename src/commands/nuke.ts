/**
 * `instar nuke <name>` — Completely remove a standalone agent.
 *
 * Cleans up ALL artifacts:
 *   1. Stop the running server (tmux session)
 *   2. Remove auto-start (launchd/systemd)
 *   3. Push any uncommitted changes to git remote (if configured)
 *   4. Remove from agent registry
 *   5. Delete the agent directory
 *
 * Safety:
 *   - Requires explicit confirmation (unless --yes)
 *   - Pushes to git remote before deletion (preserves cloud backup)
 *   - Shows exactly what will be removed before proceeding
 *   - Only works on standalone agents (not project-bound)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { standaloneAgentsDir } from '../core/Config.js';
import { unregisterAgent } from '../core/AgentRegistry.js';
import { uninstallAutoStart } from './setup.js';
import { SecretManager, SECRET_KEYS } from '../core/SecretManager.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

interface NukeOptions {
  skipConfirm?: boolean;
}

interface NukeHereOptions {
  dir?: string;
  skipConfirm?: boolean;
}

const PROJECT_LOCAL_ALWAYS_REMOVE = [
  '.instar',
  '.claude',
  '.codex',
  '.mcp.json',
  'instar.config.json',
];

const PROJECT_LOCAL_IDENTITY_SHADOWS = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  // .gitignore goes through the same classifier: instar's init writes a
  // fresh .gitignore listing per-machine state paths, but a project may
  // already have one tracked at HEAD. Same rule applies (tracked-clean
  // keep, tracked-modified restore, untracked delete).
  '.gitignore',
];

export async function nukeAgent(name: string, options: NukeOptions = {}): Promise<void> {
  const agentDir = path.join(standaloneAgentsDir(), name);
  const stateDir = path.join(agentDir, '.instar');

  // Verify agent exists
  if (!fs.existsSync(path.join(stateDir, 'config.json'))) {
    console.log(pc.red(`  Agent "${name}" not found at ${agentDir}`));
    console.log(pc.dim(`  Standalone agents live at: ${standaloneAgentsDir()}/`));
    process.exit(1);
  }

  // Load config for project name
  let projectName = name;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    projectName = config.projectName || name;
  } catch {
    // Use name as fallback
  }

  // Check what exists
  const hasGit = fs.existsSync(path.join(agentDir, '.git'));
  const hasRemote = hasGit && hasGitRemote(agentDir);
  const hasTmux = isTmuxSessionRunning(projectName);

  // Show what will be removed
  console.log();
  console.log(pc.bold(pc.red('  This will permanently remove:')));
  console.log();
  console.log(`  ${pc.red('x')} Agent directory: ${pc.dim(agentDir)}`);
  console.log(`  ${pc.red('x')} All agent data: memories, relationships, config, logs`);
  if (hasTmux) {
    console.log(`  ${pc.red('x')} Running server: ${pc.dim(`tmux session "${projectName}-server"`)}`);
  }
  console.log(`  ${pc.red('x')} Auto-start configuration (if any)`);
  console.log(`  ${pc.red('x')} Agent registry entry`);

  if (hasGit && hasRemote) {
    console.log();
    console.log(`  ${pc.green('~')} Git remote backup will be ${pc.bold('preserved')} (we'll push before deleting)`);
  } else if (hasGit && !hasRemote) {
    console.log();
    console.log(pc.yellow(`  ! Local git repo exists but has NO remote — data will be permanently lost`));
  }

  console.log();

  // Confirm
  if (!options.skipConfirm) {
    try {
      const { confirm } = await import('@inquirer/prompts');
      const confirmed = await confirm({
        message: `Remove agent "${name}" and all its data? This cannot be undone.`,
        default: false,
      });
      if (!confirmed) {
        console.log(pc.dim('  Cancelled.'));
        return;
      }
    } catch {
      console.log(pc.dim('  Cancelled.'));
      return;
    }
  }

  console.log();

  // Step 1: Stop server AND all spawned sessions
  if (hasTmux) {
    try {
      execFileSync('tmux', ['kill-session', '-t', `${projectName}-server`], { stdio: 'pipe' });
      console.log(`  ${pc.green('✓')} Stopped server`);
    } catch {
      console.log(pc.yellow('  Could not stop server (may already be stopped)'));
    }
  }

  // Kill ALL tmux sessions prefixed with the project name (spawned Claude sessions)
  try {
    const sessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    const projectSessions = sessions.filter(s => s.startsWith(`${projectName}-`) && s !== `${projectName}-server`);
    for (const session of projectSessions) {
      try {
        execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' });
      } catch { /* already dead */ }
    }
    if (projectSessions.length > 0) {
      console.log(`  ${pc.green('✓')} Killed ${projectSessions.length} spawned session(s)`);
    }
  } catch {
    // tmux not running or no sessions — fine
  }

  // Step 2: Remove auto-start
  try {
    const removed = uninstallAutoStart(projectName);
    if (removed) {
      console.log(`  ${pc.green('✓')} Removed auto-start`);
    }
  } catch {
    // Non-fatal
  }

  // Step 3: Push to git remote (preserve cloud backup)
  if (hasGit && hasRemote) {
    try {
      // Stage and commit any uncommitted changes
      SafeGitExecutor.execSync(['add', '-A'], { cwd: agentDir, stdio: 'pipe', operation: 'src/commands/nuke.ts:143' });
      const status = SafeGitExecutor.readSync(['status', '--porcelain'], { cwd: agentDir,
        encoding: 'utf-8',
        stdio: 'pipe', operation: 'src/commands/nuke.ts:145' }).trim();

      if (status) {
        SafeGitExecutor.execSync(['commit', '-m', 'final backup before nuke'], { cwd: agentDir,
          stdio: 'pipe', operation: 'src/commands/nuke.ts:153' });
      }

      SafeGitExecutor.execSync(['push'], { cwd: agentDir, stdio: 'pipe', timeout: 30_000, operation: 'src/commands/nuke.ts:160' });
      console.log(`  ${pc.green('✓')} Pushed final backup to remote`);
    } catch {
      console.log(pc.yellow('  Could not push final backup (remote may be unavailable)'));
    }
  }

  // Step 4: Back up secrets before deletion
  try {
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    const secretMgr = new SecretManager({ agentName: name });
    secretMgr.initialize();

    const telegramEntry = config.messaging?.find((m: { type: string }) => m.type === 'telegram');
    if (telegramEntry?.config) {
      // String-type guards reject the { secret: true } placeholder produced by
      // SecretMigrator after multi-machine pairing — the real values are already
      // in the encrypted store in that case, so backing up the placeholder
      // would silently corrupt the backup.
      const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      secretMgr.backupFromConfig({
        telegramToken: asStr(telegramEntry.config.token),
        telegramChatId: asStr(telegramEntry.config.chatId),
        authToken: asStr(config.authToken),
        dashboardPin: asStr(config.dashboardPin),
        tunnelToken: asStr(config.tunnel?.token),
      });
      console.log(`  ${pc.green('✓')} Secrets backed up (will auto-restore on reinstall)`);
    }
  } catch {
    // Non-fatal — secrets may not exist or store may not be configured
  }

  // Step 5: Remove from agent registry
  try {
    unregisterAgent(agentDir);
    console.log(`  ${pc.green('✓')} Removed from agent registry`);
  } catch {
    // Non-fatal — may not be registered
  }

  // Step 6: Delete the agent directory
  try {
    SafeFsExecutor.safeRmSync(agentDir, { recursive: true, force: true, operation: 'src/commands/nuke.ts:199' });
    console.log(`  ${pc.green('✓')} Deleted ${agentDir}`);
  } catch (err) {
    console.log(pc.red(`  Could not delete directory: ${err instanceof Error ? err.message : err}`));
    console.log(pc.dim(`  Try manually: rm -rf ${agentDir}`));
  }

  console.log();
  console.log(pc.green(`  Agent "${name}" has been removed.`));
  if (hasGit && hasRemote) {
    console.log(pc.dim('  Your cloud backup is still available on GitHub.'));
    console.log(pc.dim(`  To restore: git clone <repo-url> ${agentDir} && instar server start ${name}`));
  }
  console.log();
}

/**
 * `instar nuke --here` — Remove the project-local instar install in cwd.
 *
 * Sibling of nukeAgent for project-bound installs (the result of
 * `npx instar setup` inside a project directory). See
 * `specs/dev-infrastructure/nuke-here.md` for the full design.
 */
export async function nukeHere(options: NukeHereOptions = {}): Promise<void> {
  const dir = path.resolve(options.dir || process.cwd());
  const stateDir = path.join(dir, '.instar');
  const configPath = path.join(stateDir, 'config.json');

  if (isInstarSourceRepo(dir)) {
    console.log(pc.red('  Refusing to nuke the instar source repo.'));
    console.log(pc.dim('  --here removes an installed agent in a project directory.'));
    console.log(pc.dim('  The instar source checkout is not an agent install.'));
    process.exit(1);
  }

  if (!fs.existsSync(configPath)) {
    console.log(pc.red(`  No instar install found at ${dir}`));
    console.log(pc.dim('  Expected: .instar/config.json'));
    console.log(pc.dim('  (Standalone agents live under ~/.instar/agents/ — use `instar nuke <name>` for those.)'));
    process.exit(1);
  }

  let projectName = path.basename(dir);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    projectName = config.projectName || projectName;
  } catch {
    // fall back to basename
  }

  const hasTmux = isTmuxSessionRunning(projectName);
  const isGitRepo = fs.existsSync(path.join(dir, '.git'));

  const presentAlwaysRemove = PROJECT_LOCAL_ALWAYS_REMOVE.filter(rel =>
    fs.existsSync(path.join(dir, rel)),
  );
  const presentShadows = PROJECT_LOCAL_IDENTITY_SHADOWS.filter(rel =>
    fs.existsSync(path.join(dir, rel)),
  );

  // Decide shadow disposition up front so the plan can show it.
  const shadowDispositions: Array<{ file: string; action: 'keep' | 'restore' | 'delete' }> = [];
  for (const rel of presentShadows) {
    shadowDispositions.push({ file: rel, action: classifyShadowFile(dir, rel, isGitRepo) });
  }

  console.log();
  console.log(pc.bold(pc.red('  This will remove instar from this project:')));
  console.log();
  console.log(`  Project: ${pc.cyan(projectName)}`);
  console.log(`  Directory: ${pc.dim(dir)}`);
  console.log();
  console.log('  Artifacts to remove:');
  for (const rel of presentAlwaysRemove) {
    console.log(`  ${pc.red('x')} ${rel}`);
  }
  for (const { file, action } of shadowDispositions) {
    if (action === 'delete') {
      console.log(`  ${pc.red('x')} ${file} ${pc.dim('(created by instar)')}`);
    } else if (action === 'restore') {
      console.log(`  ${pc.yellow('~')} ${file} ${pc.dim('(restoring to git HEAD)')}`);
    } else {
      console.log(`  ${pc.dim('-')} ${file} ${pc.dim('(pre-existing, kept)')}`);
    }
  }
  if (hasTmux) {
    console.log(`  ${pc.red('x')} Running server: ${pc.dim(`tmux session "${projectName}-server"`)}`);
  }
  console.log(`  ${pc.red('x')} Auto-start configuration (if any)`);
  console.log(`  ${pc.red('x')} Agent registry entry (if any)`);
  console.log(`  ${pc.green('~')} Secrets backed up (auto-restored on next setup)`);
  console.log();

  if (!options.skipConfirm) {
    try {
      const { confirm } = await import('@inquirer/prompts');
      const confirmed = await confirm({
        message: `Remove instar from "${projectName}"? This cannot be undone.`,
        default: false,
      });
      if (!confirmed) {
        console.log(pc.dim('  Cancelled.'));
        return;
      }
    } catch {
      console.log(pc.dim('  Cancelled.'));
      return;
    }
  }

  console.log();

  // 1. Stop tmux server + spawned sessions
  if (hasTmux) {
    try {
      execFileSync('tmux', ['kill-session', '-t', `${projectName}-server`], { stdio: 'pipe' });
      console.log(`  ${pc.green('✓')} Stopped server`);
    } catch {
      console.log(pc.yellow('  Could not stop server (may already be stopped)'));
    }
  }
  try {
    const sessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);
    const projectSessions = sessions.filter(
      s => s.startsWith(`${projectName}-`) && s !== `${projectName}-server`,
    );
    for (const session of projectSessions) {
      try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'pipe' }); } catch { /* */ }
    }
    if (projectSessions.length > 0) {
      console.log(`  ${pc.green('✓')} Killed ${projectSessions.length} spawned session(s)`);
    }
  } catch {
    // tmux not running or no sessions — fine
  }

  // 2. Remove auto-start
  try {
    const removed = uninstallAutoStart(projectName);
    if (removed) console.log(`  ${pc.green('✓')} Removed auto-start`);
  } catch {
    // non-fatal
  }

  // 3. Back up secrets
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const secretMgr = new SecretManager({ agentName: projectName });
    secretMgr.initialize();
    const telegramEntry = config.messaging?.find?.(
      (m: { type: string }) => m.type === 'telegram',
    );
    if (telegramEntry?.config) {
      // Same string-guard treatment as the in-place backup above — reject the
      // { secret: true } placeholder so the backup never re-saves the marker
      // instead of the real value.
      const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      secretMgr.backupFromConfig({
        telegramToken: asStr(telegramEntry.config.token),
        telegramChatId: asStr(telegramEntry.config.chatId),
        authToken: asStr(config.authToken),
        dashboardPin: asStr(config.dashboardPin),
        tunnelToken: asStr(config.tunnel?.token),
      });
      console.log(`  ${pc.green('✓')} Secrets backed up`);
    }
  } catch {
    // non-fatal — store may not be configured
  }

  // 4. Unregister from agent registry
  try {
    unregisterAgent(dir);
    console.log(`  ${pc.green('✓')} Removed from agent registry`);
  } catch {
    // non-fatal — may not be registered
  }

  // 5. Filesystem teardown.
  //
  // Order matters: SafeFsExecutor + SafeGitExecutor both write to
  // .instar/audit/destructive-ops.jsonl on every operation. If .instar
  // is deleted first, every subsequent destructive op recreates
  // .instar/audit/ to log its entry, leaving a ghost .instar directory
  // behind. So:
  //   1) Process identity-shadow files first.
  //   2) Process non-.instar always-remove paths second.
  //   3) Process .instar LAST, with audit logging suppressed for that
  //      final op so it doesn't immediately recreate itself.
  for (const { file, action } of shadowDispositions) {
    const abs = path.join(dir, file);
    if (action === 'keep') {
      console.log(`  ${pc.dim('-')} Kept ${file} (pre-existing)`);
    } else if (action === 'restore') {
      try {
        SafeGitExecutor.execSync(['checkout', 'HEAD', '--', file], {
          cwd: dir,
          stdio: 'pipe',
          operation: 'src/commands/nuke.ts:nukeHere-restore-shadow',
        });
        console.log(`  ${pc.green('↺')} Restored ${file} to git HEAD`);
      } catch (err) {
        console.log(pc.red(`  Could not restore ${file}: ${err instanceof Error ? err.message : err}`));
      }
    } else {
      try {
        SafeFsExecutor.safeRmSync(abs, {
          recursive: false,
          force: true,
          operation: 'src/commands/nuke.ts:nukeHere-delete-shadow',
        });
        console.log(`  ${pc.green('✓')} Removed ${file}`);
      } catch (err) {
        console.log(pc.red(`  Could not remove ${file}: ${err instanceof Error ? err.message : err}`));
      }
    }
  }
  const dotInstar = presentAlwaysRemove.find(rel => rel === '.instar');
  const nonInstarAlwaysRemove = presentAlwaysRemove.filter(rel => rel !== '.instar');
  for (const rel of nonInstarAlwaysRemove) {
    const abs = path.join(dir, rel);
    try {
      SafeFsExecutor.safeRmSync(abs, {
        recursive: true,
        force: true,
        operation: 'src/commands/nuke.ts:nukeHere-delete-always',
      });
      console.log(`  ${pc.green('✓')} Removed ${rel}`);
    } catch (err) {
      console.log(pc.red(`  Could not remove ${rel}: ${err instanceof Error ? err.message : err}`));
    }
  }
  if (dotInstar) {
    // Suppress audit logging for this op only — .instar IS the audit log
    // location, so a final audit-write would recreate the directory we
    // are deleting. The agent dir is going away in the same breath, so
    // there's nothing the audit log would be useful FOR anymore.
    const prevAudit = process.env.INSTAR_AUDIT_LOG_DISABLED;
    process.env.INSTAR_AUDIT_LOG_DISABLED = '1';
    try {
      SafeFsExecutor.safeRmSync(path.join(dir, dotInstar), {
        recursive: true,
        force: true,
        operation: 'src/commands/nuke.ts:nukeHere-delete-dot-instar',
      });
      console.log(`  ${pc.green('✓')} Removed ${dotInstar}`);
    } catch (err) {
      console.log(pc.red(`  Could not remove ${dotInstar}: ${err instanceof Error ? err.message : err}`));
    } finally {
      if (prevAudit === undefined) delete process.env.INSTAR_AUDIT_LOG_DISABLED;
      else process.env.INSTAR_AUDIT_LOG_DISABLED = prevAudit;
    }
  }

  console.log();
  console.log(pc.green(`  instar has been removed from "${projectName}".`));
  console.log(pc.dim('  Run `npx instar` to reinstall.'));
  console.log();
}

/**
 * Returns true when `dir` is the instar source repo (package.json name ===
 * "instar" AND src/cli.ts is present). Conservative — must match BOTH to
 * avoid false positives in projects that happen to be named "instar."
 */
export function isInstarSourceRepo(dir: string): boolean {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.name !== 'instar') return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, 'src', 'cli.ts'));
}

/**
 * Classifies an identity-shadow file (CLAUDE.md / AGENTS.md / GEMINI.md)
 * for `nuke --here` disposition:
 *   - 'keep'    — tracked by git at HEAD with no working-tree diff (pre-existing)
 *   - 'restore' — tracked by git at HEAD with a diff (instar modified)
 *   - 'delete'  — not tracked, or not in a git repo (instar created)
 *
 * Exported for unit testing.
 */
export function classifyShadowFile(
  dir: string,
  relPath: string,
  isGitRepo: boolean,
): 'keep' | 'restore' | 'delete' {
  if (!isGitRepo) return 'delete';
  let tracked = false;
  try {
    SafeGitExecutor.readSync(['ls-files', '--error-unmatch', relPath], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      operation: 'src/commands/nuke.ts:classifyShadowFile-ls',
    });
    tracked = true;
  } catch {
    tracked = false;
  }
  if (!tracked) return 'delete';
  let dirty = '';
  try {
    dirty = SafeGitExecutor.readSync(['status', '--porcelain', relPath], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe',
      operation: 'src/commands/nuke.ts:classifyShadowFile-status',
    }).trim();
  } catch {
    return 'restore';
  }
  return dirty ? 'restore' : 'keep';
}

function hasGitRemote(dir: string): boolean {
  try {
    const remote = SafeGitExecutor.readSync(['remote'], { cwd: dir,
      encoding: 'utf-8',
      stdio: 'pipe', operation: 'src/commands/nuke.ts:218' }).trim();
    return remote.length > 0;
  } catch {
    return false;
  }
}

function isTmuxSessionRunning(projectName: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `${projectName}-server`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
