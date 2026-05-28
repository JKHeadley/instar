/**
 * Multi-machine CLI commands.
 *
 * Commands:
 *   instar machines          — List paired machines and their roles
 *   instar machines remove   — Revoke a machine
 *   instar whoami            — Show this machine's identity and role
 *   instar pair              — Generate a pairing code for a new machine
 *   instar join              — Join an existing mesh (clone, pair, setup)
 *   instar wakeup            — Move agent to this machine (transfer awake role)
 *   instar leave             — Self-remove from the mesh
 *   instar doctor            — Diagnose multi-machine health
 *
 * Part of Phase 1-6 of the multi-machine spec.
 */

import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { redactUrl, redactUrlsInText } from '../core/redactUrl.js';
import { MachineIdentityManager } from '../core/MachineIdentity.js';
import { HeartbeatManager } from '../core/HeartbeatManager.js';
import { SecretStore } from '../core/SecretStore.js';
import { GitSyncManager } from '../core/GitSync.js';
import { SelfKnowledgeTree } from '../knowledge/SelfKnowledgeTree.js';
import { CoverageAuditor } from '../knowledge/CoverageAuditor.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import type { MachineRole } from '../core/types.js';

/**
 * Claim the fenced lease for THIS machine and propagate it to the substrate.
 *
 * `instar wakeup` (force path and the no-awake-machine path) used to only flip
 * the LOCAL registry role — but the lease, not the role, is the authority, and
 * the server's reconcileRoleToLease() OVERRIDES role back to match the lease on
 * startup. So a role-only flip was silently undone and never reached the peer
 * (verified live on a real two-machine mesh, 2026-05-28). Here we build a real
 * signed +1-epoch acquisition (the same record GitLeaseStore writes), persist it
 * into the registry with the holder's freshness fields, and best-effort push so
 * the peer sees the takeover immediately (the server's next sync re-pushes too).
 */
export async function claimLeaseForSelf(
  mgr: MachineIdentityManager,
  machineId: string,
  signingKeyPem: string,
  config: { stateDir: string; projectDir: string; multiMachine?: unknown },
): Promise<void> {
  const { sign, verify } = await import('../core/MachineIdentity.js');
  const { FencedLease } = await import('../core/FencedLease.js');
  const { assertSeamlessnessInvariants } = await import('../core/seamlessnessConfig.js');

  const seamless = assertSeamlessnessInvariants(config.multiMachine as never);
  const crypto = {
    selfMachineId: machineId,
    sign: (canonical: string) => sign(canonical, signingKeyPem),
    verify: (canonical: string, signature: string, holder: string) => {
      const pub = mgr.getSigningPublicKeyPem(holder);
      if (!pub) return false;
      try { return verify(canonical, signature, pub); } catch { return false; }
    },
  };
  const fenced = new FencedLease(crypto, {
    leaseTtlMs: seamless.leaseTtlMs,
    failoverThresholdMs: seamless.failoverThresholdMs,
  });

  const registry = mgr.loadRegistry();
  const candidate = fenced.buildAcquisition(registry.lease ?? null, Date.now(), (registry.lease?.nonce ?? 0) + 1);
  registry.lease = candidate;
  const entry = registry.machines[machineId];
  if (entry) {
    entry.syncSequence = (entry.syncSequence ?? 0) + 1;
    entry.authoredUnderEpoch = candidate.epoch;
  }
  mgr.saveRegistry(registry);

  // Best-effort immediate propagation (gpgsign disabled so a stale signing
  // config can't block the commit — see GitSync.configureCommitSigning).
  try {
    if (!fs.existsSync(path.join(config.projectDir, '.git'))) return;
    const opts = { cwd: config.projectDir, encoding: 'utf-8' as const, stdio: 'pipe' as const, operation: 'src/commands/machine.ts:claimLeaseForSelf' };
    SafeGitExecutor.run(['add', path.join(config.stateDir, 'machines', 'registry.json')], opts);
    SafeGitExecutor.run(['-c', 'commit.gpgsign=false', 'commit', '-m', `chore(mesh): force-wakeup lease epoch ${candidate.epoch} → ${machineId.slice(0, 8)}`], opts);
    let hasUpstream = false;
    try { SafeGitExecutor.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], opts); hasUpstream = true; } catch { /* none yet */ }
    const branch = SafeGitExecutor.run(['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim() || 'main';
    SafeGitExecutor.run(hasUpstream ? ['push'] : ['push', '-u', 'origin', branch], opts);
  } catch {
    // @silent-fallback-ok — the server's next sync will push the claimed lease.
  }
}

// ── instar machines ──────────────────────────────────────────────

interface MachinesOptions {
  dir?: string;
}

export async function listMachines(options: MachinesOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const mgr = new MachineIdentityManager(config.stateDir);

  if (!mgr.hasIdentity()) {
    console.log(pc.yellow('No machine identity found. Run `instar init` to generate one.'));
    process.exit(1);
  }

  const registry = mgr.loadRegistry();
  const localIdentity = mgr.loadIdentity();
  const machines = Object.entries(registry.machines);

  if (machines.length === 0) {
    console.log(pc.dim('No machines registered.'));
    return;
  }

  console.log(pc.bold(`\n  Machines for ${pc.cyan(config.projectName)}\n`));

  for (const [machineId, entry] of machines) {
    const isLocal = machineId === localIdentity.machineId;
    const roleIcon = entry.role === 'awake' ? pc.green('▶') : pc.dim('○');
    const statusIcon = entry.status === 'active' ? '' : pc.red(' [revoked]');
    const localTag = isLocal ? pc.cyan(' (this machine)') : '';

    console.log(`  ${roleIcon} ${pc.bold(entry.name)}${localTag}${statusIcon}`);
    console.log(`    ID:     ${pc.dim(machineId.slice(0, 12) + '...')}`);
    console.log(`    Role:   ${entry.role}`);
    console.log(`    Status: ${entry.status}`);
    console.log(`    Paired: ${entry.pairedAt}`);
    console.log(`    Seen:   ${entry.lastSeen}`);

    if (entry.revokedAt) {
      console.log(`    Revoked: ${entry.revokedAt} by ${entry.revokedBy}`);
      if (entry.revokeReason) {
        console.log(`    Reason:  ${entry.revokeReason}`);
      }
    }

    console.log();
  }
}

// ── instar machines remove ───────────────────────────────────────

interface RemoveMachineOptions {
  dir?: string;
}

export async function removeMachine(nameOrId: string, options: RemoveMachineOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const mgr = new MachineIdentityManager(config.stateDir);
  const localIdentity = mgr.loadIdentity();
  const registry = mgr.loadRegistry();

  // Find the machine by name or ID prefix
  const match = Object.entries(registry.machines).find(([id, entry]) =>
    entry.name === nameOrId || id.startsWith(nameOrId)
  );

  if (!match) {
    console.log(pc.red(`Machine not found: ${nameOrId}`));
    console.log('Run `instar machines` to see available machines.');
    process.exit(1);
  }

  const [machineId, entry] = match;

  if (machineId === localIdentity.machineId) {
    console.log(pc.red("Can't remove yourself. Use `instar leave` to self-remove."));
    process.exit(1);
  }

  if (entry.status === 'revoked') {
    console.log(pc.yellow(`Machine "${entry.name}" is already revoked.`));
    return;
  }

  mgr.revokeMachine(machineId, localIdentity.machineId, 'Removed via CLI');

  console.log(pc.green(`Machine "${entry.name}" has been revoked.`));
  console.log(pc.dim('Secrets should be rotated. The revoked machine can no longer authenticate.'));
}

// ── instar whoami ────────────────────────────────────────────────

interface WhoamiOptions {
  dir?: string;
}

export async function whoami(options: WhoamiOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const mgr = new MachineIdentityManager(config.stateDir);

  if (!mgr.hasIdentity()) {
    console.log(pc.yellow('No machine identity found. Run `instar init` to generate one.'));
    process.exit(1);
  }

  const identity = mgr.loadIdentity();
  const registry = mgr.loadRegistry();
  const entry = registry.machines[identity.machineId];

  console.log(pc.bold(`\n  ${pc.cyan(config.projectName)} — This Machine\n`));
  console.log(`  Name:         ${pc.bold(identity.name)}`);
  console.log(`  Machine ID:   ${pc.dim(identity.machineId)}`);
  console.log(`  Platform:     ${identity.platform}`);
  console.log(`  Created:      ${identity.createdAt}`);
  console.log(`  Capabilities: ${identity.capabilities.join(', ')}`);

  if (entry) {
    const roleColor = entry.role === 'awake' ? pc.green : pc.dim;
    console.log(`  Role:         ${roleColor(entry.role)}`);
    console.log(`  Status:       ${entry.status}`);
    console.log(`  Last Seen:    ${entry.lastSeen}`);
  }

  console.log(`  Fingerprint:  ${pc.dim(identity.signingPublicKey.slice(0, 16) + '...')}`);
  console.log();
}

// ── instar pair ──────────────────────────────────────────────────

interface PairOptions {
  dir?: string;
  qr?: boolean;
}

export async function startPairing(options: PairOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const mgr = new MachineIdentityManager(config.stateDir);

  if (!mgr.hasIdentity()) {
    console.log(pc.red('No machine identity. Run `instar init` first.'));
    process.exit(1);
  }

  const { generatePairingCode, createPairingSession } = await import('../core/PairingProtocol.js');
  const { migrateSecrets } = await import('../core/SecretMigrator.js');

  // Migrate secrets from config.json before pairing (ensures they're in the encrypted store)
  const configPath = path.join(config.stateDir, 'config.json');
  const migration = migrateSecrets(configPath, config.stateDir);
  if (migration.extracted > 0) {
    console.log(pc.green(`  Migrated ${migration.extracted} secret(s) to encrypted store.`));
  }

  const pairingCode = generatePairingCode();
  const _pairingSession = createPairingSession({ code: pairingCode });

  console.log(pc.bold(`\n  Pairing Code for ${pc.cyan(config.projectName)}\n`));
  console.log(`  ${pc.bold(pc.yellow(pairingCode))}`);
  console.log();

  // Check if tunnel is available
  let tunnelUrl = '';
  try {
    const resp = await fetch(`http://localhost:${config.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      // Try to get tunnel URL from server
      try {
        const health = await resp.json() as { tunnelUrl?: string };
        tunnelUrl = health.tunnelUrl || '';
      } catch { /* no tunnel URL in health response */ }
    }
  } catch { /* server not running */ }

  if (tunnelUrl) {
    console.log(`  On the new machine, run:`);
    console.log(`  ${pc.cyan(`instar join ${tunnelUrl} --code ${pairingCode}`)}`);
  } else {
    console.log(`  On the new machine, clone the repo and run:`);
    console.log(`  ${pc.cyan(`instar join <repo-url> --code ${pairingCode}`)}`);
    console.log();
    console.log(pc.dim('  Or start the server with a tunnel and re-run this command.'));
  }

  console.log();
  console.log(pc.dim('  This code expires in 10 minutes.'));
  console.log(pc.dim('  After entering the code, verify the visual symbols match on both screens.'));
  console.log();
}

// ── instar join ─────────────────────────────────────────────────

interface JoinOptions {
  dir?: string;
  code?: string;
  name?: string;
  port?: number;
}

/**
 * Build a complete machine-local config.json for a freshly-joined home.
 *
 * config.json is gitignored (authToken + dashboardPin), so a cloned mesh repo
 * never carries it — `join` must scaffold one or the standby boots with NO
 * authToken (unauthenticated API) on loadConfig defaults. Pure + exported so
 * the scaffold logic is unit-testable independent of the git/identity I/O.
 */
export function buildJoinedConfig(
  loaded: { projectName?: string; projectDir?: string; port?: number; sessions?: { tmuxPath?: string; claudePath?: string; maxSessions?: number } },
  portOption: number | undefined,
  authToken: string,
): Record<string, unknown> {
  const port = portOption ?? loaded.port ?? 4040;
  return {
    projectName: loaded.projectName,
    projectDir: loaded.projectDir,
    port,
    agentType: 'standalone',
    sessions: {
      tmuxPath: loaded.sessions?.tmuxPath,
      claudePath: loaded.sessions?.claudePath,
      maxSessions: loaded.sessions?.maxSessions ?? 10,
      protectedSessions: [`${loaded.projectName}-server`],
    },
    scheduler: { enabled: true, maxParallelJobs: 2 },
    messaging: [],
    monitoring: { quotaTracking: true, memoryMonitoring: true, healthCheckIntervalMs: 30000 },
    authToken,
  };
}

export async function joinMesh(repoUrl: string, options: JoinOptions): Promise<void> {
  if (!options.code) {
    console.log(pc.red('Missing pairing code. Usage: instar join <url> --code <code>'));
    process.exit(1);
  }

  // Basic format check: WORD-WORD-NNNN
  if (!/^[A-Z]+-[A-Z]+-\d{4}$/i.test(options.code)) {
    console.log(pc.red('Invalid pairing code format. Expected: WORD-WORD-NNNN'));
    process.exit(1);
  }

  console.log(pc.bold('\n  Joining mesh...\n'));

  // Step 1: Clone the repo if it looks like a git URL
  let projectDir = options.dir || process.cwd();
  const isGitUrl = repoUrl.includes('github.com') || repoUrl.includes('.git') || repoUrl.startsWith('git@');

  if (isGitUrl) {
    const repoName = path.basename(repoUrl, '.git');
    projectDir = path.resolve(repoName);

    if (fs.existsSync(projectDir)) {
      console.log(pc.yellow(`  Directory ${repoName}/ already exists. Using existing repo.`));
    } else {
      console.log(`  Cloning repository...`);
      try {
        const { execFileSync } = await import('child_process');
        execFileSync('git', ['clone', repoUrl, projectDir], { stdio: 'inherit', timeout: 60_000 });
        console.log(pc.green('  Cloned.'));
      } catch (err) {
        console.log(pc.red(`  Failed to clone: ${redactUrlsInText(err instanceof Error ? err.message : String(err))}`));
        process.exit(1);
      }
    }
  }

  // Step 2: Load config from the cloned/existing project
  let config;
  try {
    config = loadConfig(projectDir);
  } catch (err) {
    console.log(pc.red(`Not an instar project: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Step 2b: scaffold a machine-local config.json if the joined home lacks one.
  // config.json is gitignored (it holds the authToken + dashboardPin), so a
  // freshly-cloned mesh repo never carries it — which left the joined standby
  // with NO authToken (unauthenticated API) and only loadConfig defaults
  // (verified live on a real two-machine mesh, 2026-05-28). Generate a complete
  // machine-local config so the standby boots healthy and authenticated. Shared
  // state (jobs, topics) still syncs via the repo; only per-machine secrets and
  // the port live in config.json.
  const configFilePath = path.join(config.stateDir, 'config.json');
  if (!fs.existsSync(configFilePath)) {
    const { randomUUID } = await import('node:crypto');
    const scaffolded = buildJoinedConfig(config, options.port, randomUUID());
    fs.writeFileSync(configFilePath, JSON.stringify(scaffolded, null, 2));
    console.log(pc.green(`  Scaffolded machine-local config.json (port ${scaffolded.port}, fresh auth token).`));
    config = loadConfig(projectDir); // reload so downstream steps see the persisted config
  } else if (options.port != null) {
    // Honor an explicit --port on an existing config (e.g. re-join on a new port).
    try {
      const existing = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
      existing.port = options.port;
      fs.writeFileSync(configFilePath, JSON.stringify(existing, null, 2));
      config = loadConfig(projectDir);
      console.log(pc.dim(`  Set port ${options.port} on existing config.json.`));
    } catch {
      // @silent-fallback-ok — port override is best-effort.
    }
  }

  const mgr = new MachineIdentityManager(config.stateDir);

  // Step 3: Generate identity for this machine.
  //
  // Use the canonical MachineIdentityManager.generateIdentity() rather than
  // hand-writing the keys — the hand-rolled path wrote `signing-private.pem` /
  // `encryption-private.pem`, but EVERY reader (loadSigningKey, leaseCrypto,
  // configureCommitSigning) expects the canonical `signing-key.pem` /
  // `encryption-key.pem`. The mismatch left joined machines unable to load
  // their own signing key — breaking lease signing on the standby and (where
  // the name happened to line up) enabling broken commit-signing. Verified live
  // on a real two-machine mesh, 2026-05-28. generateIdentity writes the
  // canonical filenames, the identity, and self-registers as standby.
  if (mgr.hasIdentity()) {
    console.log(pc.yellow('  This machine already has an identity. Using existing.'));
  } else {
    const identity = await mgr.generateIdentity({ name: options.name, role: 'standby' });
    console.log(pc.green(`  Identity created: ${identity.name} (${identity.machineId.slice(0, 12)}...)`));
  }

  // Step 4: Contact the awake machine's pairing endpoint (if URL is a tunnel)
  const isTunnelUrl = repoUrl.startsWith('http://') || repoUrl.startsWith('https://');
  if (isTunnelUrl) {
    console.log(`  Contacting ${redactUrl(repoUrl)}...`);
    try {
      const identity = mgr.loadIdentity();
      const resp = await fetch(`${repoUrl}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairingCode: options.code,
          machineIdentity: identity,
          ephemeralPublicKey: identity.encryptionPublicKey,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        console.log(pc.red(`  Pairing rejected: ${(body as any).error || resp.statusText}`));
        process.exit(1);
      }

      const result = await resp.json() as { machineIdentity?: any; status?: string };
      if (result.machineIdentity) {
        // Store the remote machine's identity
        mgr.storeRemoteIdentity(result.machineIdentity);
        mgr.registerMachine(result.machineIdentity, 'awake');
        console.log(pc.green(`  Paired with: ${result.machineIdentity.name}`));
      }
    } catch (err) {
      console.log(pc.red(`  Failed to contact server: ${redactUrlsInText(err instanceof Error ? err.message : String(err))}`));
      console.log(pc.dim('  If the server is not running, clone the repo with git and register manually.'));
    }
  }

  // Step 5: Ensure gitignore protects secrets
  const { ensureGitignore } = await import('../core/MachineIdentity.js');
  ensureGitignore(config.projectDir);

  // Step 6: Install auto-start for THIS (the joined) home.
  // Without this, a joined agent has no LaunchAgent/systemd unit — the operator
  // must hand-start it, and worse: a stale `ai.instar.<projectName>` plist left
  // by a prior `instar init` of the same name (at a DIFFERENT home) keeps
  // respawning a server against the wrong directory and fights the joined one
  // for the port + identity (observed live 2026-05-27). The auto-start Label is
  // keyed on projectName, so installing here for the joined projectDir cleanly
  // REPLACES any stale same-name plist — one unit, pointing at the joined home.
  // (Spec MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS Track C — simpler than the drafted
  // pointer-file approach, which was solving a non-problem given Label-keying.)
  try {
    const { installAutoStart } = await import('./setup.js');
    // Mirror server.ts's hasTelegram derivation. A standby still installs its
    // server unit so it's ready to take over; the shipped poll-ownership lease
    // prevents any dual-poll if telegram is configured on both ends.
    const hasTelegram = (config as { messaging?: Array<{ type?: string }> }).messaging?.some(
      (m) => m.type === 'telegram',
    ) ?? false;
    const installed = installAutoStart(config.projectName, config.projectDir, hasTelegram);
    if (installed) {
      console.log(pc.dim(`  Auto-start installed for the joined home (${process.platform === 'darwin' ? 'LaunchAgent' : 'systemd service'}).`));
    }
  } catch (err) {
    // @silent-fallback-ok — auto-start is non-critical; join still succeeds.
    console.log(pc.dim(`  (Auto-start install skipped: ${err instanceof Error ? err.message : String(err)})`));
  }

  console.log();
  console.log(pc.green(pc.bold(`  Joined ${config.projectName} mesh as standby.`)));
  console.log();
  console.log(`  Next steps:`);
  console.log(`  1. Start the server: ${pc.cyan('instar server start')}`);
  console.log(`  2. Check health:     ${pc.cyan('instar doctor')}`);
  console.log(`  3. Wake up agent:    ${pc.cyan('instar wakeup')} (when ready)`);
  console.log();
}

// ── instar leave ─────────────────────────────────────────────────

interface LeaveOptions {
  dir?: string;
}

export async function leaveMesh(options: LeaveOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized.'));
    process.exit(1);
  }

  const mgr = new MachineIdentityManager(config.stateDir);

  if (!mgr.hasIdentity()) {
    console.log(pc.yellow('No machine identity found. Nothing to leave.'));
    return;
  }

  const identity = mgr.loadIdentity();
  const registry = mgr.loadRegistry();
  const entry = registry.machines[identity.machineId];

  if (entry?.role === 'awake') {
    console.log(pc.red('This machine is the awake machine. Hand off to another machine first:'));
    console.log(pc.cyan('  On the standby machine, run: instar wakeup'));
    process.exit(1);
  }

  // Revoke self in registry
  if (entry) {
    mgr.revokeMachine(identity.machineId, identity.machineId, 'Self-removal via `instar leave`');
  }

  // Remove local identity and keys
  mgr.removeLocalIdentity();

  console.log(pc.green(`This machine has been removed from the ${config.projectName} mesh.`));
  console.log(pc.dim('Local keys have been deleted. Re-pair to rejoin.'));
}

// ── instar wakeup ────────────────────────────────────────────────

interface WakeupOptions {
  dir?: string;
  force?: boolean;
}

export async function wakeup(options: WakeupOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const mgr = new MachineIdentityManager(config.stateDir);

  if (!mgr.hasIdentity()) {
    console.log(pc.red('No machine identity. Run `instar init` first.'));
    process.exit(1);
  }

  const identity = mgr.loadIdentity();
  const registry = mgr.loadRegistry();
  const myEntry = registry.machines[identity.machineId];

  if (myEntry?.role === 'awake') {
    console.log(pc.yellow(`${config.projectName} is already awake on this machine.`));
    return;
  }

  // Find the currently awake machine
  const awake = mgr.getAwakeMachine();

  // Signing key for claiming the lease (canonical MachineIdentity name).
  const wakeupSigningKeyPath = path.join(config.stateDir, 'machine', 'signing-key.pem');
  const wakeupSigningKeyPem = fs.existsSync(wakeupSigningKeyPath) ? fs.readFileSync(wakeupSigningKeyPath, 'utf-8') : '';

  if (!awake) {
    // No awake machine — promote ourselves AND claim the lease (the authority).
    console.log(pc.yellow('No awake machine found. Promoting this machine.'));
    mgr.updateRole(identity.machineId, 'awake');
    if (wakeupSigningKeyPem) {
      await claimLeaseForSelf(mgr, identity.machineId, wakeupSigningKeyPem, config);
    }

    // Write initial heartbeat
    const heartbeat = new HeartbeatManager(config.stateDir, identity.machineId);
    heartbeat.writeHeartbeat();

    console.log(pc.green(`${config.projectName} is now awake on ${identity.name}.`));
    console.log(pc.dim('Restart the server to begin processing.'));
    return;
  }

  if (options.force) {
    // Force-promote without contacting the current awake machine. Claim the
    // LEASE (not just the role) at a higher epoch and push it — otherwise the
    // server's reconcileRoleToLease() reverts our role on startup and the peer
    // never learns of the takeover.
    console.log(pc.yellow(`Force-wakeup: bypassing contact with ${awake.entry.name}.`));
    mgr.updateRole(awake.machineId, 'standby');
    mgr.updateRole(identity.machineId, 'awake');
    if (!wakeupSigningKeyPem) {
      console.log(pc.red('  Missing signing key — cannot claim the lease. Run `instar init` to regenerate.'));
      process.exit(1);
    }
    await claimLeaseForSelf(mgr, identity.machineId, wakeupSigningKeyPem, config);

    const heartbeat = new HeartbeatManager(config.stateDir, identity.machineId);
    heartbeat.writeHeartbeat();

    console.log(pc.green(`${config.projectName} is now awake on ${identity.name} (forced).`));
    console.log(pc.dim('Lease claimed + pushed; the old awake machine steps down when it sees the higher epoch.'));
    return;
  }

  // Normal handoff: contact the awake machine via tunnel or local
  console.log(`  Current location: ${pc.bold(awake.entry.name)}`);
  console.log('  Contacting for handoff...');

  // Determine server URL — try tunnel first, fall back to localhost
  let serverUrl = '';
  try {
    const healthResp = await fetch(`http://localhost:${config.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (healthResp.ok) {
      const health = await healthResp.json() as { tunnelUrl?: string };
      serverUrl = health.tunnelUrl || `http://localhost:${config.port}`;
    }
  } catch { /* server not reachable locally */ }

  if (!serverUrl) {
    console.log(pc.red(`  Can't reach the server on port ${config.port}.`));
    console.log(pc.dim(`  The awake machine may be offline. Use --force to take over.`));
    process.exit(1);
  }

  // Load signing key for challenge-response (canonical MachineIdentity name).
  const signingKeyPath = path.join(config.stateDir, 'machine', 'signing-key.pem');
  if (!fs.existsSync(signingKeyPath)) {
    console.log(pc.red('  Missing signing key. Run `instar init` to regenerate.'));
    process.exit(1);
  }
  const signingKeyPem = fs.readFileSync(signingKeyPath, 'utf-8');
  const { signRequest } = await import('../server/machineAuth.js');
  const { sign: signData } = await import('../core/MachineIdentity.js');

  try {
    // Step 1: Get challenge from the awake machine
    const challengeHeaders = signRequest(identity.machineId, signingKeyPem, {}, 1);
    const challengeResp = await fetch(`${serverUrl}/api/handoff/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...challengeHeaders },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });

    if (!challengeResp.ok) {
      const err = await challengeResp.json().catch(() => ({})) as { error?: string };
      throw new Error(`Challenge failed: ${(err as any).error || challengeResp.statusText}`);
    }

    const { challenge } = await challengeResp.json() as { challenge: string; expiresAt: string };
    console.log('  Challenge received. Signing...');

    // Step 2: Sign the challenge with the structured message the server expects:
    // challenge|sender_machine_id|receiver_machine_id|SHA256(body_without_challenge_fields)
    const crypto = await import('node:crypto');
    const bodyForHash = {}; // Empty — challenge and challengeSignature are excluded by the server
    const bodyHash = crypto.createHash('sha256')
      .update(JSON.stringify(bodyForHash))
      .digest('hex');
    const challengeMessage = `${challenge}|${identity.machineId}|${awake.machineId}|${bodyHash}`;
    const challengeSignature = signData(challengeMessage, signingKeyPem);
    const handoffBody = { challenge, challengeSignature };
    const handoffHeaders = signRequest(identity.machineId, signingKeyPem, handoffBody, 2);

    const handoffResp = await fetch(`${serverUrl}/api/handoff/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...handoffHeaders },
      body: JSON.stringify(handoffBody),
      signal: AbortSignal.timeout(15_000),
    });

    if (!handoffResp.ok) {
      const err = await handoffResp.json().catch(() => ({})) as { error?: string };
      throw new Error(`Handoff rejected: ${(err as any).error || handoffResp.statusText}`);
    }

    const result = await handoffResp.json() as { status: string; state?: unknown; message?: string };

    if (result.status === 'not-ready') {
      console.log(pc.yellow(`  ${result.message || 'Server not ready for handoff. Try again shortly.'}`));
      process.exit(1);
    }

    // Step 3: Update local registry and heartbeat
    mgr.updateRole(awake.machineId, 'standby');
    mgr.updateRole(identity.machineId, 'awake');

    const heartbeat = new HeartbeatManager(config.stateDir, identity.machineId);
    heartbeat.writeHeartbeat();

    console.log(pc.green(`\n  ${config.projectName} is now awake on ${identity.name}.`));
    console.log(pc.dim(`  ${awake.entry.name} has been demoted to standby.`));
  } catch (err) {
    console.log(pc.red(`  Handoff failed: ${err instanceof Error ? err.message : String(err)}`));
    console.log(pc.dim(`  Use --force to take over without contacting the awake machine.`));
    process.exit(1);
  }
}

// ── instar doctor ────────────────────────────────────────────────

interface DoctorOptions {
  dir?: string;
}

export async function doctor(options: DoctorOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const mgr = new MachineIdentityManager(config.stateDir);
  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = [];

  console.log(pc.bold(`\n  ${config.projectName} — Doctor\n`));

  // 1. Machine identity
  if (mgr.hasIdentity()) {
    const identity = mgr.loadIdentity();
    checks.push({ name: 'Machine identity', status: 'ok', detail: `${identity.name} (${identity.machineId.slice(0, 12)}...)` });
  } else {
    checks.push({ name: 'Machine identity', status: 'fail', detail: 'No identity found. Run `instar init`.' });
  }

  // 2. Registry health
  try {
    const registry = mgr.loadRegistry();
    const active = Object.entries(registry.machines).filter(([, e]) => e.status === 'active');
    const awake = active.filter(([, e]) => e.role === 'awake');

    if (awake.length === 1) {
      checks.push({ name: 'Registry', status: 'ok', detail: `${active.length} active machine(s), 1 awake` });
    } else if (awake.length === 0) {
      checks.push({ name: 'Registry', status: 'warn', detail: `${active.length} active machine(s), none awake. Run \`instar wakeup\`.` });
    } else {
      checks.push({ name: 'Registry', status: 'fail', detail: `${awake.length} machines claim awake (split-brain?)` });
    }
  } catch (e) {
    checks.push({ name: 'Registry', status: 'fail', detail: e instanceof Error ? e.message : String(e) });
  }

  // 3. Heartbeat
  if (mgr.hasIdentity()) {
    const identity = mgr.loadIdentity();
    const hb = new HeartbeatManager(config.stateDir, identity.machineId);
    const check = hb.checkHeartbeat();

    if (check.status === 'healthy') {
      checks.push({ name: 'Heartbeat', status: 'ok', detail: `Healthy (holder: ${check.holder}, age: ${Math.round(check.ageMs / 1000)}s)` });
    } else if (check.status === 'stale') {
      checks.push({ name: 'Heartbeat', status: 'warn', detail: `Stale (age: ${Math.round(check.ageMs / 1000)}s). Is the server running?` });
    } else if (check.status === 'expired') {
      checks.push({ name: 'Heartbeat', status: 'fail', detail: `Expired. The awake machine may be down.` });
    } else if (check.status === 'missing') {
      checks.push({ name: 'Heartbeat', status: 'warn', detail: 'No heartbeat file. Server may not have started yet.' });
    } else {
      checks.push({ name: 'Heartbeat', status: 'fail', detail: `Status: ${check.status}` });
    }
  }

  // 4. Server reachability
  try {
    const resp = await fetch(`http://localhost:${config.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const health = await resp.json() as { uptimeHuman?: string };
      checks.push({ name: 'Server', status: 'ok', detail: `Running (port ${config.port}, up ${health.uptimeHuman || '?'})` });
    } else {
      checks.push({ name: 'Server', status: 'warn', detail: `Responded with ${resp.status}` });
    }
  } catch {
    checks.push({ name: 'Server', status: 'fail', detail: `Not reachable on port ${config.port}. Run \`instar server start\`.` });
  }

  // 5. Signing key permissions
  if (mgr.hasIdentity()) {
    const keyPath = mgr.signingKeyPath;
    if (fs.existsSync(keyPath)) {
      const stats = fs.statSync(keyPath);
      const mode = (stats.mode & 0o777).toString(8);
      if (mode === '600') {
        checks.push({ name: 'Key permissions', status: 'ok', detail: '0600 (owner-only)' });
      } else {
        checks.push({ name: 'Key permissions', status: 'warn', detail: `0${mode} — should be 0600. Run: chmod 600 ${keyPath}` });
      }
    }
  }

  // 6. Secret Store
  try {
    const secretStore = new SecretStore({ stateDir: config.stateDir });
    if (secretStore.exists) {
      const keychainLabel = secretStore.isKeychainBacked ? 'keychain-backed' : 'file-backed key';
      checks.push({ name: 'Secret store', status: 'ok', detail: `Encrypted (${keychainLabel})` });
    } else {
      checks.push({ name: 'Secret store', status: 'ok', detail: 'No encrypted secrets (single-machine mode)' });
    }
  } catch (e) {
    checks.push({ name: 'Secret store', status: 'fail', detail: e instanceof Error ? e.message : String(e) });
  }

  // 7. Git signing
  try {
    const gitSync = new GitSyncManager({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      identityManager: mgr,
      securityLog: { append: () => {} } as any,
      machineId: mgr.hasIdentity() ? mgr.loadIdentity().machineId : '',
    });
    if (gitSync.isSigningConfigured()) {
      checks.push({ name: 'Git signing', status: 'ok', detail: 'SSH signing configured' });
    } else {
      checks.push({ name: 'Git signing', status: 'warn', detail: 'Not configured. Run `instar init` with multi-machine.' });
    }
  } catch {
    checks.push({ name: 'Git signing', status: 'warn', detail: 'Could not check git signing status' });
  }

  // 8. Gitignore
  const gitignorePath = path.join(config.projectDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const hasKeyIgnore = content.includes('signing-key.pem') || content.includes('signing-private.pem');
    const hasEncIgnore = content.includes('encryption-key.pem') || content.includes('encryption-private.pem');
    const hasSecretsIgnore = content.includes('secrets/') || content.includes('config.secrets.enc');
    if (hasKeyIgnore && hasEncIgnore) {
      const secretsNote = hasSecretsIgnore ? ', secrets gitignored' : '';
      checks.push({ name: 'Gitignore', status: 'ok', detail: `Private keys gitignored${secretsNote}` });
    } else {
      checks.push({ name: 'Gitignore', status: 'fail', detail: 'Private keys NOT gitignored! Run `instar init` to fix.' });
    }
  } else {
    checks.push({ name: 'Gitignore', status: 'warn', detail: 'No .gitignore found' });
  }

  // 9. Self-knowledge tree
  try {
    const tree = new SelfKnowledgeTree({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      intelligence: null,
    });
    const treeConfig = tree.getConfig();
    if (treeConfig) {
      const validation = tree.validate();
      const auditor = new CoverageAuditor(config.projectDir, config.stateDir);
      const health = auditor.healthSummary();
      const totalNodes = treeConfig.layers.reduce((s: number, l: { children: unknown[] }) => s + l.children.length, 0);

      const parts = [
        `${totalNodes} nodes`,
        `${Math.round(validation.coverageScore * 100)}% coverage`,
      ];
      if (health.searchCount > 0) {
        parts.push(`${Math.round(health.cacheHitRate * 100)}% cache hit`);
        parts.push(`${Math.round(health.avgLatencyMs)}ms avg`);
        if (health.errorRate > 0) {
          parts.push(`${(health.errorRate * 100).toFixed(1)}% error rate`);
        }
      }

      const hasErrors = validation.errors.length > 0;
      const hasWarnings = validation.warnings.length > 0;
      checks.push({
        name: 'Self-knowledge tree',
        status: hasErrors ? 'fail' : hasWarnings ? 'warn' : 'ok',
        detail: parts.join(', '),
      });

      // Report gaps
      const detectedPlatforms = auditor.detectPlatforms();
      const audit = auditor.audit(treeConfig, validation, detectedPlatforms);
      for (const gap of audit.gaps) {
        checks.push({
          name: 'Tree coverage gap',
          status: gap.severity === 'high' ? 'fail' : 'warn',
          detail: gap.description,
        });
      }
    } else {
      checks.push({ name: 'Self-knowledge tree', status: 'warn', detail: 'No tree found. Will be generated on next update.' });
    }
  } catch (e) {
    checks.push({ name: 'Self-knowledge tree', status: 'warn', detail: e instanceof Error ? e.message : String(e) });
  }

  // Print results
  for (const check of checks) {
    const icon = check.status === 'ok' ? pc.green('✓')
      : check.status === 'warn' ? pc.yellow('!')
      : pc.red('✗');
    console.log(`  ${icon} ${pc.bold(check.name)}: ${check.detail}`);
  }

  const failures = checks.filter(c => c.status === 'fail');
  const warnings = checks.filter(c => c.status === 'warn');

  console.log();
  if (failures.length > 0) {
    console.log(pc.red(`  ${failures.length} issue(s) need attention.`));
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log(pc.yellow(`  ${warnings.length} warning(s).`));
  } else {
    console.log(pc.green('  All checks passed.'));
  }
  console.log();
}
