/**
 * Interactive setup wizard — the one-line onboarding experience.
 *
 * `npx instar` or `instar setup` walks through everything:
 *   1. Project detection + naming
 *   2. Secret management (Bitwarden / local encrypted / manual)
 *   3. Telegram setup (primary communication channel)
 *   4. User setup (name, email, permissions)
 *   5. Scheduler + first job (optional)
 *   6. Start server
 *
 * Launches a Claude Code session that walks you through setup
 * conversationally. Claude Code is a hard requirement — Instar's
 * entire runtime depends on it.
 *
 * No flags needed. No manual config editing. Just answers.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { detectClaudePath, detectGhPath } from '../core/Config.js';
import { ensurePrerequisites } from '../core/Prerequisites.js';
import type { SecretBackend } from '../core/SecretManager.js';

/**
 * Launch the conversational setup wizard via Claude Code.
 * Claude Code is required — there is no fallback.
 */
export async function runSetup(): Promise<void> {
  // Check and install prerequisites (tmux, Claude CLI, Node.js version)
  console.log();
  const prereqs = await ensurePrerequisites();

  // Claude Code is a hard requirement — Instar can't run without it
  const claudePath = detectClaudePath();
  if (!claudePath) {
    console.log();
    console.log(pc.red('  Claude Code is required to use Instar.'));
    console.log();
    console.log(pc.dim('  Instar agents are powered by Claude Code — it\'s not optional.'));
    console.log(pc.dim('  Install it, then run this command again:'));
    console.log();
    console.log(`    ${pc.cyan('npm install -g @anthropic-ai/claude-code')}`);
    console.log();
    process.exit(1);
  }

  if (!prereqs.allMet) {
    console.log(pc.red('  Some prerequisites are still missing. Please install them and try again.'));
    console.log();
    process.exit(1);
  }

  // Check that the setup-wizard skill exists
  const skillPath = path.join(findInstarRoot(), '.claude', 'skills', 'setup-wizard', 'skill.md');
  if (!fs.existsSync(skillPath)) {
    console.log();
    console.log(pc.red('  Setup wizard skill not found.'));
    console.log(pc.dim(`  Expected: ${skillPath}`));
    console.log(pc.dim('  This may indicate a corrupted installation. Try: npm install -g instar'));
    console.log();
    process.exit(1);
  }

  console.log();
  console.log(pc.bold('  Welcome to Instar'));
  console.log();
  console.log(pc.yellow('  Note: Instar runs Claude Code with --dangerously-skip-permissions.'));
  console.log(pc.dim('  This allows your agent to operate autonomously — reading, writing, and'));
  console.log(pc.dim('  executing within your project without per-action approval prompts.'));
  console.log(pc.dim('  Security is enforced through behavioral hooks, identity grounding, and'));
  console.log(pc.dim('  scoped access — not permission dialogs. See: README.md > Security Model'));
  console.log();

  // Detect git context to pass to the conversational wizard
  const projectDir = process.cwd();
  let gitContext = '';
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const repoName = path.basename(gitRoot);
    gitContext = ` This directory is inside a git repository "${repoName}" at ${gitRoot}. Set up a project-bound agent here.`;
  } catch {
    gitContext = ' This directory is NOT inside a git repository. Set up a standalone agent at ~/.instar/agents/<name>/ using `npx instar init --standalone <name>`.';
  }

  // Detect existing agent context for the multi-user decision tree (Phase 1)
  const stateDir = path.join(projectDir, '.instar');
  const existingConfig = fs.existsSync(path.join(stateDir, 'config.json'));
  let detectionContext = '';

  if (existingConfig) {
    // Read agent details for the wizard
    let agentName = 'unknown';
    let knownUsers: string[] = [];
    let machinesPaired = 0;
    let gitStateEnabled = false;
    let telegramConfigured = false;
    let registrationPolicy = 'admin-only';
    let autonomyLevel = 'collaborative';

    try {
      const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
      agentName = config.projectName || 'unknown';
      telegramConfigured = config.messaging?.some((m: { type: string; enabled?: boolean }) => m.type === 'telegram' && m.enabled !== false) || false;
      gitStateEnabled = !!config.gitState?.enabled;
      registrationPolicy = config.userRegistrationPolicy || 'admin-only';
      autonomyLevel = config.agentAutonomy?.level || 'collaborative';
    } catch { /* use defaults */ }

    try {
      const users = JSON.parse(fs.readFileSync(path.join(stateDir, 'users.json'), 'utf-8'));
      knownUsers = users.map((u: { name: string }) => u.name);
    } catch { /* empty */ }

    try {
      const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'machines', 'registry.json'), 'utf-8'));
      machinesPaired = Object.keys(registry.machines || {}).filter(
        (k: string) => registry.machines[k].status === 'active'
      ).length;
    } catch { /* zero */ }

    detectionContext = ` EXISTING AGENT DETECTED: existingAgent=true, agentName="${agentName}", knownUsers=[${knownUsers.map(u => `"${u}"`).join(',')}], machinesPaired=${machinesPaired}, gitStateEnabled=${gitStateEnabled}, telegramConfigured=${telegramConfigured}, registrationPolicy="${registrationPolicy}", autonomyLevel="${autonomyLevel}". Present the 3-option decision tree: (1) "I'm a new user joining this agent", (2) "I'm an existing user on a new machine", (3) "I want to start fresh with a new agent".`;
  } else {
    // No agent in CWD — check for existing standalone agents and GitHub backups
    const standaloneDir = path.join(os.homedir(), '.instar', 'agents');
    const existingStandalone: string[] = [];

    if (fs.existsSync(standaloneDir)) {
      try {
        for (const name of fs.readdirSync(standaloneDir)) {
          const configFile = path.join(standaloneDir, name, '.instar', 'config.json');
          if (fs.existsSync(configFile)) {
            existingStandalone.push(name);
          }
        }
      } catch { /* non-fatal */ }
    }

    // Proactively ensure gh CLI is available for GitHub scanning
    let ghPath = detectGhPath();
    let ghStatus: 'ready' | 'installed' | 'auth-needed' | 'unavailable' = 'unavailable';

    if (!ghPath) {
      // Try to install gh
      console.log(pc.dim('  Installing GitHub CLI for agent backup/restore...'));
      try {
        if (process.platform === 'darwin') {
          execFileSync('brew', ['install', 'gh'], { stdio: 'pipe', timeout: 60000 });
        } else {
          // Linux — try apt, snap, or dnf
          try {
            execFileSync('sudo', ['apt', 'install', '-y', 'gh'], { stdio: 'pipe', timeout: 60000 });
          } catch {
            try {
              execFileSync('snap', ['install', 'gh'], { stdio: 'pipe', timeout: 60000 });
            } catch {
              // Can't auto-install
            }
          }
        }
        ghPath = detectGhPath();
        if (ghPath) {
          ghStatus = 'installed';
          console.log(`  ${pc.green('✓')} GitHub CLI installed`);
        }
      } catch {
        console.log(pc.dim('  GitHub CLI not available — the wizard can help set it up.'));
      }
    }

    // Check gh auth status
    if (ghPath) {
      try {
        execFileSync(ghPath, ['auth', 'status'], { stdio: 'pipe', timeout: 5000 });
        ghStatus = 'ready';
      } catch {
        ghStatus = 'auth-needed';
      }
    }

    // Scan for GitHub-backed agents (only if gh is ready)
    let githubAgents: string[] = [];
    if (ghStatus === 'ready' && ghPath) {
      try {
        const ghResult = execFileSync(ghPath, ['repo', 'list', '--json', 'name', '--limit', '100'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 15000,
        }).trim();
        if (ghResult) {
          const repos = JSON.parse(ghResult) as Array<{ name: string }>;
          githubAgents = repos
            .filter(r => r.name.startsWith('instar-'))
            .map(r => r.name.replace(/^instar-/, ''));
        }
      } catch {
        // Scan failed — wizard will handle
      }
    }

    // Build detection context with full status
    detectionContext = ` No agent in current directory.`;
    detectionContext += ` ghStatus="${ghStatus}".`;

    if (existingStandalone.length > 0) {
      detectionContext += ` EXISTING STANDALONE AGENTS on this machine: [${existingStandalone.map(n => `"${n}"`).join(',')}] at ${standaloneDir}/.`;
    }
    if (githubAgents.length > 0) {
      detectionContext += ` GITHUB BACKUPS found: [${githubAgents.map(n => `"${n}"`).join(',')}] (repos: ${githubAgents.map(n => `instar-${n}`).join(', ')}).`;
      detectionContext += ` Offer to restore from GitHub backup before suggesting a new agent.`;
    }
    if (ghStatus === 'auth-needed') {
      detectionContext += ` GitHub CLI is installed but NOT authenticated. The wizard should walk the user through "gh auth login --web" to enable GitHub scanning and cloud backup.`;
    }
    if (ghStatus === 'unavailable') {
      detectionContext += ` GitHub CLI could not be installed automatically. The wizard should ask the user "Have you used Instar before on another machine?" and if yes, help them install gh manually to scan for backups.`;
    }
    if (existingStandalone.length === 0 && githubAgents.length === 0 && ghStatus === 'ready') {
      detectionContext += ` No existing agents found locally or on GitHub.`;
    }
  }

  // Pre-install Playwright browser binaries AND register the MCP server so
  // ALL Claude Code sessions (including the secret-setup micro-session) have
  // browser automation available.
  const instarRoot = findInstarRoot();
  console.log(pc.dim('  Preparing browser automation...'));

  // Step 1: Ensure .claude/settings.json has Playwright MCP registered
  ensurePlaywrightMcp(instarRoot);

  // Step 2: Pre-install Playwright browser binaries
  try {
    execFileSync('npx', ['-y', 'playwright', 'install', 'chromium'], {
      cwd: instarRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch {
    // Non-fatal — wizard will fall back to manual if browser isn't available
    console.log(pc.dim('  (Browser automation may not be available — the wizard can still guide you manually)'));
  }

  // ── Phase Gate: Secret Management ──────────────────────────────────
  // Structure > Willpower: secret management MUST be configured before the
  // main wizard. Uses a Claude Code micro-session (/secret-setup) for a
  // conversational experience. Gate: main wizard won't start without backend.json.
  const secretContext = await ensureSecretBackend(claudePath, instarRoot);

  // If Bitwarden session was saved by the secret-setup micro-session, pass it
  // as an env var so the main wizard can use it for credential restoration.
  const spawnEnv = { ...process.env };
  const bwSessionFile = path.join(os.homedir(), '.instar', 'secrets', '.bw-session');
  if (fs.existsSync(bwSessionFile)) {
    const bwSession = fs.readFileSync(bwSessionFile, 'utf-8').trim();
    if (bwSession) {
      spawnEnv.BW_SESSION = bwSession;
    }
  }

  // Launch Claude Code from the instar package root (where .claude/skills/ lives)
  const child = spawn(claudePath, [
    '--dangerously-skip-permissions',
    `/setup-wizard The project to set up is at: ${projectDir}.${gitContext}${detectionContext}${secretContext}`,
  ], {
    cwd: instarRoot,
    stdio: 'inherit',
    env: spawnEnv,
  });

  return new Promise((resolve) => {
    child.on('close', () => {
      resolve();
    });
    child.on('error', (err) => {
      console.log();
      console.log(pc.red(`  Could not launch Claude Code: ${err.message}`));
      console.log(pc.dim('  Make sure Claude Code is installed and accessible:'));
      console.log(`    ${pc.cyan('npm install -g @anthropic-ai/claude-code')}`);
      console.log();
      process.exit(1);
    });
  });
}

// ── Phase Gate: Secret Management ──────────────────────────────────────
// Structure > Willpower: secret management MUST be configured before the main
// wizard launches. We use a Claude Code micro-session (/secret-setup skill)
// for this — conversational, can explain options, can answer questions, can
// install and configure Bitwarden end-to-end. But SCOPED to one job.
//
// The gate: setup.ts won't launch the main wizard until backend.json exists.

/**
 * Ensure a secret backend is configured before the wizard launches.
 * Returns context string to pass to the wizard so it knows secrets are handled.
 *
 * If backend.json already exists → skip (returns existing choice as context).
 * If not → spawn a focused Claude Code session with the /secret-setup skill.
 *   Claude explains options, guides through Bitwarden install/login/unlock,
 *   configures the backend, and exits. Then we continue.
 */
async function ensureSecretBackend(claudePath: string, instarRoot: string): Promise<string> {
  const backendFile = path.join(os.homedir(), '.instar', 'secrets', 'backend.json');

  // Check if already configured
  if (fs.existsSync(backendFile)) {
    try {
      const pref = JSON.parse(fs.readFileSync(backendFile, 'utf-8'));
      const backend = pref.backend as SecretBackend;
      console.log(`  ${pc.green('✓')} Secret management: ${formatBackendName(backend)}`);

      // If Bitwarden, check for saved session and try to restore it
      let bwSessionContext = '';
      if (backend === 'bitwarden') {
        const sessionFile = path.join(os.homedir(), '.instar', 'secrets', '.bw-session');
        if (fs.existsSync(sessionFile)) {
          const savedSession = fs.readFileSync(sessionFile, 'utf-8').trim();
          if (savedSession) {
            bwSessionContext = ` BW_SESSION is available — Bitwarden vault is unlocked.`;
          }
        }
      }

      return ` SECRET_BACKEND_CONFIGURED="${backend}". Secret management is already set up — skip Phase 2.5.${bwSessionContext}`;
    } catch {
      // Corrupted file — fall through to micro-session
    }
  }

  // Not configured — launch Claude Code micro-session for secret setup
  console.log();
  console.log(pc.bold('  Secret Management'));
  console.log(pc.dim('  Your agent needs a way to store secrets securely.'));
  console.log(pc.dim('  Let me walk you through the options...'));
  console.log();

  // Spawn a focused Claude Code session with the /secret-setup skill
  const child = spawn(claudePath, [
    '--dangerously-skip-permissions',
    '/secret-setup',
  ], {
    cwd: instarRoot,
    stdio: 'inherit',
  });

  await new Promise<void>((resolve) => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });

  // Verify the micro-session did its job — backend.json must exist now
  if (fs.existsSync(backendFile)) {
    try {
      const pref = JSON.parse(fs.readFileSync(backendFile, 'utf-8'));
      const backend = pref.backend as SecretBackend;
      console.log();
      console.log(`  ${pc.green('✓')} Secret management: ${formatBackendName(backend)}`);

      let bwSessionContext = '';
      if (backend === 'bitwarden') {
        const sessionFile = path.join(os.homedir(), '.instar', 'secrets', '.bw-session');
        if (fs.existsSync(sessionFile)) {
          bwSessionContext = ` BW_SESSION is available — Bitwarden vault is unlocked.`;
        }
      }

      return ` SECRET_BACKEND_CONFIGURED="${backend}". Secret management configured. Skip Phase 2.5.${bwSessionContext}`;
    } catch {
      // Fall through
    }
  }

  // Micro-session didn't configure a backend — fall back to local
  console.log();
  console.log(pc.yellow('  Secret setup was not completed. Using local encrypted store as default.'));
  console.log(pc.dim('  You can change this later via: instar secrets backend bitwarden'));
  console.log();

  const { SecretManager } = await import('../core/SecretManager.js');
  const mgr = new SecretManager({ agentName: '_setup' });
  mgr.configureBackend('local');

  return ` SECRET_BACKEND_CONFIGURED="local". Secret setup micro-session did not complete — defaulted to local encrypted store. Skip Phase 2.5.`;
}

function formatBackendName(backend: SecretBackend): string {
  switch (backend) {
    case 'bitwarden': return 'Bitwarden';
    case 'local': return 'Local encrypted store';
    case 'manual': return 'Manual (paste when prompted)';
  }
}

/**
 * Register the Playwright MCP server so Claude Code has browser automation
 * available when spawned for the setup wizard.
 *
 * Claude Code loads MCP servers from THREE places (NOT .claude/settings.json):
 *   1. ~/.claude.json — user scope (top-level mcpServers) or local scope
 *      (projects["/abs/path"].mcpServers) — NO trust dialog needed
 *   2. .mcp.json in project root — project scope — requires trust acceptance
 *
 * We register in BOTH places for robustness:
 *   - ~/.claude.json local scope: guaranteed to work, no trust dialog
 *   - .mcp.json: works if trust is pre-accepted or enableAllProjectMcpServers
 */
function ensurePlaywrightMcp(dir: string): void {
  const absDir = path.resolve(dir);

  // ── 1. Register in ~/.claude.json at local scope (most reliable) ──
  const claudeJsonPath = path.join(os.homedir(), '.claude.json');
  try {
    let claudeJson: Record<string, unknown> = {};
    if (fs.existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    }

    // Ensure projects map exists
    if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
      claudeJson.projects = {};
    }
    const projects = claudeJson.projects as Record<string, Record<string, unknown>>;

    // Ensure project entry exists
    if (!projects[absDir]) {
      projects[absDir] = {};
    }
    const projectEntry = projects[absDir];

    // Register Playwright MCP at local scope
    if (!projectEntry.mcpServers || typeof projectEntry.mcpServers !== 'object') {
      projectEntry.mcpServers = {};
    }
    const mcpServers = projectEntry.mcpServers as Record<string, unknown>;
    if (!mcpServers.playwright) {
      mcpServers.playwright = {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      };
    }

    // Pre-accept trust so .mcp.json servers also load without a dialog
    projectEntry.hasTrustDialogAccepted = true;

    // Write atomically
    const tmpPath = `${claudeJsonPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(claudeJson, null, 2));
    fs.renameSync(tmpPath, claudeJsonPath);
  } catch {
    // Non-fatal — .mcp.json fallback below
  }

  // ── 2. Also create .mcp.json in the project root (belt-and-suspenders) ──
  const mcpJsonPath = path.join(dir, '.mcp.json');
  if (!fs.existsSync(mcpJsonPath)) {
    try {
      const mcpConfig = {
        mcpServers: {
          playwright: {
            command: 'npx',
            args: ['-y', '@playwright/mcp@latest'],
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2));
    } catch {
      // Non-fatal
    }
  }
}

/**
 * Find the root of the instar package (where .claude/skills/ lives).
 * Works whether running from source, linked global, or node_modules.
 */
function findInstarRoot(): string {
  // Walk up from this file to find package.json with name "instar"
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === 'instar') return dir;
      } catch { /* continue */ }
    }
    dir = path.dirname(dir);
  }
  // Fallback: assume we're in dist/commands/ — go up to root
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
}

// ── Auto-Start on Login ─────────────────────────────────────────

/**
 * Install auto-start so the agent's lifeline process starts on login.
 * macOS: LaunchAgent plist in ~/Library/LaunchAgents/
 * Linux: systemd user service in ~/.config/systemd/user/
 *
 * Returns true if auto-start was installed successfully.
 */
export function installAutoStart(projectName: string, projectDir: string, hasTelegram: boolean): boolean {
  const platform = process.platform;

  if (platform === 'darwin') {
    return installMacOSLaunchAgent(projectName, projectDir, hasTelegram);
  } else if (platform === 'linux') {
    return installLinuxSystemdService(projectName, projectDir, hasTelegram);
  } else {
    // Windows or other — no auto-start support yet
    return false;
  }
}

/**
 * Remove auto-start for a project.
 */
export function uninstallAutoStart(projectName: string): boolean {
  const platform = process.platform;

  if (platform === 'darwin') {
    const label = `ai.instar.${projectName}`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

    // Unload if loaded
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: 'ignore' });
    } catch { /* not loaded */ }

    // Remove file
    try {
      fs.unlinkSync(plistPath);
      return true;
    } catch {
      return false;
    }
  } else if (platform === 'linux') {
    const serviceName = `instar-${projectName}.service`;
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);

    try {
      execFileSync('systemctl', ['--user', 'disable', serviceName], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'stop', serviceName], { stdio: 'ignore' });
    } catch { /* not loaded */ }

    try {
      fs.unlinkSync(servicePath);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function findNodePath(): string {
  try {
    return execFileSync('which', ['node'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '/usr/local/bin/node';
  }
}

function findInstarCli(): string {
  // Find the actual instar CLI entry point
  try {
    const globalPath = execFileSync('which', ['instar'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (globalPath && !globalPath.includes('.npm/_npx')) {
      return globalPath;
    }
  } catch { /* not global */ }

  // Fallback: use the dist/cli.js from the npm package
  const cliPath = new URL('../cli.js', import.meta.url).pathname;
  if (fs.existsSync(cliPath)) {
    return cliPath;
  }

  return 'instar';
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function installMacOSLaunchAgent(projectName: string, projectDir: string, hasTelegram: boolean): boolean {
  const label = `ai.instar.${projectName}`;
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const logDir = path.join(projectDir, '.instar', 'logs');
  const nodePath = findNodePath();
  const instarCli = findInstarCli();

  // Determine what to start: lifeline if Telegram configured, otherwise just the server
  const command = hasTelegram ? 'lifeline' : 'server';
  const args = hasTelegram
    ? [instarCli, 'lifeline', 'start', '--dir', projectDir]
    : [instarCli, 'server', 'start', '--foreground', '--dir', projectDir];

  // If instar CLI is a node script (not a binary), prepend node
  const isNodeScript = instarCli.endsWith('.js') || instarCli.endsWith('.mjs');
  const programArgs = isNodeScript ? [nodePath, ...args] : args;

  // Build the plist XML
  const argsXml = programArgs.map(a => `      <string>${escapeXml(a)}</string>`).join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(projectDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(logDir, `${command}-launchd.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(logDir, `${command}-launchd.err`))}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(process.env.PATH || '/usr/local/bin:/usr/bin:/bin')}</string>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>`;

  try {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);

    // Load the agent
    try {
      // Unload first if already loaded
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: 'ignore' });
    } catch { /* not loaded yet — fine */ }

    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 501}`, plistPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function installLinuxSystemdService(projectName: string, projectDir: string, hasTelegram: boolean): boolean {
  const serviceName = `instar-${projectName}.service`;
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, serviceName);
  const nodePath = findNodePath();
  const instarCli = findInstarCli();

  const command = hasTelegram ? 'lifeline' : 'server';
  const args = hasTelegram
    ? `${instarCli} lifeline start --dir ${projectDir}`
    : `${instarCli} server start --foreground --dir ${projectDir}`;

  const isNodeScript = instarCli.endsWith('.js') || instarCli.endsWith('.mjs');
  const execStart = isNodeScript ? `${nodePath} ${args}` : args;

  const service = `[Unit]
Description=Instar Agent - ${projectName}
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${projectDir}
Restart=always
RestartSec=10
Environment=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}

[Install]
WantedBy=default.target
`;

  try {
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, service);

    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', serviceName], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'start', serviceName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
