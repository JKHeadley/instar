/**
 * `instar server start|stop` — Manage the persistent agent server.
 *
 * Start launches the server in a tmux session (background) or foreground.
 * Stop kills the server tmux session.
 *
 * When Telegram is configured, wires up message routing:
 *   topic message → find/spawn session → inject message → session replies via [telegram:N]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { loadConfig, ensureStateDir, detectTmuxPath, detectGeminiPath } from '../core/Config.js';
import { isNonFatalUncaught, shouldLogStackForUncaught } from '../core/uncaughtExceptionPolicy.js';
import { closeAllSqlite } from '../core/SqliteRegistry.js';
import { SessionManager } from '../core/SessionManager.js';
import { StateManager } from '../core/StateManager.js';
import { StuckInputSentinel } from '../core/StuckInputSentinel.js';
import { SessionRecoveryChannel } from '../core/SessionRecoveryChannel.js';
import { JobScheduler } from '../scheduler/JobScheduler.js';
import { IntegrationGate } from '../scheduler/IntegrationGate.js';
import { JobRunHistory } from '../scheduler/JobRunHistory.js';
import { AgentServer } from '../server/AgentServer.js';
import { TelegramAdapter, TOPIC_STYLE, selectTopicEmoji } from '../messaging/TelegramAdapter.js';
import { getTelegramInboundDir } from '../messaging/shared/telegramInboundFiles.js';
import { RelationshipManager } from '../core/RelationshipManager.js';
import { ClaudeCliIntelligenceProvider } from '../core/ClaudeCliIntelligenceProvider.js';
import { wrapIntelligenceWithCircuitBreaker } from '../core/CircuitBreakingIntelligenceProvider.js';
import { configureLlmCircuitBreaker } from '../core/LlmCircuitBreaker.js';
import { isClaudeForbidden } from '../core/claudeForbiddenGuard.js';
import { FeedbackManager } from '../core/FeedbackManager.js';
import { FeedbackAnomalyDetector } from '../monitoring/FeedbackAnomalyDetector.js';
import { lifelineOwnsPoll as lifelineOwnsTelegramPoll } from '../lifeline/TelegramPollOwnerLease.js';
import { DispatchManager } from '../core/DispatchManager.js';
import { UpdateChecker } from '../core/UpdateChecker.js';
import { AutoUpdater } from '../core/AutoUpdater.js';
import { UpdateRestartHandshake, verifyRestartHandshake } from '../core/UpdateRestartHandshake.js';
import { AutoDispatcher } from '../core/AutoDispatcher.js';
import { DispatchExecutor } from '../core/DispatchExecutor.js';
import { registerAgent, unregisterAgent, startHeartbeat, isFetchBlockedPort } from '../core/AgentRegistry.js';
import { TelegraphService } from '../publishing/TelegraphService.js';
import { PrivateViewer } from '../publishing/PrivateViewer.js';
import { TunnelManager } from '../tunnel/TunnelManager.js';
import { PostUpdateMigrator } from '../core/PostUpdateMigrator.js';
import { UpgradeGuideProcessor } from '../core/UpgradeGuideProcessor.js';
import { EvolutionManager } from '../core/EvolutionManager.js';
import { TopicMemory } from '../memory/TopicMemory.js';
import { SemanticMemory } from '../memory/SemanticMemory.js';
import { WorkingMemoryAssembler } from '../memory/WorkingMemoryAssembler.js';
import { QuotaTracker } from '../monitoring/QuotaTracker.js';
import { AccountSwitcher } from '../monitoring/AccountSwitcher.js';
import { QuotaNotifier } from '../monitoring/QuotaNotifier.js';
import { QuotaManager } from '../monitoring/QuotaManager.js';
import { classifySessionDeath } from '../monitoring/QuotaExhaustionDetector.js';
import { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import { formatWatchdogUserMessage } from '../monitoring/watchdog-notifications.js';
import { StallTriageNurse } from '../monitoring/StallTriageNurse.js';
import { TriageOrchestrator } from '../monitoring/TriageOrchestrator.js';
import { SessionMonitor } from '../monitoring/SessionMonitor.js';
import { SessionRecovery } from '../monitoring/SessionRecovery.js';
import { MultiMachineCoordinator } from '../core/MultiMachineCoordinator.js';
import { MachineIdentityManager } from '../core/MachineIdentity.js';
import { isRemotelyHandled } from '../core/SessionRouter.js';
import { formatForwardedTopicContext } from '../core/ForwardedTopicContext.js';
import { resolveAdvertisedMeshUrl, advertiseSelfMeshUrl } from '../core/MeshUrlAdvertiser.js';
import { relayOutbound } from '../core/TelegramRelay.js';
import { GitSyncManager } from '../core/GitSync.js';
import { RegistrySyncDebouncer } from '../core/RegistrySyncDebouncer.js';
import { wireRegistrySync } from '../core/wireRegistrySync.js';
import { assertSeamlessnessInvariants } from '../core/seamlessnessConfig.js';
import { FencedLease, type LeaseCrypto } from '../core/FencedLease.js';
import { GitLeaseStore } from '../core/GitLeaseStore.js';
import { LocalLeaseStore } from '../core/LocalLeaseStore.js';
import { LeaseCoordinator, type LeaseStore } from '../core/LeaseCoordinator.js';
import { HttpLeaseTransport } from '../core/HttpLeaseTransport.js';
import { HttpLiveTailTransport } from '../core/HttpLiveTailTransport.js';
import { LiveTailBuffer } from '../core/LiveTailBuffer.js';
import { LiveTailSource } from '../core/LiveTailSource.js';
import { HandoffWireTransport } from '../core/HandoffWireTransport.js';
import { createHandoffReceiverWiring } from '../core/handoffReceiverWiring.js';
import { createHandoffSentinelBootWiring } from '../core/handoffSentinelBootWiring.js';
import type { HandoffOutcome } from '../core/HandoffSentinel.js';
import { MessageProcessingLedger } from '../messaging/MessageProcessingLedger.js';
import { recoverStuckMessages } from '../messaging/stuckMessageRecovery.js';
import { ReplyMarkerTransport } from '../core/ReplyMarkerTransport.js';
import { decryptFromSync, encryptForSync } from '../core/SecretStore.js';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { sign as signEd25519, verify as verifyEd25519 } from '../core/MachineIdentity.js';
import { ProjectMapper } from '../core/ProjectMapper.js';
import { CapabilityMapper } from '../core/CapabilityMapper.js';
import { ScopeVerifier } from '../core/ScopeVerifier.js';
import { ContextHierarchy } from '../core/ContextHierarchy.js';
import { CanonicalState } from '../core/CanonicalState.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../core/ExternalOperationGate.js';
import { MessageSentinel } from '../core/MessageSentinel.js';
import { AdaptiveTrust } from '../core/AdaptiveTrust.js';
import { AutonomyProfileManager } from '../core/AutonomyProfileManager.js';
import { TrustElevationTracker } from '../core/TrustElevationTracker.js';
import { AutonomousEvolution } from '../core/AutonomousEvolution.js';
import { DispatchScopeEnforcer } from '../core/DispatchScopeEnforcer.js';
import { TrustRecovery } from '../core/TrustRecovery.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { HumanAsDetectorLog, observeInboundMessage } from '../monitoring/HumanAsDetectorLog.js';
import { creditUsherOnMiss } from '../core/UsherActedCorrelator.js';
import { resolveStableNodeBinary } from '../utils/resolveNodeBinary.js';
import { SelfKnowledgeTree } from '../knowledge/SelfKnowledgeTree.js';
import { CoverageAuditor } from '../knowledge/CoverageAuditor.js';
import { LiveConfig } from '../config/LiveConfig.js';
import { CoherenceMonitor } from '../monitoring/CoherenceMonitor.js';
import { ProcessIntegrity } from '../core/ProcessIntegrity.js';
import { StaleProcessGuard } from '../core/StaleProcessGuard.js';
import { cleanupGlobalInstalls } from '../core/GlobalInstallCleanup.js';
import { ForegroundRestartWatcher } from '../core/ForegroundRestartWatcher.js';
import { NotificationBatcher } from '../messaging/NotificationBatcher.js';
import { formatLocalTimestamp } from '../utils/localTime.js';
import type { NotificationTier } from '../messaging/NotificationBatcher.js';
import { MessageStore } from '../messaging/MessageStore.js';
import { MessageFormatter } from '../messaging/MessageFormatter.js';
import { MessageDelivery } from '../messaging/MessageDelivery.js';
import type { TmuxOperations } from '../messaging/MessageDelivery.js';
import { MessageRouter } from '../messaging/MessageRouter.js';
import { generateAgentToken } from '../messaging/AgentTokenManager.js';
import { pickupDroppedMessages } from '../messaging/DropPickup.js';
import { pickupGitSyncMessages } from '../messaging/GitSyncTransport.js';
import { DeliveryRetryManager } from '../messaging/DeliveryRetryManager.js';
import { SpawnRequestManager } from '../messaging/SpawnRequestManager.js';
import { ThreadlineRouter, trustMeetsFloor } from '../threadline/ThreadlineRouter.js';
import { WarmSessionPool } from '../threadline/WarmSessionPool.js';
import { resolveThreadlineMcpEntry } from '../threadline/mcpEntry.js';
import { ThreadResumeMap } from '../threadline/ThreadResumeMap.js';
import { ConversationStore } from '../threadline/ConversationStore.js';
import { WarrantsReplyGate, evaluateAndRecordInbound } from '../threadline/WarrantsReplyGate.js';
import { CollaborationSurfacer } from '../threadline/CollaborationSurfacer.js';
import { ListenerSessionManager } from '../threadline/ListenerSessionManager.js';
import { SystemReviewer } from '../monitoring/SystemReviewer.js';
import { createSessionProbes } from '../monitoring/probes/SessionProbe.js';
import { createSchedulerProbes } from '../monitoring/probes/SchedulerProbe.js';
import { createMessagingProbes } from '../monitoring/probes/MessagingProbe.js';
import { createLifelineProbes } from '../monitoring/probes/LifelineProbe.js';
import { createPlatformProbes } from '../monitoring/probes/PlatformProbe.js';
import { bootstrapThreadline } from '../threadline/ThreadlineBootstrap.js';
import { DEFAULT_RELAY_HOST } from '../threadline/constants.js';
import { createUnifiedTrustSystem, type UnifiedTrustSystem } from '../threadline/UnifiedTrustWiring.js';
import type { PipelineMessage } from '../types/pipeline.js';
import { toPipeline, toInjection, toLogEntry, formatHistoryLine } from '../types/pipeline.js';
import type { Message, IntelligenceProvider, UserProfile, InstarConfig } from '../core/types.js';
import { UserManager } from '../users/UserManager.js';
import { formatUserContextForSession, hasUserContext } from '../users/UserContextBuilder.js';
import type { OrphanProcessReaper } from '../monitoring/OrphanProcessReaper.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
// setup.ts uses @inquirer/prompts which requires Node 20.12+
// Dynamic import to avoid breaking the server on older Node versions
// import { installAutoStart } from './setup.js';

/**
 * Dependencies for the fix command handler — populated incrementally as
 * subsystems initialize (some start after wireTelegramRouting).
 */
interface FixCommandDeps {
  state: StateManager;
  liveConfig: LiveConfig;
  sessionManager: SessionManager;
  telegram: TelegramAdapter;
  config: InstarConfig;
  orphanReaper?: OrphanProcessReaper;
  coherenceMonitor?: CoherenceMonitor;
}

/**
 * Handle "fix X" and "clean X" commands from Agent Attention notifications.
 * These are mechanical server-side operations — no Claude session needed.
 * Returns true if the command was recognized and handled.
 */
async function handleFixCommand(topicId: number, text: string, deps: FixCommandDeps): Promise<boolean> {
  const cmd = text.trim().toLowerCase();

  // Only handle commands in the Agent Attention topic
  const attentionTopicId = deps.state.get<number>('agent-attention-topic');
  if (!attentionTopicId || topicId !== attentionTopicId) {
    return false;
  }

  const send = (msg: string) => deps.telegram.sendToTopic(topicId, msg);

  if (cmd === 'fix auth') {
    const existing = deps.liveConfig.get<string>('authToken', '');
    if (existing) {
      await send('Your API already has an authentication token configured. No changes needed.');
      return true;
    }
    // Generate a random token
    const token = Array.from({ length: 32 }, () =>
      'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36))
    ).join('');
    deps.liveConfig.set('authToken', token);
    await send(`Done! Generated and saved a new API authentication token. Your API is now protected.\n\nToken: ${token.slice(0, 8)}... (stored in config)`);
    return true;
  }

  if (cmd === 'fix dashboard') {
    const existing = deps.liveConfig.get<string>('dashboardPin', '');
    if (existing) {
      await send(`Your dashboard already has a PIN: ${existing}`);
      return true;
    }
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    deps.liveConfig.set('dashboardPin', pin);
    await send(`Done! Generated dashboard PIN: ${pin}`);
    return true;
  }

  if (cmd === 'fix shadow') {
    const localPkg = path.join(deps.config.projectDir, 'node_modules', 'instar');
    if (!fs.existsSync(localPkg)) {
      await send('No shadow installation found — your agent is using the global Instar installation correctly.');
      return true;
    }
    try {
      // Remove the shadow installation
      const { spawnSync } = await import('node:child_process');
      spawnSync('rm', ['-rf',
        path.join(deps.config.projectDir, 'node_modules'),
        path.join(deps.config.projectDir, 'package.json'),
        path.join(deps.config.projectDir, 'package-lock.json'),
      ], { timeout: 10000 });
      await send('Done! Removed the local shadow installation. Your agent will now use the global Instar binary and receive auto-updates properly.');
    } catch (err) {
      await send(`I ran into a problem removing the local installation. I'll try again next time, or you can ask me to retry now.`);
    }
    return true;
  }

  if (cmd === 'clean processes' || cmd === 'clean') {
    if (!deps.orphanReaper) {
      await send('The process monitor is still starting up. Try again in a minute.');
      return true;
    }
    // Run a fresh scan first
    await deps.orphanReaper.scan();
    const result = deps.orphanReaper.killAllExternal();
    if (result.killed === 0) {
      await send('No external Claude processes found to clean up. Everything looks good.');
    } else {
      await send(`Cleaned up ${result.killed} external Claude process${result.killed === 1 ? '' : 'es'}, freeing ~${result.freedMB}MB of memory.`);
    }
    return true;
  }

  if (cmd === 'restart') {
    // Request a graceful server restart — write to state/ subdirectory where
    // the supervisor and ForegroundRestartWatcher poll for it.
    const restartFile = path.join(deps.config.stateDir, 'state', 'restart-requested.json');
    fs.writeFileSync(restartFile, JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: 'User requested restart via Agent Attention fix command',
      requestedBy: 'fix-command',
    }));
    await send('Restart requested. Your agent will restart momentarily.');
    return true;
  }

  if (cmd === 'restart sessions') {
    const running = deps.sessionManager.listRunningSessions();
    const stale = running.filter(s => !deps.sessionManager.isSessionAlive(s.tmuxSession));
    if (stale.length === 0) {
      await send(`All ${running.length} session${running.length === 1 ? ' is' : 's are'} running normally. No action needed.`);
    } else {
      for (const s of stale) {
        try {
          deps.sessionManager.killSession(s.tmuxSession);
        } catch { /* best effort */ }
      }
      await send(`Found ${stale.length} stuck session${stale.length === 1 ? '' : 's'} and cleaned ${stale.length === 1 ? 'it' : 'them'} up. New sessions will start fresh when needed.`);
    }
    return true;
  }

  if (cmd === 'fix lifeline') {
    // Lifeline is managed by the separate lifeline process, not the server.
    // Best we can do is suggest the right command.
    await send('The lifeline runs separately from the main server. Head over to the Lifeline topic and say "restart" — it will reset everything and bring the server back up.');
    return true;
  }

  if (cmd === 'fix output') {
    if (!deps.coherenceMonitor) {
      await send('The coherence monitor is still starting up. Try again in a minute.');
      return true;
    }
    const report = deps.coherenceMonitor.runCheck();
    const outputCheck = report.checks.find(c => c.name === 'output-sanity');
    if (!outputCheck || outputCheck.passed) {
      await send('Output check passed — no bad patterns found in recent messages. The earlier issue may have resolved itself.');
    } else {
      await send(`Output check still showing issues — your agent is including internal links in messages that users can't access. Your agent should be using your public domain instead. This will be flagged to your agent in its next session.`);
    }
    return true;
  }

  // Not a recognized fix command
  return false;
}

interface StartOptions {
  foreground?: boolean;
  dir?: string;
  /** When false, skip Telegram polling (used when lifeline owns the Telegram connection).
   *  Commander maps --no-telegram to telegram: false. */
  telegram?: boolean;
}

/**
 * Check if autostart is installed for this project.
 * Extracted from the CLI `autostart status` handler for programmatic use.
 */
function isAutostartInstalled(projectName: string): boolean {
  if (process.platform === 'darwin') {
    const label = `ai.instar.${projectName}`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    return fs.existsSync(plistPath);
  } else if (process.platform === 'linux') {
    const serviceName = `instar-${projectName}.service`;
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
    return fs.existsSync(servicePath);
  }
  return false;
}

/**
 * Spawn a session for a topic with full conversational context.
 * Shared by both auto-spawn (new topic) and respawn (dead session) paths.
 *
 * Context loading priority (when TopicMemory is available):
 *   1. Rolling conversation summary (captures full history)
 *   2. Recent messages (last 30 — the immediate context)
 *   3. Search instructions (so agent can query deeper history)
 *
 * Fallback: JSONL-based last 20 messages (when TopicMemory unavailable).
 *
 * Returns the new tmux session name.
 */
// Module-level reference so spawnSessionForTopic can trigger orphan cleanup under memory pressure.
// Set once the reaper is initialized in startServer().
let _orphanReaper: import('../monitoring/OrphanProcessReaper.js').OrphanProcessReaper | null = null;
let _memoryMonitor: import('../monitoring/MemoryPressureMonitor.js').MemoryPressureMonitor | null = null;
let _fixDeps: FixCommandDeps | null = null;

// Module-level reference for session resume mapping.
// Set once in startServer() and used by spawnSessionForTopic/respawnSessionForTopic.
let _topicResumeMap: import('../core/TopicResumeMap.js').TopicResumeMap | null = null;

// ── Multi-Machine Session Pool (§L4) activation refs ──────────────────────
// The SessionRouter is constructed in startServer()'s mesh block, but the inbound
// dispatch handler that consults it is defined ABOVE startServer — so the router is
// shared via this module-level ref (the same pattern as _orphanReaper/_topicResumeMap).
// `_sessionPoolStage()` reads the live rollout stage; the inbound interception only
// routes through the pool when it returns a non-'dark' stage, so DARK (the default)
// is byte-identical to today's always-local dispatch. Set once in startServer().
let _sessionRouter: import('../core/SessionRouter.js').SessionRouter | null = null;
let _sessionPoolStage: () => string = () => 'dark';
/** This machine's mesh id — lets the inbound dispatch tell a REMOTE placement
 *  (forward/spawn on another machine → must NOT also dispatch locally) from a
 *  self placement. Set once in startServer()'s mesh block. */
let _meshSelfId: string | null = null;
/** Resolve the current router (Telegram-owning lease holder)'s base URL, or null if
 *  this machine IS the router / none is known. Used by the owner-side resume to fetch
 *  a moved topic's prior history from the router (bug #2). Set in the mesh block where
 *  the peer-URL resolver + coordinator are in scope. */
let _resolveRouterUrl: (() => string | null) | null = null;
/** Every OTHER active machine with a known URL — backs GET /sessions?scope=pool
 *  (pool-wide session aggregation for the dashboard). Set in the same mesh block. */
let _resolvePeerUrls: (() => Array<{ machineId: string; url: string }>) | null = null;
/** Multi-Machine Session Pool §L4: per-topic placement pin store ("move this to <nickname>"). */
let _topicPinStore: import('../core/TopicPlacementPinStore.js').TopicPlacementPinStore | null = null;
/** Cross-machine secret-sync (spec Phase 4): route-facing handle (push lever + read-only status). */
let _secretSyncHandle: import('../core/SecretSync.js').SecretSyncHandle | null = null;
/** Recognize + apply a "move/run this on <nickname>" relocation on inbound; returns handled=true when the message WAS a relocation command (so it must not also be dispatched). */
let _tryNicknameRelocation: ((topicId: number, text: string) => Promise<{ handled: boolean }>) | null = null;
/** Per-topic framework override (claude-code | codex-cli). Populated from
 *  `config.topicFrameworks` at server boot. Boot-immutable; runtime
 *  mutations go through `_topicFrameworksStore` instead so they persist
 *  across restarts and don't race with operator-edited config.json. */
let _topicFrameworks: Record<string, 'claude-code' | 'codex-cli'> = {};
/** Runtime-mutable, atomically-persisted per-topic framework store.
 *  Initialized in startServer(); consulted by resolveTopicFramework on every spawn. */
let _topicFrameworksStore: import('../core/TopicFrameworksStore.js').TopicFrameworksStore | null = null;
let _topicLocalModelStore: import('../core/TopicLocalModelStore.js').TopicLocalModelStore | null = null;
/** Default framework for sessions when no per-topic override is set. */
let _defaultFramework: 'claude-code' | 'codex-cli' = 'claude-code';

function resolveTopicFramework(topicId: number | undefined): 'claude-code' | 'codex-cli' {
  if (topicId !== undefined && _topicFrameworksStore) {
    const stored = _topicFrameworksStore.get(topicId);
    if (stored === 'claude-code' || stored === 'codex-cli') return stored;
  }
  if (topicId !== undefined && _topicFrameworks[String(topicId)]) {
    return _topicFrameworks[String(topicId)]!;
  }
  return _defaultFramework;
}
let _projectDir: string = process.cwd();
let _sharedIntelligence: import('../core/types.js').IntelligenceProvider | null = null;
let _selfKnowledgeTree: SelfKnowledgeTree | null = null;
let _slackAdapter: import('../messaging/slack/SlackAdapter.js').SlackAdapter | null = null;
// SessionRefresh — agent-initiated respawn. Module-scope so onRestartSession
// (defined outside startServer) can delegate to it once startServer wires it.
// Null until startServer constructs it; the Telegram /restart handler falls
// back to the inline kill+respawn path when null (e.g. early in boot).
let _sessionRefresh: import('../core/SessionRefresh.js').SessionRefresh | null = null;

async function spawnSessionForTopic(
  sessionManager: SessionManager,
  telegram: TelegramAdapter,
  sessionName: string,
  topicId: number,
  latestMessage?: string,
  topicMemory?: TopicMemory,
  userProfile?: UserProfile,
  precomputedContext?: string,
): Promise<string> {
  const msg = latestMessage || 'Session started — send a message to continue.';

  // If memory is elevated/critical and we have the reaper, try to free memory
  // by cleaning orphans before spawning. Interactive sessions are NEVER blocked
  // (the user must always be able to interact), but we clean up first.
  if (_memoryMonitor && _orphanReaper) {
    const memState = _memoryMonitor.getState();
    if (memState.state === 'elevated' || memState.state === 'critical') {
      console.log(`[spawnSessionForTopic] Memory ${memState.state} (${memState.pressurePercent.toFixed(1)}%) — triggering orphan cleanup before spawn`);
      try {
        await _orphanReaper.scan();
      } catch (err) {
        console.error('[spawnSessionForTopic] Orphan cleanup failed:', err);
      }
    }
  }

  // bug #2: a session MOVED here by the session pool has no local history (this
  // machine never polled the topic; its TopicMemory has no rows). The router relays
  // the prior conversation as precomputedContext — use it verbatim and skip the
  // (empty) local sources, so a moved session continues instead of starting blank.
  let contextContent: string = precomputedContext ?? '';

  // Prefer TopicMemory (SQLite-backed, with summaries) over raw JSONL scan
  let usedFallback = false;
  if (!contextContent && topicMemory?.isReady()) {
    try {
      contextContent = topicMemory.formatContextForSession(topicId, 50);
    } catch (err) {
      // @silent-fallback-ok — TopicMemory format, JSONL fallback
      console.error(`[telegram→session] TopicMemory context failed, falling back to JSONL:`, err);
    }
  }

  // Fallback to JSONL-based history — this means TopicMemory is broken
  if (!contextContent) {
    usedFallback = true;
    try {
      const history = telegram.getTopicHistory(topicId, 50);
      if (history.length > 0) {
        const lines: string[] = [];
        lines.push(`--- Thread History (last ${history.length} messages) ---`);
        lines.push(`IMPORTANT: Read this history carefully before taking any action.`);
        lines.push(`Your task is to continue THIS conversation, not start something new.`);
        const topicName = telegram.getTopicName?.(topicId);
        if (topicName) {
          lines.push(`Topic: ${topicName}`);
        }
        lines.push(``);
        for (const m of history) {
          // Use actual sender name if available (multi-user topics), fall back to generic
          const sender = m.fromUser
            ? (m.senderName || 'User')
            : 'Agent';
          const ts = formatLocalTimestamp(m.timestamp); // local + tz label (see src/utils/localTime.ts)
          const text = (m.text || '').slice(0, 2000);
          lines.push(`[${ts}] ${sender}: ${text}`);
        }
        lines.push(``);
        lines.push(`--- End Thread History ---`);
        contextContent = lines.join('\n');
      }
    } catch (err) {
      console.error(`[telegram→session] Failed to fetch thread history:`, err);
    }
  }

  // Report degradation if fallback was used and TopicMemory should have been available
  if (usedFallback && topicMemory !== undefined) {
    DegradationReporter.getInstance().report({
      feature: 'TopicMemory.formatContextForSession',
      primary: 'SQLite-backed context with summaries and search',
      fallback: 'JSONL-based last 20 messages (no summaries, no search)',
      reason: topicMemory.isReady()
        ? `TopicMemory returned empty context for topic ${topicId} (possible data gap)`
        : `TopicMemory database not open (init failure)`,
      impact: `Session for topic ${topicId} started with degraded context — no summaries, limited history.`,
    });
  }

  // ── Agent Self-Knowledge Injection ──────────────────────────────
  // If the self-knowledge tree is loaded, inject a compact agent identity
  // snapshot into the bootstrap. This gives the session awareness of
  // WHO the agent is — name, description, capabilities, autonomy level.
  let agentContextBlock = '';
  if (_selfKnowledgeTree) {
    try {
      const { ContextSnapshotBuilder } = await import('../core/ContextSnapshotBuilder.js');
      const snapshotBuilder = new ContextSnapshotBuilder({
        projectName: _selfKnowledgeTree.getConfig()?.agentName || '',
        projectDir: _projectDir,
        stateDir: path.join(_projectDir, '.instar'),
      }, { detailLevel: 'concise' });
      agentContextBlock = `--- Agent Identity ---\n${snapshotBuilder.renderForPrompt()}\n--- End Agent Identity ---`;
    } catch {
      // @silent-fallback-ok — agent context non-critical
    }
  }

  // ── User Context Injection (Gap 8) ──────────────────────────────
  // If we have a resolved UserProfile with meaningful context, format it
  // for injection into the bootstrap message. This gives the agent awareness
  // of who it's talking to: permissions, preferences, relationship history.
  let userContextBlock = '';
  if (userProfile && hasUserContext(userProfile)) {
    userContextBlock = formatUserContextForSession(userProfile);
  }

  // Build the bootstrap message with inline context.
  // CRITICAL: Context must be BEFORE the user's message and inline (not a file reference).
  // Previous approach used a parenthetical file reference after the user's message:
  //   "[telegram:N] Hello (Thread history at /path — read it)"
  // This failed because Claude's attention goes to the user's greeting, generates a
  // generic response, and never reads the file. The context instruction was structurally
  // too weak — a skippable parenthetical, not a command.
  //
  // Fix: Inline the context directly, put it BEFORE the user's message, with strong
  // continuation framing. Claude processes the context first, then responds to the
  // user's message WITH that context loaded.
  const tmpDir = getTelegramInboundDir(_projectDir);
  fs.mkdirSync(tmpDir, { recursive: true });

  let bootstrapMessage: string;

  if (contextContent) {
    // Also write full context to file for deeper lookup if needed
    const filepath = path.join(tmpDir, `history-${topicId}-${Date.now()}-${process.pid}.txt`);
    fs.writeFileSync(filepath, contextContent);

    // Inject the FULL context inline — no truncation.
    // Claude handles context management via compaction. Pre-truncating strips
    // recent messages and makes resumed sessions feel like they lost memory.
    // The session should feel like it never stopped.
    const inlineContext = contextContent;

    const parts = [
      `CONTINUATION — You are resuming an EXISTING conversation. Read the context below before responding.`,
      ``,
    ];

    // Agent identity comes FIRST — the agent needs to know WHO IT IS.
    if (agentContextBlock) {
      parts.push(agentContextBlock);
      parts.push(``);
    }

    // User context comes SECOND — before conversation history.
    // The agent needs to know WHO it's talking to before reading WHAT was said.
    if (userContextBlock) {
      parts.push(userContextBlock);
      parts.push(``);
    }

    parts.push(
      inlineContext,
      ``,
      `IMPORTANT: Your response MUST acknowledge and continue the conversation above. Do NOT introduce yourself or ask "how can I help" — the user has been talking to you. Pick up where the conversation left off.`,
      ``,
      `The user's latest message:`,
      `[telegram:${topicId}] ${msg}`,
    );

    bootstrapMessage = parts.join('\n');
  } else {
    // No conversation history — new session.
    // Still inject agent + user context if available.
    const newSessionParts: string[] = [];
    if (agentContextBlock) {
      newSessionParts.push(agentContextBlock);
      newSessionParts.push(``);
    }
    if (userContextBlock) {
      newSessionParts.push(userContextBlock);
      newSessionParts.push(``);
    }
    newSessionParts.push(`[telegram:${topicId}] ${msg}`);

    if (newSessionParts.length > 1) {
      bootstrapMessage = newSessionParts.join('\n');
    } else {
      bootstrapMessage = `[telegram:${topicId}] ${msg}`;
    }
  }

  // Resolve framework EARLY — needed for the inline Telegram-relay block
  // (the block is the same for both frameworks today, but the helper accepts
  // framework so future divergence stays structural rather than ad-hoc).
  const framework = resolveTopicFramework(topicId);

  // Large bootstrap messages (e.g. CONTINUATION context with full thread history)
  // can exceed tmux send-keys limits. Write to a temp file and inject a reference,
  // same pattern as injectTelegramMessage's FILE_THRESHOLD.
  const BOOTSTRAP_FILE_THRESHOLD = 500;
  if (bootstrapMessage.length > BOOTSTRAP_FILE_THRESHOLD) {
    const bootstrapFilename = `bootstrap-${topicId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`;
    const bootstrapFilepath = path.join(tmpDir, bootstrapFilename);
    fs.writeFileSync(bootstrapFilepath, bootstrapMessage);
    console.log(`[spawnSessionForTopic] Bootstrap message too large (${bootstrapMessage.length} chars), wrote to ${bootstrapFilepath}`);
    bootstrapMessage = `[IMPORTANT: Read ${bootstrapFilepath} — it contains your full session context, conversation history, and the user's latest message. You MUST read this file before responding.]`;
  }

  // Telegram-relay instruction MUST be inline (not hidden behind a file
  // reference) so the agent processes it as a structural directive rather
  // than a skippable background note. Claude historically learned this from
  // a SessionStart shell hook that Codex CLI doesn't honor — so we encode
  // the instruction framework-agnostically here. Appended LAST so recency
  // bias makes it the most salient part of the prompt.
  try {
    const { buildTelegramRelayBlock } = await import('../messaging/shared/telegramRelayPrompt.js');
    const relayBlock = buildTelegramRelayBlock({ topicId, framework });
    bootstrapMessage = `${bootstrapMessage}\n\n${relayBlock}`;
  } catch (err) {
    console.error('[spawnSessionForTopic] telegramRelayPrompt import failed (non-fatal):', err);
  }

  // Check for a resume UUID from a previously-killed session on this topic.
  // TopicResumeMap is authoritative — it saved the UUID for this specific topic at kill time
  // or via the refresh heartbeat. Skip LLM validation (which was failing due to JSONL sampling
  // issues and is redundant for an authoritative source).
  let resumeSessionId = _topicResumeMap?.get(topicId) ?? undefined;
  if (resumeSessionId) {
    console.log(`[spawnSessionForTopic] Found resume UUID for topic ${topicId}: ${resumeSessionId} (source: TopicResumeMap — trusted)`);
  }

  // Ensure the framework's identity shadow file exists at the project
  // root before spawn — Codex reads AGENTS.md at session start; Claude
  // reads CLAUDE.md. Legacy installs may have CLAUDE.md authored
  // directly without an AGENT.md, so a fresh Codex spawn would miss
  // the relay-script instructions and the agent would never know how
  // to ship its output back to Telegram. ensureFrameworkIdentityFile
  // bootstraps AGENT.md from any existing shadow and renders the
  // framework's shadow if missing. Idempotent — no-op when the
  // shadow already exists.
  try {
    const { ensureFrameworkIdentityFile } = await import('../core/IdentityRenderer.js');
    // Telegram-relay appendix gets rendered into AGENTS.md/CLAUDE.md whenever
    // we're spawning for a Telegram topic — topicId !== undefined is a safe
    // proxy for "Telegram is configured" since spawnSessionForTopic only runs
    // in that path. Codex CLI needs the appendix to remember the relay
    // convention past turn 1 (no SessionStart hook coverage).
    ensureFrameworkIdentityFile(_projectDir, framework, {
      stateDir: path.join(_projectDir, '.instar'),
      appendTelegramRelayBlock: true,
    });
  } catch (err) {
    console.warn(`[spawnSessionForTopic] ensureFrameworkIdentityFile failed (non-fatal):`, err instanceof Error ? err.message : err);
  }

  // Per-topic local-model selection (Codex --oss passthrough). The store
  // merges runtime overrides (set by /local-model) with config.json
  // defaults. spawnInteractiveSession's codexLocalProvider option flows
  // through to frameworkSessionLaunch which composes the
  // `codex exec --oss --local-provider <p> --model <m>` argv.
  const localEntry = _topicLocalModelStore?.get(topicId) ?? null;
  const codexLocalProvider = framework === 'codex-cli' ? localEntry?.provider : undefined;
  const codexLocalModelOverride = framework === 'codex-cli' && localEntry?.model ? localEntry.model : undefined;

  const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, sessionName, {
    telegramTopicId: topicId,
    resumeSessionId,
    framework,
    ...(codexLocalProvider ? { codexLocalProvider } : {}),
    ...(codexLocalModelOverride ? { defaultModel: codexLocalModelOverride } : {}),
  });

  // Clear the resume entry after successful spawn to prevent stale reuse
  if (resumeSessionId) {
    _topicResumeMap?.remove(topicId);
  }

  // Proactive UUID save — schedule discovery after spawn.
  // ONLY uses authoritative claudeSessionId from hook events.
  // Never falls back to mtime-based JSONL scan — that can pick up a UUID from
  // a different topic's session when multiple sessions are running concurrently.
  // The heartbeat (refreshResumeMappings) has a proper single-session guard and
  // will safely fill in the mapping within 60s if hooks haven't fired yet.
  if (_topicResumeMap) {
    setTimeout(() => {
      try {
        const sessions = sessionManager.listRunningSessions();
        const session = sessions.find(s => s.tmuxSession === newSessionName);
        if (session?.claudeSessionId) {
          _topicResumeMap!.save(topicId, session.claudeSessionId, newSessionName);
          console.log(`[spawnSessionForTopic] Proactive UUID save: ${session.claudeSessionId} for topic ${topicId} (source: hook)`);
        }
      } catch (err) {
        console.error(`[spawnSessionForTopic] Proactive UUID save failed:`, err);
      }
    }, 8000);
  }

  return newSessionName;
}

/**
 * Respawn a session for a topic, including thread history in the bootstrap.
 * This prevents "thread drift" where respawned sessions lose context.
 */
async function respawnSessionForTopic(
  sessionManager: SessionManager,
  telegram: TelegramAdapter,
  targetSession: string,
  topicId: number,
  latestMessage?: string,
  topicMemory?: TopicMemory,
  userProfile?: UserProfile,
  recoveryPrompt?: string,
  options?: { silent?: boolean },
): Promise<void> {
  console.log(`[telegram→session] Session "${targetSession}" needs respawn for topic ${topicId}`);

  // Save the old session's Claude UUID before respawning so --resume can reattach context
  if (_topicResumeMap) {
    try {
      const uuid = _topicResumeMap.findUuidForSession(targetSession);
      if (uuid) {
        _topicResumeMap.save(topicId, uuid, targetSession);
        console.log(`[telegram→session] Saved resume UUID ${uuid} for topic ${topicId}`);
      }
    } catch (err) {
      console.error(`[telegram→session] Failed to save resume UUID:`, err);
    }
  }

  // Kill the old tmux session before spawning. spawnInteractiveSession
  // no-ops when a tmux session with the same name already exists (it
  // just injects the message and returns), so without this kill a
  // framework swap via /route would silently keep the old session
  // alive and the new framework binding never takes effect.
  // Idempotent: if the session is already dead the kill is a no-op.
  try {
    execFileSync(detectTmuxPath()!, ['kill-session', '-t', `=${targetSession}`], { stdio: 'ignore' });
  } catch { /* session may already be dead — that's fine */ }
  // Invalidate the framework cache for this tmux name. The kill+respawn
  // may reuse the same name under a different framework (e.g., /route
  // claude-code → codex-cli), and a stale cache entry would make
  // injection use the wrong submit semantics.
  sessionManager.clearSessionFrameworkCache(targetSession);

  let storedName = telegram.getTopicName(topicId);
  // If the name is unknown, try to resolve it from Telegram before falling back
  if (!storedName || /^topic-\d+$/.test(storedName)) {
    const resolved = await telegram.resolveTopicName(topicId);
    if (resolved) storedName = resolved;
  }
  // Use topic name, not tmux session name — tmux names include the project prefix
  // which causes cascading names like ai-guy-ai-guy-ai-guy-topic-1 on each respawn.
  const topicName = storedName || `topic-${topicId}`;

  // If this is a recovery respawn, prepend the recovery context to the message
  // so the session knows what happened and can avoid repeating the failure.
  const effectiveMessage = recoveryPrompt
    ? `${recoveryPrompt}\n\n${latestMessage || 'Session recovered — continue where you left off.'}`
    : latestMessage;

  const newSessionName = await spawnSessionForTopic(sessionManager, telegram, topicName, topicId, effectiveMessage, topicMemory, userProfile);

  telegram.registerTopicSession(topicId, newSessionName, topicName);
  if (!options?.silent) {
    await telegram.sendToTopic(topicId, `Session respawned.`);
  }
  console.log(`[telegram→session] Respawned "${newSessionName}" for topic ${topicId}`);
}

/**
 * Wire up Telegram session management callbacks.
 * These enable /interrupt, /restart, /sessions commands and stall detection.
 */
function wireTelegramCallbacks(
  telegram: TelegramAdapter,
  sessionManager: SessionManager,
  state: StateManager,
  quotaTracker?: QuotaTracker,
  accountSwitcher?: AccountSwitcher,
  claudePath?: string,
  topicMemory?: TopicMemory,
): void {
  // /interrupt — send Escape key to a tmux session
  telegram.onInterruptSession = async (sessionName: string): Promise<boolean> => {
    try {
      execFileSync(detectTmuxPath()!, ['send-keys', '-t', `=${sessionName}:`, 'Escape'], {
        encoding: 'utf-8', timeout: 5000,
      });
      return true;
    } catch {
      // @silent-fallback-ok — interrupt boolean return
      return false;
    }
  };

  // /restart — kill session and respawn. Delegates to SessionRefresh, the
  // consolidated lifecycle owner: it routes the kill through
  // sessionManager.killSession (which fires the kill hook so the UUID
  // listener persists session.claudeSessionId), then spawns a fresh tmux
  // running `claude --resume <uuid>`. Includes the rate guard against
  // infinite-respawn loops.
  //
  // If SessionRefresh isn't wired yet (very narrow early-boot window
  // before startServer reaches the construction point), we no-op with a
  // warning instead of falling back to a broken inline path — the
  // pre-PR inline kill bypassed sessionManager.killSession and so the
  // kill hook never fired, meaning resume UUIDs were silently dropped.
  // Routing exclusively through SessionRefresh fixes that latent issue.
  telegram.onRestartSession = async (sessionName: string, topicId: number): Promise<void> => {
    if (!_sessionRefresh) {
      console.warn(`[telegram /restart] SessionRefresh not yet wired; deferring restart for sessionName=${sessionName} topicId=${topicId}`);
      return;
    }
    const result = await _sessionRefresh.refreshSession({ sessionName, reason: 'telegram-/restart' });
    if (!result.ok) {
      console.warn(`[telegram /restart] SessionRefresh refused sessionName=${sessionName} code=${result.code}`);
    }
  };

  // /sessions — list running sessions
  telegram.onListSessions = () => {
    const sessions = state.listSessions({ status: 'running' });
    return sessions.map(s => ({
      name: s.name,
      tmuxSession: s.tmuxSession,
      status: s.status,
      alive: sessionManager.isSessionAlive(s.tmuxSession),
    }));
  };

  // Stall detection — check if a session is alive
  telegram.onIsSessionAlive = (sessionName: string): boolean => {
    return sessionManager.isSessionAlive(sessionName);
  };

  // Stall verification — check if session has recent output activity
  telegram.onIsSessionActive = async (sessionName: string): Promise<boolean> => {
    const output = sessionManager.captureOutput(sessionName, 20);
    if (!output) return false;

    const lines = output.trim().split('\n').slice(-15);
    // Look for signs of Claude Code activity in recent output
    const activePatterns = [
      /\bRead\b|\bWrite\b|\bEdit\b|\bBash\b|\bGrep\b|\bGlob\b/,  // Tool names
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,  // Spinner characters
      /\d+\s*tokens?/i,     // Token counts
      /Sent \d+ chars/,     // Telegram reply confirmation
    ];

    for (const line of lines) {
      for (const pattern of activePatterns) {
        if (pattern.test(line)) return true;
      }
    }
    return false;
  };

  // /switch-account — swap active Claude Code account
  if (accountSwitcher) {
    telegram.onSwitchAccountRequest = async (target: string, replyTopicId: number): Promise<void> => {
      try {
        const result = await accountSwitcher.switchAccount(target);
        await telegram.sendToTopic(replyTopicId, result.message);
      } catch (err) {
        console.error(`[telegram] Account switch failed:`, err);
        await telegram.sendToTopic(replyTopicId, 'Account switch didn\'t work. There may be an issue with the target account — try again or check /quota for current status.');
      }
    };
  }

  // /quota — show quota status
  if (quotaTracker) {
    telegram.onQuotaStatusRequest = async (replyTopicId: number): Promise<void> => {
      try {
        const quotaState = quotaTracker.getState();
        if (!quotaState) {
          await telegram.sendToTopic(replyTopicId, 'No quota data available.');
          return;
        }
        const recommendation = quotaTracker.getRecommendation();
        const lines = [
          `Weekly: ${quotaState.usagePercent}%`,
          quotaState.fiveHourPercent != null ? `5-Hour: ${quotaState.fiveHourPercent}%` : null,
          `Recommendation: ${recommendation}`,
          `Last updated: ${quotaState.lastUpdated}`,
        ].filter(Boolean);

        // Add account info if available
        if (accountSwitcher) {
          const statuses = accountSwitcher.getAccountStatuses();
          if (statuses.length > 0) {
            lines.push('', 'Accounts:');
            for (const s of statuses) {
              const marker = s.isActive ? '→ ' : '  ';
              const stale = s.isStale ? ' (stale)' : '';
              const expired = s.tokenExpired ? ' (token expired)' : '';
              lines.push(`${marker}${s.name || s.email}: ${s.weeklyPercent}%${stale}${expired}`);
            }
          }
        }

        await telegram.sendToTopic(replyTopicId, lines.join('\n'));
      } catch (err) {
        console.error(`[telegram] Quota check failed:`, err);
        await telegram.sendToTopic(replyTopicId, 'Couldn\'t check quota right now. The usage tracking service may be temporarily unavailable.');
      }
    };
  }

  // Classify session deaths for quota-aware stall detection
  telegram.onClassifySessionDeath = async (sessionName: string): Promise<{ cause: string; detail: string } | null> => {
    try {
      const output = sessionManager.captureOutput(sessionName, 100);
      if (!output) return null;

      const quotaState = quotaTracker?.getState() ?? null;
      const classification = classifySessionDeath(output, quotaState);
      return { cause: classification.cause, detail: classification.detail };
    } catch {
      // @silent-fallback-ok — classify death returns null
      return null;
    }
  };

  // /login — seamless OAuth login flow
  telegram.onLoginRequest = async (email: string | null, replyTopicId: number): Promise<void> => {
    const tmuxPath = detectTmuxPath();
    if (!tmuxPath) {
      await telegram.sendToTopic(replyTopicId, 'Login isn\'t available right now — a required system component is missing. This needs to be set up on the server side.');
      return;
    }

    const loginSession = 'instar-login-flow';

    try {
      // Kill any existing login session
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${loginSession}`], { stdio: 'ignore' });
      } catch { /* @silent-fallback-ok — kill login session, may be dead */ }

      // Start login command in tmux
      const cliPath = claudePath || 'claude';
      const loginCmd = email
        ? `${cliPath} auth login --email "${email}"`
        : `${cliPath} auth login`;

      execFileSync(tmuxPath, ['new-session', '-d', '-s', loginSession, loginCmd], {
        timeout: 10000,
      });

      await telegram.sendToTopic(replyTopicId, `Login flow started${email ? ` for ${email}` : ''}. Watching for OAuth URL...`);

      // Poll for OAuth URL (up to 15 seconds)
      let oauthUrl: string | null = null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const output = sessionManager.captureOutput(loginSession, 50) || '';
          const urlMatch = output.match(/https:\/\/[^\s]+auth[^\s]*/i)
            || output.match(/https:\/\/[^\s]+login[^\s]*/i)
            || output.match(/https:\/\/[^\s]+oauth[^\s]*/i)
            || output.match(/https:\/\/console\.anthropic\.com[^\s]*/i);
          if (urlMatch) {
            oauthUrl = urlMatch[0];
            break;
          }
        } catch { /* retry */ }
      }

      if (!oauthUrl) {
        await telegram.sendToTopic(replyTopicId, 'Could not detect OAuth URL. Check the login session manually.');
        return;
      }

      await telegram.sendToTopic(replyTopicId, `Open this URL to authenticate:\n\n${oauthUrl}\n\nI'll detect when you're done.`);

      // Poll for auth completion (up to 5 minutes)
      let authComplete = false;
      for (let i = 0; i < 300; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const output = sessionManager.captureOutput(loginSession, 30) || '';
          const lower = output.toLowerCase();

          if (lower.includes('successfully') || lower.includes('authenticated') || lower.includes('logged in')) {
            authComplete = true;
            break;
          }

          // Detect "press Enter to continue" prompt
          if (lower.includes('press enter') || lower.includes('press any key')) {
            execFileSync(tmuxPath, ['send-keys', '-t', `=${loginSession}:`, 'Enter'], { timeout: 5000 });
            await new Promise(r => setTimeout(r, 2000));

            // Check if that completed it
            const finalOutput = sessionManager.captureOutput(loginSession, 30) || '';
            if (finalOutput.toLowerCase().includes('successfully') || finalOutput.toLowerCase().includes('authenticated')) {
              authComplete = true;
            }
            break;
          }
        } catch { /* retry */ }
      }

      // Clean up
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${loginSession}`], { stdio: 'ignore' });
      } catch { /* already ended */ }

      if (authComplete) {
        await telegram.sendToTopic(replyTopicId, 'Authentication successful! New sessions will use this account.');
      } else {
        await telegram.sendToTopic(replyTopicId, 'Login flow ended, but I couldn\'t confirm it completed successfully. Try sending a message to test if the new account is working.');
      }
    } catch (err) {
      // Clean up on error
      try {
        execFileSync(tmuxPath, ['kill-session', '-t', `=${loginSession}`], { stdio: 'ignore' });
      } catch { /* ignore */ }
      console.error(`[telegram] Login failed:`, err);
      await telegram.sendToTopic(replyTopicId, 'Login didn\'t complete successfully. Try again, or if this keeps happening, the authentication service may be down.');
    }
  };

  // /route — get or set the framework for this topic. Persists via
  // TopicFrameworksStore (atomic write) and triggers a respawn so the
  // new framework binding takes effect on the next session for this topic.
  telegram.onRouteCommand = async (topicId: number, framework: string | null): Promise<{ ok: boolean; message: string }> => {
    if (framework === null) {
      // Status query — read current resolved framework
      const current = resolveTopicFramework(topicId);
      return { ok: true, message: `This topic is using "${current}". Run /route claude-code or /route codex-cli to switch.` };
    }

    const valid = ['claude-code', 'codex-cli'];
    if (!valid.includes(framework)) {
      return { ok: false, message: `Unknown framework "${framework}". Supported: ${valid.join(', ')}.` };
    }

    if (!_topicFrameworksStore) {
      return { ok: false, message: 'Routing store not initialized — server boot was incomplete. Restart the server.' };
    }

    const prev = resolveTopicFramework(topicId);
    if (prev === framework) {
      return { ok: true, message: `This topic is already on "${framework}". Nothing to change.` };
    }

    _topicFrameworksStore.set(topicId, framework as 'claude-code' | 'codex-cli');

    // Drop any stored resume UUID — it was created under the previous
    // framework's session-id scheme and is meaningless to the new one
    // (Claude UUIDs ≠ Codex session ids). Without this, the new
    // session's --resume flag gets a wrong-shape id, which at best
    // emits a warning and at worst dies during startup.
    _topicResumeMap?.remove(topicId);

    // Trigger a respawn so the new framework takes effect immediately.
    // Re-use the existing respawn path which builds context from TopicMemory.
    const existingSession = telegram.getSessionForTopic(topicId);
    if (existingSession) {
      try {
        await respawnSessionForTopic(
          sessionManager, telegram, existingSession, topicId, undefined,
          topicMemory, undefined, undefined, { silent: true },
        );
      } catch (err) {
        return { ok: false, message: `Persisted "${framework}", but respawn failed: ${err instanceof Error ? err.message : String(err)}. The new framework will take effect on the next session for this topic.` };
      }
    }

    return { ok: true, message: `Routed this topic to "${framework}". ${existingSession ? 'Session respawned.' : 'Will take effect when a session starts for this topic.'}` };
  };

  // /local-model — conversational counterpart of editing config.json.
  // Justin's rule: every config change must be reachable via Telegram.
  // Validates the requested provider is reachable before flipping the
  // binding, then persists via TopicLocalModelStore + respawns.
  telegram.onLocalModelCommand = async (topicId: number, provider: string | null, model: string | null): Promise<{ ok: boolean; message: string }> => {
    if (!_topicLocalModelStore) {
      return { ok: false, message: 'Local-model store not initialized — server boot was incomplete. Restart the server.' };
    }

    // Status query
    if (provider === null) {
      const current = _topicLocalModelStore.get(topicId);
      const fw = resolveTopicFramework(topicId);
      if (!current) {
        return {
          ok: true,
          message: fw === 'codex-cli'
            ? 'This topic is on Codex with the cloud model. Run /local-model ollama [model] to switch to a local model (Ollama / LM Studio supported).'
            : `This topic is on "${fw}", which doesn't support the local-model path. Run /route codex-cli first, then /local-model ollama [model].`,
        };
      }
      return { ok: true, message: `This topic is on Codex via local ${current.provider}${current.model ? ` (model: ${current.model})` : ''}. Run /local-model off to revert to cloud Codex.` };
    }

    // Disable
    if (provider === 'off' || provider === 'none' || provider === 'disable') {
      const cleared = _topicLocalModelStore.clear(topicId);
      if (!cleared) {
        return { ok: true, message: 'This topic was not on a local model. Nothing to change.' };
      }
      _topicResumeMap?.remove(topicId);
      const existingSession = telegram.getSessionForTopic(topicId);
      if (existingSession) {
        try {
          await respawnSessionForTopic(
            sessionManager, telegram, existingSession, topicId, undefined,
            topicMemory, undefined, undefined, { silent: true },
          );
        } catch (err) {
          return { ok: false, message: `Cleared local-model binding, but respawn failed: ${err instanceof Error ? err.message : String(err)}. Effect on next session.` };
        }
      }
      return { ok: true, message: 'Reverted to cloud Codex. Session respawned.' };
    }

    // Validate provider
    const validProviders = ['ollama', 'lmstudio'];
    if (!validProviders.includes(provider)) {
      return { ok: false, message: `Unknown local-model provider "${provider}". Supported: ${validProviders.join(', ')}. Or "/local-model off" to revert.` };
    }

    // Topic must be on codex-cli — local-model goes through Codex --oss.
    const fw = resolveTopicFramework(topicId);
    if (fw !== 'codex-cli') {
      return { ok: false, message: `This topic is on "${fw}". Local models route through Codex CLI's --oss flag, so the topic must be on codex-cli first. Run /route codex-cli, then re-run this command.` };
    }

    // Pre-flight: provider reachability + model availability (best-effort).
    try {
      const { checkLocalProviderReachable } = await import('../providers/adapters/openai-codex/transport/checkLocalProvider.js');
      const reachable = await checkLocalProviderReachable(provider as 'ollama' | 'lmstudio', model ?? undefined);
      if (!reachable.ok) {
        return { ok: false, message: `Can't reach ${provider} — ${reachable.reason}. Once that's fixed, re-run this command.` };
      }
    } catch (err) {
      console.warn('[onLocalModelCommand] reachability check skipped (helper missing):', err);
      // Fall through; spawn will fail loudly if the provider truly isn't reachable.
    }

    _topicLocalModelStore.set(topicId, { provider: provider as 'ollama' | 'lmstudio', ...(model ? { model } : {}) });
    _topicResumeMap?.remove(topicId);

    const existingSession = telegram.getSessionForTopic(topicId);
    if (existingSession) {
      try {
        await respawnSessionForTopic(
          sessionManager, telegram, existingSession, topicId, undefined,
          topicMemory, undefined, undefined, { silent: true },
        );
      } catch (err) {
        return { ok: false, message: `Persisted local-model binding, but respawn failed: ${err instanceof Error ? err.message : String(err)}. Effect on next session.` };
      }
    }

    return { ok: true, message: `Switched this topic to local ${provider}${model ? ` (model: ${model})` : ' (default model)'}. ${existingSession ? 'Session respawned.' : 'Will take effect when a session starts for this topic.'}` };
  };
}

/**
 * Wire up Telegram message routing: topic messages → Claude sessions.
 * This is the core handler that makes Telegram topics work like sessions.
 */
/**
 * Convert a loosely-typed Message (from core/types.ts) to a typed PipelineMessage.
 * This is the bridge between TelegramAdapter's existing Message format and
 * the new typed pipeline contracts. The types enforce that sender identity,
 * topic context, and message content are all present and accounted for.
 */
function messageToPipeline(msg: Message, topicName?: string): PipelineMessage {
  return {
    id: msg.id,
    sender: {
      telegramUserId: (msg.metadata?.telegramUserId as number) ?? 0,
      firstName: (msg.metadata?.firstName as string) ?? 'Unknown',
      username: (msg.metadata?.username as string) ?? undefined,
    },
    topicId: (msg.metadata?.messageThreadId as number) ?? 1,
    topicName,
    content: msg.content,
    type: msg.content.startsWith('[voice]') ? 'voice'
      : msg.content.startsWith('[image:') ? 'photo'
      : msg.content.startsWith('[document:') ? 'document'
      : 'text',
    timestamp: msg.receivedAt,
  };
}

function wireTelegramRouting(
  telegram: TelegramAdapter,
  sessionManager: SessionManager,
  quotaTracker?: QuotaTracker,
  topicMemory?: TopicMemory,
  userManager?: UserManager,
  fixCommandHandler?: (topicId: number, text: string) => Promise<boolean>,
  // Late-bound: the threadline hub deps are constructed AFTER this is wired, so
  // resolve them at message-time (CMT-529 deterministic "open this" intercept).
  getHubDeps?: () => import('../threadline/hubCommands.js').HubBindDeps | null,
): void {
  // Guard: tracks which topic IDs have a spawn in progress.
  // Prevents duplicate concurrent spawns for the same topic when messages
  // arrive faster than the async spawn completes.
  const spawningTopics = new Set<number>();

  telegram.onTopicMessage = async (msg: Message) => {
    const topicId = (msg.metadata?.messageThreadId as number) ?? null;
    if (!topicId) return;

    const text = msg.content;

    // Resolve user profile for context injection (Gap 8)
    const telegramUserId = (msg.metadata?.telegramUserId as number) ?? 0;
    const resolvedUser = telegramUserId && userManager
      ? userManager.resolveFromTelegramUserId(telegramUserId)
      : null;

    // In lifeline-owned polling mode (deep-signal, echo) TelegramAdapter's
    // own poll loop never runs, so its handleCommand() never fires on forwarded
    // messages. Route slash-commands through it here so /route, /sessions, /claim,
    // /flush, etc. behave identically whether the server polls or lifeline does.
    if (text.startsWith('/')) {
      const handled = await telegram.handleCommand(text, topicId, telegramUserId);
      if (handled) return;
    }

    // /new — create a new topic thread. Does NOT spawn a session immediately.
    // Sessions are spawned on-demand when the user sends their first real message
    // in the new topic (via the auto-spawn path below). This avoids premature
    // session exit: spawning with a meta-message ("new session started") gives
    // Claude nothing real to do, so it responds and exits. The user's actual
    // message then arrives to a dead session.
    const newMatch = text.match(/^\/new(?:\s+(.+))?$/);
    if (newMatch) {
      const sessionName = newMatch[1]?.trim() || null;
      const topicName = sessionName || `session-${new Date().toISOString().slice(5, 16).replace('T', '-').replace(':', '')}`;
      const topicEmoji = sessionName ? selectTopicEmoji(sessionName) : TOPIC_STYLE.SESSION.emoji;
      const topicDisplayName = `${topicEmoji} ${topicName}`;

      (async () => {
        try {
          const topic = await telegram.findOrCreateForumTopic(topicDisplayName, TOPIC_STYLE.SESSION.color, { origin: 'user' });
          // Don't create a session — findOrCreateForumTopic already stored the topic name.
          // The first message in this topic will trigger auto-spawn with real content.
          await telegram.sendToTopic(topic.topicId, `Ready — send your first message to start.`);
          await telegram.sendToTopic(topicId, `Created topic "${topicName}" — head over there.`);
          console.log(`[telegram] Created topic "${topicName}" (${topic.topicId}) — session will spawn on first message`);
        } catch (err) {
          console.error(`[telegram] /new failed:`, err);
          await telegram.sendToTopic(topicId, 'Couldn\'t create the topic. Try again in a moment.').catch(() => {});
        }
      })();
      return;
    }

    // ── Threadline hub commands: "open this" / "tie this to <topic>" (CMT-529) ──
    // When a message in the Threadline HUB topic is a deterministic hub command,
    // bind the conversation to a topic STRUCTURALLY — before any agent interprets
    // it. This onTopicMessage seam is the convergence both inbound paths reach
    // (lifeline-forward AND server-polling), so one intercept covers both modes.
    // FAIL-OPEN: any error falls through to normal routing.
    const hubDeps = getHubDeps?.() ?? null;
    if (hubDeps) {
      try {
        let hubTopicId: number | undefined;
        try { hubTopicId = hubDeps.collaborationSurfacer.getHubTopicId(); } catch { hubTopicId = undefined; }
        if (hubTopicId !== undefined && Number(topicId) === Number(hubTopicId)) {
          const { parseHubCommand, bindHubConversation } = await import('../threadline/hubCommands.js');
          const cmd = parseHubCommand(text);
          if (cmd) {
            const result = await bindHubConversation(hubDeps, { ...cmd, autoPick: true }); // human "open this" → auto-pick most-recent, never 409
            if (!result.ok) {
              await telegram.sendToTopic(topicId, result.status === 404
                ? 'Nothing waiting in the hub to open right now.'
                : `Couldn't open that — ${result.error}`).catch(() => { });
            }
            // On success bindHubConversation already posted the hub confirmation.
            return; // structural: never inject the command into a session
          }
        }
      } catch (err) {
        console.warn(`[telegram] hub-command intercept error (fail-open): ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── Fix commands from notification messages ──────────────────────
    // Handle "fix auth", "clean processes", "restart", etc. directly
    // in the server process — no need to spawn a Claude session for these.
    if (fixCommandHandler) {
      const cmdText = text.trim().toLowerCase();
      const isFixCommand = cmdText.startsWith('fix ') || cmdText.startsWith('clean ') ||
        cmdText.startsWith('restart') || cmdText === 'fix' || cmdText === 'clean';
      if (isFixCommand) {
        (async () => {
          try {
            const handled = await fixCommandHandler(topicId, text);
            if (!handled) {
              // Not a recognized fix command — fall through to session routing
              // Re-trigger the normal routing by calling the topic message handler again
              // Actually, since we can't re-trigger, just send a help message
              await telegram.sendToTopic(topicId,
                `I didn't recognize that command. Available fix commands:\n` +
                `• "fix auth" — Generate an API security token\n` +
                `• "fix lifeline" — Restart the crash-recovery system\n` +
                `• "fix shadow" — Remove shadow installation\n` +
                `• "clean processes" — Kill external Claude processes\n` +
                `• "restart" — Restart the server\n` +
                `• "restart sessions" — Restart stuck sessions`
              );
            }
          } catch (err) {
            console.error(`[telegram] Fix command error:`, err);
            await telegram.sendToTopic(topicId,
              `Something went wrong while trying to fix that: ${err instanceof Error ? err.message : String(err)}`
            ).catch(() => {});
          }
        })();
        return;
      }
    }

    // ── Pipeline-typed routing ──────────────────────────────────────
    // Convert to PipelineMessage — types enforce that sender identity
    // and topic context are present at every stage downstream.
    const storedTopicName = telegram.getTopicName(topicId) || undefined;
    const pipeline = messageToPipeline(msg, storedTopicName);

    // Route message to corresponding session
    const targetSession = telegram.getSessionForTopic(topicId);

    // ── Multi-Machine Session Pool (§L4): route through the pool when active ──
    // When the rollout stage is past 'dark', consult the SessionRouter: it may
    // forward this topic's message to the machine that OWNS the session (over the
    // mesh) instead of handling it locally. DARK (the default) skips this block
    // entirely → byte-identical to single-machine dispatch. Any error falls back
    // to the local path below (fail-safe). The live-transfer behavior is gated by
    // the staged rollout (StageAdvancer); shadow records ownership but stays local.
    //
    // §L4 transfer-by-nickname: FIRST, intercept an explicit "move/run this on
    // <nickname>" relocation command. If recognized, it sets the topic's
    // placement pin (+ releases local ownership) and is fully handled here — the
    // command message itself is NOT dispatched to a session. Subsequent messages
    // for the topic then re-place onto the pinned machine via route() below.
    if (_tryNicknameRelocation && _sessionPoolStage() !== 'dark') {
      try {
        const relo = await _tryNicknameRelocation(topicId, text);
        if (relo.handled) return;
      } catch (err) {
        console.warn(`[session-pool] nickname relocation error for topic ${topicId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (_sessionRouter && _sessionPoolStage() !== 'dark') {
      try {
        const outcome = await _sessionRouter.route({
          sessionKey: String(topicId),
          messageId: String(msg.id),
          payload: text,
          topicMetadata: _topicPinStore?.asTopicMetadata(String(topicId)),
        });
        // Routing-decision observability — the live transfer path is otherwise a black
        // box (the recognizer logs its pin, but route()'s actual placement/forward
        // decision was invisible; that hid the bug below from the first live test).
        console.log(`[session-pool] route topic ${topicId} → action=${outcome.action} owner=${outcome.owner ?? '?'} self=${_meshSelfId ?? '?'}`);
        // Short-circuit local dispatch whenever the session ended up on ANOTHER machine
        // (forward/duplicate, OR a fresh remote 'spawned'/'owner-dead-replaced'). Before
        // this, only 'forwarded'/'duplicate' were caught, so a just-moved topic was
        // spawned on the target AND injected into the stale local session
        // (double-dispatch — the bug the first live transfer test surfaced, 2026-05-31).
        if (isRemotelyHandled(outcome, _meshSelfId)) {
          console.log(`[session-pool] topic ${topicId} handled by owner ${outcome.owner ?? '?'} (${outcome.action}) — not dispatching locally`);
          return;
        }
        // 'handled-locally' / 'spawned'(self) / 'owner-dead-replaced'(self) / 'queued' /
        // 'placement-blocked' → fall through to the existing local dispatch below.
      } catch (err) {
        console.warn(`[session-pool] route error for topic ${topicId} — falling back to local dispatch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (targetSession) {
      // Session is mapped — check if it's alive, inject or respawn
      if (sessionManager.isSessionAlive(targetSession)) {
        // Use toInjection() — types guarantee sender identity is included in the tag
        const injection = toInjection(pipeline, targetSession);
        console.log(`[telegram→session] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        sessionManager.injectTelegramMessage(
          targetSession, topicId, text, pipeline.topicName, pipeline.sender.firstName, pipeline.sender.telegramUserId,
          parseInt(pipeline.id.replace('tg-', ''), 10) || undefined,
        );
        // Delivery confirmation — only when WE own polling. When lifeline owns
        // polling (--no-telegram / standby), it already sends its own confirmation.
        if (telegram.isPolling) {
          telegram.sendToTopic(topicId, `✓ Delivered`).catch(() => {});
        }
        // Track for stall detection
        telegram.trackMessageInjection(topicId, targetSession, text);
      } else {
        // Session died — classify death cause before deciding how to respawn
        let isQuotaDeath = false;
        let isContextExhausted = false;
        try {
          const output = sessionManager.captureOutput(targetSession, 100);
          if (output) {
            const quotaState = quotaTracker?.getState() ?? null;
            const classification = classifySessionDeath(output, quotaState);
            if (classification.cause === 'quota_exhaustion' && classification.confidence !== 'low') {
              isQuotaDeath = true;
              telegram.sendToTopic(topicId,
                `🔴 Session died — quota limit reached.\n${classification.detail}\n\n` +
                `Use /switch-account to switch, /login to add an account, or reply again to force restart.`
              ).catch(() => {});
            } else if (classification.cause === 'context_exhausted') {
              isContextExhausted = true;
              telegram.sendToTopic(topicId,
                `🔄 Conversation got too long — starting a fresh session with your recent history.`
              ).catch(() => {});
            }
          }
        } catch { /* classification failed — fall through to respawn */ }

        if (isContextExhausted) {
          // Context exhaustion: respawn FRESH (no --resume) — the old conversation
          // is too large to continue. The respawn path will load telegram thread
          // history as context, giving the new session continuity.
          if (spawningTopics.has(topicId)) {
            console.log(`[telegram→session] Spawn already in progress for topic ${topicId} — skipping duplicate respawn`);
            return;
          }
          spawningTopics.add(topicId);
          // Remove the resume UUID so respawnSessionForTopic doesn't try --resume
          if (_topicResumeMap) {
            _topicResumeMap.remove(topicId);
          }
          respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text, topicMemory, resolvedUser ?? undefined)
            .catch(err => {
              console.error(`[telegram→session] Context exhaustion respawn failed:`, err);
              telegram.sendToTopic(topicId, `❌ Fresh session restart failed. Try sending your message again.`).catch(() => {});
            })
            .finally(() => {
              spawningTopics.delete(topicId);
            });
        } else if (!isQuotaDeath) {
          // Guard: skip respawn if one is already in progress for this topic.
          // Prevents the infinite respawn loop: dead session + rapid messages → each
          // message triggers a new respawn → multiple concurrent spawns → chaos.
          if (spawningTopics.has(topicId)) {
            console.log(`[telegram→session] Spawn already in progress for topic ${topicId} — skipping duplicate respawn`);
            return;
          }
          spawningTopics.add(topicId);
          telegram.sendToTopic(topicId, `🔄 Session restarting — message queued.`).catch(() => {});
          respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, text, topicMemory, resolvedUser ?? undefined)
            .catch(err => {
              console.error(`[telegram→session] Respawn failed:`, err);
              const errMsg = err instanceof Error ? err.message : String(err);
              const userMsg = errMsg.includes('session limit') || errMsg.includes('limit')
                ? `❌ Session restart failed — session limit reached. Close an existing session or increase maxSessions in your config, then try again.`
                : `❌ Session restart failed. Try sending your message again in a moment.`;
              telegram.sendToTopic(topicId, userMsg).catch(() => {});
            })
            .finally(() => {
              spawningTopics.delete(topicId);
            });
        }
      }
    } else {
      // No session mapped — auto-spawn with topic history (same as respawn path).
      // Without history, the agent has no conversational context and gives blind answers.
      console.log(`[telegram→session] No session for topic ${topicId}, auto-spawning with history...`);

      // Guard: skip spawn if one is already in progress for this topic.
      if (spawningTopics.has(topicId)) {
        telegram.sendToTopic(topicId, `Session is still starting up — please wait a moment.`).catch(() => {});
        console.log(`[telegram→session] Spawn already in progress for topic ${topicId} — skipping duplicate`);
        return;
      }

      spawningTopics.add(topicId);

      // Resolve topic name — try in-memory, then active probe, then fallback
      let spawnName = storedTopicName;
      if (!spawnName || /^topic-\d+$/.test(spawnName)) {
        const resolved = await telegram.resolveTopicName(topicId);
        if (resolved) spawnName = resolved;
      }
      if (!spawnName) spawnName = `topic-${topicId}`;

      // Use the shared spawn helper that includes topic history + user context
      spawnSessionForTopic(sessionManager, telegram, spawnName, topicId, text, topicMemory, resolvedUser ?? undefined).then((newSessionName) => {
        telegram.registerTopicSession(topicId, newSessionName, spawnName);
        telegram.sendToTopic(topicId, `Session starting up — reading your message now. One moment.`).catch(() => {});
        console.log(`[telegram→session] Auto-spawned "${newSessionName}" for topic ${topicId}`);
      }).catch((err) => {
        console.error(`[telegram→session] Auto-spawn failed:`, err);
        const errMsg = err instanceof Error ? err.message : String(err);
        const userMsg = errMsg.includes('session limit') || errMsg.includes('limit')
          ? `❌ Unable to start session — session limit reached. Close an existing session or increase maxSessions in your config, then try again.`
          : 'Having trouble starting a session right now. Try sending your message again in a moment.';
        telegram.sendToTopic(topicId, userMsg).catch(() => {});
      }).finally(() => {
        spawningTopics.delete(topicId);
      });
    }
  };
}

/**
 * Wire WhatsApp message routing: incoming messages → Claude sessions.
 *
 * Similar to wireTelegramRouting but for WhatsApp JIDs instead of Telegram topics.
 * Maps JIDs to sessions, spawns new sessions for new conversations,
 * injects messages into existing sessions, and handles respawning.
 */
function wireWhatsAppRouting(
  whatsapp: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter,
  sessionManager: SessionManager,
): void {
  whatsapp.onMessage(async (msg) => {
    const jid = msg.channel?.identifier;
    if (!jid) return;

    const text = msg.content;
    const senderName = (msg.metadata?.senderName as string) ?? undefined;

    // Check for existing session
    const targetSession = whatsapp.getSessionForChannel(jid);

    if (targetSession) {
      // Session exists — check if alive
      if (sessionManager.isSessionAlive(targetSession)) {
        console.log(`[whatsapp→session] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        sessionManager.injectWhatsAppMessage(targetSession, jid, text, senderName);
      } else {
        // Session died — respawn
        console.log(`[whatsapp→session] Session "${targetSession}" died, respawning...`);
        try {
          const replyInstruction = `(IMPORTANT: Relay all responses back via: cat <<'EOF' | .instar/scripts/whatsapp-reply.sh ${jid}\nYour response\nEOF)`;
          const bootstrap = `[whatsapp:${jid}] ${text} ${replyInstruction}`;
          const sessionName = `wa-${jid.split('@')[0].slice(-6)}`;
          const newSession = await sessionManager.spawnInteractiveSession(bootstrap, sessionName);
          whatsapp.registerSession(jid, newSession);
          console.log(`[whatsapp→session] Respawned "${newSession}" for ${jid}`);
        } catch (err) { // @silent-fallback-ok — matches Telegram respawn pattern
          console.error(`[whatsapp→session] Respawn failed:`, err);
        }
      }
    } else {
      // No session — auto-spawn
      console.log(`[whatsapp→session] No session for ${jid}, auto-spawning...`);
      try {
        const replyInstruction = `(IMPORTANT: Relay all responses back via: cat <<'EOF' | .instar/scripts/whatsapp-reply.sh ${jid}\nYour response\nEOF)`;
        const bootstrap = `[whatsapp:${jid}${senderName ? ` from ${senderName}` : ''}] ${text} ${replyInstruction}`;
        const sessionName = `wa-${jid.split('@')[0].slice(-6)}`;
        const newSession = await sessionManager.spawnInteractiveSession(bootstrap, sessionName);
        whatsapp.registerSession(jid, newSession);
        console.log(`[whatsapp→session] Spawned "${newSession}" for ${jid}`);
      } catch (err) { // @silent-fallback-ok — matches Telegram auto-spawn pattern
        console.error(`[whatsapp→session] Auto-spawn failed:`, err);
      }
    }
  });
}

/**
 * Wire iMessage message routing — mirrors Telegram's session patterns exactly.
 *
 * Routes incoming iMessages to Claude Code sessions using the same flow as Telegram:
 * 1. Existing alive session → injectIMessageMessage (with pendingInjections tracking)
 * 2. Existing dead session → respawn via spawnInteractiveSession(bootstrapMessage)
 * 3. No session → auto-spawn via spawnInteractiveSession(bootstrapMessage)
 *
 * Key design: the bootstrap message (with inline context) is passed as the
 * initialMessage to spawnInteractiveSession, which handles wait-for-ready and
 * injection internally — the same code path that Telegram uses successfully.
 */
function wireIMessageRouting(
  imessage: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter,
  sessionManager: SessionManager,
): void {
  const spawningSenders = new Set<string>();

  // Wire session alive check for stall detection
  imessage.setIsSessionAlive((sessionName) => sessionManager.isSessionAlive(sessionName));

  const replyScript = '.claude/scripts/imessage-reply.sh';

  /**
   * Build a bootstrap message for spawning an iMessage session.
   * Follows Telegram's spawnSessionForTopic pattern: context is INLINE in the
   * bootstrap message, not a file reference. For long messages, writes to a temp
   * file with a strong read instruction (matching Telegram's BOOTSTRAP_FILE_THRESHOLD).
   */
  function buildBootstrapMessage(sender: string, text: string, senderName?: string): string {
    // Get conversation history from chat.db (includes both user AND agent messages)
    const conversationContext = imessage.getConversationContext(sender, 30);

    const parts: string[] = [];

    if (conversationContext) {
      parts.push(
        `CONTINUATION — You are resuming an EXISTING conversation via iMessage.`,
        `Read the context below before responding.`,
        ``,
        conversationContext,
        ``,
        `IMPORTANT: Your response MUST acknowledge and continue the conversation above. Do NOT introduce yourself or ask "how can I help" — the user has been talking to you. Pick up where the conversation left off.`,
        ``,
      );
    }

    // Sanitize sender name to prevent injection via chat.db display_name
    const safeSenderName = senderName ? senderName.replace(/[\[\]`$\\]/g, '') : undefined;

    // iMessage relay instructions
    parts.push(
      `--- iMessage SESSION (${sender}) ---`,
      `This is a PERSISTENT conversational session via iMessage.`,
      `MANDATORY: After EVERY response, relay your message back to the user:`,
      `  cat <<'EOF' | ${replyScript} "${sender}"`,
      `  Your response text here`,
      `  EOF`,
      ``,
      `CRITICAL: After replying, STAY AT THE PROMPT and wait for follow-up messages.`,
      `Do NOT exit. More messages will be injected as [imessage:${sender}] prefixed text.`,
      `Strip the [imessage:...] prefix before interpreting messages.`,
      `Only relay conversational text — not tool output or internal reasoning.`,
      `--- END iMessage SESSION ---`,
      ``,
      `The user's latest message:`,
      `[imessage:${sender}${safeSenderName ? ` from ${safeSenderName}` : ''}] ${text}`,
    );

    let bootstrapMessage = parts.join('\n');

    // Large bootstrap messages: write to temp file with strong read instruction
    // (matches Telegram's BOOTSTRAP_FILE_THRESHOLD pattern)
    const BOOTSTRAP_FILE_THRESHOLD = 500;
    if (bootstrapMessage.length > BOOTSTRAP_FILE_THRESHOLD) {
      const tmpDir = '/tmp/instar-imessage';
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      // Clean up old temp files (>1 hour) to prevent unbounded accumulation
      try {
        const cutoff = Date.now() - 3_600_000;
        for (const f of fs.readdirSync(tmpDir)) {
          const fp = path.join(tmpDir, f);
          try { if (fs.statSync(fp).mtimeMs < cutoff) SafeFsExecutor.safeUnlinkSync(fp, { operation: 'src/commands/server.ts:1257' }); } catch { /* ignore */ }
        }
      } catch { /* non-critical */ }
      const senderSlug = sender.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
      const filepath = path.join(tmpDir, `bootstrap-${senderSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(filepath, bootstrapMessage, { mode: 0o600 });
      console.log(`[imessage→session] Bootstrap too large (${bootstrapMessage.length} chars), wrote to ${filepath}`);
      bootstrapMessage = `[IMPORTANT: Read ${filepath} — it contains your full session context, conversation history, and the user's latest message. You MUST read this file before responding.]`;
    }

    return bootstrapMessage;
  }

  imessage.onMessage(async (msg) => {
    const sender = msg.channel?.identifier;
    if (!sender) return;

    // Build the text with attachment references inlined. iMessage stores the
    // attachment placeholder character (\uFFFC) in the text where the photo sits,
    // but doesn't include the path. We replace placeholders with explicit
    // [image:/path] tags (matching the Telegram pattern) so Claude can read the
    // files via the Read tool. Attachments are auto-hardlinked into
    // .instar/imessage/attachments/ by the user-context sync script, avoiding
    // the need for FDA on node.
    let text = msg.content;
    const attachments = (msg.metadata?.attachments as Array<{
      filename?: string;
      mimeType?: string;
      path?: string;
    }>) ?? [];
    if (attachments.length > 0) {
      // If text has no placeholders but has attachments, append refs at the end.
      // Otherwise replace each \uFFFC with an [image:/path] tag sequentially.
      const tags = attachments.map((a) => {
        if (!a.path) return '[attachment path unavailable]';
        // For images/PDFs/etc., use [image:...] so Claude's existing handling applies.
        // The path will be the hardlinked one if the sync script ran; otherwise
        // the TCC-protected original (which Claude may or may not be able to read).
        const isImage = (a.mimeType || '').startsWith('image/');
        const kind = isImage ? 'image' : 'file';
        return `[${kind}:${a.path}]`;
      });
      if (text.includes('\uFFFC')) {
        // Replace each placeholder with the next tag
        let i = 0;
        text = text.replace(/\uFFFC/g, () => tags[i++] ?? '[image:missing]');
      } else {
        // No inline placeholders — append tags at the end
        text = (text ? text + ' ' : '') + tags.join(' ');
      }
    }

    const senderName = (msg.metadata?.senderName as string) ?? undefined;
    const senderNorm = sender.toLowerCase();

    // Skip empty messages (reactions, read receipts, lookback artifacts)
    if (!text || !text.trim()) return;

    // Check for existing session
    const targetSession = imessage.getSessionForSender(sender);

    // Guard: skip if spawn already in progress for this sender
    if (spawningSenders.has(senderNorm)) {
      console.log(`[imessage→session] Spawn already in progress for ${senderNorm} — skipping`);
      return;
    }

    if (targetSession && sessionManager.isSessionAlive(targetSession)) {
      // Session alive — inject directly (same as Telegram's injectTelegramMessage path)
      console.log(`[imessage→session] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
      sessionManager.injectIMessageMessage(targetSession, sender, text, senderName);
      imessage.trackMessageInjection(sender, targetSession, text);
    } else {
      // Session dead or missing — spawn with full context (same as Telegram's spawnSessionForTopic)
      spawningSenders.add(senderNorm);

      // Use a hash of the full sender to avoid collisions (slice(-6) collides easily)
      const crypto = await import('node:crypto');
      const senderHash = crypto.createHash('sha1').update(sender.toLowerCase()).digest('hex').slice(0, 8);
      const sessionName = `im-${senderHash}`;
      const bootstrapMessage = buildBootstrapMessage(sender, text, senderName);

      // Pass bootstrap as initialMessage — spawnInteractiveSession handles
      // wait-for-ready and injection internally (same code path as Telegram)
      sessionManager.spawnInteractiveSession(bootstrapMessage, sessionName)
        .then((newSession) => {
          imessage.registerSession(sender, newSession);
          console.log(`[imessage→session] Spawned "${newSession}" for ${(imessage.constructor as any).maskIdentifier?.(sender) || sender}`);
        })
        .catch((err) => {
          console.error(`[imessage→session] Spawn failed:`, err);
        })
        .finally(() => {
          spawningSenders.delete(senderNorm);
        });
    }
  });
}

/**
 * Ensure the Agent Attention topic exists — the agent's direct line to the user.
 * Created once on first server start, persisted in state.
 */
async function ensureAgentAttentionTopic(
  telegram: TelegramAdapter,
  state: StateManager,
): Promise<void> {
  const existingTopicId = state.get<number>('agent-attention-topic');
  if (existingTopicId) {
    console.log(`  Agent Attention topic: ${existingTopicId}`);
    return;
  }

  try {
    const topic = await telegram.createForumTopic(
      `${TOPIC_STYLE.ALERT.emoji} Attention`,
      TOPIC_STYLE.ALERT.color, // Yellow — needs user action
      { origin: 'system' }, // bounded create-once boot topic
    );
    state.set('agent-attention-topic', topic.topicId);
    await telegram.sendToTopic(topic.topicId,
      `This is your agent's direct line to you — for things that genuinely need your attention.\n\nBlocked tasks, critical errors, memory pressure, quota alerts, and anything where your agent can't proceed without you.`
    );
    console.log(pc.green(`  Created Agent Attention topic: ${topic.topicId}`));
  } catch (err) {
    console.error(`  Failed to create Agent Attention topic: ${err}`);
  }
}

/**
 * Ensure a Slack attention channel exists — for operational alerts routed via Slack.
 */
async function ensureSlackAttentionChannel(
  slack: import('../messaging/slack/SlackAdapter.js').SlackAdapter,
  state: StateManager,
): Promise<void> {
  const existingChannelId = state.get<string>('slack-attention-channel');
  if (existingChannelId) {
    console.log(`  Slack Attention channel: ${existingChannelId}`);
    return;
  }

  try {
    const agentName = (slack as unknown as { config: { workspaceName?: string } }).config?.workspaceName?.replace(/-agent$/, '') || 'agent';
    const channelId = await slack.createChannel(`${agentName}-sys-attention`);
    state.set('slack-attention-channel', channelId);
    await slack.sendToChannel(channelId,
      `Attention channel active. Blocked tasks, critical errors, quota alerts, and anything that needs your attention will appear here.`
    );
    console.log(pc.green(`  Created Slack Attention channel: ${channelId}`));
  } catch (err) {
    console.error(`  Failed to create Slack Attention channel: ${err}`);
  }
}

/**
 * Ensure a Slack updates channel exists — for version updates and feature announcements.
 */
async function ensureSlackUpdatesChannel(
  slack: import('../messaging/slack/SlackAdapter.js').SlackAdapter,
  state: StateManager,
): Promise<void> {
  const existingChannelId = state.get<string>('slack-updates-channel');
  if (existingChannelId) return;

  try {
    const agentName = (slack as unknown as { config: { workspaceName?: string } }).config?.workspaceName?.replace(/-agent$/, '') || 'agent';
    const channelId = await slack.createChannel(`${agentName}-sys-updates`);
    state.set('slack-updates-channel', channelId);
    await slack.sendToChannel(channelId,
      `Updates channel active. Version updates, new features, and system announcements will appear here.`
    );
    console.log(`  Created Slack Updates channel: ${channelId}`);
  } catch (err) {
    console.error(`  Failed to create Slack Updates channel: ${err}`);
  }
}

/**
 * Ensure the Agent Updates topic exists — for version updates, feature announcements, etc.
 * Separates informational updates from critical attention items.
 * Created once on first server start, persisted in state.
 */
async function ensureAgentUpdatesTopic(
  telegram: TelegramAdapter,
  state: StateManager,
): Promise<void> {
  const existingTopicId = state.get<number>('agent-updates-topic');
  if (existingTopicId) {
    console.log(`  Agent Updates topic: ${existingTopicId}`);
    return;
  }

  try {
    const topic = await telegram.createForumTopic(
      `${TOPIC_STYLE.INFO.emoji} Updates`,
      TOPIC_STYLE.INFO.color, // Blue — informational
      { origin: 'system' }, // bounded create-once boot topic
    );
    state.set('agent-updates-topic', topic.topicId);
    await telegram.sendToTopic(topic.topicId,
      `This is where I'll post updates about new features, version changes, and improvements.\n\nNothing urgent — just keeping you in the loop about what's new.`
    );
    console.log(pc.green(`  Created Agent Updates topic: ${topic.topicId}`));
  } catch (err) {
    console.error(`  Failed to create Agent Updates topic: ${err}`);
  }
}

/**
 * Find npm's CLI entry point (npm-cli.js) so we can run npm via
 * `execFileSync(process.execPath, [npmCli, ...args])` — no shell required.
 * This avoids "/bin/sh ENOENT" failures in minimal/containerized environments.
 */
function findNpmCli(): string {
  // npm ships alongside node — look for it relative to process.execPath
  const nodeDir = path.dirname(process.execPath);

  // Standard layout: node is in bin/, npm-cli.js is in lib/node_modules/npm/bin/npm-cli.js
  const libNpmCli = path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(libNpmCli)) return libNpmCli;

  // Homebrew on macOS: node in /opt/homebrew/bin, npm-cli in /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js
  // (same layout, but verify explicitly for clarity)
  for (const candidate of [
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Last resort: use the npm shell wrapper (requires shell, but at least we tried)
  const npmBin = path.join(nodeDir, 'npm');
  if (fs.existsSync(npmBin)) return npmBin;

  throw new Error('Cannot find npm CLI — native module rebuild unavailable');
}

/**
 * Pre-flight check: ensure better-sqlite3 native bindings are compiled for the current Node.js version.
 *
 * Both TopicMemory and SemanticMemory use better-sqlite3. When Telegram is not configured,
 * TopicMemory never initializes, so the TopicMemory-embedded rebuild logic never runs.
 * SemanticMemory then fails with "Could not locate the bindings file."
 *
 * This runs ONCE at startup, before any SQLite subsystem initializes, making the rebuild
 * unconditionally available to all consumers.
 */
/**
 * Returns true if a rebuild was performed and a process restart is needed.
 *
 * ESM module import failures are cached in Node.js's module registry. Once
 * `import('better-sqlite3')` fails, subsequent imports by SemanticMemory,
 * TopicMemory etc. get the same cached error — even after a successful rebuild.
 * The only way to clear the cache is to restart the process so all subsystems
 * start fresh with the rebuilt bindings.
 */
async function ensureSqliteBindings(): Promise<boolean> {
  try {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    // Import alone doesn't catch all mismatches — some NODE_MODULE_VERSION
    // conflicts cause runtime crashes (C++ mutex errors) rather than import errors.
    // Actually opening an in-memory DB exercises the native bindings fully.
    const testDb = new BetterSqlite3(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.close();
    return false;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const isBindingError =
      reason.includes('Could not locate the bindings file') ||
      reason.includes('better-sqlite3') ||
      reason.includes('was compiled against a different Node.js version') ||
      reason.includes('NODE_MODULE_VERSION') ||
      reason.includes('mutex lock failed');

    if (!isBindingError) return false; // Not a binding issue — let subsystems handle it.

    console.log(pc.yellow('  better-sqlite3: native binding mismatch detected — auto-rebuilding for current Node.js version...'));

    // Heal-execpath-staleness fix: resolve a stable Node binary BEFORE spawning.
    // When Homebrew (or any package manager) updates Node mid-session, the
    // running process holds an FD to the original binary so it keeps executing,
    // but spawnSync(process.execPath, …) returns ENOENT because the file is
    // gone from disk. Observed live on luna 2026-05-21. See src/utils/resolveNodeBinary.ts.
    const resolved = resolveStableNodeBinary();
    if (!resolved) {
      const recoveryHint =
        'No working Node.js binary found at process.execPath or any fallback ' +
        '(/opt/homebrew/bin/node, /usr/local/bin/node, /usr/bin/node, PATH). ' +
        'This typically means Node was uninstalled or moved while the server ' +
        'was running. Reinstall Node, then restart the agent.';
      console.log(pc.yellow(`  better-sqlite3: ${recoveryHint}`));
      DegradationReporter.getInstance().report({
        feature: 'ensureSqliteBindings.nodeBinaryResolution',
        primary: 'Locate a working Node.js binary to run the better-sqlite3 rebuild',
        fallback: 'Rebuild skipped — SQLite subsystems will degrade until operator restores Node',
        reason: `Why: process.execPath (${process.execPath}) is ENOENT and no fallback resolved`,
        impact: recoveryHint,
      });
      return false;
    }
    const spawnNode = resolved.path;
    if (spawnNode !== process.execPath) {
      console.log(pc.dim(`  better-sqlite3: process.execPath (${process.execPath}) unreachable; using ${resolved.source} fallback at ${spawnNode}`));
    }

    try {
      // Use the bundled fix script which downloads correct prebuilds from GitHub.
      // This is more reliable than `npm rebuild` which fails with pnpm/asdf installs.
      const fixScript = path.resolve(__dirname, '../../../scripts/fix-better-sqlite3.cjs');
      if (fs.existsSync(fixScript)) {
        execFileSync(spawnNode, [fixScript], { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' });
      } else {
        // Fallback: npm rebuild in the directory containing better-sqlite3.
        // Shadow installs have their own node_modules — try that first, then global.
        // IMPORTANT: Use execFileSync (no shell) instead of execSync to avoid
        // "/bin/sh ENOENT" failures in minimal/containerized environments.
        const npmCli = findNpmCli();
        const instarDir = path.resolve(__dirname, '../../..');
        const shadowBs3 = path.join(instarDir, 'node_modules', 'better-sqlite3');
        if (fs.existsSync(shadowBs3)) {
          execFileSync(spawnNode, [npmCli, 'rebuild', 'better-sqlite3'], {
            cwd: instarDir,
            encoding: 'utf-8',
            timeout: 60000,
            stdio: 'pipe',
          });
        } else {
          const globalInstarDir = execFileSync(spawnNode, [npmCli, 'root', '-g'], { encoding: 'utf-8', timeout: 10000 }).toString().trim() + '/instar';
          execFileSync(spawnNode, [npmCli, 'rebuild', 'better-sqlite3'], {
            cwd: globalInstarDir,
            encoding: 'utf-8',
            timeout: 60000,
            stdio: 'pipe',
          });
        }
      }
      console.log(pc.green('  better-sqlite3: rebuilt successfully — restarting to apply (ESM module cache must be cleared).'));
      return true; // Restart needed — ESM cache holds the stale failure
    } catch (rebuildErr) {
      const rebuildMsg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
      console.log(pc.yellow(`  better-sqlite3: rebuild failed (${rebuildMsg}). SQLite subsystems may degrade.`));
      DegradationReporter.getInstance().report({
        feature: 'ensureSqliteBindings.rebuildFailed',
        primary: 'Rebuild better-sqlite3 native bindings for the current Node.js version',
        fallback: 'SQLite subsystems (SemanticMemory, TopicMemory, FeatureRegistry) will degrade until rebuild succeeds',
        reason: `Why: ${rebuildMsg}`,
        impact:
          'The agent is running but its knowledge graph, conversation summaries, and ' +
          'related sqlite-backed subsystems are offline. The most common cause is a ' +
          'Node upgrade landed after the server started. Restart the agent to pick up ' +
          'the rebuilt binding; if rebuild itself keeps failing, run `npx instar update` ' +
          'or reinstall the agent.',
      });
      return false;
    }
  }
}

/**
 * Clean up stale project-local Telegram inbound files.
 * Removes files older than 7 days to prevent unbounded accumulation.
 */
function cleanupTelegramTempFiles(): void {
  const tmpDir = getTelegramInboundDir(_projectDir);
  try {
    if (!fs.existsSync(tmpDir)) return;
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    let cleaned = 0;
    for (const file of fs.readdirSync(tmpDir)) {
      try {
        const filepath = path.join(tmpDir, file);
        const stat = fs.statSync(filepath);
        if (stat.isFile() && now - stat.mtimeMs > maxAge) {
          SafeFsExecutor.safeUnlinkSync(filepath, { operation: 'src/commands/server.ts:1592' });
          cleaned++;
        }
      } catch { /* @silent-fallback-ok — temp file cleanup */ }
    }
    if (cleaned > 0) {
      console.log(`[cleanup] Removed ${cleaned} stale temp files from ${tmpDir}`);
    }
  } catch {
    // @silent-fallback-ok — temp dir cleanup
  }
}

/**
 * Tee stdout/stderr to a log file for observability.
 * The self-diagnosis job checks .instar/logs/server.log — this ensures it exists.
 * Log is truncated at 5MB to prevent unbounded growth.
 */
function getInstalledVersion(): string {
  try {
    const pkgPath = resolvePackageJsonPath();
    if (pkgPath) return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || '';
    return '';
  } catch (err) {
    DegradationReporter.getInstance().report({
      feature: 'server.getInstalledVersion',
      primary: 'Read installed package version from package.json',
      fallback: 'Return empty string — version unknown',
      reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
      impact: 'Version display and upgrade guide notifications may use blank version',
    });
    return '';
  }
}

/**
 * Resolve path to instar's package.json.
 * Used by ProcessIntegrity for live disk version reads.
 */
function resolvePackageJsonPath(): string | null {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    if (fs.existsSync(pkgPath)) return pkgPath;
  } catch {
    // @silent-fallback-ok — best-effort path resolution for package.json; null return is the documented default
  }
  return null;
}

function setupServerLog(stateDir: string): void {
  const logDir = path.join(stateDir, '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'server.log');

  // Truncate if over 5MB
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 5 * 1024 * 1024) {
      // Keep last 1MB
      const content = fs.readFileSync(logPath, 'utf-8');
      fs.writeFileSync(logPath, content.slice(-1024 * 1024));
    }
  } catch { /* file doesn't exist yet */ }

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  const timestamp = () => new Date().toISOString();

  console.log = (...args: unknown[]) => {
    origLog(...args);
    logStream.write(`${timestamp()} [LOG] ${args.map(String).join(' ')}\n`);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    logStream.write(`${timestamp()} [WARN] ${args.map(String).join(' ')}\n`);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    logStream.write(`${timestamp()} [ERROR] ${args.map(String).join(' ')}\n`);
  };
}

export async function startServer(options: StartOptions): Promise<void> {
  const config = loadConfig(options.dir);
  ensureStateDir(config.stateDir);

  // LiveConfig: dynamic config re-reading for long-running server process.
  // Solves the "Written But Not Re-Read" class of bugs — sessions modify
  // config.json but the server process never picks up the changes.
  const liveConfig = new LiveConfig(config.stateDir, {
    watchPaths: ['updates.autoApply', 'sessions.maxSessions', 'monitoring'],
  });
  liveConfig.start();

  // Threadline → Telegram bridge config — settings surface for the bridge
  // module. Default-OFF auto-create ships from day one;
  // see TelegramBridgeConfig for the policy.
  const { TelegramBridgeConfig } = await import('../threadline/TelegramBridgeConfig.js');
  const telegramBridgeConfig = new TelegramBridgeConfig(liveConfig);

  // The actual bridge module is instantiated AFTER the Telegram adapter is
  // wired (further down in this file). Held as a let so closures formed
  // here can reference whatever instance ends up assigned. Bridge is
  // RELAY-ONLY (signal-vs-authority compliant): emits no routing decisions,
  // blocks nothing. Authority lives in TelegramBridgeConfig.
  let telegramBridge: import('../threadline/TelegramBridge.js').TelegramBridge | null = null;

  // Read-only observability layer over canonical inbox/outbox/bindings.
  // Stateless — reads files at every query. Powers the dashboard
  // Threadline tab via /threadline/observability/* endpoints.
  const { ThreadlineObservability } = await import('../threadline/ThreadlineObservability.js');
  const threadlineObservability = new ThreadlineObservability({ stateDir: config.stateDir });

  // NotificationBatcher: consolidate all Telegram notifications into tiered delivery.
  // IMMEDIATE = user needs to act NOW (quota exhausted, critical stall)
  // SUMMARY = batched every 30 min (degradations, coherence, orphan reports)
  // DIGEST = batched every 2 hrs (updates, wake events, routine lifecycle)
  // Principle: Log everything, notify selectively.
  const notificationBatcher = new NotificationBatcher({
    enabled: true,
    summaryIntervalMinutes: 30,
    digestIntervalMinutes: 120,
  });

  // State reference — set once StateManager is created, used by notify()
  let _notifyState: { get<T>(key: string): T | null | undefined } | null = null;

  /**
   * Central notification gateway — ALL non-interactive notifications should go through here.
   * Sends to both Telegram (via batcher) and Slack (directly) when available.
   * Interactive messages (session replies, user-facing responses) still use sendToTopic/sendToChannel directly.
   */
  function notify(tier: NotificationTier, category: string, message: string, topicId?: number): void {
    // Telegram: via notification batcher
    const resolvedTopicId = topicId ?? _notifyState?.get<number>('agent-attention-topic') ?? 0;
    if (resolvedTopicId) {
      notificationBatcher.enqueue({
        tier,
        category,
        message,
        timestamp: new Date(),
        topicId: resolvedTopicId,
      }).catch(() => { /* @silent-fallback-ok */ });
    }

    // Slack: send all notification tiers to attention channel
    if (_slackAdapter) {
      const slackAttentionChannel = _notifyState?.get<string>('slack-attention-channel');
      if (slackAttentionChannel) {
        _slackAdapter.sendToChannel(slackAttentionChannel, message).catch(() => { /* @silent-fallback-ok */ });
      }
    }
  }

  /**
   * Translate coherence check failures into human-readable, actionable messages.
   */
  function formatCoherenceFailure(checkName: string, message: string): string {
    switch (checkName) {
      case 'output-sanity':
        return `I noticed some of my recent messages might contain placeholder text or raw internal references. Reply "fix output" and I'll clean that up.`;
      case 'readiness-auth-token':
        return `My API doesn't have an auth token set, which means anyone with the URL could access it. Reply "fix auth" to lock it down.`;
      case 'readiness-dashboard-pin':
        return `The dashboard doesn't have a PIN yet. Reply "fix dashboard" to set one up.`;
      case 'readiness-telegram-token':
        return `I can't connect to Telegram — the bot token is missing from my config. Check .instar/config.json to set it up.`;
      case 'config-file-valid':
        return `My config file looks damaged, which might cause unexpected behavior. Reply "fix config" and I'll try to repair it.`;
      case 'process-version-mismatch': {
        // Extract versions from message like "Running v0.21.0 but disk has v0.21.1 — restart needed"
        const versionMatch = message.match(/v[\d.]+/g);
        const newVersion = versionMatch && versionMatch.length >= 2 ? versionMatch[1] : 'a newer version';
        return `There's an update ready (${newVersion}). Reply "restart" to apply it.`;
      }
      case 'shadow-installation':
        return `A local copy of instar is overriding the global install, which blocks auto-updates. Reply "fix shadow" to remove it.`;
      case 'state-topic-registry':
        return `My topic routing got corrupted — messages might be landing in the wrong threads. Reply "fix registry" to rebuild it.`;
      default:
        return `${checkName}: ${message}`;
    }
  }

  // Migration disabled — we manage updates via the daily rebase job,
  // not via npm auto-updates. The migration was forcing autoApply: true
  // which overwrites our intentional autoApply: false setting.

  const serverSessionName = `${config.projectName}-server`;

  // Migration-parity warning: an EXISTING agent whose port predates the
  // fetch-blocked-port allocator guard (or was set by hand) silently can't mesh —
  // node fetch refuses WHATWG bad ports (e.g. 4045 = NFS lockd). New agents now
  // skip these at allocation; surface it loudly for ones already on a bad port so
  // the operator can re-port. (2026-06-02 incident.)
  if (typeof config.port === 'number' && isFetchBlockedPort(config.port)) {
    console.warn(pc.yellow(
      `  ⚠ Port ${config.port} is on the WHATWG fetch "bad ports" list — multi-machine ` +
      `mesh (pairing/lease/heartbeat use node fetch) CANNOT reach this agent on this port. ` +
      `Change "port" in .instar/config.json to a non-blocked port (e.g. 4040–4044, 4046–4099) ` +
      `and restart if you use multi-machine.`,
    ));
  }

  if (options.foreground) {
    // Run in foreground — useful for development
    console.log(pc.bold(`Starting instar server for ${pc.cyan(config.projectName)}`));
    console.log(`  Port: ${config.port}`);
    console.log(`  State: ${config.stateDir}`);
    console.log();

    // Set up file logging for observability
    setupServerLog(config.stateDir);

    // ── Shadow installation detection (v0.9.72) ────────────────────────
    // The Luna Incident: a local `npm install instar` created node_modules/
    // in the project directory, shadowing the global binary. AutoUpdater
    // updated the global, but the server kept loading the stale local copy.
    // Detect this at startup and warn loudly.
    const localInstarBin = path.join(process.cwd(), 'node_modules', '.bin', 'instar');
    const localInstarPkg = path.join(process.cwd(), 'node_modules', 'instar', 'package.json');
    if (fs.existsSync(localInstarBin) || fs.existsSync(localInstarPkg)) {
      const localVersion = (() => {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', 'instar', 'package.json'), 'utf-8'));
          return pkg.version || 'unknown';
        } catch { return 'unknown'; }
      })();
      console.warn(pc.red(pc.bold('  ⚠ SHADOW INSTALLATION DETECTED')));
      console.warn(pc.red(`  Local node_modules/instar (v${localVersion}) shadows the global binary.`));
      console.warn(pc.red('  Auto-updates will NOT take effect. Remove with:'));
      console.warn(pc.red(`  rm -rf ${path.join(process.cwd(), 'node_modules')} ${path.join(process.cwd(), 'package.json')} ${path.join(process.cwd(), 'package-lock.json')}`));
      console.warn();
    }

    // ── Global install cleanup ─────────────────────────────────────────
    // Shadow installs are the sole source of truth. Global installs cause
    // version confusion — agents report stale versions when CLI commands
    // resolve to a global binary instead of the shadow install.
    // Clean up any lingering globals at startup (idempotent, safe to run every time).
    try {
      const cleanup = cleanupGlobalInstalls();
      if (cleanup.removed.length > 0) {
        console.log(pc.green(`  ✓ Cleaned up ${cleanup.removed.length} stale global instar install(s):`));
        for (const r of cleanup.removed) {
          console.log(pc.green(`    - ${r}`));
        }
      }
      if (cleanup.failed.length > 0) {
        for (const f of cleanup.failed) {
          console.warn(pc.yellow(`  ⚠ Failed to remove global install at ${f.path}: ${f.error}`));
        }
      }
    } catch (err) {
      // Non-fatal — log and continue
      console.warn(`[server] Global install cleanup error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── ProcessIntegrity: freeze the running version at startup ────────
    // This MUST happen before any version reporting. The version is captured
    // from the code loaded into memory, NOT from disk (which changes after
    // npm install -g). See ProcessIntegrity.ts for the full rationale.
    const packageJsonPath = resolvePackageJsonPath();
    const startupVersion = config.version ?? '0.0.0';
    const processIntegrity = ProcessIntegrity.initialize(startupVersion, packageJsonPath);

    // StaleProcessGuard: register version as a monitored snapshot
    const staleGuard = new StaleProcessGuard();
    staleGuard.registerSnapshot(
      'instar-version',
      startupVersion,
      () => {
        try {
          if (packageJsonPath && fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
            return pkg.version || '0.0.0';
          }
        } catch { /* fallback */ }
        return startupVersion;
      },
      { description: 'Instar package version', severity: 'critical' },
    );

    // Initialize DegradationReporter early — before any feature that might fall back.
    // Downstream systems (feedback, telegram) are connected once the server is fully up.
    const degradationReporter = DegradationReporter.getInstance();
    degradationReporter.configure({
      stateDir: config.stateDir,
      agentName: config.projectName,
      instarVersion: startupVersion,
    });

    // HumanAsDetectorLog — treats a human-caught coherence break (a correction,
    // a "you already said", a "why didn't you catch this") as evidence that some
    // automated guardian failed. Configured early; the inbound-message observe()
    // is chained onto telegram.onMessageLogged once telegram is up (see below).
    const humanAsDetectorLog = HumanAsDetectorLog.getInstance();
    humanAsDetectorLog.configure({
      stateDir: config.stateDir,
      agentName: config.projectName,
    });

    // Clean up stale Telegram temp files on startup
    cleanupTelegramTempFiles();

    // Pre-flight: ensure better-sqlite3 bindings are compiled for the current Node.js version.
    // Must run before TopicMemory or SemanticMemory initialize. See ensureSqliteBindings() for rationale.
    // If rebuild occurred, we must restart — ESM caches the import failure and won't retry.
    const sqliteRebuildRequired = await ensureSqliteBindings();
    if (sqliteRebuildRequired) {
      console.log(pc.yellow('  Restarting server to apply SQLite rebuild. Server will be back online momentarily.'));
      process.exit(0);
    }

    // Run post-update migration on startup — ensures agent knowledge stays current
    // regardless of how the update was applied (shadow install, npx, etc.).
    // This is the SAFETY NET: catches all upgrades regardless of how they were applied.
    try {
      const installedVersion = getInstalledVersion();
      const versionFile = path.join(config.stateDir, 'state', 'last-migrated-version.json');
      let lastMigrated = '';
      try { lastMigrated = JSON.parse(fs.readFileSync(versionFile, 'utf-8')).version || ''; } catch { /* first run */ }
      if (installedVersion && installedVersion !== lastMigrated) {
        // Backup config.json before migration — protects against accidental wipes
        const configPath = path.join(config.stateDir, 'config.json');
        if (fs.existsSync(configPath)) {
          const backupPath = path.join(config.stateDir, 'config.json.backup');
          fs.copyFileSync(configPath, backupPath);
        }
        const hasTelegram = config.messaging?.some((m: any) => m.type === 'telegram') ?? false;
        const migrator = new PostUpdateMigrator({
          projectDir: config.projectDir,
          stateDir: config.stateDir,
          port: config.port,
          hasTelegram,
          projectName: config.projectName,
        });
        const migration = await migrator.migrateAsync();
        if (migration.upgraded.length > 0) {
          console.log(pc.green(`  Knowledge upgrade (v${lastMigrated || '?'} → v${installedVersion}): ${migration.upgraded.join(', ')}`));
        }
        // Record the migrated version
        const dir = path.dirname(versionFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(versionFile, JSON.stringify({ version: installedVersion, migratedAt: new Date().toISOString() }));
      }

      // ALWAYS process upgrade guides on startup — regardless of version match.
      // This is the critical safety net that catches manual `npm install -g` updates
      // where the auto-updater pipeline was bypassed. UpgradeGuideProcessor handles
      // deduplication internally via processed-upgrades.json, so re-running is safe.
      // Removing the old `hasPendingGuide()` guard that caused guides to be skipped.
      try {
        const guideProcessor = new UpgradeGuideProcessor({
          stateDir: config.stateDir,
          currentVersion: installedVersion || config.version || '0.0.0',
          previousVersion: lastMigrated || undefined,
        });
        const guideResult = guideProcessor.process();
        if (guideResult.pendingGuides.length > 0) {
          console.log(pc.green(`  Upgrade guides pending: ${guideResult.pendingGuides.join(', ')}`));
        }
      } catch (guideErr) {
        console.log(pc.yellow(`  Upgrade guide check: ${guideErr instanceof Error ? guideErr.message : String(guideErr)}`));
      }
    } catch (err) {
      console.log(pc.yellow(`  Post-update migration check: ${err instanceof Error ? err.message : String(err)}`));
    }

    // Register this agent in the global registry (multi-instance support)
    try {
      registerAgent(config.projectDir, config.projectName, config.port);
      console.log(pc.green(`  Registered agent "${config.projectName}" on port ${config.port}`));
    } catch (err) {
      console.log(pc.red(`  Port conflict: ${err instanceof Error ? err.message : err}`));
      process.exit(1);
    }

    // Agent worktree convention (Layer 4) — detector invocation lives
    // AFTER the TelegramAdapter setup blocks below, so it can pass
    // `telegram.createAttentionItem` as the emit-attention callback when
    // Telegram is configured. The original placement here was deferred
    // for that reason (see upgrades/side-effects/agent-worktree-
    // convention-layer-3-4.md). When no Telegram adapter is present the
    // detector still runs and falls back to the JSONL append.
    let stopHeartbeat: (() => void) | undefined;
    try {
      // The reRegister callback closes the registry lost-update race: if an
      // old server generation's shutdown deleted our fresh registration
      // (back-to-back update restarts), the next heartbeat notices the
      // missing entry and resurrects it instead of silently no-oping forever.
      stopHeartbeat = startHeartbeat(config.projectDir, undefined, () => {
        registerAgent(config.projectDir, config.projectName, config.port);
      });
    } catch (err) {
      // Registry heartbeat is non-critical — server should run without it.
      // ELOCKED errors from concurrent agent startups are transient.
      console.log(pc.yellow(`  Registry heartbeat failed to start (non-critical): ${err instanceof Error ? err.message : err}`));
    }

    // Phase 5 — register the Anthropic adapters and install the cost-aware
    // routing policy on the global providers registry. Registration is the
    // formerly-deferred "separate cycle" (src/providers/bootRegistration.ts):
    // gated (codex-only agents register nothing), idempotent, and LAZY (no
    // tmux/claude spawns at boot — the pool only spawns on first use). With
    // adapters actually registered, `registry.resolve()` decisions are real,
    // and the policy's `readSdkCredit` is plumbed from the headless adapter's
    // UsageMeterProvider instead of the old `() => null` stub.
    //
    // Idempotent: only installs when no policy has been set yet on the
    // module-singleton registry. Re-entering `startServer` in the same
    // process (test harnesses, in-proc respawn) won't clobber a policy
    // a caller (test or production wiring) installed first.
    let anthropicRegistration: import('../providers/bootRegistration.js').RegisterAnthropicAdaptersResult | null = null;
    try {
      const { registry } = await import('../providers/registry.js');
      const { registerAnthropicAdapters } = await import('../providers/bootRegistration.js');

      // Scratch working dir for intelligence-pool sessions (context
      // decontamination — no project CLAUDE.md/MCP in judgment calls).
      const subscriptionPathConfig = config.intelligence?.subscriptionPath;
      const poolWorkdir = subscriptionPathConfig?.workingDirectory
        ?? path.join(config.stateDir, 'intelligence-pool');
      try { fs.mkdirSync(poolWorkdir, { recursive: true }); } catch { /* spawn-time failure surfaces loudly */ }

      anthropicRegistration = await registerAnthropicAdapters({
        ...(config.enabledFrameworks ? { enabledFrameworks: config.enabledFrameworks } : {}),
        ...(config.sessions?.claudePath ? { claudePath: config.sessions.claudePath } : {}),
        ...(config.sessions?.tmuxPath ? { tmuxPath: config.sessions.tmuxPath } : {}),
        pool: {
          poolSize: subscriptionPathConfig?.poolSize ?? 2,
          // One model per pool; 'haiku' default keeps sentinel chatter off
          // the subscription's large-model quota (types.ts rationale).
          model: subscriptionPathConfig?.model ?? 'haiku',
          workingDirectory: poolWorkdir,
          // Agent-scoped prefix — pool.start()'s orphan recovery kills
          // stale `<prefix>-*` tmux sessions from a crashed previous
          // process, so the prefix MUST be unique per agent on a shared
          // machine (an unscoped prefix would reap another agent's pool).
          sessionPrefix: `instar-pool-${String(config.projectName ?? 'agent').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
        },
      });
      if (anthropicRegistration.skippedReason) {
        console.log(pc.dim(`  Providers registry: Anthropic adapters skipped (${anthropicRegistration.skippedReason})`));
      } else {
        const ids = [...anthropicRegistration.registered, ...anthropicRegistration.alreadyRegistered];
        console.log(pc.green(`  Providers registry: ${ids.join(', ')} registered`));
      }

      // Read-only probe — `getRoutingPolicy` isn't on the public surface,
      // so we test by attempting a no-op resolve and seeing whether the
      // chain fires. Cheaper proxy: a private convention — set a marker
      // on the registry the first time we install. Use a Symbol so we
      // don't pollute the public interface.
      const ROUTING_POLICY_INSTALLED = Symbol.for('instar.serverBoot.routingPolicyInstalled');
      const tagged = registry as unknown as Record<symbol, boolean>;
      if (tagged[ROUTING_POLICY_INSTALLED]) {
        console.log(pc.dim('  Routing policy already installed in this process — skipping re-install'));
      } else {
        const { ChainPolicy, FirstAvailablePolicy } = await import('../providers/routing.js');
        const { CostAwareRoutingPolicy } = await import('../providers/costAwareRouting.js');
        registry.setRoutingPolicy(new ChainPolicy([
          new CostAwareRoutingPolicy({
            // Real credit reader from the headless adapter's usage meter
            // (TTL-cached; null = unknown → subscription floor). On a
            // skipped registration this stays a null-reader by contract.
            readSdkCredit: anthropicRegistration.readSdkCredit,
            sdkCreditAdapterId: 'anthropic-headless' as never,
            subscriptionAdapterId: 'anthropic-interactive-pool' as never,
          }),
          new FirstAvailablePolicy(),
        ]));
        tagged[ROUTING_POLICY_INSTALLED] = true;
        console.log(pc.green('  Routing policy installed: ChainPolicy[CostAware, FirstAvailable]'));
      }
    } catch (err) {
      // Registration/policy install is non-critical — sessions still resolve
      // adapters via the registry's first-match-by-registration fallback.
      // But it IS a degradation: the June-15 subscription-path routing is
      // not live in this process, so report it rather than only logging.
      console.log(pc.yellow(`  Providers registration/policy install failed (non-critical): ${err instanceof Error ? err.message : err}`));
      DegradationReporter.getInstance().report({
        feature: 'serverBoot.anthropicProviderRegistration',
        primary: 'both Anthropic adapters registered + cost-aware routing policy installed at boot',
        fallback: 'empty providers registry — internal LLM calls stay on the legacy claude -p path with no SDK-pot-vs-subscription routing',
        reason: `registration/policy install threw: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'subscription-path routing (June-15 readiness) is unavailable for this server process until restart',
      });
    }

    // Warn if no auth token configured — server allows unauthenticated access
    if (!config.authToken) {
      console.log(pc.yellow(pc.bold('  ⚠ WARNING: No auth token configured — all API endpoints are unauthenticated!')));
      console.log(pc.yellow('  Set authToken in .instar/config.json or re-run instar init'));
      console.log();
    }

    const state = new StateManager(config.stateDir);
    _notifyState = state; // Wire state into notify() gateway

    // Multi-machine coordinator — determines role (awake/standby) before other components start.
    // If standby, StateManager becomes read-only and processing is gated.
    const coordinator = new MultiMachineCoordinator(state, {
      stateDir: config.stateDir,
      multiMachine: config.multiMachine,
    });
    const machineRole = coordinator.start();
    if (coordinator.enabled) {
      console.log(pc.green(`  Multi-machine: ${pc.bold(machineRole)} (${coordinator.identity!.machineId.slice(0, 12)}...)`));
      if (machineRole === 'standby') {
        console.log(pc.yellow('  Standby mode — processing gated, writes disabled'));
      }
    }

    // Cross-Machine Seamlessness (spec §9) — resolve + validate the tunable
    // knobs at startup. A violating config (e.g. a widened ingressHeartbeatMs
    // that breaks the RPO bound) is REJECTED here with a clear message rather
    // than degrading silently. Default/absent config resolves to valid values.
    const seamlessness = assertSeamlessnessInvariants(config.multiMachine);

    // Read local signing key for machine route authentication
    let localSigningKeyPem = '';
    if (coordinator.enabled && coordinator.identity) {
      try {
        // The canonical signing-key filename is `signing-key.pem` (MachineIdentity.SIGNING_KEY_FILE,
        // what every normally-created install has + what idMgr.loadSigningKey reads). This loader
        // historically hard-coded `signing-private.pem`, which only EXISTS on installs that were
        // propagated with that (non-canonical) name — so a normally-created machine got an EMPTY
        // localSigningKeyPem, its MeshRpcClient then signed every cross-machine command with no key,
        // the send threw, and it could not PULL/transfer to any peer (while still RECEIVING fine,
        // since receive verifies the OTHER machine's key). Try the canonical name first, then fall
        // back to the legacy/propagated name so both layouts work.
        for (const name of ['signing-key.pem', 'signing-private.pem']) {
          const keyPath = path.join(config.stateDir, 'machine', name);
          if (fs.existsSync(keyPath)) {
            localSigningKeyPem = fs.readFileSync(keyPath, 'utf-8');
            break;
          }
        }
      } catch { /* @silent-fallback-ok — signing key optional */ }
    }

    // Git sync for multi-machine (awake machines only — standby pulls via cron or manual)
    // Only attempt git sync if the project directory is actually a git repo.
    // Standalone agents don't have git repos unless the user opted into cloud backup.
    let gitSync: GitSyncManager | undefined;
    let registrySyncDebouncer: RegistrySyncDebouncer | undefined;
    let leaseTransport: HttpLeaseTransport | undefined;
    let leaseCoordinatorRef: LeaseCoordinator | undefined;
    let liveTailBuffer: LiveTailBuffer | undefined;
    let liveTailSendTransport: HttpLiveTailTransport | undefined;
    let handoffWireTransport: HandoffWireTransport | undefined;
    let replyMarkerTransport: ReplyMarkerTransport | undefined;
    let liveTailReceiver:
      | ((
          flush: { topic: string; seq: number; enc: unknown; redactionVersion?: number },
          fromMachineId: string,
        ) => { applied: boolean; reason: string } | void)
      | undefined;
    const isGitRepo = fs.existsSync(path.join(config.projectDir, '.git'));
    const gitBackupEnabled = config.gitBackup?.enabled !== false;
    // Construct gitSync for BOTH roles when this is a git-backed mesh machine:
    // a standby needs it to pull, and a standby that later self-elects to awake
    // (the Phase-0 scenario) must ALREADY have it so its role-change push fires.
    // Only an awake machine pulls+pushes at boot; the durable registry push is
    // driven by the RegistrySyncDebouncer below, gated on authority.
    if (coordinator.enabled && coordinator.identity) {
      const idMgr = coordinator.managers.identityManager;
      const selfMachineId = coordinator.identity.machineId;
      // ── Git-sync substrate (OPTIONAL — not required for coordination) ──
      // git is the durable shared-CAS substrate for the lease + the registry
      // push channel. It is NOT required for cross-machine coordination: a
      // credential-less standby, or an agent whose home IS the instar source
      // tree (where SourceTreeGuard refuses GitSyncManager), has no git medium.
      // Construct it best-effort; its failure must NOT skip the HTTP lease/
      // handoff/live-tail transports below. (2026-05-31 bug, found live: the
      // lease block was nested in the git-gated try, so a gitSync throw left the
      // standby with leaseHolder=null → MeshRpc 'not-router' → transfer dead.)
      let gitSyncRef: GitSyncManager | undefined;
      if (isGitRepo && gitBackupEnabled) {
        try {
          gitSync = new GitSyncManager({
            projectDir: config.projectDir,
            stateDir: config.stateDir,
            identityManager: coordinator.managers.identityManager,
            securityLog: coordinator.managers.securityLog,
            machineId: selfMachineId,
          });
          // Configure commit signing if not already done
          if (!gitSync.isSigningConfigured() && localSigningKeyPem) {
            gitSync.configureCommitSigning();
            console.log(pc.green('  Git commit signing configured'));
          }
          // Pull (and auto-push) latest on startup — awake machine only.
          if (coordinator.isAwake) {
            const syncResult = await gitSync.sync();
            if (syncResult.pulled) {
              console.log(pc.green(`  Git sync: pulled ${syncResult.commitsPulled} commit(s)`));
            }
          }
          gitSyncRef = gitSync;
          // ── G2 wiring (spec §8 G2) — roleChange/leaseEpoch → debounced push ──
          // Without a subscriber the durable registry push never fires; a
          // wiring-integrity test asserts this subscription exists.
          const gitSyncForDebounce = gitSyncRef;
          registrySyncDebouncer = new RegistrySyncDebouncer({
            commitAndPush: (msg, paths) => gitSyncForDebounce.commitAndPush(msg, paths),
            registryAbsPath: coordinator.managers.identityManager.registryPath,
            isAuthoritative: () => coordinator.isAwake,
            debounceMs: seamlessness.registrySyncDebounceMs,
            logger: (m) => console.log(pc.dim(m)),
          });
          wireRegistrySync(coordinator, registrySyncDebouncer);
          console.log(pc.dim('  Registry sync wired (roleChange/leaseEpoch → durable push)'));
        } catch (err) {
          // @silent-fallback-ok — git medium unavailable (SourceTreeGuard, no
          // remote, etc). The lease falls back to LocalLeaseStore + the HTTP
          // transport below, so cross-machine coordination still works.
          console.log(pc.yellow(`  Git sync setup: ${err instanceof Error ? err.message : String(err)}`));
          gitSyncRef = undefined;
        }
      }

      try {
        // ── G1 fenced-lease integration (spec §6) ──────────────────
        // The lease is the authority for awake/standby + the MeshRpc router-only
        // RBAC (deliverMessage/place/transfer). GitLeaseStore is the durable
        // shared-CAS substrate WHEN git is available; otherwise LocalLeaseStore
        // persists this machine's own view and the HttpLeaseTransport carries
        // cross-machine propagation (broadcast/observe). A holder that cannot
        // confirm its renewal over its medium for > leaseTtlMs self-suspends,
        // preventing the partitioned-old-awake split-brain.
        const leaseCrypto: LeaseCrypto = {
          selfMachineId,
          sign: (canonical) => signEd25519(canonical, idMgr.loadSigningKey()),
          verify: (canonical, signature, holderMachineId) => {
            const pub = idMgr.getSigningPublicKeyPem(holderMachineId);
            if (!pub) return false;
            try { return verifyEd25519(canonical, signature, pub); } catch { return false; }
          },
        };
        const fencedLease = new FencedLease(leaseCrypto, {
          leaseTtlMs: seamlessness.leaseTtlMs,
          failoverThresholdMs: seamlessness.failoverThresholdMs,
        });
        let leaseStore: LeaseStore;
        if (gitSyncRef) {
          const gs = gitSyncRef;
          leaseStore = new GitLeaseStore({
            machineId: selfMachineId,
            loadRegistry: () => idMgr.loadRegistry(),
            saveRegistry: (r) => idMgr.saveRegistry(r),
            registryAbsPath: idMgr.registryPath,
            pullRebase: () => gs.pullRebase(),
            commitAndPush: (msg, paths) => gs.commitAndPush(msg, paths),
            logger: (m) => console.log(pc.dim(m)),
          });
        } else {
          leaseStore = new LocalLeaseStore({
            filePath: path.join(config.stateDir, 'lease-local.json'),
            logger: (m) => console.log(pc.dim(m)),
          });
          console.log(pc.dim('  Lease store: LocalLeaseStore (no git medium — HTTP transport carries cross-machine lease)'));
        }
        // Lease wire transport (spec §6) — the low-latency authoritative copy
        // travels over the existing authenticated machine channel. For a
        // single-machine mesh (no peers) broadcast is a no-op and isReachable()
        // stays true, so the lease behaves exactly as git-only. Multi-machine
        // meshes get RTT-bounded acquisition + the renewal-requires-medium rule.
        let leaseSeq = Date.now();
        leaseTransport = new HttpLeaseTransport({
          selfMachineId,
          signingKeyPem: idMgr.loadSigningKey(),
          peers: () => {
            const reg = idMgr.loadRegistry();
            return Object.entries(reg.machines ?? {})
              .filter(([id, e]) => id !== selfMachineId && !!e.lastKnownUrl && !e.revokedAt)
              .map(([id, e]) => ({ machineId: id, url: e.lastKnownUrl as string }));
          },
          nextSequence: () => ++leaseSeq,
          reachabilityWindowMs: seamlessness.leaseTtlMs,
          // P19 hung-socket brake, derived from config: must stay BELOW the
          // self-suspend horizon (leaseTtlMs) so one slow renewal can't burn
          // the whole TTL, but ABOVE the fleet's 5-40s receiver-stall envelope
          // so a slow-but-alive peer isn't converted into "no medium".
          requestTimeoutMs: Math.min(seamlessness.leaseTtlMs / 2, 30_000),
          logger: (m) => console.log(pc.dim(m)),
        });
        const leaseCoordinator = new LeaseCoordinator({
          lease: fencedLease,
          store: leaseStore,
          tunnel: leaseTransport,
          presumedDeadHolders: () => {
            const reg = idMgr.loadRegistry();
            const nowMs = Date.now();
            const dead = new Set<string>();
            for (const [id, e] of Object.entries(reg.machines ?? {})) {
              if (id === selfMachineId) continue;
              const last = Date.parse(e.lastSeen);
              if (!Number.isNaN(last) && nowMs - last > seamlessness.failoverThresholdMs) dead.add(id);
            }
            return dead;
          },
          onEpochAdvance: (epoch) => coordinator.emit('leaseEpochChange', epoch),
          onSelfSuspend: (reason) => console.log(pc.yellow(`  [lease] self-suspend: ${reason}`)),
          onEscalate: (info) => console.log(pc.yellow(`  [lease] split-brain escalation: ${info.reason} (holder ${info.holder})`)),
          logger: (m) => console.log(pc.dim(m)),
        });
        coordinator.attachLeaseCoordinator(leaseCoordinator);
        leaseCoordinatorRef = leaseCoordinator;
        await coordinator.initializeLease();
        console.log(pc.dim(`  Fenced lease active (epoch ${leaseCoordinator.currentEpoch()}, holder=${leaseCoordinator.currentHolder() ?? 'none'})`));

        // ── Handoff ack/yield wire (spec §8 G3d/G3e) ───────────────
        // The point-to-point channel the two machines use to negotiate a
        // verified, lease-safe planned handoff. The /api/handoff/ack route
        // delivers the incoming machine's caught-up echo via recordAck (resolves
        // the outgoing's awaitAck); /api/handoff/yield delivers the explicit
        // yield via recordYield (fires the incoming's registered handler → lease
        // CAS). A handoff is strictly 1:1, so peer() resolves the single
        // reachable counterpart. Solo agent (no peer) → sends are reachable
        // no-ops, so a single-machine mesh behaves exactly as before.
        let handoffSeq = Date.now();
        handoffWireTransport = new HandoffWireTransport({
          selfMachineId,
          signingKeyPem: idMgr.loadSigningKey(),
          peer: () => {
            const reg = idMgr.loadRegistry();
            for (const [id, e] of Object.entries(reg.machines ?? {})) {
              if (id === selfMachineId || !e.lastKnownUrl || e.revokedAt) continue;
              return { machineId: id, url: e.lastKnownUrl as string };
            }
            return null;
          },
          nextSequence: () => ++handoffSeq,
          logger: (m) => console.log(pc.dim(m)),
        });

        // Cross-machine reply-marker propagation (spec §8 G3a) — only when the
        // exactly-once ledger is active. Broadcasts "this event was answered" to
        // standby peers so a post-handoff redelivery is deduped on the new holder.
        if (seamlessness.exactlyOnceIngress) {
          let markerSeq = Date.now();
          replyMarkerTransport = new ReplyMarkerTransport({
            selfMachineId,
            signingKeyPem: idMgr.loadSigningKey(),
            peers: () => {
              const reg = idMgr.loadRegistry();
              const out: { machineId: string; url: string }[] = [];
              for (const [id, e] of Object.entries(reg.machines ?? {})) {
                if (id === selfMachineId || !e.lastKnownUrl || e.revokedAt) continue;
                out.push({ machineId: id, url: e.lastKnownUrl as string });
              }
              return out;
            },
            nextSequence: () => ++markerSeq,
            logger: (m) => console.log(pc.dim(m)),
          });
        }
        console.log(pc.dim('  Handoff ack/yield wire active (ack→recordAck, yield→recordYield)'));

        // ── Live-tail RECEIVER (spec §8 G3b/c) ─────────────────────
        // The standby receives the holder's redacted+encrypted live-tail flushes
        // at /api/live-tail, decrypts them with THIS machine's X25519 private key,
        // and sequence-dedups them into a persisted buffer so a failover resumes
        // from a durable (not merely in-memory) copy. The HOLDER-side sender
        // (HttpLiveTailTransport.broadcast) is driven by the flush producer wired
        // in the inbound-dispatch + handoff integration (next increment piece).
        // Solo agent (no peers ever POST here) → the receiver simply never fires.
        if (seamlessness.liveTailTransport === 'tunnel') {
          liveTailBuffer = new LiveTailBuffer({
            outOfOrderTimeoutMs: seamlessness.liveTailOutOfOrderTimeoutMs,
            maxBytesPerTopic: seamlessness.liveTailMaxBytesPerTopic,
            logger: (m) => console.log(pc.dim(m)),
          });
          const liveTailBufferRef = liveTailBuffer;
          // Decrypt with THIS machine's X25519 private key, then apply
          // (sequence-deduped). Throws on a bad payload → the route returns 400.
          const ownEncryptionKey = createPrivateKey(idMgr.loadEncryptionKey());
          liveTailReceiver = (flush) => {
            const decrypted = decryptFromSync(flush.enc as any, ownEncryptionKey) as { content?: unknown };
            const content = typeof decrypted.content === 'string' ? decrypted.content : '';
            return liveTailBufferRef.applyFlush({ topic: flush.topic, seq: flush.seq, content });
          };
          console.log(pc.dim('  Live-tail receiver active (standby decrypts + sequence-dedups holder stream)'));

          // Holder-side SENDER transport (the LiveTailSource that drives it is
          // constructed after the Telegram adapter is up — it needs the content
          // provider). Built here because it needs idMgr (signing key + peer
          // registry). No peers → broadcast is a reachable no-op.
          let liveTailWireSeq = Date.now();
          liveTailSendTransport = new HttpLiveTailTransport({
            selfMachineId,
            signingKeyPem: idMgr.loadSigningKey(),
            peers: () => {
              const reg = idMgr.loadRegistry();
              const out: { machineId: string; url: string; encryptionPublicKey: string }[] = [];
              for (const [id, e] of Object.entries(reg.machines ?? {})) {
                if (id === selfMachineId || !e.lastKnownUrl || e.revokedAt) continue;
                const pem = idMgr.getEncryptionPublicKeyPem(id);
                if (!pem) continue; // can't encrypt for a peer whose X25519 key we lack
                try {
                  const encB64 = createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
                  out.push({ machineId: id, url: e.lastKnownUrl, encryptionPublicKey: encB64 });
                } catch { /* skip a peer with an unusable key */ }
              }
              return out;
            },
            nextSequence: () => ++liveTailWireSeq,
            encryptFor: (content, recipientEncPubB64) => encryptForSync({ content }, recipientEncPubB64),
            reachabilityWindowMs: seamlessness.leaseTtlMs,
            logger: (m) => console.log(pc.dim(m)),
          });
        }
      } catch (err) {
        // @silent-fallback-ok — lease/transport setup failed; the agent still
        // serves single-machine (cross-machine coordination simply stays off).
        console.log(pc.yellow(`  Lease/transport setup: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    // Per-agent Codex threadline MCP override. Codex reads a SHARED
    // ~/.codex/config.toml whose [mcp_servers."threadline"] is last-writer-wins
    // across every codex agent on the machine — so a codex worker could load a
    // DIFFERENT agent's threadline identity and its threadline_send would be
    // misaddressed. Pin this agent's own entry per-spawn (the launch builders
    // emit `-c mcp_servers.threadline.*`). Only when threadline is configured;
    // ignored by non-codex launches. See CODEX-MULTIAGENT-THREADLINE-SPEC.
    const codexThreadlineMcp = config.threadline
      ? resolveThreadlineMcpEntry(config.sessions.projectDir, config.stateDir, config.projectName)
      : undefined;
    const sessionManagerConfig = {
      ...config.sessions,
      ...(codexThreadlineMcp ? { codexThreadlineMcp } : {}),
      respawnBuildContext: {
        ...(config.sessions.respawnBuildContext ?? {}),
        enabled: config.sessions.respawnBuildContext?.enabled ?? !!config.developmentAgent,
      },
    };
    const sessionManager = new SessionManager(sessionManagerConfig, state);

    // Input Guard is constructed later (after sharedIntelligence is available)
    // so the topic coherence reviewer can route through the IntelligenceProvider
    // abstraction instead of calling Anthropic directly.

    // TopicResumeMap: persist Claude session UUIDs across session restarts.
    // When a session is killed/restarted, we save its UUID so the next spawn
    // can use --resume to reattach to the existing conversation context.
    const { TopicResumeMap } = await import('../core/TopicResumeMap.js');
    _topicResumeMap = new TopicResumeMap(config.stateDir, config.sessions.projectDir, config.sessions.tmuxPath);
    _projectDir = config.sessions.projectDir;

    // TopicIntentStore (Layer 1 of the Topic Intent Layer): per-topic
    // confidence tracker. File-backed, framework-agnostic — works under
    // Claude Code AND Codex sessions. See docs/specs/topic-intent-layer.md.
    const { TopicIntentStore, configureDecayProfiles } = await import('../core/TopicIntent.js');
    const topicIntentStore = new TopicIntentStore(config.stateDir);
    // Apply any operator decay-horizon overrides (existence-checked; invalid
    // values ignored). No-op when unset → built-in defaults. Tracked refinement
    // cwa-decay-profile-config of the rung-1 task-context spec.
    configureDecayProfiles(config.topicIntent?.capture?.decayProfiles);

    // Usher (rung 4) — signal store for mid-task re-surface signals. Constructed
    // unless explicitly disabled; the read-only routes 503 when it's null.
    const { UsherSignalStore } = await import('../core/UsherSignalStore.js');
    const usherSignalStore = (config.usher?.enabled !== false)
      ? new UsherSignalStore(config.stateDir)
      : null;

    // Shared intelligence provider — lightweight LLM for internal classification tasks.
    // Subscription path only: routes through the Claude CLI (`claude -p`), which bills against
    // the Agent SDK credit pot and falls back to the Max subscription. Components that need
    // LLM intelligence (Sentinel, TelegramAdapter, etc.) share this single provider instance.
    //
    // Direct calls to the Anthropic Messages API are forbidden per Rule 2 of the path
    // constraints (specs/provider-portability/04-anthropic-path-constraints.md). The old
    // `intelligenceProvider: "anthropic-api"` config field is no longer honored; if a stale
    // agent config has it set (with or without the `intelligenceProviderConfirmed: true`
    // opt-in flag that older versions accepted), we warn loudly and proceed with the
    // subscription path.
    let sharedIntelligence: IntelligenceProvider | undefined;
    const staleApiProvider =
      (config as unknown as { intelligenceProvider?: string }).intelligenceProvider === 'anthropic-api';
    let intelligenceSource = 'none';
    let resolvedFramework: import('../core/intelligenceProviderFactory.js').IntelligenceFramework = 'claude-code';

    if (staleApiProvider) {
      console.log(pc.yellow(
        '  intelligenceProvider: "anthropic-api" is no longer supported — using Claude CLI subscription instead.\n'
        + '  Remove the field from config.json. See specs/provider-portability/04-anthropic-path-constraints.md.'
      ));
    }

    // Codex-only enforcement (Justin 2026-05-23 absolute requirement): if
    // this agent's enabledFrameworks excludes 'claude-code', forbid ALL
    // Claude provider construction process-wide. Any internal LLM path that
    // tries to fall back to Claude (relationships, summaries, gates) then
    // throws ClaudeForbiddenError instead of silently using Claude on a
    // machine where the claude binary happens to be installed. Set BEFORE
    // any provider is built so the guard is active for the whole boot.
    try {
      const { setClaudeForbidden, isCodexOnly } = await import('../core/claudeForbiddenGuard.js');
      const ef = (config as { enabledFrameworks?: string[] }).enabledFrameworks;
      if (isCodexOnly(ef)) {
        setClaudeForbidden(`enabledFrameworks=${JSON.stringify(ef)} (no claude-code)`);
        console.log(pc.cyan('  Codex-only mode: Claude provider construction is forbidden process-wide.'));
      }
    } catch (err) {
      console.warn(`[server] codex-only guard init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Account-global LLM rate-limit circuit breaker. Apply operator overrides
    // from config before any provider is built; the breaker defaults ON with a
    // 15-minute window, so absent config still protects the agent.
    configureLlmCircuitBreaker({
      enabled: config.intelligence?.circuitBreaker?.enabled,
      openMs: config.intelligence?.circuitBreaker?.openMs,
    });

    // Hoisted out of the provider-build try block: the per-component
    // IntelligenceRouter below (outside that try) reuses the same
    // subscription-path option for its claude-code builds.
    let subscriptionPathOption:
      | import('../core/intelligenceProviderFactory.js').BuildIntelligenceProviderOptions['subscriptionPath']
      | undefined;

    // Provider-portability v1.0.0: pick the IntelligenceProvider that
    // matches the configured framework. Defaults to claude-code for
    // backwards-compat; INSTAR_FRAMEWORK=codex-cli routes through Codex.
    try {
      const { buildIntelligenceProvider, frameworkFromEnv } = await import('../core/intelligenceProviderFactory.js');
      // _defaultFramework is what the Telegram spawn path uses for any topic
      // without an explicit per-topic override (resolveTopicFramework returns
      // it). It MUST come from the agent's resolved runtime framework
      // (config.sessions.framework — derived at load from
      // sessions.framework | enabledFrameworks[0] | INSTAR_FRAMEWORK), NOT from
      // INSTAR_FRAMEWORK alone. Before this fix it was `frameworkFromEnv() ??
      // 'claude-code'`, so a codex-cli-only agent that didn't set the
      // INSTAR_FRAMEWORK env var (the common case — the wizard sets
      // enabledFrameworks, not the env) silently defaulted to claude-code and
      // spawned a CLAUDE session on every Telegram message. The fresh-spawn
      // path (spawnInteractiveSession's internal resolution) already read
      // config.framework correctly; this aligns the Telegram path with it so
      // both doors agree. See specs/dev-infrastructure/framework-spawn-portability.md.
      const framework = config.sessions?.framework ?? frameworkFromEnv() ?? 'claude-code';
      resolvedFramework = framework;
      _defaultFramework = framework as 'claude-code' | 'codex-cli';
      _topicFrameworks = (config as { topicFrameworks?: Record<string, 'claude-code' | 'codex-cli'> }).topicFrameworks ?? {};
      // Initialize the runtime-mutable persistent store (overrides win over
      // config defaults; both layers feed resolveTopicFramework).
      try {
        const { TopicFrameworksStore } = await import('../core/TopicFrameworksStore.js');
        _topicFrameworksStore = new TopicFrameworksStore({
          stateFilePath: path.join(config.stateDir, 'state', 'topic-frameworks.json'),
          configDefaults: _topicFrameworks,
        });
      } catch (err) {
        console.warn(`[server] TopicFrameworksStore failed to initialize: ${err}`);
      }
      // Per-topic local-model selection — Codex --oss --local-provider
      // passthrough. Driven conversationally via /local-model in Telegram;
      // operator-edited defaults come from config.json's topicCodexLocalProvider
      // + topicCodexLocalModel maps (merged into a single TopicLocalModelEntry
      // per topic).
      try {
        const { TopicLocalModelStore } = await import('../core/TopicLocalModelStore.js');
        const localProviderDefaults =
          (config as { topicCodexLocalProvider?: Record<string, 'ollama' | 'lmstudio'> }).topicCodexLocalProvider
          ?? {};
        const localModelDefaults =
          (config as { topicCodexLocalModel?: Record<string, string> }).topicCodexLocalModel
          ?? {};
        const mergedDefaults: Record<string, { provider: 'ollama' | 'lmstudio'; model?: string }> = {};
        for (const [topic, provider] of Object.entries(localProviderDefaults)) {
          mergedDefaults[topic] = {
            provider,
            ...(localModelDefaults[topic] ? { model: localModelDefaults[topic] } : {}),
          };
        }
        _topicLocalModelStore = new TopicLocalModelStore({
          stateFilePath: path.join(config.stateDir, 'state', 'topic-local-models.json'),
          configDefaults: mergedDefaults,
        });
      } catch (err) {
        console.warn(`[server] TopicLocalModelStore failed to initialize: ${err}`);
      }
      // June-15 subscription-path routing (spec 04 Rule 1). Built ONCE here;
      // reused by the main provider below AND the per-component
      // IntelligenceRouter's claude-code builds, so a component routed to
      // claude-code while the default framework is codex still gets the
      // same SDK-pot-vs-subscription routing. Mode 'off'/unset ⇒ option
      // stays undefined ⇒ claude path byte-for-byte unchanged.
      const spMode = config.intelligence?.subscriptionPath?.mode ?? 'off';
      if ((spMode === 'auto' || spMode === 'force') && anthropicRegistration?.pool) {
        // (string | undefined, not `= null` — a `= null;` initializer inside
        // the preceding catch's 20-line scan window false-flags the unrelated
        // TopicLocalModelStore catch in no-silent-fallbacks.test.ts.)
        let lastRoutedPath: string | undefined;
        subscriptionPathOption = {
          mode: spMode,
          poolAdapter: anthropicRegistration.pool,
          readSdkCredit: anthropicRegistration.readSdkCredit,
          // Transition-only logging (reaper-audit pattern): a line when the
          // serving path CHANGES, not per call — ~1k internal calls/day must
          // not become 1k log lines.
          onRoute: (info) => {
            if (info.path !== lastRoutedPath) {
              lastRoutedPath = info.path;
              console.log(pc.gray(`  [subscription-path] serving internal intelligence via ${info.path} (${info.reason})`));
            }
          },
          onDegrade: (info) => {
            try {
              DegradationReporter.getInstance().report({
                feature: 'AnthropicSubscriptionRouter',
                primary: `internal intelligence on ${info.from}`,
                fallback: `fell back to ${info.to}`,
                reason: info.reason,
                impact: `Internal LLM call${info.component ? ` (${info.component})` : ''} served by ${info.to} after ${info.from} failed.`,
              });
            } catch { /* never break the LLM path on a degradation report */ }
          },
        };
        console.log(pc.green(`  Subscription-path routing: mode '${spMode}' (pool model: ${config.intelligence?.subscriptionPath?.model ?? 'haiku'})`));
      } else if (spMode !== 'off') {
        // Configured but unusable (codex-only gate, registration failure) —
        // say so loudly rather than silently running the SDK path.
        console.log(pc.yellow(`  Subscription-path routing: mode '${spMode}' configured but the interactive-pool adapter is unavailable — internal calls stay on the default claude -p path`));
      }
      const built = buildIntelligenceProvider({
        framework,
        binaryPath: framework === 'claude-code' ? config.sessions.claudePath : undefined,
        ...(subscriptionPathOption ? { subscriptionPath: subscriptionPathOption } : {}),
        ...(framework === 'gemini-cli' && config.monitoring?.quotaTracking
          ? {
              quotaStateFile: (config.monitoring as { quotaStateFile?: string }).quotaStateFile
                || path.join(config.stateDir, 'quota-state.json'),
            }
          : {}),
      });
      if (built) {
        sharedIntelligence = built;
        intelligenceSource = framework === 'codex-cli'
          ? 'Codex CLI'
          : framework === 'gemini-cli'
            ? 'Gemini CLI'
            : 'Claude CLI subscription';
      } else {
        // Fall back to the legacy Claude path for backwards-compat. Wrap with
        // the circuit breaker (the factory path above is already wrapped).
        sharedIntelligence =
          wrapIntelligenceWithCircuitBreaker(new ClaudeCliIntelligenceProvider(config.sessions.claudePath)) ?? undefined;
        intelligenceSource = 'Claude CLI subscription (fallback)';
      }
    } catch { /* CLI not available */ }

    // Per-component framework routing (docs/specs/per-component-framework-routing.md).
    // Wrap the shared provider in an IntelligenceRouter so internal components
    // (sentinels, gates, …) can be routed to different frameworks via
    // sessions.componentFrameworks. Unconfigured ⇒ the router delegates straight to
    // the shared provider, so behavior is byte-identical to before. Own try/catch so
    // a router-build failure can never 503 the boot (it just leaves the raw provider).
    if (sharedIntelligence) {
      try {
        const { IntelligenceRouter } = await import('../core/IntelligenceRouter.js');
        const { buildIntelligenceProvider: buildIP } = await import('../core/intelligenceProviderFactory.js');
        const { LlmCircuitBreaker } = await import('../core/LlmCircuitBreaker.js');
        const defaultFw = resolvedFramework;
        const rawDefault = sharedIntelligence;
        sharedIntelligence = new IntelligenceRouter({
          defaultProvider: rawDefault,
          defaultFramework: defaultFw,
          // Live read: each call sees the current config object's componentFrameworks
          // (a config edit that mutates the in-memory object is hot; a file reload is
          // out of B1 scope — same semantics as the rest of instar's config).
          resolveConfig: () => config.sessions?.componentFrameworks,
          // Each non-default framework gets its OWN breaker → a Claude trip can't
          // pause Codex (the whole point). Default framework keeps the shared one.
          // claude-code builds inherit the subscription-path routing so a
          // component routed to Claude under a codex default still honors
          // the June-15 SDK-pot-vs-subscription decision.
          buildProvider: (fw) => buildIP({
            framework: fw,
            breaker: new LlmCircuitBreaker(),
            ...(fw === 'claude-code' && subscriptionPathOption
              ? { subscriptionPath: subscriptionPathOption }
              : {}),
          }),
          onDegrade: (info) => {
            try {
              DegradationReporter.getInstance().report({
                feature: 'IntelligenceRouter',
                primary: `component '${info.component}' (${info.category}) on framework ${info.from}`,
                fallback: `routed to ${info.to}`,
                reason: info.reason,
                impact: `LLM calls for '${info.component}' run on ${info.to} instead of the configured ${info.from} until that framework is available.`,
              });
            } catch { /* never break the LLM path on a degradation report */ }
          },
        });
      } catch (err) {
        console.warn(`[server] IntelligenceRouter failed to initialize, using unrouted provider: ${err}`);
      }
    }

    _sharedIntelligence = sharedIntelligence ?? null;
    if (sharedIntelligence) {
      console.log(pc.gray(`  Intelligence: ${intelligenceSource}`));
    } else {
      console.log(pc.yellow('  Intelligence: none (no Claude CLI available) — LLM-gated features degraded'));
      // Visible degradation — every downstream LLM-gated feature depends on this.
      // The DegradationReporter routes to console, disk, Telegram alert, and feedback.
      // Keep the externally-rendered impact string generic; the detailed
      // capability-down enumeration (tone gate, input guard, coherence gate, stall
      // triage, job reflection) stays in the yellow console line above and the
      // local degradations.json log. We don't broadcast a "which defenses are down"
      // checklist to Telegram/feedback channels.
      const { DegradationReporter } = await import('../monitoring/DegradationReporter.js');
      DegradationReporter.getInstance().report({
        feature: 'SharedIntelligenceProvider',
        primary: 'Shared LLM provider (Claude CLI subscription path)',
        fallback: 'Heuristic-only operation for LLM-gated features',
        reason: 'Claude CLI not available on this machine (see local startup logs for detail).',
        impact: 'LLM-gated features degraded; defense-in-depth reduced. See local logs for the affected feature list.',
      });
    }

    // Wire intelligence into git sync for LLM conflict resolution (Tier 1 → 2)
    if (gitSync && sharedIntelligence) {
      gitSync.setIntelligence(sharedIntelligence);
    }

    // Input Guard — cross-topic injection defense (Layer 1 + 1.5 + 2).
    // Constructed AFTER sharedIntelligence so the topic-coherence reviewer routes
    // through the IntelligenceProvider (subscription-first). InputGuard no longer
    // carries a direct Anthropic API path — all LLM usage flows through the shared
    // provider abstraction, enforcing the subscription-first principle at the
    // single provider-selection layer rather than in each consumer.
    if (config.inputGuard?.enabled !== false) {
      const guardConfig = config.inputGuard ?? { enabled: true };
      const { InputGuard } = await import('../core/InputGuard.js');
      const inputGuard = new InputGuard({
        config: {
          enabled: true,
          provenanceCheck: guardConfig.provenanceCheck ?? true,
          injectionPatterns: guardConfig.injectionPatterns ?? true,
          topicCoherenceReview: guardConfig.topicCoherenceReview ?? true,
          action: guardConfig.action ?? 'warn',
          reviewTimeout: guardConfig.reviewTimeout ?? 3000,
        },
        stateDir: config.stateDir,
        intelligence: sharedIntelligence,
      });
      const registryPath = path.join(config.stateDir, 'topic-session-registry.json');
      sessionManager.setInputGuard(inputGuard, registryPath);
      const reviewBackend = sharedIntelligence
        ? 'via shared IntelligenceProvider'
        : 'provenance + patterns only (no LLM review)';
      console.log(pc.green(`  Input Guard: enabled (action: ${guardConfig.action ?? 'warn'}, ${reviewBackend})`));
    }

    let relationships: RelationshipManager | undefined;
    if (config.relationships) {
      // Wire LLM intelligence for identity resolution. Subscription path only —
      // direct Anthropic API is forbidden per Rule 2 of the path constraints.
      // Reuse `sharedIntelligence` (already framework-aware: Claude or Codex
      // per resolvedFramework) so a Codex-only install gets Codex-backed
      // relationship resolution instead of falling back to heuristic-only.
      let intelligenceMode = 'heuristic-only';

      const staleRelApi = (config.relationships as unknown as { intelligenceProvider?: string }).intelligenceProvider === 'anthropic-api';
      if (staleRelApi) {
        console.log(pc.yellow(
          '  relationships.intelligenceProvider: "anthropic-api" is no longer supported — using the configured framework instead.\n'
          + '  Remove the field from config.json.'
        ));
      }

      if (sharedIntelligence) {
        config.relationships.intelligence = sharedIntelligence;
        intelligenceMode = `LLM-supervised (${intelligenceSource})`;
      } else if (config.sessions.claudePath && !isClaudeForbidden()) {
        // Last-ditch fallback for installs where sharedIntelligence couldn't
        // be built but a claude binary path is still configured. Skipped on
        // codex-only agents (isClaudeForbidden) — there, relationships run
        // without LLM intelligence rather than silently using Claude.
        config.relationships.intelligence =
          wrapIntelligenceWithCircuitBreaker(new ClaudeCliIntelligenceProvider(config.sessions.claudePath)) ?? undefined;
        intelligenceMode = 'LLM-supervised (Claude CLI subscription, fallback)';
      }

      relationships = new RelationshipManager(config.relationships);
      const count = relationships.getAll().length;
      console.log(pc.green(`  Relationships loaded: ${count} tracked (${intelligenceMode})`));
    }

    // Set up quota tracking if enabled
    let quotaTracker: QuotaTracker | undefined;
    let quotaManager: QuotaManager | undefined;
    if (config.monitoring?.quotaTracking) {
      const quotaFile = (config.monitoring as any).quotaStateFile
        || path.join(config.stateDir, 'quota-state.json');
      quotaTracker = new QuotaTracker({
        quotaFile,
        thresholds: config.scheduler?.quotaThresholds ?? { normal: 50, elevated: 60, critical: 80, shutdown: 95 },
      });
      console.log(pc.green(`  Quota tracking enabled (${quotaFile})`));
    }

    // Set up opt-in telemetry heartbeat.
    // ALWAYS construct, even when disabled — fixes the chicken-and-egg deadlock
    // where POST /telemetry/enable returned 503 because the subsystem was only
    // constructed when telemetry was already enabled at boot (so it could never
    // be turned on through its own endpoint). Construction is cheap and pure;
    // the side-effects (.start()/submit()) already self-gate on `config.enabled`
    // inside TelemetryHeartbeat, so an always-constructed-but-disabled heartbeat
    // never starts a loop and never submits. Spec: docs/specs/enable-layer-coherence.md
    let telemetryHeartbeat: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat | undefined;
    {
      const { TelemetryHeartbeat } = await import('../monitoring/TelemetryHeartbeat.js');
      telemetryHeartbeat = new TelemetryHeartbeat(
        config.monitoring?.telemetry ?? { enabled: false },
        config.stateDir,
        config.projectDir,
        config.version || 'unknown',
      );
      // Note: .start() is deferred until after scheduler is available so
      // TelemetryCollector can be wired; .start() itself no-ops when disabled.
      if (config.monitoring?.telemetry?.enabled) {
        console.log(pc.green(`  Telemetry: enabled (${config.monitoring.telemetry.level || 'basic'} level, every ${Math.round((config.monitoring.telemetry.intervalMs || 21600000) / 3600000)}h)`));
      }
    }

    // ── Prompt Gate: detect and handle interactive prompts in sessions ──
    const promptGateConfig = config.monitoring?.promptGate;
    let promptDetector: import('../monitoring/PromptGate.js').InputDetector | undefined;
    if (promptGateConfig?.enabled) {
      const { InputDetector } = await import('../monitoring/PromptGate.js');
      const { InputClassifier } = await import('../monitoring/InputClassifier.js');
      const { AutoApprover } = await import('../core/AutoApprover.js');

      const detector = new InputDetector({
        detectionWindowLines: promptGateConfig.detectionWindowLines ?? 50,
        enabled: true,
        intelligence: sharedIntelligence ?? undefined,
      });
      promptDetector = detector;

      const classifier = new InputClassifier({
        projectDir: config.sessions.projectDir,
        autoApprove: {
          enabled: promptGateConfig.autoApprove?.enabled ?? false,
          fileCreation: promptGateConfig.autoApprove?.fileCreation ?? true,
          fileEdits: promptGateConfig.autoApprove?.fileEdits ?? true,
          planApproval: promptGateConfig.autoApprove?.planApproval ?? true,
        },
        dryRun: promptGateConfig.dryRun ?? false,
        intelligence: sharedIntelligence,
      });

      const autoApprover = new AutoApprover({
        stateDir: config.stateDir,
        logRetentionDays: promptGateConfig.logRetentionDays ?? 30,
        verboseLogging: promptGateConfig.verboseLogging ?? false,
        sendKey: (tmuxSession, key) => sessionManager.sendKey(tmuxSession, key),
      });

      // Wire detector into SessionManager
      sessionManager.setPromptDetector(detector);

      // Handle detected prompts: classify → auto-approve or relay to Telegram
      detector.on('prompt', async (prompt: import('../monitoring/PromptGate.js').DetectedPrompt) => {
        try {
          // Non-blocking system prompts (e.g. Claude Code's optional session
          // feedback survey) carry an autoDismissKey directive. Send the key
          // and skip the classify/relay pipeline entirely to avoid Telegram
          // spam on prompts that don't actually block the session.
          if (prompt.autoDismissKey) {
            if (prompt.autoDismissDisposition === 'safe-reject') {
              const rejectedCommand = prompt.autoDismissCommand || prompt.summary || '(unknown command)';
              console.warn(
                `[PromptGate] Auto-rejected execution approval for ${prompt.sessionName} ` +
                `(key="${prompt.autoDismissKey}"): ${rejectedCommand}`
              );
              DegradationReporter.getInstance().report({
                feature: 'PromptGate.executionApprovalAutoReject',
                primary: 'Relay execution-approval prompts to the user or reject them explicitly',
                fallback: `Auto-rejected execution approval with key "${prompt.autoDismissKey}"`,
                reason: `Rejected command: ${rejectedCommand}`,
                impact: 'The session may pause or alter course, but arbitrary model-proposed command execution was not approved.',
              });
            }
            const dismissed = sessionManager.sendKey(prompt.sessionName, prompt.autoDismissKey);
            const dismissKind = prompt.autoDismissDisposition === 'safe-reject'
              ? 'safe-reject prompt'
              : 'non-blocking prompt';
            console.log(
              `[PromptGate] Auto-dismissed ${dismissKind} for ${prompt.sessionName} ` +
              `(key="${prompt.autoDismissKey}", sent=${dismissed}): ${prompt.summary}`
            );
            if (dismissed) detector.onAutoDismissSent(prompt);
            // Reset detector state so the next genuine prompt isn't blocked
            // by the per-session cooldown.
            detector.onInputSent(prompt.sessionName);
            return;
          }

          const classification = await classifier.classify(prompt);

          if (classification.action === 'auto-approve') {
            const handled = autoApprover.handle(prompt, classification);
            if (handled) {
              // Clear dedup so detector is ready for the next prompt
              detector.onInputSent(prompt.sessionName);
              return;
            }
            // If handle() returned false, fall through to relay
          }

          // Relay to messaging platform if adapter is available and session has a binding
          if (classification.action === 'relay' || classification.action === 'auto-approve') {
            let relayed = false;

            // Try Telegram first
            if (telegram) {
              const topicId = telegram.getTopicForSession(prompt.sessionName);
              if (topicId) {
                try {
                  await telegram.relayPrompt(topicId, prompt);
                  console.log(`[PromptGate] Relayed ${prompt.type} prompt to Telegram topic ${topicId}`);
                  relayed = true;
                } catch (relayErr) {
                  console.error(`[PromptGate] Telegram relay failed: ${relayErr instanceof Error ? relayErr.message : relayErr}`);
                }
              }
            }

            // Try Slack if not already relayed via Telegram
            if (!relayed && _slackAdapter) {
              const channelId = _slackAdapter.getChannelForSession(prompt.sessionName);
              if (channelId) {
                try {
                  const question = prompt.summary || 'Agent needs your input';
                  const options = (prompt.options || []).map((opt, i) => ({
                    label: opt.label.slice(0, 75),
                    value: opt.key,
                    primary: i === 0,
                  }));
                  if (options.length > 0) {
                    await _slackAdapter.relayPrompt(channelId, prompt.id, question, options);
                  } else {
                    await _slackAdapter.sendToChannel(channelId,
                      `⏳ *Agent needs your input:*\n${question}\n\n_Reply in this channel to respond._`
                    );
                  }
                  console.log(`[PromptGate] Relayed ${prompt.type} prompt to Slack channel ${channelId}`);
                } catch (relayErr) {
                  console.error(`[PromptGate] Slack relay failed: ${relayErr instanceof Error ? relayErr.message : relayErr}`);
                }
              }
            }
          }
        } catch (err) {
          console.error(`[PromptGate] Classification error: ${err instanceof Error ? err.message : err}`);
        }
      });

      const mode = promptGateConfig.autoApprove?.enabled
        ? (promptGateConfig.dryRun ? 'dry-run' : 'auto-approve')
        : 'detect-only';
      console.log(pc.green(`  Prompt Gate: enabled (mode: ${mode})`));
    }

    let scheduler: JobScheduler | undefined;
    if (config.scheduler.enabled && coordinator.isAwake) {
      scheduler = new JobScheduler(config.scheduler, sessionManager, state, config.stateDir);
      // Wire machine identity for machine-scoped job filtering
      if (coordinator.identity) {
        scheduler.setMachineIdentity(coordinator.identity.machineId, coordinator.identity.name);
      }
      if (quotaTracker) {
        // Basic binding — QuotaManager will override this once wired
        scheduler.canRunJob = quotaTracker.canRunJob.bind(quotaTracker);
        scheduler.setQuotaTracker(quotaTracker);
      }
      if (sharedIntelligence) {
        scheduler.setIntelligence(sharedIntelligence);
      }

      // Wire IntegrationGate — enforces learning consolidation after job completion
      const integrationGate = new IntegrationGate({
        stateDir: config.stateDir,
        intelligence: sharedIntelligence ?? null,
        runHistory: new JobRunHistory(config.stateDir),
      });
      scheduler.setIntegrationGate(integrationGate);

      scheduler.start();
      console.log(pc.green('  Scheduler started'));

      // Wire up Baseline TelemetryCollector now that scheduler is available
      if (telemetryHeartbeat && scheduler) {
        const sched = scheduler; // capture for closure narrowing
        const { TelemetryCollector } = await import('../monitoring/TelemetryCollector.js');
        const collector = new TelemetryCollector({
          skipLedger: sched.getSkipLedger(),
          runHistory: sched.getRunHistory(),
          getJobs: () => sched.getJobs(),
          version: config.version || 'unknown',
          startTime: Date.now(),
          getSessionCount24h: () => telemetryHeartbeat!.getStatus().counters.sessionsSpawned,
          getConfig: () => config as unknown as Record<string, unknown>,
          // Watchdog stats — lazy getter since watchdog may be initialized later
          getWatchdogStats: (sinceMs: number) => {
            if (!watchdog) return { interventionsTotal: 0, interventionsByLevel: {}, recoveries: 0, sessionDeaths: 0, llmGateOverrides: 0 };
            return watchdog.getStats(sinceMs);
          },
          // Session recovery stats — lazy getter (declared later in scope via `let`)
          getRecoveryStats: (_sinceMs: number) => {
            return { attempts: { stall: 0, crash: 0, errorLoop: 0 }, successes: { stall: 0, crash: 0, errorLoop: 0 } };
          },
          // Triage orchestrator stats — lazy getter (declared later in scope via `let`)
          getTriageStats: (_sinceMs: number) => {
            return { activations: 0, heuristicResolutions: 0, llmResolutions: 0, failures: 0, actionCounts: {} };
          },
          // Notification batcher stats — lazy getter
          getNotificationStats: () => {
            if (!notificationBatcher) return { flushed: 0, suppressed: 0, summaryQueueSize: 0, digestQueueSize: 0 };
            const s = notificationBatcher.getStats();
            return { flushed: s.totalFlushed, suppressed: s.totalSuppressed, summaryQueueSize: s.summaryQueueSize, digestQueueSize: s.digestQueueSize };
          },
          // Process staleness stats — lazy getter
          getStalenessStats: () => {
            const pi = ProcessIntegrity.getInstance();
            if (!pi) return { versionMismatch: false, driftCount: 0 };
            const drifts = staleGuard.checkAll();
            return { versionMismatch: pi.versionMismatch, driftCount: drifts.length };
          },
        });
        telemetryHeartbeat.setCollector(collector);
        console.log(pc.green('  Baseline telemetry collector wired'));
      }
    } else if (config.scheduler.enabled && !coordinator.isAwake) {
      console.log(pc.yellow('  Scheduler skipped (standby mode)'));
    }

    // Start telemetry heartbeat (deferred to here so collector can be wired first)
    if (telemetryHeartbeat) {
      telemetryHeartbeat.start();
    }

    // Helper: resolve pending plan prompts when a prompt response arrives.
    // Calls the internal route endpoint to mark the plan prompt as resolved,
    // which unblocks the PreToolUse hook that's polling for the response.
    const resolvePlanPromptForSession = (sessionName: string, key: string) => {
      const port = config.port ?? 4042;
      const payload = JSON.stringify({ sessionName, key });
      const http = require('node:http');
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/hooks/plan-prompt/resolve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${config.authToken}`,
        },
        timeout: 2000,
      });
      req.on('error', () => {}); // Best-effort
      req.write(payload);
      req.end();
    };

    // Set up Telegram if configured
    // When --no-telegram is set (lifeline owns polling), create adapter in send-only mode
    // so the server can still relay replies via /telegram/reply/:topicId
    let telegram: TelegramAdapter | undefined;
    let topicMemory: TopicMemory | undefined;
    const telegramConfig = config.messaging.find(m => m.type === 'telegram' && m.enabled);
    const skipTelegram = options.telegram === false; // --no-telegram sets telegram: false
    // Standby machines use send-only Telegram — they don't poll for messages
    const isStandbyTelegram = !coordinator.isAwake && telegramConfig;
    // Poll-ownership lease (Task 4 / 2026-05-27 silent-stalls postmortem,
    // SELF-PROPAGATION-HARNESS-SPEC.md Part 1): if a lifeline is already polling
    // this bot token (lease present + fresh + token-hash match), the server
    // auto-demotes to send-only — Telegram allows exactly one long-poller per
    // token, and dual-polling would 409. Fail-OPEN: any read miss/stale/
    // mismatch ⇒ false ⇒ server polls as today, so setups without a lifeline
    // are unaffected. Reads only — never writes the lease here.
    // HARDENED (v1.3.270 boot-crash incident): an unresolved `{ secret: true }`
    // placeholder is a truthy OBJECT — only a real string token may reach
    // tokenHash(), or the whole boot dies with ERR_INVALID_ARG_TYPE.
    const rawTelegramToken = telegramConfig ? (telegramConfig.config as { token?: unknown }).token : undefined;
    const telegramBotToken = typeof rawTelegramToken === 'string' && rawTelegramToken ? rawTelegramToken : undefined;
    const lifelineOwnsPolling = telegramConfig && telegramBotToken
      ? lifelineOwnsTelegramPoll(config.stateDir, telegramBotToken)
      : false;
    if ((skipTelegram || isStandbyTelegram || lifelineOwnsPolling) && telegramConfig) {
      // Send-only mode: no polling, but sendToTopic() works for session replies
      telegram = new TelegramAdapter(
        {
          ...(telegramConfig.config as any),
          // PR2: hot-reloadable accessors. Sending-side authoritative —
          // each send re-reads config so a canary flip lands without restart.
          getFormatMode: () =>
            (config as unknown as { telegramFormatMode?: 'plain' | 'html' | 'code' | 'markdown' | 'legacy-passthrough' })
              .telegramFormatMode,
          getLintStrict: () =>
            (config as unknown as { telegramLintStrict?: boolean }).telegramLintStrict,
        },
        config.stateDir,
      );
      console.log(pc.green(`  Telegram send-only mode (${isStandbyTelegram ? 'standby' : lifelineOwnsPolling ? 'lifeline owns polling (lease detected)' : 'lifeline owns polling'})`));

      // Resolve any topic names still using the fallback "topic-NNNN" pattern
      telegram.resolveUnknownTopicNames().catch(err => {
        console.warn(`[telegram] Topic name resolution failed: ${err}`);
      });

      // Ensure topics exist even in send-only mode (createForumTopic is a simple API call)
      ensureAgentAttentionTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Attention topic: ${err}`);
      });
      ensureAgentUpdatesTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Updates topic: ${err}`);
      });

      // Wire Prompt Gate callbacks in send-only mode too — the lifeline forwards
      // callback queries via /internal/telegram-callback, and we need handlers for them
      if (promptGateConfig?.enabled) {
        telegram.onPromptResponse = (sessionName, key) => {
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          // Also resolve any pending plan prompt for this session (unblocks the hook)
          resolvePlanPromptForSession(sessionName, key);
          const sent = sessionManager.sendKey(sessionName, key);
          // Reset detector dedup / cooldown so the NEXT prompt in a multi-step
          // form (or a fresh prompt that follows) can be detected immediately.
          if (sent) promptDetector?.onInputSent(sessionName);
          return sent;
        };
        telegram.onPromptTextResponse = (sessionName, text) => {
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping text injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          const sent = sessionManager.sendInput(sessionName, text);
          if (sent) promptDetector?.onInputSent(sessionName);
          return sent;
        };
        telegram.onRelayLeaseStart = (sessionName) => {
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            const leaseMs = (promptGateConfig.relayTimeoutSeconds ?? 300) * 2 * 1000;
            sessionManager.grantRelayLease(session.id, leaseMs);
          }
        };
        telegram.onRelayLeaseEnd = (sessionName) => {
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            sessionManager.clearRelayLease(session.id);
          }
        };
        console.log(pc.green('  Prompt Gate: Telegram relay wired (via lifeline callback forwarding)'));
      }

      // Wire incoming-message routing + command callbacks so messages forwarded
      // by lifeline (via /internal/telegram-forward → onTopicMessage) actually
      // fire handleCommand → onRouteCommand / onListSessions / onFlush etc.
      // Without this, send-only mode left onTopicMessage null, so the
      // /internal/telegram-forward handler in routes.ts fell through to the
      // "--no-telegram (registry-only) injection" branch and slash-commands
      // reached the AI session as plain chat text.
      const userManagerSendOnly = new UserManager(config.stateDir, config.users);
      _fixDeps = { state, liveConfig, sessionManager, telegram, config };
      wireTelegramRouting(telegram, sessionManager, quotaTracker, topicMemory, userManagerSendOnly,
        (topicId, text) => handleFixCommand(topicId, text, _fixDeps!),
        () => (collaborationSurfacer && conversationStore && telegram) ? { collaborationSurfacer, conversationStore, commitmentTracker, telegram, brief: briefDeps } : null);
      wireTelegramCallbacks(telegram, sessionManager, state, quotaTracker, undefined, config.sessions.claudePath, topicMemory);
      console.log(pc.green('  Telegram routing + command callbacks wired (send-only)'));
    }

    if (telegramConfig && !skipTelegram && !isStandbyTelegram && !lifelineOwnsPolling) {
      telegram = new TelegramAdapter(
        {
          ...(telegramConfig.config as any),
          // PR2: hot-reloadable accessors. Sending-side authoritative —
          // each send re-reads config so a canary flip lands without restart.
          getFormatMode: () =>
            (config as unknown as { telegramFormatMode?: 'plain' | 'html' | 'code' | 'markdown' | 'legacy-passthrough' })
              .telegramFormatMode,
          getLintStrict: () =>
            (config as unknown as { telegramLintStrict?: boolean }).telegramLintStrict,
        },
        config.stateDir,
      );
      telegram.intelligence = sharedIntelligence ?? null;
      await telegram.start();
      console.log(pc.green(`  Telegram connected (stall alerts: ${sharedIntelligence ? 'LLM-gated' : 'timer-only'})`));

      // UNIFIED-SESSION-LIFECYCLE bonus — session label follows topic rename.
      // When the user renames a Telegram forum topic, update the bound
      // session's display `name` ONLY (never tmuxSession or id). Fire-and-
      // forget; rename-display is non-critical.
      telegram.setTopicRenamedHandler((topicId, newName) => {
        const tmuxSession = telegram?.getSessionForTopic(topicId);
        if (!tmuxSession) return;
        const renamed = sessionManager.renameSessionByTmux(tmuxSession, newName);
        if (renamed) {
          console.log(`[session-rename] Updated bound session "${tmuxSession}" display name → "${newName}" (topic ${topicId})`);
        }
      });

      // Threadline → Telegram bridge — mirrors inbound/outbound threadline
      // messages into per-thread Telegram topics. Default-OFF; the relay
      // handler below and the threadline_send tool consult bridge.mirror*
      // unconditionally — TelegramBridgeConfig owns the gate.
      try {
        const { TelegramBridge } = await import('../threadline/TelegramBridge.js');
        telegramBridge = new TelegramBridge({
          stateDir: config.stateDir,
          localAgentName: config.projectName,
          config: telegramBridgeConfig,
          telegram,
        });
        console.log(pc.dim(`  Threadline → Telegram bridge: armed (default ${telegramBridgeConfig.getSettings().enabled ? 'ENABLED' : 'OFF'})`));
      } catch (err) {
        console.warn(pc.yellow(`  Threadline → Telegram bridge init failed (non-fatal): ${err instanceof Error ? err.message : err}`));
      }

      // Wire Prompt Gate callbacks — connect Telegram relay responses to sessions
      if (promptGateConfig?.enabled) {
        telegram.onPromptResponse = (sessionName, key) => {
          // Pre-injection verification: confirm session is still alive
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          // Also resolve any pending plan prompt for this session (unblocks the hook)
          resolvePlanPromptForSession(sessionName, key);
          const sent = sessionManager.sendKey(sessionName, key);
          // Reset detector dedup / cooldown so a follow-up prompt isn't
          // blocked by the per-session 5-minute LLM relay cooldown.
          if (sent) promptDetector?.onInputSent(sessionName);
          return sent;
        };
        telegram.onPromptTextResponse = (sessionName, text) => {
          // Pre-injection verification: confirm session is still alive
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[PromptGate] Skipping text injection — session "${sessionName}" is no longer alive`);
            return false;
          }
          const sent = sessionManager.sendInput(sessionName, text);
          if (sent) promptDetector?.onInputSent(sessionName);
          return sent;
        };
        telegram.onRelayLeaseStart = (sessionName) => {
          // Find the session by tmux name and grant a relay lease
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            const leaseMs = (promptGateConfig.relayTimeoutSeconds ?? 300) * 2 * 1000;
            sessionManager.grantRelayLease(session.id, leaseMs);
          }
        };
        telegram.onRelayLeaseEnd = (sessionName) => {
          const sessions = sessionManager.listRunningSessions();
          const session = sessions.find(s => s.tmuxSession === sessionName);
          if (session) {
            sessionManager.clearRelayLease(session.id);
          }
        };
        // Periodic relay timeout checker (every 60s)
        const relayPruneTimer = setInterval(() => {
          telegram!.pruneExpiredRelays().catch(err => {
            console.error(`[PromptGate] Relay prune error: ${err instanceof Error ? err.message : err}`);
          });
        }, 60_000);
        if (relayPruneTimer.unref) relayPruneTimer.unref();
        console.log(pc.green('  Prompt Gate: Telegram relay wired'));
      }

      // Wire NotificationBatcher to Telegram and start batching
      notificationBatcher.setSendFunction(
        async (topicId, text) => {
          await telegram!.sendToTopic(topicId, text);
          // NOTE: Batched notifications (SUMMARY/DIGEST) are NOT mirrored to Slack.
          // Only IMMEDIATE notifications reach Slack (via the notify() gateway).
          // This prevents notification spam in the attention channel.
          return { messageId: 0 };
        }
      );
      notificationBatcher.start();
      console.log(pc.green('  Notification batcher enabled (SUMMARY: 30m, DIGEST: 2h)'));

      // Set up account switcher (Keychain-based OAuth account swapping)
      const accountSwitcher = new AccountSwitcher();

      // Set up quota notifier (Telegram alerts on threshold crossings)
      const quotaNotifier = new QuotaNotifier(config.stateDir);
      const alertTopicId = state.get<number>('agent-attention-topic') ?? null;
      quotaNotifier.configure(
        async (_topicId, text) => {
          // Quota exhaustion is IMMEDIATE; warnings are SUMMARY
          const tier: NotificationTier = text.includes('EXHAUSTED') || text.includes('critical') ? 'IMMEDIATE' : 'SUMMARY';
          notify(tier, 'quota', text);
        },
        alertTopicId,
      );

      // Set up QuotaManager orchestration hub (Phase 4)
      if (quotaTracker) {
        // Try to set up the full collector-driven pipeline
        let collector: InstanceType<typeof import('../monitoring/QuotaCollector.js').QuotaCollector> | null = null;
        let migrator: InstanceType<typeof import('../monitoring/SessionMigrator.js').SessionMigrator> | null = null;

        try {
          const { QuotaCollector } = await import('../monitoring/QuotaCollector.js');
          const { createDefaultProvider } = await import('../monitoring/CredentialProvider.js');
          if (resolvedFramework === 'claude-code') {
            const provider = createDefaultProvider();
            collector = new QuotaCollector(provider, quotaTracker);
          } else {
            console.log(pc.yellow(`  QuotaCollector skipped for ${resolvedFramework} (no framework usage meter)`));
          }
        } catch (err) {
          console.log(pc.yellow(`  QuotaCollector not available: ${err instanceof Error ? err.message : err}`));
        }

        try {
          const { SessionMigrator } = await import('../monitoring/SessionMigrator.js');
          migrator = new SessionMigrator({ stateDir: config.stateDir });
        } catch (err) {
          console.log(pc.yellow(`  SessionMigrator not available: ${err instanceof Error ? err.message : err}`));
        }

        quotaManager = new QuotaManager(
          { stateDir: config.stateDir },
          {
            tracker: quotaTracker,
            collector,
            switcher: accountSwitcher,
            migrator,
            notifier: quotaNotifier,
          },
        );

        // Wire session manager and scheduler for migration support
        quotaManager.setSessionManager(sessionManager);
        if (scheduler) {
          quotaManager.setScheduler(scheduler);
        }

        // Wire Telegram notifications
        quotaManager.setNotificationSender(async (message) => {
          const tier: NotificationTier = message.includes('❌') || message.includes('EXHAUSTED') ? 'IMMEDIATE' : 'SUMMARY';
          notify(tier, 'quota', message);
        });

        // Start adaptive polling (replaces the 10-min setInterval)
        quotaManager.start();
        console.log(pc.green('  QuotaManager started (adaptive polling, auto-migration)'));
      } else {
        console.log(pc.yellow('  QuotaManager skipped (no quota tracker)'));
      }

      // Initialize persistent UserManager for user identity resolution (Gap 8)
      const userManager = new UserManager(config.stateDir, config.users);

      // Fix command dependencies — populated later when subsystems initialize.
      // Uses a mutable ref so wireTelegramRouting can capture it in a closure now.
      _fixDeps = {
        state,
        liveConfig,
        sessionManager,
        telegram,
        config,
      };

      // Wire up topic → session routing and session management callbacks
      wireTelegramRouting(telegram, sessionManager, quotaTracker, topicMemory, userManager,
        (topicId, text) => handleFixCommand(topicId, text, _fixDeps!),
        () => (collaborationSurfacer && conversationStore && telegram) ? { collaborationSurfacer, conversationStore, commitmentTracker, telegram, brief: briefDeps } : null);
      wireTelegramCallbacks(telegram, sessionManager, state, quotaTracker, accountSwitcher, config.sessions.claudePath, topicMemory);

      // Wire up unknown-user handling (Multi-User Setup Wizard Phase 4.5)
      telegram.onGetRegistrationPolicy = () => ({
        policy: config.userRegistrationPolicy ?? 'admin-only',
        contactHint: config.registrationContactHint,
        agentName: config.projectName,
      });

      telegram.onNotifyAdminJoinRequest = async (request) => {
        const { JoinRequestManager } = await import('../users/UserOnboarding.js');
        const joinManager = new JoinRequestManager(config.stateDir);
        const joinRequest = joinManager.createRequest(
          request.name,
          request.telegramUserId,
          null, // agentAssessment — could be enhanced later with LLM evaluation
        );

        // Notify admin via Lifeline topic (the always-available admin channel)
        const lifelineTopicId = telegram!.getLifelineTopicId();
        if (lifelineTopicId) {
          const userLabel = request.username ? `@${request.username}` : request.name;
          await telegram!.sendToTopic(lifelineTopicId,
            `\ud83d\udc64 **Join Request** from ${userLabel} (ID: ${request.telegramUserId})\n\n` +
            `To approve: \`/approve ${joinRequest.approvalCode}\`\n` +
            `To deny: \`/deny ${joinRequest.approvalCode}\``,
          ).catch(() => {});
        }
      };

      telegram.onStartMiniOnboarding = async (telegramUserId, firstName, username) => {
        const { buildUserProfile, buildCondensedConsentDisclosure } = await import('../users/UserOnboarding.js');

        // Send consent disclosure first
        const consentText = buildCondensedConsentDisclosure(config.projectName);
        await telegram!.sendToTopic(1, consentText).catch(() => {}); // General topic

        // Build a basic profile (consent will be confirmed via follow-up reply)
        const profile = buildUserProfile({
          name: firstName,
          telegramUserId,
        });

        // Add to persistent UserManager (reuses the instance created above)
        userManager.upsertUser(profile);

        // Add to authorized user IDs so future messages are accepted
        const telegramConfig = config.messaging?.find(m => m.type === 'telegram');
        if (telegramConfig?.config) {
          const authIds = (telegramConfig.config.authorizedUserIds as number[]) ?? [];
          // Type-tolerant membership check: config JSON may already hold ids as
          // strings, so a strict `includes(number)` would miss an existing string
          // entry and push a duplicate (leaving mixed-type config). Compare as
          // strings; isAuthorized() is likewise type-tolerant.
          const already = authIds.some(id => String(id) === String(telegramUserId));
          if (!already) {
            authIds.push(telegramUserId);
            telegramConfig.config.authorizedUserIds = authIds;
          }
        }

        console.log(`[telegram] Mini-onboarding complete for ${firstName} (${telegramUserId})`);
      };

      console.log(pc.green('  Telegram message routing active'));

      if (scheduler) {
        scheduler.setMessenger(telegram);
        scheduler.setTelegram(telegram);
        if (topicMemory?.isReady()) {
          scheduler.setTopicMemory(topicMemory);
        }
      }

      // Ensure Agent Attention topic exists (the agent's direct line to the user)
      ensureAgentAttentionTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Attention topic: ${err}`);
      });

      // Ensure Agent Updates topic exists (informational updates, not critical)
      ensureAgentUpdatesTopic(telegram, state).catch(err => {
        console.error(`[server] Failed to ensure Agent Updates topic: ${err}`);
      });
    }

    // Agent worktree convention (Layer 4) — lifeline detector.
    //
    // Runs once per server boot. Inspects the canonical instar repo's
    // worktree list and emits an AttentionItem per worktree that lives
    // outside any registered agent's `<agent_home>/.worktrees/` safe
    // area. Signal-only: never blocks, never moves, never deletes.
    //
    // Placement is deliberately AFTER both TelegramAdapter setup blocks
    // (send-only at line ~2810 and full-mode at line ~2897) so we can
    // pass `telegram.createAttentionItem` as the emit-attention callback.
    // When Telegram isn't configured the detector still runs and falls
    // back to the JSONL append at
    // `<stateDir>/audit/worktree-detector.jsonl` (O_NOFOLLOW + fstat,
    // 24h rolling-window dedupe).
    //
    // Dedupe semantics:
    //   - Telegram path: AttentionQueue's `item.id` collision (a second
    //     emit with the same `worktree-misplaced:sha256(path)` id is a
    //     no-op via the existing `attentionItems` Map lookup in
    //     TelegramAdapter.createAttentionItem).
    //   - JSONL path: 24h rolling-window scan of the fallback file.
    try {
      const detector = await import('../core/AgentWorktreeDetector.js');
      const repo = detector.resolveDetectorInstarRepo();
      if (repo) {
        const safeRoots = detector.enumerateSafeRoots();
        const emitAttention = telegram
          ? async (item: import('../core/AgentWorktreeDetector.js').AttentionItemInput) => {
              await telegram!.createAttentionItem({
                id: item.id,
                title: item.title,
                summary: item.summary,
                description: item.description,
                category: item.category,
                priority: item.priority,
                sourceContext: item.sourceContext,
              });
            }
          : undefined;
        const detectionResult = await detector.runDetection({
          instarRepo: repo,
          stateDir: config.stateDir,
          safeRoots,
          emitAttention,
        });
        if (detectionResult.misplacedCount > 0 || detectionResult.timedOut) {
          const channel = telegram ? 'Telegram' : 'JSONL fallback';
          console.log(pc.yellow(
            `  Worktree detector: ${detectionResult.misplacedCount} misplaced worktree(s) flagged via ${channel} ` +
              `(${detectionResult.emitted} aggregated item(s), ` +
              `enumerated=${detectionResult.enumerated} skipped=${detectionResult.skipped}` +
              `${detectionResult.deduped ? ` deduped=${detectionResult.deduped}` : ''}` +
              `${detectionResult.timedOut ? ' [timeout]' : ''})`,
          ));
        }
      }
    } catch (err) {
      console.log(pc.yellow(
        `  Worktree detector: skipped (${err instanceof Error ? err.message : String(err)})`,
      ));
    }

    // ArcCheck (Layer 3) — declared at outer scope so the instance built inside
    // the telegram block is visible at AgentServer construction below. The same
    // instance backs the HTTP route and the in-process checkOutboundMessage caller.
    let topicIntentArcCheck: import('../core/TopicIntentArcCheck.js').ArcCheck | undefined;

    // Initialize TopicMemory whenever Telegram is configured (any mode).
    // TopicMemory provides session context — needed even when lifeline owns polling.
    if (telegram) {
      topicMemory = new TopicMemory(config.stateDir);
      try {
        try {
          await topicMemory.open();
        } catch (openErr) {
          const reason = openErr instanceof Error ? openErr.message : String(openErr);
          const isBindingError = reason.includes('Could not locate the bindings file') ||
            reason.includes('better-sqlite3') ||
            reason.includes('was compiled against a different Node.js version');

          if (!isBindingError) throw openErr;

          console.log(pc.yellow('  TopicMemory: native binding mismatch — auto-rebuilding better-sqlite3...'));
          const fixScript = path.resolve(__dirname, '../../../scripts/fix-better-sqlite3.cjs');
          if (fs.existsSync(fixScript)) {
            execFileSync(process.execPath, [fixScript], { encoding: 'utf-8', timeout: 60000, stdio: 'pipe' });
          } else {
            const npmCli = findNpmCli();
            const globalInstarDir = execFileSync(process.execPath, [npmCli, 'root', '-g'], { encoding: 'utf-8', timeout: 10000 }).toString().trim() + '/instar';
            execFileSync(process.execPath, [npmCli, 'rebuild', 'better-sqlite3'], {
              cwd: globalInstarDir,
              encoding: 'utf-8',
              timeout: 60000,
              stdio: 'pipe',
            });
          }
          console.log(pc.green('  TopicMemory: better-sqlite3 rebuilt successfully, retrying...'));

          topicMemory = new TopicMemory(config.stateDir);
          await topicMemory.open();
        }

        const jsonlPath = path.join(config.stateDir, 'telegram-messages.jsonl');
        if (fs.existsSync(jsonlPath)) {
          const imported = await topicMemory.importFromJsonl(jsonlPath);
          if (imported > 0) {
            console.log(pc.green(`  TopicMemory: imported ${imported} messages from JSONL`));
          }
        }

        const tmStats = topicMemory.stats();
        console.log(pc.green(`  TopicMemory: ${tmStats.totalMessages} messages, ${tmStats.totalTopics} topics, ${tmStats.topicsWithSummaries} summaries`));

        // Wire dual-write: every message logged to JSONL also goes to SQLite.
        // Includes sender identity for multi-user topic context (Phase 1D — User-Agent Topology Spec).
        const tm = topicMemory;
        telegram.onMessageLogged = (entry) => {
          if (entry.topicId != null && tm) {
            tm.insertMessage({
              messageId: entry.messageId,
              topicId: entry.topicId,
              text: entry.text,
              fromUser: entry.fromUser,
              timestamp: entry.timestamp,
              sessionName: entry.sessionName,
              senderName: entry.senderName,
              senderUsername: entry.senderUsername,
              telegramUserId: entry.telegramUserId,
            });
          }
        };
      } catch (err) {
        // @silent-fallback-ok — already uses DegradationReporter
        const reason = err instanceof Error ? err.message : String(err);
        topicMemory = undefined;

        degradationReporter.report({
          feature: 'TopicMemory',
          primary: 'SQLite-backed conversational memory with summaries and FTS5 search',
          fallback: 'JSONL-based last 20 messages (no summaries, no search)',
          reason: `TopicMemory init failed: ${reason}`,
          impact: 'Sessions start without conversation summaries. Search unavailable. Context limited to last 20 raw messages.',
        });
      }
    }

    // ── WhatsApp adapter initialization ──────────────────────────────
    let whatsappAdapter: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter | undefined;
    let whatsappBusinessBackend: import('../messaging/backends/BusinessApiBackend.js').BusinessApiBackend | undefined;
    let messageBridge: import('../messaging/shared/MessageBridge.js').MessageBridge | undefined;

    const whatsappConfig = config.messaging?.find(m => m.type === 'whatsapp' && m.enabled);
    if (whatsappConfig) {
      try {
        const { WhatsAppAdapter } = await import('../messaging/WhatsAppAdapter.js');
        whatsappAdapter = new WhatsAppAdapter(whatsappConfig.config as Record<string, unknown>, config.stateDir);
        await whatsappAdapter.start();

        const waConf = whatsappConfig.config as Record<string, unknown>;
        const backendType = (waConf.backend as string) ?? 'baileys';

        if (backendType === 'business-api') {
          const { BusinessApiBackend } = await import('../messaging/backends/BusinessApiBackend.js');
          const businessApiConf = waConf.businessApi as { phoneNumberId: string; accessToken: string; webhookVerifyToken: string; webhookPort?: number };
          whatsappBusinessBackend = new BusinessApiBackend(
            whatsappAdapter,
            businessApiConf,
            {
              onConnected: (phone) => console.log(pc.green(`  WhatsApp Business API connected: ${phone}`)),
              onMessage: async (jid: string, msgId: string, text: string, senderName?: string, timestamp?: number) => {
                await whatsappAdapter!.handleIncomingMessage(jid, msgId, text, senderName, timestamp);
              },
              onButtonReply: (_jid, _msgId, buttonId, _title) => {
                console.log(`[whatsapp] Button reply: ${buttonId}`);
              },
              onError: (err) => console.error(`[whatsapp] Business API error: ${err.message}`),
              onStatusUpdate: (_msgId, status) => {
                if (status === 'failed') console.warn(`[whatsapp] Message delivery failed`);
              },
            },
          );
          await whatsappBusinessBackend.connect();
          console.log(pc.green(`  WhatsApp Business API: webhook routes at /webhooks/whatsapp`));
        } else {
          // Baileys backend
          const { BaileysBackend } = await import('../messaging/backends/BaileysBackend.js');
          const baileysConfig = whatsappAdapter.getBaileysConfig();
          const baileysBackend = new BaileysBackend(
            whatsappAdapter,
            baileysConfig,
            {
              onQrCode: (qr) => console.log(`[whatsapp] QR code: ${qr.substring(0, 20)}...`),
              onPairingCode: (code) => console.log(`[whatsapp] Pairing code: ${code}`),
              onConnected: (phone) => console.log(pc.green(`  WhatsApp (Baileys) connected: ${phone}`)),
              onDisconnected: (reason, shouldReconnect) => {
                console.log(`[whatsapp] Disconnected: ${reason}${shouldReconnect ? ' (reconnecting)' : ''}`);
              },
              onMessage: async (jid, msgId, text, senderName, timestamp, msgKey, participant, mentionedJids) => {
                await whatsappAdapter!.handleIncomingMessage(jid, msgId, text, senderName, timestamp, msgKey, participant, mentionedJids);
              },
              onError: (err) => console.error(`[whatsapp] Baileys error: ${err.message}`),
            },
          );
          await baileysBackend.connect();
        }

        // Wire WhatsApp → Claude session routing
        wireWhatsAppRouting(whatsappAdapter, sessionManager);
        console.log(pc.green('  WhatsApp message routing: wired'));

        // Wire cross-platform alerts if both adapters are available
        if (telegram && whatsappAdapter) {
          const { CrossPlatformAlerts } = await import('../messaging/shared/CrossPlatformAlerts.js');
          const crossAlerts = new CrossPlatformAlerts({
            telegram,
            whatsapp: whatsappAdapter,
            businessApiBackend: whatsappBusinessBackend,
            getAlertTopicId: () => state.get<number>('agent-attention-topic') ?? null,
          });
          crossAlerts.start();
          console.log(pc.green('  Cross-platform alerts: WhatsApp <-> Telegram'));

          // Wire message bridge for cross-platform message forwarding
          try {
            const { MessageBridge } = await import('../messaging/shared/MessageBridge.js');
            messageBridge = new MessageBridge({
              registryPath: path.join(config.stateDir ?? '.instar/state', 'bridge-registry.json'),
              whatsappEventBus: whatsappAdapter.getEventBus() ?? undefined,
              telegramEventBus: telegram.getEventBus() ?? undefined,
              sendToTelegram: async (topicId, text) => {
                await telegram.sendToTopic(topicId, text);
              },
              sendToWhatsApp: async (jid, text) => {
                await whatsappAdapter!.send({
                  content: text,
                  userId: jid,
                  channel: { type: 'whatsapp', identifier: jid },
                });
              },
            });
            messageBridge.start();
            console.log(pc.green('  Message bridge: WhatsApp <-> Telegram'));
          } catch (bridgeErr) {
            console.error(`  Message bridge init failed: ${bridgeErr}`);
          }
        }

        console.log(pc.green(`  WhatsApp adapter: ${backendType} backend`));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`  WhatsApp init failed: ${reason}`));
        whatsappAdapter = undefined;
        whatsappBusinessBackend = undefined;

        degradationReporter.report({
          feature: 'WhatsApp',
          primary: 'WhatsApp messaging adapter',
          fallback: 'Telegram only',
          reason: `WhatsApp init failed: ${reason}`,
          impact: 'WhatsApp messaging unavailable. Telegram continues working.',
        });
      }
    }

    // ── Slack adapter initialization ─────────────────────────────────
    let slackAdapter: import('../messaging/slack/SlackAdapter.js').SlackAdapter | undefined;

    const slackConfig = config.messaging?.find(m => m.type === 'slack' && m.enabled);
    if (slackConfig) {
      try {
        const { SlackAdapter } = await import('../messaging/slack/index.js');
        slackAdapter = new SlackAdapter(slackConfig.config as Record<string, unknown>, config.stateDir);

        // Wire message handler — inject Slack messages into sessions
        slackAdapter.onMessage(async (message) => {
          const channelId = message.channel.identifier;
          const isDM = message.metadata?.isDM as boolean;
          const senderName = message.metadata?.senderName as string || 'User';

          // Sentinel intercept — classify message for emergency stop/pause
          if (sentinel) {
            try {
              const classification = await sentinel.classify(message.content);
              if (classification.category === 'emergency-stop') {
                // Kill all sessions
                const sessions = sessionManager.listRunningSessions();
                for (const s of sessions) {
                  try { sessionManager.killSession(s.id); } catch { /* ok */ }
                }
                slackAdapter!.sendToChannel(channelId, '🛑 Emergency stop — all sessions killed.').catch(() => {});
                return;
              } else if (classification.category === 'pause') {
                const existingSession = slackAdapter!.getSessionForChannel(channelId);
                if (existingSession) {
                  sessionManager.sendKey(existingSession, 'Escape');
                  slackAdapter!.sendToChannel(channelId, '⏸️ Session paused.').catch(() => {});
                }
                return;
              }
            } catch { /* fail-open — if Sentinel errors, process message normally */ }
          }

          // Build injection tag with sender info (matches Telegram's buildInjectionTag pattern)
          const slackUserId = message.metadata?.slackUserId as string;
          // Sanitize sender name at injection boundary (prevents injection attacks)
          const safeSenderName = senderName
            ? senderName.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').replace(/["\[\]]/g, '').trim().slice(0, 64) || 'User'
            : undefined;
          let prefix = `[slack:${channelId}]`;
          if (safeSenderName && slackUserId) {
            prefix = `[slack:${channelId} from ${safeSenderName} (uid:${slackUserId})]`;
          } else if (safeSenderName) {
            prefix = `[slack:${channelId} from ${safeSenderName}]`;
          }

          // Build context for the session — inject inline like Telegram does
          // Use async fallback to fetch from Slack API if ring buffer is empty
          const tmpDir = '/tmp/instar-slack';
          fs.mkdirSync(tmpDir, { recursive: true });
          const history = await slackAdapter!.getChannelMessagesWithFallback(channelId, 30);
          const unansweredCount = slackAdapter!.getUnansweredCount(channelId);

          const botUserId = slackAdapter!.getBotUserId?.() ?? null;

          // Build human-readable thread history (matches Telegram's inline context pattern)
          const contextLines: string[] = [];
          if (history.length > 0) {
            contextLines.push('CONTINUATION — You are resuming an EXISTING Slack conversation. Read the context below before responding. Do NOT ask what was being discussed.');
            contextLines.push('');
            contextLines.push(`--- Thread History (last ${history.length} messages) ---`);
            contextLines.push('IMPORTANT: Read this history carefully before taking any action.');
            contextLines.push('Your task is to continue THIS conversation, not start something new.');
            contextLines.push(`Channel: ${channelId}`);
            contextLines.push('');
            for (const m of history) {
              const date = new Date(parseFloat(m.ts) * 1000);
              const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
              const isBot = botUserId && m.user === botUserId;
              const label = isBot ? 'Agent' : (senderName || m.user);
              contextLines.push(`[${time}] ${label}: ${m.text}`);
            }
            contextLines.push('');
            contextLines.push('--- End Thread History ---');
          } else {
            console.warn(`[slack→context] No history available for channel ${channelId} — session starts without thread context`);
          }
          contextLines.push('');
          contextLines.push('CRITICAL: You MUST relay your response back to Slack after responding.');
          contextLines.push('Use the relay script (write ONLY your reply text — do NOT pipe or cat this file into the script):');
          contextLines.push('');
          contextLines.push(`cat <<'EOF' | .claude/scripts/slack-reply.sh ${channelId}`);
          contextLines.push('Your response text here');
          contextLines.push('EOF');
          contextLines.push('');
          contextLines.push('Strip the [slack:] prefix before interpreting the message.');
          contextLines.push('Only relay conversational text — not tool output, file contents, or internal reasoning.');

          const contextData = contextLines.join('\n');

          // Also write to file as backup reference
          const ctxPath = path.join(tmpDir, `ctx-${channelId}-${Date.now()}.txt`);
          fs.writeFileSync(ctxPath, contextData);

          // Transform [image:path] and [document:path] tags into explicit read instructions
          let transformedContent = message.content.replace(
            /\[image:([^\]]+)\]/g,
            (_, imagePath: string) => {
              if (imagePath === 'download-failed') {
                return '[User sent a photo but the download failed]';
              }
              return `[User sent a photo — read the image file at ${imagePath} to view it. If the image cannot be processed, acknowledge you received it and describe what you can see, or let the user know the image format may not be supported.]`;
            },
          ).replace(
            /\[document:([^\]]+)\]/g,
            (_, docPath: string) => {
              if (docPath === 'download-failed') {
                return '[User sent a file but the download failed]';
              }
              return `[User sent a file — it has been saved to ${docPath}. Read the file to view its contents]`;
            },
          );

          // Inject context INLINE in the bootstrap message (matches Telegram pattern).
          // This ensures the agent sees thread history immediately without needing to read a file.
          const fullMessage = `${prefix} ${transformedContent} (IMPORTANT: Read ${ctxPath} for thread history and Slack relay instructions — you MUST relay your response back.)`;

          // Large bootstrap messages: write to file with INLINE context included
          const FILE_THRESHOLD = 500;
          let bootstrapMessage: string;
          if (fullMessage.length > FILE_THRESHOLD) {
            // Write full message + inline context to the file so agent gets everything in one read
            const msgFilePath = path.join(tmpDir, `msg-${channelId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`);
            const fullContent = `${fullMessage}\n\n${contextData}`;
            fs.writeFileSync(msgFilePath, fullContent);
            bootstrapMessage = `${prefix} [Long message saved to ${msgFilePath} — read it to see the full message and thread history]`;
          } else {
            bootstrapMessage = fullMessage;
          }

          // Check for existing session bound to this channel
          const existingSession = slackAdapter!.getSessionForChannel(channelId);
          if (existingSession) {
            // Try to inject into existing session via tmux
            const sessions = sessionManager.listRunningSessions();
            const alive = sessions.find(s => s.tmuxSession === existingSession);
            if (alive) {
              console.log(`[slack→session] Injecting into ${existingSession}: "${message.content.slice(0, 80)}"`);
              // Wait for Claude to be ready (handles race with recently spawned sessions)
              const ready = await sessionManager.waitForClaudeReady(existingSession, 15000);
              if (!ready) {
                // Session is stuck (permissions prompt, tool hang, etc.)
                // Kill it and fall through to spawn a fresh session — never silently lose messages
                console.warn(`[slack→session] Session ${existingSession} not ready after 15s — killing and respawning`);
                try {
                  const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === existingSession);
                  if (stuckSession) {
                    sessionManager.killSession(stuckSession.id);
                  }
                } catch { /* ok if already dead */ }
                // Fall through to respawn below — registerChannelSession will be called with new session name
              } else {
                // Session is ready — inject via SessionManager (handles idle timer reset + bracketed paste)
                try {
                  sessionManager.injectMessage(existingSession, bootstrapMessage);
                  // Track for stall detection
                  slackAdapter!.trackMessageInjection(channelId, existingSession, message.content);
                  // Delivery confirmation via reaction only (no text message — the ✅ reaction is sufficient)
                } catch (injectErr) {
                  console.error(`[slack→session] Injection failed: ${injectErr instanceof Error ? injectErr.message : injectErr}`);
                }
                return;
              }
            }
            console.log(`[slack→session] Session "${existingSession}" died, respawning...`);
          }

          // Check resume map for session continuity
          const resumeInfo = slackAdapter!.getChannelResume(channelId);
          const resumeSessionId = resumeInfo?.uuid ?? undefined;
          if (resumeInfo) {
            slackAdapter!.removeChannelResume(channelId);
          }

          // Route: DMs go to lifeline session, channels spawn new sessions
          const targetSession = isDM ? 'lifeline' : undefined;
          try {
            const newSessionName = await sessionManager.spawnInteractiveSession(
              bootstrapMessage,
              targetSession,
              { resumeSessionId, slackChannelId: channelId },
            );
            if (newSessionName) {
              slackAdapter!.registerChannelSession(channelId, newSessionName);
              slackAdapter!.trackMessageInjection(channelId, newSessionName, message.content);
              console.log(`[slack→session] ${resumeSessionId ? 'Resumed' : 'Spawned'} "${newSessionName}" for channel ${channelId}`);
            }
          } catch (err) {
            console.error(`[slack] Session spawn failed: ${err instanceof Error ? err.message : err}`);
          }
        });

        await slackAdapter.start();
        _slackAdapter = slackAdapter;
        console.log(pc.green(`  Slack connected (workspace: ${(slackConfig.config as Record<string, unknown>).workspaceName || 'unknown'})`));

        // Ensure Slack system channels exist
        ensureSlackAttentionChannel(slackAdapter, state).catch(err => {
          console.error(`[server] Failed to ensure Slack Attention channel: ${err}`);
        });
        ensureSlackUpdatesChannel(slackAdapter, state).catch(err => {
          console.error(`[server] Failed to ensure Slack Updates channel: ${err}`);
        });

        // Wire stall detection — route stall alerts to Slack attention channel
        slackAdapter.onStallDetected = (channelId, sessionName, messageText, injectedAt) => {
          const slackAttentionChannel = state.get<string>('slack-attention-channel');
          if (slackAttentionChannel) {
            slackAdapter!.sendToChannel(slackAttentionChannel,
              `⚠️ Stall detected in session "${sessionName}" (channel ${channelId}). Message may not have been answered: "${messageText.slice(0, 100)}"`
            ).catch(() => {});
          }
          // Also notify in the originating channel
          slackAdapter!.sendToChannel(channelId,
            `⚠️ The session appears to have stalled. Use \`!restart\` to restart or \`!interrupt\` to nudge it.`
          ).catch(() => {});
        };

        // Wire voice transcription (reuses Telegram's provider resolution: Groq → OpenAI)
        slackAdapter.transcribeVoice = async (filePath: string) => {
          const providers: Record<string, { envKey: string; baseUrl: string; model: string }> = {
            groq: { envKey: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
            openai: { envKey: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
          };
          let provider: { apiKey: string; baseUrl: string; model: string } | null = null;
          const explicit = (slackConfig.config as Record<string, unknown>).audioTranscriptionProvider as string;
          if (explicit && providers[explicit.toLowerCase()]) {
            const p = providers[explicit.toLowerCase()];
            const apiKey = process.env[p.envKey];
            if (apiKey) provider = { apiKey, baseUrl: p.baseUrl, model: p.model };
          }
          if (!provider) {
            for (const [, p] of Object.entries(providers)) {
              const apiKey = process.env[p.envKey];
              if (apiKey) { provider = { apiKey, baseUrl: p.baseUrl, model: p.model }; break; }
            }
          }
          if (!provider) throw new Error('No voice transcription provider. Set GROQ_API_KEY or OPENAI_API_KEY.');

          const formData = new FormData();
          const fileBuffer = fs.readFileSync(filePath);
          const blob = new Blob([fileBuffer], { type: 'audio/ogg' });
          formData.append('file', blob, path.basename(filePath));
          formData.append('model', provider.model);

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60_000);
          try {
            const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${provider.apiKey}` },
              body: formData,
              signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Transcription API error (${response.status}): ${await response.text()}`);
            const data = await response.json() as { text: string };
            return data.text;
          } finally {
            clearTimeout(timer);
          }
        };

        // Wire intelligence provider for LLM-gated stall confirmation
        if (sharedIntelligence) {
          slackAdapter.intelligence = sharedIntelligence;
        }

        // Start stall detection timer (with promise tracking)
        const stallTimeout = (slackConfig.config as Record<string, unknown>).stallTimeoutMinutes as number ?? 5;
        const promiseTimeout = (slackConfig.config as Record<string, unknown>).promiseTimeoutMinutes as number ?? 10;
        if (stallTimeout > 0) {
          slackAdapter.startStallDetection(stallTimeout * 60 * 1000, promiseTimeout * 60 * 1000);
        }

        // Wire session management callbacks for slash commands
        slackAdapter.onInterruptSession = async (sessionName) => {
          return sessionManager.sendKey(sessionName, 'Escape');
        };
        slackAdapter.onRestartSession = async (sessionName, channelId) => {
          try {
            const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === sessionName);
            if (stuckSession) {
              sessionManager.killSession(stuckSession.id);
            }
          } catch { /* ok if already dead */ }
        };
        slackAdapter.onListSessions = () => {
          return sessionManager.listRunningSessions().map(s => ({
            name: s.name,
            tmuxSession: s.tmuxSession,
            status: s.status,
            alive: sessionManager.isSessionAlive(s.tmuxSession),
          }));
        };
        slackAdapter.onIsSessionAlive = (tmuxSession) => {
          return sessionManager.isSessionAlive(tmuxSession);
        };

        // Wire prompt response callback — inject button presses into sessions
        slackAdapter.onPromptResponse = (channelId, promptId, value) => {
          // Look up which session is bound to this channel
          const sessionName = slackAdapter!.getSessionForChannel(channelId);
          if (!sessionName) {
            console.warn(`[slack] Prompt response for channel ${channelId} but no session bound`);
            return;
          }
          if (!sessionManager.isSessionAlive(sessionName)) {
            console.warn(`[slack] Prompt response for dead session "${sessionName}"`);
            return;
          }
          sessionManager.sendKey(sessionName, value);
          console.log(`[slack] Prompt response injected: session="${sessionName}" key="${value}"`);
        };

        // Standby commands and triage status will be wired after PresenceProxy/TriageOrchestrator (below)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`  Slack init failed: ${reason}`));
        slackAdapter = undefined;

        degradationReporter.report({
          feature: 'Slack',
          primary: 'Slack messaging adapter',
          fallback: 'Other messaging channels',
          reason: `Slack init failed: ${reason}`,
          impact: 'Slack messaging unavailable.',
        });
      }
    }

    // ── iMessage adapter initialization ────────────────────────────────
    let imessageAdapter: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter | undefined;

    const imessageConfig = config.messaging?.find(m => m.type === 'imessage' && m.enabled);
    if (imessageConfig) {
      try {
        const { IMessageAdapter } = await import('../messaging/imessage/index.js');
        imessageAdapter = new IMessageAdapter(imessageConfig.config as Record<string, unknown>, config.stateDir);

        // Wire session routing (following Telegram/WhatsApp pattern)
        wireIMessageRouting(imessageAdapter, sessionManager);

        // Set agent name for mention-based triggering
        const imAgentName = (imessageConfig.config as any)?.agentName || config.projectName;
        if (imAgentName) imessageAdapter.setAgentName(imAgentName);

        await imessageAdapter.start();
        const triggerInfo = imessageAdapter.getTriggerMode() === 'mention'
          ? `trigger: @${imAgentName}`
          : 'trigger: all messages';
        console.log(pc.green(`  iMessage adapter: connected (${triggerInfo})`));
        console.log(pc.green('  iMessage message routing: wired'));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`  iMessage init failed: ${reason}`));
        imessageAdapter = undefined;

        degradationReporter.report({
          feature: 'iMessage',
          primary: 'iMessage messaging adapter',
          fallback: 'Other messaging channels',
          reason: `iMessage init failed: ${reason}`,
          impact: 'iMessage messaging unavailable.',
        });
      }
    }

    // Wire the topic-binding checker for the zombie-killer. Topic-bound sessions
    // (live Telegram topic, Slack channel, iMessage thread) are *waiting* for the
    // user; "idle at prompt" is healthy. Without this exemption, the killer cuts
    // sessions at 15m of idle and the user's next message has to navigate a
    // respawn-with-resume — which sometimes crashes — instead of going straight
    // to a live agent.
    sessionManager.setTopicBindingChecker((tmuxSession: string): string | number | null => {
      if (telegram) {
        const topicId = telegram.getTopicForSession(tmuxSession);
        if (topicId != null) return topicId;
      }
      if (_slackAdapter) {
        const channelId = _slackAdapter.getChannelForSession(tmuxSession);
        if (channelId != null) return channelId;
      }
      if (imessageAdapter) {
        const sender = imessageAdapter.getSenderForSession(tmuxSession);
        if (sender != null) return sender;
      }
      return null;
    });

    // Initialize SemanticMemory — the knowledge graph that unifies all memory systems.
    // Uses the same better-sqlite3 as TopicMemory; shares the rebuild path.
    let semanticMemory: SemanticMemory | undefined;
    try {
      semanticMemory = new SemanticMemory({
        dbPath: path.join(config.stateDir, 'semantic.db'),
        decayHalfLifeDays: 30,
        lessonDecayHalfLifeDays: 90,
        staleThreshold: 0.2,
      });
      await semanticMemory.open();
      const smStats = semanticMemory.stats();
      console.log(pc.green(`  SemanticMemory: ${smStats.totalEntities} entities, ${smStats.totalEdges} edges`));

      // Phase 5: Hybrid Search — attach EmbeddingProvider for vector-enhanced search.
      // Loads all-MiniLM-L6-v2 (~80MB ONNX model, cached after first download) and
      // sqlite-vec extension for KNN queries alongside FTS5.
      // Graceful degradation: if either fails, SemanticMemory continues FTS5-only.
      try {
        const { EmbeddingProvider } = await import('../memory/EmbeddingProvider.js');
        const embeddingProvider = new EmbeddingProvider();
        const vecModuleLoaded = await embeddingProvider.loadVecModule();
        if (vecModuleLoaded) {
          semanticMemory.setEmbeddingProvider(embeddingProvider);
          const vecReady = await semanticMemory.initializeVectorSearch();
          if (vecReady) {
            // Initialize model in background — don't block server startup
            embeddingProvider.initialize().then(() => {
              const updatedStats = semanticMemory!.stats();
              console.log(pc.green(`  Vector search: ready (${updatedStats.embeddingCount ?? 0}/${updatedStats.totalEntities} embeddings)`));
            }).catch((modelErr) => { // @silent-fallback-ok: embedding model load is non-blocking, FTS5-only degradation logged
              console.log(pc.yellow(`  Vector search: model load failed (${modelErr instanceof Error ? modelErr.message : String(modelErr)}). FTS5-only mode.`));
            });
          } else {
            console.log(pc.yellow('  Vector search: sqlite-vec extension failed to initialize. FTS5-only mode.'));
          }
        } else {
          console.log(pc.yellow('  Vector search: sqlite-vec not available. FTS5-only mode.'));
        }
      } catch (vecErr) { // @silent-fallback-ok: vector search is optional enhancement, FTS5-only degradation logged
        console.log(pc.yellow(`  Vector search: ${vecErr instanceof Error ? vecErr.message : String(vecErr)}. FTS5-only mode.`));
      }
    } catch (err) {
      let reason = err instanceof Error ? err.message : String(err);
      semanticMemory = undefined;
      // Add actionable guidance for disk I/O errors (SQLITE_IOERR) — disk full or failing
      if (reason.toLowerCase().includes('disk i/o') || reason.includes('SQLITE_IOERR')) {
        reason += '. Likely cause: disk full or filesystem error. Diagnose: run `df -h` to check disk usage and free space if needed. Semantic.db path: ' + path.join(config.stateDir, 'semantic.db');
      }
      DegradationReporter.getInstance().report({
        feature: 'SemanticMemory',
        primary: 'SQLite-backed knowledge graph with FTS5 + vector hybrid search',
        fallback: 'Legacy memory systems (MEMORY.md, CanonicalState, MemoryIndex)',
        reason: `SemanticMemory init failed: ${reason}`,
        impact: 'Knowledge graph unavailable. Migration, semantic search, and entity-relationship queries disabled.',
      });
    }

    // Pre-prompt memory recall (OpenClaw import T2.2). Bounded synchronous
    // recall pass that runs before UserPromptSubmit injects context. Default
    // off; opt in via config.promptBuildRecall.enabled.
    const promptRecallCfg = (config as unknown as {
      promptBuildRecall?: Partial<import('../core/PromptBuildRecall.js').PromptBuildRecallConfig>;
    }).promptBuildRecall;
    if (promptRecallCfg?.enabled && semanticMemory) {
      const { PromptBuildRecall, DEFAULT_PROMPT_BUILD_RECALL_CONFIG } = await import('../core/PromptBuildRecall.js');
      const recall = new PromptBuildRecall(
        { semanticMemory },
        { ...DEFAULT_PROMPT_BUILD_RECALL_CONFIG, ...promptRecallCfg },
      );
      (globalThis as Record<string, unknown>).__instarPromptBuildRecall = recall;
      console.log(pc.green('  Pre-prompt memory recall enabled'));
    }

    // WorkingMemoryAssembler is initialized after activitySentinel (see below)
    // so it can wire episodicMemory from the sentinel.
    let workingMemory: WorkingMemoryAssembler | undefined;

    // ── Reap observability + notify (UNIFIED-SESSION-LIFECYCLE §P3/§P4) ──
    // Wired BEFORE the boot purge so even boot-time reaps land in the reap-log
    // and surface a notice. The awake-checker is also wired here so the boot
    // purge is lease-gated (a standby never reaps another machine's sessions).
    // (The KEEP-guard is wired later, once its tracker deps exist — that is safe:
    //  the boot purge passes knownDead and bypasses the guard, and the only other
    //  guard consumers (monitorTick #2 age-limit / #3 idle-zombie) cannot fire a
    //  kill in the first monitoring seconds — they require multi-hour age or 15+m
    //  of observed idle — long after the guard is set below.)
    const { ReapLog } = await import('../monitoring/ReapLog.js');
    const { ReapNotifier } = await import('../monitoring/ReapNotifier.js');
    const reapLog = new ReapLog(
      config.stateDir,
      () => (coordinator.enabled ? coordinator.identity?.machineId : undefined),
    );
    const reapNotifier = new ReapNotifier(
      {
        resolveTopic: (tmuxSession) => {
          const t = telegram?.getTopicForSession(tmuxSession);
          if (t == null) return null;
          const n = typeof t === 'number' ? t : Number(t);
          return Number.isFinite(n) ? n : null;
        },
        lifelineTopic: () => telegram?.getLifelineTopicId() ?? null,
        // SUMMARY tier → through the formatter/tone-gate (HTML-escaped, quiet-hours
        // aware). The notifier already coalesces, so a burst is one message.
        send: (topicId, text) => notify('SUMMARY', 'session-reap', text, topicId),
      },
      {
        enabled: config.monitoring?.reapNotify?.enabled ?? true,
        coalesceWindowMs: config.monitoring?.reapNotify?.coalesceWindowMs ?? 60_000,
      },
    );
    sessionManager.setAwakeChecker(() => !coordinator.enabled || coordinator.isAwake);
    sessionManager.on('sessionReaped', (e: { session: import('../core/types.js').Session; reason: string; disposition?: 'terminal' | 'recovery-bounce'; origin?: 'operator' | 'autonomous' }) => {
      reapLog.recordReaped({
        session: e.session.name,
        tmuxSession: e.session.tmuxSession,
        reason: e.reason,
        disposition: e.disposition,
        origin: e.origin,
      });
      reapNotifier.onReaped({ session: e.session, reason: e.reason, disposition: e.disposition, origin: e.origin });
    });
    sessionManager.on('reapBlocked', (e: { session: import('../core/types.js').Session; reason: string; skipped: string; origin?: 'operator' | 'autonomous' }) => {
      reapLog.recordSkipped({
        session: e.session.name,
        tmuxSession: e.session.tmuxSession,
        reason: e.reason,
        skipped: e.skipped,
        origin: e.origin,
      });
    });

    // Fast startup purge — remove session records for dead tmux sessions BEFORE
    // monitoring starts. Prevents the death spiral where stale sessions overwhelm
    // the health endpoint (synchronous tmux has-session calls) and cause the
    // lifeline to restart the server in a tight loop.
    await sessionManager.purgeDeadSessions();

    sessionManager.startMonitoring();

    // StuckInputSentinel — persistent, restart-safe recovery for tmux prompts
    // that hold text but never submitted Enter. Complements the in-process
    // verifyInjection timers (PR #159) which die when the server crashes.
    //
    // Codex session-wedge self-recovery (dark by default): when enabled, the
    // sentinel escalates PAST the keypress ladder by requesting a tier-C recovery
    // (server restart + replay) via SessionRecoveryChannel — executed by the
    // lifeline-process consumer (SessionRecoveryConsumer). See
    // docs/specs/CODEX-SESSION-WEDGE-SELF-RECOVERY.md.
    const codexWedgeCfg = config.monitoring?.codexWedgeRecovery;
    const stuckInputSentinel = new StuckInputSentinel(sessionManager, {
      stateDir: config.stateDir,
      recoveryChannel: new SessionRecoveryChannel(config.stateDir),
      escalationEnabled: codexWedgeCfg?.enabled ?? false,
      escalationTimeoutTicks: codexWedgeCfg?.escalationTimeoutTicks,
    });
    stuckInputSentinel.start();

    // Proactive resume heartbeat: every 60s, update the topic→UUID mapping
    // for all active topic-linked sessions. Ensures crash recovery via --resume.
    if (_topicResumeMap && (telegram || _slackAdapter)) {
      const resumeHeartbeatInterval = setInterval(() => {
        try {
          const enriched = new Map<number, { sessionName: string; claudeSessionId?: string }>();

          // Telegram topic-session mappings
          if (telegram) {
            const topicSessions = telegram.getAllTopicSessions();
            for (const [topicId, sessionName] of topicSessions) {
              const sessions = sessionManager.listRunningSessions();
              const session = sessions.find(s => s.tmuxSession === sessionName);
              enriched.set(topicId, {
                sessionName,
                claudeSessionId: session?.claudeSessionId ?? undefined,
              });
            }
          }

          // Slack channel-session mappings (use synthetic IDs for compatibility)
          if (_slackAdapter) {
            const registry = _slackAdapter.getChannelRegistry();
            const runningSessions = sessionManager.listRunningSessions();
            for (const [channelId, entry] of Object.entries(registry)) {
              const syntheticId = slackChannelToSyntheticId(channelId);
              const session = runningSessions.find(s => s.tmuxSession === entry.sessionName);
              enriched.set(syntheticId, {
                sessionName: entry.sessionName,
                claudeSessionId: session?.claudeSessionId ?? undefined,
              });

              // Also save to the Slack-specific resume map so that
              // getChannelResume() finds the UUID on next message.
              // refreshResumeMappings only writes to topic-resume-map.json
              // (keyed by synthetic numeric ID), but Slack message handling
              // reads from slack-channel-resume-map.json (keyed by channel ID).
              // ONLY use authoritative claudeSessionId — never mtime fallback,
              // which can cross-contaminate when multiple sessions are active.
              if (session?.claudeSessionId && _topicResumeMap!.jsonlExistsPublic(session.claudeSessionId)) {
                _slackAdapter.saveChannelResume(channelId, session.claudeSessionId, entry.sessionName);
              }
            }
          }

          _topicResumeMap?.refreshResumeMappings(enriched);
        } catch (err) {
          console.error('[server] Resume heartbeat error:', err);
        }
      }, 60_000);
      // Don't prevent process exit
      resumeHeartbeatInterval.unref();
      console.log(pc.green('  Resume heartbeat: active (60s interval)'));
    }

    // Save Claude session UUID before any session kill so the topic can be
    // resumed later with --resume. This fires BEFORE the tmux session is
    // destroyed, so the UUID can still be discovered from the JSONL mtime.
    if (_topicResumeMap) {
      sessionManager.on('beforeSessionKill', (session: import('../core/types.js').Session) => {
        try {
          // Save Telegram topic resume UUID (if Telegram is configured)
          // Skip for context exhaustion kills — re-saving would cause a death loop
          if (telegram && !contextExhaustionKills.has(session.tmuxSession)) {
            const topicId = telegram!.getTopicForSession(session.tmuxSession);
            if (topicId) {
              const uuid = _topicResumeMap!.findUuidForSession(session.tmuxSession, session.claudeSessionId ?? undefined);
              if (uuid) {
                _topicResumeMap!.save(topicId, uuid, session.tmuxSession);
                console.log(`[beforeSessionKill] Saved resume UUID ${uuid} for topic ${topicId} (session: ${session.name}, source: ${session.claudeSessionId ? 'hook' : 'mtime'})`);
              }
            }
          }

          // Save Slack channel resume UUID (if Slack is configured)
          // Skip if the session is being killed for context exhaustion — saving the UUID
          // would cause a death loop where the next respawn loads the same bloated conversation.
          if (_slackAdapter && !contextExhaustionKills.has(session.tmuxSession)) {
            const channelId = _slackAdapter.getChannelForSession(session.tmuxSession);
            if (channelId) {
              const uuid = _topicResumeMap!.findUuidForSession(session.tmuxSession, session.claudeSessionId ?? undefined);
              if (uuid) {
                _slackAdapter.saveChannelResume(channelId, uuid, session.tmuxSession);
                console.log(`[beforeSessionKill] Saved Slack resume UUID ${uuid} for channel ${channelId} (session: ${session.name})`);
              }
            }
          } else if (contextExhaustionKills.has(session.tmuxSession)) {
            console.log(`[beforeSessionKill] Skipping Slack resume UUID save for ${session.name} — context exhaustion recovery`);
          }
        } catch (err) {
          console.error(`[beforeSessionKill] Failed to save resume UUID:`, err);
        }
      });

      // Auto-respawn sessions that die with unanswered Telegram injections.
      // When a session crashes or is cleaned up before replying, re-forward the
      // user's message so it gets a fresh session and a response.
      // Clear the bad resume UUID when --resume crashes during startup.
      // SessionManager handles the fresh-spawn fallback itself; we only need to
      // make sure the next user message doesn't try the same broken UUID.
      //
      // UUID-equality gate: only clear when the currently-stored UUID matches
      // the failed one. The fresh-spawn fallback may save a *new* UUID via the
      // proactive-save heartbeat between this event firing and the listener
      // running. Clearing without checking would wipe the new, valid UUID and
      // force a fresh spawn on every subsequent message.
      sessionManager.on('resumeFailed', (info: { tmuxSession: string; resumeSessionId: string; telegramTopicId?: number; slackChannelId?: string }) => {
        if (info.telegramTopicId != null && _topicResumeMap) {
          try {
            const stored = _topicResumeMap.get(info.telegramTopicId);
            if (stored === info.resumeSessionId) {
              _topicResumeMap.remove(info.telegramTopicId);
              console.log(`[resumeFailed] Cleared bad resume UUID for topic ${info.telegramTopicId} (tmux: "${info.tmuxSession}", uuid: ${info.resumeSessionId})`);
            } else {
              console.log(`[resumeFailed] Skipping UUID clear for topic ${info.telegramTopicId} — stored UUID (${stored ?? 'none'}) no longer matches failed UUID (${info.resumeSessionId}); fresh spawn likely already saved a new one.`);
            }
          } catch (err) {
            console.error(`[resumeFailed] Failed to clear resume UUID for topic ${info.telegramTopicId}:`, err);
          }
        }
      });

      sessionManager.on('injectionDropped', (info: { topicId: number; sessionName: string; text: string; injectedAt: number }) => {
        const elapsed = Date.now() - info.injectedAt;
        // Only respawn if the injection is recent (< 10 minutes old).
        // Stale injections may have been superseded by newer messages.
        if (elapsed > 10 * 60_000) {
          console.log(`[injectionDropped] Skipping respawn for topic ${info.topicId} — injection is ${Math.round(elapsed / 60_000)}m old`);
          return;
        }
        console.log(`[injectionDropped] Session "${info.sessionName}" died with unanswered message for topic ${info.topicId}. Triggering respawn.`);
        // Re-trigger the telegram-forward endpoint internally using fetch
        fetch(`http://localhost:${config.port}/internal/telegram-forward`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.authToken}`,
          },
          body: JSON.stringify({ topicId: info.topicId, text: info.text, fromFirstName: 'User' }),
        }).then(async (res) => {
          if (res.ok) {
            console.log(`[injectionDropped] Respawn successful for topic ${info.topicId}`);
          } else {
            const body = await res.text().catch(() => '');
            console.error(`[injectionDropped] Respawn failed (${res.status}): ${body}`);
          }
        }).catch((err: Error) => {
          console.error(`[injectionDropped] Respawn request failed:`, err.message);
        });
      });
    }

    sessionManager.on('injectionReplyDetected', (info: { topicId: number; sessionName: string; text: string; injectedAt: number }) => {
      if (!telegram) return;
      console.log(`[injectionReplyDetected] Surfacing Gemini final pane reply from "${info.sessionName}" to topic ${info.topicId}`);
      telegram.sendToTopic(info.topicId, info.text).catch((err: Error) => {
        console.error(`[injectionReplyDetected] Failed to send reply for topic ${info.topicId}:`, err.message);
      });
    });

    if (scheduler) {
      sessionManager.on('sessionComplete', (session) => {
        scheduler!.processQueue();
        scheduler!.notifyJobComplete(session.id, session.tmuxSession);
        // Record telemetry events
        if (telemetryHeartbeat && session.jobSlug) {
          telemetryHeartbeat.recordJobRun();
        }
      });
    }

    // Wire telemetry counters
    if (telemetryHeartbeat) {
      sessionManager.on('sessionStart', () => {
        telemetryHeartbeat!.recordSessionSpawned();
      });
    }

    // Auto-summarize topics on session completion.
    // When a Telegram-linked session ends, check if its topic needs a summary update.
    // Uses Haiku for cost efficiency — summaries don't need deep reasoning.
    if (topicMemory && telegram) {
      const { TopicSummarizer } = await import('../memory/TopicSummarizer.js');
      // Reuse the framework-aware sharedIntelligence so Codex installs
      // get Codex-summarized topics. Last-ditch ClaudeCli fallback
      // preserves v0.x behavior when sharedIntelligence couldn't be
      // built but a claude binary is still on disk.
      let summaryIntelligence: IntelligenceProvider | null = null;
      if (sharedIntelligence) {
        summaryIntelligence = sharedIntelligence;
      } else if (!isClaudeForbidden()) {
        const { ClaudeCliIntelligenceProvider } = await import('../core/ClaudeCliIntelligenceProvider.js');
        summaryIntelligence = wrapIntelligenceWithCircuitBreaker(
          new ClaudeCliIntelligenceProvider(config.sessions.claudePath),
        );
      }
      // On a codex-only agent without a built Codex provider, summaryIntelligence
      // stays null — topic summaries are skipped rather than run on Claude.
      if (summaryIntelligence) {
      const summarizer = new TopicSummarizer(summaryIntelligence, topicMemory);

      sessionManager.on('sessionComplete', (session) => {
        // Find the topic linked to this session
        const sessionTopicId = telegram!.getTopicForSession(session.tmuxSession);
        if (!sessionTopicId) return;

        // Check if this topic needs a summary update (async, fire-and-forget)
        summarizer.summarize(sessionTopicId).then((result) => {
          if (result) {
            console.log(`[TopicSummarizer] Updated summary for topic ${sessionTopicId}: ${result.messagesProcessed} messages processed in ${result.durationMs}ms`);
          }
        }).catch((err) => {
          console.error(`[TopicSummarizer] Failed for topic ${sessionTopicId}: ${err instanceof Error ? err.message : err}`);
        });
      });
      console.log(pc.green('  Topic auto-summarization enabled (on session end)'));
      } else {
        console.log(pc.dim('  Topic auto-summarization skipped (no LLM provider; codex-only without Codex provider)'));
      }
    }

    // Session Activity Sentinel — episodic memory digestion.
    // Creates mid-session mini-digests via LLM, and session syntheses on completion.
    let activitySentinel: import('../monitoring/SessionActivitySentinel.js').SessionActivitySentinel | undefined;
    if (sharedIntelligence) {
      const { SessionActivitySentinel, resolveSentinelScanIntervalMs } = await import('../monitoring/SessionActivitySentinel.js');
      activitySentinel = new SessionActivitySentinel({
        stateDir: config.stateDir,
        intelligence: sharedIntelligence,
        getActiveSessions: () => sessionManager.listRunningSessions(),
        captureSessionOutput: (tmuxSession) => sessionManager.captureOutput(tmuxSession),
        getTelegramMessages: telegram
          ? (topicId, since) => telegram!.searchLog({
              topicId,
              since: since ? new Date(since) : undefined,
              limit: 200,
            })
          : undefined,
        getTopicForSession: telegram
          ? (tmuxSession) => telegram!.getTopicForSession(tmuxSession)
          : undefined,
        // When SemanticMemory is available, the sentinel materializes
        // entities + relationships extracted by the digest LLM call into
        // the knowledge graph. Without this wire, digests still persist
        // with `entities: []` — graceful degradation.
        semanticMemory: semanticMemory ?? undefined,
      });

      sessionManager.on('sessionComplete', (session) => {
        activitySentinel!.synthesizeSession(session).then((report) => {
          if (report.synthesisCreated) {
            console.log(`[ActivitySentinel] Session synthesis created for ${session.name}: ${report.digestCount} digests`);
          }
        }).catch((err) => {
          console.error(`[ActivitySentinel] Synthesis failed for ${session.name}: ${err instanceof Error ? err.message : err}`);
        });
      });

      // Periodic mid-session scan. Without this, the sentinel only digests on
      // sessionComplete — so a long-running Telegram session that never cleanly
      // ends (compaction, multi-day topic, machine restart) accumulates hours
      // of activity that is never digested, and the entities within it never
      // reach SemanticMemory. The periodic scan digests in-flight activity on a
      // cadence so the knowledge graph grows throughout long sessions, not just
      // at the end. scan() is internally idempotent (hash-keyed digests),
      // skips dormant sessions, and enforces a minimum-activity threshold, so a
      // frequent cadence is safe.
      const scanIntervalMs = resolveSentinelScanIntervalMs(config.monitoring.episodicSentinel);
      if (scanIntervalMs !== null) {
        const scanMinutes = Math.round(scanIntervalMs / 60_000);
        const activityScanTimer = setInterval(() => {
          // Only the awake machine scans — mirrors the scheduler gating so
          // standby machines in a multi-machine setup don't double-digest.
          if (coordinator.enabled && !coordinator.isAwake) return;
          activitySentinel!.scan().then((report) => {
            if (report.digestsCreated > 0) {
              console.log(`[ActivitySentinel] Periodic scan: ${report.digestsCreated} digest(s) across ${report.sessionsScanned} session(s)`);
            }
          }).catch((err) => {
            console.error(`[ActivitySentinel] Periodic scan failed: ${err instanceof Error ? err.message : err}`);
          });
        }, scanIntervalMs);
        if (activityScanTimer.unref) activityScanTimer.unref();
        console.log(pc.dim(`  Episodic memory sentinel: periodic scan every ${scanMinutes}min`));
      }

      const semStatus = semanticMemory ? 'with entity extraction' : 'digests only (no SemanticMemory)';
      console.log(pc.green(`  Episodic memory sentinel enabled (LLM-powered digestion, ${semStatus})`));
    }

    // Initialize WorkingMemoryAssembler — token-budgeted context assembly for session-start hooks.
    // Placed after activitySentinel so episodicMemory can be wired from the sentinel.
    // Skipped in minimal-config setups where neither memory system is available.
    if (semanticMemory || activitySentinel || topicIntentStore) {
      workingMemory = new WorkingMemoryAssembler({
        semanticMemory,
        episodicMemory: activitySentinel?.getEpisodicMemory(),
        // rung 2 — unified read path: topic-intent refs + Playbook manifest items
        // join the assembled working set (both read-only, degrade-safe).
        topicIntentStore,
        stateDir: config.stateDir,
      });
      const epStatus = activitySentinel ? 'yes' : 'no';
      console.log(pc.green(`  WorkingMemoryAssembler: ready (semantic: ${semanticMemory ? 'yes' : 'no'}, episodic: ${epStatus}, topic-intent: ${topicIntentStore ? 'yes' : 'no'})`));
    }

    // Session Watchdog — auto-remediation for stuck commands
    let watchdog: SessionWatchdog | undefined;
    if (config.monitoring.watchdog?.enabled) {
      watchdog = new SessionWatchdog(config, sessionManager, state);
      watchdog.intelligence = sharedIntelligence ?? null;

      watchdog.on('intervention', (event: any) => {
        // Routine recovery (Ctrl+C, SIGTERM) stays as console diagnostics only.
        // The user only hears when we had to force-kill (SIGKILL / session-kill) —
        // that's the "actual issue" threshold. See watchdog-notifications.ts.
        const userMsg = formatWatchdogUserMessage(event);
        if (!userMsg) return;

        if (telegram) {
          const topicId = telegram.getTopicForSession(event.sessionName);
          if (topicId) telegram.sendToTopic(topicId, userMsg).catch(() => {});
        }
        if (_slackAdapter) {
          const channelId = _slackAdapter.getChannelForSession(event.sessionName);
          if (channelId) _slackAdapter.sendToChannel(channelId, userMsg).catch(() => {});
        }
      });

      // Recovery events stay silent to the user. If we didn't announce the
      // problem (Ctrl+C / SIGTERM are now silent), announcing recovery is
      // noise. Intervention log still records it for diagnostics.

      watchdog.start();
      console.log(pc.green('  Session Watchdog enabled'));
    }

    // StallTriageNurse — LLM-powered session recovery (uses shared intelligence)
    // Platform-aware: works with Telegram topics AND Slack channels
    let triageNurse: StallTriageNurse | undefined;
    if (config.monitoring.triage?.enabled && (telegram || _slackAdapter)) {
      triageNurse = new StallTriageNurse(
        {
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          sendKey: (name, key) => sessionManager.sendKey(name, key),
          sendInput: (name, text) => sessionManager.sendInput(name, text),
          getTopicHistory: (topicId, limit) => {
            // Check if this is a Slack synthetic ID
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              const msgs = _slackAdapter.getChannelMessages(slackChId, limit);
              return msgs.map(m => ({ text: m.text, fromUser: true, timestamp: new Date(parseFloat(m.ts) * 1000).toISOString() }));
            }
            if (telegram) {
              const entries = telegram.getTopicHistory(topicId, limit);
              return entries.map(e => ({ text: e.text, fromUser: e.fromUser, timestamp: e.timestamp }));
            }
            return [];
          },
          sendToTopic: async (topicId, text) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              // Never send monitoring messages to system channels (dashboard, lifeline)
              if (_slackAdapter.isSystemChannel(slackChId)) return;
              await _slackAdapter.sendToChannel(slackChId, text);
              return;
            }
            if (telegram) await telegram.sendToTopic(topicId, text);
          },
          respawnSession: (name, topicId, options) => {
            if (telegram) {
              return respawnSessionForTopic(sessionManager, telegram, name, topicId, undefined, topicMemory, undefined, undefined, options);
            }
            // Slack respawn: kill and let next message trigger fresh session
            const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === name);
            if (stuckSession) sessionManager.killSession(stuckSession.id);
            return Promise.resolve();
          },
          clearStallForTopic: (topicId) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              _slackAdapter.clearStallTracking(slackChId);
              return;
            }
            if (telegram) telegram.clearStallTracking(topicId);
          },
        },
        {
          config: { ...config.monitoring.triage, framework: resolvedFramework },
          state,
          intelligence: sharedIntelligence,
        },
      );

      // Wire nurse into stall detection — both Telegram and Slack
      // Note: presenceProxy may be set later — use late-binding check
      const stallTriageHandler = async (topicId: number, sessionName: string, messageText: string, injectedAt: number) => {
        // If PresenceProxy Tier 3 is actively handling this topic, defer to it
        if (presenceProxy) {
          const proxyState = presenceProxy.getState(topicId);
          if (proxyState && proxyState.tier3FiredAt && !proxyState.cancelled) {
            const tier3Age = Date.now() - proxyState.tier3FiredAt;
            if (tier3Age < 60_000) {
              console.log(`[StallTriageNurse] Deferring — PresenceProxy Tier 3 active for topic ${topicId}`);
              return { resolved: false };
            }
          }
        }
        const result = await triageNurse!.triage(topicId, sessionName, messageText, injectedAt, 'telegram_stall');
        return { resolved: result.resolved };
      };

      if (telegram) {
        telegram.onStallDetected = stallTriageHandler;
      }

      console.log(pc.green('  Stall Triage Nurse enabled'));
    }

    // TriageOrchestrator — next-gen session recovery with scoped Claude Code sessions
    // Platform-aware: works with Telegram topics AND Slack channels
    let triageOrchestrator: TriageOrchestrator | undefined;
    if (config.monitoring.triageOrchestrator?.enabled && (telegram || _slackAdapter)) {
      triageOrchestrator = new TriageOrchestrator(
        {
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          sendKey: (name, key) => sessionManager.sendKey(name, key),
          sendInput: (name, text) => sessionManager.sendInput(name, text),
          getTopicHistory: (topicId, limit) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              const msgs = _slackAdapter.getChannelMessages(slackChId, limit);
              return msgs.map(m => ({ text: m.text, fromUser: true, timestamp: new Date(parseFloat(m.ts) * 1000).toISOString() }));
            }
            if (telegram) {
              const entries = telegram.getTopicHistory(topicId, limit);
              return entries.map(e => ({ text: e.text, fromUser: e.fromUser, timestamp: e.timestamp }));
            }
            return [];
          },
          sendToTopic: async (topicId, text) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              if (_slackAdapter.isSystemChannel(slackChId)) return;
              await _slackAdapter.sendToChannel(slackChId, text);
              return;
            }
            if (telegram) await telegram.sendToTopic(topicId, text);
          },
          respawnSession: (name, topicId, options) => {
            if (telegram) return respawnSessionForTopic(sessionManager, telegram, name, topicId, undefined, topicMemory, undefined, undefined, options);
            const stuckSession = sessionManager.listRunningSessions().find(s => s.tmuxSession === name);
            if (stuckSession) sessionManager.killSession(stuckSession.id);
            return Promise.resolve();
          },
          clearStallForTopic: (topicId) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) { _slackAdapter.clearStallTracking(slackChId); return; }
            if (telegram) telegram.clearStallTracking(topicId);
          },
          spawnTriageSession: (name, options) => sessionManager.spawnTriageSession(name, options),
          getTriageSessionUuid: (sessionName) => {
            return _topicResumeMap?.findUuidForSession(sessionName) ?? undefined;
          },
          killTriageSession: (name) => {
            try {
              const tmux = detectTmuxPath() || 'tmux';
              execFileSync(tmux, ['kill-session', '-t', `=${name}`], { encoding: 'utf-8' });
            } catch { /* best-effort — session may already be dead */ }
          },
          scheduleFollowUpJob: (slug, delayMs, callback) => {
            const jobId = `${slug}-${Date.now()}`;
            const timer = setTimeout(callback, delayMs);
            (triageOrchestrator as any).__timers = (triageOrchestrator as any).__timers || new Map();
            (triageOrchestrator as any).__timers.set(jobId, timer);
            return jobId;
          },
          cancelJob: (jobId) => {
            const timers = (triageOrchestrator as any).__timers as Map<string, NodeJS.Timeout> | undefined;
            if (timers?.has(jobId)) {
              clearTimeout(timers.get(jobId)!);
              timers.delete(jobId);
            }
          },
          injectMessage: (name, text) => sessionManager.sendInput(name, text),
          captureTriageOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isTriageSessionAlive: (name) => sessionManager.tmuxSessionExists(name),
          projectDir: config.projectDir,
        },
        {
          config: {
            cooldownMs: config.monitoring.triageOrchestrator.cooldownMs,
            maxConcurrentTriages: config.monitoring.triageOrchestrator.maxConcurrentTriages,
            autoActionEnabled: config.monitoring.triageOrchestrator.autoActionEnabled,
            maxAutoActionsPerHour: config.monitoring.triageOrchestrator.maxAutoActionsPerHour,
            defaultModel: config.monitoring.triageOrchestrator.defaultModel,
          },
          state,
        },
      );

      // TriageOrchestrator takes over stall detection from StallTriageNurse
      const triageStallHandler = async (topicId: number, sessionName: string, messageText: string, injectedAt: number) => {
        const result = await triageOrchestrator!.activate(topicId, sessionName, 'stall_detector', messageText, injectedAt);
        return { resolved: result.resolved };
      };

      if (telegram) {
        telegram.onStallDetected = triageStallHandler;

        // Cancel triage when stall tracking clears (session responded)
        const origClearStall = telegram.clearStallTracking.bind(telegram);
        telegram.clearStallTracking = (topicId: number) => {
          origClearStall(topicId);
          triageOrchestrator!.onTargetSessionResponded(topicId);
        };

        // Wire /triage command
        telegram.onGetTriageStatus = (topicId) => {
          const ts = triageOrchestrator!.getTriageState(topicId);
          if (!ts) return null;
          return {
            active: true,
            classification: ts.classification,
            checkCount: ts.checkCount,
            lastCheck: new Date(ts.lastCheckAt).toISOString(),
          };
        };
      }

      console.log(pc.green('  Triage Orchestrator enabled (replaces Stall Triage Nurse for stall detection)'));
    }

    // SessionRecovery — fast mechanical recovery (JSONL analysis, no LLM)
    // Platform-aware: works with Telegram topics AND Slack channels
    let sessionRecovery: SessionRecovery | undefined;
    // Track sessions being killed for context exhaustion — prevents beforeSessionKill
    // from re-saving resume UUIDs (which would cause an infinite death loop)
    const contextExhaustionKills = new Set<string>();
    if (telegram || _slackAdapter) {
      sessionRecovery = new SessionRecovery(
        { enabled: true, projectDir: config.projectDir },
        {
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          getPanePid: (name) => {
            try {
              const tmux = detectTmuxPath();
              if (!tmux) return null;
              const pid = execFileSync(tmux, ['list-panes', '-t', `=${name}:`, '-F', '#{pane_pid}'], { encoding: 'utf-8', timeout: 5000 }).trim();
              return /^\d+$/.test(pid) ? parseInt(pid, 10) : null;
            } catch { return null; }
          },
          // UNIFIED-SESSION-LIFECYCLE §P0 #8: route the kill-to-respawn through
          // the ReapAuthority with disposition:'recovery-bounce' (silent §P3
          // notifier — a bounce is not a disappearance) and bypassRecoveryFlag
          // (the recovery's own in-flight flag would otherwise refuse its own
          // kill via the KEEP-guard).
          killSession: async (name) => {
            const session = sessionManager.listRunningSessions().find((s) => s.tmuxSession === name);
            if (session) {
              await sessionManager.terminateSession(session.id, 'session-recovery', {
                disposition: 'recovery-bounce',
                finalStatus: 'killed',
                bypassRecoveryFlag: true,
              });
              return;
            }
            // Fallback: direct tmux kill for untracked sessions
            try {
              const tmux = detectTmuxPath();
              if (!tmux) return;
              execFileSync(tmux, ['kill-session', '-t', `=${name}`], { encoding: 'utf-8' });
            } catch { /* may already be dead */ }
          },
          // P1/P2 cross-check dep — see SessionRecovery.killForRecovery().
          hasActiveProcesses: (name) => sessionManager.hasActiveProcesses(name),
          respawnSession: async (topicId, _sessionName, recoveryPrompt) => {
            // Check Slack first (synthetic IDs are negative)
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              // Slack respawn: kill existing, next message triggers fresh session
              const session = sessionManager.listRunningSessions().find(s => s.tmuxSession === _sessionName);
              if (session) sessionManager.killSession(session.id);
              return;
            }
            if (telegram) {
              const targetSession = telegram.getSessionForTopic(topicId);
              if (!targetSession) return;
              await respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, undefined, topicMemory, undefined, recoveryPrompt, { silent: true });
            }
          },
          sendToTopic: async (topicId, message) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) { await _slackAdapter.sendToChannel(slackChId, message); return; }
            if (telegram) await telegram.sendToTopic(topicId, message);
          },
          captureSessionOutput: (name, lines) => {
            return sessionManager.captureOutput(name, lines);
          },
          getRecentTopicMessages: (topicId, limit) => {
            // Used by context-exhaustion recovery to capture any in-flight agent
            // reply that lands after the session is killed, so the fresh session
            // can avoid duplicating it. TopicMemory is the authoritative source
            // once the adapter has written the reply to the store.
            if (!topicMemory || !topicMemory.isReady()) return [];
            try {
              return topicMemory.getRecentMessages(topicId, limit).map(m => ({
                text: m.text,
                fromUser: m.fromUser,
                timestamp: m.timestamp,
              }));
            } catch {
              return [];
            }
          },
          respawnSessionFresh: async (topicId, _sessionName, recoveryPrompt) => {
            // Fresh respawn for context exhaustion — explicitly clear resume UUID
            // so the new session starts clean with history, not --resume.
            if (_topicResumeMap) {
              _topicResumeMap.remove(topicId);
            }

            // Check if this is a Slack channel (synthetic negative topic IDs)
            let slackChId = slackProxyChannelMap.get(topicId);

            // Fallback: reverse-lookup from adapter channel registry if map doesn't have it
            if (!slackChId && _slackAdapter && topicId < 0) {
              const registry = _slackAdapter.getChannelRegistry();
              for (const channelId of Object.keys(registry)) {
                if (slackChannelToSyntheticId(channelId) === topicId) {
                  slackChId = channelId;
                  break;
                }
              }
              if (slackChId) {
                console.log(`[respawnSessionFresh] Resolved slackChId=${slackChId} via reverse lookup (map miss for topicId=${topicId})`);
              }
            }

            console.log(`[respawnSessionFresh] topicId=${topicId} slackChId=${slackChId || 'none'} slackAdapter=${!!_slackAdapter} session=${_sessionName} mapSize=${slackProxyChannelMap.size}`);

            if (slackChId && _slackAdapter) {
              // Kill existing session (already flagged in contextExhaustionKills via event listener)
              const session = sessionManager.listRunningSessions().find(s => s.tmuxSession === _sessionName);
              if (session) sessionManager.killSession(session.id);

              // Clear the channel resume so the new session starts fresh
              _slackAdapter.removeChannelResume(slackChId);

              // Spawn a fresh session with recovery context
              await new Promise(resolve => setTimeout(resolve, 2000));

              // Build a recovery bootstrap message with thread history (inline, matching Telegram pattern)
              // Use async fallback to fetch from Slack API if ring buffer is empty (race condition on restart)
              const history = await _slackAdapter.getChannelMessagesWithFallback(slackChId, 30);
              const botUserId = _slackAdapter.getBotUserId?.() ?? null;
              const lines: string[] = [];
              lines.push(`CONTINUATION — You are resuming an EXISTING Slack conversation after context exhaustion. Read the context below and pick up where you left off. Do NOT ask what was being discussed.`);
              lines.push('');
              lines.push(`[RECOVERY] Previous session hit the context window limit. This is a FRESH restart with thread history.`);
              if (recoveryPrompt) lines.push(recoveryPrompt);
              lines.push('');
              if (history.length > 0) {
                lines.push(`--- Thread History (last ${history.length} messages) ---`);
                for (const m of history) {
                  const date = new Date(parseFloat(m.ts) * 1000);
                  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                  const isBot = botUserId && m.user === botUserId;
                  const label = isBot ? 'Agent' : m.user;
                  lines.push(`[${time}] ${label}: ${m.text}`);
                }
                lines.push('--- End Thread History ---');
              } else {
                console.warn(`[slack→recovery] WARNING: No history available for channel ${slackChId} — recovery context is empty. Ring buffer may not be populated yet.`);
                lines.push('[WARNING: Thread history unavailable — ring buffer may not be populated. Check Slack channel for recent messages before responding.]');
              }
              lines.push('');
              lines.push('CRITICAL: You MUST relay your response back to Slack.');
              lines.push(`cat <<'EOF' | .claude/scripts/slack-reply.sh ${slackChId}`);
              lines.push('Your response text here');
              lines.push('EOF');

              const tmpDir = '/tmp/instar-slack';
              fs.mkdirSync(tmpDir, { recursive: true });
              const ctxPath = path.join(tmpDir, `recovery-${slackChId}-${Date.now()}.txt`);
              const contextData = lines.join('\n');
              fs.writeFileSync(ctxPath, contextData);

              const bootstrapMessage = `[slack:${slackChId}] ${contextData}`;

              try {
                const newSessionName = await sessionManager.spawnInteractiveSession(bootstrapMessage, undefined, { slackChannelId: slackChId });
                if (newSessionName) {
                  _slackAdapter.registerChannelSession(slackChId, newSessionName);
                  console.log(`[slack→recovery] Fresh session "${newSessionName}" spawned for channel ${slackChId} (context exhaustion recovery)`);
                }
              } catch (err) {
                console.error(`[slack→recovery] Fresh session spawn failed for ${slackChId}: ${err instanceof Error ? err.message : err}`);
              }
              return;
            }

            if (telegram) {
              const targetSession = telegram.getSessionForTopic(topicId);
              if (!targetSession) {
                console.warn(`[respawnSessionFresh] No Telegram or Slack session found for topicId=${topicId} — recovery has no target`);
                return;
              }
              await respawnSessionForTopic(sessionManager, telegram, targetSession, topicId, undefined, topicMemory, undefined, recoveryPrompt, { silent: true });
            } else if (!slackChId) {
              console.warn(`[respawnSessionFresh] No platform handler for topicId=${topicId} — recovery is a no-op`);
            }
          },
        },
      );
      // Track context exhaustion kills to prevent beforeSessionKill from re-saving
      // resume UUIDs (which would cause an infinite death loop)
      sessionRecovery.on('recovery:context_exhaustion', ({ sessionName }: { sessionName: string }) => {
        contextExhaustionKills.add(sessionName);
        // Clean up after 60 seconds — by then the kill and respawn are done
        setTimeout(() => contextExhaustionKills.delete(sessionName), 60_000);
      });
      console.log(pc.green('  Session Recovery enabled (mechanical fast-path)'));
    }

    // SessionMonitor — proactive session health monitoring
    // Platform-aware: monitors both Telegram and Slack sessions
    let sessionMonitor: SessionMonitor | undefined;
    if (telegram || _slackAdapter) {
      sessionMonitor = new SessionMonitor(
        {
          getActiveTopicSessions: () => {
            const sessions = new Map<number, string>();
            // Telegram topic sessions
            if (telegram && telegram.getActiveTopicSessions) {
              const telegramSessions = telegram.getActiveTopicSessions();
              for (const [topicId, sessionName] of telegramSessions) {
                sessions.set(topicId, sessionName);
              }
            }
            // Slack channel sessions (using synthetic IDs)
            // Exclude system channels (dashboard, lifeline) — they don't have interactive sessions
            if (_slackAdapter) {
              const registry = _slackAdapter.getChannelRegistry();
              for (const [channelId, entry] of Object.entries(registry)) {
                if (_slackAdapter.isSystemChannel(channelId)) continue;
                const syntheticId = slackChannelToSyntheticId(channelId);
                sessions.set(syntheticId, entry.sessionName);
              }
            }
            return sessions;
          },
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          getTopicHistory: (topicId, limit) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              const msgs = _slackAdapter.getChannelMessages(slackChId, limit);
              return msgs.map(m => ({ text: m.text, fromUser: true, timestamp: new Date(parseFloat(m.ts) * 1000).toISOString() }));
            }
            if (telegram) {
              const history = telegram.getMessageLog?.();
              if (!history) return [];
              return history
                .filter((m: any) => m.topicId === topicId)
                .slice(-limit)
                .map((m: any) => ({ text: m.text, fromUser: m.fromUser, timestamp: m.timestamp }));
            }
            return [];
          },
          sendToTopic: async (topicId, text) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              if (_slackAdapter.isSystemChannel(slackChId)) return;
              await _slackAdapter.sendToChannel(slackChId, text);
              return;
            }
            if (telegram) await telegram.sendToTopic(topicId, text);
          },
          triggerTriage: triageOrchestrator
            ? async (topicId, sessionName, reason) => {
                const result = await triageOrchestrator!.activate(topicId, sessionName, 'watchdog', reason, Date.now());
                return { resolved: result.resolved };
              }
            : triageNurse
              ? async (topicId, sessionName, reason) => {
                  const result = await triageNurse!.triage(topicId, sessionName, reason, Date.now(), 'watchdog');
                  return { resolved: result.resolved };
                }
              : undefined,
          sessionRecovery,
        },
        config.monitoring.sessionMonitor,
      );
      sessionMonitor.start();
      console.log(pc.green('  Session Monitor enabled'));
    }

    // Set up feedback and update checking
    let feedback: FeedbackManager | undefined;
    let feedbackAnomalyDetector: FeedbackAnomalyDetector | undefined;
    if (config.feedback) {
      feedback = new FeedbackManager({
        ...config.feedback,
        version: startupVersion,
      });
      feedbackAnomalyDetector = new FeedbackAnomalyDetector();
      console.log(pc.green('  Feedback loop enabled (with anomaly detection)'));
    }
    // Set up dispatch system with auto-dispatcher
    let dispatches: DispatchManager | undefined;
    let autoDispatcher: AutoDispatcher | undefined;
    if (config.dispatches) {
      dispatches = new DispatchManager({
        ...config.dispatches,
        version: startupVersion,
      });

      const dispatchExecutor = new DispatchExecutor(config.projectDir, sessionManager);
      autoDispatcher = new AutoDispatcher(
        dispatches,
        dispatchExecutor,
        state,
        config.stateDir,
        {
          pollIntervalMinutes: 30,
          autoApplyPassive: config.dispatches.autoApply ?? true,
          autoExecuteActions: true,
        },
        telegram,
      );
      // Wire dispatch decision journal for Discernment Layer (Milestone 1)
      const { DispatchDecisionJournal } = await import('../core/DispatchDecisionJournal.js');
      const dispatchDecisionJournal = new DispatchDecisionJournal(config.stateDir);
      autoDispatcher.setDecisionJournal(dispatchDecisionJournal);

      autoDispatcher.start();
      console.log(pc.green('  Dispatch system enabled (auto-polling active)'));
    }

    const updateChecker = new UpdateChecker({
      stateDir: config.stateDir,
      projectDir: config.projectDir,
      port: config.port,
      hasTelegram: config.messaging.some(m => m.type === 'telegram' && m.enabled),
      projectName: config.projectName,
    });

    // Check for updates on startup (non-blocking)
    updateChecker.check().then(info => {
      if (info.updateAvailable) {
        console.log(pc.yellow(`  Update available: ${info.currentVersion} → ${info.latestVersion}`));
      } else {
        console.log(pc.green(`  Instar ${info.currentVersion} is up to date`));
      }
    }).catch(() => { /* ignore startup check failures */ });

    // codex-instar audit Item 4 — restart-handshake verification.
    //
    // If the previous process applied an update and triggered a restart, it
    // wrote a pending-handshake marker describing what version it expected
    // to be running and the notification it would have sent. We now verify
    // that against the NEW process's runningVersion. The "Just updated, ...
    // restarting" notification only fires AFTER the restart actually took
    // effect — eliminating the bug where users were told the update was
    // live before it really was.
    const restartHandshake = new UpdateRestartHandshake(config.stateDir);
    try {
      const outcome = verifyRestartHandshake({
        handshake: restartHandshake,
        runningVersion: processIntegrity.runningVersion,
      });
      if (outcome.kind === 'verified') {
        // An empty deferredNotification means the bump was patch-only and the
        // restart narration was deliberately suppressed (Fork 3,
        // mature-update-announcements) — verification still ran, we just emit
        // nothing. Still clear the handshake either way.
        const note = (outcome.deferredNotification || '').trim();
        const topicId = state.get<number>('agent-updates-topic') || 0;
        if (note && telegram && topicId) {
          try {
            await telegram.sendToTopic(topicId, note);
          } catch (err) {
            console.warn(`[restart-handshake] verified notification failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!note) {
          console.log(`[restart-handshake] verified v${outcome.expectedVersion} (patch-level restart narration suppressed — Fork 3)`);
        } else {
          console.log(`[restart-handshake] verified v${outcome.expectedVersion} (no telegram/topic — skipping notification)`);
        }
        restartHandshake.clearHandshake();
      } else if (outcome.kind === 'failed') {
        const msg = outcome.escalate
          ? `Heads up — I tried to update to v${outcome.expectedVersion} but the restart didn't pick up the new code. Still running v${outcome.runningVersion}. Retry ${outcome.retryCount}.`
          : `Update to v${outcome.expectedVersion} was applied but I'm still running v${outcome.runningVersion}. The next restart should pick it up.`;
        const topicId = state.get<number>('agent-updates-topic') || 0;
        if (telegram && topicId) {
          try {
            await telegram.sendToTopic(topicId, msg);
          } catch (err) {
            console.warn(`[restart-handshake] failure notification failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          console.warn(`[restart-handshake] ${msg}`);
        }
      }
    } catch (err) {
      // Verification must never block startup — log and continue.
      console.warn(`[restart-handshake] verification error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Start auto-updater — periodic check + auto-apply + notify + restart
    // Notifications routed dynamically to Updates topic (see getNotificationTopicId)
    const autoUpdater = new AutoUpdater(
      updateChecker,
      state,
      config.stateDir,
      {
        checkIntervalMinutes: 30,
        autoApply: config.updates?.autoApply ?? true,
        autoRestart: true,
        restartWindow: config.updates?.restartWindow ?? null,
        restartCascadeDampenerWindowMs: config.updates?.restartCascadeDampenerWindowMs,
        // Primary-developer mode (per-agent opt-in) — never defer a restart for
        // active sessions or the restart window; always roll onto the latest.
        restartImmediately: config.updates?.restartImmediately ?? false,
        // codex-instar audit Item 4 — wire the handshake into AutoUpdater so
        // the pre-restart notification is DEFERRED into the marker file.
        restartHandshake,
      },
      telegram,
      liveConfig,
    );
    // Wire session deps for session-aware restart gating (Phase 2B)
    autoUpdater.setSessionDeps(sessionManager, sessionMonitor);
    autoUpdater.start();

    // ForegroundRestartWatcher — the critical gap fix (v0.9.72).
    // In foreground mode there's no supervisor to pick up restart-requested.json.
    // Without this, AutoUpdater installs the update, writes the flag, and nobody
    // acts on it — the process stays stale forever (the Luna/v0.9.70 incident).
    const restartWatcher = new ForegroundRestartWatcher({
      stateDir: config.stateDir,
      // Don't let the watcher call process.exit() directly — it crashes with
      // "mutex lock failed" because better-sqlite3 databases aren't closed.
      // Instead, we wire the 'restartDetected' event to the graceful shutdown
      // function (defined below) which closes all resources before exiting.
      exitOnRestart: false,
      onRestartDetected: async (request) => {
        // Only notify if there are active sessions — silent restart otherwise.
        // Phase 1C of GRACEFUL_UPDATES: reduce noise for routine maintenance.
        const runningSessions = sessionManager.listRunningSessions();
        if (runningSessions.length > 0) {
          // Route the pre-restart heads-up to the dedicated Agent Updates
          // topic, not the central-notify default (Attention). Every other
          // update-class emitter (AutoUpdater, AutoDispatcher, the restart
          // handshake, /telegram/post-update) routes here; this caller was
          // the lone path going to Attention. Falls through to the central
          // default when Updates is unset, preserving prior behavior for
          // agents without an Updates topic.
          const updatesTopicId = state.get<number>('agent-updates-topic') || undefined;
          notify('IMMEDIATE', 'system',
            `Applying update to v${request.targetVersion} — restarting now. Active sessions will resume automatically.`,
            updatesTopicId,
          );
        } else {
          console.log(`[ForegroundRestartWatcher] Silent restart — no active sessions (v${request.previousVersion} → v${request.targetVersion})`);
        }
      },
    });
    restartWatcher.start();

    // Set up Telegraph publishing (auto-enabled when config exists or Telegram is configured)
    let publisher: TelegraphService | undefined;
    const pubConfig = config.publishing;
    if (pubConfig?.enabled !== false) {
      publisher = new TelegraphService({
        stateDir: config.stateDir,
        shortName: pubConfig?.shortName || config.projectName,
        authorName: pubConfig?.authorName,
        authorUrl: pubConfig?.authorUrl,
      });
      console.log(pc.green(`  Publishing enabled (Telegraph)`));
    }

    // Set up private viewer (always enabled — stores rendered markdown locally)
    const viewer = new PrivateViewer({
      viewsDir: path.join(config.stateDir, 'views'),
    });
    console.log(pc.green(`  Private viewer enabled`));

    // Set up paste manager (Drop Zone — always enabled)
    const { PasteManager } = await import('../paste/PasteManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- paste config fields are optional extensions
    const cfgAny = config as any;
    const pasteManager = new PasteManager({
      pasteDir: path.join(config.stateDir, 'paste'),
      stateDir: path.join(config.stateDir, 'state'),
      projectDir: config.projectDir,
      maxSizeBytes: cfgAny.pasteMaxSizeMB ? cfgAny.pasteMaxSizeMB * 1024 * 1024 : undefined,
      retentionDays: cfgAny.pasteRetentionDays ?? undefined,
    });
    console.log(pc.green(`  Drop Zone (paste) enabled`));

    // Set up Cloudflare Tunnel — enabled by default (quick tunnel, zero-config)
    // Only disabled if explicitly set to tunnel.enabled = false
    const tunnelEnabled = config.tunnel?.enabled !== false;
    let tunnel: TunnelManager | undefined;
    if (tunnelEnabled) {
      // Persist tunnel config if it wasn't in config.json yet (existing agents)
      if (!config.tunnel) {
        liveConfig.set('tunnel', { enabled: true, type: 'quick' });
      }
      tunnel = new TunnelManager({
        enabled: true,
        type: config.tunnel?.type || 'quick',
        token: config.tunnel?.token,
        configFile: config.tunnel?.configFile,
        hostname: config.tunnel?.hostname,
        port: config.port,
        stateDir: config.stateDir,
        // Tunnel-failure-resilience knobs (spec Part 4).
        relayProviders: config.tunnel?.relayProviders,
        relaysEnabled: config.tunnel?.relaysEnabled,
        relayConsent: config.tunnel?.relayConsent,
        consentTimeoutMs: config.tunnel?.consentTimeoutMs,
      });

      // Wire credential rotation (tunnel-failure-resilience spec Part 6).
      // The manager owns WHEN to rotate (every terminal exit from
      // relay-active + boot-recovery); this closure owns WHAT: regenerate
      // the dashboard PIN + authToken, persist them, and DM the owner the
      // new PIN. Rotating authToken invalidates every previously-signed
      // view URL and the dashboard session — the documented UX cost of
      // having briefly routed private traffic through a third-party relay.
      tunnel.setCredentialRotator(async () => {
        const { randomUUID } = await import('node:crypto');
        const newPin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit, matches startup gen
        const newToken = randomUUID();
        // Persist to config.json (survives restart; boot reads the new token)…
        liveConfig.set('authToken', newToken);
        liveConfig.set('dashboardPin', newPin);
        // …and mutate the in-memory config the running server reads live,
        // so the auth middleware + view-URL signing reject the old token
        // and old signed links immediately, without a restart.
        config.authToken = newToken;
        config.dashboardPin = newPin;
        console.log(pc.yellow('  [tunnel] rotated dashboard PIN + auth token after relay episode'));
        if (telegram) {
          const msg = [
            `Security cleanup after the backup tunnel: I've rotated your dashboard PIN and access token.`,
            ``,
            `New dashboard PIN: ${newPin}`,
            ``,
            `Heads up: any dashboard tab you had open will need to sign in again with this new PIN, and any private view links you shared earlier no longer work. That's deliberate — it makes sure the backup operator can't reuse anything they may have seen while the backup was running.`,
          ].join('\n');
          await telegram.sendToOwnerDM(msg).catch(() => { /* best-effort; adapter logs its own failures */ });
        }
      });
    }

    // Set up evolution system (always enabled — the feedback loop infrastructure)
    const evolution = new EvolutionManager({
      stateDir: config.stateDir,
      ...(config.evolution || {}),
    });
    console.log(pc.green('  Evolution system enabled'));

    // Start MemoryPressureMonitor (platform-aware memory tracking)
    const { MemoryPressureMonitor } = await import('../monitoring/MemoryPressureMonitor.js');
    const memoryMonitor = new MemoryPressureMonitor({ stateDir: config.stateDir });
    // Memory notification cooldown removed — handled by NotificationBatcher (SUMMARY tier)
    memoryMonitor.on('stateChange', ({ from, to, state: memState }: { from: string; to: string; state: any }) => {
      // Gate scheduler spawning on memory pressure
      if (scheduler && (to === 'elevated' || to === 'critical')) {
        console.log(`[MemoryPressure] ${from} -> ${to} — scheduler should respect canSpawnSession()`);
      }
      // Alert via batcher — critical memory is IMMEDIATE, elevated is SUMMARY
      if (to !== 'normal') {
        const tier: NotificationTier = to === 'critical' ? 'IMMEDIATE' : 'SUMMARY';
        const freeGb = memState.freeGB.toFixed(1);
        const msg = to === 'critical'
          ? `The machine is running very low on memory (only ${freeGb}GB free). I'll hold off on starting new sessions until this clears up.`
          : `Memory is getting tight (${freeGb}GB free). I'll be conservative about spinning up new work.`;
        notify(tier, 'system', msg);
      }
    });
    memoryMonitor.start();

    // Wire memory gate into scheduler
    if (scheduler) {
      const originalCanRun = scheduler.canRunJob;
      scheduler.canRunJob = (priority) => {
        // Check memory first — return a rich result so the scheduler can
        // log the actual gating reason instead of mislabelling it as 'quota'.
        const memCheck = memoryMonitor.canSpawnSession();
        if (!memCheck.allowed) {
          return {
            allowed: false,
            reason: 'memory-pressure',
            detail: memCheck.reason ?? 'memory pressure elevated',
          };
        }
        // Then check original gate (quota, etc.)
        return originalCanRun(priority);
      };
    }

    // Start OrphanProcessReaper (detect and clean up untracked Claude processes)
    const { OrphanProcessReaper } = await import('../monitoring/OrphanProcessReaper.js');
    const orphanReaper = new OrphanProcessReaper(config, sessionManager, {
      pollIntervalMs: 60_000,      // Check every minute
      orphanMaxAgeMs: 3_600_000,   // Kill Instar orphans after 1 hour
      externalReportAgeMs: 14_400_000, // Report external processes after 4 hours
      highMemoryThresholdMB: 500,  // Flag processes using >500MB
      autoKillOrphans: true,       // Auto-kill Instar orphans (safe — only project-prefixed tmux sessions)
      reportExternalProcesses: config.monitoring?.reportExternalProcesses !== false,
      alertCallback: async (msg: string) => {
        notify('DIGEST', 'system', msg);
      },
    });
    orphanReaper.start();
    _orphanReaper = orphanReaper;
    if (_fixDeps) _fixDeps.orphanReaper = orphanReaper;
    _memoryMonitor = memoryMonitor;
    console.log(pc.green('  Orphan process reaper enabled'));

    // Hook Event Receiver — receives HTTP hook events from Claude Code sessions
    const { HookEventReceiver } = await import('../monitoring/HookEventReceiver.js');
    const hookEventReceiver = new HookEventReceiver({ stateDir: config.stateDir });
    console.log(pc.green('  Hook event receiver enabled'));

    // ── Compaction Resume: unified recovery for one session ──────────────
    // After compaction, the session's working context is gone. Rather than
    // replaying the user's last message (which assumes the agent still has
    // thread context), we inject a prompt telling the agent to re-read recent
    // topic messages and continue. The agent fetches its own history, so this
    // restores continuity without pretending no compaction happened.
    //
    // Note: we deliberately bypass triageOrchestrator here. Its reinject_message
    // heuristic unconditionally re-sends the last user message from topic
    // history — fine for "message lost mid-flight" stalls, wrong for compaction
    // recovery where the agent needs to re-orient first.
    //
    // Three independent triggers call into this:
    //   1. PreCompact hook event (Claude Code fires it — unreliable)
    //   2. SessionWatchdog 'compaction-idle' polling (default-enabled)
    //   3. POST /internal/compaction-resume (compaction-recovery.sh hook)
    // After compaction the agent needs three things: orientation, user-facing
    // transparency, and a clear handoff back to whatever they were doing.
    //
    // The payload embeds the same context block the session-spawn path uses
    // (topicMemory.formatContextForSession → summary + recent messages + a
    // search hint for deeper lookup). Before this, the prompt was a single
    // sentence asking the agent to "read recent messages" on its own — which
    // let it fabricate a plausible-sounding status summary instead of
    // answering the actual intent of the user's last message. Giving it the
    // same shape of context it had at first spawn removes the reason to
    // hallucinate.
    const { isSystemOrProxyMessage, findLastRealMessage } = await import('../messaging/shared/isSystemOrProxyMessage.js');
    const {
      buildCompactionResumePayload,
      formatInlineHistory,
      prepareInjectionText,
    } = await import('../messaging/shared/compactionResumePayload.js');

    const recoverCompactedSession = async (sessionName: string, triggerLabel: string): Promise<boolean> => {
      if (!sessionManager.isSessionAlive(sessionName)) return false;

      // Telegram path
      if (telegram) {
        const topicId = telegram.getTopicForSession(sessionName);
        if (topicId) {
          // Walk history backward, skipping PresenceProxy standby messages and
          // server-emitted delivery/lifecycle acks. Those are from-agent but
          // they are NOT real responses — treating them as "agent answered"
          // is what let this recovery path silently decline for 15 minutes
          // while the user's question sat unanswered. See
          // isSystemOrProxyMessage / findLastRealMessage for the canonical filter.
          const history = telegram.getTopicHistory(topicId, 20);
          const lastReal = findLastRealMessage(history);
          if (lastReal?.fromUser) {
            console.log(`[CompactionResume] (${triggerLabel}) topic ${topicId} session "${sessionName}" has unanswered message — recovering`);

            // Prefer topicMemory (summary + recent messages + search hint);
            // fall back to inline JSONL history when the SQLite store isn't
            // ready. Matches the session-spawn precedence in this file.
            let contextBlock = '';
            if (topicMemory?.isReady()) {
              try {
                contextBlock = topicMemory.formatContextForSession(topicId, 20);
              } catch (err) {
                console.warn(`[CompactionResume] (${triggerLabel}) topicMemory failed, falling back to inline history:`, err);
              }
            }
            if (!contextBlock) {
              const topicName = telegram.getTopicName?.(topicId) ?? undefined;
              contextBlock = formatInlineHistory(history, { topicName, label: 'TOPIC CONTEXT' });
            }

            const payload = buildCompactionResumePayload(contextBlock);
            const injectText = prepareInjectionText(payload, triggerLabel, topicId);
            // Direct injection with topic tag so InputGuard accepts it.
            const tagged = `[telegram:${topicId}] ${injectText}`;
            const ok = sessionManager.injectMessage(sessionName, tagged);
            if (ok) {
              console.log(`[CompactionResume] (${triggerLabel}) direct re-inject OK for topic ${topicId}`);
              return true;
            }
            console.warn(`[CompactionResume] (${triggerLabel}) direct re-inject FAILED for topic ${topicId}`);
          }
        }
      }

      // Slack path — handled in the Slack-aware block below (needs slackChannelToSyntheticId).
      // We attempt it here lazily via a deferred handler set on globalThis to avoid TDZ.
      const slackHandler = (globalThis as Record<string, unknown>).__instarSlackCompactionResume as
        | ((sessionName: string, triggerLabel: string) => Promise<boolean>)
        | undefined;
      if (slackHandler) {
        try { return await slackHandler(sessionName, triggerLabel); } catch { /* fall through */ }
      }
      return false;
    };

    // ── CompactionSentinel ────────────────────────────────────────────
    // Owns the full recovery lifecycle: detect → inject → verify (jsonl
    // growth) → retry on failure → finalize. Replaces the fire-and-forget
    // calls that used to live here. Dedupes across the three triggers and
    // vetoes zombie cleanup while a recovery is in flight.
    const { CompactionSentinel } = await import('../monitoring/CompactionSentinel.js');
    const compactionSentinel = new CompactionSentinel(
      {
        recoverFn: recoverCompactedSession,
        projectDir: config.projectDir,
        getClaudeSessionId: (sessionName: string) => {
          const session = sessionManager.listRunningSessions()
            .find(s => s.tmuxSession === sessionName);
          return session?.claudeSessionId;
        },
        // Codex parity: for codex sessions, recovery-verification reads the newest codex
        // rollout's growth (account-wide signal) instead of the Claude transcript (#33 recipe).
        getSessionFramework: (name) =>
          sessionManager.listRunningSessions().find((s) => s.tmuxSession === name)?.framework,
        // Don't re-inject a recovery prompt into a session that's actively
        // working (mid extended-think / tool call). Re-injecting buries the
        // user's real message under stacked recovery bootstraps — the false
        // "session is restarting" loop. The sentinel defers instead, bounded
        // by maxWorkingDefers. See SessionManager.isSessionActivelyWorking.
        isActivelyWorking: (sessionName: string) =>
          sessionManager.isSessionActivelyWorking(sessionName),
      },
      // Defaults are production-sensible; override here only if needed.
      {},
    );
    // ── RateLimitSentinel ─────────────────────────────────────────────
    // Rides out Anthropic's server-side capacity throttle ("Server is
    // temporarily limiting requests · not your usage limit") with
    // backoff-before-nudge + user check-ins, instead of the single immediate
    // nudge (quota burn) → silence the session used to fall into. See
    // docs/specs/rate-limit-sentinel.md.
    const { RateLimitSentinel } = await import('../monitoring/RateLimitSentinel.js');
    const getClaudeSessionIdForName = (sessionName: string): string | undefined =>
      sessionManager.listRunningSessions().find(s => s.tmuxSession === sessionName)?.claudeSessionId;

    // Recovery-reachability audit trail. Both recovery paths below ALWAYS leave
    // a record: a recovery-reached/recovery-unreachable line in the sentinel
    // audit log, and — when delivery to the user fails entirely — an entry in
    // .instar/sentinel-alerts.json so the dashboard surfaces it even without
    // Telegram. The defining bug this closes: a non-topic-bound session (e.g. a
    // developer's interactive Claude Code window) used to make both recovery
    // paths silently no-op, so the throttle never recovered and nothing reached
    // the user. Reachability is now unconditional — see the Sentinel
    // Reachability spec.
    const rlReachLogPath = path.join(config.stateDir, '..', 'logs', 'sentinel-events.jsonl');
    const rlAlertsPath = path.join(config.stateDir, 'sentinel-alerts.json');
    const recordRecovery = (
      kind: 'recovery-reached' | 'recovery-unreachable',
      sessionName: string,
      detail: string,
      fallbackTried: string[],
    ): void => {
      const entry = { timestamp: new Date().toISOString(), kind, sentinel: 'rate-limit', sessionName, detail, fallbackTried };
      console.log(`[sentinel:${kind}] rate-limit/${sessionName} — ${detail}`);
      try { fs.appendFileSync(rlReachLogPath, JSON.stringify(entry) + '\n'); } catch { /* best-effort */ }
      if (kind === 'recovery-unreachable') {
        // Append-only alert log the dashboard reads when Telegram can't be reached.
        try {
          let alerts: unknown[] = [];
          if (fs.existsSync(rlAlertsPath)) {
            try { alerts = JSON.parse(fs.readFileSync(rlAlertsPath, 'utf-8')) as unknown[]; } catch { alerts = []; }
            if (!Array.isArray(alerts)) alerts = [];
          }
          alerts.push(entry);
          fs.writeFileSync(rlAlertsPath, JSON.stringify(alerts.slice(-200), null, 2));
        } catch { /* best-effort */ }
      }
    };

    // Reachability deps (extracted to sentinelWiring.buildRateLimitRecoveryDeps
    // so the topic / lifeline / audit branching is unit-testable). Topic-bound
    // sessions get a topic-tagged nudge + topic notice; non-topic-bound sessions
    // (e.g. an interactive dev window) get a trusted internal nudge + a lifeline
    // notice; if no channel is reachable, a recovery-unreachable audit event is
    // recorded instead of a silent no-op.
    const { buildRateLimitRecoveryDeps } = await import('../monitoring/sentinelWiring.js');
    const { resumeFn: rateLimitResume, notifyFn: rateLimitNotify } = buildRateLimitRecoveryDeps({
      isSessionAlive: (name) => sessionManager.isSessionAlive(name),
      injectTopicNudge: (name, topicId, text) =>
        sessionManager.injectMessage(name, `[telegram:${topicId}] ${text}`),
      injectInternalNudge: (name, text) =>
        sessionManager.injectInternalMessage(name, text, 'sentinel-recovery'),
      getTopicForSession: (name) => telegram?.getTopicForSession(name),
      getLifelineTopicId: () => telegram?.getLifelineTopicId?.(),
      deliverNotice: async (topicId, text) => {
        const resp = await fetch(`http://localhost:${config.port}/telegram/reply/${topicId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.authToken}` },
          body: JSON.stringify({ text }),
        });
        return resp.ok;
      },
      recordRecovery,
    });
    const rlsCfg = config.monitoring?.rateLimitSentinel ?? { enabled: true };
    const rateLimitSentinel = new RateLimitSentinel(
      {
        resumeFn: rateLimitResume,
        notifyFn: rateLimitNotify,
        projectDir: config.projectDir,
        getClaudeSessionId: getClaudeSessionIdForName,
        // #33 codex parity: for codex sessions, recovery-verification reads the newest
        // codex rollout (account-wide throttle → newest-rollout growth = cleared) and
        // the user-facing messages use OpenAI wording.
        getSessionFramework: (name) =>
          sessionManager.listRunningSessions().find((s) => s.tmuxSession === name)?.framework,
      },
      rlsCfg,
    );

    // Zombie-kill veto: compose BOTH sentinels (editing the single-predicate
    // checker — a second setActiveRecoveryChecker call would drop the
    // compaction veto).
    sessionManager.setActiveRecoveryChecker(
      session =>
        compactionSentinel.isRecoveryActive(session.tmuxSession) ||
        rateLimitSentinel.isRecoveryActive(session.tmuxSession),
    );
    // Bidirectional deferral — neither sentinel injects into a pane the other
    // already owns.
    rateLimitSentinel.setDeferIf(s => compactionSentinel.isRecoveryActive(s));
    compactionSentinel.setDeferIf(s => rateLimitSentinel.isRecoveryActive(s));

    // Triggers: watchdog poll + SessionManager idle-error emit. Both deduped by
    // the sentinel.
    if (watchdog) {
      watchdog.on('rate-limited', (sessionName: string) => {
        rateLimitSentinel.report(sessionName, 'watchdog-poll');
      });
    }
    sessionManager.on('rateLimitedAtIdle', (sessionName: string) => {
      rateLimitSentinel.report(sessionName, 'idle-error');
    });
    // Generic transient API errors (500/502/503, timeout, connection drop) ride the
    // SAME backoff→verify→escalate lifecycle as throttles, with a faster backoff
    // schedule (they usually clear in seconds). Generalizing the proven recovery to
    // the whole transient-API class is the 2026-05-29 future-proofing ask (topic 13481).
    sessionManager.on('apiErrorAtIdle', (sessionName: string) => {
      rateLimitSentinel.report(sessionName, 'idle-error', { errorClass: 'transient-api' });
    });
    // #33 codex parity: the two triggers above read CLAUDE panes / claude-PID watchdog,
    // so a codex session throttled by OpenAI is invisible to them. This poll reads the
    // codex account usage; when codex itself flags a rate-limit hit
    // (rateLimitReachedType), it reports each running codex session into the sentinel
    // (deduped — report() no-ops while a recovery is active). The recovery keeps the
    // session alive and verifies via the newest codex rollout's growth (the codex-aware
    // readJsonlBaseline / getSessionFramework dep above).
    //
    // KNOWN LIMITATION — must-fix BEFORE enabling (2nd-pass review): the OpenAI limit is
    // account-wide and recovery-verification watches the ACCOUNT's newest rollout, not a
    // specific session's. Correct for ONE codex session (today's reality), but with ≥2
    // concurrent throttled codex sessions, one session's resumed output grows the shared
    // newest rollout and would recover ALL reported sessions — including a sibling that
    // is genuinely still stuck (a false recovery). Safe while DARK + single-session; do
    // NOT flip codexUsageDetection on a host that runs ≥2 concurrent codex sessions until
    // this is per-session (track the session's own rollout) or redefined as account-level
    // with per-session re-probe. Ships DARK (default off); rollback = set it false.
    // Best-effort + non-blocking.
    if (rlsCfg.codexUsageDetection === true) {
      const codexRateLimitPoll = setInterval(() => {
        void (async () => {
          try {
            const codexSessions = sessionManager
              .listRunningSessions()
              .filter((s) => s.framework === 'codex-cli');
            if (codexSessions.length === 0) return;
            const { readLatestCodexUsage } = await import(
              '../providers/adapters/openai-codex/observability/codexRateLimitReader.js'
            );
            const usage = await readLatestCodexUsage();
            if (!usage || !usage.rateLimitReachedType) return;
            for (const s of codexSessions) {
              rateLimitSentinel.report(s.tmuxSession, 'codex-usage-poll', { errorClass: 'throttle' });
            }
          } catch {
            /* @silent-fallback-ok best-effort codex-throttle detection; never crash the poll */
          }
        })();
      }, 60_000);
      codexRateLimitPoll.unref?.();
    }
    // Observability: every RateLimitSentinel lifecycle transition → the shared
    // sentinel-events.jsonl audit trail, so a throttle recovery is never
    // invisible (the 2026-05-30 ask: "instrument so we can SEE it working").
    // Complements the recovery-reached/unreachable notify-outcome events above;
    // together they trace detect → backoff/resume(attempt N) → recovered/escalated.
    {
      const rlMaxAttempts = rlsCfg.maxAttempts ?? 6;
      const rlEvent = (kind: string, sessionName: string, detail: string): void => {
        const entry = { timestamp: new Date().toISOString(), kind, sentinel: 'rate-limit', sessionName, detail };
        console.log(`[sentinel:${kind}] rate-limit/${sessionName} — ${detail}`);
        try { fs.appendFileSync(rlReachLogPath, JSON.stringify(entry) + '\n'); }
        catch { /* @silent-fallback-ok best-effort audit; never crash the monitor path */ }
      };
      rateLimitSentinel.on('rate-limit:detected', (s: { sessionName: string; trigger: string }) =>
        rlEvent('throttle-detected', s.sessionName, `trigger=${s.trigger}`));
      rateLimitSentinel.on('rate-limit:resuming', (s: { sessionName: string; attempts: number; backoffMs?: number }) =>
        rlEvent('throttle-resuming', s.sessionName, `attempt ${s.attempts}/${rlMaxAttempts} after ${Math.round((s.backoffMs ?? 0) / 1000)}s backoff`));
      rateLimitSentinel.on('rate-limit:recovered', (s: { sessionName: string; attempts: number; jsonlDelta?: number }) =>
        rlEvent('throttle-recovered', s.sessionName, `jsonl grew ${s.jsonlDelta ?? 0}b after ${s.attempts} attempt(s)`));
      rateLimitSentinel.on('rate-limit:escalated', (s: { sessionName: string; reason?: string }) =>
        rlEvent('throttle-escalated', s.sessionName, s.reason ?? 'unknown'));
    }
    if (rlsCfg.enabled !== false) {
      console.log(pc.green('  RateLimitSentinel enabled (server-throttle backoff + check-ins)'));
    }
    console.log(pc.green('  CompactionSentinel enabled (verified recovery lifecycle)'));

    // ── Silently-stopped trio: SocketDisconnectSentinel + ActiveWorkSilenceSentinel ──
    // Wire-up post-2026-05-22 incident. Every transition (detect/nudge/recover)
    // lands in the audit log (server logs + JSONL) — the user never sees it.
    // A genuine recovery-failed escalation goes through SentinelNotifier, which
    // is OFF for Telegram by default and, when enabled, coalesces into ONE
    // consolidated message to the existing system topic. No new-topic-per-event.
    // Spec: docs/specs/silently-stopped-trio.md.
    //
    // Captured out of the trio block so the SessionReaper's recovery veto can
    // compose socket + silence in too (SESSION-REAPER-SPEC §4 "compose, don't
    // replace"). undefined when the corresponding sentinel is disabled.
    let socketRecoveryActive: ((sessionName: string) => boolean) | undefined;
    let silenceRecoveryActive: ((sessionName: string) => boolean) | undefined;
    let wedgeRecoveryActive: ((sessionName: string) => boolean) | undefined;
    {
      const { SocketDisconnectSentinel } = await import('../monitoring/SocketDisconnectSentinel.js');
      const { ActiveWorkSilenceSentinel } = await import('../monitoring/ActiveWorkSilenceSentinel.js');
      const { ContextWedgeSentinel } = await import('../monitoring/ContextWedgeSentinel.js');
      const {
        buildSocketDisconnectDeps,
        buildActiveWorkSilenceDeps,
        buildContextWedgeDeps,
        OutputActivityTracker,
      } = await import('../monitoring/sentinelWiring.js');
      const { SentinelNotifier } = await import('../monitoring/SentinelNotifier.js');
      type _LogEntry = import('../monitoring/SentinelNotifier.js').SentinelLogEntry;

      const sessionSurface = {
        captureOutput: (s: string, lines?: number) => sessionManager.captureOutput(s, lines),
        isSessionAlive: (s: string) => sessionManager.isSessionAlive(s),
        sendKey: (s: string, key: string) => sessionManager.sendKey(s, key),
        listRunningSessions: () =>
          sessionManager.listRunningSessions().map(sess => ({
            tmuxSession: sess.tmuxSession,
            framework: sessionManager.frameworkForSession(sess.tmuxSession),
          })),
      };

      // Audit log: console + JSONL. setupServerLog already created the logs dir.
      const sentinelLogPath = path.join(config.stateDir, '..', 'logs', 'sentinel-events.jsonl');
      const logSink = (entry: _LogEntry): void => {
        const detail = entry.detail ? ` — ${entry.detail}` : '';
        console.log(`[sentinel:${entry.kind}] ${entry.sentinel}/${entry.sessionName}${detail}`);
        try {
          fs.appendFileSync(sentinelLogPath, JSON.stringify(entry) + '\n');
        } catch { /* logs are best-effort; never crash the monitoring path */ }
      };

      // Consolidated Telegram delivery — reuses the existing system (lifeline)
      // topic. When telegramEscalation is off, this callback is never invoked.
      const localTelegram = telegram;
      const sendConsolidated = localTelegram
        ? async (text: string): Promise<boolean> => {
            const topicId = localTelegram.getLifelineTopicId();
            if (!topicId) return false;
            try {
              await localTelegram.sendToTopic(topicId, text);
              return true;
            } catch {
              return false;
            }
          }
        : undefined;

      const telegramEscalation = config.monitoring?.sentinelTelegramEscalation === true;
      const notifier = new SentinelNotifier(
        { log: logSink, sendConsolidated },
        { telegramEscalation },
      );

      const socketCfg = config.monitoring?.socketDisconnectSentinel ?? { enabled: true };
      if (socketCfg.enabled !== false) {
        const socketSentinel = new SocketDisconnectSentinel(
          buildSocketDisconnectDeps({
            sessions: sessionSurface,
            escalate: (name, text) => notifier.escalate('socket-disconnect', name, text),
          }),
          socketCfg,
        );
        socketSentinel.on('recovered', (n: string) => notifier.record('recovered', 'socket-disconnect', n));
        socketSentinel.on('recovery-error', (e: { sessionName: string; err: unknown }) =>
          notifier.record('recovery-error', 'socket-disconnect', e.sessionName, e.err instanceof Error ? e.err.message : String(e.err)));
        socketSentinel.start();
        socketRecoveryActive = (s: string) => socketSentinel.isRecoveryActive(s);
        console.log(pc.green('  SocketDisconnectSentinel enabled (connection-drop recovery)'));
      }

      const silenceCfg = config.monitoring?.activeWorkSilenceSentinel ?? { enabled: true };
      if (silenceCfg.enabled !== false) {
        const tracker = new OutputActivityTracker(sessionSurface);
        const silenceSentinel = new ActiveWorkSilenceSentinel(
          buildActiveWorkSilenceDeps({
            tracker, sessions: sessionSurface,
            escalate: (name, text) => notifier.escalate('active-silence', name, text),
          }),
          silenceCfg,
        );
        silenceSentinel.on('silence', (e: { sessionName: string; idleMs: number }) =>
          notifier.record('detected', 'active-silence', e.sessionName, `idleMs=${e.idleMs}`));
        silenceSentinel.on('recovered', (n: string) => notifier.record('recovered', 'active-silence', n));
        silenceSentinel.on('nudge-error', (e: { sessionName: string; err: unknown }) =>
          notifier.record('nudge-error', 'active-silence', e.sessionName, e.err instanceof Error ? e.err.message : String(e.err)));
        silenceSentinel.start();
        silenceRecoveryActive = (s: string) => silenceSentinel.isRecoveryActive(s);
        console.log(pc.green(
          telegramEscalation
            ? '  ActiveWorkSilenceSentinel enabled (silent-freeze watchdog — Telegram escalation ON, consolidated)'
            : '  ActiveWorkSilenceSentinel enabled (silent-freeze watchdog — logs only, Telegram escalation OFF)',
        ));
      }

      // ── ContextWedgeSentinel — thinking-block-400 fast-fail wedge ──
      // Detection + audit ship default-ON (harmless housekeeping). The
      // destructive fresh-respawn is gated by autoRecovery (default OFF +
      // dryRun) and rides the Graduated Feature Rollout track. freshRespawn is
      // late-bound to _sessionRefresh (assigned later in boot) and only invoked
      // at recovery time; it uses fresh-mode so the new session never --resume-s
      // the corrupted transcript. Spec: docs/specs/context-wedge-sentinel.md.
      const wedgeCfg = config.monitoring?.contextWedgeSentinel ?? { enabled: true };
      if (wedgeCfg.enabled !== false) {
        const autoRecovery = wedgeCfg.autoRecovery ?? { enabled: false, dryRun: true };
        const wedgeSentinel = new ContextWedgeSentinel(
          buildContextWedgeDeps({
            sessions: sessionSurface,
            escalate: (name, text) => notifier.escalate('context-wedge', name, text),
            autoRecovery,
            freshRespawn: async (name: string): Promise<boolean> => {
              if (!_sessionRefresh) return false;
              const result = await _sessionRefresh.refreshSession({
                sessionName: name,
                fresh: true,
                reason: 'context-wedge-400',
              });
              return result.ok;
            },
          }),
          {
            enabled: wedgeCfg.enabled,
            tickIntervalMs: wedgeCfg.tickIntervalMs,
            confirmWindowMs: wedgeCfg.confirmWindowMs,
          },
        );
        wedgeSentinel.on('detected', (e: { sessionName: string }) =>
          notifier.record('detected', 'context-wedge', e.sessionName));
        wedgeSentinel.on('recovered', (e: { sessionName: string }) =>
          notifier.record('recovered', 'context-wedge', e.sessionName, 'fresh respawn'));
        wedgeSentinel.on('dry-run', (e: { sessionName: string }) =>
          notifier.record('dry-run', 'context-wedge', e.sessionName, 'would fresh-respawn'));
        wedgeSentinel.on('false-alarm', (e: { sessionName: string }) =>
          notifier.record('false-alarm', 'context-wedge', e.sessionName, 'signature scrolled out of tail'));
        wedgeSentinel.on('recovery-error', (e: { sessionName: string; err: unknown }) =>
          notifier.record('recovery-error', 'context-wedge', e.sessionName, e.err instanceof Error ? e.err.message : String(e.err)));
        wedgeSentinel.start();
        wedgeRecoveryActive = (s: string) => wedgeSentinel.isRecoveryActive(s);
        const mode = autoRecovery.enabled ? (autoRecovery.dryRun ? 'auto-recover dry-run' : 'auto-recover LIVE') : 'detect-only';
        console.log(pc.green(`  ContextWedgeSentinel enabled (thinking-block-400 wedge — ${mode})`));
      }
    }

    // Recompose the zombie-kill veto to include ALL four recovery sentinels now
    // that socket + silence exist (the interim set above covered only compaction
    // + rate-limit, before those two were constructed). This single composed
    // predicate is the superset — it drops none — and is reused as the
    // SessionReaper's recovery gate (G) so the reaper never kills a session any
    // sentinel is reviving. SESSION-REAPER-SPEC §4 "compose, don't replace".
    const composedRecoveryActive = (session: import('../core/types.js').Session): boolean =>
      compactionSentinel.isRecoveryActive(session.tmuxSession) ||
      rateLimitSentinel.isRecoveryActive(session.tmuxSession) ||
      (socketRecoveryActive?.(session.tmuxSession) ?? false) ||
      (silenceRecoveryActive?.(session.tmuxSession) ?? false) ||
      (wedgeRecoveryActive?.(session.tmuxSession) ?? false);
    sessionManager.setActiveRecoveryChecker(composedRecoveryActive);

    // Trigger 1: PreCompact hook event — report to sentinel.
    hookEventReceiver.on('PreCompact', () => {
      // Delay to let compaction + recovery hooks finish
      setTimeout(() => {
        if (!telegram) return;
        const topicSessions = telegram.getAllTopicSessions();
        for (const [, sessionName] of topicSessions) {
          compactionSentinel.report(sessionName, 'PreCompact');
        }
      }, 10_000);
    });
    console.log(pc.green('  Compaction auto-resume wired (PreCompact hook event)'));

    // Pre-compaction memory flush — write durable facts before compaction
    // collapses working memory. Off by default; enable via config.preCompactionFlush.
    // See docs/specs/OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.md.
    const preCompactFlushCfg = (config as unknown as {
      preCompactionFlush?: Partial<import('../core/PreCompactionFlush.js').PreCompactionFlushConfig>;
    }).preCompactionFlush;
    if (preCompactFlushCfg?.enabled) {
      const { PreCompactionFlush, DEFAULT_PRE_COMPACTION_FLUSH_CONFIG } = await import('../core/PreCompactionFlush.js');
      const flush = new PreCompactionFlush(
        {
          intelligence: sharedIntelligence ?? null,
          projectDir: config.projectDir,
        },
        { ...DEFAULT_PRE_COMPACTION_FLUSH_CONFIG, ...preCompactFlushCfg },
      );
      hookEventReceiver.on('PreCompact', (payload) => {
        flush.handle(payload as Parameters<typeof flush.handle>[0]).catch(() => {
          /* handle() owns its audit; never throws. */
        });
      });
      console.log(pc.green('  Pre-compaction memory flush enabled'));
    }

    // Trigger 2: Watchdog 'compaction-idle' polling — report to sentinel.
    if (watchdog) {
      watchdog.on('compaction-idle', (sessionName: string) => {
        compactionSentinel.report(sessionName, 'watchdog-poll');
      });
      console.log(pc.green('  Compaction auto-resume wired (watchdog poll)'));
    }

    // Trigger 3: stash a function on globalThis so the HTTP route (registered
    // later in AgentServer) and the compaction-recovery.sh hook can invoke it
    // via POST /internal/compaction-resume. Routes into the sentinel so the
    // dedupe/verify/retry lifecycle applies to this path too.
    (globalThis as Record<string, unknown>).__instarCompactionRecover = (
      sessionName: string,
      triggerLabel: string,
    ) => {
      compactionSentinel.report(sessionName, triggerLabel || 'recovery-hook');
      return Promise.resolve(true);
    };

    // Subagent Tracker — monitors subagent lifecycle via hook events
    const { SubagentTracker } = await import('../monitoring/SubagentTracker.js');
    const subagentTracker = new SubagentTracker({ stateDir: config.stateDir });
    console.log(pc.green('  Subagent tracker enabled'));

    // Helper Watchdog — detects subagent stalls and rate-limit failures,
    // surfacing them back into the parent session's stdin so the agent
    // can decide whether to retry smaller. Complements SessionWatchdog,
    // which only covers the top-level session.
    const { HelperWatchdog } = await import('../monitoring/HelperWatchdog.js');
    const helperWatchdog = new HelperWatchdog({ subagentTracker });
    helperWatchdog.start();
    const findTmuxForClaudeSession = (claudeSessionId: string): string | null => {
      const running = sessionManager
        .listRunningSessions()
        .filter((s) => s.claudeSessionId === claudeSessionId);
      return running[0]?.tmuxSession ?? null;
    };
    const deliverHelperAlert = (tmux: string | null, msg: string): void => {
      console.warn(msg);
      if (!tmux) return;
      try {
        sessionManager.injectMessage(tmux, msg);
      } catch (err) {
        console.warn(
          `[HelperWatchdog] inject failed for ${tmux}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    helperWatchdog.on(
      'stall',
      (e: { agentId: string; agentType: string; sessionId: string; elapsedMs: number }) => {
        const minutes = Math.round(e.elapsedMs / 60_000);
        deliverHelperAlert(
          findTmuxForClaudeSession(e.sessionId),
          `[helper-watchdog] Your ${e.agentType} helper (agent ${e.agentId}) has been running for ${minutes}m with no stop event — likely stalled. Consider retrying with a smaller scope or aborting.`,
        );
      },
    );
    helperWatchdog.on(
      'helper-failed',
      (e: {
        record: { agentId: string; agentType: string; sessionId: string; lastMessage: string | null };
        reason: string;
      }) => {
        const snippet = (e.record.lastMessage ?? '').slice(0, 160);
        deliverHelperAlert(
          findTmuxForClaudeSession(e.record.sessionId),
          `[helper-watchdog] Your ${e.record.agentType} helper (agent ${e.record.agentId}) died with reason=${e.reason}. Last message: ${snippet}`,
        );
      },
    );
    console.log(pc.green('  Helper watchdog enabled'));

    // Wire subagent awareness into zombie cleanup — prevents killing sessions
    // that are idle at the prompt but waiting for subagent results.
    const MAX_SUBAGENT_WAIT_MS = 60 * 60_000; // 60 minutes — stale subagent safety cap
    sessionManager.setSubagentChecker((session: import('../core/types.js').Session) => {
      if (!session.claudeSessionId) return false;
      const active = subagentTracker.getActiveSubagents(session.claudeSessionId);
      if (active.length === 0) return false;
      // Safety cap: if ALL active subagents have been running > 60 minutes,
      // treat them as stale (likely missed a SubagentStop event) and allow the kill.
      const now = Date.now();
      const allStale = active.every(a =>
        now - new Date(a.startedAt).getTime() > MAX_SUBAGENT_WAIT_MS,
      );
      if (allStale) {
        console.warn(`[SessionManager] Session "${session.name}" has ${active.length} stale subagent(s) (>60m). Allowing zombie kill.`);
        return false;
      }
      return true;
    });

    // Worktree Monitor — detects orphaned worktrees after sessions complete
    const { WorktreeMonitor } = await import('../monitoring/WorktreeMonitor.js');
    const worktreeMonitor = new WorktreeMonitor({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      pollIntervalMs: 300_000, // 5 minutes
      alertCallback: async (msg: string) => {
        notify('IMMEDIATE', 'system', msg);
      },
    });
    worktreeMonitor.start();

    // Wire worktree scan to session completion
    sessionManager.on('sessionComplete', async (session: import('../core/types.js').Session) => {
      try {
        await worktreeMonitor.onSessionComplete(session);
      } catch (err) {
        console.error('[WorktreeMonitor] Post-session scan failed:', err);
      }
    });
    console.log(pc.green('  Worktree monitor enabled (post-session + periodic)'));

    // Session-end maintenance — lightweight housekeeping at session boundaries
    // Cross-pollinated from Dawn: distributes maintenance load across all sessions
    const { SessionMaintenanceRunner } = await import('../core/SessionMaintenanceRunner.js');
    const sessionMaintenance = new SessionMaintenanceRunner({ stateDir: config.stateDir });
    sessionManager.on('sessionComplete', async () => {
      try {
        const result = await sessionMaintenance.run();
        if (result.tasksRun.length > 0) {
          console.log(`[SessionMaintenance] ${result.summary}`);
        }
      } catch (err) {
        // Fire-and-forget — maintenance failures never block session cleanup
        console.error('[SessionMaintenance] Failed:', err);
      }
    });
    console.log(pc.green('  Session-end maintenance enabled'));

    // Instructions Verifier — tracks which CLAUDE.md files loaded
    const { InstructionsVerifier } = await import('../monitoring/InstructionsVerifier.js');
    const instructionsVerifier = new InstructionsVerifier({ stateDir: config.stateDir });
    console.log(pc.green('  Instructions verifier enabled'));

    // Coherence Monitor — runtime self-awareness for homeostasis.
    // Periodically checks config coherence, state durability, output sanity,
    // and feature readiness. Self-corrects where possible, notifies otherwise.
    const coherenceMonitor = new CoherenceMonitor({
      stateDir: config.stateDir,
      liveConfig,
      port: config.port,
      onIncoherence: (report) => {
        const failedChecks = report.checks.filter(c => !c.passed && !c.corrected);
        const parts = failedChecks.map(c => formatCoherenceFailure(c.name, c.message));
        notify('SUMMARY', 'attention-update', parts.join('\n\n'));
      },
    });
    coherenceMonitor.start();
    if (_fixDeps) _fixDeps.coherenceMonitor = coherenceMonitor;
    console.log(pc.green('  Coherence monitor enabled'));

    // Commitment Tracker — durable promise enforcement for agent commitments.
    // When users ask agents to change settings/behavior, this ensures it sticks.
    const { CommitmentTracker } = await import('../monitoring/CommitmentTracker.js');
    const commitmentTracker = new CommitmentTracker({
      stateDir: config.stateDir,
      liveConfig,
      onViolation: (commitment, detail) => {
        notify('IMMEDIATE', 'commitment',
          `You asked me to "${commitment.userRequest}" but it looks like that setting reverted. ${detail}`
        );
      },
      onVerified: (commitment) => {
        console.log(`[CommitmentTracker] First verification passed: ${commitment.id} "${commitment.userRequest}"`);
      },
      onEscalation: (commitment, detail) => {
        notify('IMMEDIATE', 'commitment',
          `The change you asked for ("${commitment.userRequest}") keeps reverting — this looks like a bug I need to fix. ${detail}`
        );
      },
    });
    commitmentTracker.start();
    console.log(pc.green('  Commitment tracker enabled'));

    // Commitment Sentinel — LLM-powered scanner that finds unregistered commitments.
    let commitmentSentinel: import('../monitoring/CommitmentSentinel.js').CommitmentSentinel | undefined;
    if (sharedIntelligence) {
      const { CommitmentSentinel } = await import('../monitoring/CommitmentSentinel.js');
      commitmentSentinel = new CommitmentSentinel({
        stateDir: config.stateDir,
        intelligence: sharedIntelligence,
        commitmentTracker,
      });
      commitmentSentinel.start();
      console.log(pc.green('  Commitment sentinel enabled (LLM-powered)'));
    }

    // Presence Proxy — Intelligent Response Standby (tiered status updates)
    // Slack bridge: PresenceProxy uses numeric topicIds internally. For Slack channels,
    // we assign stable negative synthetic IDs and route sendMessage to the correct platform.
    const slackProxyChannelMap = new Map<number, string>(); // syntheticId -> Slack channelId
    function slackChannelToSyntheticId(channelId: string): number {
      // Stable hash: sum of char codes, negated to avoid Telegram topic ID collisions
      let hash = 0;
      for (let i = 0; i < channelId.length; i++) {
        hash = ((hash << 5) - hash + channelId.charCodeAt(i)) | 0;
      }
      const syntheticId = -(Math.abs(hash) + 1); // Always negative, never 0
      slackProxyChannelMap.set(syntheticId, channelId);
      return syntheticId;
    }

    // Pre-populate the Slack proxy channel map from existing channel registry
    // so PresenceProxy state recovery can resolve synthetic IDs on restart
    if (_slackAdapter) {
      const registry = _slackAdapter.getChannelRegistry();
      for (const channelId of Object.keys(registry)) {
        slackChannelToSyntheticId(channelId);
      }
    }

    // Slack compaction-resume wiring — registered as a deferred handler the
    // unified recoverCompactedSession() helper above will call. Works with or
    // without triageOrchestrator (falls back to direct sessionManager inject).
    if (_slackAdapter) {
      const _slack = _slackAdapter;
      const slackRecover = async (sessionName: string, triggerLabel: string): Promise<boolean> => {
        const channelId = _slack.getChannelForSession(sessionName);
        if (!channelId) return false;
        const slackLogPath = path.join(config.stateDir, 'slack-messages.jsonl');
        // Load up to the last 20 messages for this channel so we can both
        // verify the most recent entry is unanswered (last real message is
        // user) AND build an inline history block for the resume payload.
        interface SlackLogEntry { text?: string; fromUser?: boolean; timestamp?: string; senderName?: string; channelId?: string }
        const channelMessages: SlackLogEntry[] = [];
        try {
          const content = fs.readFileSync(slackLogPath, 'utf-8');
          const lines = content.trim().split('\n');
          for (let i = lines.length - 1; i >= 0 && channelMessages.length < 20; i--) {
            try {
              const msg = JSON.parse(lines[i]) as SlackLogEntry;
              if (msg.channelId === channelId) {
                channelMessages.unshift(msg);
              }
            } catch { /* skip malformed */ }
          }
        } catch { /* no log */ }
        if (channelMessages.length === 0) return false;
        const lastReal = findLastRealMessage(channelMessages);
        if (!lastReal?.fromUser) return false;
        console.log(`[CompactionResume] (${triggerLabel}) Slack channel ${channelId} has unanswered message — recovering`);

        const contextBlock = formatInlineHistory(channelMessages, { label: 'SLACK CHANNEL CONTEXT' });
        const payload = buildCompactionResumePayload(contextBlock);
        const injectText = prepareInjectionText(payload, triggerLabel, channelId);
        // Direct injection — bypass triage (see comment on recoverCompactedSession).
        const ok = sessionManager.injectMessage(sessionName, injectText);
        if (ok) {
          console.log(`[CompactionResume] (${triggerLabel}) Slack direct re-inject OK for channel ${channelId}`);
          return true;
        }
        return false;
      };
      (globalThis as Record<string, unknown>).__instarSlackCompactionResume = slackRecover;
      console.log(pc.green('  Compaction auto-resume registered (Slack channels)'));
    }

    // ── ProxyCoordinator (shared between PresenceProxy and PromiseBeacon) ──
    // Per PROMISE-BEACON-SPEC.md §A10: a per-topic mutex that prevents
    // ⏳ (PromiseBeacon) and 🔭 (PresenceProxy) from double-posting.
    const { ProxyCoordinator } = await import('../monitoring/ProxyCoordinator.js');
    const proxyCoordinator = new ProxyCoordinator();

    // ── Shared LlmQueue (priority-laned, daily-spend-capped) ──
    const { LlmQueue: SharedLlmQueueCls } = await import('../monitoring/LlmQueue.js');
    const promiseBeaconCfg = ((config as any).promiseBeacon ?? {}) as {
      prefix?: string;
      maxDailyLlmSpendCents?: number;
      sentinelAutoEnable?: boolean;
      quietHours?: { start: string; end: string; timezone?: string };
      maxActiveBeacons?: number;
    };
    const sharedLlmQueue = new SharedLlmQueueCls({
      maxConcurrent: 3,
      interactiveReservePct: 0.4,
      maxDailyCents: promiseBeaconCfg.maxDailyLlmSpendCents ?? 100,
    });
    // sharedLlmQueue is wired into both PromiseBeacon (background lane) and
    // PresenceProxy (interactive lane) below.

    let presenceProxy: import('../monitoring/PresenceProxy.js').PresenceProxy | undefined;
    if (sharedIntelligence && telegram) {
      try {
        const { PresenceProxy, isBriefAck } = await import('../monitoring/PresenceProxy.js');
        const { execSync: shellExecSync } = await import('child_process');

        const messagesLogPath = path.join(config.stateDir, 'telegram-messages.jsonl');
        const slackMessagesLogPath = path.join(config.stateDir, 'slack-messages.jsonl');

        // Shared helper: check a messages log file for SUBSTANTIVE agent
        // responses after a timestamp. Filters out system/proxy messages via
        // isSystemOrProxyMessage AND brief acks via isBriefAck — both kinds
        // of messages are non-cancelling from PresenceProxy's perspective.
        //
        // The brief-ack filter is what closes the gap from PR #128: that PR
        // taught the event path (recordAgentMessage) to ignore acks, but the
        // log-reading race guard at PresenceProxy.fireTier didn't share the
        // same classifier. The result was Tier 2 silently cancelling because
        // the ack was on disk. Same isBriefAck export feeds both paths now.
        const checkLogForAgentResponse = (logPath: string, topicId: number, sinceIso: string): boolean => {
          try {
            const content = fs.readFileSync(logPath, 'utf-8');
            const lines = content.trim().split('\n').slice(-50);
            for (const line of lines) {
              try {
                const msg = JSON.parse(line);
                // Slack logs use channelId (string); Telegram logs use topicId (number).
                // For Slack synthetic IDs (negative), match against channelId via the map.
                const matchesTopic = msg.topicId === topicId
                  || (topicId < 0 && msg.channelId && slackChannelToSyntheticId(String(msg.channelId)) === topicId);
                if (matchesTopic && !msg.fromUser && msg.timestamp > sinceIso) {
                  // Non-cancelling agent message kinds: system/proxy
                  // chrome, and brief acks ("On it"). Both leave tier
                  // timers running.
                  const isNonCancelling = isSystemOrProxyMessage(msg.text)
                    || isBriefAck(msg.text);
                  if (isNonCancelling) continue;
                  return true;
                }
              } catch { /* skip malformed lines */ }
            }
            return false;
          } catch {
            return false;
          }
        };

        presenceProxy = new PresenceProxy({
          stateDir: config.stateDir,
          intelligence: sharedIntelligence,
          agentName: config.projectName ?? 'the agent',
          // Resolved default framework so idle/stall detection uses the right
          // pane signals (Codex panes don't match Claude prompt patterns).
          agentFramework: _defaultFramework,
          hasAgentRespondedSince: (topicId, sinceMs) => {
            const sinceIso = new Date(sinceMs).toISOString();
            // Check Telegram log
            if (checkLogForAgentResponse(messagesLogPath, topicId, sinceIso)) return true;
            // Also check Slack log (for Slack synthetic IDs or cross-platform responses)
            if (checkLogForAgentResponse(slackMessagesLogPath, topicId, sinceIso)) return true;
            return false;
          },
          captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
          getSessionForTopic: (topicId) => {
            // Check if this is a Slack synthetic ID
            const slackChId = slackProxyChannelMap.get(topicId);
            if (slackChId && _slackAdapter) {
              return _slackAdapter.getSessionForChannel(slackChId) ?? null;
            }
            return telegram!.getSessionForTopic(topicId);
          },
          isSessionAlive: (name) => sessionManager.isSessionAlive(name),
          sendMessage: async (topicId, text, metadata) => {
            // Check if this is a Slack synthetic ID (negative = Slack channel)
            const slackChannelId = slackProxyChannelMap.get(topicId);
            if (slackChannelId && _slackAdapter) {
              // Never send proxy messages to system channels (dashboard, lifeline)
              if (_slackAdapter.isSystemChannel(slackChannelId)) return;
              // Route directly to Slack channel
              await _slackAdapter.sendToChannel(slackChannelId, text);
              return;
            }

            // Send to Telegram
            const url = `http://localhost:${config.port}/telegram/reply/${topicId}`;
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.authToken}`,
              },
              body: JSON.stringify({ text, metadata }),
            });
            if (!response.ok) {
              throw new Error(`Reply failed: ${response.status}`);
            }

            // Slack standby is now handled directly via its own PresenceProxy wiring
            // (Slack onMessageLogged → synthetic ID → PresenceProxy → sendMessage → Slack channel).
            // No more Telegram→Slack mirroring — that caused standby spam when only Telegram was active.
          },
          getAuthorizedUserIds: () => {
            const ids = config.messaging?.[0]?.config?.authorizedUserIds;
            if (Array.isArray(ids)) return ids;
            const ownerId = config.monitoring?.promptGate?.ownerId;
            return ownerId ? [ownerId] : [];
          },
          getProcessTree: (sessionName) => {
            // Return only genuinely active processes — filter out Claude Code itself
            // and baseline children (MCP servers, caffeinate, etc.) so that
            // PresenceProxy tier 3 falls through to LLM assessment when the session
            // is idle at its prompt. Without this filtering, the Claude node process
            // alone makes tier 3 conclude "working" and skip stall detection.
            const BASELINE_PATTERNS = [
              /\bplaywright-mcp\b/,
              /\bplaywright\/mcp\b/,
              /\bmcp-stdio-entry\b/,
              /\bmcp.*server\b/i,
              /\bcaffeinate\b/,
              /\bnpm exec\b.*mcp/,
              /\bclaude\b/,
              /\bnode\b.*\bclaude\b/,
            ];
            try {
              const panePid = shellExecSync(
                `tmux display-message -t '=${sessionName}' -p '#{pane_pid}' 2>/dev/null`
              ).toString().trim();
              if (!panePid) return [];
              const childPids = shellExecSync(
                `pgrep -P ${panePid} 2>/dev/null`
              ).toString().trim();
              if (!childPids) return [];
              const pids = childPids.split('\n').filter(Boolean).join(',');
              const psOutput = shellExecSync(
                `ps -o pid=,command= -p ${pids} 2>/dev/null`
              ).toString().trim();
              if (!psOutput) return [];
              return psOutput.split('\n').map(line => {
                const match = line.trim().match(/^(\d+)\s+(.+)$/);
                return match ? { pid: parseInt(match[1], 10), command: match[2] } : null;
              }).filter((p): p is { pid: number; command: string } => {
                if (!p) return false;
                return !BASELINE_PATTERNS.some(pattern => pattern.test(p.command));
              });
            } catch {
              return [];
            }
          },
          triggerManualTriage: triageNurse
            ? async (topicId, sessionName) => {
                await triageNurse!.triage(topicId, sessionName, '', Date.now(), 'manual');
              }
            : undefined,
          recoverContextExhaustion: sessionRecovery
            ? async (topicId, sessionName) => {
                const result = await sessionRecovery!.checkAndRecover(topicId, sessionName);
                return { recovered: result.recovered };
              }
            : undefined,
          // Shared per-topic mutex — coordinates with PromiseBeacon.
          acquireProxyMutex: (topicId, holder) => proxyCoordinator.tryAcquire(topicId, holder),
          releaseProxyMutex: (topicId, holder) => proxyCoordinator.release(topicId, holder),
          // BUILD-STALL-VISIBILITY-SPEC Fix 2 — suppress generic standby when
          // a /build heartbeat landed recently on this topic.
          hasRecentBuildHeartbeat: (topicId, windowMs) => proxyCoordinator.hasRecentBuildHeartbeat(topicId, windowMs),
          // Suppress ALL tiers while the RateLimitSentinel owns the voice for
          // this topic's session (server-throttle recovery).
          hasActiveRateLimitRecovery: (topicId) => {
            const slackChId = slackProxyChannelMap.get(topicId);
            const sessionName = (slackChId && _slackAdapter)
              ? _slackAdapter.getSessionForChannel(slackChId)
              : telegram!.getSessionForTopic(topicId);
            return sessionName ? rateLimitSentinel.isRecoveryActive(sessionName) : false;
          },
          // Shared LLM queue (interactive lane) — cross-monitor concurrency
          // and daily-spend-cap with PromiseBeacon.
          sharedLlmQueue,
        });

        // Hook into Telegram's onMessageLogged callback (always active, unlike EventBus which requires a feature flag)
        const existingCallback = telegram.onMessageLogged;
        telegram.onMessageLogged = (entry) => {
          // Call existing callback first (TopicMemory dual-write)
          if (existingCallback) {
            existingCallback(entry);
          }
          // Forward to PresenceProxy
          presenceProxy!.onMessageLogged({
            messageId: entry.messageId,
            channelId: entry.topicId?.toString() ?? '',
            text: entry.text,
            fromUser: entry.fromUser,
            timestamp: entry.timestamp,
            sessionName: entry.sessionName,
            senderName: entry.senderName,
            senderUsername: entry.senderUsername,
            platformUserId: entry.telegramUserId?.toString(),
          });
        };

        // Human-as-Detector: observe inbound HUMAN messages for coherence-break
        // corrections — a correction the user had to make is evidence a guardian
        // failed. Chains the prior callback; best-effort (observe never throws).
        const beforeHadCallback = telegram.onMessageLogged;
        telegram.onMessageLogged = (entry) => {
          if (beforeHadCallback) beforeHadCallback(entry);
          const missSignal = observeInboundMessage(humanAsDetectorLog, entry);
          // ── Usher precision, path (b): the user just had to correct me (a
          // human-as-detector miss). If a recent faded-context nudge on this
          // topic covers what they're correcting, that nudge was a REAL catch I
          // ignored → mark it acted. This is the miss-map → precision-numerator
          // correlation that pairs with path (a). Best-effort (never throws).
          if (missSignal && usherSignalStore) {
            const credited = creditUsherOnMiss(usherSignalStore, missSignal, entry);
            if (credited.length) {
              console.log(`[Usher] ${credited.length} signal(s) marked acted (miss) on topic ${entry.topicId}`);
            }
          }
        };

        // ── Topic-Intent ArcCheck (rung 3 / Layer 3) ────────────────────
        // Pre-send classifier that scans agent drafts against the topic's
        // tracked refs and emits a signal (never blocks) when the draft
        // would contradict a settled item / drift from the active frame /
        // act on an unconfirmed tentative item. Same instance is exposed
        // behind the HTTP route AND consumed in-process by
        // checkOutboundMessage so the MessagingToneGate sees ArcCheck as
        // one more entry in its existing signals fan-in.
        // Spec: docs/specs/topic-intent-arccheck-wiring.md.
        if (sharedIntelligence && (config.topicIntent?.arccheck?.enabled ?? true)) {
          try {
            const { ArcCheck, createArcCheckClassifyFn } = await import('../core/TopicIntentArcCheck.js');
            const { createQueuedIntelligence } = await import('../core/TopicIntentCapture.js');
            const arcCheckIntelligence = createQueuedIntelligence(
              sharedIntelligence,
              (lane, fn, costCents) => sharedLlmQueue.enqueue(lane, fn, costCents),
            );
            const arcCheckClassify = createArcCheckClassifyFn(arcCheckIntelligence);
            topicIntentArcCheck = new ArcCheck(topicIntentStore, arcCheckClassify);
            (globalThis as Record<string, unknown>).__instarTopicIntentArcCheckWired = true;
            console.log(pc.green('  Topic-intent ArcCheck wired (pre-send classifier → tone gate)'));
          } catch (err) {
            console.warn('[TopicIntentArcCheck] init failed:', (err as Error).message);
          }
        }

        // ── Topic-Intent capture loop (rung 0 of continuous-working-awareness) ─
        // The "clerk" that fills the topic-intent store from live conversation so
        // the per-topic briefing + ArcCheck have real material (closes the
        // shipped-but-asleep gap — the store/routes/briefing all existed but
        // nothing ever invoked ingest()). Chains the prior callback; capture is
        // fire-and-forget + degrade-safe so it NEVER blocks or slows delivery.
        // Spec: docs/specs/topic-intent-capture-loop.md.
        if (sharedIntelligence && (config.topicIntent?.capture?.enabled ?? true)) {
          try {
            const { TopicIntentExtractor, createLlmExtractFn } = await import('../core/TopicIntentExtractor.js');
            const { createCaptureLoop, createQueuedIntelligence } = await import('../core/TopicIntentCapture.js');
            // Transport: route every extraction through sharedLlmQueue (background
            // lane → yields to interactive work, respects the daily cap), with the
            // call itself delegating to sharedIntelligence (subscription/REPL-pool,
            // never raw API — acceptance #6).
            const queuedIntelligence = createQueuedIntelligence(
              sharedIntelligence,
              (lane, fn, costCents) => sharedLlmQueue.enqueue(lane, fn, costCents),
            );
            const captureExtractFn = createLlmExtractFn(queuedIntelligence, (reason, topicId) => {
              topicIntentStore.bumpCaptureCounters(
                topicId,
                reason === 'no-intelligence'
                  ? { degraded_no_intelligence: 1 }
                  : { degraded_cap_or_error: 1 },
              );
            });
            const captureExtractor = new TopicIntentExtractor(topicIntentStore, captureExtractFn);
            const captureLoop = createCaptureLoop({
              extractor: captureExtractor,
              store: topicIntentStore,
              topicMemory,
              // Skip capture under sustained quota pressure (load-shedding).
              shouldShed: () => {
                const r = quotaTracker?.getRecommendation();
                return r === 'critical' || r === 'stop';
              },
              // Per-topic runaway guard beyond the pre-filter.
              rateCeiling: { maxPerWindow: 30, windowMs: 60_000 },
            });
            const beforeCaptureCb = telegram.onMessageLogged;
            telegram.onMessageLogged = (entry) => {
              if (beforeCaptureCb) beforeCaptureCb(entry);
              // Fire-and-forget — capture latency must never reach the delivery path.
              void captureLoop({
                messageId: entry.messageId,
                topicId: entry.topicId ?? undefined,
                text: entry.text,
                fromUser: entry.fromUser,
                timestamp: entry.timestamp,
              });
            };
            // Anti-"shipped-but-asleep" marker for the wiring-integrity test.
            (globalThis as Record<string, unknown>).__instarTopicIntentCaptureWired = true;
            console.log(pc.green('  Topic-intent capture loop wired (per-turn extraction → store)'));

            // ── Usher (rung 4) ──────────────────────────────────────────────
            // Signal-only mid-task watcher: chained AFTER capture so it sees the
            // freshly-filed turn, queries the faded tail, and emits re-surface
            // signals to the pull surface. Never injects. Fire-and-forget,
            // degrade-safe. Spec: docs/specs/cwa-usher.md.
            if (usherSignalStore) {
              const { createUsherLoop, createUsherCheckFn } = await import('../core/Usher.js');
              const usherQueued = createQueuedIntelligence(
                sharedIntelligence,
                (lane, fn, costCents) => sharedLlmQueue.enqueue(lane, fn, costCents),
              );
              const usherCheckFn = createUsherCheckFn(usherQueued, (reason) => {
                console.warn(`[Usher] degraded: ${reason}`);
              });
              const usherLoop = createUsherLoop({
                store: topicIntentStore,
                signalStore: usherSignalStore,
                checkFn: usherCheckFn,
                shouldShed: () => {
                  const r = quotaTracker?.getRecommendation();
                  return r === 'critical' || r === 'stop';
                },
                rateCeiling: { maxPerWindow: 20, windowMs: 60_000 },
              });
              const beforeUsherCb = telegram.onMessageLogged;
              telegram.onMessageLogged = (entry) => {
                if (beforeUsherCb) beforeUsherCb(entry);
                void usherLoop({
                  messageId: entry.messageId,
                  topicId: entry.topicId ?? undefined,
                  text: entry.text,
                  fromUser: entry.fromUser,
                  timestamp: entry.timestamp,
                });
              };
              (globalThis as Record<string, unknown>).__instarUsherWired = true;
              console.log(pc.green('  Usher wired (signal-only mid-task re-surface watcher)'));
            }
          } catch (err) {
            console.warn('[TopicIntentCapture] init failed:', (err as Error).message);
          }
        }

        // ── Correction & Preference Learning Sentinel — capture loop (Slice 1b) ─
        // Hot-path capture → distill → CorrectionLedger. VOID fire-and-forget so
        // the async distill NEVER blocks delivery and a thrown distill error
        // NEVER propagates back to the message seam. Constructed ONLY when
        // monitoring.correctionLearning.enabled (Layer-0 classify is the only
        // always-on piece; the loop is dark by default). The sentinel owns its
        // OWN LlmQueue (object opts — the per-sentinel daily cap is real, NOT a
        // fleet ceiling) so a distill burst can never starve PresenceProxy/Usher.
        // Spec: docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md §3.1.
        if (sharedIntelligence && config.monitoring?.correctionLearning?.enabled === true) {
          try {
            const cl = config.monitoring.correctionLearning;
            const { CorrectionLedger } = await import('../monitoring/CorrectionLedger.js');
            const { LlmQueue } = await import('../monitoring/LlmQueue.js');
            const {
              CaptureRing,
              captureAndDistill,
              drainBacklog,
              makeCaptureRateState,
            } = await import('../monitoring/CorrectionCaptureLoop.js');
            const { llmCircuitAvailable } = await import('../core/LlmCircuitBreaker.js');

            const correctionLedger = new CorrectionLedger({
              dbPath: path.join(config.stateDir, 'correction-ledger.db'),
            });
            // Per-sentinel LlmQueue — object opts (do NOT pass a bare number; that
            // is the latent PresenceProxy bug §2). Dedicated daily cap.
            const correctionLlmQueue = new LlmQueue({
              maxConcurrent: cl.llmMaxConcurrent ?? 1,
              maxDailyCents: cl.llmDailyCents ?? 25,
            });
            // Drift-canary sub-budget (Slice 2 NEW-1): a SEPARATE LlmQueue instance
            // with its own (small) daily cap, so the periodic "would this have been
            // a correction?" sampler can never starve the main distill path's cap.
            // Constructed only when the canary is on (it ships dark); when off this
            // is null and the canary path never runs. The separate instance IS the
            // sub-budget (LlmQueue has no per-feature sub-cap, spec §2).
            const driftCanaryLlmQueue = cl.driftCanary === true
              ? new LlmQueue({
                  maxConcurrent: 1,
                  maxDailyCents: cl.driftCanaryDailyCents ?? 5,
                })
              : null;
            void driftCanaryLlmQueue; // reserved for the canary sampler (dark); the
            // budget is provisioned here so enabling the canary cannot regress the
            // main cap. Referenced to satisfy no-unused under the dark default.
            const ring = new CaptureRing({
              captureContextTurns: cl.captureContextTurns ?? 6,
              captureTopicMapMax: cl.captureTopicMapMax ?? 64,
              topicTtlMs: (cl.captureTopicTtlMinutes ?? 60) * 60_000,
            });
            const rateState = makeCaptureRateState();
            // Durable capture-backlog with retry (resilience extension). When the
            // Tier-1 distill is rate-limited/capacity-throttled, the pre-scrubbed
            // capture is PERSISTED here instead of dropped, then drained into the
            // ledger in a later LLM headroom window — so corrections survive
            // sustained throttling. ON when the feature is enabled; maxEntries:0
            // disables it (preserves the old drop-on-throttle behavior).
            const backlogMaxEntries = cl.captureBacklogMaxEntries ?? 200;
            const captureBacklog = backlogMaxEntries > 0
              ? new (await import('../monitoring/CorrectionCaptureBacklog.js')).CorrectionCaptureBacklog({
                  dbPath: path.join(config.stateDir, 'correction-capture-backlog.db'),
                  maxEntries: backlogMaxEntries,
                  maxRetries: cl.captureBacklogMaxRetries ?? 3,
                })
              : null;
            const backlogTtlMs = (cl.captureBacklogTtlHours ?? 24) * 3_600_000;
            const backlogDrainPerTick = cl.captureBacklogDrainPerTick ?? 5;
            // Audit sink — one structured line per capture decision. The rollout
            // evidence filter keys on `correction-loop` in this file.
            const correctionAuditPath = path.join(config.stateDir, 'logs', 'correction-learning-audit.jsonl');
            const correctionAudit = (event: { decision: string; topicId: number | null; detail?: string }) => {
              try {
                fs.mkdirSync(path.dirname(correctionAuditPath), { recursive: true });
                fs.appendFileSync(
                  correctionAuditPath,
                  JSON.stringify({ ts: new Date().toISOString(), origin: 'correction-loop', ...event }) + '\n',
                  { mode: 0o600 },
                );
              } catch { /* @silent-fallback-ok — audit is best-effort */ }
            };

            // Shared distill fn — used by BOTH the hot-path capture and the
            // off-hot-path backlog drainer (same per-sentinel LlmQueue + cap).
            const correctionDistill = (prompt: string) =>
              correctionLlmQueue.enqueue(
                'background',
                () => sharedIntelligence.evaluate(prompt, { model: 'fast', maxTokens: 400, temperature: 0, attribution: { component: 'server:correction-learning' } }), // attribution for /metrics/features
                0.3,
              );

            // Off-hot-path drainer. Single-flight (a `draining` guard prevents an
            // overlapping drain from a near-simultaneous trigger) and fail-open
            // (drainBacklog itself never throws). Skips internally when the LLM
            // circuit is open / shedding (it would just re-fail every entry).
            let draining = false;
            const maybeDrainBacklog = () => {
              if (!captureBacklog || draining) return;
              if (!llmCircuitAvailable()) return; // breaker open — don't even claim.
              draining = true;
              // void: NEVER awaited on any seam — fully detached.
              void (async () => {
                try {
                  await drainBacklog(
                    {
                      backlog: captureBacklog,
                      ledger: correctionLedger,
                      distill: correctionDistill,
                      llmAvailable: () => llmCircuitAvailable(),
                      ttlMs: backlogTtlMs,
                      audit: (e) => correctionAudit({ decision: e.decision, topicId: e.topicId, detail: e.detail }),
                    },
                    backlogDrainPerTick,
                  );
                } finally {
                  draining = false;
                }
              })();
            };

            const beforeCorrectionCb = telegram.onMessageLogged;
            telegram.onMessageLogged = (entry) => {
              if (beforeCorrectionCb) beforeCorrectionCb(entry);
              // Layer 0 (SYNC, free) — classify on the seam. No signal → stop at
              // ~zero cost on the vast majority of messages.
              const verdict = entry.fromUser && entry.text
                ? HumanAsDetectorLog.getInstance().classify(entry.text)
                : null;
              // Fire-and-forget — capture/distill latency must NEVER reach the
              // delivery path. A thrown distill error is caught inside.
              void captureAndDistill(
                {
                  ring,
                  ledger: correctionLedger,
                  distill: correctionDistill,
                  shouldShed: () => {
                    const r = quotaTracker?.getRecommendation();
                    return r === 'critical' || r === 'stop';
                  },
                  rateCeiling: { maxPerWindow: cl.distillPerTopicRatePerMinute ?? 8, windowMs: 60_000 },
                  backlog: captureBacklog,
                  audit: correctionAudit,
                },
                {
                  topicId: entry.topicId ?? null,
                  text: entry.text ?? '',
                  fromUser: !!entry.fromUser,
                  sessionId: entry.sessionName ?? null,
                  deterministicWeight: verdict?.deterministicWeight ?? 0,
                  isLearningSignal: verdict?.learningKind != null,
                },
                rateState,
              ).then((decision) => {
                // DRAIN TRIGGER (off-hot-path): a real distill just succeeded →
                // the LLM has headroom RIGHT NOW, so opportunistically work down
                // the backlog. .then runs AFTER the fire-and-forget capture
                // resolves — it never blocks delivery. Skips internally if the
                // breaker is open.
                if (decision === 'recorded' || decision === 'noise') maybeDrainBacklog();
              }).catch(() => { /* @silent-fallback-ok — capture is fail-open */ });
            };

            // Belt-and-suspenders periodic tick: even with no live captures, a
            // throttle that has since lifted gets drained. Bounded + off-hot-path
            // + skipped while the breaker is open. unref()'d so it never holds the
            // process open. Only armed when the backlog is active.
            if (captureBacklog) {
              const backlogTimer = setInterval(() => maybeDrainBacklog(), 5 * 60_000);
              if (typeof backlogTimer.unref === 'function') backlogTimer.unref();
            }
            (globalThis as Record<string, unknown>).__instarCorrectionLearningWired = true;
            (globalThis as Record<string, unknown>).__instarCorrectionCaptureBacklogWired = !!captureBacklog;
            console.log(pc.green('  Correction & Preference Learning Sentinel wired (capture → distill → ledger; dark by default)'));
          } catch (err) {
            console.warn('[CorrectionLearning] init failed:', (err as Error).message);
          }
        }

        presenceProxy.start();

        // ── PromiseBeacon ────────────────────────────────────────────────
        // Watches beacon-enabled commitments and emits ⏳ heartbeats so the
        // user knows the agent hasn't gone silent on an open promise.
        // Spec: docs/specs/PROMISE-BEACON-SPEC.md
        try {
          const { PromiseBeacon } = await import('../monitoring/PromiseBeacon.js');
          const promiseBeacon = new PromiseBeacon({
            stateDir: config.stateDir,
            commitmentTracker,
            llmQueue: sharedLlmQueue,
            proxyCoordinator,
            captureSessionOutput: (name, lines) => sessionManager.captureOutput(name, lines),
            getSessionForTopic: (topicId) => telegram!.getSessionForTopic(topicId),
            isSessionAlive: (name) => sessionManager.isSessionAlive(name),
            sendMessage: async (topicId, text, metadata) => {
              const url = `http://localhost:${config.port}/telegram/reply/${topicId}`;
              const response = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${config.authToken}`,
                },
                body: JSON.stringify({ text, metadata }),
              });
              if (!response.ok) throw new Error(`Beacon reply failed: ${response.status}`);
            },
            prefix: promiseBeaconCfg.prefix ?? '⏳',
            maxDailyLlmSpendCents: promiseBeaconCfg.maxDailyLlmSpendCents ?? 100,
            sentinelAutoEnable: promiseBeaconCfg.sentinelAutoEnable ?? false,
            quietHours: promiseBeaconCfg.quietHours ?? { start: '22:00', end: '08:00' },
            maxActiveBeacons: promiseBeaconCfg.maxActiveBeacons ?? 20,
          });
          promiseBeacon.start();
          (globalThis as Record<string, unknown>).__instarPromiseBeacon = promiseBeacon;

          // ── "keep watching" resume detector ─────────────────────────────
          // When a user replies on a topic that has any auto-paused beacons,
          // a literal "keep watching" match resumes them. Brittle detector
          // (regex) with no blocking authority — it only triggers the
          // structurally-symmetric /resume endpoint. False-positive cost:
          // one extra heartbeat that re-pauses on next idle cycle.
          const KEEP_WATCHING_RE = /\bkeep[\s-]?watching\b/i;
          const previousTelegramHook = telegram.onMessageLogged;
          telegram.onMessageLogged = (entry) => {
            if (previousTelegramHook) previousTelegramHook(entry);
            if (!entry.fromUser) return;
            if (!entry.topicId) return;
            if (!entry.text || !KEEP_WATCHING_RE.test(entry.text)) return;
            const topicId = entry.topicId;
            const paused = commitmentTracker
              .getActive()
              .filter(c => c.topicId === topicId && c.beaconPaused);
            if (paused.length === 0) return;
            (async () => {
              let resumed = 0;
              for (const c of paused) {
                try {
                  const url = `http://localhost:${config.port}/commitments/${c.id}/resume`;
                  const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${config.authToken}`,
                    },
                  });
                  if (resp.ok) resumed += 1;
                  else console.warn(`[PromiseBeacon] resume call returned ${resp.status} for ${c.id}`);
                } catch (err) {
                  console.warn(`[PromiseBeacon] resume call failed for ${c.id}:`, (err as Error).message);
                }
              }
              let ackText: string;
              if (resumed === paused.length && resumed > 0) {
                ackText = `⏳ resumed ${resumed === 1 ? 'watcher' : `${resumed} watchers`} on this topic.`;
              } else if (resumed > 0) {
                ackText = `⏳ resumed ${resumed} of ${paused.length} watchers — ${paused.length - resumed} didn't resume. Try again or open the dashboard.`;
              } else {
                ackText = `⚠️ couldn't resume the watcher${paused.length === 1 ? '' : 's'} on this topic — try again or open the dashboard.`;
              }
              try {
                const ackUrl = `http://localhost:${config.port}/telegram/reply/${topicId}`;
                await fetch(ackUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.authToken}`,
                  },
                  body: JSON.stringify({
                    text: ackText,
                    metadata: { source: 'promise-beacon', isProxy: true, tier: 1 },
                  }),
                });
              } catch (err) {
                console.warn('[PromiseBeacon] resume ack send failed:', (err as Error).message);
              }
            })();
          };
        } catch (err) {
          console.warn('[PromiseBeacon] init failed:', (err as Error).message);
        }

        // Wire Slack's onMessageLogged into PresenceProxy + TopicMemory (if Slack is active)
        if (_slackAdapter) {
          const existingSlackCallback = _slackAdapter.onMessageLogged;
          _slackAdapter.onMessageLogged = (entry) => {
            if (existingSlackCallback) {
              existingSlackCallback(entry);
            }

            // TopicMemory dual-write (matches Telegram's insertMessage pattern)
            // TopicMemory uses numeric topicId; for Slack we use the synthetic hash
            if (entry.channelId && topicMemory) {
              const synId = slackChannelToSyntheticId(String(entry.channelId));
              topicMemory.insertMessage({
                messageId: typeof entry.messageId === 'number' ? entry.messageId : 0,
                topicId: synId,
                text: entry.text,
                fromUser: entry.fromUser,
                timestamp: entry.timestamp,
                sessionName: entry.sessionName,
                senderName: entry.senderName,
              });
            }

            // Clear stall tracking when agent responds in this channel
            if (!entry.fromUser && entry.channelId) {
              _slackAdapter!.clearStallTracking(String(entry.channelId));
            }

            // Convert Slack channelId to synthetic numeric ID for PresenceProxy
            // Skip system channels (dashboard, lifeline) — they don't have interactive sessions
            if (!entry.channelId) return;
            if (_slackAdapter!.isSystemChannel(String(entry.channelId))) return;
            const syntheticId = slackChannelToSyntheticId(String(entry.channelId));
            presenceProxy!.onMessageLogged({
              messageId: typeof entry.messageId === 'number' ? entry.messageId : parseInt(String(entry.messageId), 10) || 0,
              channelId: syntheticId.toString(),
              text: entry.text,
              fromUser: entry.fromUser,
              timestamp: entry.timestamp,
              sessionName: entry.sessionName,
              senderName: entry.senderName,
              platformUserId: entry.platformUserId != null ? String(entry.platformUserId) : undefined,
            });
          };
          console.log(pc.green('  Presence Proxy wired to Slack'));

          // Wire standby commands for Slack (unstick, quiet, resume, restart)
          _slackAdapter.onStandbyCommand = async (channelId, command, userId) => {
            const syntheticId = slackChannelToSyntheticId(channelId);
            return presenceProxy!.handleCommand(syntheticId, command, parseInt(userId, 10) || 0);
          };

          // Wire triage status for Slack !triage command
          if (triageOrchestrator) {
            _slackAdapter.onGetTriageStatus = (channelId) => {
              const syntheticId = slackChannelToSyntheticId(channelId);
              const ts = triageOrchestrator!.getTriageState(syntheticId);
              if (!ts) return null;
              return {
                active: true,
                classification: ts.classification,
                checkCount: ts.checkCount,
                lastCheck: new Date(ts.lastCheckAt).toISOString(),
              };
            };
          }
        }

        console.log(pc.green('  Presence Proxy enabled (🔭 [Standby])'));
      } catch (err) {
        console.error(`[PresenceProxy] Failed to initialize:`, err);
      }
    }

    // Start CaffeinateManager (prevents macOS system sleep)
    const { CaffeinateManager } = await import('../core/CaffeinateManager.js');
    const caffeinateManager = new CaffeinateManager({ stateDir: config.stateDir });
    caffeinateManager.start();

    // Start SleepWakeDetector (re-validate sessions on wake). The CPU-starvation
    // guard (load-ratio + long-sleep floor + emit cooldown) defaults live in the
    // class so every agent gets the fix on update; config.monitoring.sleepWake
    // can tune them without a migration.
    const { SleepWakeDetector } = await import('../core/SleepWakeDetector.js');
    const sleepWakeCfg = config.monitoring?.sleepWake;
    const sleepWakeDetector = new SleepWakeDetector({
      maxLoadRatio: sleepWakeCfg?.maxLoadRatio,
      longSleepFloorSeconds: sleepWakeCfg?.longSleepFloorSeconds,
      minWakeIntervalMs: sleepWakeCfg?.minWakeIntervalMs,
    });
    // §P0 #9 (SE-8): give the scheduler's wake-reaper a cumulative-sleep view
    // (not the single last sleep event) so a job that spanned multiple sleeps
    // isn't reaped early.
    if (scheduler) {
      scheduler.setCumulativeSleepProvider((a, b) => sleepWakeDetector.getCumulativeSleepMsBetween(a, b));
    }
    sleepWakeDetector.on('wake', async (event: { sleepDurationSeconds: number; timestamp: string }) => {
      console.log(`[SleepWake] Wake detected after ~${event.sleepDurationSeconds}s sleep`);

      // Checkpoint SQLite WAL files to flush stale locks from pre-sleep connections
      try { topicMemory?.checkpoint(); } catch { /* non-critical */ }
      try { semanticMemory?.checkpoint(); } catch { /* non-critical */ }

      // Re-validate tmux sessions
      try {
        const tmuxPath = detectTmuxPath();
        if (tmuxPath) {
          const { execFileSync } = await import('child_process');
          const result = execFileSync(tmuxPath, ['list-sessions'], { encoding: 'utf-8', timeout: 5000 }).trim();
          console.log(`[SleepWake] tmux sessions after wake: ${result.split('\n').length}`);
        }
      } catch {
        console.warn('[SleepWake] tmux check failed after wake');
      }

      // Restart tunnel if configured — disable auto-reconnect first to prevent
      // a cascade of competing reconnection attempts, then forceStop to handle
      // zombie cloudflared processes that may be hung after sleep.
      if (tunnel) {
        try {
          await Promise.race([
            (async () => {
              tunnel.disableAutoReconnect();
              await tunnel.forceStop(5000);
              tunnel.enableAutoReconnect();
              const tunnelUrl = await tunnel.start();
              console.log(`[SleepWake] Tunnel restarted: ${tunnelUrl}`);

              // Re-advertise the mesh URL — a quick tunnel gets a NEW URL after a
              // sleep/wake restart, so the previously-advertised lastKnownUrl is
              // now stale; peers must learn the new one or cross-machine routing
              // silently breaks post-wake.
              if (coordinator.enabled && coordinator.identity) {
                advertiseSelfMeshUrl(
                  coordinator.managers.identityManager,
                  coordinator.identity.machineId,
                  resolveAdvertisedMeshUrl(config.tunnel, tunnelUrl),
                  (m) => console.log(pc.dim(m)),
                );
              }

              // Re-broadcast dashboard URL after tunnel restart (quick tunnels get new URL)
              if (tunnelUrl) {
                const tunnelType = config.tunnel?.type || 'quick';
                if (telegram) {
                  await telegram.broadcastDashboardUrl(tunnelUrl, tunnelType as 'quick' | 'named').catch(() => {});
                }
                if (_slackAdapter) {
                  await _slackAdapter.broadcastDashboardUrl(tunnelUrl).catch(() => {});
                }
              }
            })(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('Tunnel restart timed out after 15s')), 15_000)
            ),
          ]);
        } catch (err) {
          console.error(`[SleepWake] Tunnel restart failed:`, err);
          // Re-enable auto-reconnect even on failure so it can self-heal
          tunnel.enableAutoReconnect();
        }
      }

      // Reconnect Slack after sleep — WebSocket connections die during sleep
      // and the close-handler reconnect can silently fail if the network isn't
      // fully up yet. Proactive reconnect after a short delay is more reliable.
      if (slackAdapter) {
        // Wait 2s for network to stabilize after wake before reconnecting
        setTimeout(async () => {
          try {
            await slackAdapter!.reconnect();
            console.log('[SleepWake] Slack reconnected');
          } catch (err) {
            console.error('[SleepWake] Slack reconnect failed:', (err as Error).message);
          }
        }, 2000);
      }

      // Reap stuck job runs — sessions that were running when the host slept
      // can't complete normally because their tmux process was suspended.
      // Without this, runs leak as `pending` until the next claim TTL fires
      // (or indefinitely, if the supervising scheduler tick is also missed).
      let reapResult: { reaped: string[]; skipped: number } = { reaped: [], skipped: 0 };
      try {
        if (scheduler) {
          reapResult = await scheduler.reapStuckRuns(event);
        }
      } catch (err) {
        console.error('[SleepWake][reaper] unexpected error:', err);
      }

      // Notify via batcher — wake events are informational, not urgent
      // Only notify for long sleeps (>5 min) — short sleeps are routine and not worth mentioning
      if (event.sleepDurationSeconds > 300 || reapResult.reaped.length > 0) {
        const mins = Math.round(event.sleepDurationSeconds / 60);
        const reapNote = reapResult.reaped.length > 0
          ? ` Reaped ${reapResult.reaped.length} stuck job(s): ${reapResult.reaped.join(', ')}.`
          : '';
        notify('DIGEST', 'system',
          `Machine woke up after ${mins > 60 ? `${Math.round(mins / 60)}h` : `${mins}m`} of sleep.${reapNote} Everything's reconnected and running.`
        );
      }
    });
    sleepWakeDetector.start();

    // Project Map + Coherence Gate — spatial awareness and pre-action verification
    const projectMapper = new ProjectMapper({ projectDir: config.projectDir, stateDir: config.stateDir });
    try {
      projectMapper.generateAndSave();
      console.log(pc.green('  Project map generated'));
    } catch (err) {
      // @silent-fallback-ok — project map non-critical
      console.error(`  Project map generation failed (non-critical): ${err instanceof Error ? err.message : err}`);
    }

    // Self-Knowledge Tree — tree-based agent self-knowledge with LLM triage
    let selfKnowledgeTree: SelfKnowledgeTree | undefined;
    let coverageAuditor: CoverageAuditor | undefined;
    try {
      selfKnowledgeTree = new SelfKnowledgeTree({
        projectDir: config.projectDir,
        stateDir: config.stateDir,
        intelligence: sharedIntelligence ?? null,
        memoryIndex: semanticMemory ?? undefined,
      });
      coverageAuditor = new CoverageAuditor(config.projectDir, config.stateDir);
      _selfKnowledgeTree = selfKnowledgeTree;

      const treeConfig = selfKnowledgeTree.getConfig();
      if (treeConfig) {
        const totalNodes = treeConfig.layers.reduce((s: number, l: { children: unknown[] }) => s + l.children.length, 0);
        console.log(pc.green(`  Self-knowledge tree loaded (${totalNodes} nodes)`));
      } else {
        console.log(pc.dim('  Self-knowledge tree: not generated yet (run instar init or doctor)'));
      }
    } catch (err) {
      // @silent-fallback-ok — self-knowledge tree non-critical at startup
      console.error(`  Self-knowledge tree init failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Capability Map — fractal self-knowledge for agent introspection
    const capabilityMapper = new CapabilityMapper({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      projectName: config.projectName,
      version: config.version || '0.0.0',
      port: config.port,
    });
    // Initial map generation (async, non-blocking)
    capabilityMapper.refresh().then(() => {
      console.log(pc.green('  Capability map generated'));
    }).catch((err: Error) => {
      // @silent-fallback-ok — capability map non-critical at startup
      console.error(`  Capability map generation failed (non-critical): ${err.message}`);
    });

    const scopeVerifier = new ScopeVerifier({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      projectName: config.projectName,
    });
    // Load any persisted topic-project bindings
    scopeVerifier.loadTopicBindings();

    // Context Hierarchy — tiered context loading for session efficiency
    const contextHierarchy = new ContextHierarchy({
      stateDir: config.stateDir,
      projectDir: config.projectDir,
      projectName: config.projectName,
    });
    const ctxResult = contextHierarchy.initialize();
    if (ctxResult.created.length > 0) {
      console.log(pc.green(`  Context hierarchy: ${ctxResult.created.length} segments created`));
    }

    // Canonical State — registry-first state management
    const canonicalState = new CanonicalState({ stateDir: config.stateDir });
    const stateResult = canonicalState.initialize(config.projectName, config.projectDir);
    if (stateResult.created.length > 0) {
      console.log(pc.green(`  Canonical state: ${stateResult.created.length} registries created`));
    }

    // External Operation Safety — gate, sentinel, trust
    const extOpsConfig = config.externalOperations;
    const extOpsEnabled = extOpsConfig?.enabled !== false;
    const autonomyLevel = config.agentAutonomy?.level ?? 'collaborative';
    const autonomyProfile = AUTONOMY_PROFILES[autonomyLevel] ?? AUTONOMY_PROFILES.collaborative;
    const operationGate = extOpsEnabled ? new ExternalOperationGate({
      stateDir: config.stateDir,
      autonomyDefaults: autonomyProfile,
      services: (extOpsConfig?.services ?? {}) as Record<string, import('../core/ExternalOperationGate.js').ServicePermissions>,
      readOnlyServices: extOpsConfig?.readOnlyServices ?? [],
    }) : undefined;
    const sentinel = extOpsEnabled && extOpsConfig?.sentinel?.enabled !== false
      ? new MessageSentinel({ intelligence: sharedIntelligence })
      : undefined;
    const adaptiveTrust = extOpsEnabled ? new AdaptiveTrust({
      stateDir: config.stateDir,
    }) : undefined;
    if (extOpsEnabled) {
      const sentinelMode = sentinel
        ? (sharedIntelligence ? 'LLM-supervised' : 'fast-path only')
        : 'off';
      console.log(pc.green(`  External operation safety: gate=${autonomyLevel}, sentinel=${sentinelMode}, trust=on`));
    }

    // Adaptive Autonomy — unified profile coordinator
    const autonomyManager = new AutonomyProfileManager({
      stateDir: config.stateDir,
      config,
      adaptiveTrust: adaptiveTrust ?? null,
      evolution: evolution ?? null,
    });
    console.log(pc.green(`  Autonomy profile: ${autonomyManager.getProfile()}`));

    // Trust Elevation Tracker — monitors acceptance rates and surfaces upgrade opportunities
    const trustElevationTracker = new TrustElevationTracker({
      stateDir: config.stateDir,
    });

    // Autonomous Evolution — auto-approval and auto-implementation of proposals
    const autonomousEvolution = new AutonomousEvolution({
      stateDir: config.stateDir,
      enabled: autonomyManager.getResolvedState().evolutionApprovalMode === 'autonomous',
    });

    // Dispatch Scope Enforcer — scope tiers for dispatch execution
    const dispatchScopeEnforcer = new DispatchScopeEnforcer();

    // Trust Recovery — recovery path after trust incidents
    const trustRecovery = extOpsEnabled ? new TrustRecovery({
      stateDir: config.stateDir,
    }) : undefined;

    // ── Adaptive Autonomy Wiring ──────────────────────────────────────
    // Wire the new modules together so they exchange events at runtime.

    // 1. AdaptiveTrust ↔ TrustRecovery
    //    When trust drops (incident), record in TrustRecovery.
    //    When operations succeed post-incident, increment recovery counter.
    if (adaptiveTrust && trustRecovery) {
      adaptiveTrust.setTrustRecovery(trustRecovery);
    }

    // 2. AutoDispatcher ↔ DispatchScopeEnforcer
    //    Before executing a dispatch, check scope permissions against current autonomy profile.
    if (autoDispatcher) {
      autoDispatcher.setScopeEnforcer(dispatchScopeEnforcer, autonomyManager);
    }

    // 3. EvolutionManager ↔ TrustElevationTracker + AutonomousEvolution
    //    Proposal decisions feed trust elevation tracking.
    //    Autonomous mode uses AutonomousEvolution for auto-implementation.
    evolution.setAdaptiveAutonomyModules({
      trustElevationTracker,
      autonomousEvolution,
      autonomyManager,
    });

    // Wire sentinel into Telegram message flow — intercepts BEFORE session routing.
    // Must be wired AFTER sentinel is created but BEFORE server starts.
    if (sentinel && telegram) {
      telegram.onSentinelIntercept = async (text: string, _topicId: number) => {
        const classification = await sentinel.classify(text);
        if (classification.category === 'emergency-stop' || classification.category === 'pause') {
          return {
            category: classification.category,
            action: classification.action as { type: string; message?: string },
            reason: classification.reason,
          };
        }
        return null; // Normal messages pass through
      };
      telegram.onSentinelKillSession = (sessionName: string) => {
        // Save resume UUID before killing so respawn can --resume
        if (_topicResumeMap) {
          try {
            const sessions = sessionManager.listRunningSessions();
            const session = sessions.find(s => s.tmuxSession === sessionName);
            const uuid = _topicResumeMap.findUuidForSession(sessionName, session?.claudeSessionId ?? undefined);
            if (uuid) {
              const topicSessions = telegram.getAllTopicSessions();
              for (const [topicId, sessName] of topicSessions) {
                if (sessName === sessionName) {
                  _topicResumeMap.save(topicId, uuid, sessionName);
                  console.log(`[sentinel] Saved resume UUID ${uuid} for topic ${topicId} before kill`);
                  break;
                }
              }
            }
          } catch { /* best effort */ }
        }
        return sessionManager.killSession(sessionName);
      };
      telegram.onSentinelPauseSession = (sessionName: string) => {
        // Save resume UUID so if the session dies during pause, respawn can --resume
        if (_topicResumeMap) {
          try {
            const sessions = sessionManager.listRunningSessions();
            const session = sessions.find(s => s.tmuxSession === sessionName);
            const uuid = _topicResumeMap.findUuidForSession(sessionName, session?.claudeSessionId ?? undefined);
            if (uuid) {
              const topicSessions = telegram.getAllTopicSessions();
              for (const [topicId, sessName] of topicSessions) {
                if (sessName === sessionName) {
                  _topicResumeMap.save(topicId, uuid, sessionName);
                  console.log(`[sentinel] Saved resume UUID ${uuid} for topic ${topicId} on pause`);
                  break;
                }
              }
            }
          } catch { /* best effort */ }
        }
      };
      console.log(pc.green('  Sentinel wired into Telegram message flow'));
    }

    // Inter-Agent Messaging — structured communication between sessions
    const messageStore = new MessageStore(path.join(config.stateDir, 'messages'));
    await messageStore.initialize();
    const threadResumeMap = new ThreadResumeMap(config.stateDir, config.stateDir);
    // Threadline Phase 1 keystone: the Conversation single-source-of-truth +
    // the warrants-a-reply gate. The gate runs once at the relay inbound funnel
    // (below), upstream of all three routing branches, with turn/novelty state
    // living on the Conversation (the one-shot worker can't self-police a loop).
    const conversationStore = new ConversationStore(config.stateDir);
    const warrantsReplyGate = new WarrantsReplyGate({ intelligence: sharedIntelligence });
    // CMT-509 §2: surface PARENTLESS Threadline conversations into a single
    // dedicated topic so a peer reaching out cold is visible (not an invisible
    // side channel). Topic-bound conversations surface via TopicLinkageHandler.
    const collaborationSurfacer = telegram
      ? new CollaborationSurfacer({ telegram, stateDir: config.stateDir })
      : undefined;
    // CMT-567: one shared BriefDeps for the "open this" LLM topic-name + summary.
    // Built once here (all three inputs in scope) and threaded to BOTH getHubDeps
    // closures AND the AgentServer ctx, so the HTTP route + the structural
    // intercept share one construction. Any null sub-dep degrades to template/slug.
    const briefDeps: import('../threadline/openConversationBrief.js').BriefDeps = {
      observability: threadlineObservability ?? null,
      llmQueue: sharedLlmQueue ?? null,
      intelligence: sharedIntelligence ?? null,
    };
    const messageFormatter = new MessageFormatter();
    const tmuxBin = config.sessions.tmuxPath;
    const tmuxOps: TmuxOperations = {
      getForegroundProcess(tmuxSession: string): string {
        try {
          return execFileSync(tmuxBin, ['list-panes', '-t', `=${tmuxSession}:`, '-F', '#{pane_current_command}'], {
            encoding: 'utf-8', timeout: 5000,
          }).trim().split('\n')[0] || 'unknown';
        } catch { /* @silent-fallback-ok — tmux query, delivery layer handles unknown */ return 'unknown'; }
      },
      isSessionAlive(tmuxSession: string): boolean {
        return sessionManager.isSessionAlive(tmuxSession);
      },
      hasActiveHumanInput(_tmuxSession: string): boolean {
        // Agent sessions don't have human input — safe to inject
        return false;
      },
      sendKeys(tmuxSession: string, text: string): boolean {
        try {
          const target = `=${tmuxSession}:`;
          execFileSync(tmuxBin, ['send-keys', '-t', target, '-l', text], { encoding: 'utf-8', timeout: 5000 });
          execFileSync(tmuxBin, ['send-keys', '-t', target, 'Enter'], { encoding: 'utf-8', timeout: 5000 });
          return true;
        } catch { /* @silent-fallback-ok — send-keys boolean return */ return false; }
      },
      getOutputLineCount(tmuxSession: string): number {
        try {
          const output = execFileSync(tmuxBin, ['capture-pane', '-t', `=${tmuxSession}:`, '-p'], {
            encoding: 'utf-8', timeout: 5000,
          });
          return output.split('\n').length;
        } catch { /* @silent-fallback-ok — capture-pane line count, 0 triggers inline delivery */ return 0; }
      },
    };
    const messageDelivery = new MessageDelivery(messageFormatter, tmuxOps);
    const machineId = coordinator.identity?.machineId ?? os.hostname();
    // Build cross-machine deps if multi-machine is enabled
    const crossMachineDeps = coordinator.enabled && coordinator.identity
      ? {
          identityManager: coordinator.managers.identityManager,
          signingKeyPem: localSigningKeyPem,
          nonceStore: coordinator.managers.nonceStore,
          securityLog: coordinator.managers.securityLog,
        }
      : undefined;
    const messageRouter = new MessageRouter(messageStore, messageDelivery, {
      localAgent: config.projectName,
      localMachine: machineId,
      serverUrl: `http://localhost:${config.port}`,
    }, crossMachineDeps);
    // Generate/persist agent token for cross-agent auth (idempotent — reuses existing token)
    const agentToken = generateAgentToken(config.projectName);

    // Pick up any messages dropped while this agent was offline
    const dropResult = await pickupDroppedMessages(config.projectName, messageStore);
    const dropSummary = dropResult.ingested > 0
      ? ` | picked up ${dropResult.ingested} dropped message(s)`
      : '';
    if (dropResult.rejected > 0) {
      console.warn(pc.yellow(`  Messaging: rejected ${dropResult.rejected} dropped message(s): ${dropResult.rejections.map(r => r.reason).join(', ')}`));
    }

    // Pick up any messages received via git-sync while offline (Phase 4: cross-machine)
    const localMachineId = coordinator.identity?.machineId;
    if (localMachineId) {
      const gitSyncResult = await pickupGitSyncMessages({
        localMachineId,
        stateDir: config.stateDir,
        store: messageStore,
        verifySignature: crossMachineDeps
          ? (envelope) => messageRouter.verifyInboundSignature(envelope)
          : undefined,
      });
      if (gitSyncResult.ingested > 0) {
        console.log(pc.green(`  Git-sync: picked up ${gitSyncResult.ingested} cross-machine message(s)`));
      }
      if (gitSyncResult.rejected > 0) {
        console.warn(pc.yellow(`  Git-sync: rejected ${gitSyncResult.rejected} message(s): ${gitSyncResult.rejections.map(r => r.reason).join(', ')}`));
      }
    }

    // Start delivery retry manager for automatic retries, watchdog, and TTL expiry
    const retryManager = new DeliveryRetryManager(messageStore, messageDelivery, {
      agentName: config.projectName,
      onEscalate: (envelope, reason) => {
        notify('IMMEDIATE', 'messaging', `Message escalation: ${reason}\n  From: ${envelope.message.from.agent}\n  Subject: ${envelope.message.subject}`);
      },
    });
    retryManager.start();

    // Session summary sentinel for intelligent routing (Phase 2)
    const { SessionSummarySentinel } = await import('../messaging/SessionSummarySentinel.js');
    const summarySentinel = new SessionSummarySentinel({
      stateDir: config.stateDir,
      getActiveSessions: () => sessionManager.listRunningSessions(),
      captureOutput: (tmuxSession: string) => {
        // RULE 3: EXEMPT — this is raw byte capture (the whole pane), not state parsing.
        // The output is handed verbatim to the SummarySentinel (LLM-backed) which is the
        // authority that interprets it. No structural format is parsed here; per
        // signal-vs-authority, this is a signal producer with no blocking authority.
        try {
          const tmuxBin = detectTmuxPath();
          if (!tmuxBin) return null;
          const output = execFileSync(tmuxBin, ['capture-pane', '-t', `=${tmuxSession}:`, '-p'], {
            encoding: 'utf-8', timeout: 5000,
          });
          return output;
        } catch { return null; } // @silent-fallback-ok — tmux capture-pane for sentinel
      },
    });
    summarySentinel.start();
    messageRouter.setSummarySentinel(summarySentinel);

    // On-demand session spawning for message delivery (Phase 5)
    // §4.4: spawn knobs are read from config.threadline.spawn — see
    // ThreadlineSpawnConfig in core/types.ts. All fields are optional and
    // fall through to manager-level defaults if absent.
    const spawnConfig = config.threadline?.spawn;
    // Forward-declared `let` so the onDrainReady callback can reference the
    // manager it belongs to (for re-entrant evaluate() calls during drain).
    let spawnManager: SpawnRequestManager;
    spawnManager = new SpawnRequestManager({
      maxSessions: config.sessions.maxSessions ?? 5,
      // Live accessor — read config on every admission check so operators
      // raising sessions.maxSessions don't have to rebuild the manager.
      // Resolves the split-brain where /status reflected the new cap but
      // spawn denials kept reporting the constructor value (codex-instar
      // audit Item 2). Reads the canonical key first; if absent, falls back
      // to the legacy top-level maxSessions for older configs.
      getMaxSessions: () => config.sessions?.maxSessions
        ?? (config as { maxSessions?: number }).maxSessions
        ?? 5,
      getActiveSessions: () => sessionManager.listRunningSessions(),
      spawnSession: async (prompt, opts) => {
        // Warm-session A2A (Arch Y): when the SpawnRequest is flagged interactive,
        // launch a PERSISTENT (keep-alive) interactive worker instead of the
        // headless one-shot `claude -p`. The grounded prompt is delivered as the
        // worker's FIRST turn (after-ready inject), and the worker stays alive so
        // follow-ups inject into the same session. The MCP/permission flag set
        // matches the `-p` path: claude interactive keeps the PROJECT MCP (where
        // threadline_send lives) under --dangerously-skip-permissions, and codex
        // interactive launches with --dangerously-bypass-approvals-and-sandbox +
        // the per-agent threadline MCP (the bypass the `-p` codexAllowMcpTools
        // selects) — so threadline_send is available either way.
        if (opts?.interactive) {
          const warmName = `msg-warm-${Date.now()}`;
          // Framework-GENERAL: the warm worker runs in the LOCAL agent's
          // framework (claude-code / codex-cli / gemini-cli), NOT hardcoded
          // Claude. spawnInteractiveSession + frameworkSessionLaunch compose the
          // right argv + MCP/permission flags per framework (claude keeps PROJECT
          // MCP under --dangerously-skip-permissions; codex launches under
          // --dangerously-bypass-approvals-and-sandbox with its per-agent
          // threadline MCP) so threadline_send works regardless of framework.
          // A2A reply threads have no topic, so the agent default framework
          // applies (mirrors resolveTopicFramework's own fallback).
          const tmuxSession = await sessionManager.spawnInteractiveSession(prompt, warmName, {
            framework: _defaultFramework,
            // Deterministic conversation id for lossless eviction→resume (#746).
            // frameworkSessionLaunch maps this per framework: claude-code pins
            // `--session-id`; codex/gemini ignore it (they resume by their own
            // mechanism). NOT a Claude assumption — it's the abstraction's job.
            sessionId: opts?.sessionId,
          });
          // spawnInteractiveSession returns the tmux name; resolve the instar
          // session id from the running set so the warm callback returns the
          // slice-2 {sessionId, tmuxSession} shape spawnWarmThread expects.
          const running = sessionManager.listRunningSessions();
          const rec = running.find(s => s.tmuxSession === tmuxSession);
          return { sessionId: rec?.id ?? tmuxSession, tmuxSession };
        }
        const session = await sessionManager.spawnSession({
          name: `msg-spawn-${Date.now()}`,
          prompt,
          model: opts?.model as import('../core/types.js').ModelTier | undefined,
          maxDurationMinutes: opts?.maxDurationMinutes,
          // §4.5: honor SpawnRequestManager's provenance tag so drain-spawned
          // sessions are distinguishable from inline-spawned ones in logs/stream.
          triggeredBy: opts?.triggeredBy ?? 'spawn-request',
          // This is the Threadline inbound-reply spawn: the worker must call
          // the threadline_send MCP tool to reply, which a codex worker can only
          // do under full bypass (codex cancels MCP calls in any sandbox). Jobs
          // do NOT set this and stay sandboxed. Bounded: Threadline only accepts
          // messages from trusted agents.
          codexAllowMcpTools: true,
          // Threadline A2A continuity: forward the conversation-id intent so a
          // claude-code A2A reply spawn sets (--session-id) a deterministic
          // transcript on a fresh thread, or resumes (--resume) the prior
          // transcript on a follow-up. Both undefined on every non-Threadline
          // spawn, so existing behavior is unaffected.
          sessionId: opts?.sessionId,
          resumeSessionId: opts?.resumeSessionId,
        });
        // Return BOTH ids: spawnNewThread persists `tmuxSession` as the resume
        // entry's sessionName (the REAL `echo-msg-spawn-<ts>`), so live-inject /
        // resume-while-alive and onSessionComplete's getBySessionName can find the
        // running session. Returning only the bare id stamped a useless fallback
        // name and made every A2A follow-up cold-spawn (the continuity break).
        return { sessionId: session.id, tmuxSession: session.tmuxSession };
      },
      isMemoryPressureHigh: memoryMonitor
        ? () => {
            const state = memoryMonitor!.getState();
            return state.state === 'critical' || state.state === 'elevated';
          }
        : undefined,
      onEscalate: (request, reason) => {
        notify('IMMEDIATE', 'messaging', `Spawn escalation: ${reason}\n  Requester: ${request.requester.agent}\n  Target: ${request.target.agent}`);
      },
      // §4.5: emit degradation breadcrumbs on edge transitions.
      onDegradation: (event) => {
        try {
          const reporter = DegradationReporter.getInstance();
          if (event.kind === 'spawn-penalty-tripped') {
            reporter.report({
              feature: 'Threadline.SpawnPenalty',
              primary: `Open spawn slot for peer "${event.agent}"`,
              fallback: `Spawn blocked for ${Math.round(event.penaltyMs / 1000)}s after ${event.consecutiveFailures} consecutive agent-attributable failures`,
              reason: `Peer "${event.agent}" tripped the consecutive-failure penalty (3 strikes)`,
              impact: 'Peer cannot spawn sessions until penalty clears. Successful inbound spawn from a different peer is unaffected.',
            });
          } else if (event.kind === 'spawn-infra-degraded') {
            reporter.report({
              feature: 'Threadline.SpawnInfraDegraded',
              primary: `Full queue admission (cap 10) for peer "${event.agent}"`,
              fallback: `Degraded admission (cap ${spawnConfig?.degradedMaxQueuedPerAgent ?? 1}) for ${Math.round(event.degradationMs / 60_000)}min`,
              reason: `Peer "${event.agent}" tripped the infra-failure soft limiter (${event.failureCount} non-attributable failures in 10min)`,
              impact: 'Peer\'s queue depth is capped; older messages are dropped. No blame attribution.',
            });
          }
        } catch (err) {
          console.warn(`[spawn-manager] degradation reporter failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      // §4.4: optional knobs from config.
      cooldownMs: spawnConfig?.cooldownMs,
      maxDrainsPerTick: spawnConfig?.maxDrainsPerTick,
      maxEnvelopeBytes: spawnConfig?.maxEnvelopeBytes,
      maxGlobalQueued: spawnConfig?.maxGlobalQueued,
      degradedMaxQueuedPerAgent: spawnConfig?.degradedMaxQueuedPerAgent,
      // §4.4 commit 2 + §4.5: drain-loop consumer wiring.
      // When the drain loop finds an agent ready (cooldown cleared + queued
      // messages present), this callback re-invokes evaluate() with a
      // synthetic SpawnRequest tagged `triggeredBy: 'spawn-request-drain'`.
      // The real queued context is reattached by SpawnRequestManager.evaluate
      // via its internal drainQueue() call. Stub session/machine values:
      // requester.session/machine isn't preserved per-message — those fields
      // are only used in the spawn prompt template for display.
      onDrainReady: async (agent: string) => {
        try {
          const result = await spawnManager.evaluate({
            requester: { agent, session: 'drain', machine: 'drain' },
            target: { agent: config.projectName, machine: os.hostname() },
            reason: `Drain re-attempt for queued messages from ${agent}`,
            priority: 'medium',
            triggeredBy: 'spawn-request-drain',
          });
          if (!result.approved) {
            console.log(`[spawn-manager] drain re-attempt for ${agent} not approved: ${result.reason}`);
          }
        } catch (err) {
          console.warn(`[spawn-manager] drain re-attempt for ${agent} threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    // §4.4 kill switch: drain loop runs unless explicitly disabled in config.
    // Wired here so emergency rollback is a config flip, not a code change.
    if (spawnConfig?.drainEnabled !== false) {
      spawnManager.start();
      console.log(`[spawn-manager] drain loop started (tick=${spawnManager.getDrainTickMs()}ms)`);
    } else {
      console.log('[spawn-manager] drain loop disabled by config.threadline.spawn.drainEnabled=false');
    }

    // Warm-Session A2A (Arch Y, dark-ship) — keep each A2A reply thread's session
    // alive between messages so follow-ups inject into the live worker instead of
    // cold-spawning. Resolved via the developmentAgent gate: `enabled ?? !!dev` →
    // LIVE on Echo, DARK on the fleet. The pool is null when disabled, so the
    // ThreadlineRouter falls back to the proven cold-spawn path byte-for-byte.
    const warmCfg = config.threadline?.warmSessionA2A;
    const warmEnabled = warmCfg?.enabled ?? !!config.developmentAgent;
    const warmSessionPool = warmEnabled
      ? new WarmSessionPool({
          globalCap: warmCfg?.globalCap ?? 3,
          perPeerCap: warmCfg?.perPeerCap ?? 1,
          ttlMs: warmCfg?.ttlMs ?? 600000,
        })
      : null;
    const warmTrustFloor = warmCfg?.trustFloor ?? 'verified';
    // Server-owned kill primitive: resolve the tmux NAME → instar session id →
    // killSession (sessions are filed by id, not tmux name). Used for cap-eviction
    // on admit and the periodic reap tick. Never throws to the caller.
    const killWarmSessionByName = (sessionName: string): void => {
      try {
        const rec = sessionManager.listRunningSessions().find(s => s.tmuxSession === sessionName);
        if (rec) sessionManager.killSession(rec.id);
        else console.log(`[warm-session] kill requested for ${sessionName} but no running session matched (already gone?)`);
      } catch (err) {
        console.warn(`[warm-session] kill ${sessionName} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    if (warmEnabled) {
      console.log(`[warm-session] A2A keep-alive ENABLED (globalCap=${warmCfg?.globalCap ?? 3}, perPeerCap=${warmCfg?.perPeerCap ?? 1}, ttlMs=${warmCfg?.ttlMs ?? 600000}, trustFloor=${warmTrustFloor})`);
    }

    // Threadline Router — handles threaded cross-agent conversations via relay
    const threadlineRouter = new ThreadlineRouter(
      messageRouter, spawnManager, threadResumeMap, messageStore,
      { localAgent: config.projectName, localMachine: os.hostname() },
      null, // autonomyGate
      messageDelivery, // PR-4: live-session injection path
      undefined, // onLedgerEvent (wired below via registerLedgerEmitters if present)
      undefined, // nowFn
      warmSessionPool, // Warm-Session A2A (null when disabled)
      warmEnabled,
      warmTrustFloor,
      warmEnabled ? killWarmSessionByName : null,
    );

    // Warm-Session A2A reap tick — kill warm sessions idle past their TTL so a
    // flood can't pin processes. Gated on warmEnabled; .unref() so it never holds
    // the process open; cleared on shutdown. Eviction is lossless (the next
    // message resumes via #746).
    let warmReapTimer: ReturnType<typeof setInterval> | null = null;
    if (warmEnabled && warmSessionPool) {
      warmReapTimer = setInterval(() => {
        try {
          const expired = warmSessionPool.reapExpired();
          for (const rec of expired) {
            console.log(`[warm-session] reaping idle warm session ${rec.sessionName} (thread ${rec.threadId})`);
            killWarmSessionByName(rec.sessionName);
          }
        } catch (err) {
          console.warn(`[warm-session] reap tick failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, 60_000);
      warmReapTimer.unref();
    }
    sessionManager.on('sessionComplete', (session: import('../core/types.js').Session) => {
      const sessionName = session.tmuxSession || session.name;
      if (!sessionName) return;
      // A2A Coherence Layer 1 (the continuity linchpin): persist the AUTHORITATIVE Claude
      // transcript UUID (`session.claudeSessionId`, populated from Claude session-hook events),
      // NOT `session.id` (the SessionManager/tmux id). The old `session.id || claudeSessionId`
      // stamped the tmux id, which `ThreadResumeMap.get()`'s `jsonlExists()` check can never
      // resolve — so every entry was nulled and every inbound cold-spawned a memoryless session
      // (spec §3, B1). Passing only `claudeSessionId` means: present → a resumable entry is
      // saved; absent (hook not yet fired) → `onSessionComplete` leaves the existing uuid intact
      // (it still demotes via sessionName) and `get()` fails open to a fresh respawn. Never the
      // tmux id. (THREADLINE-A2A-COHERENCE-SPEC.md Layer 1.)
      const result = threadlineRouter.onSessionComplete(sessionName, session.claudeSessionId);
      if (result.demoted > 0 || result.skippedAwaitingReply > 0) {
        console.log(
          `[ThreadlineRouter] sessionComplete ${sessionName}: demoted ${result.demoted} thread(s), skipped ${result.skippedAwaitingReply} awaiting-reply thread(s)`,
        );
      }
    });

    // A2A Coherence Layer 4 — silence-breaker check-ins (THREADLINE-A2A-COHERENCE-SPEC).
    // Ships DARK (config.threadline.a2aCheckIn.enabled=false). When enabled, a cadence timer
    // posts a brief conversational "still talking to <peer>" to the bound topic after the
    // operator has heard nothing for the configured interval (default 5-10 min). Summaries run
    // on the shared LlmQueue BACKGROUND lane, are credential-redacted + attributed +
    // output-guarded, and never fire when there's nothing worth saying. start() is a no-op
    // when disabled, so this is inert until the operator opts in.
    const a2aCheckInCfg = (config.threadline as { a2aCheckIn?: { enabled?: boolean; heartbeatEnabled?: boolean; heartbeatIntervalMs?: number } } | undefined)?.a2aCheckIn;
    if (a2aCheckInCfg?.enabled && _sharedIntelligence && telegram) {
      const { createA2ACheckInScheduler } = await import('../threadline/A2ACheckInScheduler.js');
      const intelligence = _sharedIntelligence;
      const tg = telegram;
      const a2aCheckInScheduler = createA2ACheckInScheduler({
        config: {
          enabled: true,
          heartbeatEnabled: a2aCheckInCfg.heartbeatEnabled ?? false,
          heartbeatIntervalMs: a2aCheckInCfg.heartbeatIntervalMs ?? 420_000,
        },
        listActiveThreads: () =>
          threadResumeMap
            .listActive()
            .map(({ threadId, entry }) => ({ threadId, peerName: entry.remoteAgent ?? 'peer', topicId: entry.originTopicId }))
            .filter((t): t is { threadId: string; peerName: string; topicId: number } => typeof t.topicId === 'number'),
        summarize: (prompt) => sharedLlmQueue.enqueue('background', () => intelligence.evaluate(prompt, { model: 'fast', attribution: { component: 'server:a2a-checkin' } })), // attribution for /metrics/features
        surface: async ({ topicId, body }) => {
          if (typeof topicId === 'number') await tg.sendToTopic(topicId, body);
        },
        getHistory: async (threadId) => {
          try {
            const [inbound, outbound] = await Promise.all([
              messageStore.queryInbox(config.projectName, { threadId }),
              messageStore.queryOutbox(config.projectName, { threadId }),
            ]);
            return [...inbound, ...outbound]
              .sort((a, b) => new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime())
              .slice(-12)
              .map((e) => `${e.message.from?.agent ?? 'peer'}: ${e.message.body ?? ''}`)
              .join('\n');
          } catch {
            return '';
          }
        },
        log: (m) => console.log(m),
      });
      a2aCheckInScheduler.start();
      console.log(pc.green('  A2A check-ins: enabled (Layer 4 silence-breaker active)'));
    }

    // Topic linkage handler — Per THREAD-TOPIC-LINKAGE-SPEC.md.
    // Ties threadline conversations to the originating Telegram topic so
    // replies route back to the topic session instead of a sibling worker.
    // commitmentTracker + telegram are constructed earlier in this file and
    // are guaranteed in scope by this point; the handler is wired into the
    // router immediately.
    const { SalienceGate } = await import('../threadline/SalienceGate.js');
    const { TopicLinkageHandler } = await import('../threadline/TopicLinkageHandler.js');
    const salienceGate = new SalienceGate(); // fallback-only for v1; spec §5.4
    let topicLinkageHandler: import('../threadline/TopicLinkageHandler.js').TopicLinkageHandler | null = null;
    if (commitmentTracker) {
      topicLinkageHandler = new TopicLinkageHandler({
        topicResumeMap: _topicResumeMap as import('../core/TopicResumeMap.js').TopicResumeMap,
        threadResumeMap,
        commitmentTracker,
        salienceGate,
        messageStore,
        localAgent: config.projectName,
        injectIntoSession: async (sessionName: string, text: string) => {
          // Confirm the inject actually submitted (not left stuck at the prompt
          // by the paste-end race). A bare dispatch returning true is the A2 bug:
          // a stalled inject must NOT count as delivered, so the Telegram fallback
          // surfaces the reply instead.
          try {
            return await sessionManager.injectPasteNotificationConfirmed(sessionName, text);
          } catch { return false; }
        },
        isSessionAlive: (sessionName: string) => {
          try { return sessionManager.isSessionAlive(sessionName); } catch { return false; }
        },
        sendTelegramToTopic: telegram
          ? (topicId: number, text: string) => telegram.sendToTopic(topicId, text)
          : null,
        getSessionForTopic: telegram
          ? (topicId: number) => telegram.getSessionForTopic(topicId)
          : undefined,
      });
      threadlineRouter.setTopicLinkageHandler(topicLinkageHandler);
    }

    // Listener Session Manager — warm session for fast relay responses (Phase 2)
    const listenerManager = config.threadline?.relayEnabled
      ? new ListenerSessionManager(config.stateDir, config.authToken ?? '', config.threadline as Partial<import('../threadline/ListenerSessionManager.js').ListenerConfig>)
      : null;

    // Wake Socket Server — receives signals from the standalone listener daemon (Phase 1)
    let wakeSocketServer: import('../threadline/WakeSocketServer.js').WakeSocketServer | undefined;
    try {
      const { WakeSocketServer } = await import('../threadline/WakeSocketServer.js');
      wakeSocketServer = new WakeSocketServer(config.stateDir);
      // CRITICAL (fleet crash-loop fix): WakeSocketServer emits 'error'
      // ASYNCHRONOUSLY (e.g. EADDRINUSE when a live peer — a duplicate instance
      // or a transient rapid-respawn race — already holds listener.sock). The
      // try/catch around .start() only catches synchronous errors, so without a
      // listener this async 'error' is an unhandled EventEmitter 'error' and
      // CRASHES THE WHOLE SERVER PROCESS. Combined with the supervisor respawn,
      // that produced an unrecoverable crash loop (observed: inspec, 1830
      // restarts). The wake socket is an optimization (fast wake/failover from
      // the listener daemon) — degrade gracefully without it rather than take
      // the entire agent down.
      wakeSocketServer.on('error', (err: Error) => {
        console.log(pc.dim(`  Wake socket: degraded — continuing without it (${err instanceof Error ? err.message : err})`));
      });
      wakeSocketServer.on('wake', () => {
        // Daemon wrote a new inbox entry — read and process it
        const inboxPath = path.join(config.stateDir, 'threadline', 'inbox.jsonl.active');
        if (fs.existsSync(inboxPath)) {
          console.log('[wake-socket] Received wake signal from listener daemon');
        }
      });

      // Phase 3: Fast failover via relay presence detection
      wakeSocketServer.on('failover-trigger', () => {
        console.log('[wake-socket] Received FAILOVER_TRIGGER from listener daemon');
        // Read trigger details
        const triggerPath = path.join(config.stateDir, 'failover-trigger.json');
        if (fs.existsSync(triggerPath)) {
          try {
            const trigger = JSON.parse(fs.readFileSync(triggerPath, 'utf-8'));
            console.log(`[wake-socket] Peer agent ${trigger.agentId?.slice(0, 8)}... disconnected from relay`);
            // The MultiMachineCoordinator can use this to speed up failover
            // For now, log the event. Full failover integration requires
            // evaluating whether this agent is a standby for the disconnected peer.
          } catch { /* ignore parse errors */ }
        }
      });

      wakeSocketServer.start();
      console.log(pc.dim(`  Wake socket: listening at ${path.join(config.stateDir, 'listener.sock')}`));
    } catch (err) {
      console.log(pc.dim(`  Wake socket: not started (${err instanceof Error ? err.message : err})`));
    }

    // Pipe Session Spawner — lightweight claude -p sessions for simple queries (Phase 2)
    let pipeSpawner: import('../threadline/PipeSessionSpawner.js').PipeSessionSpawner | undefined;
    if (config.threadline?.relayEnabled) {
      try {
        const { PipeSessionSpawner } = await import('../threadline/PipeSessionSpawner.js');
        const pipeConfig = config.threadline?.listener?.pipeMode;
        // Provider-portability v1.0.0: pipe sessions route through the
        // same framework the rest of this agent uses. Codex pipe-mode
        // model defaults to gpt-5.3-codex; Claude defaults to sonnet.
        const pipeFramework = resolvedFramework ?? 'claude-code';
        const pipeBinaryPath = pipeFramework === 'claude-code'
          ? config.sessions.claudePath
          : (config.sessions.frameworkBinaryPaths?.['codex-cli'] ?? config.sessions.claudePath);
        const pipeModelDefault = pipeFramework === 'claude-code' ? 'sonnet' : 'gpt-5.3-codex';
        pipeSpawner = new PipeSessionSpawner({
          stateDir: config.stateDir,
          model: pipeConfig?.model ?? pipeModelDefault,
          timeoutMs: pipeConfig?.timeoutMs ?? 600_000,
          warningMs: pipeConfig?.warningMs ?? 480_000,
          maxConcurrent: pipeConfig?.maxConcurrent ?? 5,
          allowedTools: pipeConfig?.allowedTools ?? ['threadline_send', 'Read', 'Glob', 'Grep'],
          allowedPaths: pipeConfig?.allowedPaths ?? ['src/', 'docs/', 'specs/'],
          minIqsBand: pipeConfig?.minIqsBand ?? 70,
          framework: pipeFramework,
          binaryPath: pipeBinaryPath,
          // Same per-agent codex threadline MCP override as SessionManager, so a
          // codex pipe-reply worker uses THIS agent's threadline MCP.
          ...(codexThreadlineMcp ? { codexThreadlineMcp } : {}),
        });
        console.log(pc.dim(`  Pipe sessions: enabled (model: ${pipeConfig?.model ?? 'sonnet'}, max: ${pipeConfig?.maxConcurrent ?? 5})`));
      } catch (err) {
        console.log(pc.dim(`  Pipe sessions: not available (${err instanceof Error ? err.message : err})`));
      }
    }

    console.log(pc.green(`  Inter-agent messaging: enabled (token: ${agentToken.slice(0, 8)}...)${dropSummary}`));

    // ── System Reviewer: self-monitoring feature health ──────────────
    const systemReviewConfig = config.monitoring?.systemReview;
    const systemReviewEnabled = systemReviewConfig?.enabled !== false; // default: enabled
    let systemReviewer: SystemReviewer | undefined;
    if (systemReviewEnabled) {
      const alertTopicId = state.get<number>('agent-attention-topic') ?? undefined;
      systemReviewer = new SystemReviewer(
        {
          enabled: true,
          scheduleMs: systemReviewConfig?.scheduleMs,
          scheduledTiers: systemReviewConfig?.scheduledTiers,
          autoSubmitFeedback: systemReviewConfig?.autoSubmitFeedback,
          feedbackConsentGiven: systemReviewConfig?.feedbackConsentGiven,
          alertOnCritical: systemReviewConfig?.alertOnCritical,
          alertCooldownMs: systemReviewConfig?.alertCooldownMs,
          disabledProbes: systemReviewConfig?.disabledProbes,
        },
        {
          stateDir: config.stateDir,
          sendAlert: telegram
            ? (_topicId, text) => {
                notify('SUMMARY', 'system-review', text, alertTopicId);
                return Promise.resolve();
              }
            : undefined,
          submitFeedback: feedback
            ? (item) => feedback!.submit({ ...item, os: `${process.platform} ${process.arch}` })
            : undefined,
        },
      );

      // Register Tier 1 probes with real dependencies
      const tmuxPath = detectTmuxPath() ?? '/usr/bin/tmux';
      const probes = [
        ...createSessionProbes({
          listRunningSessions: () => sessionManager.listRunningSessions(),
          getSessionDiagnostics: () => sessionManager.getSessionDiagnostics(),
          maxSessions: config.sessions?.maxSessions ?? 10,
          tmuxPath,
        }),
        ...createSchedulerProbes({
          getJobs: () => (scheduler?.getJobs() ?? []).map(j => ({ id: j.slug, name: j.name, enabled: j.enabled })),
          getStatus: () => scheduler?.getStatus() ?? { running: false, paused: false, jobCount: 0, enabledJobs: 0, queueLength: 0 },
          jobsFilePath: config.scheduler.jobsFile,
        }),
        ...(telegram ? createMessagingProbes({
          getStatus: () => telegram!.getStatus(),
          messageLogPath: path.join(config.stateDir, 'telegram-messages.jsonl'),
          isConfigured: () => true,
          externalPollerActive: () => Boolean(lifelineOwnsPolling && fs.existsSync(path.join(config.stateDir, 'lifeline.lock'))),
        }) : []),
        ...createLifelineProbes({
          // Supervisor status intentionally omitted: the supervisor only exists
          // in the lifeline process, not in the server. The process + queue probes
          // here check lifeline health via the lock file and queue contents,
          // which is the correct signal from the server's vantage point.
          getQueueLength: () => 0,
          peekQueue: () => [],
          lockFilePath: path.join(config.stateDir, 'lifeline.lock'),
          isEnabled: () => fs.existsSync(path.join(config.stateDir, 'lifeline.lock')),
        }),
        ...createPlatformProbes({
          tmuxPath,
        }),
      ];
      systemReviewer.registerAll(probes);
      systemReviewer.start();
      console.log(pc.green(`  System Reviewer: ${probes.length} probes registered`));
    }

    // ── Threadline Protocol: auto-bootstrap ──────────────────────────
    // Threadline is always ON — MCP tools registered into Claude Code,
    // discovery heartbeat running, identity keys persisted.
    // The user never sees any of this. The agent IS the interface.
    let threadlineHandshake: import('../threadline/HandshakeManager.js').HandshakeManager | undefined;
    let threadlineShutdown: (() => Promise<void>) | undefined;
    let threadlineRelayClient: import('../threadline/client/ThreadlineClient.js').ThreadlineClient | undefined;
    let unifiedTrust: UnifiedTrustSystem | undefined;
    /** Shared reply waiters for threadline waitForReply support */
    const threadlineReplyWaiters = new Map<string, { resolve: (reply: string) => void; threadId: string; senderAgent: string; timer: ReturnType<typeof setTimeout> }>();
    try {
      const threadline = await bootstrapThreadline({
        agentName: config.projectName,
        stateDir: config.stateDir,
        projectDir: config.projectDir,
        port: config.port,
        relayEnabled: config.threadline?.relayEnabled,
        relayUrl: config.threadline?.relayUrl,
        visibility: config.threadline?.visibility,
        capabilities: config.threadline?.capabilities,
      });
      threadlineHandshake = threadline.handshakeManager;
      threadlineShutdown = threadline.shutdown;
      threadlineRelayClient = threadline.relayClient;

      // Initialize unified trust system (three-layer model + MoltBridge)
      if (threadline.trustManager) {
        try {
          unifiedTrust = createUnifiedTrustSystem(threadline.trustManager, {
            stateDir: config.stateDir,
            moltbridge: config.moltbridge,
          });
          console.log(`Unified trust system initialized (identity: ${unifiedTrust.identity.get()?.displayFingerprint ?? 'none'})`);
        } catch (err) {
          console.error(`Unified trust system init failed (non-fatal): ${err instanceof Error ? err.message : err}`);
        }
      }

      if (threadlineRelayClient) {
        // Wire relay message delivery through ThreadlineRouter (Phase 1).
        // Replaces the ad-hoc handler with proper thread persistence, auto-ack,
        // and warm listener routing (Phase 2).

        // Per-sender stable synthetic threadId for messages without threadId
        const syntheticThreadIds = new Map<string, string>();
        function getSyntheticThreadId(fingerprint: string): string {
          if (!syntheticThreadIds.has(fingerprint)) {
            syntheticThreadIds.set(fingerprint, `auto-${crypto.randomUUID()}`);
          }
          return syntheticThreadIds.get(fingerprint)!;
        }

        // Per-sender ack rate limiter
        const ackTimestamps = new Map<string, number[]>();
        const ACK_RATE_LIMIT = config.threadline?.ackRateLimit ?? 5;
        const ACK_WINDOW_MS = 60 * 1000;
        function isAckRateLimited(fingerprint: string): boolean {
          const now = Date.now();
          let timestamps = ackTimestamps.get(fingerprint);
          if (!timestamps) { timestamps = []; ackTimestamps.set(fingerprint, timestamps); }
          const filtered = timestamps.filter(t => now - t < ACK_WINDOW_MS);
          ackTimestamps.set(fingerprint, filtered);
          if (filtered.length >= ACK_RATE_LIMIT) return true;
          filtered.push(now);
          return false;
        }

        // Wire router reference into InboundMessageGate
        if (threadline.inboundGate) {
          threadline.inboundGate.setRouter(threadlineRouter);
        }

        threadlineRelayClient.on('gate-passed', async (decision: { message?: { from: string; content: unknown; threadId?: string; messageId?: string }; trustLevel?: string }) => {
          if (!decision.message) return;
          const msg = decision.message;
          const senderFingerprint = msg.from;
          const senderName = senderFingerprint.slice(0, 8);
          const trustLevel = (decision.trustLevel ?? 'untrusted') as import('../threadline/AgentTrustManager.js').AgentTrustLevel;

          // Extract text content
          let textContent: string;
          if (typeof msg.content === 'string') { textContent = msg.content; }
          else if (typeof msg.content === 'object' && msg.content !== null) {
            const c = msg.content as Record<string, unknown>;
            textContent = String(c.content ?? c.text ?? JSON.stringify(msg.content));
          } else { textContent = JSON.stringify(msg.content); }

          // Check if this message resolves a pending waitForReply request.
          // Skip auto-ack messages (they're from us, not a real reply).
          // PR-3: Waiters are now keyed by threadId (unique per conversation)
          // rather than sender fingerprint or agent name. Fall back to the
          // legacy fingerprint/name lookup only if no threadId is present,
          // for compatibility with older senders.
          const isAutoAck = textContent.startsWith('Message received.') || textContent.startsWith('Message received,');
          let waiter = msg.threadId ? threadlineReplyWaiters.get(msg.threadId) : undefined;
          if (!waiter) {
            // Legacy fallback: try by sender fingerprint, then by resolved name
            waiter = threadlineReplyWaiters.get(senderFingerprint);
            if (!waiter) {
              const resolvedName = (() => {
                try {
                  const kaPath = path.join(config.stateDir, 'threadline', 'known-agents.json');
                  const kaData = JSON.parse(fs.readFileSync(kaPath, 'utf-8'));
                  const agents = kaData.agents ?? kaData;
                  if (Array.isArray(agents)) {
                    const match = agents.find((a: { publicKey?: string; name?: string }) =>
                      a.publicKey === senderFingerprint || a.publicKey?.startsWith(senderFingerprint));
                    return match?.name ?? null;
                  }
                  return null;
                } catch { return null; }
              })();
              if (resolvedName) waiter = threadlineReplyWaiters.get(resolvedName);
            }
          }
          if (waiter && !isAutoAck) {
            waiter.resolve(textContent);
            // Don't return — still process the message normally for routing
          }

          // Auto-ack (post-trust-verification, never ack status messages)
          const msgType = typeof msg.content === 'object' && msg.content !== null ? (msg.content as Record<string, unknown>).type : undefined;
          if (trustLevel !== 'untrusted' && msgType !== 'status' && config.threadline?.autoAck !== false && !isAckRateLimited(senderFingerprint)) {
            try {
              threadlineRelayClient!.sendPlaintext(senderFingerprint, config.threadline?.autoAckMessage ?? 'Message received. Composing response...', msg.threadId);
            } catch (ackErr) { console.error(`[relay] Auto-ack failed: ${ackErr instanceof Error ? ackErr.message : ackErr}`); }
          }

          // Canonical inbox write — single source of truth across all routing branches.
          // Runs once at relay-ingest, BEFORE pipe / warm-listener / cold-spawn branching,
          // so .instar/threadline/inbox.jsonl.active reflects every inbound message regardless
          // of which path handles it. Read by the dashboard observability tab and the
          // threadline → telegram bridge. Non-fatal on failure — routing continues either way.
          if (listenerManager) {
            try {
              listenerManager.appendCanonicalInboxEntry({
                from: senderFingerprint,
                senderName,
                trustLevel,
                threadId: msg.threadId ?? getSyntheticThreadId(senderFingerprint),
                text: textContent,
                messageId: msg.messageId,
              });
            } catch (err) {
              console.warn(`[relay] Canonical inbox append failed (non-fatal): ${err instanceof Error ? err.message : err}`);
            }
          }

          // Threadline → Telegram bridge: mirror inbound message into a per-thread
          // Telegram topic so the user has visibility into agent-to-agent
          // conversations. Relay-only — TelegramBridgeConfig owns the gate
          // (default-OFF; allow/deny list determines auto-create). Async,
          // non-awaited, and never blocks routing or throws to this handler.
          if (telegramBridge) {
            telegramBridge
              .mirrorInbound({
                threadId: msg.threadId ?? getSyntheticThreadId(senderFingerprint),
                remoteAgent: senderFingerprint,
                remoteAgentName: senderName,
                text: textContent,
                messageId: msg.messageId,
              })
              .catch(err => console.warn(`[tg-bridge] mirrorInbound: ${err instanceof Error ? err.message : err}`));
          }

          // Phase 1 keystone: warrants-a-reply gate. Runs ONCE here, UPSTREAM of
          // all three routing branches (pipe-spawn / warm-listener / cold-spawn),
          // so a no-reply verdict short-circuits ALL of them — the observed
          // ack-loop rides the pipe/listener branches, which never reach
          // ThreadlineRouter, so a router-only gate would not stop it. Turn +
          // novelty state lives on the Conversation, not the one-shot worker.
          {
            const gateThreadId = msg.threadId ?? getSyntheticThreadId(senderFingerprint);
            try {
              // Relay inbound is agent-to-agent → autonomous (stricter). The
              // human-in-loop exemption is derived ONLY from our own records and
              // is never set from anything the peer sends (unforgeable).
              const decision = await evaluateAndRecordInbound(warrantsReplyGate, conversationStore, {
                threadId: gateThreadId,
                text: textContent,
                senderFingerprint,
                senderName,
                trustLevel,
                humanInLoop: false,
              });
              if (decision.suppress) {
                console.log(`[relay] warrants-reply gate suppressed reply (${decision.verdict.signal}) for ${senderName} thread ${gateThreadId.slice(0, 8)}`);
                // On budget exhaustion, surface ONE status notice — never silently
                // drop. CMT-519: route it to the SILENT Threadline hub (not a
                // per-event attention topic, not the parent topic the operator is
                // working in). This is housekeeping, not a user task.
                if (decision.verdict.budgetExhausted && collaborationSurfacer) {
                  void collaborationSurfacer.notify({
                    threadId: gateThreadId,
                    title: 'Conversation loop paused',
                    body: `Stopped auto-replying to a thread with ${senderName} that kept going with no new content (thread ${gateThreadId.slice(0, 8)}). Say "re-engage" in this topic if you want me to pick it back up.`,
                    peerName: senderName,
                  }).catch(escErr => console.warn(`[relay] loop-gate hub notice failed: ${escErr instanceof Error ? escErr.message : escErr}`));
                }
                return; // short-circuit ALL three routing branches
              }

              // CMT-509 §2: warranted + PARENTLESS conversation (no bound topic)
              // → surface to the dedicated Threadline topic so the operator sees
              // a peer reaching out cold. Topic-bound conversations are surfaced by
              // TopicLinkageHandler instead, so we skip them here. Best-effort,
              // non-blocking; never breaks the inbound path.
              if (collaborationSurfacer) {
                const hasParentTopic = conversationStore.get(gateThreadId)?.boundTopicId != null;
                void collaborationSurfacer.surface({
                  threadId: gateThreadId,
                  senderName,
                  text: textContent,
                  hasParentTopic,
                  warrants: !decision.suppress,
                });
              }
            } catch (gateErr) {
              // Gate failure → fail toward responsive (never silently drop a message).
              console.warn(`[relay] warrants-reply gate error (defaulting responsive): ${gateErr instanceof Error ? gateErr.message : gateErr}`);
            }
          }

          // Phase 2a: Pipe-mode session for simple queries (lightweight, auto-exit)
          // Rapid-fire same-thread guard: if an active pipe session already exists for this
          // thread, fall through to the listener/cold-spawn path so messages queue serially
          // via ListenerSessionManager.writeToInbox instead of killing the prior tmux session.
          if (
            pipeSpawner &&
            msg.threadId &&
            !threadResumeMap.get(msg.threadId) &&
            !pipeSpawner.hasActiveSessionForThread(msg.threadId)
          ) {
            const pipeCheck = pipeSpawner.shouldUsePipeMode({
              threadId: msg.threadId,
              messageText: textContent,
              fromFingerprint: senderFingerprint,
              fromName: senderName,
              trustLevel,
            });
            if (pipeCheck.eligible) {
              try {
                const { classifyIntent, summarizeThreadHistory } = await import('../threadline/PipeSessionSpawner.js');
                // Route classifier through the shared IntelligenceProvider so
                // Codex agents can use pipe-mode too. When no provider is
                // available (degraded mode) the classifier fails closed to
                // 'interactive' — safer than missing a TASK message.
                const intent = await classifyIntent(textContent, {
                  intelligence: sharedIntelligence,
                });
                if (intent === 'pipe') {
                  const result = await pipeSpawner.spawn({
                    threadId: msg.threadId,
                    messageText: textContent,
                    fromFingerprint: senderFingerprint,
                    fromName: senderName,
                    trustLevel,
                  });
                  if (result.spawned) {
                    console.log(`[relay] Pipe session spawned for ${senderName} (thread: ${msg.threadId.slice(0, 8)})`);
                    return;
                  }
                }
              } catch (err) {
                console.error(`[relay] Pipe session error (falling through to interactive): ${err instanceof Error ? err.message : err}`);
              }
            }
          }

          // Phase 2b: Route to warm listener if available and appropriate.
          // EXCEPT topic-bound replies: a reply on a thread bound to a Telegram
          // topic must reach handleInboundMessage → TopicLinkageHandler so it
          // surfaces in the bound topic. The listener inbox is a side-channel
          // that never surfaces to the topic — routing a topic-bound reply there
          // is exactly the relay-path leak (A1-relay) that makes the reply vanish
          // for the user even though transport succeeded. (The pipe-spawn branch
          // above is already excluded for topic-bound threads via its
          // `!threadResumeMap.get(...)` guard, now that get() no longer nulls them.)
          const isTopicBoundReply =
            !!msg.threadId && threadResumeMap.get(msg.threadId)?.originTopicId !== undefined;
          if (listenerManager && listenerManager.shouldUseListener(trustLevel, textContent.length) && !isTopicBoundReply) {
            listenerManager.writeToInbox({ from: senderFingerprint, senderName, trustLevel, threadId: msg.threadId ?? getSyntheticThreadId(senderFingerprint), text: textContent });
            console.log(`[relay] Routed to listener inbox from ${senderName} (trust: ${trustLevel})`);
            return;
          }

          // Route through ThreadlineRouter (cold-spawn path)
          const envelope = {
            schemaVersion: 1 as const,
            message: { id: msg.messageId ?? crypto.randomUUID(), from: { agent: senderFingerprint, session: 'relay', machine: 'relay' }, to: { agent: config.projectName, session: 'best', machine: 'local' }, subject: 'Relay message', body: textContent, type: 'query' as const, priority: 'medium' as const, threadId: msg.threadId, createdAt: new Date().toISOString() },
            transport: { protocol: 'relay' as const, origin: { agent: senderFingerprint, machine: 'relay' }, nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`, timestamp: new Date().toISOString() },
            delivery: { status: 'delivered' as const, attempts: 1, lastAttempt: new Date().toISOString() },
          } as unknown as import('../messaging/types.js').MessageEnvelope;

          // Warm-Session A2A (Arch Y, dark-ship): mark this inbound as eligible for
          // a keep-alive interactive worker when the feature is on, it's NOT a
          // topic-bound reply (those go to TopicLinkageHandler), and the peer meets
          // the trust floor. Trust compare via the explicit ordering array
          // (trustMeetsFloor), NEVER string `>=`. When false (or feature off), the
          // router takes the proven cold-spawn path byte-for-byte.
          const preferWarmSession =
            warmEnabled && !isTopicBoundReply && trustMeetsFloor(trustLevel, warmTrustFloor);
          const relayContext = {
            trust: { kind: 'plaintext-tofu' as const, senderFingerprint },
            senderFingerprint,
            senderName,
            trustLevel,
            preferWarmSession,
          };
          let result = await threadlineRouter.handleInboundMessage(envelope, relayContext);

          // Fallback for threadId-less messages
          if (!result.handled && !msg.threadId) {
            (envelope.message as { threadId?: string }).threadId = getSyntheticThreadId(senderFingerprint);
            result = await threadlineRouter.handleInboundMessage(envelope, relayContext);
          }

          if (result.error) console.warn(`[relay] Router error: ${result.error}`);
          if (result.spawned) console.log(`[relay] Spawned session for ${senderName} (trust: ${trustLevel}, thread: ${result.threadId})`);
          if (result.resumed) console.log(`[relay] Resumed session for ${senderName} (thread: ${result.threadId})`);
        });

        // Relay client is passed to AgentServer → RouteContext for the /threadline/relay-send endpoint

        console.log(pc.green(`  Threadline: relay connected to ${config.threadline?.relayUrl ?? DEFAULT_RELAY_HOST}`));
      }
      console.log(pc.green(`  Threadline: enabled (MCP tools registered, discovery heartbeat active)`));
    } catch (err) {
      // Non-fatal — agent works without Threadline
      console.warn(pc.yellow(`  Threadline: failed to bootstrap — ${err instanceof Error ? err.message : String(err)}`));
    }

    // Messaging Tone Gate — always-on tone check on outbound messaging routes.
    // Uses the shared IntelligenceProvider (Claude CLI subscription by default,
    // Anthropic API if key is set). No opt-in. Catches CLI commands, file paths,
    // config syntax, and other technical leakage in agent-to-user messages.
    let messagingToneGate: import('../core/MessagingToneGate.js').MessagingToneGate | undefined;
    if (sharedIntelligence) {
      const { MessagingToneGate } = await import('../core/MessagingToneGate.js');
      messagingToneGate = new MessagingToneGate(sharedIntelligence);
      console.log(pc.green('  Messaging tone gate: active (Haiku via shared IntelligenceProvider)'));
    } else {
      console.log(pc.yellow('  Messaging tone gate: inactive (no IntelligenceProvider available)'));
    }

    // Outbound dedup gate — deterministic near-duplicate detection on every
    // outbound agent message. Catches respawn races and idempotency gaps.
    const { OutboundDedupGate } = await import('../core/OutboundDedupGate.js');
    const outboundDedupGate = new OutboundDedupGate();
    console.log(pc.green('  Outbound dedup gate: active (word-3gram Jaccard, threshold 0.7, 5min window)'));

    // Unjustified Stop Gate — observe-only by default. The routes and authority
    // already fail open; constructing both pieces here is what makes the Stop
    // router produce real shadow-mode telemetry instead of a dark endpoint.
    let unjustifiedStopGate: import('../core/UnjustifiedStopGate.js').UnjustifiedStopGate | undefined;
    let stopGateDb: import('../core/StopGateDb.js').StopGateDb | undefined;
    {
      const { configureStopGateState } = await import('../server/stopGate.js');
      const modeFilePath = path.join(config.stateDir, 'server-data', 'stop-gate-mode.json');
      try {
        const { StopGateDb } = await import('../core/StopGateDb.js');
        stopGateDb = new StopGateDb({
          dbPath: path.join(config.stateDir, 'server-data', 'stop-gate.db'),
        });
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'unjustifiedStopGate.db',
          primary: 'SQLite decision log for Stop-gate evaluations',
          fallback: 'fail-open → no Stop-gate persistence',
          reason: err instanceof Error ? err.message : String(err),
          impact: 'Stop events are allowed and not recorded until the database opens.',
        });
      }
      if (sharedIntelligence && stopGateDb) {
        try {
          const { UnjustifiedStopGate } = await import('../core/UnjustifiedStopGate.js');
          unjustifiedStopGate = new UnjustifiedStopGate({ intelligence: sharedIntelligence });
        } catch (err) {
          DegradationReporter.getInstance().report({
            feature: 'unjustifiedStopGate.authority',
            primary: 'LLM authority for unjustified Stop-event detection',
            fallback: 'fail-open → allow',
            reason: err instanceof Error ? err.message : String(err),
            impact: 'Stop events are allowed until the authority can initialize.',
          });
        }
      }
      const activeMode = configureStopGateState({
        modeFilePath,
        defaultMode: unjustifiedStopGate && stopGateDb ? 'shadow' : 'off',
      });
      console.log(pc.green(`  Unjustified Stop Gate: ${activeMode}${unjustifiedStopGate && stopGateDb ? ' (authority + SQLite wired)' : ' (degraded, fail-open)'}`));
    }

    // notify-on-stop Layer B — surface a genuinely-stuck UNATTENDED stop to the
    // user (docs/specs/NOTIFY-ON-STOP-SPEC.md). The evaluate route feeds each
    // decision to StopNotifier, which filters to the notify-worthy classes
    // (shadow+continue / escalate), the attended-gate, and per-session dedup,
    // then hands a coalesced one-liner to a dedicated SentinelNotifier sink
    // (single lifeline topic, log-always — reuses the post-2026-05-22 discipline).
    // Default ON (Justin's "tell me why it stopped"); requires telegram wired.
    let stopNotifier: import('../monitoring/StopNotifier.js').StopNotifier | null = null;
    {
      const nosCfg = config.monitoring?.notifyOnStop ?? {};
      const nosEnabled = nosCfg.enabled !== false; // default true
      const localTg = telegram;
      if (nosEnabled && localTg) {
        const stopLogPath = path.join(config.stateDir, '..', 'logs', 'sentinel-events.jsonl');
        const stopLog = (entry: { kind: string; sessionName: string; detail?: string }): void => {
          try { fs.appendFileSync(stopLogPath, JSON.stringify({ ...entry, sentinel: 'stop-notify', ts: new Date().toISOString() }) + '\n'); } catch { /* best-effort */ }
        };
        const send = async (text: string): Promise<boolean> => {
          const topicId = localTg.getLifelineTopicId();
          if (!topicId) return false;
          try { await localTg.sendToTopic(topicId, text); return true; } catch { return false; }
        };
        const { SentinelNotifier } = await import('../monitoring/SentinelNotifier.js');
        const stopSink = new SentinelNotifier(
          { log: stopLog, sendConsolidated: send },
          { telegramEscalation: true }, // notify-on-stop is default-on by design
        );
        const { StopNotifier } = await import('../monitoring/StopNotifier.js');
        stopNotifier = new StopNotifier(
          { escalate: (name, text) => stopSink.escalate('stop-gate', name, text) },
          {
            enabled: true,
            unattendedOnly: nosCfg.unattendedOnly !== false,
            ...(typeof nosCfg.cooldownMs === 'number' ? { cooldownMs: nosCfg.cooldownMs } : {}),
          },
        );
        console.log(pc.green('  notify-on-stop Layer B: enabled (unjustified-stall heads-up — unattended-only, deduped, coalesced)'));
      } else {
        console.log(pc.dim(`  notify-on-stop Layer B: ${nosEnabled ? 'idle (no telegram)' : 'disabled by config'}`));
      }
    }

    // Response Review Pipeline (Coherence Gate) — evaluates agent responses before delivery.
    // Prefers the shared IntelligenceProvider (subscription-compatible) so the gate works
    // even without ANTHROPIC_API_KEY. Falls back to direct Anthropic API if a key is set
    // and no intelligence is available.
    let responseReviewGate: import('../core/CoherenceGate.js').CoherenceGate | undefined;
    if (config.responseReview?.enabled) {
      if (sharedIntelligence) {
        const { CoherenceGate } = await import('../core/CoherenceGate.js');
        responseReviewGate = new CoherenceGate({
          config: config.responseReview,
          stateDir: config.stateDir,
          intelligence: sharedIntelligence,
          relationships: relationships ?? undefined,
          adaptiveTrust: adaptiveTrust ?? undefined,
        });
        console.log(pc.green(`  Response review pipeline: enabled via shared IntelligenceProvider (${Object.keys(config.responseReview.reviewers ?? {}).length} reviewers configured)`));
      } else {
        console.warn(pc.yellow(`  Response review pipeline: configured but no IntelligenceProvider available (path-constraints.md Rule 2 forbids direct API path)`));
      }
    }

    // Feature Registry (Consent & Discovery Framework — Phase 1)
    const { FeatureRegistry } = await import('../core/FeatureRegistry.js');
    const { BUILTIN_FEATURES } = await import('../core/FeatureDefinitions.js');
    const featureRegistry = new FeatureRegistry(config.stateDir, {
      hmacKey: config.authToken || undefined,
    });
    let featureRegistryReady = false;
    try {
      await featureRegistry.open();
      featureRegistryReady = true;
    } catch (frErr: unknown) {
      const msg = frErr instanceof Error ? frErr.message : String(frErr);
      console.warn(pc.yellow(`  FeatureRegistry: failed to open (${msg.slice(0, 120)})`));
      const { DegradationReporter } = await import('../monitoring/DegradationReporter.js');
      DegradationReporter.getInstance().report({
        feature: 'FeatureRegistry',
        primary: 'SQLite-backed feature registry with discovery state tracking',
        fallback: 'Feature definitions available in-memory only (no persistent state)',
        reason: `FeatureRegistry open failed: ${msg.slice(0, 200)}`,
        impact: 'Feature discovery state not persisted. Features default to definitions only.',
      });
    }
    for (const def of BUILTIN_FEATURES) {
      featureRegistry.register(def);
    }
    if (featureRegistryReady) {
      featureRegistry.bootstrap(config as unknown as Record<string, unknown>);
    }
    {
      const summaries = featureRegistry.getSummaries();
      const enabledCount = summaries.filter((f: { enabled: boolean }) => f.enabled).length;
      console.log(pc.green(`  Feature registry: ${summaries.length} features (${enabledCount} enabled, ${summaries.length - enabledCount} undiscovered)`));
    }

    // Wire Baseline telemetry consent check to FeatureRegistry
    if (telemetryHeartbeat) {
      telemetryHeartbeat.setConsentChecker(() => {
        const state = featureRegistry.getState('baseline-telemetry');
        return state?.enabled === true;
      });
      console.log(pc.green('  Baseline telemetry: consent check wired to feature registry'));
    }

    // Discovery Evaluator (Consent & Discovery Framework — Phase 3)
    let discoveryEvaluator: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator | undefined;
    if (sharedIntelligence) {
      const { DiscoveryEvaluator } = await import('../core/DiscoveryEvaluator.js');
      discoveryEvaluator = new DiscoveryEvaluator(featureRegistry, sharedIntelligence);
      console.log(pc.green('  Discovery evaluator: active (Haiku-class LLM)'));
    } else {
      console.log(pc.yellow('  Discovery evaluator: inactive (no IntelligenceProvider)'));
    }

    // Independent autonomous-completion judge (mirrors /goal). Reuses the
    // framework-aware sharedIntelligence; falls back to the self-declared promise
    // when absent (the stop-hook handles that).
    let completionEvaluator: import('../core/CompletionEvaluator.js').CompletionEvaluator | undefined;
    if (sharedIntelligence) {
      const { CompletionEvaluator } = await import('../core/CompletionEvaluator.js');
      completionEvaluator = new CompletionEvaluator({ intelligence: sharedIntelligence });
      console.log(pc.green('  Completion evaluator: active (independent /goal-style judge)'));
    }

    // ── CollaborationRedriveEngine ────────────────────────────────────
    // Proactively re-engage a COUNTERPART that has gone silent on an open
    // threadline-reply commitment. Bounded peer nudges with a durable,
    // reply-INDEPENDENT cap; escalates to the Attention queue after the cap
    // and goes terminal-quiet (never spins). Spec:
    // docs/specs/collaboration-redrive-on-counterpart-silence.md (approved
    // by Justin 2026-05-28). Ships OFF.
    try {
      const redriveCfg = config.monitoring?.collaborationRedrive ?? {};
      if (redriveCfg.enabled && completionEvaluator) {
        const { CollaborationRedriveEngine, DEFAULT_REDRIVE_CONFIG } = await import('../monitoring/CollaborationRedriveEngine.js');
        const collaborationRedrive = new CollaborationRedriveEngine(
          {
            commitmentTracker,
            completionEvaluator,
            relayClient: threadlineRelayClient ?? undefined,
            surfacer: collaborationSurfacer ?? undefined,
            raiseAttention: telegram
              ? async (item) => {
                  const priorityMap: Record<string, 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'> = {
                    high: 'HIGH', medium: 'NORMAL', low: 'LOW',
                  };
                  return telegram!.createAttentionItem({
                    id: `collab-redrive-${Date.now()}`,
                    title: item.title,
                    summary: item.body.slice(0, 160),
                    description: item.body,
                    category: 'collaboration-redrive',
                    priority: priorityMap[item.priority ?? 'medium'] ?? 'NORMAL',
                    sourceContext: item.source ?? 'collaboration-redrive',
                  });
                }
              : undefined,
            knownAgentsPath: path.join(config.stateDir, 'threadline', 'known-agents.json'),
          },
          { ...DEFAULT_REDRIVE_CONFIG, ...redriveCfg, enabled: true },
        );
        collaborationRedrive.start();
        (globalThis as Record<string, unknown>).__instarCollaborationRedrive = collaborationRedrive;
        console.log(pc.green('  CollaborationRedriveEngine: armed (proactive peer re-drive on counterpart silence)'));
      } else {
        console.log(pc.dim('  CollaborationRedriveEngine: disabled (monitoring.collaborationRedrive.enabled=false; the ship-OFF default)'));
      }
    } catch (err) {
      console.warn('[CollaborationRedrive] init failed:', (err as Error).message);
    }

    // Register feature-discovery probe for self-knowledge tree (Phase 4: Agent Integration)
    if (selfKnowledgeTree && featureRegistry) {
      selfKnowledgeTree.probes.register('feature-discovery', async () => {
        const start = Date.now();
        const summaries = featureRegistry.getSummaries();
        const byState: Record<string, string[]> = {};
        for (const s of summaries) {
          (byState[s.discoveryState] ??= []).push(`${s.name} (${s.consentTier})`);
        }
        const lines: string[] = ['Feature Discovery Status:'];
        for (const [state, features] of Object.entries(byState)) {
          lines.push(`  ${state}: ${features.join(', ')}`);
        }
        lines.push('');
        lines.push('Behavioral contract: max 1 feature per turn, never during frustration,');
        lines.push('network/self-governing tier requires local tier enabled first.');
        lines.push('Use POST /features/:id/surface to record surfacings.');
        lines.push('Use POST /features/evaluate-context for LLM-powered recommendations.');
        return { content: lines.join('\n'), truncated: false, elapsedMs: Date.now() - start };
      }, { description: 'Feature discovery state and behavioral contract summary' });
    }

    // Register conversational-catalog probe — Conversational-action v0.2.
    // On-demand load of the catalog of invocable actions. Per the AGENT.md
    // bloat lesson (L1) and Structure>Willpower (P1), the catalog is NEVER
    // inlined into AGENT.md — agents probe for it during intent-interpretation
    // moments (matched by the conversational-actions Tier 2 segment dispatch
    // triggers).
    if (selfKnowledgeTree) {
      selfKnowledgeTree.probes.register('conversational-catalog', async () => {
        const start = Date.now();
        const { discoverActions, renderCatalogBlock } = await import('../providers/parity/conversationalActionCatalog.js');
        const actions = await discoverActions(config.projectDir);
        const catalog = renderCatalogBlock(actions);
        return { content: catalog, truncated: false, elapsedMs: Date.now() - start };
      }, { description: 'Catalog of invocable actions for conversational-intent matching. Fetched on-demand during interpretation moments — never inlined into AGENT.md.' });
    }

    // ── Integrated-Being ledger (v1) ──────────────────────────────────
    // Spec: docs/specs/integrated-being-ledger-v1.md
    let sharedStateLedger: import('../core/SharedStateLedger.js').SharedStateLedger | undefined;
    let ledgerSessionRegistry:
      | import('../core/LedgerSessionRegistry.js').LedgerSessionRegistry
      | undefined;
    {
      const ibConfig = config.integratedBeing ?? {};
      const ibEnabled = ibConfig.enabled === undefined ? true : ibConfig.enabled !== false;
      if (ibEnabled) {
        const { SharedStateLedger } = await import('../core/SharedStateLedger.js');
        const { randomBytes } = await import('node:crypto');
        // Generate salt on first use — persisted via LiveConfig.
        let salt = ibConfig.counterpartyHashSalt ?? '';
        if (!salt) {
          salt = randomBytes(32).toString('hex');
          try {
            if (liveConfig) liveConfig.set('integratedBeing.counterpartyHashSalt', salt);
          } catch { /* best effort */ }
        }
        sharedStateLedger = new SharedStateLedger({
          stateDir: config.stateDir,
          config: ibConfig,
          salt,
          degradationReporter,
        });
        // Wire emitters (single call-site; revert = delete this block).
        const { registerLedgerEmitters } = await import('../core/registerLedgerEmitters.js');
        // Note: dispatchExecutor is scoped inside the dispatches.enabled block.
        // AutoDispatcher wraps it; the emitter sink is set via
        // autoDispatcher.executor.setLedgerEventSink(). We access it through
        // autoDispatcher — if dispatches are disabled, no emitter is installed.
        const dispatchExec = autoDispatcher
          ? (autoDispatcher as any).executor as import('../core/DispatchExecutor.js').DispatchExecutor | undefined
          : undefined;
        registerLedgerEmitters(sharedStateLedger, {
          threadlineRouter: threadlineRouter ?? undefined,
          dispatchExecutor: dispatchExec ?? undefined,
          coherenceGate: responseReviewGate ?? undefined,
          config: ibConfig,
          instance: config.projectName ?? 'server',
        });
        console.log(pc.green('  Integrated-Being ledger: enabled'));

        // ── Integrated-Being v2 (session-write surface) ────────────────
        // Spec: docs/specs/integrated-being-ledger-v2.md
        // Gated by config.integratedBeing.v2Enabled (default false).
        // When false the registry is still instantiated so endpoints can
        // consistently 503 with X-Disabled: v2; only the endpoint guards
        // read the flag. Keeping the registry in-scope avoids a second
        // branch in server.ts wiring.
        if (ibConfig.v2Enabled === true) {
          const { LedgerSessionRegistry } = await import(
            '../core/LedgerSessionRegistry.js'
          );
          ledgerSessionRegistry = new LedgerSessionRegistry({
            stateDir: config.stateDir,
            config: ibConfig,
          });
          console.log(
            pc.green('  Integrated-Being v2 (session-write surface): enabled')
          );
          // Start background sweepers (expired + stranded). Bounded
          // per-run; safe to run on every server start.
          const { CommitmentSweeper } = await import(
            '../core/CommitmentSweeper.js'
          );
          const sweeper = new CommitmentSweeper({
            ledger: sharedStateLedger!,
            registry: ledgerSessionRegistry,
            instance: config.projectName ?? 'server',
          });
          sweeper.start();
          console.log(
            pc.green('  Integrated-Being v2 (commitment sweepers): running')
          );
        } else {
          console.log(
            pc.dim('  Integrated-Being v2 (session-write surface): disabled')
          );
        }
      }
    }

    // Parallel-dev isolation (PARALLEL-DEV-ISOLATION-SPEC.md) — off by default.
    // When enabled, each topic session spawns in its own git worktree, with
    // fencing tokens, Ed25519-signed commit trailers, and (at phase='enforce')
    // an authoritative push gate at GitHub Actions.
    let worktreeManager: import('../core/WorktreeManager.js').WorktreeManager | undefined;
    const parallelDevConfig = config.parallelDev;
    if (parallelDevConfig && parallelDevConfig.phase !== 'off') {
      const { wireParallelDev } = await import('../core/ParallelDevWiring.js');
      const wired = await wireParallelDev({
        config: parallelDevConfig,
        projectDir: config.projectDir,
        stateDir: config.stateDir,
      });
      if (wired) {
        worktreeManager = wired.worktreeManager;
        sessionManager.setWorktreeManager(worktreeManager, wired.shimRoot);
        console.log(
          pc.green(`  Parallel-dev isolation: ${parallelDevConfig.phase} (WorktreeManager wired)`)
        );
      }
    }

    const { InitiativeTracker } = await import('../core/InitiativeTracker.js');
    const initiativeTracker = new InitiativeTracker(config.stateDir);

    // Project-scope Phase 1.9 — wire the digest cache writer so every
    // project mutation re-renders `.instar/projects-digest.cache`. The
    // session-start + compaction-recovery hooks read this file directly
    // (≤50ms budget, no HTTP). First-start writes the file unconditionally
    // so the hooks always have something to read on a fresh install.
    const { ProjectDigestCache } = await import('../core/ProjectDigestCache.js');
    const projectDigestCache = new ProjectDigestCache(config.stateDir, initiativeTracker);
    initiativeTracker.setDigestCacheInvalidator(() => projectDigestCache.writeDigestCache());
    projectDigestCache.writeDigestCache();

    // ── Graduated Feature Rollout — self-populating tracker ──────────────
    // The reconciler turns approved specs + traces + merge state into tracker
    // initiatives automatically (GRADUATED-FEATURE-ROLLOUT-SPEC §4.1), so no
    // ship-dark feature relies on anyone remembering to register it. Runs once
    // at boot + on a bounded cadence. Observation-only w.r.t. config flags.
    const { FeatureRolloutReconciler } = await import('../core/FeatureRolloutReconciler.js');
    const { scanSpecArtifactsWithCanonical, makeFlagObserver } = await import('../core/featureRolloutScan.js');
    const { getInitDefaults: _getRolloutDefaults } = await import('../config/ConfigDefaults.js');
    const _shippedDefaults = _getRolloutDefaults(
      (config as { agentType?: string }).agentType === 'standalone' ? 'standalone' : 'managed-project',
    );
    // Layer C of release-readiness-visibility: when featureRollout.canonicalRefScan
    // is enabled, scan against canonical `main` (not the local working tree, which
    // silently misses freshly-merged specs). Falls back to the local scan on any
    // failure with a single degradation log line — never throws into boot.
    const _frCfg = config.featureRollout;
    const featureRolloutReconciler = new FeatureRolloutReconciler({
      tracker: initiativeTracker,
      listSpecArtifacts: () =>
        scanSpecArtifactsWithCanonical(config.projectDir, {
          canonicalRefScanEnabled: _frCfg?.canonicalRefScan === true,
          canonicalRemote: _frCfg?.canonicalRemote,
          fetchTimeoutMs: _frCfg?.fetchTimeoutMs,
          onDegradation: (reason) =>
            console.warn(`[instar] feature-rollout canonical scan degraded: ${reason}`),
        }),
      observeFlag: makeFlagObserver(config, _shippedDefaults),
    });
    void featureRolloutReconciler.reconcile().catch(err =>
      console.warn('[instar] feature-rollout reconcile failed (non-fatal):', err instanceof Error ? err.message : String(err)));
    const _rolloutReconcileTimer = setInterval(() => {
      void featureRolloutReconciler.reconcile().catch(() => { /* non-fatal */ });
    }, 6 * 60 * 60 * 1000);
    if (typeof _rolloutReconcileTimer.unref === 'function') _rolloutReconcileTimer.unref();

    // Project-scope Phase 1b PR 3 — round runner (single chokepoint for
    // /advance, /halt, /ack, /accept-partial; lock-protected; future
    // autonomous-delegating run loop).
    const machineIdForProjects = coordinator.identity?.machineId ?? os.hostname();
    const { ProjectRoundRunner } = await import('../core/ProjectRoundRunner.js');
    const projectRoundRunner = new ProjectRoundRunner({
      tracker: initiativeTracker,
      stateDir: config.stateDir,
      machineId: machineIdForProjects,
    });

    // Project-scope Phase 1b PR 4 — machine heartbeat + auto-advance poller.
    // Heartbeat writes .instar/machine-health/<machineId>.json every 30 min
    // (git-synced); the claim-ownership endpoint queries it for the >48h
    // staleness check that spec § P5 requires. Auto-advance poller scans
    // for project rounds whose autoAdvanceAt has elapsed and bookkeeps the
    // next round.
    const { MachineHeartbeat } = await import('../core/MachineHeartbeat.js');
    const machineHeartbeatApi = new MachineHeartbeat({
      stateDir: config.stateDir,
      machineId: machineIdForProjects,
    });
    machineHeartbeatApi.start();
    const machineHeartbeat = { api: machineHeartbeatApi, config: { machineId: machineIdForProjects } };
    // Wire the run-round executor: fire-and-forget launch of
    // ProjectRoundExecution.runRound() after a successful auto-advance.
    // The executor itself acquires the lock + spawns + polls + cleans up.
    // Errors are surfaced via the poller's result.executorErrors and
    // logged to stderr; they don't take the server down.
    const { runRound } = await import('../core/ProjectRoundExecution.js');
    const { ProjectAutoAdvancePoller } = await import('../core/ProjectAutoAdvancePoller.js');
    const projectAutoAdvancePoller = new ProjectAutoAdvancePoller({
      tracker: initiativeTracker,
      runner: projectRoundRunner,
      machineId: machineIdForProjects,
      executor: async ({ projectId, roundIndex }) => {
        const proj = initiativeTracker.get(projectId);
        if (!proj || !proj.targetRepoPath) return;
        await runRound(
          {
            tracker: initiativeTracker,
            projectId,
            roundIndex,
            targetRepoPath: proj.targetRepoPath,
          },
          { stateDir: config.stateDir }
        );
      },
    });
    // Tick once a minute; .unref() so the timer never keeps the process alive.
    const projectAutoAdvanceTimer = setInterval(() => {
      projectAutoAdvancePoller.tick().catch((err: unknown) => {
        console.error('[ProjectAutoAdvancePoller] tick error:', err);
      });
    }, 60_000);
    if (typeof projectAutoAdvanceTimer.unref === 'function') projectAutoAdvanceTimer.unref();

    // Post-restore reconciler — downgrade any round still flagged
    // in-progress to pending. The previous owner may have crashed or
    // migrated, and no TaskFlow exists yet to detect an actually-live
    // run. One-shot at startup.
    try {
      for (const proj of initiativeTracker.list({ kind: 'project', status: 'active' })) {
        const rounds = proj.rounds ?? [];
        let any = false;
        const nextRounds = rounds.map((r) => {
          if (r.status === 'in-progress') {
            any = true;
            return { ...r, status: 'pending' as const };
          }
          return r;
        });
        if (any) {
          await initiativeTracker.update(proj.id, {
            rounds: nextRounds,
            ifMatch: proj.version,
          }).catch(() => { /* OCC race or already gone — best-effort */ });
        }
      }
    } catch (err) {
      console.error('[ProjectAutoAdvancePoller] post-restore reconciler error:', err);
    }

    // Project drift checker — used by POST /projects/:id/drift-check.
    // Reuses the shared IntelligenceProvider. Cache + ledger are optional
    // and not wired here yet (the dashboard caller can pass per-call
    // overrides); a follow-up can wire ProjectDriftCheckerCache + the
    // DriftSpendLedger once spend telemetry is needed in prod.
    const { ProjectDriftChecker } = await import('../core/ProjectDriftChecker.js');
    const projectDriftChecker = new ProjectDriftChecker({
      intelligence: sharedIntelligence,
    });

    // TaskFlow registry — opt-in via config.taskFlow.enabled (default: off in v1).
    // Owns its own SQLite file under .instar/task-flows.db. The maintenance
    // sweeper and due-waker start with the registry; both .unref() their timers
    // so they never keep the process alive on shutdown.
    let taskFlowRegistry: import('../tasks/TaskFlowRegistry.js').TaskFlowRegistry | undefined;
    let taskFlowSweeper: import('../tasks/TaskFlowMaintenanceSweeper.js').TaskFlowMaintenanceSweeper | undefined;
    let taskFlowDueWaker: import('../tasks/TaskFlowDueWaker.js').TaskFlowDueWaker | undefined;
    let threadlineFlowBridge: import('../tasks/ThreadlineFlowBridge.js').ThreadlineFlowBridge | undefined;
    let divergenceChecker: import('../tasks/DivergenceChecker.js').DivergenceChecker | undefined;
    if ((config as any).taskFlow?.enabled) {
      try {
        const { TaskFlowStore } = await import('../tasks/task-flow-registry.store.sqlite.js');
        const { TaskFlowRegistry } = await import('../tasks/TaskFlowRegistry.js');
        const { TaskFlowMaintenanceSweeper } = await import('../tasks/TaskFlowMaintenanceSweeper.js');
        const { TaskFlowDueWaker } = await import('../tasks/TaskFlowDueWaker.js');
        const path = await import('node:path');
        const dbPath = path.default.join(config.stateDir, 'task-flows.db');
        const store = new TaskFlowStore({ dbPath });
        await store.open();
        taskFlowRegistry = new TaskFlowRegistry({
          store,
          ledger: sharedStateLedger ?? undefined,
          thresholds: (config as any).taskFlow?.thresholds,
          // Phase 5: rate limits + cache cap. Each field has a documented
          // default in DEFAULT_RATE_LIMITS / DEFAULT_CACHE_CONFIG.
          rateLimits: (config as any).taskFlow?.rateLimits,
          cache: (config as any).taskFlow?.cache,
        });
        taskFlowSweeper = new TaskFlowMaintenanceSweeper({
          registry: taskFlowRegistry,
          store,
          ledger: sharedStateLedger ?? undefined,
        });
        taskFlowDueWaker = new TaskFlowDueWaker({ registry: taskFlowRegistry });
        taskFlowSweeper.start();
        taskFlowDueWaker.start();
        const { ThreadlineFlowBridge } = await import('../tasks/ThreadlineFlowBridge.js');
        threadlineFlowBridge = new ThreadlineFlowBridge({ registry: taskFlowRegistry });

        // Phase 3a — wire EvolutionManager dual-write + divergence checker.
        const crypto = await import('node:crypto');
        const controllerInstanceId = crypto.randomUUID();
        evolution.setTaskFlowRegistry(taskFlowRegistry, controllerInstanceId);
        // Backfill in-flight clusters into TaskFlow. Idempotent via
        // `evolution-cluster-create-<id>` idempotency key.
        try {
          const migrationReport = await evolution.migrateExistingToTaskFlow();
          console.log(
            pc.green(
              `  TaskFlow: backfilled evolution clusters created=${migrationReport.created} ` +
              `existed=${migrationReport.alreadyExisted} advanced=${migrationReport.advanced} ` +
              `skipped=${migrationReport.skipped}`
            )
          );
        } catch (err) {
          console.warn('[instar] taskflow evolution backfill failed (non-fatal):', err);
        }
        const { DivergenceChecker } = await import('../tasks/DivergenceChecker.js');
        divergenceChecker = new DivergenceChecker({
          registry: taskFlowRegistry,
          evolutionManager: evolution,
          ledger: sharedStateLedger ?? undefined,
        });
        divergenceChecker.start();

        // Phase 4 — wire InitiativeTracker to TaskFlow as the single source of
        // truth. Backfill any initiatives present in the legacy
        // `initiatives.json` file. Idempotent via `findIdempotent` on
        // `(controllerId="InitiativeTracker", ownerKey, idempotencyKey)`.
        initiativeTracker.setTaskFlowRegistry(taskFlowRegistry, controllerInstanceId);
        try {
          const initiativeReport = await initiativeTracker.migrateExistingToTaskFlow();
          console.log(
            pc.green(
              `  TaskFlow: backfilled initiatives created=${initiativeReport.created} ` +
              `existed=${initiativeReport.alreadyExisted} advanced=${initiativeReport.advanced} ` +
              `skipped=${initiativeReport.skipped}`
            )
          );
        } catch (err) {
          console.warn('[instar] taskflow initiative backfill failed (non-fatal):', err);
        }
      } catch (err) {
        console.warn('[instar] task-flow init failed (non-fatal):', err);
        taskFlowRegistry = undefined;
        threadlineFlowBridge = undefined;
        divergenceChecker = undefined;
      }
    }

    // SessionRefresh — agent-initiated session respawn. Requires a Telegram
    // adapter (v1 scope: Telegram-bound sessions only). The respawner closure
    // captures `topicMemory` by reference, so even if topicMemory is wired up
    // after this point it will be resolved at refresh-time.
    if (telegram) {
      const { SessionRefresh } = await import('../core/SessionRefresh.js');
      const telegramRef = telegram; // narrow for closure
      _sessionRefresh = new SessionRefresh({
        sessionManager,
        state,
        telegram: telegramRef,
        topicResumeMap: _topicResumeMap,
        respawner: async (sessionName: string, topicId: number, followUpPrompt: string | undefined): Promise<string> => {
          // killSession (called inside SessionRefresh) has already fired
          // beforeSessionKill (UUID persisted) and destroyed the tmux
          // session. respawnSessionForTopic spawns the new tmux running
          // `claude --resume <uuid>` and registers the topic mapping.
          await respawnSessionForTopic(sessionManager, telegramRef, sessionName, topicId, followUpPrompt, topicMemory);
          return telegramRef.getSessionForTopic(topicId) ?? sessionName;
        },
      });
    }

    // ── SessionReaper (SESSION-REAPER-SPEC) ──────────────────────────────
    // Pressure-aware reaper of idle-but-alive sessions. Ships OFF + dry-run by
    // default; the classifier's positive-evidence + confidence-contract is what
    // guarantees it never reaps a working session. Reuses composedRecoveryActive
    // (gate G) so it defers to every recovery sentinel. Pressure is freemem-tiered
    // for v1 (advisory; spawn-denial-primary is a tracked follow-up) — and note
    // an over-eager tier can only reap a GENUINELY-idle session sooner, never a
    // working one (the classifier protects working sessions regardless of tier).
    const { SessionReaper, computePressure, reaperAuditSink } = await import('../monitoring/SessionReaper.js');
    const _os = await import('node:os');
    const _resolveTopic = (tmuxSession: string): number | null => {
      const t = telegram?.getTopicForSession(tmuxSession);
      if (t == null) return null;
      const n = typeof t === 'number' ? t : Number(t);
      return Number.isFinite(n) ? n : null;
    };
    // Shared stateless KEEP-guard deps (UNIFIED-SESSION-LIFECYCLE §P2). Built
    // once here and used to back BOTH the SessionReaper and the ReapAuthority's
    // guard (`sessionManager.setReapGuard`), so a killer cannot end a session the
    // reaper would have kept — the same chain protects every kill path.
    const reapGuardDeps: import('../core/ReapGuard.js').ReapGuardDeps = {
      protectedSessions: () => sessionManager.getProtectedSessions(),
      isRecoveryActive: (session) => composedRecoveryActive(session),
      hasPendingInjection: (s) => sessionManager.getPendingInjection(s) != null,
      isRelayLeaseActive: (id) => sessionManager.isRelayLeaseActive(id),
      topicBinding: _resolveTopic,
      // Gate I is a v1 stub (returns false): active conversation is already
      // covered by the relay-lease + pending-injection gates and by render
      // stasis (a session being talked to is not render-static for the full
      // hysteresis+threshold window). Promoting to a real message-recency
      // query is a tracked tuning follow-up.
      recentUserMessage: () => false,
      activeCommitmentForTopic: (topicId) => {
        try { return commitmentTracker.getActive().some(c => c.topicId === topicId); }
        catch { return true; } // cannot tell → protect
      },
      activeSubagentCount: (csid) => {
        try { return csid ? subagentTracker.getActiveSubagents(csid).length : 0; }
        catch { return 1; } // cannot tell → protect
      },
      buildOrAutonomousActive: (topicId) => {
        const fresh = (p: string): boolean => {
          try { return fs.existsSync(p) && (Date.now() - fs.statSync(p).mtimeMs) < 30 * 60_000; }
          catch { return false; }
        };
        if (topicId != null && fresh(path.join(config.stateDir, 'autonomous', `${topicId}.local.md`))) return true;
        return fresh(path.join(config.stateDir, 'state', 'build', 'build-state.json'));
      },
      hasActiveProcesses: (s) => sessionManager.hasActiveProcesses(s),
    };

    // Wire the ReapAuthority's KEEP-guard. minAgeMs:0 disables spawn-grace here —
    // the killers that consult this guard (age-limit #2, idle-zombie #3) already
    // gate on their own age/idle thresholds, so the reaper-specific spawn-grace
    // would otherwise delay legitimate zombie kills for young-but-stuck sessions.
    {
      const { ReapGuard } = await import('../core/ReapGuard.js');
      sessionManager.setReapGuard(new ReapGuard(reapGuardDeps, { minAgeMs: 0 }));
    }
    // (setAwakeChecker is wired earlier, before the boot purge, so the purge is
    //  lease-gated — see the §P3/§P4 block above.)

    const sessionReaper = new SessionReaper(
      {
        ...reapGuardDeps,
        listRunningSessions: () => sessionManager.listRunningSessions(),
        captureOutput: (s, n) => sessionManager.captureOutput(s, n) ?? '',
        frameworkForSession: (s) => sessionManager.frameworkForSession(s) as 'claude-code' | 'codex-cli' | undefined,
        pressure: () => {
          const total = _os.totalmem();
          const freePct = total > 0 ? (_os.freemem() / total) * 100 : 100;
          // CPU pressure: 1-min load average ÷ core count. The overall tier is the
          // WORST of memory and CPU, so a CPU-bound box (the common case) raises
          // pressure even when free memory is fine. cores unknown ⇒ memory-only.
          const cores = _os.cpus()?.length ?? 0;
          const loadPerCore = cores > 0 ? _os.loadavg()[0] / cores : null;
          const rcfg = config.monitoring?.sessionReaper;
          return computePressure(
            { freePct, loadPerCore },
            {
              cpuModerateLoadPerCore: rcfg?.cpuModerateLoadPerCore ?? 1.0,
              cpuCriticalLoadPerCore: rcfg?.cpuCriticalLoadPerCore ?? 1.5,
            },
          );
        },
        terminate: (id, reason) => sessionManager.terminateSession(id, reason),
        markReaping: (id) => sessionManager.markReaping(id),
        clearReaping: (id) => sessionManager.clearReaping(id),
        // Backs cpuAwareActiveProcessKeep: lets the reaper tell a wedged/idle
        // child (CPU-flat) from a working one, so an idle MCP child no longer
        // holds an otherwise-reapable session hostage under host load.
        descendantCpuSeconds: (s) => sessionManager.descendantCpuSeconds(s),
        // Post-transfer closeout (2026-06-05): the OTHER machine that owns this
        // topic per the session-pool ownership registry, as a display identifier
        // (nickname when resolvable). Late-binds the pool objects — they are
        // constructed AFTER the reaper in this function; until the mesh block
        // wires them (and on single-machine installs forever) this returns null
        // and the rule is inert. try/catch also absorbs the TDZ window.
        topicOwnerElsewhere: (topicId) => {
          try {
            const reg = sessionOwnershipRegistry;
            const self = _meshSelfId;
            if (!reg || !self) return null;
            const owner = reg.ownerOf(String(topicId));
            if (!owner || owner === self) return null;
            return machinePoolRegistry?.getCapacity(owner)?.nickname ?? owner;
          } catch { return null; /* @silent-fallback-ok — pool not wired yet → rule inert */ }
        },
        audit: reaperAuditSink(config.stateDir),
      },
      // developmentAgent gate (standard_development_agent_dark_feature_gate):
      // cpuAwareActiveProcessKeep ships dark fleet-wide and live on dev agents
      // (echo) for dogfooding. An explicit config value always wins.
      (() => {
        const rcfg = config.monitoring?.sessionReaper;
        if (!rcfg) return rcfg; // reaper config absent ⇒ reaper disabled ⇒ flag moot
        return {
          ...rcfg,
          cpuAwareActiveProcessKeep: rcfg.cpuAwareActiveProcessKeep ?? !!config.developmentAgent,
          // Observe-only busy-orphan detection rides the same dev-gate (dark fleet,
          // live on dev agents). Zero risk — it never changes a keep/kill verdict.
          busyOrphanDetection: rcfg.busyOrphanDetection ?? !!config.developmentAgent,
        };
      })(),
    );
    sessionReaper.start();

    // ── AgentWorktreeReaper (RESPONSIBLE-RESOURCE-USAGE — OS resource hygiene) ──
    // Reclaims stale CLI-created worktrees under the agent's `.worktrees/` that
    // are merged + clean + inactive. Ships OFF + dry-run; start() no-ops when
    // disabled. Observability at GET /worktrees/agent-reaper.
    const { AgentWorktreeReaper } = await import('../monitoring/AgentWorktreeReaper.js');
    const { makeAgentWorktreeReaperDeps } = await import('../monitoring/agentWorktreeGit.js');
    const _agentWorktreesDir = path.join(path.dirname(config.stateDir), '.worktrees');
    const agentWorktreeReaper = new AgentWorktreeReaper(
      makeAgentWorktreeReaperDeps({ instarRepo: config.projectDir, worktreesDir: _agentWorktreesDir }),
      config.monitoring?.agentWorktreeReaper,
    );
    agentWorktreeReaper.start();
    if (config.monitoring?.agentWorktreeReaper?.enabled) {
      console.log(pc.green(
        config.monitoring.agentWorktreeReaper.dryRun === false
          ? '  AgentWorktreeReaper enabled (stale-worktree reclaim — LIVE)'
          : '  AgentWorktreeReaper enabled (stale-worktree reclaim — dry-run, report only)',
      ));
    }

    // ── McpProcessReaper (RESPONSIBLE-RESOURCE-USAGE — MCP-leak fix, Option B) ──
    // Reaps leaked MCP-server children (playwright-mcp / mcp-remote / instar
    // stdio) whose owning session is dead/stale or fully orphaned. Killing a
    // session's main pid doesn't cascade to MCP children, so they re-parent and
    // accumulate for days. Ships OFF + dry-run fleet-wide; the developmentAgent
    // gate ENABLES it (still dry-run) on dev agents (echo) so it observes +
    // audits would-reap WITHOUT killing until dryRun is explicitly turned off.
    // Observability at GET /processes/mcp-reaper.
    const { McpProcessReaper } = await import('../monitoring/McpProcessReaper.js');
    const { makeMcpProcessReaperDeps } = await import('../monitoring/mcpProcessReaperDeps.js');
    const _mcpReaperCfg = (() => {
      const mcfg = config.monitoring?.mcpProcessReaper;
      // developmentAgent gate: `enabled` defaults ON for dev agents (dark fleet-
      // wide); an explicit config value always wins. `dryRun` is untouched (stays
      // true by default) so a dev agent only observes — never kills.
      return { ...(mcfg ?? {}), enabled: mcfg?.enabled ?? !!config.developmentAgent };
    })();
    const mcpProcessReaper = new McpProcessReaper(
      makeMcpProcessReaperDeps({
        sessionManager,
        tmuxPath: config.sessions.tmuxPath,
        auditPath: path.join(config.stateDir, '..', 'logs', 'mcp-reaper-audit.jsonl'),
      }),
      _mcpReaperCfg,
    );
    mcpProcessReaper.start();
    if (_mcpReaperCfg.enabled) {
      console.log(pc.green(
        _mcpReaperCfg.dryRun === false
          ? '  McpProcessReaper enabled (leaked-MCP reclaim — LIVE)'
          : '  McpProcessReaper enabled (leaked-MCP reclaim — dry-run, report only)',
      ));
    }

    // ── GeminiLoopRunner (need-gem-002) — multi-turn gemini loop-driver ──────────
    // Lets the gemini mentee sustain a multi-turn task: turn 1 one-shot establishes
    // a session, later turns re-spawn `gemini -r <handle>` so context restores
    // natively (no transcript re-send → quota-efficient). Subscription-auth is
    // structural (the transport strips billing env). Ships DARK
    // (autonomousSessions.geminiLoopDriver.enabled); the developmentAgent gate turns
    // it on for dev agents only. Powers POST + GET /gemini-loop/runs.
    let geminiLoopRunner: import('../monitoring/GeminiLoopRunner.js').GeminiLoopRunner | null = null;
    {
      const gcfg = config.autonomousSessions?.geminiLoopDriver;
      const enabled = gcfg?.enabled ?? !!config.developmentAgent; // dark fleet-wide; live on dev agents
      if (enabled) {
        const { GeminiLoopRunner } = await import('../monitoring/GeminiLoopRunner.js');
        const { createGeminiLoopSpawn, createGeminiHandleCapture, createQuotaBudgetGate } =
          await import('../monitoring/geminiLoopProduction.js');
        const geminiPath = detectGeminiPath() ?? 'gemini';
        const turnTimeoutMs = gcfg?.turnTimeoutMs ?? 180_000;
        geminiLoopRunner = new GeminiLoopRunner({
          config: {
            enabled: true,
            model: gcfg?.model ?? 'gemini-2.5-flash',
            maxTurns: gcfg?.maxTurns ?? 12,
            minTurnIntervalMs: gcfg?.minTurnIntervalMs ?? 2_000,
            maxConcurrent: gcfg?.maxConcurrent ?? 1,
            maxRetainedRuns: gcfg?.maxRetainedRuns ?? 50,
          },
          spawn: createGeminiLoopSpawn(geminiPath, turnTimeoutMs),
          captureHandle: createGeminiHandleCapture(geminiPath),
          budgetGate: createQuotaBudgetGate(quotaTracker ?? null),
          log: (msg) => console.log(pc.dim(msg)),
        });
        console.log(pc.green('  GeminiLoopRunner enabled (multi-turn gemini mentee, subscription auth)'));
      }
    }

    // ── Agent hard-sleep — SleepController (RESPONSIBLE-RESOURCE-USAGE, Stage B) ──
    // Decides "is it safe for this idle agent to drop to near-zero footprint?" with
    // every safety guard. Ships OFF + dry-run: observes + audits to
    // logs/agent-sleep-events.jsonl, never stops a server. The mechanism
    // (supervisor stop + lifeline respawn) is a later slice. GET /sleep exposes the
    // live verdict. The shared idle signal (AgentActivityState) is bumped at the
    // inbound-message chokepoint (/internal/telegram-forward).
    const { AgentActivityState } = await import('../monitoring/AgentActivityState.js');
    const agentActivityState = new AgentActivityState();
    const { SleepController, sleepAuditSink, sleepRequestWriter } = await import('../monitoring/SleepController.js');
    const _sleepCfg = config.monitoring?.agentSleep;
    const sleepController = new SleepController(
      {
        sample: () => {
          const act = agentActivityState.snapshot();
          return {
            now: Date.now(),
            runningSessions: sessionManager.listRunningSessions().length,
            lastInboundAt: act.lastInboundAt,
            lastActivityAt: act.lastActivityAt,
            // Lease guard: only relevant when multi-machine coordination is active.
            leaseActive: coordinator.enabled,
            holdsLease: coordinator.enabled ? coordinator.holdsLease() : false,
            // In-flight: an inbound message currently being handled. (A fuller
            // relay/forward-queue in-flight signal + the scheduler next-fire wake are
            // tracked refinements; nextScheduledJobAt stays null until scheduler-wake
            // lands, so the scheduled-job guard is conservative-off for now.)
            inflightWork: (currentInboundByTopic?.size ?? 0) > 0,
            nextScheduledJobAt: null,
          };
        },
        audit: sleepAuditSink(config.stateDir),
        // Live-mode only (enabled && !dryRun): writes state/sleep-requested.json
        // for the ServerSupervisor to honor. Dark/dry-run never invokes this.
        requestSleep: sleepRequestWriter(config.stateDir),
      },
      {
        enabled: _sleepCfg?.enabled ?? false,
        dryRun: _sleepCfg?.dryRun ?? true,
        tickIntervalMs: (_sleepCfg?.tickIntervalSec ?? 60) * 1000,
        thresholds: {
          idleGraceMs: _sleepCfg?.idleGraceMs ?? 120_000,
          deepIdleMs: _sleepCfg?.deepIdleMs ?? 900_000,
          wakeLeadMs: _sleepCfg?.wakeLeadMs ?? 120_000,
        },
      },
    );
    sleepController.start();
    if (_sleepCfg?.enabled) {
      console.log(pc.green(
        _sleepCfg.dryRun === false
          ? '  SleepController enabled (agent hard-sleep — LIVE decision)'
          : '  SleepController enabled (agent hard-sleep — dry-run, observe only)',
      ));
    }

    // ── Unkillability backstop (UNIFIED-SESSION-LIFECYCLE §P5) ───────────────
    // Signal-only: raises ONE deduped Attention item (never auto-kills) when a
    // session is KEPT forever despite faking work, or is stuck indeterminate.
    {
      const { StaleSessionBackstop } = await import('../monitoring/StaleSessionBackstop.js');
      const { probeTranscript } = await import('../monitoring/transcriptProber.js');
      const { makeAttentionPoster } = await import('../monitoring/sentinelWiring.js');
      const _crypto = await import('node:crypto');
      const staleCfg = config.monitoring?.staleBackstop ?? {};
      const progressFloorBytes = staleCfg.progressFloorBytes ?? 512;
      const hash = (s: string): string => _crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
      const backstop = new StaleSessionBackstop(
        {
          listRunningSessions: () => sessionManager.listRunningSessions(),
          probeLiveness: (names) => sessionManager.probeLivenessBatch(names),
          snapshot: (session) => {
            const framework = session.framework ?? sessionManager.frameworkForSession(session.tmuxSession) ?? 'claude-code';
            const sessionId = framework === 'claude-code' ? (session.claudeSessionId ?? '') : '';
            const tp = probeTranscript({ framework, sessionId, projectDir: '' });
            // Tail hash: read the last progressFloorBytes so a heartbeat-byte append
            // (same tail) is NOT counted as a meaningful advance.
            let tailHash: string | null = null;
            if (tp.resolved && tp.path) {
              try {
                const fd = fs.openSync(tp.path, 'r');
                try {
                  const start = Math.max(0, tp.size - progressFloorBytes);
                  const len = tp.size - start;
                  const buf = Buffer.alloc(len);
                  fs.readSync(fd, buf, 0, len, start);
                  tailHash = hash(buf.toString('utf-8'));
                } finally { fs.closeSync(fd); }
              } catch {
                // @silent-fallback-ok — an unreadable transcript tail just means
                // "no meaningful-advance signal this tick"; the backstop treats a
                // null tail as ambiguous (never as progress), which is safe.
                tailHash = null;
              }
            }
            const frame = sessionManager.captureOutput(session.tmuxSession, 8) ?? '';
            return {
              transcriptResolved: tp.resolved,
              transcriptSize: tp.size,
              transcriptTailHash: tailHash,
              mainProcessActive: sessionManager.hasActiveProcesses(session.tmuxSession),
              idleStateToken: hash(frame),
              descendantCpuSeconds: sessionManager.descendantCpuSeconds(session.tmuxSession),
              isJobSession: !!session.jobSlug,
            };
          },
          raiseAttention: makeAttentionPoster({ port: config.port, authToken: config.authToken ?? '' }),
          setLongIndeterminate: (id, isLong) => sessionManager.markLongIndeterminate(id, isLong),
          resolveTopicName: (session) => {
            // session.name is "topic-<id>"; resolve that topic to its human name
            // so the Agent-Health heads-up reads "the 'EXO 3.0' session".
            const m = /^topic-(\d+)$/.exec(session.name);
            const tid = m ? Number(m[1]) : (telegram?.getTopicForSession?.(session.tmuxSession) ?? null);
            return (typeof tid === 'number' && telegram) ? (telegram.getTopicName?.(tid) ?? null) : null;
          },
          // Operator-protected sessions (the reaper's protectedSessions) are never
          // escalated as "stale" — they're deliberately kept alive, so flagging
          // them is crying wolf. Match by tmux name or session name.
          isProtectedSession: (session) => {
            const protectedList = sessionManager.getProtectedSessions();
            return protectedList.includes(session.tmuxSession) || protectedList.includes(session.name);
          },
        },
        staleCfg,
      );
      backstop.start();
      if (staleCfg.enabled !== false) {
        console.log(pc.green('  Unkillability backstop enabled (§P5 — signal-only, never auto-kills)'));
      }
    }
    if (config.monitoring?.sessionReaper?.enabled) {
      console.log(pc.green(
        config.monitoring.sessionReaper.dryRun === false
          ? '  SessionReaper enabled (idle-session reaper — LIVE)'
          : '  SessionReaper enabled (idle-session reaper — dry-run, logs only)',
      ));
    }

    // ── Live-tail STREAMING (spec §8 G3b) ──────────────────────────
    // The holder pushes the live conversation tail to the standby on a cadence,
    // keeping the standby's persisted copy fresh (RPO = liveTailMaxStalenessMs).
    // Gated on holding the lease, so only the awake machine streams. Solo agent
    // (no peers) → the transport's broadcast is a reachable no-op. The sender
    // transport was built in the lease block; the source + cadence are wired here
    // because the content provider needs the Telegram adapter.
    //
    // The outgoing-side planned-handoff trigger (spec §8 G3e) is assigned INSIDE
    // this block too: the sentinel must drive liveTailSource.pushTick to make the
    // standby current before it flushes the manifest, so liveTailSource has to be
    // in scope. Declared out here so the AgentServer mount (POST /handoff/initiate)
    // can read it; undefined on a solo agent / multi-machine off.
    let handoffInitiate: (() => Promise<HandoffOutcome>) | undefined;
    let handoffSentinelInProgress: (() => boolean) | undefined;
    if (liveTailSendTransport && telegram && coordinator.enabled) {
      const sendTransport = liveTailSendTransport;
      const liveTailSource = new LiveTailSource({
        // Full current tail for a topic — recent history formatted append-only.
        // (A window shift past the limit triggers a one-off full resend, which the
        // standby buffer dedups by seq + caps by bytes — correct, just occasional.)
        getTopicContent: (topic) => {
          const entries = telegram.getTopicHistory(Number(topic), 500);
          return entries.map((e) => `[${e.timestamp}] ${e.text}`).join('\n') + (entries.length ? '\n' : '');
        },
        activeTopics: () => telegram.getKnownTopicIds().map((id) => String(id)),
        // Cheap per-topic change signal — lets the source skip serializing
        // topics with no new messages instead of rebuilding every topic's
        // history every tick (the 2026-06-05 event-loop-stall fix).
        getTopicVersion: (topic) => telegram.getTopicContentVersion(Number(topic)),
        // Eternal Sentinel condition 4 (P19): a topic whose standby copy has
        // been stale past the threshold surfaces ONCE per episode through the
        // standard degradation channel (housekeeping — never a user ping).
        reportStaleStandby: ({ topic, failingForMs, consecutiveFailures }) => {
          DegradationReporter.getInstance().report({
            feature: 'LiveTail.standbyFreshness',
            primary: 'Standby machine receives a fresh copy of each conversation tail',
            fallback: `Topic ${telegram.getTopicName?.(Number(topic)) ?? topic}'s standby copy is stale (flushes failing ~${Math.round(failingForMs / 60_000)}min, ${consecutiveFailures} consecutive); retries continue on capped backoff`,
            reason: 'Live-tail flushes to the standby peer are persistently rejected or unreachable',
            impact: 'A failover during this window would resume that conversation from an older tail (bounded by the outage start).',
          });
        },
        transport: sendTransport,
        logger: (m) => console.log(pc.dim(m)),
      });
      const liveTailTimer = setInterval(() => {
        // Only the lease holder streams (mirrors the scheduler/sentinel gating).
        if (!coordinator.holdsLease()) return;
        liveTailSource.pushTick().catch((err) => {
          console.error(`[live-tail] push tick failed: ${err instanceof Error ? err.message : err}`);
        });
      }, seamlessness.liveTailPushRateMs);
      if (liveTailTimer.unref) liveTailTimer.unref();
      console.log(pc.dim(`  Live-tail streaming active (holder pushes every ${seamlessness.liveTailPushRateMs}ms when peers present)`));

      // ── Outgoing-side planned-handoff sentinel (spec §8 G3e) ──
      // The conductor: flush the live tail → POST the begin manifest → await +
      // VERIFY the incoming's caught-up echo → validate → yield → demote. The
      // CRITICAL invariant lives in HandoffSentinel: it NEVER yields the lease
      // unless the echo verifies AND validation passes — on any mismatch/timeout
      // it aborts and stays awake (no two-holders window). This block only binds
      // the ops to the live components. Additionally gated on handoffWireTransport
      // (the signed begin/ack/yield channel). The trigger is the explicit
      // POST /handoff/initiate route (no sleep auto-trigger — SleepWakeDetector
      // emits only 'wake', so there is no pre-sleep hook for v1).
      if (handoffWireTransport) {
        // The active-topic selection + dep binding live in the extracted
        // createHandoffSentinelBootWiring factory so the boot glue is unit-tested
        // (wiring-integrity), not inline here.
        const sentinelWiring = createHandoffSentinelBootWiring({
          telegram,
          coordinator,
          liveTailSource,
          wire: handoffWireTransport,
          handoffAckTimeoutMs: seamlessness.handoffAckTimeoutMs,
          minHandoffIntervalMs: seamlessness.minHandoffIntervalMs,
          logger: (m) => console.log(pc.dim(`  ${m}`)),
        });
        handoffInitiate = sentinelWiring.initiate;
        handoffSentinelInProgress = () => sentinelWiring.sentinel.inProgress;
        console.log(pc.dim('  Handoff sentinel active (operator trigger: POST /handoff/initiate)'));
      }
    }

    // ── Incoming-side planned-handoff receiver (spec §8 G3d/G3e) ──
    // Constructed on every mesh machine; it acts only while this machine is the
    // standby being handed to. The begin route hands us the outgoing's flush
    // manifest; buildAck echoes its tailSeq + ingressPosition and recomputes the
    // thread-history hash from OUR own synced state (matches iff the live-tail
    // kept us caught up — same hash function the outgoing's flush uses). The lease
    // CAS is attempted ONLY on the explicit yield, never on the ack.
    let onHandoffBegin: ((manifest: unknown, fromMachineId: string) => void) | undefined;
    if (handoffWireTransport && telegram && coordinator.enabled) {
      const hwt = handoffWireTransport;
      const handoffWiring = createHandoffReceiverWiring({
        sendAck: (ack) => hwt.sendAck(ack),
        acquireLeaseOnConsent: (from) => coordinator.acquireLeaseOnConsent(from),
        getTopicHistory: (topic, limit) => telegram.getTopicHistory(topic, limit),
        logger: (m) => console.log(pc.dim(`  ${m}`)),
      });
      // The yield route → transport.recordYield → this handler → receiver.onYield → lease CAS.
      hwt.onYield(handoffWiring.yieldHandler);
      // The begin route → store the manifest + drive the caught-up ack build/send.
      onHandoffBegin = handoffWiring.onBegin;
      console.log(pc.dim('  Handoff receiver active (begin→ack, yield→lease CAS)'));
    }

    // ── Exactly-once ingress ledger (spec §8 G3a) ──────────────────
    // Constructed ONLY when multiMachine.exactlyOnceIngress is enabled (default
    // off). When absent the inbound/outbound message path is byte-for-byte
    // unchanged — this ships dark and is flipped on only after a live
    // test-as-self confirms no false-drops on the most critical path.
    let messageLedger: MessageProcessingLedger | undefined;
    let currentInboundByTopic: Map<string, string> | undefined;
    if (seamlessness.exactlyOnceIngress) {
      try {
        messageLedger = MessageProcessingLedger.open(config.projectName, config.stateDir);
        currentInboundByTopic = new Map<string, string>();
        console.log(pc.dim('  Exactly-once ingress ledger ACTIVE (spec §8 G3a — inbound dedup + reply commit)'));
      } catch (err) {
        console.error(`[exactly-once] ledger open failed, gate stays dark: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── ReleaseReadinessSentinel (Layer B of release-readiness-visibility) ──
    // Repo-gated dev-environment watchdog: only constructed when the install has
    // an analyzable instar git repo AND the feature is enabled in config. On a
    // plain npm-installed agent (no instar repo) it stays null → routes 503,
    // never a spurious signal. Not start()ed here — the off-by-default
    // release-readiness-check job drives tick() via POST /release-readiness/tick.
    let releaseReadinessSentinel: import('../monitoring/ReleaseReadinessSentinel.js').ReleaseReadinessSentinel | null = null;
    {
      const rrCfg = config.monitoring?.releaseReadiness;
      const repoPath = rrCfg?.repoPath ?? process.cwd();
      if (rrCfg?.enabled) {
        const { isAnalyzableRepo, buildReleaseReadinessDeps } = await import('../monitoring/releaseReadinessWiring.js');
        if (isAnalyzableRepo(repoPath)) {
          const { ReleaseReadinessSentinel } = await import('../monitoring/ReleaseReadinessSentinel.js');
          const deps = buildReleaseReadinessDeps({
            repoPath,
            statePath: path.join(config.stateDir, 'release-readiness.json'),
            auditPath: path.join(config.stateDir, '..', 'logs', 'sentinel-events.jsonl'),
            port: config.port,
            authToken: config.authToken ?? '',
            canonicalRemote: rrCfg.canonicalRemote,
            fetchTimeoutMs: rrCfg.fetchTimeoutMs,
          });
          releaseReadinessSentinel = new ReleaseReadinessSentinel(deps, {
            enabled: true,
            tickIntervalMs: rrCfg.tickIntervalMs,
            backlogAgeDaysSilent: rrCfg.backlogAgeDaysSilent,
            backlogAgeDaysLow: rrCfg.backlogAgeDaysLow,
            backlogAgeDaysMedium: rrCfg.backlogAgeDaysMedium,
            backlogAgeDaysHigh: rrCfg.backlogAgeDaysHigh,
            hysteresisHours: rrCfg.hysteresisHours,
            staleEpisodeTtlDays: rrCfg.staleEpisodeTtlDays,
          });
          console.log(pc.green('  ReleaseReadinessSentinel enabled (release-hygiene watchdog — job-driven)'));
        } else {
          console.log(pc.dim('  ReleaseReadinessSentinel enabled in config but no analyzable instar repo found — staying inert'));
        }
      }
    }

    // ── Multi-Machine Session Pool registry (§L2) — live MachineCapacity view for GET /pool ──
    // Always instantiated (cheap); the feature stays dark behind the sessionPool stage gate.
    // Self-attests hardware + records a self-heartbeat so GET /pool + the Machines tab show
    // this machine online with its specs; peer liveness is fed from MachineHeartbeat.
    let machinePoolRegistry: import('../core/MachinePoolRegistry.js').MachinePoolRegistry | undefined;
    try {
      const poolMod = await import('../core/MachinePoolRegistry.js');
      const osMod = await import('node:os');
      const poolIdMgr = coordinator?.managers?.identityManager;
      if (poolIdMgr) {
        const failoverThresholdMs = (config.multiMachine?.failoverTimeoutMinutes ?? 15) * 60_000;
        const clockSkewToleranceMs =
          (config.multiMachine?.sessionPool as { clockSkewToleranceMs?: number } | undefined)?.clockSkewToleranceMs ?? 300_000;
        machinePoolRegistry = new poolMod.MachinePoolRegistry({
          listMachines: () =>
            poolIdMgr.getActiveMachines().map(({ machineId, entry }) => ({
              machineId,
              nickname: entry.nickname,
              hardware: entry.hardware,
            })),
          clockSkewToleranceMs,
          failoverThresholdMs,
          logger: (m: string) => console.log(pc.dim(`  [pool] ${m}`)),
        });
        const poolSelfId =
          machineHeartbeat?.config?.machineId ??
          (poolIdMgr.hasIdentity() ? poolIdMgr.loadIdentity().machineId : null);
        if (poolSelfId) {
          try {
            poolIdMgr.recordSelfHardware(poolSelfId, poolMod.captureHardware());
          } catch { /* best-effort hardware self-attest */ }
          // Quota-aware placement (2026-06-05): self-report whether a NEW
          // session on THIS machine could work right now. Blocked = a provider
          // block is in effect (blockedUntil in the future) or the 5-hour
          // window is exhausted (>= 95%, the same bar QuotaTracker.canRunJob
          // uses to block all spawns). Sourced from THIS machine's own
          // QuotaTracker — never another machine's file (the gemini
          // quota-conflation lesson). Absent/unreadable state = not blocked.
          const selfQuotaState = (): { blocked: boolean; blockedUntil?: string; reason?: string } | undefined => {
            try {
              const q = quotaTracker?.getState();
              if (!q) return undefined;
              const blockActive = !!q.blockedUntil && Date.parse(q.blockedUntil) > Date.now();
              const fiveHourExhausted = (q.fiveHourPercent ?? 0) >= 95;
              if (!blockActive && !fiveHourExhausted) return { blocked: false };
              return {
                blocked: true,
                blockedUntil: q.blockedUntil,
                reason: q.blockReason ?? (fiveHourExhausted ? `5-hour window at ${q.fiveHourPercent}%` : 'provider block'),
              };
            } catch { return undefined; /* unknown ≠ blocked */ }
          };
          const refreshPool = (): void => {
            try {
              machinePoolRegistry!.recordHeartbeat({
                machineId: poolSelfId,
                selfReportedLastSeen: new Date().toISOString(),
                loadAvg: osMod.loadavg()[0],
                quotaState: selfQuotaState(),
              });
              const hbApi = machineHeartbeat?.api;
              if (hbApi) {
                for (const r of hbApi.listAll()) {
                  if (r.machineId !== poolSelfId) {
                    machinePoolRegistry!.recordHeartbeat({ machineId: r.machineId, selfReportedLastSeen: r.lastHeartbeatAt });
                  }
                }
              }
            } catch { /* best-effort pool refresh */ }
          };
          refreshPool();
          const poolTimer = setInterval(refreshPool, 30_000);
          if (typeof poolTimer.unref === 'function') poolTimer.unref();
        }
      }
    } catch (err) {
      console.log(pc.dim(`  [pool] registry not wired: ${err instanceof Error ? err.message : String(err)}`));
    }

    // ── MeshRpc dispatcher (§L0) + SessionOwnership registry (§L3) ──
    // Built when there's a machine identity. The ownership registry (L3) feeds
    // the dispatcher's RBAC (ownerOf/placementTargetOf) + the place/claim/
    // transfer/release handlers; read-class handlers (capacity/session-status)
    // are live too. Single-machine uses the in-memory store; the cross-machine
    // git-backed store swaps in for the Track-H proof (the registry is store-agnostic).
    let meshRpcDispatcher: import('../core/MeshRpc.js').MeshRpcDispatcher | undefined;
    let sessionOwnershipRegistry: import('../core/SessionOwnershipRegistry.js').SessionOwnershipRegistry | undefined;
    try {
      const meshMod = await import('../core/MeshRpc.js');
      const idMod = await import('../core/MachineIdentity.js');
      const meshIdMgr = coordinator?.managers?.identityManager;
      const meshSelfId = machineHeartbeat?.config?.machineId
        ?? (meshIdMgr?.hasIdentity() ? meshIdMgr.loadIdentity().machineId : null);
      if (meshIdMgr && meshSelfId) {
        const meshClockToleranceMs = config.multiMachine?.sessionPool?.meshRpcClockToleranceMs ?? 30000;
        const seenMeshNonces = new Map<string, number>(); // `${sender}:${nonce}` → ts, age-pruned
        const meshPruneMs = Math.max(meshClockToleranceMs * 4, 120_000);
        // SessionOwnership registry (§L3) — in-memory store (single-machine correct;
        // git-backed cross-machine store is the Track-H swap). Per-session nonce set.
        const ownMod = await import('../core/SessionOwnershipRegistry.js');
        const seenOwnNonces = new Set<string>();
        sessionOwnershipRegistry = new ownMod.SessionOwnershipRegistry({
          store: new ownMod.InMemorySessionOwnershipStore(),
          seenNonce: (k) => seenOwnNonces.has(k),
          recordNonce: (k) => seenOwnNonces.add(k),
          logger: (m: string) => console.log(pc.dim(`  ${m}`)),
        });
        const ownReg = sessionOwnershipRegistry;
        // The §L3 ownership commands, routed from MeshRpc to the registry CAS.
        const ownAction = (
          cmd: import('../core/MeshRpc.js').MeshCommand,
          sender: string,
          env: import('../core/MeshRpc.js').MeshEnvelope,
        ): unknown => {
          if (cmd.type === 'place') return ownReg.cas({ type: 'place', machineId: cmd.machine }, { sessionKey: cmd.session, sender, nonce: env.nonce });
          if (cmd.type === 'claim') return ownReg.cas({ type: 'claim', machineId: sender }, { sessionKey: cmd.session, sender, nonce: env.nonce });
          if (cmd.type === 'transfer') return ownReg.cas({ type: 'transfer', to: cmd.target }, { sessionKey: cmd.session, sender, nonce: env.nonce });
          if (cmd.type === 'release') return ownReg.cas({ type: 'release', machineId: sender }, { sessionKey: cmd.session, sender, nonce: env.nonce });
          return { ok: false, reason: 'unsupported' };
        };
        // The §L4 owner-side deliverMessage receive handler (shared factory — same
        // code path the tests exercise). Durable-receipt-before-processing with
        // idempotent dedupe on messageId + the stale-ownership fence. Returns the
        // deliverMessageAck the router waits on before advancing the platform offset.
        // (Local processing hand-off to SessionManager is the Track-H staged
        // activation; the durable receipt + ACK is the complete dark-phase contract.)
        const deliverMod = await import('../core/DeliverMessageHandler.js');
        const deliverSeenFallback = new Set<string>(); // used only if the SQLite ledger is unavailable
        const deliverMessageHandler = deliverMod.createDeliverMessageHandler({
          ownerEpochOf: (s) => ownReg.read(s)?.ownershipEpoch ?? null,
          recordReceipt: (messageId, session) => {
            if (messageLedger) return messageLedger.record(messageId, { platform: 'mesh', topic: session }).firstSeen;
            if (deliverSeenFallback.has(messageId)) return false;
            deliverSeenFallback.add(messageId);
            return true;
          },
          // Owner-side bridge (§L4 handoff): a forwarded message landed → spawn/resume
          // the local session for the topic so the conversation continues on THIS machine.
          // Only fires for a FIRST-seen forwarded deliverMessage (the ledger dedupes
          // redeliveries), and a deliverMessage only arrives from a router peer — but we
          // double-gate on stage!=='dark' to be safe. Fire-and-forget: the durable receipt
          // is already recorded + ACKed before this runs.
          onAccepted: (cmd) => {
            if (_sessionPoolStage() === 'dark' || !telegram) return;
            const tg = telegram;
            const topicId = Number(cmd.session);
            if (!Number.isFinite(topicId)) return;
            const text = typeof cmd.payload === 'string'
              ? cmd.payload
              : (cmd.payload && typeof cmd.payload === 'object' && 'text' in (cmd.payload as object))
                ? String((cmd.payload as { text: unknown }).text)
                : undefined;
            // bug #13: a moved session ALREADY running on this machine must receive
            // follow-ups via INJECTION (mirroring the normal inbound dispatch), NOT a
            // re-spawn. getSessionForTopic returns the already-prefixed tmux name; routing
            // it back through spawnSessionForTopic re-prefixes it (projectBase-projectBase-
            // topic-N) so tmuxSessionExists misses and a DUPLICATE session is spawned on
            // every follow-up — the moved conversation never advances. So: if a live
            // session exists, inject the text into it (with the [telegram:N …] prefix the
            // session expects) and return; only spawn when there is none.
            const existing = tg.getSessionForTopic(topicId);
            if (existing && sessionManager.isSessionAlive(existing)) {
              if (text) {
                console.log(pc.green(`  [session-pool] owner-side inject for forwarded topic ${topicId} → ${existing}`));
                sessionManager.injectTelegramMessage(existing, topicId, text, tg.getTopicName?.(topicId) ?? undefined);
                tg.trackMessageInjection(topicId, existing, text);
              }
              return;
            }
            // No live session yet (the FIRST forwarded message for this topic, or the
            // prior one died) — spawn the moved session with the relayed context, under a
            // clean topic-derived name. NEVER reuse the prefixed getSessionForTopic value
            // as the spawn name (that is the double-prefix defect above).
            const spawnName = `topic-${topicId}`;
            // bug #2: fetch the prior conversation from the router (this machine's local
            // history for the topic is empty) so the moved session continues with context
            // instead of starting blank. Best-effort — on any failure we spawn without it.
            void (async (): Promise<string> => {
              let movedContext: string | undefined;
              try {
                const url = _resolveRouterUrl?.() ?? null;
                if (url) {
                  const resp = await fetch(`${url}/telegram/topics/${topicId}/messages?limit=50`, {
                    headers: { 'Authorization': `Bearer ${config.authToken}` },
                  });
                  if (resp.ok) {
                    const j = (await resp.json()) as { messages?: import('../core/ForwardedTopicContext.js').ForwardedHistoryMessage[] };
                    movedContext = formatForwardedTopicContext(j.messages, tg.getTopicName?.(topicId) ?? undefined) || undefined;
                  }
                }
              } catch {
                // @silent-fallback-ok — cross-machine context relay is best-effort
              }
              return spawnSessionForTopic(sessionManager, tg, spawnName, topicId, text, undefined, undefined, movedContext);
            })()
              .then((name) => {
                tg.registerTopicSession(topicId, name, spawnName);
                console.log(pc.green(`  [session-pool] owner-side resume for forwarded topic ${topicId} → ${name}`));
              })
              .catch((err) => console.warn(`  [session-pool] owner-side resume failed for topic ${topicId}: ${err instanceof Error ? err.message : String(err)}`));
          },
        });
        // ── Secret-sync inbound handler (cross-machine secret distribution, spec Phase 4) ──
        // Dark by default; live on the dev agent via the developmentAgent gate. An inbound
        // `secret-share` command is decrypted to THIS machine's X25519 key and stored in the
        // local encrypted vault. The sender's authenticity + registered-peer gate are enforced
        // by the mesh acceptance layer before this runs; confidentiality is enforced by the
        // decryption (a payload not sealed to our key fails). The OUTBOUND provisioner is wired
        // after the MeshRpcClient is constructed (below).
        const _secretSyncCfg =
          (config.multiMachine as { secretSync?: { enabled?: boolean; pushEnabled?: boolean } } | undefined)?.secretSync;
        const _secretSyncEnabled = _secretSyncCfg?.enabled ?? !!config.developmentAgent;
        // SAFETY: pushing is opt-in SEPARATELY from receiving and DEFAULTS OFF. A machine
        // whose local secret store is stale/divergent (e.g. recovered from a key drift) would
        // otherwise auto-push its stale set to peers on boot and CLOBBER their good secrets —
        // the exact corruption class this guard prevents. So `enabled` alone = RECEIVE-ONLY;
        // outbound (boot best-effort + POST /secrets/sync-now) requires `pushEnabled: true`,
        // which you set only on the machine whose store is authoritative.
        const _secretSyncPushEnabled = _secretSyncEnabled && (_secretSyncCfg?.pushEnabled ?? false);
        let _secretShareHandler: import('../core/SecretSync.js').SecretShareHandler | undefined;
        if (_secretSyncEnabled) {
          try {
            const secretSyncMod = await import('../core/SecretSync.js');
            const secretStoreMod = await import('../core/SecretStore.js');
            const cryptoMod = await import('node:crypto');
            const secretStore = new secretStoreMod.SecretStore({ stateDir: config.stateDir });
            _secretShareHandler = new secretSyncMod.SecretShareHandler({
              ownEncryptionPrivateKey: () => cryptoMod.createPrivateKey(meshIdMgr.loadEncryptionKey()),
              store: { set: (k, v) => secretStore.set(k, v) },
              log: (m) => console.log(pc.dim(`  ${m}`)),
            });
            console.log(pc.dim('  [secret-sync] enabled — inbound handler wired'));
          } catch (err) {
            console.log(pc.dim(`  [secret-sync] inbound handler not wired: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
        meshRpcDispatcher = new meshMod.MeshRpcDispatcher({
          verify: {
            selfMachineId: meshSelfId,
            verify: (canonical, signature, sender) => {
              const pem = meshIdMgr.getSigningPublicKeyPem(sender);
              if (!pem) return false;
              try { return idMod.verify(canonical, signature, pem); } catch { return false; }
            },
            isRegisteredPeer: (s) => meshIdMgr.isMachineActive(s),
            seenNonce: (s, n) => seenMeshNonces.has(`${s}:${n}`),
            now: () => Date.now(),
            clockToleranceMs: meshClockToleranceMs,
          },
          rbac: {
            routerHolder: () => coordinator?.getSyncStatus().leaseHolder ?? null,
            ownerOf: (s) => ownReg.ownerOf(s),
            placementTargetOf: (s) => ownReg.placementTargetOf(s),
          },
          recordNonce: (s, n) => {
            const t = Date.now();
            seenMeshNonces.set(`${s}:${n}`, t);
            if (seenMeshNonces.size > 5000) {
              for (const [k, v] of seenMeshNonces) if (t - v > meshPruneMs) seenMeshNonces.delete(k);
            }
          },
          handlers: {
            'capacity-report': () => machinePoolRegistry?.getCapacities() ?? [],
            'session-status': () => machinePoolRegistry?.getCapacity(meshSelfId) ?? { machineId: meshSelfId },
            place: ownAction,
            claim: ownAction,
            transfer: ownAction,
            release: ownAction,
            deliverMessage: deliverMessageHandler,
            'secret-share': (cmd, sender) =>
              _secretShareHandler
                ? _secretShareHandler.handle(cmd as { type: 'secret-share'; encrypted: string }, sender)
                : { ok: false, reason: 'secret-sync disabled' },
          },
          logger: (m: string) => console.log(pc.dim(`  ${m}`)),
        });

        // ── L4 SessionRouter (activation transport) — shared via _sessionRouter ──
        // Constructed with the real registry/ownership/placement + the outbound
        // MeshRpcClient so it can reach peers. INERT until the rollout stage advances
        // past 'dark': the inbound dispatch interception only consults it when
        // _sessionPoolStage() !== 'dark'. Single-machine → placement keeps everything local.
        try {
          const routerMod = await import('../core/SessionRouter.js');
          const placeMod = await import('../core/PlacementExecutor.js');
          const clientMod = await import('../core/MeshRpcClient.js');
          let routerNonce = 0;
          const meshClient = new clientMod.MeshRpcClient({
            selfMachineId: meshSelfId,
            sign: (c) => idMod.sign(c, localSigningKeyPem),
            nonce: () => `${meshSelfId}:r:${Date.now()}:${++routerNonce}`,
            now: () => Date.now(),
          });
          const peerUrl = (machineId: string): string | null =>
            meshIdMgr.getActiveMachines().find((m) => m.machineId === machineId)?.entry.lastKnownUrl ?? null;
          _meshSelfId = meshSelfId;
          _resolveRouterUrl = () => {
            const h = coordinator.getSyncStatus().leaseHolder;
            return h && h !== meshSelfId ? peerUrl(h) : null;
          };
          _resolvePeerUrls = () =>
            meshIdMgr
              .getActiveMachines()
              .filter((m) => m.machineId !== meshSelfId && !!m.entry.lastKnownUrl)
              .map((m) => ({ machineId: m.machineId, url: m.entry.lastKnownUrl as string }));
          // ── Self-nickname convergence (§L4, 2026-06-04 live-caught fix) ──
          // `updateNickname` (PATCH /pool/machines) is local-only, so a rename applied on a
          // PEER's registry never reaches the owning machine — leaving that machine unable to
          // resolve its OWN nickname (the laptop's self-entry was nickname=None, so "move it
          // back to the laptop" silently failed on the very machine that runs the relocation
          // check). Periodically adopt our own nickname from a peer's authoritative /pool view
          // and persist it, making getCapacities() SYMMETRIC so the recognizer, the transfer
          // route, and /pool all resolve self. No-ops once the local nickname is known.
          const selfNickMod = await import('../core/SelfNicknameResolver.js');
          const convergeSelfNickname = async (): Promise<void> => {
            try {
              if (!machinePoolRegistry) return;
              const localCaps = machinePoolRegistry.getCapacities();
              if (localCaps.find((c) => c.machineId === meshSelfId)?.nickname?.trim()) return; // already known
              // Collect peers' authoritative /pool views (they carry this machine's nickname).
              const peerCapacities: { machineId: string; nickname?: string }[][] = [];
              for (const m of meshIdMgr.getActiveMachines()) {
                if (m.machineId === meshSelfId) continue;
                const url = peerUrl(m.machineId);
                if (!url) continue;
                try {
                  const r = await fetch(`${url}/pool`, { headers: { Authorization: `Bearer ${config.authToken}` } });
                  if (!r.ok) continue;
                  const j = (await r.json()) as { machines?: { machineId: string; nickname?: string }[] };
                  if (j.machines) peerCapacities.push(j.machines);
                } catch {
                  /* @silent-fallback-ok — best-effort peer fetch; convergence retries on the timer */
                }
              }
              const resolved = selfNickMod.resolveSelfNickname({ selfMachineId: meshSelfId, localCapacities: localCaps, peerCapacities });
              if (resolved) {
                meshIdMgr.updateNickname(meshSelfId, resolved);
                console.log(pc.green(`  [self-nickname] adopted "${resolved}" for ${meshSelfId} from a peer's view (was unset locally)`));
              }
            } catch {
              /* @silent-fallback-ok — convergence is best-effort; never blocks startup */
            }
          };
          void convergeSelfNickname();
          const selfNickTimer = setInterval(() => { void convergeSelfNickname(); }, 60_000);
          if (typeof selfNickTimer.unref === 'function') selfNickTimer.unref();
          // ── Secret-sync OUTBOUND provisioner (push-on-provision, spec Phase 4) ──
          // Constructed here (after meshClient + peerUrl exist). Encrypts the secret set
          // PER online peer to that peer's X25519 key and pushes a signed `secret-share`.
          // Dark by default; live on the dev agent via the same gate as the inbound handler.
          // Exposed to routes via _secretSyncHandle (push lever + read-only status). A boot
          // best-effort push covers a peer that came online after a secret was provisioned
          // elsewhere; the deterministic POST /secrets/sync-now is the explicit lever.
          if (_secretSyncEnabled) {
            try {
              const secretSyncMod = await import('../core/SecretSync.js');
              const secretStoreMod = await import('../core/SecretStore.js');
              const cryptoModOut = await import('node:crypto');
              const provStore = new secretStoreMod.SecretStore({ stateDir: config.stateDir });
              const readSecrets = (): import('../core/SecretStore.js').Secrets => {
                // @silent-fallback-ok — no vault on disk (or unreadable) ⇒ nothing to sync; an
                // empty set makes provisionAll a clean no-op rather than crashing the boot path.
                try { return provStore.read(); } catch { return {}; }
              };
              const onlinePeers = (): { machineId: string; nickname?: string | null }[] =>
                meshIdMgr.getActiveMachines()
                  .filter((m) => m.machineId !== meshSelfId)
                  .filter((m) => machinePoolRegistry?.getCapacity(m.machineId)?.online ?? false)
                  .map((m) => ({ machineId: m.machineId, nickname: machinePoolRegistry?.getCapacity(m.machineId)?.nickname ?? null }));
              const provisioner = new secretSyncMod.SecretProvisioner({
                secretsToSync: readSecrets,
                listPeers: () =>
                  onlinePeers()
                    .map((p) => {
                      const pem = meshIdMgr.getEncryptionPublicKeyPem(p.machineId);
                      if (!pem) return null;
                      const b64 = cryptoModOut.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
                      return { machineId: p.machineId, encryptionPublicKey: b64 };
                    })
                    .filter((x): x is { machineId: string; encryptionPublicKey: string } => x !== null),
                send: async (machineId, command) => {
                  const url = peerUrl(machineId);
                  if (!url) return { ok: false, reason: 'no peer url' };
                  const r = await meshClient.send({ machineId, url }, command, 0);
                  return { ok: r.ok, reason: r.reason };
                },
                log: (m) => console.log(pc.dim(`  ${m}`)),
              });
              _secretSyncHandle = {
                enabled: true,
                pushEnabled: _secretSyncPushEnabled,
                // Outbound is gated on pushEnabled: a receive-only machine NEVER pushes its
                // (possibly stale) set to peers. The route surfaces a clear refusal instead.
                provisionAll: () => _secretSyncPushEnabled
                  ? provisioner.provisionAll()
                  : Promise.resolve([]),
                localKeyPaths: () => secretSyncMod.secretKeyPaths(readSecrets()),
                // Vault readability probe — NEVER mask a decrypt failure as "empty"
                // (the 2026-06-05 bifurcation hid behind localKeyPaths: []).
                vaultStatus: () => {
                  try {
                    const secrets = provStore.read();
                    return { status: Object.keys(secrets).length > 0 ? 'ok' as const : 'empty' as const };
                  } catch (err) {
                    return { status: 'decrypt-failed' as const, error: err instanceof Error ? err.message : String(err) };
                  }
                },
                syncTargets: onlinePeers,
              };
              if (_secretSyncPushEnabled) {
                // Boot best-effort: push current secrets to any peer already online.
                // @silent-fallback-ok — fire-and-forget; per-peer failures are already captured
                // in provisionAll's result array, and a fresh push fires on the next provision /
                // the deterministic POST /secrets/sync-now. Boot must never block on a peer.
                void provisioner.provisionAll().catch(() => {});
                console.log(pc.dim('  [secret-sync] enabled — outbound provisioner wired (push ON)'));
              } else {
                console.log(pc.dim('  [secret-sync] enabled — RECEIVE-ONLY (push disabled; set multiMachine.secretSync.pushEnabled=true on the authoritative machine to push)'));
              }
            } catch (err) {
              console.log(pc.dim(`  [secret-sync] outbound provisioner not wired: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
          // This machine participates in the session pool, so a read-only standby may
          // persist the PER-SESSION state of sessions it's handed (the pool's owner-side
          // resume only fires for CAS-confirmed owned sessions, and only past 'dark').
          // Shared-cluster writes stay blocked on a standby. (bug #9: the moved session's
          // saveSession was blocked by the standby read-only guard.)
          state.setSessionPoolActive(true);
          _sessionRouter = new routerMod.SessionRouter({
            selfMachineId: meshSelfId,
            placement: new placeMod.PlacementExecutor(),
            machineRegistry: () => machinePoolRegistry?.getCapacities() ?? [],
            resolveOwnership: (sk) => {
              const r = ownReg.read(sk);
              if (!r) return { owner: null, epoch: 0, status: null };
              const status = r.status === 'released' ? null : (r.status as 'active' | 'placing' | 'transferring');
              return { owner: ownReg.ownerOf(sk), epoch: r.ownershipEpoch, status, target: ownReg.placementTargetOf(sk) ?? undefined };
            },
            isMachineAlive: (m) => m === meshSelfId || (machinePoolRegistry?.getCapacity(m)?.online ?? false),
            casClaimOwnership: (sk, machineId) => {
              const r = ownReg.cas({ type: 'place', machineId }, { sessionKey: sk, sender: meshSelfId, nonce: `${meshSelfId}:c:${++routerNonce}` });
              return { ok: r.ok, epoch: ownReg.read(sk)?.ownershipEpoch ?? 0 };
            },
            // bug #11: confirm the remote owner (placing → active) after the spawn is
            // dispatched. The router holds the authoritative ownReg (single-router
            // topology); the FSM permits a claim whose machineId equals the placed
            // owner, so the router confirms on the target's behalf. Without this the
            // record stays 'placing' and every later message for the session queues.
            confirmClaim: (sk, machineId) => {
              ownReg.cas({ type: 'claim', machineId }, { sessionKey: sk, sender: meshSelfId, nonce: `${meshSelfId}:cl:${++routerNonce}` });
            },
            deliverMessage: async (target, env) => {
              const url = peerUrl(target);
              if (!url) throw new Error(`no peer url for ${target}`);
              const res = await meshClient.send({ machineId: target, url }, { type: 'deliverMessage', session: env.sessionKey, messageId: env.messageId, payload: env.payload, ownershipEpoch: env.ownershipEpoch }, env.ownershipEpoch);
              if (res.ok && res.result && typeof res.result === 'object' && 'accepted' in (res.result as object)) {
                return res.result as { messageId: string; accepted: 'queued' | 'duplicate' | 'stale-ownership' };
              }
              throw new Error(`deliverMessage rejected: ${res.status} ${res.reason ?? ''}`);
            },
            spawnOnMachine: async (machineId, msg) => {
              const url = peerUrl(machineId);
              if (!url) throw new Error(`no peer url for ${machineId}`);
              await meshClient.send({ machineId, url }, { type: 'deliverMessage', session: msg.sessionKey, messageId: msg.messageId, payload: msg.payload, ownershipEpoch: 0 }, 0);
            },
            handleLocally: async () => { /* inbound interception falls through to the existing local spawn */ },
            queueMessage: () => { /* queued — left for the inbound path's redelivery/retry */ },
            raiseAttention: (title, body) => console.log(pc.dim(`  [session-router] attention: ${title} — ${body}`)),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            log: (line) => console.log(pc.dim(`  [session-router] ${line}`)),
          });

          // ── B (HTTP presence transport): pull each peer's self-capacity over
          // the signed /mesh/rpc channel and record it into the pool registry.
          // This is the credential-less presence path — a standby that cannot
          // push a git-synced MachineHeartbeat (no write access to the shared
          // agent repo) still appears ONLINE to the router purely over its
          // tunnel. Symmetric: every mesh machine runs one, so each maintains its
          // own HTTP-sourced view of peer liveness, parallel to (and idempotent
          // with) the git-synced refreshPool path for credentialed peers.
          // 'session-status' is a read-class command (RBAC: any registered peer),
          // so it authenticates off the mutual identity established at pairing —
          // no router role, no epoch fence required.
          const presenceMod = await import('../core/PeerPresencePuller.js');
          const peerPresencePuller = new presenceMod.PeerPresencePuller({
            selfMachineId: meshSelfId,
            listPeers: () =>
              meshIdMgr
                .getActiveMachines()
                .filter((m) => !m.entry.revokedAt)
                .map((m) => ({ machineId: m.machineId, url: peerUrl(m.machineId) })),
            fetchPeerCapacity: async (machineId, url) => {
              const res = await meshClient.send({ machineId, url }, { type: 'session-status' }, 0);
              if (res.ok && res.result && typeof res.result === 'object') {
                return res.result as { selfReportedLastSeen?: string; loadAvg?: number };
              }
              return null;
            },
            recordHeartbeat: (obs) => { machinePoolRegistry?.recordHeartbeat(obs); },
            log: (line) => console.log(pc.dim(`  [peer-presence] ${line}`)),
          });
          void peerPresencePuller.pullOnce();
          const peerPresenceTimer = setInterval(() => { void peerPresencePuller.pullOnce(); }, 30_000);
          if (typeof peerPresenceTimer.unref === 'function') peerPresenceTimer.unref();

          _sessionPoolStage = () => {
            try {
              const fallback = (config.multiMachine?.sessionPool ?? {}) as { enabled?: boolean; stage?: string };
              const live = liveConfig.get('multiMachine.sessionPool', fallback) as { enabled?: boolean; stage?: string };
              return live?.enabled && live?.stage ? String(live.stage) : 'dark';
            } catch { return 'dark'; }
          };
          console.log(pc.green('  SessionRouter wired (L4) — inert until rollout stage advances past dark'));

          // bug #7: tokenless-standby outbound Telegram relay. TelegramAdapter.sendToTopic
          // only invokes this when the adapter has NO bot token (a pool standby serving a
          // session moved to it); a token-holding router never calls it. It relays the send
          // to the Telegram-OWNING lease holder's /telegram/reply, so a moved session's
          // replies reach the user without the standby ever sending on the shared bot
          // (preserving the single-Telegram-owner invariant — the 409-conflict guard).
          if (telegram) {
            // Bounded + observable relay (see src/core/TelegramRelay.ts). The
            // original inline fetch had NO timeout (a stalled holder tunnel hung
            // the moved session's reply >70s) and logged NOTHING on failure (a
            // dropped reply was invisible). Timeout tunable via
            // config.multiMachine.relayTimeoutMs (default 15s).
            const relayTimeoutMs = ((): number => {
              const v = (config as { multiMachine?: { relayTimeoutMs?: number } }).multiMachine?.relayTimeoutMs;
              return typeof v === 'number' && v > 0 ? v : 15_000;
            })();
            telegram.outboundRelay = (topicId, text, opts) =>
              relayOutbound(topicId, text, opts, {
                leaseHolder: () => coordinator.getSyncStatus().leaseHolder,
                selfMachineId: meshSelfId,
                peerUrl,
                authToken: config.authToken,
                timeoutMs: relayTimeoutMs,
                log: (line) => console.warn(pc.yellow(`  ${line}`)),
              });
          }

          // ── L4 transfer-by-nickname activation: the "move/run this on <nickname>"
          // trigger. The recognizer + planner are pure units; this wires them to the
          // pin store + ownership so a recognized command pins the topic to the named
          // machine and (if we currently own it) releases it, so the topic's next
          // routed message re-places onto the pinned machine via the already-wired
          // placeAndClaim → spawnOnMachine → owner-side onAccepted resume path.
          // Inert unless the rollout stage is past 'dark' (gated at the call site).
          const nickMod = await import('../core/NicknameCommand.js');
          const transferMod = await import('../core/TransferByNickname.js');
          const pinMod = await import('../core/TopicPlacementPinStore.js');
          const relocSetMod = await import('../core/RelocationNicknameSet.js');
          const nickAssignMod = await import('../core/NicknameAssigner.js');
          _topicPinStore = new pinMod.TopicPlacementPinStore({
            filePath: path.join(config.stateDir, 'session-pool', 'topic-pins.json'),
          });
          // Authoritative resolver for THIS machine's OWN nickname. Guarantees a topic
          // can always be moved BACK to the machine currently handling it, even when the
          // capacities view omits the self nickname (the back-transfer bug: the lifeline
          // forwards inbound to the holder, so the relocation check runs on the very
          // machine the user is moving back to). Priority: capacities self-entry →
          // identity registry self-entry → deterministic derive (reconstructs the
          // auto-assigned nickname; a manual rename is persisted on the identity entry).
          const resolveSelfNickname = (
            caps: readonly { machineId: string; nickname?: string }[],
          ): string | undefined => {
            const fromCaps = caps.find((c) => c.machineId === meshSelfId)?.nickname;
            if (fromCaps) return fromCaps;
            try {
              const selfEntry = meshIdMgr
                .getActiveMachines()
                .find((m) => m.machineId === meshSelfId)?.entry as
                | { nickname?: string; hardware?: { platform?: string } }
                | undefined;
              if (selfEntry?.nickname) return selfEntry.nickname;
              const id = meshIdMgr.hasIdentity()
                ? (meshIdMgr.loadIdentity() as { name?: string })
                : null;
              const derived = nickAssignMod.deriveBaseNickname(id?.name, selfEntry?.hardware?.platform);
              if (derived) return derived;
            } catch {
              /* @silent-fallback-ok — best-effort self-nickname resolution; on any failure we
                 return undefined and the recognizer simply falls back to the capacities-derived
                 set (the pre-existing behavior), so this can only ever ADD a nickname, never break. */
            }
            return undefined;
          };
          _tryNicknameRelocation = async (topicId, text) => {
            const sessionKey = String(topicId);
            const caps = machinePoolRegistry?.getCapacities() ?? [];
            const { knownNicknames, nickToMachine } = relocSetMod.buildRelocationNicknameSet({
              capacities: caps,
              selfMachineId: meshSelfId,
              selfNickname: resolveSelfNickname(caps),
            });
            const cmd = nickMod.recognizeNicknameCommand(text, knownNicknames);
            if (!cmd) return { handled: false };
            const plan = transferMod.planTransferByNickname(
              cmd,
              {
                resolveNickname: (n) => nickToMachine.get(n.toLowerCase()) ?? null,
                validNicknames: () => knownNicknames,
                isOnline: (m) => machinePoolRegistry?.getCapacity(m)?.online ?? false,
                currentOwnerOf: (sk) => ownReg.ownerOf(sk),
                isMidReply: () => false, // best-effort; the pin takes effect on the next routed message
                // Pin-aware idempotency: a duplicate "move to X" while already pinned
                // to X (e.g. a lifeline retry / post-restart replay of the same
                // message) no-ops as "already there" instead of burning the rate limit.
                currentPinOf: (sk) => _topicPinStore?.get(sk)?.preferredMachine ?? null,
                lastPlacementUpdateAt: (sk) => _topicPinStore?.lastUpdatedAtMs(sk) ?? null,
                now: () => Date.now(),
              },
              sessionKey,
            );
            if (plan.action === 'transfer' || plan.action === 'noop') {
              const target = plan.targetMachine!;
              _topicPinStore!.set(sessionKey, target, plan.setPin ?? true);
              // If THIS machine actively owns the topic, release so the next message re-places to the pin.
              try {
                if (ownReg.ownerOf(sessionKey) === meshSelfId) {
                  ownReg.cas({ type: 'release', machineId: meshSelfId }, { sessionKey, sender: meshSelfId, nonce: `${meshSelfId}:rel:${sessionKey}:${Math.round(performance.now())}` });
                }
              } catch { /* best-effort; route() re-places regardless once the owner is cleared */ }
              // ── Post-transfer closeout, immediate half (2026-06-05) ───────
              // The user's explicit move means this machine's topic session is
              // now a leftover — left running it does duplicate work alongside
              // the target machine's session. Close it NOW (origin 'operator':
              // this executes the user's direct command, arrived through the
              // authed Telegram pipeline; disposition 'recovery-bounce' keeps
              // the §P3 notifier silent — the user already got the "Moving…"
              // reply, and the conversation continues on the target). Protected
              // sessions are never auto-closed (skipped here AND vetoed in the
              // reaper sweeper that backstops non-explicit move paths).
              if (plan.action === 'transfer' && target !== meshSelfId) {
                try {
                  const tmuxName = telegram?.getSessionForTopic(topicId);
                  const rec = tmuxName ? sessionManager.listRunningSessions().find((s) => s.tmuxSession === tmuxName) : undefined;
                  if (rec && !sessionManager.getProtectedSessions().includes(rec.tmuxSession)) {
                    void sessionManager.terminateSession(
                      rec.id,
                      `topic ${topicId} moved to ${cmd.nickname} (user-commanded transfer) — closing the leftover local session`,
                      { origin: 'operator', disposition: 'recovery-bounce' },
                    ).then((r) => {
                      console.log(pc.dim(`  [session-pool] post-transfer closeout: ${rec.tmuxSession} → ${r.terminated ? 'closed' : `skipped (${r.skipped})`}`));
                    });
                  }
                } catch { /* @silent-fallback-ok — the reaper's topic-moved sweeper backstops this */ }
              }
              await telegram?.sendToTopic(topicId, plan.action === 'noop'
                ? (plan.detail === 'already-on-target'
                  ? `This conversation is already running on ${cmd.nickname} — nothing to move.`
                  : `This conversation is already pinned to ${cmd.nickname} — it'll keep running there.`)
                : `Moving this conversation to ${cmd.nickname} — it'll pick up there on your next message.`).catch(() => {});
              console.log(pc.green(`  [session-pool] topic ${topicId} pinned to ${target} (${plan.action}) via "${cmd.matchedVerb}"`));
              return { handled: true };
            }
            if (plan.action === 'confirm-required') {
              await telegram?.sendToTopic(topicId, plan.confirmationPrompt ?? `That machine isn't reachable right now — say "yes, move it" to confirm.`).catch(() => {});
              return { handled: true };
            }
            // reject
            const validList = (plan.validNicknames ?? []).join(', ');
            await telegram?.sendToTopic(topicId, plan.rejectReason === 'unknown-machine-nickname'
              ? `I don't know a machine called "${plan.detail}". I can move this to: ${validList || '(no other machines available)'}.`
              : `I can't move this right now (${plan.rejectReason}).`).catch(() => {});
            return { handled: true };
          };
        } catch (err) {
          console.log(pc.dim(`  [session-router] not wired: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    } catch (err) {
      console.log(pc.dim(`  [mesh-rpc] dispatcher not wired: ${err instanceof Error ? err.message : String(err)}`));
    }

    // ── Rollout gate (§Rollout): signed E2E result store + StageAdvancer ──────────
    // The E2E result store backs GET /session-pool/e2e-results (observable gate state);
    // StageAdvancer is the SOLE writer of multiMachine.sessionPool.stage (it passes the
    // stageWriteGuard token; any other write throws stage-write-not-permitted). Always
    // instantiated (cheap); inert until the pool activates past 'dark'.
    let sessionPoolE2EResultStore: import('../core/SessionPoolE2EResultStore.js').SessionPoolE2EResultStore | undefined;
    try {
      const e2eMod = await import('../core/SessionPoolE2EResultStore.js');
      const stageMod = await import('../core/StageAdvancer.js');
      const guardMod = await import('../config/stageWriteGuard.js');
      const crypto = await import('node:crypto');
      // HMAC over the agent's authToken — tamper-evident without a separate keystore.
      const hmacKey = String(config.authToken ?? 'instar-session-pool-e2e');
      const hmac = (c: string) => crypto.createHmac('sha256', hmacKey).update(c).digest('hex');
      sessionPoolE2EResultStore = new e2eMod.SessionPoolE2EResultStore({
        filePath: path.join(config.stateDir, 'session-pool-e2e-results.json'),
        sign: hmac,
        verifySig: (c, s) => {
          try { const exp = hmac(c); return s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp)); } catch { return false; }
        },
      });
      // Boot-cache the running commit SHA once (env first, else git HEAD, else
      // 'unknown'). StageAdvancer scopes an E2E red/green to the CURRENT build via
      // this, so a stale result from another commit can't trigger a revert/advance.
      const gitMod = await import('../core/SafeGitExecutor.js');
      let bootCommitSha = process.env.INSTAR_COMMIT_SHA ?? process.env.GITHUB_SHA ?? '';
      if (!bootCommitSha) {
        try {
          bootCommitSha = gitMod.SafeGitExecutor.readSync(['rev-parse', 'HEAD'], {
            cwd: process.cwd(), encoding: 'utf-8', stdio: 'pipe', operation: 'server.ts:rollout-commit-sha',
          }).trim();
        } catch { bootCommitSha = ''; /* @silent-fallback-ok — git unreadable → 'unknown' */ }
      }
      // StageAdvancer: the sole stage writer. Held for the rollout job/route to drive;
      // constructed here so the write path (liveConfig + token) is wired in one place.
      const stageAdvancer = new stageMod.StageAdvancer({
        resultStore: sessionPoolE2EResultStore,
        currentCommitSha: () => bootCommitSha || 'unknown',
        readStage: () => (liveConfig.get('multiMachine.sessionPool.stage', 'dark') as import('../core/StageAdvancer.js').SessionPoolStage),
        writeStageConfig: (s) => liveConfig.set(guardMod.STAGE_CONFIG_PATH, s, { stageWriteToken: guardMod.STAGE_WRITE_TOKEN }),
        audit: (event, detail) => console.log(pc.dim(`  [stage-advancer] ${event} ${JSON.stringify(detail)}`)),
      });
      // Revert-ONLY reconcile tick (§Rollout): reconcile() can solely DEMOTE a live
      // stage when the CURRENT commit's Tier-3 E2E goes red — it never advances.
      // Promotion (advanceTo) stays operator-triggered via the rollout route/job.
      // Cheap + inert while stage is 'dark' (reconcile() no-ops at the floor).
      const stageReconcileTimer = setInterval(() => {
        try { stageAdvancer.reconcile(); } catch { /* @silent-fallback-ok — retried next tick */ }
      }, 60_000);
      if (stageReconcileTimer.unref) stageReconcileTimer.unref();
    } catch (err) {
      console.log(pc.dim(`  [session-pool] rollout gate not wired: ${err instanceof Error ? err.message : String(err)}`));
    }

    const server = new AgentServer({ config, sessionManager, state, scheduler, telegram, relationships, feedback, feedbackAnomalyDetector, dispatches, updateChecker, autoUpdater, autoDispatcher, quotaTracker, quotaManager, publisher, viewer, tunnel, evolution, watchdog, topicMemory, triageNurse, projectMapper, coherenceGate: scopeVerifier, contextHierarchy, canonicalState, operationGate, sentinel, adaptiveTrust, memoryMonitor, orphanReaper, coherenceMonitor, commitmentTracker, semanticMemory, activitySentinel, rateLimitSentinel, releaseReadinessSentinel: releaseReadinessSentinel ?? undefined, messageRouter, summarySentinel, spawnManager, systemReviewer, capabilityMapper, selfKnowledgeTree, coverageAuditor, topicResumeMap: _topicResumeMap ?? undefined, sessionRefresh: _sessionRefresh ?? undefined, autonomyManager, trustElevationTracker, autonomousEvolution, coordinator: coordinator.enabled ? coordinator : undefined, localSigningKeyPem, leaseTransport, onLeasePullRequest: () => leaseCoordinatorRef?.currentLease() ?? null, liveTailReceiver, handoffWireTransport, onHandoffBegin, onHandoffInitiate: handoffInitiate, handoffInProgress: handoffSentinelInProgress, messageLedger, currentInboundByTopic, replyMarkerTransport, onReplyMarker: messageLedger ? (marker: unknown) => { const m = marker as { dedupeKey: string; platform: string; replyIdempotencyKey: string; epoch: number; topic?: string | null }; messageLedger!.applyRemoteReplyMarker(m.dedupeKey, { platform: m.platform, replyIdempotencyKey: m.replyIdempotencyKey, epoch: m.epoch, topic: m.topic ?? null }); } : undefined, whatsapp: whatsappAdapter, slack: slackAdapter, imessage: imessageAdapter, whatsappBusinessBackend, messageBridge, hookEventReceiver, worktreeMonitor, subagentTracker, instructionsVerifier, handshakeManager: threadlineHandshake, threadlineRouter, conversationStore, warrantsReplyGate, collaborationSurfacer, threadResumeMap, topicLinkageHandler: topicLinkageHandler ?? undefined, threadlineRelayClient, threadlineReplyWaiters, listenerManager: listenerManager ?? undefined, responseReviewGate, messagingToneGate, outboundDedupGate, telemetryHeartbeat, pasteManager, featureRegistry, discoveryEvaluator, completionEvaluator, unifiedTrust, liveConfig, sharedStateLedger, ledgerSessionRegistry, worktreeManager, oidcEnrolledRepos: parallelDevConfig?.oidcEnrolledRepos, initiativeTracker, projectRoundRunner, projectDriftChecker, machineHeartbeat, machinePoolRegistry, meshRpcDispatcher, sessionOwnershipRegistry, topicPinStore: _topicPinStore ?? undefined, secretSync: _secretSyncHandle ?? undefined, meshSelfId: _meshSelfId ?? undefined, resolveRouterUrl: _resolveRouterUrl ?? undefined, resolvePeerUrls: _resolvePeerUrls ?? undefined, sessionPoolE2EResultStore, proxyCoordinator, topicIntentStore, topicIntentArcCheck, usherSignalStore, intelligence: sharedIntelligence ?? undefined, telegramBridgeConfig, telegramBridge: telegramBridge ?? undefined, threadlineObservability, briefDeps, workingMemory, taskFlowRegistry, threadlineFlowBridge, sessionReaper, agentWorktreeReaper, mcpProcessReaper, geminiLoopRunner, sleepController, agentActivityState, reapLog, sleepWakeDetector, unjustifiedStopGate, stopGateDb, stopNotifier });
    // Boot-recovery (tunnel-failure-resilience spec Part 6): if the agent
    // died mid-relay-episode, the persisted tunnel.json carries
    // rotationPending=true. Rotate the dashboard PIN + authToken BEFORE
    // the server starts accepting API traffic, so a relay operator who saw
    // the old credentials can't use them against the freshly-booted server.
    if (tunnel && tunnel.lifecycleState.rotationPending) {
      console.log(pc.yellow('  [tunnel] boot-recovery: relay episode was in flight at last shutdown — rotating credentials before serving'));
      await tunnel.recoverPendingRotation();
    }

    await server.start();
    void taskFlowSweeper; void taskFlowDueWaker; void divergenceChecker;

    // ── No-LOSS recovery: re-run inbound events stranded in 'processing' (spec §8 G3a) ──
    // The complement to the inbound dedup gate: an event claimed but never
    // reply_committed (the holder crashed or was fenced mid-turn) is re-run by the
    // current lease holder from its stored input, via the SAME onTopicMessage path a
    // fresh forward uses — so the lost reply is produced. Only active when the
    // exactly-once ledger is wired (flag on). Lease-gated (a standby never injects),
    // attempts-capped (an unanswered message is not re-run forever). Telegram-only for
    // v1 (the --no-telegram sessionManager path is a tracked refinement).
    if (messageLedger && currentInboundByTopic && telegram) {
      const ledgerForRecovery = messageLedger;
      const inboundMap = currentInboundByTopic;
      const reinjectStuck = (topicId: string, dedupeKey: string, replayText: string): void => {
        inboundMap.set(topicId, dedupeKey); // so the eventual reply commits THIS entry
        void telegram.onTopicMessage?.({
          id: `replay-${dedupeKey}`,
          userId: 'unknown',
          content: replayText,
          channel: { type: 'telegram', identifier: topicId },
          receivedAt: new Date().toISOString(),
          metadata: { messageThreadId: Number(topicId), viaLifeline: true, replay: true },
        } as Message);
      };
      const runStuckRecovery = (): void => {
        try {
          recoverStuckMessages({
            ledger: ledgerForRecovery,
            holdsLease: () => coordinator.holdsLease(),
            epoch: coordinator.getLeaseEpoch(),
            maxProcessingMs: seamlessness.maxProcessingMs,
            reinject: reinjectStuck,
            logger: (m) => console.log(pc.dim(`  ${m}`)),
          });
        } catch (err) {
          console.error(`[stuck-recovery] ${err instanceof Error ? err.message : err}`);
        }
      };
      runStuckRecovery(); // boot: re-run anything a prior crash left mid-turn
      const stuckTimer = setInterval(runStuckRecovery, Math.max(30_000, seamlessness.maxProcessingMs));
      if (stuckTimer.unref) stuckTimer.unref();
      console.log(pc.dim('  Stuck-message recovery active (no-loss half, spec §8 G3a)'));
    }

    // Connect DegradationReporter downstream systems now that everything is initialized.
    // Any degradation events queued during startup will drain to feedback + telegram.
    {
      const alertTopicId = state.get<number>('agent-attention-topic') ?? null;
      degradationReporter.connectDownstream({
        feedbackSubmitter: feedback ? (item) => feedback!.submit(item) : undefined,
        // Route degradation alerts through the batcher — these are important but not urgent
        telegramSender: (_topicId, text) => {
          notify('SUMMARY', 'system', text);
          return Promise.resolve();
        },
        alertTopicId,
        // The MessagingToneGate is the single authority for outbound user
        // messages — degradation alerts go through the same gate as agent
        // replies do. Without this wire-in, health alerts bypass the
        // jargon / self-heal / CTA discipline and the user sees raw
        // ops-pager output. See upgrades/side-effects/agent-health-alert-authority-routing.md.
        toneGate: messagingToneGate ?? null,
      });
    }

    // Tier-2 live-mode wire-up (SELF-HEALING-REMEDIATOR-V2-SPEC §A57).
    //
    // When `config.remediator.enabled === true`, construct the full F-1..F-8
    // dispatch graph and register it with the DegradationReporter via the
    // F-3 `setRemediator()` hook. Default is OFF — the legacy alert path
    // + in-line healers (NativeModuleHealer.openWithHeal, supervisor
    // preflightSelfHeal) remain the safety net regardless of Remediator
    // state. See upgrades/side-effects/tier2-degradation-reporter-live-wire.md.
    {
      const remediatorEnabled = (config as { remediator?: { enabled?: boolean } })
        .remediator?.enabled === true;
      if (remediatorEnabled) {
        try {
          const { bootstrapRemediator } = await import(
            '../remediation/RemediatorBootstrap.js'
          );
          const machineIdForRemediator =
            coordinator.identity?.machineId ?? os.hostname();
          const bootstrapResult = await bootstrapRemediator({
            stateDir: config.stateDir,
            machineId: machineIdForRemediator,
            autonomyProfile: config.autonomyProfile,
          });
          if (bootstrapResult.disabled) {
            console.log(
              pc.yellow(
                `  Remediator live-mode requested but disabled: ${bootstrapResult.reason} — legacy alert path active.`,
              ),
            );
          } else {
            degradationReporter.setRemediator(bootstrapResult.remediator);
            console.log(
              pc.green(
                `  Remediator live-mode active (runbooks: ${bootstrapResult.registeredRunbookIds.join(', ') || 'none'}).`,
              ),
            );
          }
        } catch (err) {
          console.error(
            pc.red(
              `  Remediator bootstrap failed: ${err instanceof Error ? err.message : String(err)}. Legacy alert path active.`,
            ),
          );
        }
      }
    }

    // Periodic housekeeping — calls orphaned cleanup methods every 6 hours.
    // These methods exist on their respective classes but were never scheduled.
    const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
    setInterval(() => {
      try { triageOrchestrator?.cleanup(); } catch { /* best-effort */ }
      try { sessionRecovery?.cleanup(); } catch { /* best-effort */ }
      try { messageStore?.cleanup(); } catch { /* best-effort */ }
      console.log('[Housekeeping] Periodic cleanup completed');
    }, HOUSEKEEPING_INTERVAL_MS);

    // Start tunnel AFTER server is listening.
    //
    // The TunnelManager is now the single owner of the detect → attempt →
    // fall-back → notify lifecycle (per
    // specs/dev-infrastructure/tunnel-failure-resilience.md). The old
    // startup-retry ladder + background-retry scheduler + Lifeline
    // failure message that used to live here are RETIRED; the manager
    // handles backoff internally, schedules the post-exhausted self-heal
    // retry, and (once the notifier sink is wired in the next PR of the
    // chain) emits user-facing messages via the two-channel notifier.
    //
    // Failure on initial start is non-fatal: the manager keeps trying
    // in the background, and the post-exhausted retry timer keeps the
    // agent recoverable without requiring a server restart.
    if (tunnel) {
      try {
        const tunnelUrl = await tunnel.start();
        console.log(pc.green(`  Tunnel active: ${pc.bold(tunnelUrl)}`));
        // Mesh URL advertisement: record THIS machine's reachable URL into its
        // registry entry so cross-machine routing (deliver/transfer/lease) can
        // reach it. Without this, lastKnownUrl is null and every peer is filtered
        // out (the session pool is inert across machines). The existing
        // RegistrySyncDebouncer propagates the populated entry to peers.
        if (coordinator.enabled && coordinator.identity) {
          advertiseSelfMeshUrl(
            coordinator.managers.identityManager,
            coordinator.identity.machineId,
            resolveAdvertisedMeshUrl(config.tunnel, tunnelUrl),
            (m) => console.log(pc.dim(m)),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(pc.red(`  Tunnel start failed (manager will keep retrying in background): ${msg}`));
      }
    }

    // ── Dashboard Topic: always-available link ──────────────────────────
    // Retroactive: creates the topic on first run for existing agents.
    // Posts tunnel URL + PIN and pins the message for instant access.
    if (telegram) {
      try {
        const dashTopicId = await telegram.ensureDashboardTopic();
        if (dashTopicId) {
          console.log(pc.green(`  Dashboard topic: ${dashTopicId}`));

          // Auto-generate dashboardPin if missing — do this on every startup,
          // not just during upgrades. The PIN should always exist.
          if (!config.dashboardPin) {
            const pin = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
            config.dashboardPin = pin;
            // Persist via LiveConfig so it survives restart
            liveConfig.set('dashboardPin', pin);
            console.log(pc.green(`  Auto-generated dashboard PIN: ${pin}`));
          }

          // Wire the tunnel's two-channel notifier to telegram now that
          // both telegram + Dashboard topic exist. Per
          // specs/dev-infrastructure/tunnel-failure-resilience.md Part 3:
          //   - Group messages (status text only) → Dashboard topic.
          //   - Owner-DM messages (credentials) → telegram.sendToOwnerDM.
          // The credentialProvider supplies the live URL + current PIN
          // at compose time so the notifier never holds stale credentials.
          if (tunnel) {
            tunnel.attachTelegram(telegram, () => {
              const live = liveConfig.get<string>('dashboardPin', '');
              return live || config.dashboardPin;
            });
          }

          // Only broadcast if we have a tunnel URL — posting localhost to Telegram
          // is useless noise. The user can't access localhost remotely.
          const dashUrl = tunnel?.url;
          const tunnelType = config.tunnel?.type || 'quick';

          if (dashUrl) {
            // Pass dashboard PIN to TelegramAdapter so the broadcast includes it
            const telegramConfig = config.messaging?.find(
              (m: { type: string }) => m.type === 'telegram'
            );
            if (telegramConfig?.config) {
              (telegramConfig.config as Record<string, unknown>).dashboardPin = config.dashboardPin || '';
              // Update the adapter's config reference
              (telegram as unknown as { config: { dashboardPin?: string } }).config.dashboardPin = config.dashboardPin || '';
            }

            await telegram.broadcastDashboardUrl(dashUrl, tunnelType as 'quick' | 'named');

            // Also broadcast to Slack dashboard channel if configured
            if (_slackAdapter) {
              await _slackAdapter.broadcastDashboardUrl(dashUrl).catch((err: Error) => {
                console.warn(`[server] Slack dashboard broadcast failed: ${err.message}`);
              });
            }
          } else {
            console.log(pc.yellow(`  Dashboard available locally at http://localhost:${config.port}/dashboard (no tunnel configured — not broadcasting to Telegram)`));
          }
        }
      } catch (err) {
        // @silent-fallback-ok — dashboard topic is nice-to-have
        console.warn(`[server] Dashboard topic setup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Self-healing: ensure autostart is installed AND uses the correct format.
    // This is a non-negotiable requirement — the user must always be able to reach their agent remotely.
    // If autostart isn't installed, install it silently. If it uses the old /bin/bash entry point
    // (vulnerable to macOS TCC/FDA restrictions), regenerate it with the node + JS wrapper.
    try {
      const hasTelegram = !!telegram;
      const autostartInstalled = isAutostartInstalled(config.projectName);
      let needsReinstall = !autostartInstalled;

      // On macOS, keep node symlink fresh and check plist format
      if (process.platform === 'darwin') {
        // Always update the node symlink — primary defense against NVM/asdf switches
        try {
          const { ensureStableNodeSymlink } = await import('./setup.js');
          ensureStableNodeSymlink(config.projectDir);
        } catch { /* non-critical */ }

        if (!needsReinstall) {
          const label = `ai.instar.${config.projectName}`;
          const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
          try {
            const plistContent = fs.readFileSync(plistPath, 'utf-8');
            // Accept either .cjs (current) or .js (legacy installs that
            // predate the always-.cjs change). The PostUpdateMigrator
            // handles the .js → .cjs flip; here we only flag "no node
            // wrapper at all" as needing reinstall.
            const hasNodeWrapper = plistContent.includes('instar-boot.cjs') ||
                                   plistContent.includes('instar-boot.js');
            if (!hasNodeWrapper) {
              needsReinstall = true;
              console.log(pc.yellow(`  Auto-start uses legacy format — upgrading to TCC-safe node entry point`));
            } else if (!plistContent.includes('.instar/bin/node')) {
              needsReinstall = true;
              console.log(pc.yellow(`  Auto-start uses direct node path — upgrading to stable symlink`));
            } else {
              // Verify node path in plist still exists (should be the symlink)
              const nodeMatch = plistContent.match(/<string>(\/[^<]+node[^<]*)<\/string>/);
              if (nodeMatch && !fs.existsSync(nodeMatch[1])) {
                needsReinstall = true;
                console.log(pc.yellow(`  Auto-start node path stale (${nodeMatch[1]}) — regenerating`));
              }
            }
          } catch { /* plist read failed — will reinstall */ needsReinstall = true; }
        }
      }

      if (needsReinstall) {
        const { installAutoStart } = await import('./setup.js');
        const installed = installAutoStart(config.projectName, config.projectDir, hasTelegram);
        if (installed) {
          console.log(pc.green(`  Auto-start self-healed: installed ${process.platform === 'darwin' ? 'LaunchAgent (node + JS wrapper)' : 'systemd service'}`));
        } else {
          console.log(pc.yellow(`  Auto-start not available on ${process.platform}`));
        }
      }
    } catch (err) {
      // @silent-fallback-ok — auto-start non-critical
      console.error(`  Auto-start check failed: ${err instanceof Error ? err.message : err}`);
    }

    // Upgrade guide delivery — silent approach.
    // The pending guide file is preserved at .instar/state/pending-upgrade-guide.md
    // and gets injected into the agent's context at the NEXT natural session start
    // (via ContextHierarchy). No dedicated notification session is spawned.
    //
    // Previous approach spawned a Claude session (haiku → sonnet escalation) that
    // messaged the user via Telegram — too noisy. Updates should be invisible
    // unless the user's active work is interrupted.
    try {
      const pendingGuidePath = path.join(config.stateDir, 'state', 'pending-upgrade-guide.md');
      if (fs.existsSync(pendingGuidePath)) {
        const guideContent = fs.readFileSync(pendingGuidePath, 'utf-8');
        if (guideContent.trim()) {
          console.log(pc.green('  Pending upgrade guide detected — will be injected at next session start'));
        }
      }
    } catch {
      // @silent-fallback-ok — upgrade guide check non-critical
    }

    // Graceful shutdown
    let _shuttingDown = false;
    const shutdown = async () => {
      // Re-entrancy guard: SIGINT+SIGTERM (or a restartDetected racing a signal)
      // must not run the teardown twice. closeAllSqlite() is itself idempotent,
      // but the resume-UUID save + sidecar flush should run once.
      if (_shuttingDown) return;
      _shuttingDown = true;
      console.log('\nShutting down...');

      // Dispose the interactive-pool adapter (kills its tmux REPL sessions
      // so they don't orphan). No-op when registration was skipped or the
      // pool never spawned (lazy). Must run before process exit — orphaned
      // pool sessions would silently keep drawing subscription quota.
      if (anthropicRegistration?.pool) {
        try {
          const { registry: providersRegistry } = await import('../providers/registry.js');
          await providersRegistry.unregister(anthropicRegistration.pool.id);
          console.log('[shutdown] Interactive-pool adapter disposed');
        } catch (err) {
          console.error('[shutdown] Interactive-pool dispose failed:', err);
        }
      }

      // Save resume UUIDs for ALL active topic-linked sessions before exit.
      // Without this, server restarts lose all resume mappings because:
      // 1. Resume entries are consumed (removed) on spawn
      // 2. Proactive save may not have run yet
      // 3. beforeSessionKill doesn't fire for bulk process exit
      if (_topicResumeMap) {
        try {
          const runningSessions = sessionManager.listRunningSessions();
          let saved = 0;

          // Save Telegram topic resume UUIDs
          if (telegram) {
            const topicSessions = telegram.getAllTopicSessions?.();
            if (topicSessions) {
              for (const [topicId, sessionName] of topicSessions) {
                const session = runningSessions.find(s => s.tmuxSession === sessionName);
                const uuid = _topicResumeMap.findUuidForSession(sessionName, session?.claudeSessionId ?? undefined);
                if (uuid) {
                  _topicResumeMap.save(topicId, uuid, sessionName);
                  saved++;
                }
              }
            }
          }

          // Save Slack channel resume UUIDs
          if (_slackAdapter) {
            const registry = _slackAdapter.getChannelRegistry();
            for (const [channelId, entry] of Object.entries(registry)) {
              const session = runningSessions.find(s => s.tmuxSession === entry.sessionName);
              const uuid = _topicResumeMap.findUuidForSession(entry.sessionName, session?.claudeSessionId ?? undefined);
              if (uuid) {
                _slackAdapter.saveChannelResume(channelId, uuid, entry.sessionName);
                saved++;
              }
            }
          }

          if (saved > 0) {
            console.log(`[shutdown] Saved ${saved} resume UUID(s) for active sessions`);
          }
        } catch (err) {
          console.error('[shutdown] Failed to save resume UUIDs:', err);
        }
      }

      registrySyncDebouncer?.stop();
      gitSync?.stop();
      coordinator.stop();
      coherenceMonitor.stop();
      commitmentTracker.stop();
      commitmentSentinel?.stop();
      await notificationBatcher.flushAll(); // Drain pending notifications before exit
      notificationBatcher.stop();
      retryManager.stop();
      if (warmReapTimer) { clearInterval(warmReapTimer); warmReapTimer = null; } // Warm-Session A2A reap tick
      spawnManager.dispose(); // §4.4: stop drain loop + clear DRR state
      summarySentinel.stop();
      memoryMonitor.stop();
      caffeinateManager.stop();
      sleepWakeDetector.stop();
      autoUpdater.stop();
      autoDispatcher?.stop();
      sessionMonitor?.stop();
      if (tunnel) await tunnel.stop();
      if (threadlineShutdown) await threadlineShutdown();
      wakeSocketServer?.stop();
      pipeSpawner?.killAll();
      try { stopHeartbeat?.(); } catch { /* non-critical during shutdown */ }
      // pid-guarded: only remove OUR OWN registration. An unguarded
      // unregister-by-path here deletes the successor generation's fresh
      // entry during back-to-back update restarts (registry lost-update
      // race) — the agent then vanishes from the registry until restart.
      try { unregisterAgent(config.projectDir, { onlyIfPid: process.pid }); } catch { /* ELOCKED is non-critical during shutdown */ }
      scheduler?.stop();
      if (telegram) await telegram.stop();
      sessionManager.stopMonitoring();
      stuckInputSentinel.stop();
      // Integrated-Being v1 — flush stats sidecar (coalesces pending writes)
      // BEFORE closing SQLite, so no unflushed write is lost.
      try { sharedStateLedger?.shutdown(); } catch { /* best effort */ }
      await server.stop();
      // Close EVERY registered SQLite handle LAST — after all writers (server,
      // scheduler, sentinels, telegram) have stopped — to prevent the
      // "mutex lock failed" SIGABRT when better-sqlite3 static destructors fire
      // during process teardown. The structural registry (SqliteRegistry.ts)
      // replaces the old hand-maintained topicMemory/semanticMemory close-list,
      // which covered only 2 of the 15 long-lived stores.
      try {
        const closed = closeAllSqlite();
        console.log(`[shutdown] closed ${closed} sqlite handle(s)`);
      } catch { /* best effort */ }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Last-resort SQLite cleanup — if the process crashes from an uncaught exception
    // (e.g., cloudflared crash cascade during sleep/wake), close databases to prevent
    // the "mutex lock failed" error on next start. This doesn't prevent the crash,
    // but ensures the next boot is clean.
    process.on('uncaughtException', (err) => {
      // Isolated, recoverable uncaught exceptions — log and continue, don't
      // crash the server (which would close its databases + drop in-flight
      // work). See isNonFatalUncaught for the allowlist + rationale (HTTP
      // double-response races, Slack Socket Mode reconnect races).
      if (isNonFatalUncaught(err)) {
        // Attach the stack the first time a given origin is seen so the offending
        // call site (e.g. a route that double-responds → "Cannot set headers")
        // is diagnosable; repeats log message-only to avoid flooding the log
        // (these isolated races recur ~10-20x/hour).
        const stackSuffix =
          shouldLogStackForUncaught(err) && err.stack
            ? `\n  first-seen stack (for diagnosis):\n${err.stack}`
            : '';
        console.warn(`[WARN] Non-fatal uncaught exception (suppressed): ${err.message}${stackSuffix}`);
        return; // Don't crash — the server is fine
      }

      console.error('[FATAL] Uncaught exception — closing databases before crash:', err.message);
      // Close ALL registered SQLite handles (not just topic/semantic memory) so
      // the crash exit doesn't compound into a "mutex lock failed" SIGABRT on top
      // of the original error. closeAllSqlite() is best-effort + idempotent.
      try { closeAllSqlite(); } catch { /* best effort */ }
      process.exit(1);
    });

    // Wire the ForegroundRestartWatcher to the graceful shutdown function.
    // This ensures auto-update restarts close all resources (especially SQLite
    // databases) before exiting, preventing the "mutex lock failed" crash.
    restartWatcher.on('restartDetected', shutdown);
  } else {
    // Run in tmux background session
    const tmuxPath = detectTmuxPath();
    if (!tmuxPath) {
      console.log(pc.red('tmux not found. Use --foreground to run without tmux.'));
      process.exit(1);
    }

    // Check if already running
    try {
      execFileSync(tmuxPath, ['has-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
      console.log(pc.yellow(`Server already running in tmux session: ${serverSessionName}`));
      console.log(`  Attach with: tmux attach -t '=${serverSessionName}'`);
      return;
    } catch {
      // Not running — good
    }

    // Get the path to the CLI entry point
    const cliPath = path.resolve(__dirname, '../cli.js');

    // Use shell-safe command construction: pass node + args as separate tokens
    // tmux new-session runs the remainder as a shell command, so we quote each arg
    const nodeCmd = ['node', cliPath, 'server', 'start', '--foreground']
      .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
      .join(' ');

    try {
      execFileSync(tmuxPath, ['new-session', '-d', '-s', serverSessionName, '-c', config.projectDir, nodeCmd], { stdio: 'ignore' });
      console.log(pc.green(`Server started in tmux session: ${pc.bold(serverSessionName)}`));
      console.log(`  Port: ${config.port}`);
      console.log(`  Attach: tmux attach -t '=${serverSessionName}'`);
      console.log(`  Health: curl http://localhost:${config.port}/health`);
    } catch (err) {
      console.log(pc.red(`Failed to start server: ${err}`));
      process.exit(1);
    }
  }
}

export async function stopServer(options: { dir?: string }): Promise<void> {
  const config = loadConfig(options.dir);
  const serverSessionName = `${config.projectName}-server`;
  const tmuxPath = detectTmuxPath();

  if (!tmuxPath) {
    console.log(pc.red('tmux not found'));
    process.exit(1);
  }

  // Check if the session exists
  try {
    execFileSync(tmuxPath, ['has-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
  } catch {
    console.log(pc.yellow(`No server running (no tmux session: ${serverSessionName})`));
    return;
  }

  // Send SIGTERM first for graceful shutdown, then force kill after timeout
  try {
    // Send C-c (SIGINT) to the foreground process in the session
    execFileSync(tmuxPath, ['send-keys', '-t', `=${serverSessionName}:`, 'C-c'], { stdio: 'ignore' });
    console.log(`  Sent shutdown signal to ${serverSessionName}...`);

    // Wait up to 5 seconds for graceful shutdown
    let stopped = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        execFileSync(tmuxPath, ['has-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
        // Still running
      } catch {
        // @silent-fallback-ok — session check
        stopped = true;
        break;
      }
    }

    if (!stopped) {
      // Force kill after graceful timeout
      execFileSync(tmuxPath, ['kill-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
      console.log(pc.yellow(`  Forced kill after graceful shutdown timeout`));
    }

    console.log(pc.green(`Server stopped (session: ${serverSessionName})`));
  } catch {
    // @silent-fallback-ok — graceful shutdown fallback to force
    try {
      execFileSync(tmuxPath, ['kill-session', '-t', `=${serverSessionName}`], { stdio: 'ignore' });
      console.log(pc.green(`Server stopped (forced kill: ${serverSessionName})`));
    } catch {
      console.log(pc.yellow(`No server running (no tmux session: ${serverSessionName})`));
    }
  }
}

/**
 * Restart the agent server — handles launchd/systemd lifecycle correctly.
 *
 * When autostart (launchd/systemd) is active, simply stopping the server causes
 * the service manager to respawn it with the OLD binary within seconds. This
 * makes it impossible to apply patches. The restart command handles this by:
 *   1. Temporarily disabling the autostart service
 *   2. Stopping the running server
 *   3. Re-enabling autostart (which starts the server with the new binary)
 *
 * Without autostart, falls back to stop + start.
 */
export async function restartServer(options: { dir?: string }): Promise<void> {
  const config = loadConfig(options.dir);

  if (process.platform === 'darwin') {
    const label = `ai.instar.${config.projectName}`;
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

    if (fs.existsSync(plistPath)) {
      const uid = process.getuid?.() ?? 501;
      console.log(`  Restarting via launchd (${label})...`);

      // Bootout the service (stops process + unloads)
      try {
        execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' });
      } catch { /* @silent-fallback-ok — may not be loaded */ }

      // Wait for process to die
      await new Promise(r => setTimeout(r, 1000));

      // Bootstrap it back (loads + starts)
      try {
        execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'pipe' });
        console.log(pc.green(`  Server restarted via launchd (${label})`));
      } catch (err) {
        // If bootstrap fails (already loaded), try kickstart
        try {
          execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'pipe' });
          console.log(pc.green(`  Server restarted via launchd kickstart (${label})`));
        } catch { /* @silent-fallback-ok — logs manual instructions below */
          console.log(pc.red(`  Failed to restart via launchd: ${err instanceof Error ? err.message : err}`));
          console.log(pc.yellow(`  Try manually: launchctl bootout gui/${uid}/${label} && launchctl bootstrap gui/${uid} ${plistPath}`));
        }
      }
      return;
    }
  } else if (process.platform === 'linux') {
    const serviceName = `instar-${config.projectName}.service`;
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', serviceName);
    if (fs.existsSync(servicePath)) {
      console.log(`  Restarting via systemd (${serviceName})...`);
      try {
        execFileSync('systemctl', ['--user', 'restart', serviceName], { stdio: 'pipe' });
        console.log(pc.green(`  Server restarted via systemd (${serviceName})`));
      } catch (err) {
        console.log(pc.red(`  Failed to restart via systemd: ${err instanceof Error ? err.message : err}`));
      }
      return;
    }
  }

  // No autostart — manual stop + start
  console.log('  Restarting server (stop + start)...');
  await stopServer(options);
  await new Promise(r => setTimeout(r, 500));
  await startServer({ dir: options.dir });
}
