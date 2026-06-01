/**
 * Post-Update Migrator — the "intelligence download" layer.
 *
 * When an agent installs a new version of instar, updating the npm
 * package only changes the server code. But the agent's local awareness
 * lives in project files: CLAUDE.md, hooks, scripts.
 *
 * This migrator bridges that gap. After every successful update, it:
 *   1. Re-installs hooks with the latest templates (behavioral upgrades)
 *   2. Patches CLAUDE.md with any new sections (awareness upgrades)
 *   3. Installs any new scripts (capability upgrades)
 *   4. Deploys missing built-in skills (exec:skill job support)
 *   5. Returns a human-readable migration report
 *
 * Design principles:
 *   - Additive only: never remove or modify existing user customizations
 *   - Hooks are overwritten (they're generated infrastructure, not user-edited)
 *   - CLAUDE.md sections are appended only if missing (check by heading)
 *   - Scripts are installed only if missing (never overwrite user modifications)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import { ensureInstarBashPreToolUseHooks, type SettingsMatcherEntry } from './instarSettingsHooks.js';
import { resolveAgentHome as resolveAgentHomeForWorktree, ensureWorktreeSpotlightExclusion } from './InstarWorktreeManager.js';
import { fileURLToPath } from 'node:url';
import { TreeGenerator } from '../knowledge/TreeGenerator.js';
import { HTTP_HOOK_TEMPLATES, buildHttpHookSettings } from '../data/http-hook-templates.js';
import { getMigrationDefaults, applyDefaults } from '../config/ConfigDefaults.js';
import { installBuiltinSkills } from '../commands/init.js';
import { crossesBreaking, writeLifelineRestartSignal } from './version-skew.js';
import { IdentityManager } from '../threadline/client/IdentityManager.js';
import { installAutoStart, installBootWrapper } from '../commands/setup.js';
import { installBuiltinJobs } from '../scheduler/InstallBuiltinJobs.js';
import { jobsMigrate } from '../commands/jobMigrate.js';
import { snapshotUserNamespace, verifyMigrationInvariants } from '../scheduler/MigrationInvariants.js';
import { appendMigrationEvent, normalizePerEntryAction, type MigrationEvent } from '../scheduler/MigrationLedger.js';
import { randomUUID } from 'node:crypto';
import {
  ELIGIBILITY_SCHEMA_SQL,
  ELIGIBILITY_SCHEMA_SQL_SHA256,
  PUSH_GATE_SH,
  PUSH_GATE_SH_SHA256,
  INSTAR_PR_GATE_WORKFLOW_YML,
  INSTAR_PR_GATE_WORKFLOW_YML_SHA256,
  PR_GATE_SETUP_MD,
  PR_GATE_SETUP_MD_SHA256,
} from '../data/pr-gate-artifacts.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { installCodexHooks } from './installCodexHooks.js';
import { armCodexHooks, makeTmuxTrustDriver } from './codexHookArm.js';
import { detectCodexPath, detectTmuxPath } from './Config.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import {
  MigratorStepEngine,
  type MigratorStep,
  type RunPendingStepsResult,
} from './MigratorStepEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MigrationResult {
  /** What was upgraded */
  upgraded: string[];
  /** What was already up to date */
  skipped: string[];
  /** Any errors that occurred (non-fatal) */
  errors: string[];
}

export interface MigratorConfig {
  projectDir: string;
  stateDir: string;
  port: number;
  hasTelegram: boolean;
  projectName: string;
}

export class PostUpdateMigrator {
  private config: MigratorConfig;
  /**
   * F-7 atomic-step engine. Lazily constructed on first access via
   * `getStepEngine()` so existing callers that never touch atomic steps
   * pay zero cost. See `src/core/MigratorStepEngine.ts` for the primitive
   * docs; see `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A35/§A50
   * for the spec.
   */
  private stepEngine: MigratorStepEngine | undefined;

  constructor(config: MigratorConfig) {
    this.config = config;
  }

  /**
   * Resolve the set of frameworks this install actively uses, read from
   * the persisted `.instar/config.json` `enabledFrameworks` field.
   *
   * Default (unset / empty / unreadable): `['claude-code']` — the
   * historical behavior, so existing and dual-framework installs are
   * unaffected. A Codex-only install sets `enabledFrameworks:
   * ['codex-cli']`, which makes framework-specific migration steps that
   * scaffold `.claude/`-only artifacts skip cleanly instead of writing
   * files that runtime will never read.
   *
   * Single source of truth for the migrator's framework gating — both
   * the parity-renderings backfill and the legacy `.claude/`-specific
   * steps consult this.
   */
  private getEnabledFrameworks(): ReadonlyArray<'claude-code' | 'codex-cli'> {
    try {
      const configPath = path.join(this.config.stateDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        enabledFrameworks?: unknown;
      };
      const enabled = config.enabledFrameworks;
      if (Array.isArray(enabled) && enabled.length > 0) {
        const filtered = enabled.filter(
          (f): f is 'claude-code' | 'codex-cli' =>
            f === 'claude-code' || f === 'codex-cli',
        );
        if (filtered.length > 0) return filtered;
      }
    } catch {
      // fall through to default
    }
    return ['claude-code'];
  }

  /**
   * F-7 atomic-step primitive: register a step that will run once on
   * the release boundary where `step.version <= toVersion`. Idempotent
   * across runs — the engine records every step's outcome in
   * `<stateDir>/migrator-steps-completed.json` keyed by
   * `<version>:<step-name>`.
   *
   * Steps are atomic and self-contained: a failure in one step does not
   * roll back prior steps and does not block subsequent steps.
   *
   * See `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A35 + §A50.
   */
  registerStep(step: MigratorStep): void {
    this.getStepEngine().registerStep(step);
  }

  /**
   * F-7 atomic-step primitive: execute every pending step. Pending =
   * step.version <= toVersion AND no ledger entry recorded yet.
   *
   * Steps run in registration order. Failures are recorded (never
   * thrown) and do not stop subsequent steps.
   */
  async runPendingSteps(
    fromVersion: string,
    toVersion: string,
  ): Promise<RunPendingStepsResult> {
    return this.getStepEngine().runPendingSteps(fromVersion, toVersion);
  }

  private getStepEngine(): MigratorStepEngine {
    if (!this.stepEngine) {
      this.stepEngine = new MigratorStepEngine(this.config.stateDir);
    }
    return this.stepEngine;
  }

  private templateCandidates(subdir: 'hooks' | 'scripts' | 'playbook', filename: string): string[] {
    return [
      path.resolve(__dirname, '..', 'templates', subdir, filename),
      path.resolve(__dirname, '..', '..', 'src', 'templates', subdir, filename),
    ];
  }

  /**
   * Read a built-in template from the compiled layout when templates have
   * been copied to dist, or from the packaged source-template layout used by
   * current npm publishes.
   */
  private loadTemplate(subdir: 'hooks' | 'scripts' | 'playbook', filename: string): string | null {
    for (const candidate of this.templateCandidates(subdir, filename)) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf-8');
      }
    }
    return null;
  }

  /**
   * Run all post-update migrations. Safe to call multiple times —
   * each migration is idempotent.
   */
  migrate(): MigrationResult {
    const result: MigrationResult = {
      upgraded: [],
      skipped: [],
      errors: [],
    };

    this.migrateHooks(result);
    this.migrateClaudeMd(result);
    this.migrateFrameworkShadowCapabilities(result);
    this.migrateScripts(result);
    this.migrateSecretExternalizationSurvivability(result);
    this.migrateSettings(result);
    this.migrateConfig(result);
    this.migrateLegacyMaxSessions(result);
    this.migrateRetireDeadMentorConfig(result);
    this.migrateRetireMentorOutbox(result);
    this.migratePrPipelineArtifacts(result);
    this.migrateBackupManifest(result);
    this.migrateGitignore(result);
    this.migrateBuiltinSkills(result);
    this.migrateBuiltinJobs(result);
    this.autoMigrateLegacyJobsJson(result);
    this.migrateSkillPortHardcoding(result);
    this.migrateBuildSkillMethodology(result);
    this.migrateTestAsSelfSkill(result);
    this.migrateAutonomousStopHookTopicKeyed(result);
    this.migrateSelfKnowledgeTree(result);
    this.migrateSoulMd(result);
    this.migrateAgentMdSections(result);
    this.migrateContextDeathAntiPattern(result);
    this.migrateProviderPortability(result);
    this.migrateFleetWatchdog(result);
    this.migrateParitySentinelTrust(result);
    this.migrateConversationalCatalogPlaybookManifest(result);
    this.migrateWorktreeConvention(result);
    this.migrateWorktreeSpotlightExclusion(result);
    this.migrateNodeModulesSpotlightExclusion(result);
    this.migrateBootWrapperToCjs(result);
    this.migrateBootWrapperAbiCheck(result);
    this.migrateStaleLifelineSignal(result);
    this.migrateThreadlineConversationStore(result);
    this.migrateThreadlineAgentInfoIdentity(result);

    return result;
  }

  /**
   * Regenerate the boot wrapper when it predates the ABI-aware node
   * self-heal (recurring-SQLite-bane fix).
   *
   * The `.js → .cjs` migration above only regenerates the wrapper when the
   * plist still references the old `.js` name — agents already on `.cjs`
   * (the majority) are skipped, so they'd never receive the new
   * selfHealNodeSymlink logic that detects "node runs but can't load
   * better-sqlite3" and re-points to an ABI-compatible node. This migration
   * closes that gap: if the on-disk `instar-boot.cjs` lacks the ABI-check
   * marker, regenerate it via installBootWrapper.
   *
   * Idempotent: once the marker is present, it skips.
   */
  private migrateBootWrapperAbiCheck(result: MigrationResult): void {
    if (process.platform !== 'darwin') {
      result.skipped.push('boot-wrapper ABI-check: non-darwin');
      return;
    }
    const bootWrapperPath = path.join(this.config.stateDir, 'instar-boot.cjs');
    if (!fs.existsSync(bootWrapperPath)) {
      result.skipped.push('boot-wrapper ABI-check: no instar-boot.cjs present');
      return;
    }
    let content: string;
    try {
      content = fs.readFileSync(bootWrapperPath, 'utf-8');
    } catch (err) {
      result.errors.push(`boot-wrapper ABI-check read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Marker strings the current boot wrapper must contain to be considered
    // up-to-date. Both are required:
    //  - 'cannot load better-sqlite3 (ABI drift)' — the ABI-check self-heal branch.
    //  - 'version-managed node candidates' — the asdf/nvm `which node` candidate
    //    discovery (instar-codey node-25/ABI-141 deadlock fix). An install that has
    //    the ABI check but NOT this marker (e.g. instar-codey) self-heals FORWARD to
    //    the wrong ABI and cannot recover — it must be regenerated.
    if (
      content.includes('cannot load better-sqlite3 (ABI drift)') &&
      content.includes('version-managed node candidates')
    ) {
      result.skipped.push('boot-wrapper ABI-check: already current');
      return;
    }
    try {
      installBootWrapper(this.config.projectDir);
      result.upgraded.push('boot-wrapper ABI-check: regenerated instar-boot.cjs with ABI-aware node self-heal + version-managed node candidates');
    } catch (err) {
      result.errors.push(`boot-wrapper ABI-check regen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Boot-wrapper .js → .cjs plist migration ─────────────────────────
  //
  // Older installs generated `instar-boot.js` and a launchd plist that
  // referenced `instar-boot.js`. Recent installBootWrapper change ships
  // `instar-boot.cjs` always (works regardless of package.json "type"),
  // but in-the-wild agents whose plists already point at the old `.js`
  // path keep using it — until something deletes the .js wrapper and
  // launchd's next restart hits a missing file (the failure mode that
  // took echo dark on 2026-05-20).
  //
  // This migration:
  //   1. Skips non-darwin (only launchd uses the plist path).
  //   2. Reads ~/Library/LaunchAgents/ai.instar.<projectName>.plist.
  //   3. If it references `instar-boot.js` (not `.cjs`), regenerates via
  //      installAutoStart, which writes the new .cjs wrapper AND updates
  //      the plist's ProgramArguments to match.
  //   4. Idempotent: if the plist already references `.cjs`, no-op.
  //
  // The migration does NOT delete the old `.js` file — leaving it makes
  // rollback safe and avoids any race where launchd is mid-restart on the
  // old path. The relevant fix is the plist+wrapper coherence going
  // forward, not retroactive file cleanup.
  // ── Stale-lifeline coordinated-restart bootstrap ────────────────────
  //
  // When an agent's running lifeline is on a pre-coordination version of
  // instar (no in-process signal-file consumer), the auto-updater can bump
  // the server through many minor releases over hours/days and the lifeline
  // never restarts. We saw this twice in three days (b2lead-insights
  // 2026-05-19 → 2026-05-22). Spec:
  // docs/specs/auto-updater-lifeline-coordination.md
  //
  // This migration runs once per agent update. If the running lifeline
  // version (recorded in `lifeline-started-at.json`) crosses major.minor
  // against the version this migrator is part of, we write the coordinated-
  // restart signal. The fleet watchdog (out-of-process) picks the signal up
  // within ~5 min and force-restarts the lifeline; in-process consumers
  // pick it up faster.
  //
  // Idempotent: writeLifelineRestartSignal skips when a fresh signal for
  // the same targetVersion already exists.
  private migrateStaleLifelineSignal(result: MigrationResult): void {
    const lifelineStartedAtPath = path.join(this.config.stateDir, 'lifeline-started-at.json');
    if (!fs.existsSync(lifelineStartedAtPath)) {
      result.skipped.push('stale-lifeline-signal: no lifeline-started-at.json (lifeline never ran here)');
      return;
    }

    let lifelineVersion: string | null = null;
    try {
      const data = JSON.parse(fs.readFileSync(lifelineStartedAtPath, 'utf-8')) as { version?: string };
      lifelineVersion = data.version ?? null;
    } catch {
      result.skipped.push('stale-lifeline-signal: lifeline-started-at.json unreadable');
      return;
    }

    if (!lifelineVersion) {
      result.skipped.push('stale-lifeline-signal: no version field in lifeline-started-at.json');
      return;
    }

    let installedVersion: string;
    try {
      const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
      installedVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version as string;
    } catch {
      result.skipped.push('stale-lifeline-signal: could not read installed package.json');
      return;
    }

    if (!crossesBreaking(lifelineVersion, installedVersion)) {
      result.skipped.push(`stale-lifeline-signal: lifeline v${lifelineVersion} same major.minor as v${installedVersion}`);
      return;
    }

    try {
      const outcome = writeLifelineRestartSignal({
        stateDir: this.config.stateDir,
        requestedBy: 'post-update-migrator-bootstrap',
        reason: 'stale-lifeline-bootstrap',
        previousVersion: lifelineVersion,
        targetVersion: installedVersion,
      });
      result.upgraded.push(
        `stale-lifeline-signal: ${outcome} (lifeline v${lifelineVersion} → v${installedVersion})`,
      );
    } catch (err) {
      result.errors.push(`stale-lifeline-signal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Threadline Phase 1 keystone (THREADLINE-CONVERSATION-KEYSTONE-SPEC, Migration
   * parity): fold the legacy thread-resume-map.json + context-thread-map.json
   * into the unified conversations.json so in-flight conversations survive the
   * update with their turn/binding context. Idempotent (skips a threadId already
   * present in conversations.json — never clobbers runtime-written rows),
   * atomic (tmp + rename), and field-preserving (sessionUuid, agentIdentity,
   * pinned, lifecycle incl. failed/archived, cross-machine fields). Reconciliation
   * rule: the resume entry is authoritative for session binding; the contextId
   * index is attached from the context map (distinct fields, no conflict).
   */
  private migrateThreadlineConversationStore(result: MigrationResult): void {
    const dir = path.join(this.config.stateDir, 'threadline');
    const resumePath = path.join(dir, 'thread-resume-map.json');
    const ctxPath = path.join(dir, 'context-thread-map.json');
    const convPath = path.join(dir, 'conversations.json');

    if (!fs.existsSync(resumePath) && !fs.existsSync(ctxPath)) {
      result.skipped.push('threadline-conversations: no legacy stores to fold');
      return;
    }

    // Load existing unified store (idempotency — never overwrite live rows).
    let store: { version: 1; conversations: Record<string, Record<string, unknown>>; lastModified: string };
    try {
      if (fs.existsSync(convPath)) {
        const parsed = JSON.parse(fs.readFileSync(convPath, 'utf-8'));
        store = (parsed && parsed.version === 1 && parsed.conversations)
          ? parsed
          : { version: 1, conversations: {}, lastModified: new Date().toISOString() };
      } else {
        store = { version: 1, conversations: {}, lastModified: new Date().toISOString() };
      }
    } catch {
      store = { version: 1, conversations: {}, lastModified: new Date().toISOString() };
    }

    const now = new Date().toISOString();
    let folded = 0;

    // 1) Fold ThreadResumeMap entries (authoritative for session binding).
    try {
      if (fs.existsSync(resumePath)) {
        const resumeMap = JSON.parse(fs.readFileSync(resumePath, 'utf-8')) as Record<string, Record<string, unknown>>;
        for (const [threadId, e] of Object.entries(resumeMap)) {
          if (!threadId || typeof e !== 'object' || e === null) continue;
          if (store.conversations[threadId]) continue; // idempotent — keep live row
          const remoteAgent = typeof e.remoteAgent === 'string' ? e.remoteAgent : undefined;
          store.conversations[threadId] = {
            threadId,
            version: 0,
            participants: { peers: remoteAgent ? [remoteAgent] : [] },
            remoteAgent,
            state: typeof e.state === 'string' ? e.state : 'idle',
            resolvedAt: e.resolvedAt,
            sessionUuid: typeof e.uuid === 'string' ? e.uuid : undefined,
            boundSessionName: typeof e.sessionName === 'string' ? e.sessionName : undefined,
            boundTopicId: typeof e.originTopicId === 'number' ? e.originTopicId : undefined,
            originSessionName: typeof e.originSessionName === 'string' ? e.originSessionName : undefined,
            spawnMode: e.spawnMode,
            subject: typeof e.subject === 'string' ? e.subject : undefined,
            pinned: e.pinned === true,
            messageCount: typeof e.messageCount === 'number' ? e.messageCount : 0,
            machineOrigin: e.machineOrigin,
            migratedTo: e.migratedTo,
            turnCount: 0,
            createdAt: typeof e.createdAt === 'string' ? e.createdAt : now,
            savedAt: now,
            lastActivityAt: typeof e.lastAccessedAt === 'string' ? e.lastAccessedAt : now,
          };
          folded++;
        }
      }
    } catch (err) {
      result.errors.push(`threadline-conversations resume fold: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2) Attach ContextThreadMap identity bindings (reconciliation: resume entry
    //    is authoritative for session binding; contextId index rebuilt from here).
    try {
      if (fs.existsSync(ctxPath)) {
        const ctxFile = JSON.parse(fs.readFileSync(ctxPath, 'utf-8')) as { mappings?: Array<Record<string, unknown>> };
        const mappings = Array.isArray(ctxFile.mappings) ? ctxFile.mappings : [];
        for (const m of mappings) {
          const threadId = typeof m.threadId === 'string' ? m.threadId : undefined;
          if (!threadId) continue;
          const existing = store.conversations[threadId];
          if (existing) {
            if (existing.contextId === undefined && typeof m.contextId === 'string') existing.contextId = m.contextId;
            if (existing.agentIdentity === undefined && typeof m.agentIdentity === 'string') existing.agentIdentity = m.agentIdentity;
          } else {
            // Context-only thread (no resume entry) — create a minimal row so the
            // identity binding (hijack guard) is not lost.
            store.conversations[threadId] = {
              threadId, version: 0, participants: { peers: [] },
              state: 'idle', pinned: false, messageCount: 0, turnCount: 0,
              contextId: typeof m.contextId === 'string' ? m.contextId : undefined,
              agentIdentity: typeof m.agentIdentity === 'string' ? m.agentIdentity : undefined,
              createdAt: typeof m.createdAt === 'string' ? m.createdAt : now,
              savedAt: now,
              lastActivityAt: typeof m.lastAccessedAt === 'string' ? m.lastAccessedAt : now,
            };
            folded++;
          }
        }
      }
    } catch (err) {
      result.errors.push(`threadline-conversations context fold: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (folded === 0) {
      result.skipped.push('threadline-conversations: nothing new to fold (already migrated)');
      return;
    }

    // Atomic write (backup + tmp + rename).
    try {
      store.lastModified = now;
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(convPath)) {
        try { fs.copyFileSync(convPath, `${convPath}.bak`); } catch { /* best-effort backup */ }
      }
      const tmp = `${convPath}.migrate-${process.pid}-${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
      fs.renameSync(tmp, convPath);
      result.upgraded.push(`threadline-conversations: folded ${folded} legacy thread(s) into conversations.json`);
    } catch (err) {
      result.errors.push(`threadline-conversations write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Threadline identity-discovery unification (THREADLINE-IDENTITY-DISCOVERY-
   * UNIFICATION-SPEC, Migration parity): existing agents may carry an
   * agent-info.json whose `publicKey` is the orphan identity-keys.json hex key
   * (or no `fingerprint` at all) while the relay routes by the canonical
   * identity.json fingerprint — so peers who discover them obtain a dead
   * address. The fixed announcePresence rewrites agent-info.json on every boot,
   * and the update path restarts the server, so the common case self-heals.
   * This is the belt-and-suspenders for the narrow window where the package
   * updates but the server has not yet restarted before a peer tries to
   * discover the agent.
   *
   * Resolves the routing identity via the SAME read-only API the relay client
   * uses (IdentityManager.get()). If it yields an identity whose fingerprint is
   * absent from / differs from agent-info.json, rewrites agent-info.json with
   * the consistent { fingerprint, publicKey(hex) } pair. No-op (never
   * fabricate) when get() is null (no identity, or locked-encrypted) or when
   * agent-info.json is already aligned. Atomic write; idempotent across runs;
   * last-writer-wins with a concurrent boot announce is safe (same value).
   */
  private migrateThreadlineAgentInfoIdentity(result: MigrationResult): void {
    const agentInfoPath = path.join(this.config.stateDir, 'threadline', 'agent-info.json');
    if (!fs.existsSync(agentInfoPath)) {
      result.skipped.push('threadline-agent-info-identity: no agent-info.json (agent never announced)');
      return;
    }

    // Resolve the routing identity — same API the relay client uses. Null when
    // no identity exists or canonical identity.json is locked-encrypted: do NOT
    // fabricate a dead address.
    const identity = new IdentityManager(this.config.stateDir).get();
    if (!identity) {
      result.skipped.push('threadline-agent-info-identity: no resolvable routing identity (none on disk or locked) — not fabricating');
      return;
    }

    const canonicalFingerprint = identity.fingerprint;
    const canonicalPublicKeyHex = identity.publicKey.toString('hex');

    let agentInfo: Record<string, unknown>;
    try {
      agentInfo = JSON.parse(fs.readFileSync(agentInfoPath, 'utf-8'));
    } catch {
      result.skipped.push('threadline-agent-info-identity: agent-info.json unreadable');
      return;
    }

    if (agentInfo.fingerprint === canonicalFingerprint && agentInfo.publicKey === canonicalPublicKeyHex) {
      result.skipped.push('threadline-agent-info-identity: already aligned with canonical identity');
      return;
    }

    agentInfo.fingerprint = canonicalFingerprint;
    agentInfo.publicKey = canonicalPublicKeyHex;
    agentInfo.updatedAt = new Date().toISOString();

    try {
      const tmp = `${agentInfoPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(agentInfo, null, 2));
      fs.renameSync(tmp, agentInfoPath);
      result.upgraded.push(`threadline-agent-info-identity: repaired agent-info.json to canonical fingerprint ${canonicalFingerprint.slice(0, 8)}…`);
    } catch (err) {
      result.errors.push(`threadline-agent-info-identity write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private migrateBootWrapperToCjs(result: MigrationResult): void {
    if (process.platform !== 'darwin') {
      result.skipped.push('boot-wrapper .cjs: non-darwin, no plist to migrate');
      return;
    }
    const label = `ai.instar.${this.config.projectName}`;
    const plistPath = path.join(
      process.env.HOME ?? '',
      'Library',
      'LaunchAgents',
      `${label}.plist`,
    );

    let content: string;
    try {
      content = fs.readFileSync(plistPath, 'utf-8');
    } catch {
      // No plist (not under launchd, or running under a different
      // supervision mechanism). Not an error.
      result.skipped.push('boot-wrapper .cjs: no launchd plist present');
      return;
    }

    // Already migrated — plist references .cjs and not .js.
    if (content.includes('instar-boot.cjs') && !/instar-boot\.js\b/.test(content)) {
      result.skipped.push('boot-wrapper .cjs: plist already references .cjs');
      return;
    }

    // No boot wrapper at all? That's a different shape (old bash-only
    // installs, hand-rolled plists) — leave it for the lifeline's
    // selfHealPlist to handle, since it has more context.
    if (!content.includes('instar-boot.js') && !content.includes('instar-boot.cjs')) {
      result.skipped.push('boot-wrapper .cjs: plist does not reference any instar-boot wrapper');
      return;
    }

    // Regenerate via installAutoStart, which writes the new .cjs wrapper
    // and updates the plist's ProgramArguments to point at it.
    try {
      const installed = installAutoStart(
        this.config.projectName,
        this.config.projectDir,
        this.config.hasTelegram,
      );
      if (installed) {
        result.upgraded.push('boot-wrapper .cjs: regenerated plist to reference instar-boot.cjs');
      } else {
        result.errors.push('boot-wrapper .cjs: installAutoStart returned false');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`boot-wrapper .cjs: ${msg}`);
    }
  }

  // ── Conversational-action catalog Playbook manifest (v0.2) ─────────
  //
  // Ships the conversational-catalog Playbook manifest template into
  // .instar/playbook/builtin-manifests/ so operators can mount it via
  // `instar playbook mount`. The actual mount registration stays operator-
  // initiated (per Playbook's design — mounts are explicit consent), but
  // the template file is shipped so it's available without a separate
  // download step.
  //
  // The Playbook item itself is a metadata pointer to the .instar/context/
  // conversational-actions.md segment (always-overwritten on update by the
  // ContextHierarchy initializer) and the `conversational-catalog`
  // SelfKnowledgeTree probe. The catalog content lives in the probe; the
  // Playbook item is the scoring/relevance signal.
  //
  // Idempotent via content-sniff (skip if existing file matches template).
  private migrateConversationalCatalogPlaybookManifest(result: MigrationResult): void {
    const builtinDir = path.join(this.config.stateDir, 'playbook', 'builtin-manifests');
    const targetPath = path.join(builtinDir, 'conversational-catalog.json');
    const templateContent = this.loadTemplate('playbook', 'conversational-catalog-manifest.json');
    if (templateContent === null) {
      // Built-in template missing — should never happen post-install, but
      // don't error out the update; just skip.
      result.skipped.push('conversational-catalog-playbook: template not found in package install');
      return;
    }

    if (fs.existsSync(targetPath)) {
      const existing = fs.readFileSync(targetPath, 'utf-8');
      if (existing === templateContent) {
        result.skipped.push('conversational-catalog-playbook: manifest up to date');
        return;
      }
    }

    fs.mkdirSync(builtinDir, { recursive: true });
    fs.writeFileSync(targetPath, templateContent);
    result.upgraded.push('conversational-catalog-playbook: installed/updated manifest template');
  }

  // ── Agent worktree convention (Layer 3) ────────────────────────────────
  //
  // Spec: docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md §"Layer 3 —
  // PostUpdateMigrator step (single-agent scope)".
  //
  // For every agent whose binary just updated, ensure the on-disk surface
  // is wired up so the convention works:
  //   1. Install/refresh `<agent_home>/.bin/instar-worktree-create.sh`
  //      (always-overwrite, per Migration Parity Standard).
  //   2. `<agent_home>/.gitignore` already covered by `migrateGitignore`
  //      consumers; we add a one-line direct ensure here as
  //      defense-in-depth for hosts whose project gitignore isn't reached.
  //   3. Ensure `<agent_home>/.worktrees/` exists with `0700`.
  //   4. If a pre-existing `worktree.repoUrlAllowlist` config blocks the
  //      resolved instar repo (or no repo is reachable), emit one
  //      AttentionItem so the operator can fix before the wrapper runs.
  //
  // Refuses any filesystem mutation when:
  //   - The agent home doesn't pass `<instarHome>/agents/<name>/` shape +
  //     registry-membership validation (project-bound agents living
  //     somewhere else simply opt out — the wrapper isn't applicable).
  //   - `<agent_home>/.bin` exists as a symlink (defeats the
  //     /usr/local/bin clobber attack surface).
  /**
   * OS resource hygiene (Responsible Resource Usage standard): ensure a
   * `.metadata_never_index` marker at the agent's `.worktrees/` container so
   * macOS Spotlight/mediaanalysisd stop re-indexing every worktree beneath it.
   * Existing agents accumulated dozens of worktrees before the create-path drop
   * existed; this backfills the marker so they get the relief on update. The
   * marker is honored recursively, harmless on non-macOS, and idempotent.
   */
  private migrateWorktreeSpotlightExclusion(result: MigrationResult): void {
    const agentHome = path.dirname(this.config.stateDir);
    let resolved: { agentHome: string; agentName: string };
    try {
      resolved = resolveAgentHomeForWorktree({ env: { INSTAR_AGENT_HOME: agentHome } });
    } catch {
      result.skipped.push('worktree-spotlight-exclusion: agent home does not match the convention');
      return;
    }
    const worktreesDir = path.join(resolved.agentHome, '.worktrees');
    if (!fs.existsSync(worktreesDir)) {
      result.skipped.push('worktree-spotlight-exclusion: no .worktrees/ directory');
      return;
    }
    try {
      const created = ensureWorktreeSpotlightExclusion(worktreesDir);
      if (created) {
        result.upgraded.push('worktree-spotlight-exclusion: dropped .metadata_never_index at .worktrees/ (excludes worktrees from Spotlight indexing)');
      } else {
        result.skipped.push('worktree-spotlight-exclusion: marker already present');
      }
    } catch (err) {
      result.errors.push(`worktree-spotlight-exclusion: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * OS resource hygiene (Responsible Resource Usage standard): exclude the agent's
   * node_modules trees from macOS Spotlight. The worktree exclusion above covers
   * `.worktrees/`, but the bigger churning set was never excluded — each agent home
   * carries a full `node_modules/` (~1.3GB / ~25k files measured) AND a
   * `.instar/shadow-install/node_modules/` (~600MB), re-indexed by Spotlight /
   * mediaanalysisd on every `npm ci` and every shadow-install update. Across a
   * ~10-agent fleet that is ~20GB of un-excluded node_modules — a top OS-level CPU
   * consumer (measured: Metadata.framework ~62% CPU). node_modules never need
   * Spotlight indexing, so the marker is unambiguously safe; it is honored
   * recursively, harmless on non-macOS, and idempotent. Reuses the generic
   * marker-dropper. (`ensureWorktreeSpotlightExclusion` is dir-agnostic.)
   */
  private migrateNodeModulesSpotlightExclusion(result: MigrationResult): void {
    const agentHome = path.dirname(this.config.stateDir);
    const dirs = [
      path.join(agentHome, 'node_modules'),
      path.join(this.config.stateDir, 'shadow-install', 'node_modules'),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        if (ensureWorktreeSpotlightExclusion(dir)) {
          const rel = path.relative(agentHome, dir) || dir;
          result.upgraded.push(`node-modules-spotlight-exclusion: dropped .metadata_never_index at ${rel} (excludes node_modules from Spotlight indexing)`);
        }
      } catch (err) {
        result.errors.push(`node-modules-spotlight-exclusion: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private migrateWorktreeConvention(result: MigrationResult): void {
    const agentHome = path.dirname(this.config.stateDir);

    // Validate the agent home against Layer 1's contract. We import the
    // resolver from InstarWorktreeManager so the rule lives in exactly one
    // place. If validation fails, the convention doesn't apply to this
    // agent and we skip silently (no error — project-bound agents with
    // bespoke layouts pass through unchanged).
    let resolved: { agentHome: string; agentName: string };
    try {
      resolved = resolveAgentHomeForWorktree({ env: { INSTAR_AGENT_HOME: agentHome } });
    } catch (err) {
      result.skipped.push(`worktree-convention: agent home does not match the convention (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      return;
    }

    // `.bin/` must be a real directory inside the agent home.
    const binDir = path.join(resolved.agentHome, '.bin');
    if (fs.existsSync(binDir)) {
      try {
        const lst = fs.lstatSync(binDir);
        if (lst.isSymbolicLink()) {
          result.errors.push(`worktree-convention: ${binDir} is a symlink — refused (defeats /usr/local/bin clobber surface)`);
          return;
        }
      } catch (err) {
        result.errors.push(`worktree-convention: stat ${binDir} failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else {
      fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
    }

    // Always-overwrite the wrapper (Migration Parity Standard for hook
    // scripts: built-in templates are authoritative).
    const wrapperTargetPath = path.join(binDir, 'instar-worktree-create.sh');
    const templateContent = this.loadTemplate('scripts', 'instar-worktree-create.sh');
    if (templateContent === null) {
      result.skipped.push('worktree-convention: wrapper template not found in package install');
      return;
    }
    try {
      const existing = fs.existsSync(wrapperTargetPath)
        ? fs.readFileSync(wrapperTargetPath, 'utf-8')
        : null;
      if (existing !== templateContent) {
        fs.writeFileSync(wrapperTargetPath, templateContent, { mode: 0o755 });
        // Re-assert mode (umask masking can drop the +x bit on existing files).
        fs.chmodSync(wrapperTargetPath, 0o755);
        result.upgraded.push('worktree-convention: installed/refreshed instar-worktree-create.sh');
      } else {
        // Re-assert mode even when content matches — defends against an
        // operator's `chmod -R` that may have dropped the +x bit.
        try { fs.chmodSync(wrapperTargetPath, 0o755); } catch { /* @silent-fallback-ok — best-effort */ }
        result.skipped.push('worktree-convention: instar-worktree-create.sh up to date');
      }
    } catch (err) {
      result.errors.push(`worktree-convention: wrapper install failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Ensure `<agent_home>/.gitignore` contains `.worktrees/`. Defense-in-
    // depth — the v1.1.0 `GITIGNORE_ENTRIES` change covers fresh inits and
    // any agent whose .gitignore flows through `ensureGitignore` on
    // update, but agents with hand-crafted gitignores may not reach it.
    try {
      const gitignorePath = path.join(resolved.agentHome, '.gitignore');
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
      const hasEntry = /^\s*\.worktrees\/?\s*$/m.test(existing);
      if (!hasEntry) {
        const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        const block = `${sep}\n# Sandbox-safe worktrees (per-machine; multi-GB foreign-repo contents)\n.worktrees/\n`;
        fs.writeFileSync(gitignorePath, existing + block);
        result.upgraded.push('worktree-convention: added .worktrees/ to agent-home .gitignore');
      } else {
        result.skipped.push('worktree-convention: .gitignore already excludes .worktrees/');
      }
    } catch (err) {
      result.errors.push(`worktree-convention: gitignore patch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Ensure `<agent_home>/.worktrees/` exists with 0700.
    try {
      const worktreesDir = path.join(resolved.agentHome, '.worktrees');
      if (!fs.existsSync(worktreesDir)) {
        fs.mkdirSync(worktreesDir, { recursive: true, mode: 0o700 });
      }
      fs.chmodSync(worktreesDir, 0o700);
    } catch (err) {
      result.errors.push(`worktree-convention: .worktrees/ ensure failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Async migration superset — runs the sync migrate() then performs the
   * async parity-renderings backfill that needs rule.remediate() Promises.
   * Callers in async contexts should prefer migrateAsync() to ensure all
   * post-update side effects (including primitive-rendering backfill) are
   * complete before returning.
   *
   * Sync callers can still use migrate() and rely on the next async pass to
   * pick up the parity backfill. The marker in _instar_migrations ensures
   * the backfill runs exactly once even across mixed sync/async callers.
   */
  async migrateAsync(): Promise<MigrationResult> {
    const result = this.migrate();
    try {
      await this.migrateParityRenderings(result);
    } catch (err) {
      result.errors.push(`parity-renderings: backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  }

  // ── Parity Rule Rendering Backfill ─────────────────────────────────
  //
  // For every registered parity rule (Layer-3 functional primitive), iterate
  // its canonical instances and call remediate() for each enabled framework.
  // This is the Migration Parity §5-style backfill for primitive-renderings
  // that PRs #252 (Skill), #253 (Hook), #254 (Memory) deferred — existing
  // deployed agents pick up the canonical→framework rendering on update.
  //
  // skillParityRule: refuse-on-conflict (per §5). User-edited skill files
  //   are preserved with operator-action requirement.
  // hookParityRule: alwaysOverwrite=true (per §4). Built-in hooks ALWAYS
  //   re-render from canonical; user edits captured in audit event for
  //   git-recovery.
  // memoryParityRule: refuse-on-conflict (per §5). Memory canonical content
  //   is operator-managed; system never clobbers.
  //
  // Idempotent via _instar_migrations marker AND each rule's verify-first
  // pattern (no-op when rendering matches canonical).
  private async migrateParityRenderings(result: MigrationResult): Promise<void> {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('parity-renderings: config.json not found');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`parity-renderings: config.json read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const migrations = (config._instar_migrations ?? []) as string[];
    const marker = 'parity-renderings-backfill-v1';
    if (migrations.some(m => m.startsWith(marker))) {
      result.skipped.push('parity-renderings: already migrated');
      return;
    }

    // Lazy-import registry so PostUpdateMigrator doesn't pull the entire
    // parity graph at startup for agents that never invoke migrate().
    const { listParityRules } = await import('../providers/parity/registry.js');

    // Single source of truth for framework gating (see getEnabledFrameworks).
    const frameworks = this.getEnabledFrameworks();

    const rules = listParityRules();
    let renderedCount = 0;
    let skippedCount = 0;
    for (const rule of rules) {
      let instances: string[];
      try {
        instances = await rule.listInstances(this.config.projectDir);
      } catch (err) {
        result.errors.push(`parity-renderings: ${rule.primitive} listInstances failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const instance of instances) {
        for (const framework of frameworks) {
          if (!rule.frameworks.includes(framework)) continue;
          try {
            await rule.remediate(this.config.projectDir, instance, framework);
            renderedCount += 1;
            result.upgraded.push(`parity-renderings: ${rule.primitive}/${instance} → ${framework}`);
          } catch (err) {
            // refuse-on-conflict (mirror-trust without alwaysOverwrite) is
            // expected for user-edited renderings — not an error, just a
            // skip. Capture for visibility.
            const msg = err instanceof Error ? err.message : String(err);
            // Per Migration Parity §5, rules may legitimately refuse to
            // remediate. Two documented refuse patterns:
            //   - 'user-edit-conflict' (skill rule per §5)
            //   - 'refused to remediate' (memory rule — never auto-regenerates
            //     identity/learning artifacts; see specs/instar-concepts/memory.md)
            // Both are skips, not errors. Operator resolves manually.
            const isRefuse = msg.includes('user-edit-conflict') || msg.includes('refused to remediate');
            if (isRefuse) {
              skippedCount += 1;
              result.skipped.push(`parity-renderings: ${rule.primitive}/${instance} on ${framework} — ${msg}`);
            } else {
              result.errors.push(`parity-renderings: ${rule.primitive}/${instance} on ${framework} — ${msg}`);
            }
          }
        }
      }
    }

    // Mark migration complete regardless of per-instance skips — the marker
    // means "this backfill pass ran successfully," not "every rendering
    // succeeded." Operators resolve user-edit-conflicts via /spec-converge.
    migrations.push(`${marker}-${new Date().toISOString()}`);
    config._instar_migrations = migrations;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    if (renderedCount === 0 && skippedCount === 0) {
      result.skipped.push('parity-renderings: no canonical instances found (new agent or no primitives shipped yet)');
    }
  }

  // ── Parity Sentinel trust profile seed ─────────────────────────────
  //
  // FrameworkParitySentinel.shouldRemediate now consults AdaptiveTrust on
  // mirror-trust rules: trust level 'log' or 'autonomous' allows remediation,
  // 'approve-*' or 'blocked' downgrades to flag-only. AdaptiveTrust's
  // DEFAULT_TRUST for 'modify' is 'approve-always', which would silently turn
  // every mirror-trust rule into flag-only for existing agents on update.
  //
  // This migration seeds state/trust-profile.json with a parity-sentinel
  // service entry at level 'log' (auto-elevatable, never blocking by default)
  // so existing agents preserve the v0.1 remediate-by-default behavior. New
  // agents get the same seed via the natural AdaptiveTrust flow once the
  // sentinel first calls getTrustLevel.
  //
  // Idempotent: re-runs are no-ops via the _instar_migrations marker AND a
  // content-sniff (skip if parity-sentinel service entry already exists).
  private migrateParitySentinelTrust(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    const trustProfilePath = path.join(this.config.stateDir, 'state', 'trust-profile.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('parity-sentinel-trust: config.json not found');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`parity-sentinel-trust: config.json read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const migrations = (config._instar_migrations ?? []) as string[];
    const marker = 'parity-sentinel-trust-seed';
    if (migrations.some(m => m.startsWith(marker))) {
      result.skipped.push('parity-sentinel-trust: already migrated');
      return;
    }

    // Load existing trust profile (or create skeleton). Content-sniff: skip
    // if a parity-sentinel service entry already exists (operator-set).
    let profile: {
      services: Record<string, {
        service: string;
        operations: Record<string, { level: string; source: string; changedAt: string }>;
        history: { successCount: number; incidentCount: number; streakSinceIncident: number };
      }>;
      global: { maturity: number; lastEvent: string; lastEventAt: string; floor: string };
    };
    try {
      if (fs.existsSync(trustProfilePath)) {
        profile = JSON.parse(fs.readFileSync(trustProfilePath, 'utf-8'));
      } else {
        profile = {
          services: {},
          global: {
            maturity: 0,
            lastEvent: 'Profile created by parity-sentinel-trust-seed migration',
            lastEventAt: new Date().toISOString(),
            floor: 'collaborative',
          },
        };
      }
    } catch (err) {
      result.errors.push(`parity-sentinel-trust: trust-profile.json read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (profile.services['parity-sentinel']) {
      // Operator already configured it — never overwrite. Mark migration done.
      migrations.push(`${marker}-${new Date().toISOString()}-existing-entry-preserved`);
      config._instar_migrations = migrations;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      result.skipped.push('parity-sentinel-trust: existing entry preserved');
      return;
    }

    const now = new Date().toISOString();
    profile.services['parity-sentinel'] = {
      service: 'parity-sentinel',
      operations: {
        modify: { level: 'log', source: 'default', changedAt: now },
      },
      history: { successCount: 0, incidentCount: 0, streakSinceIncident: 0 },
    };

    // Ensure state dir exists before writing the profile.
    const stateDir = path.dirname(trustProfilePath);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    fs.writeFileSync(trustProfilePath, JSON.stringify(profile, null, 2));

    migrations.push(`${marker}-${now}`);
    config._instar_migrations = migrations;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    result.upgraded.push('parity-sentinel-trust: seeded trust profile entry at level=log');
  }

  // ── Provider portability v1.0.0 — Phase 7 migration entry ──────────
  //
  // Idempotent migrator that runs on every `instar update`. Confirms the
  // agent's config is portable-ready and records the migration in
  // `_instar_migrations` so re-runs are no-ops. Auto-detects Codex CLI
  // presence and surfaces it in the result for the user-visible upgrade
  // path. No config mutation beyond the migration marker — the runtime
  // frameworkBinaryPaths population in Config.ts is the load-bearing
  // piece, and it runs at every boot.
  //
  // What this migrator INTENTIONALLY does NOT do:
  //  - Flip an existing Claude-only agent to a different framework
  //    default (operator choice via /route or topicFrameworks config).
  //  - Force-install Codex CLI (user's package-manager choice).
  //  - Write any credentials (Spec 12 Rule 1 — subscription-only path).
  private migrateProviderPortability(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('provider-portability: config.json not found');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`provider-portability: config.json read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const migrations = (config._instar_migrations ?? []) as string[];
    const marker = 'provider-portability-v1.0.0';
    const alreadyMigrated = migrations.some(m => m.startsWith(marker));

    if (alreadyMigrated) {
      result.skipped.push('provider-portability: already migrated');
      return;
    }

    // Best-effort backup snapshot. The BackupManager handles the actual
    // snapshot; we just record a migration marker. If a future
    // hard-refuse phase ever rolls back, the user can restore the
    // pre-migration state.
    const detectedCodex = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { detectCodexPath } = require('./Config.js') as typeof import('./Config.js');
        return detectCodexPath();
      } catch { return null; }
    })();

    // Mark migration complete. No config field mutations — frameworkBinaryPaths
    // is rebuilt at every server boot from live detection.
    migrations.push(`${marker}-${new Date().toISOString()}`);
    config._instar_migrations = migrations;

    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      const codexNote = detectedCodex
        ? `Codex CLI detected at ${detectedCodex} — portable to Codex via /route or topicFrameworks config.`
        : 'Codex CLI not detected — install via `npm i -g @openai/codex` to enable Codex routing.';
      result.upgraded.push(`provider-portability: v1.0.0 migration recorded. ${codexNote}`);
    } catch (err) {
      result.errors.push(`provider-portability: config.json write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Fleet watchdog (lifeline-shadow-install-self-heal spec) ──────────
  //
  // The user-machine fleet watchdog supervises ALL instar agents on the host.
  // It used to be a hand-rolled script at ~/.instar/instar-watchdog.sh with no
  // source-of-truth or migration path. It now ships from
  // `src/templates/scripts/instar-watchdog.sh` and is overwritten on every
  // update so existing agents pick up improvements (PATH fixes, peer
  // escalation, etc.).
  //
  // This migration runs in every agent's PostUpdateMigrator pass, but the
  // installation it performs is per-machine (singleton). Multiple agents
  // updating concurrently will produce identical writes — acceptable.
  //
  // Skipped on non-darwin (launchd plist is macOS-specific).
  private migrateFleetWatchdog(result: MigrationResult): void {
    if (process.platform !== 'darwin') {
      result.skipped.push('fleet-watchdog: non-darwin platform');
      return;
    }

    const scriptPath = path.join(os.homedir(), '.instar', 'instar-watchdog.sh');
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.instar.watchdog.plist');

    const scriptBody = this.loadTemplate('scripts', 'instar-watchdog.sh');
    if (scriptBody === null) {
      result.skipped.push('fleet-watchdog: template not found in dist or src');
      return;
    }

    const launchdPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
    const stdoutPath = path.join(os.homedir(), '.instar', 'watchdog-launchd.log');
    const stderrPath = path.join(os.homedir(), '.instar', 'watchdog-launchd.err');

    const escapeXml = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
       .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.instar.watchdog</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${escapeXml(scriptPath)}</string>
    </array>
    <key>StartInterval</key>
    <integer>300</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(launchdPath)}</string>
    </dict>
</dict>
</plist>`;

    try {
      // Compare against current contents to avoid noisy re-installs.
      const scriptCurrent = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf-8') : '';
      const plistCurrent = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf-8') : '';
      const scriptChanged = scriptCurrent !== scriptBody;
      const plistChanged = plistCurrent !== plistBody;
      if (!scriptChanged && !plistChanged) {
        result.skipped.push('fleet-watchdog: already up to date');
        return;
      }

      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      if (scriptChanged) fs.writeFileSync(scriptPath, scriptBody, { mode: 0o755 });
      if (plistChanged) fs.writeFileSync(plistPath, plistBody);

      // Validate plist before triggering launchd
      try {
        execFileSync('plutil', ['-lint', plistPath], { stdio: 'pipe' });
      } catch (err) {
        const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr) : '';
        result.errors.push(`fleet-watchdog: plist validation failed: ${stderr}`);
        return;
      }

      // Reload only if plist changed (script-only changes don't need launchd touch).
      if (plistChanged) {
        const uid = process.getuid?.() ?? 501;
        try { execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' }); } catch { /* not loaded */ }
        try { execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' }); } catch { /* non-fatal */ }
      }

      result.upgraded.push(
        `fleet-watchdog: updated (script=${scriptChanged}, plist=${plistChanged})`
      );
    } catch (err) {
      result.errors.push(`fleet-watchdog: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Context-death anti-pattern (PR1 — context-death-pitfall-
  //    prevention spec § (a)) ────────────────────────────────────────
  //
  // Injects the "Context-Death Self-Stop" anti-pattern marker block
  // into CLAUDE.md (under "Critical Anti-Patterns") and AGENT.md
  // (under "My Principles") when absent. Idempotent: if the marker
  // is already present, nothing happens. Honors .instar/identity-
  // pins.json — if an entry exists for the marker id, the block is
  // skipped (user has customized).
  //
  // The marker is a literal HTML comment pair:
  //   <!-- INSTAR:ANTI-PATTERN-CONTEXT-DEATH -->
  //   ...content...
  //   <!-- /INSTAR:ANTI-PATTERN-CONTEXT-DEATH -->
  //
  // Pin file format (local, agent-side only):
  //   { "INSTAR:ANTI-PATTERN-CONTEXT-DEATH": { "contentHash": "sha256...",
  //                                             "pinnedAt": "<ISO>" } }
  private migrateContextDeathAntiPattern(result: MigrationResult): void {
    const markerId = 'INSTAR:ANTI-PATTERN-CONTEXT-DEATH';
    const pins = this.readIdentityPins();

    if (pins[markerId]) {
      result.skipped.push(`${markerId}: pinned in .instar/identity-pins.json — skip`);
      return;
    }

    const claudeBlock = [
      `<!-- ${markerId} -->`,
      '**"Context-Death Self-Stop"** — Do not self-terminate mid-plan citing context preservation, context-window concerns, or "let\'s continue in a fresh session" when durable artifacts for the plan exist on disk (committed code, plan files, ledger rows). Compaction-recovery re-injects identity, memory, and recent context automatically; worst case is a ~30s re-read of the plan file. Legitimate stops: real design questions, missing information only the user can provide, genuine errors, completion. Context-preservation is NOT a legitimate stop reason on its own. If you catch yourself reaching for it, check the durable artifact instead and keep going.',
      `<!-- /${markerId} -->`,
    ].join('\n');

    const agentBlock = [
      `<!-- ${markerId} -->`,
      '**No context-death self-stops.** I do not self-terminate mid-plan citing context preservation, context-window concerns, or "let\'s continue in a fresh session" when durable artifacts (committed code, plan files, ledger rows) exist on disk. Compaction-recovery re-injects my identity, memory, and recent context automatically — worst case is a ~30s re-read of the plan file. Legitimate stops are real design questions, missing information only the user can provide, genuine errors, or completion. Context preservation is not a legitimate stop reason on its own. If I catch myself reaching for that rationalization, I verify the durable artifact exists and keep going.',
      `<!-- /${markerId} -->`,
    ].join('\n');

    // ── CLAUDE.md — insert inside "Critical Anti-Patterns" section ──
    const claudeMdPath = path.join(this.config.projectDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      try {
        let content = fs.readFileSync(claudeMdPath, 'utf-8');
        if (!content.includes(markerId)) {
          // Anchor: end of "Critical Anti-Patterns" (just before next
          // `## ` heading) — falls back to append if section absent.
          const antiPatternsIdx = content.indexOf('## Critical Anti-Patterns');
          if (antiPatternsIdx >= 0) {
            // Find the next top-level heading after Critical Anti-Patterns.
            const afterHeader = antiPatternsIdx + '## Critical Anti-Patterns'.length;
            const nextHeadingIdx = content.indexOf('\n## ', afterHeader);
            const insertAt = nextHeadingIdx >= 0 ? nextHeadingIdx : content.length;
            content = content.slice(0, insertAt) + '\n' + claudeBlock + '\n' + content.slice(insertAt);
          } else {
            content += '\n\n## Critical Anti-Patterns\n\n' + claudeBlock + '\n';
          }
          fs.writeFileSync(claudeMdPath, content);
          result.upgraded.push(`CLAUDE.md: added ${markerId} marker block`);
        } else {
          result.skipped.push(`CLAUDE.md: ${markerId} marker already present`);
        }
      } catch (err) {
        result.errors.push(`CLAUDE.md ${markerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── AGENT.md — append the block inside "My Principles" section ──
    const agentMdPath = path.join(this.config.stateDir, 'AGENT.md');
    if (fs.existsSync(agentMdPath)) {
      try {
        let content = fs.readFileSync(agentMdPath, 'utf-8');
        if (!content.includes(markerId)) {
          const principlesIdx = content.indexOf('## My Principles');
          if (principlesIdx >= 0) {
            const afterHeader = principlesIdx + '## My Principles'.length;
            const nextHeadingIdx = content.indexOf('\n## ', afterHeader);
            const insertAt = nextHeadingIdx >= 0 ? nextHeadingIdx : content.length;
            content = content.slice(0, insertAt) + '\n' + agentBlock + '\n' + content.slice(insertAt);
          } else {
            content += '\n\n## My Principles\n\n' + agentBlock + '\n';
          }
          fs.writeFileSync(agentMdPath, content);
          result.upgraded.push(`AGENT.md: added ${markerId} marker block`);
        } else {
          result.skipped.push(`AGENT.md: ${markerId} marker already present`);
        }
      } catch (err) {
        result.errors.push(`AGENT.md ${markerId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Read `.instar/identity-pins.json` if present. Returns an object
   * keyed by marker id; missing file or malformed JSON yields `{}`
   * (soft-fail — a broken pin file shouldn't block every migration).
   */
  private readIdentityPins(): Record<string, { contentHash?: string; pinnedAt?: string }> {
    const pinsPath = path.join(this.config.stateDir, 'identity-pins.json');
    if (!fs.existsSync(pinsPath)) return {};
    try {
      const raw = fs.readFileSync(pinsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Upgrade built-in skills that hardcoded a localhost port at install time
   * to use a runtime-expandable ${INSTAR_PORT:-PORT} pattern.
   *
   * Background: installBuiltinSkills used to template the port at install.
   * Users who later changed their server port ended up with stale URLs in
   * their skills. This migration rewrites `http://localhost:NNNN/` to
   * `http://localhost:${INSTAR_PORT:-NNNN}/` in the known-default skill set.
   *
   * Idempotent: skips files that already use the dynamic pattern.
   * Scoped: only touches skills from the installBuiltinSkills set — custom
   * skills are never modified.
   */
  private migrateSkillPortHardcoding(result: MigrationResult): void {
    const defaultSkills = [
      'evolve', 'learn', 'gaps', 'commit-action', 'feedback',
      'triage-findings', 'reflect', 'coherence-audit', 'degradation-digest',
      'state-integrity-check', 'memory-hygiene', 'guardian-pulse',
      'session-continuity-check', 'git-sync',
    ];
    const skillsDir = path.join(this.config.projectDir, '.claude', 'skills');
    const hardcodedRe = /http:\/\/localhost:(\d+)\//g;
    const dynamicMarker = '${INSTAR_PORT:-';

    for (const name of defaultSkills) {
      const skillFile = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      try {
        const original = fs.readFileSync(skillFile, 'utf8');
        if (original.includes(dynamicMarker)) continue;
        if (!hardcodedRe.test(original)) continue;
        hardcodedRe.lastIndex = 0;
        const updated = original.replace(hardcodedRe, (_m, p) => `http://localhost:\${INSTAR_PORT:-${p}}/`);
        if (updated !== original) {
          fs.writeFileSync(skillFile, updated);
          result.upgraded.push(`skills/${name}/SKILL.md (hardcoded port -> \${INSTAR_PORT:-NNNN})`);
        }
      } catch (err) {
        result.errors.push(`skills/${name}/SKILL.md port migration: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Update the /build skill with the GSD-cherry-pick methodology sections
   * (Phase 0.5 must-haves + STRIDE, atomic-commit discipline, SUMMARY
   * deviation-tracking). installBuildSkill is install-if-missing, so existing
   * agents need an explicit content-update migration.
   *
   * Idempotent + conservative: only re-copies the bundled SKILL.md when the
   * installed copy (a) lacks the new "Phase 0.5: MUST-HAVES" marker AND
   * (b) still looks like the stock /build skill (contains "Rigorous Build
   * Skill" + "Phase 5: COMPLETE"). A heavily-customized /build skill that no
   * longer matches the stock fingerprint is left untouched.
   */
  private migrateBuildSkillMethodology(result: MigrationResult): void {
    try {
      const skillFile = path.join(this.config.projectDir, '.claude', 'skills', 'build', 'SKILL.md');
      if (!fs.existsSync(skillFile)) return; // installBuildSkill handles fresh installs
      const current = fs.readFileSync(skillFile, 'utf8');
      if (current.includes('Phase 0.5: MUST-HAVES')) return; // already updated — idempotent
      // Stock-fingerprint guard: don't clobber a customized /build skill.
      if (!current.includes('Rigorous Build Skill') || !current.includes('Phase 5: COMPLETE')) {
        result.skipped.push('skills/build/SKILL.md: customized — left untouched (no methodology update)');
        return;
      }
      // Re-copy the bundled SKILL.md (which carries the new sections).
      const bundled = path.join(__dirname, '..', '..', '.claude', 'skills', 'build', 'SKILL.md');
      if (!fs.existsSync(bundled)) return;
      const next = fs.readFileSync(bundled, 'utf8');
      if (next.includes('Phase 0.5: MUST-HAVES')) {
        fs.writeFileSync(skillFile, next);
        result.upgraded.push('skills/build/SKILL.md (GSD methodology: must-haves + atomic-commit + SUMMARY deviations)');
      }
    } catch (err) {
      result.errors.push(`skills/build/SKILL.md methodology migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update the deployed test-as-self SKILL.md to the Part 2.1 version that leads
   * with the one-button `instar test-as-self` command (manual recipe demoted to
   * fallback). installBuiltinSkills is install-if-missing, so existing agents
   * never get the updated content through init — this dedicated migration is the
   * only path (Migration Parity Standard, "updating existing skill content").
   *
   * Idempotent + conservative: re-copy the bundled SKILL.md only when the
   * installed copy (a) lacks the Part 2.1 MARKER AND (b) still matches the stock
   * FINGERPRINT. A customized skill is left untouched.
   */
  private migrateTestAsSelfSkill(result: MigrationResult): void {
    try {
      const skillFile = path.join(this.config.projectDir, '.claude', 'skills', 'test-as-self', 'SKILL.md');
      if (!fs.existsSync(skillFile)) return; // installBuiltinSkills handles fresh installs
      const current = fs.readFileSync(skillFile, 'utf8');
      const MARKER = 'The one-button path (Part 2.1';
      if (current.includes(MARKER)) return; // already updated — idempotent
      // Stock-fingerprint guard: don't clobber a customized test-as-self skill.
      if (!current.includes('Throwaway-Deploy Harness') || !current.includes('verify.mjs')) {
        result.skipped.push('skills/test-as-self/SKILL.md: customized — left untouched (no Part 2.1 update)');
        return;
      }
      const bundled = path.join(__dirname, '..', '..', '.claude', 'skills', 'test-as-self', 'SKILL.md');
      if (!fs.existsSync(bundled)) return;
      const next = fs.readFileSync(bundled, 'utf8');
      if (next.includes(MARKER)) {
        fs.writeFileSync(skillFile, next);
        result.upgraded.push('skills/test-as-self/SKILL.md (Part 2.1: one-button instar test-as-self leads; manual recipe demoted)');
      }
    } catch (err) {
      result.errors.push(`skills/test-as-self/SKILL.md migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Update the deployed autonomous skill files (stop hook + setup script) to the
   * current bundled versions. This covers both the topic-keyed ownership fix
   * (v1.2.55: restarts no longer silently kill autonomy) AND multi-session
   * per-topic state (each topic runs its own autonomous job from
   * .instar/autonomous/<topicId>.local.md).
   *
   * installAutonomousSkill() is install-if-missing, so existing agents never get
   * these through init — a dedicated migration is the only path (Migration Parity
   * Standard, "updating existing skill content").
   *
   * Idempotent + conservative per file: re-copy the bundled file only when the
   * installed copy (a) lacks the current capability MARKER AND (b) still matches
   * the stock FINGERPRINT. A customized file is left untouched. The marker is the
   * multi-session signature so v1.2.55 topic-keyed installs (which lack it) still
   * receive this upgrade.
   */
  private migrateAutonomousStopHookTopicKeyed(result: MigrationResult): void {
    const upgrade = (
      relPath: string, marker: string, fingerprint: string, label: string,
    ): void => {
      try {
        const deployed = path.join(this.config.projectDir, ...relPath.split('/'));
        if (!fs.existsSync(deployed)) return; // installAutonomousSkill handles fresh installs
        const current = fs.readFileSync(deployed, 'utf8');
        if (current.includes(marker)) return; // already current — idempotent
        if (!current.includes(fingerprint)) {
          result.skipped.push(`${relPath}: customized — left untouched`);
          return;
        }
        const bundled = path.join(__dirname, '..', '..', ...relPath.split('/'));
        if (!fs.existsSync(bundled)) return;
        const next = fs.readFileSync(bundled, 'utf8');
        if (next.includes(marker)) {
          fs.writeFileSync(deployed, next);
          fs.chmodSync(deployed, 0o755);
          result.upgraded.push(label);
        }
      } catch (err) {
        result.errors.push(`${relPath} migration: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // Marker = the latest capability signature (bumped each time the bundled hook/
    // setup gains a feature, so prior installs upgrade): now `p13_stop_allowed` —
    // the autonomous stop-hook now consults the P13 "The Stop Reason Is the Work"
    // guard (POST /autonomous/evaluate-stop) before approving a completion, so a stop
    // resting on a judgment-call / needs-engineering deferral keeps working instead of
    // exiting. This marker is ABSENT from prior installs (which carry the older
    // `codex-stdout-json-safe` signature but not the P13 guard), so bumping to it
    // re-deploys the updated hook to every existing agent; the bundled hook retains all
    // prior features (codex stdout-safe, native /goal); customized hooks (no stock
    // fingerprint) are still left untouched.
    upgrade(
      '.claude/skills/autonomous/hooks/autonomous-stop-hook.sh',
      'p13_stop_allowed',
      'Autonomous Mode Stop Hook',
      'skills/autonomous/hooks/autonomous-stop-hook.sh (P13 stop-reason guard — evaluate-stop before approving a completion)',
    );
    // setup-autonomous.sh marker bumped `native-goal/set` → `IS_CODEX_AGENT`: the bundled
    // setup now ALSO auto-delegates to native /goal for CODEX agents (the prior native /goal
    // wiring was gated on `claude --version >= 2.1.139`, which is empty for a codex agent, so
    // codex autonomous jobs fell through to the dark Phase-1 codexLoopDriver no-op and never
    // sustained multi-turn). Bumping the marker re-deploys the FIXED setup to existing agents
    // (which carry `native-goal/set` but not `IS_CODEX_AGENT`); customized scripts (no stock
    // `autonomous-state.local.md` fingerprint) are still left untouched.
    upgrade(
      '.claude/skills/autonomous/scripts/setup-autonomous.sh',
      'IS_CODEX_AGENT',
      'autonomous-state.local.md',
      'skills/autonomous/scripts/setup-autonomous.sh (codex native /goal auto-wire)',
    );
  }

  /**
   * Deploy any missing built-in skills (e.g., guardian job skills added after initial setup).
   * Non-destructive — only writes SKILL.md files that don't already exist.
   */
  private migrateBuiltinSkills(result: MigrationResult): void {
    try {
      const skillsDir = path.join(this.config.projectDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      installBuiltinSkills(skillsDir, this.config.port);
      result.skipped.push('built-in skills: checked (non-destructive)');
    } catch (err) {
      result.errors.push(`built-in skills: ${err}`);
    }
  }

  /**
   * Phase 2 — install/refresh built-in agentmd jobs. Copies the shipped
   * markdown templates into `.instar/jobs/instar/` and writes their
   * per-slug manifests. Honors operator-disabled state (preserves
   * `enabled: false` + `disabledAtBodyHash` across updates). Retires
   * jobs that are no longer shipped.
   *
   * The `.instar/jobs/user/` namespace is structurally untouched (Seamless
   * Migration Guarantee invariant 4).
   */
  private migrateBuiltinJobs(result: MigrationResult): void {
    try {
      // The package root is two levels up from this compiled module (dist/core/),
      // which puts us at the installed npm package root in production or the
      // repo root in dev.
      const packageRoot = path.resolve(__dirname, '..', '..');
      const report = installBuiltinJobs({
        agentStateDir: this.config.stateDir,
        packageRoot,
        port: this.config.port,
      });
      if (report.installed.length > 0) {
        result.upgraded.push(`built-in agentmd jobs: ${report.installed.length} installed/refreshed`);
      } else if (report.errors.length === 0) {
        result.skipped.push('built-in agentmd jobs: nothing to install');
      }
      for (const slug of report.retired) {
        result.upgraded.push(`built-in agentmd jobs: retired "${slug}"`);
      }
      for (const e of report.errors) {
        result.errors.push(`built-in agentmd jobs${e.slug ? ` [${e.slug}]` : ''}: ${e.reason}`);
      }
    } catch (err) {
      result.errors.push(`built-in agentmd jobs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Phase 5 — auto-run `instar jobs migrate` for pre-spec agents on update.
   *
   * Behavior:
   *   - SKIP entirely if `.instar/jobs/.migration-complete.json` exists
   *     (operator already confirmed completion via Dashboard).
   *   - SKIP entirely if `.instar/jobs/.migration-abandoned.json` exists
   *     (operator explicitly chose to roll back).
   *   - SKIP if `.instar/jobs.json` is absent (nothing to migrate).
   *   - Otherwise, invoke `jobsMigrate({ defaultAction: 'fork' })` —
   *     fork policy preserves the operator's customized body in user/
   *     namespace, never silently drops content. This is the
   *     spec-mandated default for the auto-run path.
   *   - Emit a Dashboard banner event via the migration result so the
   *     operator sees "migration ran on update — confirm in Dashboard."
   *
   * Seamless Migration Guarantee invariants enforced at this layer
   * (PR #180 §Seamless Migration Guarantee):
   *   #6 in-flight protection — JobScheduler.activeRuns() check is
   *      currently a defensive no-op until Phase 4 wires the scheduler
   *      back-reference; the migration runs at update time, before the
   *      new scheduler instance comes up, so by construction nothing is
   *      in flight.
   *   #7 transactional safety on interrupt — `jobsMigrate` is structurally
   *      safe (backup-first, idempotent, rollback via --abandon).
   *   #8 telemetry — outcome is appended to result.upgraded/errors.
   */
  private autoMigrateLegacyJobsJson(result: MigrationResult): void {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      const stateDir = this.config.stateDir;
      const jobsJsonPath = path.join(stateDir, 'jobs.json');
      const jobsRoot = path.join(stateDir, 'jobs');
      const completedMarker = path.join(jobsRoot, '.migration-complete.json');
      const abandonedMarker = path.join(jobsRoot, '.migration-abandoned.json');

      if (!fs.existsSync(jobsJsonPath)) {
        return; // nothing to migrate
      }
      if (fs.existsSync(completedMarker)) {
        result.skipped.push('legacy jobs.json migration: already complete (operator-confirmed)');
        return;
      }
      if (fs.existsSync(abandonedMarker)) {
        result.skipped.push('legacy jobs.json migration: explicitly abandoned by operator');
        return;
      }

      // Snapshot pre-migration state so the runtime invariant gate has
      // ground truth to compare against. Per spec §Gate wiring:
      // "Before performing any destructive write, the migrator re-verifies
      //  invariants 1, 2, 4, and 6 against the staged state. Failure aborts
      //  to fail-closed (invariant 9)."
      let preMigrationJobs: any[] = [];
      try {
        preMigrationJobs = JSON.parse(fs.readFileSync(jobsJsonPath, 'utf-8'));
        if (!Array.isArray(preMigrationJobs)) preMigrationJobs = [];
      } catch {
        preMigrationJobs = [];
      }
      const preMigrationUserSnapshot = snapshotUserNamespace(stateDir);

      const packageRoot = path.resolve(__dirname, '..', '..');
      const instarVersion = this.readBundledInstarVersion(packageRoot);
      const outcome = jobsMigrate({
        agentStateDir: stateDir,
        packageRoot,
        defaultAction: 'fork',
      });

      if (outcome.status === 'completed') {
        // Runtime invariant gate. Spec §Seamless Migration Guarantee #1, #2, #4.
        // Invariant 6 (in-flight) is structurally satisfied at update-apply
        // time because no jobs run mid-update.
        const verification = verifyMigrationInvariants({
          agentStateDir: stateDir,
          preMigrationJobs,
          preMigrationUserSnapshot,
        });

        if (!verification.ok) {
          // Fail-closed (invariant 9): roll back via abandon.
          try {
            jobsMigrate({ agentStateDir: stateDir, packageRoot, abandon: true });
          } catch (rollbackErr) {
            result.errors.push(
              `legacy jobs.json migration: invariant verification failed AND rollback errored — ` +
                `${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
            );
          }
          result.errors.push(`legacy jobs.json migration: ${verification.summary} — rolled back to pre-migration state`);
          return;
        }

        const migratedCount = outcome.perEntry.filter((e: { action: string }) => e.action === 'migrated-instar').length;
        const forkedCount = outcome.perEntry.filter((e: { action: string }) => e.action === 'forked-user' || e.action === 'kept-user').length;
        const renamedCount = outcome.perEntry.filter((e: { action: string }) => e.action === 'renamed-user').length;
        result.upgraded.push(
          `legacy jobs.json migration: auto-ran on update — ${migratedCount} migrated to instar, ${forkedCount} preserved in user namespace, ${renamedCount} renamed. Invariants verified. Confirm via Dashboard to allow jobs.json removal.`,
        );
        if (outcome.backupPath) {
          result.upgraded.push(`legacy jobs.json migration: backup at ${path.basename(outcome.backupPath)}`);
        }
        // Spec invariant 8: telemetry write is the LAST action of a
        // successful migration. Append the migration.completed event.
        this.appendMigrationTelemetry({
          kind: 'migration.completed',
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          trigger: 'post-update',
          perEntry: outcome.perEntry.map((e) => ({
            slug: e.slug,
            action: normalizePerEntryAction(e.action),
            reason: e.reason,
          })),
          backupPath: outcome.backupPath,
          instarVersion,
        });
      } else if (outcome.status === 'aborted') {
        result.errors.push(`legacy jobs.json migration: aborted — ${outcome.errors.join('; ')}`);
        this.appendMigrationTelemetry({
          kind: 'migration.aborted',
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          trigger: 'post-update',
          perEntry: outcome.perEntry.map((e) => ({
            slug: e.slug,
            action: normalizePerEntryAction(e.action),
            reason: e.reason,
          })),
          abortReason: outcome.errors.join('; '),
          instarVersion,
        });
      }
    } catch (err) {
      result.errors.push(`legacy jobs.json migration: ${err instanceof Error ? err.message : String(err)}`);
      this.appendMigrationTelemetry({
        kind: 'migration.aborted',
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        trigger: 'post-update',
        perEntry: [],
        abortReason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Read the installed package's version, for the migration event's
   *  `instarVersion` field. Best-effort — returns undefined on failure. */
  private readBundledInstarVersion(packageRoot: string): string | undefined {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
      return typeof pkg.version === 'string' ? pkg.version : undefined;
    } catch {
      return undefined;
    }
  }

  /** Best-effort telemetry write. Missing telemetry is degradation, not a
   *  release-blocker, so failures are swallowed. */
  private appendMigrationTelemetry(event: MigrationEvent): void {
    try {
      appendMigrationEvent(this.config.stateDir, event);
    } catch {
      // @silent-fallback-ok — telemetry is non-load-bearing
    }
  }

  /**
   * Re-install hooks with the latest templates.
   * Built-in hooks in instar/ are always overwritten.
   * Custom hooks in custom/ are never touched.
   */
  private migrateHooks(result: MigrationResult): void {
    const hooksDir = path.join(this.config.stateDir, 'hooks');
    const instarHooksDir = path.join(hooksDir, 'instar');
    const customHooksDir = path.join(hooksDir, 'custom');
    fs.mkdirSync(instarHooksDir, { recursive: true });
    fs.mkdirSync(customHooksDir, { recursive: true });

    // Migrate from flat layout to directory layout if needed
    this.migrateHookLayout(hooksDir, instarHooksDir, result);

    try {
      // Session start hook — the most important one for self-discovery
      fs.writeFileSync(path.join(instarHooksDir, 'session-start.sh'), this.getSessionStartHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/session-start.sh (capability awareness)');
    } catch (err) {
      result.errors.push(`session-start.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'dangerous-command-guard.sh'), this.getDangerousCommandGuard(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/dangerous-command-guard.sh');
    } catch (err) {
      result.errors.push(`dangerous-command-guard.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'grounding-before-messaging.sh'), this.getGroundingBeforeMessaging(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/grounding-before-messaging.sh');
    } catch (err) {
      result.errors.push(`grounding-before-messaging.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'compaction-recovery.sh'), this.getCompactionRecovery(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/compaction-recovery.sh');
    } catch (err) {
      result.errors.push(`compaction-recovery.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'telegram-topic-context.sh'), this.getTelegramTopicContextHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/telegram-topic-context.sh (per-message unanswered detection)');
    } catch (err) {
      result.errors.push(`telegram-topic-context.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'external-operation-gate.js'), this.getExternalOperationGateHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/external-operation-gate.js (MCP tool safety gate)');
    } catch (err) {
      result.errors.push(`external-operation-gate.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Codex enforcement-hook registration (migration parity): existing Codex
    // agents get the per-project .codex/hooks.json on update. installCodexHooks
    // otherwise runs only via init's refreshHooksAndSettings — so without this an
    // existing Codex agent would receive the updated gate SCRIPTS but never the
    // registration that makes Codex actually fire them. Idempotent; preserves
    // any user-added Codex hooks. The referenced gate scripts are written above.
    if (this.getEnabledFrameworks().includes('codex-cli')) {
      try {
        installCodexHooks(this.config.projectDir);
        result.upgraded.push('.codex/hooks.json (Codex enforcement-hook registration)');
        // P0 (codex-full-parity): ARM the just-(re)written hooks so Codex actually runs
        // them — registration alone leaves them untrusted/dark until a human clicks the
        // trust prompt (which an autonomous agent can't). Atomic with the rewrite (B2):
        // the hash changed → trust invalidated → re-arm now. Idempotent: armCodexHooks
        // skips the spawn when the hooks are already trusted (unchanged), so this only
        // drives Codex when the hook set actually changed. Fail-soft: a failure is logged,
        // never aborts the migration. Opt-out: config.codex.autoArmHooks === false.
        let autoArm = true; // default ON; opt-out via config.codex.autoArmHooks === false
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(this.config.stateDir, 'config.json'), 'utf-8')) as { codex?: { autoArmHooks?: boolean } };
          if (cfg.codex?.autoArmHooks === false) autoArm = false;
        } catch { /* default ON */ }
        // Never spawn a real codex TUI under the test runner (armCodexHooks is unit-tested
        // directly + live-proven; spawning here during vitest would be a slow side-effect).
        if (process.env.VITEST) autoArm = false;
        const codexBinary = detectCodexPath();
        if (autoArm && codexBinary) {
          try {
            const outcome = armCodexHooks({
              projectDir: this.config.projectDir,
              trustDriver: makeTmuxTrustDriver({
                tmuxPath: detectTmuxPath() || 'tmux',
                codexBinary,
                model: 'gpt-5.2',
              }),
            });
            result.upgraded.push(`.codex hook auto-arm: ${outcome.status}`);
            if (outcome.status === 'partial') {
              result.errors.push(`codex hook auto-arm incomplete: untrusted=${outcome.untrusted.join(',')} disabled=${outcome.disabled.join(',')} — guards may not fire until re-armed`);
            }
          } catch (armErr) {
            result.errors.push(`codex hook auto-arm: ${armErr instanceof Error ? armErr.message : String(armErr)}`);
          }
        } else if (autoArm && !codexBinary) {
          // Not an error — expected on hosts/CI without a codex binary. The guards are
          // registered; they get armed on a host where codex resolves (or on the next update).
          result.skipped.push('codex hook auto-arm: no codex binary resolved (guards registered, will arm when codex is available)');
        }
      } catch (err) {
        result.errors.push(`codex hooks: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'deferral-detector.js'), this.getDeferralDetectorHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/deferral-detector.js (anti-deferral checklist)');
    } catch (err) {
      result.errors.push(`deferral-detector.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'slopcheck-guard.js'), this.getSlopcheckGuardHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/slopcheck-guard.js (package-legitimacy check on installs)');
    } catch (err) {
      result.errors.push(`slopcheck-guard.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'post-action-reflection.js'), this.getPostActionReflectionHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/post-action-reflection.js (evolution awareness)');
    } catch (err) {
      result.errors.push(`post-action-reflection.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'external-communication-guard.js'), this.getExternalCommunicationGuardHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/external-communication-guard.js (identity grounding)');
    } catch (err) {
      result.errors.push(`external-communication-guard.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'scope-coherence-collector.js'), this.getScopeCoherenceCollectorHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/scope-coherence-collector.js (implementation depth tracking)');
    } catch (err) {
      result.errors.push(`scope-coherence-collector.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'scope-coherence-checkpoint.js'), this.getScopeCoherenceCheckpointHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/scope-coherence-checkpoint.js (scope zoom-out checkpoint)');
    } catch (err) {
      result.errors.push(`scope-coherence-checkpoint.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'free-text-guard.sh'), this.getFreeTextGuardHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/free-text-guard.sh (blocks AskUserQuestion for passwords/credentials)');
    } catch (err) {
      result.errors.push(`free-text-guard.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'claim-intercept.js'), this.getClaimInterceptHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/claim-intercept.js (false claim detection on tool output)');
    } catch (err) {
      result.errors.push(`claim-intercept.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'claim-intercept-response.js'), this.getClaimInterceptResponseHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/claim-intercept-response.js (false claim detection on responses)');
    } catch (err) {
      result.errors.push(`claim-intercept-response.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'response-review.js'), this.getResponseReviewHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/response-review.js (coherence gate response review pipeline)');
    } catch (err) {
      result.errors.push(`response-review.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'stop-gate-router.js'), this.getStopGateRouterHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/stop-gate-router.js (unjustified Stop gate router)');
    } catch (err) {
      result.errors.push(`stop-gate-router.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'auto-approve-permissions.js'), this.getAutoApprovePermissionsHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/auto-approve-permissions.js (subagent permission unblocking)');
    } catch (err) {
      result.errors.push(`auto-approve-permissions.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      fs.writeFileSync(path.join(instarHooksDir, 'skill-usage-telemetry.sh'), this.getSkillUsageTelemetryHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/skill-usage-telemetry.sh (skill invocation tracking)');
    } catch (err) {
      result.errors.push(`skill-usage-telemetry.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Build stop hook — structural enforcement for /build pipeline.
    // Previously only installed once by init.ts, so existing agents that initialized
    // before it was added never received the file, yet settings.json references it
    // (registered by the /build skill). Result: silent "No such file or directory"
    // errors on every Stop event. Overwrite on every upgrade to match the pattern
    // used for every other instar-owned hook.
    try {
      fs.writeFileSync(path.join(instarHooksDir, 'build-stop-hook.sh'), this.getBuildStopHook(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/build-stop-hook.sh (/build pipeline structural enforcement)');
    } catch (err) {
      result.errors.push(`build-stop-hook.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Hook event reporter — always overwrite (built-in infrastructure).
    // Previously only installed-if-missing by migrateHttpHooksToCommandHooks, which left
    // agents stuck on a broken template (the old template used CommonJS `require('http')`,
    // which throws in ESM hosts where package.json has "type": "module").
    try {
      fs.writeFileSync(path.join(instarHooksDir, 'hook-event-reporter.js'), this.getHookEventReporterScript(), { mode: 0o755 });
      result.upgraded.push('hooks/instar/hook-event-reporter.js (ESM-compatible http import)');
    } catch (err) {
      result.errors.push(`hook-event-reporter.js: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Validate settings.json hook references exist on disk. Structural invariant:
    // every `command:` in settings.json hooks that resolves to a file under
    // .instar/hooks/ must exist, otherwise every firing of that hook emits
    // "No such file or directory" with no user-facing signal.
    this.validateHookReferences(hooksDir, result);
  }

  /**
   * Scan .claude/settings.json for hook `command:` entries that reference files
   * under the instar hooks tree, and report any that don't exist on disk.
   *
   * Structural invariant check — runs at upgrade time, emits into result.errors
   * so the upgrade log surfaces the drift. Not fatal: unknown hooks may be
   * agent-custom (lives under .instar/hooks/custom/) and we don't want to wedge
   * an upgrade on a reference we don't own.
   */
  validateHookReferences(hooksDir: string, result: MigrationResult): void {
    const settingsPath = path.join(this.config.projectDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return;

    let settings: unknown;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      result.errors.push(`settings.json parse (hook-reference validation): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const hooksSection = (settings as { hooks?: Record<string, unknown> }).hooks;
    if (!hooksSection || typeof hooksSection !== 'object') return;

    const missing: string[] = [];
    for (const [event, entries] of Object.entries(hooksSection)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Array<{ hooks?: Array<{ command?: string }> }>) {
        const hookList = Array.isArray(entry?.hooks) ? entry.hooks : [];
        for (const hook of hookList) {
          const cmd = typeof hook?.command === 'string' ? hook.command : '';
          if (!cmd) continue;
          // Extract a path that looks like `.instar/hooks/...` from the command.
          // Matches bash .instar/hooks/instar/foo.sh, node .instar/hooks/instar/foo.js,
          // or any direct reference to a file path under the hooks tree. Custom hooks
          // live under .instar/hooks/custom/ and are skipped — the agent owns them.
          const match = cmd.match(/(?:^|\s)(\.instar\/hooks\/instar\/[^\s"]+)/);
          if (!match) continue;
          const relPath = match[1];
          const abs = path.join(this.config.projectDir, relPath);
          if (!fs.existsSync(abs)) {
            missing.push(`${event}: ${relPath} (referenced in settings.json, not found on disk)`);
          }
        }
      }
    }

    if (missing.length > 0) {
      for (const m of missing) {
        result.errors.push(`hook-reference-missing — ${m}`);
      }
    }
  }

  /**
   * Migrate hooks from flat .instar/hooks/ layout to .instar/hooks/instar/ subdirectory.
   * Detects agent-modified built-in hooks by comparing content hashes and moves them
   * to .instar/hooks/custom/ with provenance 'inherited'.
   */
  private migrateHookLayout(hooksDir: string, instarHooksDir: string, result: MigrationResult): void {
    // List of known built-in hook filenames
    const builtinHooks = [
      'session-start.sh', 'dangerous-command-guard.sh', 'grounding-before-messaging.sh',
      'compaction-recovery.sh', 'external-operation-gate.js', 'deferral-detector.js',
      'slopcheck-guard.js',
      'post-action-reflection.js', 'external-communication-guard.js',
      'scope-coherence-collector.js', 'scope-coherence-checkpoint.js',
      'instructions-loaded-tracker.js', 'subagent-start-tracker.js',
      'free-text-guard.sh', 'claim-intercept.js', 'claim-intercept-response.js', 'response-review.js',
      'stop-gate-router.js',
      'auto-approve-permissions.js',
    ];

    // Check if we're still on the old flat layout (hooks directly in .instar/hooks/)
    const hasOldLayout = builtinHooks.some(name => {
      const oldPath = path.join(hooksDir, name);
      return fs.existsSync(oldPath) && !fs.statSync(oldPath).isDirectory();
    });

    if (!hasOldLayout) return;

    // Already migrated or fresh install — instar/ dir has the hooks
    if (fs.existsSync(path.join(instarHooksDir, 'session-start.sh'))) return;

    const customHooksDir = path.join(hooksDir, 'custom');

    for (const hookName of builtinHooks) {
      const oldPath = path.join(hooksDir, hookName);
      if (!fs.existsSync(oldPath)) continue;

      try {
        // Move built-in hooks to instar/ — they'll be overwritten by the current
        // migrateHooks() call anyway, but cleaning up the old location is important
        SafeFsExecutor.safeUnlinkSync(oldPath, { operation: 'src/core/PostUpdateMigrator.ts:524' });
      } catch {
        // If we can't remove, it's not critical — the new hooks will be written
        // to instar/ regardless
      }
    }

    // Check for any non-builtin hooks in the old flat directory (agent-created)
    try {
      const remaining = fs.readdirSync(hooksDir).filter(name => {
        const fullPath = path.join(hooksDir, name);
        return !fs.statSync(fullPath).isDirectory() && !builtinHooks.includes(name);
      });

      for (const customHook of remaining) {
        const oldPath = path.join(hooksDir, customHook);
        const newPath = path.join(customHooksDir, customHook);
        try {
          fs.renameSync(oldPath, newPath);
          result.upgraded.push(`hooks: migrated custom hook ${customHook} to hooks/custom/`);
        } catch (err) {
          result.errors.push(`hook migration ${customHook}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch {
      // Directory read failed — not critical
    }

    result.upgraded.push('hooks: migrated from flat layout to instar/custom/ directory structure');
  }

  /**
   * Migrate settings.json hook command paths from .instar/hooks/X to .instar/hooks/instar/X.
   * This handles the transition for agents that already have hooks configured.
   */
  private migrateSettingsHookPaths(hookEntries: unknown[], result: MigrationResult): void {
    const oldPrefix = '.instar/hooks/';
    const newPrefix = '.instar/hooks/instar/';

    for (const entry of hookEntries) {
      if (typeof entry !== 'object' || entry === null) continue;

      // Handle entries with nested hooks arrays (matcher-based entries)
      const entryObj = entry as Record<string, unknown>;
      if (Array.isArray(entryObj.hooks)) {
        for (const hook of entryObj.hooks) {
          if (typeof hook === 'object' && hook !== null) {
            const hookObj = hook as Record<string, unknown>;
            if (typeof hookObj.command === 'string') {
              const cmd = hookObj.command;
              // Only migrate paths that point to flat layout (not already in instar/ or custom/)
              if (cmd.includes(oldPrefix) && !cmd.includes(newPrefix) && !cmd.includes('.instar/hooks/custom/')) {
                hookObj.command = cmd.replace(oldPrefix, newPrefix);
              }
            }
          }
        }
      }

      // Handle direct hook entries (not nested)
      if (typeof entryObj.command === 'string') {
        const cmd = entryObj.command;
        if (cmd.includes(oldPrefix) && !cmd.includes(newPrefix) && !cmd.includes('.instar/hooks/custom/')) {
          entryObj.command = cmd.replace(oldPrefix, newPrefix);
        }
      }
    }
  }

  /**
   * Migrate HTTP hook URLs to include INSTAR_SESSION_ID query parameter.
   * This enables the server to map Claude Code's session_id to the instar session,
   * which is required for subagent-aware zombie cleanup (prevents killing sessions
   * that are waiting for subagent results).
   *
   * Finds HTTP hooks with URLs ending in /hooks/events (no query params) and
   * appends ?instar_sid=${INSTAR_SESSION_ID}. Also adds INSTAR_SESSION_ID to
   * allowedEnvVars if missing.
   */
  private migrateHttpHookSessionId(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    let patched = false;

    for (const hookEntries of Object.values(hooks)) {
      if (!Array.isArray(hookEntries)) continue;

      for (const entry of hookEntries) {
        if (typeof entry !== 'object' || entry === null) continue;
        const entryObj = entry as Record<string, unknown>;

        // Handle entries with nested hooks arrays (matcher-based entries)
        if (Array.isArray(entryObj.hooks)) {
          for (const hook of entryObj.hooks) {
            if (typeof hook !== 'object' || hook === null) continue;
            const hookObj = hook as Record<string, unknown>;

            if (hookObj.type !== 'http' || typeof hookObj.url !== 'string') continue;

            // Update URL: add ?instar_sid= if the URL hits /hooks/events without it
            if (hookObj.url.includes('/hooks/events') && !hookObj.url.includes('instar_sid')) {
              hookObj.url = hookObj.url.replace(
                '/hooks/events',
                '/hooks/events?instar_sid=${INSTAR_SESSION_ID}',
              );
              patched = true;
            }

            // Add INSTAR_SESSION_ID to allowedEnvVars if missing
            if (Array.isArray(hookObj.allowedEnvVars)) {
              const envVars = hookObj.allowedEnvVars as string[];
              if (!envVars.includes('INSTAR_SESSION_ID')) {
                envVars.push('INSTAR_SESSION_ID');
                patched = true;
              }
            }
          }
        }

        // Handle direct hook entries (not nested)
        if (entryObj.type === 'http' && typeof entryObj.url === 'string') {
          if (entryObj.url.includes('/hooks/events') && !entryObj.url.includes('instar_sid')) {
            entryObj.url = (entryObj.url as string).replace(
              '/hooks/events',
              '/hooks/events?instar_sid=${INSTAR_SESSION_ID}',
            );
            patched = true;
          }
          if (Array.isArray(entryObj.allowedEnvVars)) {
            const envVars = entryObj.allowedEnvVars as string[];
            if (!envVars.includes('INSTAR_SESSION_ID')) {
              envVars.push('INSTAR_SESSION_ID');
              patched = true;
            }
          }
        }
      }
    }

    if (patched) {
      result.upgraded.push('.claude/settings.json: added INSTAR_SESSION_ID to HTTP hook URLs (subagent-aware zombie cleanup)');
    }

    return patched;
  }

  /**
   * Ensure HTTP hooks from the template exist in settings.json.
   * Previous migrations only patched existing HTTP hooks (adding instar_sid param)
   * but never added them from scratch. Agents initialized before HTTP hooks were
   * introduced have no HTTP hooks at all, causing claudeSessionId to never be
   * populated — which breaks session resume (falls back to mtime cross-contamination).
   */
  private ensureHttpHooksExist(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    const serverUrl = `http://localhost:${this.config.port}`;

    // Check if ANY event reporter hook already exists (HTTP or command-based)
    const hasEventReporterHook = Object.values(hooks).some(entries => {
      if (!Array.isArray(entries)) return false;
      return entries.some(entry => {
        if (typeof entry !== 'object' || entry === null) return false;
        const e = entry as Record<string, unknown>;
        if (Array.isArray(e.hooks)) {
          return (e.hooks as Array<Record<string, unknown>>).some(h => {
            // Check for command hook (new style)
            if (h.type === 'command' && typeof h.command === 'string' && (h.command as string).includes('hook-event-reporter')) return true;
            // Check for HTTP hook (old style, with valid URL)
            if (h.type === 'http' && typeof h.url === 'string' && !(h.url as string).includes('${INSTAR_SERVER_URL}')) return true;
            return false;
          });
        }
        // Check direct entry
        if (e.type === 'command' && typeof e.command === 'string' && (e.command as string).includes('hook-event-reporter')) return true;
        if (e.type === 'http' && typeof e.url === 'string' && !(e.url as string).includes('${INSTAR_SERVER_URL}')) return true;
        return false;
      });
    });

    if (hasEventReporterHook) return false;

    // Remove any existing broken HTTP hooks (with unresolved template vars)
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      hooks[event] = entries.filter(entry => {
        if (typeof entry !== 'object' || entry === null) return true;
        const e = entry as Record<string, unknown>;
        if (Array.isArray(e.hooks)) {
          const hooksArr = e.hooks as Array<Record<string, unknown>>;
          return !hooksArr.some(h =>
            h.type === 'http' && typeof h.url === 'string' && (h.url as string).includes('${INSTAR_SERVER_URL}'),
          );
        }
        return !(e.type === 'http' && typeof e.url === 'string' && (e.url as string).includes('${INSTAR_SERVER_URL}'));
      });
      // Clean up empty arrays
      if ((hooks[event] as unknown[]).length === 0) {
        delete hooks[event];
      }
    }

    // Add HTTP hooks using the resolved localhost URL
    const httpHookSettings = buildHttpHookSettings(serverUrl);
    for (const [event, entries] of Object.entries(httpHookSettings)) {
      if (!hooks[event]) {
        hooks[event] = [];
      }
      (hooks[event] as unknown[]).push(...entries);
    }

    result.upgraded.push(
      `.claude/settings.json: added ${HTTP_HOOK_TEMPLATES.length} HTTP hooks for observability (url: ${serverUrl}/hooks/events)`,
    );
    return true;
  }

  /**
   * Ensure PermissionRequest auto-approve hook exists in settings.json.
   * Subagents spawned via the Agent tool don't inherit --dangerously-skip-permissions,
   * so without this catch-all hook they prompt for every tool use and block jobs.
   * Real safety is in PreToolUse hooks — permission prompts are duplicative friction.
   */
  private ensurePermissionAutoApprove(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    // Check if PermissionRequest hook already exists
    if (hooks.PermissionRequest) {
      const entries = hooks.PermissionRequest as Array<{ hooks?: Array<{ command?: string }> }>;
      const hasAutoApprove = entries.some(e =>
        e.hooks?.some(h => h.command?.includes('auto-approve-permissions')),
      );
      if (hasAutoApprove) return false;
    }

    if (!hooks.PermissionRequest) {
      hooks.PermissionRequest = [];
    }

    (hooks.PermissionRequest as unknown[]).push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/auto-approve-permissions.js',
        timeout: 5000,
      }],
    });

    result.upgraded.push('.claude/settings.json: added PermissionRequest auto-approve (subagent unblocking)');
    return true;
  }

  /**
   * Ensure autonomous stop hook is registered and the skill files are deployed.
   * This is the structural enforcement for /autonomous mode — without it,
   * sessions exit normally after each response instead of looping on the task list.
   */
  private ensureAutonomousStopHook(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    let patched = false;

    // 1. Deploy full autonomous skill directory (SKILL.md, hooks/, scripts/) if missing
    const skillDir = path.join(this.config.projectDir, '.claude', 'skills', 'autonomous');
    const skillHooksDir = path.join(skillDir, 'hooks');
    const hookScript = path.join(skillHooksDir, 'autonomous-stop-hook.sh');
    const hooksJson = path.join(skillHooksDir, 'hooks.json');
    const skillMd = path.join(skillDir, 'SKILL.md');

    const bundledSkillDir = path.join(path.dirname(path.dirname(__dirname)), '.claude', 'skills', 'autonomous');
    if (fs.existsSync(bundledSkillDir)) {
      // Deploy SKILL.md if missing
      const bundledSkillMd = path.join(bundledSkillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd) && fs.existsSync(bundledSkillMd)) {
        fs.mkdirSync(skillDir, { recursive: true });
        fs.copyFileSync(bundledSkillMd, skillMd);
        result.upgraded.push('.claude/skills/autonomous/SKILL.md: deployed skill prompt');
        patched = true;
      }

      // Deploy scripts/ if missing
      const bundledScriptsDir = path.join(bundledSkillDir, 'scripts');
      const skillScriptsDir = path.join(skillDir, 'scripts');
      if (!fs.existsSync(skillScriptsDir) && fs.existsSync(bundledScriptsDir)) {
        fs.mkdirSync(skillScriptsDir, { recursive: true });
        for (const f of fs.readdirSync(bundledScriptsDir)) {
          fs.copyFileSync(path.join(bundledScriptsDir, f), path.join(skillScriptsDir, f));
          fs.chmodSync(path.join(skillScriptsDir, f), 0o755);
        }
        result.upgraded.push('.claude/skills/autonomous/scripts: deployed skill scripts');
        patched = true;
      }

      // Deploy hooks/ if missing
      if (!fs.existsSync(hookScript)) {
        fs.mkdirSync(skillHooksDir, { recursive: true });
        const bundledHook = path.join(bundledSkillDir, 'hooks', 'autonomous-stop-hook.sh');
        const bundledJson = path.join(bundledSkillDir, 'hooks', 'hooks.json');
        if (fs.existsSync(bundledHook)) {
          fs.copyFileSync(bundledHook, hookScript);
          fs.chmodSync(hookScript, 0o755);
        }
        if (fs.existsSync(bundledJson) && !fs.existsSync(hooksJson)) {
          fs.copyFileSync(bundledJson, hooksJson);
        }
        result.upgraded.push('.claude/skills/autonomous/hooks: deployed stop hook files');
        patched = true;
      }

      // Force-update autonomous skill files that reference old .claude/ state path.
      // The state file was moved from .claude/autonomous-state.local.md to
      // .instar/autonomous-state.local.md because Claude Code's settings
      // self-modification prompt blocks writes to .claude/ even with
      // --dangerously-skip-permissions. Also adds UUID validation for session_id.
      const filesToUpdate = [
        { src: 'hooks/autonomous-stop-hook.sh', dst: hookScript, executable: true },
        { src: 'scripts/setup-autonomous.sh', dst: path.join(skillDir, 'scripts', 'setup-autonomous.sh'), executable: true },
        { src: 'SKILL.md', dst: skillMd, executable: false },
      ];
      for (const { src, dst, executable } of filesToUpdate) {
        if (fs.existsSync(dst)) {
          const content = fs.readFileSync(dst, 'utf-8');
          if (content.includes('.claude/autonomous-state') || content.includes('.claude/autonomous-emergency-stop')) {
            const bundledSrc = path.join(bundledSkillDir, src);
            if (fs.existsSync(bundledSrc)) {
              fs.copyFileSync(bundledSrc, dst);
              if (executable) fs.chmodSync(dst, 0o755);
              result.upgraded.push(`${dst}: migrated autonomous state path from .claude/ to .instar/`);
              patched = true;
            }
          }
        }
      }
    }

    // 2. Register in settings.json Stop hooks if missing
    if (!hooks.Stop) {
      hooks.Stop = [];
    }
    const stopEntries = hooks.Stop as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
    const hasAutonomousHook = stopEntries.some(e =>
      e.hooks?.some(h => h.command?.includes('autonomous-stop-hook')),
    );
    if (!hasAutonomousHook) {
      // Keep stop-gate-router first when present so shadow telemetry sees every
      // Stop event before legacy autonomous blocking can short-circuit the chain.
      const autonomousEntry = {
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'bash ${CLAUDE_PROJECT_DIR}/.claude/skills/autonomous/hooks/autonomous-stop-hook.sh',
          timeout: 10000,
        }],
      };
      const stopGateIndex = stopEntries.findIndex(e =>
        e.hooks?.some(h => h.command?.includes('stop-gate-router.js')),
      );
      if (stopGateIndex >= 0) {
        stopEntries.splice(stopGateIndex + 1, 0, autonomousEntry);
      } else {
        stopEntries.unshift(autonomousEntry);
      }
      result.upgraded.push('.claude/settings.json: registered autonomous stop hook (structural enforcement)');
      patched = true;
    }

    return patched;
  }

  /**
   * Replace HTTP hooks with command hooks that use hook-event-reporter.js.
   * Claude Code HTTP hooks (type: "http") silently fail to fire as of v2.1.78.
   * This migration converts them to command hooks which reliably fire.
   * The hook-event-reporter.js script itself is installed by migrateHooks()
   * (always-overwrite pattern for built-in hooks).
   */
  private migrateHttpHooksToCommandHooks(
    hooks: Record<string, unknown[]>,
    result: MigrationResult,
  ): boolean {
    let patched = false;
    const commandHook = {
      type: 'command',
      command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/hook-event-reporter.js',
      timeout: 3000,
    };

    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;

      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (typeof entry !== 'object' || entry === null) continue;
        const entryObj = entry as Record<string, unknown>;

        // Check nested hooks arrays for HTTP hooks
        if (Array.isArray(entryObj.hooks)) {
          const hooksArr = entryObj.hooks as Array<Record<string, unknown>>;
          const hasHttpHook = hooksArr.some(h =>
            h.type === 'http' && typeof h.url === 'string' && (h.url as string).includes('/hooks/events'),
          );
          if (hasHttpHook) {
            // Replace the entire entry with a command hook entry
            entries[i] = {
              matcher: (entryObj.matcher as string) ?? '',
              hooks: [commandHook],
            };
            patched = true;
          }
        }

        // Check direct HTTP hook entries
        if (entryObj.type === 'http' && typeof entryObj.url === 'string' && (entryObj.url as string).includes('/hooks/events')) {
          entries[i] = {
            matcher: '',
            hooks: [commandHook],
          };
          patched = true;
        }
      }
    }

    // The hook-event-reporter.js script is installed unconditionally by migrateHooks()
    // (always-overwrite pattern for built-in hooks). No install needed here.

    if (patched) {
      result.upgraded.push('.claude/settings.json: replaced HTTP hooks with command hooks (HTTP hooks silently fail in Claude Code <=2.1.78)');
    }

    return patched;
  }

  private getHookEventReporterScript(): string {
    return `#!/usr/bin/env node
// Hook Event Reporter — command hook replacement for HTTP hooks.
//
// Claude Code HTTP hooks (type: "http") silently fail to fire as of v2.1.78.
// This command hook achieves the same result: POST hook event data to the
// Instar server, which populates claudeSessionId for session resumption.
//
// NOTE: Uses \`await import('node:http')\` instead of \`require('http')\` so this
// script works regardless of the host package.json's module type. A plain
// \`require\` throws in ESM scope (when the host has "type": "module"); a plain
// \`import\` is a syntax error in CJS scope. Dynamic import works in both.

const serverUrl = process.env.INSTAR_SERVER_URL || 'http://localhost:4042';
const authToken = process.env.INSTAR_AUTH_TOKEN || '';
const instarSid = process.env.INSTAR_SESSION_ID || '';

if (!authToken || !instarSid) {
  process.exit(0);
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const { request } = await import('node:http');
    const input = JSON.parse(data);
    const payload = JSON.stringify({
      event: input.hook_event || (input.tool_name ? 'PostToolUse' : 'Unknown'),
      session_id: input.session_id || '',
      tool_name: input.tool_name || '',
    });

    const url = new URL(serverUrl + '/hooks/events?instar_sid=' + instarSid);
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      timeout: 3000,
    }, (res) => {
      res.resume();
    });

    req.on('error', () => {});
    req.write(payload);
    req.end();

    setTimeout(() => process.exit(0), 50);
  } catch (e) {
    process.exit(0);
  }
});

setTimeout(() => process.exit(0), 2000);
`;
  }

  /**
   * Patch CLAUDE.md with any new sections that don't exist yet.
   * Only adds — never modifies or removes existing content.
   */
  private migrateClaudeMd(result: MigrationResult): void {
    const claudeMdPath = path.join(this.config.projectDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      result.skipped.push('CLAUDE.md (not found — will be created on next init)');
      return;
    }

    let content: string;
    try {
      content = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch (err) {
      result.errors.push(`CLAUDE.md read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;
    const port = this.config.port;

    // Cross-Agent Communication Discipline (anti-confabulation) — codex-instar
    // audit Item 11. Existing agents need this section even if they were
    // initialized before it existed. The check uses a content-sniffing marker
    // distinctive enough to avoid false positives but stable enough to be
    // idempotent.
    if (!content.includes('Cross-Agent Communication Discipline (anti-confabulation)')) {
      const antiConfabulationSection = `
### Cross-Agent Communication Discipline (anti-confabulation)

**Never narrate cross-agent work as if it happened. Only state work I actually completed.**

When coordinating with another agent, two failure modes are easy to fall into and both burn the other agent's trust irrecoverably:

**1. Describing a tool call instead of making one.**
Writing "I sent Echo a cross-agent handoff covering the fundamental fix list" is not the same as calling \`threadline_send\`. If I describe the send without making the call, the other agent never receives anything, and my report is a fabrication.

Rule: every claim about a cross-agent action must be preceded by the actual tool call that performed it. If the tool call wasn't made, the claim doesn't get written.

**2. Authoring messages in the other agent's voice in shared files.**
Coordination files (e.g. \`echo_chat.md\`, \`team-sync.md\`) are append-only multi-agent logs. Sections are stamped with the author's identity. Writing a section labeled "from <other-agent>" — even as a synthesis or "what they might say" — is impersonation: it pollutes the log with content the other agent didn't write, and any reader (including my own monitors!) downstream treats it as real.

Rule: in shared coordination files, I only write sections in my own voice. If I'm summarizing what another agent said, I quote them with attribution to a specific real timestamped section they actually wrote — never paraphrase their position into a new section labeled as theirs.

**3. Registering state inside another agent's system without an ACK.**
Saying "I registered ACT-148 in Echo's commitments" only counts when Echo's commitment registry actually shows ACT-148 with an authenticated origin. Cross-agent state-mutation goes through Threadline (or an explicit HTTP call to the other agent's authenticated endpoint), and the other agent's system records the entry. Until I see that record (via \`threadline_history\` or a direct probe), nothing has been "registered" in their system.

Rule: I do not state that work landed inside another agent's state unless I have an ACK from that agent's tools showing the record exists. If the tool failed or returned no record, I say so honestly — never paper over it with a description of what I intended.

**The metafailure:** all three patterns share the same root — narrating intentions as if they were completed actions. Catching myself: any sentence about cross-agent work that doesn't have a corresponding tool-call trace within the same response is a flag to stop, run the actual call, and rewrite the sentence to match the outcome.

(Source: codex-instar audit Item 11, 2026-05-22 confabulation incident where one agent fabricated an ACK from another, then logged its own fabrication as evidence of progress.)
`;
      content += '\n' + antiConfabulationSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Cross-Agent Communication Discipline (anti-confabulation) section');
    }

    // Close the Loop (Untracked = Abandoned) — STANDARDS-REGISTRY amendment
    // ratified with Justin 2026-05-31. The "nothing slips through the cracks"
    // principle was made a constitutional standard; existing agents need the
    // operating principle, not just new agents via the template. Content-sniffed
    // on the distinctive name (also present in the template's Core Principles,
    // so a freshly-initialized agent is never double-patched).
    if (!content.includes('Close the Loop (Untracked = Abandoned)')) {
      const closeTheLoopSection = `
### Close the Loop (Untracked = Abandoned)

Every loop I open — a promise to a user, a feature shipped dark, a gate I deployed, an issue I flagged — must be durably registered and re-surfaced on a cadence until it reaches a deliberate close. Capturing it once isn't enough; if nothing brings it back for review, it rots silently and is, in effect, abandoned. Where there's no cadence, add one: open a commitment for a follow-through, file it to a maturation track, or schedule a review — never a private intention to "come back to it." This is coherence across **time** — "Structure > Willpower" says don't rely on remembering *within* a session; this says don't rely on remembering to *revisit* across sessions. (Deferral = Deletion captures it now; Close the Loop keeps re-surfacing it until it's actually closed. Instar constitution: "Close the Loop", \`docs/STANDARDS-REGISTRY.md\`.)
`;
      content += '\n' + closeTheLoopSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Close the Loop (Untracked = Abandoned) core principle');
    }

    // THREADLINE-IDENTITY-DISCOVERY-UNIFICATION (Agent Awareness). Existing
    // agents on the network need to know the authoritative "what address reaches
    // me" source is the routing fingerprint (relay registration / health
    // fingerprint), not the legacy publicKey hex — this is exactly the bug that
    // made a peer's sends vanish. Content-sniffed on a distinctive marker.
    if (!content.includes('What address reaches me (Threadline routing fingerprint)')) {
      const routingFingerprintSection = `
### What address reaches me (Threadline routing fingerprint)

If a peer's messages to me never land (their side shows \`sent=true\`, my \`logs/server.log\` shows no "Accepted message from <them>"), the usual cause is a **wrong address**. The authoritative "what address reaches me" value is my **routing fingerprint** — the one my relay registers with (\`logs/server.log\`: \`Threadline: relay connected (fingerprint: …)\`) and the one I publish at \`GET /threadline/health\` (\`fingerprint\` field) and in \`threadline/agent-info.json\`. These are sourced from my canonical \`identity.json\`, so they always agree. Hand peers THAT fingerprint — never the legacy \`publicKey\` hex from an old keypair. If \`/threadline/health\` returns no \`fingerprint\`, I have no resolvable routing identity yet (none on disk, or it's locked-encrypted) and am simply not relay-discoverable until I do.
`;
      content += '\n' + routingFingerprintSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Threadline routing-fingerprint guidance section');
    }

    // Cross-Machine Seamlessness (spec §11 Agent Awareness). Existing
    // multi-machine agents need to know about lease-based authority, the
    // honest machine-provenance disclosure, and where to read mesh/sync status.
    // Content-sniffed on a distinctive marker for idempotency.
    if (!content.includes('Cross-Machine Seamlessness (one agent, many machines)')) {
      const seamlessnessSection = `
### Cross-Machine Seamlessness (one agent, many machines)

When I run on more than one machine, I am ONE agent that follows the user across them — not clones. Exactly one machine is "awake" (serving) at a time, decided by a **fenced lease** (a clock-proof, numbered "who's in charge" badge). The other machine is standby and only takes over when the awake machine genuinely goes silent.

What this means for how I behave:
- **I never double-reply.** Each inbound message is handled exactly once (a durable per-message ledger keyed on the platform's event id), so a redelivery or a mid-handoff overlap can't make me answer twice.
- **A handoff feels like a compaction pause, not amnesia.** When serving moves between machines, the new machine resumes the conversation via CONTINUATION — it picks up the thread rather than re-greeting. In a planned handoff the context is current; in a hard failover it's as-of-the-last-sync, so if my context is partial I say so honestly ("picking this back up from the other machine") rather than pretending nothing changed.
- **I know which machine I'm on.** Turn provenance is recorded; if a failover outran the sync I disclose that the exact provenance is still catching up rather than asserting a stale machine.

Where to look (never guess mesh state — read it):
- \`GET /health\` → \`multiMachine.syncStatus\` = \`{ leaseHolder, leaseEpoch, holdsLease, splitBrainState, awakeMachineCount, protocolVersion }\`. \`instar doctor\` surfaces the same.
- A genuinely **unresolvable split-brain** (a machine looks alive but unreachable, so the lease can't move) surfaces as a single **Attention-queue** item with a Y/N decision ("demote machine X?") — it is deduped per partition episode, never per heartbeat. If I see one, I present the data and the decision to the user; I do not silently pick.
- Dials live under \`.instar/config.json\` → \`multiMachine\` (ingressHeartbeatMs, leaseTtlMs, liveTailMaxStalenessMs, handoffAckTimeoutMs, …). A nonsensical combination is rejected at startup with a clear message rather than degrading silently.
`;
      content += '\n' + seamlessnessSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Cross-Machine Seamlessness section');
    }

    // CMT-519 — Threadline hub topic + "open this"/bind guidance. Existing agents
    // need to know threadline notices route parent-or-hub (never per-event topics)
    // and that "open this" / "tie this to X" in the hub means calling the bind
    // endpoint, not replying inline. Content-sniffed on a distinctive marker.
    if (!content.includes('The "Threadline" hub topic — notifications')) {
      const hubSection = `
### The "Threadline" hub topic — notifications + "open this"

Threadline activity NEVER spawns a new Telegram topic per event. Notices route one of two ways:
- A conversation **bound to a parent topic** → its real replies surface THERE (handled automatically).
- A **parentless** conversation + any **status/housekeeping** notice → a single, SILENT **"Threadline" hub topic**. It does not buzz the user — agent-to-agent chatter isn't the user's job by default; the hub is a calm, browsable record.

When the user is reading the Threadline hub topic and says **"open this"** or **"tie this to &lt;an existing topic&gt;"**, this is handled **structurally** — the system intercepts those exact commands in the hub topic and binds the conversation automatically (bare "open this" opens the most-recent one) BEFORE the message reaches me. I will not see "open this" as a message to interpret, and must NOT reply to it conversationally. (Also available as \`POST /threadline/hub/bind\` \`{action:"open"|"tie", ...}\` for scripted use.) After binding, that conversation's future updates flow to the bound topic automatically.
`;
      content += '\n' + hubSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Threadline hub + "open this" guidance (CMT-519)');
    }

    // release-readiness-visibility §7 — Agent Awareness + Migration Parity:
    // existing agents must learn the release-readiness watchdog endpoints, not
    // just new agents via init. Content-sniff on the route marker.
    if (!content.includes('/release-readiness')) {
      const rrSection = `
### Release Readiness (instar-dev / maintainer environments only)

A repo-gated watchdog that makes a stalled instar release impossible to miss: it evaluates canonical \`main\` and, when finished work sits unreleased while publishing is blocked, raises ONE deduped, age-escalating item on the Attention queue. Ships OFF; the \`release-readiness-check\` job drives it. Null/503 on any install with no analyzable instar git repo.
- Status: \`GET /release-readiness\` · Run one check: \`POST /release-readiness/tick\`
- Disable (loud — raises a HIGH attention item + audits, never silent): \`POST /release-readiness/rollback\` · re-arm: \`POST /release-readiness/enable\`
`;
      content += '\n' + rrSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Release Readiness watchdog awareness (release-readiness-visibility)');
    }

    // codex-usage-visibility (Agent Awareness + Migration Parity): existing
    // agents must learn they can check codex `/status` usage over HTTP without
    // the interactive TUI. Content-sniff on the route marker.
    if (!content.includes('/codex/usage')) {
      const codexUsageSection = `
### Codex Usage (the codex \`/status\` rate-limit windows)

Check where codex account usage sits without the interactive TUI. The codex CLI persists the authoritative primary (5h) + secondary (weekly) rate-limit windows into its session rollout files; this surfaces the freshest snapshot.
- Check: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/codex/usage\`
- Returns \`{ available, usage: { primary, secondary, model, planType, rateLimitReachedType } }\`; each window has \`usedPercent\`, \`remainingPercent\`, \`windowMinutes\`, \`resetsAt\`/\`resetsAtIso\`, \`resetsInSeconds\`. \`available:false\` means no codex session data on disk yet (e.g. a pure-Claude agent).
- **When to use**: "how much codex usage is left?" / "am I near the limit?", before scheduling heavy codex work, or to drive a model-swap when a window is exhausted (\`rateLimitReachedType\` non-null, or \`secondary.remainingPercent\` low).
`;
      content += '\n' + codexUsageSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Codex Usage (/codex/usage) awareness (codex-usage-visibility)');
    }

    // llm-feature-metrics (Agent Awareness + Migration Parity): existing agents
    // must learn they can read per-gate/sentinel cost + hit-rate over HTTP to
    // tune their LLM checks. Content-sniff on the route marker (also emitted by
    // the template, so a freshly-initialized agent is never double-patched).
    if (!content.includes('/metrics/features')) {
      const metricsSection = `
### Per-Feature LLM Metrics (\`/metrics/features\`)

See what each LLM-driven gate/sentinel actually costs and how often it fires, so tuning them is evidence-based (which to thin, which to strengthen). Read-only observability (like token usage) — it never gates anything.
- Check: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/metrics/features?sinceHours=24"\`
- Returns \`{ totals, features: [{ feature, calls, tokensIn, tokensOut, fired, noop, fireRate, p50LatencyMs, p95LatencyMs, ... }] }\` — one row per system (e.g. MessagingToneGate, CoherenceReviewer). Filter with \`?feature=<name>\`.
- **When to use**: "which checks cost the most / fire the least?", "is this gate worth it?", or before tuning a sentinel/gate. Spec: \`docs/specs/llm-feature-metrics-spec.md\`.
`;
      content += '\n' + metricsSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Per-Feature LLM Metrics (/metrics/features) awareness (llm-feature-metrics)');
    }

    // update-message-topic-routing §Fix 3 — existing agents need to learn that
    // self-broadcast about ships/restarts/updates must route through the
    // post-update channel (lands in the Agent Updates topic), not the active
    // session topic. Without this, the agent authors update narration into
    // whatever conversation the user happened to be in — the exact bug Justin
    // flagged 2026-05-27. Content-sniff on a distinctive marker.
    if (!content.includes('Agent Updates topic (self-broadcasts about ships, restarts, updates)')) {
      const selfBroadcastSection = `
### Agent Updates topic (self-broadcasts about ships, restarts, updates)

When narrating a ship, an update I just applied, or a restart I just completed (e.g. "Just shipped X", "Back up and running on vN", "Bounced cleanly after the update"), route the message through the post-update channel so it lands in the dedicated Agent Updates topic — NOT the active session topic the user happened to be chatting in.
- Post: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/telegram/post-update -H 'Content-Type: application/json' -d '{"text":"Your update narration here"}'\`
- The endpoint resolves the Updates topic from state server-side; you cannot specify a topic and you should not try to.
- If Updates is not configured, the endpoint returns 400 — do NOT fall back to sending in the active topic. Update-class messages belong in Updates or they don't go out at all.
- **When to use** (PROACTIVE — this is the trigger): the moment I am about to author a conversational message whose subject is *me* shipping, updating, or restarting — including post-restart "I'm back" confirmations — I use this endpoint. Authoring such a message via the standard Telegram reply path puts release chatter into whatever conversation the user was last in, which is the bug this routing closes.
`;
      content += '\n' + selfBroadcastSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Agent Updates topic self-broadcast guidance (update-message-topic-routing)');
    }

    // CMT-529 — agents migrated under CMT-519 got the OLD "call the bind endpoint"
    // wording; "open this" is now a STRUCTURAL intercept (handled before the agent).
    // Re-patch the stale sentence so the agent doesn't try to call the endpoint /
    // reply to a command it will never actually see.
    if (content.includes('act on it by calling the bind endpoint')) {
      content = content.replace(
        /When the user is reading the Threadline hub topic and says \*\*"open this"\*\*[\s\S]*?(?:returns 409 — ask the user which one \(pass its `threadId`\)\.)/,
        `When the user is reading the Threadline hub topic and says **"open this"** or **"tie this to <an existing topic>"**, this is handled **structurally** — the system intercepts those exact commands and binds the conversation automatically (bare "open this" opens the most-recent one) BEFORE the message reaches me. I will not see "open this" as a message to interpret, and must NOT reply to it conversationally.`,
      );
      patched = true;
      result.upgraded.push('CLAUDE.md: updated "open this" guidance to structural-intercept (CMT-529)');
    }

    // Multi-Session Autonomy awareness (Agent Awareness Standard). Existing
    // agents need to know they can run concurrent per-topic autonomous jobs and
    // how to list/stop them, even if initialized before this capability existed.
    if (!content.includes('Multi-Session Autonomy')) {
      const multiSessionSection = `
### Multi-Session Autonomy

**Multi-Session Autonomy** — I can run multiple autonomous jobs at once, one per topic (default cap 5, set \`autonomousSessions.maxConcurrent\` in config). Each topic's job is isolated, survives restarts (keyed on its topic), and lives at \`.instar/autonomous/<topicId>.local.md\`.

- What's running: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/autonomous/sessions\`
- The cap + budget gate is checked automatically when a job starts (\`GET /autonomous/can-start\`); a start is refused at the cap or under budget pressure.
- Stop one topic's job: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/autonomous/sessions/TOPIC/stop\`
- Stop every job: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/autonomous/stop-all\`
- Proactive: "what autonomous jobs are running?" → GET /autonomous/sessions. "stop everything" → POST /autonomous/stop-all. "stop the job on topic X" → POST /autonomous/sessions/X/stop.
`;
      content += '\n' + multiSessionSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Multi-Session Autonomy awareness section');
    }

    // Framework-Onboarding Mentor System — issue-ledger observability (Agent
    // Awareness Standard). Existing agents need to know the read-only
    // /framework-issues + playbook routes exist, even if initialized before this
    // capability shipped. Signal-only (never gates). Content-sniffed marker.
    if (!content.includes('Framework-Onboarding Mentor System')) {
      const fwLedgerSection = `
### Framework-Onboarding Mentor System — issue ledger (read-only)

A durable, bucket-tagged record of behavioral issues observed while onboarding an agent framework (Codex, then Cursor/Aider/Gemini) onto Instar. **Observability only — it never gates a job, blocks a message, or constrains a session.** The full mentor loop ships staged (off by default).

- Issues logged for a framework: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/framework-issues\` (optional \`?framework=X&bucket=...&status=...&limit=N\`)
- The onboarding playbook (generalizable lessons from PRIOR frameworks, impact-ranked): \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/framework-issues/playbook?targetFramework=X"\`
- The two GET routes above are read-only and return references, not log contents.
- **Log an engineering-discovered issue** (the durable write path): when you find a framework-compat issue by auditing/fixing code — not just what a live mentor tick trips over — record it so it survives and feeds the next-framework playbook: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/framework-issues/observe -H 'Content-Type: application/json' -d '{"framework":"codex-cli","bucket":"instar-integration-gap","severity":"high","title":"…","dedupKey":"…","evidence":"PR #N","status":"fixed","fixedInVersion":"1.3.x"}'\`. Buckets: \`framework-limitation\` | \`instar-integration-gap\` | \`generic-agent-mistake\` (the first two generalize to the next framework). Idempotent on \`dedupKey\`. **Proactive trigger:** the moment you fix (or decide won't-fix) a framework-compat issue, log it here — Structure-over-Willpower, not memory.

**Autonomous-fix loop ("just be Echo")** — when \`mentor.autonomousFix.enabled\` is true, the mentor heartbeat stops running the observe-and-log pipeline and instead keeps ONE full-tool **Opus** session alive on the manual dogfooding loop: assign the mentee a real task over Telegram, observe the UX + the mentee's internals, FIX whatever is broken as a proper fleet PR (full ship gate), and report. Ships **dark** (off by default). The expensive Opus session only spawns when no loop session is already running (single-instance), budget is OK, and the min-interval has elapsed — so it never idle-burns or spawn-storms. Enable per agent in \`.instar/config.json\` → \`mentor.autonomousFix\`. Status lands in \`GET /mentor/status .lastResult\` (\`reason: 'spawned' | 'loop-active' | 'budget' | …\`).
`;
      content += '\n' + fwLedgerSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Framework-Onboarding Mentor System issue-ledger awareness section');
    } else {
      // Migration parity (independent, idempotent content-sniffs): agents that
      // already have the mentor section must still learn about each later
      // addition. Each guard appends only its own paragraph.
      if (!content.includes('Autonomous-fix loop ("just be Echo")')) {
        content +=
          '\n**Autonomous-fix loop ("just be Echo")** — when `mentor.autonomousFix.enabled` is true, the mentor heartbeat keeps ONE full-tool **Opus** session alive on the manual dogfooding loop (assign the mentee a real task → observe the UX + internals → FIX as a proper fleet PR → report) instead of the observe-and-log pipeline. Ships **dark** (off by default); single-instance + budget + min-interval gated so it never idle-burns. Enable in `.instar/config.json` → `mentor.autonomousFix`; status in `GET /mentor/status .lastResult`.\n';
        patched = true;
        result.upgraded.push('CLAUDE.md: added autonomous-fix loop ("just be Echo") awareness paragraph');
      }
      if (!content.includes('framework-issues/observe')) {
        content +=
          `\n**Log an engineering-discovered framework issue** (durable write path) — when you find a framework-compat issue by auditing/fixing code, record it so it feeds the next-framework playbook: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/framework-issues/observe -H 'Content-Type: application/json' -d '{"framework":"codex-cli","bucket":"instar-integration-gap","severity":"high","title":"…","dedupKey":"…","evidence":"PR #N","status":"fixed","fixedInVersion":"1.3.x"}'\`. Buckets: \`framework-limitation\` | \`instar-integration-gap\` | \`generic-agent-mistake\`. Idempotent on \`dedupKey\`. Proactive: log it the moment you fix (or won't-fix) a framework-compat issue.\n`;
        patched = true;
        result.upgraded.push('CLAUDE.md: added framework-issues/observe write-path awareness paragraph');
      }
    }

    // Version-Skew Self-Recovery section
    // Tells the agent what's happening when the lifeline+server temporarily
    // mismatch versions during an auto-update. Without this, agents diagnose
    // their own "ingress paused" alerts as a problem the user has to solve.
    if (!content.includes('Version-Skew Self-Recovery') && !content.includes('coordinated lifeline restart')) {
      const versionSkewSection = `
### Version-Skew Self-Recovery

When my server auto-updates across a major.minor boundary, my lifeline (the process that polls Telegram) needs to restart onto the matching version. This is now coordinated automatically:

- The auto-updater writes a coordinated-restart signal whenever it bumps major.minor.
- My lifeline reads the signal on its next tick (within 30s) and self-restarts.
- If my lifeline tick loop is wedged, the out-of-process fleet watchdog catches it within ~5 minutes and force-restarts via launchd.
- Belt-and-suspenders: the server itself writes the same signal whenever it returns HTTP 426 on \`/internal/telegram-forward\`.

**What the user might see:** a one-time Telegram alert *"Heads up: my server auto-updated to v… but my lifeline is still on v… Ingress is paused until the lifeline restarts onto the new version. Your messages are NOT lost — they will replay automatically on recovery."* — followed by a quiet recovery within 30s to 5 min. No action needed.

I should NEVER manually touch \`state/lifeline-restart-requested.json\` — it's purely managed by infrastructure (AutoUpdater, server, PostUpdateMigrator, fleet watchdog).

Spec: \`docs/specs/auto-updater-lifeline-coordination.md\` (in the instar repo).
`;
      content += '\n' + versionSkewSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Version-Skew Self-Recovery section');
    }

    // Sentinel Notifications (silently-stopped trio post-2026-05-22) — tells
    // the agent the silently-stopped sentinels are housekeeping and go to the
    // logs by default. Without this, an agent asked "are my sentinels alerting?"
    // or "where do sentinel events go?" has no grounded answer. Idempotent via
    // content-sniffing on the unique marker phrase.
    if (!content.includes('sentinelTelegramEscalation') && !content.includes('Sentinel Notifications (silently-stopped trio)')) {
      const section = `
## Sentinel Notifications (silently-stopped trio)

The SocketDisconnectSentinel + ActiveWorkSilenceSentinel watch for sessions that drop their socket or freeze mid-task. They detect, attempt one gentle nudge, and verify recovery — all on their own.

By default this is HOUSEKEEPING — the user never sees it. Every transition (detected / nudged / recovered / escalated) is written to:
- The server log (\`logs/server.log\`) as \`[sentinel:KIND] sentinel/sessionName — detail\` lines.
- A structured audit trail at \`logs/sentinel-events.jsonl\` (one JSON entry per transition).

Telegram delivery of escalations is OFF by default. When a genuinely-stuck session truly fails recovery and the user should know, set \`monitoring.sentinelTelegramEscalation: true\` in \`.instar/config.json\` — then escalations are COALESCED into ONE consolidated message and posted to the existing system (lifeline) topic. They are never per-event new topics. This default-off + single-topic design is the post-2026-05-22 fix for the topic-spam flood.

If a user asks "are my sentinels alerting?" or "why isn't the watchdog notifying me?" — read \`logs/sentinel-events.jsonl\` for the full audit trail and explain that Telegram is opt-in via the flag above. Spec: \`docs/specs/silently-stopped-trio.md\`.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Sentinel Notifications section');
    } else {
      result.skipped.push('CLAUDE.md: Sentinel Notifications section already present');
    }

    // Topic-Flood Guard (2026-05-28 lockdown) — the structural backstop that
    // caps how many forum topics a single attention source may spawn. Without
    // this section an agent asked "why are my notices grouped / where did topic
    // X go?" has no grounded answer. Idempotent via the unique marker phrase.
    if (!content.includes('Topic-Flood Guard') && !content.includes('attention-suppressed.jsonl')) {
      const section = `
## Topic-Flood Guard (attention queue circuit breaker)

The attention queue spawns ONE Telegram forum topic per item — right for a genuine /ack-able to-do, catastrophic when a HOUSEKEEPING feature raises items at volume (this is exactly the 2026-05-22 sentinel flood and the 2026-05-28 collaboration-redrive flood). A per-source circuit breaker now sits at the topic-creation chokepoint (\`TelegramAdapter.createAttentionItem\`): if a single attention \`sourceContext\` exceeds its topic budget within a rolling window, further NON-critical items from that source are COALESCED into ONE running "notices coalesced" topic and recorded in \`state/attention-suppressed.jsonl\` — never a wall of new topics. HIGH/URGENT items are NEVER coalesced (critical messages always get their own topic). No item is dropped — only its per-item topic is withheld; every item is still in the attention store.

- Default-ON, no config required (it ships in code). Tune via \`messaging[].config.attentionTopicGuard\` = \`{ "enabled": true, "windowMs": 600000, "maxTopicsPerSource": 3 }\`.
- If a user asks "why are my notices grouped together / where did topic X go / what is this 'notices coalesced' topic?" — read \`state/attention-suppressed.jsonl\` for the per-source suppressed items and explain the breaker above. The real fix for a recurring flood is to make the offending feature route housekeeping to the logs (like the sentinels and collaboration-redrive now do); the guard is the backstop that protects you regardless.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Topic-Flood Guard section');
    } else {
      result.skipped.push('CLAUDE.md: Topic-Flood Guard section already present');
    }

    // Multi-Machine Session Pool (§L2) — tells the agent about the active-active
    // pool + the Machines tab + nickname-based placement/transfer. Without it an
    // agent asked "what machines am I on / move this to the mini / where is this
    // running?" has no grounded answer. Idempotent via the unique marker phrase.
    if (!content.includes('Multi-Machine Session Pool (active-active') && !content.includes('/pool/machines/')) {
      const section = `
## Multi-Machine Session Pool (active-active — spread conversations across machines)

Beyond the one-awake-machine model: with the pool enabled I run conversations across ALL my machines at once and can MOVE a conversation between them. Ships DARK behind \`multiMachine.sessionPool.stage\` (default 'dark'); a single-machine agent is a no-op.

- **See the pool:** the **Machines tab** in the dashboard, or \`GET /pool\` (Bearer-auth) → which machine is the router ("dispatcher") + every machine's nickname, hardware, online status, load, and clock-skew status.
- **Machine nicknames** are the user-facing handle (auto-assigned, editable). Rename via \`PATCH /pool/machines/:machineId\` with \`{"nickname":"the mini"}\`, or inline on the Machines tab.
- **Proactive triggers:** when the user says "run this on <nickname>" / "move this to <nickname>" → placement/transfer-by-nickname (the session moves to the named machine, resuming like a session restart). "where is this running?" → \`GET /pool\`. Deep mechanics: the Machines tab + \`docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md\`.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Multi-Machine Session Pool section');
    } else {
      result.skipped.push('CLAUDE.md: Multi-Machine Session Pool section already present');
    }

    // ContextWedgeSentinel — the 4th silently-stopped sentinel. Tells the agent
    // about the thinking-block-400 wedge + that auto-recovery is opt-in. Without
    // it, an agent asked "why did my session keep failing instantly / what is
    // the thinking-block error?" has no grounded answer. Idempotent via marker.
    if (!content.includes('ContextWedgeSentinel') && !content.includes('Stuck-Context Recovery (thinking-block wedge)')) {
      const section = `
## Stuck-Context Recovery (thinking-block wedge)

The ContextWedgeSentinel (4th member of the silently-stopped family) detects a specific way a session dies: when a tool call is cancelled inside a PARALLEL tool batch while extended thinking is on, Claude Code cancels every sibling call and that corrupts the thinking block on the latest assistant turn. After that, the Anthropic API rejects every resume with \`400 … thinking blocks in the latest assistant message cannot be modified\`, so the session fast-fails instantly on every message ("Cooked for 0s") — permanently dead, yet still emitting output (so the silence + socket sentinels miss it).

A nudge can't fix this (re-engaging re-sends the corrupted turn). Recovery is a FRESH respawn — kill + spawn a new session that does NOT \`--resume\` the corrupted transcript (the topic's resume UUID is cleared first, so the bridge can't re-wedge on the next message).

- **Detection + audit are default-ON housekeeping** — every transition (detected / recovered / dry-run / false-alarm / escalated) lands in \`logs/sentinel-events.jsonl\`; the user sees nothing.
- **Auto-recovery is OPT-IN** (it kills + respawns a session). It rides the Graduated Feature Rollout track and ships dark. Turn it on in \`.instar/config.json\`: \`{"monitoring": {"contextWedgeSentinel": {"autoRecovery": {"enabled": true, "dryRun": false}}}}\` (use \`dryRun: true\` first to log what it WOULD respawn). When OFF, a confirmed wedge escalates (gated by \`sentinelTelegramEscalation\`) so you can restart it yourself.
- If a user asks "why did my session keep failing / get stuck on a thinking error?" — read \`logs/sentinel-events.jsonl\` (filter \`context-wedge\`) and explain the above. Spec: \`docs/specs/context-wedge-sentinel.md\`.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Stuck-Context Recovery section');
    } else {
      result.skipped.push('CLAUDE.md: Stuck-Context Recovery section already present');
    }

    // Reap-log (UNIFIED-SESSION-LIFECYCLE §P4) — tells the agent the durable
    // "why did my session vanish?" answer exists and where to read it. Without
    // this, an agent asked "where did my session go?" has no grounded answer.
    // Idempotent via content-sniffing on the route path.
    if (!content.includes('/sessions/reap-log')) {
      const section = `
## Reap-Log — why a session vanished

Every session shutoff — and every REFUSED shutoff (protected, not-lease-holder, a KEEP-guard hold, in-flight) — is recorded as one JSON line in \`logs/reap-log.jsonl\` and served read-only at \`GET /sessions/reap-log\`. A session can never disappear without a trace.

- Read it: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:4040/sessions/reap-log?limit=50"\` → \`{ entries: [{ ts, type:'reaped'|'skipped', session, reason, disposition, origin, skipped?, machine? }] }\`.
- Distinct from \`/sessions/reaper\` (live verdicts): the reap-log is the historical record of what ACTUALLY happened.
- When a session is autonomously shut down you also get a "your session was shut down — <reason>" notice. Recovery-bounces (kill-to-respawn) and your own operator kills stay silent. Off-switch: \`{"monitoring": {"reapNotify": {"enabled": false}}}\`.
- Proactive: user asks "where did my session go?" / "why did X disappear?" / "did something get killed?" → GET /sessions/reap-log and explain the most recent entries for that session. Spec: \`docs/specs/unified-session-lifecycle-robustness.md\`.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Reap-Log section');
    } else {
      result.skipped.push('CLAUDE.md: Reap-Log section already present');
    }

    // AgentWorktreeReaper report (RESPONSIBLE-RESOURCE-USAGE — OS resource hygiene).
    // Tells the agent the "which stale worktrees can be reclaimed?" read-surface
    // exists. Without it, an agent asked about worktree disk/sprawl has no grounded
    // answer. Idempotent via content-sniffing on the route path.
    if (!content.includes('/worktrees/agent-reaper')) {
      const section = `
## Stale-Worktree Reclaim (AgentWorktreeReaper)

CLI-created worktrees under \`~/.instar/agents/<agent>/.worktrees/\` accumulate (each is a full source tree). The AgentWorktreeReaper reclaims ones that are **merged + clean + not-in-use** — for a merged branch the work is in main, so removing the checkout loses nothing (the branch + commits remain). It NEVER touches a worktree with uncommitted changes, an unmerged branch, a live lock, or a running process whose cwd is inside it. Ships **OFF + dry-run** (it deletes on a heuristic).

- See what's reclaimable (and why each is kept): \`curl -H "Authorization: Bearer $AUTH" http://localhost:4040/worktrees/agent-reaper\` → per-worktree verdict (in-use / uncommitted-changes / unmerged / reap-eligible) + the reclaimable count.
- Review the dry-run report FIRST, then enable in \`.instar/config.json\`: \`{"monitoring": {"agentWorktreeReaper": {"enabled": true, "dryRun": false}}}\`. Tune \`maxReapsPerPass\` (default 20).
- Pairs with the Spotlight-exclusion marker (fewer worktrees = less disk AND less macOS indexing). Proactive: user asks "why is my disk full of worktrees?" / "clean up old worktrees?" → GET /worktrees/agent-reaper.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Stale-Worktree Reclaim section');
    } else {
      result.skipped.push('CLAUDE.md: Stale-Worktree Reclaim section already present');
    }

    // SessionReaper CPU-aware pressure + decision audit (RESPONSIBLE-RESOURCE-USAGE).
    // Tells the agent (a) the reaper now reaps under CPU strain, not only memory,
    // and (b) a silent, reviewable decision trail + endpoint exists. Without this an
    // agent asked "what is the reaper considering / why isn't it acting under load?"
    // has no grounded answer. Idempotent via content-sniffing on the new route path.
    if (!content.includes('/sessions/reaper/audit')) {
      const section = `
## SessionReaper — CPU-aware pressure + decision audit

The idle-session reaper's pressure is **CPU-aware**: the tier is the WORST of memory (free %) and CPU (1-min load ÷ cores), so a CPU-bound box raises pressure even when free RAM is fine. Tune the CPU thresholds in \`.instar/config.json\` → \`{"monitoring": {"sessionReaper": {"cpuModerateLoadPerCore": 1.0, "cpuCriticalLoadPerCore": 1.5}}}\`. \`GET /sessions/reaper\`'s \`pressure.inputs\` shows freePct, loadPerCore, and the memTier/cpuTier breakdown.

A silent **decision audit** records every keep/kill decision *change* (logged on transition, not every tick) plus the reap-path events, each stamped with the pressure tier that drove it, to \`logs/reaper-audit.jsonl\`.
- Read the tail: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:4040/sessions/reaper/audit?limit=50"\` → \`{ entries: [...] }\`. Read-only, no notifications — purely for inspection.
- Proactive: user asks "what is the reaper considering?" / "why did/didn't it reap X?" / "is it acting under load?" → GET /sessions/reaper (live pressure + verdicts) and GET /sessions/reaper/audit (decision history).
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added SessionReaper CPU-aware + decision-audit section');
    } else {
      result.skipped.push('CLAUDE.md: SessionReaper CPU-aware + decision-audit section already present');
    }

    // Self-Heal: Update Restart Behavior — explains restart-cascade dampener
    // and lifeline drift auto-promote. Complementary to Version-Skew Self-
    // Recovery above (that one handles major.minor crossings; this one handles
    // back-to-back update cascades + patch-level drift). Idempotent via
    // content-sniffing.
    if (!content.includes('restart-cascade dampener') && !content.includes('Restart-cascade dampener')) {
      const section = `
## Self-Heal: Update Restart Behavior

Updates land in two places: a **server** restart for new code, and a **lifeline** restart when the lifeline drifts too far behind the server. Both have built-in self-heal so the user shouldn't get hit by avoidable disruptions:

- **Restart-cascade dampener** — when two updates arrive within 15 minutes of each other (e.g. v1.2.34 at 10:00 and v1.2.36 at 10:03), the server only restarts ONCE for the highest version instead of twice. The user gets a "rolling into the pending restart at HH:MM" notice. Tune in \`.instar/config.json\` → \`updates.restartCascadeDampenerWindowMs\` (default 900000, set 0 to disable).
- **Lifeline drift auto-promote** — when the server's version handshake sees the lifeline is more than 20 patches behind (within the same major.minor, so below the version-skew threshold above), the lifeline self-restarts at the next clean window (no in-flight forwards, no queued messages, no recent traffic in the last 90s). On the post-restart boot it sends one note: "Lifeline self-restarted: was N patches behind, now in sync at vX.Y.Z." Tune in \`.instar/config.json\` → \`lifeline.driftPromoter\`.

If the user reports they were "unresponsive for a while during updates," check \`state/auto-updater.json\` for batched-restart state and the most recent \`logs/server-stderr.log\` for "Restart batched" / "Cascade-dampener" lines. If the lifeline is still on a very old version, the drift promoter will pick it up automatically on the next forward — no manual kick needed.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Self-Heal update-restart section');
    } else {
      result.skipped.push('CLAUDE.md: Self-Heal section already present');
    }

    // Correction & Preference Learning Sentinel (Slice 1a) §7 — Agent Awareness +
    // Migration Parity: existing agents must learn about the preferences read-
    // surface (the session-start hook now fetches /preferences/session-context
    // and injects an <auto-learned-preference> block) so they HONOR injected
    // preferences and understand the loop is watching their repeated corrections.
    // The Failure-Learning Loop only backfilled its sub-tab and left existing
    // agents unaware of the main capability — that gap is not repeated here.
    // Content-sniffed on a distinctive marker for idempotency.
    if (!content.includes('Correction & Preference Learning Sentinel')) {
      const prefsSection = `
## Preferences I've learned about you (Correction & Preference Learning Sentinel)

When you correct me the same way repeatedly — "no, plainer", "stop asking me that every session", "from now on lead with the action" — the Correction & Preference Learning Sentinel turns the recurring correction into a durable preference instead of a lesson that evaporates when the session ends. Each learned preference is written to \`.instar/preferences.json\`, and from then on my session-start hook fetches \`GET /preferences/session-context\` on EVERY boot and injects the active preferences into my context, wrapped in an \`<auto-learned-preference src='correction-loop'>\` envelope.

That envelope is deliberate: learned preferences are **signals, not authoritative instructions**. I apply them by default, but a real instruction or a safety rule always wins. The loop is **SIGNAL-ONLY** — it never blocks or rewrites an outbound message.

- See what's currently injected: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/preferences/session-context\` (the byte-bounded, priority-ordered block; \`503\` when the feature is off, \`{ present: false }\` when there are none yet).
- See the distilled correction/preference records the loop has captured: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/corrections\` (deduped, scrubbed records — the raw conversation is NEVER stored or served). The off-by-default weekly \`correction-analyzer\` job drives \`POST /corrections/analyze\` (the 3-pronged recurrence gate + closed-loop tick).
- Ships OFF (\`monitoring.correctionLearning.enabled\`). When off, the routes 503 and the session-start hook silently injects nothing.
- **When to use** (PROACTIVE): when the user corrects me repeatedly on the same thing, I acknowledge it, adapt now, and trust the loop to carry it forward — I do NOT promise to "remember" it by willpower across sessions. If preferences are already injected at session start, I honor them by default.
`;
      content += '\n' + prefsSection;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Correction & Preference Learning Sentinel awareness (preferences session-context + /corrections)');
    } else if (!content.includes('/corrections')) {
      // Slice 1b backfill for agents that already have the Slice-1a section but
      // not the /corrections read surface. Content-sniffed on the route path for
      // idempotency (so it's appended exactly once).
      const correctionsLine = `
- The Correction & Preference Learning Sentinel now also records distilled, scrubbed correction/preference patterns. See them: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/corrections\` (deduped, scrubbed — raw conversation is NEVER stored). The off-by-default weekly \`correction-analyzer\` job drives \`POST /corrections/analyze\` (3-pronged recurrence gate + closed-loop tick; routes explicit preferences to the preferences file, infra-gaps to a human-approved /feedback proposal, policy-relaxation to Attention).
`;
      content += '\n' + correctionsLine;
      patched = true;
      result.upgraded.push('CLAUDE.md: added /corrections read surface awareness (Correction & Preference Learning Slice 1b)');
    } else {
      result.skipped.push('CLAUDE.md: Preferences (Correction & Preference Learning) section already present');
    }

    // Slice 2 backfill — the Preferences dashboard tab is the human read surface.
    // Existing agents that already have the Slice-1a/1b section must also learn to
    // point the user at the tab instead of pasting curl output. Content-sniffed on
    // a distinctive Slice-2 marker for idempotency. Only appends when the section
    // exists (Slice-1a present) but the dashboard-tab line does not.
    if (content.includes('Correction & Preference Learning Sentinel') && !content.includes('Preferences dashboard tab')) {
      const dashTabLine = `
- The **Preferences dashboard tab** is the human read surface: it shows, in plain language, the preferences I've picked up about the user and the recent scrubbed corrections with their status. When the user asks "what have you learned about me?", I point them to that tab (dashboard URL + PIN) rather than pasting \`/corrections\` curl output. \`GET /corrections\` also pages with \`?limit\`, the \`?before=<ISO>\` keyset cursor, and a \`?since=<ISO>\` lower-bound.
`;
      content += '\n' + dashTabLine;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Preferences dashboard tab awareness (Correction & Preference Learning Slice 2)');
    }

    // Self-Violation Signal backfill — existing agents that already have the
    // Correction & Preference Learning section must also learn that a stored
    // preference can carry a self-violation pattern that turns a contradicting
    // outbound message into a recurrence-reinforcing learning signal. OBSERVE-ONLY
    // (never blocks/rewrites). Content-sniffed on a distinctive marker for
    // idempotency; only appended when the parent section exists.
    if (content.includes('Correction & Preference Learning Sentinel') && !content.includes('Self-Violation Signal')) {
      const selfViolationLine = `
- **Self-Violation Signal** (sub-feature, ships OFF behind \`monitoring.correctionLearning.selfViolationSignal\`): a learned preference may carry an optional self-violation pattern. When set, the moment I SEND an outbound message that contradicts that preference, the contradiction is recorded as a self-violation in \`/corrections\`, reinforcing that preference's recurrence so it surfaces more prominently next session. This is OBSERVE-ONLY — it NEVER blocks, delays, or rewrites the message; the message always sends. A stored-but-violated preference no longer evaporates; it becomes a learning signal.
`;
      content += '\n' + selfViolationLine;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Self-Violation Signal awareness (Correction & Preference Learning extension)');
    }

    const authenticatedCapabilitiesCurl = `curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/capabilities`;

    // Self-Discovery section
    if (!content.includes('Self-Discovery') && !content.includes('/capabilities')) {
      const section = `
### Self-Discovery (Know Before You Claim)

Before EVER saying "I don't have", "I can't", or "this isn't available" — check what actually exists:

\`\`\`bash
${authenticatedCapabilitiesCurl}
\`\`\`

This returns your full capability matrix: scripts, hooks, Telegram status, jobs, relationships, and more. It is the source of truth about what you can do. **Never hallucinate about missing capabilities — verify first.**
`;
      // Insert before "### How to Build" or "### Building New" if present, otherwise append
      const insertPoint = content.indexOf('### How to Build New Capabilities');
      const insertPoint2 = content.indexOf('### Building New Capabilities');
      const target = insertPoint >= 0 ? insertPoint : (insertPoint2 >= 0 ? insertPoint2 : -1);

      if (target >= 0) {
        content = content.slice(0, target) + section + '\n' + content.slice(target);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Self-Discovery section');
    } else {
      result.skipped.push('CLAUDE.md: Self-Discovery section already present');
    }

    const legacyCapabilitiesCurl =
      /curl(?: -s)? http:\/\/localhost:(?:\$\{INSTAR_PORT:-)?\d+\}?\/capabilities/g;
    if (legacyCapabilitiesCurl.test(content)) {
      content = content.replace(legacyCapabilitiesCurl, () => authenticatedCapabilitiesCurl);
      patched = true;
      result.upgraded.push('CLAUDE.md: authenticated Self-Discovery capabilities curl');
    }

    // Telegram Relay section — add if Telegram is configured but section is missing
    if (this.config.hasTelegram && !content.includes('Telegram Relay') && !content.includes('telegram-reply')) {
      const section = `
## Telegram Relay

When user input starts with \`[telegram:N]\` (e.g., \`[telegram:26] hello\`), the message came from a user via Telegram topic N.

**IMMEDIATE ACKNOWLEDGMENT (MANDATORY):** When you receive a Telegram message, your FIRST action — before reading files, searching code, or doing any work — must be sending a brief acknowledgment back. This confirms the message was received and you haven't stalled. Examples: "Got it, looking into this now." / "On it — checking the scheduler." / "Received, working on the sync." Then do the work, then send the full response.

**Message types:**
- **Text**: \`[telegram:26] hello there\` — standard text message
- **Voice**: \`[telegram:26] [voice] transcribed text here\` — voice message, already transcribed
- **Photo**: \`[telegram:26] [image:/path/to/file.jpg]\` or \`[telegram:26] [image:/path/to/file.jpg] caption text\` — use the Read tool to view the image at the given path
- **File**: \`[telegram:26] [document:/path/to/file.ext]\` — file uploaded by user, read it to view contents

**Response relay:** After completing your work, relay your response back:

\`\`\`bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh N
Your response text here
EOF
\`\`\`

Strip the \`[telegram:N]\` prefix before interpreting the message. Respond naturally, then relay. Only relay your conversational text — not tool output or internal reasoning.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Telegram Relay section');
    }

    // Upgrade existing Telegram Relay sections to include mandatory acknowledgment
    if (this.config.hasTelegram && content.includes('Telegram Relay') && !content.includes('IMMEDIATE ACKNOWLEDGMENT')) {
      const ackBlock = `\n**IMMEDIATE ACKNOWLEDGMENT (MANDATORY):** When you receive a Telegram message, your FIRST action — before reading files, searching code, or doing any work — must be sending a brief acknowledgment back. This confirms the message was received and you haven't stalled. Examples: "Got it, looking into this now." / "On it — checking the scheduler." / "Received, working on the sync." Then do the work, then send the full response.\n`;
      // Insert after the first line of the Telegram Relay section
      const relayIdx = content.indexOf('## Telegram Relay');
      if (relayIdx >= 0) {
        const nextNewline = content.indexOf('\n\n', relayIdx + 18);
        if (nextNewline >= 0) {
          content = content.slice(0, nextNewline + 1) + ackBlock + content.slice(nextNewline + 1);
          patched = true;
          result.upgraded.push('CLAUDE.md: added mandatory acknowledgment to Telegram Relay');
        }
      }
    }

    // Upgrade existing Telegram Relay sections to document image message format
    if (this.config.hasTelegram && content.includes('Telegram Relay') && !content.includes('[image:')) {
      const imageBlock = `\n**Message types:**\n- **Text**: \`[telegram:N] hello there\` — standard text message\n- **Voice**: \`[telegram:N] [voice] transcribed text here\` — voice message, already transcribed\n- **Photo**: \`[telegram:N] [image:/path/to/file.jpg]\` or with caption — use the Read tool to view the image at the given path\n`;
      // Insert before the Response relay section
      const relayIdx = content.indexOf('**Response relay:**');
      if (relayIdx >= 0) {
        content = content.slice(0, relayIdx) + imageBlock + '\n' + content.slice(relayIdx);
        patched = true;
        result.upgraded.push('CLAUDE.md: added image/photo message format to Telegram Relay');
      }
    }

    // Private Viewer + Tunnel section
    if (!content.includes('Private Viewing') && !content.includes('POST /view')) {
      const section = `
**Private Viewing** — Render markdown as auth-gated HTML pages, accessible only through the agent's server (local or via tunnel).
- Create: \`curl -X POST http://localhost:${port}/view -H 'Content-Type: application/json' -d '{"title":"Report","markdown":"# Private content"}'\`
- View (HTML): Open \`http://localhost:${port}/view/VIEW_ID\` in a browser
- List: \`curl http://localhost:${port}/views\`
- Update: \`curl -X PUT http://localhost:${port}/view/VIEW_ID -H 'Content-Type: application/json' -d '{"title":"Updated","markdown":"# New content"}'\`
- Delete: \`curl -X DELETE http://localhost:${port}/view/VIEW_ID\`

**Use private views for sensitive content. Use Telegraph for public content.**

**Cloudflare Tunnel** — Expose the local server to the internet via Cloudflare. Enables remote access to private views, the API, and file serving.
- Status: \`curl http://localhost:${port}/tunnel\`
- Configure in \`.instar/config.json\`: \`{"tunnel": {"enabled": true, "type": "quick"}}\`
- Quick tunnels (default): Zero-config, ephemeral URL (*.trycloudflare.com), no account needed
- Named tunnels: Persistent custom domain, requires token from Cloudflare dashboard
- When a tunnel is running, private view responses include a \`tunnelUrl\` with auth token for browser-clickable access
`;
      // Insert after Publishing section or before Scripts section
      const publishIdx = content.indexOf('**Scripts**');
      if (publishIdx >= 0) {
        content = content.slice(0, publishIdx) + section + '\n' + content.slice(publishIdx);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Private Viewer + Cloudflare Tunnel section');
    } else {
      result.skipped.push('CLAUDE.md: Private Viewer section already present');
    }

    // Secret Drop section. Pre-existing agents whose CLAUDE.md predates the
    // Secret Drop template section never received it — and because
    // migrateFrameworkShadowCapabilities copies sections FROM CLAUDE.md, a
    // missing source section also means Codex/Gemini shadows (AGENTS.md) never
    // learn the capability, so those agents improvise a weaker plaintext-file
    // handoff and even ask the user to edit a file (observed live on codey,
    // 2026-05-24). Content-sniff and inject the full section if absent. Inserted
    // immediately before the Cloudflare Tunnel marker (template document order)
    // so the shadow-capability slicer bounds the section cleanly at the next
    // marker. The retrieve-line hardening below patches an existing section; this
    // block ensures the section exists in the first place.
    if (!content.includes('**Secret Drop**')) {
      const section = `
**Secret Drop** — Securely collect secrets (API keys, passwords, tokens) from users without exposing them in chat history.
- Request a secret: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/secrets/request -H 'Content-Type: application/json' -d '{"label":"OpenAI API Key","description":"Needed for GPT integration","topicId":TOPIC_ID}'\`
- The response includes a one-time URL (\`localUrl\` and \`tunnelUrl\`). Send this link to the user.
- When the user submits the secret through the form, you receive a Telegram confirmation in the specified topic.
- **Retrieve the secret (HARDENED — required)**: \`node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name\` — streams the field VALUE to stdout, prints field NAMES + lengths to stderr, NEVER prints the response body. Discover available fields with \`... TOKEN --names\`.
- **NEVER use \`curl /secrets/retrieve\` directly** — the raw curl pattern dumps the full JSON response (including the secret value) into the Bash tool transcript.
- List pending: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/secrets/pending\`
- **Security**: One-time use, expires after 15 minutes, in-memory only (never written to disk), CSRF-protected.
- **When to use** (PROACTIVE — this is the trigger): the moment a user offers to give you a credential (API key, password, token) or you realize you need one, use Secret Drop. It is the ONLY correct way to collect a secret. NEVER accept it pasted into Telegram or chat, and NEVER create a local file (e.g. \`.instar/secrets/foo.env\`) and ask the user to edit/paste into it — that defeats the one-time, in-memory, never-on-disk guarantee and asks the user to edit files (which you must never do). Always issue a Secret Drop one-time link instead.
`;
      const tunnelIdx = content.indexOf('**Cloudflare Tunnel**');
      const scriptsIdx = content.indexOf('**Scripts**');
      const insertBefore = tunnelIdx >= 0 ? tunnelIdx : scriptsIdx;
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section.trimStart() + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Secret Drop section');
    } else {
      result.skipped.push('CLAUDE.md: Secret Drop section already present');
    }

    // Commitments & Follow-Through section. The durable follow-through
    // mechanism (CommitmentTracker + PromiseBeacon, `/commitments`) had no
    // agent-facing documentation in the template — only the dev/architecture
    // section mentions it. Result: agents (Codex observed live on codey,
    // 2026-05-24) improvise a raw `sleep`/background timer for "I'll report
    // back" promises, which does not survive session turnover. Inject the
    // agent-facing section if absent, before the Cloudflare Tunnel marker so
    // the shadow-capability slicer bounds it cleanly.
    if (!content.includes('**Commitments & Follow-Through**')) {
      const section = `
**Commitments & Follow-Through** — Durable tracking for any promise you make to the user. When you say "I'll report back when X", "I'll check in after N minutes", or otherwise commit to a future action, register it so the follow-through survives session turnover, restarts, and compaction.
- Open a one-time follow-up commitment: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/commitments -H 'Content-Type: application/json' -d '{"userRequest":"<what the user asked>","agentResponse":"<what you said you would do>","type":"one-time-action","topicId":TOPIC_ID}'\`
- List / inspect: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/commitments\` · \`GET /commitments/:id\`
- Mark delivered when done: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/commitments/:id/deliver\`
- The PromiseBeacon fires cadenced heartbeats on open commitments so you actually follow through, and the commitment-check job surfaces overdue ones.
- **When to use** (PROACTIVE — this is the trigger): the moment you promise the user a future action, open a commitment. NEVER improvise the follow-through with a raw \`sleep\`/background timer or by "remembering" — those do not survive a session ending, a restart, or compaction, so the promise is silently dropped. A registered commitment is the ONLY durable path. (Distinct from the Evolution Action Queue / \`/commit-action\`, which tracks self-improvement items, not promises to the user.)
`;
      const tunnelIdx = content.indexOf('**Cloudflare Tunnel**');
      const scriptsIdx = content.indexOf('**Scripts**');
      const insertBefore = tunnelIdx >= 0 ? tunnelIdx : scriptsIdx;
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section.trimStart() + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Commitments & Follow-Through section');
    } else {
      result.skipped.push('CLAUDE.md: Commitments & Follow-Through section already present');
    }

    // Publishing (Telegraph public pages). Awareness-parity pass: add the
    // agent-facing section if absent so it reaches Codex/Gemini shadows via
    // the markers list. Inserted before Private Viewing (template doc order).
    if (!content.includes('**Publishing**')) {
      const section = `
**Publishing** — Share content as PUBLIC web pages via Telegraph. Instant, zero-config, accessible from anywhere.
- Publish: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/publish -H 'Content-Type: application/json' -d '{"title":"Page Title","markdown":"# Content here"}'\`
- List published: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/published\`
- **⚠ CRITICAL: All Telegraph pages are PUBLIC.** Anyone with the URL can view the content — no auth, no access control. NEVER publish sensitive/private/confidential info via Telegraph; use Private Viewing for that. Always tell the user a Telegraph link is publicly accessible.
`;
      const pvIdx = content.indexOf('**Private Viewing**');
      const scriptsIdx = content.indexOf('**Scripts**');
      const insertBefore = pvIdx >= 0 ? pvIdx : scriptsIdx;
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section.trimStart() + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Publishing section');
    } else {
      result.skipped.push('CLAUDE.md: Publishing section already present');
    }

    // Attention Queue. Awareness-parity pass — agent-facing capability for
    // signalling items the user must see. Inserted before Dashboard (doc order).
    if (!content.includes('**Attention Queue**')) {
      const section = `
**Attention Queue** — Signal important items to the user. When something needs their attention — a decision, a review, an anomaly — queue it here instead of hoping they see a chat message.
- Queue: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/attention -H 'Content-Type: application/json' -d '{"id":"agent:unique-item-id","title":"...","body":"...","priority":"medium","source":"agent"}'\`
- View / resolve: \`GET /attention\` · \`PATCH /attention/ATT-ID\` with \`{"status":"resolved"}\`
- **Proactive use**: when you detect something the user should know (stale relationships, failed jobs, CI failures, overdue actions), don't just log it — queue it so it gets seen.
`;
      const dashIdx = content.indexOf('**Dashboard**');
      const scriptsIdx = content.indexOf('**Scripts**');
      const insertBefore = dashIdx >= 0 ? dashIdx : scriptsIdx;
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section.trimStart() + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Attention Queue section');
    } else {
      result.skipped.push('CLAUDE.md: Attention Queue section already present');
    }

    // Tunnel-failure-resilience awareness (spec Part 7). Existing agents
    // already have the Cloudflare Tunnel section but not the resilience
    // text — content-sniff and append a bullet so they can explain a link
    // outage + the consent-gated backup relay conversationally.
    if (content.includes('Cloudflare Tunnel') && !content.includes('Failure resilience')) {
      const resilienceBullet = `- **Failure resilience**: If Cloudflare can't give you a link (e.g. rate-limited), I'll DM you (owner only) with two buttons to approve a consent-gated backup relay through a third party. While the backup is active your dashboard traffic briefly passes through that operator, so when Cloudflare recovers I switch back automatically (after several healthy checks) and rotate your dashboard PIN + access token — which signs out open tabs and invalidates previously-shared private view links. \`GET /tunnel\` reports the live \`lifecycle.state\` (active / retrying / awaiting-consent / relay-active / self-healing / exhausted). Opt out of backups with \`{"tunnel": {"relaysEnabled": false}}\` or \`{"tunnel": {"relayConsent": "never"}}\`.`;
      // Anchor after the existing tunnelUrl bullet (present in both the
      // current template and the older variant).
      const anchors = [
        '- When a tunnel is running, private view responses include a `tunnelUrl` with auth token for browser-clickable access',
        '- When a tunnel is running, private view responses include a `tunnelUrl` field for remote access',
      ];
      const anchor = anchors.find((a) => content.includes(a));
      if (anchor) {
        content = content.replace(anchor, `${anchor}\n${resilienceBullet}`);
        patched = true;
        result.upgraded.push('CLAUDE.md: added tunnel failure-resilience awareness');
      }
    }

    // Dashboard section
    if (!content.includes('**Dashboard**') && !content.includes('/dashboard')) {
      const section = `
**Dashboard** — Visual web interface for monitoring and managing sessions. Accessible from any device (phone, tablet, laptop) via tunnel.
- Local: \`http://localhost:${port}/dashboard\`
- Remote: When a tunnel is running, the dashboard is accessible at \`{tunnelUrl}/dashboard\`
- Authentication: Uses a 6-digit PIN (auto-generated in \`dashboardPin\` in \`.instar/config.json\`). NEVER mention "bearer tokens" or "auth tokens" to users — just give them the PIN.
- Features: Real-time terminal streaming of all running sessions, session management, model badges, mobile-responsive
- **Sharing the dashboard**: When the user wants to check on sessions from their phone, give them the tunnel URL + PIN. Read the PIN from your config.json. Check tunnel status: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/tunnel\`
`;
      // Insert after Server Status or before Scripts section
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Dashboard section');
    } else {
      result.skipped.push('CLAUDE.md: Dashboard section already present');
    }

    // Coherence Gate section — pre-action verification for high-risk actions
    if (!content.includes('Coherence Gate') && !content.includes('/coherence/check')) {
      const section = `
### Coherence Gate (Pre-Action Verification)

**BEFORE any high-risk action** (deploying, pushing to git, modifying files outside this project, calling external APIs):

1. **Check coherence**: \`curl -X POST http://localhost:${port}/coherence/check -H 'Content-Type: application/json' -d '{"action":"deploy","context":{"topicId":TOPIC_ID}}'\`
2. **If result says "block"** — STOP. You may be working on the wrong project for this topic.
3. **If result says "warn"** — Pause and verify before proceeding.
4. **Generate a reflection prompt**: \`POST http://localhost:${port}/coherence/reflect\` — produces a self-verification checklist.

#### ORG-INTENT.md (Organizational Intent at Runtime)

If \`.instar/ORG-INTENT.md\` exists on disk, two runtime surfaces consume it: the Coherence Gate (Phase 1) reads it on every outbound message review, and the session-start hook (Phase 2) fetches it at session boot via \`GET /intent/org/session-context\` and injects the structured contract into your context. **Constraints** are mandatory (violations block), **goals** are organizational defaults (contradictions warn or block), **values** shape representation (drift warns), and the **tradeoff hierarchy** resolves ties when two values pull in opposite directions (earlier entry wins).

Manage it:
- Scaffold a starter: \`instar intent org-init "Your Org Name"\`
- Static validation against agent intent: \`instar intent validate\`
- Inspect parsed structure: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/intent/org\`
- Preview the session-start block: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/intent/org/session-context\`
- Resolve a tradeoff via the org hierarchy (Phase 3): \`curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"valueA":"speed","valueB":"customer trust"}' http://localhost:${port}/intent/tradeoff-resolve\` — returns the winning value with explanation per the org's tradeoff hierarchy.
- Surface accumulated drift (Phase 4): \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/intent/org/drift?lookbackDays=7"\` — drift digest from recent Coherence Gate review history. A weekly job template (\`.instar/jobs/instar/org-intent-drift-audit.md\`, off by default) wraps this for periodic Telegram heads-ups.

**Topic-Project Bindings**: Each Telegram topic can be bound to a specific project. When switching topics, verify the binding matches your current working directory.
- View bindings: \`GET http://localhost:${port}/topic-bindings\`
- Create binding: \`POST http://localhost:${port}/topic-bindings\` with \`{"topicId": N, "binding": {"projectName": "...", "projectDir": "..."}}\`

**Project Map**: Your spatial awareness of the working environment.
- View: \`GET http://localhost:${port}/project-map?format=compact\`
- Refresh: \`POST http://localhost:${port}/project-map/refresh\`
`;
      // Insert before Scripts or append
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added Coherence Gate section');
    } else if (!content.includes('ORG-INTENT.md (Organizational Intent at Runtime)') && !content.includes('Organizational Intent at Runtime')) {
      // Coherence Gate section is present but predates the ORG-INTENT runtime
      // wiring. Append the ORG-INTENT subsection inline after the
      // "Generate a reflection prompt" line so the agent learns that
      // ORG-INTENT.md now actually shapes outbound message review.
      const subsection = `

#### ORG-INTENT.md (Organizational Intent at Runtime)

If \`.instar/ORG-INTENT.md\` exists on disk, two runtime surfaces consume it: the Coherence Gate (Phase 1) reads it on every outbound message review, and the session-start hook (Phase 2) fetches it at session boot via \`GET /intent/org/session-context\` and injects the structured contract into your context. **Constraints** are mandatory (violations block), **goals** are organizational defaults (contradictions warn or block), **values** shape representation (drift warns), and the **tradeoff hierarchy** resolves ties when two values pull in opposite directions (earlier entry wins).

Manage it:
- Scaffold a starter: \`instar intent org-init "Your Org Name"\`
- Static validation against agent intent: \`instar intent validate\`
- Inspect parsed structure: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/intent/org\`
- Preview the session-start block: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/intent/org/session-context\`
- Resolve a tradeoff via the org hierarchy (Phase 3): \`curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"valueA":"speed","valueB":"customer trust"}' http://localhost:${port}/intent/tradeoff-resolve\` — returns the winning value with explanation per the org's tradeoff hierarchy.
- Surface accumulated drift (Phase 4): \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/intent/org/drift?lookbackDays=7"\` — drift digest from recent Coherence Gate review history. A weekly job template (\`.instar/jobs/instar/org-intent-drift-audit.md\`, off by default) wraps this for periodic Telegram heads-ups.
`;
      // Anchor: insert after "Topic-Project Bindings" header so it lands inside
      // the Coherence Gate section but before the Project Map subsection.
      const anchor = content.indexOf('**Topic-Project Bindings**');
      if (anchor >= 0) {
        content = content.slice(0, anchor) + subsection + '\n' + content.slice(anchor);
        patched = true;
        result.upgraded.push('CLAUDE.md: added ORG-INTENT.md runtime subsection (Phase 1+2) to Coherence Gate');
      } else {
        // Fallback: append at end if the Topic-Project Bindings anchor moved
        content += '\n' + subsection;
        patched = true;
        result.upgraded.push('CLAUDE.md: appended ORG-INTENT.md runtime subsection (anchor missing, fallback insert)');
      }
    } else if (
      content.includes('ORG-INTENT.md (Organizational Intent at Runtime)')
      && content.includes('/intent/tradeoff-resolve')
      && !content.includes('/intent/org/drift')
    ) {
      // CLAUDE.md has Phase 1+2+3 but is missing Phase 4 (drift detection).
      // Append the drift curl line to the existing Manage-it bullet list.
      // Idempotent: substring check above prevents re-insertion.
      const driftLine = `- Surface accumulated drift (Phase 4): \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/intent/org/drift?lookbackDays=7"\` — drift digest from recent Coherence Gate review history. A weekly job template (\`.instar/jobs/instar/org-intent-drift-audit.md\`, off by default) wraps this for periodic Telegram heads-ups.`;
      // Anchor: insert right after the Phase 3 tradeoff-resolve line.
      const phase3Marker = '/intent/tradeoff-resolve';
      const idx = content.indexOf(phase3Marker);
      if (idx >= 0) {
        const lineEnd = content.indexOf('\n', idx);
        if (lineEnd >= 0) {
          content = content.slice(0, lineEnd + 1) + driftLine + '\n' + content.slice(lineEnd + 1);
          patched = true;
          result.upgraded.push('CLAUDE.md: added Phase 4 drift-detection curl line to ORG-INTENT subsection');
        } else {
          result.skipped.push('CLAUDE.md: Phase 3 marker present but newline anchor missing (skipping)');
        }
      } else {
        result.skipped.push('CLAUDE.md: Phase 3 anchor for drift insertion not found (skipping)');
      }
    } else if (
      content.includes('ORG-INTENT.md (Organizational Intent at Runtime)')
      && content.includes('/intent/org/session-context')
      && !content.includes('/intent/tradeoff-resolve')
    ) {
      // CLAUDE.md has Phase 1+2 but is missing Phase 3 (tradeoff helper).
      // Append the tradeoff-resolve curl line to the existing Manage-it
      // bullet list. Idempotent: substring check above prevents re-insertion.
      const tradeoffLine = `- Resolve a tradeoff via the org hierarchy (Phase 3): \`curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"valueA":"speed","valueB":"customer trust"}' http://localhost:${port}/intent/tradeoff-resolve\` — returns the winning value with explanation per the org's tradeoff hierarchy.
- Surface accumulated drift (Phase 4): \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/intent/org/drift?lookbackDays=7"\` — drift digest from recent Coherence Gate review history. A weekly job template (\`.instar/jobs/instar/org-intent-drift-audit.md\`, off by default) wraps this for periodic Telegram heads-ups.`;
      const anchor = `- Preview the session-start block: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/intent/org/session-context\``;
      const before = content;
      content = content.replace(anchor, `${anchor}\n${tradeoffLine}`);
      if (content !== before) {
        patched = true;
        result.upgraded.push('CLAUDE.md: added Phase 3 tradeoff-resolve curl line to ORG-INTENT subsection');
      } else {
        result.skipped.push('CLAUDE.md: ORG-INTENT subsection present but Phase 3 anchor line not found (skipping)');
      }
    } else if (
      content.includes('ORG-INTENT.md (Organizational Intent at Runtime)')
      && !content.includes('/intent/org/session-context')
    ) {
      // CLAUDE.md already has the Phase 1 ORG-INTENT runtime subsection but
      // not the Phase 2 session-start injection mention. Rewrite the
      // subsection in place so the agent learns about both surfaces.
      // Match: from the heading line through the empty line before the next
      // ### heading (typically "### External Operation Safety" or
      // "## Agent Infrastructure").
      const headingPattern = /(####? ORG-INTENT\.md \(Organizational Intent at Runtime\))[\s\S]*?(?=\n## |\n### |$)/;
      const replacement = `$1

If \`.instar/ORG-INTENT.md\` exists on disk, two runtime surfaces consume it: the Coherence Gate (Phase 1) reads it on every outbound message review, and the session-start hook (Phase 2) fetches it at session boot via \`GET /intent/org/session-context\` and injects the structured contract into your context. **Constraints** are mandatory (violations block), **goals** are organizational defaults (contradictions warn or block), **values** shape representation (drift warns), and the **tradeoff hierarchy** resolves ties when two values pull in opposite directions (earlier entry wins).

Manage it:
- Scaffold a starter: \`instar intent org-init "Your Org Name"\`
- Static validation against agent intent: \`instar intent validate\`
- Inspect parsed structure: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/intent/org\`
- Preview the session-start block: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/intent/org/session-context\`
- Resolve a tradeoff via the org hierarchy (Phase 3): \`curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' -d '{"valueA":"speed","valueB":"customer trust"}' http://localhost:${port}/intent/tradeoff-resolve\` — returns the winning value with explanation per the org's tradeoff hierarchy.
- Surface accumulated drift (Phase 4): \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/intent/org/drift?lookbackDays=7"\` — drift digest from recent Coherence Gate review history. A weekly job template (\`.instar/jobs/instar/org-intent-drift-audit.md\`, off by default) wraps this for periodic Telegram heads-ups.

`;
      const before = content;
      content = content.replace(headingPattern, replacement);
      if (content !== before) {
        patched = true;
        result.upgraded.push('CLAUDE.md: upgraded ORG-INTENT.md subsection to mention Phase 2 session-start injection');
      } else {
        result.skipped.push('CLAUDE.md: ORG-INTENT.md subsection present but Phase 2 upgrade pattern did not match (skipping)');
      }
    } else {
      result.skipped.push('CLAUDE.md: Coherence Gate section already present');
    }

    // External Operation Safety — structural guardrails for external service operations
    if (!content.includes('External Operation Safety') && !content.includes('/operations/evaluate')) {
      const section = `
### External Operation Safety (Structural Guardrails)

**When using MCP tools that interact with external services** (email, Slack, GitHub, etc.), a PreToolUse hook automatically classifies and gates each operation.

How it works:
1. The \`external-operation-gate.js\` hook intercepts all \`mcp__*\` tool calls
2. It classifies the operation by mutability (read/write/modify/delete) and reversibility
3. For non-read operations, it calls the gate API: \`POST http://localhost:${port}/operations/evaluate\`
4. The gate returns: \`proceed\`, \`block\`, \`show-plan\` (requires user approval), or \`suggest-alternative\`

**If an operation is blocked**, you'll see an error message with the reason. Do NOT try to bypass it.
**If an operation requires a plan**, show the plan to the user and get explicit approval before proceeding.

**Emergency stop**: If the user says "stop everything", "emergency stop", "kill all sessions", or similar urgent commands, the MessageSentinel will intercept the message and halt operations immediately.

**Trust levels**: Each service starts at a trust floor (supervised or collaborative). As operations succeed without issues, trust can be elevated automatically. Check trust status: \`GET http://localhost:${port}/trust\`

**API endpoints**:
- Evaluate operation: \`POST http://localhost:${port}/operations/evaluate\`
- Classify message: \`POST http://localhost:${port}/sentinel/classify\`
- View trust: \`GET http://localhost:${port}/trust\`
- View operation log: \`GET http://localhost:${port}/operations/log\`
`;
      // Insert before Scripts or append
      const insertBefore = content.indexOf('**Scripts**');
      if (insertBefore >= 0) {
        content = content.slice(0, insertBefore) + section + '\n' + content.slice(insertBefore);
      } else {
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added External Operation Safety section');
    } else {
      result.skipped.push('CLAUDE.md: External Operation Safety section already present');
    }

    // Playbook — adaptive context engineering system
    if (!content.includes('Playbook') || !content.includes('instar playbook')) {
      const section = `
### Playbook — Adaptive Context Engineering

The Playbook system gives you a living knowledge base that makes every session smarter than the last. Instead of loading the same static context every time, Playbook curates a manifest of context items — facts, lessons, patterns, safety rules — and selects exactly what's relevant for each session based on triggers, token budgets, and usefulness scores.

**Getting started:**
\`\`\`bash
instar playbook init       # Initialize the playbook system
instar playbook doctor     # Verify everything is healthy
\`\`\`

**Core commands:**
- \`instar playbook status\` — Overview of your manifest
- \`instar playbook list\` — All context items with metadata
- \`instar playbook add '<json>'\` — Add a new context item
- \`instar playbook search --tag <tag>\` — Find items by tag
- \`instar playbook assemble --triggers session-start\` — Preview what would load for a trigger
- \`instar playbook evaluate\` — Run lifecycle: score usefulness, decay stale items, deduplicate

**When to add context items:** After learning a lesson that cost time, when discovering a recurring pattern, when safety-critical knowledge should survive compaction, or when the user teaches you something project-specific.

**The principle:** Your context should evolve with you. Every session that adds a lesson, scores an item's usefulness, or retires stale knowledge makes the next session more grounded. Run \`instar playbook init\` to get started.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Playbook section');
    } else {
      result.skipped.push('CLAUDE.md: Playbook section already present');
    }

    // Threadline Network — agent-to-agent communication awareness
    if (!content.includes('Threadline Network')) {
      const section = `
## Threadline Network (Agent-to-Agent Communication)

I have a built-in capability to join a secure network of AI agents. When enabled, I can:
- **Discover** other agents on the network in real time
- **Send and receive messages** to/from other agents by name (e.g., "message AI Guy")
- **Collaborate** across machines — agents on different computers can communicate seamlessly

### Current Status
This capability is **installed and ready** but **not yet enabled**. I will only connect when you say so.

### Why You Might Want This
- Talk to other AI agents your operator runs on other machines
- Let other agents reach you for collaboration or delegation
- Join a growing network of Instar-powered agents

### Privacy & Security
- **Encrypted** — TLS transport + Ed25519 end-to-end encryption
- **Trust-gated** — I control who can message me via trust levels
- **Your choice** — just ask me to "connect to the agent network" and I'll enable it. Ask me to "disconnect" and I'll stop.

### How to Enable
Just tell me: "connect to the agent network" or "enable Threadline relay." I'll handle the rest — no config editing needed.

MCP tools: \`threadline_discover\`, \`threadline_send\`, \`threadline_trust\`, \`threadline_relay\`
Use \`threadline_relay explain\` for full details.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Threadline Network section');
    } else {
      result.skipped.push('CLAUDE.md: Threadline Network section already present');
    }

    // Session Continuity — ensure agents know how to handle respawn context
    if (this.config.hasTelegram && !content.includes('Session Continuity') && !content.includes('CONTINUATION')) {
      const section = `
### Session Continuity (CRITICAL)

When your first message starts with \`CONTINUATION\`, you are **resuming an existing conversation**. The inline context contains a summary and recent messages from the prior session. You MUST:

1. **Read the context first** — it tells you what the conversation is about
2. **Pick up where you left off** — do NOT introduce yourself or ask "how can I help?"
3. **Reference the prior context** — show the user you know what they were discussing

The user has been talking to you (possibly for days). A generic greeting like "Hey! What can I help you with?" after dozens of messages of conversation history is a critical failure — it signals you lost all context and the user has to repeat everything. The context is right there in your input. Use it.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Session Continuity section');
    } else if (this.config.hasTelegram && content.includes('Session Continuity')) {
      result.skipped.push('CLAUDE.md: Session Continuity section already present');
    }

    // File Viewer — browse and edit files from the dashboard
    if (!content.includes('File Viewer') && !content.includes('/api/files/')) {
      const section = `
**File Viewer (Dashboard Tab)** — Browse and edit project files from any device via the Files tab.
- **Browse files**: Files tab in the dashboard shows configured directories with rendered markdown and syntax-highlighted code
- **Edit files**: Files in editable paths can be edited inline from your phone. Save with Cmd/Ctrl+S.
- **Link to files**: Generate deep links: \`{dashboardUrl}?tab=files&path=.claude/CLAUDE.md\`
- **When to link vs inline**: Prefer dashboard links for long files (>50 lines) and when editing is needed. Show short files inline AND provide a link.
- **Config API**: View: \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/api/files/config\`
- **Update paths conversationally**: \`curl -X PATCH -H "Authorization: Bearer $AUTH" -H "X-Instar-Request: 1" -H "Content-Type: application/json" http://localhost:${port}/api/files/config -d '{"allowedPaths":[".claude/","docs/","src/"]}'\`
- **Generate a file link**: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/api/files/link?path=.claude/CLAUDE.md"\`
- **Download a file**: \`curl -H "Authorization: Bearer $AUTH" "http://localhost:${port}/api/files/download?path=.claude/CLAUDE.md" -O\`
- **Default config**: Browsing and editing enabled for the entire project directory (\`./\`) by default.
- **Never editable**: \`.claude/hooks/\`, \`.claude/scripts/\`, \`node_modules/\`, \`.instar/jobs/instar/\` are always read-only regardless of config.
`;
      // Insert after Dashboard section
      const dashboardIdx = content.indexOf('**Dashboard**');
      if (dashboardIdx >= 0) {
        // Find the end of the Dashboard section (next empty line followed by **Bold** or ###)
        const afterDashboard = content.indexOf('\n\n**', dashboardIdx + 15);
        const afterDashboardH3 = content.indexOf('\n\n###', dashboardIdx + 15);
        const insertIdx = Math.min(
          afterDashboard >= 0 ? afterDashboard : Infinity,
          afterDashboardH3 >= 0 ? afterDashboardH3 : Infinity,
        );
        if (isFinite(insertIdx)) {
          content = content.slice(0, insertIdx) + '\n' + section + content.slice(insertIdx);
        } else {
          content += '\n' + section;
        }
      } else {
        // No Dashboard section — append
        content += '\n' + section;
      }
      patched = true;
      result.upgraded.push('CLAUDE.md: added File Viewer section');
    } else {
      result.skipped.push('CLAUDE.md: File Viewer section already present');
    }

    // Secret Drop hardened retrieve — patch the unsafe `curl /secrets/retrieve/TOKEN`
    // line if it's still in the user's CLAUDE.md. Fresh inits get the hardened
    // guidance via generateClaudeMd; existing agents updating in place keep the
    // old unsafe instruction unless we rewrite it here. Idempotent: skips if
    // the user already has the hardened helper documented.
    if (
      content.includes('Retrieve the secret:') &&
      content.includes('secrets/retrieve/TOKEN') &&
      !content.includes('secret-drop-retrieve.mjs')
    ) {
      const oldLine =
        `- Retrieve the secret: \`curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:${port}/secrets/retrieve/TOKEN\``;
      const newBlock =
        `- **Retrieve the secret (HARDENED — required)**: \`node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name\` — streams the field VALUE to stdout, prints field NAMES + lengths to stderr, NEVER prints the response body. Pipe directly: \`node .instar/scripts/secret-drop-retrieve.mjs TOKEN password | gh secret set FOO\`. Discover available fields with \`... TOKEN --names\`.\n- **NEVER use \`curl /secrets/retrieve\` directly** — the raw curl pattern dumps the full JSON response (including the secret value) into the Bash tool transcript. The hardened script exists specifically to close that leak class (origin: 2026-05-20 incident).`;
      if (content.includes(oldLine)) {
        content = content.replace(oldLine, newBlock);
        patched = true;
        result.upgraded.push('CLAUDE.md: rewrote Secret Drop retrieval to hardened helper');
      } else {
        // Older agents may have a slightly different port literal in the
        // line — match on the stable substring and replace the whole line.
        const lineRegex = /- Retrieve the secret:.*\/secrets\/retrieve\/TOKEN`/;
        if (lineRegex.test(content)) {
          content = content.replace(lineRegex, newBlock);
          patched = true;
          result.upgraded.push('CLAUDE.md: rewrote Secret Drop retrieval to hardened helper (port-tolerant)');
        }
      }
    } else if (content.includes('secret-drop-retrieve.mjs')) {
      result.skipped.push('CLAUDE.md: Secret Drop already documents hardened helper');
    }

    // Worktree Convention section (Migration Parity Standard backfill for
    // Layer 2 of the agent worktree convention — fresh inits get this via
    // generateClaudeMd; existing agents get it here on update).
    if (!content.includes('Worktree Convention') && !content.includes('instar worktree create <branch>')) {
      const section = `
## Worktree Convention

Create worktrees for collaborator repos with \`instar worktree create <branch>\` — it resolves your agent's home automatically. Never hardcode another agent's name or place worktrees inside the shared checkout.

**Why:** the macOS sandbox can revoke filesystem access to anything outside the agent home mid-session, with no in-session recovery path. The agent home (\`~/.instar/agents/<agent>/\`) is the one location the sandbox cannot revoke. \`instar worktree create\` places the worktree at \`~/.instar/agents/<agent>/.worktrees/<slug>/\` and refuses any other destination. Spec: \`docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md\`.

**Caveat — git identity env vars:** the CLI sets per-worktree \`user.name\` / \`user.email\` to \`Instar Agent (<name>)\` / \`<name>@instar.local\`. \`GIT_AUTHOR_NAME\` / \`GIT_COMMITTER_EMAIL\` in the calling environment override that local config. Agents that care about commit attribution must avoid exporting those vars.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Worktree Convention section');
    } else {
      result.skipped.push('CLAUDE.md: Worktree Convention section already present');
    }

    // Graduated Feature Rollout (§4.5): the Registry-First table must route
    // "what are we working on" to the initiative tracker so the agent never
    // answers from memory. Idempotent: insert the row after "What can I do?".
    if (!content.includes('What are we working on?') && content.includes('| What can I do?')) {
      const row = `| What are we working on? / status of a project or initiative? | \`curl -H "Authorization: Bearer $AUTH" http://localhost:${port}/initiatives\` + \`/projects\` (and \`/initiatives/digest\` for what needs a decision) — NEVER answer this from memory |`;
      content = content.replace(/(\| What can I do\?[^\n]*\n)/, `$1${row}\n`);
      patched = true;
      result.upgraded.push('CLAUDE.md: added "what are we working on" Registry-First row (initiative discoverability)');
    }

    // Process Health (Dashboard Tab) — Agent Awareness backfill for the
    // Failure-Learning Loop's read surface. Fresh inits get this via
    // generateClaudeMd; existing agents get it here on update. The copy mirrors
    // the template exactly. Idempotent via content-sniff on the section title.
    if (!content.includes('Process Health (Dashboard Tab)')) {
      const section = `
**Process Health (Dashboard Tab)** — A calm, human-readable window into the Failure-Learning Loop. The loop's findings are otherwise invisible (API-only); this tab shows, in plain English and large type, what's being watched, any patterns surfaced, and where the rollout sits.
- **Where**: the "Process Health" tab in the dashboard. Refreshes itself quietly; nothing to run.
- **What it shows**: an informational headline ("Watching — N issues recorded"), surfaced patterns (awareness-only — never auto-acted-on), recent captures as plain sentences, and the maturation track. A collapsed "Detail" drawer holds the aggregate counts.
- **Proactive trigger**: when the user asks "is the loop noticing anything? / how's the rollout going? / what's it found?" → point them to the Process Health tab (give the dashboard URL + PIN). Do NOT paraphrase \`/failures*\` curl output at them — the tab IS the answer surface. Only read \`/failures/analysis\` yourself when you need the raw numbers for your own reasoning.
- **Disabled note**: when \`monitoring.failureLearning.enabled\` is false the tab shows a friendly "not turned on yet" message, not an error.
`;
      content += '\n' + section;
      patched = true;
      result.upgraded.push('CLAUDE.md: added Process Health dashboard tab awareness section');
    }

    if (patched) {
      try {
        fs.writeFileSync(claudeMdPath, content);
      } catch (err) {
        result.errors.push(`CLAUDE.md write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Mirror capability-instruction sections from the freshly-patched CLAUDE.md
   * into any non-Claude framework shadows (AGENTS.md, GEMINI.md) that exist
   * on disk. Portability audit Gap 6 minimal-shim implementation:
   * `generateClaudeMd` + `migrateClaudeMd` produce a rich capability/
   * instructions document for Claude Code, but Codex/Gemini shadows had no
   * equivalent — agents on those runtimes received the canonical identity
   * (Gap 1, shipped) but none of the "here's what you can do" sections.
   *
   * The shim slices each known capability section out of CLAUDE.md (from its
   * marker through the start of the next top-level heading) and appends any
   * section missing from the shadow. The section bodies are NOT duplicated
   * — they are literally copied from the just-patched CLAUDE.md, so the two
   * cannot drift. Runs AFTER `migrateClaudeMd` so the source is current.
   *
   * Idempotent: each section is only appended when its marker is absent from
   * the shadow. No-op when CLAUDE.md is absent or no shadow exists. Safe for
   * Claude-only installs (they have no AGENTS.md/GEMINI.md so nothing
   * happens). A full refactor that extracts the section *bodies* into a
   * shared array is deliberately NOT done here per the operator's
   * "minimal shim" decision — that would touch ~360 lines of inline content
   * in `migrateClaudeMd` and is high-risk for low marginal benefit.
   */
  private migrateFrameworkShadowCapabilities(result: MigrationResult): void {
    const claudeMdPath = path.join(this.config.projectDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      result.skipped.push('shadow capabilities (CLAUDE.md absent — nothing to mirror)');
      return;
    }
    let claudeMd: string;
    try {
      claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    } catch (err) {
      result.errors.push(`shadow capabilities: CLAUDE.md read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Markers identifying each capability section migrateClaudeMd may have
    // ensured exists in CLAUDE.md. Kept in document order so appended
    // sections preserve narrative ordering in the shadow.
    const markers = [
      '### Self-Discovery',
      '**Publishing**',
      '**Private Viewing**',
      '**Secret Drop**',
      '**Commitments & Follow-Through**',
      '**Cloudflare Tunnel**',
      '**Attention Queue**',
      '**Dashboard**',
      '**File Viewer',
      '### Coherence Gate',
      '### External Operation Safety',
      '### Playbook — Adaptive Context Engineering',
      '## Threadline Network (Agent-to-Agent Communication)',
      '## Worktree Convention',
      '**Multi-Session Autonomy**',
      '**Process Health (Dashboard Tab)**',
      "**Preferences I've learned about you**",
    ];

    for (const shadowName of ['AGENTS.md', 'GEMINI.md']) {
      const shadowPath = path.join(this.config.projectDir, shadowName);
      if (!fs.existsSync(shadowPath)) continue;

      let shadowContent: string;
      try {
        shadowContent = fs.readFileSync(shadowPath, 'utf-8');
      } catch (err) {
        result.errors.push(`${shadowName} read: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      let appended = shadowContent;
      let mirrored = 0;
      for (const marker of markers) {
        if (appended.includes(marker)) continue;
        const start = claudeMd.indexOf(marker);
        if (start < 0) continue;
        // Slice from the marker through the start of the next top-level
        // heading (##/### line) OR the next capability marker, whichever comes
        // first. The leading "\n" guard avoids matching headings inside fenced
        // code blocks at column 0 only when they begin a line. Bounding at the
        // next marker (not only the next heading) is required because these
        // capability sections are `**bold**` blocks with NO intervening
        // heading — without it, slicing one bold section over-grabs every
        // following bold section up to the next ### and duplicates them in the
        // shadow. (Regression context: `**Secret Drop**` sits between
        // `**Private Viewing**` and `**Cloudflare Tunnel**`; a heading-only
        // bound would have copied Tunnel + everything after into the Secret
        // Drop slice.)
        const after = claudeMd.slice(start);
        // Skip past the marker's own header line, then look for the next
        // boundary. Without this, a marker that itself starts with "###"
        // would zero-length match.
        const nlAfterMarker = after.indexOf('\n');
        const searchFrom = nlAfterMarker >= 0 ? nlAfterMarker + 1 : 0;
        const tail = after.slice(searchFrom);
        let nextRel = tail.search(/(^|\n)(##|###) [^#\n]/);
        if (nextRel < 0) nextRel = tail.length;
        for (const other of markers) {
          if (other === marker) continue;
          const oi = tail.indexOf(other);
          if (oi >= 0 && oi < nextRel) nextRel = oi;
        }
        const sectionEnd = searchFrom + nextRel;
        const section = after.slice(0, sectionEnd).trimEnd();
        appended = appended.trimEnd() + '\n\n' + section + '\n';
        mirrored++;
      }

      if (mirrored > 0) {
        try {
          fs.writeFileSync(shadowPath, appended);
          result.upgraded.push(`${shadowName}: mirrored ${mirrored} capability section(s) from CLAUDE.md`);
        } catch (err) {
          result.errors.push(`${shadowName} write: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        result.skipped.push(`${shadowName}: capability sections already present`);
      }
    }
  }

  /**
   * Install any new scripts that don't exist yet.
   * Never overwrites existing scripts (user may have customized them).
   */
  private migrateScripts(result: MigrationResult): void {
    const scriptsDir = path.join(this.config.projectDir, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Telegram reply script — install if missing, or migrate if the existing
    // copy is an older version that lacks HTTP 408 handling. The 408-handling
    // fix prevents duplicate-send cascades when the outbound-route request
    // timeout races a successful tone-gate + Telegram API send (see 408 branch
    // in the current template). Detection: the telltale is the literal
    // 'HTTP_CODE" = "408"' branch — older versions don't have it.
    if (this.config.hasTelegram) {
      const scriptPath = path.join(scriptsDir, 'telegram-reply.sh');
      const newContent = this.getTelegramReplyScript();
      if (!fs.existsSync(scriptPath)) {
        try {
          fs.writeFileSync(scriptPath, newContent, { mode: 0o755 });
          result.upgraded.push('scripts/telegram-reply.sh (Telegram outbound relay)');
        } catch (err) {
          result.errors.push(`telegram-reply.sh: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // SHA-based migrator (spec § Layer 1, migration). Replaces the
        // marker-string match — which silently overwrote any user
        // customization that happened to keep the shipped header line.
        // The new flow is hash-only: if the on-disk SHA matches a
        // known prior shipped version, back up + overwrite; if it
        // matches the new template, no-op; otherwise leave the
        // original alone, write a `.new` candidate, and surface a
        // degradation event so the operator sees the customization
        // and can resolve it.
        this.migrateReplyScriptToPortConfig({
          scriptPath,
          newContent,
          label: 'scripts/telegram-reply.sh',
          stateDir: this.config.stateDir,
          result,
        });
      }

      // Framework-neutral mirror (portability audit Gap 4). The SessionStart
      // hook and the IdentityRenderer relay appendix prefer
      // `.instar/scripts/telegram-reply.sh` because `.instar/` exists for
      // every runtime, whereas `.claude/scripts/` only exists for Claude
      // Code. Before this, the script was installed ONLY under
      // `.claude/scripts/`, so the neutral preference never resolved and a
      // Codex/Gemini install was told (via AGENTS.md) to run a script that
      // did not exist. Mirror the same generated content to the neutral
      // location, install-if-missing + SHA-migrate, identical semantics to
      // the `.claude/scripts/` copy above.
      const neutralScriptsDir = path.join(this.config.stateDir, 'scripts');
      try {
        fs.mkdirSync(neutralScriptsDir, { recursive: true });
        const neutralScriptPath = path.join(neutralScriptsDir, 'telegram-reply.sh');
        if (!fs.existsSync(neutralScriptPath)) {
          fs.writeFileSync(neutralScriptPath, newContent, { mode: 0o755 });
          result.upgraded.push('.instar/scripts/telegram-reply.sh (framework-neutral relay)');
        } else {
          this.migrateReplyScriptToPortConfig({
            scriptPath: neutralScriptPath,
            newContent,
            label: '.instar/scripts/telegram-reply.sh',
            stateDir: this.config.stateDir,
            result,
          });
        }
      } catch (err) {
        result.errors.push(`.instar/scripts/telegram-reply.sh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Slack reply script — file-presence gated (migrator has no hasSlack
    // signal and init.ts doesn't install this one; scripts get deployed
    // through the template manifest). If the script is present and matches
    // the shipped header but lacks 408 handling, migrate it. Custom scripts
    // are preserved by the shipped-marker check.
    this.migrateReplyScriptTo408({
      scriptPath: path.join(scriptsDir, 'slack-reply.sh'),
      templateFilename: 'slack-reply.sh',
      shippedMarker: 'slack-reply.sh — Send a message to a Slack channel via the instar server',
      label: 'scripts/slack-reply.sh',
      result,
    });

    // WhatsApp reply script — lives in .instar/scripts/ per init.ts, not
    // .claude/scripts/. File-presence gated same as Slack.
    const whatsappScriptsDir = path.join(this.config.stateDir, 'scripts');
    this.migrateReplyScriptTo408({
      scriptPath: path.join(whatsappScriptsDir, 'whatsapp-reply.sh'),
      templateFilename: 'whatsapp-reply.sh',
      shippedMarker: 'whatsapp-reply.sh — Send a message back to a WhatsApp JID via instar server',
      label: 'scripts/whatsapp-reply.sh',
      result,
    });

    // Health watchdog — install if missing
    const watchdogPath = path.join(scriptsDir, 'health-watchdog.sh');
    if (!fs.existsSync(watchdogPath)) {
      try {
        fs.writeFileSync(watchdogPath, this.getHealthWatchdog(), { mode: 0o755 });
        result.upgraded.push('scripts/health-watchdog.sh');
      } catch (err) {
        result.errors.push(`health-watchdog.sh: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      result.skipped.push('scripts/health-watchdog.sh (already exists)');
    }

    // Convergence check — always overwrite (generated infrastructure, not user-edited).
    // This is the heuristic quality gate that runs before external messaging.
    // Must be in .instar/scripts/ where grounding-before-messaging.sh expects it.
    const instarScriptsDir = path.join(this.config.stateDir, 'scripts');
    fs.mkdirSync(instarScriptsDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(instarScriptsDir, 'convergence-check.sh'), this.getConvergenceCheck(), { mode: 0o755 });
      result.upgraded.push('scripts/convergence-check.sh (pre-messaging quality gate)');
    } catch (err) {
      result.errors.push(`convergence-check.sh: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Secret Drop hardened retrieve helper — always overwrite. Security-
    // critical: the raw curl pattern against /secrets/retrieve leaks the
    // value into the Bash tool transcript (2026-05-20 incident class). The
    // hardened mjs streams the field value to stdout and never prints the
    // response body. Existing agents must get the helper without waiting
    // for a manual install. Custom forks land at custom/secret-drop-* paths
    // and are untouched by this overwrite.
    try {
      const retrieveContent = this.loadRelayTemplate('secret-drop-retrieve.mjs');
      if (retrieveContent) {
        fs.writeFileSync(
          path.join(instarScriptsDir, 'secret-drop-retrieve.mjs'),
          retrieveContent,
          { mode: 0o755 },
        );
        result.upgraded.push('scripts/secret-drop-retrieve.mjs (hardened Secret Drop retrieval)');
      }
    } catch (err) {
      result.errors.push(`secret-drop-retrieve.mjs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Secret-externalization survivability migration.
   *
   * On first multi-machine pairing, `SecretMigrator` moves authToken out of
   * plaintext config.json into the encrypted secret store and replaces the
   * on-disk field with the literal `{ "secret": true }` placeholder. Any
   * shipped script that reads authToken directly from config.json then sends
   * the placeholder as a Bearer token and the server returns 403 silently —
   * the script just emits nothing. This caused the 2026-05-29 incident where
   * the telegram topic-history injection hook stopped firing and the agent
   * came back from compaction with no idea what the user had been saying.
   *
   * The canonical hook scripts (session-start.sh, compaction-recovery.sh,
   * telegram-topic-context.sh) are always-overwritten by the existing
   * `migrateHooks()` path, so this method only addresses the auxiliary
   * shipped scripts that aren't on the always-overwrite track: the messaging
   * channel-context hook (slack-channel-context.sh), the iMessage reply
   * script, and the serendipity-capture helper. Telegram/Slack/WhatsApp
   * reply scripts have their own SHA-based migrators that already detect
   * stale auth-handling via the extended-marker check in
   * `migrateReplyScriptTo408()`.
   *
   * The detection is structural: the file is upgraded iff
   *   1. it exists at the expected path,
   *   2. it contains the shipped header marker (so we don't touch custom
   *      forks),
   *   3. AND it does NOT contain `INSTAR_AUTH_TOKEN` (the env-first canary
   *      that proves the new resolver pattern is in place).
   *
   * Idempotent: re-running after the upgrade finds (3) violated, so it
   * skips silently.
   */
  private migrateSecretExternalizationSurvivability(result: MigrationResult): void {
    type Target = {
      relPath: string;
      templateDir: 'scripts' | 'hooks';
      templateFilename: string;
      shippedMarker: string;
      label: string;
    };
    const targets: Target[] = [
      {
        relPath: path.join(this.config.stateDir, 'scripts', 'imessage-reply.sh'),
        templateDir: 'scripts',
        templateFilename: 'imessage-reply.sh',
        // First-line shipped marker — present in every shipped version, so it
        // identifies our copies without touching custom forks.
        shippedMarker: '# imessage-reply.sh',
        label: 'scripts/imessage-reply.sh',
      },
      {
        relPath: path.join(this.config.stateDir, 'scripts', 'serendipity-capture.sh'),
        templateDir: 'scripts',
        templateFilename: 'serendipity-capture.sh',
        shippedMarker: 'serendipity-capture.sh',
        label: 'scripts/serendipity-capture.sh',
      },
      {
        relPath: path.join(this.config.projectDir, '.claude', 'hooks', 'instar', 'slack-channel-context.sh'),
        templateDir: 'hooks',
        templateFilename: 'slack-channel-context.sh',
        shippedMarker: 'slack-channel-context.sh',
        label: '.claude/hooks/instar/slack-channel-context.sh',
      },
    ];

    for (const target of targets) {
      if (!fs.existsSync(target.relPath)) continue;
      try {
        const existing = fs.readFileSync(target.relPath, 'utf-8');
        const looksShipped = existing.includes(target.shippedMarker);
        const hasAuthEnvHandling = existing.includes('INSTAR_AUTH_TOKEN');
        if (!looksShipped || hasAuthEnvHandling) {
          // Skip custom forks and already-current installs.
          continue;
        }
        const template = this.loadTemplate(target.templateDir, target.templateFilename);
        if (!template) {
          result.errors.push(`${target.label}: template file not found`);
          continue;
        }
        fs.writeFileSync(target.relPath, template, { mode: 0o755 });
        result.upgraded.push(`${target.label} (auth-env-first; secret-externalization survivability)`);
      } catch (err) {
        result.errors.push(`${target.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Ensure .claude/settings.json has required MCP servers and correct hook wiring.
   * Migrates legacy PostToolUse/Notification hooks to proper SessionStart type.
   */
  private migrateSettings(result: MigrationResult): void {
    // Framework gate (portability audit Gap 5). `.claude/settings.json` is
    // Claude Code's hook/MCP configuration — it has zero meaning for a
    // Codex-only runtime. Skip the entire step when claude-code is not in
    // the enabled set so a Codex-only install is not scaffolded with
    // `.claude/` artifacts it will never read. Default (unset config) is
    // ['claude-code'], so existing and dual-framework installs are
    // unaffected.
    if (!this.getEnabledFrameworks().includes('claude-code')) {
      result.skipped.push('.claude/settings.json (skipped — claude-code not in enabledFrameworks)');
      return;
    }
    const settingsPath = path.join(this.config.projectDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      result.skipped.push('.claude/settings.json (not found — will be created on next init)');
      return;
    }

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`settings.json read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;

    // Playwright MCP server — required for browser automation (Telegram setup, etc.)
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }
    const mcpServers = settings.mcpServers as Record<string, unknown>;
    if (!mcpServers.playwright) {
      mcpServers.playwright = {
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
      };
      patched = true;
      result.upgraded.push('.claude/settings.json: added Playwright MCP server');
    } else {
      result.skipped.push('.claude/settings.json: Playwright MCP already configured');
    }

    // Migrate hooks from legacy PostToolUse/Notification to proper SessionStart
    if (!settings.hooks) {
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown[]>;

    const sessionStartHook = {
      type: 'command',
      command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/session-start.sh',
      timeout: 5,
    };

    // Add SessionStart hooks if missing
    if (!hooks.SessionStart) {
      hooks.SessionStart = [
        { matcher: 'startup', hooks: [sessionStartHook] },
        { matcher: 'resume', hooks: [sessionStartHook] },
        { matcher: 'compact', hooks: [sessionStartHook] },
      ];
      patched = true;
      result.upgraded.push('.claude/settings.json: added SessionStart hooks (startup/resume/compact)');
    } else {
      // Migrate existing session-start paths from flat to instar/ subdirectory
      this.migrateSettingsHookPaths(hooks.SessionStart as unknown[], result);
    }

    // Add UserPromptSubmit hook for Telegram topic context injection
    if (!hooks.UserPromptSubmit) {
      hooks.UserPromptSubmit = [];
    }
    const userPromptSubmit = hooks.UserPromptSubmit as Array<{ matcher?: string; hooks?: unknown[] }>;
    const hasTelegramTopicContext = userPromptSubmit.some(e =>
      (e.hooks as Array<{ command?: string }> | undefined)?.some(h => h.command?.includes('telegram-topic-context')),
    );
    if (!hasTelegramTopicContext) {
      userPromptSubmit.push({
        matcher: '',
        hooks: [{
          type: 'command',
          command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/telegram-topic-context.sh',
          timeout: 5000,
        }],
      });
      patched = true;
      result.upgraded.push('.claude/settings.json: added UserPromptSubmit telegram-topic-context hook');
    }

    // Add PreToolUse MCP matcher for external operation gate
    if (!hooks.PreToolUse) {
      hooks.PreToolUse = [];
    }
    const preToolUse = hooks.PreToolUse as Array<{ matcher?: string; hooks?: unknown[] }>;
    // Migrate existing PreToolUse paths from flat to instar/ subdirectory
    this.migrateSettingsHookPaths(preToolUse as unknown[], result);
    const hasMcpMatcher = preToolUse.some(e => e.matcher === 'mcp__.*');
    if (!hasMcpMatcher) {
      preToolUse.push({
        matcher: 'mcp__.*',
        hooks: [{
          type: 'command',
          command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/external-operation-gate.js',
          blocking: true,
          timeout: 5000,
        }],
      });
      patched = true;
      result.upgraded.push('.claude/settings.json: added PreToolUse MCP matcher (external operation gate)');
    } else {
      result.skipped.push('.claude/settings.json: PreToolUse MCP matcher already present');
    }

    // Clean up legacy PostToolUse session-start (was noisy — fired every tool use)
    if (hooks.PostToolUse) {
      const postToolUse = hooks.PostToolUse as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const filtered = postToolUse.filter(e => {
        if (e.matcher === '' && e.hooks?.some(h => h.command?.includes('session-start.sh'))) {
          return false;
        }
        return true;
      });
      if (filtered.length !== postToolUse.length) {
        if (filtered.length === 0) {
          delete hooks.PostToolUse;
        } else {
          hooks.PostToolUse = filtered;
        }
        patched = true;
        result.upgraded.push('.claude/settings.json: removed legacy PostToolUse session-start hook');
      }
    }

    // Clean up legacy Notification compaction hook (now in SessionStart)
    if (hooks.Notification) {
      const notification = hooks.Notification as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const filtered = notification.filter(e => {
        if (e.matcher === 'compact' && e.hooks?.some(h => h.command?.includes('compaction-recovery.sh'))) {
          return false;
        }
        return true;
      });
      if (filtered.length !== notification.length) {
        if (filtered.length === 0) {
          delete hooks.Notification;
        } else {
          hooks.Notification = filtered;
        }
        patched = true;
        result.upgraded.push('.claude/settings.json: migrated compaction hook from Notification to SessionStart');
      }
    }

    // Ensure the canonical instar Bash PreToolUse hooks are present (dark-guardrail
    // migration gap, 2026-05-27). init.ts wires these for NEW agents; existing
    // agents previously only got slopcheck + the MCP gate ensured here, so
    // deferral-detector (the false-blocker pre-filter), grounding-before-messaging,
    // external-communication-guard, and post-action-reflection shipped to disk but
    // were never switched on. Both paths now share INSTAR_BASH_PRETOOLUSE_HOOKS so
    // they cannot drift again. Idempotent: appends only missing hooks, never
    // reorders/removes; safe to re-run. (slopcheck stays in its own block below.)
    {
      const added = ensureInstarBashPreToolUseHooks(preToolUse as SettingsMatcherEntry[]);
      if (added.length > 0) {
        patched = true;
        for (const fname of added) {
          result.upgraded.push(`.claude/settings.json: added PreToolUse ${fname} hook (dark-guardrail wiring)`);
        }
      }
    }

    // Ensure PreToolUse Bash slopcheck-guard hook exists (cherry-pick 2026-05-23).
    // Existing agents only get new Bash-matcher hooks through an explicit ensure
    // block here — there is no wholesale settings-template refresh on migration.
    {
      const bashEntry = preToolUse.find(e => e.matcher === 'Bash') as
        { matcher?: string; hooks?: Array<{ command?: string; type?: string; timeout?: number }> } | undefined;
      const hasSlopcheck = bashEntry?.hooks?.some(h => h.command?.includes('slopcheck-guard'));
      if (bashEntry && !hasSlopcheck) {
        bashEntry.hooks = bashEntry.hooks ?? [];
        bashEntry.hooks.push({
          type: 'command',
          command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/slopcheck-guard.js',
          timeout: 5000,
        });
        patched = true;
        result.upgraded.push('.claude/settings.json: added PreToolUse slopcheck-guard hook');
      } else if (!bashEntry) {
        // No Bash matcher at all — create one with just slopcheck (rare; most
        // agents already have a Bash matcher with dangerous-command-guard).
        preToolUse.push({
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/slopcheck-guard.js',
            timeout: 5000,
          }] as never,
        });
        patched = true;
        result.upgraded.push('.claude/settings.json: created PreToolUse Bash matcher with slopcheck-guard');
      }
    }

    // Ensure PostToolUse skill-usage-telemetry hook exists
    {
      const postToolUse = (hooks.PostToolUse || []) as Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      const hasSkillTelemetry = postToolUse.some(e =>
        e.matcher === 'Skill' && e.hooks?.some(h => h.command?.includes('skill-usage-telemetry'))
      );
      if (!hasSkillTelemetry) {
        postToolUse.push({
          matcher: 'Skill',
          hooks: [{
            type: 'command' as never,
            command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/skill-usage-telemetry.sh',
            timeout: 3000,
          } as never],
        });
        hooks.PostToolUse = postToolUse;
        patched = true;
        result.upgraded.push('.claude/settings.json: added PostToolUse skill-usage-telemetry hook');
      }
    }

    // Migrate all hook paths from flat layout to instar/ subdirectory
    if (hooks.PostToolUse) {
      this.migrateSettingsHookPaths(hooks.PostToolUse as unknown[], result);
      patched = true;
    }
    {
      const stopHooks = (hooks.Stop ?? []) as Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string; timeout?: number }> }>;
      const hasStopGateRouter = stopHooks.some(e =>
        e.hooks?.some(h => h.command?.includes('stop-gate-router.js')),
      );
      if (!hasStopGateRouter) {
        stopHooks.unshift({
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/stop-gate-router.js',
            timeout: 5000,
          }],
        });
        hooks.Stop = stopHooks;
        patched = true;
        result.upgraded.push('.claude/settings.json: added Stop stop-gate-router hook');
      }
    }
    if (hooks.Stop) {
      this.migrateSettingsHookPaths(hooks.Stop as unknown[], result);
      patched = true;
    }

    // Add INSTAR_SESSION_ID to HTTP hook URLs — enables subagent-aware zombie cleanup.
    // Without this, the server can't map Claude Code's session_id to the instar session,
    // and zombie cleanup may kill sessions that are waiting for subagent results.
    if (this.migrateHttpHookSessionId(hooks, result)) {
      patched = true;
    }

    // Replace HTTP hooks with command hooks. Claude Code HTTP hooks (type: "http")
    // silently fail to fire as of v2.1.78, which means claudeSessionId is never
    // populated and session resume falls back to unreliable mtime heuristic.
    // Command hooks reliably fire, so we use hook-event-reporter.js instead.
    if (this.migrateHttpHooksToCommandHooks(hooks, result)) {
      patched = true;
    }

    // Ensure event reporter hooks exist for observability events (session resume, telemetry).
    if (this.ensureHttpHooksExist(hooks, result)) {
      patched = true;
    }

    // Ensure PermissionRequest auto-approve hook exists — subagents don't inherit
    // --dangerously-skip-permissions, so they'd prompt without this catch-all.
    if (this.ensurePermissionAutoApprove(hooks, result)) {
      patched = true;
    }

    // Ensure autonomous stop hook is registered — structural enforcement for /autonomous mode.
    // Without this, autonomous sessions have no hook to block exit and feed tasks back,
    // so they just stop after each response. This was a critical gap where the hook files
    // existed but were never registered in settings.json.
    if (this.ensureAutonomousStopHook(hooks, result)) {
      patched = true;
    }

    if (patched) {
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      } catch (err) {
        result.errors.push(`settings.json write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Migrate the agent's config.json with sensible defaults for new features.
   * Only adds missing fields — never overwrites existing user customizations.
   */
  private migrateConfig(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('config.json (not found)');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`config.json read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let patched = false;

    // Auto-generate dashboardPin if missing — the dashboard should always be
    // accessible via PIN, not bearer token. Users don't need to know about tokens.
    if (!config.dashboardPin && config.authToken) {
      const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit PIN
      config.dashboardPin = pin;
      patched = true;
      result.upgraded.push(`config.json: generated dashboard PIN (${pin})`);
    } else if (config.dashboardPin) {
      result.skipped.push('config.json: dashboard PIN already set');
    }

    // Apply defaults from the canonical ConfigDefaults registry.
    // This single call replaces ALL individual migration blocks (externalOperations,
    // promptGate, threadline, etc.). Adding a new default to ConfigDefaults.ts
    // automatically applies it to existing agents on update.
    try {
      // Uses imported getMigrationDefaults and applyDefaults from ConfigDefaults.ts
      const agentType = (config.agentType as string) === 'standalone' ? 'standalone' : 'managed-project';
      const defaults = getMigrationDefaults(agentType as any);
      const { patched: defaultsPatched, changes, skipped } = applyDefaults(config, defaults);

      if (defaultsPatched) {
        patched = true;
        // Record migration version for audit trail
        const migrations = (config._instar_migrations ?? []) as string[];
        const version = 'unknown';
        migrations.push(`defaults-${version}-${new Date().toISOString()}`);
        config._instar_migrations = migrations;

        for (const change of changes) {
          result.upgraded.push(`config.json: ${change}`);
        }
      }
      for (const skip of skipped) {
        result.skipped.push(`config.json: ${skip}`);
      }
    } catch (err) {
      // Fallback: if ConfigDefaults import fails, log error but don't crash migration
      result.errors.push(`config.json defaults: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (patched) {
      try {
        // Atomic write: backup, then write to tmp, then rename
        const bak = configPath + '.bak';
        const tmp = configPath + '.tmp';
        fs.copyFileSync(configPath, bak);
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
        fs.renameSync(tmp, configPath);

        // Audit log
        try {
          const securityLogPath = path.join(this.config.stateDir, 'security.jsonl');
          const auditEntry = {
            event: 'config-migration',
            timestamp: new Date().toISOString(),
            version: 'unknown',
            changes: result.upgraded.filter(u => u.startsWith('config.json:')),
            source: 'PostUpdateMigrator',
          };
          fs.appendFileSync(securityLogPath, JSON.stringify(auditEntry) + '\n');
        } catch { /* audit log is best-effort */ }
      } catch (err) {
        result.errors.push(`config.json write: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Fix gitignore entries that shouldn't exclude shared state.
   * Removes relationships/ from gitignore so multi-machine agents share awareness.
   */
  /**
   * Generate self-knowledge tree for agents that don't have one.
   * Uses managed/unmanaged merge if one already exists.
   */
  /**
   * Canonical maxSessions migration — codex-instar audit Item 10.
   *
   * Older agent configs used a top-level `maxSessions` field; the current
   * canonical location is `sessions.maxSessions`. Some agents (echo as of
   * 2026-05-22) carry BOTH keys, with divergent values — the legacy key is
   * dead in code today (after audit Item 2's fallback chain reads canonical
   * first), but it's still cruft and still misleading to anyone reading the
   * file.
   *
   * Logic:
   *  - If only canonical key → no-op (skip).
   *  - If neither key → no-op (skip).
   *  - If only legacy key → copy to canonical, delete legacy.
   *  - If both → keep canonical, delete legacy (canonical wins; legacy is
   *    presumed stale because it was historically the only source).
   *
   * Idempotent: subsequent runs find no legacy key and skip.
   */
  private migrateLegacyMaxSessions(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('legacy maxSessions migration (config.json not found)');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`legacy maxSessions migration: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const hasLegacy = typeof config.maxSessions === 'number';
    const sessionsBlock = (config.sessions as Record<string, unknown> | undefined) ?? undefined;
    const hasCanonical = sessionsBlock !== undefined && typeof sessionsBlock.maxSessions === 'number';

    if (!hasLegacy) {
      result.skipped.push('legacy maxSessions migration (no legacy key present)');
      return;
    }

    const legacyValue = config.maxSessions as number;

    if (!hasCanonical) {
      // Only legacy key exists — promote to canonical.
      const newSessions: Record<string, unknown> = sessionsBlock
        ? { ...sessionsBlock, maxSessions: legacyValue }
        : { maxSessions: legacyValue };
      config.sessions = newSessions;
      delete config.maxSessions;
      result.upgraded.push(`config.json: promoted legacy maxSessions=${legacyValue} to sessions.maxSessions`);
    } else {
      // Both keys exist — keep canonical, delete legacy.
      const canonicalValue = (config.sessions as Record<string, unknown>).maxSessions as number;
      delete config.maxSessions;
      if (canonicalValue !== legacyValue) {
        result.upgraded.push(`config.json: removed stale legacy maxSessions=${legacyValue} (canonical sessions.maxSessions=${canonicalValue} retained)`);
      } else {
        result.upgraded.push(`config.json: removed duplicate legacy maxSessions=${legacyValue} (matched canonical)`);
      }
    }

    try {
      const bak = configPath + '.bak';
      const tmp = configPath + '.tmp';
      fs.copyFileSync(configPath, bak);
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
      fs.renameSync(tmp, configPath);

      try {
        const securityLogPath = path.join(this.config.stateDir, 'security.jsonl');
        const auditEntry = {
          event: 'config-migration-legacy-maxsessions',
          timestamp: new Date().toISOString(),
          changes: result.upgraded.filter(u => u.includes('legacy maxSessions') || u.includes('canonical sessions.maxSessions')),
          source: 'PostUpdateMigrator.migrateLegacyMaxSessions',
        };
        fs.appendFileSync(securityLogPath, JSON.stringify(auditEntry) + '\n');
      } catch { /* audit log is best-effort */ }
    } catch (err) {
      result.errors.push(`legacy maxSessions migration write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Retire `mentor.dailySpendCapUsd` — a config field that was DECORATIVE (read nowhere
   * in code; spec MENTOR-LIVE-READINESS §Migration parity called it out as the
   * silent-dead-config bug we shouldn't repeat at migration time). On a Claude
   * subscription there's no per-token dollar charge to cap; the real budget is quota-
   * aware (a separate future PR ships `mentor.stageBTokenCeiling`).
   *
   * Behavior:
   *  - field absent → silent skip
   *  - field present at the default (0.5) → silent delete (no warning)
   *  - field present at a NON-default value → delete + LOUD `result.upgraded` entry with
   *    a REVIEW prefix (operator never set this thinking it was enforced; they deserve
   *    to know). Don't repeat the original silent-dead-config bug at migration time.
   * Idempotent via the `_instar_migrations` marker.
   */
  private migrateRetireDeadMentorConfig(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('mentor dailySpendCapUsd retirement (config.json not found)');
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`mentor dailySpendCapUsd retirement: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const migrations = (config._instar_migrations ?? []) as string[];
    const marker = 'mentor-dailySpendCapUsd-retire-v1';
    if (migrations.some(m => m.startsWith(marker))) {
      result.skipped.push('mentor dailySpendCapUsd retirement (already migrated)');
      return;
    }

    const mentor = (config.mentor as Record<string, unknown> | undefined) ?? undefined;
    if (!mentor || !('dailySpendCapUsd' in mentor)) {
      // Field never present — mark + skip.
      migrations.push(`${marker}-${new Date().toISOString()}`);
      config._instar_migrations = migrations;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      result.skipped.push('mentor dailySpendCapUsd retirement (field never present)');
      return;
    }

    const value = mentor.dailySpendCapUsd;
    const isDefault = value === 0.5;
    delete mentor.dailySpendCapUsd;
    config.mentor = mentor;
    migrations.push(`${marker}-${new Date().toISOString()}`);
    config._instar_migrations = migrations;
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      if (isDefault) {
        result.upgraded.push('mentor.dailySpendCapUsd retired (was default 0.5; field was decorative — never read)');
      } else {
        // LOUD prefix so the operator notices in post-update output (this is the
        // "non-silent removal" the spec specifically calls for).
        result.upgraded.push(
          `REVIEW: mentor.dailySpendCapUsd=${JSON.stringify(value)} was retired. ` +
          `The field was decorative (never enforced) — Echo runs on a Claude subscription, ` +
          `so there is no per-token dollar charge to cap. A future update introduces ` +
          `mentor.stageBTokenCeiling (quota-aware) as the real replacement. ` +
          `If you set this value expecting enforcement, adjust your expectations accordingly.`
        );
      }
    } catch (err) {
      result.errors.push(`mentor dailySpendCapUsd retirement write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Retire the legacy `{stateDir}/mentor-outbox/` directory — the file-based mentor
   * delivery design that Justin's substrate correction replaced (spec MENTOR-LIVE-
   * READINESS §Migration parity). The new mentor delivery goes through the agent-to-
   * agent Telegram comms primitive (sendAgentMessage); the outbox files are now dead
   * state and should be swept so they don't accumulate or mislead a future operator.
   *
   * Idempotent via the `_instar_migrations` marker. The first run deletes if present;
   * subsequent runs are no-ops. Best-effort — a removal failure logs + continues.
   */
  private migrateRetireMentorOutbox(result: MigrationResult): void {
    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      // Still try to retire the outbox if present, even without config.json — but mark
      // via state-file marker since we can't write to config. Simpler: skip entirely.
      result.skipped.push('mentor outbox retirement (config.json not found)');
      return;
    }
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`mentor outbox retirement: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const migrations = (config._instar_migrations ?? []) as string[];
    const marker = 'mentor-outbox-retire-v1';
    if (migrations.some(m => m.startsWith(marker))) {
      result.skipped.push('mentor outbox retirement (already migrated)');
      return;
    }

    const outboxDir = path.join(this.config.stateDir, 'mentor-outbox');
    let removed = false;
    let filesRemoved = 0;
    if (fs.existsSync(outboxDir)) {
      try {
        // Count files before removing for the audit entry.
        try {
          filesRemoved = fs.readdirSync(outboxDir).length;
        } catch { /* ignore, just for the audit */ }
        SafeFsExecutor.safeRmSync(outboxDir, { recursive: true, force: true, operation: 'migrateRetireMentorOutbox' });
        removed = true;
      } catch (err) {
        result.errors.push(`mentor outbox retirement removeSync failed: ${err instanceof Error ? err.message : String(err)}`);
        // Don't mark migrated on failure — retry on next run.
        return;
      }
    }

    migrations.push(`${marker}-${new Date().toISOString()}`);
    config._instar_migrations = migrations;
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      if (removed) {
        result.upgraded.push(`mentor-outbox directory retired (removed ${filesRemoved} file(s) — legacy file-based mentor delivery; replaced by the agent-to-agent Telegram comms primitive)`);
      } else {
        result.skipped.push('mentor outbox retirement (directory not present; marker set so we don\'t re-check)');
      }
    } catch (err) {
      result.errors.push(`mentor outbox retirement marker write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private migrateSelfKnowledgeTree(result: MigrationResult): void {
    const treeFilePath = path.join(this.config.stateDir, 'self-knowledge-tree.json');

    try {
      const generator = new TreeGenerator();

      if (fs.existsSync(treeFilePath)) {
        // Tree exists — regenerate managed nodes only (preserves unmanaged)
        const config = generator.generate({
          projectDir: this.config.projectDir,
          stateDir: this.config.stateDir,
          agentName: this.config.projectName || path.basename(this.config.projectDir),
          hasMemory: true,
          hasJobs: true,
          hasDecisionJournal: true,
        });
        generator.save(config, this.config.stateDir);
        result.upgraded.push('self-knowledge tree: refreshed managed nodes');
      } else {
        // No tree — generate from scratch
        const config = generator.generate({
          projectDir: this.config.projectDir,
          stateDir: this.config.stateDir,
          agentName: this.config.projectName || path.basename(this.config.projectDir),
          hasMemory: true,
          hasJobs: true,
          hasDecisionJournal: true,
        });
        generator.save(config, this.config.stateDir);
        const totalNodes = config.layers.reduce((sum: number, l: { children: unknown[] }) => sum + l.children.length, 0);
        result.upgraded.push(`self-knowledge tree: created (${config.layers.length} layers, ${totalNodes} nodes)`);
      }
    } catch (err) {
      result.errors.push(`self-knowledge tree: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private migrateGitignore(result: MigrationResult): void {
    // Fix project-level .gitignore
    const projectGitignore = path.join(this.config.projectDir, '.gitignore');
    this.removeGitignoreEntry(projectGitignore, '.instar/relationships/', result, 'project .gitignore');

    // Fix .instar-level .gitignore (GitStateManager's internal git tracking)
    const instarGitignore = path.join(this.config.stateDir, '.gitignore');
    this.removeGitignoreEntry(instarGitignore, 'relationships/', result, '.instar/.gitignore');

    // PR-REVIEW-HARDENING Phase A: ensure .instar/secrets/pr-gate/ is excluded
    // from the project repo. The BackupManager.BLOCKED_PATH_PREFIXES guard
    // (commit 1) defends the backup path; this entry defends the plain
    // `git add .` path so contributors can't accidentally commit pr-gate
    // secrets from the project directory.
    this.addGitignoreEntry(projectGitignore, '.instar/secrets/pr-gate/', result, 'project .gitignore');
  }

  /**
   * PR-REVIEW-HARDENING Phase A — ensure pr-gate state paths are backed up.
   *
   * Uses the `config.backup.includeFiles` plumbing shipped in commit 2
   * (see src/core/BackupManager.ts + src/config/ConfigDefaults.ts). The
   * BackupManager's constructor unions these entries with
   * DEFAULT_CONFIG.includeFiles at snapshot time — this migrator just
   * persists the extra entries into the user's config.json so they
   * survive process restarts and git-sync.
   *
   * Paths added to `config.backup.includeFiles`:
   *   - .instar/state/pr-pipeline.jsonl*       (pipeline event log + rotations)
   *   - .instar/state/pr-gate/phase-a-sha.json (grandfathering-boundary SHA)
   *   - .instar/state/pr-debounce.jsonl        (PR-wave debounce window)
   *   - .instar/state/pr-debounce-archive.jsonl
   *   - .instar/state/pr-cost-ledger.jsonl     (daily cost accounting)
   *   - .instar/state/security.jsonl*          (auth + revocation events)
   *
   * Set-union semantics preserve user-added entries. Idempotent on
   * re-run. Atomic write (temp → fsync → rename).
   *
   * Safety assertion: no entry under .instar/secrets/ is ever allowed
   * into the merged list. BackupManager.BLOCKED_PATH_PREFIXES (commit 1)
   * is the authoritative enforcement; this migrator-level assertion is
   * defense-in-depth and logs a warning if violated.
   */
  private migrateBackupManifest(result: MigrationResult): void {
    const PR_GATE_BACKUP_ENTRIES = [
      '.instar/state/pr-pipeline.jsonl*',
      '.instar/state/pr-gate/phase-a-sha.json',
      '.instar/state/pr-debounce.jsonl',
      '.instar/state/pr-debounce-archive.jsonl',
      '.instar/state/pr-cost-ledger.jsonl',
      '.instar/state/security.jsonl*',
    ];

    const configPath = path.join(this.config.stateDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      result.skipped.push('config.backup.includeFiles (config.json not found)');
      return;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      result.errors.push(`migrateBackupManifest read: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const backup = (config.backup ?? {}) as { includeFiles?: unknown };
    const existing = Array.isArray(backup.includeFiles)
      ? (backup.includeFiles as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];

    const merged = Array.from(new Set<string>([...existing, ...PR_GATE_BACKUP_ENTRIES]));

    for (const entry of merged) {
      if (path.normalize(entry).startsWith('.instar/secrets/')) {
        result.errors.push(
          `migrateBackupManifest: includeFiles contains secrets-prefix entry "${entry}" — BackupManager will refuse it at snapshot time, but the entry should not be here`,
        );
      }
    }

    const added = merged.filter((e) => !existing.includes(e));
    if (added.length === 0) {
      result.skipped.push('config.backup.includeFiles (already up to date)');
      return;
    }

    const nextConfig = { ...config, backup: { ...backup, includeFiles: merged } };

    try {
      const tmpPath = `${configPath}.migrate-backup-${process.pid}-${Date.now()}.tmp`;
      const serialized = JSON.stringify(nextConfig, null, 2) + '\n';
      const fd = fs.openSync(tmpPath, 'w', 0o600);
      try {
        fs.writeSync(fd, serialized);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, configPath);
      result.upgraded.push(
        `config.backup.includeFiles: added ${added.length} pr-gate state path(s)`,
      );
    } catch (err) {
      result.errors.push(`migrateBackupManifest write: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * PR-REVIEW-HARDENING Phase A — ship pr-gate pipeline artifacts.
   *
   * Writes four shipped files:
   *   - scripts/pr-gate/eligibility-schema.sql   (all agents)
   *   - .claude/skills/fork-and-fix/scripts/push-gate.sh  (all agents, 0755)
   *   - .github/workflows/instar-pr-gate.yml     (instar source repo only)
   *   - docs/pr-gate-setup.md                    (instar source repo only)
   *
   * Each write is gated by sha256(content) === expectedHash. A tamperer
   * who modifies the content string in the published JS without also
   * updating the hash constant trips this assertion; migration aborts
   * for that file and logs a critical error.
   *
   * Idempotent: files whose on-disk content already matches the shipped
   * content are skipped (no rewrite).
   *
   * Phase A landing: endpoints are inert (prGate.phase='off') so these
   * artifacts have no runtime consumer yet. Later phases activate them.
   */
  private migratePrPipelineArtifacts(result: MigrationResult): void {
    // Schema — always shipped. Primary (gate-serving) agents instantiate
    // the SQLite file from this schema in later phases.
    this.writeShippedArtifact({
      destPath: path.join(this.config.projectDir, 'scripts', 'pr-gate', 'eligibility-schema.sql'),
      content: ELIGIBILITY_SCHEMA_SQL,
      expectedSha256: ELIGIBILITY_SCHEMA_SQL_SHA256,
      label: 'scripts/pr-gate/eligibility-schema.sql',
      result,
    });

    // Push-gate — always shipped to every agent. Fork-and-fix skill
    // sources it from here during push. Mode 0o755 so it's executable.
    this.writeShippedArtifact({
      destPath: path.join(
        this.config.projectDir, '.claude', 'skills', 'fork-and-fix', 'scripts', 'push-gate.sh',
      ),
      content: PUSH_GATE_SH,
      expectedSha256: PUSH_GATE_SH_SHA256,
      label: '.claude/skills/fork-and-fix/scripts/push-gate.sh',
      mode: 0o755,
      result,
    });

    // .github/workflows and docs/pr-gate-setup are instar-source-only.
    // Non-instar-source agents don't gain a workflow file for a gate
    // they neither host nor are gated by.
    if (!this.isInstarSourceRepo()) {
      return;
    }

    this.writeShippedArtifact({
      destPath: path.join(this.config.projectDir, '.github', 'workflows', 'instar-pr-gate.yml'),
      content: INSTAR_PR_GATE_WORKFLOW_YML,
      expectedSha256: INSTAR_PR_GATE_WORKFLOW_YML_SHA256,
      label: '.github/workflows/instar-pr-gate.yml',
      result,
    });

    this.writeShippedArtifact({
      destPath: path.join(this.config.projectDir, 'docs', 'pr-gate-setup.md'),
      content: PR_GATE_SETUP_MD,
      expectedSha256: PR_GATE_SETUP_MD_SHA256,
      label: 'docs/pr-gate-setup.md',
      result,
    });
  }

  /**
   * Write a shipped artifact with content-hash verification. Idempotent:
   * skips write if on-disk content already matches. Aborts with a logged
   * error if sha256(content) !== expectedSha256 (detects post-publish
   * tamper of one side without the other).
   */
  private writeShippedArtifact(opts: {
    destPath: string;
    content: string;
    expectedSha256: string;
    label: string;
    mode?: number;
    result: MigrationResult;
  }): void {
    const actual = crypto.createHash('sha256').update(opts.content).digest('hex');
    if (actual !== opts.expectedSha256) {
      const msg = `${opts.label}: shipped content hash mismatch — expected ${opts.expectedSha256}, got ${actual}. Migration aborted for this file.`;
      opts.result.errors.push(msg);
      console.error(`[PR-GATE CRITICAL] ${msg}`);
      return;
    }

    try {
      if (fs.existsSync(opts.destPath)) {
        const existing = fs.readFileSync(opts.destPath, 'utf-8');
        if (existing === opts.content) {
          opts.result.skipped.push(`${opts.label} (already up to date)`);
          return;
        }
      }

      fs.mkdirSync(path.dirname(opts.destPath), { recursive: true });
      const writeOpts = opts.mode !== undefined ? { mode: opts.mode } : undefined;
      fs.writeFileSync(opts.destPath, opts.content, writeOpts);
      opts.result.upgraded.push(opts.label);
    } catch (err) {
      opts.result.errors.push(`${opts.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Detect whether this agent lives in the JKHeadley/instar source repo.
   * Two-signal check: normalized `git remote get-url origin` (or upstream
   * if origin is a fork) points at github.com/JKHeadley/instar, AND
   * package.json.name === 'instar'. Both must match — the package-name
   * check prevents writing the workflow to a fork that happens to have
   * a different package name.
   *
   * Silent false on any error (no git, no package.json, parse failure):
   * non-instar agents should NOT have workflow/docs files dropped on them.
   */
  private isInstarSourceRepo(): boolean {
    const remoteIsInstar = (remote: string): boolean => {
      const normalized = remote
        .trim()
        .replace(/^https:\/\//, '')
        .replace(/^http:\/\//, '')
        .replace(/^git@/, '')
        .replace(/\.git$/, '')
        .replace(':', '/')
        .toLowerCase();
      return /^github\.com\/jkheadley\/instar(\/|$)/.test(normalized);
    };

    const getRemote = (name: string): string | null => {
      try {
        return SafeGitExecutor.readSync(['remote', 'get-url', name], {
          cwd: this.config.projectDir,
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf-8',
          operation: 'src/core/PostUpdateMigrator.ts:getRemote',
        });
      } catch {
        return null;
      }
    };

    const origin = getRemote('origin');
    const upstream = getRemote('upstream');
    const remoteOk =
      (origin !== null && remoteIsInstar(origin)) ||
      (upstream !== null && remoteIsInstar(upstream));
    if (!remoteOk) return false;

    try {
      const pkgPath = path.join(this.config.projectDir, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
      return pkg.name === 'instar';
    } catch {
      return false;
    }
  }

  /**
   * Idempotently add a .gitignore entry. No-op if the entry is already
   * present as an active (non-comment, non-blank) line. Creates the file
   * if it doesn't exist. A comment line that happens to contain the entry
   * text is NOT treated as present — only exact-match active lines count.
   */
  private addGitignoreEntry(gitignorePath: string, entry: string, result: MigrationResult, label: string): void {
    try {
      let content = '';
      if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf-8');
      }

      const alreadyPresent = content.split('\n').some((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) return false;
        return trimmed === entry;
      });
      if (alreadyPresent) return;

      let nextContent = content;
      if (nextContent.length > 0 && !nextContent.endsWith('\n')) {
        nextContent += '\n';
      }
      nextContent += entry + '\n';

      const dir = path.dirname(gitignorePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(gitignorePath, nextContent);
      result.upgraded.push(`${label}: added ${entry}`);
    } catch (err) {
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removeGitignoreEntry(gitignorePath: string, entry: string, result: MigrationResult, label: string): void {
    if (!fs.existsSync(gitignorePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (!content.includes(entry)) {
        return;
      }

      // Remove the entry and any associated comment line above it
      const lines = content.split('\n');
      const filtered = lines.filter((line, i) => {
        if (line.trim() === entry) return false;
        // Remove comment line directly above the entry if it mentions "relationships" or "PII" or "Privacy"
        if (i < lines.length - 1 && lines[i + 1]?.trim() === entry &&
            line.startsWith('#') && /relationship|PII|Privacy/i.test(line)) {
          return false;
        }
        return true;
      });

      // Clean up double blank lines left behind
      const cleaned = filtered.join('\n').replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(gitignorePath, cleaned);
      result.upgraded.push(`${label}: un-ignored ${entry} (shared state for multi-machine)`);
    } catch (err) {
      result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Opt-in soul.md migration for existing agents.
   * Does NOT auto-create soul.md — adds config flag and queues notification.
   */
  private migrateSoulMd(result: MigrationResult): void {
    const soulPath = path.join(this.config.stateDir, 'soul.md');
    const configPath = path.join(this.config.stateDir, 'config.json');

    // Skip if soul.md already exists
    if (fs.existsSync(soulPath)) {
      return;
    }

    // Add identity.soulEnabled flag to config if not present
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.identity?.soulEnabled === undefined) {
          config.identity = config.identity || {};
          config.identity.soulEnabled = false;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          result.upgraded.push('config: added identity.soulEnabled flag (opt-in, default false)');
        }
      }
    } catch (err) {
      result.errors.push(`soul.md config migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Add Self-Observations and Identity History sections to existing AGENT.md.
   */
  private migrateAgentMdSections(result: MigrationResult): void {
    const agentMdPath = path.join(this.config.stateDir, 'AGENT.md');
    if (!fs.existsSync(agentMdPath)) return;

    try {
      let content = fs.readFileSync(agentMdPath, 'utf-8');
      let modified = false;

      if (!content.includes('## Self-Observations')) {
        // Add before ## Growth if it exists, otherwise append
        const growthIdx = content.indexOf('## Growth');
        if (growthIdx !== -1) {
          content = content.substring(0, growthIdx)
            + '## Self-Observations\n\n_Behavioral patterns I\'ve noticed in myself. Strengths, weaknesses, tendencies._\n\n<!-- Populated as the agent observes their own patterns across sessions. -->\n\n'
            + content.substring(growthIdx);
        } else {
          content += '\n\n## Self-Observations\n\n_Behavioral patterns I\'ve noticed in myself. Strengths, weaknesses, tendencies._\n\n<!-- Populated as the agent observes their own patterns across sessions. -->\n';
        }
        modified = true;
      }

      if (!content.includes('## Identity History')) {
        content += '\n\n## Identity History\n\n_When and why I changed this file._\n\n| Date | Change |\n|------|--------|\n<!-- Updated when the agent modifies their own identity. -->\n';
        modified = true;
      }

      if (modified) {
        fs.writeFileSync(agentMdPath, content);
        result.upgraded.push('AGENT.md: added Self-Observations and Identity History sections');
      }
    } catch (err) {
      result.errors.push(`AGENT.md migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Hook Templates ─────────────────────────────────────────────────

  /**
   * Get the content of a named hook template.
   * Used by init.ts to share canonical hook content without duplication.
   */
  getHookContent(name: 'session-start' | 'compaction-recovery' | 'external-operation-gate' | 'deferral-detector' | 'slopcheck-guard' | 'post-action-reflection' | 'external-communication-guard' | 'scope-coherence-collector' | 'scope-coherence-checkpoint' | 'claim-intercept' | 'claim-intercept-response' | 'telegram-topic-context' | 'response-review' | 'stop-gate-router' | 'auto-approve-permissions' | 'skill-usage-telemetry' | 'build-stop-hook'): string {
    switch (name) {
      case 'session-start': return this.getSessionStartHook();
      case 'compaction-recovery': return this.getCompactionRecovery();
      case 'external-operation-gate': return this.getExternalOperationGateHook();
      case 'deferral-detector': return this.getDeferralDetectorHook();
      case 'slopcheck-guard': return this.getSlopcheckGuardHook();
      case 'post-action-reflection': return this.getPostActionReflectionHook();
      case 'external-communication-guard': return this.getExternalCommunicationGuardHook();
      case 'scope-coherence-collector': return this.getScopeCoherenceCollectorHook();
      case 'scope-coherence-checkpoint': return this.getScopeCoherenceCheckpointHook();
      case 'claim-intercept': return this.getClaimInterceptHook();
      case 'claim-intercept-response': return this.getClaimInterceptResponseHook();
      case 'telegram-topic-context': return this.getTelegramTopicContextHook();
      case 'response-review': return this.getResponseReviewHook();
      case 'stop-gate-router': return this.getStopGateRouterHook();
      case 'auto-approve-permissions': return this.getAutoApprovePermissionsHook();
      case 'skill-usage-telemetry': return this.getSkillUsageTelemetryHook();
      case 'build-stop-hook': return this.getBuildStopHook();
    }
  }

  /** Public accessor for grounding-before-messaging hook content (used by init.ts) */
  getGroundingBeforeMessagingPublic(): string {
    return this.getGroundingBeforeMessaging();
  }

  /** Public accessor for convergence-check script content (used by init.ts) */
  getConvergenceCheckPublic(): string {
    return this.getConvergenceCheck();
  }

  private getSessionStartHook(): string {
    return `#!/bin/bash
# Session start hook — injects identity context on session lifecycle events.
# Fires on: startup, resume, clear, compact (via SessionStart hook type)
#
# On startup/resume: outputs a compact identity summary
# On compact: delegates to compaction-recovery.sh for full injection
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
EVENT="\${CLAUDE_HOOK_MATCHER:-startup}"

# On compaction, delegate to the dedicated recovery hook
if [ "\$EVENT" = "compact" ]; then
  if [ -x "$INSTAR_DIR/hooks/compaction-recovery.sh" ]; then
    exec bash "$INSTAR_DIR/hooks/compaction-recovery.sh"
  fi
fi

# For startup/resume/clear — output a compact orientation
echo "=== SESSION START ==="

# Current wall-clock time — addresses Claude Code's "harness injects date, not
# time of day" blind spot. Without this, agents say things like "it's 2am" when
# it's actually 5:45am because they carry stale clock context from session
# history. Always fired, always fresh.
NOW=\$(date +'%Y-%m-%d %H:%M:%S %z (%Z)' 2>/dev/null)
if [ -n "\$NOW" ]; then
  echo ""
  echo "--- CURRENT TIME ---"
  echo "\$NOW"
  echo "Wall-clock at hook fire. Quote this — do not carry stale clock times from prior context."
  echo "--- END CURRENT TIME ---"
fi

# TOPIC CONTEXT (loaded FIRST — highest priority context)
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="$INSTAR_DIR/config.json"
  if [ -f "\$CONFIG_FILE" ]; then
    PORT=\$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "\$CONFIG_FILE" | head -1 | grep -oE '[0-9]+' | head -1)
    if [ -n "\$PORT" ]; then
      TOPIC_CTX=\$(curl -s "http://localhost:\${PORT}/topic/context/\${TOPIC_ID}?recent=30" 2>/dev/null)
      if [ -n "\$TOPIC_CTX" ] && echo "\$TOPIC_CTX" | grep -q '"totalMessages"'; then
        TOTAL=\$(echo "\$TOPIC_CTX" | grep -o '"totalMessages":[0-9]*' | cut -d':' -f2)
        TOPIC_NAME=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('topicName') or 'Unknown')" 2>/dev/null || echo "Unknown")
        echo ""
        echo "--- CONVERSATION CONTEXT (Topic: \${TOPIC_NAME}, \${TOTAL} total messages) ---"
        echo ""
        SUMMARY=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('summary'); print(s if s else '')" 2>/dev/null)
        if [ -n "\$SUMMARY" ]; then
          echo "SUMMARY OF CONVERSATION SO FAR:"
          echo "\$SUMMARY"
          echo ""
        fi
        echo "RECENT MESSAGES:"
        echo "\$TOPIC_CTX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for m in d.get('recentMessages', []):
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = m.get('timestamp', '')[:16].replace('T', ' ')
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:\${PORT}/topic/search?topic=\${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# INTEGRATED-BEING LEDGER — cross-session observations (see docs/specs/integrated-being-ledger-v1.md)
# Fetches /shared-state/render and injects it if non-empty. Silent on absence /
# auth failure — endpoint returns 503 when disabled, empty body when enabled
# but has no entries. Either way we only echo when content is present.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\${PORT:-\$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)}
  # Env first (set by SessionManager per-session) — survives secret-externalization.
  # Fallback grep: matches only a plaintext-string authToken. After externalization,
  # the value is the literal { "secret": true } placeholder which has no "..." form,
  # so the grep yields empty — we never send a bogus Bearer token.
  TOKEN="\${INSTAR_AUTH_TOKEN:-\$(grep -o '"authToken":"[^"]*"' "$INSTAR_DIR/config.json" | head -1 | sed 's/"authToken":"//;s/"$//')}"
  if [ -n "\$PORT" ] && [ -n "\$TOKEN" ]; then
    SHARED_STATE=\$(curl -sf -H "Authorization: Bearer \$TOKEN" "http://localhost:\${PORT}/shared-state/render?limit=50" 2>/dev/null)
    if [ -n "\$SHARED_STATE" ]; then
      echo ""
      echo "--- INTEGRATED-BEING (cross-session observations) ---"
      echo "\$SHARED_STATE"
      echo "--- END INTEGRATED-BEING ---"
      echo ""
    fi
  fi
fi

# ORG-INTENT injection — Phase 2 of the ORG-INTENT runtime project.
# Fetches the parsed three-rule contract (constraints / goals / values /
# tradeoff hierarchy) from /intent/org/session-context and injects it at
# session-start so the agent reasons with the organizational intent from
# message one. The Coherence Gate (Phase 1) still enforces the same contract
# at outbound-message review time — this just brings the same intent into the
# agent's working context up front. Fail-open: route unreachable / absent
# ORG-INTENT.md / 503 → silent skip, session continues normally.
if [ -n "\$PORT" ] && [ -n "\$TOKEN" ]; then
  ORG_INTENT_RESPONSE=\$(curl -sf --max-time 4 -H "Authorization: Bearer \$TOKEN" \\
    "http://localhost:\${PORT}/intent/org/session-context" 2>/dev/null)
  if [ -n "\$ORG_INTENT_RESPONSE" ]; then
    ORG_INTENT_BLOCK=\$(echo "\$ORG_INTENT_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "\$ORG_INTENT_BLOCK" ]; then
      echo ""
      echo "\$ORG_INTENT_BLOCK"
      echo ""
    fi
  fi
fi

# AUTO-LEARNED PREFERENCES injection — Correction & Preference Learning Sentinel
# (Slice 1a). Fetches /preferences/session-context and injects the structured
# block of preferences the correction loop has learned about this user, so the
# agent reasons with them from message one. SIGNAL-ONLY — these are preferences,
# not authoritative instructions; the server wraps them in an
# <auto-learned-preference src='correction-loop'> envelope so they cannot be
# mistaken for commands. Fail-open: route 503 (feature off) / unreachable /
# empty block → silent skip, session continues normally.
if [ -n "\$PORT" ] && [ -n "\$TOKEN" ]; then
  PREFS_RESPONSE=\$(curl -sf --max-time 4 -H "Authorization: Bearer \$TOKEN" \\
    "http://localhost:\${PORT}/preferences/session-context" 2>/dev/null)
  if [ -n "\$PREFS_RESPONSE" ]; then
    PREFS_BLOCK=\$(echo "\$PREFS_RESPONSE" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if d.get('present') and d.get('block'):
        print(d['block'])
except Exception:
    pass
" 2>/dev/null)
    if [ -n "\$PREFS_BLOCK" ]; then
      echo ""
      echo "\$PREFS_BLOCK"
      echo ""
    fi
  fi
fi

# BEGIN integrated-being-v2
# INTEGRATED-BEING V2 — session-write binding (see docs/specs/integrated-being-ledger-v2.md §3)
# Generates a session UUID, registers with /shared-state/session-bind, writes the
# token file with mode 0o600 + atomic rename, writes .ready marker, confirms via
# session-bind-confirm. Silent on 503 (v2Enabled=false) — v1 behavior preserved.
# Section bounded by markers for inject-mode migration to re-update in place.
if [ -f "$INSTAR_DIR/config.json" ] && [ -n "\$PORT" ] && [ -n "\$TOKEN" ]; then
  SID=\$(python3 -c "import uuid; print(str(uuid.uuid4()))" 2>/dev/null)
  if [ -n "\$SID" ]; then
    BIND_RESP=\$(curl -sf -X POST -H "Authorization: Bearer \$TOKEN" -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"\$SID\\"}" \\
      "http://localhost:\${PORT}/shared-state/session-bind" 2>/dev/null)
    if [ -n "\$BIND_RESP" ] && echo "\$BIND_RESP" | grep -q '"token"'; then
      LEDGER_TOKEN=\$(echo "\$BIND_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
      if [ -n "\$LEDGER_TOKEN" ]; then
        BIND_DIR="$INSTAR_DIR/session-binding"
        # Create dir under umask 077 to avoid a mode-race window where
        # a concurrent process could stat/listdir before chmod lands.
        ( umask 077; mkdir -p "\$BIND_DIR" )
        chmod 0700 "\$BIND_DIR" 2>/dev/null
        TOK_FILE="\$BIND_DIR/\${SID}.token"
        TMP_FILE="\${TOK_FILE}.tmp.\$\$"
        # Atomic write: umask-safe 0o600 mode, explicit chmod, fsync, rename.
        ( umask 077; printf '%s' "\$LEDGER_TOKEN" > "\$TMP_FILE" )
        chmod 0600 "\$TMP_FILE" 2>/dev/null
        python3 -c "import os,sys; fd=os.open('\$TMP_FILE', os.O_RDONLY); os.fsync(fd); os.close(fd)" 2>/dev/null
        mv "\$TMP_FILE" "\$TOK_FILE"
        chmod 0600 "\$TOK_FILE" 2>/dev/null
        # Mode verification — fail-CLOSED on anything other than 0600.
        MODE=\$(python3 -c "import os,stat; print(oct(stat.S_IMODE(os.stat('\$TOK_FILE').st_mode))[-4:])" 2>/dev/null)
        if [ "\$MODE" = "0600" ]; then
          touch "\$BIND_DIR/\${SID}.ready"
          chmod 0600 "\$BIND_DIR/\${SID}.ready" 2>/dev/null
          curl -sf -X POST -H "Authorization: Bearer \$TOKEN" -H "Content-Type: application/json" \\
            -d "{\\"sessionId\\":\\"\$SID\\"}" \\
            "http://localhost:\${PORT}/shared-state/session-bind-confirm" -o /dev/null 2>/dev/null || true
          export INSTAR_LEDGER_SESSION_ID="\$SID"
          export INSTAR_LEDGER_TOKEN_PATH="\$TOK_FILE"
        else
          # Mode mismatch → deny for this session's lifetime, clean up evidence.
          echo "[integrated-being-v2] token file mode \$MODE != 0600; denying session-write for this session" >&2
          rm -f "\$TOK_FILE"
        fi
      fi
    fi
  fi
fi
# END integrated-being-v2

# Identity summary (first 20 lines of AGENT.md — enough for name + role)
if [ -f "$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  AGENT_NAME=\$(head -1 "$INSTAR_DIR/AGENT.md" | sed 's/^# //')
  echo "Identity: \$AGENT_NAME"
  # Output personality and principles sections
  sed -n '/^## Personality/,/^## [^P]/p' "$INSTAR_DIR/AGENT.md" 2>/dev/null | head -10
fi

# PROJECT MAP — spatial awareness of the working environment
if [ -f "$INSTAR_DIR/project-map.json" ]; then
  echo ""
  echo "--- PROJECT CONTEXT ---"
  python3 -c "
import json, sys
try:
    m = json.load(open('$INSTAR_DIR/project-map.json'))
    print(f'Project: {m[\"projectName\"]} ({m[\"projectType\"]})')
    print(f'Path: {m[\"projectDir\"]}')
    r = m.get('gitRemote')
    b = m.get('gitBranch')
    if r: print(f'Git: {r}' + (f' [{b}]' if b else ''))
    t = m.get('deploymentTargets', [])
    if t: print(f'Deploy targets: {(\", \").join(t)}')
    d = m.get('directories', [])
    print(f'Files: {m[\"totalFiles\"]} across {len(d)} directories')
    for dd in d[:6]:
        print(f'  {dd[\"name\"]}/ ({dd[\"fileCount\"]}) — {dd[\"description\"]}')
    if len(d) > 6: print(f'  ... and {len(d) - 6} more')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
fi

# COHERENCE SCOPE — before ANY high-risk action, verify alignment
if [ -f "$INSTAR_DIR/config.json" ]; then
  echo ""
  echo "--- COHERENCE SCOPE ---"
  echo "BEFORE deploying, pushing, or modifying files outside this project:"
  echo "  1. Verify you are in the RIGHT project for the current topic/task"
  echo "  2. Check: curl -X POST http://localhost:\${PORT:-4040}/coherence/check \\\\"
  echo "       -H 'Content-Type: application/json' \\\\"
  echo "       -d '{\"action\":\"deploy\",\"context\":{\"topicId\":N}}'"
  echo "  3. If the check says BLOCK — STOP. You may be in the wrong project."
  echo "  4. Read the full reflection: POST /coherence/reflect"
  echo "--- END COHERENCE SCOPE ---"
fi

# Key files
echo ""
echo "Key files:"
[ -f "$INSTAR_DIR/AGENT.md" ] && echo "  .instar/AGENT.md — Your identity (read for full context)"
[ -f "$INSTAR_DIR/USER.md" ] && echo "  .instar/USER.md — Your collaborator"
[ -f "$INSTAR_DIR/MEMORY.md" ] && echo "  .instar/MEMORY.md — Persistent learnings"
[ -f "$INSTAR_DIR/project-map.md" ] && echo "  .instar/project-map.md — Project structure map"

# Relationship count
if [ -d "$INSTAR_DIR/relationships" ]; then
  REL_COUNT=\$(ls -1 "$INSTAR_DIR/relationships"/*.json 2>/dev/null | wc -l | tr -d ' ')
  [ "\$REL_COUNT" -gt "0" ] && echo "  \${REL_COUNT} tracked relationships in .instar/relationships/"
fi

# Server status + self-discovery + feature awareness
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port \${PORT}"
    # Reset scope coherence state — prevents accumulated counts from prior sessions
    # leaking into this session and causing false-positive hook triggers.
    # Endpoint: POST /scope-coherence/reset (routes.ts)
    curl -s -X POST "http://localhost:\${PORT}/scope-coherence/reset" -o /dev/null 2>/dev/null || true
    # Load full capabilities for tunnel + feature guide
    CAPS=\$(curl -s "http://localhost:\${PORT}/capabilities" 2>/dev/null)
    TUNNEL_URL=\$(echo "\$CAPS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tunnel',{}).get('url',''))" 2>/dev/null)
    [ -n "\$TUNNEL_URL" ] && echo "Cloudflare Tunnel active: \$TUNNEL_URL"
    # Inject feature guide — proactive capability awareness at every session start
    if echo "\$CAPS" | grep -q '"featureGuide"'; then
      echo ""
      echo "--- YOUR CAPABILITIES (use these proactively when context matches) ---"
      echo "\$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    triggers = guide.get('triggers', [])
    if triggers:
        for t in triggers:
            print(f'  When: {t[\"context\"]}')
            print(f'  Do:   {t[\"action\"]}')
            print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi

    # Context dispatch table — structural "when X, look at Y" routing
    # Structure > Willpower: instead of burying this in a 600-line CLAUDE.md,
    # inject it at session start so the agent sees it before doing anything.
    DISPATCH_FILE="$INSTAR_DIR/context/DISPATCH.md"
    if [ -f "\$DISPATCH_FILE" ]; then
      echo ""
      echo "--- CONTEXT DISPATCH (when X arises, read Y) ---"
      cat "\$DISPATCH_FILE" | head -20
      echo "--- END CONTEXT DISPATCH ---"
    fi
  else
    echo ""
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""
echo "IMPORTANT: To report bugs or request features, use POST /feedback on your local server."

# Working Memory — surface relevant knowledge from SemanticMemory + EpisodicMemory
# Right context at the right moment: query-driven, not a full dump.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)
  if [ -n "\$PORT" ]; then
    # Resolve auth token: env first (set by SessionManager for every spawned
    # session), legacy plaintext-config fallback with string-type guard so the
    # { "secret": true } placeholder produced by SecretMigrator never leaks
    # through as a bogus Bearer token.
    AUTH_TOKEN="\${INSTAR_AUTH_TOKEN:-}"
    if [ -z "\$AUTH_TOKEN" ]; then
      AUTH_TOKEN=\$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
    fi
    HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
    if [ "\$HEALTH" = "200" ]; then
      # Build query from available context signals
      QUERY_PARTS=""
      [ -n "\$INSTAR_TELEGRAM_TOPIC" ] && QUERY_PARTS="topic:\${INSTAR_TELEGRAM_TOPIC} "
      WM_PROMPT=\$(echo "\${QUERY_PARTS}\${CLAUDE_SESSION_GOAL:-session-start}" | python3 -c "import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read()[:300].strip()))" 2>/dev/null)
      WORKING_MEM=\$(curl -s -H "Authorization: Bearer \${AUTH_TOKEN}" \
        "http://localhost:\${PORT}/context/working-memory?prompt=\${WM_PROMPT}&limit=8" 2>/dev/null)
      if [ -n "\$WORKING_MEM" ]; then
        WM_CONTEXT=\$(echo "\$WORKING_MEM" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])
    if ctx and tokens > 0:
        src_summary = ', '.join(f'{s[\"count\"]} {s[\"name\"]}' for s in sources if s.get('count', 0) > 0)
        print(f'[{tokens} tokens from: {src_summary}]')
        print()
        print(ctx)
except Exception:
    pass
" 2>/dev/null)
        if [ -n "\$WM_CONTEXT" ]; then
          echo ""
          echo "--- WORKING MEMORY (relevant knowledge for this session) ---"
          echo "\$WM_CONTEXT"
          echo "--- END WORKING MEMORY ---"
        fi
      fi
    fi
  fi
fi

# Telegram relay instructions (structural — ensures EVERY Telegram session knows how to respond)
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  [ -f "$INSTAR_DIR/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  [ -z "\$RELAY_SCRIPT" ] && [ -f "\${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ] && RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  echo ""
  echo "--- TELEGRAM SESSION (topic \${TOPIC_ID}) ---"
  echo "MANDATORY: After EVERY response, relay conversational text back to Telegram:"
  echo "  cat <<'EOF' | \${RELAY_SCRIPT:-'.instar/scripts/telegram-reply.sh'} \${TOPIC_ID}"
  echo "  Your response text here"
  echo "  EOF"
  echo "Strip the [telegram:\${TOPIC_ID}] prefix before interpreting messages."
  echo "If a thread history file is referenced, READ IT FIRST before responding."
  echo "--- END TELEGRAM SESSION ---"
fi

# Pending upgrade guide — inject knowledge from the latest update
GUIDE_FILE="$INSTAR_DIR/state/pending-upgrade-guide.md"
if [ -f "\$GUIDE_FILE" ]; then
  echo ""
  echo "=== UPGRADE GUIDE (ACTION REQUIRED) ==="
  echo ""
  echo "A new version of Instar was installed with upgrade instructions."
  echo "You MUST do the following:"
  echo ""
  echo "1. Read the full upgrade guide below"
  echo "2. Take any suggested actions that apply to YOUR situation"
  echo "3. MESSAGE YOUR USER about what's new:"
  echo "   - Compose a brief, personalized message highlighting the features"
  echo "     that matter most to THEM and their specific use case"
  echo "   - Explain what each feature means in practical terms — how they"
  echo "     can take advantage of it, what it changes for them"
  echo "   - Skip internal plumbing details — focus on what the user will"
  echo "     notice, benefit from, or need to configure"
  echo "   - Send this message to the user via Telegram (Agent Updates topic)"
  echo "   - NEVER send updates to Agent Attention — that's for critical/blocking items only"
  echo "   - Use your knowledge of your user to personalize — you know their"
  echo "     workflow, their priorities, what they care about"
  echo "4. UPDATE YOUR MEMORY with the new capabilities:"
  echo "   - Read the upgrade guide's 'Summary of New Capabilities' section"
  echo "   - Add the relevant capabilities to your .instar/MEMORY.md file"
  echo "   - Focus on WHAT you can now do and HOW to use it"
  echo "   - If similar notes exist in MEMORY.md, update rather than duplicate"
  echo "   - This ensures you KNOW about these capabilities in every future session"
  echo "5. After messaging the user and updating memory, run: instar upgrade-ack"
  echo ""
  echo "--- UPGRADE GUIDE CONTENT ---"
  echo ""
  cat "\$GUIDE_FILE"
  echo ""
  echo "--- END UPGRADE GUIDE CONTENT ---"
  echo "=== END UPGRADE GUIDE ==="
fi

echo "=== END SESSION START ==="
`;
  }

  private getDangerousCommandGuard(): string {
    return `#!/bin/bash
# Dangerous command guard — safety infrastructure for autonomous agents.
# Supports safety.level in .instar/config.json:
#   Level 1 (default): Block and ask user. Level 2: Agent self-verifies.
# Input: Claude passes the command as arg \$1; Codex (stdin-only) delivers the
# hook event as JSON on stdin. Claude uses tool_input.command; Codex's exec_command
# tool uses tool_input.cmd — accept either (verified live 2026-05-24).
INPUT="$1"
if [ -z "$INPUT" ]; then
  INPUT="$(cat 2>/dev/null | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); ti=d.get('tool_input',{}) or {}
    print(ti.get('command') or ti.get('cmd') or '')
except Exception:
    print('')" 2>/dev/null)"
fi
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

# Read safety level from config
SAFETY_LEVEL=1
if [ -f "$INSTAR_DIR/config.json" ]; then
  SAFETY_LEVEL=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('safety', {}).get('level', 1))" 2>/dev/null || echo "1")
fi

# ALWAYS blocked (catastrophic, irreversible)
for pattern in "rm -rf /" "rm -rf ~" "> /dev/sda" "mkfs\\." "dd if=" ":(){:|:&};:"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    echo "BLOCKED: Catastrophic command detected: $pattern" >&2
    echo "Always blocked regardless of safety level. User must execute directly." >&2
    exit 2
  fi
done

# Deployment/push commands — check coherence gate first
for pattern in "vercel deploy" "vercel --prod" "git push" "npm publish" "npx wrangler deploy" "fly deploy" "railway up"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ -f "$INSTAR_DIR/config.json" ]; then
      PORT=$(python3 -c "import json; print(json.load(open('$INSTAR_DIR/config.json')).get('port', 4040))" 2>/dev/null || echo "4040")
      TOPIC_ID="\${INSTAR_TELEGRAM_TOPIC:-}"
      ACTION="deploy"
      echo "$INPUT" | grep -qi "git push" && ACTION="git-push"
      echo "$INPUT" | grep -qi "npm publish" && ACTION="git-push"
      CTX="{}"
      [ -n "$TOPIC_ID" ] && CTX="{\\\"topicId\\\": $TOPIC_ID}"
      CHECK=$(curl -s -X POST "http://localhost:$PORT/coherence/check" -H 'Content-Type: application/json' -d "{\\\"action\\\":\\\"$ACTION\\\",\\\"context\\\":$CTX}" 2>/dev/null)
      if echo "$CHECK" | grep -q '"recommendation":"block"'; then
        SUMMARY=$(echo "$CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary','Coherence check failed'))" 2>/dev/null || echo "Coherence check failed")
        echo "BLOCKED: Coherence gate blocked this action." >&2
        echo "$SUMMARY" >&2
        echo "Run POST /coherence/reflect for a detailed self-verification checklist." >&2
        exit 2
      fi
    fi
  fi
done

# Risky commands — behavior depends on safety level
for pattern in "rm -rf \\." "git push --force" "git push -f" "git reset --hard" "git clean -fd" "DROP TABLE" "DROP DATABASE" "TRUNCATE" "DELETE FROM"; do
  if echo "$INPUT" | grep -qi "$pattern"; then
    if [ "$SAFETY_LEVEL" -eq 1 ]; then
      echo "BLOCKED: Potentially destructive command detected: $pattern" >&2
      echo "Authorization required: Ask the user whether to proceed with this operation." >&2
      echo "Once they confirm, YOU execute the command — never ask the user to run it themselves." >&2
      exit 2
    else
      IDENTITY=""
      if [ -f "$INSTAR_DIR/AGENT.md" ]; then
        IDENTITY=$(head -20 "$INSTAR_DIR/AGENT.md" | tr '\\n' ' ')
      fi
      echo "{\\"decision\\":\\"approve\\",\\"additionalContext\\":\\"=== SELF-VERIFICATION REQUIRED ===\\\\nDestructive command detected: $pattern\\\\n\\\\n1. Is this necessary for the current task?\\\\n2. What are the consequences if this goes wrong?\\\\n3. Is there a safer alternative?\\\\n4. Does this align with your principles?\\\\n\\\\nIdentity: $IDENTITY\\\\n\\\\nIf ALL checks pass, proceed. If ANY fails, stop.\\\\n=== END SELF-VERIFICATION ===\\"}"
      exit 0
    fi
  fi
done

# 'gh pr merge' watch-exit-merge gate — closes the PR #539 class.
# Justin merged #539 on 'gh run watch' exit code (= success), but 'watch'
# returns 0 on workflow COMPLETION regardless of conclusion; meanwhile the
# PR's branch-protection checks were RED. Cost a fix-forward (#540) + a
# fleet outage. The rule: 'gh pr merge' must NEVER fire if any PR-event
# check is non-pass. This guard runs 'gh pr checks <num>' and refuses on
# any failure / pending / queued check.
#
# 'gh pr merge --auto' is the documented safe path (only fires when
# checks pass) — let it through. Other flags (--admin, no flag) get
# verified against the live check state.
if echo "$INPUT" | grep -qiE '(^|[;&|(\\s])gh +pr +merge( |\$|--)'; then
  if echo "$INPUT" | grep -qE '(^| )--auto( |$)'; then
    : # --auto is the safe async gate; allow.
  else
    PR_NUM=$(echo "$INPUT" | grep -oE 'gh +pr +merge[ +-]+[0-9]+' | grep -oE '[0-9]+' | head -1)
    if [ -z "$PR_NUM" ]; then
      PR_NUM=$(gh pr view --json number -q .number 2>/dev/null)
    fi
    if [ -n "$PR_NUM" ]; then
      CHECKS_JSON=$(gh pr checks "$PR_NUM" --json name,state 2>/dev/null)
      if [ -n "$CHECKS_JSON" ]; then
        NON_OK=$(echo "$CHECKS_JSON" | python3 -c "
import sys, json
try:
    rows = json.loads(sys.stdin.read())
    if isinstance(rows, list):
        bad = [r.get('name','?') + '=' + str(r.get('state','?')) for r in rows
               if str(r.get('state','')).upper() not in ('SUCCESS','SKIPPED','SKIPPING','NEUTRAL','')]
        print(','.join(bad))
except Exception:
    pass
" 2>/dev/null)
        if [ -n "$NON_OK" ]; then
          echo "BLOCKED: PR #$PR_NUM has non-passing checks: $NON_OK" >&2
          echo "" >&2
          echo "'gh pr merge' must not run while any check is failing, pending, or queued." >&2
          echo "Closes the 2026-05-27 #539 watch-exit-merge class — 'gh run watch' returns 0" >&2
          echo "on workflow completion regardless of conclusion, which caused a fix-forward" >&2
          echo "(#540) + a fleet outage when #539 was merged on a red unit-test shard." >&2
          echo "" >&2
          echo "Options:" >&2
          echo "  1) Wait. Re-check with: gh pr checks $PR_NUM" >&2
          echo "  2) Use 'gh pr merge --auto' — async gate that ONLY fires when all" >&2
          echo "     checks pass. Documented safe path." >&2
          echo "  3) If a non-passing check is an intentional skip (e.g. Contract Tests" >&2
          echo "     on non-tagged PRs), it appears as SKIPPED / SKIPPING in" >&2
          echo "     'gh pr checks --json state' output and the gate already allows it." >&2
          exit 2
        fi
      fi
    fi
  fi
fi
`;
  }

  private getGroundingBeforeMessaging(): string {
    return `#!/bin/bash
# Grounding before messaging — ensures the agent is grounded and message is
# quality-checked before sending any external communication.
#
# Three-phase defense:
# 1. Identity injection — re-ground the agent in who they are
# 2. Convergence check — heuristic quality gate on the message content
# 3. URL provenance — verify URLs aren't fabricated
#
# Structure > Willpower: these checks run automatically before
# external messaging, not when the agent remembers to do them.
#
# The 164th Lesson (Dawn): Advisory hooks are insufficient.
# Grounding must be automatic — content injected, not pointed to.
#
# Installed by instar during setup. Runs as a PreToolUse hook (Claude: Bash arg;
# Codex: stdin JSON — tool_input.command for Claude, tool_input.cmd for Codex's
# exec_command tool; accept either).

INPUT="$1"
if [ -z "$INPUT" ]; then
  INPUT="$(cat 2>/dev/null | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); ti=d.get('tool_input',{}) or {}
    print(ti.get('command') or ti.get('cmd') or '')
except Exception:
    print('')" 2>/dev/null)"
fi

# Detect messaging commands (telegram-reply, email sends, API message posts, etc.)
if echo "$INPUT" | grep -qE "(telegram-reply|send-email|send-message|POST.*/telegram/reply|POST.*/message|/reply)"; then
  INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
  SCRIPTS_DIR="$INSTAR_DIR/scripts"

  # Phase 1: Identity injection (Structure > Willpower — output content, not pointers)
  if [ -f "$INSTAR_DIR/AGENT.md" ]; then
    echo "=== PRE-MESSAGE GROUNDING ==="
    echo ""
    echo "--- YOUR IDENTITY ---"
    cat "$INSTAR_DIR/AGENT.md"
    echo ""
    echo "--- END IDENTITY ---"
    echo ""
  fi

  # Phase 2: Convergence check (heuristic quality gate)
  if [ -f "$SCRIPTS_DIR/convergence-check.sh" ]; then
    # Pipe the full tool input through the convergence check.
    # The check looks for common agent failure modes (capability claims,
    # sycophancy, settling, experiential fabrication, commitment overreach,
    # URL provenance).
    CHECK_RESULT=$(echo "$INPUT" | bash "$SCRIPTS_DIR/convergence-check.sh" 2>&1)
    CHECK_EXIT=$?

    if [ "$CHECK_EXIT" -ne "0" ]; then
      echo "$CHECK_RESULT"
      echo ""
      echo "=== MESSAGE BLOCKED — Review and revise before sending. ==="
      exit 2
    fi
  fi

  echo "=== GROUNDED — Proceed with message. ==="
fi
`;
  }

  private getConvergenceCheckInline(): string {
    // Inline fallback — used if template file can't be found.
    // The primary getConvergenceCheck() reads from the template file.
    const script = [
      '#!/bin/bash',
      '# Lightweight convergence check — heuristic content quality gate before messaging.',
      '# No LLM calls. Fast. Catches the most common agent failure modes.',
      '#',
      '# Usage: echo "message content" | bash .instar/scripts/convergence-check.sh',
      '# Exit codes: 0 = converged (safe to send), 1 = issues found (review needed)',
      '#',
      '# Checks 7 criteria via pattern matching:',
      '#',
      '# 1. capability_claims — Claims about what the agent can\'t do (may be wrong)',
      '# 2. commitment_overreach — Promises the agent may not be able to keep',
      '# 3. settling — Accepting empty/failed results without investigation',
      '# 4. experiential_fabrication — Claiming to see/read/feel without verification',
      '# 5. sycophancy — Reflexive agreement, excessive apology, capitulation',
      '# 6. url_provenance — URLs with unfamiliar domains that may be fabricated',
      '# 7. temporal_staleness — Language suggesting outdated perspective or stale draft',
      '#',
      '# This is Structure > Willpower: the check runs automatically before',
      '# external messaging, not when the agent remembers to do it.',
      '',
      'CONTENT=$(cat)',
      'ISSUES=()',
      'ISSUE_COUNT=0',
      '',
      '# 1. CAPABILITY CLAIMS — Watch for "I can\'t" / "I don\'t have" / "not available"',
      'if echo "$CONTENT" | grep -qiE "(unfortunately.{0,20}(i can.t|i.m unable|not (possible|available|supported))|i don.t have (the ability|access|a way)|this (isn.t|is not) (possible|available|supported))"; then',
      '  ISSUES+=("CAPABILITY: You\'re claiming a limitation. Did you check /capabilities first? Many \'I can\'t\' statements are wrong — verify before sending.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 2. COMMITMENT OVERREACH — Promises that may not survive session boundaries',
      'if echo "$CONTENT" | grep -qiE "(i.ll (make sure|ensure|guarantee|always|never forget)|i (promise|commit to|will always)|you can count on me to|i.ll remember (to|this)|from now on i.ll)"; then',
      '  ISSUES+=("COMMITMENT: You\'re making a promise that may not survive context compaction or session end. Can your infrastructure actually keep this commitment? If not, reframe as intent rather than guarantee.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 3. SETTLING — Accepting empty results without digging deeper',
      'if echo "$CONTENT" | grep -qiE "(no (data|results|information) (available|found|exists)|nothing (to report|happened|was found)|there (is|are) no|could(n.t| not) find (any|the)|appears to be empty|no (relevant|matching|applicable))"; then',
      '  ISSUES+=("SETTLING: You\'re reporting nothing found. Did you check multiple sources? Could the data source be stale or the search terms wrong? Empty results deserve investigation, not acceptance.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 4. EXPERIENTIAL FABRICATION — Claiming first-person experience without tool verification',
      'if echo "$CONTENT" | grep -qiE "(i (can see|noticed|observed|felt|sensed|perceived) (that |the |a |an )|looking at (this|the|your)|from what i.ve (seen|read|observed)|i.ve (reviewed|examined|analyzed|inspected) (the|your|this))"; then',
      '  ISSUES+=("EXPERIENTIAL: You\'re claiming a first-person experience. Did you actually access this data with a tool in THIS session, or are you completing a social script? Verify before claiming.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 5. SYCOPHANCY — Reflexive agreement, excessive apology',
      'if echo "$CONTENT" | grep -qiE "(you.re (absolutely|totally|completely) right|i (completely|totally|fully) (agree|understand)|great (question|point|observation)|i apologize for|sorry.{0,20}(mistake|confusion|error|oversight)|that.s (a |an )?(excellent|great|wonderful|fantastic) (point|question|idea|suggestion))"; then',
      '  ISSUES+=("SYCOPHANCY: You may be reflexively agreeing or over-apologizing. If you genuinely agree, state why. If you don\'t fully agree, say what you actually think. Politeness is not a substitute for honesty.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# 6. URL PROVENANCE — URLs with unfamiliar domains may be fabricated',
      '# Common confabulation: agent constructs plausible URL from project name',
      '# (e.g., "deepsignal.xyz" from project "deep-signal"). Catch and require verification.',
      'URLS_IN_MSG=$(echo "$CONTENT" | grep -oE \'https?://[^ )"' + "'" + '>]+\' 2>/dev/null || true)',
      'if [ -n "$URLS_IN_MSG" ]; then',
      '  # Trust only this agent\'s configured tunnel hostname plus Cloudflare quick tunnels.',
      '  # If config/python is unavailable or tunnel.hostname is empty, fall back cleanly.',
      '  OWN_TUNNEL_HOST=""',
      '  CONFIG_PATH="${CLAUDE_PROJECT_DIR:-.}/.instar/config.json"',
      '  if [ -f "$CONFIG_PATH" ]; then',
      '    OWN_TUNNEL_HOST=$(python3 - "$CONFIG_PATH" <<\'PY\' 2>/dev/null',
      'import json',
      'import sys',
      'from urllib.parse import urlparse',
      '',
      'try:',
      '    cfg = json.load(open(sys.argv[1]))',
      '    raw = ((cfg.get(\'tunnel\') or {}).get(\'hostname\') or \'\').strip()',
      '    if not raw:',
      '        print(\'\')',
      '    else:',
      '        parsed = urlparse(raw if \'://\' in raw else f\'https://{raw}\')',
      '        print((parsed.hostname or \'\').lower())',
      'except Exception:',
      '    print(\'\')',
      'PY',
      ')',
      '  fi',
      '',
      '  UNFAMILIAR_URLS=""',
      '  while IFS= read -r url; do',
      '    [ -z "$url" ] && continue',
      '    URL_HOST=$(python3 - "$url" <<\'PY\' 2>/dev/null',
      'import sys',
      'from urllib.parse import urlparse',
      'try:',
      '    print((urlparse(sys.argv[1]).hostname or \'\').lower())',
      'except Exception:',
      '    print(\'\')',
      'PY',
      ')',
      '    if [ -n "$OWN_TUNNEL_HOST" ] && [ "$URL_HOST" = "$OWN_TUNNEL_HOST" ]; then',
      '      continue',
      '    fi',
      '    if echo "$URL_HOST" | grep -qE \'(^|\\.)trycloudflare\\.com$\'; then',
      '      continue',
      '    fi',
      '    # Skip well-known service domains',
      '    if echo "$url" | grep -qE \'(github\\.com|vercel\\.app|vercel\\.com|netlify\\.app|netlify\\.com|npmjs\\.com|npmjs\\.org|cloudflare\\.com|google\\.com|twitter\\.com|x\\.com|youtube\\.com|reddit\\.com|discord\\.com|discord\\.gg|telegram\\.org|t\\.me|localhost|127\\.0\\.0\\.1|stackoverflow\\.com|developer\\.mozilla\\.org|docs\\.anthropic\\.com|anthropic\\.com|openai\\.com|claude\\.ai|notion\\.so|linear\\.app|fly\\.io|render\\.com|railway\\.app|heroku\\.com|amazonaws\\.com|azure\\.com|gitlab\\.com|bitbucket\\.org|docker\\.com|hub\\.docker\\.com|pypi\\.org|crates\\.io|rubygems\\.org|pkg\\.go\\.dev|wikipedia\\.org|medium\\.com|substack\\.com|circle\\.so|ghost\\.io|telegraph\\.ph)\'; then',
      '      continue',
      '    fi',
      '    UNFAMILIAR_URLS="$UNFAMILIAR_URLS  $url\\n"',
      '  done <<< "$URLS_IN_MSG"',
      '',
      '  if [ -n "$UNFAMILIAR_URLS" ]; then',
      '    ISSUES+=("URL_PROVENANCE: Your message contains URLs with unfamiliar domains:\\n${UNFAMILIAR_URLS}Before including a URL, verify it appeared in actual tool output in THIS session OR confirm it resolves with curl. A common confabulation: constructing domains from project names (e.g., \'deepsignal.xyz\' from project \'deep-signal\').")',
      '    ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      '  fi',
      'fi',
      '',
      '# 7. TEMPORAL STALENESS — Language suggesting outdated perspective or stale draft',
      'if echo "$CONTENT" | grep -qiE "(i used to (think|believe|feel|assume)|back when i (first|started|was new)|at (that|the) time i|my (early|earlier|initial|original|first) (understanding|thinking|view|perspective|approach)|i didn.t yet understand|before i (learned|realized|discovered|knew)|i (once|previously) (thought|believed|felt)|this was (before|when) i)"; then',
      '  ISSUES+=("TEMPORAL: Your message references past understanding or earlier perspectives. Is this content from an older draft? If your thinking has evolved since writing this, revise to reflect your current understanding before publishing.")',
      '  ISSUE_COUNT=$((ISSUE_COUNT + 1))',
      'fi',
      '',
      '# Output results',
      'if [ "$ISSUE_COUNT" -gt "0" ]; then',
      '  echo "=== CONVERGENCE CHECK: ${ISSUE_COUNT} ISSUE(S) FOUND ==="',
      '  echo ""',
      '  for ISSUE in "${ISSUES[@]}"; do',
      '    echo "  - $ISSUE"',
      '    echo ""',
      '  done',
      '  echo "Review and revise before sending. Re-run this check after revision."',
      '  echo "=== END CONVERGENCE CHECK ==="',
      '  exit 1',
      'else',
      '  exit 0',
      'fi',
    ].join('\n');
    return script;
  }

  private getTelegramTopicContextHook(): string {
    return `#!/bin/bash
# UserPromptSubmit Hook: Auto-inject Telegram topic history context.
#
# When a user prompt contains [telegram:N], this hook reads the recent
# conversation history for that topic and injects it as context. Also
# detects unanswered user messages and surfaces them with directives.
#
# This prevents the "what are we talking about?" failure after compaction
# or session restart — where the agent receives a message without
# conversation context and responds with a generic greeting.
#
# Time injection: fires on every UserPromptSubmit regardless of [telegram:N]
# prefix so the agent always sees current wall-clock time. Addresses the
# Claude Code "harness injects date, not time of day" blind spot that caused
# agents to hallucinate clock times in long sessions.

# Current wall-clock time — always emitted, BEFORE the [telegram:N] early-exit.
NOW=\$(date +'%Y-%m-%d %H:%M:%S %z (%Z)' 2>/dev/null)
if [ -n "\$NOW" ]; then
  echo "--- CURRENT TIME ---"
  echo "\$NOW"
  echo "Wall-clock at user-prompt submit. Quote this — do not carry stale clock times from prior context."
  echo "--- END CURRENT TIME ---"
  echo ""
fi

# Read the user prompt from stdin (Claude Code pipes JSON with { prompt: "..." })
USER_PROMPT=\$(python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('prompt', ''))
except:
    print('')
" 2>/dev/null)

# Check for [telegram:N] prefix
TOPIC_ID=\$(echo "\$USER_PROMPT" | python3 -c "
import sys, re
line = sys.stdin.read()
m = re.search(r'\\\\[telegram:(\\\\d+)', line)
if m:
    print(m.group(1))
" 2>/dev/null)

if [ -z "\$TOPIC_ID" ]; then
  exit 0
fi

# Get server port from config
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
CONFIG_FILE="\$INSTAR_DIR/config.json"

if [ ! -f "\$CONFIG_FILE" ]; then
  exit 0
fi

PORT=\$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "\$CONFIG_FILE" | head -1 | grep -oE '[0-9]+' | head -1)
if [ -z "\$PORT" ]; then
  exit 0
fi

# Check server health
HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "\$HEALTH" != "200" ]; then
  exit 0
fi

# Resolve the auth token. INSTAR_AUTH_TOKEN env first (set by SessionManager and
# JobScheduler for every spawned session) — survives the secret-externalization
# refactor that moved authToken out of config.json into the encrypted store.
# Legacy fallback: read from config.json with a string-type guard. When authToken
# has been externalized, the value is the literal placeholder { "secret": true } —
# the guard rejects it and yields empty, so we never send the placeholder as a
# Bearer token (which the server rejects with 403, silently breaking history
# injection — the 2026-05-29 incident this fix is for).
AUTH_TOKEN="\${INSTAR_AUTH_TOKEN:-}"
if [ -z "\$AUTH_TOKEN" ] && [ -f "\$CONFIG_FILE" ]; then
  AUTH_TOKEN=\$(python3 -c "import json; v=json.load(open('\$CONFIG_FILE')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
fi

# Fetch recent messages for this topic
if [ -n "\$AUTH_TOKEN" ]; then
  RECENT_MSGS=\$(curl -s \\
    -H "Authorization: Bearer \${AUTH_TOKEN}" \\
    "http://localhost:\${PORT}/telegram/topics/\${TOPIC_ID}/messages?limit=15" 2>/dev/null)
else
  RECENT_MSGS=\$(curl -s \\
    "http://localhost:\${PORT}/telegram/topics/\${TOPIC_ID}/messages?limit=15" 2>/dev/null)
fi

# Format and output context with unanswered message detection
echo "\$RECENT_MSGS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    msgs = data.get('messages', [])
    if not msgs:
        sys.exit(0)

    print('TOPIC \${TOPIC_ID} RECENT HISTORY (auto-injected):')

    for m in msgs:
        ts = m.get('timestamp', '')[:16].replace('T', ' ')
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        text = m.get('text', '').strip()
        sender = 'User' if from_user else 'Agent'
        if len(text) > 300:
            text = text[:297] + '...'
        print(f'  [{ts}] {sender}: {text}')

    # Detect unanswered user messages
    pending_user = []
    for m in msgs:
        text = m.get('text', '').strip()
        if not text:
            continue
        from_user = m.get('fromUser', m.get('direction', 'in') == 'in')
        if from_user:
            pending_user.append(m)
        else:
            pending_user = []

    if pending_user:
        print()
        print('*** UNANSWERED MESSAGE(S) FROM USER ***')
        for pm in pending_user:
            pm_text = pm.get('text', '')[:200]
            pm_ts = pm.get('timestamp', '')[:16].replace('T', ' ')
            print(f'  [{pm_ts}] \\\\\\\"{pm_text}\\\\\\\"')
        print()
        print('You MUST address these messages substantively. Do NOT respond with just')
        print('a greeting or generic reply. Read the conversation history above and')
        print('respond to what the user actually said. If the current message is a')
        print('follow-up like \\\\\\\"hello?\\\\\\\" or \\\\\\\"please respond\\\\\\\", address the EARLIER')
        print('unanswered message — that is what the user is waiting for.')
except Exception:
    pass
" 2>/dev/null

exit 0
`;
  }

  private getCompactionRecovery(): string {
    return `#!/bin/bash
# Compaction recovery — re-injects identity AND topic context when Claude's context compresses.
# Born from Dawn's 164th Lesson: "Advisory hooks get ignored. Automatic content
# injection removes the compliance gap entirely."
#
# This hook OUTPUTS identity content directly into context rather than just
# pointing to files. After compaction, the agent needs to KNOW who it is
# AND what conversation it's in — not be told where to look.
#
# Context priority (same as session-start):
#   1. Topic context (summary + recent messages) — what are we working on?
#   2. Identity (AGENT.md) — who am I?
#   3. Memory (MEMORY.md) — what have I learned?
#   4. Telegram relay — how do I respond?
#   5. Capabilities — what can I do?
INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"

echo "=== IDENTITY RECOVERY (post-compaction) ==="

# ── 1. TOPIC CONTEXT (highest priority — what are we working on?) ──
# After compaction, the conversation history is lost. Re-inject it from TopicMemory.
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  CONFIG_FILE="\$INSTAR_DIR/config.json"
  if [ -f "\$CONFIG_FILE" ]; then
    PORT=\$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "\$CONFIG_FILE" | head -1 | grep -oE '[0-9]+' | head -1)
    if [ -n "\$PORT" ]; then
      TOPIC_CTX=\$(curl -s "http://localhost:\${PORT}/topic/context/\${TOPIC_ID}?recent=20" 2>/dev/null)
      if [ -n "\$TOPIC_CTX" ] && echo "\$TOPIC_CTX" | grep -q '"totalMessages"'; then
        TOTAL=\$(echo "\$TOPIC_CTX" | grep -o '"totalMessages":[0-9]*' | cut -d':' -f2)
        TOPIC_NAME=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('topicName') or 'Unknown')" 2>/dev/null || echo "Unknown")

        echo ""
        echo "--- CONVERSATION CONTEXT (Topic: \${TOPIC_NAME}, \${TOTAL} total messages) ---"
        echo ""

        SUMMARY=\$(echo "\$TOPIC_CTX" | python3 -c "import sys,json; d=json.load(sys.stdin); s=d.get('summary'); print(s if s else '')" 2>/dev/null)
        if [ -n "\$SUMMARY" ]; then
          echo "SUMMARY OF CONVERSATION SO FAR:"
          echo "\$SUMMARY"
          echo ""
        fi

        echo "RECENT MESSAGES:"
        echo "\$TOPIC_CTX" | python3 -c "
import sys, json
d = json.load(sys.stdin)
msgs = d.get('recentMessages', [])
for m in msgs:
    sender = 'User' if m.get('fromUser') else 'Agent'
    ts = m.get('timestamp', '')[:16].replace('T', ' ')
    text = m.get('text', '')
    if len(text) > 500:
        text = text[:500] + '...'
    print(f'[{ts}] {sender}: {text}')

# Detect unanswered user messages
pending_user = []
for m in msgs:
    text = m.get('text', '').strip()
    if not text:
        continue
    if m.get('fromUser'):
        pending_user.append(m)
    else:
        pending_user = []

if pending_user:
    print()
    print('!' * 60)
    print('UNANSWERED MESSAGE(S) FROM USER:')
    for pm in pending_user:
        pm_text = pm.get('text', '')[:200]
        pm_ts = pm.get('timestamp', '')[:16].replace('T', ' ')
        print(f'  [{pm_ts}] \\\"{pm_text}\\\"')
    print()
    print('You MUST address these messages substantively. Do NOT respond')
    print('with just a greeting or generic reply. If the latest message')
    print('is a follow-up like \\\"hello?\\\" or \\\"please respond\\\", address')
    print('the EARLIER unanswered message — that is what the user is')
    print('waiting for.')
    print('!' * 60)
" 2>/dev/null
        echo ""
        echo "Search past conversations: curl http://localhost:\${PORT}/topic/search?topic=\${TOPIC_ID}&q=QUERY"
        echo "--- END CONVERSATION CONTEXT ---"
        echo ""
      fi
    fi
  fi
fi

# ── 2. IDENTITY (full AGENT.md — who am I?) ──
if [ -f "\$INSTAR_DIR/AGENT.md" ]; then
  echo ""
  echo "--- Your Identity (from .instar/AGENT.md) ---"
  cat "\$INSTAR_DIR/AGENT.md"
  echo ""
  echo "--- End Identity ---"
fi

# ── 2b. PROJECT CONTEXT (where am I working?) ──
if [ -f "\$INSTAR_DIR/project-map.json" ]; then
  echo ""
  echo "--- PROJECT CONTEXT ---"
  python3 -c "
import json, sys
try:
    m = json.load(open('\$INSTAR_DIR/project-map.json'))
    print(f'Project: {m[\"projectName\"]} ({m[\"projectType\"]})')
    print(f'Path: {m[\"projectDir\"]}')
    r = m.get('gitRemote')
    b = m.get('gitBranch')
    if r: print(f'Git: {r}' + (f' [{b}]' if b else ''))
    t = m.get('deploymentTargets', [])
    if t: print(f'Deploy targets: {(\", \").join(t)}')
    print(f'Files: {m[\"totalFiles\"]} across {len(m.get(\"directories\", []))} directories')
except Exception as e:
    print(f'(project map load failed: {e})', file=sys.stderr)
" 2>/dev/null
  echo "--- END PROJECT CONTEXT ---"
fi

# ── 3. MEMORY (first 50 lines — what have I learned?) ──
if [ -f "\$INSTAR_DIR/MEMORY.md" ]; then
  LINES=\$(wc -l < "\$INSTAR_DIR/MEMORY.md" | tr -d ' ')
  echo ""
  echo "--- Your Memory (.instar/MEMORY.md — \${LINES} lines, showing first 50) ---"
  head -50 "\$INSTAR_DIR/MEMORY.md"
  if [ "\$LINES" -gt 50 ]; then
    echo "... (\$((LINES - 50)) more lines — read full file if needed)"
  fi
  echo "--- End Memory ---"
fi

# ── 4. TELEGRAM RELAY (how do I respond?) ──
if [ -n "\$INSTAR_TELEGRAM_TOPIC" ]; then
  TOPIC_ID="\$INSTAR_TELEGRAM_TOPIC"
  RELAY_SCRIPT=""
  if [ -f "\$INSTAR_DIR/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".instar/scripts/telegram-reply.sh"
  elif [ -f "\${CLAUDE_PROJECT_DIR:-.}/.claude/scripts/telegram-reply.sh" ]; then
    RELAY_SCRIPT=".claude/scripts/telegram-reply.sh"
  fi

  echo ""
  echo "--- TELEGRAM SESSION (topic \${TOPIC_ID}) ---"
  echo "This session is connected to Telegram topic \${TOPIC_ID}."
  echo "Messages arrive prefixed with [telegram:\${TOPIC_ID}]. Strip prefix before interpreting."
  echo "After EVERY response, relay your text back:"
  if [ -n "\$RELAY_SCRIPT" ]; then
    echo "  cat <<'EOF' | \${RELAY_SCRIPT} \${TOPIC_ID}"
  else
    echo "  cat <<'EOF' | .instar/scripts/telegram-reply.sh \${TOPIC_ID}"
  fi
  echo "  Your response text here"
  echo "  EOF"
  echo "--- END TELEGRAM SESSION ---"
fi

# ── 5. SERVER STATUS + CAPABILITIES ──
CONFIG_FILE="\$INSTAR_DIR/config.json"
if [ -f "\$CONFIG_FILE" ]; then
  PORT=\$(python3 -c "import json; print(json.load(open('\$CONFIG_FILE')).get('port', 4040))" 2>/dev/null || echo "4040")
  HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
  if [ "\$HEALTH" = "200" ]; then
    echo ""
    echo "Instar server: RUNNING on port \${PORT}"
    CAPS=\$(curl -s "http://localhost:\${PORT}/capabilities" 2>/dev/null)
    if echo "\$CAPS" | grep -q '"featureGuide"' 2>/dev/null; then
      echo ""
      echo "--- YOUR CAPABILITIES ---"
      echo "\$CAPS" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    guide = d.get('featureGuide', {})
    for t in guide.get('triggers', []):
        print(f'  When: {t[\"context\"]}')
        print(f'  Do:   {t[\"action\"]}')
        print()
except: pass
" 2>/dev/null
      echo "--- END CAPABILITIES ---"
    fi

    # Context dispatch table — structural "when X, read Y" routing
    DISPATCH_FILE="\$INSTAR_DIR/context/DISPATCH.md"
    if [ -f "\$DISPATCH_FILE" ]; then
      echo ""
      echo "--- CONTEXT DISPATCH (when X arises, read Y) ---"
      cat "\$DISPATCH_FILE" | head -20
      echo "--- END CONTEXT DISPATCH ---"
    fi
  else
    echo ""
    echo "Instar server: NOT RUNNING (port \${PORT})"
  fi
fi

echo ""

# Working Memory — surface relevant knowledge after compaction
# This restores what you knew before compaction that's relevant now.
if [ -f "$INSTAR_DIR/config.json" ]; then
  PORT=\$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTAR_DIR/config.json" | head -1 | grep -oE '[0-9]+' | head -1)
  if [ -n "\$PORT" ]; then
    # Resolve auth token: env first (set by SessionManager for every spawned
    # session), legacy plaintext-config fallback with string-type guard so the
    # { "secret": true } placeholder produced by SecretMigrator never leaks
    # through as a bogus Bearer token.
    AUTH_TOKEN="\${INSTAR_AUTH_TOKEN:-}"
    if [ -z "\$AUTH_TOKEN" ]; then
      AUTH_TOKEN=\$(python3 -c "import json; v=json.load(open('$INSTAR_DIR/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)
    fi
    HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
    if [ "\$HEALTH" = "200" ]; then
      WM_QUERY=\$(python3 -c "import urllib.parse; print(urllib.parse.quote('compaction-recovery context-restoration'))" 2>/dev/null)
      WORKING_MEM=\$(curl -s -H "Authorization: Bearer \${AUTH_TOKEN}" \
        "http://localhost:\${PORT}/context/working-memory?prompt=\${WM_QUERY}&limit=6" 2>/dev/null)
      if [ -n "\$WORKING_MEM" ]; then
        WM_CONTEXT=\$(echo "\$WORKING_MEM" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ctx = data.get('context', '').strip()
    tokens = data.get('estimatedTokens', 0)
    sources = data.get('sources', [])
    if ctx and tokens > 0:
        src_summary = ', '.join(f'{s[\\\"count\\\"]} {s[\\\"name\\\"]}' for s in sources if s.get('count', 0) > 0)
        print(f'[{tokens} tokens from: {src_summary}]')
        print()
        print(ctx)
except Exception:
    pass
" 2>/dev/null)
        if [ -n "\$WM_CONTEXT" ]; then
          echo "--- WORKING MEMORY RESTORED ---"
          echo "\$WM_CONTEXT"
          echo "--- END WORKING MEMORY ---"
          echo ""
        fi
      fi
    fi
  fi
fi

echo "=== END IDENTITY RECOVERY ==="
`;
  }

  private getDeferralDetectorHook(): string {
    return `#!/usr/bin/env node
// Deferral detector — catches agents deferring work they could do themselves
// AND catches agents proposing orphan-TODO follow-ups with no infrastructure.
// PreToolUse hook for shell commands (Claude 'Bash' | Codex 'exec_command').
// Scans outgoing messages for the patterns.
// When detected, injects a due diligence checklist (does NOT block).
//
// Born from two failure modes:
//   1) An agent saying "This is credential input I cannot do myself" when it
//      already had the token available via CLI tools.
//   2) An agent saying "queue for next session" / "loop back later" / "we
//      can pick this up in a follow-up" with no /schedule cron and no
//      /commit-action tracker — the orphan-TODO trap that makes
//      promised follow-through evaporate (incident: 2026-04-27, when
//      Echo proposed exactly this pattern after Layer 1 of a multi-layer
//      build shipped without infra to ensure follow-on layers landed).
//   3) An agent deferring a doable task to a person — "needs a human",
//      "second opinion", "needs reverse-engineering" — when computer use,
//      terminal, send-keys, and MCP tools were right there (the B17
//      "Never a False Blocker" signal; authority is MessagingToneGate B17).
//      Self-fetched cross-model review (GPT/Gemini/etc.) is NOT flagged.
//
// SIGNAL ONLY — this hook never blocks. The authority that can hold an
// outbound message is MessagingToneGate (B17_FALSE_BLOCKER).

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    // Codex-aware: Codex's shell tool is 'exec_command' (not 'Bash') and puts the
    // command in tool_input.cmd (Claude uses tool_input.command). Accept both so the
    // detector fires on both engines (same fix class as dangerous-command-guard).
    if (input.tool_name !== 'Bash' && input.tool_name !== 'exec_command') process.exit(0);

    const command = (input.tool_input || {}).command || (input.tool_input || {}).cmd || '';
    if (!command) process.exit(0);

    // Only check communication commands (messages to humans)
    const commPatterns = [
      /telegram-reply/i, /send-email/i, /send-message/i,
      /POST.*\\/telegram\\/reply/i, /slack.*send/i
    ];
    if (!commPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: genuinely human-only actions
    if (/password|captcha|legal|billing|payment credential/i.test(command)) process.exit(0);

    // Inability / passing-the-buck patterns (original detector scope)
    const inabilityPatterns = [
      { re: /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)/i, type: 'inability_claim' },
      { re: /(?:this |it )(?:requires|needs) (?:your|human|manual) (?:input|intervention|action)/i, type: 'human_required' },
      { re: /you(?:'ll| will)? need to (?:do|handle|complete|input|enter|run|execute|click)/i, type: 'directing_human' },
      { re: /(?:you (?:can|could|should|might want to) )(?:run|execute|navigate|open|click)/i, type: 'suggesting_human_action' },
      { re: /(?:want me to|should I|shall I|would you like me to) (?:proceed|continue|go ahead)/i, type: 'permission_seeking' },
      { re: /(?:blocker|blocking issue|can'?t proceed (?:without|until))/i, type: 'claimed_blocker' },
      // B17 false-blocker shapes: deferring a doable task to a person / reverse-engineering.
      { re: /(?:needs?|requires?) (?:a )?human to/i, type: 'needs_human_to' },
      { re: /(?:needs?|requires?|need) (?:to )?reverse[- ]?engineer/i, type: 'needs_reverse_engineering' },
    ];

    // Orphan-TODO patterns — proposing future-self follow-up without infrastructure.
    // The danger: "later" without /schedule or /commit-action evaporates between
    // sessions because there is no automatic carry-over.
    const orphanPatterns = [
      { re: /queue (?:them |it |this )?(?:up |for )?(?:the )?(?:next session|later|future|follow[- ]?up)/i, type: 'queue_for_later' },
      { re: /(?:pick (?:this |it )?up|circle back|loop back|come back) (?:later|in (?:a |the )?(?:next|future|follow[- ]?up))/i, type: 'pick_up_later' },
      { re: /(?:in |for )(?:a |the |another )?(?:follow[- ]?up|next session|future session|later session)/i, type: 'follow_up_session' },
      { re: /(?:i'?ll |i will |i can |we (?:can|could) )(?:address|tackle|handle|fix|do|build|implement) (?:that |this |it )?(?:later|next time|in (?:the |a )?(?:future|follow[- ]?up))/i, type: 'self_promised_later' },
      { re: /(?:deferred|defer|deferring) (?:to|until|for) (?:a |the |next |another )?(?:follow[- ]?up|session|later|future)/i, type: 'explicit_defer' },
      { re: /(?:next time|future work|left for later|future iteration|TODO:?\\s*later)/i, type: 'future_work_marker' },
    ];

    // Anti-trigger: messages that DO back the deferral with infrastructure
    // get a pass — they are not orphan TODOs. The same message that mentions
    // /schedule, /commit-action, a cron expression, or a tracked deadline
    // is doing it right.
    const infrastructureBackedPatterns = [
      /\\/schedule\\b/i,
      /\\/commit[-_ ]?action\\b/i,
      /commit-action\\b/i,
      /scheduled (?:agent|run|cron|routine)/i,
      /cron expression|cron schedule/i,
      /tracked (?:commitment|deadline|action[- ]?item)/i,
      /follow[- ]?up (?:PR|commit|branch)\\b/i,
    ];
    const isInfrastructureBacked = infrastructureBackedPatterns.some(p => p.test(command));

    const inabilityMatches = inabilityPatterns.filter(p => p.re.test(command));

    // B17 second-opinion: a false blocker ONLY when the agent hands the task to the
    // user. Seeking a cross-model review the agent will fetch itself (GPT/Gemini/etc.)
    // is endorsed practice, not a deferral — so suppress when a model/agent is named.
    const selfFetchedReview = /\\b(?:gpt|gemini|grok|o3|cross[- ]?model|crossreview|another (?:agent|model))\\b/i.test(command);
    if (!selfFetchedReview && /second opinion/i.test(command)) {
      inabilityMatches.push({ re: /second opinion/i, type: 'wants_second_opinion' });
    }

    const orphanMatches = isInfrastructureBacked
      ? []  // Backed by real infra — not an orphan TODO.
      : orphanPatterns.filter(p => p.re.test(command));

    const allMatches = [...inabilityMatches, ...orphanMatches];
    if (allMatches.length === 0) process.exit(0);

    const checklist = [];

    if (inabilityMatches.length > 0) {
      checklist.push(
        'DEFERRAL DETECTED — Before claiming you cannot do something, verify:',
        '',
        '1. Did you check --help or docs for the tool you are using?',
        '2. Did you search for a token/API-based alternative to interactive auth?',
        '3. Do you already have credentials/tokens that might work? (env vars, CLI auth, saved configs)',
        '4. Did you try your OWN means? — computer use (read the screen, click buttons), terminal, send-keys into a live session, the dashboard, MCP tools. A button on screen is not a human-only blocker.',
        '5. Is this GENUINELY human-only? The tiny set: a password only the user knows, a CAPTCHA, a legal/billing/payment authorization, an account only they can grant, or a judgment call that is theirs.',
        '',
        'If ANY check might work — try it first, naming what you actually tried and what happened.',
        'The pattern: You are DESCRIBING work instead of DOING work. "Needs a human / a second opinion / reverse-engineering" is almost never true when you have computer use and a terminal.',
      );
    }

    if (orphanMatches.length > 0) {
      if (checklist.length > 0) checklist.push('');
      checklist.push(
        'ORPHAN-TODO TRAP DETECTED — You proposed deferring work to "later" or "next session" without backing infrastructure.',
        '',
        'Without one of these, the work will not actually happen:',
        '  - /schedule a remote agent (cron or one-shot) to do the work',
        '  - /commit-action with a deadline so it surfaces on the work queue',
        '  - A same-branch follow-up commit chained to merge before you stop',
        '  - Tying the deferred work to an existing tracked spec/issue',
        '',
        'If none of those apply, the deferral evaporates between sessions.',
        'Either back the deferral with infrastructure NOW, or do the work NOW.',
        '"I will get to it next time" is not infrastructure.',
      );
    }

    checklist.push('', 'Detected: ' + allMatches.map(m => m.type).join(', '));

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist.join('\\n') }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getSlopcheckGuardHook(): string {
    return `#!/usr/bin/env node
// Slopcheck guard — package-legitimacy check on install commands.
// PreToolUse hook for Bash. When the command is a package install
// (npm/pnpm/yarn/pip/cargo), it extracts the package names and checks
// whether each is already known to the project (present in a lockfile
// or manifest). Unfamiliar packages get a confirmation nudge — does NOT
// block, just surfaces the legitimacy question before a slopsquatted or
// hallucinated package gets installed.
//
// Cherry-picked into Instar 2026-05-23 from the GSD-Instar integration
// spike (gsd-executor Rule 3 exclusion: package installs are NOT
// auto-fixable because a failed/typo'd install may be a slopsquat).
// Signal-only — decision: approve + additionalContext. The agent decides.
//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level \`require(...)\` throws
// in ESM scope when the host package.json has "type":"module" — silently
// killed this PreToolUse guard on every tool call. See hook-event-reporter.js.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  // Install-command patterns → capture the args portion after the verb.
  const INSTALL_PATTERNS = [
    { re: /\\bnpm\\s+(?:i|install|add)\\s+([^&|;]+)/i, mgr: 'npm' },
    { re: /\\bpnpm\\s+(?:i|install|add)\\s+([^&|;]+)/i, mgr: 'pnpm' },
    { re: /\\byarn\\s+add\\s+([^&|;]+)/i, mgr: 'yarn' },
    { re: /\\bpip3?\\s+install\\s+([^&|;]+)/i, mgr: 'pip' },
    { re: /\\bcargo\\s+add\\s+([^&|;]+)/i, mgr: 'cargo' },
  ];

  // Flags to strip when extracting package names.
  const FLAG_RE = /^-/;

  function parsePackages(argStr) {
    return argStr
      .trim()
      .split(/\\s+/)
      .filter(tok => tok && !FLAG_RE.test(tok))
      // Strip version specifiers: pkg@1.2.3, pkg==1.2.3, pkg~=1.0
      .map(tok => tok.replace(/[@=~<>!].*$/, '').replace(/\\[.*$/, ''))
      .filter(Boolean);
  }

  // Returns the set of package names already known to the project from
  // any manifest/lockfile present in the project dir.
  function knownPackages(projectDir) {
    const known = new Set();
    const add = (name) => { if (name && typeof name === 'string') known.add(name.toLowerCase()); };

    // package.json deps + devDeps + lock
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (pkg[k]) Object.keys(pkg[k]).forEach(add);
      }
    } catch { /* no package.json */ }
    // package-lock.json — names appear as keys; cheap substring presence check via raw read
    let lockRaw = '';
    for (const lf of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'Cargo.toml', 'Cargo.lock', 'Pipfile', 'pyproject.toml']) {
      try { lockRaw += '\\n' + fs.readFileSync(path.join(projectDir, lf), 'utf-8'); } catch { /* absent */ }
    }
    return { known, lockRaw: lockRaw.toLowerCase() };
  }

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);
    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    let matched = null;
    for (const p of INSTALL_PATTERNS) {
      const m = command.match(p.re);
      if (m) { matched = { mgr: p.mgr, args: m[1] }; break; }
    }
    if (!matched) process.exit(0);

    const pkgs = parsePackages(matched.args);
    if (pkgs.length === 0) process.exit(0);

    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { known, lockRaw } = knownPackages(projectDir);

    // A package is "familiar" if it's in the manifest deps OR appears as a
    // token in any lockfile (covers transitive + already-installed).
    const unfamiliar = pkgs.filter(pkg => {
      const low = pkg.toLowerCase();
      if (known.has(low)) return false;
      // Word-boundary-ish presence in lockfiles (quoted or pathed)
      if (lockRaw.includes('"' + low + '"') || lockRaw.includes('/' + low) ||
          lockRaw.includes(low + '@') || lockRaw.includes(low + ' ') || lockRaw.includes(low + '==')) return false;
      return true;
    });

    if (unfamiliar.length === 0) process.exit(0);

    const checklist = [
      'SLOPCHECK — installing package(s) not already known to this project: ' + unfamiliar.join(', '),
      '',
      'Before installing an unfamiliar package, confirm it is legitimate (not a',
      'slopsquat or a hallucinated name):',
      '',
      '1. Is the spelling exactly right? Typosquats differ by one or two characters.',
      '2. Does the package actually exist on its registry, with real download counts',
      '   and a credible publisher? (npmjs.com / pypi.org / crates.io)',
      '3. Did YOU choose this package deliberately, or did it come from an LLM',
      '   suggestion that might be hallucinated?',
      '4. Is there a more-established alternative you already trust?',
      '',
      'This is a nudge, not a block. If the package is legitimate, proceed.',
    ];
    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: checklist.join('\\n') }));
  } catch { /* never block on errors */ }
  process.exit(0);
})();
`;
  }

  private getPostActionReflectionHook(): string {
    return `#!/usr/bin/env node
// Post-action reflection — evolution awareness after significant actions.
// PostToolUse hook for Bash. When the agent commits, deploys, or
// completes a task, captures the step for Living Skills and injects
// a brief reminder to capture learnings.
//
// "Every action is an opportunity to learn. Most of that learning is lost
// because nobody paused to ask: what did this teach me?"
//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. See hook-event-reporter.js header.

(async () => {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Significant action patterns — moments worth reflecting on
    const significantPatterns = [
      /git\\s+commit/i,
      /git\\s+push/i,
      /npm\\s+publish/i,
      /curl/i,
      /docker/i,
      /deploy/i,
      /prisma/i,
      /psql/i,
      /npm\\s+run\\s+build/i,
      /npm\\s+test/i,
      /instar\\s+server\\s+restart/i,
    ];

    const isSignificant = significantPatterns.some(p => p.test(command));

    // Living Skills: capture step to pending journal if enabled
    const cwd = input.cwd || process.cwd();
    const sessionId = process.env.INSTAR_SESSION_ID || '';
    const jobSlug = process.env.INSTAR_JOB_SLUG || '';

    if (isSignificant && sessionId && jobSlug) {
      // Check for sentinel file (created by JobScheduler when livingSkills.enabled)
      const instarDir = process.env.INSTAR_STATE_DIR || pathMod.join(cwd, '.instar');
      const sentinelPath = pathMod.join(instarDir, 'state', 'execution-journal', '_ls-enabled-' + jobSlug);

      try {
        if (fs.existsSync(sentinelPath)) {
          // Sanitize command before writing
          const REDACT = [
            /Bearer\\s+[A-Za-z0-9\\-._~+\\/]+=*/gi,
            /Authorization:\\s*[^\\s"']*/gi,
            /(api[_-]?key|apikey|api_secret)\\s*[:=]\\s*\\S+/gi,
            /(password|passwd|secret|token)\\s*[:=]\\s*\\S+/gi,
            /sk-[A-Za-z0-9]{20,}/g,
            /ghp_[A-Za-z0-9]{36}/g,
            /xox[baprs]-[A-Za-z0-9\\-]+/g,
          ];
          let sanitized = command;
          for (const p of REDACT) { p.lastIndex = 0; sanitized = sanitized.replace(p, '[REDACTED]'); }
          sanitized = sanitized.slice(0, 500);

          const pendingFile = pathMod.join(instarDir, 'state', 'execution-journal', '_pending.' + sessionId + '.jsonl');
          fs.mkdirSync(pathMod.dirname(pendingFile), { recursive: true });
          const entry = {
            sessionId,
            jobSlug,
            timestamp: new Date().toISOString(),
            command: sanitized,
            source: 'hook',
          };
          fs.appendFileSync(pendingFile, JSON.stringify(entry) + '\\n');
        }
      } catch { /* Living Skills capture failure is non-critical */ }
    }

    // Only show reflection reminder for the most significant actions
    const reflectionPatterns = [
      /git\\s+commit/i,
      /git\\s+push/i,
      /npm\\s+publish/i,
      /curl\\s+-X\\s+POST.*\\/deploy/i,
      /instar\\s+server\\s+restart/i,
    ];

    if (!reflectionPatterns.some(p => p.test(command))) process.exit(0);

    const reminder = [
      'POST-ACTION REFLECTION — Quick evolution check:',
      '',
      'Before moving on, consider:',
      '- Did this teach you something worth recording? → /learn',
      '- Did you notice a gap in your capabilities? → /gaps',
      '- Did you discover an improvement opportunity? → /evolve',
      '- Did you make a commitment to follow up? → /commit-action',
      '',
      'Skip if nothing notable. The value is in the pause, not the output.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
})();
`;
  }

  private getExternalCommunicationGuardHook(): string {
    return `#!/usr/bin/env node
// External communication guard — identity grounding before external posting.
// PreToolUse hook for Bash. Detects external posting commands (curl POST, API calls,
// CLI tools that post to external services). Injects identity re-read reminder.
//
// "An agent that knows itself is harder to compromise."
// "An agent that forgets itself posts things it shouldn't."

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    if (input.tool_name !== 'Bash') process.exit(0);

    const command = (input.tool_input || {}).command || '';
    if (!command) process.exit(0);

    // Patterns that indicate external posting
    const postingPatterns = [
      /curl\\s.*-X\\s+POST/i,
      /curl\\s.*-X\\s+PUT/i,
      /curl\\s.*-X\\s+PATCH/i,
      /curl\\s.*-d\\s+['"]/i,
      /curl\\s.*--data/i,
      /gh\\s+issue\\s+(?:comment|create)/i,
      /gh\\s+pr\\s+(?:comment|create|review)/i,
      /gh\\s+api\\s+graphql.*mutation/i,
      /sendgrid|mailgun|ses\\.amazonaws.*send/i,
      /telegram-reply/i,
      /send-email/i,
      /slack.*(?:chat\\.postMessage|send)/i,
    ];

    if (!postingPatterns.some(p => p.test(command))) process.exit(0);

    // Exempt: localhost, internal APIs, health checks
    if (/localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0/i.test(command)) process.exit(0);
    if (/curl\\s+-s\\s+https?:\\/\\/[^\\s]+\\s*$/i.test(command)) process.exit(0);  // Simple GET
    if (/heartbeat|keepalive|health/i.test(command)) process.exit(0);

    const reminder = [
      'EXTERNAL COMMUNICATION DETECTED — Identity grounding check:',
      '',
      'Before posting externally, verify:',
      '1. Have you read .instar/AGENT.md recently in this session?',
      '2. Does this message represent who you are and your principles?',
      '3. Are you posting something you would stand behind across sessions?',
      '4. Is the tone and content consistent with your identity?',
      '',
      'Security Through Identity: An agent that knows itself is harder to compromise.',
    ].join('\\n');

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: reminder }));
  } catch { /* don't break on errors */ }
  process.exit(0);
});
`;
  }

  private getExternalOperationGateHook(): string {
    return `#!/usr/bin/env node
// External operation gate — structural safety for external service operations.
// PreToolUse hook. Intercepts MCP tool calls to external services and evaluates
// risk before allowing execution. Structure > Willpower.
//
// Born from the OpenClaw email deletion incident: an agent deleted 200+ emails
// because nothing distinguished safe reads from destructive bulk deletes.
//
// Uses global fetch() (Node.js 18+) — no CommonJS imports needed.

// Read tool input from stdin
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';

    // Only intercept MCP tools (external service calls)
    if (!toolName.startsWith('mcp__')) {
      process.exit(0); // Not an MCP tool — pass through
    }

    // Extract service name from mcp__<service>__<action>
    const parts = toolName.split('__');
    if (parts.length < 3) {
      process.exit(0); // Malformed MCP tool name — pass through
    }

    const service = parts[1];
    const action = parts.slice(2).join('_');

    // Classify mutability from action name
    let mutability = 'read';
    if (/^(delete|remove|trash|purge|destroy|drop|clear)/.test(action)) {
      mutability = 'delete';
    } else if (/^(send|create|post|write|add|insert|new|compose|publish)/.test(action)) {
      mutability = 'write';
    } else if (/^(update|modify|edit|patch|rename|move|change|set|toggle|enable|disable)/.test(action)) {
      mutability = 'modify';
    }
    // Everything else defaults to 'read' (get, list, search, fetch, check, etc.)

    // Read operations are always safe — fast-path
    if (mutability === 'read') {
      process.exit(0);
    }

    // Classify reversibility
    let reversibility = 'reversible';
    if (/^(send|publish|post|destroy|purge|drop)/.test(action)) {
      reversibility = 'irreversible';
    } else if (/^(delete|remove|trash)/.test(action)) {
      reversibility = 'partially-reversible';
    }

    // Estimate item count from tool_input
    const toolInput = input.tool_input || {};
    let itemCount = 1;
    for (const key of Object.keys(toolInput)) {
      const val = toolInput[key];
      if (Array.isArray(val)) {
        itemCount = Math.max(itemCount, val.length);
      }
    }

    // Build description
    const description = action.replace(/_/g, ' ') + ' on ' + service;

    // Read config (port + auth token) via dynamic import to stay ESM-compatible.
    // Auth-token resolution: INSTAR_AUTH_TOKEN env first (SessionManager injects
    // it into every spawned session, survives secret-externalization), legacy
    // plaintext-config fallback with a string-type guard so the { secret: true }
    // placeholder produced by SecretMigrator can never leak through as a Bearer.
    let port = 4321;
    let authToken = process.env.INSTAR_AUTH_TOKEN || '';
    try {
      const nodeFs = await import('node:fs');
      const configPath = (process.env.CLAUDE_PROJECT_DIR || '.') + '/.instar/config.json';
      const raw = nodeFs.readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw);
      port = cfg.port || 4321;
      if (!authToken && typeof cfg.authToken === 'string') authToken = cfg.authToken;
    } catch { /* use defaults */ }

    // Call the gate API using global fetch (Node 18+)
    const postData = JSON.stringify({
      service,
      mutability,
      reversibility,
      description,
      itemCount,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch('http://127.0.0.1:' + port + '/operations/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body: postData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const decision = await res.json();

      const actionDecision = decision.action;
      const permitsOperation = actionDecision === 'proceed' || actionDecision === 'allow';

      if (actionDecision === 'block') {
        process.stderr.write('BLOCKED: External operation gate denied this action.\\n');
        process.stderr.write('Reason: ' + (decision.reason || 'Operation not permitted') + '\\n');
        process.stderr.write('Service: ' + service + ', Action: ' + action + '\\n');
        process.exit(2);
      }

      if (actionDecision === 'show-plan') {
        const ctx = [
          '=== EXTERNAL OPERATION GATE: APPROVAL REQUIRED ===',
          'Operation: ' + description,
          'Risk: ' + (decision.riskLevel || 'unknown'),
          decision.plan ? 'Plan: ' + decision.plan : '',
          decision.checkpoint ? 'Checkpoint: pause after ' + decision.checkpoint.afterCount + ' items' : '',
          '',
          'Show this plan to the user and get explicit approval before proceeding.',
          'If the user has not approved this specific operation, DO NOT PROCEED.',
          '=== END GATE ===',
        ].filter(Boolean).join('\\n');

        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: ctx,
        }));
        process.exit(0);
      }

      if (actionDecision === 'suggest-alternative' && decision.alternative) {
        process.stdout.write(JSON.stringify({
          decision: 'approve',
          additionalContext: 'External Operation Gate suggests: ' + decision.alternative,
        }));
        process.exit(0);
      }

      if (!permitsOperation) {
        process.stderr.write('BLOCKED: External operation gate returned an unknown action.\\n');
        process.stderr.write('Action: ' + String(actionDecision || 'missing') + '\\n');
        process.stderr.write('Service: ' + service + ', Action: ' + action + '\\n');
        process.exit(2);
      }

      // Identity grounding for external write/send/publish operations.
      // Dawn pattern (grounding-enforcement): agents must be grounded in
      // identity before any public-facing action. The gate approved the
      // operation — now inject identity context so the agent writes as itself.
      if ((mutability === 'write' || mutability === 'modify') && reversibility === 'irreversible') {
        const nodeFs = await import('node:fs');
        const agentMdPath = (process.env.CLAUDE_PROJECT_DIR || '.') + '/.instar/AGENT.md';
        let identitySnippet = '';
        try {
          const content = nodeFs.readFileSync(agentMdPath, 'utf-8');
          // Extract first 500 chars of identity for context injection
          identitySnippet = content.slice(0, 500).trim();
        } catch { /* AGENT.md not found — skip identity injection */ }

        if (identitySnippet) {
          const groundingCtx = [
            '=== IDENTITY GROUNDING (pre-' + action.replace(/_/g, ' ') + ') ===',
            '',
            identitySnippet,
            identitySnippet.length >= 500 ? '...' : '',
            '',
            'Verify: Does this ' + action.replace(/_/g, ' ') + ' represent who you are?',
            '=== END GROUNDING ===',
          ].filter(Boolean).join('\\n');

          process.stdout.write(JSON.stringify({
            decision: 'approve',
            additionalContext: groundingCtx,
          }));
          process.exit(0);
        }
      }

      process.exit(0);
    } catch {
      clearTimeout(timeout);
      process.exit(0); // Server unreachable or timeout — fail open
    }
  } catch {
    process.exit(0); // Parse error — fail open
  }
});
`;
  }

  /**
   * Apply the HTTP 408 ambiguous-outcome migration to an existing reply script
   * if and only if:
   *   - the file exists (we never install these from here — only upgrade),
   *   - its header matches the shipped version (so we don't stomp custom scripts),
   *   - and it does NOT already handle HTTP 408.
   *
   * Used by migrateScripts() for slack-reply.sh and whatsapp-reply.sh. The
   * telegram-reply.sh migration uses similar logic inline because it ALSO
   * installs on first run (hasTelegram gate); these two are upgrade-only.
   */
  /**
   * Known-shipped SHA-256 hashes of `src/templates/scripts/telegram-reply.sh`.
   *
   * The migrator overwrites an on-disk copy only when its SHA matches one
   * of these — meaning it is a verbatim prior shipped version. Any other
   * content (user customization, partial edits, accidental damage) is
   * preserved. The new template is written alongside as `.new` and a
   * degradation event is raised so the operator can resolve it manually.
   *
   * Add the prior shipped SHA when shipping a new template; never remove
   * old SHAs (they remain valid migration sources).
   */
  // eslint-disable-next-line @typescript-eslint/naming-convention
  public static readonly TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS: ReadonlySet<string> = new Set([
    // Tier-1 initial-init shipped version. Shipped at 362ff59d.
    '98f70b86856e37f2719c39ecec152adf07ec30ce73c8134ab831b35c5b1c25b3',
    // Rebrand to Instar (no behavioral change). Shipped at 686f5758.
    '6ebc835e0077dc1cd52ec15820722b7059cf11bf5796775902f82034d43b29c4',
    // Batch feedback fixes — auth headers, job topics race, session limits.
    // Shipped at d28120f0.
    'ce73a2fd1941381b63eb591d7c30ed761496202437a8c7fffa4926c6dfa2b7cb',
    // Tone-gate inline check on outbound messaging (no 408 handling yet).
    // Shipped at 2cb50a9a.
    'f3aa0c8aae3f3275d0efb45b333ad83c14f7513a9e27c743039a9a113c0d16ff',
    // Adds 120s timeout + HTTP 408 ambiguous-outcome path (no port-from-
    // config yet). Shipped at a049fc5f.
    '4f8787df1bf6384545dd7f19093fd77daa1bf993ed48a8ab02b6598d41a2007c',
    // Pre-port-config version (HTTP 408 handling, INSTAR_PORT-or-4040 default,
    // no agent-id header). Shipped through 2026-04-27.
    '3d08c63c6280d0a7ba94a345c259673a461ee5c1d116cb47c95c7626c67cee23',
    // Layer 1 shipped version (port-from-config + agent-id header, no
    // recoverable-class detection). Shipped 2026-04-27 with the Layer 1
    // PR #100. Adding here so the Layer 2 migration cleanly upgrades from
    // a Layer-1-deployed copy without producing a `.new` candidate.
    '5ec2eb19bf35310471f107cb54219097698abad1c11166eb14daf746a63a2f08',
    // Layer 2 shipped version (durable SQLite queue + structured failure
    // events). Shipped 2026-04-27 with the Layer 2 PR #101. Recorded here
    // (rather than left as the implicit current-template SHA) because the
    // verifier and lint both treat any deployed SHA matching this set as
    // a known-shipped instar version, not user-modified content.
    '371d7e8f4f72146bf8bd07115873bdbbaaf32e851ac6e1318ba5b8929cd06e68',
  ]);

  /**
   * SHA-based migrator for telegram-reply.sh — replaces marker-string
   * detection with content-hash detection. See spec
   * docs/specs/telegram-delivery-robustness.md § Layer 1 "Migration".
   *
   * Three branches:
   *   - on-disk SHA ∈ prior-shipped → back up and overwrite with new template.
   *   - on-disk SHA == new-template SHA → no-op (idempotent).
   *   - otherwise → write `<scriptPath>.new`, raise a
   *     `relay-script-modified-locally` degradation event, leave the
   *     original untouched.
   */
  private migrateReplyScriptToPortConfig(opts: {
    scriptPath: string;
    newContent: string;
    label: string;
    stateDir: string;
    result: MigrationResult;
  }): void {
    let existing: string;
    try {
      existing = fs.readFileSync(opts.scriptPath, 'utf-8');
    } catch (err) {
      opts.result.errors.push(
        `${opts.label} migration: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const existingSha = crypto.createHash('sha256').update(existing).digest('hex');
    const newSha = crypto.createHash('sha256').update(opts.newContent).digest('hex');

    if (existingSha === newSha) {
      // Idempotent path — already on the new template. Assert this by
      // recording a no-op result; never write, never back up.
      opts.result.skipped.push(`${opts.label} (already current)`);
      return;
    }

    if (PostUpdateMigrator.TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS.has(existingSha)) {
      // Backup-then-overwrite. Backup directory lives under the agent's
      // state dir (so it follows backup/restore semantics already
      // configured for .instar/).
      const backupDir = path.join(opts.stateDir, 'backups');
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(
          backupDir,
          `telegram-reply.sh.${Date.now()}`
        );
        fs.writeFileSync(backupPath, existing, { mode: 0o644 });
        fs.writeFileSync(opts.scriptPath, opts.newContent, { mode: 0o755 });
        opts.result.upgraded.push(
          `${opts.label} (upgraded to port-from-config + agent-id binding; ` +
          `prior version backed up to ${path.relative(opts.stateDir, backupPath)})`
        );
      } catch (err) {
        opts.result.errors.push(
          `${opts.label} migration: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    // Unknown content (user-modified or unknown version). Write a `.new`
    // candidate next to the original and raise a degradation event so
    // the operator can resolve it without us stomping their changes.
    //
    // Idempotency: if a `.new` file already exists with byte-identical
    // content (e.g., this is the second `instar update` against the same
    // user-modified script), skip the rewrite and the degradation event
    // so the operator doesn't get duplicate noise on every upgrade.
    const candidatePath = `${opts.scriptPath}.new`;
    let candidateAlreadyCurrent = false;
    try {
      const existingCandidate = fs.readFileSync(candidatePath, 'utf-8');
      if (existingCandidate === opts.newContent) {
        candidateAlreadyCurrent = true;
      }
    } catch {
      // No existing .new file — fall through to write.
    }

    if (!candidateAlreadyCurrent) {
      try {
        fs.writeFileSync(candidatePath, opts.newContent, { mode: 0o755 });
      } catch (err) {
        opts.result.errors.push(
          `${opts.label} migration: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      // Only fire the degradation event the first time we detect the
      // drift OR when the new template content has shifted since the
      // last `.new` write. Re-running the migrator on the same unknown
      // on-disk SHA + same new template SHA is a no-op event-wise.
      try {
        const reporter = DegradationReporter.getInstance();
        if (reporter && typeof reporter.report === 'function') {
          reporter.report({
            feature: 'relay-script-modified-locally',
            primary: 'overwrite shipped relay script with new template',
            fallback: 'wrote new template alongside as .new — operator review required',
            reason:
              `${opts.label} content does not match any prior shipped SHA ` +
              `(found sha256:${existingSha.slice(0, 12)}…). New template ` +
              `written to ${path.basename(candidatePath)}.`,
            impact:
              'Relay script keeps running with user-modified content; the ' +
              'port-from-config + agent-id binding fix is NOT active until ' +
              'the operator reconciles the .new file.',
          });
        }
      } catch {
        // DegradationReporter is best-effort; don't block migration on it.
      }
    }

    opts.result.skipped.push(
      `${opts.label} (user-modified — new version ` +
      `${candidateAlreadyCurrent ? 'already' : ''} written to ${path.basename(candidatePath)})`
    );
  }

  private migrateReplyScriptTo408(opts: {
    scriptPath: string;
    templateFilename: string;
    shippedMarker: string;
    label: string;
    result: MigrationResult;
  }): void {
    if (!fs.existsSync(opts.scriptPath)) return; // Not installed — not our responsibility here
    try {
      const existing = fs.readFileSync(opts.scriptPath, 'utf-8');
      const looksShipped = existing.includes(opts.shippedMarker);
      const hasNewHandling = existing.includes('HTTP_CODE" = "408"');
      // Secret-externalization survivability marker: the canonical auth
      // resolver pattern uses INSTAR_AUTH_TOKEN env first. Existing scripts
      // that have the 408 marker but still read authToken straight from
      // config.json silently 403 after secret-externalization (the
      // 2026-05-29 telegram-topic-context incident). Treat the env-first
      // pattern as a separate upgrade marker so a deployed-but-stale script
      // gets refreshed rather than skipped as "already up to date".
      const hasAuthEnvHandling = existing.includes('INSTAR_AUTH_TOKEN');
      const fullyCurrent = hasNewHandling && hasAuthEnvHandling;
      if (!looksShipped || fullyCurrent) {
        opts.result.skipped.push(`${opts.label} (already up to date or customized)`);
        return;
      }
      const template = this.loadRelayTemplate(opts.templateFilename);
      if (!template) {
        opts.result.errors.push(`${opts.label}: template file not found`);
        return;
      }
      fs.writeFileSync(opts.scriptPath, template, { mode: 0o755 });
      const reason = hasNewHandling
        ? 'auth-env-first (secret-externalization survivability)'
        : 'HTTP 408 ambiguous-outcome handling';
      opts.result.upgraded.push(`${opts.label} (upgraded to ${reason})`);
    } catch (err) {
      opts.result.errors.push(`${opts.label} migration: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Read a reply-script template from src/templates/scripts/.
   * Returns null if the template file cannot be located (shouldn't happen in
   * a healthy install). The caller is responsible for handling the null case.
   */
  private loadRelayTemplate(filename: string): string | null {
    return this.loadTemplate('scripts', filename);
  }

  private getTelegramReplyScript(): string {
    // Read the canonical template from the templates directory. Keeping this
    // in sync with src/commands/init.ts (scaffold-time installer) matters —
    // both paths must ship the same HTTP 408 handling, or an upgraded agent
    // would still duplicate-send if it re-ran init after the upgrade.
    // Same pattern as getConvergenceCheck() above.
    const template = this.loadRelayTemplate('telegram-reply.sh');
    if (template !== null) {
      return template;
    }
    // Fallback: minimal inline version that still handles HTTP 408 correctly.
    // Used only if template file isn't found (shouldn't happen in a healthy
    // install). The full-featured version — auth header, 422 tone-gate UX,
    // 408 ambiguous-outcome — lives in src/templates/scripts/telegram-reply.sh.
    const port = this.config.port;
    return `#!/bin/bash
# telegram-reply.sh — fallback version (template file not found).
TOPIC_ID="$1"
shift
MSG="\${*:-$(cat)}"
PORT="\${INSTAR_PORT:-${port}}"
JSON_MSG=$(printf '%s' "$MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null)
RESPONSE=$(curl -s -w "\\n%{http_code}" -X POST "http://localhost:\${PORT}/telegram/reply/\${TOPIC_ID}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"text\\":\${JSON_MSG}}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
if [ "$HTTP_CODE" = "200" ]; then
  echo "Sent $(echo "$MSG" | wc -c | tr -d ' ') chars to topic $TOPIC_ID"
elif [ "$HTTP_CODE" = "408" ]; then
  echo "AMBIGUOUS (HTTP 408): server timed out; send may have completed — verify before retrying." >&2
  echo "AMBIGUOUS (HTTP 408): outcome unknown — verify in conversation before retrying"
  exit 0
else
  echo "Failed (HTTP $HTTP_CODE): $BODY" >&2
  exit 1
fi
`;
  }

  private getHealthWatchdog(): string {
    const port = this.config.port;
    const projectName = this.config.projectName;
    const escapedProjectDir = this.config.projectDir.replace(/'/g, "'\\''");
    return `#!/bin/bash
# health-watchdog.sh — Monitor instar server and auto-recover.
# Install as cron: */5 * * * * '${path.join(this.config.projectDir, '.claude/scripts/health-watchdog.sh').replace(/'/g, "'\\''")}'

PORT="${port}"
SERVER_SESSION="${projectName}-server"
PROJECT_DIR='${escapedProjectDir}'
TMUX_PATH=$(which tmux 2>/dev/null || echo "/opt/homebrew/bin/tmux")

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:\${PORT}/health" 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then exit 0; fi

echo "[\$(date -Iseconds)] Server not responding. Restarting..."
$TMUX_PATH kill-session -t "=\${SERVER_SESSION}" 2>/dev/null
sleep 2
cd "$PROJECT_DIR" && npx instar server start
echo "[\$(date -Iseconds)] Server restart initiated"
`;
  }

  private getConvergenceCheck(): string {
    // Read the convergence check template from the templates directory.
    // This file is the heuristic quality gate that runs before external messaging.
    const template = this.loadTemplate('scripts', 'convergence-check.sh');
    if (template !== null) {
      return template;
    }
    // Fallback: use inline version so migration doesn't fail
    return this.getConvergenceCheckInline();
  }

  // ── Scope Coherence Hooks ─────────────────────────────────────────

  private getScopeCoherenceCollectorHook(): string {
    const port = this.config.port;
    return `#!/usr/bin/env node
// Scope Coherence Collector — PostToolUse hook
// Tracks implementation depth (Edit/Write/Bash) vs scope-checking actions (Read docs).
// The 232nd Lesson: Implementation depth narrows scope.
//
// This hook records each tool action locally. Fast path — no network call.
// State persists in .instar/state/scope-coherence.json via the server API.

// CJS imports — this is a standalone hook script, not an ESM module
//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level \`require(...)\` throws in
// ESM scope when the host has "type":"module" — silently killed this hook on
// every fire. See hook-event-reporter.js header for the documented pattern.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

const STATE_FILE = path.join('.instar', 'state', 'scope-coherence.json');
const SCOPE_DOC_PATTERNS = [
  'docs/', 'specs/', 'SPEC', 'PROPOSAL', 'DESIGN', 'ARCHITECTURE',
  'README', '.instar/AGENT.md', '.instar/USER.md', '.claude/context/',
  '.claude/grounding/', 'CLAUDE.md'
];
const SCOPE_DOC_EXTENSIONS = ['.md', '.txt', '.rst'];
const QUERY_PREFIXES = [
  'git status', 'git log', 'git diff', 'ls ', 'cat ', 'grep ',
  'echo ', 'which ', 'head ', 'tail ', 'wc ', 'pwd', 'date'
];
const GROUNDING_SKILLS = ['grounding', 'dawn', 'reflect', 'introspect', 'session-bootstrap'];

function isScopeDoc(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  if (SCOPE_DOC_PATTERNS.some(p => lower.includes(p.toLowerCase()))) return true;
  const parts = filePath.split('/');
  const name = parts[parts.length - 1] || '';
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const ext = name.slice(dot);
    const stem = name.slice(0, dot);
    if (SCOPE_DOC_EXTENSIONS.includes(ext) && stem === stem.toUpperCase() && stem.length > 3) return true;
  }
  return false;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return {
    implementationDepth: 0, lastScopeCheck: null, lastCheckpointPrompt: null,
    sessionDocsRead: [], checkpointsDismissed: 0, lastImplementationTool: null, sessionStart: null
  };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    const agentId = input.agent_id || null;
    const agentType = input.agent_type || null;
    const state = loadState();
    const now = new Date().toISOString();
    if (!state.sessionStart) state.sessionStart = now;
    // Track agent context (M4: Claude Code now enriches all hook events)
    if (agentId) {
      if (!state.agentActivity) state.agentActivity = {};
      if (!state.agentActivity[agentId]) state.agentActivity[agentId] = { type: agentType, actions: 0 };
      state.agentActivity[agentId].actions++;
    }

    if (toolName === 'Edit' || toolName === 'Write') {
      state.implementationDepth += 1;
      state.lastImplementationTool = toolName + ':' + now;
    } else if (toolName === 'Bash') {
      const cmd = (toolInput.command || '').trim();
      const isQuery = QUERY_PREFIXES.some(p => cmd.startsWith(p));
      if (!isQuery && cmd.length > 10) {
        state.implementationDepth += 1;
        state.lastImplementationTool = 'Bash:' + now;
      }
    } else if (toolName === 'Read') {
      const fp = toolInput.file_path || '';
      if (isScopeDoc(fp)) {
        state.implementationDepth = Math.max(0, state.implementationDepth - 10);
        state.lastScopeCheck = now;
        if (!state.sessionDocsRead.includes(fp)) {
          state.sessionDocsRead.push(fp);
          if (state.sessionDocsRead.length > 20) state.sessionDocsRead = state.sessionDocsRead.slice(-20);
        }
      }
    } else if (toolName === 'Skill') {
      const skill = toolInput.skill || '';
      if (GROUNDING_SKILLS.includes(skill)) {
        state.implementationDepth = 0;
        state.lastScopeCheck = now;
      }
    }

    saveState(state);
  } catch {}
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
})();

`;
  }

  private getScopeCoherenceCheckpointHook(): string {
    const port = this.config.port;
    return `#!/usr/bin/env node
// Scope Coherence Checkpoint — Stop hook
// The structural zoom-out. Forces agents to step back and check the big picture
// when they've been deep in implementation without reading design docs.
//
// The 232nd Lesson: Implementation depth narrows scope.
// "See code -> wire it -> declare done" vs "read spec -> understand scope -> build right thing"
//
// Calls the Instar server for active job context to make the checkpoint actionable.

// CJS imports — this is a standalone hook script, not an ESM module
//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level \`require(...)\` throws in
// ESM scope when the host has "type":"module" — silently killed this hook on
// every fire. See hook-event-reporter.js header for the documented pattern.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const http = await import('node:http');

const STATE_FILE = path.join('.instar', 'state', 'scope-coherence.json');
const DEPTH_THRESHOLD = 20;
const COOLDOWN_MS = 30 * 60 * 1000;  // 30 minutes
const MIN_AGE_MS = 5 * 60 * 1000;    // 5 minutes

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { implementationDepth: 0 };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function fetchActiveJob() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:${port}/context/active-job', { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    // ALLOW = empty stdout + exit 0. We deliberately do NOT emit
    // {decision:'approve'} on the allow paths: codex's Stop-hook contract treats
    // any non-empty stdout that isn't a recognized block decision as invalid
    // ('hook returned invalid stop hook JSON output'), so an explicit approve-JSON
    // breaks every codex session completion. Claude treats empty == approve, so
    // emitting nothing is byte-equivalent there. Only the BLOCK path writes JSON
    // (codex accepts {decision:'block',...}). Sibling of #604 (autonomous-stop-hook).
    let _input = {};
    try { _input = JSON.parse(data); } catch {}
    if (_input && _input.stop_hook_active) {
      // Re-entry guard: never re-block a correction continuation. (allow = empty)
      process.exit(0);
      return;
    }

    // Never block headless/job sessions — no human to dismiss the block.
    // INSTAR_SESSION_ID is set for all server-spawned sessions.
    if (process.env.INSTAR_SESSION_ID && !process.env.TERM_PROGRAM) {
      process.exit(0);
      return;
    }

    const state = loadState();
    const now = Date.now();
    const depth = state.implementationDepth || 0;

    if (depth < DEPTH_THRESHOLD) {
      process.exit(0);
      return;
    }

    // Check cooldown
    if (state.lastCheckpointPrompt) {
      const elapsed = now - new Date(state.lastCheckpointPrompt).getTime();
      if (elapsed < COOLDOWN_MS) {
        process.exit(0);
        return;
      }
    }

    // Check minimum session age
    if (state.sessionStart) {
      const age = now - new Date(state.sessionStart).getTime();
      if (age < MIN_AGE_MS) {
        process.exit(0);
        return;
      }
    }

    // Fetch active job context from server
    const jobData = await fetchActiveJob();
    const dismissed = state.checkpointsDismissed || 0;
    const docsRead = state.sessionDocsRead || [];

    let jobContext = '';
    if (jobData && jobData.active && jobData.job) {
      jobContext = '\\nYou are running the **' + jobData.job.name + '** job.\\n' +
        'Scope: ' + (jobData.job.description || 'No description') + '\\n' +
        'Are you still within the job\\'s boundaries?\\n';
    }

    let docsContext = '';
    if (docsRead.length > 0) {
      const recent = docsRead.slice(-5).map(d => d.split('/').pop());
      docsContext = '\\nDocs read this session: ' + recent.join(', ');
    } else {
      docsContext = '\\nNo design docs, specs, or proposals have been read this session.';
    }

    let escalation = '';
    if (dismissed >= 3) {
      escalation = '\\n\\nYou\\'ve dismissed ' + dismissed + ' scope checkpoints. ' +
        'Dismissing scope checks during deep implementation is how scope collapse happens.';
    }

    const reason = 'SCOPE COHERENCE CHECK\\n\\n' +
      'You\\'ve been deep in implementation for ' + depth + ' actions without reading design documents.\\n' +
      'Implementation depth narrows perception.\\n' +
      jobContext +
      '\\nStep back and ask yourself:\\n' +
      '\\n1. WHO AM I? What role am I filling right now?\\n' +
      '2. WHAT AM I WORKING ON? What\\'s the full scope? Is there a spec or proposal?\\n' +
      '3. BIG PICTURE — How does this fit into the larger system?\\n' +
      '4. HIGHER-LEVEL ELEMENTS — What architectural or cross-system aspects am I missing?\\n' +
      '5. COMPLETENESS — Am I considering all elements, or have I collapsed the scope?\\n' +
      docsContext + escalation +
      '\\n\\nOptions: Read the relevant spec/proposal, confirm scope awareness, or /grounding';

    // Record that we prompted
    state.lastCheckpointPrompt = new Date().toISOString();
    state.checkpointsDismissed = dismissed + 1;
    saveState(state);

    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
  } catch {
    // On any error, allow (empty stdout) — never emit approve-JSON (codex-unsafe).
  }
  process.exit(0);
})();

`;
  }

  private getFreeTextGuardHook(): string {
    // Read the hook from the templates directory instead of inline generation.
    // This avoids multi-layer escaping issues (TypeScript -> bash -> Python -> regex).
    const template = this.loadTemplate('hooks', 'free-text-guard.sh');
    if (template !== null) {
      return template;
    }
    throw new Error(
      `free-text-guard.sh template not found; checked ${this.templateCandidates('hooks', 'free-text-guard.sh').join(', ')}`,
    );
  }

  private getClaimInterceptHook(): string {
    return `#!/usr/bin/env node
// Claim Intercept — PostToolUse hook for catching false operational claims.
//
// The Proprioceptive Stack for Instar agents.
// Agents sometimes falsely deny capabilities they actually have.
// This hook cross-checks denial claims against Canonical State
// (quick-facts.json, project-registry.json) and injects corrections.
//
// Architecture: Two-layer detection
//   Layer 1: Regex fast-path (<1ms) — catches explicit denial patterns
//   Layer 2: Canonical State cross-check — verifies claims against ground truth
//
// Design principles:
//   - Never blocks — injects warnings via additionalContext
//   - Reads canonical state files directly (no server dependency)
//   - Only checks topically relevant output (skip pure code, grep, cat)
//   - Rate-limited to prevent latency stacking

//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level \`require(...)\` throws in
// ESM scope when the host has "type":"module" — silently killed this hook on
// every fire. See hook-event-reporter.js header for the documented pattern.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

const STATE_DIR = path.join('.instar', 'state');
const RATE_FILE = path.join(STATE_DIR, '.claim-intercept-last.tmp');
const RATE_LIMIT_MS = 10000; // 10 seconds between checks
const LOG_FILE = path.join(STATE_DIR, 'claim-intercept.log');

// ── Denial pattern templates ───────────────────────────────────
// These catch explicit claims of inability or missing capability.

const DENIAL_PATTERNS = [
  /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)\\s+(.{5,80})/i,
  /(?:don'?t|do not) have (?:access|credentials|a?n? ?(?:api|token|key|tool|script|capability))\\s*(?:for|to)?\\s*(.{3,60})?/i,
  /(?:no |not )(?:available|configured|set up|installed|deployed|running|accessible)\\b/i,
  /(?:isn'?t|is not|aren'?t|are not) (?:available|configured|set up|working|running|accessible)\\b/i,
  /(?:blocked|unavailable|disabled|suspended|broken|offline|unreachable)\\b/i,
  /(?:need|require)s? (?:the user|human|manual|someone) to/i,
  /(?:outside|beyond) (?:my|the agent'?s?) (?:capabilities|scope|access|authority)/i,
  /(?:no |don'?t have (?:a |any )?)(?:way|mechanism|method|means) to/i,
  /(?:not |never )(?:been )?(?:set up|configured|registered|deployed)/i,
];

// ── Topic relevance filter ─────────────────────────────────────
// Skip pure code output, file reads, grep results.

const EXEMPT_PATTERNS = [
  /^\\s*\\d+[:\\|]/m,                   // Line-numbered output (cat -n, grep -n)
  /^diff --git/m,                     // Git diffs
  /^\\+\\+\\+|^---/m,                    // Diff headers
  /^commit [a-f0-9]{40}/m,            // Git log
  /node_modules\\//,                   // Node modules paths
  /\\.test\\.[jt]s/,                    // Test file output
];

function isExempt(text) {
  return EXEMPT_PATTERNS.some(p => p.test(text));
}

// ── Rate limiter ───────────────────────────────────────────────

function checkRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE)) {
      const mtime = fs.statSync(RATE_FILE).mtimeMs;
      if (Date.now() - mtime < RATE_LIMIT_MS) return false;
    }
    fs.mkdirSync(path.dirname(RATE_FILE), { recursive: true });
    fs.writeFileSync(RATE_FILE, '');
    return true;
  } catch { return true; }
}

// ── Canonical State loader ─────────────────────────────────────

function loadCanonicalState() {
  const state = { facts: [], projects: [], antiPatterns: [] };
  try {
    const factsPath = path.join(STATE_DIR, 'quick-facts.json');
    if (fs.existsSync(factsPath)) {
      state.facts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'));
    }
  } catch {}
  try {
    const projPath = path.join(STATE_DIR, 'project-registry.json');
    if (fs.existsSync(projPath)) {
      state.projects = JSON.parse(fs.readFileSync(projPath, 'utf-8'));
    }
  } catch {}
  try {
    const apPath = path.join(STATE_DIR, 'anti-patterns.json');
    if (fs.existsSync(apPath)) {
      state.antiPatterns = JSON.parse(fs.readFileSync(apPath, 'utf-8'));
    }
  } catch {}
  return state;
}

// ── Cross-check claims against canonical state ─────────────────

function findContradictions(text, state) {
  const contradictions = [];
  const textLower = text.toLowerCase();

  // Check if any denied capability contradicts a quick fact
  for (const fact of state.facts) {
    const answerWords = fact.answer.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const questionWords = fact.question.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const allWords = [...answerWords, ...questionWords];

    // If the denial text mentions something related to a known fact
    for (const word of allWords) {
      if (textLower.includes(word)) {
        // Check if the text contains a denial near this word
        const wordIdx = textLower.indexOf(word);
        const context = textLower.substring(Math.max(0, wordIdx - 100), Math.min(textLower.length, wordIdx + 100));
        if (DENIAL_PATTERNS.some(p => p.test(context))) {
          contradictions.push({
            claim: 'Denied capability related to: ' + word,
            fact: fact.question + ' → ' + fact.answer,
            source: 'quick-facts.json (verified: ' + (fact.lastVerified || 'unknown') + ')',
          });
          break; // One contradiction per fact is enough
        }
      }
    }
  }

  // Check if denial mentions a registered project
  for (const proj of state.projects) {
    const projName = proj.name.toLowerCase();
    if (textLower.includes(projName)) {
      const nameIdx = textLower.indexOf(projName);
      const context = textLower.substring(Math.max(0, nameIdx - 100), Math.min(textLower.length, nameIdx + 100));
      if (DENIAL_PATTERNS.some(p => p.test(context))) {
        contradictions.push({
          claim: 'Denied access/capability for project: ' + proj.name,
          fact: proj.name + ' is registered at ' + proj.dir + (proj.deploymentTargets ? ' (deploys to: ' + proj.deploymentTargets.join(', ') + ')' : ''),
          source: 'project-registry.json',
        });
      }
    }
  }

  return contradictions;
}

// ── Main ───────────────────────────────────────────────────────

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';

    // Only check Bash, Write, Edit output
    if (!['Bash', 'Write', 'Edit'].includes(toolName)) process.exit(0);

    // Extract text content
    let text = '';
    if (toolName === 'Bash') {
      text = (input.tool_input || {}).command || '';
      // Also check stdout if available
      const result = input.tool_result || '';
      if (typeof result === 'string') text += ' ' + result;
    } else if (toolName === 'Write') {
      text = (input.tool_input || {}).content || '';
    } else if (toolName === 'Edit') {
      text = (input.tool_input || {}).new_string || '';
    }

    if (!text || text.length < 40) process.exit(0);
    if (isExempt(text)) process.exit(0);

    // Quick scan: does the text even contain a denial pattern?
    const hasDenial = DENIAL_PATTERNS.some(p => p.test(text));
    if (!hasDenial) process.exit(0);

    // Rate limit before loading canonical state
    if (!checkRateLimit()) process.exit(0);

    // Cross-check against canonical state
    const state = loadCanonicalState();
    if (state.facts.length === 0 && state.projects.length === 0) process.exit(0);

    const contradictions = findContradictions(text, state);
    if (contradictions.length === 0) process.exit(0);

    // Build warning message
    const details = contradictions.map(c =>
      '  CLAIM: ' + c.claim + '\\n' +
      '  FACT:  ' + c.fact + '\\n' +
      '  FROM:  ' + c.source
    ).join('\\n\\n');

    const warning = 'CLAIM-INTERCEPT: CONTRADICTION DETECTED\\n\\n' +
      'Your output contains claims that contradict canonical state:\\n\\n' +
      details + '\\n\\n' +
      'Do NOT repeat false claims. Revise your statement to match operational reality.\\n' +
      'Canonical state is compiled from verified registries. If you believe it is wrong,\\n' +
      'verify with: GET /state/quick-facts or check .instar/state/ files directly.';

    // Log the interception
    try {
      const logEntry = '[' + new Date().toISOString() + '] ' +
        'tool=' + toolName + ' | ' +
        'contradictions=' + contradictions.length + ' | ' +
        'claims=' + contradictions.map(c => c.claim.substring(0, 50)).join('; ') + '\\n';
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, logEntry);
    } catch {}

    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: warning }));
  } catch {}
  process.exit(0);
})();

`;
  }

  private getResponseReviewHook(): string {
    const port = this.config.port;
    return `#!/usr/bin/env node
// Response Review — Stop hook for the Coherence Gate response review pipeline.
//
// Thin client: reads stdin JSON, posts to the Instar server's /review/evaluate
// endpoint, and returns the verdict. All review logic lives server-side.
//
// Unlike other stop hooks, this does NOT skip when stop_hook_active is true.
// The CoherenceGate handles retry tracking and exhaustion internally.
// The hook always passes the stopHookActive flag so the server can decide.

//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level \`require(...)\` throws in
// ESM scope when the host has "type":"module" — silently killed this hook on
// every fire. See hook-event-reporter.js header for the documented pattern.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const http = await import('node:http');

// Read config for port and auth token. Token: env first (SessionManager injects
// INSTAR_AUTH_TOKEN per spawned session — survives secret-externalization), legacy
// plaintext-config fallback with a string-type guard so the { secret: true }
// placeholder produced by SecretMigrator can never leak as a Bearer.
let serverPort = ${port};
let authToken = process.env.INSTAR_AUTH_TOKEN || '';
try {
  const configPath = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(raw);
  serverPort = cfg.port || ${port};
  if (!authToken && typeof cfg.authToken === 'string') authToken = cfg.authToken;
} catch {}

// Check if response review is enabled in config
let reviewEnabled = false;
try {
  const configPath = path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.instar', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf-8');
  const cfg = JSON.parse(raw);
  reviewEnabled = cfg.responseReview && cfg.responseReview.enabled;
} catch {}

if (!reviewEnabled) {
  process.exit(0);
}

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    const input = JSON.parse(data);
    const message = input.last_assistant_message || '';

    // Skip empty or very short messages (greetings, etc.)
    if (!message || message.length < 20) {
      process.exit(0);
    }

    // Determine channel from environment
    const topicId = process.env.INSTAR_TELEGRAM_TOPIC;
    const sessionId = process.env.INSTAR_SESSION_ID || 'unknown';
    const channel = topicId ? 'telegram' : 'direct';
    const isExternalFacing = !!topicId; // Telegram = external

    // Build the review request
    const body = JSON.stringify({
      message,
      sessionId,
      stopHookActive: !!input.stop_hook_active,
      context: {
        channel,
        topicId: topicId ? parseInt(topicId, 10) : undefined,
        recipientType: 'primary-user',
        isExternalFacing,
      },
    });

    // Call the review endpoint with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch('http://127.0.0.1:' + serverPort + '/review/evaluate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        // Server error — fail open (approve)
        process.exit(0);
      }

      const result = await res.json();

      if (!result.pass) {
        // BLOCK — return feedback to the agent for revision
        const reason = result.feedback || 'Response did not pass coherence review.';
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason,
        }));
        process.exit(2);
      }

      // PASS — optionally include warnings
      if (result.warnings && result.warnings.length > 0) {
        process.stderr.write('[response-review] Warnings: ' + result.warnings.join('; ') + '\\n');
      }

      process.exit(0);
    } catch {
      // Network error or timeout — fail open
      clearTimeout(timeout);
      process.exit(0);
    }
  } catch {
    // JSON parse error on stdin — fail open
    process.exit(0);
  }
})();

`;
  }

  private getStopGateRouterHook(): string {
    const port = this.config.port;
    return `#!/usr/bin/env node
// Unjustified Stop Gate router.
//
// Thin client: reads Stop-hook JSON from stdin, asks the local Instar server
// for hot-path state, and in shadow/enforce mode submits trusted evidence
// metadata to /internal/stop-gate/evaluate. Shadow mode only records telemetry;
// enforce mode blocks only on a server-side "continue" decision.
//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. A bare top-level \`require(...)\` throws
// "require is not defined in ES module scope" when the host package.json has
// "type":"module" (which silently killed this gate — the gate meant to PREVENT
// unjustified silent stalls). A bare top-level \`import\` is a syntax error in
// CJS scope; dynamic import works in BOTH. See hook-event-reporter.js header.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const childProcess = await import('node:child_process');

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const configPath = path.join(projectDir, '.instar', 'config.json');
  let serverPort = ${port};
  // INSTAR_AUTH_TOKEN env first — SessionManager injects it per spawned session
  // and it survives secret-externalization. Legacy plaintext-config fallback
  // with string-type guard so the { secret: true } placeholder cannot leak.
  let authToken = process.env.INSTAR_AUTH_TOKEN || '';
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    serverPort = cfg.port || ${port};
    if (!authToken && typeof cfg.authToken === 'string') authToken = cfg.authToken;
  } catch {}

  function postJson(urlPath, payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch('http://127.0.0.1:' + serverPort + urlPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).then(async function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function getJson(urlPath, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch('http://127.0.0.1:' + serverPort + urlPath, {
      headers: { 'Authorization': 'Bearer ' + authToken },
      signal: controller.signal,
    }).then(async function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function git(args) {
    try {
      return childProcess.execFileSync('git', ['-C', projectDir].concat(args), {
        encoding: 'utf-8',
        timeout: 800,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  }

  function firstLine(value) {
    return String(value || '').split(/\\r?\\n/).filter(Boolean)[0] || null;
  }

  function listEvidenceArtifacts(sessionStartTs) {
    const out = git(['ls-files']);
    if (!out) return [];
    const files = out.split(/\\r?\\n/).filter(function (file) {
      if (!file) return false;
      if (!/\\.(md|markdown|json|jsonl|txt)$/i.test(file)) return false;
      return /(^|\\/)(docs\\/specs|specs|plans?|tasks?|upgrades|MEMORY\\.md|AGENTS\\.md)|spec|plan|handoff|todo|next|round/i.test(file);
    }).slice(0, 30);
    return files.map(function (file) {
      const introducingCommit = firstLine(git(['log', '--follow', '--format=%H', '--reverse', '--', file]));
      const latestCommit = firstLine(git(['log', '--format=%H', '-1', '--', file]));
      let createdThisSession = false;
      let modifiedThisSession = false;
      if (sessionStartTs && latestCommit) {
        const ts = Number(firstLine(git(['show', '-s', '--format=%ct', latestCommit])) || '0') * 1000;
        modifiedThisSession = ts >= sessionStartTs;
        if (introducingCommit) {
          const createdTs = Number(firstLine(git(['show', '-s', '--format=%ct', introducingCommit])) || '0') * 1000;
          createdThisSession = createdTs >= sessionStartTs;
        }
      }
      return {
        path: file,
        introducingCommit: introducingCommit,
        latestCommit: latestCommit,
        createdThisSession: createdThisSession,
        modifiedThisSession: modifiedThisSession,
      };
    });
  }

  function buildSignals(stopReason, message) {
    const text = String(stopReason || '') + '\\n' + String(message || '');
    return {
      mentionsContextLimit: /context|window|token|compact/i.test(text),
      mentionsFreshSession: /fresh session|new session|restart|continue in a new/i.test(text),
      claimsShouldStopForContext: /stop|pause|wrap up|hand off/i.test(text) && /context|fresh|compact/i.test(text),
    };
  }

  function exitOpen() {
    process.exit(0);
  }

  // Read the Stop-hook JSON from stdin (works in both CJS + ESM).
  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch {
    exitOpen();
    return;
  }

  let input;
  try {
    input = data ? JSON.parse(data) : {};
  } catch {
    exitOpen();
    return;
  }

  if (input.stop_hook_active) { exitOpen(); return; }
  const sessionId = String(input.session_id || input.sessionId || process.env.INSTAR_SESSION_ID || 'unknown');

  // ── Stated-continuation guard (mode-INDEPENDENT). ───────────────────────────
  // Catches the specific silent-stall pattern that shadow mode lets through: the
  // agent's FINAL message tells the user it is about to act this turn ("I'll
  // build X now", "starting now", "next phase: ship ...") and then the turn ENDS
  // without doing it. Blocks ONCE (the stop_hook_active guard above prevents a
  // loop) regardless of the gate's shadow/enforce mode — shadow is exactly when
  // these stalls slip through (telemetry only). The re-feed allows a clean exit:
  // do the work, OR send the user one honest message that you are stopping and
  // why. Pure substring matching (no regex-escape hazards in this template).
  (function statedContinuationGuard() {
    const lc = String(input.last_assistant_message || '').toLowerCase();
    if (lc.length < 8) return;
    function hasAny(arr) { for (let i = 0; i < arr.length; i++) { if (lc.indexOf(arr[i]) !== -1) return arr[i]; } return null; }
    const commit = hasAny([
      "i'm going to", 'i am going to', "i'll ", 'i will ', 'about to ', 'gonna ',
      'next phase', 'next step', 'next up', 'next round', 'kicking off',
      'getting started', 'starting now', 'on it', "i'll build", "i'll ship",
      "i'll continue", "i'll finish", "i'll fix", "i'll start", "i'll do",
    ]);
    const imminent = hasAny([
      ' now', 'right now', 'immediately', 'starting now', 'next phase',
      'next step', 'next up', 'this turn', 'this session', 'then i',
    ]);
    if (!commit || !imminent) return;
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: 'STOP-GATE (stated-continuation): your final message tells the user you are about to act ("' + commit + '" / "' + imminent + '") but you are ending the turn without doing it. Do NOT give the impression you are continuing and then stall silently. Either (a) actually do that work now, or (b) if you are genuinely blocked, finished, or need the user, send ONE short honest message saying you are stopping and exactly why — then you may stop. This guard fires once.',
    }));
    process.exit(2);
  })();

  try {
    const hot = await getJson('/internal/stop-gate/hot-path?session=' + encodeURIComponent(sessionId), 1500);
    if (!hot || hot.killSwitch || hot.mode === 'off' || hot.compactionInFlight) { exitOpen(); return; }

    const message = String(input.last_assistant_message || '');
    const stopReason = String(input.stop_reason || input.reason || message || '');
    const evidenceMetadata = {
      artifacts: listEvidenceArtifacts(hot.sessionStartTs || null),
      signals: buildSignals(stopReason, message),
      sessionStartTs: hot.sessionStartTs || null,
    };

    const result = await postJson('/internal/stop-gate/evaluate', {
      sessionId: sessionId,
      evidenceMetadata: evidenceMetadata,
      untrustedContent: {
        stopReason: stopReason,
        recentTurns: message ? [{ source: 'agent', text: message }] : [],
      },
    }, 2500);

    if (hot.mode === 'enforce' && result && result.decision === 'continue' && result.reminder) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reminder }));
      process.exit(2);
      return;
    }
    exitOpen();
  } catch {
    exitOpen();
  }
})();
`;
  }

  private getClaimInterceptResponseHook(): string {
    return `#!/usr/bin/env node
// Claim Intercept — Stop hook for catching false claims in direct responses.
//
// Complements the PostToolUse claim-intercept hook by checking the agent's
// direct text responses (the words between tool calls). This closes the gap
// where tool output is checked but conversational text goes unchecked.
//
// Architecture:
//   Stop hook — fires when the agent finishes a response turn.
//   Receives last_assistant_message from stdin.
//   Cross-checks against Canonical State.
//   If contradiction found: BLOCKS the stop (exit 2) to force correction.
//
// Guard against infinite loops:
//   If stop_hook_active is true, we're in a correction continuation — skip.

//
// ESM-SAFE: dynamic \`await import(...)\` inside an async IIFE so this runs in
// both CJS and ESM host package types. Bare top-level \`require(...)\` throws in
// ESM scope when the host has "type":"module" — silently killed this hook on
// every fire. See hook-event-reporter.js header for the documented pattern.

(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

const STATE_DIR = path.join('.instar', 'state');
const RATE_FILE = path.join(STATE_DIR, '.claim-intercept-last.tmp');
const RATE_LIMIT_MS = 10000;
const LOG_FILE = path.join(STATE_DIR, 'claim-intercept.log');

// Same denial patterns as PostToolUse hook
const DENIAL_PATTERNS = [
  /(?:I |i )(?:can'?t|cannot|am (?:not |un)able to)\\s+(.{5,80})/i,
  /(?:don'?t|do not) have (?:access|credentials|a?n? ?(?:api|token|key|tool|script|capability))\\s*(?:for|to)?\\s*(.{3,60})?/i,
  /(?:no |not )(?:available|configured|set up|installed|deployed|running|accessible)\\b/i,
  /(?:isn'?t|is not|aren'?t|are not) (?:available|configured|set up|working|running|accessible)\\b/i,
  /(?:blocked|unavailable|disabled|suspended|broken|offline|unreachable)\\b/i,
  /(?:need|require)s? (?:the user|human|manual|someone) to/i,
  /(?:outside|beyond) (?:my|the agent'?s?) (?:capabilities|scope|access|authority)/i,
  /(?:no |don'?t have (?:a |any )?)(?:way|mechanism|method|means) to/i,
  /(?:not |never )(?:been )?(?:set up|configured|registered|deployed)/i,
];

function checkRateLimit() {
  try {
    if (fs.existsSync(RATE_FILE)) {
      const mtime = fs.statSync(RATE_FILE).mtimeMs;
      if (Date.now() - mtime < RATE_LIMIT_MS) return false;
    }
    fs.mkdirSync(path.dirname(RATE_FILE), { recursive: true });
    fs.writeFileSync(RATE_FILE, '');
    return true;
  } catch { return true; }
}

function loadCanonicalState() {
  const state = { facts: [], projects: [] };
  try {
    const factsPath = path.join(STATE_DIR, 'quick-facts.json');
    if (fs.existsSync(factsPath)) {
      state.facts = JSON.parse(fs.readFileSync(factsPath, 'utf-8'));
    }
  } catch {}
  try {
    const projPath = path.join(STATE_DIR, 'project-registry.json');
    if (fs.existsSync(projPath)) {
      state.projects = JSON.parse(fs.readFileSync(projPath, 'utf-8'));
    }
  } catch {}
  return state;
}

function findContradictions(text, state) {
  const contradictions = [];
  const textLower = text.toLowerCase();

  for (const fact of state.facts) {
    const answerWords = fact.answer.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const questionWords = fact.question.toLowerCase().split(/\\s+/).filter(w => w.length > 3);
    const allWords = [...answerWords, ...questionWords];

    for (const word of allWords) {
      if (textLower.includes(word)) {
        const wordIdx = textLower.indexOf(word);
        const context = textLower.substring(Math.max(0, wordIdx - 100), Math.min(textLower.length, wordIdx + 100));
        if (DENIAL_PATTERNS.some(p => p.test(context))) {
          contradictions.push({
            claim: 'Denied capability related to: ' + word,
            fact: fact.question + ' → ' + fact.answer,
            source: 'quick-facts.json',
          });
          break;
        }
      }
    }
  }

  for (const proj of state.projects) {
    const projName = proj.name.toLowerCase();
    if (textLower.includes(projName)) {
      const nameIdx = textLower.indexOf(projName);
      const context = textLower.substring(Math.max(0, nameIdx - 100), Math.min(textLower.length, nameIdx + 100));
      if (DENIAL_PATTERNS.some(p => p.test(context))) {
        contradictions.push({
          claim: 'Denied access/capability for project: ' + proj.name,
          fact: proj.name + ' is registered at ' + proj.dir,
          source: 'project-registry.json',
        });
      }
    }
  }

  return contradictions;
}

  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch { process.exit(0); }

  try {
    const input = JSON.parse(data);

    // Guard: if we're already in a Stop hook continuation, skip
    if (input.stop_hook_active) process.exit(0);

    const message = input.last_assistant_message || '';
    if (!message || message.length < 80) process.exit(0);

    // Quick scan for denial patterns
    const hasDenial = DENIAL_PATTERNS.some(p => p.test(message));
    if (!hasDenial) process.exit(0);

    // Rate limit
    if (!checkRateLimit()) process.exit(0);

    // Cross-check against canonical state
    const state = loadCanonicalState();
    if (state.facts.length === 0 && state.projects.length === 0) process.exit(0);

    const contradictions = findContradictions(message, state);
    if (contradictions.length === 0) process.exit(0);

    // Build correction prompt
    const details = contradictions.map(c =>
      '  CLAIM: ' + c.claim + '\\n' +
      '  FACT:  ' + c.fact + '\\n' +
      '  FROM:  ' + c.source
    ).join('\\n\\n');

    const reason = 'CLAIM-INTERCEPT (Response-Level): FALSE CLAIM DETECTED\\n\\n' +
      'Your last response contained claims that contradict canonical state:\\n\\n' +
      details + '\\n\\n' +
      'You MUST correct this. Issue a brief correction acknowledging the error.\\n' +
      'Do NOT repeat the false claim. State what is actually true.\\n' +
      'Canonical state: .instar/state/quick-facts.json, project-registry.json';

    // Log the interception
    try {
      const logEntry = '[' + new Date().toISOString() + '] ' +
        'RESPONSE-LEVEL | contradictions=' + contradictions.length + ' | ' +
        'claims=' + contradictions.map(c => c.claim.substring(0, 50)).join('; ') + '\\n';
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, logEntry);
    } catch {}

    // BLOCK the stop — force the agent to correct itself
    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
    process.exit(2);
  } catch {}
  process.exit(0);
})();

`;
  }

  private getSkillUsageTelemetryHook(): string {
    return `#!/bin/bash
# Skill Usage Telemetry — PostToolUse hook for Skill tool.
#
# Logs every skill invocation to .instar/skill-telemetry.jsonl
# for future pattern detection (which skills are used, when, how often).
#
# Cross-pollinated from Dawn's Portal project (2026-04-09).
# Lightweight: appends one JSONL line, no network calls.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
if [ "$TOOL_NAME" != "Skill" ]; then
  exit 0
fi

INSTAR_DIR="\${CLAUDE_PROJECT_DIR:-.}/.instar"
TELEMETRY_FILE="$INSTAR_DIR/skill-telemetry.jsonl"

SKILL_NAME=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('skill','unknown'))" 2>/dev/null)
SKILL_ARGS=$(echo "$INPUT" | python3 -c "import json,sys; a=json.load(sys.stdin).get('tool_input',{}).get('args',''); print(a[:200])" 2>/dev/null)
OUTPUT_LEN=$(echo "$INPUT" | python3 -c "import json,sys; print(len(str(json.load(sys.stdin).get('tool_output',''))))" 2>/dev/null)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

SESSION_ID="\${INSTAR_SESSION_ID:-}"

mkdir -p "$INSTAR_DIR"
echo "{\\"timestamp\\":\\"$TIMESTAMP\\",\\"skill\\":\\"$SKILL_NAME\\",\\"args\\":\\"$SKILL_ARGS\\",\\"session_id\\":\\"$SESSION_ID\\",\\"output_length\\":$OUTPUT_LEN}" >> "$TELEMETRY_FILE"
`;
  }

  private getBuildStopHook(): string {
    // Canonical source: src/templates/hooks/build-stop-hook.sh
    // If you edit either, keep them byte-identical — tests assert equality.
    return `#!/bin/bash
# Build Stop Hook — Structural enforcement for the /build pipeline.
#
# Prevents premature exit during active builds. Graduated protection:
#   SMALL  (light):  3 reinforcements
#   STANDARD (medium): 5 reinforcements
#   LARGE  (heavy):  10 reinforcements
#
# Reads state from .instar/state/build/build-state.json.

STATE_FILE=".instar/state/build/build-state.json"

# No state file = no active build = allow exit
if [ ! -f "\$STATE_FILE" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Read state
PHASE=\$(python3 -c "import json; d=json.load(open('\$STATE_FILE')); print(d.get('phase','idle'))" 2>/dev/null)

# Terminal phases — allow exit
if [ "\$PHASE" = "complete" ] || [ "\$PHASE" = "failed" ] || [ "\$PHASE" = "escalated" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# ── Session-scope ownership (BUILD-STOP-HOOK-SESSION-SCOPING-SPEC) ───────────
# build-state stamps the owning session (tmux name + Claude session UUID) at /build
# start. Only the OWNER session's Stop should be blocked; any other concurrent
# session of the same agent must approve-exit WITHOUT spending the owner's
# reinforcement budget. This closes the cross-session stop-hook leak + budget drain.
HOOK_INPUT=\$(cat 2>/dev/null || echo "")
HOOK_SESSION=\$(printf '%s' "\$HOOK_INPUT" | python3 -c "import sys,json
try: print((json.load(sys.stdin) or {}).get('session_id','') or '')
except Exception: print('')" 2>/dev/null)

# Resolve MY tmux session name (the stable, cwd-independent owner address).
# Test seams: INSTAR_HOOK_TMUX_SESSION (if set, even empty, wins);
# INSTAR_HOOK_NO_TMUX=1 forces empty.
if [ "\${INSTAR_HOOK_NO_TMUX:-}" = "1" ]; then
  MY_TMUX=""
elif [ -n "\${INSTAR_HOOK_TMUX_SESSION+x}" ]; then
  MY_TMUX="\${INSTAR_HOOK_TMUX_SESSION}"
else
  MY_TMUX=\$(tmux display-message -p '#S' 2>/dev/null || echo "")
fi

OWNERSHIP=\$(STATE_FILE="\$STATE_FILE" MY_TMUX="\$MY_TMUX" HOOK_SESSION="\$HOOK_SESSION" python3 -c "
import json, os, sys
try:
    state = json.load(open(os.environ['STATE_FILE']))
except Exception:
    print('approve'); sys.exit(0)
owner = state.get('owner') or {}
o_tmux = owner.get('tmux') or ''
o_sess = owner.get('session') or ''
my_tmux = os.environ.get('MY_TMUX', '')
my_sess = os.environ.get('HOOK_SESSION', '')

# (a) No owner stamped -> conservative no-adopt: approve, never claim ownership.
if not o_tmux and not o_sess:
    print('approve'); sys.exit(0)

# (b)/(c) Owner stamped: block only the proven owner. A session that cannot match
# (including one with no resolvable identity) is approved -> never trap, no drain.
is_owner = (bool(o_tmux) and o_tmux == my_tmux) or (bool(o_sess) and o_sess == my_sess)
if not is_owner:
    print('approve'); sys.exit(0)

# Owner confirmed. Restart reconcile: ONLY on a confirmed tmux-owner match whose
# session UUID rotated (restart) do we update owner.session. The write is gated
# strictly behind the tmux match, so a non-owner can never clobber owner.session.
if o_tmux and o_tmux == my_tmux and my_sess and o_sess != my_sess:
    owner['session'] = my_sess
    state['owner'] = owner
    try:
        with open(os.environ['STATE_FILE'], 'w') as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass
print('owner')
" 2>/dev/null)

if [ "\$OWNERSHIP" != "owner" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Check and update reinforcement counter
RESULT=\$(python3 -c "
import json, sys
with open('\$STATE_FILE') as f:
    state = json.load(f)

protection = state.get('protection', {})
max_r = protection.get('reinforcements', 5)
used = state.get('reinforcementsUsed', 0)

if used >= max_r:
    print(json.dumps({'decision': 'approve'}))
    sys.exit(0)

state['reinforcementsUsed'] = used + 1
with open('\$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)

phase = state.get('phase', 'idle')
task = state.get('task', 'unknown')
label = protection.get('label', '?')
steps = state.get('steps', [])
total_tests = state.get('totalTests', 0)
wt = state.get('worktree')

prompts = {
    'idle': 'Build initialized. Begin with Phase 0 (CLARIFY) or Phase 1 (PLAN).',
    'clarify': 'In CLARIFY phase. Resolve ambiguity, then transition to PLAN.',
    'planning': 'In PLAN phase. Complete plan with test strategy, then EXECUTE.',
    'executing': 'In EXECUTE phase. Complete current step: code, tests, verify.',
    'verifying': 'In VERIFY phase. Run independent verification and real-world tests.',
    'fixing': 'In FIXING phase. Address findings, return to VERIFY.',
    'hardening': 'In HARDEN phase. Complete observability checklists.',
}

hint = prompts.get(phase, 'Continue with current phase.')
steps_info = ' | %d steps, %d tests' % (len(steps), total_tests) if steps else ''
wt_info = ' | worktree: %s' % wt['path'] if wt else ''

reason = (
    '/build active. Phase: %s (%s, %d/%d reinforcements)%s%s\\n\\n'
    'Task: %s\\n\\n%s\\n\\n'
    'Use \\\`python3 playbook-scripts/build-state.py status\\\` to check state.\\n'
    'Use \\\`python3 playbook-scripts/build-state.py transition <phase>\\\` to advance.\\n\\n'
    'The build pipeline is not complete. Continue working.'
) % (phase, label, state['reinforcementsUsed'], max_r, steps_info, wt_info, task, hint)

print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null)

echo "\$RESULT"
exit 0
`;
  }

  private getAutoApprovePermissionsHook(): string {
    return `#!/usr/bin/env node
// Auto-approve ALL PermissionRequest hooks.
//
// Subagents spawned via the Agent tool don't inherit --dangerously-skip-permissions
// from the parent session. Without this hook, subagents prompt for every tool use,
// blocking autonomous sessions and jobs.
//
// Real safety is enforced by PreToolUse hooks (dangerous-command-guard.sh,
// external-communication-guard.js, external-operation-gate.js). Permission prompts
// are duplicative friction, not protection.

process.stdin.resume();
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  }));
});

// Timeout safety
setTimeout(() => {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' }
    }
  }));
  process.exit(0);
}, 2000);
`;
  }
}
