/**
 * HTTP API routes — health, status, sessions, jobs, events.
 *
 * Extracted/simplified from Dawn's 2267-line routes.ts.
 * All the observability you need, none of the complexity you don't.
 */

import { Router } from 'express';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionManager } from '../core/SessionManager.js';
import type { SessionRefresh } from '../core/SessionRefresh.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { InstarConfig, JobPriority } from '../core/types.js';
import { rateLimiter, signViewPath } from './middleware.js';
import type { WriteOperation, WriteToken } from '../core/StateWriteAuthority.js';
import { writeLifelineRestartSignal } from '../core/version-skew.js';
import { readSessionClocks } from '../core/SessionClockReader.js';
import { creditUsherOnOutbound } from '../core/UsherActedCorrelator.js';
import { validateWriteToken, canPerformOperation } from '../core/StateWriteAuthority.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { FailureLedger } from '../monitoring/FailureLedger.js';
import { FailureAttributionEngine } from '../monitoring/FailureAttributionEngine.js';
import { FailureAnalyzer } from '../monitoring/FailureAnalyzer.js';
import { FailureLoopDriver } from '../monitoring/FailureLoopDriver.js';
import { CorrectionLedger } from '../monitoring/CorrectionLedger.js';
import { scrubSecrets as scrubCorrectionSecrets } from '../monitoring/scrubSecrets.js';
import { HumanAsDetectorLog, LEARNING_DETERMINISTIC_THRESHOLD } from '../monitoring/HumanAsDetectorLog.js';
import { parseVersion, compareVersions } from '../lifeline/versionHandshake.js';
import { readLatestCodexUsage } from '../providers/adapters/openai-codex/observability/codexRateLimitReader.js';
import {
  GATE_ROUTE_VERSION,
  GATE_ROUTE_MINIMUM_VERSION,
  getHotPathState,
  setKillSwitch,
  getKillSwitch,
  recordSessionStart,
  getMode,
  setMode,
} from './stopGate.js';
import {
  UnjustifiedStopGate,
  assembleReminder,
  type EvaluateInput,
  type AuthorityOutcome,
  type EvidenceMetadata,
  type EvidencePointer,
} from '../core/UnjustifiedStopGate.js';
import { StopGateDb, dayKeyFor, type EvalMode } from '../core/StopGateDb.js';
import { randomUUID as cryptoRandomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { validateStageTransition, type ValidationContext as StageValidationContext } from '../core/StageTransitionValidator.js';
import type { PipelineStage, RoundStatus } from '../core/InitiativeTracker.js';
import {
  ATTENTION_PRIORITIES,
  ATTENTION_STATUSES,
  normalizeAttentionPriority,
  normalizeAttentionStatus,
} from './attentionApi.js';

const execFile = promisify(execFileCb);

/**
 * Per-session continue-ceiling (spec § (b) Outcomes).
 * If an authority judgement of `continue` would push this session's
 * counter to >= this value, the evaluate route force-allows + flags
 * stuck-state instead. Catches runaway authority judgment without
 * requiring operator intervention.
 */
const CONTINUE_CEILING = 2;

/**
 * Server-side post-verifier for a continue decision (spec § (b) lines 273-281).
 * Runs three of the five structural checks (#1 git object exists,
 * #3 descendant relationship, #5 ≥1 non-session-created artifact).
 * Checks #2 (ctime unchanged) and #4 (`.git/HEAD` unchanged) require
 * T0 state the hook router will collect — deferred to PR3b when the
 * router lands.
 *
 * Returns null on success; failure-detail string on any check that fails.
 * Fail-open path: caller converts a failed verify into `invalidEvidence`.
 */
async function postVerifyEvidence(
  projectDir: string,
  evidence: EvidenceMetadata,
  pointer: EvidencePointer
): Promise<string | null> {
  // Check #5 first — cheap, doesn't spawn git.
  const hasPreSessionArtifact = evidence.artifacts.some(a => !a.createdThisSession);
  if (!hasPreSessionArtifact) {
    return 'all enumerated artifacts were created this session';
  }

  const planSha = pointer.plan_commit_sha;
  const incSha = pointer.incremental_commit_sha;

  try {
    // Check #1: plan_commit_sha exists in the git object DB.
    if (planSha) {
      await execFile('git', ['-C', projectDir, 'cat-file', '-e', planSha], { timeout: 500 });
    }

    // Check #3: incremental_commit_sha is a descendant of plan_commit_sha.
    //   `git merge-base --is-ancestor <plan> <incremental>` exits 0 if
    //   plan IS an ancestor of incremental (i.e. incremental is a descendant).
    if (planSha && incSha && planSha !== incSha) {
      try {
        await execFile(
          'git',
          ['-C', projectDir, 'merge-base', '--is-ancestor', planSha, incSha],
          { timeout: 500 }
        );
      } catch {
        return `incremental ${incSha} is not a descendant of plan ${planSha}`;
      }
    }
  } catch (err) {
    return `git structural check failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return null;
}
import { ReflectionMetrics } from '../monitoring/ReflectionMetrics.js';
import { HomeostasisMonitor } from '../monitoring/HomeostasisMonitor.js';
import { readReaperAudit } from '../monitoring/SessionReaper.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';
import type { FeedbackManager } from '../core/FeedbackManager.js';
import type { DispatchManager } from '../core/DispatchManager.js';
import type { UpdateChecker } from '../core/UpdateChecker.js';
import type { AutoUpdater } from '../core/AutoUpdater.js';
import type { AutoDispatcher } from '../core/AutoDispatcher.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { TelegraphService } from '../publishing/TelegraphService.js';
import type { PrivateViewer } from '../publishing/PrivateViewer.js';
import type { TunnelManager } from '../tunnel/TunnelManager.js';
import type { EvolutionManager } from '../core/EvolutionManager.js';
import type { EvolutionStatus, EvolutionType, GapCategory } from '../core/types.js';
import type { SessionWatchdog } from '../monitoring/SessionWatchdog.js';
import type { StallTriageNurse } from '../monitoring/StallTriageNurse.js';
import type { OrphanProcessReaper } from '../monitoring/OrphanProcessReaper.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import type { FeedbackAnomalyDetector } from '../monitoring/FeedbackAnomalyDetector.js';
import type { ProjectMapper } from '../core/ProjectMapper.js';
import { verifyMergedItemsViaGit } from '../core/ProjectRoundExecution.js';
import type { ProjectDriftChecker } from '../core/ProjectDriftChecker.js';
import type { ScopeVerifier } from '../core/ScopeVerifier.js';
import type { HighRiskAction } from '../core/ScopeVerifier.js';
import type { ContextHierarchy } from '../core/ContextHierarchy.js';
import type { CanonicalState } from '../core/CanonicalState.js';
import type { ExternalOperationGate } from '../core/ExternalOperationGate.js';
import type { OperationMutability, OperationReversibility } from '../core/ExternalOperationGate.js';
import type { MessageSentinel } from '../core/MessageSentinel.js';
import type { AdaptiveTrust } from '../core/AdaptiveTrust.js';
import type { AutonomyProfileManager } from '../core/AutonomyProfileManager.js';
import type { TrustElevationTracker } from '../core/TrustElevationTracker.js';
import type { AutonomousEvolution } from '../core/AutonomousEvolution.js';
import type { AutonomyProfileLevel } from '../core/types.js';
import {
  listAutonomousJobs,
  canStartAutonomousJob,
  stopAutonomousTopic,
  stopAllAutonomousJobs,
  DEFAULT_MAX_CONCURRENT_AUTONOMOUS,
} from '../core/AutonomousSessions.js';
import type { MemoryPressureMonitor } from '../monitoring/MemoryPressureMonitor.js';
import type { CoherenceMonitor } from '../monitoring/CoherenceMonitor.js';
import type { SystemReviewer } from '../monitoring/SystemReviewer.js';
import type { CommitmentTracker } from '../monitoring/CommitmentTracker.js';
import type { SemanticMemory } from '../memory/SemanticMemory.js';
import type { SessionActivitySentinel } from '../monitoring/SessionActivitySentinel.js';
import { ProcessIntegrity } from '../core/ProcessIntegrity.js';
import type { MessageRouter } from '../messaging/MessageRouter.js';
import type { SessionSummarySentinel } from '../messaging/SessionSummarySentinel.js';
import { decideIngress, commitInboundReply, dedupeKeyFor } from '../messaging/ingressDedup.js';
import { RelayContentDedup } from '../messaging/relayContentDedup.js';
import type { SpawnRequestManager } from '../messaging/SpawnRequestManager.js';
import { getOutboundQueueStatus, cleanupDeliveredOutbound, buildAgentList } from '../messaging/GitSyncTransport.js';
import type { CapabilityMapper } from '../core/CapabilityMapper.js';
import type { SelfKnowledgeTree } from '../knowledge/SelfKnowledgeTree.js';
import type { CoverageAuditor } from '../knowledge/CoverageAuditor.js';
import type { TopicResumeMap } from '../core/TopicResumeMap.js';
import type { MessageType, MessagePriority, MessageFilter } from '../messaging/types.js';
import { verifyAgentToken, getAgentToken } from '../messaging/AgentTokenManager.js';
import type { WorkingMemoryAssembler } from '../memory/WorkingMemoryAssembler.js';
import type { QuotaManager } from '../monitoring/QuotaManager.js';
import type { ThreadlineRouter } from '../threadline/ThreadlineRouter.js';
import { evaluateAndRecordInbound } from '../threadline/WarrantsReplyGate.js';
import type { HandshakeManager } from '../threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../threadline/ThreadlineEndpoints.js';
import type { UnifiedTrustSystem } from '../threadline/UnifiedTrustWiring.js';
import { DEFAULT_RELAY_URL } from '../threadline/constants.js';
import { ThreadlineNicknames } from '../threadline/ThreadlineNicknames.js';
import { ScopeCoherenceTracker } from '../core/ScopeCoherenceTracker.js';
import type { ScopeCoherenceState } from '../core/ScopeCoherenceTracker.js';
import type { HookEventReceiver } from '../monitoring/HookEventReceiver.js';
import type { WorktreeMonitor } from '../monitoring/WorktreeMonitor.js';
import type { SubagentTracker } from '../monitoring/SubagentTracker.js';
import type { InstructionsVerifier } from '../monitoring/InstructionsVerifier.js';
import type { CoherenceGate } from '../core/CoherenceGate.js';
import type { MessagingToneGate } from '../core/MessagingToneGate.js';
import { isJunkPayload } from '../core/junk-payload.js';
import { detectJargon } from '../core/JargonDetector.js';
import type { PasteManager } from '../paste/PasteManager.js';
import type { WebSocketManager } from './WebSocketManager.js';
import { TruncationDetector } from '../paste/TruncationDetector.js';
import { SecretDrop, type CreateSecretRequestOptions } from './SecretDrop.js';
import { computeFingerprint } from '../threadline/client/MessageEncryptor.js';
import {
  evaluateTransferAuthorization,
  type PeerTrustLevel,
  type OperationAutonomyLevel,
} from '../threadline/OperatorConfirmGate.js';
import { buildAllCapabilityBlocks } from './CapabilityIndex.js';
import { matchesSystemTemplate } from '../messaging/system-templates.js';
import { resolvePendingRelayPath } from '../messaging/pending-relay-store.js';
import Database from 'better-sqlite3';

/**
 * Build the /whoami request handler.
 *
 * Spec docs/specs/telegram-delivery-robustness.md § Layer 1c. Exported
 * separately from createRoutes so unit tests can mount it on a minimal
 * Express app without instantiating the entire RouteContext.
 *
 * Behavior:
 *   - 403 `{error: 'agent_id_header_required'}` when X-Instar-AgentId is
 *     absent. The middleware accepts bare-token requests during the
 *     deprecation window for *other* endpoints; /whoami does not, because
 *     accepting a bare-token request here would let a caller learn the
 *     expected agent-id from the response (discovery oracle).
 *   - 403 `{error: 'agent_id_mismatch', expected}` when the header is
 *     present but does not match.
 *   - 429 with retry hint when the per-source rate limit (1 req/s) is
 *     exceeded — the bucket is keyed on (agent-id, remoteAddress) so a
 *     single misbehaving caller can't starve the budget for legitimate
 *     sentinel callers from other source addresses.
 *   - 200 `{agentId, port}` on a clean request. (We deliberately do NOT
 *     return `version`: an authed identity probe shouldn't double as a
 *     CVE-targeting oracle for an authed peer who has stolen a token.)
 */
export function createWhoamiHandler(opts: {
  agentId: string;
  port: number;
  configVersion?: string;
}) {
  const WHOAMI_WINDOW_MS = 1000;
  // Bucket key is `${agentId}|${remoteAddress}` so a single noisy caller
  // can't starve the budget for legitimate sentinel callers from other
  // source addresses on the same authed agent-id.
  const buckets = new Map<string, number>();
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - WHOAMI_WINDOW_MS * 60;
    for (const [k, t] of buckets) {
      if (t < cutoff) buckets.delete(k);
    }
  }, WHOAMI_WINDOW_MS * 60);
  cleanup.unref();

  return (req: ExpressRequest, res: ExpressResponse) => {
    const headerVal = req.headers['x-instar-agentid'];
    const provided = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const expected = opts.agentId;
    if (!provided) {
      res.status(403).json({ error: 'agent_id_header_required', expected });
      return;
    }
    if (provided !== expected) {
      // Defense-in-depth — auth middleware should have already caught this.
      res.status(403).json({ error: 'agent_id_mismatch', expected });
      return;
    }
    const remote = req.ip || req.socket?.remoteAddress || 'unknown';
    const bucketKey = `${provided}|${remote}`;
    const now = Date.now();
    const last = buckets.get(bucketKey);
    if (last !== undefined && now - last < WHOAMI_WINDOW_MS) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfterMs: WHOAMI_WINDOW_MS - (now - last),
      });
      return;
    }
    buckets.set(bucketKey, now);

    // Deliberately omit `version`: an authed identity probe shouldn't
    // double as a CVE-targeting oracle for a peer whose token has been
    // stolen. Layer 3's recovery path needs agentId + port, not version.
    // (`opts.configVersion` retained on the type for forward-compat
    // — callers who need version must read it from a separate route.)
    res.json({
      agentId: expected,
      port: opts.port,
    });
  };
}

/**
 * Build the `POST /events/delivery-failed` request handler.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 2c.
 *
 * Contract:
 *   - Body: `{ delivery_id, topic_id, text_hash, http_code,
 *              error_body?, attempted_port, attempts }` — strict
 *     (any extra field rejected with 400).
 *   - Caps: text-equivalent fields ≤ 8KB, error_body ≤ 1KB, total
 *     body ≤ 16KB. The endpoint *does not store anything* — the
 *     SQLite queue on the script side is the durable record. This
 *     route only fans out an SSE event so listeners (the Layer 3
 *     sentinel, the dashboard) can react in real time.
 *   - Per-(agentId, remote) token bucket: 10 req/s sustained, burst 50.
 *   - Auth handled by upstream `authMiddleware`; we additionally
 *     reject responses missing `X-Instar-AgentId` so the auth-mismatch
 *     path returns the same structured 403 even when the route is
 *     mounted in tests without the full middleware stack.
 *
 * Validation is hand-rolled (rather than zod) for two reasons:
 *   (1) the schema is small and we want every failure mode to map to a
 *       precise error code without translating zod's verbose message
 *       shape; (2) zod is in deps but adds a non-trivial import-time
 *       cost on a hot route.
 */
export function createDeliveryFailedHandler(opts: {
  agentId: string;
  emit?: (event: Record<string, unknown>) => void;
  /** Override clock for tests; defaults to `Date.now`. */
  now?: () => number;
}) {
  const now = opts.now ?? (() => Date.now());

  // Per-source token bucket. Burst 50; refill 10 tokens/sec.
  // Keyed on `${agentId}|${remoteAddress}` — the agent-id is opaque to
  // the bucket itself but having it in the key means tests that mount
  // multiple agents on a single Express app each get their own budget.
  const BURST = 50;
  const REFILL_PER_SEC = 10;
  type Bucket = { tokens: number; lastRefillMs: number };
  const buckets = new Map<string, Bucket>();
  // Periodic GC so a large cardinality of (agent, IP) pairs doesn't bloat the map.
  const gc = setInterval(() => {
    const cutoff = now() - 5 * 60 * 1000;
    for (const [k, b] of buckets) {
      if (b.lastRefillMs < cutoff) buckets.delete(k);
    }
  }, 60 * 1000);
  gc.unref();

  function takeToken(key: string): boolean {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: BURST, lastRefillMs: t };
      buckets.set(key, b);
    } else {
      const elapsedMs = t - b.lastRefillMs;
      if (elapsedMs > 0) {
        b.tokens = Math.min(BURST, b.tokens + (elapsedMs / 1000) * REFILL_PER_SEC);
        b.lastRefillMs = t;
      }
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // Caps — defense-in-depth on top of the body-parser limit.
  const MAX_TOTAL_BYTES = 16 * 1024;
  const MAX_TEXT_FIELD_BYTES = 8 * 1024;
  const MAX_ERROR_BODY_BYTES = 1 * 1024;
  const HEX64 = /^[a-f0-9]{64}$/i;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const allowedFields = new Set([
    'delivery_id',
    'topic_id',
    'text_hash',
    'http_code',
    'error_body',
    'attempted_port',
    'attempts',
  ]);

  /** Strip control chars (except \n, \t) and length-cap. */
  function sanitizeErrorBody(s: string): string {
    // eslint-disable-next-line no-control-regex
    const stripped = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    return stripped.length > MAX_ERROR_BODY_BYTES
      ? stripped.slice(0, MAX_ERROR_BODY_BYTES)
      : stripped;
  }

  return (req: ExpressRequest, res: ExpressResponse): void => {
    // Auth-mismatch defense in depth — emit a single 403 audit line and do
    // not echo the body. The upstream auth middleware should already have
    // rejected, but the route is mountable bare in tests, so we re-check.
    const headerVal = req.headers['x-instar-agentid'];
    const provided = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (provided !== undefined && provided !== opts.agentId) {
      const remote = req.ip || req.socket?.remoteAddress || 'unknown';
      console.warn(
        `[delivery-failed] auth_failure: agent_id_mismatch from ${remote} ` +
        `(provided=${JSON.stringify(provided).slice(0, 64)}, expected=${opts.agentId})`,
      );
      res.status(403).json({ error: 'agent_id_mismatch', expected: opts.agentId });
      return;
    }

    // Rate limit.
    const remote = req.ip || req.socket?.remoteAddress || 'unknown';
    const bucketKey = `${opts.agentId}|${remote}`;
    if (!takeToken(bucketKey)) {
      res.status(429).json({
        error: 'Rate limit exceeded',
        limit: { rps: REFILL_PER_SEC, burst: BURST },
      });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }

    // Total-body cap. Express's body-parser already imposes a limit, but we
    // re-measure here so a misconfigured upstream limit can't smuggle through.
    let totalBytes: number;
    try {
      totalBytes = Buffer.byteLength(JSON.stringify(body), 'utf-8');
    } catch {
      res.status(400).json({ error: 'body not serializable' });
      return;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      res.status(413).json({ error: 'body too large', maxBytes: MAX_TOTAL_BYTES });
      return;
    }

    // Strict field set — reject extras.
    for (const k of Object.keys(body)) {
      if (!allowedFields.has(k)) {
        res.status(400).json({ error: `unexpected field: ${k}` });
        return;
      }
    }

    const {
      delivery_id,
      topic_id,
      text_hash,
      http_code,
      error_body,
      attempted_port,
      attempts,
    } = body as Record<string, unknown>;

    if (typeof delivery_id !== 'string' || !UUID.test(delivery_id)) {
      res.status(400).json({ error: 'delivery_id must be a UUIDv4 string' });
      return;
    }
    if (typeof topic_id !== 'number' || !Number.isInteger(topic_id) || topic_id < 0) {
      res.status(400).json({ error: 'topic_id must be a non-negative integer' });
      return;
    }
    if (typeof text_hash !== 'string' || !HEX64.test(text_hash)) {
      res.status(400).json({ error: 'text_hash must be a 64-char hex string' });
      return;
    }
    if (typeof http_code !== 'number' || !Number.isInteger(http_code) || http_code < 0 || http_code > 999) {
      res.status(400).json({ error: 'http_code must be an integer in [0,999]' });
      return;
    }
    if (typeof attempted_port !== 'number' || !Number.isInteger(attempted_port) || attempted_port < 1 || attempted_port > 65535) {
      res.status(400).json({ error: 'attempted_port must be an integer in [1,65535]' });
      return;
    }
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
      res.status(400).json({ error: 'attempts must be a positive integer' });
      return;
    }
    let sanitizedErrorBody: string | null = null;
    if (error_body !== undefined && error_body !== null) {
      if (typeof error_body !== 'string') {
        res.status(400).json({ error: 'error_body must be a string when present' });
        return;
      }
      if (Buffer.byteLength(error_body, 'utf-8') > MAX_TEXT_FIELD_BYTES) {
        // We could just silently truncate, but the script's contract caps at
        // 1KB before send — anything bigger is a contract violation worth
        // reporting back. Cap at 8KB as the field-size hard upper bound;
        // sanitization below handles the per-field 1KB normalization.
        res.status(413).json({ error: 'error_body too large', maxBytes: MAX_TEXT_FIELD_BYTES });
        return;
      }
      sanitizedErrorBody = sanitizeErrorBody(error_body);
    }

    // Fan out to listeners. We do NOT persist anything — that's the script's
    // job. Listeners care about the *fact* of failure plus enough metadata to
    // look up the queued row.
    const event = {
      type: 'delivery_failed',
      agentId: opts.agentId,
      delivery_id,
      topic_id,
      text_hash,
      http_code,
      attempted_port,
      attempts,
      error_body: sanitizedErrorBody,
      receivedAt: new Date(now()).toISOString(),
    };
    if (opts.emit) {
      try {
        opts.emit(event);
      } catch (err) {
        // The endpoint must not fail because a listener crashed. The script
        // already has the row in SQLite; the event is best-effort signal.
        console.error('[delivery-failed] emit handler threw:', err);
      }
    }

    res.status(202).json({ accepted: true, delivery_id });
  };
}

export interface RouteContext {
  config: InstarConfig;
  sessionManager: SessionManager;
  state: StateManager;
  scheduler: JobScheduler | null;
  telegram: TelegramAdapter | null;
  relationships: RelationshipManager | null;
  feedback: FeedbackManager | null;
  dispatches: DispatchManager | null;
  updateChecker: UpdateChecker | null;
  autoUpdater: AutoUpdater | null;
  autoDispatcher: AutoDispatcher | null;
  quotaTracker: QuotaTracker | null;
  publisher: TelegraphService | null;
  viewer: PrivateViewer | null;
  tunnel: TunnelManager | null;
  evolution: EvolutionManager | null;
  watchdog: SessionWatchdog | null;
  triageNurse: StallTriageNurse | null;
  topicMemory: TopicMemory | null;
  feedbackAnomalyDetector: FeedbackAnomalyDetector | null;
  projectMapper: ProjectMapper | null;
  coherenceGate: ScopeVerifier | null;
  contextHierarchy: ContextHierarchy | null;
  canonicalState: CanonicalState | null;
  operationGate: ExternalOperationGate | null;
  sentinel: MessageSentinel | null;
  adaptiveTrust: AdaptiveTrust | null;
  memoryMonitor: MemoryPressureMonitor | null;
  orphanReaper: OrphanProcessReaper | null;
  coherenceMonitor: CoherenceMonitor | null;
  commitmentTracker: CommitmentTracker | null;
  semanticMemory: SemanticMemory | null;
  activitySentinel: SessionActivitySentinel | null;
  rateLimitSentinel: import('../monitoring/RateLimitSentinel.js').RateLimitSentinel | null;
  /** ReleaseReadinessSentinel (Layer B of release-readiness-visibility). Null on
   *  installs with no analyzable instar git repo, or when disabled in config. */
  releaseReadinessSentinel: import('../monitoring/ReleaseReadinessSentinel.js').ReleaseReadinessSentinel | null;
  messageRouter: MessageRouter | null;
  summarySentinel: SessionSummarySentinel | null;
  spawnManager: SpawnRequestManager | null;
  workingMemory: WorkingMemoryAssembler | null;
  quotaManager: QuotaManager | null;
  systemReviewer: SystemReviewer | null;
  capabilityMapper: CapabilityMapper | null;
  selfKnowledgeTree: SelfKnowledgeTree | null;
  coverageAuditor: CoverageAuditor | null;
  topicResumeMap: TopicResumeMap | null;
  /** Agent-initiated session respawn. Null when no Telegram adapter is
   *  wired (v1 requires a Telegram-bound session). */
  sessionRefresh: SessionRefresh | null;
  autonomyManager: AutonomyProfileManager | null;
  trustElevationTracker: TrustElevationTracker | null;
  autonomousEvolution: AutonomousEvolution | null;
  whatsapp: import('../messaging/WhatsAppAdapter.js').WhatsAppAdapter | null;
  slack: import('../messaging/slack/SlackAdapter.js').SlackAdapter | null;
  imessage: import('../messaging/imessage/IMessageAdapter.js').IMessageAdapter | null;
  messageBridge: import('../messaging/shared/MessageBridge.js').MessageBridge | null;
  hookEventReceiver: HookEventReceiver | null;
  worktreeMonitor: WorktreeMonitor | null;
  subagentTracker: SubagentTracker | null;
  instructionsVerifier: InstructionsVerifier | null;
  threadlineRouter: ThreadlineRouter | null;
  /** Threadline Phase 1 keystone — the Conversation single-source-of-truth and
   *  the warrants-a-reply gate, exposed on ctx so the LOCAL co-located inbound
   *  path (/messages/relay-agent) gates identically to the relay funnel. Without
   *  this, same-machine agents bypass the loop gate (caught in test-as-self). */
  conversationStore?: import('../threadline/ConversationStore.js').ConversationStore;
  warrantsReplyGate?: import('../threadline/WarrantsReplyGate.js').WarrantsReplyGate;
  /** CMT-509: surface parentless Threadline conversations to a dedicated topic. */
  collaborationSurfacer?: import('../threadline/CollaborationSurfacer.js').CollaborationSurfacer;
  /** ThreadResumeMap — exposed on ctx so /threadline/relay-send can stamp
   *  originTopicId on outbound sends. Per THREAD-TOPIC-LINKAGE-SPEC.md. */
  threadResumeMap: import('../threadline/ThreadResumeMap.js').ThreadResumeMap | null;
  /** TopicLinkageHandler — drives outbound capture + inbound topic-routing.
   *  Optional; null when threadline is disabled. */
  topicLinkageHandler: import('../threadline/TopicLinkageHandler.js').TopicLinkageHandler | null;
  handshakeManager: HandshakeManager | null;
  threadlineRelayClient: import('../threadline/client/ThreadlineClient.js').ThreadlineClient | null;
  listenerManager: import('../threadline/ListenerSessionManager.js').ListenerSessionManager | null;
  responseReviewGate: CoherenceGate | null;
  /** Scoped tone gate for outbound agent-to-user messaging routes.
   *  Uses the shared IntelligenceProvider (Claude CLI subscription or Anthropic API).
   *  Catches CLI commands, file paths, config syntax leaking to users. */
  messagingToneGate: MessagingToneGate | null;
  /** Layer 3 of the Topic Intent Layer — pre-send arc-check. Same instance
   *  is wired behind the HTTP route (createTopicIntentRoutes) and consumed
   *  in-process by checkOutboundMessage so the tone gate sees ArcCheck's
   *  signal alongside junk/jargon/duplicate. Null when disabled. */
  topicIntentArcCheck: import('../core/TopicIntentArcCheck.js').ArcCheck | null;
  /** Usher signal store (rung 4). Used by the outbound-reply path to credit a
   *  re-surface nudge the agent's reply actually used (precision numerator,
   *  path (a)). Optional/null when the Usher is disabled. */
  usherSignalStore?: import('../core/UsherSignalStore.js').UsherSignalStore | null;
  /** Deterministic dedup gate. Blocks near-duplicate outbound messages in
   *  the same conversation — universal safety net against respawn races,
   *  idempotency gaps, and other lifecycle hazards. No LLM call, runs on
   *  every outbound message. */
  outboundDedupGate: import('../core/OutboundDedupGate.js').OutboundDedupGate | null;
  telemetryHeartbeat: import('../monitoring/TelemetryHeartbeat.js').TelemetryHeartbeat | null;
  pasteManager: PasteManager | null;
  wsManager: WebSocketManager | null;
  soulManager: import('../core/SoulManager.js').SoulManager | null;
  featureRegistry: import('../core/FeatureRegistry.js').FeatureRegistry | null;
  discoveryEvaluator: import('../core/DiscoveryEvaluator.js').DiscoveryEvaluator | null;
  /** Independent autonomous-completion judge (mirrors /goal). Null if no IntelligenceProvider. */
  completionEvaluator: import('../core/CompletionEvaluator.js').CompletionEvaluator | null;
  unifiedTrust: UnifiedTrustSystem | null;
  /** Shared proxy coordinator — mutex + /build heartbeat record for the
   *  PresenceProxy ↔ PromiseBeacon ↔ /build-heartbeat three-way deconfliction
   *  (BUILD-STALL-VISIBILITY-SPEC Fix 2 "Routing"). */
  proxyCoordinator: import('../monitoring/ProxyCoordinator.js').ProxyCoordinator | null;
  /** Integrated-Being SharedStateLedger (v1). Null when disabled. */
  sharedStateLedger: import('../core/SharedStateLedger.js').SharedStateLedger | null;
  /** Integrated-Being LedgerSessionRegistry (v2). Null when v2Enabled=false. */
  ledgerSessionRegistry: import('../core/LedgerSessionRegistry.js').LedgerSessionRegistry | null;
  /** Initiative tracker — persisted record of multi-phase long-running work. */
  initiativeTracker: import('../core/InitiativeTracker.js').InitiativeTracker | null;
  /** Project-scope round runner (Phase 1b PR 3). Single chokepoint for
   *  /advance, /halt, /ack, /accept-partial. Null when initiativeTracker
   *  is also null. */
  projectRoundRunner: import('../core/ProjectRoundRunner.js').ProjectRoundRunner | null;
  /** Project drift checker (Phase 1b connect-the-dots). Null when no
   *  IntelligenceProvider is configured (then POST /projects/:id/drift-check
   *  returns 503). */
  projectDriftChecker: ProjectDriftChecker | null;
  /** Machine heartbeat (Phase 1b PR 4). Bundled with `config.machineId`
   *  so the claim-ownership route can compare against the current
   *  machine without a separate top-level field. Null when running in
   *  single-machine mode. */
  machineHeartbeat: {
    api: import('../core/MachineHeartbeat.js').MachineHeartbeat;
    config: { machineId: string };
  } | null;
  /** Threadline → Telegram bridge config — toggles + allow/deny list. Read by
   *  /threadline/telegram-bridge/config endpoints and by the bridge module
   *  to decide whether to mirror an inbound message into
   *  a Telegram topic. Null when LiveConfig is not wired. */
  telegramBridgeConfig: import('../threadline/TelegramBridgeConfig.js').TelegramBridgeConfig | null;
  /** Threadline → Telegram bridge — mirrors threadline messages into per-thread
   *  Telegram topics. RELAY-ONLY: never blocks routing, swallows its own
   *  errors. Null when no Telegram adapter is wired. */
  telegramBridge: import('../threadline/TelegramBridge.js').TelegramBridge | null;
  /** Threadline observability — read-only view layer over inbox/outbox/bindings.
   *  Powers the dashboard Threadline tab via /threadline/observability/*. */
  threadlineObservability: import('../threadline/ThreadlineObservability.js').ThreadlineObservability | null;
  /** CMT-567: shared deps for the "open this" LLM topic-name + summary brief.
   *  Built once at server startup; the hub/bind route + the structural intercept
   *  share it. Null sub-deps degrade to template/slug. */
  briefDeps: import('../threadline/openConversationBrief.js').BriefDeps | null;
  /** Pending reply waiters for threadline relay-send waitForReply support.
   *  Key: threadId (UUID — unique per conversation, unlike agent names which
   *  can collide when multiple agents share a name). Value: resolve callback
   *  with reply text. */
  threadlineReplyWaiters: Map<string, { resolve: (reply: string) => void; threadId: string; senderAgent: string; timer: ReturnType<typeof setTimeout> }>;
  /** UnjustifiedStopGate authority (PR3 — context-death spec). Null
   *  when no intelligence provider is configured; the evaluate route
   *  fail-opens in that case. */
  unjustifiedStopGate: UnjustifiedStopGate | null;
  /** Stop-gate SQLite persistence (PR3). Null when not initialized;
   *  the evaluate route will still produce a response, just without
   *  persistence. */
  stopGateDb: StopGateDb | null;
  /** notify-on-stop Layer B — surfaces a genuinely-stuck unattended stop to the
   *  user (coalesced via SentinelNotifier). Null when telegram isn't wired; the
   *  evaluate route simply skips the notice. */
  stopNotifier: import('../monitoring/StopNotifier.js').StopNotifier | null;
  /** Token-usage ledger (read-only observability over Claude Code JSONL
   *  transcripts). Null when stateDir is unavailable. */
  tokenLedger: import('../monitoring/TokenLedger.js').TokenLedger | null;
  featureMetricsLedger: import('../monitoring/FeatureMetricsLedger.js').FeatureMetricsLedger | null;
  /** Framework-Onboarding Mentor System issue ledger (read-only observability;
   *  signal-only — never gates). Null when stateDir is unavailable. Powers
   *  GET /framework-issues and /framework-issues/playbook. */
  frameworkIssueLedger?: import('../monitoring/FrameworkIssueLedger.js').FrameworkIssueLedger | null;
  /** Mentor-onboarding runner (§19.4). Null when not wired. Ships dormant
   *  (mentor.enabled=false); powers GET /mentor/status + POST /mentor/tick. */
  mentorRunner?: import('../scheduler/MentorOnboardingRunner.js').MentorOnboardingRunner | null;
  /** Failure-Learning Loop ledger + attribution engine (instar dev-process
   *  forensics). Null/absent when the feature is disabled (default) → /failures 503s. */
  failureLedger?: import('../monitoring/FailureLedger.js').FailureLedger | null;
  failureAttributionEngine?: import('../monitoring/FailureAttributionEngine.js').FailureAttributionEngine | null;
  /** Correction & Preference Learning Sentinel ledger (distilled, scrubbed
   *  records only). Null/absent when monitoring.correctionLearning.enabled is
   *  false (default) → /corrections 503s. */
  correctionLedger?: import('../monitoring/CorrectionLedger.js').CorrectionLedger | null;
  /** Apprenticeship Program registry + lifecycle gates (Apprenticeship Step 1).
   *  Null when stateDir is unavailable → /apprenticeship/* 503s. Powers the
   *  instance-as-project registry, the retro-gate (pending→active) and the
   *  doc-as-required-artifact gate (active→complete). */
  apprenticeshipProgram?: import('../core/ApprenticeshipProgram.js').ApprenticeshipProgram | null;
  /** Apprenticeship differential-cycle store. Null when SQLite/state init fails
   *  → /apprenticeship/cycles* 503s. */
  apprenticeshipCycleStore?: import('../monitoring/ApprenticeshipCycleStore.js').ApprenticeshipCycleStore | null;
  /** Observe-only overdue-cycle SLA monitor. Null when disabled/unavailable. */
  apprenticeshipCycleSlaMonitor?: import('../monitoring/ApprenticeshipCycleSlaMonitor.js').ApprenticeshipCycleSlaMonitor | null;
  /** SessionReaper — pressure-aware idle-session reaper. Null when not wired
   *  (older boot paths). Powers GET /sessions/reaper observability. */
  sessionReaper?: import('../monitoring/SessionReaper.js').SessionReaper | null;
  reapLog?: import('../monitoring/ReapLog.js').ReapLog | null;
  /** AgentWorktreeReaper — reclaims stale CLI worktrees. Null when not wired.
   *  Powers GET /worktrees/agent-reaper observability. */
  agentWorktreeReaper?: import('../monitoring/AgentWorktreeReaper.js').AgentWorktreeReaper | null;
  /** SleepController — agent hard-sleep decision (Stage B). Powers GET /sleep. */
  sleepController?: import('../monitoring/SleepController.js').SleepController | null;
  /** AgentActivityState — shared idle signal; bumped at the inbound chokepoint. */
  agentActivityState?: import('../monitoring/AgentActivityState.js').AgentActivityState | null;
  /** SleepWakeDetector — timer-drift sleep detection with a CPU-starvation guard.
   *  Powers GET /monitoring/sleep-wake (wake + suppression telemetry). Null when
   *  not wired (older boot paths / standby) → the route 503s. */
  sleepWakeDetector?: import('../core/SleepWakeDetector.js').SleepWakeDetector | null;
  /** TaskFlow registry — durable multi-step job records (OpenClaw import).
   *  Null when not enabled. Phase 1: no business consumers; admin endpoints
   *  only. */
  taskFlowRegistry: import('../tasks/TaskFlowRegistry.js').TaskFlowRegistry | null;
  /** ThreadlineFlowBridge — resumes TaskFlow flows waiting on
   *  cross-agent-callback when a matching threadline message arrives. Null
   *  when TaskFlow is not enabled. */
  threadlineFlowBridge: import('../tasks/ThreadlineFlowBridge.js').ThreadlineFlowBridge | null;
  /** Multi-machine coordinator (cross-machine seamlessness) — null on single-machine installs. */
  coordinator: import('../core/MultiMachineCoordinator.js').MultiMachineCoordinator | null;
  /** Multi-Machine Session Pool registry (§L2) — live MachineCapacity view behind
   *  GET /pool + the Machines dashboard tab. Null/absent when not wired (ships dark). */
  machinePoolRegistry?: import('../core/MachinePoolRegistry.js').MachinePoolRegistry | null;
  /** MeshRpc dispatcher (§L0) — the receive side behind POST /mesh/rpc (signed,
   *  recipient-bound, RBAC-gated m2m commands). Null/absent when not wired (dark). */
  meshRpcDispatcher?: import('../core/MeshRpc.js').MeshRpcDispatcher | null;
  /** Per-session ownership registry (§L3) — exactly-one-owner CAS + ownerOf/
   *  placementTargetOf. Read by L4 placement + observability. Null/absent (dark). */
  sessionOwnershipRegistry?: import('../core/SessionOwnershipRegistry.js').SessionOwnershipRegistry | null;
  /** Signed, append-only rollout-stage E2E results (§Rollout) — backs GET
   *  /session-pool/e2e-results so the gate state is observable. Null/absent (dark). */
  sessionPoolE2EResultStore?: import('../core/SessionPoolE2EResultStore.js').SessionPoolE2EResultStore | null;
  /**
   * Exactly-once ingress ledger (spec §8 G3a) — non-null ONLY when
   * multiMachine.exactlyOnceIngress is enabled. When present, the inbound
   * forward path dedups via it and the outbound reply path commits. null →
   * the gate is dark (default), and the message path behaves exactly as before.
   */
  messageLedger: import('../messaging/MessageProcessingLedger.js').MessageProcessingLedger | null;
  /**
   * Per-topic "current inbound dedupeKey" — set when a forward is claimed for
   * processing, read when the reply for that topic is committed. In-memory;
   * paired with messageLedger (both null when the gate is dark).
   */
  currentInboundByTopic: Map<string, string> | null;
  /**
   * Cross-machine reply-marker propagation (spec §8 G3a). When a reply commits,
   * the outbound path broadcasts the marker to standby peers so a post-handoff
   * redelivery is deduped on the new holder. null → no propagation (paired with
   * messageLedger; both null when exactly-once is dark).
   */
  replyMarkerTransport: import('../core/ReplyMarkerTransport.js').ReplyMarkerTransport | null;
  startTime: Date;
}

// Validation patterns for route parameters
const SESSION_NAME_RE = /^[a-zA-Z0-9_-]{1,200}$/;
const JOB_SLUG_RE = /^[a-zA-Z0-9_-]{1,100}$/;
const VALID_SORTS = ['significance', 'recent', 'name'] as const;

// ── Project-scope helpers (Phase 1a PR 2) ─────────────────────────

/**
 * Hash the incoming Authorization header to derive a per-token identity
 * for the projects-rate counter. We never store the raw token; the hash
 * is a stable per-token key.
 */
function hashAuthHeader(header: unknown): string {
  if (typeof header !== 'string') return 'anon';
  return createHash('sha256').update(header).digest('hex').slice(0, 16);
}

/**
 * Read-check-increment for the per-token projects-creation counter.
 * Returns `{ok: true}` if the request is within the 5/hour window, or
 * `{ok: false, windowEnds}` if the limit is reached.
 *
 * The counter file lives under `.instar/local/projects-rate.json` — the
 * `.instar/local/` directory is gitignored (Phase 1.12) so the counter
 * never syncs across machines. We bound file size by retaining only
 * tokens whose window is still open.
 */
function checkAndIncrementProjectsRate(
  stateDir: string,
  tokenHash: string
): { ok: true } | { ok: false; windowEnds: string } {
  const localDir = path.join(stateDir, 'local');
  try {
    fs.mkdirSync(localDir, { recursive: true });
  } catch {
    // mkdir failures fall through; we'll fail the write below.
  }
  const ratePath = path.join(localDir, 'projects-rate.json');
  type Window = { count: number; windowStart: number };
  let table: Record<string, Window> = {};
  try {
    if (fs.existsSync(ratePath)) {
      const raw = JSON.parse(fs.readFileSync(ratePath, 'utf-8'));
      if (raw && typeof raw === 'object') table = raw as Record<string, Window>;
    }
  } catch {
    table = {};
  }
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000;
  // GC entries whose window has expired.
  for (const k of Object.keys(table)) {
    if (now - (table[k]?.windowStart ?? 0) >= WINDOW_MS) delete table[k];
  }
  const entry = table[tokenHash];
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    table[tokenHash] = { count: 1, windowStart: now };
  } else if (entry.count >= 5) {
    return {
      ok: false,
      windowEnds: new Date(entry.windowStart + WINDOW_MS).toISOString(),
    };
  } else {
    entry.count += 1;
  }
  try {
    fs.writeFileSync(ratePath, JSON.stringify(table, null, 2), 'utf-8');
  } catch {
    // If we can't persist, fail open: still allow the call (rate-limit
    // is best-effort, not a security boundary).
  }
  return { ok: true };
}

/** Project + children creation as a single logical operation. */
async function createProjectAndChildren(
  tracker: import('../core/InitiativeTracker.js').InitiativeTracker,
  parsed: import('../core/PlanDocParser.js').ParsedPlanDoc
): Promise<{ project: unknown; children: unknown[] }> {
  if (!parsed.project) throw new Error('parsed.project is null');
  const proj = parsed.project;

  // Group children by roundName, preserving first-seen order.
  const roundOrder: string[] = [];
  const byRound = new Map<string, string[]>();
  for (const c of parsed.children) {
    if (!byRound.has(c.roundName)) {
      roundOrder.push(c.roundName);
      byRound.set(c.roundName, []);
    }
    byRound.get(c.roundName)!.push(c.id);
  }
  const rounds = roundOrder.map((name) => ({
    name,
    itemIds: byRound.get(name)!,
    status: 'pending' as const,
  }));

  const projectInit = await tracker.create({
    id: proj.id,
    title: proj.title,
    description: proj.description,
    phases: [{ id: 'overview', name: 'overview', status: 'pending' }],
    kind: 'project',
    rounds,
    sourceDocs: proj.sourceDocs,
    autoAdvance: proj.autoAdvance,
    telegramTopicId: proj.telegramTopicId,
    targetRepoPath: proj.targetRepoPath,
  });

  const createdChildren: unknown[] = [];
  for (const child of parsed.children) {
    const c = await tracker.create({
      id: child.id,
      title: child.title,
      description: `Source: ${child.sourceTag}; effort: ${child.effortTag}`,
      phases: [{ id: 'outline', name: 'outline', status: 'pending' }],
      kind: 'task',
      pipelineStage: child.pipelineStage,
      parentProjectId: proj.id,
    });
    createdChildren.push(c);
  }
  return { project: projectInit, children: createdChildren };
}

/** Subset a record by an allowlist of fields. */
function pickFields(
  obj: Record<string, unknown>,
  fields: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fields) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

/** Maps a /projects/:id/next action verb to the suggested skill invocation.
 *  Names are the canonical command set from PROJECT-SCOPE-SPEC § Phase 1.7. */
function skillCommandForAction(action: string, projectId: string, roundIndex: number): string {
  switch (action) {
    case 'await-user-approval':
      return `/project ack ${projectId}`;
    case 'ack-required':
      return `/project ack ${projectId}`;
    case 'resolve-conflict':
      return `/project resolve-conflict ${projectId}`;
    case 'accept-partial':
      return `/project accept-partial ${projectId} ${roundIndex}`;
    case 'run-spec-converge':
      return `/spec-converge`;
    case 'run-drift-check':
      return `/project drift ${projectId} ${roundIndex}`;
    case 'start-round':
    default:
      return `/project run-round ${projectId} ${roundIndex}`;
  }
}

/**
 * Top-level config keys that may be patched via `PATCH /config`.
 * Exported as the single source of truth so the enableAction-validity test
 * (tests/unit/feature-enableaction-validity.test.ts) can assert that every
 * FeatureDefinition whose enableAction patches `/config` targets a key that is
 * actually patchable — the guard that catches the `dispatches`-class bug
 * (enableAction pointing at a non-allowlisted key) at build time.
 * Spec: docs/specs/enable-layer-coherence.md
 */
export const PATCHABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'evolution', 'threadline', 'publishing', 'tunnel', 'gitBackup',
  'externalOperations', 'responseReview', 'inputGuard', 'monitoring',
  'updates', 'sessions', 'jobs',
  // `dispatches` and `feedback` each have a FeatureDefinition whose enableAction
  // patches that key; without them here those toggles 400 (the switch points at
  // a key the API refuses to change). Both are real config keys (types.ts:
  // dispatches?, feedback?; read in server.ts). The enableAction-validity test
  // (tests/unit/feature-enableaction-validity.test.ts) caught both.
  'dispatches', 'feedback',
]);

export function createRoutes(ctx: RouteContext): Router {
  const router = Router();

  // Content-hash dedup for the agent-to-agent relay-agent ingress path. Guards
  // the duplicate-reply bug where a sender that times out on the receiver's
  // session spawn retries with a FRESH message.id, slipping past the id-based
  // relay dedup. One instance per server (process-wide across relay-agent calls).
  const relayContentDedup = new RelayContentDedup();

  // ── PR-REVIEW-HARDENING kill-switch (Phase A) ─────────────────────
  //
  // Spec §"Runtime kill-switch": `prGate.phase = 'off'` returns 404 for
  // every /pr-gate/* route. Must run BEFORE any /pr-gate/* route
  // registration downstream — Express middleware only applies to routes
  // declared after it in the same Router. Placed here at the top so
  // every future pr-gate route is automatically gated by this check.
  //
  // Phases:
  //   'off'       — 404 with {disabled: true, reason: 'prGate.phase=off'}
  //   'shadow'    — pass-through; downstream handlers accept writes but
  //                 never block merges (future phase wiring).
  //   'layer1-2'  — pass-through; enforcement logic in handlers.
  //   'layer3'    — pass-through; full gate.
  //
  // Default-BLOCK allowlist shape (deliberately inverted from "block
  // exactly 'off'"): the spec's signal-vs-authority carve-out is
  // "safety guards on irreversible actions where false pass is
  // catastrophic". A default-pass check that blocks only one literal
  // spelling would let typos/casing/whitespace in the JSON config
  // ('OFF', '', ' shadow', 'bogus') bypass the gate. Default-block +
  // allowlist of known-active phases matches the risk profile: a new
  // phase value cannot accidentally open the gate; only explicit
  // allowlist membership does.
  const PR_GATE_ACTIVE_PHASES = new Set(['shadow', 'layer1-2', 'layer3']);
  router.use('/pr-gate', (_req, res, next) => {
    const prGate = (ctx.config as { prGate?: { phase?: unknown } }).prGate;
    const phase = typeof prGate?.phase === 'string'
      ? prGate.phase.trim().toLowerCase()
      : 'off';
    if (!PR_GATE_ACTIVE_PHASES.has(phase)) {
      return res.status(404).json({
        disabled: true,
        reason: 'prGate.phase=off',
      });
    }
    return next();
  });

  // Reflection metrics — usage-based reflection trigger (ported from Dawn)
  const reflectionMetrics = new ReflectionMetrics(ctx.config.stateDir);

  // Homeostasis monitor — work-velocity awareness (ported from Dawn)
  const homeostasisMonitor = new HomeostasisMonitor(ctx.config.stateDir);

  // Truncation detector for Telegram messages (Drop Zone integration)
  const truncationDetector = new TruncationDetector();

  // ── /telegram/reply X-Instar-DeliveryId dedup LRU (Layer 3 §3d step 4) ──
  // 24h sliding window of seen delivery_ids. Map preserves insertion order;
  // we GC entries whose timestamp is older than 24h on each access.
  const DELIVERY_LRU_MAX = 10_000;
  const DELIVERY_LRU_TTL_MS = 24 * 60 * 60 * 1000;
  const deliveryIdLru = new Map<string, number>();
  function deliveryLruHas(id: string): boolean {
    const at = deliveryIdLru.get(id);
    if (at === undefined) return false;
    if (Date.now() - at > DELIVERY_LRU_TTL_MS) {
      deliveryIdLru.delete(id);
      return false;
    }
    return true;
  }
  function deliveryLruRecord(id: string): void {
    if (deliveryIdLru.size >= DELIVERY_LRU_MAX) {
      // Drop oldest insertion-ordered entry.
      const first = deliveryIdLru.keys().next().value;
      if (first !== undefined) deliveryIdLru.delete(first);
    }
    deliveryIdLru.set(id, Date.now());
  }
  // Wrap Map.has to use TTL-aware logic without rewriting call sites.
  // We export via a small object so the route handler can call .has and .set.
  // (Not using a Set — we need TTL.) Helper functions above provide that.
  const deliveryIdLruHelpers = { has: deliveryLruHas, record: deliveryLruRecord };
  void deliveryIdLruHelpers; // referenced via the helpers; alias kept for grep

  // ── Messaging tone gate ──────────────────────────────────────────
  //
  // Invoked before forwarding agent-authored messages to a user. Runs the
  // ConversationalToneReviewer (single Haiku-class call, ~500ms) to catch CLI
  // commands, file paths, config keys, and other technical leakage that the
  // agent's internal memory discipline missed.
  //
  // Returns true if the message was blocked (response already sent as 422).
  // Returns false if safe to proceed (pass, fail-open, or gate unavailable).
  /**
   * Outbound-message gate — SINGLE authority for agent→user message delivery.
   *
   * Combines structured signals from upstream detectors (junk-payload matcher,
   * outbound dedup gate) with conversational context, and makes the block/allow
   * decision in one LLM call via MessagingToneGate.
   *
   * This is the reshaping called for by docs/signal-vs-authority.md: detectors
   * emit signals, the authority decides. No detector holds independent block
   * power — "test" is junk sometimes and legitimate other times; a near-
   * duplicate is respawn-race sometimes and a legitimate re-ask other times.
   * Only the authority has the conversational context to tell them apart.
   *
   * Bypass flags preserved:
   *   metadata.isProxy = true         → skip all gating (system-generated msgs)
   *   metadata.allowDebugText = true  → junk signal suppressed
   *   metadata.allowDuplicate = true  → duplicate signal suppressed
   *
   * Returns true if blocked (response already sent as 422). False if safe.
   */
  async function checkOutboundMessage(
    text: string,
    channel: string,
    res: import('express').Response,
    options: {
      topicId?: number;
      allowDebugText?: boolean;
      allowDuplicate?: boolean;
      messageKind?: 'reply' | 'health-alert' | 'unknown';
      jargon?: boolean;
    },
  ): Promise<boolean> {
    // ── Self-Violation Signal (OBSERVE-ONLY) ──────────────────────────
    // Record — but NEVER act on — the case where this finalized outbound
    // message contradicts a stored preference. This runs as a fire-and-forget
    // VOID call that is structurally independent of the tone-gate verdict and
    // of this function's return value: it cannot block, delay, or rewrite the
    // message. It runs FIRST (before the gate-availability early-return below)
    // so the observation happens regardless of whether the tone gate exists or
    // what it decides. Dark by default (gated inside on enabled+selfViolationSignal).
    void observeSelfViolation(text, options.topicId).catch(() => {
      /* @silent-fallback-ok — observe-only; a detector error never affects delivery */
    });

    if (!ctx.messagingToneGate) return false; // No authority configured — pass through

    try {
      // ── Collect signals from upstream detectors ──
      const signals: import('../core/MessagingToneGate.js').ToneReviewSignals = {};

      if (!options.allowDebugText) {
        const junkResult = isJunkPayload(text);
        signals.junk = {
          detected: junkResult.junk,
          reason: junkResult.reason,
        };
      }

      if (options.jargon) {
        try {
          const j = detectJargon(text);
          signals.jargon = { detected: j.detected, terms: j.terms, score: j.score };
        } catch {
          // Detector errors never override the authority — skip the signal.
        }
      }

      // Recent conversation — used by both the authority and the dedup detector.
      let recentMessages: import('../core/MessagingToneGate.js').ToneReviewContextMessage[] | undefined;
      let recentOutbound: Array<{ text: string; timestamp: number }> = [];
      if (options.topicId && ctx.topicMemory) {
        try {
          const rows = ctx.topicMemory.getRecentMessages(options.topicId, 10);
          recentMessages = rows.map((m) => ({
            role: m.fromUser ? ('user' as const) : ('agent' as const),
            text: m.text,
          }));
          recentOutbound = rows
            .filter((m) => !m.fromUser && m.text)
            .map((m) => ({ text: m.text, timestamp: new Date(m.timestamp).getTime() }));
        } catch {
          // Non-fatal — authority runs without context
        }
      }

      if (!options.allowDuplicate && ctx.outboundDedupGate && recentOutbound.length > 0) {
        try {
          const dupResult = ctx.outboundDedupGate.check({ text, recent: recentOutbound });
          signals.duplicate = {
            detected: dupResult.duplicate,
            similarity: dupResult.similarity,
            matchedText: dupResult.matchedText,
          };
        } catch {
          // Detector errors are never authoritative — just skip the signal.
        }
      }

      // ── Topic-Intent ArcCheck signal (Layer 3) ──
      // In-process call against the same ArcCheck instance the HTTP route
      // uses. Concurrent-eligible with the rest of the signal collection;
      // hard timeout means a slow classifier never reaches the gate's hot
      // path. Failures are silent — ArcCheck is signal-only and MUST NOT
      // block delivery. Spec: docs/specs/topic-intent-arccheck-wiring.md.
      if (options.topicId !== undefined && ctx.topicIntentArcCheck) {
        try {
          const ARC_CHECK_TIMEOUT_MS = 200;
          const arcVerdict = await Promise.race([
            ctx.topicIntentArcCheck.check({ topicId: options.topicId, draftText: text }),
            new Promise<{ fire: false }>((resolve) =>
              setTimeout(() => resolve({ fire: false }), ARC_CHECK_TIMEOUT_MS),
            ),
          ]);
          if (arcVerdict.fire) {
            signals.arcCheck = {
              fire: true,
              kind: arcVerdict.kind,
              refText: arcVerdict.refText,
              suggestedRewriteHint: arcVerdict.suggestedRewriteHint,
            };
          }
        } catch {
          // Detector errors are never authoritative — just skip the signal.
        }
      }

      // ── Invoke the single authority ──
      const result = await ctx.messagingToneGate.review(text, {
        channel,
        recentMessages,
        signals,
        targetStyle: ctx.config.messagingStyle,
        messageKind: options.messageKind,
      });

      // Structured observability: log every decision the authority made. This is
      // the "why I blocked" log — over-block audits read this. Invalid-rule
      // citations (authority drift) are also logged so patterns become visible.
      logToneGateDecision({
        text,
        channel,
        topicId: options.topicId,
        signals,
        result,
      });

      if (!result.pass) {
        res.status(422).json({
          error: 'tone-gate-blocked',
          rule: result.rule,
          issue: result.issue,
          suggestion: result.suggestion,
          latencyMs: result.latencyMs,
        });
        return true;
      }
    } catch {
      // Fail-open — any error short of a clean block lets the message through.
    }
    return false;
  }

  /**
   * Self-Violation Signal — OBSERVE-ONLY (Correction & Preference Learning
   * Sentinel extension).
   *
   * Runs `detectSelfViolation` against the agent's currently-active preferences
   * and, on a hit, records the violation in the CorrectionLedger (reinforcing the
   * matched preference's recurrence/salience) and emits a non-blocking audit line.
   *
   * HARD GUARANTEES (the user's explicit constraint — "guards that block messages
   * have too much power"):
   *   - SIGNAL-ONLY: this function returns void. It is called as a fire-and-forget
   *     branch in checkOutboundMessage and has NO path to block, delay, rewrite,
   *     or otherwise influence the outbound message or the gate's verdict.
   *   - FAIL-OPEN: every operation is guarded; any throw is swallowed. It never
   *     propagates an error to the delivery seam.
   *   - DARK BY DEFAULT: inert unless BOTH `monitoring.correctionLearning.enabled`
   *     AND `monitoring.correctionLearning.selfViolationSignal` are true, AND a
   *     correction ledger is wired.
   */
  async function observeSelfViolation(text: string, topicId?: number): Promise<void> {
    try {
      const cl = ctx.config.monitoring?.correctionLearning;
      // Dark unless explicitly enabled AND the sub-flag is on AND a ledger exists.
      if (cl?.enabled !== true || cl?.selfViolationSignal !== true) return;
      if (!ctx.correctionLedger) return;
      if (typeof text !== 'string' || text.trim().length === 0) return;

      const { PreferencesManager } = await import('../core/PreferencesManager.js');
      const { detectSelfViolation } = await import('../monitoring/SelfViolationDetector.js');

      const manager = new PreferencesManager(ctx.config.stateDir);
      const store = manager.read();
      const active = store.preferences.filter((p) => typeof p.violationPattern === 'string');
      if (active.length === 0) return; // no checkable preferences → nothing to do

      const violations = detectSelfViolation(text, active);
      if (violations.length === 0) return;

      for (const v of violations) {
        // Record a self-violation occurrence. dedupeKey is the violated
        // preference's own key so repeated self-violations of the SAME preference
        // collapse to one record and ESCALATE its recurrence in the analyzer.
        // deterministicWeight is set at the code-determined threshold so the
        // occurrence counts toward the recurrence gate (an explicit regex/keyword
        // hit is a full-confidence, code-determined signal — never LLM-inferred).
        const learning = scrubCorrectionSecrets(
          `self-violation: outbound message contradicted preference "${v.preference.learning}"`,
        );
        const summary = scrubCorrectionSecrets(
          `Self-violation of a stored preference (matched ${v.matchKind}).`,
        );
        ctx.correctionLedger.record({
          kind: 'user-preference',
          learning,
          scrubbedSummary: summary,
          deterministicWeight: LEARNING_DETERMINISTIC_THRESHOLD,
          llmConfidence: 0,
          topicId: typeof topicId === 'number' ? topicId : null,
        });

        // Non-blocking audit line — observability only.
        try {
          process.stderr.write(
            `[self-violation] ${JSON.stringify({
              t: new Date().toISOString(),
              kind: 'self-violation',
              topicId: topicId ?? null,
              dedupeKey: v.preference.dedupeKey,
              matchKind: v.matchKind,
              matchedHead: v.matchedText.slice(0, 80),
            })}\n`,
          );
        } catch {
          /* @silent-fallback-ok — audit must never throw */
        }
      }
    } catch {
      // @silent-fallback-ok — observe-only; any error silently no-ops and the
      // outbound message is unaffected.
    }
  }

  /**
   * Log a tone-gate decision. Structured output for the over-block audit tail.
   * Writes to stderr so it's captured in the server log.
   */
  function logToneGateDecision(entry: {
    text: string;
    channel: string;
    topicId?: number;
    signals: import('../core/MessagingToneGate.js').ToneReviewSignals;
    result: import('../core/MessagingToneGate.js').ToneReviewResult;
  }): void {
    try {
      const line = {
        t: new Date().toISOString(),
        kind: 'tone-gate-decision',
        channel: entry.channel,
        topicId: entry.topicId,
        textLen: entry.text.length,
        textHead: entry.text.slice(0, 80),
        pass: entry.result.pass,
        rule: entry.result.rule || null,
        failedOpen: entry.result.failedOpen || false,
        invalidRule: entry.result.invalidRule || false,
        latencyMs: entry.result.latencyMs,
        signals: {
          junk: entry.signals.junk?.detected ?? null,
          dup: entry.signals.duplicate?.detected ?? null,
          dupSim: entry.signals.duplicate?.similarity ?? null,
        },
      };
      process.stderr.write(`[tone-gate] ${JSON.stringify(line)}\n`);
    } catch {
      // Logging must never throw
    }
  }

  // ── Discovery ───────────────────────────────────────────────────
  //
  // Bootstrap endpoint for agents to discover available APIs.

  router.get('/.well-known/instar.json', (_req, res) => {
    res.json({
      name: ctx.config.projectName,
      version: ctx.config.version || '0.0.0',
      endpoints: {
        health: '/health',
        capabilities: '/capabilities',
        capabilityMap: '/capability-map',
        capabilityMapCompact: '/capability-map?format=compact',
        capabilityMapDrift: '/capability-map/drift',
        capabilityMapRefresh: '/capability-map/refresh',
        projectMap: '/project-map',
        sessions: '/sessions',
        jobs: '/jobs',
        jobHistory: '/jobs/history',
        jobHistoryBySlug: '/jobs/:slug/history',
        evolution: '/evolution',
        context: '/context',
        autonomy: '/autonomy',
      },
    });
  });

  // ── Health ──────────────────────────────────────────────────────

  router.get('/ping', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health', (req, res) => {
    const uptimeMs = Date.now() - ctx.startTime.getTime();
    // Use cached session count to avoid blocking the event loop with synchronous
    // tmux has-session calls. The cache is updated every 5s by the monitor tick.
    // This prevents the death spiral where stale sessions overwhelm the health
    // endpoint, causing the lifeline to restart the server in a tight loop.
    const cached = ctx.sessionManager.getCachedRunningSessions();
    const sessionCount = cached.count;
    const maxSessions = ctx.config.sessions?.maxSessions ?? 10;
    const sessionExhausted = sessionCount >= maxSessions;

    let totalFailures = 0;
    if (ctx.scheduler) {
      const jobs = ctx.scheduler.getJobs();
      for (const j of jobs) {
        const st = ctx.state.getJobState(j.slug);
        if (st) totalFailures += st.consecutiveFailures;
      }
    }

    const degradations = DegradationReporter.getInstance().getEvents();
    let isDegraded = sessionExhausted || totalFailures >= 5 || degradations.length > 0;

    const base: Record<string, unknown> = {
      status: isDegraded ? 'degraded' : 'ok',
      uptime: uptimeMs,
      uptimeHuman: formatUptime(uptimeMs),
      degradations: degradations.length,
      ...(degradations.length > 0 && {
        degradationSummary: degradations.map(e => DegradationReporter.narrativeFor(e)),
      }),
      // Stop-gate route contract (P0.7). Always present, unauthenticated:
      // hook-lib reads this on startup before sending the auth token.
      gateRouteVersion: GATE_ROUTE_VERSION,
      gateRouteMinimumVersion: GATE_ROUTE_MINIMUM_VERSION,
    };

    // Include detailed info only for authenticated callers.
    // Must actually validate the token here since authMiddleware skips /health.
    let isAuthed = !ctx.config.authToken;
    if (!isAuthed && ctx.config.authToken) {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const token = header.slice(7);
        const ha = createHash('sha256').update(token).digest();
        const hb = createHash('sha256').update(ctx.config.authToken).digest();
        isAuthed = timingSafeEqual(ha, hb);
      }
    }
    if (isAuthed) {
      const mem = process.memoryUsage();
      // Use ProcessIntegrity for truthful version reporting
      const integrity = ProcessIntegrity.getInstance();
      if (integrity) {
        base.version = integrity.runningVersion;
        if (integrity.versionMismatch) {
          base.versionMismatch = true;
          base.diskVersion = integrity.diskVersion;
          base.bootedAt = integrity.bootedAt;
        }
      } else {
        base.version = ctx.config.version || '0.0.0';
      }
      base.sessions = { current: sessionCount, max: maxSessions };
      base.schedulerRunning = ctx.scheduler !== null;
      base.consecutiveJobFailures = totalFailures;

      // Cross-Machine Seamlessness (spec §11) — the Phase-1 "feature is alive"
      // surface. Always present with valid fields (never null/503), even on a
      // single-machine install (where the lease is trivially held).
      base.multiMachine = ctx.coordinator
        ? { enabled: true, syncStatus: ctx.coordinator.getSyncStatus() }
        : { enabled: ctx.config.multiMachine?.enabled ?? false, syncStatus: null };
      base.project = ctx.config.projectName;
      base.node = process.version;
      base.memory = {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      };
      if (ctx.autoUpdater) {
        const auto = ctx.autoUpdater.getStatus();
        base.autoUpdater = {
          lastCheck: auto.lastCheck,
          lastApply: auto.lastApply,
          lastAppliedVersion: auto.lastAppliedVersion,
          pendingUpdate: auto.pendingUpdate,
          restartDeferral: auto.restartDeferral,
          lastError: auto.lastError,
        };
      }

      // System-wide memory state (prefer MemoryPressureMonitor's vm_stat-based
      // calculation on macOS — os.freemem() only counts "Pages free" and ignores
      // reclaimable inactive/purgeable pages, reporting wildly pessimistic numbers)
      if (ctx.memoryMonitor) {
        const memState = ctx.memoryMonitor.getState();
        base.systemMemory = {
          totalGB: Math.round(memState.totalGB * 10) / 10,
          freeGB: Math.round(memState.freeGB * 10) / 10,
          usedPercent: Math.round(memState.pressurePercent * 10) / 10,
        };
      } else {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        base.systemMemory = {
          totalGB: Math.round(totalMem / (1024 ** 3) * 10) / 10,
          freeGB: Math.round(freeMem / (1024 ** 3) * 10) / 10,
          usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
        };
      }

      // Memory pressure state from MemoryPressureMonitor (macOS-accurate via vm_stat).
      // On macOS, os.freemem() is misleading — wired+compressed+app memory leaves little
      // "free" even under no real pressure. MemoryPressureMonitor uses platform-native
      // APIs to classify actual pressure as normal/warning/elevated/critical.
      if (ctx.memoryMonitor) {
        const ps = ctx.memoryMonitor.getState();
        base.memoryPressure = {
          state: ps.state,
          pressurePercent: ps.pressurePercent,
        };
      }

      // Orphan reaper last report (per-process memory visibility)
      if (ctx.orphanReaper) {
        const reaperReport = ctx.orphanReaper.getLastReport();
        if (reaperReport) {
          base.claudeProcesses = {
            tracked: reaperReport.tracked.length,
            orphans: reaperReport.orphans.length,
            external: reaperReport.external.length,
            totalMemoryMB: reaperReport.totalMemoryMB,
            orphanMemoryMB: reaperReport.orphanMemoryMB,
            externalMemoryMB: reaperReport.externalMemoryMB,
            lastScan: reaperReport.timestamp,
          };
        }
      }

      // Job health summary
      if (ctx.scheduler) {
        const jobs = ctx.scheduler.getJobs();
        const failingJobs = jobs
          .map(j => ({ slug: j.slug, state: ctx.state.getJobState(j.slug) }))
          .filter(j => j.state && j.state.consecutiveFailures > 0);
        base.jobs = {
          total: jobs.length,
          enabled: jobs.filter(j => j.enabled).length,
          failing: failingJobs.map(j => ({
            slug: j.slug,
            failures: j.state!.consecutiveFailures,
            lastError: j.state!.lastError,
          })),
        };
      }

      // System Reviewer health
      if (ctx.systemReviewer) {
        const latest = ctx.systemReviewer.getLatest();
        const health = ctx.systemReviewer.getHealthStatus();
        const failedProbes = latest
          ? latest.results.filter(r => !r.passed).map(r => ({
              probeId: r.probeId,
              name: r.name,
              tier: r.tier,
              error: r.error,
              remediation: r.remediation,
            }))
          : [];
        base.systemReview = {
          status: health,
          lastReview: latest ? {
            status: latest.status,
            timestamp: latest.timestamp,
            passed: latest.stats.passed,
            failed: latest.stats.failed,
            skipped: latest.stats.skipped,
          } : null,
          probesRegistered: ctx.systemReviewer.getProbeCount(),
          failedProbes,
          detailsUrl: '/system-reviews/latest',
        };
        // Contribute to overall degradation if critical
        if (latest?.status === 'critical') {
          isDegraded = true;
        }
      }

      // WhatsApp adapter status
      if (ctx.whatsapp) {
        const waStatus = ctx.whatsapp.getStatus();
        base.whatsapp = {
          state: waStatus.state,
          phoneNumber: waStatus.phoneNumber,
          registeredSessions: waStatus.registeredSessions,
          pendingMessages: waStatus.pendingMessages,
          stalledChannels: waStatus.stalledChannels,
          totalMessagesLogged: waStatus.totalMessagesLogged,
        };
        if (waStatus.state === 'disconnected') {
          isDegraded = true;
        }
      }
    }
    res.json(base);
  });

  // GET /whoami — authenticated identity probe.
  //
  // Spec § Layer 1c: the sentinel hits this BEFORE any auth-bearing
  // POST /telegram/reply during recovery. It returns this server's
  // agentId/port/version so the caller can verify it's talking to the
  // right agent before sending content.
  //
  // Hard requirement (no deprecation exception): the X-Instar-AgentId
  // header MUST be present AND match this server's agent-id. If we
  // accepted bare-token requests here, the endpoint would become a
  // discovery oracle for token→port→agent-id triples. The auth
  // middleware already validates the token and (when header present)
  // the agent-id; we re-check the header presence here to close the
  // deprecation hole that otherwise lets bare-token callers learn the
  // expected agent-id from the response.
  router.get(
    '/whoami',
    createWhoamiHandler({
      agentId: ctx.config.projectName,
      port: ctx.config.port,
      configVersion: ctx.config.version,
    })
  );

  // POST /events/delivery-failed — fan-out for the script-side detector.
  //
  // Spec § Layer 2c. The relay script INSERTs into its local SQLite queue
  // and then best-effort POSTs here so the in-process Layer 3 sentinel
  // can react in <1s rather than waiting for its 5-minute watchdog tick.
  // The endpoint itself does not persist anything — SQLite is the
  // durable record on the script side.
  router.post(
    '/events/delivery-failed',
    createDeliveryFailedHandler({
      agentId: ctx.config.projectName,
      emit: ctx.wsManager
        ? (event) => {
            // wsManager is set lazily after server.listen; if it's still
            // null at request time we just no-op the broadcast — the
            // event was still accepted, and the Layer 3 backstop watchdog
            // (5-min tick over SQLite) catches up.
            if (ctx.wsManager) ctx.wsManager.broadcastEvent(event);
          }
        : undefined,
    })
  );

  /**
   * Get all feature degradation events.
   * A degradation means a feature fallback activated — the primary path failed.
   * This is always a bug that needs investigation.
   */
  router.get('/health/degradations', (_req, res) => {
    const reporter = DegradationReporter.getInstance();
    const events = reporter.getEvents();
    res.json({
      total: events.length,
      unreported: reporter.getUnreportedEvents().length,
      events: events.map(e => ({
        ...e,
        narrative: DegradationReporter.narrativeFor(e),
      })),
    });
  });

  /**
   * Mark degradation events as reported by feature-name match. Used by
   * the guardian-pulse daily digest after surfacing degradations to the
   * attention queue (PR0c — context-death-pitfall-prevention spec).
   * Closes the loop so the next pulse run doesn't re-surface the same
   * events.
   *
   * Body: { feature: string }   exact-match feature name
   *   OR: { featurePattern: string }   regex source, applied without flags
   *
   * Returns: { flipped: number }   count of events actually marked
   */
  /**
   * Read-only observability for the RateLimitSentinel — active server-throttle
   * recoveries (sessionName, status, attempts, nextBackoffMs). Bearer-gated by
   * the global auth middleware. Backs the E2E "feature is alive" check.
   */
  router.get('/rate-limit/status', (_req, res) => {
    if (!ctx.rateLimitSentinel) {
      res.json({ enabled: false, active: [] });
      return;
    }
    res.json({
      enabled: true,
      active: ctx.rateLimitSentinel.listActive().map(s => ({
        sessionName: s.sessionName,
        trigger: s.trigger,
        status: s.status,
        attempts: s.attempts,
        nextBackoffMs: s.nextBackoffMs,
        detectedAt: s.detectedAt,
        lastInjectAt: s.lastInjectAt,
        lastCheckInAt: s.lastCheckInAt,
      })),
    });
  });

  router.post('/health/degradations/mark-reported', (req, res) => {
    const reporter = DegradationReporter.getInstance();
    const { feature, featurePattern } = req.body ?? {};
    if (typeof feature === 'string' && feature.length > 0) {
      const flipped = reporter.markReported(feature);
      res.json({ flipped });
      return;
    }
    if (typeof featurePattern === 'string' && featurePattern.length > 0) {
      let re: RegExp;
      try {
        re = new RegExp(featurePattern);
      } catch (err) {
        res.status(400).json({
          error: 'invalid featurePattern',
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const flipped = reporter.markReported(re);
      res.json({ flipped });
      return;
    }
    res.status(400).json({ error: 'feature or featurePattern required' });
  });

  /**
   * Coherence health — runtime self-awareness report.
   * Checks config drift, state durability, output sanity, and feature readiness.
   * Where possible, issues are self-corrected.
   */
  router.get('/health/coherence', (_req, res) => {
    if (!ctx.coherenceMonitor) {
      res.json({ status: 'unavailable', message: 'CoherenceMonitor not initialized' });
      return;
    }
    const report = ctx.coherenceMonitor.getLastReport();
    if (!report) {
      res.json({ status: 'pending', message: 'First check has not run yet' });
      return;
    }
    res.json({
      ...report,
      corrections: ctx.coherenceMonitor.getCorrectionLog(),
    });
  });

  /**
   * Trigger an on-demand coherence check.
   */
  router.post('/health/coherence/check', (_req, res) => {
    if (!ctx.coherenceMonitor) {
      res.status(503).json({ error: 'CoherenceMonitor not initialized' });
      return;
    }
    const report = ctx.coherenceMonitor.runCheck();
    res.json(report);
  });

  // ── Hook Events ────────────────────────────────────────────────
  //
  // Receives HTTP hook event payloads from Claude Code.
  // The central ingest point for PostToolUse, SubagentStart/Stop, Stop,
  // SessionEnd, WorktreeCreate/Remove, TaskCompleted events.

  // Compaction-resume trigger #3 — called by .instar/hooks/instar/compaction-recovery.sh
  // immediately after a compaction event, independent of HookEventReceiver and Watchdog.
  // This is the most reliable path: the hook only runs when compaction actually happened.
  // Pre-prompt memory recall (OpenClaw import T2.2). Invoked by a Claude Code
  // UserPromptSubmit hook to inject bounded memory context before each reply.
  // Synchronous from the caller's perspective; bounded by recallTimeoutMs in
  // PromptBuildRecallConfig.
  router.post('/internal/prompt-recall', async (req, res) => {
    const userMessage = (req.body?.userMessage ?? '').toString();
    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
    if (!userMessage) {
      res.status(400).json({ error: 'userMessage required' });
      return;
    }
    const recall = (globalThis as Record<string, unknown>).__instarPromptBuildRecall as
      | { recall: (opts: { userMessage: string; sessionId?: string }) => { contextText: string; source: string; elapsedMs: number; resultsCount: number; cacheKey: string } }
      | undefined;
    if (!recall) {
      res.json({ contextText: '', source: 'no-recall', elapsedMs: 0, resultsCount: 0, cacheKey: '' });
      return;
    }
    const result = recall.recall({ userMessage, sessionId });
    res.json(result);
  });

  router.post('/internal/compaction-resume', async (req, res) => {
    const sessionName = (req.body?.sessionName || req.body?.tmuxSession || '').toString();
    if (!sessionName) {
      res.status(400).json({ error: 'sessionName required' });
      return;
    }
    const recover = (globalThis as Record<string, unknown>).__instarCompactionRecover as
      | ((sessionName: string, triggerLabel: string) => Promise<boolean>)
      | undefined;
    if (!recover) {
      res.status(503).json({ error: 'compaction recovery not initialized' });
      return;
    }
    // Delay slightly to let Claude Code settle at the post-compaction prompt
    setTimeout(() => {
      recover(sessionName, 'recovery-hook').catch(err => {
        console.warn('[CompactionResume] hook-triggered recovery failed:', err);
      });
    }, 8_000);
    res.json({ ok: true, scheduled: true });
  });

  // ── Stop-gate (UnjustifiedStopGate) — PR0a server infra ─────────────
  //
  // Spec: docs/specs/context-death-pitfall-prevention.md
  // Implements (b) hot-path batched read, kill-switch fast-path, and
  // session-start timestamp recording. State is in-memory for PR0a;
  // PR3 migrates to SQLite. All endpoints respect the existing auth
  // middleware (drift-correction threat model — local auth is enough).

  router.get('/internal/stop-gate/hot-path', (req, res) => {
    const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
    const state = getHotPathState({ sessionId: sessionId || undefined });
    res.json(state);
  });

  router.get('/internal/stop-gate/kill-switch', (_req, res) => {
    res.json({ killSwitch: getKillSwitch() });
  });

  router.post('/internal/stop-gate/kill-switch', (req, res) => {
    const value = req.body?.value;
    if (typeof value !== 'boolean') {
      res.status(400).json({ error: 'value must be boolean' });
      return;
    }
    const prior = setKillSwitch(value);
    res.json({ killSwitch: value, prior, changed: prior !== value });
  });

  // Mode flip endpoint (PR4 — context-death spec § rollout PR4).
  // Used by `instar gate set unjustified-stop --mode <mode>`.
  // Multi-machine fanout (`--wait-sync`, `--skip-machine`,
  // `--allow-partial`) lands in PR4b; this endpoint covers the local
  // flip only.
  router.post('/internal/stop-gate/mode', (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
      res.status(400).json({ error: 'mode must be off | shadow | enforce' });
      return;
    }
    const prior = getMode();
    setMode(mode);
    res.json({ mode, prior, changed: prior !== mode });
  });

  // ── Stop-gate evaluate + log + annotations (PR3 — context-death
  //    spec § (b),(d)) ─────────────────────────────────────────────
  //
  // evaluate: invoked by the stop-hook router in shadow+ modes. Takes
  // the evidence_metadata + untrusted_content payload, runs the
  // UnjustifiedStopGate authority, writes the event to SQLite, and
  // returns the decision plus a server-assembled reminder (for
  // `continue` decisions). Fails open on any error path — the response
  // always includes `decision: 'allow'` fallback if the authority
  // couldn't run.

  router.post('/internal/stop-gate/evaluate', async (req, res) => {
    const body = (req.body ?? {}) as Partial<{
      sessionId: string;
      evidenceMetadata: EvaluateInput['evidenceMetadata'];
      untrustedContent: EvaluateInput['untrustedContent'];
    }>;

    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId required' });
      return;
    }
    if (!body.evidenceMetadata || !body.untrustedContent) {
      res.status(400).json({ error: 'evidenceMetadata and untrustedContent required' });
      return;
    }

    const mode = getMode() as EvalMode;
    const agentId = ctx.config.projectName ?? 'unknown';
    const eventId = cryptoRandomUUID();
    const ts = Date.now();
    const reasonPreview = (body.untrustedContent.stopReason ?? '').slice(0, 200);
    // notify-on-stop Layer B: whether the stopping session is unattended
    // (autonomous). Used only to gate the user-facing notice (StopNotifier);
    // never affects the gate decision itself.
    const autonomousActive = getHotPathState({ sessionId: sessionId || undefined }).autonomousActive;

    // Kill-switch or mode=off: short-circuit to allow, no authority
    // call, no event logged (caller already knows not to call us here,
    // but belt-and-suspenders).
    if (getKillSwitch() || mode === 'off') {
      res.json({
        eventId,
        decision: 'allow',
        rule: null,
        reminder: '',
        shortCircuit: getKillSwitch() ? 'kill-switch' : 'mode-off',
      });
      return;
    }

    const authority = ctx.unjustifiedStopGate;
    const db = ctx.stopGateDb;

    // Per-session continue-ceiling (spec § (b) Outcomes).
    //
    // If this session has already received >= CONTINUE_CEILING `continue`
    // decisions, force_allow. The authority may be consistently wrong
    // on this session; keep letting it stop and let the operator see
    // the stuck-state flag. No authority call on the force-allow path.
    const priorCount = db?.getContinueCount(sessionId)?.count ?? 0;
    if (priorCount >= CONTINUE_CEILING) {
      if (db) {
        db.setStuck(sessionId, ts);
        db.recordEvent({
          eventId,
          sessionId,
          agentId,
          ts,
          mode,
          decision: 'force_allow',
          rule: null,
          invalidKind: null,
          evidencePointerJson: null,
          latencyMs: 0,
          reasonPreview,
        });
        db.rollupAggregate({
          agentId,
          dayKey: dayKeyFor(ts),
          triggeredDelta: 1,
          shadowDelta: mode === 'shadow' ? 1 : 0,
          allowDelta: 1,
        });
      }
      res.json({
        eventId,
        decision: 'force_allow',
        rule: null,
        reminder: '',
        shortCircuit: 'continue-ceiling',
        priorCount,
      });
      return;
    }

    let outcome: AuthorityOutcome | null = null;
    if (authority) {
      try {
        outcome = await authority.evaluate({
          evidenceMetadata: body.evidenceMetadata,
          untrustedContent: body.untrustedContent,
        });
      } catch (err) {
        outcome = {
          ok: false,
          failure: {
            kind: 'llmUnavailable',
            detail: err instanceof Error ? err.message : String(err),
            latencyMs: 0,
          },
        };
      }
    } else {
      outcome = {
        ok: false,
        failure: { kind: 'llmUnavailable', detail: 'authority not configured', latencyMs: 0 },
      };
    }

    // Log + respond. Failures fail-open to allow.
    if (outcome.ok) {
      const r = outcome.result;

      // Server-side post-verifier for `continue` decisions (spec §
      // "Evidence pointer" lines 273-281). On any structural check
      // failure: fail-open → allow + invalidEvidence log. The
      // authority's stated rule is discarded.
      if (r.decision === 'continue') {
        const verifyFailure = await postVerifyEvidence(
          ctx.config.projectDir,
          body.evidenceMetadata,
          r.evidencePointer
        );
        if (verifyFailure) {
          if (db) {
            db.recordEvent({
              eventId,
              sessionId,
              agentId,
              ts,
              mode,
              decision: null,
              rule: null,
              invalidKind: 'invalidEvidence',
              evidencePointerJson: JSON.stringify(r.evidencePointer),
              latencyMs: r.latencyMs,
              reasonPreview,
            });
            db.rollupAggregate({
              agentId,
              dayKey: dayKeyFor(ts),
              triggeredDelta: 1,
              shadowDelta: mode === 'shadow' ? 1 : 0,
              failureDelta: 1,
            });
          }
          DegradationReporter.getInstance().report({
            feature: 'unjustifiedStopGate.postVerifier',
            primary: 'Server-side evidence pointer structural verification',
            fallback: 'fail-open → allow',
            reason: verifyFailure,
            impact: 'Stop event allowed (authority continue rejected as unverifiable)',
          });
          res.json({
            eventId,
            decision: 'allow',
            rule: null,
            reminder: '',
            failOpen: 'invalidEvidence',
            postVerifyFailure: verifyFailure,
            latencyMs: r.latencyMs,
          });
          return;
        }
      }

      // Record + count. On `continue`, increment the session counter
      // (the NEXT call hitting CONTINUE_CEILING will short-circuit to
      // force_allow above). Atomic via SQLite UPSERT.
      if (db && r.decision === 'continue') {
        db.incrementContinueCount(sessionId, ts);
      }

      const reminder = r.decision === 'continue' ? assembleReminder(r.rule, r.evidencePointer) : '';
      if (db) {
        db.recordEvent({
          eventId,
          sessionId,
          agentId,
          ts,
          mode,
          decision: r.decision,
          rule: r.rule,
          invalidKind: null,
          evidencePointerJson: JSON.stringify(r.evidencePointer),
          latencyMs: r.latencyMs,
          reasonPreview,
        });
        db.rollupAggregate({
          agentId,
          dayKey: dayKeyFor(ts),
          triggeredDelta: 1,
          shadowDelta: mode === 'shadow' ? 1 : 0,
          continueDelta: r.decision === 'continue' ? 1 : 0,
          allowDelta: r.decision === 'allow' ? 1 : 0,
          escalateDelta: r.decision === 'escalate' ? 1 : 0,
        });
      }
      res.json({
        eventId,
        decision: r.decision,
        rule: r.rule,
        reminder,
        latencyMs: r.latencyMs,
      });
      // notify-on-stop Layer B: surface a genuinely-stuck unattended stop to the
      // user. No-ops for non-worthy decisions, attended sessions, and recent
      // dups — see StopNotifier. Fire-and-forget; never affects the response.
      ctx.stopNotifier?.maybeNotify({
        sessionId,
        mode,
        decision: r.decision,
        autonomousActive,
      });
    } else {
      // Fail-open: allow. Log with the failure kind so guardian-pulse
      // can surface patterns. A `breakerOpen` short-circuit is NOT a real
      // evaluation failure (the breaker deliberately skipped the LLM after
      // repeated provider failures), so it's excluded from the failure rollup
      // and the degradation report — recording it would skew the gate's
      // failure-rate analytics with the very churn the breaker exists to stop.
      if (db && outcome.failure.kind !== 'breakerOpen') {
        db.recordEvent({
          eventId,
          sessionId,
          agentId,
          ts,
          mode,
          decision: null,
          rule: null,
          invalidKind: outcome.failure.kind,
          evidencePointerJson: null,
          latencyMs: outcome.failure.latencyMs,
          reasonPreview,
        });
        db.rollupAggregate({
          agentId,
          dayKey: dayKeyFor(ts),
          triggeredDelta: 1,
          shadowDelta: mode === 'shadow' ? 1 : 0,
          failureDelta: 1,
        });
      }
      // E2E-PAIRING: EXEMPT — a one-line conditional on an existing internal
      // route (/internal/stop-gate/evaluate); no new API surface. Covered by
      // tests/unit/UnjustifiedStopGate-breaker.test.ts + tests/unit/routes-stopGate.test.ts.
      // Suppress the per-event degradation when the gate's circuit breaker is
      // open: the breaker only opens after repeated provider failures already
      // reported the condition, and re-emitting on every short-circuited stop is
      // exactly the /health flood this breaker exists to stop (a 2s budget vs the
      // ~5-6s `claude -p` path makes subscription agents time out on every stop).
      // The fail-open still happens; only the redundant degradation is withheld.
      if (outcome.failure.kind !== 'breakerOpen') {
        DegradationReporter.getInstance().report({
          feature: `unjustifiedStopGate.${outcome.failure.kind}`,
          primary: 'Authority evaluation',
          fallback: 'fail-open → allow',
          reason: outcome.failure.detail,
          impact: 'Stop event allowed without authority ruling (drift correction not applied)',
        });
      }
      res.json({
        eventId,
        decision: 'allow',
        rule: null,
        reminder: '',
        failOpen: outcome.failure.kind,
        latencyMs: outcome.failure.latencyMs,
      });
    }
  });

  router.get('/internal/stop-gate/log', (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.tail ?? '100'), 10) || 100));
    const db = ctx.stopGateDb;
    if (!db) {
      res.json({ events: [] });
      return;
    }
    const events = db.recentEvents(limit);
    res.json({ events });
  });

  router.post('/internal/stop-gate/annotations', (req, res) => {
    const db = ctx.stopGateDb;
    if (!db) {
      res.status(503).json({ error: 'stop-gate DB not initialized' });
      return;
    }
    const body = (req.body ?? {}) as Partial<{
      eventId: string;
      operator: string;
      verdict: string;
      rationale: string;
      dwellMs: number;
    }>;
    if (!body.eventId || !body.operator || !body.verdict) {
      res.status(400).json({ error: 'eventId, operator, verdict required' });
      return;
    }
    if (!['correct', 'incorrect', 'unclear'].includes(body.verdict)) {
      res.status(400).json({ error: 'verdict must be correct|incorrect|unclear' });
      return;
    }
    const dwellMs = typeof body.dwellMs === 'number' ? body.dwellMs : 0;
    // Per spec PR5: ≥15s dwell time on each annotation. We don't reject
    // low-dwell writes at this layer — the CLI review tool enforces
    // per-submit; this endpoint just records what it gets.
    db.addAnnotation({
      eventId: body.eventId,
      operator: body.operator,
      verdict: body.verdict as 'correct' | 'incorrect' | 'unclear',
      rationale: body.rationale ?? '',
      dwellMs,
      createdAt: Date.now(),
    });
    res.json({ ok: true });
  });

  router.get('/internal/stop-gate/annotations/:eventId', (req, res) => {
    const db = ctx.stopGateDb;
    if (!db) {
      res.json({ annotations: [] });
      return;
    }
    const annotations = db.annotationsFor(req.params.eventId);
    res.json({ annotations });
  });

  router.post('/hooks/events', (req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    // Stop-gate: capture SessionStart timestamp (PR0a). Idempotent —
    // first SessionStart for a session id wins. Read before storing the
    // event so a malformed payload doesn't break the gate.
    if (req.body?.event === 'SessionStart') {
      const sid = (req.body?.sessionId || req.body?.session_id || '').toString();
      if (sid) {
        const startedAt = Date.now();
        recordSessionStart(sid, startedAt);
        try {
          ctx.stopGateDb?.recordSessionStart(
            sid,
            ctx.config.projectName ?? 'unknown',
            startedAt,
          );
        } catch {
          // Best-effort hot-path enrichment; evaluation still fail-opens.
        }
      }
    }

    const payload = req.body;
    if (!payload || !payload.event) {
      res.status(400).json({ error: 'Missing event field in payload' });
      return;
    }

    const stored = ctx.hookEventReceiver.receive(payload);
    if (!stored) {
      res.status(500).json({ error: 'Failed to store event' });
      return;
    }

    // Track tool calls for reflection metrics
    if (payload.event === 'PostToolUse') {
      reflectionMetrics.recordToolCall();

      // Track commits for homeostasis (work-velocity awareness).
      // Detect git commit in Bash tool output — Structure > Willpower.
      const toolName = payload.tool_name || payload.toolName || '';
      const toolInput = payload.tool_input || payload.toolInput || '';
      if (toolName === 'Bash' && typeof toolInput === 'string' && /git\s+commit\b/.test(toolInput)) {
        homeostasisMonitor.recordCommit();
      }
    }

    // Bridge instar session ID ↔ Claude Code session ID.
    // Hook URLs include ?instar_sid=<INSTAR_SESSION_ID> set via tmux env var.
    // On the first hook event from a session, this populates claudeSessionId on
    // the instar Session record, enabling SubagentTracker lookups.
    const instarSid = typeof req.query.instar_sid === 'string' ? req.query.instar_sid : '';
    if (instarSid && payload.session_id && ctx.sessionManager) {
      const session = ctx.sessionManager.getSessionById(instarSid);
      if (session && !session.claudeSessionId) {
        ctx.sessionManager.setClaudeSessionId(instarSid, payload.session_id);
      }
    }

    // Dispatch to specialized trackers
    if (ctx.subagentTracker && payload.session_id) {
      if (payload.event === 'SubagentStart' && payload.agent_id && payload.agent_type) {
        ctx.subagentTracker.onStart(payload.agent_id, payload.agent_type, payload.session_id);
      } else if (payload.event === 'SubagentStop' && payload.agent_id) {
        ctx.subagentTracker.onStop(
          payload.agent_id,
          payload.session_id,
          payload.last_assistant_message,
          payload.agent_transcript_path,
        );
      }
    }

    res.json({ ok: true, event: payload.event });
  });

  router.get('/hooks/events/:sessionId', (req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const events = ctx.hookEventReceiver.getSessionEvents(sessionId);
    res.json({ sessionId, events, count: events.length });
  });

  router.get('/hooks/events/:sessionId/summary', (req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const summary = ctx.hookEventReceiver.getSessionSummary(sessionId);
    if (!summary) {
      res.status(404).json({ error: 'No events found for session' });
      return;
    }
    res.json(summary);
  });

  router.get('/hooks/sessions', (_req, res) => {
    if (!ctx.hookEventReceiver) {
      res.status(503).json({ error: 'HookEventReceiver not initialized' });
      return;
    }

    const sessions = ctx.hookEventReceiver.listSessions();
    const index = ctx.hookEventReceiver.getIndex();
    const sessionList = sessions.map(id => ({
      sessionId: id,
      eventCount: index.get(id) ?? 0,
    }));
    res.json({ sessions: sessionList });
  });

  // ── Subagent Tracking ─────────────────────────────────────────

  router.get('/hooks/subagents/:sessionId', (req, res) => {
    if (!ctx.subagentTracker) {
      res.status(503).json({ error: 'SubagentTracker not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const records = ctx.subagentTracker.getSessionRecords(sessionId);
    const summary = ctx.subagentTracker.getSessionSummary(sessionId);
    res.json({ sessionId, records, summary });
  });

  // ── Reflection Metrics (Usage-Based Trigger) ─────────────────

  router.get('/reflection/metrics', (_req, res) => {
    const check = reflectionMetrics.check();
    res.json(check);
  });

  router.post('/reflection/record', (req, res) => {
    const { type } = req.body;
    if (!type || typeof type !== 'string') {
      res.status(400).json({ error: 'Missing "type" field (e.g., "quick", "deep", "grounding")' });
      return;
    }
    reflectionMetrics.recordReflection(type);
    res.json({ ok: true, message: `Reflection recorded (type: ${type}). Counters reset.` });
  });

  router.post('/reflection/session-start', (_req, res) => {
    reflectionMetrics.recordSessionStart();
    res.json({ ok: true });
  });

  router.put('/reflection/thresholds', (req, res) => {
    const { toolCalls, sessions, minutes } = req.body;
    reflectionMetrics.updateThresholds({
      toolCalls: typeof toolCalls === 'number' ? toolCalls : undefined,
      sessions: typeof sessions === 'number' ? sessions : undefined,
      minutes: typeof minutes === 'number' ? minutes : undefined,
    });
    res.json({ ok: true, thresholds: reflectionMetrics.getData().thresholds });
  });

  // ── Homeostasis Monitor (Work-Velocity Awareness) ─────────────
  //
  // Tracks commits and elapsed time since last pause. Suggests brief
  // awareness checks when the agent has been grinding without reflection.
  // Ported from Dawn's homeostasis-check.sh — the heartbeat that prevents
  // tunnel vision during extended autonomous sessions.

  router.get('/homeostasis/check', (_req, res) => {
    const check = homeostasisMonitor.check();
    res.json(check);
  });

  router.post('/homeostasis/commit', (_req, res) => {
    homeostasisMonitor.recordCommit();
    const check = homeostasisMonitor.check();
    res.json({ ok: true, ...check });
  });

  router.post('/homeostasis/pause', (req, res) => {
    const { context } = req.body || {};
    homeostasisMonitor.recordPause(context);
    res.json({ ok: true, message: 'Pause recorded. Counters reset.' });
  });

  router.post('/homeostasis/reset', (_req, res) => {
    homeostasisMonitor.resetSession();
    res.json({ ok: true, message: 'Homeostasis reset for new session.' });
  });

  router.put('/homeostasis/thresholds', (req, res) => {
    const { commits, minutes } = req.body;
    homeostasisMonitor.updateThresholds({
      commits: typeof commits === 'number' ? commits : undefined,
      minutes: typeof minutes === 'number' ? minutes : undefined,
    });
    res.json({ ok: true, thresholds: homeostasisMonitor.getData().thresholds });
  });

  // ── Worktree Monitoring ───────────────────────────────────────

  router.get('/hooks/worktrees', (_req, res) => {
    if (!ctx.worktreeMonitor) {
      res.status(503).json({ error: 'WorktreeMonitor not initialized' });
      return;
    }

    const report = ctx.worktreeMonitor.scanWorktrees();
    res.json(report);
  });

  router.get('/hooks/worktrees/last-report', (_req, res) => {
    if (!ctx.worktreeMonitor) {
      res.status(503).json({ error: 'WorktreeMonitor not initialized' });
      return;
    }

    const report = ctx.worktreeMonitor.getLastReport();
    if (!report) {
      res.status(404).json({ error: 'No worktree scan has been performed yet' });
      return;
    }
    res.json(report);
  });

  // ── Instructions Verification ─────────────────────────────────

  router.get('/hooks/instructions/:sessionId', (req, res) => {
    if (!ctx.instructionsVerifier) {
      res.status(503).json({ error: 'InstructionsVerifier not initialized' });
      return;
    }

    const { sessionId } = req.params;
    const result = ctx.instructionsVerifier.verify(sessionId);
    res.json(result);
  });

  // ── Agents ─────────────────────────────────────────────────────

  router.get('/agents', async (_req, res) => {
    try {
      const { listAgents } = await import('../core/AgentRegistry.js');
      const agents = listAgents();
      res.json({ agents });
    } catch {
      res.status(500).json({ error: 'Failed to load agent registry' });
    }
  });

  /**
   * Cross-agent restart — restart another agent on this machine.
   *
   * Uses the agent registry to find the agent's path, then starts the server
   * via the shadow install CLI. This lets any agent recover any other agent
   * on the same machine, solving the dead man's switch problem where an agent
   * can't restart itself and the user has no other way in.
   */
  router.post('/agents/:name/restart', async (req, res) => {
    const { name } = req.params;
    try {
      const { listAgents } = await import('../core/AgentRegistry.js');
      const agents = listAgents();
      const agent = agents.find((a: { name: string }) =>
        a.name === name || a.name === `${name}-lifeline`
      );

      if (!agent) {
        res.status(404).json({ error: `Agent "${name}" not found in registry` });
        return;
      }

      // Don't restart self — that's a different code path
      if (agent.name === ctx.config.projectName) {
        res.status(400).json({ error: 'Cannot restart self via cross-agent restart. Use /lifeline restart.' });
        return;
      }

      const agentPath = agent.path.replace(/-lifeline$/, ''); // Normalize to main agent path
      const shadowCli = `${agentPath}/.instar/shadow-install/node_modules/instar/dist/cli.js`;
      const { existsSync } = await import('node:fs');
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      if (!existsSync(shadowCli)) {
        res.status(500).json({ error: `Shadow install not found for "${name}" at ${shadowCli}` });
        return;
      }

      // Start the server via the shadow install CLI
      // This will handle tmux session creation, port binding, etc.
      try {
        await execFileAsync('node', [shadowCli, 'server', 'start', '--dir', agentPath], {
          cwd: agentPath,
          timeout: 30_000,
        });
        res.json({ success: true, message: `Agent "${name}" restart initiated`, agentPath });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // "Server started in tmux" in stdout is actually success — execFile may still "fail"
        // because the CLI exits after spawning tmux
        if (errMsg.includes('Server started') || errMsg.includes('already running')) {
          res.json({ success: true, message: `Agent "${name}" restart initiated`, agentPath });
        } else {
          res.status(500).json({ error: `Failed to restart "${name}": ${errMsg}` });
        }
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Cross-agent restart failed' });
    }
  });

  // ── Backups ────────────────────────────────────────────────────

  router.get('/backups', async (_req, res) => {
    try {
      const { BackupManager } = await import('../core/BackupManager.js');
      const manager = new BackupManager(ctx.config.stateDir, ctx.config.backup);
      res.json({ snapshots: manager.listSnapshots() });
    } catch {
      res.status(500).json({ error: 'Failed to list backups' });
    }
  });

  router.post('/backups', async (_req, res) => {
    try {
      const { BackupManager } = await import('../core/BackupManager.js');
      const manager = new BackupManager(ctx.config.stateDir, ctx.config.backup);
      const snapshot = manager.createSnapshot('manual');
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
    }
  });

  router.post('/backups/:id/restore', async (req, res) => {
    const { id } = req.params;
    const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z(-\d+)?$/;

    if (!SNAPSHOT_ID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid snapshot ID format' });
      return;
    }

    // Path containment check (P0-2)
    const backupsDir = path.resolve(ctx.config.stateDir, 'backups');
    const resolvedPath = path.resolve(backupsDir, id);
    if (!resolvedPath.startsWith(backupsDir + path.sep)) {
      res.status(400).json({ error: 'Invalid snapshot ID' });
      return;
    }

    // Session guard (defense-in-depth — also enforced in BackupManager)
    const sessions = ctx.sessionManager.listRunningSessions();
    if (sessions.length > 0) {
      res.status(409).json({
        error: 'Cannot restore while sessions are active',
        activeSessions: sessions.length,
      });
      return;
    }

    try {
      const { BackupManager } = await import('../core/BackupManager.js');
      const manager = new BackupManager(
        ctx.config.stateDir,
        ctx.config.backup,
        () => ctx.sessionManager.listRunningSessions().length > 0,
      );
      manager.restoreSnapshot(id);
      res.json({ restored: id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  // ── Git State ─────────────────────────────────────────────────

  router.get('/git/status', async (_req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      res.json(manager.status());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get git status' });
    }
  });

  router.post('/git/commit', async (req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      const message = req.body?.message || '[instar] manual commit via API';
      const files = req.body?.files;
      manager.commit(message, files);
      res.json({ committed: true, message });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Commit failed' });
    }
  });

  router.post('/git/push', async (req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      const config = manager.getConfig();

      // First-push confirmation gate
      if (config.lastPushedRemote !== config.remote && !req.body?.force) {
        res.status(428).json({
          warning: `First push to ${config.remote}. This will send all committed agent state to the remote.`,
          requiresConfirmation: true,
        });
        return;
      }

      const result = manager.push();
      res.json({ pushed: true, firstPush: result.firstPush });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Push failed' });
    }
  });

  router.post('/git/pull', async (_req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      manager.pull();
      res.json({ pulled: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Pull failed' });
    }
  });

  router.get('/git/log', async (req, res) => {
    try {
      const { GitStateManager } = await import('../core/GitStateManager.js');
      const gitConfig = (ctx.config as any).git || {};
      const manager = new GitStateManager(ctx.config.stateDir, gitConfig);
      const limit = parseInt(req.query.limit as string, 10) || 20;
      res.json({ entries: manager.log(limit) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get git log' });
    }
  });

  // ── Memory Search (DEPRECATED — use /semantic/* routes instead) ─

  router.get('/memory/search', async (req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
    res.setHeader('Link', '</semantic/search>; rel="successor-version"');
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        index.sync();
        const query = String(req.query.q || '');
        const limit = parseInt(req.query.limit as string, 10) || 10;
        const source = req.query.source as string | undefined;
        const startMs = Date.now();
        const results = index.search(query, { limit, source });
        res.json({
          query,
          results,
          totalResults: results.length,
          searchTimeMs: Date.now() - startMs,
        });
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  router.get('/memory/stats', async (_req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
    res.setHeader('Link', '</semantic/stats>; rel="successor-version"');
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        res.json(index.stats());
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get stats' });
    }
  });

  router.post('/memory/reindex', async (_req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        const result = index.reindex();
        res.json({ reindexed: true, ...result });
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Reindex failed' });
    }
  });

  router.post('/memory/sync', async (_req, res) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', '2026-06-01');
    try {
      const { MemoryIndex } = await import('../memory/MemoryIndex.js');
      const memoryConfig = (ctx.config as any).memory || {};
      const index = new MemoryIndex(ctx.config.stateDir, { ...memoryConfig, enabled: true });
      await index.open();
      try {
        const result = index.sync();
        res.json({ synced: true, ...result });
      } finally {
        index.close();
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Sync failed' });
    }
  });



  // ── Semantic Memory ─────────────────────────────────────────────

  const VALID_ENTITY_TYPES = new Set(['fact', 'person', 'project', 'tool', 'pattern', 'decision', 'lesson']);
  const VALID_RELATION_TYPES = new Set([
    'related_to', 'built_by', 'learned_from', 'depends_on', 'supersedes',
    'contradicts', 'part_of', 'used_in', 'knows_about', 'caused', 'verified_by',
  ]);

  router.post('/semantic/remember', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    const { type, name, content, confidence, source, sourceSession, tags, domain, expiresAt } = req.body;
    if (!type || !name || !content || confidence === undefined || !source) {
      res.status(400).json({ error: 'Missing required fields: type, name, content, confidence, source' }); return;
    }
    if (!VALID_ENTITY_TYPES.has(type)) {
      res.status(400).json({ error: `Invalid entity type: ${type}` }); return;
    }
    try {
      const id = ctx.semanticMemory.remember({
        type, name, content, confidence,
        lastVerified: new Date().toISOString(),
        source, sourceSession, tags: tags || [], domain, expiresAt,
      });
      res.json({ id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to remember' });
    }
  });

  router.get('/semantic/recall/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const result = ctx.semanticMemory.recall(req.params.id);
      if (!result) { res.status(404).json({ error: 'Entity not found' }); return; }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to recall' });
    }
  });

  router.delete('/semantic/forget/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      ctx.semanticMemory.forget(req.params.id, req.body?.reason);
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to forget' });
    }
  });

  router.post('/semantic/connect', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    const { fromId, toId, relation, context, weight } = req.body;
    if (!fromId || !toId || !relation) {
      res.status(400).json({ error: 'Missing required fields: fromId, toId, relation' }); return;
    }
    if (!VALID_RELATION_TYPES.has(relation)) {
      res.status(400).json({ error: `Invalid relation type: ${relation}` }); return;
    }
    try {
      const edgeId = ctx.semanticMemory.connect(fromId, toId, relation, context, weight);
      res.json({ edgeId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to connect' });
    }
  });

  router.get('/semantic/search', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const query = String(req.query.q || '');
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const types = req.query.types ? String(req.query.types).split(',').filter(t => VALID_ENTITY_TYPES.has(t)) : undefined;
      const domain = req.query.domain as string | undefined;
      const minConfidence = req.query.minConfidence ? parseFloat(req.query.minConfidence as string) : undefined;

      const results = ctx.semanticMemory.search(query, { types: types as any, domain, minConfidence, limit });
      res.json({ query, results, totalResults: results.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  // Hybrid search — uses FTS5 + vector KNN when embeddings are available
  router.get('/semantic/search/hybrid', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const query = String(req.query.q || '');
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const types = req.query.types ? String(req.query.types).split(',').filter(t => VALID_ENTITY_TYPES.has(t)) : undefined;
      const domain = req.query.domain as string | undefined;
      const minConfidence = req.query.minConfidence ? parseFloat(req.query.minConfidence as string) : undefined;

      const results = await ctx.semanticMemory.searchHybrid(query, { types: types as any, domain, minConfidence, limit });
      res.json({ query, results, totalResults: results.length, vectorSearchActive: ctx.semanticMemory.vectorSearchAvailable });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Hybrid search failed' });
    }
  });

  // Batch embed all entities that are missing embeddings
  router.post('/semantic/embeddings/migrate', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const count = await ctx.semanticMemory.embedAllEntities();
      res.json({ embedded: count, vectorSearchAvailable: ctx.semanticMemory.vectorSearchAvailable });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Embedding migration failed' });
    }
  });

  router.get('/semantic/explore/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const maxDepth = parseInt(req.query.maxDepth as string, 10) || 2;
      const relations = req.query.relations ? String(req.query.relations).split(',') : undefined;
      const results = ctx.semanticMemory.explore(req.params.id, { maxDepth, relations: relations as any });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Explore failed' });
    }
  });

  router.post('/semantic/verify/:id', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      ctx.semanticMemory.verify(req.params.id, req.body?.confidence);
      res.json({ verified: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Verify failed' });
    }
  });

  router.post('/semantic/supersede', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    const { oldId, newId, reason } = req.body;
    if (!oldId || !newId) {
      res.status(400).json({ error: 'Missing required fields: oldId, newId' }); return;
    }
    try {
      ctx.semanticMemory.supersede(oldId, newId, reason);
      res.json({ superseded: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Supersede failed' });
    }
  });

  router.post('/semantic/decay', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const report = ctx.semanticMemory.decayAll();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Decay failed' });
    }
  });

  router.get('/semantic/stale', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const maxConfidence = req.query.maxConfidence ? parseFloat(req.query.maxConfidence as string) : undefined;
      const olderThan = req.query.olderThan as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const results = ctx.semanticMemory.findStale({ maxConfidence, olderThan, limit });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Stale query failed' });
    }
  });

  router.get('/semantic/export', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      res.json(ctx.semanticMemory.export());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed' });
    }
  });

  router.post('/semantic/import', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const report = ctx.semanticMemory.import(req.body);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Import failed' });
    }
  });

  router.get('/semantic/stats', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      res.json(ctx.semanticMemory.stats());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Stats failed' });
    }
  });

  router.get('/semantic/context', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const query = String(req.query.q || '');
      const maxTokens = parseInt(req.query.maxTokens as string, 10) || 2000;
      const context = ctx.semanticMemory.getRelevantContext(query, { maxTokens });
      res.json({ context });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Context generation failed' });
    }
  });

  // ── WikiClaim Phase 4 — Inverse-traceability HTTP endpoints ───────
  //
  // Per docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md § Phase 4
  // (line 343) and § Inverse traceability (line 291).
  //
  // Both routes are thin pass-throughs to SemanticMemory's already-filtered
  // typed methods (`getEvidence` / `findCitations`). Privacy enforcement
  // lives ONE place — the storage layer's read-time filter (Phase 1) plus
  // the EvidenceRenderer helper (Phase 5). These routes do not re-implement
  // the filter; they invoke the methods and serialize the result.
  //
  // viewerScope derivation: the single bearer-token auth model has one
  // principal (the agent itself), which sees its own data at `private`
  // scope by default. Callers can request a NARROWED view via the
  // `?viewerScope=shared-project|shared-topic|private` query param —
  // useful for "what would a topic-peer see?" preview rendering in the
  // dashboard. Widening above the auth principal is a no-op (the cap is
  // `private`). Per spec § Storage and Privacy line 315 — the renderer is
  // the privacy boundary; this route is a read endpoint with no
  // judgment surface.
  const VALID_EVIDENCE_KINDS = new Set([
    'feedback', 'commit', 'session', 'document', 'message',
    'job-run', 'ledger-entry', 'pattern-entity', 'external-url',
    'supersedes-evidence',
  ]);
  const VALID_VIEWER_SCOPES = new Set(['shared-project', 'shared-topic', 'private']);

  function resolveViewerScope(raw: unknown): 'shared-project' | 'shared-topic' | 'private' {
    if (typeof raw === 'string' && VALID_VIEWER_SCOPES.has(raw)) {
      return raw as 'shared-project' | 'shared-topic' | 'private';
    }
    // Default: agent has full visibility into its own DB.
    return 'private';
  }

  // GET /memory/evidence/by-entity/:id
  // Returns the entity's evidence array, viewer-scope filtered.
  router.get('/memory/evidence/by-entity/:id', (req, res) => {
    if (!ctx.semanticMemory) {
      res.status(503).json({ error: 'Semantic memory not enabled' });
      return;
    }
    try {
      const entityId = req.params.id;
      if (!entityId || typeof entityId !== 'string') {
        res.status(400).json({ error: 'Missing entity id' });
        return;
      }
      const viewerScope = resolveViewerScope(req.query.viewerScope);

      // Existence + entity-level visibility check goes through the eager
      // helper, which returns null when the entity is hidden (or missing)
      // at the requested viewer scope. We deliberately collapse "entity
      // exists but entity-scope wider than viewer" and "entity does not
      // exist" into the same 404 — the spec's inverse-query non-leak rule
      // (§ Storage and Privacy line 316) extends to direct fetch: a viewer
      // at a narrower scope must not be able to probe entity existence by
      // diffing 404 vs 200-empty.
      const eager = ctx.semanticMemory.getEntityWithEvidence(entityId, viewerScope);
      if (!eager) {
        res.status(404).json({ error: 'Entity not found' });
        return;
      }
      res.json({
        entityId,
        viewerScope,
        evidence: eager.evidence,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Evidence lookup failed',
      });
    }
  });

  // GET /memory/entities/by-evidence?kind=feedback&sourceId=fb_123
  // Returns entities citing (kind, sourceId), viewer-scope filtered.
  router.get('/memory/entities/by-evidence', (req, res) => {
    if (!ctx.semanticMemory) {
      res.status(503).json({ error: 'Semantic memory not enabled' });
      return;
    }
    try {
      const kindRaw = req.query.kind;
      const sourceIdRaw = req.query.sourceId;
      const kind = typeof kindRaw === 'string' ? kindRaw : '';
      const sourceId = typeof sourceIdRaw === 'string' ? sourceIdRaw : '';
      if (!kind || !sourceId) {
        res.status(400).json({ error: 'Missing required query params: kind, sourceId' });
        return;
      }
      if (!VALID_EVIDENCE_KINDS.has(kind)) {
        res.status(400).json({ error: `Invalid evidence kind: ${kind}` });
        return;
      }
      const viewerScope = resolveViewerScope(req.query.viewerScope);

      const entities = ctx.semanticMemory.findCitations(
        { kind: kind as any, sourceId },
        viewerScope,
      );
      res.json({
        kind,
        sourceId,
        viewerScope,
        entities,
        totalResults: entities.length,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Citation lookup failed',
      });
    }
  });

  // ── MEMORY.md Export (Phase 6) ─────────────────────────────────

  router.post('/semantic/export-memory', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryExporter } = await import('../memory/MemoryExporter.js');
      const exporter = new MemoryExporter({
        semanticMemory: ctx.semanticMemory,
        minConfidence: req.body?.minConfidence,
        maxEntities: req.body?.maxEntities,
        agentName: req.body?.agentName,
        includeFooter: req.body?.includeFooter,
      });

      // If filePath provided, write to disk; otherwise return markdown
      const filePath = req.body?.filePath;
      if (filePath) {
        const result = exporter.write(filePath);
        if (result.entityCount === 0) {
          res.json({ ...result, skipped: true, reason: 'SemanticMemory has 0 entities — existing file preserved' });
          return;
        }
        // Also write a JSON snapshot alongside the MEMORY.md export
        try { ctx.semanticMemory.writeSnapshot(); } catch { /* non-critical */ }
        res.json(result);
      } else {
        const result = exporter.generate();
        res.json(result);
      }
    } catch (err) {
      // Fallback: if DB is broken but a MEMORY.md file exists, serve the last-known-good version
      const filePath = req.body?.filePath;
      if (filePath) {
        try {
          const fs = await import('node:fs');
          if (fs.existsSync(filePath)) {
            const lastGood = fs.readFileSync(filePath, 'utf-8');
            res.json({
              markdown: lastGood,
              entityCount: 0,
              excludedCount: 0,
              domainCount: 0,
              estimatedTokens: Math.ceil(lastGood.length / 4),
              fallback: true,
              fallbackReason: err instanceof Error ? err.message : 'Export failed',
            });
            return;
          }
        } catch { /* fallback also failed */ }
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'Export failed' });
    }
  });

  // ── Semantic Memory Rebuild (Disaster Recovery) ──────────────────

  router.post('/semantic/rebuild', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const jsonlPath = req.body?.jsonlPath;
      const full = req.body?.full !== false; // Default to full rebuild
      const result = full
        ? ctx.semanticMemory.rebuild(jsonlPath)
        : ctx.semanticMemory.importFromJsonl(jsonlPath);
      res.json({ ...result, mode: full ? 'full-rebuild' : 'incremental-import' });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Rebuild failed' });
    }
  });

  router.post('/semantic/snapshot', (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const result = ctx.semanticMemory.writeSnapshot(req.body?.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Snapshot failed' });
    }
  });

  // ── Semantic Memory Migration ────────────────────────────────────

  router.post('/semantic/migrate', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const memoryMdPath = req.body?.memoryMdPath;
      const report = await migrator.migrateAll({ memoryMdPath });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/memory-md', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const filePath = req.body?.filePath;
      if (!filePath) { res.status(400).json({ error: 'filePath required' }); return; }
      const report = await migrator.migrateMemoryMd(filePath);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/relationships', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const report = await migrator.migrateRelationships();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/canonical-state', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const report = await migrator.migrateCanonicalState();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  router.post('/semantic/migrate/decisions', async (req, res) => {
    if (!ctx.semanticMemory) { res.status(503).json({ error: 'Semantic memory not enabled' }); return; }
    try {
      const { MemoryMigrator } = await import('../memory/MemoryMigrator.js');
      const migrator = new MemoryMigrator({
        stateDir: ctx.config.stateDir,
        semanticMemory: ctx.semanticMemory,
      });

      const report = await migrator.migrateDecisionJournal();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed' });
    }
  });

  // ── Status ──────────────────────────────────────────────────────

  router.get('/status', (_req, res) => {
    const sessions = ctx.sessionManager.listRunningSessions();
    const schedulerStatus = ctx.scheduler?.getStatus() ?? null;

    res.json({
      sessions: {
        running: sessions.length,
        max: ctx.config.sessions.maxSessions,
        list: sessions.map(s => ({ id: s.id, name: s.name, jobSlug: s.jobSlug })),
      },
      scheduler: schedulerStatus,
    });
  });

  // ── Capabilities (Self-Discovery) ──────────────────────────────
  //
  // Returns a structured self-portrait of what this agent has available.
  // Agents should query this at session start rather than guessing
  // about what infrastructure exists.

  // ── Multi-session autonomy: list / start-gate / stop ──────────────────
  // Per-topic autonomous jobs live at .instar/autonomous/<topicId>.local.md.
  // These routes are the management surface; the stop hook is the per-session enforcer.
  router.get('/autonomous/sessions', (_req, res) => {
    res.json({ sessions: listAutonomousJobs(ctx.config.stateDir) });
  });

  router.get('/autonomous/can-start', (req, res) => {
    const priority = req.query.priority as JobPriority | undefined;
    const maxConcurrent =
      ctx.config.autonomousSessions?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_AUTONOMOUS;
    const result = canStartAutonomousJob({
      stateDir: ctx.config.stateDir,
      maxConcurrent,
      priority,
      quotaCanStart: ctx.quotaTracker
        ? (p) => ctx.quotaTracker!.shouldSpawnSession(p)
        : undefined,
    });
    res.json(result);
  });

  router.post('/autonomous/stop-all', (_req, res) => {
    const result = stopAllAutonomousJobs(ctx.config.stateDir);
    res.json({ ok: true, ...result });
  });

  router.post('/autonomous/sessions/:topic/stop', (req, res) => {
    const topic = req.params.topic;
    const stopped = stopAutonomousTopic(ctx.config.stateDir, topic);
    res.status(stopped ? 200 : 404).json({ ok: stopped, topic });
  });

  // Independent completion judge for the autonomous stop-hook (mirrors /goal):
  // given a verifiable condition + the recent transcript, decide met/not-met.
  // The hook treats 503/unreachable as "keep working" (fail-safe — never a false done).
  router.post('/autonomous/evaluate-completion', async (req, res) => {
    if (!ctx.completionEvaluator) {
      res.status(503).json({ error: 'No completion evaluator (IntelligenceProvider not configured)' });
      return;
    }
    const { condition, transcriptTail } = req.body ?? {};
    if (!condition || typeof condition !== 'string') {
      res.status(400).json({ error: '"condition" (string) required' });
      return;
    }
    try {
      const verdict = await ctx.completionEvaluator.evaluate(
        condition,
        typeof transcriptTail === 'string' ? transcriptTail : '',
      );
      res.json(verdict);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // P13 "The Stop Reason Is the Work" guard for the autonomous stop-hook: given the
  // recent transcript, decide whether a stop-attempt is EARNED or rests on a
  // judgment-call / needs-real-engineering deferral. Fail-open: the hook treats
  // 503/unreachable/error and stopAllowed:true as permit — a SECONDARY guard must
  // never trap a genuine completion (the completion check is the primary authority).
  router.post('/autonomous/evaluate-stop', async (req, res) => {
    if (!ctx.completionEvaluator) {
      res.status(503).json({ error: 'No completion evaluator (IntelligenceProvider not configured)' });
      return;
    }
    const { transcriptTail } = req.body ?? {};
    try {
      const verdict = await ctx.completionEvaluator.evaluateStopRationale(
        typeof transcriptTail === 'string' ? transcriptTail : '',
      );
      res.json(verdict);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Native /goal delegation (Phase 2): drive the framework's own /goal loop by
  // INJECTING the slash command into the session (instar's core mechanism —
  // SessionManager.sendInput / tmux send-keys), and mark the job goal_mode:native so
  // the stop-hook defers completion to native /goal (still enforcing emergency/duration).
  const resolveTopicSession = (topic: string): string | null => {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(ctx.config.stateDir, 'topic-session-registry.json'), 'utf8'));
      return (reg.topicToSession || {})[topic] ?? null;
    } catch { return null; }
  };
  const setGoalMode = (topic: string, mode: 'native' | '') => {
    const f = path.join(ctx.config.stateDir, 'autonomous', `${topic}.local.md`);
    if (!fs.existsSync(f)) return;
    let c = fs.readFileSync(f, 'utf8');
    c = /^goal_mode:/m.test(c) ? c.replace(/^goal_mode:.*$/m, `goal_mode: "${mode}"`)
                              : c.replace(/^(active:.*)$/m, `$1\ngoal_mode: "${mode}"`);
    fs.writeFileSync(f, c);
  };

  router.post('/autonomous/native-goal/set', (req, res) => {
    const { topicId, condition } = req.body ?? {};
    if (!topicId || !condition || typeof condition !== 'string') {
      res.status(400).json({ error: '"topicId" and "condition" (string) required' });
      return;
    }
    const tmux = resolveTopicSession(String(topicId));
    if (!tmux) { res.status(404).json({ error: `no session for topic ${topicId}` }); return; }
    const ok = ctx.sessionManager.sendInput(tmux, `/goal ${condition}`);
    if (ok) setGoalMode(String(topicId), 'native');
    res.status(ok ? 200 : 502).json({ ok, topicId, mode: ok ? 'native' : 'unchanged' });
  });

  router.post('/autonomous/native-goal/clear', (req, res) => {
    const { topicId } = req.body ?? {};
    if (!topicId) { res.status(400).json({ error: '"topicId" required' }); return; }
    const tmux = resolveTopicSession(String(topicId));
    if (!tmux) { res.status(404).json({ error: `no session for topic ${topicId}` }); return; }
    const ok = ctx.sessionManager.sendInput(tmux, '/goal clear');
    if (ok) setGoalMode(String(topicId), '');
    res.status(ok ? 200 : 502).json({ ok, topicId });
  });

  router.get('/capabilities', (_req, res) => {
    // /capabilities used to be a 440-line hand-curated object literal — the
    // documented self-discovery primitive, but the only structural enforcement
    // of "what should be in here" lived as policy in a unit-test allowlist.
    // PR #N moved both surfaces (the response builders AND the lint policy)
    // into src/server/CapabilityIndex.ts. Adding a new top-level route prefix
    // now fails CI until the author either claims it in CAPABILITY_INDEX or
    // adds it to INTERNAL_PREFIXES — the discoverability gap closes
    // structurally instead of relying on author memory.
    const projectDir = ctx.config.projectDir;
    const stateDir = ctx.config.stateDir;

    // Identity files
    const identityFiles: Record<string, boolean> = {
      'AGENT.md': fs.existsSync(path.join(stateDir, 'AGENT.md')),
      'USER.md': fs.existsSync(path.join(stateDir, 'USER.md')),
      'MEMORY.md': fs.existsSync(path.join(stateDir, 'MEMORY.md')),
    };

    // Scripts
    const scriptsDir = path.join(projectDir, '.claude', 'scripts');
    let scripts: string[] = [];
    if (fs.existsSync(scriptsDir)) {
      try {
        scripts = fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.'));
      } catch { /* permission error, etc. */ }
    }

    // Hooks
    const hooksDir = path.join(stateDir, 'hooks');
    let hooks: string[] = [];
    if (fs.existsSync(hooksDir)) {
      try {
        hooks = fs.readdirSync(hooksDir).filter(f => !f.startsWith('.'));
      } catch { /* permission error, etc. */ }
    }

    const setupIntegrity = ProcessIntegrity.getInstance();
    const capabilityBlocks = buildAllCapabilityBlocks({ ctx, scripts, secretDrop });
    res.json({
      project: ctx.config.projectName,
      version: setupIntegrity?.runningVersion || ctx.config.version || '0.0.0',
      port: ctx.config.port,
      identity: identityFiles,
      scripts,
      hooks,
      ...capabilityBlocks,
    });
  });


  // ── Capability Map ──────────────────────────────────────────────────
  //
  // Hierarchical self-knowledge map with provenance tracking and drift detection.
  // Agents use this to understand their own features, skills, and integrations.

  router.get('/capability-map', async (req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const map = await ctx.capabilityMapper.getMap();
      const format = req.query.format;

      if (format === 'md' || format === 'markdown') {
        res.type('text/markdown').send(ctx.capabilityMapper.renderMarkdown(map, 2));
      } else if (format === 'compact') {
        res.type('text/markdown').send(ctx.capabilityMapper.renderMarkdown(map, 1));
      } else {
        res.json(map);
      }
    } catch (err) {
      res.status(500).json({
        error: 'SCAN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/capability-map/drift', async (_req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const drift = await ctx.capabilityMapper.detectDrift();
      res.json(drift);
    } catch (err) {
      res.status(500).json({
        error: 'DRIFT_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/capability-map/:domain', async (req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const map = await ctx.capabilityMapper.getMap();
      const domain = map.domains.find(d => d.id === req.params.domain);

      if (!domain) {
        res.status(404).json({
          error: 'DOMAIN_NOT_FOUND',
          message: `Domain '${req.params.domain}' not found`,
          suggestion: `Available domains: ${map.domains.map(d => d.id).join(', ')}`,
        });
        return;
      }

      res.json(domain);
    } catch (err) {
      res.status(500).json({
        error: 'SCAN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/capability-map/refresh', async (_req, res) => {
    if (!ctx.capabilityMapper) {
      res.status(501).json({ error: 'CapabilityMapper not initialized' });
      return;
    }

    try {
      const map = await ctx.capabilityMapper.refresh();
      res.status(202).json({
        status: 'completed',
        summary: map.summary,
        generatedAt: map.generatedAt,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'REFRESH_IN_PROGRESS') {
        res.status(409).json({
          error: 'REFRESH_IN_PROGRESS',
          message: 'A scan is already running',
          retryAfter: 10,
        });
        return;
      }
      res.status(500).json({
        error: 'REFRESH_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Self-Knowledge Tree ────────────────────────────────────────────
  //
  // Tree-based agent self-knowledge with LLM triage, tiered caching,
  // and cross-layer synthesis. Agents use this to answer "who am I?"

  router.get('/self-knowledge/search', async (req, res) => {
    if (!ctx.selfKnowledgeTree) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    const query = req.query.q as string;
    if (!query) {
      res.status(400).json({ error: 'Missing required query parameter: q' });
      return;
    }

    try {
      const dryRun = req.query.dry_run === 'true';
      const maxBudget = req.query.maxTokens ? parseInt(req.query.maxTokens as string, 10) : undefined;
      if (dryRun) {
        const plan = await ctx.selfKnowledgeTree.dryRun(query);
        res.json(plan);
      } else {
        const result = await ctx.selfKnowledgeTree.search(query, { maxBudget });
        res.json(result);
      }
    } catch (err) {
      res.status(500).json({
        error: 'SEARCH_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/self-knowledge/validate', (_req, res) => {
    if (!ctx.selfKnowledgeTree) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    try {
      const validation = ctx.selfKnowledgeTree.validate();
      const cacheStats = ctx.selfKnowledgeTree.cacheStats();
      res.json({ ...validation, cacheStats });
    } catch (err) {
      res.status(500).json({
        error: 'VALIDATION_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/self-knowledge/health', (_req, res) => {
    if (!ctx.selfKnowledgeTree || !ctx.coverageAuditor) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    try {
      const config = ctx.selfKnowledgeTree.getConfig();
      if (!config) {
        res.json({ status: 'no_tree', message: 'Tree not generated yet' });
        return;
      }

      const validation = ctx.selfKnowledgeTree.validate();
      const health = ctx.coverageAuditor.healthSummary();
      const totalNodes = config.layers.reduce((s: number, l: { children: unknown[] }) => s + l.children.length, 0);
      const detectedPlatforms = ctx.coverageAuditor.detectPlatforms();
      const audit = ctx.coverageAuditor.audit(config, validation, detectedPlatforms);

      res.json({
        status: 'ok',
        totalNodes,
        coverageScore: validation.coverageScore,
        cacheHitRate: health.cacheHitRate,
        avgLatencyMs: health.avgLatencyMs,
        errorRate: health.errorRate,
        searchCount: health.searchCount,
        degradedSearches: health.degradedSearches,
        gaps: audit.gaps,
        warnings: validation.warnings.length,
        errors: validation.errors.length,
      });
    } catch (err) {
      res.status(500).json({
        error: 'HEALTH_CHECK_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/self-knowledge/tree', (_req, res) => {
    if (!ctx.selfKnowledgeTree) {
      res.status(501).json({ error: 'SelfKnowledgeTree not initialized' });
      return;
    }

    const config = ctx.selfKnowledgeTree.getConfig();
    if (!config) {
      res.status(404).json({ error: 'Tree not generated yet' });
      return;
    }

    res.json(config);
  });

  // ── Project Map ───────────────────────────────────────────────────
  //
  // Auto-generated territory map of the project structure. Agents use this
  // for spatial awareness — "where am I and what does this project look like?"

  router.get('/project-map', (_req, res) => {
    if (!ctx.projectMapper) {
      res.status(501).json({ error: 'ProjectMapper not initialized' });
      return;
    }

    // Try to load saved map first; generate if missing
    let map = ctx.projectMapper.loadSavedMap();
    if (!map) {
      map = ctx.projectMapper.generateAndSave();
    }

    const format = _req.query.format;
    if (format === 'markdown') {
      res.type('text/markdown').send(ctx.projectMapper.toMarkdown(map));
    } else if (format === 'compact') {
      res.type('text/plain').send(ctx.projectMapper.getCompactSummary(map));
    } else {
      res.json(map);
    }
  });

  router.post('/project-map/refresh', (_req, res) => {
    if (!ctx.projectMapper) {
      res.status(501).json({ error: 'ProjectMapper not initialized' });
      return;
    }

    const map = ctx.projectMapper.generateAndSave();
    res.json({ refreshed: true, projectName: map.projectName, totalFiles: map.totalFiles, directories: map.directories.length });
  });

  // ── Coherence Gate ────────────────────────────────────────────────
  //
  // Pre-action coherence verification. Agents call this before high-risk
  // actions to verify they're in the right project for the right topic.

  router.post('/coherence/check', (req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
      return;
    }

    const { action, context } = req.body;
    if (!action || typeof action !== 'string') {
      res.status(400).json({ error: 'Missing required field: action (e.g., "deploy", "git-push")' });
      return;
    }

    const result = ctx.coherenceGate.check(action as HighRiskAction, context);
    res.json(result);
  });

  router.post('/coherence/reflect', (req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
      return;
    }

    const { action, context } = req.body;
    if (!action || typeof action !== 'string') {
      res.status(400).json({ error: 'Missing required field: action' });
      return;
    }

    const prompt = ctx.coherenceGate.generateReflectionPrompt(action as HighRiskAction, context);
    res.type('text/plain').send(prompt);
  });

  // ── Topic-Project Bindings ────────────────────────────────────────
  //
  // Manage which Telegram topics are bound to which projects.
  // Critical for multi-project agents — prevents cross-project confusion.

  router.get('/topic-bindings', (_req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
      return;
    }

    const bindings = ctx.coherenceGate.loadTopicBindings();
    res.json(bindings);
  });

  router.post('/topic-bindings', (req, res) => {
    if (!ctx.coherenceGate) {
      res.status(501).json({ error: 'ScopeVerifier not initialized' });
      return;
    }

    const { topicId, binding } = req.body;
    if (!topicId || !binding?.projectName || !binding?.projectDir) {
      res.status(400).json({ error: 'Required: topicId (number), binding.projectName, binding.projectDir' });
      return;
    }

    ctx.coherenceGate.setTopicBinding(Number(topicId), binding);
    res.json({ bound: true, topicId: Number(topicId), binding });
  });

  // ── Context Hierarchy ──────────────────────────────────────────────
  //
  // Tiered context loading for efficient agent awareness.

  router.get('/context', (_req, res) => {
    if (!ctx.contextHierarchy) {
      res.status(501).json({ error: 'ContextHierarchy not initialized' });
      return;
    }
    res.json({
      contextDir: ctx.contextHierarchy.getContextDir(),
      segments: ctx.contextHierarchy.listSegments(),
    });
  });

  router.get('/context/dispatch', (_req, res) => {
    if (!ctx.contextHierarchy) {
      res.status(501).json({ error: 'ContextHierarchy not initialized' });
      return;
    }
    res.json(ctx.contextHierarchy.getDispatchTable());
  });

  // ── Working Memory Assembly ────────────────────────────────────────
  //
  // Token-budgeted context assembly from all memory layers.
  // NOTE: Must come BEFORE /context/:segmentId to avoid param capture.

  router.get('/context/working-memory', (req, res) => {
    if (!ctx.workingMemory) {
      res.status(503).json({ error: 'Working memory assembler not enabled' });
      return;
    }
    try {
      const { prompt, jobSlug, topicId, sessionId } = req.query;
      const result = ctx.workingMemory.assemble({
        prompt: typeof prompt === 'string' ? prompt : undefined,
        jobSlug: typeof jobSlug === 'string' ? jobSlug : undefined,
        topicId: topicId ? Number(topicId) : undefined,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Assembly failed' });
    }
  });

  // ── Active Job Context ──────────────────────────────────────────────
  //
  // Returns the currently active job (if any) for scope coherence checkpoints.

  router.get('/context/active-job', (_req, res) => {
    const activeJob = ctx.state.get<{
      slug: string;
      name: string;
      description: string;
      priority: string;
      sessionName: string;
      triggeredBy: string;
      startedAt: string;
      grounding: unknown;
    }>('active-job');

    if (!activeJob) {
      res.json({ active: false });
      return;
    }

    res.json({ active: true, job: activeJob });
  });

  // ── Scope Coherence ──────────────────────────────────────────────────
  //
  // Tracks implementation depth for the scope coherence checkpoint system.
  // The 232nd Lesson: Implementation depth narrows scope.

  router.get('/scope-coherence', (_req, res) => {
    const tracker = new ScopeCoherenceTracker(ctx.state);
    res.json(tracker.getState());
  });

  router.post('/scope-coherence/record', (req, res) => {
    const { toolName, toolInput } = req.body || {};
    if (!toolName || typeof toolName !== 'string') {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }
    const tracker = new ScopeCoherenceTracker(ctx.state);
    tracker.recordAction(toolName, toolInput || {});
    res.json(tracker.getState());
  });

  router.get('/scope-coherence/check', (_req, res) => {
    const tracker = new ScopeCoherenceTracker(ctx.state);
    const result = tracker.shouldTriggerCheckpoint();

    // Enrich with active job context if triggering
    let jobContext = null;
    if (result.trigger) {
      const activeJob = ctx.state.get<{
        slug: string;
        name: string;
        description: string;
      }>('active-job');
      if (activeJob) {
        jobContext = {
          slug: activeJob.slug,
          name: activeJob.name,
          description: activeJob.description,
        };
      }
      tracker.recordCheckpointShown();
    }

    res.json({ ...result, jobContext });
  });

  router.post('/scope-coherence/reset', (_req, res) => {
    const tracker = new ScopeCoherenceTracker(ctx.state);
    tracker.reset();
    res.json({ reset: true });
  });

  // NOTE: Must come AFTER all specific /context/* routes to avoid param capture.
  router.get('/context/:segmentId', (req, res) => {
    if (!ctx.contextHierarchy) {
      res.status(501).json({ error: 'ContextHierarchy not initialized' });
      return;
    }
    const content = ctx.contextHierarchy.loadSegment(req.params.segmentId);
    if (content === null) {
      res.status(404).json({ error: `Segment not found: ${req.params.segmentId}` });
      return;
    }
    res.type('text/markdown').send(content);
  });

  // ── Canonical State ───────────────────────────────────────────────
  //
  // Registry-first state management: quick facts, anti-patterns, project registry.

  router.get('/state/quick-facts', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.json(ctx.canonicalState.getQuickFacts());
  });

  router.post('/state/quick-facts', (req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    const { question, answer, source } = req.body;
    if (!question || !answer) {
      res.status(400).json({ error: 'Required: question, answer' });
      return;
    }
    ctx.canonicalState.setFact(question, answer, source || 'api');
    res.json({ saved: true, question, answer });
  });

  router.get('/state/anti-patterns', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.json(ctx.canonicalState.getAntiPatterns());
  });

  router.post('/state/anti-patterns', (req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    const { pattern, consequence, alternative, incident } = req.body;
    if (!pattern || !consequence || !alternative) {
      res.status(400).json({ error: 'Required: pattern, consequence, alternative' });
      return;
    }
    const entry = ctx.canonicalState.addAntiPattern({ pattern, consequence, alternative, incident });
    res.json(entry);
  });

  router.get('/state/projects', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.json(ctx.canonicalState.getProjects());
  });

  router.post('/state/projects', (req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    const { name, dir, gitRemote, deploymentTargets, type, topicIds, description } = req.body;
    if (!name || !dir) {
      res.status(400).json({ error: 'Required: name, dir' });
      return;
    }
    ctx.canonicalState.setProject({ name, dir, gitRemote, deploymentTargets, type, topicIds, description });
    res.json({ saved: true, name });
  });

  router.get('/state/summary', (_req, res) => {
    if (!ctx.canonicalState) {
      res.status(501).json({ error: 'CanonicalState not initialized' });
      return;
    }
    res.type('text/plain').send(ctx.canonicalState.getCompactSummary());
  });

  // ── CI Health ─────────────────────────────────────────────────────
  //
  // On-demand CI status check. Detects GitHub repo from git remote and
  // queries GitHub Actions for recent failures. Agents can use this to
  // check CI health without waiting for the next self-diagnosis cycle.

  router.get('/ci', (_req, res) => {
    const projectDir = ctx.config.projectDir;

    // Detect GitHub repo from git remote
    let repo: string | null = null;
    try {
      const remoteUrl = SafeGitExecutor.readSync(['remote', 'get-url', 'origin'], { cwd: projectDir,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'], operation: 'src/server/routes.ts:3037' }).trim();
      // Extract owner/repo from SSH or HTTPS URL
      const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
      if (match) repo = match[1];
    } catch {
      // Not a git repo or no remote
    }

    if (!repo) {
      res.json({ status: 'unknown', message: 'No GitHub repo detected', runs: [] });
      return;
    }

    // Query recent CI runs
    try {
      const result = execFileSync('gh', [
        'run', 'list', '--repo', repo, '--limit', '5',
        '--json', 'databaseId,conclusion,status,headBranch,name,createdAt',
      ], {
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const runs = JSON.parse(result);
      const failures = runs.filter((r: any) => r.conclusion === 'failure');
      const inProgress = runs.filter((r: any) => r.status === 'in_progress');

      res.json({
        repo,
        status: failures.length > 0 ? 'failing' : inProgress.length > 0 ? 'in_progress' : 'passing',
        failureCount: failures.length,
        inProgressCount: inProgress.length,
        runs,
      });
    } catch (err) {
      res.json({
        repo,
        status: 'error',
        message: err instanceof Error ? err.message : 'gh CLI failed',
        runs: [],
      });
    }
  });

  // ── Sessions ────────────────────────────────────────────────────

  // Literal routes BEFORE parameterized routes to avoid capture
  router.get('/sessions/tmux', (_req, res) => {
    try {
      const tmuxPath = ctx.config.sessions.tmuxPath;
      const output = execFileSync(tmuxPath, ['list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const sessions = output
        ? output.split('\n').filter(Boolean).map((name: string) => ({ name }))
        : [];

      res.json({ sessions });
    } catch {
      res.json({ sessions: [] });
    }
  });

  // SessionReaper observability (SESSION-REAPER-SPEC §3.9). Answers
  // "why did/didn't it reap X?" from a pull surface — pressure tier, active
  // threshold, and every running session's verdict + the gate that kept it.
  router.get('/sessions/reaper', (_req, res) => {
    if (!ctx.sessionReaper) {
      res.status(503).json({ error: 'session reaper unavailable' });
      return;
    }
    res.json(ctx.sessionReaper.snapshot());
  });

  // AgentWorktreeReaper (RESPONSIBLE-RESOURCE-USAGE — OS resource hygiene). The
  // pull-surface answer to "which stale worktrees can be reclaimed, and why is
  // each kept?": every `.worktrees/` worktree's verdict (active-lock /
  // uncommitted-changes / not-stale / unmerged / reap-eligible) + the reclaimable
  // count + whether reaping is armed (enabled, dryRun). Read-only, Bearer-auth.
  router.get('/worktrees/agent-reaper', (_req, res) => {
    if (!ctx.agentWorktreeReaper) {
      res.status(503).json({ error: 'agent worktree reaper unavailable' });
      return;
    }
    res.json(ctx.agentWorktreeReaper.snapshot());
  });

  // SleepController (RESPONSIBLE-RESOURCE-USAGE — agent hard-sleep, Stage B). The
  // pull-surface answer to "would this idle agent sleep right now, and if not,
  // which guard is holding it awake?": the live verdict (awake / idle-shallow /
  // keep-awake / would-sleep) + reason + thresholds + whether sleep is armed
  // (enabled, dryRun). Read-only, Bearer-auth. Dry-run by default — never acts.
  router.get('/sleep', (_req, res) => {
    if (!ctx.sleepController) {
      res.status(503).json({ error: 'sleep controller unavailable' });
      return;
    }
    res.json(ctx.sleepController.snapshot());
  });

  // Reap-log (UNIFIED-SESSION-LIFECYCLE §P4). The pull-surface answer to "why did
  // my session vanish?": every reap + every refused/skipped terminate, newest
  // last. Read-only, Bearer-auth (the router-level middleware). `?limit=N`
  // bounds the tail (default 200).
  router.get('/sessions/reap-log', (req, res) => {
    if (!ctx.reapLog) {
      res.status(503).json({ error: 'reap-log unavailable' });
      return;
    }
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 200;
    res.json({ entries: ctx.reapLog.read(limit) });
  });

  // Reaper decision audit (RESPONSIBLE-RESOURCE-USAGE). The pull-surface answer to
  // "what is the reaper considering, and why is it keeping/killing each session?":
  // every keep/kill DECISION transition (logged on change, not every tick) plus the
  // reap-path events, each stamped with the pressure tier (memory + CPU) that drove
  // it. Read-only, Bearer-auth (router-level middleware), silent (no notifications).
  // `?limit=N` bounds the tail (default 200, max 1000).
  router.get('/sessions/reaper/audit', (req, res) => {
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 200;
    res.json({ entries: readReaperAudit(ctx.config.stateDir, limit) });
  });

  // Sleep/wake telemetry. The pull-surface answer to "why does my agent keep
  // 'restarting'?" — wakeCount is genuine sleep/wake recovery; suppressedCount
  // (with the cpu-starvation/cooldown breakdown) is the false-wake storm the
  // CPU-starvation guard absorbed instead of triggering recovery. Read-only,
  // Bearer-auth (router-level middleware). `?sinceMs=<epoch>` filters the window.
  router.get('/monitoring/sleep-wake', (req, res) => {
    if (!ctx.sleepWakeDetector) {
      res.status(503).json({ error: 'sleep-wake detector unavailable' });
      return;
    }
    const rawSince = Number(req.query.sinceMs);
    const sinceMs = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : undefined;
    res.json(ctx.sleepWakeDetector.getStats(sinceMs));
  });

  router.get('/sessions', (req, res) => {
    const status = req.query.status as string | undefined;
    const validStatuses = ['starting', 'running', 'completed', 'failed', 'killed'];
    const sessions = status && validStatuses.includes(status)
      ? ctx.state.listSessions({ status: status as 'starting' | 'running' | 'completed' | 'failed' | 'killed' })
      : ctx.state.listSessions();

    // Enrich sessions with hook event telemetry and platform info
    const enriched = sessions.map(s => {
      const result: Record<string, unknown> = { ...s };

      // Add hook event telemetry
      if (req.query.enrich !== 'false' && ctx.hookEventReceiver) {
        const summary = ctx.hookEventReceiver.getSessionSummary(s.tmuxSession);
        if (summary) {
          result.telemetry = {
            eventCount: summary.eventCount,
            toolsUsed: summary.toolsUsed,
            subagentsSpawned: summary.subagentsSpawned,
            lastActivity: summary.lastEvent,
            taskCompleted: ctx.hookEventReceiver!.hasTaskCompleted(s.tmuxSession),
            exitReason: ctx.hookEventReceiver!.getExitReason(s.tmuxSession),
          };
        }
      }

      // Add platform indicator and display name
      if (ctx.telegram) {
        const topicId = ctx.telegram.getTopicForSession?.(s.tmuxSession);
        if (topicId) {
          result.platform = 'telegram';
          result.platformId = topicId;
          const topicName = ctx.telegram.getTopicName?.(topicId);
          if (topicName && !/^topic-\d+$/.test(topicName)) result.platformName = topicName;
        }
      }
      if (!result.platform && ctx.slack) {
        const channelId = ctx.slack.getChannelForSession(s.tmuxSession);
        if (channelId) {
          result.platform = 'slack';
          result.platformId = channelId;
          const registry = ctx.slack.getChannelRegistry();
          if (registry[channelId]?.channelName) result.platformName = registry[channelId].channelName;
        }
      }
      if (!result.platform) {
        result.platform = 'headless';
      }

      return result;
    });

    res.json(enriched);
  });

  router.post('/sessions/cleanup-stale', (_req, res) => {
    const cleaned = ctx.sessionManager.cleanupStaleSessions();

    // Also purge failed-messages files older than 24 hours
    const failDir = path.join(ctx.config.stateDir, 'state', 'failed-messages');
    let purgedFiles = 0;
    if (fs.existsSync(failDir)) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const fname of fs.readdirSync(failDir)) {
        const fpath = path.join(failDir, fname);
        try {
          if (fs.statSync(fpath).mtimeMs < cutoff) {
            SafeFsExecutor.safeUnlinkSync(fpath, { operation: 'src/server/routes.ts:3177' });
            purgedFiles++;
          }
        } catch { /* ignore individual file errors */ }
      }
    }

    res.json({ cleaned: cleaned.length, sessionIds: cleaned, purgedFailedMessages: purgedFiles });
  });

  router.get('/sessions/:name/output', (req, res) => {
    if (!SESSION_NAME_RE.test(req.params.name)) {
      res.status(400).json({ error: 'Invalid session name' });
      return;
    }
    const rawLines = parseInt(req.query.lines as string, 10) || 100;
    const lines = Math.min(Math.max(rawLines, 1), 10_000);
    const output = ctx.sessionManager.captureOutput(req.params.name, lines);

    if (output === null) {
      res.status(404).json({ error: `Session "${req.params.name}" not found or not running` });
      return;
    }

    res.json({ session: req.params.name, output });
  });

  router.post('/sessions/:name/input', (req, res) => {
    if (!SESSION_NAME_RE.test(req.params.name)) {
      res.status(400).json({ error: 'Invalid session name' });
      return;
    }
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Request body must include "text" field' });
      return;
    }
    if (text.length > 100_000) {
      res.status(400).json({ error: 'Input text exceeds maximum length (100KB)' });
      return;
    }

    const success = ctx.sessionManager.sendInput(req.params.name, text);
    if (!success) {
      res.status(404).json({ error: `Session "${req.params.name}" not found or not running` });
      return;
    }

    res.json({ ok: true });
  });

  // Rate limit session spawning — each session is a real Claude Code process.
  // Default: 10 spawns per 60 seconds, which is generous for normal use.
  const spawnLimiter = rateLimiter(60_000, 10);
  router.post('/sessions/spawn', spawnLimiter, async (req, res) => {
    const { name, prompt, model, jobSlug, framework } = req.body;

    if (!name || !prompt) {
      res.status(400).json({ error: '"name" and "prompt" are required' });
      return;
    }
    if (typeof name !== 'string' || !SESSION_NAME_RE.test(name)) {
      res.status(400).json({ error: '"name" must contain only letters, numbers, hyphens, underscores (max 200)' });
      return;
    }
    if (typeof prompt !== 'string' || prompt.length > 500_000) {
      res.status(400).json({ error: '"prompt" must be a string under 500KB' });
      return;
    }
    if (framework !== undefined && !['claude-code', 'codex-cli'].includes(framework)) {
      res.status(400).json({ error: '"framework" must be one of: claude-code, codex-cli' });
      return;
    }
    // Provider-portability v1.0.0: model whitelist is framework-aware.
    // Generic tiers ('fast'|'balanced'|'capable') are universally accepted
    // and resolve per-framework inside buildHeadlessLaunch. Framework-
    // specific names are accepted when they match the framework slot.
    const GENERIC_TIERS = ['fast', 'balanced', 'capable'];
    const CLAUDE_TIERS = ['opus', 'sonnet', 'haiku'];
    // E2E-PAIRING: EXEMPT — adds one value ('gpt-5.4-mini') to an existing
    // model allowlist on the already-live /sessions/create route. No new route,
    // no route-aliveness change, no 503 surface; route-create E2E coverage is
    // unchanged by extending the accepted-model set.
    const CODEX_MODELS_SUBSCRIPTION = ['gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5'];
    if (model !== undefined) {
      if (typeof model !== 'string') {
        res.status(400).json({ error: '"model" must be a string' });
        return;
      }
      const requestedFramework = framework ?? 'claude-code';
      const allowed = requestedFramework === 'codex-cli'
        ? [...GENERIC_TIERS, ...CODEX_MODELS_SUBSCRIPTION]
        : [...GENERIC_TIERS, ...CLAUDE_TIERS];
      if (!allowed.includes(model)) {
        res.status(400).json({
          error: `"model" must be one of: ${allowed.join(', ')} (framework: ${requestedFramework})`,
        });
        return;
      }
    }
    if (jobSlug !== undefined && (typeof jobSlug !== 'string' || !JOB_SLUG_RE.test(jobSlug))) {
      res.status(400).json({ error: '"jobSlug" must contain only letters, numbers, hyphens, underscores' });
      return;
    }

    try {
      const session = await ctx.sessionManager.spawnSession({ name, prompt, model, jobSlug, framework });
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /sessions/refresh — agent-initiated session respawn.
  //
  // The agent calls this when it needs new MCPs/skills (just installed via
  // `claude mcp add`) to attach. We kill its tmux session and respawn with
  // `claude --resume <uuid>`, which loads the new tools while keeping the
  // conversation. The response is 202 immediately because the kill itself
  // ends the requester's process — there is no synchronous result.
  //
  // Rate limit and lifecycle live in SessionRefresh (the orchestrator);
  // this route is a thin entry point.
  router.post('/sessions/refresh', spawnLimiter, (req, res) => {
    if (!ctx.sessionRefresh) {
      res.status(503).json({ error: 'Session refresh not enabled (no Telegram adapter wired)' });
      return;
    }

    const { sessionName, followUpPrompt, reason } = req.body || {};

    if (!sessionName || typeof sessionName !== 'string' || !SESSION_NAME_RE.test(sessionName)) {
      res.status(400).json({ error: '"sessionName" is required and must contain only letters, numbers, hyphens, underscores (max 200)' });
      return;
    }
    if (followUpPrompt !== undefined && (typeof followUpPrompt !== 'string' || followUpPrompt.length > 500_000)) {
      res.status(400).json({ error: '"followUpPrompt" must be a string under 500KB' });
      return;
    }
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
      res.status(400).json({ error: '"reason" must be a string under 1000 chars' });
      return;
    }

    // Acknowledge BEFORE killing — the requester is the session being killed,
    // so it needs to receive the 202 before its process disappears.
    res.status(202).json({ ok: true, message: 'Refresh scheduled', sessionName });

    // Schedule the kill+spawn after the response has flushed and the agent
    // has a moment to log its last action. 500ms is enough for HTTP flush
    // on a local loopback without being a noticeable user-facing delay.
    const sessionRefresh = ctx.sessionRefresh;
    setTimeout(() => {
      sessionRefresh.refreshSession({ sessionName, followUpPrompt, reason }).then(result => {
        if (!result.ok) {
          // Structured logging so over-blocks (rate guard) are detectable
          // in operations per signal-vs-authority logging rule. The agent's
          // process may already be dead — nothing to reply to.
          console.warn(`[sessions/refresh] refused sessionName=${sessionName} code=${result.code} message="${result.message}"`);
        }
      }).catch(err => {
        console.error(`[sessions/refresh] unexpected error for sessionName=${sessionName}:`, err);
      });
    }, 500);
  });

  // POST /sessions/restart-all — bulk config-apply restart.
  //
  // After a config change (default model, disabled features, a newly-added
  // hook), running sessions keep their OLD config until they restart — and
  // Claude Code only loads hooks/settings at session START, so a hook added
  // mid-session never engages on the live session. Previously the only way to
  // push every session onto the new config was to wait for the reaper or
  // refresh each session by hand. This refreshes every running, Telegram-bound
  // session through SessionRefresh (kill + `claude --resume`, preserving each
  // conversation), staggered so we don't kill+respawn the whole fleet at once.
  //
  // Non-Telegram-bound sessions (Slack, iMessage, headless) are skipped — the
  // respawn path is topic-routed, the same v1 limitation as /sessions/refresh.
  router.post('/sessions/restart-all', spawnLimiter, (req, res) => {
    if (!ctx.sessionRefresh) {
      res.status(503).json({ error: 'Session refresh not enabled (no Telegram adapter wired)' });
      return;
    }

    const { reason, excludeSession, followUpPrompt } = req.body || {};
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
      res.status(400).json({ error: '"reason" must be a string under 1000 chars' });
      return;
    }
    if (excludeSession !== undefined && (typeof excludeSession !== 'string' || !SESSION_NAME_RE.test(excludeSession))) {
      res.status(400).json({ error: '"excludeSession" must contain only letters, numbers, hyphens, underscores (max 200)' });
      return;
    }
    if (followUpPrompt !== undefined && (typeof followUpPrompt !== 'string' || followUpPrompt.length > 500_000)) {
      res.status(400).json({ error: '"followUpPrompt" must be a string under 500KB' });
      return;
    }

    // Snapshot running sessions NOW, before any kills. Filter to Telegram-bound
    // up front (checking in-memory AND disk, mirroring SessionRefresh's own
    // resolution) so the "scheduled" list we return is honest — the rest would
    // only come back not_telegram_bound.
    const running = ctx.state.listSessions({ status: 'running' });
    const targets = running
      .map(s => s.tmuxSession)
      .filter((name): name is string => !!name && name !== excludeSession)
      .filter(name => {
        const topic = ctx.telegram?.getTopicForSession?.(name)
          ?? ctx.telegram?.resolveTopicForSessionFromDisk?.(name)
          ?? null;
        return topic !== null;
      });

    res.status(202).json({
      ok: true,
      message: 'Bulk restart scheduled',
      scheduled: targets,
      count: targets.length,
      skipped: running.length - targets.length,
    });

    // Stagger the refreshes so we don't kill+respawn the whole fleet in one
    // burst (a tmux storm + a model-load CPU spike). Each refresh is
    // independent and self-rate-limited inside SessionRefresh, so a repeated
    // restart-all inside the rate window is harmlessly refused per session.
    const sessionRefresh = ctx.sessionRefresh;
    const STAGGER_MS = 750;
    targets.forEach((sessionName, i) => {
      setTimeout(() => {
        sessionRefresh
          .refreshSession({ sessionName, followUpPrompt, reason: reason ?? 'bulk restart-all (config apply)' })
          .then(result => {
            if (!result.ok) {
              console.warn(`[sessions/restart-all] refused sessionName=${sessionName} code=${result.code} message="${result.message}"`);
            } else {
              console.log(`[sessions/restart-all] refreshed sessionName=${sessionName} -> ${result.newSessionName} (topic ${result.topicId})`);
            }
          })
          .catch(err => {
            console.error(`[sessions/restart-all] unexpected error for sessionName=${sessionName}:`, err);
          });
      }, 500 + i * STAGGER_MS);
    });
  });

  router.delete('/sessions/:id', async (req, res) => {
    if (!SESSION_NAME_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid session ID format' });
      return;
    }
    try {
      // Operator kill — stamped origin:'operator' so it bypasses the autonomous
      // ReapAuthority gates (protected / lease / KEEP-guard) and ALWAYS happens
      // (the user clicked "kill"). Routing through terminateSession (rather than
      // the raw killSession) gives the reap-log + lifecycle events the §P4 surface
      // depends on. (UNIFIED-SESSION-LIFECYCLE §P0.)
      // Try direct UUID lookup first, then fall back to tmux session name lookup —
      // the dashboard sends tmux session names, not UUIDs.
      let target = ctx.state.getSession(req.params.id);
      if (!target) {
        const allSessions = ctx.state.listSessions({ status: 'running' });
        target = allSessions.find(s => s.tmuxSession === req.params.id) ?? null;
      }
      if (!target) {
        res.status(404).json({ error: `Session "${req.params.id}" not found` });
        return;
      }
      const result = await ctx.sessionManager.terminateSession(target.id, 'operator-kill', {
        origin: 'operator',
        finalStatus: 'killed',
      });
      if (!result.terminated) {
        res.status(404).json({ error: `Session "${req.params.id}" not found`, skipped: result.skipped });
        return;
      }
      res.json({ ok: true, killed: req.params.id });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Create an interactive session from the dashboard.
  // Set platform to 'telegram', 'slack', or 'headless'.
  // Legacy: headless=true is equivalent to platform='headless'.
  router.post('/sessions/create', spawnLimiter, async (req, res) => {
    const { name, headless, platform } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      res.status(400).json({ error: '"name" is required (non-empty string)' });
      return;
    }
    if (name.length > 128) {
      res.status(400).json({ error: '"name" must be 128 characters or fewer' });
      return;
    }

    const topicName = name.trim();
    let topicId: number | undefined;
    let slackChannelId: string | undefined;
    const resolvedPlatform = platform || (headless ? 'headless' : (ctx.telegram ? 'telegram' : (ctx.slack ? 'slack' : 'headless')));

    // Create Telegram topic
    if (resolvedPlatform === 'telegram' && ctx.telegram) {
      try {
        const topic = await ctx.telegram.findOrCreateForumTopic(topicName);
        topicId = topic.topicId;
      } catch (err) {
        console.error(`[sessions/create] Telegram topic creation failed, proceeding headless: ${err}`);
      }
    }

    // Create Slack channel
    if (resolvedPlatform === 'slack' && ctx.slack) {
      try {
        const rawAgentName = (ctx.slack as unknown as { config: { workspaceName?: string } }).config?.workspaceName?.replace(/-agent$/i, '') || 'agent';
        const agentName = rawAgentName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const channelName = `${agentName}-sess-${topicName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40)}`;
        slackChannelId = await ctx.slack.createChannel(channelName);
      } catch (err) {
        console.error(`[sessions/create] Slack channel creation failed, proceeding headless: ${err}`);
      }
    }

    try {
      const tmuxSession = await ctx.sessionManager.spawnInteractiveSession(
        undefined, // no initial message
        topicName,
        topicId ? { telegramTopicId: topicId } : undefined,
      );

      // Update topic-session registry if we created a Telegram topic
      if (topicId) {
        const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
        try {
          const reg = fs.existsSync(registryPath)
            ? JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
            : { topicToSession: {}, topicToName: {} };
          reg.topicToSession[String(topicId)] = tmuxSession;
          reg.topicToName[String(topicId)] = topicName;
          fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
        } catch {
          // Non-fatal — registry is best-effort
        }
      }

      // Update Slack channel-session registry and invite authorized users
      if (slackChannelId && ctx.slack) {
        ctx.slack.registerChannelSession(slackChannelId, tmuxSession, topicName);
        // Invite authorized users to the new channel
        try {
          const slackConfig = ctx.config.messaging?.find(m => m.type === 'slack')?.config as Record<string, unknown> | undefined;
          const authorizedUserIds = (slackConfig?.authorizedUserIds as string[]) ?? [];
          for (const userId of authorizedUserIds) {
            await ctx.slack.api.call('conversations.invite', { channel: slackChannelId, users: userId }).catch(() => {});
          }
        } catch { /* non-fatal */ }
      }

      res.status(201).json({
        ok: true,
        session: tmuxSession,
        name: topicName,
        topicId: topicId || null,
        slackChannelId: slackChannelId || null,
        platform: resolvedPlatform,
        headless: resolvedPlatform === 'headless',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Token Ledger ────────────────────────────────────────────────
  // Read-only token-usage observability backed by SQLite. Source data
  // is Claude Code's per-session JSONL transcripts at
  // ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl.
  // Auth is enforced globally by authMiddleware.

  const TOKEN_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const TOKEN_DEFAULT_ORPHAN_IDLE_MS = 30 * 60 * 1000;

  function parseSinceMs(raw: unknown): number {
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n >= 0) return n;
    }
    return Date.now() - TOKEN_DEFAULT_WINDOW_MS;
  }

  router.get('/tokens/summary', (req, res) => {
    if (!ctx.tokenLedger) {
      res.status(503).json({ error: 'token ledger unavailable' });
      return;
    }
    const sinceMs = parseSinceMs(req.query.since);
    // `summary` = Claude token_events (unchanged; this is what BurnDetector reads).
    // `codex` = the separate Codex-rollout rollup — additive, observability-only.
    res.json({
      sinceMs,
      summary: ctx.tokenLedger.summary({ sinceMs }),
      codex: ctx.tokenLedger.codexSummary({ sinceMs }),
    });
  });

  // Session clock (docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md) — read-only
  // observability: elapsed/remaining for each active time-boxed (autonomous)
  // session, so an agent (or the dashboard) can ask "how long have I been running
  // / how much is left" instead of guessing. Leak-bounded: returns the computed
  // clock + the sanitized derived `label` only — never the raw `goal` task text.
  // Per-machine by nature (the record is `.local`, gitignored).
  router.get('/session/clock', (req, res) => {
    const topic = typeof req.query.topic === 'string' ? req.query.topic : null;
    const now = Date.now();
    let sessions: ReturnType<typeof readSessionClocks> = [];
    try {
      sessions = readSessionClocks(ctx.config.stateDir, now, topic);
    } catch {
      sessions = [];
    }
    res.json({ now, nowIso: new Date(now).toISOString(), sessions });
  });

  // Per-feature LLM metrics (docs/specs/llm-feature-metrics-spec.md) — read-only
  // observability: per gate/sentinel cost + hit-rate, so tuning is evidence-based
  // (which to thin, which to strengthen). 503-stubs via the null ledger when
  // stateDir/metrics is unavailable. Phase 1a — the funnel tap that feeds it is
  // Phase 1b (on top of #638).
  router.get('/metrics/features', (req, res) => {
    if (!ctx.featureMetricsLedger) {
      res.status(503).json({ error: 'feature-metrics ledger unavailable' });
      return;
    }
    const sinceHours = req.query.sinceHours ? Number(req.query.sinceHours) : undefined;
    const feature = typeof req.query.feature === 'string' ? req.query.feature : undefined;
    const summary = ctx.featureMetricsLedger.summary(
      sinceHours && sinceHours > 0 ? { sinceHours } : {},
    );
    const features = feature
      ? summary.features.filter((f) => f.feature === feature)
      : summary.features;
    res.json({ ...summary, features });
  });

  // ── Release-readiness (Layer B of release-readiness-visibility) ──────
  // Null when there's no analyzable instar git repo or the feature is off.
  router.get('/release-readiness', (_req, res) => {
    if (!ctx.releaseReadinessSentinel) {
      res.status(503).json({ error: 'release-readiness watchdog not configured (no analyzable instar repo or disabled)' });
      return;
    }
    const s = ctx.releaseReadinessSentinel.snapshot();
    const openEpisode = s.episodes.find((e) => !e.resolvedMs && e.openedMs);
    // Served from the local host's cache; on a multi-machine follower this may
    // lag the leader by up to one lease-handoff (spec §4.2.7).
    res.setHeader('X-Readiness-Source', 'leader');
    res.json({
      disabled: s.disabled ?? false,
      lastTickAt: s.lastTickAt,
      lastSignalAt: s.lastSignalAt,
      cacheHeadSha: s.cacheHeadSha,
      canonicalRemoteOverridden: s.canonicalRemoteOverridden ?? false,
      openEpisodes: s.episodes.filter((e) => !e.resolvedMs).length,
      oldestOpenSha: openEpisode?.oldestSha,
      openAttentionId: openEpisode?.attentionId,
      rollbackHistory: (s.rollbackHistory ?? []).slice(-5),
    });
  });

  // The job (off by default) calls this on its cadence — tick() is the cron
  // entry point. Runs one evaluation; the sentinel owns all signalling.
  router.post('/release-readiness/tick', async (_req, res) => {
    if (!ctx.releaseReadinessSentinel) {
      res.status(503).json({ error: 'release-readiness watchdog not configured' });
      return;
    }
    await ctx.releaseReadinessSentinel.tick();
    res.json({ ok: true });
  });

  // Rollback is bearer-gated AND loud: it raises a HIGH-priority Attention item
  // + audits, so it can't silently mute the alarm (spec §4.2.7 / iter-3 V5).
  router.post('/release-readiness/rollback', async (req, res) => {
    if (!ctx.releaseReadinessSentinel) {
      res.status(503).json({ error: 'release-readiness watchdog not configured' });
      return;
    }
    await ctx.releaseReadinessSentinel.rollback({
      sessionId: typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined,
      sourceIp: req.ip,
    });
    res.json({ ok: true, rolledBack: true });
  });

  router.post('/release-readiness/enable', (_req, res) => {
    if (!ctx.releaseReadinessSentinel) {
      res.status(503).json({ error: 'release-readiness watchdog not configured' });
      return;
    }
    ctx.releaseReadinessSentinel.enable();
    res.json({ ok: true, enabled: true });
  });

  // ── Human-as-Detector heat map ───────────────────────────────────────
  // "Where the human is doing the system's job": coherence breaks a human had
  // to surface, grouped by the automated layer that should plausibly have
  // caught each. Observability-only, read-only. The singleton is always
  // configured at startup, so no availability guard is needed.
  router.get('/human-as-detector/summary', (_req, res) => {
    const log = HumanAsDetectorLog.getInstance();
    res.json({
      byLayer: log.summarizeByLayer(),
      recent: log.getRecent().slice(-50),
    });
  });

  router.get('/tokens/codex-sessions', (req, res) => {
    if (!ctx.tokenLedger) {
      res.status(503).json({ error: 'token ledger unavailable' });
      return;
    }
    const sinceMs = parseSinceMs(req.query.since);
    let limit = 50;
    if (typeof req.query.limit === 'string' && /^\d+$/.test(req.query.limit)) {
      const n = Number(req.query.limit);
      if (n > 0 && n <= 500) limit = n;
    }
    res.json({ sinceMs, limit, sessions: ctx.tokenLedger.codexSessions({ limit, sinceMs }) });
  });

  router.get('/tokens/sessions', (req, res) => {
    if (!ctx.tokenLedger) {
      res.status(503).json({ error: 'token ledger unavailable' });
      return;
    }
    const sinceMs = parseSinceMs(req.query.since);
    let limit = 20;
    if (typeof req.query.limit === 'string' && /^\d+$/.test(req.query.limit)) {
      const n = Number(req.query.limit);
      if (n > 0 && n <= 500) limit = n;
    }
    res.json({ sinceMs, limit, sessions: ctx.tokenLedger.topSessions({ limit, sinceMs }) });
  });

  router.get('/tokens/by-project', (req, res) => {
    if (!ctx.tokenLedger) {
      res.status(503).json({ error: 'token ledger unavailable' });
      return;
    }
    const sinceMs = parseSinceMs(req.query.since);
    res.json({ sinceMs, projects: ctx.tokenLedger.byProject({ sinceMs }) });
  });

  router.get('/tokens/orphans', (req, res) => {
    if (!ctx.tokenLedger) {
      res.status(503).json({ error: 'token ledger unavailable' });
      return;
    }
    let idleMs = TOKEN_DEFAULT_ORPHAN_IDLE_MS;
    if (typeof req.query.idleMs === 'string' && /^\d+$/.test(req.query.idleMs)) {
      const n = Number(req.query.idleMs);
      if (n > 0) idleMs = n;
    }
    res.json({ idleMs, orphans: ctx.tokenLedger.orphans({ idleMs }) });
  });

  // ── Codex usage (the codex `/status` equivalent, read from disk) ─────
  // Codex has no usage API, but the codex CLI persists the authoritative
  // account rate-limit windows (primary=5h, secondary=weekly) into each
  // session rollout's `token_count` events. This route surfaces the freshest
  // snapshot so an agent can answer "where does codex usage sit?" and so the
  // model-swap policy can react to an exhausted window — without the
  // interactive TUI. Read-only; never mutates session state. Always 200 when
  // wired ("alive"): `available:false` (not 503) means simply no codex data
  // on disk yet (e.g. a pure-Claude agent).
  router.get('/codex/usage', async (req, res) => {
    const codexHome =
      typeof req.query.codexHome === 'string' && req.query.codexHome
        ? req.query.codexHome
        : undefined;
    let usage = null;
    try {
      usage = await readLatestCodexUsage({ codexHome });
    } catch {
      usage = null;
    }
    if (!usage) {
      res.json({
        available: false,
        usage: null,
        reason: 'no codex rollout with rate-limit data found',
      });
      return;
    }
    res.json({ available: true, usage });
  });

  // ── Framework-Onboarding Mentor System: issue ledger (read-only) ──
  // Signal-only observability. Bearer auth is applied globally by middleware;
  // these routes never gate behaviour. See FRAMEWORK-ONBOARDING-MENTOR-SPEC §5.

  // Clamp a list limit to 1..500 (§5/§17). Local to avoid import churn; mirrors
  // FrameworkIssueLedger.clampLimit (the ledger re-clamps server-side too).
  const clampFwLimit = (raw: unknown): number => {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
    if (!Number.isFinite(n)) return 100;
    return Math.max(1, Math.min(500, Math.floor(n)));
  };

  router.get('/framework-issues', (req, res) => {
    if (!ctx.frameworkIssueLedger) {
      res.status(503).json({ error: 'framework issue ledger unavailable' });
      return;
    }
    const limit = clampFwLimit(req.query.limit);
    // Validate framework against the known-framework allowlist (§17) — an
    // unknown value yields an empty result, never an unbounded/injection query.
    const known = ctx.frameworkIssueLedger.knownFrameworks();
    let framework: string | undefined;
    if (typeof req.query.framework === 'string') {
      if (!known.includes(req.query.framework)) {
        res.json({ framework: req.query.framework, knownFrameworks: known, issues: [] });
        return;
      }
      framework = req.query.framework;
    }
    const bucket = typeof req.query.bucket === 'string' ? req.query.bucket : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    try {
      const issues = ctx.frameworkIssueLedger.listIssues({
        framework,
        // listIssues validates these enums and throws on bad input.
        bucket: bucket as never,
        status: status as never,
        limit,
      });
      res.json({ framework, knownFrameworks: known, limit, issues });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/framework-issues/playbook', (req, res) => {
    if (!ctx.frameworkIssueLedger) {
      res.status(503).json({ error: 'framework issue ledger unavailable' });
      return;
    }
    const targetFramework = typeof req.query.targetFramework === 'string' ? req.query.targetFramework : '';
    if (!targetFramework) {
      res.status(400).json({ error: 'targetFramework query param is required' });
      return;
    }
    const limit = clampFwLimit(req.query.limit);
    const playbook = ctx.frameworkIssueLedger.playbook({ targetFramework, limit });
    res.json({ targetFramework, limit, playbook });
  });

  router.get('/framework-issues/capture-stats', (_req, res) => {
    if (!ctx.frameworkIssueLedger) {
      res.status(503).json({ error: 'framework issue ledger unavailable' });
      return;
    }
    // The capture funnel: runs vs observations written. A nonzero run count with
    // a stuck-at-zero observation count over time flags an inert/broken writer.
    res.json(ctx.frameworkIssueLedger.captureStats());
  });

  router.get('/framework-issues/observability', (_req, res) => {
    if (!ctx.frameworkIssueLedger) {
      res.status(503).json({ error: 'framework issue ledger unavailable' });
      return;
    }
    // Adversarial telemetry (§15): bucket-distribution skew, leak-suspected and
    // probable-loop counts, playbook-extracted count. Read-only signal.
    res.json(ctx.frameworkIssueLedger.observability());
  });

  // Durable write path (§5) — lets an agent (or the mentor loop, or a backfill
  // script) record an engineering-DISCOVERED framework issue into the ledger,
  // not just the ones a live mentor tick trips over. Thin wrapper over the
  // already-validated recordObservation (+ optional status transition for
  // backfilling an already-fixed issue). bucket/severity/status enums are
  // validated by the ledger, which throws → 400. New framework strings are
  // intentionally allowed (onboarding the NEXT framework introduces one).
  router.post('/framework-issues/observe', (req, res) => {
    if (!ctx.frameworkIssueLedger) {
      res.status(503).json({ error: 'framework issue ledger unavailable' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
    for (const field of ['framework', 'bucket', 'title', 'dedupKey'] as const) {
      if (!str(b[field])) {
        res.status(400).json({ error: `${field} (non-empty string) is required` });
        return;
      }
    }
    try {
      const result = ctx.frameworkIssueLedger.recordObservation({
        framework: b.framework as string,
        bucket: b.bucket as never, // ledger assertEnum-validates → throws → 400
        title: b.title as string,
        severity: str(b.severity) as never,
        dedupKey: b.dedupKey as string,
        signature: str(b.signature),
        evidence: str(b.evidence),
        observedVersion: str(b.observedVersion),
        bucketPrimary: str(b.bucketPrimary) as never,
        relatedSpec: str(b.relatedSpec),
      });
      // Optional terminal-status transition in the same call. recordObservation
      // always creates as 'open'; a backfill of an already-fixed issue passes
      // status:'fixed' (+ fixedInVersion). wont-fix requires a reason (the
      // ledger enforces this → 400 if missing).
      let issue = ctx.frameworkIssueLedger.getIssue(result.issueId);
      const status = str(b.status);
      if (status && status !== 'open') {
        issue =
          ctx.frameworkIssueLedger.updateIssue(result.issueId, {
            status: status as never,
            fixedInVersion: str(b.fixedInVersion),
            wontFixReason: str(b.wontFixReason),
          }) ?? issue;
      }
      res.json({ ...result, issue });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/framework-issues/:id/promote', (req, res) => {
    if (!ctx.frameworkIssueLedger) {
      res.status(503).json({ error: 'framework issue ledger unavailable' });
      return;
    }
    const target = typeof req.body?.status === 'string' ? req.body.status : '';
    const promotedBy = typeof req.body?.promotedBy === 'string' ? req.body.promotedBy : '';
    try {
      // candidate→extracted requires a non-Echo attestation (§13.6); the ledger
      // throws if Echo attempts to promote its own lesson into the playbook.
      const updated = ctx.frameworkIssueLedger.promotePlaybook(req.params.id, target as never, promotedBy);
      if (!updated) {
        res.status(404).json({ error: 'issue not found' });
        return;
      }
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Mentor-onboarding job (§19.4) — dormant by default ──
  router.get('/mentor/status', (_req, res) => {
    if (!ctx.mentorRunner) {
      res.status(503).json({ error: 'mentor runner unavailable' });
      return;
    }
    res.json(ctx.mentorRunner.status());
  });

  router.post('/mentor/tick', (_req, res) => {
    if (!ctx.mentorRunner) {
      res.status(503).json({ error: 'mentor runner unavailable' });
      return;
    }
    // The built-in mentor job (off by default) hits this each tick. The tick runs
    // FIRE-AND-FORGET (a slow Stage-A spawn must not hang this request — the
    // gate-latency-vs-client-timeout failure mode); the outcome lands in
    // GET /mentor/status .lastResult. When disabled, this returns 200 disabled.
    const r = ctx.mentorRunner.startTick();
    if (r.reason === 'disabled') {
      res.json({ ran: false, reason: 'disabled' });
      return;
    }
    res.status(202).json({ accepted: r.accepted, reason: r.reason ?? null });
  });

  // ── Failure-Learning Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md §4.5) ──
  // instar self-hosting dev-process forensics. Inline (like /tokens) so the
  // /capabilities discoverability lint sees the routes. 503-stub when the
  // ledger is null (feature OFF, default). Reads serve toApiView ONLY —
  // detail.full NEVER crosses the boundary (§4.8). POST is the one mutating
  // route: requires X-Instar-Request intent + server-validated initiative.

  // ETag/304 for the Process Health tab's diff-aware polling (tab spec §3/§4.3).
  // Deterministic SHA over the fully-assembled body (incl. any rollout block);
  // rely on V8 insertion order — do NOT sort keys.
  const sendFailureJson = (req: ExpressRequest, res: ExpressResponse, body: unknown): void => {
    const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.json(body);
  };
  // Parse a ?before=<ISO-ts> upper-bound param. Returns 400 sentinel on NaN.
  const parseBeforeMs = (raw: unknown): { ok: true; ms?: number } | { ok: false } => {
    if (typeof raw !== 'string') return { ok: true, ms: undefined };
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? { ok: false } : { ok: true, ms };
  };

  router.get('/failures', (req, res) => {
    if (!ctx.failureLedger) { res.status(503).json({ error: 'failure-learning disabled' }); return; }
    const q = req.query;
    const before = parseBeforeMs(q.before);
    if (!before.ok) { res.status(400).json({ error: 'invalid before= (expected an ISO timestamp)' }); return; }
    const records = ctx.failureLedger.list({
      source: typeof q.source === 'string' ? (q.source as never) : undefined,
      category: typeof q.category === 'string' ? (q.category as never) : undefined,
      initiativeId: typeof q.initiativeId === 'string' ? q.initiativeId : undefined,
      attribution: q.attribution === 'automatic' || q.attribution === 'one-tap' || q.attribution === 'inferred' ? q.attribution : undefined,
      status: typeof q.status === 'string' ? (q.status as never) : undefined,
      beforeMs: before.ms,
      limit: typeof q.limit === 'string' && /^\d+$/.test(q.limit) ? Number(q.limit) : undefined,
    });
    sendFailureJson(req, res, { failures: records.map((r) => FailureLedger.toApiView(r)) });
  });

  router.get('/failures/analysis', (req, res) => {
    if (!ctx.failureLedger) { res.status(503).json({ error: 'failure-learning disabled' }); return; }
    const sinceDays = typeof req.query.sinceDays === 'string' ? Number(req.query.sinceDays) : undefined;
    const sinceMs = sinceDays && sinceDays > 0 ? Date.now() - sinceDays * 86400_000 : undefined;
    // rollout is assembled HERE (analyze() has no config access). Stage derives
    // from the two failureLearning booleans; the 4th "default-on" stage has no
    // per-agent flag and is never returned (tab renders it as a future step).
    const fl = ctx.config.monitoring?.failureLearning;
    const enabled = !!fl?.enabled;
    const insightTelegramEscalation = !!fl?.insightTelegramEscalation;
    const stage = !enabled ? 'dark' : insightTelegramEscalation ? 'insight-push' : 'capture-only';
    const rollout = { stage, enabled, insightTelegramEscalation };
    sendFailureJson(req, res, { ...ctx.failureLedger.analyze({ sinceMs }), rollout });
  });

  router.get('/failures/insights', (req, res) => {
    if (!ctx.failureLedger) { res.status(503).json({ error: 'failure-learning disabled' }); return; }
    const q = req.query;
    const before = parseBeforeMs(q.before);
    if (!before.ok) { res.status(400).json({ error: 'invalid before= (expected an ISO timestamp)' }); return; }
    const status = typeof q.status === 'string' ? q.status : undefined;
    const insights = ctx.failureLedger.listInsights({
      status: status ? (status as never) : undefined,
      beforeMs: before.ms,
      limit: typeof q.limit === 'string' && /^\d+$/.test(q.limit) ? Number(q.limit) : 50,
    });
    sendFailureJson(req, res, { insights });
  });

  // The analyzer + closed-loop tick (spec §4.4/§4.6.1). Invoked by the off-by-
  // default `failure-analyzer` builtin job (Tier-1 supervised). Discovers
  // insights, then — if the Evolution Action queue + InitiativeTracker are wired
  // — opens human-approved tracked items (by-construction guard: only Actions +
  // draft Initiatives, NEVER a proposal) and runs the verify step.
  router.post('/failures/analyze', async (req, res) => {
    if (!ctx.failureLedger) { res.status(503).json({ error: 'failure-learning disabled' }); return; }
    try {
      const gates = {
        minSupport: ctx.config.monitoring?.failureLearning?.minSupport ?? 4,
        minDistinctSessions: ctx.config.monitoring?.failureLearning?.minDistinctSessions ?? 3,
        minDistinctCauseCommits: ctx.config.monitoring?.failureLearning?.minDistinctCauseCommits ?? 3,
      };
      const analysis = new FailureAnalyzer(ctx.failureLedger, gates).analyze();

      let actedOn = 0;
      let verified = 0;
      const evo = ctx.evolution as { addAction?: (o: never) => { id: string } } | null;
      const tracker = ctx.initiativeTracker;
      if (evo?.addAction && tracker?.create) {
        const driver = new FailureLoopDriver(ctx.failureLedger, {
          addAction: (o) => evo.addAction!(o as never),
          createInitiative: async (i) => {
            const created = await tracker.create(i as never);
            return { id: created.id };
          },
        });
        actedOn = (await driver.actOnNewInsights()).actedOn.length;
        verified = driver.runVerification().evaluated.length;
      }
      res.json({ analysis, actedOn, verified });
    } catch (err) {
      // Fail-open: the analyzer never crashes the caller (job).
      res.status(200).json({ error: 'analyze failed (logged)', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/failures/:id', (req, res) => {
    if (!ctx.failureLedger) { res.status(503).json({ error: 'failure-learning disabled' }); return; }
    const rec = ctx.failureLedger.get(req.params.id);
    if (!rec) { res.status(404).json({ error: 'not found' }); return; }
    res.json(FailureLedger.toApiView(rec));
  });

  router.post('/failures', (req, res) => {
    if (!ctx.failureLedger) { res.status(503).json({ error: 'failure-learning disabled' }); return; }
    // Intent marker (§4.2#B) — NOT a transport boundary; paired with filedBy audit.
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'POST /failures requires the X-Instar-Request: 1 intent header' });
      return;
    }
    const body = req.body ?? {};
    const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    const initiativeId = typeof body.initiativeId === 'string' ? body.initiativeId.trim() : '';
    if (!summary || !initiativeId) {
      res.status(400).json({ error: 'summary and initiativeId are required' });
      return;
    }
    if (!ctx.failureAttributionEngine) {
      res.status(503).json({ error: 'attribution engine not configured' });
      return;
    }
    const verdict = ctx.failureAttributionEngine.validateAgentDiagnosed({
      initiativeId,
      causeCommitOid: typeof body.causeCommitOid === 'string' ? body.causeCommitOid : undefined,
    });
    if (!verdict.ok) { res.status(400).json({ error: verdict.reason }); return; }
    const severity = body.severity === 'low' || body.severity === 'high' ? body.severity : 'medium';
    const redacted = typeof body.detail === 'string' && body.detail ? body.detail : summary;
    const filedBy =
      (req.headers['x-instar-agentid'] as string) ||
      (req.headers['x-instar-session'] as string) ||
      'agent-diagnosed';
    const rec = ctx.failureLedger.open({
      filedBy,
      source: 'agent-diagnosed',
      severity,
      summary,
      detail: { redacted, full: redacted },
      category: FailureAttributionEngine.coerceCategory(typeof body.category === 'string' ? body.category : undefined),
      initiativeId: verdict.verdict.initiativeId,
      projectId: verdict.verdict.projectId,
      specPath: verdict.verdict.specPath,
      causeCommitOid: verdict.verdict.causeCommitOid,
      attribution: verdict.verdict.attribution, // one-tap — never upgrades (B6)
      attributionConfidence: verdict.verdict.attributionConfidence,
      provenance: 'unknown',
    });
    if (!rec) { res.status(500).json({ error: 'failed to record (logged via fail-open path)' }); return; }
    res.status(201).json(FailureLedger.toApiView(rec));
  });

  // ── Jobs ────────────────────────────────────────────────────────

  router.get('/jobs', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ jobs: [], scheduler: null });
      return;
    }

    const nextRunTimes = ctx.scheduler.getNextRunTimes();
    const jobs = ctx.scheduler.getJobs().map(job => {
      const jobState = ctx.state.getJobState(job.slug);
      // Merge live scheduler nextRun into state — fixes display bug where
      // never-run jobs show as "unscheduled" despite having active cron tasks
      const liveNext = nextRunTimes[job.slug];
      const mergedState = jobState
        ? { ...jobState, nextScheduled: jobState.nextScheduled ?? liveNext }
        : liveNext ? { slug: job.slug, lastRun: null, lastResult: null, nextScheduled: liveNext, consecutiveFailures: 0 } : null;
      return { ...job, state: mergedState, runsOnThisMachine: ctx.scheduler!.isJobLocal(job.slug) };
    });

    res.json({ jobs, queue: ctx.scheduler.getQueue() });
  });

  // ── Category Overseer Reports ────────────────────────────────────
  // These MUST be registered before /jobs/:slug routes to avoid Express
  // matching "categories" and "category-report" as :slug params.

  /**
   * GET /jobs/categories
   * List all unique category tags and their job counts.
   */
  router.get('/jobs/categories', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ categories: {} });
      return;
    }

    const allJobs = ctx.scheduler.getJobs();
    const categories: Record<string, string[]> = {};

    for (const job of allJobs) {
      for (const tag of job.tags ?? []) {
        if (tag.startsWith('cat:')) {
          const cat = tag.slice(4);
          if (!categories[cat]) categories[cat] = [];
          categories[cat].push(job.slug);
        }
      }
    }

    res.json({ categories });
  });

  /**
   * GET /jobs/category-report/:category
   * Aggregates run history, skip data, handoff notes, and health for all jobs
   * matching the given category tag. Used by overseer jobs to review their domain.
   */
  router.get('/jobs/category-report/:category', (req, res) => {
    const category = req.params.category;
    if (!category || !/^[a-z][a-z0-9-]{0,31}$/.test(category)) {
      res.status(400).json({ error: 'Invalid category name' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const sinceHours = parseInt(req.query.sinceHours as string) || 24;
    const allJobs = ctx.scheduler.getJobs();
    const history = ctx.scheduler.getRunHistory();
    const skipLedger = ctx.scheduler.getSkipLedger();

    // Find jobs matching this category (tag starts with "cat:" or exact match)
    const categoryTag = `cat:${category}`;
    const matchingJobs = allJobs.filter(j =>
      j.tags?.includes(categoryTag) || j.tags?.includes(category)
    );

    if (matchingJobs.length === 0) {
      res.json({ category, jobs: [], summary: { totalJobs: 0, healthy: 0, failing: 0, skipping: 0 } });
      return;
    }

    const jobReports = matchingJobs.map(job => {
      const jobState = ctx.state.getJobState(job.slug);
      const stats = history.stats(job.slug, sinceHours);
      const lastHandoff = history.getLastHandoff(job.slug);
      const skipSummary = skipLedger.getSkipSummary(sinceHours);
      const jobSkips = skipSummary[job.slug] || { total: 0, byReason: {} };
      const workloadTrend = skipLedger.getWorkloadTrend(job.slug);

      // Recent runs (last 5)
      const recentRuns = history.query({ slug: job.slug, limit: 5 }).runs.map(r => ({
        runId: r.runId,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        result: r.result,
        durationSeconds: r.durationSeconds,
        model: r.model,
        error: r.error,
      }));

      return {
        slug: job.slug,
        name: job.name,
        enabled: job.enabled,
        priority: job.priority,
        model: job.model,
        schedule: job.schedule,
        tags: job.tags,
        state: {
          lastRun: jobState?.lastRun,
          lastResult: jobState?.lastResult,
          consecutiveFailures: jobState?.consecutiveFailures ?? 0,
        },
        stats: stats ? {
          totalRuns: stats.totalRuns,
          successes: stats.successes,
          failures: stats.failures,
          successRate: stats.successRate,
          avgDurationSeconds: stats.avgDurationSeconds,
          runsPerDay: stats.runsPerDay,
        } : null,
        skips: {
          total: jobSkips.total,
          byReason: jobSkips.byReason,
        },
        workloadTrend: workloadTrend ? {
          avgSaturation: workloadTrend.avgSaturation,
          skipFastRate: workloadTrend.skipFastRate,
          avgDuration: workloadTrend.avgDuration,
          runCount: workloadTrend.runCount,
        } : null,
        lastHandoff: lastHandoff ? {
          notes: lastHandoff.handoffNotes,
          from: lastHandoff.completedAt,
        } : null,
        recentRuns,
      };
    });

    // Compute summary
    const healthy = jobReports.filter(j => j.state.consecutiveFailures === 0 && j.enabled).length;
    const failing = jobReports.filter(j => j.state.consecutiveFailures > 0).length;
    const skipping = jobReports.filter(j => j.skips.total > 0).length;
    const disabled = jobReports.filter(j => !j.enabled).length;
    const totalRuns = jobReports.reduce((sum, j) => sum + (j.stats?.totalRuns ?? 0), 0);
    const totalFailures = jobReports.reduce((sum, j) => sum + (j.stats?.failures ?? 0), 0);
    const avgSuccessRate = jobReports.length > 0
      ? jobReports.reduce((sum, j) => sum + (j.stats?.successRate ?? 100), 0) / jobReports.length
      : 100;

    res.json({
      category,
      sinceHours,
      generatedAt: new Date().toISOString(),
      summary: {
        totalJobs: matchingJobs.length,
        healthy,
        failing,
        skipping,
        disabled,
        totalRuns,
        totalFailures,
        avgSuccessRate: Math.round(avgSuccessRate * 10) / 10,
      },
      jobs: jobReports,
    });
  });

  /**
   * GET /jobs/migration-status
   * Phase 4 — surface the jobs-as-agentmd migration state so the Dashboard
   * can render the "Confirm migration complete" / "Roll back" buttons.
   *
   * Returns:
   *   - hasLegacyJobsJson: boolean (whether .instar/jobs.json exists)
   *   - hasMigrationComplete: boolean
   *   - hasMigrationAbandoned: boolean
   *   - canConfirm: boolean (legacy + schedule/ exist, no marker)
   *   - canAbandon: boolean (schedule/ exists, no completion marker)
   *   - scheduleEntryCount: number
   */
  /**
   * GET /jobs/reconcile
   *
   * Boot-time consistency check for the agentmd job tree. Surfaces
   * orphan manifests, shadow .md files, missing-from-jobs.json entries,
   * staged .new files from interrupted saves, and case-collisions per
   * INSTAR-JOBS-AS-AGENTMD spec §Runtime "Load lifecycle (boot)".
   *
   * Dashboard Issues-card consumes the returned `findings` array.
   */
  router.get('/jobs/reconcile', async (_req, res) => {
    try {
      const stateDir = ctx.config.stateDir;
      if (!stateDir) {
        res.status(503).json({ error: 'state dir not configured' });
        return;
      }
      const { reconcileAgentMdTree } = await import('../scheduler/AgentMdReconcile.js');
      const report = reconcileAgentMdTree({ stateDir });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/jobs/migration-status', (_req, res) => {
    try {
      const stateDir = ctx.config.stateDir;
      if (!stateDir) {
        res.status(503).json({ error: 'state dir not configured' });
        return;
      }
      const jobsJson = path.join(stateDir, 'jobs.json');
      const jobsRoot = path.join(stateDir, 'jobs');
      const scheduleDir = path.join(jobsRoot, 'schedule');
      const completed = path.join(jobsRoot, '.migration-complete.json');
      const abandoned = path.join(jobsRoot, '.migration-abandoned.json');
      const hasLegacyJobsJson = fs.existsSync(jobsJson);
      const hasMigrationComplete = fs.existsSync(completed);
      const hasMigrationAbandoned = fs.existsSync(abandoned);
      let scheduleEntryCount = 0;
      if (fs.existsSync(scheduleDir)) {
        scheduleEntryCount = fs.readdirSync(scheduleDir).filter((f) => f.endsWith('.json')).length;
      }
      res.json({
        hasLegacyJobsJson,
        hasMigrationComplete,
        hasMigrationAbandoned,
        canConfirm: hasLegacyJobsJson && scheduleEntryCount > 0 && !hasMigrationComplete && !hasMigrationAbandoned,
        canAbandon: scheduleEntryCount > 0 && !hasMigrationComplete && !hasMigrationAbandoned,
        scheduleEntryCount,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * POST /jobs/migration-confirm
   * Phase 4 — operator confirms migration is complete. Writes
   * .instar/jobs/.migration-complete.json which the release-cut gate
   * consumes to allow jobs.json deletion.
   *
   * Idempotent — re-confirming is a no-op.
   */
  router.post('/jobs/migration-confirm', (_req, res) => {
    try {
      const stateDir = ctx.config.stateDir;
      if (!stateDir) {
        res.status(503).json({ error: 'state dir not configured' });
        return;
      }
      const jobsRoot = path.join(stateDir, 'jobs');
      const completed = path.join(jobsRoot, '.migration-complete.json');
      const abandoned = path.join(jobsRoot, '.migration-abandoned.json');
      if (fs.existsSync(abandoned)) {
        res.status(409).json({ error: 'Migration has been abandoned; cannot confirm. Run `instar job migrate` first.' });
        return;
      }
      fs.mkdirSync(jobsRoot, { recursive: true });
      fs.writeFileSync(
        completed,
        JSON.stringify({ confirmedAt: new Date().toISOString(), confirmedBy: 'dashboard' }, null, 2),
        'utf-8',
      );
      res.json({ ok: true, marker: completed });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * POST /jobs/migration-abandon
   * Phase 4 — operator rolls back migration. Invokes
   * `jobsMigrate({ abandon: true })` to remove `.instar/jobs/schedule/`,
   * write `.migration-abandoned.json`, and leave `jobs.json` intact.
   */
  router.post('/jobs/migration-abandon', async (_req, res) => {
    try {
      const stateDir = ctx.config.stateDir;
      if (!stateDir) {
        res.status(503).json({ error: 'state dir not configured' });
        return;
      }
      const { jobsMigrate } = await import('../commands/jobMigrate.js');
      const packageRoot = path.resolve(__dirname, '..', '..');
      const outcome = jobsMigrate({ agentStateDir: stateDir, packageRoot, abandon: true });
      res.json(outcome);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/jobs/:slug/trigger', async (req, res) => {
    if (!JOB_SLUG_RE.test(req.params.slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const rawReason = (req.body?.reason as string) || 'manual';
    const reason = typeof rawReason === 'string' ? rawReason.slice(0, 500) : 'manual';

    try {
      const result = await ctx.scheduler.triggerJob(req.params.slug, reason);
      res.json({ slug: req.params.slug, result });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Manual Job Trigger (Dashboard) ─────────────────────────────
  //
  // Rate-limited manual job trigger with security logging.
  // Used by the dashboard — stricter than /jobs/:slug/trigger.

  const manualTriggerLastRun = new Map<string, number>();
  let manualTriggerConcurrent = 0;
  const MANUAL_TRIGGER_MAX_CONCURRENT = 5;

  router.post('/jobs/:slug/run', async (req, res) => {
    const { slug } = req.params;

    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const job = ctx.scheduler.getJobs().find(j => j.slug === slug);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${slug}` });
      return;
    }

    const jobState = ctx.state.getJobState(slug);
    if (jobState?.lastResult === 'pending') {
      res.status(409).json({ error: 'Job is already running' });
      return;
    }

    // Rate limit: minimum interval based on job's expected duration (in ms)
    const minIntervalMs = (job.expectedDurationMinutes ?? 5) * 60 * 1000;
    const lastTrigger = manualTriggerLastRun.get(slug);
    if (lastTrigger && Date.now() - lastTrigger < minIntervalMs) {
      const retryAfterSec = Math.ceil((minIntervalMs - (Date.now() - lastTrigger)) / 1000);
      res.status(429).json({
        error: 'Too soon — job was manually triggered recently',
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    // Global concurrency cap
    if (manualTriggerConcurrent >= MANUAL_TRIGGER_MAX_CONCURRENT) {
      res.status(429).json({ error: 'Too many concurrent manual triggers' });
      return;
    }

    try {
      manualTriggerConcurrent++;
      manualTriggerLastRun.set(slug, Date.now());

      const result = await ctx.scheduler.triggerJob(slug, 'dashboard-manual');
      const runId = `manual-${slug}-${Date.now().toString(36)}`;

      // Decrement concurrent counter after a reasonable time
      // (the job itself is tracked by the scheduler, this just gates manual triggers)
      setTimeout(() => { manualTriggerConcurrent = Math.max(0, manualTriggerConcurrent - 1); }, 5000);

      // Security log
      try {
        const securityEntry = JSON.stringify({
          timestamp: new Date().toISOString(),
          action: 'job-run',
          slug,
          source: 'dashboard',
          ip: req.ip,
          result,
        });
        fs.appendFileSync(path.join(ctx.config.stateDir, 'security.jsonl'), securityEntry + '\n');
      } catch {
        // Security logging failure is non-fatal
      }

      res.status(202).json({ status: 'accepted', runId, result, message: 'Job queued for execution' });
    } catch (err) {
      manualTriggerConcurrent = Math.max(0, manualTriggerConcurrent - 1);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Job Enable/Disable (Dashboard) ────────────────────────────

  router.patch('/jobs/:slug', (req, res) => {
    const { slug } = req.params;

    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    // Allow-list: only { enabled: boolean } is accepted
    const body = req.body;
    const allowedKeys = ['enabled'];
    const bodyKeys = Object.keys(body || {});
    if (bodyKeys.length === 0 || bodyKeys.some(k => !allowedKeys.includes(k))) {
      res.status(400).json({ error: 'Only { enabled: boolean } is accepted' });
      return;
    }
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: '"enabled" must be a boolean' });
      return;
    }

    const job = ctx.scheduler.getJobs().find(j => j.slug === slug);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${slug}` });
      return;
    }

    // Update the job's enabled state in the jobs.json config file
    try {
      const jobsFile = ctx.config.scheduler.jobsFile ?? path.join(ctx.config.stateDir, '..', 'jobs.json');
      if (fs.existsSync(jobsFile)) {
        const jobsData = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
        const jobEntry = (jobsData.jobs || jobsData).find((j: { slug: string }) => j.slug === slug);
        if (jobEntry) {
          jobEntry.enabled = body.enabled;
          fs.writeFileSync(jobsFile, JSON.stringify(jobsData, null, 2) + '\n');
        }
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to update job config: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Security log
    try {
      const securityEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'job-toggle',
        slug,
        enabled: body.enabled,
        source: 'dashboard',
        ip: req.ip,
      });
      fs.appendFileSync(path.join(ctx.config.stateDir, 'security.jsonl'), securityEntry + '\n');
    } catch {
      // Security logging failure is non-fatal
    }

    res.json({ slug, enabled: body.enabled, message: `Job ${body.enabled ? 'enabled' : 'disabled'}` });
  });

  // ── Reset Job State ───────────────────────────────────────────
  //
  // Clears stale pending/failure state for a job. Useful when a session dies
  // without reporting back, leaving lastResult stuck on 'pending' forever.

  router.post('/jobs/:slug/reset-state', (req, res) => {
    const { slug } = req.params;

    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const job = ctx.scheduler.getJobs().find(j => j.slug === slug);
    if (!job) {
      res.status(404).json({ error: `Job not found: ${slug}` });
      return;
    }

    const existing = ctx.state.getJobState(slug);
    const previousResult = existing?.lastResult ?? 'none';

    const resetState: import('../core/types.js').JobState = {
      slug,
      lastRun: existing?.lastRun,
      lastResult: 'failure',
      lastError: `Manually reset from '${previousResult}' state`,
      lastHandoff: existing?.lastHandoff,
      nextScheduled: existing?.nextScheduled,
      consecutiveFailures: 0,
    };
    ctx.state.saveJobState(resetState);

    ctx.state.appendEvent({
      type: 'job_state_reset',
      summary: `Job "${slug}" state manually reset from '${previousResult}'`,
      timestamp: new Date().toISOString(),
      metadata: { slug, previousResult },
    });

    // Security log
    try {
      const securityEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'job-reset-state',
        slug,
        previousResult,
        source: req.body?.source ?? 'api',
        ip: req.ip,
      });
      fs.appendFileSync(path.join(ctx.config.stateDir, 'security.jsonl'), securityEntry + '\n');
    } catch {
      // Security logging failure is non-fatal
    }

    res.json({
      slug,
      previousResult,
      newResult: 'failure',
      message: `Job state reset from '${previousResult}' to 'failure'. Job can now be re-triggered.`,
    });
  });

  // ── Job Events (SSE) ──────────────────────────────────────────
  //
  // Server-Sent Events stream for real-time job state changes.
  // Auth checked inline since SSE connections don't go through normal middleware cleanly.

  router.get('/jobs/events', (req, res) => {
    // Inline auth check for SSE — supports both Authorization header and ?token= query param
    // (EventSource API cannot send custom headers, so token in query is required for browser SSE)
    if (ctx.config.authToken) {
      let tokenValue: string | undefined;
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        tokenValue = header.slice(7);
      } else if (typeof req.query.token === 'string') {
        tokenValue = req.query.token;
      }
      if (!tokenValue) {
        res.status(401).json({ error: 'Missing Authorization header or token query param' });
        return;
      }
      const ha = createHash('sha256').update(tokenValue).digest();
      const hb = createHash('sha256').update(ctx.config.authToken).digest();
      if (!timingSafeEqual(ha, hb)) {
        res.status(403).json({ error: 'Invalid token' });
        return;
      }
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let eventId = 0;

    // Send retry directive on first message
    res.write(`retry: 1000\n\n`);

    // Heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      eventId++;
      res.write(`id: ${eventId}\nevent: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15_000);

    // Send initial state snapshot
    if (ctx.scheduler) {
      eventId++;
      const jobs = ctx.scheduler.getJobs().map(job => {
        const jobState = ctx.state.getJobState(job.slug);
        return { slug: job.slug, name: job.name, enabled: job.enabled, state: jobState };
      });
      res.write(`id: ${eventId}\nevent: snapshot\ndata: ${JSON.stringify({ jobs, ts: Date.now() })}\n\n`);
    }

    // Poll for job state changes every 5 seconds and emit deltas
    let lastStates = new Map<string, string>();
    if (ctx.scheduler) {
      for (const job of ctx.scheduler.getJobs()) {
        const st = ctx.state.getJobState(job.slug);
        if (st) lastStates.set(job.slug, JSON.stringify(st));
      }
    }

    const poller = setInterval(() => {
      if (!ctx.scheduler) return;
      for (const job of ctx.scheduler.getJobs()) {
        const st = ctx.state.getJobState(job.slug);
        const stStr = st ? JSON.stringify(st) : '';
        const prev = lastStates.get(job.slug) ?? '';
        if (stStr !== prev) {
          lastStates.set(job.slug, stStr);
          eventId++;
          res.write(`id: ${eventId}\nevent: job-state\ndata: ${JSON.stringify({ slug: job.slug, state: st, ts: Date.now() })}\n\n`);
        }
      }
    }, 5_000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(poller);
    });
  });

  // ── Job Run History ─────────────────────────────────────────────

  router.get('/jobs/history', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ runs: [], total: 0, stats: [] });
      return;
    }

    const history = ctx.scheduler.getRunHistory();
    const sinceHours = parseInt(_req.query.sinceHours as string) || undefined;
    const result = _req.query.result as string | undefined;
    const slug = _req.query.slug as string | undefined;
    const limit = Math.min(parseInt(_req.query.limit as string) || 50, 500);
    const offset = parseInt(_req.query.offset as string) || 0;

    if (slug && !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }

    const validResults = ['pending', 'success', 'failure', 'timeout', 'spawn-error'];
    const resultFilter = result && validResults.includes(result) ? result as 'success' | 'failure' | 'timeout' | 'spawn-error' | 'pending' : undefined;

    const data = history.query({ slug, sinceHours, result: resultFilter, limit, offset });
    const stats = slug ? history.stats(slug, sinceHours) : history.allStats(sinceHours);

    res.json({ ...data, stats });
  });

  router.get('/jobs/:slug/history', (req, res) => {
    if (!JOB_SLUG_RE.test(req.params.slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }
    if (!ctx.scheduler) {
      res.json({ runs: [], total: 0, stats: null });
      return;
    }

    const history = ctx.scheduler.getRunHistory();
    const slug = req.params.slug;
    const sinceHours = parseInt(req.query.sinceHours as string) || undefined;
    const result = req.query.result as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;

    const validResults = ['pending', 'success', 'failure', 'timeout', 'spawn-error'];
    const resultFilter = result && validResults.includes(result) ? result as 'success' | 'failure' | 'timeout' | 'spawn-error' | 'pending' : undefined;

    const data = history.query({ slug, sinceHours, result: resultFilter, limit, offset });
    const stats = history.stats(slug, sinceHours);

    res.json({ ...data, stats });
  });

  // ── Skip Ledger ──────────────────────────────────────────────────

  router.get('/skip-ledger', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ sinceHours: 24, summary: {}, totalSkips: 0 });
      return;
    }

    const ledger = ctx.scheduler.getSkipLedger();
    const sinceHours = parseInt(_req.query.sinceHours as string) || 24;
    const slug = _req.query.slug as string | undefined;

    if (slug && !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }

    const summary = ledger.getSkipSummary(sinceHours);
    const events = ledger.getSkips({ slug, sinceHours });

    res.json({
      sinceHours,
      summary,
      events: slug ? events : undefined,
      totalSkips: events.length,
    });
  });

  router.get('/skip-ledger/workloads', (_req, res) => {
    if (!ctx.scheduler) {
      res.json({ trends: {} });
      return;
    }

    const ledger = ctx.scheduler.getSkipLedger();
    const slug = _req.query.slug as string | undefined;

    if (slug && !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: 'Invalid job slug' });
      return;
    }

    if (slug) {
      const trend = ledger.getWorkloadTrend(slug);
      const signals = ledger.getWorkloads({ slug, limit: 20 });
      res.json({ slug, trend, recentSignals: signals });
    } else {
      const jobs = ctx.scheduler.getJobs();
      const trends: Record<string, ReturnType<typeof ledger.getWorkloadTrend>> = {};
      for (const job of jobs) {
        trends[job.slug] = ledger.getWorkloadTrend(job.slug);
      }
      res.json({ trends });
    }
  });

  router.post('/skip-ledger/workload', (req, res) => {
    if (!ctx.scheduler) {
      res.status(503).json({ error: 'Scheduler not running' });
      return;
    }

    const { slug, duration, skipFast, itemsFound, itemsProcessed, saturation, notes } = req.body;

    if (!slug || typeof slug !== 'string' || !JOB_SLUG_RE.test(slug)) {
      res.status(400).json({ error: '"slug" must be a valid job slug' });
      return;
    }
    if (typeof duration !== 'number' || duration < 0) {
      res.status(400).json({ error: '"duration" must be a non-negative number (seconds)' });
      return;
    }
    if (typeof itemsFound !== 'number' || typeof itemsProcessed !== 'number') {
      res.status(400).json({ error: '"itemsFound" and "itemsProcessed" must be numbers' });
      return;
    }

    const ledger = ctx.scheduler.getSkipLedger();
    ledger.recordWorkload({
      slug,
      timestamp: new Date().toISOString(),
      duration,
      skipFast: !!skipFast,
      itemsFound,
      itemsProcessed,
      saturation: typeof saturation === 'number' ? saturation : (itemsFound > 0 ? itemsProcessed / itemsFound : 0),
      notes: typeof notes === 'string' ? notes.slice(0, 500) : undefined,
    });

    res.status(201).json({ recorded: true, slug });
  });

  // ── Telegram ────────────────────────────────────────────────────

  router.get('/telegram/topics', (_req, res) => {
    if (!ctx.telegram) {
      res.json({ topics: [] });
      return;
    }
    res.json({ topics: ctx.telegram.getAllTopicMappings() });
  });

  router.post('/telegram/topics', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const { name, color, firstMessage } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      res.status(400).json({ error: '"name" is required (non-empty string)' });
      return;
    }
    if (name.length > 128) {
      res.status(400).json({ error: '"name" must be 128 characters or fewer' });
      return;
    }
    if (firstMessage !== undefined && (typeof firstMessage !== 'string' || firstMessage.length > 4096)) {
      res.status(400).json({ error: '"firstMessage" must be a string of 4096 characters or fewer' });
      return;
    }

    // Color is optional — defaults to green (9367192)
    const iconColor = typeof color === 'number' ? color : 9367192;

    try {
      const topic = await ctx.telegram.findOrCreateForumTopic(name.trim(), iconColor);

      // Send initial message if provided — goes through sendToTopic so it's
      // properly logged to JSONL + TopicMemory. This ensures new sessions
      // spawned in this topic will see the context in their thread history.
      let messageSent = false;
      if (firstMessage && !topic.reused) {
        await ctx.telegram.sendToTopic(topic.topicId, firstMessage);
        messageSent = true;
      }

      res.status(topic.reused ? 200 : 201).json({
        topicId: topic.topicId,
        name: name.trim(),
        created: !topic.reused,
        reused: topic.reused,
        messageSent,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/telegram/reply/:topicId', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    const { text, metadata } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }
    if (text.length > 4096) {
      res.status(400).json({ error: '"text" must be 4096 characters or fewer' });
      return;
    }

    // ── X-Instar-DeliveryId server-side dedup (Layer 3 spec §3d step 4) ──
    // 24h LRU keyed on the header value. A duplicate POST with the same
    // delivery_id returns 200 idempotent without sending again. This
    // closes the "200-but-client-blind" double-send class where the
    // sentinel re-sends a queued message that actually landed the first
    // time but the script-side response was lost.
    const deliveryIdHeader = req.headers['x-instar-deliveryid'];
    const deliveryId = Array.isArray(deliveryIdHeader) ? deliveryIdHeader[0] : deliveryIdHeader;
    if (deliveryId && typeof deliveryId === 'string' && /^[0-9a-f-]{16,64}$/i.test(deliveryId)) {
      if (deliveryLruHas(deliveryId)) {
        res.json({ ok: true, topicId, idempotent: true });
        return;
      }
    }

    // ── X-Instar-System bypass (Layer 3 spec §3f) ──
    // For sentinel-emitted templates, bypass the tone gate IF the body
    // matches a known system template. The bypass is deliberately
    // restricted to fixed templates whose content was reviewed at
    // code-review time. Membership check uses regex / SHA-256 against
    // the compiled-in template set; arbitrary text fails through to the
    // normal gate.
    const systemHeader = req.headers['x-instar-system'];
    const systemFlag = Array.isArray(systemHeader) ? systemHeader[0] : systemHeader;
    const isSystemTemplate = systemFlag === 'true' && matchesSystemTemplate(text);

    // Outbound gate — single authority. Skipped for proxy messages (PresenceProxy
    // etc. are system-generated). The authority receives structured signals from
    // the junk-payload and dedup detectors alongside conversational context, and
    // makes ONE block/allow decision with reasoning traceable to rule ids B1–B9.
    // See docs/signal-vs-authority.md.
    const isProxy = metadata?.isProxy === true;
    const allowDebugText = metadata?.allowDebugText === true;
    const allowDuplicate = metadata?.allowDuplicate === true;
    // Skip the LOCAL tone gate when this server will RELAY the reply through the
    // lease holder (a tokenless pool standby). The holder runs ITS OWN tone gate
    // on receipt, so the standby gating too is redundant — and worse, it adds a
    // serial LLM call to every cross-machine reply that, under a rate-limited
    // circuit, can wait up to 120s (MessagingToneGate rateLimitWaitMs) BEFORE the
    // relay even starts (observed: the standby's /telegram/reply hung >50s before
    // relaying). The holder is the single Telegram owner and the correct place to
    // gate. (Direct, non-relay sends still gate locally — unchanged.)
    const willRelay = typeof ctx.telegram.willRelay === 'function' && ctx.telegram.willRelay();
    if (
      !isProxy &&
      !isSystemTemplate &&
      !willRelay &&
      (await checkOutboundMessage(text, 'telegram', res, {
        topicId,
        allowDebugText,
        allowDuplicate,
      }))
    )
      return;

    try {
      // Capture the SendResult so the response can carry the REAL Telegram
      // messageId. A tokenless-standby relay reads this messageId to decide
      // whether the reply actually landed — without it the relay could only
      // ever return a placeholder 0 and so reported "ok" even when nothing was
      // delivered (the false-success-under-load class).
      const sendResult = await ctx.telegram.sendToTopic(topicId, text, { skipStallClear: isProxy });
      // Clear injection tracker — but NOT for proxy messages (PresenceProxy)
      // Proxy messages should not reset stall detection timers
      if (!isProxy) {
        ctx.sessionManager.clearInjectionTracker(topicId);
      }
      // ── Usher precision, path (a): the agent's genuine reply just went out. If
      // it actually USED a faded context the Usher re-surfaced for this topic,
      // mark that signal acted — the precision numerator that gates rung-5
      // mid-task injection. Proxy/system templates aren't the agent reasoning, so
      // they can't "use" a nudge and are excluded. Best-effort (never throws).
      if (!isProxy && !isSystemTemplate) {
        const credited = creditUsherOnOutbound(ctx.usherSignalStore, topicId, text);
        if (credited.length) {
          console.log(`[Usher] ${credited.length} signal(s) marked acted (use) on topic ${topicId}`);
        }
      }
      // ── Exactly-once ingress: commit reply_committed (spec §8 G3a) ──
      // The agent's real reply just went out → mark the inbound event this topic
      // is processing as answered, so a provider redelivery or handoff-window
      // replay of that same inbound is dropped by the gate above. Skipped for
      // proxy/system sends (they aren't replies to a user inbound). FAIL-OPEN.
      if (!isProxy && ctx.messageLedger && ctx.currentInboundByTopic) {
        try {
          const dedupeKey = ctx.currentInboundByTopic.get(String(topicId));
          if (dedupeKey) {
            const epoch = ctx.coordinator?.getLeaseEpoch() ?? 0;
            commitInboundReply(ctx.messageLedger, dedupeKey, epoch);
            ctx.currentInboundByTopic.delete(String(topicId));
            // Cross-machine half (spec §8 G3a): tell standby peers this event was
            // answered, so a post-handoff redelivery is deduped on the new holder.
            // Best-effort, fire-and-forget — the dedup gate + provider redelivery
            // are the backstop if a marker is lost.
            const entry = ctx.messageLedger.get(dedupeKey);
            if (ctx.replyMarkerTransport && entry?.replyIdempotencyKey) {
              void ctx.replyMarkerTransport.broadcast({
                dedupeKey,
                platform: 'telegram',
                replyIdempotencyKey: entry.replyIdempotencyKey,
                epoch,
                topic: String(topicId),
              });
            }
          }
        } catch (err) {
          console.error(`[telegram/reply] exactly-once commit error (non-fatal): ${err instanceof Error ? err.message : err}`);
        }
      }
      // Record successful delivery in the dedup LRU so a sentinel retry
      // with the same delivery_id returns 200-idempotent.
      if (deliveryId && typeof deliveryId === 'string' && /^[0-9a-f-]{16,64}$/i.test(deliveryId)) {
        deliveryLruRecord(deliveryId);
      }
      res.json({ ok: true, topicId, messageId: sendResult?.messageId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /delivery-queue (Layer 3 spec §3i) ──
  // Authed read-only view of the pending-relay queue depth/oldest age
  // for the current agent. Used by the dashboard "Pending Replies" panel
  // and ops health checks. Read-only: never mutates queue rows.
  router.get('/delivery-queue', (_req, res) => {
    const stateDir = ctx.config.stateDir;
    const agentId = ctx.config.projectName;
    if (!stateDir || !agentId) {
      res.status(503).json({ error: 'state directory or agent id not configured' });
      return;
    }
    const dbPath = resolvePendingRelayPath(stateDir, agentId);
    let db: import('better-sqlite3').Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const totalRow = db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
      const total = totalRow?.n ?? 0;
      const byState = db.prepare(
        'SELECT state, COUNT(*) AS n FROM entries GROUP BY state',
      ).all() as Array<{ state: string; n: number }>;
      const oldestRow = db.prepare(
        "SELECT MIN(attempted_at) AS oldest FROM entries WHERE state IN ('queued','claimed')",
      ).get() as { oldest: string | null };
      const oldestAgeSeconds = oldestRow?.oldest
        ? Math.max(0, Math.floor((Date.now() - Date.parse(oldestRow.oldest)) / 1000))
        : 0;
      res.json({
        depth: total,
        oldest_age_seconds: oldestAgeSeconds,
        by_state: Object.fromEntries(byState.map((r) => [r.state, r.n])),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Missing-file is a normal "no queue yet" state — return zeros, not 500.
      if (/unable to open|no such file|does not exist|cannot open/i.test(msg)) {
        res.json({ depth: 0, oldest_age_seconds: 0, by_state: {} });
        return;
      }
      res.status(500).json({ error: msg });
    } finally {
      if (db) {
        try { db.close(); } catch { /* best-effort */ }
      }
    }
  });

  // POST /build/heartbeat — /build pipeline status relay.
  //
  // BUILD-STALL-VISIBILITY-SPEC Fix 2. The /build skill / build-state.py calls
  // this on phase transitions (and optionally from a server-side cadence tick)
  // so the user sees signs of life during long-running tool waits.
  //
  // Content shape is locked: enumerated phase + allowlisted tool + elapsed.
  // No free-form agent prose, no argv, no paths — the caller cannot smuggle
  // sensitive content through this endpoint. The message goes out as a proxy
  // class (isProxy: true), which bypasses the outbound tone/dedup gates on
  // purpose: there's nothing free-form to judge in an enumerated template.
  //
  // The dispatch also records the heartbeat in ProxyCoordinator so
  // PresenceProxy suppresses its generic Tier 2/3 standby for the same
  // topic within the suppression window (one progress voice per channel).
  {
    const HEARTBEAT_PHASES = new Set([
      'idle', 'clarify', 'planning', 'executing',
      'verifying', 'fixing', 'hardening', 'complete', 'failed', 'escalated',
    ]);
    const HEARTBEAT_TOOLS = new Set([
      'Monitor', 'Bash-test', 'Bash-tsc', 'Bash-install',
      'Bash-lint', 'Bash-other', 'none',
    ]);
    const HEARTBEAT_STATUSES = new Set(['still-working', 'no-progress-detected', 'phase-boundary']);
    const RUNID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

    router.post('/build/heartbeat', async (req, res) => {
      const body = req.body as {
        runId?: unknown;
        phase?: unknown;
        topicId?: unknown;
        channelId?: unknown;
        tool?: unknown;
        elapsedMs?: unknown;
        status?: unknown;
      };

      const runId = typeof body.runId === 'string' ? body.runId : '';
      if (!RUNID_RE.test(runId)) {
        res.status(400).json({ error: '"runId" must match /^[a-zA-Z0-9_-]{1,64}$/' });
        return;
      }
      const phase = typeof body.phase === 'string' ? body.phase : '';
      if (!HEARTBEAT_PHASES.has(phase)) {
        res.status(400).json({ error: `"phase" must be one of: ${[...HEARTBEAT_PHASES].join(', ')}` });
        return;
      }
      const tool = typeof body.tool === 'string' ? body.tool : 'none';
      if (!HEARTBEAT_TOOLS.has(tool)) {
        res.status(400).json({ error: `"tool" must be one of: ${[...HEARTBEAT_TOOLS].join(', ')}` });
        return;
      }
      const status = typeof body.status === 'string' ? body.status : 'phase-boundary';
      if (!HEARTBEAT_STATUSES.has(status)) {
        res.status(400).json({ error: `"status" must be one of: ${[...HEARTBEAT_STATUSES].join(', ')}` });
        return;
      }
      const elapsedMs = typeof body.elapsedMs === 'number' && Number.isFinite(body.elapsedMs) && body.elapsedMs >= 0 && body.elapsedMs < 86_400_000
        ? Math.floor(body.elapsedMs)
        : 0;

      // Route by topicId (Telegram) or channelId (Slack). Exactly one must be set.
      const topicId = typeof body.topicId === 'number' && Number.isInteger(body.topicId) ? body.topicId : null;
      const channelId = typeof body.channelId === 'string' && body.channelId.length > 0 && body.channelId.length <= 128
        ? body.channelId
        : null;
      if ((topicId === null) === (channelId === null)) {
        res.status(400).json({ error: 'Exactly one of "topicId" (number) or "channelId" (string) must be provided' });
        return;
      }

      const elapsedMin = Math.floor(elapsedMs / 60_000);
      const elapsedStr = elapsedMin >= 1 ? `${elapsedMin}m` : `${Math.floor(elapsedMs / 1000)}s`;
      const text = `🔨 /build — phase=${phase}, tool=${tool}, elapsed=${elapsedStr}, status=${status}`;

      try {
        if (topicId !== null) {
          if (!ctx.telegram) {
            res.status(503).json({ error: 'Telegram not configured' });
            return;
          }
          await ctx.telegram.sendToTopic(topicId, text, { skipStallClear: true });
          ctx.proxyCoordinator?.recordBuildHeartbeat(topicId);
        } else if (channelId !== null) {
          if (!ctx.slack) {
            res.status(503).json({ error: 'Slack not configured' });
            return;
          }
          await ctx.slack.sendToChannel(channelId, text);
          // Slack uses synthetic negative topic IDs internally; compute the same
          // hash used by server.ts:slackChannelToSyntheticId so PresenceProxy's
          // Slack path sees the same suppression signal.
          let hash = 0;
          for (let i = 0; i < channelId.length; i++) {
            hash = ((hash << 5) - hash + channelId.charCodeAt(i)) | 0;
          }
          const synthetic = -(Math.abs(hash) + 1);
          ctx.proxyCoordinator?.recordBuildHeartbeat(synthetic);
        }
        res.json({ ok: true, runId, phase, tool, status, elapsedMs });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  // POST /telegram/post-update — route an update/announcement message to the
  // Agent Updates topic, deterministically.
  //
  // The caller cannot specify a topic. The topic is resolved server-side from
  // `agent-updates-topic` state. This closes off an entire class of bugs where
  // agents sent update messages to whatever topic happened to spawn their
  // session (typically the most recently active Telegram topic).
  //
  // If the Updates topic is not configured, the endpoint returns 400 — never
  // a silent fallback to Attention or any other topic. Update messages MUST
  // end up in the Updates topic or not be sent at all.
  router.post('/telegram/post-update', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const updatesTopicId = ctx.state.get<number>('agent-updates-topic');
    if (!updatesTopicId || typeof updatesTopicId !== 'number') {
      res.status(400).json({
        error: 'Agent Updates topic is not configured',
        hint: 'The Updates topic is provisioned automatically at server startup when Telegram is configured. Check server logs for "Failed to ensure Agent Updates topic" errors. Update messages are not routed to any fallback topic by design.',
      });
      return;
    }

    const { text, metadata } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }
    if (text.length > 4096) {
      res.status(400).json({ error: '"text" must be 4096 characters or fewer' });
      return;
    }

    const updateAllowDebugText = metadata?.allowDebugText === true;
    const updateAllowDuplicate = metadata?.allowDuplicate === true;
    if (
      await checkOutboundMessage(text, 'telegram', res, {
        topicId: updatesTopicId,
        allowDebugText: updateAllowDebugText,
        allowDuplicate: updateAllowDuplicate,
      })
    )
      return;

    try {
      await ctx.telegram.sendToTopic(updatesTopicId, text);
      // Note: intentionally do NOT clear the injection tracker for the Updates
      // topic. Update posts are proactive broadcasts, not replies to a stuck
      // session — resetting stall timers here would mask real hangs elsewhere.
      res.json({ ok: true, topicId: updatesTopicId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/telegram/topics/:topicId/messages', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }

    const limit = parseInt(req.query.limit as string, 10) || 20;
    const messages = ctx.telegram.getTopicHistory(topicId, Math.min(limit, 100));
    res.json({ topicId, messages });
  });

  // ── Message Log Search ──────────────────────────────────────────

  router.get('/telegram/search', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const query = req.query.q as string | undefined;
    const topicId = req.query.topicId ? parseInt(req.query.topicId as string, 10) : undefined;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const rawLimit = parseInt(req.query.limit as string, 10) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), 500);

    if (topicId !== undefined && isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    if (since !== undefined && isNaN(since.getTime())) {
      res.status(400).json({ error: 'since must be a valid ISO date' });
      return;
    }

    const results = ctx.telegram.searchLog({ query, topicId, since, limit });
    res.json({ results, count: results.length });
  });

  router.get('/telegram/log-stats', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    res.json(ctx.telegram.getLogStats());
  });

  // ── Threadline → Telegram Bridge: settings surface ─────────────
  //
  // Read/write toggles + allow-list/deny-list that gate the bridge module
  // (deliverable b). Default-OFF auto-create is a hard requirement — these
  // endpoints are how the user opts in. Bearer-auth enforced globally.

  router.get('/threadline/telegram-bridge/config', (_req, res) => {
    if (!ctx.telegramBridgeConfig) {
      res.status(503).json({ error: 'Telegram bridge config not initialized' });
      return;
    }
    res.json(ctx.telegramBridgeConfig.getSettings());
  });

  // ── Threadline observability — read-only views over inbox/outbox/bindings ──

  router.get('/threadline/observability/threads', (req, res) => {
    if (!ctx.threadlineObservability) {
      res.status(503).json({ error: 'Threadline observability not initialized' });
      return;
    }
    const remoteAgent = typeof req.query.remoteAgent === 'string' ? req.query.remoteAgent : undefined;
    const sinceIso = typeof req.query.since === 'string' ? req.query.since : undefined;
    const untilIso = typeof req.query.until === 'string' ? req.query.until : undefined;
    const hasTopicRaw = typeof req.query.hasTopic === 'string' ? req.query.hasTopic : undefined;
    const hasTopic = hasTopicRaw === 'yes' || hasTopicRaw === 'no' ? hasTopicRaw : undefined;
    const threads = ctx.threadlineObservability.listThreads({ remoteAgent, sinceIso, untilIso, hasTopic });
    res.json({ threads, count: threads.length });
  });

  router.get('/threadline/observability/threads/:threadId', (req, res) => {
    if (!ctx.threadlineObservability) {
      res.status(503).json({ error: 'Threadline observability not initialized' });
      return;
    }
    const detail = ctx.threadlineObservability.getThread(req.params.threadId);
    if (!detail) { res.status(404).json({ error: 'Thread not found' }); return; }
    res.json(detail);
  });

  router.get('/threadline/observability/search', (req, res) => {
    if (!ctx.threadlineObservability) {
      res.status(503).json({ error: 'Threadline observability not initialized' });
      return;
    }
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const hits = ctx.threadlineObservability.searchMessages(q, limit);
    res.json({ hits, count: hits.length });
  });

  router.patch('/threadline/telegram-bridge/config', (req, res) => {
    if (!ctx.telegramBridgeConfig) {
      res.status(503).json({ error: 'Telegram bridge config not initialized' });
      return;
    }
    try {
      const body = req.body as {
        enabled?: unknown;
        autoCreateTopics?: unknown;
        mirrorExisting?: unknown;
        allowList?: unknown;
        denyList?: unknown;
      };
      const patch: Record<string, unknown> = {};
      if ('enabled' in body) patch.enabled = body.enabled;
      if ('autoCreateTopics' in body) patch.autoCreateTopics = body.autoCreateTopics;
      if ('mirrorExisting' in body) patch.mirrorExisting = body.mirrorExisting;
      if ('allowList' in body) patch.allowList = body.allowList;
      if ('denyList' in body) patch.denyList = body.denyList;
      const settings = ctx.telegramBridgeConfig.update(patch);
      res.json(settings);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Slack ──────────────────────────────────────────────────────

  router.post('/slack/reply/:channelId', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { channelId } = req.params;
    const { text, thread_ts, metadata } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }

    if (
      await checkOutboundMessage(text, 'slack', res, {
        allowDebugText: metadata?.allowDebugText === true,
        allowDuplicate: metadata?.allowDuplicate === true,
      })
    )
      return;

    try {
      const ts = await ctx.slack.sendToChannel(channelId, text, { thread_ts });

      // Notify onMessageLogged that the agent responded (so PresenceProxy cancels standby)
      if (ctx.slack.onMessageLogged) {
        ctx.slack.onMessageLogged({
          messageId: ts,
          channelId,
          text,
          fromUser: false,
          timestamp: new Date().toISOString(),
          sessionName: null,
          platform: 'slack',
        });
      }

      // Track for promise detection (detect "give me a minute" patterns)
      if (ctx.slack.trackPromise) {
        const sessionName = ctx.slack.getSessionForChannel(channelId);
        if (sessionName) {
          ctx.slack.trackPromise(channelId, sessionName, text);
        }
      }

      res.json({ ok: true, topicId: channelId, ts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/internal/slack-forward', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { channelId, text } = req.body;
    if (!channelId || !text) {
      res.status(400).json({ error: '"channelId" and "text" fields required' });
      return;
    }

    try {
      await ctx.slack.sendToChannel(channelId, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/slack/channels', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    try {
      const channels = await ctx.slack.api.call('conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: req.query.include_archived !== 'true',
        limit: 200,
      });
      res.json({ ok: true, channels: channels.channels ?? [] });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/slack/channels', async (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { name, is_private } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: '"name" field required' });
      return;
    }

    try {
      const channelId = await ctx.slack.createChannel(name, is_private);
      res.json({ ok: true, channelId });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/slack/channels/:channelId/messages', (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const { channelId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 30, 100);

    const messages = ctx.slack.getChannelMessages(channelId, limit);
    res.json({ ok: true, messages, count: messages.length });
  });

  router.get('/slack/search', (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    const query = req.query.q as string | undefined;
    const channelId = req.query.channelId as string | undefined;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;
    const rawLimit = parseInt(req.query.limit as string, 10) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), 500);

    const results = ctx.slack.searchLog({ query, channelId, since, limit });
    res.json({ results, count: results.length });
  });

  router.get('/slack/log-stats', (req, res) => {
    if (!ctx.slack) {
      res.status(503).json({ error: 'Slack not configured' });
      return;
    }

    res.json(ctx.slack.getLogStats());
  });

  // ── Attention Queue ─────────────────────────────────────────────

  router.post('/attention', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const { id, title, category, description } = req.body;
    const summary = typeof req.body.summary === 'string' ? req.body.summary : req.body.body;
    const sourceContext = typeof req.body.sourceContext === 'string' ? req.body.sourceContext : req.body.source;
    const priority = normalizeAttentionPriority(req.body.priority);
    if (!id || typeof id !== 'string' || id.length > 200) {
      res.status(400).json({ error: '"id" must be a string under 200 characters' });
      return;
    }
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!summary || typeof summary !== 'string' || summary.length > 2000) {
      res.status(400).json({ error: '"summary" must be a string under 2000 characters' });
      return;
    }
    if (!priority) {
      res.status(400).json({ error: `"priority" must be one of: ${ATTENTION_PRIORITIES.join(', ')} (aliases: urgent, high, medium, normal, low)` });
      return;
    }

    // Attention items reach the user as a new Telegram topic with the title,
    // summary, and (optional) description as the body. Run that user-facing
    // candidate through the outbound-message authority before creating the
    // topic. For health-class categories ("degradation", "health"), invoke
    // the health-alert ruleset (B12/B13/B14) so jargon-laden, no-CTA, and
    // self-healed-event messages get suppressed instead of spawning topics.
    const isHealthAlert = typeof category === 'string' && /^(degradation|health|health-alert|alert)$/i.test(category);
    const candidate = [title, summary, description].filter((s): s is string => typeof s === 'string' && s.length > 0).join('\n\n');
    const blocked = await checkOutboundMessage(candidate, 'telegram', res, {
      messageKind: isHealthAlert ? 'health-alert' : 'reply',
      jargon: isHealthAlert,
      // No topicId — attention items create new topics; no prior thread context applies.
    });
    if (blocked) {
      // checkOutboundMessage already wrote the 422 response.
      return;
    }

    // CMT-519 — structural guard: threadline/agent-messaging-class attention
    // items must NOT spawn a per-event Telegram topic (the "wall of topics").
    // Redirect them through the SILENT Threadline hub (parent-or-hub routing).
    // This makes the no-per-event-topic property structural — even an agent
    // ad-hoc-posting a threadline alert can't regress into topic spam.
    const threadlineClass =
      /^(threadline|inter-agent|relay|spawn)/i.test(String(category || '')) ||
      /\bthreadline\b|inter[- ]agent|spawn[- ]?storm|spawn to (receive|RECEIVE)|cannot spawn/i.test(candidate);
    if (threadlineClass && ctx.collaborationSurfacer) {
      const relatedThreadId =
        (typeof req.body?.threadId === 'string' && req.body.threadId) ||
        (typeof req.body?.relatedThreadId === 'string' && req.body.relatedThreadId) ||
        `attn-${id}`;
      const r = await ctx.collaborationSurfacer.notify({
        threadId: relatedThreadId,
        title: title || 'Threadline activity',
        body: summary || description || title || '',
      });
      res.status(201).json({ redirected: 'threadline-hub', surfaced: r.surfaced, topicId: r.topicId });
      return;
    }

    try {
      const item = await ctx.telegram.createAttentionItem({
        id,
        title,
        summary,
        category: category || 'general',
        priority,
        description: description || undefined,
        sourceContext: sourceContext || undefined,
      });
      res.status(201).json(item);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/attention', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const requestedStatus = req.query.status as string | undefined;
    const status = requestedStatus ? (normalizeAttentionStatus(requestedStatus) ?? requestedStatus) : undefined;
    const items = ctx.telegram.getAttentionItems(status);
    res.json({ items, count: items.length });
  });

  router.get('/attention/:id', (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const item = ctx.telegram.getAttentionItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Attention item not found' });
      return;
    }
    res.json(item);
  });

  router.patch('/attention/:id', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const status = normalizeAttentionStatus(req.body.status);
    if (!status) {
      res.status(400).json({ error: `"status" must be one of: ${ATTENTION_STATUSES.join(', ')} (aliases: resolved, done, ack, in_progress, wontdo, reopen)` });
      return;
    }

    const success = await ctx.telegram.updateAttentionStatus(req.params.id, status);
    if (!success) {
      res.status(404).json({ error: 'Attention item not found' });
      return;
    }

    const item = ctx.telegram.getAttentionItem(req.params.id);
    res.json(item);
  });

  router.delete('/attention/:id', async (req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    const item = ctx.telegram.getAttentionItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Attention item not found' });
      return;
    }

    // Soft-delete: mark as DONE
    await ctx.telegram.updateAttentionStatus(req.params.id, 'DONE');

    // Security log
    try {
      const securityEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'attention-dismiss',
        itemId: req.params.id,
        source: 'dashboard',
        ip: req.ip,
      });
      fs.appendFileSync(path.join(ctx.config.stateDir, 'security.jsonl'), securityEntry + '\n');
    } catch {
      // Security logging failure is non-fatal
    }

    res.json({ id: req.params.id, deleted: true });
  });

  // ── Initiatives (multi-phase long-running work tracker) ─────────

  const initiativeIdRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

  router.get('/initiatives', (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    // Phase 1b PR 5 — server-side filters added so the dashboard
    // Initiatives tab can hide project-kind records (rendered in the
    // separate Projects tab) and any record that's a child of a
    // project (rendered inside its parent's card).
    const excludeKind = typeof req.query.excludeKind === 'string' ? req.query.excludeKind : undefined;
    const excludeParented = req.query.excludeParented === 'true';
    let items = status
      ? ctx.initiativeTracker.list({ status: status as 'active' | 'completed' | 'archived' | 'abandoned' })
      : ctx.initiativeTracker.list();
    if (excludeKind) {
      items = items.filter((i) => (i.kind ?? 'task') !== excludeKind);
    }
    if (excludeParented) {
      items = items.filter((i) => !i.parentProjectId);
    }
    res.json({ items, count: items.length });
  });

  router.get('/initiatives/digest', (_req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    res.json(ctx.initiativeTracker.digest());
  });

  router.get('/initiatives/:id', (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    if (!initiativeIdRe.test(req.params.id)) {
      res.status(400).json({ error: 'invalid initiative id' });
      return;
    }
    const initiative = ctx.initiativeTracker.get(req.params.id);
    if (!initiative) {
      res.status(404).json({ error: 'initiative not found' });
      return;
    }
    res.json(initiative);
  });

  router.post('/initiatives', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    const { id, title, description, phases, links, nextCheckAt, needsUser, needsUserReason, blockers } = req.body ?? {};
    if (typeof id !== 'string' || !initiativeIdRe.test(id)) {
      res.status(400).json({ error: '"id" must be lowercase kebab-case, 1–63 chars' });
      return;
    }
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
      res.status(400).json({ error: '"title" required, ≤200 chars' });
      return;
    }
    if (typeof description !== 'string' || description.length > 4000) {
      res.status(400).json({ error: '"description" required, ≤4000 chars' });
      return;
    }
    if (!Array.isArray(phases) || phases.length === 0) {
      res.status(400).json({ error: '"phases" must be a non-empty array' });
      return;
    }
    try {
      const created = await ctx.initiativeTracker.create({
        id, title, description, phases, links, nextCheckAt,
        needsUser, needsUserReason, blockers,
      });
      res.status(201).json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch('/initiatives/:id', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    if (!initiativeIdRe.test(req.params.id)) {
      res.status(400).json({ error: 'invalid initiative id' });
      return;
    }
    try {
      const updated = await ctx.initiativeTracker.update(req.params.id, req.body ?? {});
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = msg.includes('not found') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  router.post('/initiatives/:id/phase/:phaseId', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    const { status } = req.body ?? {};
    if (!['pending', 'in-progress', 'done', 'blocked'].includes(status)) {
      res.status(400).json({ error: '"status" must be one of pending|in-progress|done|blocked' });
      return;
    }
    try {
      const updated = await ctx.initiativeTracker.setPhaseStatus(req.params.id, req.params.phaseId, status);
      res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.delete('/initiatives/:id', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    const removed = await ctx.initiativeTracker.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'initiative not found' });
      return;
    }
    res.json({ id: req.params.id, deleted: true });
  });

  // ── Projects (project-scope, Phase 1a PR 2) ─────────────────────
  //
  // Subset of Phase 1.3 endpoints from PROJECT-SCOPE-SPEC.md. Full
  // advance/halt/ack endpoints ship in PR 3 (skill) + Phase 1b (runner).
  //
  // Auth is enforced globally by `authMiddleware` on the AgentServer; we
  // don't re-check the bearer here. Rate limiting on POST /projects is
  // enforced via a small per-token counter in `.instar/local/projects-rate.json`.

  router.get('/projects', (_req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    const items = ctx.initiativeTracker.list({ kind: 'project' });
    res.json({ items, count: items.length });
  });

  router.get('/projects/:id', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    if (!initiativeIdRe.test(req.params.id)) {
      res.status(400).json({ error: 'invalid project id' });
      return;
    }
    const project = ctx.initiativeTracker.get(req.params.id);
    if (!project || (project.kind ?? 'task') !== 'project') {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    // Join children that point at this project via parentProjectId.
    let children = ctx.initiativeTracker
      .list()
      .filter((i) => i.parentProjectId === project.id);

    // Lazy merged-state reconciler — spec § Phase 1.4 lines 256-258.
    //
    // GET /projects/:id is documented as "may mutate": when a 'building' child's
    // mergeCommitOid is no longer ancestor of origin/main, we transition it to
    // 'regressed' and clear future autoAdvanceAt on its round.
    //
    // Selection contract:
    //   - debounce: skip any child with `ciCheckedAt < 6h ago`
    //   - cap: at most 3 child-revalidations per GET
    //   - order: oldest `ciCheckedAt` first (treat undefined as 1970), ties broken
    //     by `roundIndex` ASC, then `itemId` ASC — no child can starve.
    //   - opt-out: `?reconcile=false` (or `?reconcile=0`) skips entirely
    const reconcileFlag = req.query.reconcile;
    const wantReconcile = reconcileFlag !== 'false' && reconcileFlag !== '0';
    if (wantReconcile && project.targetRepoPath) {
      const nowMs = Date.now();
      const debounceMs = 6 * 60 * 60 * 1000; // 6 hours
      const roundIndexOf = (childId: string): number => {
        const rounds = project.rounds ?? [];
        for (let i = 0; i < rounds.length; i++) {
          if ((rounds[i].itemIds ?? []).includes(childId)) return i;
        }
        return Number.MAX_SAFE_INTEGER;
      };
      const candidates = children
        .filter((c) => c.pipelineStage === 'building' && typeof c.mergeCommitOid === 'string' && c.mergeCommitOid)
        .filter((c) => {
          const t = c.ciCheckedAt ? Date.parse(c.ciCheckedAt) : 0;
          return !(Number.isFinite(t) && t > 0 && nowMs - t < debounceMs);
        })
        .sort((a, b) => {
          const ta = a.ciCheckedAt ? Date.parse(a.ciCheckedAt) : 0;
          const tb = b.ciCheckedAt ? Date.parse(b.ciCheckedAt) : 0;
          if (ta !== tb) return ta - tb;
          const ra = roundIndexOf(a.id);
          const rb = roundIndexOf(b.id);
          if (ra !== rb) return ra - rb;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .slice(0, 3);
      const candidateIds = candidates.map((c) => c.id);
      if (candidateIds.length > 0) {
        let verified: Set<string> = new Set();
        try {
          verified = await verifyMergedItemsViaGit(project.targetRepoPath, candidateIds, ctx.initiativeTracker);
        } catch {
          // git not available, no network, etc. — leave verified empty so we
          // still update ciCheckedAt to back off; better than a hot loop.
        }
        let touched = false;
        for (const cand of candidates) {
          const child = ctx.initiativeTracker.get(cand.id);
          if (!child) continue;
          const isMerged = verified.has(cand.id);
          try {
            await ctx.initiativeTracker.update(cand.id, {
              pipelineStage: isMerged ? 'merged' : 'regressed',
              ciCheckedAt: new Date(nowMs).toISOString(),
              ifMatch: child.version,
            });
            touched = true;
            if (!isMerged) {
              // On regression: clear future autoAdvanceAt on the child's round
              // so the next round doesn't auto-fire while this one is broken.
              const projAfter = ctx.initiativeTracker.get(project.id);
              const rIdx = roundIndexOf(cand.id);
              if (projAfter && rIdx < (projAfter.rounds ?? []).length) {
                const newRounds = (projAfter.rounds ?? []).map((r, i) =>
                  i > rIdx ? { ...r, autoAdvanceAt: undefined } : r
                );
                try {
                  await ctx.initiativeTracker.update(project.id, {
                    rounds: newRounds,
                    ifMatch: projAfter.version,
                  });
                } catch {
                  // OCC race; next GET will retry.
                }
              }
            }
          } catch {
            // OCC race or validator reject; leave as-is for next GET.
          }
        }
        if (touched) {
          children = ctx.initiativeTracker
            .list()
            .filter((i) => i.parentProjectId === project.id);
        }
      }
    }

    // Optional field selector: `?fields=id,title,pipelineStage`. Used by
    // the dashboard projects selector (Phase 1.10). Always preserves `id`.
    const fieldsParam = typeof req.query.fields === 'string' ? req.query.fields : '';
    if (fieldsParam.trim()) {
      const fields = new Set(
        fieldsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      fields.add('id');
      const pickProj = pickFields(project as unknown as Record<string, unknown>, fields);
      const pickKids = children.map((c) => pickFields(c as unknown as Record<string, unknown>, fields));
      res.json({ project: pickProj, children: pickKids });
      return;
    }
    res.json({ project, children });
  });

  // GET /projects/:id/next — structured next-action payload.
  //
  // Spec § Phase 1.5 (line 268): returns `{ action, params, estimatedCost?,
  // skillCommand? }` for the FIRST round whose status is not 'complete'.
  // Ordering: roundIndex ASC, then pipelineStage ASC, then itemId ASC.
  //
  // Action verbs the spec enumerates (a non-exhaustive contract):
  //   - 'await-user-approval' — first round needs `firstLaunchAckAt`
  //   - 'ack-required'         — unacknowledgedAdvanceCount >= cap
  //   - 'resolve-conflict'     — `awaitingReconciliation` non-empty
  //   - 'accept-partial'       — round is partially-complete
  //   - 'run-spec-converge'    — at least one item is `spec-drafted`
  //   - 'run-drift-check'      — at least one item is `approved`, no fresh
  //                              drift verdict
  //   - 'start-round'          — all preconditions met, ready to fire
  //
  // The endpoint does NOT run the runner's preflight — that's a heavier
  // check at fire time. The action is a hint for the dashboard + skill UI.
  router.get('/projects/:id/next', (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    if (!initiativeIdRe.test(req.params.id)) {
      res.status(400).json({ error: 'invalid project id' });
      return;
    }
    const project = ctx.initiativeTracker.get(req.params.id);
    if (!project || (project.kind ?? 'task') !== 'project') {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const rounds = project.rounds ?? [];
    const idx = rounds.findIndex((r) => (r.status ?? 'pending') !== 'complete');
    if (idx === -1) {
      res.status(204).end();
      return;
    }
    const r = rounds[idx];

    // Determine the action verb from project + round state.
    type ActionVerb =
      | 'await-user-approval'
      | 'ack-required'
      | 'resolve-conflict'
      | 'accept-partial'
      | 'run-spec-converge'
      | 'run-drift-check'
      | 'start-round';
    let action: ActionVerb = 'start-round';
    const childrenById = new Map(
      ctx.initiativeTracker
        .list()
        .filter((i) => i.parentProjectId === project.id)
        .map((c) => [c.id, c])
    );
    const itemsForRound = (r.itemIds ?? []).map((id) => childrenById.get(id)).filter(Boolean);

    if ((project.awaitingReconciliation ?? []).length > 0) {
      action = 'resolve-conflict';
    } else if ((r.status ?? 'pending') === 'partially-complete') {
      action = 'accept-partial';
    } else if (idx === 0 && !project.firstLaunchAckAt) {
      action = 'await-user-approval';
    } else if ((project.unacknowledgedAdvanceCount ?? 0) >= 2) {
      action = 'ack-required';
    } else if (itemsForRound.some((c) => c?.pipelineStage === 'spec-drafted')) {
      action = 'run-spec-converge';
    } else if (
      itemsForRound.some(
        (c) => c?.pipelineStage === 'approved' && !r.lastDriftVerdict
      )
    ) {
      action = 'run-drift-check';
    }

    res.json({
      action,
      params: {
        projectId: project.id,
        projectVersion: project.version,
        roundIndex: idx,
        name: r.name,
        itemIds: r.itemIds,
        status: r.status ?? 'pending',
        autoAdvanceAt: r.autoAdvanceAt,
      },
      skillCommand: skillCommandForAction(action, project.id, idx),
    });
  });

  // ── /projects/:id mutating routes (Phase 1b PR 3) ──────────────
  //
  // All mutating endpoints require `If-Match: <version>` (OCC). Missing
  // header → 428. Stale version → 409. Spec § Phase 1.3.
  //
  // /advance is a single-item stage transition driven by StageTransitionValidator.
  // /halt, /ack, /accept-partial route through ProjectRoundRunner.

  function parseIfMatch(req: ExpressRequest, res: ExpressResponse): number | null {
    const header = req.headers['if-match'];
    if (typeof header !== 'string' || !header.trim()) {
      res.status(428).json({ error: 'If-Match header required' });
      return null;
    }
    const n = parseInt(header.replace(/"/g, ''), 10);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ error: 'If-Match must be a positive integer version' });
      return null;
    }
    return n;
  }

  function lookupProject(req: ExpressRequest, res: ExpressResponse) {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return null;
    }
    if (!initiativeIdRe.test(req.params.id)) {
      res.status(400).json({ error: 'invalid project id' });
      return null;
    }
    const project = ctx.initiativeTracker.get(req.params.id);
    if (!project || (project.kind ?? 'task') !== 'project') {
      res.status(404).json({ error: 'project not found' });
      return null;
    }
    return project;
  }

  // POST /projects/:id/advance — advance one child item by one stage.
  //
  // Body shape:
  //   {
  //     "itemId": "<child id>",
  //     "fromStage": "<optional explicit current stage>",
  //     "targetStage": "spec-drafted|spec-converged|approved|building|merged|skipped|outline",
  //     "artifact": {
  //       "specPath"?: "...",          // outline → spec-drafted
  //       "prNumber"?: 123,            // building → merged
  //       "taskFlowRecordId"?: "...",  // approved → building
  //       "skippedReason"?: "...",     // any → skipped
  //       "skippedBy"?: "...",         // any → skipped
  //       "unskippedAt"?: "..."        // skipped → outline
  //     }
  //   }
  //
  // The HTTP layer does NOT enforce gates the ProjectRoundRunner already
  // enforces — `/advance` is a single-item transition that operates on
  // child records, not on round status. Round-level invariants (lock,
  // first-launch ack, owner machine, etc.) apply only to /run-round
  // and to the autonomous loop, both of which ship in a later PR.
  router.post('/projects/:id/advance', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.initiativeTracker) return; // narrow for TS
    const ifMatch = parseIfMatch(req, res);
    if (ifMatch === null) return;
    if (ifMatch !== project.version) {
      res.status(409).json({ error: 'version mismatch', currentVersion: project.version });
      return;
    }

    const body = (req.body ?? {}) as {
      itemId?: unknown;
      fromStage?: unknown;
      targetStage?: unknown;
      artifact?: Record<string, unknown>;
    };
    const itemId = typeof body.itemId === 'string' ? body.itemId : '';
    const targetStage = typeof body.targetStage === 'string' ? (body.targetStage as PipelineStage) : null;
    if (!itemId) {
      res.status(400).json({ error: '"itemId" required' });
      return;
    }
    if (!targetStage) {
      res.status(400).json({ error: '"targetStage" required' });
      return;
    }
    const child = ctx.initiativeTracker.get(itemId);
    if (!child || child.parentProjectId !== project.id) {
      res.status(404).json({ error: `child item "${itemId}" not found under project ${project.id}` });
      return;
    }

    if (!project.targetRepoPath) {
      res.status(400).json({ error: 'project has no targetRepoPath; cannot validate artifacts' });
      return;
    }

    const artifact = body.artifact ?? {};
    const validationCtx: StageValidationContext = {
      targetRepoPath: project.targetRepoPath,
      specPath: typeof artifact.specPath === 'string' ? artifact.specPath : undefined,
      prNumber: typeof artifact.prNumber === 'number' ? artifact.prNumber : undefined,
      taskFlowRecordId: typeof artifact.taskFlowRecordId === 'string' ? artifact.taskFlowRecordId : undefined,
      skippedReason: typeof artifact.skippedReason === 'string' ? artifact.skippedReason : undefined,
      skippedBy: typeof artifact.skippedBy === 'string' ? artifact.skippedBy : undefined,
      unskippedAt: typeof artifact.unskippedAt === 'string' ? artifact.unskippedAt : undefined,
    };

    const fromStage =
      typeof body.fromStage === 'string'
        ? (body.fromStage as PipelineStage)
        : (child.pipelineStage as PipelineStage | undefined);

    const result = await validateStageTransition(fromStage, targetStage, validationCtx);
    if (!result.ok) {
      res.status(409).json({ error: 'stage transition rejected', code: result.code, reason: result.reason });
      return;
    }

    try {
      const updated = await ctx.initiativeTracker.update(itemId, {
        pipelineStage: targetStage,
        ifMatch: child.version,
      });
      // Bump the project version too so concurrent advance calls don't
      // operate on a stale view. We touch description ("last advance
      // <timestamp>") to force a meaningful update.
      const refreshed = await ctx.initiativeTracker.update(project.id, {
        // No-op-but-bump: nudge `lastTouchedAt` indirectly via update.
        nextCheckAt: project.nextCheckAt,
        ifMatch: project.version,
      });
      res.json({
        item: { id: updated.id, pipelineStage: updated.pipelineStage, version: updated.version },
        project: { id: refreshed.id, version: refreshed.version },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'OccVersionMismatchError') {
        const cv = (err as Error & { currentVersion?: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion: cv });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /projects/:id/halt — kills the active round. Idempotent.
  router.post('/projects/:id/halt', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.projectRoundRunner) {
      res.status(503).json({ error: 'ProjectRoundRunner not configured' });
      return;
    }
    const reason = typeof (req.body ?? {}).reason === 'string' ? (req.body as { reason: string }).reason : 'no reason given';
    try {
      const result = await ctx.projectRoundRunner.halt(project.id, reason);
      if (!result) {
        res.status(409).json({ error: 'project has no halt-able round' });
        return;
      }
      res.json({ id: result.project.id, roundIndex: result.roundIndex, version: result.project.version });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /projects/:id/ack — record user acknowledgment.
  router.post('/projects/:id/ack', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.projectRoundRunner) {
      res.status(503).json({ error: 'ProjectRoundRunner not configured' });
      return;
    }
    const body = (req.body ?? {}) as { forRoundIndex?: unknown; roundIndex?: unknown };
    const idx = typeof body.forRoundIndex === 'number' ? body.forRoundIndex : (typeof body.roundIndex === 'number' ? body.roundIndex : 0);
    if (!Number.isInteger(idx) || idx < 0) {
      res.status(400).json({ error: '"forRoundIndex" must be a non-negative integer' });
      return;
    }
    try {
      const updated = await ctx.projectRoundRunner.recordAck(project.id, idx);
      if (!updated) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      res.json({
        id: updated.id,
        firstLaunchAckAt: updated.firstLaunchAckAt,
        lastAckedRoundIndex: updated.lastAckedRoundIndex,
        unacknowledgedAdvanceCount: updated.unacknowledgedAdvanceCount,
        version: updated.version,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'OccVersionMismatchError') {
        const cv = (err as Error & { currentVersion?: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion: cv });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /projects/:id/accept-partial — close a partially-complete round.
  router.post('/projects/:id/accept-partial', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.projectRoundRunner) {
      res.status(503).json({ error: 'ProjectRoundRunner not configured' });
      return;
    }
    const body = (req.body ?? {}) as { roundIndex?: unknown; reason?: unknown; skippedBy?: unknown };
    const idx = typeof body.roundIndex === 'number' ? body.roundIndex : -1;
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const skippedBy = typeof body.skippedBy === 'string' ? body.skippedBy : '';
    if (!Number.isInteger(idx) || idx < 0) {
      res.status(400).json({ error: '"roundIndex" must be a non-negative integer' });
      return;
    }
    if (!reason.trim()) {
      res.status(400).json({ error: '"reason" required' });
      return;
    }
    if (!skippedBy.trim()) {
      res.status(400).json({ error: '"skippedBy" required' });
      return;
    }
    try {
      const result = await ctx.projectRoundRunner.acceptPartial(project.id, idx, reason, skippedBy);
      if (!result) {
        res.status(404).json({ error: 'project or round not found' });
        return;
      }
      res.json({
        id: result.project.id,
        skippedItemIds: result.skippedItemIds,
        version: result.project.version,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'OccVersionMismatchError') {
        const cv = (err as Error & { currentVersion?: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion: cv });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /projects/:id/claim-ownership — multi-machine ownership transfer.
  //
  // Body: {} or { force?: boolean }
  // Header: If-Match: <version> (OCC)
  //
  // Spec § P5: the claimer must (a) commit-and-push the claim before
  // acting on it, (b) wait 60s for git-sync to converge, (c) re-read
  // before any auto-action. This endpoint ONLY records the ownership
  // change; the wait-and-converge happens at the caller level (the
  // round runner, the auto-advance poller, the dashboard). Claim is
  // refused (409) if the current owner's heartbeat is still fresh and
  // `force: true` was not set.
  router.post('/projects/:id/claim-ownership', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.initiativeTracker) return; // narrow for TS
    if (!ctx.machineHeartbeat || !ctx.machineHeartbeat.config) {
      res.status(503).json({ error: 'machine heartbeat not configured' });
      return;
    }
    const ifMatch = parseIfMatch(req, res);
    if (ifMatch === null) return;
    if (ifMatch !== project.version) {
      res.status(409).json({ error: 'version mismatch', currentVersion: project.version });
      return;
    }
    const force = (req.body ?? {}).force === true;
    const heartbeat = ctx.machineHeartbeat.api;
    const currentOwner = project.ownerMachineId;
    const claimer = ctx.machineHeartbeat.config.machineId;
    if (currentOwner === claimer) {
      // Already owned by claimer — idempotent success.
      res.json({ id: project.id, ownerMachineId: claimer, version: project.version, alreadyOwned: true });
      return;
    }
    if (currentOwner && !heartbeat.isStale(currentOwner) && !force) {
      res.status(409).json({
        error: 'current owner heartbeat is still fresh; pass {force:true} to claim anyway',
        currentOwner,
      });
      return;
    }
    try {
      const updated = await ctx.initiativeTracker.update(project.id, {
        ownerMachineId: claimer,
        ifMatch: project.version,
      });
      res.json({
        id: updated.id,
        ownerMachineId: updated.ownerMachineId,
        previousOwner: currentOwner ?? null,
        version: updated.version,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'OccVersionMismatchError') {
        const cv = (err as Error & { currentVersion?: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion: cv });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Multi-Machine Session Pool (§L2): the live machine-pool view ──────
  //
  // GET /pool — router holder + every machine's capacity (nickname, hardware,
  // liveness, load, clock-skew status). Backs the Machines dashboard tab. Always
  // 200 (Bearer-auth via the global middleware); `enabled:false` + an empty/
  // single-machine view on installs where the pool registry isn't wired (dark).
  router.get('/pool', (_req, res) => {
    const sync = ctx.coordinator ? ctx.coordinator.getSyncStatus() : null;
    const machines = ctx.machinePoolRegistry ? ctx.machinePoolRegistry.getCapacities() : [];
    res.json({
      enabled: !!ctx.machinePoolRegistry,
      router: sync
        ? {
            holder: sync.leaseHolder,
            epoch: sync.leaseEpoch,
            holdsLease: sync.holdsLease,
            awakeMachineCount: sync.awakeMachineCount,
            splitBrainState: sync.splitBrainState,
          }
        : null,
      machines,
    });
  });

  // GET /session-pool/e2e-results — the rollout gate's observable state (§Rollout).
  // Read-only; returns the latest E2E result per stage + whether each verifies. The
  // StageAdvancer gates activation on these; this surfaces them (no mutation here).
  router.get('/session-pool/e2e-results', (_req, res) => {
    const store = ctx.sessionPoolE2EResultStore;
    if (!store) {
      res.status(503).json({ error: 'session-pool rollout gate not available (dark / single-machine install)' });
      return;
    }
    const stages = [0, 1, 2, 3];
    const latestPerStage = stages.map((stage) => {
      const row = store.getLatestForStage(stage);
      return { stage, result: row?.result ?? null, commitSha: row?.commitSha ?? null, ranAt: row?.ranAt ?? null, verified: row ? store.verify(row) : null };
    });
    res.json({ latestPerStage, total: store.all().length });
  });

  // PATCH /pool/machines/:id — rename a machine (§L2 user-editable nickname).
  // Body: { nickname: string }. Validates format + pool-uniqueness; a collision
  // is rejected (400), an unknown machine is 404, a malformed nickname is 400.
  // Metadata-only — renaming NEVER moves a session or touches lease/ownership.
  router.patch('/pool/machines/:id', (req, res) => {
    const idMgr = ctx.coordinator?.managers?.identityManager ?? null;
    if (!idMgr) {
      res.status(503).json({ error: 'machine registry not available (single-machine install)' });
      return;
    }
    const nickname = (req.body ?? {}).nickname;
    if (typeof nickname !== 'string') {
      res.status(400).json({ error: 'nickname (string) is required' });
      return;
    }
    try {
      idMgr.updateNickname(req.params.id, nickname);
      res.json({ ok: true, machineId: req.params.id, nickname: nickname.trim() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(/not found/i.test(msg) ? 404 : 400).json({ error: msg });
    }
  });

  // POST /mesh/rpc — the MeshRpc receive endpoint (§L0). Body = a signed,
  // recipient-bound MeshEnvelope. The dispatcher runs verify→RBAC→nonce-burn→
  // handler and returns a typed reason + HTTP status (401/403 auth, 409 freshness,
  // 501 unimplemented). NOTE: m2m authenticity is the ENVELOPE's own Ed25519
  // signature (verified by the dispatcher), independent of the Bearer middleware.
  router.post('/mesh/rpc', async (req, res) => {
    if (!ctx.meshRpcDispatcher) {
      res.status(503).json({ error: 'mesh-rpc not configured (single-machine install)' });
      return;
    }
    const env = req.body;
    if (!env || typeof env !== 'object' || typeof (env as { sender?: unknown }).sender !== 'string') {
      res.status(400).json({ error: 'a signed MeshEnvelope is required' });
      return;
    }
    try {
      const r = await ctx.meshRpcDispatcher.dispatch(env as import('../core/MeshRpc.js').MeshEnvelope);
      if (r.ok) {
        res.json({ ok: true, result: r.result });
      } else {
        res.status(r.status).json({ ok: false, reason: r.reason });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /projects/:id/drift-check — run the drift checker for a given
  // round and return the verdict. Wraps ProjectDriftChecker.run().
  //
  // Body: { roundIndex: number, specPath: string, referencedFiles: string[],
  //         timeoutMs?: number, modelId?: string }
  //
  // Mutex-guarded per project (spec § Phase 1.5 line 279). Without it two
  // concurrent calls would double-spend the drift-spend ledger and
  // double-bill the LLM. A second concurrent call returns 409 with
  // `{error: 'drift-check already in flight'}` so the caller can poll.
  //
  // 400 on validation; 503 if no checker configured; 200 with verdict envelope
  // on success. We do NOT require If-Match: drift is a read-only signal.
  const driftInFlight: Set<string> = new Set();
  router.post('/projects/:id/drift-check', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    if (!ctx.projectDriftChecker) {
      res.status(503).json({ error: 'ProjectDriftChecker not configured' });
      return;
    }
    if (!initiativeIdRe.test(req.params.id)) {
      res.status(400).json({ error: 'invalid project id' });
      return;
    }
    const project = ctx.initiativeTracker.get(req.params.id);
    if (!project || (project.kind ?? 'task') !== 'project') {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    if (!project.targetRepoPath) {
      res.status(400).json({ error: 'project has no targetRepoPath' });
      return;
    }
    const body = (req.body ?? {}) as {
      roundIndex?: unknown;
      specPath?: unknown;
      referencedFiles?: unknown;
      timeoutMs?: unknown;
      modelId?: unknown;
    };
    const roundIndex = typeof body.roundIndex === 'number' ? body.roundIndex : -1;
    const specPath = typeof body.specPath === 'string' ? body.specPath : '';
    const referencedFiles = Array.isArray(body.referencedFiles)
      ? body.referencedFiles.filter((f): f is string => typeof f === 'string')
      : [];
    if (!Number.isInteger(roundIndex) || roundIndex < 0) {
      res.status(400).json({ error: '"roundIndex" (non-negative integer) required' });
      return;
    }
    if (!specPath.trim()) {
      res.status(400).json({ error: '"specPath" (string) required' });
      return;
    }
    const rounds = project.rounds ?? [];
    if (roundIndex >= rounds.length) {
      res.status(400).json({ error: 'roundIndex out of range', rounds: rounds.length });
      return;
    }
    if (driftInFlight.has(project.id)) {
      res.status(409).json({ error: 'drift-check already in flight for this project' });
      return;
    }
    driftInFlight.add(project.id);
    try {
      const verdict = await ctx.projectDriftChecker.run({
        projectId: project.id,
        roundIndex,
        targetRepoPath: project.targetRepoPath,
        specPath,
        referencedFiles,
        timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
      });
      res.json({ verdict, projectId: project.id, roundIndex });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      driftInFlight.delete(project.id);
    }
  });

  // POST /projects/:id/run-round — manual round-start trigger.
  //
  // Spec § Phase 1.7: `/project run-round` is the user-invoked entry path.
  // Per § Phase 1.5, every entry path goes through `ProjectRoundRunner.preflight`.
  // On a successful preflight the route schedules the round for the auto-advance
  // poller by setting `autoAdvanceAt = now`; the poller fires the executor on
  // its next tick (≤60s). This avoids spawning a long-running child process
  // from a request handler and keeps a single fire path through the poller.
  //
  // Body: { roundIndex: number }
  // Returns 200 with the preflight verdict + scheduling timestamp on accept,
  // 409 with the preflight reason on reject, 503 if the runner is not wired.
  router.post('/projects/:id/run-round', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.initiativeTracker) return;
    if (!ctx.projectRoundRunner) {
      res.status(503).json({ error: 'ProjectRoundRunner not configured' });
      return;
    }
    const body = (req.body ?? {}) as { roundIndex?: unknown };
    const idx = typeof body.roundIndex === 'number' ? body.roundIndex : 0;
    if (!Number.isInteger(idx) || idx < 0) {
      res.status(400).json({ error: '"roundIndex" must be a non-negative integer' });
      return;
    }
    const rounds = project.rounds ?? [];
    if (idx >= rounds.length) {
      res.status(404).json({ error: `round index ${idx} out of range (0..${rounds.length - 1})` });
      return;
    }
    const verdict = ctx.projectRoundRunner.preflight(project.id, idx);
    if (!verdict.ok) {
      res.status(409).json({ error: 'preflight rejected', code: verdict.code, reason: verdict.reason });
      return;
    }
    try {
      const now = new Date().toISOString();
      const nextRounds = rounds.map((r, i) => (i === idx ? { ...r, autoAdvanceAt: now } : r));
      const updated = await ctx.initiativeTracker.update(project.id, {
        rounds: nextRounds,
        ifMatch: project.version,
      });
      res.json({
        id: updated.id,
        roundIndex: idx,
        scheduledAt: now,
        version: updated.version,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'OccVersionMismatchError') {
        const cv = (err as Error & { currentVersion?: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion: cv });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /projects/:id/resume — resume a halted round.
  //
  // Spec § Phase 1.5: clears `haltedAt`/`haltReason` on the round and schedules
  // it for the auto-advance poller. For rounds with status='failed' that have
  // hit the 3-attempt resume cap (`resumeAttempts >= 3`), the body must include
  // `{ force: true }`; otherwise the route returns 409. Resetting a `failed`
  // round also zeroes `resumeAttempts` so the runner gets a fresh budget.
  //
  // Body: { roundIndex?: number (default 0), force?: boolean }
  router.post('/projects/:id/resume', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.initiativeTracker) return;
    const body = (req.body ?? {}) as { roundIndex?: unknown; force?: unknown };
    const idx = typeof body.roundIndex === 'number' ? body.roundIndex : 0;
    const force = body.force === true;
    if (!Number.isInteger(idx) || idx < 0) {
      res.status(400).json({ error: '"roundIndex" must be a non-negative integer' });
      return;
    }
    const rounds = project.rounds ?? [];
    if (idx >= rounds.length) {
      res.status(404).json({ error: `round index ${idx} out of range (0..${rounds.length - 1})` });
      return;
    }
    const round = rounds[idx];
    if (round.status === 'failed' && (round.resumeAttempts ?? 0) >= 3 && !force) {
      res.status(409).json({
        error: 'round at resume-attempts cap; pass {force:true} to override',
        resumeAttempts: round.resumeAttempts,
      });
      return;
    }
    if (!round.haltedAt && round.status !== 'failed') {
      res.status(409).json({
        error: 'round is not halted or failed',
        status: round.status,
      });
      return;
    }
    try {
      const now = new Date().toISOString();
      const nextRounds = rounds.map((r, i) => {
        if (i !== idx) return r;
        const { haltedAt: _h, haltReason: _r, ...rest } = r;
        const resetAttempts = r.status === 'failed' && force;
        return {
          ...rest,
          status: 'pending' as RoundStatus,
          autoAdvanceAt: now,
          resumeAttempts: resetAttempts ? 0 : r.resumeAttempts,
        };
      });
      const nextStatus = project.status === 'halted' || project.status === 'abandoned' ? 'active' : project.status;
      const updated = await ctx.initiativeTracker.update(project.id, {
        rounds: nextRounds,
        status: nextStatus,
        ifMatch: project.version,
      });
      res.json({
        id: updated.id,
        roundIndex: idx,
        scheduledAt: now,
        forced: force,
        version: updated.version,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'OccVersionMismatchError') {
        const cv = (err as Error & { currentVersion?: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion: cv });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /projects/:id/abandon — archive a halted/failed project.
  //
  // Spec § Phase 1.7: "archive a halted round; children remain at current stage."
  // Sets project.status='abandoned' and clears any future `autoAdvanceAt` on
  // remaining rounds so the poller stops considering them. Children's
  // `pipelineStage` is left untouched (per spec). Idempotent.
  //
  // Refuses (409) if any round is currently in-progress — halt first.
  router.post('/projects/:id/abandon', async (req, res) => {
    const project = lookupProject(req, res);
    if (!project) return;
    if (!ctx.initiativeTracker) return;
    const rounds = project.rounds ?? [];
    const active = rounds.find((r) => r.status === 'in-progress');
    if (active) {
      res.status(409).json({
        error: 'cannot abandon while a round is in-progress; halt the round first',
        activeRound: active.name,
      });
      return;
    }
    if (project.status === 'abandoned') {
      res.json({ id: project.id, status: 'abandoned', version: project.version, alreadyAbandoned: true });
      return;
    }
    try {
      const clearedRounds = rounds.map((r) => {
        if (r.autoAdvanceAt) {
          const { autoAdvanceAt: _x, ...rest } = r;
          return rest;
        }
        return r;
      });
      const updated = await ctx.initiativeTracker.update(project.id, {
        rounds: clearedRounds,
        status: 'abandoned',
        ifMatch: project.version,
      });
      res.json({ id: updated.id, status: updated.status, version: updated.version });
    } catch (err) {
      if (err instanceof Error && err.name === 'OccVersionMismatchError') {
        const cv = (err as Error & { currentVersion?: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion: cv });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/projects', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    const planDocPath = (req.body ?? {}).planDocPath;
    if (typeof planDocPath !== 'string' || !planDocPath.trim()) {
      res.status(400).json({ error: '"planDocPath" required (absolute path)' });
      return;
    }

    // ── Rate limit: 5 creates/hour per auth token ──────────────────
    // Per-token counter persisted under `.instar/local/projects-rate.json`.
    // `.instar/local/` is gitignored (Phase 1.12) so the counter never
    // syncs across machines — matches the spec's per-agent semantics.
    const tokenHash = hashAuthHeader(req.headers.authorization);
    const rateCheck = checkAndIncrementProjectsRate(ctx.config.stateDir, tokenHash);
    if (!rateCheck.ok) {
      res.status(429).json({
        error: 'rate limit exceeded',
        windowEnds: rateCheck.windowEnds,
        limit: 5,
      });
      return;
    }

    const { parsePlanDoc } = await import('../core/PlanDocParser.js');
    const parsed = await parsePlanDoc(planDocPath);
    if (!parsed.project || parsed.errors.length > 0) {
      res.status(400).json({
        error: 'plan doc validation failed',
        errors: parsed.errors,
      });
      return;
    }

    // Existing slug? Reject unless `unarchive: true` (Phase 1.6).
    const existing = ctx.initiativeTracker.get(parsed.project.id);
    if (existing) {
      if (existing.status !== 'archived' || parsed.project.unarchive !== true) {
        res.status(409).json({
          error: `project "${parsed.project.id}" already exists`,
          archived: existing.status === 'archived',
        });
        return;
      }
      // Un-archive path is implemented in Phase 1.6 via re-parse rules.
      // Phase 1a defers full re-parse mutation table to PR 3+; for now we
      // reject with a clear message so users don't accidentally clobber.
      res.status(409).json({
        error: 'unarchive flow not yet implemented; archive then re-create with a new id',
      });
      return;
    }

    try {
      const created = await createProjectAndChildren(ctx.initiativeTracker, parsed);
      res.status(201).json(created);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/projects/validate', async (req, res) => {
    const planDocPath = (req.body ?? {}).planDocPath;
    if (typeof planDocPath !== 'string' || !planDocPath.trim()) {
      res.status(400).json({ error: '"planDocPath" required (absolute path)' });
      return;
    }
    const { parsePlanDoc } = await import('../core/PlanDocParser.js');
    const parsed = await parsePlanDoc(planDocPath);
    res.json({
      ok: parsed.errors.length === 0 && !!parsed.project,
      project: parsed.project,
      children: parsed.children,
      errors: parsed.errors,
    });
  });

  router.delete('/projects/:id', async (req, res) => {
    if (!ctx.initiativeTracker) {
      res.status(503).json({ error: 'Initiative tracker not configured' });
      return;
    }
    if (!initiativeIdRe.test(req.params.id)) {
      res.status(400).json({ error: 'invalid project id' });
      return;
    }
    const project = ctx.initiativeTracker.get(req.params.id);
    if (!project || (project.kind ?? 'task') !== 'project') {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    // If-Match required for archive (P4: OCC on mutating endpoints).
    const ifMatchHeader = req.headers['if-match'];
    if (typeof ifMatchHeader !== 'string' || !ifMatchHeader.trim()) {
      res.status(428).json({ error: 'If-Match header required for archive' });
      return;
    }
    const ifMatch = parseInt(ifMatchHeader.replace(/"/g, ''), 10);
    if (!Number.isInteger(ifMatch) || ifMatch <= 0) {
      res.status(400).json({ error: 'If-Match must be a positive integer version' });
      return;
    }
    // Refuse archive if any round is in-progress.
    const activeRound = (project.rounds ?? []).find((r) => r.status === 'in-progress');
    if (activeRound) {
      res.status(409).json({
        error: 'cannot archive while a round is in-progress',
        activeRound: activeRound.name,
      });
      return;
    }
    try {
      const updated = await ctx.initiativeTracker.update(project.id, {
        status: 'archived',
        ifMatch,
      });
      res.json({ id: updated.id, status: updated.status, version: updated.version });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err && (err as Error).name === 'OccVersionMismatchError') {
        const currentVersion = (err as unknown as { currentVersion: number }).currentVersion;
        res.status(409).json({ error: 'version mismatch', currentVersion });
        return;
      }
      res.status(400).json({ error: msg });
    }
  });

  // ── WhatsApp ────────────────────────────────────────────────────

  router.get('/whatsapp/status', (_req, res) => {
    if (!ctx.whatsapp) {
      res.status(503).json({ error: 'WhatsApp not configured' });
      return;
    }
    res.json(ctx.whatsapp.getStatus());
  });

  router.get('/whatsapp/qr', (_req, res) => {
    if (!ctx.whatsapp) {
      res.status(503).json({ error: 'WhatsApp not configured' });
      return;
    }
    const status = ctx.whatsapp.getStatus();
    res.json({
      qr: ctx.whatsapp.getQrCode(),
      state: status.state,
      phoneNumber: status.phoneNumber,
      error: status.lastError,
    });
  });

  // Send a WhatsApp message to a JID (used by whatsapp-reply.sh from Claude sessions)
  router.post('/whatsapp/send/:jid', async (req, res) => {
    if (!ctx.whatsapp) {
      res.status(503).json({ error: 'WhatsApp not configured' });
      return;
    }

    const { jid } = req.params;
    if (!jid) {
      res.status(400).json({ error: 'jid parameter required' });
      return;
    }
    const { text, metadata } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }
    if (text.length > 40000) {
      res.status(400).json({ error: '"text" must be 40000 characters or fewer' });
      return;
    }

    if (
      await checkOutboundMessage(text, 'whatsapp', res, {
        allowDebugText: metadata?.allowDebugText === true,
        allowDuplicate: metadata?.allowDuplicate === true,
      })
    )
      return;

    try {
      await ctx.whatsapp.send({
        content: text,
        userId: jid,
        channel: { type: 'whatsapp', identifier: jid },
      });
      res.json({ ok: true, jid });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/messaging/bridge', (_req, res) => {
    if (!ctx.messageBridge) {
      res.status(503).json({ error: 'Message bridge not configured' });
      return;
    }
    res.json({
      ...ctx.messageBridge.getStatus(),
      links: ctx.messageBridge.getLinks(),
    });
  });

  // ── iMessage ─────────────────────────────────────────────────────

  router.get('/imessage/status', (_req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }
    res.json(ctx.imessage.getConnectionInfo());
  });

  // ── Outbound Safety: validate-before-send endpoint ──
  // Called by imessage-reply.sh BEFORE sending. Issues a single-use token
  // that binds validation to the actual send (TOCTOU mitigation).
  router.post('/imessage/validate-send/:recipient', async (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const { recipient } = req.params;
    if (!recipient) {
      res.status(400).json({ error: 'recipient parameter required' });
      return;
    }

    // Tone gate — if the client passes `text`, check it here before issuing a send token.
    const text = req.body?.text;
    const imessageMetadata = req.body?.metadata;
    if (typeof text === 'string' && text.length > 0) {
      if (
        await checkOutboundMessage(text, 'imessage', res, {
          allowDebugText: imessageMetadata?.allowDebugText === true,
          allowDuplicate: imessageMetadata?.allowDuplicate === true,
        })
      )
        return;
    }

    const result = ctx.imessage.validateSend(decodeURIComponent(recipient));

    if (!result.allowed) {
      res.status(403).json({
        allowed: false,
        reason: result.reason,
      });
      return;
    }

    res.json({
      allowed: true,
      token: result.token,
      sendMode: result.sendMode,
    });
  });

  // Reply confirmation endpoint — called by imessage-reply.sh AFTER sending via imsg CLI.
  // Requires a valid send token from validate-send (TOCTOU mitigation).
  // Logs the outbound message and clears stall tracking.
  router.post('/imessage/reply/:recipient', (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const { recipient } = req.params;
    if (!recipient) {
      res.status(400).json({ error: 'recipient parameter required' });
      return;
    }

    const decodedRecipient = decodeURIComponent(recipient);

    // Validate recipient is authorized
    if (!ctx.imessage.isAuthorized(decodedRecipient)) {
      res.status(403).json({ error: 'recipient not in authorizedContacts' });
      return;
    }

    const { text, sendToken } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: '"text" field required' });
      return;
    }

    // Note: tone gate is not applied here — this is a post-send confirmation
    // endpoint. Gating happens pre-send in /imessage/validate-send.

    // Validate send token if provided (TOCTOU binding)
    if (sendToken) {
      const tokenResult = ctx.imessage.confirmSend(sendToken, decodedRecipient, text);
      if (!tokenResult.ok) {
        res.status(403).json({ error: tokenResult.reason });
        return;
      }
    }

    // Log outbound message
    ctx.imessage.logOutboundMessage(decodedRecipient, text);

    // Clear stall tracking for this sender
    ctx.imessage.clearStallForSender(decodedRecipient);

    // Also clear in SessionManager if available
    if (ctx.sessionManager && 'clearIMessageInjectionTracker' in ctx.sessionManager) {
      (ctx.sessionManager as any).clearIMessageInjectionTracker(decodedRecipient);
    }

    res.json({ ok: true, recipient: decodedRecipient, logged: true });
  });

  router.get('/imessage/chats', async (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const limit = parseInt(req.query.limit as string) || 20;
    try {
      const chats = await ctx.imessage.listChats(limit);
      res.json(chats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/imessage/chats/:chatId/history', async (req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const { chatId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    try {
      const history = await ctx.imessage.getChatHistory(chatId, limit);
      res.json(history);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/imessage/log-stats', (_req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    try {
      const stats = ctx.imessage.messageLogger.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/imessage/search', (_req, res) => {
    if (!ctx.imessage) {
      res.status(503).json({ error: 'iMessage not configured' });
      return;
    }

    const query = (_req.query.q as string || '').trim();
    if (!query) {
      res.status(400).json({ error: 'q parameter required' });
      return;
    }

    const limit = parseInt(_req.query.limit as string) || 50;
    try {
      const results = ctx.imessage.messageLogger.search({ query, limit });
      res.json({ results, count: results.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Relationships ─────────────────────────────────────────────────

  router.get('/relationships', (req, res) => {
    if (!ctx.relationships) {
      res.json({ relationships: [] });
      return;
    }
    const rawSort = req.query.sort as string;
    const sortBy = VALID_SORTS.includes(rawSort as typeof VALID_SORTS[number])
      ? (rawSort as typeof VALID_SORTS[number])
      : 'significance';
    res.json({ relationships: ctx.relationships.getAll(sortBy) });
  });

  // Stale must be before :id to avoid "stale" matching as a param
  router.get('/relationships/stale', (req, res) => {
    if (!ctx.relationships) {
      res.json({ stale: [] });
      return;
    }
    const days = parseInt(req.query.days as string, 10) || 14;
    res.json({ stale: ctx.relationships.getStaleRelationships(days) });
  });

  router.get('/relationships/:id', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const record = ctx.relationships.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json(record);
  });

  router.delete('/relationships/:id', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const deleted = ctx.relationships.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json({ ok: true, deleted: req.params.id });
  });

  router.get('/relationships/:id/context', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }
    const context = ctx.relationships.getContextForPerson(req.params.id);
    if (!context) {
      res.status(404).json({ error: 'Relationship not found' });
      return;
    }
    res.json({ context });
  });

  // Import relationships from Portal people-registry export (PROP-166)
  router.post('/relationships/import', (req, res) => {
    if (!ctx.relationships) {
      res.status(503).json({ error: 'Relationships not configured' });
      return;
    }

    const records = req.body;
    if (!Array.isArray(records)) {
      res.status(400).json({ error: 'Expected a JSON array of relationship records' });
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const rec of records) {
      const name = rec?.name as string;
      const channels = (rec?.channels || []) as Array<{ type: string; identifier: string }>;
      if (!name || !channels.length) {
        skipped++;
        continue;
      }

      // Try to resolve by any channel
      let existing = null;
      for (const channel of channels) {
        existing = ctx.relationships!.resolveByChannel(channel);
        if (existing) break;
      }

      if (existing) {
        for (const channel of channels) {
          ctx.relationships!.linkChannel(existing.id, channel);
        }
        const importNotes = rec.notes as string | undefined;
        if (importNotes && importNotes.length > (existing.notes || '').length) {
          ctx.relationships!.updateNotes(existing.id, importNotes);
        }
        updated++;
      } else {
        const record = ctx.relationships!.findOrCreate(name, channels[0]);
        for (let i = 1; i < channels.length; i++) {
          ctx.relationships!.linkChannel(record.id, channels[i]);
        }
        if (rec.notes) {
          ctx.relationships!.updateNotes(record.id, rec.notes as string);
        }
        const themes = (rec.themes || []) as string[];
        if (themes.length > 0) {
          ctx.relationships!.recordInteraction(record.id, {
            timestamp: new Date().toISOString(),
            channel: channels[0].type,
            summary: `Imported from Portal people-registry with ${themes.length} themes`,
            topics: themes,
          });
        }
        created++;
      }
    }

    res.json({ ok: true, created, updated, skipped, total: created + updated });
  });

  // ── Feedback ────────────────────────────────────────────────────

  const feedbackLimiter = rateLimiter(60_000, 10);
  router.post('/feedback', feedbackLimiter, async (req, res) => {
    if (!ctx.feedback) {
      res.status(503).json({ error: 'Feedback not configured' });
      return;
    }

    const { type, title, description, context } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string' || description.length > 10_000) {
      res.status(400).json({ error: '"description" must be a string under 10KB' });
      return;
    }
    if (context !== undefined && (typeof context !== 'string' || context.length > 5_000)) {
      res.status(400).json({ error: '"context" must be a string under 5KB if provided' });
      return;
    }

    const validTypes = ['bug', 'feature', 'improvement', 'question', 'hallucination', 'other'];
    const feedbackType = validTypes.includes(type) ? type : 'other';

    // Semantic quality validation
    const quality = ctx.feedback.validateFeedbackQuality(title, description);
    if (!quality.valid) {
      res.status(422).json({ error: quality.reason });
      return;
    }

    // Anomaly detection — check submission patterns before storing
    if (ctx.feedbackAnomalyDetector) {
      const agentPseudonym = ctx.feedback.generatePseudonym(ctx.config.projectName);
      const anomalyCheck = ctx.feedbackAnomalyDetector.check(agentPseudonym);
      if (!anomalyCheck.allowed) {
        res.status(429).json({
          error: anomalyCheck.reason,
          anomalyType: anomalyCheck.anomalyType,
        });
        return;
      }
    }

    try {
      const item = await ctx.feedback.submit({
        type: feedbackType,
        title,
        description,
        context: context || undefined,
        agentName: ctx.config.projectName,
        instarVersion: ProcessIntegrity.getInstance()?.runningVersion || ctx.config.version || '0.0.0',
        nodeVersion: process.version,
        os: `${process.platform} ${process.arch}`,
      });

      // Record submission for anomaly tracking
      if (ctx.feedbackAnomalyDetector && item.agentPseudonym) {
        ctx.feedbackAnomalyDetector.recordSubmission(item.agentPseudonym);
      }

      res.status(201).json({
        ok: true,
        id: item.id,
        forwarded: item.forwarded,
        message: item.forwarded
          ? 'Feedback submitted and forwarded upstream.'
          : 'Feedback stored locally. Will retry forwarding later.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/feedback', (_req, res) => {
    if (!ctx.feedback) {
      res.json({ feedback: [] });
      return;
    }
    res.json({ feedback: ctx.feedback.list() });
  });

  router.post('/feedback/retry', async (_req, res) => {
    if (!ctx.feedback) {
      res.status(503).json({ error: 'Feedback not configured' });
      return;
    }

    try {
      const result = await ctx.feedback.retryUnforwarded();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Updates ────────────────────────────────────────────────────

  router.get('/updates', async (_req, res) => {
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    try {
      const info = await ctx.updateChecker.check();
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/updates/last', (_req, res) => {
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    const lastCheck = ctx.updateChecker.getLastCheck();
    if (!lastCheck) {
      res.json({ message: 'No update check has been performed yet' });
      return;
    }
    res.json(lastCheck);
  });

  router.get('/updates/config', (_req, res) => {
    res.json({
      autoApply: ctx.config.updates?.autoApply ?? true,
    });
  });

  router.patch('/updates/config', (req, res) => {
    const { autoApply } = req.body ?? {};
    if (typeof autoApply !== 'boolean') {
      res.status(400).json({ error: 'autoApply must be a boolean' });
      return;
    }

    // Update the runtime config
    if (!ctx.config.updates) {
      (ctx.config as any).updates = { autoApply };
    } else {
      ctx.config.updates.autoApply = autoApply;
    }

    // Persist to config.json
    const configPath = path.join(ctx.config.stateDir, 'config.json');
    try {
      const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
      if (!raw.updates) raw.updates = {};
      raw.updates.autoApply = autoApply;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
    } catch (err) {
      res.status(500).json({ error: `Failed to persist config: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Update the AutoUpdater's live config
    if (ctx.autoUpdater) {
      (ctx.autoUpdater as any).config.autoApply = autoApply;
    }

    res.json({ autoApply, persisted: true });
  });

  router.post('/updates/apply', async (_req, res) => {
    // Prefer AutoUpdater path (coalescing + session-aware gating)
    if (ctx.autoUpdater) {
      try {
        await ctx.autoUpdater.applyPendingUpdate({ bypassWindow: true });
        res.json(ctx.autoUpdater.getStatus());
      } catch (err) {
        // @silent-fallback-ok — returns HTTP 500 with error details to caller; not a silent degradation
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Fallback: direct apply (no coalescing/gating)
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    try {
      const result = await ctx.updateChecker.applyUpdate();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/updates/rollback', async (_req, res) => {
    if (!ctx.updateChecker) {
      res.status(503).json({ error: 'Update checker not configured' });
      return;
    }

    if (!ctx.updateChecker.canRollback()) {
      res.status(409).json({
        error: 'No rollback available. A successful update must have occurred first.',
      });
      return;
    }

    try {
      const result = await ctx.updateChecker.rollback();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Auto-Updater ────────────────────────────────────────────────

  router.get('/updates/auto', (_req, res) => {
    if (!ctx.autoUpdater) {
      res.status(503).json({ error: 'Auto-updater not configured' });
      return;
    }
    res.json(ctx.autoUpdater.getStatus());
  });

  // GET /updates/status — comprehensive update status for monitoring/UI
  router.get('/updates/status', async (_req, res) => {
    const status: Record<string, unknown> = {
      currentVersion: ctx.updateChecker?.getInstalledVersion() ?? 'unknown',
      autoApply: ctx.config.updates?.autoApply ?? true,
    };

    if (ctx.autoUpdater) {
      const auto = ctx.autoUpdater.getStatus();
      Object.assign(status, {
        pendingUpdate: auto.pendingUpdate,
        pendingUpdateDetectedAt: auto.pendingUpdateDetectedAt,
        coalescingUntil: auto.coalescingUntil,
        deferralReason: auto.deferralReason,
        deferralElapsedMinutes: auto.deferralElapsedMinutes,
        maxDeferralHours: auto.maxDeferralHours,
        restartDeferral: auto.restartDeferral,
        restartImmediately: auto.restartImmediately,
        lastCheck: auto.lastCheck,
        lastApply: auto.lastApply,
        lastAppliedVersion: auto.lastAppliedVersion,
        lastError: auto.lastError,
      });
    }

    res.json(status);
  });

  // ── Dispatches ───────────────────────────────────────────────────

  router.get('/dispatches', async (_req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    try {
      // Use checkAndAutoApply when autoApply is configured
      const result = ctx.config.dispatches?.autoApply
        ? await ctx.dispatches.checkAndAutoApply()
        : await ctx.dispatches.check();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/dispatches/auto', (_req, res) => {
    if (!ctx.autoDispatcher) {
      res.status(503).json({ error: 'Auto-dispatcher not configured' });
      return;
    }
    res.json(ctx.autoDispatcher.getStatus());
  });

  router.get('/dispatches/pending', (_req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    res.json({ dispatches: ctx.dispatches.pending() });
  });

  router.get('/dispatches/context', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({ context: '' });
      return;
    }

    res.json({ context: ctx.dispatches.generateContext() });
  });

  router.post('/dispatches/:id/apply', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const success = ctx.dispatches.applyToContext(req.params.id);
    if (success) {
      res.json({ applied: true, contextFile: ctx.dispatches.getContextFilePath() });
    } else {
      res.status(404).json({ error: 'Dispatch not found' });
    }
  });

  router.post('/dispatches/:id/evaluate', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const { decision, reason } = req.body as { decision?: string; reason?: string };
    const validDecisions = ['accepted', 'rejected', 'deferred'];

    if (!decision || !validDecisions.includes(decision)) {
      res.status(400).json({ error: `"decision" must be one of: ${validDecisions.join(', ')}` });
      return;
    }
    if (!reason || typeof reason !== 'string' || reason.length < 1) {
      res.status(400).json({ error: '"reason" must be a non-empty string' });
      return;
    }
    if (reason.length > 2000) {
      res.status(400).json({ error: '"reason" must be under 2000 characters' });
      return;
    }

    const success = ctx.dispatches.evaluate(
      req.params.id,
      decision as 'accepted' | 'rejected' | 'deferred',
      reason,
    );

    if (!success) {
      res.status(404).json({ error: 'Dispatch not found' });
      return;
    }

    // If accepted, also apply to context file
    if (decision === 'accepted') {
      ctx.dispatches.applyToContext(req.params.id);
    }

    res.json({ evaluated: true, decision });
  });

  router.post('/dispatches/:id/approve', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const success = ctx.dispatches.approve(req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Dispatch not found or not pending approval' });
      return;
    }

    res.json({ approved: true, dispatchId: req.params.id });
  });

  router.post('/dispatches/:id/reject', (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const { reason } = req.body as { reason?: string };
    if (!reason || typeof reason !== 'string' || reason.length < 1) {
      res.status(400).json({ error: '"reason" must be a non-empty string' });
      return;
    }
    if (reason.length > 2000) {
      res.status(400).json({ error: '"reason" must be under 2000 characters' });
      return;
    }

    const success = ctx.dispatches.reject(req.params.id, reason);
    if (!success) {
      res.status(404).json({ error: 'Dispatch not found or not pending approval' });
      return;
    }

    res.json({ rejected: true, dispatchId: req.params.id, reason });
  });

  router.get('/dispatches/pending-approval', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({ dispatches: [] });
      return;
    }

    res.json({ dispatches: ctx.dispatches.pendingApproval() });
  });

  router.get('/dispatches/applied', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({ context: '', contextFile: '' });
      return;
    }

    res.json({
      context: ctx.dispatches.readContextFile(),
      contextFile: ctx.dispatches.getContextFilePath(),
    });
  });

  router.post('/dispatches/:id/feedback', async (req, res) => {
    if (!ctx.dispatches) {
      res.status(503).json({ error: 'Dispatch system not configured' });
      return;
    }

    const { helpful, comment } = req.body as { helpful?: boolean; comment?: string };

    if (typeof helpful !== 'boolean') {
      res.status(400).json({ error: '"helpful" must be a boolean' });
      return;
    }
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > 2000)) {
      res.status(400).json({ error: '"comment" must be a string under 2000 characters' });
      return;
    }

    const success = ctx.dispatches.recordFeedback(req.params.id, helpful, comment);
    if (!success) {
      res.status(404).json({ error: 'Dispatch not found' });
      return;
    }

    // Also forward to FeedbackManager for upstream delivery to Dawn
    if (ctx.feedback) {
      const dispatch = ctx.dispatches.get(req.params.id);
      try {
        await ctx.feedback.submit({
          type: 'improvement',
          title: `Dispatch feedback: ${dispatch?.title ?? req.params.id}`,
          description: `Dispatch ${req.params.id} was ${helpful ? 'helpful' : 'not helpful'}.${comment ? ` Comment: ${comment}` : ''}`,
          agentName: ctx.config.projectName,
          instarVersion: ProcessIntegrity.getInstance()?.runningVersion || ctx.config.version || '0.0.0',
          nodeVersion: process.version,
          os: process.platform,
          context: JSON.stringify({
            dispatchId: req.params.id,
            dispatchType: dispatch?.type,
            helpful,
            comment,
          }),
        });
      } catch {
        // Don't fail the response if feedback forwarding fails
      }
    }

    res.json({ recorded: true, helpful });
  });

  router.get('/dispatches/stats', (_req, res) => {
    if (!ctx.dispatches) {
      res.json({
        total: 0, applied: 0, pending: 0, rejected: 0,
        helpfulCount: 0, unhelpfulCount: 0, byType: {},
      });
      return;
    }

    res.json(ctx.dispatches.stats());
  });

  // ── Quota ──────────────────────────────────────────────────────

  router.get('/quota', (_req, res) => {
    if (!ctx.quotaTracker) {
      res.json({ status: 'not_configured', usagePercent: null });
      return;
    }
    const state = ctx.quotaTracker.getState();
    res.json({
      status: state ? 'ok' : 'no_data',
      ...(state ?? {}),
      recommendation: ctx.quotaTracker.getRecommendation(),
    });
  });

  // GET /quota/migration — Session migration state, history, and config
  router.get('/quota/migration', (_req, res) => {
    if (!ctx.quotaManager) {
      res.json({ status: 'not_configured' });
      return;
    }
    res.json(ctx.quotaManager.getMigrationStatus());
  });

  // POST /quota/migration/trigger — Manually trigger a migration
  router.post('/quota/migration/trigger', async (req, res) => {
    if (!ctx.quotaManager) {
      res.status(503).json({ error: 'QuotaManager not configured' });
      return;
    }
    try {
      const { targetAccount, bypassCooldown } = req.body ?? {};
      const result = await ctx.quotaManager.triggerMigration({ targetAccount, bypassCooldown });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /quota/polling — Adaptive polling state
  router.get('/quota/polling', (_req, res) => {
    if (!ctx.quotaManager) {
      res.json({ status: 'not_configured' });
      return;
    }
    res.json(ctx.quotaManager.getPollingStatus());
  });

  // ── Publishing (Telegraph) ──────────────────────────────────────

  router.post('/publish', async (req, res) => {
    if (!ctx.publisher) {
      res.status(503).json({ error: 'Publishing not configured' });
      return;
    }

    const { title, markdown, confirmed } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }
    if (markdown.length > 100_000) {
      res.status(400).json({ error: '"markdown" must be under 100KB' });
      return;
    }

    // Confirmation gate: Telegraph pages are PUBLIC. Require explicit confirmation.
    if (!confirmed) {
      res.status(400).json({
        error: 'Publishing requires confirmation',
        requiresConfirmation: true,
        warning: 'This will create a PUBLIC Telegraph page. Anyone with the URL can view it. ' +
          'Set "confirmed": true to proceed.',
        preview: { title, contentLength: markdown.length },
      });
      return;
    }

    try {
      const page = await ctx.publisher.publishPage(title, markdown);
      res.status(201).json({
        ...page,
        warning: 'This page is PUBLIC. Anyone with the URL can view it.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/published', (_req, res) => {
    if (!ctx.publisher) {
      res.json({ pages: [] });
      return;
    }

    res.json({ pages: ctx.publisher.listPages() });
  });

  router.put('/publish/:path', async (req, res) => {
    if (!ctx.publisher) {
      res.status(503).json({ error: 'Publishing not configured' });
      return;
    }

    const pagePath = req.params.path;
    if (!pagePath || pagePath.length > 256) {
      res.status(400).json({ error: 'Invalid page path' });
      return;
    }

    const { title, markdown } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }
    if (markdown.length > 100_000) {
      res.status(400).json({ error: '"markdown" must be under 100KB' });
      return;
    }

    try {
      const page = await ctx.publisher.editPage(pagePath, title, markdown);
      res.json(page);
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'routes.editPage',
        primary: 'Edit page via API',
        fallback: 'Return 500 error',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Page edit failed — user sees error but no system alert for pattern detection',
      });
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Private Views (auth-gated rendered markdown) ────────────────

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  /** Build a browser-clickable tunnel URL with HMAC signature for auth */
  function viewTunnelUrl(viewId: string): string | null {
    const base = ctx.tunnel?.getExternalUrl(`/view/${viewId}`);
    if (!base) return null;
    if (ctx.config.authToken) {
      const viewPath = `/view/${viewId}`;
      const sig = signViewPath(viewPath, ctx.config.authToken);
      return `${base}?sig=${sig}`;
    }
    return base;
  }

  router.post('/view', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    const { title, markdown, pin, metadata } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }
    if (markdown.length > 500_000) {
      res.status(400).json({ error: '"markdown" must be under 500KB' });
      return;
    }
    if (pin !== undefined && (typeof pin !== 'string' || pin.length < 4 || pin.length > 32)) {
      res.status(400).json({ error: '"pin" must be a string between 4 and 32 characters' });
      return;
    }
    // Validate metadata if provided
    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
      res.status(400).json({ error: '"metadata" must be an object' });
      return;
    }
    if (metadata?.source) {
      if (typeof metadata.source !== 'object' || !metadata.source.type || !metadata.source.id) {
        res.status(400).json({ error: '"metadata.source" must have "type" and "id" strings' });
        return;
      }
    }

    const view = ctx.viewer.create(title, markdown, pin, metadata);

    res.status(201).json({
      id: view.id,
      title: view.title,
      pinProtected: !!view.pinHash,
      localUrl: `/view/${view.id}`,
      tunnelUrl: viewTunnelUrl(view.id),
      createdAt: view.createdAt,
    });
  });

  router.get('/view/:id', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const view = ctx.viewer.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    // PIN-protected views show PIN entry page
    if (view.pinHash) {
      const html = ctx.viewer.renderPinPage(view);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    // Serve rendered HTML
    const html = ctx.viewer.renderHtml(view);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.post('/view/:id/unlock', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const view = ctx.viewer.get(req.params.id);
    if (!view) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    if (!view.pinHash) {
      // No PIN needed — return content directly
      const html = ctx.viewer.renderHtml(view);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    const { pin } = req.body;
    if (!pin || typeof pin !== 'string') {
      res.status(400).json({ error: '"pin" is required' });
      return;
    }

    if (!ctx.viewer.verifyPin(req.params.id, pin)) {
      res.status(403).json({ error: 'Incorrect PIN' });
      return;
    }

    const html = ctx.viewer.renderHtml(view);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  router.get('/views', (_req, res) => {
    if (!ctx.viewer) {
      res.json({ views: [] });
      return;
    }

    let allViews = ctx.viewer.list();

    // Filter by source if provided (e.g. ?source=job:coherence-audit)
    const source = _req.query.source as string | undefined;
    if (source && source.includes(':')) {
      const [sourceType, sourceId] = source.split(':', 2);
      allViews = allViews.filter(v =>
        v.metadata?.source?.type === sourceType && v.metadata?.source?.id === sourceId
      );
    }

    const views = allViews.map(v => ({
      id: v.id,
      title: v.title,
      localUrl: `/view/${v.id}`,
      tunnelUrl: viewTunnelUrl(v.id),
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      metadata: v.metadata,
    }));
    res.json({ views });
  });

  router.put('/view/:id', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const { title, markdown } = req.body;
    if (!title || typeof title !== 'string' || title.length > 256) {
      res.status(400).json({ error: '"title" must be a string under 256 characters' });
      return;
    }
    if (!markdown || typeof markdown !== 'string') {
      res.status(400).json({ error: '"markdown" must be a non-empty string' });
      return;
    }

    const updated = ctx.viewer.update(req.params.id, title, markdown);
    if (!updated) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    res.json({
      id: updated.id,
      title: updated.title,
      localUrl: `/view/${updated.id}`,
      tunnelUrl: viewTunnelUrl(updated.id),
      updatedAt: updated.updatedAt,
    });
  });

  router.delete('/view/:id', (req, res) => {
    if (!ctx.viewer) {
      res.status(503).json({ error: 'Private viewer not configured' });
      return;
    }

    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid view ID' });
      return;
    }

    const deleted = ctx.viewer.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'View not found' });
      return;
    }

    res.json({ ok: true, deleted: req.params.id });
  });

  // ── Secret Drop (secure secret submission) ─────────────────────

  const secretDrop = new SecretDrop(ctx.config.projectName || 'Agent');

  // Stuck-consumer hardening: when an agent's consumer chain fails to
  // claim a submitted secret within the grace window, route a visible
  // cue to the bound topic so the operator hears about the failure
  // instead of silently waiting on a value that never arrives. Added
  // 2026-05-20 in response to the topic-10873 lost-SMS-code incident.
  secretDrop.onStuckConsumer((event) => {
    if (!event.topicId || !ctx.sessionManager) return;
    const topicId = event.topicId;
    const systemMsg = `[secret-drop-stuck] Secret "${event.label}" was submitted but has not been consumed by an agent process. ` +
      `If you weren't expecting this, the consumer may have hit a bug. ` +
      `The submission will auto-clean in ~${event.minutesUntilCleanup} minute(s). ` +
      `To retry, use the hardened helper (non-destructive): node .instar/scripts/secret-drop-retrieve.mjs ${event.token} <field-name>. ` +
      `Discover field names with --names. DO NOT use raw curl against /secrets/retrieve.`;
    try {
      const sdRegistryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
      let targetSession: string | null = null;
      if (fs.existsSync(sdRegistryPath)) {
        const registry = JSON.parse(fs.readFileSync(sdRegistryPath, 'utf-8'));
        targetSession = registry.topicToSession?.[String(topicId)] ?? null;
      }
      if (targetSession && ctx.sessionManager.isSessionAlive(targetSession)) {
        ctx.sessionManager.injectPasteNotification(
          targetSession,
          `<system-reminder>${systemMsg}</system-reminder>`,
        );
      }
    } catch (err) {
      // @silent-fallback-ok — the stuck-consumer signal is best-effort
      console.error('[secret-drop] stuck-consumer notify failed:', err instanceof Error ? err.message : String(err));
    }
  });

  /** Build a browser-clickable tunnel URL for a secret drop */
  function secretDropUrl(token: string): { localUrl: string; tunnelUrl: string | null } {
    const localUrl = `/secrets/drop/${token}`;
    const tunnelUrl = ctx.tunnel?.getExternalUrl(localUrl) ?? null;
    return { localUrl, tunnelUrl };
  }

  // Shared body validation for BOTH secret-mint paths: the bearer-gated
  // /secrets/request and the loopback-only /threadline/secrets/request
  // (sealed-handoff keystone). Keeping the contract in ONE place prevents the two
  // mint paths from drifting — a divergence on a credential-minting boundary would
  // itself be a security bug. Returns either an { error } (→ 400) or the validated
  // { opts } ready for secretDrop.create().
  function validateSecretRequestBody(
    body: any,
  ): { error: string } | { opts: CreateSecretRequestOptions } {
    const { label, description, fields, topicId, ttlMs, senderVerification } = body ?? {};

    if (!label || typeof label !== 'string' || label.length > 256) {
      return { error: '"label" must be a non-empty string under 256 characters' };
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 1024)) {
      return { error: '"description" must be a string under 1024 characters' };
    }
    if (fields !== undefined) {
      if (!Array.isArray(fields) || fields.length === 0 || fields.length > 10) {
        return { error: '"fields" must be an array of 1-10 items' };
      }
      for (const f of fields) {
        if (!f.name || typeof f.name !== 'string' || !f.label || typeof f.label !== 'string') {
          return { error: 'Each field must have a "name" and "label"' };
        }
      }
    }
    if (topicId !== undefined && (typeof topicId !== 'number' || !Number.isInteger(topicId))) {
      return { error: '"topicId" must be an integer' };
    }
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || ttlMs < 60_000 || ttlMs > 3600_000)) {
      return { error: '"ttlMs" must be between 60000 (1 min) and 3600000 (1 hour)' };
    }
    // R1a sealed-handoff (optional): pin the expected sender's Ed25519 pubkey so
    // the submit handler can verify the signed payload before accept.
    if (senderVerification !== undefined) {
      if (
        typeof senderVerification !== 'object' ||
        senderVerification === null ||
        typeof senderVerification.senderPubKeyHex !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(senderVerification.senderPubKeyHex)
      ) {
        return { error: '"senderVerification.senderPubKeyHex" must be a 64-char hex Ed25519 public key' };
      }
    }

    return { opts: { label, description, fields, topicId, ttlMs, senderVerification } };
  }

  // Create a new secret request (agent-facing, requires auth)
  router.post('/secrets/request', (req, res) => {
    const validated = validateSecretRequestBody(req.body);
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    try {
      const { token } = secretDrop.create(validated.opts);
      const urls = secretDropUrl(token);
      res.status(201).json({
        token,
        ...urls,
        expiresIn: validated.opts.ttlMs || 15 * 60 * 1000,
      });
    } catch (err) {
      res.status(429).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Sealed-handoff KEYSTONE: agent self-mint of a Secret Drop request over a
  // localhost-only loopback that does NOT require the externalized bearer.
  //
  // Why this exists: the Threadline MCP server runs as a SEPARATE stdio process
  // (.mcp.json → node mcp-stdio-entry.js) and can only read the on-disk
  // config.json, where authToken is vault-externalized ({secret:true}) — so it
  // cannot present a valid bearer to the gated /secrets/request. This route lives
  // under /threadline/* (authMiddleware bypasses the general bearer there, like
  // relay-send) but ADDS explicit loopback enforcement, because minting a
  // credential-collection URL is more sensitive than a relay send: any
  // non-loopback origin or any X-Forwarded-For is rejected (defense-in-depth
  // against a misconfigured bind or a tunnel accidentally forwarding internal
  // paths). It routes through the SAME durable server-side SecretDrop store, so
  // the minted request survives session churn — the robustness property. Spec:
  // SEALED-HANDOFF §keystone ("a localhost-only loopback that does not require
  // the externalized bearer — NOT by scraping the vault").
  router.post('/threadline/secrets/request', (req, res) => {
    const remote = req.socket?.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.status(403).json({ error: 'Self-mint is localhost-only' });
      return;
    }
    if (req.headers['x-forwarded-for']) {
      res.status(403).json({ error: 'Self-mint rejects forwarded (X-Forwarded-For) requests' });
      return;
    }
    const validated = validateSecretRequestBody(req.body);
    if ('error' in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    try {
      const { token } = secretDrop.create(validated.opts);
      const urls = secretDropUrl(token);
      res.status(201).json({
        token,
        ...urls,
        expiresIn: validated.opts.ttlMs || 15 * 60 * 1000,
      });
    } catch (err) {
      res.status(429).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve the secret submission form (user-facing, NO auth — token is the auth)
  router.get('/secrets/drop/:token', (req, res) => {
    const request = secretDrop.getPending(req.params.token);
    if (!request) {
      const html = secretDrop.renderExpiredPage();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(410).send(html);
      return;
    }

    const html = secretDrop.renderForm(request);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Security headers — prevent framing, sniffing, caching
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.send(html);
  });

  // Receive a secret submission (user-facing, NO auth — token + CSRF is the auth)
  router.post('/secrets/drop/:token', async (req, res) => {
    const { _csrf, ...values } = req.body;

    if (!_csrf || typeof _csrf !== 'string') {
      res.status(400).json({ error: 'Missing CSRF token' });
      return;
    }

    // Validate all values are strings
    for (const [key, val] of Object.entries(values)) {
      if (typeof val !== 'string') {
        res.status(400).json({ error: `Field "${key}" must be a string` });
        return;
      }
      if ((val as string).length > 10_000) {
        res.status(400).json({ error: `Field "${key}" exceeds maximum length (10KB)` });
        return;
      }
    }

    // ── R2 (sealed-handoff): trust-gated transfer authorization ──────────────
    // When the pending request pins a peer's sender key, this is a peer-to-peer
    // credential transfer (not an ordinary user Secret Drop). Per Justin's
    // 2026-06-01 directive, such a transfer needs NO operator approval only when
    // BOTH trust axes are high: this agent trusts the peer ≥ 'trusted' AND the
    // user has granted credential-transfer autonomy ≥ 'log'. A transfer is a
    // 'modify'-class op (default 'approve-always', below the bar), so absent an
    // explicit grant it requires operator authorization — and since the
    // operator-authorization store is a follow-up, a below-the-bar transfer is
    // refused here (fail-closed) BEFORE the one-time request is consumed. Ordinary
    // user Secret Drops (no senderVerification) are untouched.
    {
      const pending = secretDrop.getPending(req.params.token);
      const peerKeyHex = pending?.senderVerification?.senderPubKeyHex;
      if (peerKeyHex) {
        let peerFp = '';
        try { peerFp = computeFingerprint(Buffer.from(peerKeyHex, 'hex')); } catch { /* malformed → '' → untrusted */ }
        const peerTrust = (ctx.unifiedTrust?.trustManager?.getTrustLevelByFingerprint(peerFp)
          ?? 'untrusted') as PeerTrustLevel;
        const opAutonomy = (ctx.adaptiveTrust?.getTrustLevel('threadline', 'modify')?.level
          ?? 'approve-always') as OperationAutonomyLevel;
        const decision = evaluateTransferAuthorization({
          requesterFingerprint: 'self', // receiver = this agent; only consulted once an operator-auth record exists
          holderFingerprint: peerFp,
          requestId: req.params.token,
          authorization: null,          // operator-auth store is a follow-up; below-the-bar fails closed
          trust: { peerTrust, opAutonomy },
        });
        if (!decision.allow) {
          res.status(403).json({ error: 'Transfer not authorized by trust policy', reason: decision.reason });
          return;
        }
      }
    }

    const submission = secretDrop.submit(req.params.token, _csrf, values as Record<string, string>);
    if (!submission) {
      res.status(410).json({ error: 'This link has expired or already been used' });
      return;
    }

    // Send Telegram confirmation if topic is configured
    if (submission.topicId && ctx.telegram) {
      const fieldCount = Object.keys(submission.values).length;
      const confirmMsg = `\u2705 Secret received for "${submission.label}" (${fieldCount} field${fieldCount !== 1 ? 's' : ''}).`;
      ctx.telegram.sendToTopic(submission.topicId, confirmMsg).catch(() => {
        // @silent-fallback-ok — Non-fatal — the submission itself succeeded
      });
    }

    // Route a system message to the agent session so it can respond conversationally.
    // Uses the same inject-or-spawn pattern as Telegram forwarding.
    if (submission.topicId && ctx.sessionManager) {
      const topicId = submission.topicId;
      const fieldCount = Object.keys(submission.values).length;
      const fieldNames = Object.keys(submission.values).join(', ');
      const systemMsg = `[secret-drop-received] Secret "${submission.label}" was just submitted (${fieldCount} field${fieldCount !== 1 ? 's' : ''}: ${fieldNames}). ` +
        `Retrieve with the HARDENED helper (streams field value to stdout, never prints the response body): node .instar/scripts/secret-drop-retrieve.mjs ${req.params.token} <field-name>. ` +
        `Discover field names with: node .instar/scripts/secret-drop-retrieve.mjs ${req.params.token} --names. ` +
        `Default is non-destructive (safe to retry); append --consume after successful handoff. ` +
        `DO NOT use raw curl against /secrets/retrieve — that pattern leaks the value into the Bash tool transcript. ` +
        `Then acknowledge receipt to the user conversationally via Telegram topic ${topicId}.`;

      const sdRegistryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
      let targetSession: string | null = null;
      try {
        if (fs.existsSync(sdRegistryPath)) {
          const registry = JSON.parse(fs.readFileSync(sdRegistryPath, 'utf-8'));
          targetSession = registry.topicToSession?.[String(topicId)] ?? null;
        }
      } catch { /* registry read failed — fall through to spawn */ }

      if (targetSession && ctx.sessionManager.isSessionAlive(targetSession)) {
        // Inject into existing session as a system reminder
        ctx.sessionManager.injectPasteNotification(targetSession,
          `<system-reminder>${systemMsg}</system-reminder>`);
      } else {
        // No live session — spawn one to handle the secret receipt
        let topicName = `topic-${topicId}`;
        // Try live adapter first, then disk registry, then active probe
        if (ctx.telegram) {
          const liveName = ctx.telegram.getTopicName(topicId);
          if (liveName && !/^topic-\d+$/.test(liveName)) {
            topicName = liveName;
          }
        }
        if (/^topic-\d+$/.test(topicName)) {
          try {
            if (fs.existsSync(sdRegistryPath)) {
              const reg = JSON.parse(fs.readFileSync(sdRegistryPath, 'utf-8'));
              const stored = reg.topicToName?.[String(topicId)];
              if (stored && !/^topic-\d+$/.test(stored)) topicName = stored;
            }
          } catch { /* fall through */ }
        }
        if (/^topic-\d+$/.test(topicName) && ctx.telegram) {
          try {
            const resolved = await ctx.telegram.resolveTopicName(topicId);
            if (resolved) topicName = resolved;
          } catch { /* fall through to default */ }
        }

        // Build context with thread history
        const historyLines: string[] = [];
        if (ctx.telegram) {
          try {
            const history = ctx.telegram.getTopicHistory(topicId, 50);
            if (history.length > 0) {
              historyLines.push(`--- Thread History (last ${history.length} messages) ---`);
              historyLines.push(`IMPORTANT: Read this history carefully before taking any action.`);
              historyLines.push(`Your task is to continue THIS conversation, not start something new.`);
              historyLines.push(`Topic: ${topicName}`);
              historyLines.push(``);
              for (const m of history) {
                const sender = m.fromUser ? (m.senderName || 'User') : 'Agent';
                const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
                const histText = (m.text || '').slice(0, 2000);
                historyLines.push(`[${ts}] ${sender}: ${histText}`);
              }
              historyLines.push(``);
              historyLines.push(`--- End Thread History ---`);
            }
          } catch {
            // Non-fatal — spawn without history
          }
        }

        const contextLines = [
          ...historyLines,
          ``,
          `This session was auto-created because a Secret Drop was submitted.`,
          ``,
          systemMsg,
        ];
        const tmpDir = '/tmp/instar-telegram';
        fs.mkdirSync(tmpDir, { recursive: true });
        const ctxPath = path.join(tmpDir, `ctx-${topicId}-${Date.now()}.txt`);
        fs.writeFileSync(ctxPath, contextLines.join('\n'));

        const { buildTelegramRelayBlock } = await import('../messaging/shared/telegramRelayPrompt.js');
        const relayBlock = buildTelegramRelayBlock({ topicId, framework: 'claude-code' });
        const bootstrapMessage = `[telegram:${topicId}] ${systemMsg} (Thread history at ${ctxPath} — read it before responding.)\n\n${relayBlock}`;

        const resumeSessionId = ctx.topicResumeMap?.get(topicId) ?? undefined;
        ctx.sessionManager.spawnInteractiveSession(bootstrapMessage, topicName, { telegramTopicId: topicId, resumeSessionId }).then((newSessionName) => {
          if (resumeSessionId) ctx.topicResumeMap?.remove(topicId);
          // Register in-memory topic↔session mapping for beforeSessionKill
          ctx.telegram?.registerTopicSession(topicId, newSessionName, topicName);
          try {
            const reg = fs.existsSync(sdRegistryPath) ? JSON.parse(fs.readFileSync(sdRegistryPath, 'utf-8')) : { topicToSession: {}, topicToName: {} };
            reg.topicToSession[String(topicId)] = newSessionName;
            fs.writeFileSync(sdRegistryPath, JSON.stringify(reg, null, 2));
          } catch { /* @silent-fallback-ok — registry write non-critical */ }
          // Proactive UUID save — always run, even after --resume (new session = new UUID)
          // ONLY uses authoritative claudeSessionId — never mtime fallback, which can
          // pick up a UUID from a different topic's concurrent session.
          if (ctx.topicResumeMap) {
            setTimeout(() => {
              try {
                const sessions = ctx.sessionManager?.listRunningSessions() ?? [];
                const session = sessions.find(s => s.tmuxSession === newSessionName);
                if (session?.claudeSessionId) {
                  ctx.topicResumeMap!.save(topicId, session.claudeSessionId, newSessionName);
                  console.log(`[secret-drop] Proactive UUID save: ${session.claudeSessionId} for topic ${topicId} (source: hook)`);
                }
              } catch (err) {
                console.error(`[secret-drop] Proactive UUID save failed:`, err);
              }
            }, 8000);
          }
          console.log(`[secret-drop] Spawned "${newSessionName}" for secret receipt on topic ${topicId}`);
        }).catch((err) => {
          console.error(`[secret-drop] Session spawn failed:`, err);
        });
      }
    }

    res.json({ ok: true, receivedAt: submission.receivedAt });
  });

  // List pending secret requests (agent-facing, requires auth)
  router.get('/secrets/pending', (_req, res) => {
    const pending = secretDrop.listPending();
    res.json({
      pending: pending.map(p => ({
        ...p,
        ...secretDropUrl(p.token),
      })),
    });
  });

  // Cancel a pending secret request (agent-facing, requires auth)
  router.delete('/secrets/pending/:token', (req, res) => {
    const cancelled = secretDrop.cancel(req.params.token);
    if (!cancelled) {
      res.status(404).json({ error: 'Request not found or already expired' });
      return;
    }
    res.json({ ok: true });
  });

  // Retrieve a received secret (agent-facing, requires auth).
  //
  // Non-destructive by default — repeated calls return the same value
  // until the in-memory cleanup timer fires (~5 min). Pass `?consume=true`
  // for the legacy one-shot semantics. Rationale: a buggy consumer that
  // dropped the response value used to lose the secret with no recovery;
  // non-destructive default lets the caller retry. See
  // docs/specs/secret-drop-hardening.md for the full rationale.
  router.post('/secrets/retrieve/:token', (req, res) => {
    const consumeFlag = req.query.consume;
    const consume = consumeFlag === 'true' || consumeFlag === '1';
    const submission = consume
      ? secretDrop.consumeReceived(req.params.token)
      : secretDrop.peekReceived(req.params.token);
    if (!submission) {
      res.status(404).json({ error: 'No submission found for this token' });
      return;
    }
    res.json({ ...submission, consumed: consume });
  });

  // ── Tunnel Status ──────────────────────────────────────────────

  router.get('/tunnel', (_req, res) => {
    if (!ctx.tunnel) {
      res.json({ enabled: false, url: null });
      return;
    }

    // Lifecycle snapshot for the failure-resilience surface (spec Part 8 —
    // this is THE assertable surface for the event-driven feature). The
    // route is Bearer-gated by authMiddleware, so callers are owner-level.
    // lastFailureReason is a classified enum (never a raw/credentialed URL —
    // spec Part 6); no PIN/token is ever included here.
    const lc = ctx.tunnel.lifecycleState;
    res.json({
      enabled: true,
      running: ctx.tunnel.isRunning,
      ...ctx.tunnel.state,
      lifecycle: {
        state: lc.lastState,
        activeProvider: lc.activeProvider ?? null,
        lastFailureReason: lc.episode?.lastFailureReason ?? null,
        episodeId: lc.episode?.episodeId ?? null,
        rotationPending: lc.rotationPending,
      },
    });
  });

  // ── Dashboard Refresh ────────────────────────────────────────────
  // Re-broadcasts the dashboard URL to Telegram (edit-in-place).
  // Designed to be called by a lightweight cron job so the pinned
  // dashboard link never goes stale.

  router.post('/telegram/dashboard-refresh', async (_req, res) => {
    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }
    if (!ctx.tunnel) {
      res.status(503).json({ error: 'Tunnel not running', action: 'skipped' });
      return;
    }

    const tunnelUrl = ctx.tunnel.url;
    if (!tunnelUrl) {
      res.status(503).json({ error: 'Tunnel has no URL yet', action: 'skipped' });
      return;
    }

    const tunnelType = (ctx.config.tunnel?.type === 'named' ? 'named' : 'quick') as 'quick' | 'named';

    // Named tunnels have permanent URLs — skip periodic refresh calls since
    // the URL never changes. The initial broadcast on server startup is sufficient.
    if (tunnelType === 'named') {
      res.json({ action: 'skipped', reason: 'named tunnel — URL is permanent', url: tunnelUrl, tunnelType });
      return;
    }

    try {
      await ctx.telegram.broadcastDashboardUrl(tunnelUrl, tunnelType);
      res.json({ action: 'refreshed', url: tunnelUrl, tunnelType });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Events ──────────────────────────────────────────────────────

  router.get('/events', (req, res) => {
    const rawLimit = parseInt(req.query.limit as string, 10) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), 1000);
    const rawType = req.query.type as string | undefined;
    const type = rawType && rawType.length <= 64 ? rawType : undefined;
    const rawSinceHours = parseInt(req.query.since as string, 10) || 24;
    const sinceHours = Math.min(Math.max(rawSinceHours, 1), 720); // 1h to 30 days

    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const events = ctx.state.queryEvents({ since, type, limit });

    res.json(events);
  });

  // ── Internal: Lifeline Telegram Forward ─────────────────────────
  // Receives messages from the Telegram Lifeline process and injects
  // them into the appropriate session, just like TelegramAdapter would.

  // Cache serverVersion once at route-registration time. Use ProcessIntegrity
  // (the running-in-memory version frozen at boot) rather than a live disk
  // read that can drift after npm install -g. Stale-version prevention
  // guardrail: routes.ts tests assert this path is NOT a live read. Per spec,
  // if this fails to resolve to parseable semver, /internal/telegram-forward
  // responds 503 to skip the handshake path.
  const _serverVersionString =
    ProcessIntegrity.getInstance()?.getState().runningVersion ?? '';
  const _serverVersionParsed = parseVersion(_serverVersionString);

  // One-shot guard for pre-Stage-B lifeline observability log (see versionMissing
  // handler below). Avoids per-request log spam while preserving the signal.
  let _versionMissingLogged = false;

  router.post('/internal/telegram-forward', async (req, res) => {
    const {
      topicId, text, fromUserId, fromUsername, fromFirstName, messageId, lifelineVersion,
      // a2a spoof-defense fields (MENTOR-LIVE-READINESS-SPEC §Recipient side). The
      // lifeline forwards these when present in the Telegram update. Older lifelines
      // omit them → `senderIsBot` defaults to falsy → any marker-bearing forwarded
      // message is dropped as `agent-marker-spoofed-by-user` (fail-CLOSED for spoof
      // defense, matching the spec invariant that a real user typing a marker MUST
      // be dropped). Upgraded lifelines populate them and the hook routes normally.
      senderIsBot, senderChatId, senderBotId,
    } = req.body;

    // Server boot window: if version cache wasn't populated, skip handshake
    // rather than 426-erroneously. Lifeline retries after retryAfterMs.
    if (!_serverVersionParsed) {
      res.status(503).json({ ok: false, reason: 'server-boot-incomplete', retryAfterMs: 1000 });
      return;
    }

    // Agent hard-sleep idle signal: a real inbound message is genuine activity
    // (handshake-only pings without text are not). Bumps lastInbound so the
    // SleepController never sleeps an agent that's actively being messaged.
    if (text) ctx.agentActivityState?.markInbound(Date.now());

    // Version-handshake (only when lifelineVersion field is present AND
    // auth is configured — dev-mode with empty authToken skips the handshake
    // to avoid unauth'd fingerprinting channel if bearer-auth ever regresses).
    const authEnabled = Boolean(ctx.config.authToken);
    if (lifelineVersion !== undefined && authEnabled) {
      const clientVersion = parseVersion(lifelineVersion);
      if (!clientVersion) {
        res.status(400).json({ ok: false, error: 'invalid lifelineVersion' });
        return;
      }
      const decision = compareVersions(_serverVersionParsed, clientVersion);
      if (decision.kind === 'upgrade-required') {
        // Second-channel coordination: the running lifeline is on an
        // incompatible major.minor. Write the lifeline-restart signal so
        // that even if AutoUpdater missed the boundary (deferred restart,
        // lockfile race, etc.), the lifeline self-corrects on its next
        // tick / supervisor poll. Idempotent vs. AutoUpdater's prior write.
        try {
          writeLifelineRestartSignal({
            stateDir: ctx.config.stateDir,
            requestedBy: 'server-426',
            reason: 'server-426-direct-evidence',
            previousVersion: lifelineVersion,
            targetVersion: decision.serverVersionString,
          });
        } catch (err) {
          // Non-fatal — the 426 response itself still drives the lifeline's
          // in-process versionSkew handler. The signal is belt-and-suspenders.
          console.warn(`[telegram-forward] failed to write lifeline-restart signal: ${err}`);
        }
        res.status(426).json({
          ok: false,
          upgradeRequired: true,
          serverVersion: decision.serverVersionString,
          action: 'restart',
          reason: 'major-minor-mismatch',
        });
        return;
      }
      if (decision.kind === 'accept-with-patch-info') {
        DegradationReporter.getInstance().report({
          feature: 'TelegramLifeline.versionSkewInfo',
          primary: 'Informational — lifeline patch drift beyond policy',
          fallback: 'No behavior change; forward accepted',
          reason: `patch drift ${decision.patchDiff} between lifeline and server`,
          impact: 'LifelineDriftPromoter will self-restart the lifeline at the next clean window.',
        });
        // Signal-vs-authority: surface the observed drift to the lifeline.
        // The header is the signal; the lifeline's LifelineDriftPromoter
        // is the authority that decides whether to self-restart and when.
        res.setHeader('X-Instar-Lifeline-Patch-Drift', String(decision.patchDiff));
      }
    } else if (lifelineVersion === undefined && authEnabled) {
      // Backward-compat: pre-Stage-B lifelines don't send the field. Accept
      // silently. This was previously emitted as a [DEGRADATION] feedback
      // event, which the cluster classifier mislabelled as critical even
      // though it's expected observability for agents that upgraded the
      // package without restarting their lifeline daemon. Log once per
      // process so the signal isn't lost, but don't pollute the feedback
      // pipeline. Per dispatch dsp-moc6wunp-2dwj, agents are advised to
      // restart their lifelines; PROP-543 covers the systemic classifier
      // taxonomy work.
      if (!_versionMissingLogged) {
        _versionMissingLogged = true;
        console.info(
          '[telegram-forward] Accepted pre-Stage-B lifeline forward (no lifelineVersion field). ' +
          'Restart the lifeline to enable the Stage-B version handshake.'
        );
      }
    }

    if (!topicId || !text) {
      res.status(400).json({ error: 'topicId and text required' });
      return;
    }

    // ── Sentinel intercept (P0 safety: emergency-stop on the LIFELINE path) ──
    // The sentinel emergency-stop/pause intercept also lives in
    // TelegramAdapter.processUpdate(), but lifeline-owned-polling agents (e.g.
    // echo, server.ts ~"lifeline-owned polling mode") never run processUpdate —
    // their inbound arrives here, via the lifeline forward. Without this block
    // "stop everything" would be injected as a normal message and nothing would
    // structurally halt a running (or wedged, mid-tool-call) session.
    // Spec: docs/specs/emergency-stop-forward-path-wiring.md
    // FAIL-OPEN: any sentinel error falls through to normal routing — the safety
    // check must never block message delivery. Mirrors processUpdate's behavior.
    if (ctx.sentinel) {
      try {
        const classification = await ctx.sentinel.classify(text);
        if (classification.category === 'emergency-stop' || classification.category === 'pause') {
          // Resolve the topic's session. Prefer the on-disk registry (the
          // persistent source of truth that both polling modes maintain) since
          // a lifeline-owned adapter's in-memory topicToSession map may be empty;
          // fall back to the adapter map.
          let sessionName: string | null = null;
          try {
            const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
            if (fs.existsSync(registryPath)) {
              const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
              sessionName = reg.topicToSession?.[String(topicId)] ?? null;
            }
          } catch { /* registry read failed — fall through to adapter map */ }
          if (!sessionName) {
            sessionName = ctx.telegram?.getSessionForTopic(Number(topicId)) ?? null;
          }
          if (classification.category === 'emergency-stop') {
            if (sessionName) {
              if (ctx.telegram?.onSentinelKillSession) {
                ctx.telegram.onSentinelKillSession(sessionName); // saves resume UUID + kills
              } else {
                try { ctx.sessionManager?.killSession(sessionName); } catch { /* best-effort */ }
              }
              // Clear this topic's autonomous job so it doesn't zombie-resume.
              try { stopAutonomousTopic(ctx.config.stateDir, String(topicId)); } catch { /* best-effort */ }
              console.log(`[telegram-forward] sentinel emergency-stop: killed session "${sessionName}" for topic ${topicId}`);
            }
            if (classification.reason) {
              console.log(`[telegram-forward] sentinel stop reason: ${classification.reason}`);
            }
            ctx.telegram?.sendToTopic(Number(topicId), sessionName
              ? 'Session terminated.\n\nSend a new message to start a fresh session.'
              : 'No active session to stop.').catch(() => { /* best-effort */ });
            res.json({ ok: true, sentinel: 'emergency-stop', killed: !!sessionName });
            return;
          }
          // pause
          if (sessionName && ctx.telegram?.onSentinelPauseSession) {
            ctx.telegram.onSentinelPauseSession(sessionName);
            console.log(`[telegram-forward] sentinel pause: paused session "${sessionName}" for topic ${topicId}`);
          }
          ctx.telegram?.sendToTopic(Number(topicId), sessionName
            ? 'Session paused.\n\nSend a message to resume.'
            : 'No active session to pause.').catch(() => { /* best-effort */ });
          res.json({ ok: true, sentinel: 'pause', paused: !!sessionName });
          return;
        }
      } catch (err) {
        // FAIL-OPEN — never block message delivery on a sentinel hiccup.
        console.error(`[telegram-forward] sentinel intercept error (fail-open, routing normally): ${err}`);
      }
    }

    // Log the message so it appears in JSONL + TopicMemory even when
    // the normal polling handler didn't receive it (Lifeline forwarding).
    // Only log if we have a real Telegram messageId — re-deliveries from
    // injectionDropped don't have one and the original was already logged.
    if (ctx.telegram && messageId) {
      ctx.telegram.logInboundMessage({
        messageId,
        topicId,
        text,
        timestamp: req.body.timestamp || new Date().toISOString(),
        senderName: fromFirstName,
        senderUsername: fromUsername,
        telegramUserId: fromUserId,
      });
    }

    // ── Exactly-once ingress gate (spec §8 G3a) ──────────────────────
    // Default-DARK: only active when multiMachine.exactlyOnceIngress wired the
    // ledger. Placed AFTER the sentinel intercept (emergency-stop/pause must
    // never be deduped away) and BEFORE routing. dedupeKey = update_id (stable
    // provider id; falls back to messageId on a pre-Stage-B lifeline). On a
    // duplicate/in-flight event we return ok+deduped WITHOUT routing — the
    // structural no-duplicate-reply guarantee. FAIL-OPEN: any ledger error
    // falls through to normal routing (the gate must never drop a real message).
    if (ctx.messageLedger) {
      try {
        const eventId = req.body.updateId ?? messageId ?? `${topicId}:${req.body.timestamp ?? Date.now()}`;
        const dedupeKey = dedupeKeyFor('telegram', topicId, eventId);
        const epoch = ctx.coordinator?.getLeaseEpoch() ?? 0;
        const decision = decideIngress(ctx.messageLedger, dedupeKey, {
          platform: 'telegram',
          topic: String(topicId),
          input: text,
          epoch,
          maxProcessingMs: ctx.config.multiMachine?.maxProcessingMs ?? 5 * 60_000,
        });
        if (decision.action === 'drop') {
          console.log(`[telegram-forward] exactly-once: dropped duplicate (${decision.reason}) ${dedupeKey}`);
          res.json({ ok: true, deduped: true, reason: decision.reason });
          return;
        }
        // Claimed for processing — remember it so the outbound reply commits it.
        ctx.currentInboundByTopic?.set(String(topicId), dedupeKey);
      } catch (err) {
        console.error(`[telegram-forward] exactly-once gate error (fail-open, routing normally): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Agent-to-agent Telegram comms hook (spec MENTOR-LIVE-READINESS §Recipient side).
    // The polling path invokes this gate inside the adapter; lifeline-forwarded messages
    // bypass that path and arrive here, so we MUST invoke the same gate before falling
    // through to user-message routing. If the hook returns handled=true we short-circuit
    // — the message was an a2a event (routed to a role-handler or dropped per the spec's
    // routing matrix) and must NOT also dispatch to the user-message path.
    if (ctx.telegram && typeof text === 'string' && typeof topicId === 'number') {
      try {
        const handled = await ctx.telegram.dispatchAgentMessageHook({
          text,
          topicId,
          senderIsBot: senderIsBot === true,
          senderChatId: senderChatId !== undefined ? String(senderChatId) : undefined,
          senderBotId: senderBotId !== undefined ? String(senderBotId) : undefined,
          rawFromId: fromUserId !== undefined ? String(fromUserId) : undefined,
        });
        if (handled) {
          res.json({ ok: true, forwarded: true, agentMessage: true });
          return;
        }
      } catch (err) {
        console.error(`[telegram-forward] agentMessageHook dispatch error (falling through): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Build a Message object and fire the onTopicMessage callback
    if (ctx.telegram?.onTopicMessage) {
      const message = {
        id: `tg-${messageId || Date.now()}`,
        userId: String(fromUserId || 'unknown'),
        content: text,
        channel: { type: 'telegram', identifier: String(topicId) },
        receivedAt: new Date().toISOString(),
        metadata: {
          telegramUserId: fromUserId,
          username: fromUsername,
          firstName: fromFirstName,
          messageThreadId: topicId,
          viaLifeline: true,
        },
      };

      try {
        ctx.telegram.onTopicMessage(message);
        res.json({ ok: true, forwarded: true });
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'routes.onTopicMessage',
          primary: 'Route Telegram message to handler',
          fallback: 'Return 500 — message routing failed',
          reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'User message may not reach session, no system alert',
        });
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } else if (ctx.sessionManager) {
      // No TelegramAdapter (--no-telegram mode) — route using topic-session registry on disk
      const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
      let targetSession: string | null = null;

      try {
        if (fs.existsSync(registryPath)) {
          const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
          targetSession = registry.topicToSession?.[String(topicId)] ?? null;
        }
      } catch { /* registry read failed — fall through to spawn */ }

      if (targetSession && ctx.sessionManager.isSessionAlive(targetSession)) {
        // Session exists and is alive — inject message
        // Include topic name so session knows which conversation it's in, even after compaction
        let injectedTopicName: string | undefined;
        try {
          if (fs.existsSync(registryPath)) {
            const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
            injectedTopicName = reg.topicToName?.[String(topicId)] ?? undefined;
          }
        } catch { /* fall through without name */ }
        console.log(`[telegram-forward] Injecting into ${targetSession}: "${text.slice(0, 80)}"`);
        const injected = ctx.sessionManager.injectTelegramMessage(targetSession, topicId, text, injectedTopicName, fromFirstName, fromUserId);

        if (injected === false) {
          // Injection failed — save message under stateDir (not /tmp) to avoid world-readable exposure
          const failDir = path.join(ctx.config.stateDir, 'state', 'failed-messages');
          fs.mkdirSync(failDir, { recursive: true });
          const failFile = path.join(failDir, `failed-${topicId}-${Date.now()}.txt`);
          fs.writeFileSync(failFile, text);
          console.error(`[telegram→session] Injection FAILED for topic ${topicId} into ${targetSession}. Message saved to ${failFile}`);
          res.json({ ok: false, error: 'injection-failed', failFile, session: targetSession });
        } else {
          // Truncation detection — check if this message looks truncated and inject a hint
          const truncation = truncationDetector.detect(topicId, String(fromUserId || 'unknown'), text);
          if (truncation.truncationSuspected) {
            // Build Drop Zone URL (tunnel if available, otherwise localhost)
            let dzUrl = `http://localhost:${ctx.config.port}/dashboard?tab=dropzone`;
            if (ctx.tunnel) {
              // @silent-fallback-ok — tunnel.url access best-effort; fall through to the localhost URL.
              try {
                const tunnelUrl = ctx.tunnel.url;
                if (tunnelUrl) {
                  dzUrl = `${tunnelUrl}/dashboard?tab=dropzone`;
                }
              } catch { /* @silent-fallback-ok */ }
            }
            // Inject a system hint after a short delay so it arrives after the message
            setTimeout(() => {
              const hint = `<system-reminder>The user's previous message may be truncated (${truncation.reason}). ` +
                `If their content appears incomplete, suggest they use the Drop Zone for longer content: ${dzUrl}</system-reminder>`;
              ctx.sessionManager.injectPasteNotification(targetSession, hint);
            }, 1000);
          }

          res.json({ ok: true, forwarded: true, method: 'registry-inject', session: targetSession });
        }
      } else {
        // No session or session dead — auto-spawn a new one
        // Use topic name from registry, NOT the tmux session name.
        // tmux names include the project prefix (e.g., "ai-guy-lifeline"), and
        // spawnInteractiveSession prepends it again → cascading names.
        let topicName = `topic-${topicId}`;
        // Try live adapter first, then disk registry, then active probe
        if (ctx.telegram) {
          const liveName = ctx.telegram.getTopicName(topicId);
          if (liveName && !/^topic-\d+$/.test(liveName)) {
            topicName = liveName;
          }
        }
        if (/^topic-\d+$/.test(topicName)) {
          try {
            if (fs.existsSync(registryPath)) {
              const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
              const stored = reg.topicToName?.[String(topicId)];
              if (stored && !/^topic-\d+$/.test(stored)) topicName = stored;
            }
          } catch { /* fall through */ }
        }
        if (/^topic-\d+$/.test(topicName) && ctx.telegram) {
          try {
            const resolved = await ctx.telegram.resolveTopicName(topicId);
            if (resolved) topicName = resolved;
          } catch { /* fall through to default */ }
        }
        console.log(`[telegram-forward] No live session for topic ${topicId}, spawning "${topicName}"...`);

        // Fetch thread history so auto-spawned sessions have full conversational context
        const historyLines: string[] = [];
        if (ctx.telegram) {
          try {
            const history = ctx.telegram.getTopicHistory(topicId, 50);
            if (history.length > 0) {
              historyLines.push(`--- Thread History (last ${history.length} messages) ---`);
              historyLines.push(`IMPORTANT: Read this history carefully before taking any action.`);
              historyLines.push(`Your task is to continue THIS conversation, not start something new.`);
              historyLines.push(`Topic: ${topicName}`);
              historyLines.push(``);
              for (const m of history) {
                const sender = m.fromUser
                  ? (m.senderName || 'User')
                  : 'Agent';
                const ts = m.timestamp ? new Date(m.timestamp).toISOString().slice(11, 19) : '??:??';
                const histText = (m.text || '').slice(0, 2000);
                historyLines.push(`[${ts}] ${sender}: ${histText}`);
              }
              historyLines.push(``);
              historyLines.push(`--- End Thread History ---`);
            }
          } catch (err) {
            console.error(`[telegram-forward] Failed to fetch thread history for topic ${topicId}:`, err);
          }
        }

        // Thread history goes to a side file (it can be long). The Telegram
        // relay instruction is appended INLINE below so the agent processes
        // it as a structural directive — Claude historically learned this
        // from a SessionStart hook that Codex doesn't honor, so the inline
        // copy is what closes that gap for Codex sessions.
        const contextLines = [
          ...historyLines,
          ``,
          `This session was auto-created for Telegram topic ${topicId}.`,
        ];
        const tmpDir = '/tmp/instar-telegram';
        fs.mkdirSync(tmpDir, { recursive: true });
        const ctxPath = path.join(tmpDir, `ctx-${topicId}-${Date.now()}.txt`);
        fs.writeFileSync(ctxPath, contextLines.join('\n'));

        const { buildTelegramRelayBlock } = await import('../messaging/shared/telegramRelayPrompt.js');
        const relayBlock = buildTelegramRelayBlock({ topicId, framework: 'claude-code' });
        const bootstrapMessage = `[telegram:${topicId}] ${text} (Thread history at ${ctxPath} — read it before responding.)\n\n${relayBlock}`;

        // Check for a resume UUID from a previously-killed session.
        // TopicResumeMap is authoritative — skip LLM validation for this source.
        let resumeSessionId = ctx.topicResumeMap?.get(topicId) ?? undefined;
        if (resumeSessionId) {
          console.log(`[telegram-forward] Found resume UUID for topic ${topicId}: ${resumeSessionId} (source: TopicResumeMap — trusted)`);
        }

        ctx.sessionManager.spawnInteractiveSession(bootstrapMessage, topicName, { telegramTopicId: topicId, resumeSessionId }).then((newSessionName) => {
          // Clear resume entry after successful spawn
          if (resumeSessionId) {
            ctx.topicResumeMap?.remove(topicId);
          }
          // Register in-memory topic↔session mapping so beforeSessionKill
          // can look up the topic ID and save the resume UUID on kill.
          ctx.telegram?.registerTopicSession(topicId, newSessionName, topicName);
          // Update registry on disk
          try {
            const reg = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf-8')) : { topicToSession: {}, topicToName: {} };
            reg.topicToSession[String(topicId)] = newSessionName;
            fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2));
          } catch { /* @silent-fallback-ok — registry write non-critical */ }
          // Proactive UUID save — always run, even after --resume (new session = new UUID)
          // ONLY uses authoritative claudeSessionId — never mtime fallback, which can
          // pick up a UUID from a different topic's concurrent session.
          if (ctx.topicResumeMap) {
            setTimeout(() => {
              try {
                const sessions = ctx.sessionManager?.listRunningSessions() ?? [];
                const session = sessions.find(s => s.tmuxSession === newSessionName);
                if (session?.claudeSessionId) {
                  ctx.topicResumeMap!.save(topicId, session.claudeSessionId, newSessionName);
                  console.log(`[telegram-forward] Proactive UUID save: ${session.claudeSessionId} for topic ${topicId} (source: hook)`);
                }
              } catch (err) {
                console.error(`[telegram-forward] Proactive UUID save failed:`, err);
              }
            }, 8000);
          }
          console.log(`[telegram-forward] Spawned "${newSessionName}" for topic ${topicId}`);
        }).catch((err) => {
          console.error(`[telegram-forward] Spawn failed:`, err);
        });

        res.json({ ok: true, forwarded: true, method: 'spawn', topicName });
      }
    } else {
      res.status(503).json({ error: 'No message routing available' });
    }
  });

  // ── Agent-to-agent inbox (same-machine HTTP transport) ────────
  // The Telegram-bridge transport for a2a (mentor bot → mentee bot in shared
  // group) CANNOT work — Telegram structurally blocks bot-to-bot delivery
  // ("bots will not be able to see messages from other bots regardless of
  // mode" — Bot API FAQ). For same-machine agents this endpoint is the
  // canonical transport: a peer POSTs an a2a-marker-prefixed message + sender
  // context here, we invoke the same `dispatchAgentMessageHook` that the
  // polling + lifeline-forward paths use. The receiver wiring
  // (`installMentorMessageHook` via `config.mentee`) is unchanged — only the
  // entry point differs.
  //
  // Cross-machine transport is a separate architectural problem (would need
  // a shared-bot or user-account relay); this PR ships same-machine only.
  //
  // Auth: Bearer must match THIS agent's token (verifyAgentToken). Anyone
  // can call /a2a/inbox iff they hold our token — same trust model as
  // /messages/relay-agent for Threadline.
  router.post('/a2a/inbox', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!bearerToken || !verifyAgentToken(ctx.config.projectName, bearerToken)) {
        res.status(401).json({ error: 'Invalid or missing agent token' });
        return;
      }

      if (!ctx.telegram) {
        // No primary adapter constructed (rare: agent has no Telegram
        // messaging configured at all). The receiver hook lives on the
        // adapter; without it there's nowhere to dispatch.
        res.status(503).json({ ok: false, reason: 'no-adapter' });
        return;
      }

      const { text, topicId, senderAgent, senderBotId, senderIsBot, fromUserId } = req.body ?? {};
      if (typeof text !== 'string' || text.length === 0) {
        res.status(400).json({ error: 'text (string) is required' });
        return;
      }
      const numericTopicId = typeof topicId === 'number' ? topicId : Number(topicId);
      if (!Number.isFinite(numericTopicId)) {
        res.status(400).json({ error: 'topicId (number) is required' });
        return;
      }
      // The /a2a/inbox endpoint is ONLY for bot-origin messages. A peer agent
      // is by definition a bot (the spec's spoof defense distinguishes real
      // users from bots; same-machine peer calls satisfy the bot-origin
      // requirement by construction — they hold our agent token).
      const effectiveSenderIsBot = senderIsBot === undefined ? true : senderIsBot === true;
      const handled = await ctx.telegram.dispatchAgentMessageHook({
        text,
        topicId: numericTopicId,
        senderIsBot: effectiveSenderIsBot,
        senderBotId: senderBotId !== undefined ? String(senderBotId) : undefined,
        rawFromId: fromUserId !== undefined ? String(fromUserId) : undefined,
      });
      if (handled) {
        console.log(`[a2a-inbox] routed (senderAgent=${senderAgent ?? 'unknown'}, topicId=${numericTopicId})`);
        res.json({ ok: true, agentMessage: true });
      } else {
        // Not handled = hook rejected (no marker / malformed / not-allowlisted
        // / etc). The /a2a/inbox endpoint is dedicated to a2a — non-routable
        // messages are NOT forwarded to user-message handling. The caller
        // should not have sent it through this route.
        console.warn(`[a2a-inbox] rejected (senderAgent=${senderAgent ?? 'unknown'}, topicId=${numericTopicId}) — no marker or refused by hook`);
        res.json({ ok: true, agentMessage: false, reason: 'not-routed' });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[a2a-inbox] handler error: ${errMsg}`);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // ── Plan Prompt Relay (from hook) ─────────────────────────────
  // Receives plan mode entry events from the PreToolUse hook on EnterPlanMode.
  // Relays the plan to Telegram for user approval via inline keyboard.
  // The hook polls /hooks/plan-prompt/status until the user responds.

  // Track pending plan prompts so the hook can poll for resolution.
  // Key: promptId, Value: { resolved, key, sessionName, createdAt }
  const pendingPlanPrompts = new Map<string, {
    resolved: boolean;
    key?: string;
    sessionName: string;
    createdAt: number;
  }>();

  // Evict stale entries every 5 minutes (prompts older than 10 min)
  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, entry] of pendingPlanPrompts) {
      if (entry.createdAt < cutoff) pendingPlanPrompts.delete(id);
    }
  }, 5 * 60 * 1000);

  // Wire resolution: when a prompt callback fires, mark the plan prompt as resolved.
  // This is called from the onPromptResponse path in TelegramAdapter.
  const resolvePlanPrompt = (sessionName: string, key: string) => {
    for (const [id, entry] of pendingPlanPrompts) {
      if (entry.sessionName === sessionName && !entry.resolved) {
        entry.resolved = true;
        entry.key = key;
        console.log(`[PlanRelay] Prompt ${id} resolved: session="${sessionName}" key="${key}"`);
        break;
      }
    }
  };
  // Internal endpoint — called by onPromptResponse to mark plan prompts resolved
  router.post('/hooks/plan-prompt/resolve', (req, res) => {
    const { sessionName, key } = req.body;
    if (sessionName && key) {
      resolvePlanPrompt(sessionName, key);
    }
    res.json({ ok: true });
  });

  router.post('/hooks/plan-prompt', async (req, res) => {
    const { event, session_id, tool_input, instar_sid } = req.body;

    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    console.log(`[PlanRelay] Received plan-prompt event: sid=${instar_sid} claude_sid=${session_id}`);

    // Find the session and its topic binding
    let topicId: number | undefined;
    let tmuxSession: string | undefined;

    // Strategy 1: look up by instar session ID or Claude session ID
    const sessions = ctx.sessionManager.listRunningSessions();
    const session = sessions.find(s =>
      s.id === instar_sid || s.claudeSessionId === session_id
    );
    if (session) {
      tmuxSession = session.tmuxSession;
      topicId = ctx.telegram.getTopicForSession(session.tmuxSession) ?? undefined;
    }

    // Strategy 2: check all topic-session mappings for a match
    if (!topicId && instar_sid) {
      const allTopics = ctx.telegram.getAllTopicMappings?.() ?? [];
      for (const mapping of allTopics) {
        if (mapping.sessionName && (mapping.sessionName === instar_sid || instar_sid.includes(mapping.sessionName))) {
          topicId = mapping.topicId;
          tmuxSession = mapping.sessionName;
          break;
        }
      }
    }

    // Strategy 3: use the INSTAR_TELEGRAM_TOPIC env if the hook passed it
    if (!topicId && req.body.telegram_topic) {
      topicId = parseInt(req.body.telegram_topic, 10);
    }

    if (!topicId) {
      console.log(`[PlanRelay] No topic binding found for sid=${instar_sid}`);
      res.json({ ok: false, reason: 'no topic binding' });
      return;
    }

    // Build a DetectedPrompt and relay it
    try {
      const promptId = crypto.randomUUID().slice(0, 8);
      const sessionName = tmuxSession || session?.tmuxSession || 'unknown';

      const prompt = {
        type: 'plan' as const,
        raw: '',
        summary: 'Plan approval requested — the agent has a plan and is waiting for your decision.',
        options: [
          { key: '1', label: 'Yes, and bypass permissions' },
          { key: '2', label: 'Yes, manually approve edits' },
          { key: '3', label: 'Tell Claude what to change' },
        ],
        sessionName,
        detectedAt: Date.now(),
        id: promptId,
      };

      // Track the pending prompt so the hook can poll for resolution
      pendingPlanPrompts.set(promptId, {
        resolved: false,
        sessionName,
        createdAt: Date.now(),
      });

      await ctx.telegram.relayPrompt(topicId, prompt);
      console.log(`[PlanRelay] Relayed plan prompt ${promptId} to topic ${topicId} for session ${sessionName}`);
      res.json({ ok: true, topicId, promptId });
    } catch (err) {
      console.error(`[PlanRelay] Failed:`, err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Status endpoint — the hook polls this to know when the user has responded
  router.get('/hooks/plan-prompt/status', (req, res) => {
    const promptId = req.query.id as string;
    if (!promptId) {
      res.status(400).json({ error: 'missing id parameter' });
      return;
    }
    const entry = pendingPlanPrompts.get(promptId);
    if (!entry) {
      // Unknown prompt — tell hook to stop polling
      res.json({ resolved: true, key: '1', reason: 'unknown prompt' });
      return;
    }
    res.json({ resolved: entry.resolved, key: entry.key });
  });

  // ── Telegram Callback Query Forwarding (from Lifeline) ────────
  // Receives inline keyboard callback queries that the Lifeline forwarded.
  // Processes them through TelegramAdapter.processCallbackQuery().

  router.post('/internal/telegram-callback', async (req, res) => {
    const { callbackQueryId, data, fromUserId, messageId, chatId } = req.body;

    if (!callbackQueryId || !data) {
      res.status(400).json({ error: 'callbackQueryId and data required' });
      return;
    }

    if (!ctx.telegram) {
      res.status(503).json({ error: 'Telegram not configured' });
      return;
    }

    try {
      // Reconstruct a callback query object and process it through TelegramAdapter
      const query = {
        id: callbackQueryId,
        data,
        from: { id: fromUserId, is_bot: false, first_name: 'user' },
        message: messageId ? { message_id: messageId, chat: { id: chatId } } : undefined,
      };

      // Use the adapter's public method for processing forwarded callbacks
      await ctx.telegram.handleForwardedCallback(query);
      res.json({ ok: true });
    } catch (err) {
      console.error(`[telegram-callback] Processing failed:`, err instanceof Error ? err.message : err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Evolution System ───────────────────────────────────────────

  // Dashboard — overview of all evolution subsystems
  router.get('/evolution', (_req, res) => {
    if (!ctx.evolution) {
      res.json({ enabled: false });
      return;
    }
    res.json({ enabled: true, ...ctx.evolution.getDashboard() });
  });

  // Evolution proposals
  router.get('/evolution/proposals', (req, res) => {
    if (!ctx.evolution) { res.json({ proposals: [] }); return; }
    const status = req.query.status as EvolutionStatus | undefined;
    const type = req.query.type as EvolutionType | undefined;
    res.json({ proposals: ctx.evolution.listProposals({ status, type }) });
  });

  router.post('/evolution/proposals', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, source, description, type, impact, effort, proposedBy, tags } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string' || description.length > 10_000) {
      res.status(400).json({ error: '"description" must be a string under 10KB' });
      return;
    }
    const validTypes = ['capability', 'infrastructure', 'voice', 'workflow', 'philosophy', 'integration', 'performance'];
    if (type && !validTypes.includes(type)) {
      res.status(400).json({ error: `"type" must be one of: ${validTypes.join(', ')}` });
      return;
    }
    const proposal = ctx.evolution.addProposal({
      title, source: source || 'api', description,
      type: type || 'capability', impact, effort, proposedBy, tags,
    });
    res.status(201).json(proposal);
  });

  router.patch('/evolution/proposals/:id', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { status, resolution } = req.body;
    const validStatuses = ['proposed', 'approved', 'in_progress', 'implemented', 'rejected', 'deferred'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `"status" must be one of: ${validStatuses.join(', ')}` });
      return;
    }
    const success = ctx.evolution.updateProposalStatus(req.params.id, status, resolution);
    if (!success) {
      res.status(404).json({ error: 'Proposal not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, status });
  });

  // Learning registry
  router.get('/evolution/learnings', (req, res) => {
    if (!ctx.evolution) { res.json({ learnings: [] }); return; }
    const category = req.query.category as string | undefined;
    const applied = req.query.applied !== undefined ? req.query.applied === 'true' : undefined;
    res.json({ learnings: ctx.evolution.listLearnings({ category, applied }) });
  });

  router.post('/evolution/learnings', async (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, category, description, source, tags, evolutionRelevance,
            context, documentFallback, evidence: explicitEvidence } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: '"description" is required' });
      return;
    }

    // WikiClaim Phase 3 (spec § Producers line 268, § Migration Plan line 341):
    // /learn must cite at least one evidence row. Either:
    //   (a) caller passes `evidence: MemoryEvidence[]` directly (advanced),
    //   (b) caller passes `context: string` and we auto-derive sessions/messages,
    //   (c) caller passes `documentFallback: {sourceId, path}` for prompted-source.
    // Combining (b)+(c) is allowed.
    let derivedEvidence: import('../core/types.js').MemoryEvidence[] = [];
    let externalReferences: Array<{ kind: 'feedback' | 'commit'; sourceId: string }> = [];
    let pendingDocumentRef: { sourceId: string; path?: string; note?: string } | undefined;
    try {
      if (Array.isArray(explicitEvidence) && explicitEvidence.length > 0) {
        derivedEvidence = explicitEvidence;
      } else {
        const { buildLearnEvidence, LearnEvidenceError } =
          await import('../core/LearnSkillBridge.js');
        try {
          const built = buildLearnEvidence({
            context: typeof context === 'string' ? context : `${title}\n\n${description}`,
            documentFallback,
          });
          derivedEvidence = built.evidence;
          externalReferences = built.externalReferences;
          pendingDocumentRef = built.pendingDocumentRef;
        } catch (err) {
          if (err instanceof LearnEvidenceError) {
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to derive evidence' });
      return;
    }

    const learning = ctx.evolution.addLearning({
      title, category: category || 'general', description,
      source: source || { discoveredAt: new Date().toISOString() },
      tags, evolutionRelevance,
    });

    // Learning→Soul pipeline nudge: if soul.md is enabled, hint whether this
    // learning might be identity-relevant (the agent decides whether to act on it).
    let soulNudge: string | undefined;
    if (ctx.soulManager?.isEnabled()) {
      // Simple heuristic: check if the learning touches identity-related keywords.
      // The full LLM classifier runs in the identity-review job; this is a fast hint.
      const identityKeywords = /value|principle|belief|conviction|identity|who i am|growth|voice|authenticity|self-|philosophy|meaning|purpose/i;
      if (identityKeywords.test(title) || identityKeywords.test(description)) {
        soulNudge = 'This learning may be identity-relevant. Consider updating soul.md or running /reflect.';
      }
    }

    // WikiClaim Phase 3: surface derived evidence + external references on
    // the response so callers can confirm the bridge resolved their context.
    // Spec § Producers line 228 — LearnSkill kinds are message|session;
    // externalReferences carry feedback/commit refs that the caller routes
    // through the appropriate downstream producer.
    res.status(201).json({
      ...learning,
      soulNudge,
      evidence: derivedEvidence,
      externalReferences,
      ...(pendingDocumentRef ? { pendingDocumentRef } : {}),
    });
  });

  router.patch('/evolution/learnings/:id/apply', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { appliedTo } = req.body;
    if (!appliedTo || typeof appliedTo !== 'string') {
      res.status(400).json({ error: '"appliedTo" is required' });
      return;
    }
    const success = ctx.evolution.markLearningApplied(req.params.id, appliedTo);
    if (!success) {
      res.status(404).json({ error: 'Learning not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, appliedTo });
  });

  // Capability gaps
  router.get('/evolution/gaps', (req, res) => {
    if (!ctx.evolution) { res.json({ gaps: [] }); return; }
    const severity = req.query.severity as string | undefined;
    const category = req.query.category as GapCategory | undefined;
    const status = req.query.status as string | undefined;
    res.json({ gaps: ctx.evolution.listGaps({ severity, category, status }) });
  });

  router.post('/evolution/gaps', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, category, severity, description, context, platform, session, currentState, proposedSolution } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: '"description" is required' });
      return;
    }
    const validSeverities = ['critical', 'high', 'medium', 'low'];
    if (severity && !validSeverities.includes(severity)) {
      res.status(400).json({ error: `"severity" must be one of: ${validSeverities.join(', ')}` });
      return;
    }
    const gap = ctx.evolution.addGap({
      title, category: category || 'custom', severity: severity || 'medium',
      description, context: context || '', platform, session,
      currentState, proposedSolution,
    });
    res.status(201).json(gap);
  });

  router.patch('/evolution/gaps/:id/address', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { resolution } = req.body;
    if (!resolution || typeof resolution !== 'string') {
      res.status(400).json({ error: '"resolution" is required' });
      return;
    }
    const success = ctx.evolution.addressGap(req.params.id, resolution);
    if (!success) {
      res.status(404).json({ error: 'Gap not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, status: 'addressed' });
  });

  // Action queue
  router.get('/evolution/actions', (req, res) => {
    if (!ctx.evolution) { res.json({ actions: [] }); return; }
    const status = req.query.status as 'pending' | 'in_progress' | 'completed' | 'cancelled' | undefined;
    const priority = req.query.priority as string | undefined;
    res.json({ actions: ctx.evolution.listActions({ status, priority }) });
  });

  router.get('/evolution/actions/overdue', (_req, res) => {
    if (!ctx.evolution) { res.json({ overdue: [] }); return; }
    res.json({ overdue: ctx.evolution.getOverdueActions() });
  });

  router.post('/evolution/actions', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { title, description, priority, commitTo, dueBy, source, tags } = req.body;
    if (!title || typeof title !== 'string' || title.length > 500) {
      res.status(400).json({ error: '"title" must be a string under 500 characters' });
      return;
    }
    if (!description || typeof description !== 'string') {
      res.status(400).json({ error: '"description" is required' });
      return;
    }
    const action = ctx.evolution.addAction({
      title, description, priority, commitTo, dueBy, source, tags,
    });
    res.status(201).json(action);
  });

  router.patch('/evolution/actions/:id', (req, res) => {
    if (!ctx.evolution) {
      res.status(503).json({ error: 'Evolution system not configured' });
      return;
    }
    const { status, resolution } = req.body;
    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: `"status" must be one of: ${validStatuses.join(', ')}` });
      return;
    }
    const success = ctx.evolution.updateAction(req.params.id, { status, resolution });
    if (!success) {
      res.status(404).json({ error: 'Action not found' });
      return;
    }
    res.json({ ok: true, id: req.params.id, status });
  });

  // ── Implicit Evolution Detection ─────────────────────────────
  // Scans open gaps/proposals for items already resolved by existing infrastructure.
  // Born from Dawn's REC-52-2 pattern: detect when capability needs are already met.
  router.get('/evolution/implicit', (_req, res) => {
    if (!ctx.evolution) {
      res.json({ implicit: [], count: 0 });
      return;
    }
    const implicit = ctx.evolution.detectImplicitEvolution();
    res.json({ implicit, count: implicit.length });
  });

  // ── Implementation Trace Verification ────────────────────────
  // Checks whether "implemented" proposals left actual file traces.
  // Inspired by Dawn's lesson-behavior-gap analyzer: detects phantom
  // implementations where proposals were marked done without real changes.
  router.get('/evolution/traces', (_req, res) => {
    if (!ctx.evolution) {
      res.json({ traces: [], count: 0, unverified: 0 });
      return;
    }
    const traces = ctx.evolution.verifyImplementationTraces();
    const unverified = traces.filter(t => t.verdict === 'unverified').length;
    const weak = traces.filter(t => t.verdict === 'weak').length;
    res.json({ traces, count: traces.length, unverified, weak });
  });

  // ── Serendipity Protocol ─────────────────────────────────────
  router.get('/serendipity/stats', (_req, res) => {
    const serendipityDir = path.join(ctx.config.stateDir, 'state', 'serendipity');
    const processedDir = path.join(serendipityDir, 'processed');
    const invalidDir = path.join(serendipityDir, 'invalid');

    const countJsonFiles = (dir: string): number => {
      try {
        return fs.readdirSync(dir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.tmp')).length;
      } catch {
        return 0;
      }
    };

    const pending = countJsonFiles(serendipityDir);
    const processed = countJsonFiles(processedDir);
    const invalid = countJsonFiles(invalidDir);

    // Get details of pending findings
    const pendingFindings: Array<{ id: string; title: string; category: string; readiness: string; createdAt: string }> = [];
    try {
      const files = fs.readdirSync(serendipityDir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.tmp'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(serendipityDir, file), 'utf-8'));
          pendingFindings.push({
            id: data.id || file.replace('.json', ''),
            title: data.discovery?.title || '(untitled)',
            category: data.discovery?.category || 'unknown',
            readiness: data.readiness || 'unknown',
            createdAt: data.createdAt || '',
          });
        } catch {
          // Skip unparseable files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    res.json({
      pending,
      processed,
      invalid,
      total: pending + processed + invalid,
      pendingFindings,
    });
  });

  router.get('/serendipity/findings', (_req, res) => {
    const serendipityDir = path.join(ctx.config.stateDir, 'state', 'serendipity');
    const findings: unknown[] = [];
    try {
      const files = fs.readdirSync(serendipityDir).filter((f: string) => f.endsWith('.json') && !f.endsWith('.tmp'));
      for (const file of files) {
        try {
          findings.push(JSON.parse(fs.readFileSync(path.join(serendipityDir, file), 'utf-8')));
        } catch {
          // Skip unparseable
        }
      }
    } catch {
      // Directory doesn't exist
    }
    res.json({ findings });
  });

  // ── Watchdog ──────────────────────────────────────────────────
  router.get('/watchdog/status', (req, res) => {
    if (!ctx.watchdog) {
      res.json({ enabled: false, sessions: [], interventionHistory: [] });
      return;
    }
    res.json(ctx.watchdog.getStatus());
  });

  router.post('/watchdog/toggle', (req, res) => {
    if (!ctx.watchdog) {
      res.status(404).json({ error: 'Watchdog not configured' });
      return;
    }
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) required' });
      return;
    }
    ctx.watchdog.setEnabled(enabled);
    res.json({ enabled: ctx.watchdog.isEnabled() });
  });

  // ── Topic Memory (conversation search & context) ─────────────────────

  /**
   * Search topic message history with FTS5 full-text search.
   * GET /topic/search?q=query&topic=topicId&limit=20
   */
  router.get('/topic/search', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const q = (req.query.q as string || '').trim();
    if (!q) {
      res.status(400).json({ error: 'q (search query) required' });
      return;
    }

    const topicId = req.query.topic ? parseInt(req.query.topic as string, 10) : undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    const results = ctx.topicMemory.search(q, { topicId, limit });
    res.json({ query: q, topicId: topicId ?? null, results, totalResults: results.length });
  });

  function assembleAndRespond(
    assembler: NonNullable<typeof ctx.workingMemory>,
    topicId: number,
    opts: { prompt?: string; jobSlug?: string; assembled?: boolean },
    res: import('express').Response,
  ): void {
    const assembly = assembler.assemble({
      topicId,
      prompt: opts.prompt,
      jobSlug: opts.jobSlug,
    });
    res.json({
      topicId,
      ...(opts.assembled != null ? { assembled: opts.assembled } : {}),
      context: assembly.context,
      estimatedTokens: assembly.estimatedTokens,
      budgets: assembler.getBudgets(),
      sources: assembly.sources,
      queryTerms: assembly.queryTerms,
      assembledAt: assembly.assembledAt,
    });
  }

  /**
   * Get full context for a topic (summary + recent messages).
   * GET /topic/context/:topicId?recent=30
   * GET /topic/context/:topicId?assembled=true  — use WorkingMemoryAssembler with token budgets
   */
  router.get('/topic/context/:topicId', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'Invalid topicId' });
      return;
    }

    if (req.query.assembled === 'true' && ctx.workingMemory) {
      assembleAndRespond(ctx.workingMemory, topicId, {
        prompt: req.query.prompt as string | undefined,
        assembled: true,
      }, res);
      return;
    }

    const recentLimit = Math.min(parseInt(req.query.recent as string, 10) || 30, 100);
    const context = ctx.topicMemory.getTopicContext(topicId, recentLimit);
    res.json(context);
  });

  /**
   * Assembled session context — token-budgeted working memory for session start.
   * Uses WorkingMemoryAssembler to build context within budgets:
   *   knowledge: 800 tokens, episodes: 400, relationships: 300 (2000 total)
   *
   * GET /session/context/:topicId?prompt=...
   *
   * Both routes sit behind the global authMiddleware applied at app level in
   * AgentServer.ts — no per-route middleware needed. Neither route is in the
   * exemption list (/health, /ping, /dashboard/unlock, etc.).
   */
  router.get('/session/context/:topicId', (req, res) => {
    if (!ctx.workingMemory) {
      res.status(503).json({
        error: 'WorkingMemoryAssembler not initialized',
        hint: 'Requires SemanticMemory and/or EpisodicMemory to be active',
      });
      return;
    }

    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'Invalid topicId' });
      return;
    }

    assembleAndRespond(ctx.workingMemory, topicId, {
      prompt: req.query.prompt as string | undefined,
      jobSlug: req.query.job as string | undefined,
    }, res);
  });

  /**
   * List all topics with metadata.
   * GET /topic/list
   */
  router.get('/topic/list', (_req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const topics = ctx.topicMemory.listTopics();
    res.json({ topics, total: topics.length });
  });

  /**
   * Get topic memory stats.
   * GET /topic/stats
   */
  router.get('/topic/stats', (_req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    res.json(ctx.topicMemory.stats());
  });

  /**
   * Trigger summary generation for a topic.
   * POST /topic/summarize { topicId: number }
   */
  router.post('/topic/summarize', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const topicId = req.body?.topicId;
    if (typeof topicId !== 'number') {
      res.status(400).json({ error: 'topicId (number) required' });
      return;
    }

    const needsUpdate = ctx.topicMemory.needsSummaryUpdate(topicId, 1);
    const messagesSince = ctx.topicMemory.getMessagesSinceSummary(topicId);
    const currentSummary = ctx.topicMemory.getTopicSummary(topicId);

    // Return the data needed for an LLM to generate the summary.
    // The actual LLM call happens in the calling session (not in the HTTP handler).
    res.json({
      topicId,
      needsUpdate,
      currentSummary: currentSummary?.summary ?? null,
      messagesSinceSummary: messagesSince.length,
      messages: messagesSince.map(m => ({
        from: m.fromUser ? 'User' : 'Agent',
        text: m.text,
        timestamp: m.timestamp,
        messageId: m.messageId,
      })),
    });
  });

  /**
   * Save a generated summary for a topic.
   * POST /topic/summary { topicId, summary, messageCount, lastMessageId }
   */
  router.post('/topic/summary', (req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const { topicId, summary, purpose, messageCount, lastMessageId } = req.body || {};
    if (typeof topicId !== 'number' || typeof summary !== 'string') {
      res.status(400).json({ error: 'topicId (number) and summary (string) required' });
      return;
    }

    ctx.topicMemory.saveTopicSummary(topicId, summary, messageCount ?? 0, lastMessageId ?? 0, purpose ?? null);
    res.json({ saved: true, topicId });
  });

  /**
   * Rebuild topic memory from JSONL (idempotent import).
   * POST /topic/rebuild
   */
  router.post('/topic/rebuild', async (_req, res) => {
    if (!ctx.topicMemory) {
      res.status(503).json({ error: 'TopicMemory not initialized' });
      return;
    }

    const jsonlPath = path.join(ctx.config.stateDir, 'telegram-messages.jsonl');
    const imported = await ctx.topicMemory.rebuild(jsonlPath);
    const importStats = ctx.topicMemory.getLastImportStats();
    res.json({
      rebuilt: true,
      messagesImported: imported,
      parseErrors: importStats ? { malformed: importStats.malformed, missingFields: importStats.missingFields } : null,
      stats: ctx.topicMemory.stats(),
    });
  });

  // ── Pairing API — Multi-machine state sync (Phase 4.5) ────────

  /**
   * POST /state/submit — Secondary machine submits a state change.
   * Validates write token, checks operation authorization, applies or queues.
   */
  router.post('/state/submit', (req, res) => {
    const { operation, payload, machineId, writeToken } = req.body || {};

    // Validate required fields
    if (!operation || !payload || !machineId || !writeToken) {
      res.status(400).json({
        error: 'Missing required fields: operation, payload, machineId, writeToken',
      });
      return;
    }

    if (typeof operation !== 'string' || typeof machineId !== 'string' || typeof writeToken !== 'string') {
      res.status(400).json({ error: 'operation, machineId, and writeToken must be strings' });
      return;
    }

    // Load stored write tokens
    const tokensFile = path.join(ctx.config.stateDir, 'write-tokens.json');
    let storedTokens: WriteToken[] = [];
    try {
      if (fs.existsSync(tokensFile)) {
        storedTokens = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
      }
    } catch {
      res.status(500).json({ error: 'Failed to load write tokens' });
      return;
    }

    // Validate the write token
    const tokenResult = validateWriteToken(writeToken, storedTokens);
    if (!tokenResult.valid) {
      res.status(403).json({ error: tokenResult.error });
      return;
    }

    // Verify the token was issued to the claiming machine
    if (tokenResult.machineId !== machineId) {
      res.status(403).json({ error: 'Write token does not match machineId' });
      return;
    }

    // Check if the operation is allowed
    const opCheck = canPerformOperation(operation as WriteOperation);
    if (!opCheck.allowed) {
      res.status(403).json({
        error: opCheck.reason,
        requiresConfirmation: opCheck.requiresConfirmation,
      });
      return;
    }

    // Apply the state change based on operation type
    try {
      switch (operation as WriteOperation) {
        case 'addMemory': {
          // Append memory entry to memories.jsonl
          const memoriesFile = path.join(ctx.config.stateDir, 'memories.jsonl');
          const entry = { ...payload, sourceMachineId: machineId, appliedAt: new Date().toISOString() };
          fs.appendFileSync(memoriesFile, JSON.stringify(entry) + '\n');
          res.json({ applied: true, operation });
          break;
        }
        case 'updateProfile': {
          // Update a user profile field
          const usersFile = path.join(ctx.config.stateDir, 'users.json');
          if (!fs.existsSync(usersFile)) {
            res.status(404).json({ error: 'No users file found' });
            return;
          }
          const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
          const targetUser = users.find((u: { id: string }) => u.id === payload.userId);
          if (!targetUser) {
            res.status(404).json({ error: `User ${payload.userId} not found` });
            return;
          }
          // Apply the update fields (shallow merge)
          if (payload.updates && typeof payload.updates === 'object') {
            Object.assign(targetUser, payload.updates);
          }
          fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
          res.json({ applied: true, operation, userId: payload.userId });
          break;
        }
        case 'heartbeat': {
          // Heartbeat is handled by the dedicated endpoint below
          res.json({ applied: true, operation });
          break;
        }
        default: {
          res.status(400).json({ error: `Unknown operation: ${operation}` });
        }
      }
    } catch (err) {
      res.status(500).json({
        error: 'Failed to apply state change',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /state/sync — Secondary machine pulls latest state.
   * Returns current users, config summary, and machine registry.
   */
  router.get('/state/sync', (_req, res) => {
    try {
      // Read users
      const usersFile = path.join(ctx.config.stateDir, 'users.json');
      let users: unknown[] = [];
      if (fs.existsSync(usersFile)) {
        try {
          users = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
        } catch { /* empty array on corruption */ }
      }

      // Read machine registry
      const registryFile = path.join(ctx.config.stateDir, 'machine-registry.json');
      let machineRegistry: unknown = { version: 1, machines: {} };
      if (fs.existsSync(registryFile)) {
        try {
          machineRegistry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
        } catch { /* default on corruption */ }
      }

      // Config summary (non-sensitive fields only)
      const configSummary = {
        projectName: ctx.config.projectName,
        userRegistrationPolicy: ctx.config.userRegistrationPolicy ?? 'admin-only',
        agentAutonomy: ctx.config.agentAutonomy?.level ?? 'supervised',
        multiMachine: ctx.config.multiMachine ?? { enabled: false },
        userCount: users.length,
      };

      res.json({
        users,
        machineRegistry,
        configSummary,
        syncedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        error: 'Failed to sync state',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /state/heartbeat — Secondary machine reports online status.
   * Updates lastSeen for the machine and returns queued change count.
   */
  router.post('/state/heartbeat', (req, res) => {
    const { machineId } = req.body || {};

    if (!machineId || typeof machineId !== 'string') {
      res.status(400).json({ error: 'machineId (string) required' });
      return;
    }

    try {
      // Update machine lastSeen in registry
      const registryFile = path.join(ctx.config.stateDir, 'machine-registry.json');
      let registry: { version: number; machines: Record<string, { lastSeen: string; [k: string]: unknown }> } = {
        version: 1,
        machines: {},
      };

      if (fs.existsSync(registryFile)) {
        try {
          registry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
        } catch { /* use default */ }
      }

      if (registry.machines[machineId]) {
        registry.machines[machineId].lastSeen = new Date().toISOString();
        fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
      }

      // Count queued changes for this machine (from offline queue if it exists)
      const queueFile = path.join(
        process.env.HOME || process.env.USERPROFILE || '/tmp',
        '.instar', 'offline-queue', `${ctx.config.projectName}.jsonl`,
      );
      let queuedChanges = 0;
      if (fs.existsSync(queueFile)) {
        const content = fs.readFileSync(queueFile, 'utf-8').trim();
        if (content) {
          queuedChanges = content.split('\n').filter(line => {
            try {
              const entry = JSON.parse(line);
              return entry.sourceMachineId === machineId;
            } catch {
              // @silent-fallback-ok — JSONL parse, skip corrupted
              return false;
            }
          }).length;
        }
      }

      res.json({
        status: 'ok',
        machineId,
        queuedChanges,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        error: 'Heartbeat processing failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Intent / Decision Journal ───────────────────────────────────

  router.get('/intent/journal', async (req, res) => {
    try {
      const { DecisionJournal } = await import('../core/DecisionJournal.js');
      const journal = new DecisionJournal(ctx.config.stateDir);

      const days = req.query.days ? parseInt(req.query.days as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const jobSlug = req.query.jobSlug as string | undefined;

      const entries = journal.read({ days, limit, jobSlug });
      res.json({ entries, count: entries.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read decision journal' });
    }
  });

  router.get('/intent/journal/stats', async (_req, res) => {
    try {
      const { DecisionJournal } = await import('../core/DecisionJournal.js');
      const journal = new DecisionJournal(ctx.config.stateDir);
      const stats = journal.stats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute journal stats' });
    }
  });

  router.post('/intent/journal', async (req, res) => {
    try {
      const { DecisionJournal } = await import('../core/DecisionJournal.js');
      const { EvidencePolicyError } = await import('../memory/SemanticMemory.js');
      const journal = new DecisionJournal(ctx.config.stateDir);

      const { sessionId, decision, evidence, ...rest } = req.body || {};

      if (!sessionId || !decision) {
        res.status(400).json({ error: 'sessionId and decision are required' });
        return;
      }

      // WikiClaim Phase 3 (spec § Producers line 258): every decision must
      // cite at least one evidence row. The route accepts an explicit
      // `evidence` array, OR — when omitted — synthesizes a minimum-viable
      // `session` evidence row from the request's `sessionId` (the auth-
      // context proxy available at this HTTP layer). Synthesis keeps the
      // legacy POST shape working while still satisfying the policy gate;
      // explicit evidence always overrides synthesis. Spec § Producers
      // line 227: `session` is in the DecisionJournal allowlist. Spec
      // § Storage and Privacy line 333: synthetic sourceIds are tolerated
      // (consumers handle dangling refs).
      let effectiveEvidence: any[] = Array.isArray(evidence) ? evidence : [];
      if (effectiveEvidence.length === 0) {
        effectiveEvidence = [{
          kind: 'session',
          sourceId: `session:${sessionId}`,
          weight: 0.5,
          confidence: 0.5,
          privacyTier: 'private',
          note: 'auto-synthesized from request session (no explicit evidence)',
          updatedAt: new Date().toISOString(),
        }];
      }

      try {
        const entry = journal.log({ sessionId, decision, ...rest }, effectiveEvidence);
        res.status(201).json(entry);
      } catch (err) {
        if (err instanceof EvidencePolicyError) {
          res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
        throw err;
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to log decision' });
    }
  });

  // ── Org Intent ─────────────────────────────────────────────────

  router.get('/intent/org', async (_req, res) => {
    try {
      const { OrgIntentManager } = await import('../core/OrgIntentManager.js');
      const manager = new OrgIntentManager(ctx.config.stateDir);
      const parsed = manager.parse();
      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read org intent' });
    }
  });

  // ORG-INTENT.md → session-start friendly text block.
  // Used by the session-start hook to inject the three-rule contract at the
  // start of every session, so the agent reasons with the intent from message
  // one rather than only being blocked by it at gate-evaluate time. Phase 2
  // of the ORG-INTENT runtime project. Returns:
  //   { present: true, block: "...text...", name, counts }   when ORG-INTENT.md is present
  //   { present: false }                                      when absent/template-only
  router.get('/intent/org/session-context', async (_req, res) => {
    try {
      const { OrgIntentManager, formatOrgIntentForSessionStart } = await import('../core/OrgIntentManager.js');
      const manager = new OrgIntentManager(ctx.config.stateDir);
      const parsed = manager.parse();
      if (!parsed) {
        res.json({ present: false });
        return;
      }
      const block = formatOrgIntentForSessionStart(parsed);
      res.json({
        present: true,
        block,
        name: parsed.name,
        counts: {
          constraints: parsed.constraints.length,
          goals: parsed.goals.length,
          values: parsed.values.length,
          tradeoffHierarchy: parsed.tradeoffHierarchy.length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read org intent' });
    }
  });

  // ── Preferences (Correction & Preference Learning Sentinel, Slice 1a) ──
  //
  // Auto-learned user preferences, served as a session-start block that mirrors
  // the ORG-INTENT precedent above. The correction loop (Slice 1b) is the writer
  // via `recordPreference()`; this route is the read surface the session-start
  // hook fetches on every boot, so the agent always SEES the preferences it has
  // learned about this user. SIGNAL-ONLY — this never blocks or rewrites an
  // outbound message.
  //
  // Gated on `monitoring.correctionLearning.enabled`:
  //   - disabled → 503 (the surface still exists for capability probing)
  //   - enabled  → 200 with the structured block (or { present: false } when
  //                there are no preferences yet)
  //
  // The block is bounded by `maxInjectedPreferencesBytes` (default 4000) and
  // priority-ordered (recency × confidence × dedupeCount). Serves ONLY the
  // `learning` text + metadata — never any raw extras.
  router.get('/preferences/session-context', async (_req, res) => {
    try {
      const cfg = ctx.config.monitoring?.correctionLearning;
      if (cfg?.enabled !== true) {
        res.status(503).json({ error: 'correction-learning disabled' });
        return;
      }
      const { PreferencesManager } = await import('../core/PreferencesManager.js');
      const manager = new PreferencesManager(ctx.config.stateDir);
      const maxBytes = typeof cfg.maxInjectedPreferencesBytes === 'number' && cfg.maxInjectedPreferencesBytes > 0
        ? cfg.maxInjectedPreferencesBytes
        : 4000;
      const result = manager.sessionContext(maxBytes);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read preferences' });
    }
  });

  // ── Corrections (Correction & Preference Learning Sentinel, Slice 1b) ──
  //
  // Read surface over the CorrectionLedger — distilled, scrubbed correction /
  // preference records. SIGNAL-ONLY: this loop never blocks or rewrites a
  // message; these routes are observability + the agent-diagnosed one-tap.
  //
  //   GET  /corrections          — list deduped records (bearer; 503 when off;
  //                                 toApiView strips raw `learning`; pagination:
  //                                 ?limit (default 100, cap 1000); ?before=<ISO>
  //                                 is the keyset CURSOR (detected_at < before;
  //                                 page by passing the prior page's nextBefore);
  //                                 ?since=<ISO> is a lower-bound (detected_at >=
  //                                 since); ?kind / ?status filters. Bad ?before /
  //                                 ?since are tolerated (ignored), never a 500.
  //   GET  /corrections/:id       — one record (toApiView)
  //   POST /corrections           — agent-diagnosed one-tap (requires X-Instar-Request:1)
  //
  // 503 when the feature is disabled (null ledger). The /corrections API NEVER
  // serves the raw `learning` text under any condition (CorrectionLedger.toApiView).
  router.get('/corrections', (req, res) => {
    if (!ctx.correctionLedger) { res.status(503).json({ error: 'correction-learning disabled' }); return; }
    const limit = req.query.limit ? Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 100), 1000) : 100;
    const before = typeof req.query.before === 'string' ? Date.parse(req.query.before) : NaN;
    const since = typeof req.query.since === 'string' ? Date.parse(req.query.since) : NaN;
    const kind = typeof req.query.kind === 'string' && ['infra-gap', 'user-preference', 'noise'].includes(req.query.kind)
      ? (req.query.kind as import('../monitoring/CorrectionLedger.js').CorrectionKind)
      : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as import('../monitoring/CorrectionLedger.js').CorrectionStatus) : undefined;
    const records = ctx.correctionLedger.list({
      limit,
      beforeMs: Number.isNaN(before) ? undefined : before,
      sinceMs: Number.isNaN(since) ? undefined : since,
      kind,
      status,
    });
    res.json({
      records: records.map((r) => CorrectionLedger.toApiView(r)),
      count: records.length,
      totalRecords: ctx.correctionLedger.countRecords(),
      // The keyset cursor for the NEXT page (detected_at < nextBefore). Null when
      // this page wasn't full (no more rows to fetch).
      nextBefore: records.length === limit ? records[records.length - 1].detectedAt : null,
    });
  });

  router.get('/corrections/:id', (req, res) => {
    if (!ctx.correctionLedger) { res.status(503).json({ error: 'correction-learning disabled' }); return; }
    const rec = ctx.correctionLedger.get(req.params.id);
    if (!rec) { res.status(404).json({ error: 'not found' }); return; }
    res.json(CorrectionLedger.toApiView(rec));
  });

  router.post('/corrections', (req, res) => {
    if (!ctx.correctionLedger) { res.status(503).json({ error: 'correction-learning disabled' }); return; }
    // Intent marker — paired with the deterministic scrub. NOT a transport boundary.
    if (req.headers['x-instar-request'] !== '1') {
      res.status(403).json({ error: 'POST /corrections requires the X-Instar-Request: 1 intent header' });
      return;
    }
    const body = req.body ?? {};
    const learning = typeof body.learning === 'string' ? body.learning.trim() : '';
    const kindRaw = typeof body.kind === 'string' ? body.kind : '';
    if (!learning) { res.status(400).json({ error: 'learning is required' }); return; }
    if (!['infra-gap', 'user-preference', 'noise'].includes(kindRaw)) {
      res.status(400).json({ error: 'kind must be one of infra-gap | user-preference | noise' });
      return;
    }
    const kind = kindRaw as import('../monitoring/CorrectionLedger.js').CorrectionKind;
    const summary = typeof body.scrubbedSummary === 'string' && body.scrubbedSummary.trim()
      ? body.scrubbedSummary.trim()
      : learning;
    // POST-SCRUB at the boundary (defense in depth — the writer scrubs again).
    const rec = ctx.correctionLedger.record({
      kind,
      learning: scrubCorrectionSecrets(learning),
      scrubbedSummary: scrubCorrectionSecrets(summary),
      deterministicWeight: typeof body.deterministicWeight === 'number' ? body.deterministicWeight : 3,
      llmConfidence: typeof body.llmConfidence === 'number' ? body.llmConfidence : 0,
      topicId: typeof body.topicId === 'number' ? body.topicId : null,
    });
    if (!rec) { res.status(500).json({ error: 'failed to record (logged via fail-open path)' }); return; }
    res.status(201).json(CorrectionLedger.toApiView(rec));
  });

  // The recurrence analyzer + closed-loop tick (Correction & Preference Learning
  // Sentinel, spec §3.5/§3.6/§3.7). Invoked by the off-by-default
  // `correction-analyzer` builtin job (Tier-1 supervised). Runs the 3-pronged
  // recurrence gate, then ROUTES each crossing record by kind:
  //   user-preference (policy-clean) → recordPreference()
  //   user-preference (policy-match) → Attention (human disposes)
  //   infra-gap (autoFeedback OFF, default) → tracked Action + draft Initiative
  //   infra-gap (autoFeedback ON) → loopback POST /feedback (real route guards)
  // …then opens a verify window. BY-CONSTRUCTION authority guard: the loop's
  // injected deps carry NO proposal-minting and NO direct memory-file write.
  router.post('/corrections/analyze', async (req, res) => {
    if (!ctx.correctionLedger) { res.status(503).json({ error: 'correction-learning disabled' }); return; }
    try {
      const cl = ctx.config.monitoring?.correctionLearning;
      const { CorrectionAnalyzer } = await import('../monitoring/CorrectionAnalyzer.js');
      const { CorrectionLoopDriver } = await import('../monitoring/CorrectionLoopDriver.js');
      const { PreferencesManager } = await import('../core/PreferencesManager.js');

      const analyzer = new CorrectionAnalyzer(ctx.correctionLedger, {
        minSupport: cl?.minSupport ?? 4,
        minDistinctDaysInfraGap: cl?.minDistinctDaysInfraGap ?? 3,
        minDistinctDaysPreference: cl?.minDistinctDaysPreference ?? 2,
        minDistinctTopicsPreference: cl?.minDistinctTopicsPreference ?? 2,
      });

      const prefs = new PreferencesManager(ctx.config.stateDir);
      const port = ctx.config.port;
      const authToken = ctx.config.authToken;
      const evo = ctx.evolution as { addAction?: (o: never) => { id: string } } | null;
      const tracker = ctx.initiativeTracker;

      // Loopback POST helpers — bearer-authed to the agent's OWN routes so they
      // traverse the real middleware (feedback anomaly/quality/length guards;
      // attention tone gate). Authorization is never logged.
      const feedbackLoopbackPost = async (payload: { type: string; title: string; description: string }): Promise<import('../monitoring/CorrectionLoopDriver.js').FeedbackPostResult> => {
        try {
          const resp = await fetch(`http://localhost:${port}/feedback`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
              'X-Instar-Origin': 'correction-loop',
            },
            body: JSON.stringify(payload),
          });
          // 429 = rate-limited (the route's 10/min/IP feedbackLimiter) → carry the
          // record to the next run; any other non-201 is a guard rejection (don't
          // retry). The driver serializes the batch + stops on the first 429.
          return { posted: resp.status === 201, rateLimited: resp.status === 429 };
        } catch { return { posted: false }; }
      };
      const attentionRoute = async (item: { id: string; title: string; summary: string; priority?: string }): Promise<boolean> => {
        try {
          const resp = await fetch(`http://localhost:${port}/attention`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${authToken}`,
              'X-Instar-Origin': 'correction-loop',
            },
            body: JSON.stringify({ source: 'correction-loop', body: item.summary, ...item }),
          });
          return resp.status === 201;
        } catch { return false; }
      };

      const driver = new CorrectionLoopDriver(ctx.correctionLedger, analyzer, {
        addAction: (o) => (evo?.addAction ? evo.addAction(o as never) : { id: 'no-evolution' }),
        createInitiative: async (i) => {
          if (tracker?.create) {
            const created = await tracker.create(i as never);
            return { id: created.id };
          }
          return { id: i.id };
        },
        feedbackLoopbackPost,
        recordPreference: (p) => { prefs.recordPreference(p); },
        attentionRoute,
        autoFeedback: cl?.autoFeedback === true,
        verifyWindowDaysPreference: cl?.verifyWindowDaysPreference ?? 7,
        verifyWindowDaysInfraGap: cl?.verifyWindowDaysInfraGap ?? 14,
        maxReopens: cl?.maxReopens ?? 2,
        // Per-tick add ceiling (NEW-5) + batched-POST delay (NEW-2) — overflow
        // stays `open` and re-routes next run; the batch serializes under the
        // /feedback route's 10/min IP limit.
        maxRoutesPerTick: cl?.maxRoutesPerTick ?? 5,
        feedbackPostDelayMs: cl?.feedbackPostDelayMs ?? 7000,
        audit: (event) => {
          try {
            const auditPath = path.join(ctx.config.stateDir, 'logs', 'correction-learning-audit.jsonl');
            fs.mkdirSync(path.dirname(auditPath), { recursive: true });
            fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), origin: 'correction-loop', ...event }) + '\n', { mode: 0o600 });
          } catch { /* @silent-fallback-ok — audit is best-effort */ }
        },
        preferenceStillPresent: (dedupeKey) =>
          prefs.read().preferences.some((e) => e.dedupeKey === dedupeKey),
      });

      const analysis = analyzer.analyze();
      const routed = await driver.route();
      const verified = driver.runVerification().evaluated.length;
      res.json({
        analysis: {
          considered: analysis.considered,
          crossed: analysis.crossed.length,
          belowThreshold: analysis.belowThreshold,
        },
        routed: {
          total: routed.routed.length,
          toFeedback: routed.toFeedback,
          toPreferences: routed.toPreferences,
          toAttention: routed.toAttention,
          // Gate-crossing records left `open` this run (per-tick ceiling OR a 429
          // cut the infra-gap batch short) — re-routed next run, never dropped.
          overflow: routed.overflow,
          rateLimited: routed.rateLimited,
        },
        verified,
      });
    } catch (err) {
      // Fail-open: the analyzer never crashes the caller (job).
      res.status(200).json({ error: 'analyze failed (logged)', detail: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Apprenticeship Program (Step 1) ──────────────────────────────────
  //
  // Instance-as-project registry + the two lifecycle gates. The transition
  // route is the ONLY way status changes (the gates are not advisory — the
  // state-mutating transition itself consults the gate). 503 when the program
  // is not wired (null). Bearer-auth enforced globally by authMiddleware.
  //
  //   GET  /apprenticeship/instances            — list
  //   GET  /apprenticeship/instances/:id        — one instance (404 missing)
  //   POST /apprenticeship/instances            — create (charset-clamped, dup-rejected)
  //   POST /apprenticeship/instances/:id/transition {to} — gated status change
  //   POST /apprenticeship/instances/:id/can-start    — read-only start-gate preview
  //   POST /apprenticeship/instances/:id/can-complete — read-only completion-gate preview
  //
  // Differential-cycle capture (structural companion store):
  //   POST /apprenticeship/cycles             — record one cycle row
  //   GET  /apprenticeship/cycles             — list rows; optional instanceId, limit
  //   GET  /apprenticeship/cycles/overdue     — read-only overdue SLA view
  //   GET  /apprenticeship/cycles/:id         — fetch one row (404 missing)
  //   POST /apprenticeship/cycles/:id/close   — mark row closed (404 missing)
  router.post('/apprenticeship/cycles', (req, res) => {
    if (!ctx.apprenticeshipCycleStore) { res.status(503).json({ error: 'apprenticeship cycle store disabled' }); return; }
    try {
      const cycle = ctx.apprenticeshipCycleStore.record(req.body ?? {});
      res.status(201).json(cycle);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/apprenticeship/cycles', (req, res) => {
    if (!ctx.apprenticeshipCycleStore) { res.status(503).json({ error: 'apprenticeship cycle store disabled' }); return; }
    const instanceId = typeof req.query.instanceId === 'string' && req.query.instanceId.trim() !== ''
      ? req.query.instanceId
      : undefined;
    const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined;
    res.json({ cycles: ctx.apprenticeshipCycleStore.list({ instanceId, limit }) });
  });

  router.get('/apprenticeship/cycles/overdue', (req, res) => {
    if (!ctx.apprenticeshipCycleSlaMonitor) { res.status(503).json({ error: 'apprenticeship cycle SLA monitor disabled' }); return; }
    const instanceId = typeof req.query.instanceId === 'string' && req.query.instanceId.trim() !== ''
      ? req.query.instanceId
      : undefined;
    res.json({ overdue: ctx.apprenticeshipCycleSlaMonitor.listOverdue(instanceId) });
  });

  router.get('/apprenticeship/cycles/:id', (req, res) => {
    if (!ctx.apprenticeshipCycleStore) { res.status(503).json({ error: 'apprenticeship cycle store disabled' }); return; }
    const cycle = ctx.apprenticeshipCycleStore.get(req.params.id);
    if (!cycle) { res.status(404).json({ error: 'not found' }); return; }
    res.json(cycle);
  });

  router.post('/apprenticeship/cycles/:id/close', (req, res) => {
    if (!ctx.apprenticeshipCycleStore) { res.status(503).json({ error: 'apprenticeship cycle store disabled' }); return; }
    const cycle = ctx.apprenticeshipCycleStore.closeCycle(req.params.id);
    if (!cycle) { res.status(404).json({ error: 'not found' }); return; }
    res.json(cycle);
  });

  router.get('/apprenticeship/instances', (_req, res) => {
    if (!ctx.apprenticeshipProgram) { res.status(503).json({ error: 'apprenticeship program disabled' }); return; }
    res.json({ instances: ctx.apprenticeshipProgram.list() });
  });

  router.get('/apprenticeship/instances/:id', (req, res) => {
    if (!ctx.apprenticeshipProgram) { res.status(503).json({ error: 'apprenticeship program disabled' }); return; }
    const inst = ctx.apprenticeshipProgram.get(req.params.id);
    if (!inst) { res.status(404).json({ error: 'not found' }); return; }
    res.json(inst);
  });

  router.post('/apprenticeship/instances', (req, res) => {
    if (!ctx.apprenticeshipProgram) { res.status(503).json({ error: 'apprenticeship program disabled' }); return; }
    const body = req.body ?? {};
    try {
      const inst = ctx.apprenticeshipProgram.createInstance({
        id: typeof body.id === 'string' ? body.id : '',
        instanceType: body.instanceType,
        overseer: typeof body.overseer === 'string' ? body.overseer : undefined,
        mentor: typeof body.mentor === 'string' ? body.mentor : '',
        mentee: typeof body.mentee === 'string' ? body.mentee : '',
        framework: typeof body.framework === 'string' ? body.framework : '',
        priorInstanceId: typeof body.priorInstanceId === 'string' ? body.priorInstanceId : null,
        requiredArtifacts: body.requiredArtifacts,
        programNeeds: Array.isArray(body.programNeeds) ? body.programNeeds : undefined,
      });
      res.status(201).json(inst);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/apprenticeship/instances/:id/transition', (req, res) => {
    if (!ctx.apprenticeshipProgram) { res.status(503).json({ error: 'apprenticeship program disabled' }); return; }
    const to = (req.body ?? {}).to;
    if (!['pending', 'active', 'complete', 'blocked'].includes(to)) {
      res.status(400).json({ error: 'to must be one of pending | active | complete | blocked' });
      return;
    }
    const result = ctx.apprenticeshipProgram.transition(req.params.id, to);
    if (!result.ok) {
      // 404 for a missing instance; 409 for a refused/illegal transition.
      const code = result.reason.includes('not found') ? 404 : 409;
      res.status(code).json({ ok: false, reason: result.reason });
      return;
    }
    res.json({ ok: true, reason: result.reason, instance: result.instance });
  });

  router.post('/apprenticeship/instances/:id/can-start', (req, res) => {
    if (!ctx.apprenticeshipProgram) { res.status(503).json({ error: 'apprenticeship program disabled' }); return; }
    const inst = ctx.apprenticeshipProgram.get(req.params.id);
    if (!inst) { res.status(404).json({ error: 'not found' }); return; }
    res.json(ctx.apprenticeshipProgram.evaluateStartGate(inst));
  });

  router.post('/apprenticeship/instances/:id/can-complete', (req, res) => {
    if (!ctx.apprenticeshipProgram) { res.status(503).json({ error: 'apprenticeship program disabled' }); return; }
    const inst = ctx.apprenticeshipProgram.get(req.params.id);
    if (!inst) { res.status(404).json({ error: 'not found' }); return; }
    res.json(ctx.apprenticeshipProgram.evaluateCompletionGate(inst));
  });

  // ORG-INTENT.md tradeoff resolution (Phase 3 of the ORG-INTENT runtime
  // project). Given two contending values, consults the organization's
  // tradeoff hierarchy and returns which wins, with the basis for the
  // decision. Pure logic — no LLM call. Auth-gated like the rest of /intent/*.
  //
  // Body: { valueA: string, valueB: string }
  // Response: TradeoffResolution + { hierarchy: string[] | null }
  router.post('/intent/tradeoff-resolve', async (req, res) => {
    const valueA = typeof req.body?.valueA === 'string' ? req.body.valueA : '';
    const valueB = typeof req.body?.valueB === 'string' ? req.body.valueB : '';

    if (!valueA || !valueB) {
      res.status(400).json({
        error: 'Both "valueA" and "valueB" are required string fields in the request body.',
      });
      return;
    }

    try {
      const { OrgIntentManager } = await import('../core/OrgIntentManager.js');
      const { resolveTradeoff } = await import('../core/TradeoffResolver.js');
      const manager = new OrgIntentManager(ctx.config.stateDir);
      const parsed = manager.parse();
      const hierarchy = parsed?.tradeoffHierarchy ?? [];

      const resolution = resolveTradeoff({ valueA, valueB, hierarchy });
      res.json({
        ...resolution,
        hierarchy: parsed ? hierarchy : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to resolve tradeoff' });
    }
  });

  // ORG-INTENT drift digest (Phase 4 of the ORG-INTENT runtime project).
  // Samples recent Coherence Gate review history and emits a drift digest:
  // overall block rate, per-reviewer breakdown, half-window trend comparison,
  // and cross-reference against ORG-INTENT constraints/goals/values. SIGNAL
  // only — never blocks anything. Used by the weekly org-intent-drift-audit
  // job, surfacable on-demand by the dashboard or any agent.
  //
  // Query params:
  //   ?lookbackDays=N   (default 7)
  //   ?limit=N          (default 500 — caps the entries pulled from history)
  router.get('/intent/org/drift', async (req, res) => {
    try {
      const lookbackDays = req.query.lookbackDays
        ? Math.max(1, parseInt(req.query.lookbackDays as string, 10) || 7)
        : 7;
      const limit = req.query.limit
        ? Math.max(1, parseInt(req.query.limit as string, 10) || 500)
        : 500;

      if (!ctx.responseReviewGate) {
        res.status(503).json({
          error: 'Response review pipeline not enabled — drift analysis requires gate review history.',
        });
        return;
      }

      const { OrgIntentManager } = await import('../core/OrgIntentManager.js');
      const { analyzeOrgIntentDrift } = await import('../core/OrgIntentDriftAnalyzer.js');

      const manager = new OrgIntentManager(ctx.config.stateDir);
      const parsed = manager.parse();

      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
      const history = ctx.responseReviewGate.getReviewHistory({ since, limit });

      const analysis = analyzeOrgIntentDrift({
        entries: history.map(h => ({
          timestamp: h.timestamp,
          verdict: h.verdict,
          violations: h.violations.map(v => ({
            reviewer: v.reviewer,
            severity: v.severity,
            issue: v.issue,
          })),
        })),
        orgIntent: parsed,
        lookbackDays,
      });

      res.json(analysis);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to analyze drift' });
    }
  });

  router.get('/intent/validate', async (_req, res) => {
    try {
      const { OrgIntentManager } = await import('../core/OrgIntentManager.js');
      const manager = new OrgIntentManager(ctx.config.stateDir);

      // Read agent intent from AGENT.md
      const agentMdPath = path.join(ctx.config.stateDir, 'AGENT.md');
      let agentIntentContent = '';

      if (fs.existsSync(agentMdPath)) {
        const content = fs.readFileSync(agentMdPath, 'utf-8');
        // Extract the Intent section inline (same logic as extractIntentSection)
        const lines = content.split('\n');
        let inIntent = false;
        const intentLines: string[] = [];
        for (const line of lines) {
          if (/^##\s+Intent\b/.test(line)) { inIntent = true; intentLines.push(line); continue; }
          if (inIntent && /^##\s+/.test(line) && !/^###/.test(line)) break;
          if (inIntent) intentLines.push(line);
        }
        agentIntentContent = intentLines.join('\n').trim();
      }

      const result = manager.validateAgentIntent(agentIntentContent);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to validate intent' });
    }
  });

  // ── Intent Drift & Alignment ────────────────────────────────────

  router.get('/intent/drift', async (req, res) => {
    try {
      const { IntentDriftDetector } = await import('../core/IntentDriftDetector.js');
      const detector = new IntentDriftDetector(ctx.config.stateDir);
      const windowDays = req.query.window ? parseInt(req.query.window as string, 10) : 14;
      const analysis = detector.analyze(windowDays);
      res.json(analysis);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to analyze drift' });
    }
  });

  router.get('/intent/alignment', async (_req, res) => {
    try {
      const { IntentDriftDetector } = await import('../core/IntentDriftDetector.js');
      const detector = new IntentDriftDetector(ctx.config.stateDir);
      const score = detector.alignmentScore();
      res.json(score);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to compute alignment score' });
    }
  });

  // ── Triage ───────────────────────────────────────────────────────

  router.get('/triage/status', (_req, res) => {
    if (!ctx.triageNurse) {
      return res.json({ enabled: false });
    }
    res.json(ctx.triageNurse.getStatus());
  });

  router.get('/triage/history', (req, res) => {
    if (!ctx.triageNurse) {
      return res.json([]);
    }
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(ctx.triageNurse.getHistory(limit));
  });

  router.post('/triage/trigger', async (req, res) => {
    if (!ctx.triageNurse) {
      return res.status(400).json({ error: 'Triage nurse not enabled' });
    }
    const { sessionName, topicId } = req.body;
    if (!sessionName || !topicId) {
      return res.status(400).json({ error: 'sessionName and topicId required' });
    }
    try {
      const result = await ctx.triageNurse.triage(topicId, sessionName, '(manual trigger)', Date.now(), 'manual');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Triage failed' });
    }
  });

  // ── Systems Dashboard (rich telemetry) ──────────────────────────
  // Shared helper: safely extract data from a subsystem
  function safeGet<T>(fn: () => T): T | null {
    try { return fn(); } catch { return null; }
  }

  // Build capability telemetry for one capability
  function buildCapabilityTelemetry(id: string): {
    metric: string;
    stats: Record<string, number | string | boolean | null>;
    lastActivity: string | null;
  } {
    const stats: Record<string, number | string | boolean | null> = {};
    let lastActivity: string | null = null;
    let metric = 'Active';

    try {
      switch (id) {
        case 'session-recovery': {
          const ws = safeGet(() => ctx.watchdog?.getStats?.());
          const ts = safeGet(() => ctx.triageNurse?.getStatus?.());
          if (ws) {
            stats.interventions = ws.interventionsTotal ?? 0;
            stats.recoveries = ws.recoveries ?? 0;
            stats.sessionDeaths = ws.sessionDeaths ?? 0;
            stats.llmOverrides = ws.llmGateOverrides ?? 0;
            metric = ws.interventionsTotal > 0
              ? `${ws.recoveries} recovered · ${ws.interventionsTotal} interventions`
              : 'No interventions needed';
          }
          if (ts) {
            stats.activeCases = ts.activeCases ?? 0;
            stats.totalTriages = ts.historyCount ?? 0;
            stats.cooldowns = ts.cooldowns ?? 0;
            if (ts.activeCases) metric += ` · ${ts.activeCases} active`;
          }
          if (!ws && !ts) metric = 'Standing by';
          break;
        }
        case 'session-intelligence': {
          stats.monitoring = true;
          metric = 'Monitoring active sessions';
          break;
        }
        case 'health-monitoring': {
          const cr = safeGet(() => ctx.coherenceMonitor?.getLastReport?.()) as { passed?: number; failed?: number; corrected?: number; timestamp?: string } | null;
          const sr = safeGet(() => ctx.systemReviewer?.getHealthStatus?.()) as { status?: string; message?: string; lastCheck?: string } | null;
          const mp = safeGet(() => ctx.memoryMonitor?.getState?.()) as { pressurePercent?: number; state?: string; freeGB?: number; totalGB?: number; trend?: string; lastChecked?: string } | null;
          const op = safeGet(() => ctx.orphanReaper?.getLastReport?.()) as { tracked?: unknown[]; orphans?: unknown[]; totalMemoryMB?: number; timestamp?: string } | null;
          const parts: string[] = [];
          if (cr) {
            stats.coherenceChecks = (cr.passed ?? 0) + (cr.failed ?? 0);
            stats.coherencePassed = cr.passed ?? 0;
            stats.coherenceFailed = cr.failed ?? 0;
            stats.coherenceCorrected = cr.corrected ?? 0;
            if (cr.timestamp) lastActivity = cr.timestamp;
            parts.push(cr.failed ? `${cr.failed} failing` : `${cr.passed ?? 0} checks passed`);
          }
          if (sr) {
            stats.reviewStatus = sr.status ?? 'unknown';
            if (sr.lastCheck) lastActivity = sr.lastCheck;
            if (sr.message) parts.push(sr.message);
          }
          if (mp) {
            stats.memoryPercent = Math.round(mp.pressurePercent ?? 0);
            stats.memoryState = mp.state ?? 'unknown';
            stats.memoryFreeGB = Math.round((mp.freeGB ?? 0) * 10) / 10;
            stats.memoryTotalGB = Math.round((mp.totalGB ?? 0) * 10) / 10;
            stats.memoryTrend = mp.trend ?? 'stable';
            if (mp.lastChecked) lastActivity = mp.lastChecked;
            parts.push(`Memory ${Math.round(mp.pressurePercent ?? 0)}%`);
          }
          if (op) {
            stats.trackedProcesses = Array.isArray(op.tracked) ? op.tracked.length : 0;
            stats.orphanProcesses = Array.isArray(op.orphans) ? op.orphans.length : 0;
            stats.totalMemoryMB = Math.round(op.totalMemoryMB ?? 0);
          }
          metric = parts.join(' · ') || 'All checks passing';
          break;
        }
        case 'safety-trust': { stats.gatesActive = true; metric = 'All gates active'; break; }
        case 'coherence': {
          const cr = safeGet(() => ctx.coherenceMonitor?.getHealth?.()) as { status?: string; lastCheck?: string } | null;
          if (cr?.lastCheck) lastActivity = cr.lastCheck;
          metric = 'Monitoring project integrity';
          break;
        }
        case 'scheduled-jobs': {
          const js = safeGet(() => ctx.scheduler?.getStatus?.());
          if (js) {
            stats.totalJobs = js.jobCount ?? 0;
            stats.enabledJobs = js.enabledJobs ?? 0;
            stats.queueLength = js.queueLength ?? 0;
            stats.activeJobSessions = js.activeJobSessions ?? 0;
            const parts = [`${js.enabledJobs} jobs enabled`];
            if (js.activeJobSessions > 0) parts.push(`${js.activeJobSessions} running`);
            if (js.queueLength > 0) parts.push(`${js.queueLength} queued`);
            metric = parts.join(' · ');
          }
          break;
        }
        case 'quota': {
          const qs = safeGet(() => ctx.quotaTracker?.getState?.());
          if (qs) {
            stats.weeklyUsage = Math.round(qs.usagePercent ?? 0);
            stats.fiveHourRate = qs.fiveHourPercent != null ? Math.round(qs.fiveHourPercent) : null;
            stats.recommendation = qs.recommendation ?? 'normal';
            if (qs.lastUpdated) lastActivity = qs.lastUpdated;
            const parts = [`Weekly usage ${Math.round(qs.usagePercent)}%`];
            if (qs.fiveHourPercent != null) parts.push(`5h rate ${Math.round(qs.fiveHourPercent)}%`);
            metric = parts.join(' · ');
          }
          break;
        }
        case 'telegram': {
          const ts = safeGet(() => ctx.telegram?.getStatus?.());
          const ls = safeGet(() => ctx.telegram?.getLogStats?.());
          if (ts) {
            stats.connected = ts.started ?? false;
            stats.uptimeMs = ts.uptime ?? 0;
            stats.topicMappings = ts.topicMappings ?? 0;
            stats.pendingStalls = ts.pendingStalls ?? 0;
            const parts: string[] = [];
            if (ts.uptime) {
              const hrs = Math.floor(ts.uptime / 3600000);
              const mins = Math.floor((ts.uptime % 3600000) / 60000);
              parts.push(`Connected ${hrs > 0 ? hrs + 'h ' : ''}${mins}m`);
            }
            if (ts.topicMappings > 0) parts.push(`${ts.topicMappings} topics`);
            metric = parts.join(' · ') || 'Connected';
          }
          if (ls) { stats.totalMessages = ls.totalMessages ?? 0; }
          break;
        }
        case 'whatsapp': { metric = 'Connected'; break; }
        case 'slack': { metric = 'Connected'; break; }
        case 'message-routing': { metric = 'Routing active'; break; }
        case 'memory': { metric = 'Context assembly active'; break; }
        case 'evolution': {
          const ed = safeGet(() => ctx.evolution?.getDashboard?.()) as {
            evolution?: { totalProposals?: number }; learnings?: { totalLearnings?: number; applied?: number };
            gaps?: { totalGaps?: number }; actions?: { totalActions?: number; overdue?: number };
          } | null;
          if (ed) {
            stats.proposals = ed.evolution?.totalProposals ?? 0;
            stats.learnings = ed.learnings?.totalLearnings ?? 0;
            stats.learningsApplied = ed.learnings?.applied ?? 0;
            stats.gaps = ed.gaps?.totalGaps ?? 0;
            stats.actions = ed.actions?.totalActions ?? 0;
            stats.overdueActions = ed.actions?.overdue ?? 0;
            const parts: string[] = [];
            if (ed.evolution?.totalProposals) parts.push(`${ed.evolution.totalProposals} proposals`);
            if (ed.gaps?.totalGaps) parts.push(`${ed.gaps.totalGaps} gaps`);
            if (ed.learnings?.applied) parts.push(`${ed.learnings.applied} applied`);
            metric = parts.join(' · ') || 'Monitoring capabilities';
          }
          break;
        }
        case 'infrastructure': {
          const tunnelUrl = safeGet(() => ctx.tunnel?.getExternalUrl?.('/'));
          stats.tunnelActive = !!tunnelUrl;
          metric = tunnelUrl ? 'Tunnel active' : 'Running';
          break;
        }
      }
    } catch { /* fallback */ }

    return { metric, stats, lastActivity };
  }

  router.get('/systems/status', (_req, res) => {
    const uptimeMs = Date.now() - ctx.startTime.getTime();

    // ── Capability metadata: maps internal subsystems to user-friendly labels ──
    interface CapabilityDef {
      id: string;
      label: string;
      description: string;
      processes: { name: string; subsystem: unknown; statusFn?: () => unknown }[];
    }

    const capabilityDefs: CapabilityDef[] = [
      {
        id: 'session-recovery',
        label: 'Session Recovery',
        description: 'Detects stuck or crashed sessions and automatically recovers them. Uses a 4-layer stack: watchdog catches stuck commands, mechanical recovery fixes JSONL issues, heuristics handle 90% of remaining cases, and LLM diagnosis covers the rest.',
        processes: [
          { name: 'SessionWatchdog', subsystem: ctx.watchdog, statusFn: () => ctx.watchdog?.getStatus() },
          { name: 'StallTriageNurse', subsystem: ctx.triageNurse, statusFn: () => ctx.triageNurse?.getStatus() },
          { name: 'SpawnRequestManager', subsystem: ctx.spawnManager },
        ],
      },
      {
        id: 'session-intelligence',
        label: 'Session Intelligence',
        description: 'Monitors session activity and generates summaries for smart message routing. Captures terminal output every 60 seconds to enable intelligent routing of incoming messages to the most relevant session.',
        processes: [
          { name: 'SessionActivitySentinel', subsystem: ctx.activitySentinel },
          { name: 'SessionSummarySentinel', subsystem: ctx.summarySentinel },
        ],
      },
      {
        id: 'health-monitoring',
        label: 'Health Monitoring',
        description: 'Continuous self-checks across config drift, resource pressure, system integrity, and functional probes. Runs coherence checks every 5 minutes and deep system reviews every 6 hours.',
        processes: [
          { name: 'CoherenceMonitor', subsystem: ctx.coherenceMonitor, statusFn: () => ctx.coherenceMonitor?.getLastReport() },
          { name: 'SystemReviewer', subsystem: ctx.systemReviewer, statusFn: () => ctx.systemReviewer?.getHealthStatus() },
          { name: 'MemoryPressureMonitor', subsystem: ctx.memoryMonitor, statusFn: () => ctx.memoryMonitor?.getState() },
          { name: 'OrphanProcessReaper', subsystem: ctx.orphanReaper, statusFn: () => ctx.orphanReaper?.getLastReport() },
        ],
      },
      {
        id: 'safety-trust',
        label: 'Safety & Trust',
        description: 'Gates external operations by risk level, validates inbound messages against injection patterns, and manages adaptive trust levels per service.',
        processes: [
          { name: 'ExternalOperationGate', subsystem: ctx.operationGate },
          { name: 'MessageSentinel', subsystem: ctx.sentinel },
          { name: 'AdaptiveTrust', subsystem: ctx.adaptiveTrust },
          { name: 'AutonomyManager', subsystem: ctx.autonomyManager },
        ],
      },
      {
        id: 'coherence',
        label: 'Coherence & Integrity',
        description: 'Ensures project state, scope boundaries, and response quality remain consistent. Prevents cross-project contamination and validates agent instructions are properly loaded.',
        processes: [
          { name: 'CoherenceGate', subsystem: ctx.coherenceGate },
          { name: 'ResponseReviewGate', subsystem: ctx.responseReviewGate },
          { name: 'CanonicalState', subsystem: ctx.canonicalState },
          { name: 'InstructionsVerifier', subsystem: ctx.instructionsVerifier },
        ],
      },
      {
        id: 'scheduled-jobs',
        label: 'Scheduled Jobs',
        description: 'Runs tasks on cron schedules with priority-based queuing. Also tracks behavioral commitments the agent made to the user.',
        processes: [
          { name: 'JobScheduler', subsystem: ctx.scheduler },
          { name: 'CommitmentTracker', subsystem: ctx.commitmentTracker, statusFn: () => ({ active: ctx.commitmentTracker?.getActive().length ?? 0 }) },
        ],
      },
      {
        id: 'quota',
        label: 'Quota Management',
        description: 'Tracks Claude API token usage in real-time. Sends warnings when approaching limits, enforces quotas, and auto-switches between accounts if configured.',
        processes: [
          { name: 'QuotaTracker', subsystem: ctx.quotaTracker, statusFn: () => ctx.quotaTracker?.getState() },
          { name: 'QuotaManager', subsystem: ctx.quotaManager },
        ],
      },
      {
        id: 'telegram',
        label: 'Telegram',
        description: 'Full Telegram messaging integration with long-polling, topic-based session routing, notification batching, and delivery retry.',
        processes: [
          { name: 'TelegramAdapter', subsystem: ctx.telegram },
        ],
      },
      {
        id: 'whatsapp',
        label: 'WhatsApp',
        description: 'Sends and receives messages through WhatsApp',
        processes: [
          { name: 'WhatsAppAdapter', subsystem: ctx.whatsapp },
        ],
      },
      {
        id: 'slack',
        label: 'Slack',
        description: 'Sends and receives messages through Slack',
        processes: [
          { name: 'SlackAdapter', subsystem: ctx.slack },
        ],
      },
      {
        id: 'message-routing',
        label: 'Message Routing',
        description: 'Routes messages between platforms and sessions intelligently. Handles cross-platform bridging and inter-agent delivery with retry and dead-letter archiving.',
        processes: [
          { name: 'MessageBridge', subsystem: ctx.messageBridge },
          { name: 'MessageRouter', subsystem: ctx.messageRouter },
        ],
      },
      {
        id: 'memory',
        label: 'Memory & Context',
        description: 'Topic memory stores conversation history per topic. Semantic memory enables natural language search. Working memory assembles relevant context for each session.',
        processes: [
          { name: 'TopicMemory', subsystem: ctx.topicMemory },
          { name: 'SemanticMemory', subsystem: ctx.semanticMemory },
          { name: 'WorkingMemoryAssembler', subsystem: ctx.workingMemory },
          { name: 'SelfKnowledgeTree', subsystem: ctx.selfKnowledgeTree },
        ],
      },
      {
        id: 'evolution',
        label: 'Self-Improvement',
        description: 'Detects capability gaps, generates improvement proposals, tracks learnings, and implements approved changes. The self-improvement loop.',
        processes: [
          { name: 'EvolutionManager', subsystem: ctx.evolution },
          { name: 'AutonomousEvolution', subsystem: ctx.autonomousEvolution },
          { name: 'CapabilityMapper', subsystem: ctx.capabilityMapper },
          { name: 'CoverageAuditor', subsystem: ctx.coverageAuditor },
        ],
      },
      {
        id: 'infrastructure',
        label: 'Infrastructure',
        description: 'Cloudflare tunnel for remote access, git worktree management for isolated agent work, and the Threadline agent network.',
        processes: [
          { name: 'TunnelManager', subsystem: ctx.tunnel },
          { name: 'WorktreeMonitor', subsystem: ctx.worktreeMonitor },
          { name: 'ThreadlineRouter', subsystem: ctx.threadlineRouter },
        ],
      },
    ];

    // Build active capabilities with full telemetry
    interface ActiveCapability {
      id: string;
      label: string;
      description: string;
      status: 'active' | 'error';
      metric: string;
      stats: Record<string, number | string | boolean | null>;
      lastActivity: string | null;
      processes: { name: string; status: 'running' | 'error'; details?: unknown }[];
    }

    interface Issue {
      severity: 'error' | 'warning';
      label: string;
      description: string;
      capability: string;
      process: string;
    }

    const activeCapabilities: ActiveCapability[] = [];
    const issues: Issue[] = [];

    for (const def of capabilityDefs) {
      const configuredProcesses = def.processes.filter(p => p.subsystem != null);
      if (configuredProcesses.length === 0) continue;

      const processResults: { name: string; status: 'running' | 'error'; details?: unknown }[] = [];
      let hasError = false;

      for (const p of configuredProcesses) {
        try {
          const details = p.statusFn ? p.statusFn() : undefined;
          processResults.push({ name: p.name, status: 'running', details });
        } catch {
          processResults.push({ name: p.name, status: 'error' });
          hasError = true;
          issues.push({
            severity: 'error',
            label: `${def.label} issue`,
            description: `${p.name} encountered an error`,
            capability: def.id,
            process: p.name,
          });
        }
      }

      const telemetry = buildCapabilityTelemetry(def.id);

      activeCapabilities.push({
        id: def.id,
        label: def.label,
        description: def.description,
        status: hasError ? 'error' : 'active',
        metric: telemetry.metric,
        stats: telemetry.stats,
        lastActivity: telemetry.lastActivity,
        processes: processResults,
      });
    }

    // Determine overall health
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const health = errorCount > 0 ? 'error' as const : 'healthy' as const;
    const healthSummary = health === 'healthy'
      ? 'All systems operational'
      : `${errorCount} issue${errorCount > 1 ? 's' : ''} need${errorCount === 1 ? 's' : ''} attention`;

    // Recent degradation events
    const allEvents = DegradationReporter.getInstance().getEvents();
    const recentEvents = allEvents.slice(-20).reverse().map(e => ({
      ...e,
      narrative: DegradationReporter.narrativeFor(e),
    }));

    res.json({
      uptime: uptimeMs,
      health,
      healthSummary,
      activeCapabilities,
      issues,
      recentEvents,
    });
  });

  // Detail endpoint for a single capability
  router.get('/systems/capability/:id', (req, res) => {
    const capId = req.params.id;
    const telemetry = buildCapabilityTelemetry(capId);
    const uptimeMs = Date.now() - ctx.startTime.getTime();
    res.json({ id: capId, uptime: uptimeMs, ...telemetry });
  });

  // ── External Operation Safety ────────────────────────────────────

  // POST /operations/classify — classify an external operation
  router.post('/operations/classify', (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const { service, mutability, reversibility, description, itemCount } = req.body;
    if (!service || !mutability || !reversibility || !description) {
      return res.status(400).json({ error: 'service, mutability, reversibility, and description are required' });
    }
    const classification = ctx.operationGate.classify({
      service,
      mutability: mutability as OperationMutability,
      reversibility: reversibility as OperationReversibility,
      description,
      itemCount,
    });
    res.json(classification);
  });

  // POST /operations/evaluate — full gate evaluation
  router.post('/operations/evaluate', async (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const { service, mutability, reversibility, description, itemCount, userRequest } = req.body;
    if (!service || !mutability || !reversibility || !description) {
      return res.status(400).json({ error: 'service, mutability, reversibility, and description are required' });
    }
    try {
      const decision = await ctx.operationGate.evaluate({
        service,
        mutability: mutability as OperationMutability,
        reversibility: reversibility as OperationReversibility,
        description,
        itemCount,
        userRequest,
      });
      res.json(decision);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Evaluation failed' });
    }
  });

  // GET /operations/log — recent operation history
  router.get('/operations/log', (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(ctx.operationGate.getOperationLog(limit));
  });

  // GET /operations/permissions/:service — service permissions
  router.get('/operations/permissions/:service', (req, res) => {
    if (!ctx.operationGate) {
      return res.status(404).json({ error: 'ExternalOperationGate not configured' });
    }
    const perms = ctx.operationGate.getServicePermissions(req.params.service);
    if (!perms) {
      return res.json({ service: req.params.service, configured: false });
    }
    res.json({ service: req.params.service, configured: true, ...perms });
  });

  // POST /sentinel/classify — test message classification without executing
  router.post('/sentinel/classify', async (req, res) => {
    if (!ctx.sentinel) {
      return res.status(404).json({ error: 'MessageSentinel not configured' });
    }
    const { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required (string)' });
    }
    const result = await ctx.sentinel.classify(message);
    res.json(result);
  });

  // GET /sentinel/stats — sentinel classification stats
  router.get('/sentinel/stats', (req, res) => {
    if (!ctx.sentinel) {
      return res.status(404).json({ error: 'MessageSentinel not configured' });
    }
    res.json(ctx.sentinel.getStats());
  });

  // GET /trust — full trust profile
  router.get('/trust', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json(ctx.adaptiveTrust.getProfile());
  });

  // GET /trust/summary — compact trust summary
  router.get('/trust/summary', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json({ summary: ctx.adaptiveTrust.getSummary() });
  });

  // POST /trust/grant — explicitly grant trust
  router.post('/trust/grant', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    const { service, operation, level, statement } = req.body;
    if (!service || !operation || !level || !statement) {
      return res.status(400).json({ error: 'service, operation, level, and statement are required' });
    }
    const event = ctx.adaptiveTrust.grantTrust(
      service,
      operation as OperationMutability,
      level,
      statement
    );
    res.json(event);
  });

  // GET /trust/elevations — pending elevation suggestions
  router.get('/trust/elevations', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json(ctx.adaptiveTrust.getPendingElevations());
  });

  // GET /trust/changelog — recent trust changes
  router.get('/trust/changelog', (req, res) => {
    if (!ctx.adaptiveTrust) {
      return res.status(404).json({ error: 'AdaptiveTrust not configured' });
    }
    res.json(ctx.adaptiveTrust.getChangeLog());
  });

  // ── Adaptive Autonomy ────────────────────────────────────────────

  // GET /autonomy — full autonomy dashboard
  router.get('/autonomy', (_req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    res.json(ctx.autonomyManager.getDashboard());
  });

  // GET /autonomy/summary — natural language summary for conversational use
  router.get('/autonomy/summary', (_req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    res.json({ summary: ctx.autonomyManager.getNaturalLanguageSummary() });
  });

  // POST /autonomy/profile — set the autonomy profile
  // Body: { profile: "cautious" | "supervised" | "collaborative" | "autonomous", reason: string }
  router.post('/autonomy/profile', (req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    const { profile, reason } = req.body;
    const validProfiles: AutonomyProfileLevel[] = ['cautious', 'supervised', 'collaborative', 'autonomous'];
    if (!profile || !validProfiles.includes(profile)) {
      return res.status(400).json({
        error: `Invalid profile. Must be one of: ${validProfiles.join(', ')}`,
      });
    }
    const resolved = ctx.autonomyManager.setProfile(profile, reason || 'User request');
    res.json({
      profile,
      resolved,
      summary: ctx.autonomyManager.getNaturalLanguageSummary(),
    });
  });

  // PATCH /autonomy/notifications — update notification preferences
  router.patch('/autonomy/notifications', (req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    ctx.autonomyManager.setNotificationPreferences(req.body);
    res.json({ notifications: ctx.autonomyManager.getNotificationPreferences() });
  });

  // GET /autonomy/history — profile change history
  router.get('/autonomy/history', (_req, res) => {
    if (!ctx.autonomyManager) {
      return res.status(404).json({ error: 'Autonomy system not configured' });
    }
    res.json({ history: ctx.autonomyManager.getHistory() });
  });

  // ── Trust Elevation Tracking ─────────────────────────────────────

  // GET /autonomy/elevation — full trust elevation dashboard
  router.get('/autonomy/elevation', (_req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    res.json(ctx.trustElevationTracker.getDashboard());
  });

  // GET /autonomy/elevation/opportunities — active elevation opportunities
  router.get('/autonomy/elevation/opportunities', (_req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    res.json({ opportunities: ctx.trustElevationTracker.getActiveOpportunities() });
  });

  // POST /autonomy/elevation/record — record a proposal decision for tracking
  // Body: { proposalId, proposedAt, decision, modified? }
  router.post('/autonomy/elevation/record', (req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    const { proposalId, proposedAt, decision, modified } = req.body;
    if (!proposalId || !proposedAt || !decision) {
      return res.status(400).json({ error: 'Required: proposalId, proposedAt, decision' });
    }
    const validDecisions = ['approved', 'rejected', 'deferred'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json({ error: `Invalid decision. Must be one of: ${validDecisions.join(', ')}` });
    }

    const now = new Date();
    const latencyMs = now.getTime() - new Date(proposedAt).getTime();

    ctx.trustElevationTracker.recordApprovalEvent({
      proposalId,
      proposedAt,
      decidedAt: now.toISOString(),
      decision,
      modified: modified ?? false,
      latencyMs,
    });

    res.json({
      recorded: true,
      acceptanceStats: ctx.trustElevationTracker.getAcceptanceStats(),
      rubberStamp: ctx.trustElevationTracker.getRubberStampSignal(),
    });
  });

  // POST /autonomy/elevation/dismiss — dismiss an elevation opportunity
  // Body: { type, days? }
  router.post('/autonomy/elevation/dismiss', (req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    const { type, days } = req.body;
    if (!type) {
      return res.status(400).json({ error: 'Required: type' });
    }
    const success = ctx.trustElevationTracker.dismissOpportunity(type, days ?? 30);
    res.json({ dismissed: success });
  });

  // POST /autonomy/elevation/dismiss-rubber-stamp — dismiss rubber-stamp alert
  // Body: { days? }
  router.post('/autonomy/elevation/dismiss-rubber-stamp', (req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    ctx.trustElevationTracker.dismissRubberStamp(req.body.days ?? 60);
    res.json({ dismissed: true, rubberStamp: ctx.trustElevationTracker.getRubberStampSignal() });
  });

  // GET /autonomy/elevation/acceptance — evolution acceptance stats
  router.get('/autonomy/elevation/acceptance', (_req, res) => {
    if (!ctx.trustElevationTracker) {
      return res.status(404).json({ error: 'Trust elevation tracking not configured' });
    }
    res.json(ctx.trustElevationTracker.getAcceptanceStats());
  });

  // ── Autonomous Evolution ────────────────────────────────────────────

  // GET /autonomy/evolution — autonomous evolution dashboard
  router.get('/autonomy/evolution', (_req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    res.json(ctx.autonomousEvolution.getDashboard());
  });

  // POST /autonomy/evolution/evaluate — evaluate a proposal for auto-implementation
  // Body: { proposalId, title, source, review: { decision, reason, affectedFields, confidence } }
  router.post('/autonomy/evolution/evaluate', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { review } = req.body;
    if (!review || !review.decision || !review.affectedFields) {
      return res.status(400).json({ error: 'Required: review.decision, review.affectedFields' });
    }

    const autonomousMode = ctx.autonomyManager?.getResolvedState().evolutionApprovalMode === 'autonomous';
    const result = ctx.autonomousEvolution.evaluateForAutoImplementation(review, autonomousMode);
    res.json({
      ...result,
      scope: ctx.autonomousEvolution.classifyScope(review.affectedFields),
      autonomousMode,
    });
  });

  // POST /autonomy/evolution/sidecar — create a sidecar file for proposed job changes
  // Body: { jobSlug, proposalId, changes }
  router.post('/autonomy/evolution/sidecar', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { jobSlug, proposalId, changes } = req.body;
    if (!jobSlug || !proposalId || !changes) {
      return res.status(400).json({ error: 'Required: jobSlug, proposalId, changes' });
    }
    const sidecar = ctx.autonomousEvolution.createSidecar(jobSlug, proposalId, changes);
    res.json({ created: true, sidecar });
  });

  // POST /autonomy/evolution/sidecar/apply — apply a pending sidecar
  // Body: { proposalId }
  router.post('/autonomy/evolution/sidecar/apply', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { proposalId } = req.body;
    if (!proposalId) {
      return res.status(400).json({ error: 'Required: proposalId' });
    }
    const success = ctx.autonomousEvolution.applySidecar(proposalId);
    res.json({ applied: success });
  });

  // POST /autonomy/evolution/revert — revert an applied sidecar
  // Body: { proposalId }
  router.post('/autonomy/evolution/revert', (req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const { proposalId } = req.body;
    if (!proposalId) {
      return res.status(400).json({ error: 'Required: proposalId' });
    }
    const success = ctx.autonomousEvolution.revertSidecar(proposalId);
    res.json({ reverted: success });
  });

  // GET /autonomy/evolution/notifications — peek at notification queue
  router.get('/autonomy/evolution/notifications', (_req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    res.json({
      pending: ctx.autonomousEvolution.peekNotifications(),
      recentHistory: ctx.autonomousEvolution.getNotificationHistory(20),
    });
  });

  // POST /autonomy/evolution/notifications/drain — drain the notification queue
  router.post('/autonomy/evolution/notifications/drain', (_req, res) => {
    if (!ctx.autonomousEvolution) {
      return res.status(404).json({ error: 'Autonomous evolution not configured' });
    }
    const drained = ctx.autonomousEvolution.drainNotifications();
    res.json({ drained: drained.length, notifications: drained });
  });

  // ── Identity / Soul.md ───────────────────────────────────────────────

  // GET /identity — combined identity overview (public sections only)
  router.get('/identity', (_req, res) => {
    const agentMdPath = path.join(ctx.config.stateDir, 'AGENT.md');
    const agentMd = fs.existsSync(agentMdPath)
      ? fs.readFileSync(agentMdPath, 'utf-8')
      : null;

    const soulPublic = ctx.soulManager?.readPublicSections() ?? null;

    res.json({
      agentName: ctx.config.projectName,
      agentMd: agentMd ? agentMd.substring(0, 2000) : null,
      soul: soulPublic,
      soulEnabled: ctx.soulManager?.isEnabled() ?? false,
    });
  });

  // GET /identity/soul — full soul.md content (requires auth)
  router.get('/identity/soul', (_req, res) => {
    if (!ctx.soulManager || !ctx.soulManager.isEnabled()) {
      return res.status(404).json({ error: 'soul.md is not enabled for this agent' });
    }
    const content = ctx.soulManager.readSoul();
    res.json({ content, enabled: true });
  });

  // PATCH /identity/soul — structured soul.md update with trust enforcement
  router.patch('/identity/soul', (req, res) => {
    if (!ctx.soulManager || !ctx.soulManager.isEnabled()) {
      return res.status(404).json({ error: 'soul.md is not enabled for this agent' });
    }

    const { section, operation, content, source } = req.body;

    // Validate request
    const validSections = ['core-values', 'growth-edge', 'convictions', 'open-questions', 'integrations', 'evolution-history'];
    const validOps = ['replace', 'append', 'remove'];
    const validSources = ['reflect-skill', 'evolution-job', 'inline', 'threadline'];

    if (!section || !validSections.includes(section)) {
      return res.status(400).json({ error: `Invalid section. Must be one of: ${validSections.join(', ')}` });
    }
    if (!operation || !validOps.includes(operation)) {
      return res.status(400).json({ error: `Invalid operation. Must be one of: ${validOps.join(', ')}` });
    }
    if (typeof content !== 'string' || content.length === 0) {
      return res.status(400).json({ error: 'Content must be a non-empty string' });
    }
    if (content.length > 10000) {
      return res.status(400).json({ error: 'Content exceeds maximum length (10000 chars)' });
    }
    if (!source || !validSources.includes(source)) {
      return res.status(400).json({ error: `Invalid source. Must be one of: ${validSources.join(', ')}` });
    }

    // Get current trust level
    const trustLevel = ctx.autonomyManager?.getProfile() ?? 'supervised';

    try {
      const result = ctx.soulManager.patch(
        { section, operation, content, source },
        trustLevel,
      );
      const statusCode = result.status === 'pending' ? 202 : 200;
      res.status(statusCode).json(result);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const soulErr = err as { code: string; message: string; details?: Record<string, unknown> };
        if (soulErr.code === 'trust_violation') {
          return res.status(403).json({
            error: 'trust_violation',
            message: soulErr.message,
            ...soulErr.details,
          });
        }
        if (soulErr.code === 'conflict') {
          return res.status(409).json({ error: 'conflict', message: soulErr.message });
        }
      }
      return res.status(500).json({ error: 'Failed to update soul.md' });
    }
  });

  // GET /identity/soul/pending — list pending soul.md changes
  router.get('/identity/soul/pending', (_req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    const pending = ctx.soulManager.getPending('pending');
    res.json({ pending, count: pending.length });
  });

  // POST /identity/soul/pending/:id/approve — approve a pending change
  router.post('/identity/soul/pending/:id/approve', (req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    try {
      const result = ctx.soulManager.approvePending(req.params.id);
      res.json(result);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const soulErr = err as { code: string; message: string };
        if (soulErr.code === 'not_found') {
          return res.status(404).json({ error: soulErr.message });
        }
        if (soulErr.code === 'invalid_state') {
          return res.status(400).json({ error: soulErr.message });
        }
      }
      return res.status(500).json({ error: 'Failed to approve pending change' });
    }
  });

  // POST /identity/soul/pending/:id/reject — reject a pending change
  router.post('/identity/soul/pending/:id/reject', (req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    try {
      ctx.soulManager.rejectPending(req.params.id, req.body?.reason);
      res.json({ ok: true, id: req.params.id, status: 'rejected' });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const soulErr = err as { code: string; message: string };
        if (soulErr.code === 'not_found') {
          return res.status(404).json({ error: soulErr.message });
        }
      }
      return res.status(500).json({ error: 'Failed to reject pending change' });
    }
  });

  // GET /identity/soul/drift — drift analysis
  router.get('/identity/soul/drift', (_req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    res.json(ctx.soulManager.analyzeDrift());
  });

  // GET /identity/soul/integrity — integrity check
  router.get('/identity/soul/integrity', (_req, res) => {
    if (!ctx.soulManager) {
      return res.status(404).json({ error: 'soul.md is not enabled' });
    }
    res.json(ctx.soulManager.verifyIntegrity());
  });

  // ── Memory Monitoring ──────────────────────────────────────────────

  // GET /monitoring/memory — current memory state and thresholds
  router.get('/monitoring/memory', (req, res) => {
    if (!ctx.memoryMonitor) {
      return res.status(404).json({ error: 'MemoryPressureMonitor not configured' });
    }
    res.json({
      ...ctx.memoryMonitor.getState(),
      thresholds: ctx.memoryMonitor.getThresholds(),
    });
  });

  // ── Orphan Process Reaper ──────────────────────────────────────────

  // GET /monitoring/processes — scan for all Claude processes and classify them
  router.get('/monitoring/processes', async (_req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const report = await ctx.orphanReaper.scan();
    res.json(report);
  });

  // GET /monitoring/processes/last — get last scan report without re-scanning
  router.get('/monitoring/processes/last', (_req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const report = ctx.orphanReaper.getLastReport();
    if (!report) {
      return res.json({ message: 'No scan has been performed yet' });
    }
    res.json(report);
  });

  // POST /monitoring/processes/kill — kill a specific external process by PID (user-initiated)
  router.post('/monitoring/processes/kill', (req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const { pid } = req.body;
    if (typeof pid !== 'number') {
      return res.status(400).json({ error: 'pid (number) required' });
    }
    const result = ctx.orphanReaper.killExternalProcess(pid);
    res.json(result);
  });

  // POST /monitoring/processes/kill-all-external — kill all external Claude processes (user-initiated)
  router.post('/monitoring/processes/kill-all-external', (_req, res) => {
    if (!ctx.orphanReaper) {
      return res.status(404).json({ error: 'OrphanProcessReaper not configured' });
    }
    const result = ctx.orphanReaper.killAllExternal();
    res.json(result);
  });

  // PATCH /monitoring/memory/thresholds — update memory warning thresholds at runtime
  router.patch('/monitoring/memory/thresholds', (req, res) => {
    if (!ctx.memoryMonitor) {
      return res.status(404).json({ error: 'MemoryPressureMonitor not configured' });
    }
    const { warning, elevated, critical } = req.body;
    const update: Partial<{ warning: number; elevated: number; critical: number }> = {};

    if (warning !== undefined) {
      if (typeof warning !== 'number' || warning < 0 || warning > 100) {
        return res.status(400).json({ error: 'warning must be a number between 0 and 100' });
      }
      update.warning = warning;
    }
    if (elevated !== undefined) {
      if (typeof elevated !== 'number' || elevated < 0 || elevated > 100) {
        return res.status(400).json({ error: 'elevated must be a number between 0 and 100' });
      }
      update.elevated = elevated;
    }
    if (critical !== undefined) {
      if (typeof critical !== 'number' || critical < 0 || critical > 100) {
        return res.status(400).json({ error: 'critical must be a number between 0 and 100' });
      }
      update.critical = critical;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'At least one threshold (warning, elevated, critical) must be provided' });
    }

    ctx.memoryMonitor.updateThresholds(update);
    res.json({
      updated: true,
      thresholds: ctx.memoryMonitor.getThresholds(),
      currentState: ctx.memoryMonitor.getState(),
    });
  });

  // ── Telemetry ──────────────────────────────────────────────────────

  // GET /monitoring/telemetry — telemetry heartbeat status and counters
  router.get('/monitoring/telemetry', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ enabled: false, message: 'Telemetry not configured. Enable via POST /config/telemetry {"enabled": true}' });
    }
    res.json(ctx.telemetryHeartbeat.getStatus());
  });

  // PATCH /config — generic config patcher used by FeatureDefinitions enableAction/disableAction.
  // Deep-merges the request body into config.json and updates runtime ctx.config.
  router.patch('/config', (req, res) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }

    // Allowlist of top-level config keys that can be patched via API.
    // Prevents callers from overwriting auth tokens, project paths, etc.
    // Single source of truth (module-scope export) so the enableAction-validity
    // test stays in lock-step with what the API actually accepts.
    const allowedKeys = PATCHABLE_CONFIG_KEYS;

    const disallowed = Object.keys(patch).filter(k => !allowedKeys.has(k));
    if (disallowed.length > 0) {
      res.status(400).json({
        error: `Cannot patch these config keys via API: ${disallowed.join(', ')}`,
        allowed: [...allowedKeys],
      });
      return;
    }

    try {
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }

      // Deep merge (one level deep — sufficient for feature toggles)
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
            typeof fileConfig[key] === 'object' && fileConfig[key] !== null) {
          fileConfig[key] = { ...fileConfig[key], ...value };
        } else {
          fileConfig[key] = value;
        }
        // Also update runtime config
        if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
            typeof (ctx.config as any)[key] === 'object' && (ctx.config as any)[key] !== null) {
          (ctx.config as any)[key] = { ...(ctx.config as any)[key], ...value };
        } else {
          (ctx.config as any)[key] = value;
        }
      }

      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      res.json({
        success: true,
        patched: Object.keys(patch),
        note: 'Some changes may require a server restart to take full effect.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to patch config: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // POST /config/telemetry — enable/disable telemetry (used by agent after asking user)
  // Also dismisses the session-start nudge by writing a marker file.
  router.post('/config/telemetry', (req, res) => {
    const { enabled, level } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (level !== undefined && level !== 'basic' && level !== 'usage') {
      return res.status(400).json({ error: 'level must be "basic" or "usage"' });
    }

    try {
      // Update config.json
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      if (!fileConfig.monitoring) fileConfig.monitoring = {};
      fileConfig.monitoring.telemetry = {
        enabled,
        level: level || 'basic',
      };
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      // Write the nudge-shown marker so the session-start hook stops showing it
      const nudgeFile = path.join(ctx.config.stateDir, '.telemetry-nudge-shown');
      fs.writeFileSync(nudgeFile, JSON.stringify({
        decided: enabled ? 'opted-in' : 'declined',
        level: level || 'basic',
        at: new Date().toISOString(),
      }) + '\n');

      res.json({
        success: true,
        telemetry: { enabled, level: level || 'basic' },
        message: enabled
          ? 'Telemetry enabled. Anonymous heartbeats will start on next server restart.'
          : 'Telemetry declined. No data will be sent. Thank you for considering it.',
        note: 'Restart the server for changes to take effect.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${err instanceof Error ? err.message : err}` });
    }
  });

  // ── Baseline Telemetry ─────────────────────────────────────────────

  // GET /telemetry/status — Baseline telemetry status
  router.get('/telemetry/status', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ enabled: false, baseline: { provisioned: false } });
    }
    const status = ctx.telemetryHeartbeat.getStatus();
    res.json({
      enabled: status.enabled,
      baseline: status.baseline,
    });
  });

  // GET /telemetry/submissions — List Baseline submission transparency log
  router.get('/telemetry/submissions', (req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ submissions: [] });
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const submissions = ctx.telemetryHeartbeat.getBaselineSubmissions(limit, offset);
    res.json({ submissions, count: submissions.length });
  });

  // GET /telemetry/submissions/latest — Most recent Baseline submission payload
  router.get('/telemetry/submissions/latest', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.json({ submission: null });
    }
    const latest = ctx.telemetryHeartbeat.getLatestBaselineSubmission();
    res.json({ submission: latest });
  });

  // POST /telemetry/enable — Enable Baseline telemetry (called by CLI/dashboard)
  // Human-gated: CLI shows consent disclosure, dashboard shows modal — this endpoint
  // is the programmatic backend, NOT an agent-accessible API.
  router.post('/telemetry/enable', (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.status(503).json({ error: 'Telemetry subsystem not initialized' });
    }

    try {
      const auth = ctx.telemetryHeartbeat.getAuth();
      const { installationId, created } = auth.provision();

      // Update config.json
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      if (!fileConfig.monitoring) fileConfig.monitoring = {};
      if (!fileConfig.monitoring.telemetry) fileConfig.monitoring.telemetry = {};
      fileConfig.monitoring.telemetry.enabled = true;
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      res.json({
        success: true,
        installationId: installationId.slice(0, 8) + '...',
        created,
        message: 'Baseline telemetry enabled. Submissions will start within the next 6 hours.',
        note: 'Restart the server for the submission cycle to begin.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to enable telemetry: ${err instanceof Error ? err.message : err}` });
    }
  });

  // POST /telemetry/disable — Disable Baseline telemetry and delete identity
  router.post('/telemetry/disable', async (_req, res) => {
    if (!ctx.telemetryHeartbeat) {
      return res.status(503).json({ error: 'Telemetry subsystem not initialized' });
    }

    try {
      const auth = ctx.telemetryHeartbeat.getAuth();
      const installationId = auth.getInstallationId();

      // Attempt remote deletion if provisioned
      let remoteDeletion = 'not_attempted';
      if (installationId) {
        try {
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const deletePayload = Buffer.from(JSON.stringify({ installationId }));
          const signature = auth.sign(installationId, timestamp, deletePayload);

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          const deleteHeaders: Record<string, string> = {
            'X-Instar-Signature': `hmac-sha256=${signature}`,
            'X-Instar-Timestamp': timestamp,
          };
          const fingerprint = auth.getKeyFingerprint();
          if (fingerprint) {
            deleteHeaders['X-Instar-Key-Fingerprint'] = fingerprint;
          }

          const resp = await fetch(`https://instar-telemetry.sagemind-ai.workers.dev/v1/telemetry/${installationId}`, {
            method: 'DELETE',
            headers: deleteHeaders,
            signal: controller.signal,
          });

          clearTimeout(timeout);
          remoteDeletion = resp.ok ? 'success' : `failed_${resp.status}`;
        } catch {
          remoteDeletion = 'network_error';
          // Write pending-deletion for retry on next startup
          try {
            const pendingPath = path.join(ctx.config.stateDir, 'telemetry', 'pending-deletion.json');
            fs.writeFileSync(pendingPath, JSON.stringify({
              installationId,
              timestamp: new Date().toISOString(),
              retryCount: 0,
            }) + '\n');
          } catch { /* best-effort */ }
        }
      }

      // Delete local identity files
      auth.deprovision();

      // Clear submissions log
      const submissionsLog = path.join(ctx.config.stateDir, 'telemetry', 'submissions.jsonl');
      try { SafeFsExecutor.safeUnlinkSync(submissionsLog, { operation: 'src/server/routes.ts:8932' }); } catch { /* may not exist */ }

      // Update config.json
      const configPath = path.join(ctx.config.projectDir, '.instar', 'config.json');
      let fileConfig: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
      if (!fileConfig.monitoring) fileConfig.monitoring = {};
      if (!fileConfig.monitoring.telemetry) fileConfig.monitoring.telemetry = {};
      fileConfig.monitoring.telemetry.enabled = false;
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');

      res.json({
        success: true,
        remoteDeletion,
        message: 'Baseline telemetry disabled. Local identity deleted. Re-enabling will create a new identity.',
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to disable telemetry: ${err instanceof Error ? err.message : err}` });
    }
  });

  // ── Commitment Tracking ──────────────────────────────────────────
  // Note: Specific routes (context, verify) MUST come before :id param routes.

  /**
   * Get all commitments with optional status filter.
   */
  router.get('/commitments', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.json({ enabled: false, commitments: [] });
      return;
    }
    const status = req.query.status as string | undefined;
    if (status === 'active') {
      res.json({ enabled: true, commitments: ctx.commitmentTracker.getActive() });
    } else {
      res.json({ enabled: true, commitments: ctx.commitmentTracker.getAll() });
    }
  });

  /**
   * Get behavioral context for session injection.
   */
  router.get('/commitments/context', (_req, res) => {
    if (!ctx.commitmentTracker) {
      res.json({ enabled: false, context: '' });
      return;
    }
    res.json({
      enabled: true,
      context: ctx.commitmentTracker.getBehavioralContext(),
      health: ctx.commitmentTracker.getHealth(),
    });
  });

  /**
   * GET /commitments/active-context
   * Returns the `<active_commitments>` snippet for session-start injection
   * (spec Round 3 #7). Capped at 20 entries with a "+N more" footer.
   * MUST be registered before `/commitments/:id` or Express will route the
   * literal `active-context` to the :id handler.
   */
  router.get('/commitments/active-context', (_req, res) => {
    if (!ctx.commitmentTracker) {
      res.json({ enabled: false, snippet: '' });
      return;
    }
    const all = ctx.commitmentTracker.getActive()
      .filter(c => c.status === 'pending' && c.beaconEnabled);
    const cap = 20;
    const shown = all.slice(0, cap).map(c => ({
      id: c.id,
      promiseText: (c.agentResponse || c.userRequest).slice(0, 120),
      nextUpdateDueAt: c.nextUpdateDueAt ?? null,
      atRisk: !!c.atRisk,
    }));
    const more = Math.max(0, all.length - cap);
    let snippet = '';
    if (shown.length > 0) {
      const body = JSON.stringify(shown);
      snippet = `<active_commitments>\n${body}${more > 0 ? `\n+ ${more} more` : ''}\n</active_commitments>`;
    }
    res.json({ enabled: true, snippet, total: all.length, shown: shown.length });
  });

  /**
   * Get a single commitment by ID.
   */
  router.get('/commitments/:id', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const commitment = ctx.commitmentTracker.get(req.params.id);
    if (!commitment) {
      res.status(404).json({ error: `Commitment ${req.params.id} not found` });
      return;
    }
    res.json(commitment);
  });

  /**
   * Record a new commitment.
   */
  router.post('/commitments', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const { type, userRequest, agentResponse, topicId, source,
            configPath, configExpectedValue, behavioralRule,
            expiresAt, verificationMethod, verificationPath,
            // Promise Beacon fields (PROMISE-BEACON-SPEC.md Phase 1)
            beaconEnabled, cadenceMs, nextUpdateDueAt,
            softDeadlineAt, hardDeadlineAt, sessionEpoch,
            ownerMachineId, externalKey, beaconCreatedBySource } = req.body;

    if (!type || !userRequest || !agentResponse) {
      res.status(400).json({ error: 'type, userRequest, and agentResponse are required' });
      return;
    }
    if (!['config-change', 'behavioral', 'one-time-action'].includes(type)) {
      res.status(400).json({ error: 'type must be config-change, behavioral, or one-time-action' });
      return;
    }
    // Beacon validation: must have topicId and at least one deadline marker.
    if (beaconEnabled) {
      if (!topicId) {
        res.status(400).json({ error: 'beaconEnabled commitments require topicId' });
        return;
      }
      if (!nextUpdateDueAt && !softDeadlineAt && !hardDeadlineAt) {
        res.status(400).json({
          error: 'beaconEnabled commitments require at least one of nextUpdateDueAt, softDeadlineAt, hardDeadlineAt',
        });
        return;
      }
    }

    try {
      const commitment = ctx.commitmentTracker.record({
        type, userRequest, agentResponse, topicId, source,
        configPath, configExpectedValue, behavioralRule,
        expiresAt, verificationMethod, verificationPath,
        beaconEnabled, cadenceMs, nextUpdateDueAt,
        softDeadlineAt, hardDeadlineAt, sessionEpoch,
        ownerMachineId, externalKey, beaconCreatedBySource,
      });
      res.status(201).json(commitment);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to record' });
    }
  });

  /**
   * PATCH /commitments/:id
   * Update mutable beacon fields on a pending commitment (spec Round 3 #2
   * follow-up). Routes through CommitmentTracker.mutate() so the single-writer
   * CAS invariant is preserved. Same validator shape as POST /commitments:
   * if the caller sets beaconEnabled=true they must have topicId and at least
   * one of nextUpdateDueAt/softDeadlineAt/hardDeadlineAt (effective fields,
   * i.e. new-or-existing).
   *
   * Terminal-status guard: PATCH on delivered/violated/expired/withdrawn
   * returns 409 (matches the `deliver` guard).
   */
  router.patch('/commitments/:id', async (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const existing = ctx.commitmentTracker.get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: `Commitment ${req.params.id} not found` });
      return;
    }
    if (['delivered', 'violated', 'expired', 'withdrawn'].includes(existing.status)) {
      res.status(409).json({ error: `Commitment ${req.params.id} is ${existing.status} (terminal); PATCH rejected` });
      return;
    }

    const { nextUpdateDueAt, softDeadlineAt, hardDeadlineAt, cadenceMs, beaconEnabled } = req.body ?? {};

    // Reject unknown keys to surface typos early.
    const allowed = new Set(['nextUpdateDueAt', 'softDeadlineAt', 'hardDeadlineAt', 'cadenceMs', 'beaconEnabled']);
    const unknown = Object.keys(req.body ?? {}).filter(k => !allowed.has(k));
    if (unknown.length > 0) {
      res.status(400).json({ error: `Unknown field(s): ${unknown.join(', ')}. Allowed: ${[...allowed].join(', ')}` });
      return;
    }

    // Type validation.
    const iso = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
    if (!iso(nextUpdateDueAt)) { res.status(400).json({ error: 'nextUpdateDueAt must be ISO 8601' }); return; }
    if (!iso(softDeadlineAt)) { res.status(400).json({ error: 'softDeadlineAt must be ISO 8601' }); return; }
    if (!iso(hardDeadlineAt)) { res.status(400).json({ error: 'hardDeadlineAt must be ISO 8601' }); return; }
    if (cadenceMs !== undefined && cadenceMs !== null && (typeof cadenceMs !== 'number' || cadenceMs <= 0)) {
      res.status(400).json({ error: 'cadenceMs must be a positive number' });
      return;
    }
    if (beaconEnabled !== undefined && typeof beaconEnabled !== 'boolean') {
      res.status(400).json({ error: 'beaconEnabled must be boolean' });
      return;
    }

    // Effective-field validation (matches POST creation validator).
    const effBeaconEnabled = beaconEnabled ?? existing.beaconEnabled;
    if (effBeaconEnabled) {
      if (!existing.topicId) {
        res.status(400).json({ error: 'beaconEnabled commitments require topicId (cannot be added via PATCH)' });
        return;
      }
      // Treat an explicit-present key (even `null`) as an overwrite, so the
      // caller can clear a field. Fall back to `existing` only when the key
      // was omitted from the body entirely.
      const body = req.body ?? {};
      const effNextUpdate = 'nextUpdateDueAt' in body ? nextUpdateDueAt : existing.nextUpdateDueAt;
      const effSoft = 'softDeadlineAt' in body ? softDeadlineAt : existing.softDeadlineAt;
      const effHard = 'hardDeadlineAt' in body ? hardDeadlineAt : existing.hardDeadlineAt;
      if (!effNextUpdate && !effSoft && !effHard) {
        res.status(400).json({
          error: 'beaconEnabled commitments require at least one of nextUpdateDueAt, softDeadlineAt, hardDeadlineAt',
        });
        return;
      }
    }

    try {
      const updated = await ctx.commitmentTracker.mutate(req.params.id, prev => ({
        ...prev,
        ...(nextUpdateDueAt !== undefined ? { nextUpdateDueAt } : {}),
        ...(softDeadlineAt !== undefined ? { softDeadlineAt } : {}),
        ...(hardDeadlineAt !== undefined ? { hardDeadlineAt } : {}),
        ...(cadenceMs !== undefined ? { cadenceMs } : {}),
        ...(beaconEnabled !== undefined ? { beaconEnabled } : {}),
      }));
      // Re-arm the beacon timer if the tracker is wired to a live beacon.
      try {
        const beacon = (globalThis as Record<string, unknown>).__instarPromiseBeacon as
          | { schedule: (c: typeof updated) => void; stopFor: (id: string) => void }
          | undefined;
        if (beacon && updated.beaconEnabled && updated.status === 'pending' && !updated.beaconSuppressed) {
          beacon.stopFor(updated.id);
          beacon.schedule(updated);
        }
      } catch { /* non-fatal */ }
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'mutate failed' });
    }
  });

  /**
   * Trigger verification of all active commitments.
   */
  router.post('/commitments/verify', (_req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const report = ctx.commitmentTracker.verify();
    res.json(report);
  });

  /**
   * Withdraw a commitment.
   */
  /**
   * POST /commitments/:id/deliver
   * Marks a beacon-enabled commitment as `delivered` (distinct from `verified`).
   * Stops the PromiseBeacon timer for this commitment. Per PROMISE-BEACON-SPEC.md
   * Round 3 #18: `delivered` is a terminal status meaning "the agent actually
   * came back with the promised update," separate from `verified` which means
   * "config state is as promised."
   */
  router.post('/commitments/:id/deliver', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const { deliveryMessageId } = req.body ?? {};
    const updated = ctx.commitmentTracker.deliver(req.params.id, deliveryMessageId);
    if (!updated) {
      res.status(404).json({ error: `Commitment ${req.params.id} not found or already in terminal status` });
      return;
    }
    res.json({ delivered: true, id: updated.id, commitment: updated });
  });

  router.post('/commitments/:id/withdraw', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const { reason } = req.body;
    if (!reason) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    const success = ctx.commitmentTracker.withdraw(req.params.id, reason);
    if (!success) {
      res.status(404).json({ error: `Commitment ${req.params.id} not found or already resolved` });
      return;
    }
    res.json({ withdrawn: true, id: req.params.id });
  });

  /**
   * POST /commitments/:id/resume
   * Resume a beacon that was auto-paused after a run of unchanged heartbeats.
   * Clears `beaconPaused` / `beaconPausedReason` / `beaconPausedAt` and resets
   * `consecutiveUnchanged`. PromiseBeacon re-arms the timer on the `resumed`
   * event. No-op (404) for commitments that aren't paused or are in a terminal
   * status.
   */
  router.post('/commitments/:id/resume', (req, res) => {
    if (!ctx.commitmentTracker) {
      res.status(404).json({ error: 'CommitmentTracker not configured' });
      return;
    }
    const updated = ctx.commitmentTracker.resume(req.params.id);
    if (!updated) {
      res.status(404).json({ error: `Commitment ${req.params.id} not found, not paused, or in terminal status` });
      return;
    }
    res.json({ resumed: true, id: updated.id, commitment: updated });
  });

  // ── Episodic Memory (Activity Sentinel) ──────────────────────────

  router.get('/episodes/stats', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    res.json(memory.stats());
  });

  router.get('/episodes/sessions', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    res.json(memory.listSyntheses(limit));
  });

  router.get('/episodes/sessions/:sessionId', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    const synthesis = memory.getSynthesis(req.params.sessionId);
    if (!synthesis) { res.status(404).json({ error: 'Session synthesis not found' }); return; }
    res.json(synthesis);
  });

  router.get('/episodes/sessions/:sessionId/activities', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    res.json(memory.getSessionActivities(req.params.sessionId));
  });

  router.get('/episodes/recent', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    const hours = req.query.hours ? parseInt(String(req.query.hours), 10) : 24;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 20;
    res.json(memory.getRecentActivity(hours, limit));
  });

  router.get('/episodes/themes/:theme', (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    const memory = ctx.activitySentinel.getEpisodicMemory();
    res.json(memory.getByTheme(req.params.theme));
  });

  router.post('/episodes/scan', async (req, res) => {
    if (!ctx.activitySentinel) { res.status(503).json({ error: 'Activity sentinel not enabled' }); return; }
    try {
      const report = await ctx.activitySentinel.scan();
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // ── Inter-Agent Messaging ──────────────────────────────────────

  const MSG_ID_RE = /^[a-f0-9-]{36}$/;

  router.post('/messages/send', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { from, to, type, priority, subject, body, options } = req.body;
      if (!from || !to || !type || !priority || !subject || !body) {
        res.status(400).json({ error: 'Missing required fields: from, to, type, priority, subject, body' });
        return;
      }
      const result = await ctx.messageRouter.send(
        from,
        to,
        type as MessageType,
        priority as MessagePriority,
        subject,
        body,
        options,
      );
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Send failed' });
    }
  });

  router.post('/messages/ack', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { messageId, sessionId } = req.body;
      if (!messageId || !sessionId) {
        res.status(400).json({ error: 'Missing required fields: messageId, sessionId' });
        return;
      }
      await ctx.messageRouter.acknowledge(messageId, sessionId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Ack failed' });
    }
  });

  router.post('/messages/relay-agent', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      // Verify bearer token — the sender must present our agent's token
      const authHeader = req.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!bearerToken || !verifyAgentToken(ctx.config.projectName, bearerToken)) {
        res.status(401).json({ error: 'Invalid or missing agent token' });
        return;
      }

      const envelope = req.body;
      if (!envelope?.message?.id) {
        res.status(400).json({ error: 'Invalid envelope' });
        return;
      }

      // Content-hash dedup (duplicate-reply fix): a sender that timed out on the
      // receiver's session spawn and retried with a FRESH message.id would
      // otherwise slip past the id-based relay dedup and cause a duplicate
      // spawn/reply. Recognize the retry by the stable (sender, thread, content)
      // triple within a short window and short-circuit idempotently (200, no
      // spawn) so the sender's retry still sees success.
      {
        const dSender = envelope.message?.from?.agent ?? 'unknown';
        const dThread = envelope.message?.threadId;
        const dBody = envelope.message?.body;
        const dText = typeof dBody === 'string'
          ? dBody
          : (typeof dBody === 'object' && dBody !== null
              ? String((dBody as Record<string, unknown>).content ?? (dBody as Record<string, unknown>).text ?? '')
              : '');
        if (dThread && dText && !relayContentDedup.shouldProcess(dSender, dThread, dText)) {
          console.log(`[relay-agent] Deduped retried message from ${dSender} (thread: ${dThread.slice(0, 8)}, id: ${envelope.message?.id ?? 'none'}) — identical content within window`);
          res.json({ ok: true, deduped: true });
          return;
        }
      }

      const accepted = await ctx.messageRouter.relay(envelope, 'agent');
      if (accepted) {
        const senderAgent = envelope.message?.from?.agent;
        console.log(`[relay-agent] Accepted message from ${senderAgent ?? 'unknown'} (thread: ${envelope.message?.threadId ?? 'none'}, id: ${envelope.message?.id ?? 'none'})`);

        // Check if this message resolves a pending waitForReply request.
        // Local delivery bypasses the relay client's gate-passed event, so we
        // must check reply waiters here directly.
        // PR-3: resolve waiter by threadId (unique) rather than sender
        // agent name (which may collide across multiple same-named agents).
        const inboundThreadId = envelope.message?.threadId;
        if (inboundThreadId && ctx.threadlineReplyWaiters.size > 0) {
          let textContent: string | undefined;
          const body = envelope.message?.body;
          if (typeof body === 'string') textContent = body;
          else if (typeof body === 'object' && body !== null) {
            textContent = String((body as Record<string, unknown>).content ?? (body as Record<string, unknown>).text ?? JSON.stringify(body));
          }
          if (textContent) {
            const isAutoAck = textContent.startsWith('Message received.') || textContent.startsWith('Message received,');
            const waiter = ctx.threadlineReplyWaiters.get(inboundThreadId);
            if (waiter && !isAutoAck) {
              console.log(`[relay-agent] Resolved reply waiter for thread ${inboundThreadId} (from ${senderAgent ?? 'unknown'})`);
              waiter.resolve(textContent);
            }
          }
        }

        // ThreadlineFlowBridge: resume any TaskFlow flow waiting on a
        // cross-agent-callback whose correlationId matches this inbound. The
        // bridge runs after relay-accept (auth has passed), inspects only the
        // envelope, and never alters the HTTP response — failures or misses
        // are logged but not surfaced.
        if (ctx.threadlineFlowBridge) {
          try {
            const bridgeResult = await ctx.threadlineFlowBridge.consumeInbound(envelope);
            if (bridgeResult.resumed) {
              console.log(`[relay-agent] ThreadlineFlowBridge resumed ${bridgeResult.flowIds.length} flow(s): ${bridgeResult.flowIds.join(', ')}`);
            }
          } catch (err) {
            if (err instanceof Error) console.error('[routes] ThreadlineFlowBridge error:', err.message);
          }
        }

        // Threadline Phase 1 keystone: the warrants-a-reply gate must cover the
        // LOCAL co-located inbound path too — this route delivers straight to
        // handleInboundMessage and bypasses the relay funnel's gate, so without
        // this a same-machine agent (the original echo↔codey loop) would never
        // be gated (caught in test-as-self). Run the gate ONCE here; on a
        // no-reply verdict, record the inbound on the Conversation and
        // short-circuit BEFORE spawning.
        if (ctx.conversationStore && ctx.warrantsReplyGate) {
          try {
            const gThreadId = envelope.message?.threadId;
            const body = envelope.message?.body;
            const gText = typeof body === 'string'
              ? body
              : (typeof body === 'object' && body !== null
                  ? String((body as Record<string, unknown>).content ?? (body as Record<string, unknown>).text ?? '')
                  : '');
            if (gThreadId && gText) {
              const senderAgentName = envelope.message?.from?.agent ?? 'unknown';
              const decision = await evaluateAndRecordInbound(ctx.warrantsReplyGate, ctx.conversationStore, {
                threadId: gThreadId,
                text: gText,
                senderFingerprint: senderAgentName,
                senderName: senderAgentName,
                trustLevel: 'verified',
                // Local agent↔agent delivery is autonomous; humanInLoop derived
                // only from our own records (never the peer), default false.
                humanInLoop: false,
              });
              if (decision.suppress) {
                console.log(`[relay-agent] warrants-reply gate suppressed reply (${decision.verdict.signal}) from ${senderAgentName} thread ${gThreadId.slice(0, 8)}`);
                res.json({ ok: true, threadline: { handled: true, threadId: gThreadId, spawned: false, suppressed: true, signal: decision.verdict.signal } });
                return;
              }
              // CMT-509 §2: warranted + parentless (no bound topic) → surface to
              // the dedicated Threadline topic (the incident was a co-located peer
              // delivering here). Topic-bound conversations surface via
              // TopicLinkageHandler. Best-effort, non-blocking.
              if (ctx.collaborationSurfacer) {
                const hasParentTopic = ctx.conversationStore.get(gThreadId)?.boundTopicId != null;
                void ctx.collaborationSurfacer.surface({
                  threadId: gThreadId,
                  senderName: senderAgentName,
                  text: gText,
                  hasParentTopic,
                  warrants: !decision.suppress,
                });
              }
            }
          } catch (gateErr) {
            // Fail toward responsive — never silently drop a local message.
            console.warn(`[relay-agent] warrants-reply gate error (defaulting responsive): ${gateErr instanceof Error ? gateErr.message : gateErr}`);
          }
        }

        // ACCEPT-BOUNDARY (duplicate-reply ROOT fix). The message is already
        // accepted into the inbox AND past the warrants-reply gate above, so we
        // respond NOW — an honest "accepted, processing async" — instead of
        // AWAITING handleInboundMessage. That await is a session spawn/resume
        // that routinely takes 9-30s, far longer than the sender's relay-fetch
        // timeout: MessageRouter.relay uses AbortSignal.timeout(5000) and only
        // reads response.ok (never the spawned/resumed fields). Past 5s the
        // sender treats delivery as failed and retries with a FRESH message.id
        // → a duplicate spawn/reply. The content-hash dedup (#573) is the
        // symptom backstop; responding at the accept boundary removes the ROOT.
        // The actual reply still flows back via the reply-waiter mechanism
        // (resolved above), decoupled from this HTTP response.
        if (ctx.threadlineRouter) {
          res.json({ ok: true, accepted: true, threadline: { accepted: true, async: true } });
          // Process asynchronously — the response is already sent.
          // handleInboundMessage is NOT dropped: it runs to completion in the
          // background; its outcome is logged (never surfaced to the closed
          // response), and a failure can't 500 a request that already returned.
          void ctx.threadlineRouter
            .handleInboundMessage(envelope)
            .then((threadlineResult) => {
              console.log(
                `[relay-agent] async handleInboundMessage complete (thread ${envelope.message?.threadId ?? 'none'}): ${JSON.stringify(threadlineResult)}`,
              );
            })
            .catch((err) => {
              console.error('[routes] ThreadlineRouter async handling error:', err);
            });
          return;
        }
        res.json({ ok: true });
      } else {
        res.status(409).json({ error: 'Relay rejected (loop or duplicate)' });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Relay failed' });
    }
  });

  // relay-machine endpoint is now in machineRoutes.ts (protected by Machine-HMAC auth)

  router.get('/messages/inbox', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const filter: MessageFilter = {};
      if (req.query.type) filter.type = req.query.type as MessageType;
      if (req.query.priority) filter.priority = req.query.priority as MessagePriority;
      if (req.query.unread === 'true') filter.unread = true;
      if (req.query.fromAgent) filter.fromAgent = req.query.fromAgent as string;
      if (req.query.threadId) filter.threadId = req.query.threadId as string;
      if (req.query.limit) filter.limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      if (req.query.offset) filter.offset = parseInt(req.query.offset as string, 10) || 0;
      const messages = await ctx.messageRouter.getInbox(ctx.config.projectName, filter);
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Inbox query failed' });
    }
  });

  router.get('/messages/outbox', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const filter: MessageFilter = {};
      if (req.query.type) filter.type = req.query.type as MessageType;
      if (req.query.priority) filter.priority = req.query.priority as MessagePriority;
      if (req.query.limit) filter.limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      if (req.query.offset) filter.offset = parseInt(req.query.offset as string, 10) || 0;
      const messages = await ctx.messageRouter.getOutbox(ctx.config.projectName, filter);
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Outbox query failed' });
    }
  });

  router.get('/messages/dead-letter', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const filter: MessageFilter = {};
      if (req.query.type) filter.type = req.query.type as MessageType;
      if (req.query.priority) filter.priority = req.query.priority as MessagePriority;
      if (req.query.limit) filter.limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
      if (req.query.offset) filter.offset = parseInt(req.query.offset as string, 10) || 0;
      const messages = await ctx.messageRouter.getDeadLetters(filter);
      res.json({ messages, count: messages.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Dead-letter query failed' });
    }
  });

  router.get('/messages/threads', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const status = req.query.status as string | undefined;
      const validStatuses = ['active', 'resolved', 'stale'];
      if (status && !validStatuses.includes(status)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        return;
      }
      const threads = await ctx.messageRouter.listThreads(status as any);
      res.json({ threads, count: threads.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Thread list failed' });
    }
  });

  router.get('/messages/thread/:threadId', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { threadId } = req.params;
      if (!MSG_ID_RE.test(threadId)) {
        res.status(400).json({ error: 'Invalid thread ID format' });
        return;
      }
      const result = await ctx.messageRouter.getThread(threadId);
      if (!result) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Thread query failed' });
    }
  });

  router.post('/messages/thread/:threadId/resolve', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const { threadId } = req.params;
      if (!MSG_ID_RE.test(threadId)) {
        res.status(400).json({ error: 'Invalid thread ID format' });
        return;
      }
      await ctx.messageRouter.resolveThread(threadId);
      res.json({ ok: true });
    } catch (err) {
      res.status(err instanceof Error && err.message.includes('not found') ? 404 : 500)
        .json({ error: err instanceof Error ? err.message : 'Thread resolve failed' });
    }
  });

  router.get('/messages/stats', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const stats = await ctx.messageRouter.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Stats failed' });
    }
  });

  /**
   * §4.4 commit 3: read the current runtime-tunable spawn-manager config.
   * Returns the resolved values (defaults filled in).
   */
  router.get('/messages/spawn/config', (_req, res) => {
    if (!ctx.spawnManager) {
      res.status(503).json({ error: 'Spawn manager not available' });
      return;
    }
    res.json(ctx.spawnManager.getRuntimeConfig());
  });

  /**
   * §4.4 commit 3: update runtime-tunable spawn-manager fields atomically.
   * Body: any subset of { cooldownMs, maxDrainsPerTick, maxEnvelopeBytes,
   * maxGlobalQueued, degradedMaxQueuedPerAgent }.
   *
   * Note: changing cooldownMs updates gate logic immediately, but the drain
   * tick interval is fixed at start(). The response indicates whether a
   * timer restart is needed; operators can trigger that with a separate call
   * (or just restart the server) if they need the new tick rate to take
   * effect.
   */
  router.patch('/messages/spawn/config', (req, res) => {
    if (!ctx.spawnManager) {
      res.status(503).json({ error: 'Spawn manager not available' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Reject unknown fields to avoid silent typos.
    const allowed = new Set(['cooldownMs', 'maxDrainsPerTick', 'maxEnvelopeBytes', 'maxGlobalQueued', 'degradedMaxQueuedPerAgent']);
    const unknownKeys = Object.keys(body).filter(k => !allowed.has(k));
    if (unknownKeys.length > 0) {
      res.status(400).json({ error: `Unknown fields: ${unknownKeys.join(', ')}` });
      return;
    }
    // Reject non-number values up-front so the manager only sees clean input.
    for (const k of Object.keys(body)) {
      if (typeof body[k] !== 'number') {
        res.status(400).json({ error: `Field ${k} must be a number` });
        return;
      }
    }
    const result = ctx.spawnManager.updateConfig(body as Parameters<typeof ctx.spawnManager.updateConfig>[0]);
    if (!result.applied) {
      res.status(400).json({ error: result.reason });
      return;
    }
    res.json({
      ok: true,
      tickIntervalChanged: result.tickIntervalChanged,
      tickIntervalNote: result.tickIntervalChanged
        ? 'New tick interval will take effect after the next dispose() + start() (e.g., server restart).'
        : undefined,
      current: ctx.spawnManager.getRuntimeConfig(),
    });
  });

  router.post('/messages/spawn-request', async (req, res) => {
    if (!ctx.spawnManager) {
      res.status(503).json({ error: 'Spawn requests not available' });
      return;
    }
    try {
      const { requester, target, reason, context, priority, suggestedModel, suggestedMaxDuration, pendingMessages } = req.body;
      if (!requester || !target || !reason || !priority) {
        res.status(400).json({ error: 'Missing required fields: requester, target, reason, priority' });
        return;
      }
      const result = await ctx.spawnManager.evaluate({
        requester, target, reason, context, priority,
        suggestedModel, suggestedMaxDuration, pendingMessages,
      });
      if (!result.approved) {
        ctx.spawnManager.handleDenial(
          { requester, target, reason, context, priority, suggestedModel, suggestedMaxDuration, pendingMessages },
          result,
        );
      }
      res.status(result.approved ? 201 : 429).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Spawn request failed' });
    }
  });

  router.get('/messages/summaries', async (req, res) => {
    if (!ctx.summarySentinel) {
      res.status(503).json({ error: 'Session summaries not available' });
      return;
    }
    try {
      const summaries = ctx.summarySentinel.getAllSummaries();
      const status = ctx.summarySentinel.getStatus();
      res.json({ summaries, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Summaries failed' });
    }
  });

  router.get('/messages/route-score', async (req, res) => {
    if (!ctx.summarySentinel) {
      res.status(503).json({ error: 'Session summaries not available' });
      return;
    }
    try {
      const { subject, body } = req.query;
      if (!subject || !body) {
        res.status(400).json({ error: 'Missing required query params: subject, body' });
        return;
      }
      const scores = ctx.summarySentinel.findBestSession(
        subject as string,
        body as string,
        ctx.config.projectName,
      );
      res.json({ scores, inFallback: ctx.summarySentinel.isInFallbackMode() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Route scoring failed' });
    }
  });

  // ── Outbound Queue Status (Phase 4: Cross-Machine) ──────────

  router.get('/messages/outbound', async (_req, res) => {
    try {
      const status = getOutboundQueueStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Outbound status failed' });
    }
  });

  router.delete('/messages/outbound/:machineId/:messageId', async (req, res) => {
    try {
      const { machineId, messageId } = req.params;
      if (!machineId || !messageId) {
        res.status(400).json({ error: 'Missing machineId or messageId' });
        return;
      }
      const cleaned = cleanupDeliveredOutbound(machineId, messageId);
      res.json({ cleaned });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Outbound cleanup failed' });
    }
  });

  // ── Agent Discovery (Phase 4: Cross-Machine) ──────────────

  router.get('/messages/agents', async (_req, res) => {
    try {
      const agents = buildAgentList();
      res.json({ agents, machine: ctx.config.projectName });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Agent list failed' });
    }
  });

  // IMPORTANT: /:id must be LAST among /messages/* routes to avoid
  // catching named paths like /messages/stats, /messages/inbox, etc.
  router.get('/messages/:id', async (req, res) => {
    if (!ctx.messageRouter) {
      res.status(503).json({ error: 'Messaging not available' });
      return;
    }
    try {
      const messageId = req.params.id;
      if (!MSG_ID_RE.test(messageId)) {
        res.status(400).json({ error: 'Invalid message ID format' });
        return;
      }
      const envelope = await ctx.messageRouter.getMessage(messageId);
      if (!envelope) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      res.json(envelope);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Message query failed' });
    }
  });

  // ── System Reviews ────────────────────────────────────────────────

  router.post('/system-reviews', async (req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    try {
      const { tier, tiers, probeId, probeIds, dryRun } = req.body || {};
      const report = await ctx.systemReviewer.review({
        tiers: tiers ?? (tier != null ? [Number(tier)] : undefined),
        probeIds: probeIds ?? (probeId ? [probeId] : undefined),
        dryRun: dryRun === true,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Review failed' });
    }
  });

  // Alias for discoverability: agents commonly look for /health/probes or /system-review
  router.get('/health/probes', (_req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const latest = ctx.systemReviewer.getLatest();
    if (!latest) {
      res.json({ message: 'No reviews yet', probes: [] });
      return;
    }
    res.json({
      timestamp: latest.timestamp,
      status: latest.status,
      stats: latest.stats,
      probes: latest.results,
      skipped: latest.skipped,
    });
  });

  router.get('/system-review', (_req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const latest = ctx.systemReviewer.getLatest();
    res.json(latest ?? { message: 'No reviews yet' });
  });

  router.get('/system-reviews/latest', (_req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const latest = ctx.systemReviewer.getLatest();
    res.json(latest ?? { message: 'No reviews yet' });
  });

  router.get('/system-reviews/history', (req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const history = ctx.systemReviewer.getHistory(limit);
    res.json({ count: history.length, reports: history });
  });

  router.get('/system-reviews/trend', (_req, res) => {
    if (!ctx.systemReviewer) {
      res.status(503).json({ error: 'SystemReviewer not available' });
      return;
    }
    const trend = ctx.systemReviewer.getTrend();
    res.json(trend);
  });

  // ── Threadline Protocol ──────────────────────────────────────────

  if (ctx.handshakeManager) {
    const threadlineRoutes = createThreadlineRoutes(
      ctx.handshakeManager,
      ctx.threadlineRouter,
      {
        localAgent: ctx.config.projectName,
        version: '1.0',
        stateDir: ctx.config.stateDir,
      },
    );
    router.use(threadlineRoutes);
  }

  // ── Listener Daemon Health/Metrics ────────────────────────────────

  router.get('/listener/health', (req, res) => {
    // Auth required (tunnel exposes these endpoints)
    if (ctx.config.authToken) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || header.slice(7) !== ctx.config.authToken) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const healthPath = path.join(ctx.config.stateDir, 'listener-health.json');
    if (!fs.existsSync(healthPath)) {
      return res.json({
        status: 'not-running',
        message: 'No listener daemon health file found. Start with: instar listener start',
      });
    }

    try {
      const health = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
      // Add snapshotAge
      const healthMtime = fs.statSync(healthPath).mtimeMs;
      health.snapshotAge = Math.floor((Date.now() - healthMtime) / 1000);
      return res.json(health);
    } catch {
      return res.status(500).json({ error: 'Failed to read health file' });
    }
  });

  router.get('/listener/metrics', (req, res) => {
    if (ctx.config.authToken) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || header.slice(7) !== ctx.config.authToken) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const healthPath = path.join(ctx.config.stateDir, 'listener-health.json');
    let daemon: Record<string, unknown> = { state: 'not-running' };
    if (fs.existsSync(healthPath)) {
      try {
        daemon = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
        const healthMtime = fs.statSync(healthPath).mtimeMs;
        daemon.snapshotAge = Math.floor((Date.now() - healthMtime) / 1000);
      } catch {
        // Use default
      }
    }

    // Check if daemon socket is connected
    const socketPath = path.join(ctx.config.stateDir, 'listener.sock');
    const socketConnected = fs.existsSync(socketPath);

    // Inbox stats
    const inboxPath = path.join(ctx.config.stateDir, 'threadline', 'inbox.jsonl.active');
    let inboxSizeBytes = 0;
    if (fs.existsSync(inboxPath)) {
      try {
        inboxSizeBytes = fs.statSync(inboxPath).size;
      } catch {
        // Ignore
      }
    }

    return res.json({
      daemon,
      socket: { connected: socketConnected, path: socketPath },
      inbox: { sizeBytes: inboxSizeBytes, path: inboxPath },
    });
  });

  router.post('/listener/restart', (req, res) => {
    if (ctx.config.authToken) {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ') || header.slice(7) !== ctx.config.authToken) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // Signal daemon via PID file
    const pidPath = path.join(ctx.config.stateDir, 'listener-daemon.pid');
    if (!fs.existsSync(pidPath)) {
      return res.status(404).json({ error: 'No listener daemon PID file found' });
    }

    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      return res.json({ status: 'restart-signal-sent', pid });
    } catch (err) {
      return res.status(500).json({ error: `Failed to signal daemon: ${err}` });
    }
  });

  // ── MoltBridge Integration ──────────────────────────────────────────

  if (ctx.unifiedTrust?.moltbridge) {
    Promise.all([
      import('../moltbridge/routes.js'),
      import('../moltbridge/ProfileCompiler.js'),
    ]).then(([{ createMoltBridgeRoutes }, { ProfileCompiler }]) => {
      const profileCompiler = new ProfileCompiler({
        stateDir: ctx.config.stateDir,
        projectRoot: path.resolve(ctx.config.stateDir, '..'),
        capabilities: (ctx.config as any).moltbridge?.capabilities ?? [],
        jobNames: Object.keys((ctx.config as any).jobs ?? {}),
      });
      router.use(createMoltBridgeRoutes({
        client: ctx.unifiedTrust!.moltbridge!,
        identity: ctx.unifiedTrust!.identity,
        profileCompiler,
      }));
    }).catch(err => {
      console.error(`MoltBridge routes failed to mount: ${err instanceof Error ? err.message : err}`);
    });
  }

  // ── Threadline Status (auth-gated) ──────────────────────────────────
  router.get('/threadline/status', (_req, res) => {
    const relayClient = ctx.threadlineRelayClient;
    const connected = relayClient?.connectionState === 'connected';
    const listenerState = ctx.listenerManager?.getState() ?? { active: false, state: 'not-configured', messagesHandled: 0, queueDepth: 0, rotationId: '', rotationStartedAt: '' };

    res.json({
      ready: connected,
      relay: {
        connected,
        fingerprint: relayClient?.fingerprint ?? null,
        url: ctx.config.threadline?.relayUrl ?? DEFAULT_RELAY_URL,
        visibility: ctx.config.threadline?.visibility ?? 'unlisted',
      },
      listener: listenerState,
      config: {
        relayEnabled: ctx.config.threadline?.relayEnabled ?? false,
        autoAck: ctx.config.threadline?.autoAck ?? true,
        firstContactPolicy: ctx.config.threadline?.firstContactPolicy ?? 'auto',
      },
    });
  });

  // ── Threadline Reply Waiter ─────────────────────────────────────────
  // Waits for an incoming reply from a specific agent on a specific thread.
  // Used by the relay-send endpoint when waitForReply is true.

  function waitForThreadlineReply(
    routeCtx: RouteContext,
    senderAgent: string,
    threadId: string,
    timeoutSec?: number,
  ): Promise<string | null> {
    const timeout = Math.min(Math.max(timeoutSec ?? 120, 5), 300) * 1000; // 5s–300s, default 120s

    // PR-3: Waiters are keyed by threadId (unique per conversation) rather
    // than sender agent name (which can collide when multiple agents share
    // a name — e.g., two "luna" agents on different machines).
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        routeCtx.threadlineReplyWaiters.delete(threadId);
        resolve(null);
      }, timeout);

      routeCtx.threadlineReplyWaiters.set(threadId, {
        resolve: (reply: string) => {
          clearTimeout(timer);
          routeCtx.threadlineReplyWaiters.delete(threadId);
          resolve(reply);
        },
        threadId,
        senderAgent,
        timer,
      });
    });
  }

  // ── Threadline Relay Send ────────────────────────────────────────────
  // Used by the MCP server's threadline_send tool to route messages through
  // the relay WebSocket. Tries local delivery first for co-located agents,
  // then falls back to the relay. The MCP server runs as a stdio child
  // process and can't access the relay client directly, so it calls this
  // HTTP endpoint.

  router.post('/threadline/relay-send', async (req, res) => {
    const relayClient = ctx.threadlineRelayClient;
    const {
      targetAgent,
      message,
      threadId,
      waitForReply,
      timeoutSeconds,
      originTopicId,
      originSessionName,
      purpose,
      priority,
    } = req.body;

    if (!targetAgent || !message) {
      res.status(400).json({ success: false, error: 'Missing required fields: targetAgent, message' });
      return;
    }

    // Caller-supplied priority — accept ['critical','high','medium','low'].
    // Default to 'medium' when omitted. Reject any unknown string so caller
    // gets a clear 400 rather than silently downgraded delivery. The local
    // envelope used to hardcode 'medium', which made critical coordination
    // traffic indistinguishable from routine sends and starved the spawn
    // override policy in SpawnRequestManager.
    const ALLOWED_PRIORITIES: ReadonlyArray<MessagePriority> = ['critical', 'high', 'medium', 'low'];
    let resolvedPriority: MessagePriority = 'medium';
    if (priority !== undefined && priority !== null) {
      if (typeof priority !== 'string' || !(ALLOWED_PRIORITIES as readonly string[]).includes(priority)) {
        res.status(400).json({
          success: false,
          error: `Invalid priority "${String(priority)}". Allowed: ${ALLOWED_PRIORITIES.join(', ')}.`,
        });
        return;
      }
      resolvedPriority = priority as MessagePriority;
    }

    // THREAD-TOPIC-LINKAGE-SPEC.md: validate the optional originTopicId early.
    // We accept either number or numeric string; ignore on type mismatch (the
    // send still goes through, just without topic linkage).
    let resolvedOriginTopicId: number | undefined;
    if (originTopicId !== undefined && originTopicId !== null) {
      const asNum = typeof originTopicId === 'number' ? originTopicId : Number(originTopicId);
      if (Number.isFinite(asNum) && Number.isInteger(asNum) && asNum > 0) {
        resolvedOriginTopicId = asNum;
      }
    }
    // Threadline Phase 1 structural binding: when the caller did NOT stamp an
    // originTopicId by hand, resolve the origin session name (forwarded from the
    // spawn-boundary INSTAR_SESSION_NAME env) to its owning topic. This captures
    // the conversation↔topic binding without any caller discipline — the fix for
    // fragmentation (THREADLINE-CONVERSATION-KEYSTONE-SPEC §2). Never trusted
    // from a remote peer: originSessionName only ever comes from THIS agent's own
    // co-located MCP process env, on its own outbound send.
    if (resolvedOriginTopicId === undefined && typeof originSessionName === 'string' && originSessionName.trim()) {
      try {
        const topicId = ctx.telegram?.getTopicForSession?.(originSessionName.trim());
        if (typeof topicId === 'number' && Number.isInteger(topicId) && topicId > 0) {
          resolvedOriginTopicId = topicId;
        }
      } catch {
        // Best-effort — send still proceeds, just without auto-bound linkage.
      }
    }
    const resolvedPurpose = typeof purpose === 'string' && purpose.trim().length > 0
      ? purpose.trim().slice(0, 1024)
      : undefined;

    /**
     * Outbound origin capture (spec §5.2). Idempotent: handler returns the
     * existing commitment when one already exists for this threadId, so 4
     * call-sites below are safe.
     */
    const captureOrigin = async (effThreadId: string, remoteAgentDisplay: string): Promise<void> => {
      if (!ctx.topicLinkageHandler) return;
      if (!resolvedOriginTopicId) return;
      try {
        ctx.topicLinkageHandler.captureOriginOnSend({
          threadId: effThreadId,
          remoteAgent: remoteAgentDisplay,
          remoteAgentDisplayName: remoteAgentDisplay,
          originTopicId: resolvedOriginTopicId,
          purpose: resolvedPurpose,
          subject: 'Threadline conversation',
        });
      } catch (err) {
        console.warn(
          `[relay-send] captureOrigin failed for thread ${effThreadId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    // Validate message size (64KB limit matching inbound)
    if (Buffer.byteLength(message, 'utf-8') > 64 * 1024) {
      res.status(413).json({ success: false, error: 'Message too large (64KB limit)' });
      return;
    }

    // Nickname-first resolution. User-curated names in nicknames.json are the
    // highest-authority mapping (signal-vs-authority: relay discovery is signal,
    // user nickname is authority). If "Dawn" maps to fingerprint X here, we
    // route to X regardless of what the relay's discovery cache says about
    // some other agent that also calls itself "Dawn". Skip when caller used
    // a "name:fpPrefix" qualifier (they're explicitly disambiguating) or
    // when the input already looks like a fingerprint.
    let nicknameResolvedFp: string | null = null;
    const looksLikeFingerprint = /^[0-9a-f]{16,64}$/i.test(targetAgent);
    // Parse "name:fpPrefix" once so both branches below can reuse it.
    const fpPrefixParse = (() => {
      const ci = targetAgent.lastIndexOf(':');
      if (ci <= 0 || ci >= targetAgent.length - 1) return null;
      const suffix = targetAgent.substring(ci + 1);
      if (!/^[0-9a-f]{4,32}$/i.test(suffix)) return null;
      return { name: targetAgent.substring(0, ci), fpPrefix: suffix.toLowerCase() };
    })();
    const usesFpPrefixSyntax = fpPrefixParse !== null;
    if (!looksLikeFingerprint) {
      try {
        const nicknameStore = new ThreadlineNicknames({ stateDir: ctx.config.stateDir });
        // For "name:fpPrefix" inputs, look up the bare name in the nickname
        // store and filter the candidates by the prefix. This lets the user
        // disambiguate ambiguous nickname entries with the same syntax that
        // works for known-agents.json — the spec promises this remedy.
        // Without this, "Dawn:abcd" would skip nickname lookup entirely and
        // the documented disambiguation path would be a dead end.
        const lookupName = fpPrefixParse ? fpPrefixParse.name : targetAgent;
        const lookup = nicknameStore.resolveByName(lookupName);
        if (lookup && 'ambiguous' in lookup) {
          if (fpPrefixParse) {
            const matched = lookup.candidates.filter(c =>
              c.fingerprint.toLowerCase().startsWith(fpPrefixParse.fpPrefix)
            );
            if (matched.length === 1) {
              nicknameResolvedFp = matched[0].fingerprint;
            } else if (matched.length === 0) {
              const hints = lookup.candidates
                .map(c => `${c.entry.nickname}:${c.fingerprint.substring(0, 8)}`)
                .join(', ');
              res.status(409).json({
                success: false,
                error: `Nickname "${fpPrefixParse.name}" has no candidate matching prefix "${fpPrefixParse.fpPrefix}". Candidates: ${hints}.`,
              });
              return;
            } else {
              const hints = matched
                .map(c => `${c.entry.nickname}:${c.fingerprint.substring(0, 8)}`)
                .join(', ');
              res.status(409).json({
                success: false,
                error: `Prefix "${fpPrefixParse.fpPrefix}" still ambiguous among nickname "${fpPrefixParse.name}" candidates: ${hints}. Use a longer prefix.`,
              });
              return;
            }
          } else {
            const hints = lookup.candidates
              .map(c => `${c.entry.nickname}:${c.fingerprint.substring(0, 8)} (${c.fingerprint})`)
              .join(', ');
            res.status(409).json({
              success: false,
              error: `Ambiguous nickname "${targetAgent}" — multiple fingerprints share this name in nicknames.json: ${hints}. Send by fingerprint or use "name:fpPrefix" syntax.`,
            });
            return;
          }
        } else if (lookup) {
          // Single-candidate match. If caller also passed a fpPrefix, sanity-
          // check that it agrees with the curated mapping; on disagreement,
          // honor the caller's explicit prefix (they may be telling us the
          // nickname is stale) and skip nickname authority for this send.
          if (fpPrefixParse && !lookup.fingerprint.toLowerCase().startsWith(fpPrefixParse.fpPrefix)) {
            console.warn(
              `[relay-send] Nickname/prefix disagreement for "${fpPrefixParse.name}": ` +
              `nickname maps to ${lookup.fingerprint.substring(0, 8)}…, ` +
              `caller prefix is "${fpPrefixParse.fpPrefix}". Honoring caller prefix.`,
            );
          } else {
            nicknameResolvedFp = lookup.fingerprint;
          }
        }
      } catch (err) {
        // Nickname store read failed — fall through to existing resolution.
        // Don't block sends on a corrupt nicknames file.
        console.warn(`[relay-send] Nickname store read failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Mint a stable UUID threadId when caller didn't provide one so
    // first-contact messages aren't dropped on the recipient side. Both
    // sender and recipient will agree on this id going forward.
    const effectiveThreadId = threadId ?? randomUUID();

    // ── Try local delivery first (same-machine agents) ──────────────
    // Read known-agents.json for local agent info. If the target is local,
    // deliver directly via their /messages/relay-agent endpoint, bypassing
    // the relay entirely. This avoids stale relay WebSocket issues.
    try {
      const knownAgentsPath = path.join(ctx.config.stateDir, 'threadline', 'known-agents.json');
      if (fs.existsSync(knownAgentsPath)) {
        const knownData = JSON.parse(fs.readFileSync(knownAgentsPath, 'utf-8'));
        const agents: Array<{ name: string; port: number; path?: string; fingerprint?: string; publicKey?: string }> = knownData.agents ?? [];

        // Support "name:fingerprintPrefix" disambiguation syntax
        let targetName = targetAgent;
        let targetFpPrefix: string | undefined;
        const colonIdx = targetAgent.lastIndexOf(':');
        if (colonIdx > 0 && colonIdx < targetAgent.length - 1) {
          const suffix = targetAgent.substring(colonIdx + 1);
          if (/^[0-9a-f]{4,32}$/i.test(suffix)) {
            targetName = targetAgent.substring(0, colonIdx);
            targetFpPrefix = suffix.toLowerCase();
          }
        }

        // If a nickname resolved upstream, prefer fingerprint match over
        // name match — the user-curated mapping is authoritative.
        const nameMatches = nicknameResolvedFp
          ? agents.filter(a => {
              const fp = (a.fingerprint || a.publicKey?.substring(0, 32) || '').toLowerCase();
              return fp === nicknameResolvedFp!.toLowerCase();
            })
          : agents.filter(a =>
              a.name === targetName || a.name?.toLowerCase() === targetName?.toLowerCase()
            );

        // PR-3: Fingerprint-based disambiguation. If multiple known agents
        // share a name, require a `name:fpPrefix` qualifier to pick one.
        // Previously this silently fell through to the relay, which then
        // also usually failed — masking the root cause.
        let localTarget = nameMatches.length === 1 ? nameMatches[0] : undefined;
        if (nameMatches.length > 1 && targetFpPrefix) {
          localTarget = nameMatches.find(a => {
            const fp = a.fingerprint || a.publicKey?.substring(0, 32);
            return fp?.toLowerCase().startsWith(targetFpPrefix!);
          });
          if (!localTarget) {
            res.status(409).json({
              success: false,
              error: `No agent named "${targetName}" matches fingerprint prefix "${targetFpPrefix}". Known: ${nameMatches.map(a => `${a.name}:${(a.fingerprint || a.publicKey || '').substring(0, 8)}`).join(', ')}`,
            });
            return;
          }
        } else if (nameMatches.length > 1 && !targetFpPrefix) {
          const hints = nameMatches.map(a => {
            const fp = (a.fingerprint || a.publicKey || '').substring(0, 8);
            return `"${a.name}:${fp}"`;
          }).join(', ');
          res.status(409).json({
            success: false,
            error: `Ambiguous target: ${nameMatches.length} known agents named "${targetName}". Use one of: ${hints}`,
          });
          return;
        }

        // PR-3: Self-guard by fingerprint when available, falling back to
        // name comparison. This prevents self-delivery when the agent's
        // name happens to match one of its own aliases in known-agents.json.
        let isSelfTarget = localTarget?.name === ctx.config.projectName;
        if (localTarget && !isSelfTarget) {
          try {
            const selfIdPath = path.join(ctx.config.stateDir, 'threadline', 'identity.json');
            if (fs.existsSync(selfIdPath)) {
              const selfId = JSON.parse(fs.readFileSync(selfIdPath, 'utf-8'));
              const selfFp = (selfId.fingerprint || '').toLowerCase();
              const targetFp = (localTarget.fingerprint || localTarget.publicKey?.substring(0, 32) || '').toLowerCase();
              if (selfFp && targetFp && selfFp === targetFp) {
                isSelfTarget = true;
              }
            }
          } catch { /* @silent-fallback-ok — identity.json read is best-effort */ }
        }
        if (localTarget?.port && !isSelfTarget) {
          // Check if the local agent is actually running
          try {
            const healthResp = await fetch(`http://localhost:${localTarget.port}/threadline/health`, {
              signal: AbortSignal.timeout(3000),
            });

            if (healthResp.ok) {
              // Agent is alive — deliver locally via relay-agent endpoint
              const targetToken = getAgentToken(localTarget.name);
              if (targetToken) {
                const senderFingerprint = (() => {
                  try {
                    const idPath = path.join(ctx.config.stateDir, 'threadline', 'identity.json');
                    const idData = JSON.parse(fs.readFileSync(idPath, 'utf-8'));
                    return idData.fingerprint ?? ctx.config.projectName;
                  } catch { return ctx.config.projectName; }
                })();

                const now = new Date().toISOString();
                const envelope = {
                  schemaVersion: 1,
                  message: {
                    id: msgId,
                    from: { agent: ctx.config.projectName, session: 'threadline', machine: 'local' },
                    to: { agent: localTarget.name, session: 'best', machine: 'local' },
                    type: 'request' as const,
                    priority: resolvedPriority,
                    subject: 'Relay message',
                    body: message,
                    threadId: effectiveThreadId,
                    createdAt: now,
                  },
                  transport: {
                    relayChain: ['local'],
                    originServer: `http://localhost:${ctx.config.port ?? 4042}`,
                    nonce: `${randomUUID()}:${now}`,
                    timestamp: now,
                    // Stamp the sender's originating topic so the PEER can attribute
                    // this thread to one of ITS topics on reply (B). Opaque per-chat
                    // integer; the peer maps it via its own table and never echoes it
                    // back as a routing target (preserves the F1 anti-poisoning guard).
                    ...(resolvedOriginTopicId !== undefined ? { originTopicId: resolvedOriginTopicId } : {}),
                  },
                  delivery: {
                    phase: 'received' as const,
                    transitions: [
                      { from: 'created' as const, to: 'received' as const, at: now, reason: 'local delivery' },
                    ],
                    attempts: 1,
                  },
                };

                const localResp = await fetch(`http://localhost:${localTarget.port}/messages/relay-agent`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${targetToken}`,
                  },
                  body: JSON.stringify(envelope),
                  signal: AbortSignal.timeout(10000),
                });

                if (localResp.ok) {
                  let localRespBody: { ok?: boolean; threadline?: {
                    handled?: boolean; spawned?: boolean; resumed?: boolean; injected?: boolean;
                    threadId?: string; sessionName?: string; error?: string; gateDecision?: string;
                  } } = {};
                  try { localRespBody = await localResp.json() as typeof localRespBody; } catch { /* no body */ }
                  const tl = localRespBody.threadline;
                  const outcome = tl?.injected ? 'injected into live session'
                    : tl?.spawned ? 'spawned new session'
                    : tl?.resumed ? 'resumed existing thread'
                    : tl?.gateDecision === 'queue-for-approval' ? 'queued for approval'
                    : tl?.error ? `error: ${tl.error}`
                    : tl?.handled === false ? 'queued (no live session)'
                    : 'accepted';
                  console.log(`[relay-send] Local delivery to ${localTarget.name}:${localTarget.port} (thread: ${effectiveThreadId}) — ${outcome}`);

                  // Persist our OWN outbound leg into the thread history so
                  // getThread()/threadline_history return BOTH halves of the
                  // conversation (the D bug: only the peer's inbound leg was
                  // ever stored on this fast-path). Non-fatal, idempotent.
                  if (ctx.messageRouter) {
                    try {
                      await ctx.messageRouter.recordLocalOutbound(envelope as unknown as import('../messaging/types.js').MessageEnvelope);
                    } catch (err) {
                      console.warn(`[relay-send] recordLocalOutbound failed (non-fatal): ${err instanceof Error ? err.message : err}`);
                    }
                  }

                  // Canonical outbox write — single source of truth for outbound messages
                  // across BOTH delivery paths (local + relay). Powers the dashboard
                  // observability tab. Mirrors the inbound canonical write from PR #113.
                  if (ctx.listenerManager) {
                    try {
                      ctx.listenerManager.appendCanonicalOutboxEntry({
                        from: ctx.config.projectName ?? 'self',
                        senderName: ctx.config.projectName ?? 'self',
                        to: localTarget.name,
                        recipientName: localTarget.name,
                        threadId: effectiveThreadId,
                        text: message,
                        messageId: msgId,
                        outcome,
                      });
                    } catch (err) {
                      console.warn(`[relay-send] Canonical outbox append failed (non-fatal): ${err instanceof Error ? err.message : err}`);
                    }
                  }
                  // Mirror outbound into Telegram bridge (relay-only — best effort).
                  if (ctx.telegramBridge) {
                    ctx.telegramBridge.mirrorOutbound({
                      threadId: effectiveThreadId,
                      remoteAgent: localTarget.name,
                      remoteAgentName: localTarget.name,
                      text: message,
                      messageId: msgId,
                      outcome,
                    }).catch(() => { /* swallow — bridge is relay-only */ });
                  }
                  await captureOrigin(effectiveThreadId, localTarget.name);
                  if (waitForReply) {
                    const reply = await waitForThreadlineReply(ctx, localTarget.name, effectiveThreadId, timeoutSeconds);
                    res.json({
                      success: true,
                      messageId: msgId,
                      threadId: effectiveThreadId,
                      resolvedAgent: localTarget.name,
                      deliveryPath: 'local',
                      deliveryOutcome: outcome,
                      threadline: tl,
                      reply,
                      topicLinkageStamped: resolvedOriginTopicId !== undefined,
                    });
                  } else {
                    res.json({
                      success: true,
                      messageId: msgId,
                      threadId: effectiveThreadId,
                      resolvedAgent: localTarget.name,
                      deliveryPath: 'local',
                      deliveryOutcome: outcome,
                      threadline: tl,
                      topicLinkageStamped: resolvedOriginTopicId !== undefined,
                    });
                  }
                  return;
                }
                // Local delivery failed — fall through to relay
                console.warn(`[relay-send] Local delivery to ${localTarget.name} failed (${localResp.status}), falling back to relay`);
              }
            }
          } catch {
            // Local agent not reachable — fall through to relay
          }
        }
      }
    } catch {
      // Known-agents read failed — fall through to relay
    }

    // ── Fall back to relay delivery ─────────────────────────────────
    if (!relayClient || relayClient.connectionState !== 'connected') {
      res.status(503).json({ success: false, error: 'Relay not connected and local delivery unavailable' });
      return;
    }

    try {
      // Resolve name → fingerprint. Nickname store wins over relay discovery
      // when the user has explicitly curated a mapping (set above). Falling
      // back to relay discovery only when no nickname matched. If the relay
      // happens to also know this name but maps it to a different fingerprint,
      // we silently override with the nickname mapping — the user's choice is
      // authority. Logged so the conflict is visible in operator logs.
      let resolvedId: string | null;
      if (nicknameResolvedFp) {
        resolvedId = nicknameResolvedFp;
        try {
          const discoveryFp = await relayClient.resolveAgent(targetAgent);
          if (discoveryFp && discoveryFp.toLowerCase() !== nicknameResolvedFp.toLowerCase()) {
            console.warn(
              `[relay-send] Nickname/discovery mismatch for "${targetAgent}": ` +
              `nickname maps to ${nicknameResolvedFp.substring(0, 8)}…, ` +
              `relay discovery returned ${discoveryFp.substring(0, 8)}…. ` +
              `Honoring user-curated nickname.`,
            );
          }
        } catch {
          // Discovery probe is best-effort for the conflict warning only.
        }
      } else {
        resolvedId = await relayClient.resolveAgent(targetAgent);
      }
      if (!resolvedId) {
        res.status(404).json({
          success: false,
          error: `Agent not found: "${targetAgent}". Try discovering agents first.`,
        });
        return;
      }

      const relayMsgId = relayClient.sendAuto(resolvedId, message, threadId);
      const effectiveRelayThreadId = threadId ?? relayMsgId;

      // Canonical outbox write for the relay-delivery path — same shape as the
      // local-delivery path above, so the observability tab sees both paths.
      if (ctx.listenerManager) {
        try {
          ctx.listenerManager.appendCanonicalOutboxEntry({
            from: ctx.config.projectName ?? 'self',
            senderName: ctx.config.projectName ?? 'self',
            to: resolvedId,
            recipientName: targetAgent,
            threadId: effectiveRelayThreadId,
            text: message,
            messageId: relayMsgId,
            outcome: 'relay-sent',
          });
        } catch (err) {
          console.warn(`[relay-send] Canonical outbox append failed (non-fatal): ${err instanceof Error ? err.message : err}`);
        }
      }

      // Mirror outbound into Telegram bridge (relay-only — best effort).
      if (ctx.telegramBridge) {
        ctx.telegramBridge.mirrorOutbound({
          threadId: effectiveRelayThreadId,
          remoteAgent: resolvedId,
          remoteAgentName: targetAgent,
          text: message,
          messageId: relayMsgId,
          outcome: 'relay-sent',
        }).catch(() => { /* swallow — bridge is relay-only */ });
      }

      await captureOrigin(effectiveRelayThreadId, targetAgent);
      if (waitForReply) {
        const reply = await waitForThreadlineReply(ctx, resolvedId, effectiveRelayThreadId, timeoutSeconds);
        res.json({
          success: true,
          messageId: relayMsgId,
          threadId: effectiveRelayThreadId,
          resolvedAgent: resolvedId,
          deliveryPath: 'relay',
          reply,
          topicLinkageStamped: resolvedOriginTopicId !== undefined,
        });
      } else {
        res.json({
          success: true,
          messageId: relayMsgId,
          threadId: effectiveRelayThreadId,
          resolvedAgent: resolvedId,
          deliveryPath: 'relay',
          topicLinkageStamped: resolvedOriginTopicId !== undefined,
        });
      }
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Send failed',
      });
    }
  });

  // ── Threadline Hub: "open this" / "tie this to <topic>" ──────────────────
  // CMT-519: promote a surfaced (parentless) Threadline conversation out of the
  // hub into its own topic, or bind it to an existing one. AUTHORITATIVE bind —
  // sets boundTopicId on the conversation AND the commitment's topicId, overriding
  // captureOriginOnSend's first-write-wins (operator intent > heuristic). Once
  // bound, future replies surface to that parent topic via TopicLinkageHandler.
  router.post('/threadline/hub/bind', async (req, res) => {
    if (!ctx.collaborationSurfacer || !ctx.conversationStore || !ctx.telegram) {
      res.status(503).json({ error: 'Threadline hub not available (telegram/conversation store required)' });
      return;
    }
    // Shared logic with the deterministic onTopicMessage intercept (CMT-529).
    // API path leaves autoPick=false so a scripted caller gets the explicit 409.
    const { bindHubConversation } = await import('../threadline/hubCommands.js');
    const result = await bindHubConversation(
      {
        collaborationSurfacer: ctx.collaborationSurfacer,
        conversationStore: ctx.conversationStore,
        commitmentTracker: ctx.commitmentTracker,
        telegram: ctx.telegram,
        brief: ctx.briefDeps ?? undefined,
      },
      {
        action: req.body?.action,
        threadId: typeof req.body?.threadId === 'string' ? req.body.threadId : undefined,
        targetTopicId: typeof req.body?.targetTopicId === 'number' ? req.body.targetTopicId : undefined,
        targetTopicName: typeof req.body?.targetTopicName === 'string' ? req.body.targetTopicName : undefined,
      },
    );
    if (result.ok) {
      res.json({ ok: true, action: result.action, threadId: result.threadId, topicId: result.topicId, topicName: result.topicName });
    } else {
      res.status(result.status).json({ error: result.error });
    }
  });

  // ── Threadline Relay Discover ────────────────────────────────────────
  // Proxies a discover query through the agent server's relay WebSocket so
  // the MCP stdio subprocess can ask the relay for its live presence registry
  // (the MCP subprocess doesn't have its own relay client — same arrangement
  // as /threadline/relay-send above).
  router.post('/threadline/relay-discover', async (req, res) => {
    const relayClient = ctx.threadlineRelayClient;
    if (!relayClient || relayClient.connectionState !== 'connected') {
      res.status(503).json({
        success: false,
        error: 'Relay not connected',
        connectionState: relayClient?.connectionState ?? 'absent',
      });
      return;
    }
    const filter = (req.body && typeof req.body === 'object') ? req.body.filter : undefined;
    try {
      const agents = await relayClient.discover(filter);
      res.json({
        success: true,
        agents: agents.map(a => ({
          agentId: a.agentId,
          name: a.name,
          publicKey: Buffer.isBuffer(a.publicKey) ? a.publicKey.toString('hex') : a.publicKey,
          framework: a.framework,
          capabilities: a.capabilities,
          lastSeen: a.lastSeen,
        })),
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : 'Discover failed',
      });
    }
  });

  // ── Response Review Pipeline (Coherence Gate) ────────────────────────
  //
  // Evaluates agent responses before delivery. Implements PEL + Gate + Specialist
  // reviewer fan-out with the normative decision matrix.

  // Rate limiter for review endpoints (per session)
  const reviewRateLimits = new Map<string, { count: number; resetAt: number }>();
  const REVIEW_RATE_LIMIT = 10; // max requests per minute
  const REVIEW_RATE_WINDOW_MS = 60_000;

  function checkReviewRateLimit(sessionId: string, maxPerMinute: number): boolean {
    const now = Date.now();
    let entry = reviewRateLimits.get(sessionId);
    if (entry && now > entry.resetAt) {
      reviewRateLimits.delete(sessionId);
      entry = undefined;
    }
    if (!entry) {
      entry = { count: 0, resetAt: now + REVIEW_RATE_WINDOW_MS };
      reviewRateLimits.set(sessionId, entry);
    }
    entry.count++;
    return entry.count <= maxPerMinute;
  }

  router.post('/review/evaluate', async (req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const { message, sessionId, stopHookActive, context: evalContext } = req.body;

    // Validate required fields
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "message" field' });
      return;
    }
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "sessionId" field' });
      return;
    }

    // Per-session rate limit
    if (!checkReviewRateLimit(sessionId, REVIEW_RATE_LIMIT)) {
      res.status(429).json({ error: 'Rate limit exceeded (max 10/min per session)' });
      return;
    }

    try {
      const result = await ctx.responseReviewGate.evaluate({
        message,
        sessionId,
        stopHookActive: stopHookActive ?? false,
        context: {
          channel: evalContext?.channel ?? 'direct',
          topicId: evalContext?.topicId,
          recipientType: evalContext?.recipientType,
          recipientId: evalContext?.recipientId,
          isExternalFacing: evalContext?.isExternalFacing,
          transcriptPath: evalContext?.transcriptPath,
        },
      });

      // Strip internal audit fields from response (agent sees generic feedback only)
      res.json({
        pass: result.pass,
        feedback: result.feedback,
        issueCategories: result.issueCategories,
        warnings: result.warnings,
        retryCount: result.retryCount,
      });
    } catch (err) {
      // Fail-open: if the pipeline crashes, let the message through
      console.error('[review/evaluate] Pipeline error:', err);
      res.json({ pass: true, warnings: ['[review-error] Pipeline encountered an error'] });
    }
  });

  router.post('/review/test', async (req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    // Check if test endpoint is disabled
    if (ctx.config.responseReview?.testEndpointDisabled) {
      res.status(403).json({ error: 'Test endpoint is disabled' });
      return;
    }

    const { message, reviewer: reviewerName, context: testContext } = req.body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "message" field' });
      return;
    }

    // Per-session rate limit (use 'test' as session for test endpoint)
    if (!checkReviewRateLimit('__test__', 20)) {
      res.status(429).json({ error: 'Rate limit exceeded (max 20/min for test endpoint)' });
      return;
    }

    try {
      // Use a test session ID to avoid interfering with real sessions
      const testSessionId = `test-${Date.now()}`;
      const result = await ctx.responseReviewGate.evaluate({
        message,
        sessionId: testSessionId,
        stopHookActive: false,
        context: {
          channel: testContext?.channel ?? 'direct',
          topicId: testContext?.topicId,
          recipientType: testContext?.recipientType,
          recipientId: testContext?.recipientId,
          isExternalFacing: testContext?.isExternalFacing,
          transcriptPath: testContext?.transcriptPath,
        },
      });

      // Test endpoint returns FULL details (including reviewer names and specific issues)
      res.json({
        results: result._auditViolations ?? [],
        aggregateVerdict: result.pass ? 'pass' : 'block',
        gateResult: result._gateResult,
        pelBlock: result._pelBlock ?? false,
        outcome: result._outcome,
        warnings: result.warnings,
        feedback: result.feedback,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Test failed' });
    }
  });

  router.get('/review/history', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const history = ctx.responseReviewGate.getReviewHistory({
      sessionId: _req.query.sessionId as string | undefined,
      reviewer: _req.query.reviewer as string | undefined,
      verdict: _req.query.verdict as string | undefined,
      since: _req.query.since as string | undefined,
      recipientId: _req.query.recipientId as string | undefined,
      limit: _req.query.limit ? parseInt(_req.query.limit as string, 10) : undefined,
    });

    res.json({ history, count: history.length });
  });

  router.delete('/review/history', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const sessionId = _req.query.sessionId as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId query parameter required' });
      return;
    }

    const deleted = ctx.responseReviewGate.deleteHistory(sessionId);
    res.json({ deleted, sessionId });
  });

  router.get('/review/stats', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    res.json(ctx.responseReviewGate.getReviewerStats({
      period: (_req.query.period as 'daily' | 'weekly' | 'all') || undefined,
      since: _req.query.since as string | undefined,
    }));
  });

  // ── Coherence Proposals ─────────────────────────────────────────

  router.get('/coherence/proposals', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const status = _req.query.status as 'pending' | 'approved' | 'rejected' | undefined;
    const proposals = ctx.responseReviewGate.getProposals(status);
    res.json({ proposals, count: proposals.length });
  });

  router.post('/coherence/proposals', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const { type, title, description, source, data } = _req.body;
    if (!type || !title || !description) {
      res.status(400).json({ error: 'type, title, and description required' });
      return;
    }

    const proposal = ctx.responseReviewGate.addProposal({ type, title, description, source: source || 'user', data });
    res.status(201).json(proposal);
  });

  router.post('/coherence/proposals/:id/approve', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const result = ctx.responseReviewGate.resolveProposal(_req.params.id, 'approve', _req.body.resolution);
    if (!result) {
      res.status(404).json({ error: 'Proposal not found or already resolved' });
      return;
    }
    res.json(result);
  });

  router.post('/coherence/proposals/:id/reject', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    const result = ctx.responseReviewGate.resolveProposal(_req.params.id, 'reject', _req.body.resolution);
    if (!result) {
      res.status(404).json({ error: 'Proposal not found or already resolved' });
      return;
    }
    res.json(result);
  });

  // ── Coherence Health Dashboard ──────────────────────────────────

  router.get('/coherence/health', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    res.json(ctx.responseReviewGate.getHealthDashboard());
  });

  // ── Reviewer Health & Canary ────────────────────────────────────

  router.get('/review/health', (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    res.json(ctx.responseReviewGate.getReviewerHealth());
  });

  router.post('/review/canary', async (_req, res) => {
    if (!ctx.responseReviewGate) {
      res.status(501).json({ error: 'Response review pipeline not enabled' });
      return;
    }

    try {
      const results = await ctx.responseReviewGate.runCanaryTests();
      ctx.responseReviewGate.setCanaryResults(results);

      const passed = results.filter(r => r.pass).length;
      const total = results.length;
      const missed = results.filter(r => !r.pass);

      res.json({
        passed,
        total,
        allPassed: passed === total,
        results,
        missed: missed.length > 0 ? missed : undefined,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Canary test failed' });
    }
  });

  // ── Paste / Drop Zone ─────────────────────────────────────────────

  const pasteLimiter = rateLimiter(60_000, 10);

  router.post('/pastes', pasteLimiter, (req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const { content, label, targetSession } = req.body;
    if (!content || typeof content !== 'string') {
      res.status(400).json({ ok: false, error: 'validation_error', message: '"content" must be a non-empty string' });
      return;
    }
    if (label !== undefined && (typeof label !== 'string' || label.length > 256)) {
      res.status(400).json({ ok: false, error: 'validation_error', message: '"label" must be a string under 256 characters' });
      return;
    }
    if (targetSession !== undefined && typeof targetSession !== 'string') {
      res.status(400).json({ ok: false, error: 'validation_error', message: '"targetSession" must be a string' });
      return;
    }

    try {
      const result = ctx.pasteManager.create(content, {
        label,
        from: 'dashboard',
        targetSession,
      });

      // Try to deliver to an active session
      const paste = ctx.pasteManager.getMeta(result.pasteId);
      if (!paste) {
        res.status(500).json({ ok: false, error: 'internal', message: 'Paste created but metadata not readable' });
        return;
      }

      // Find target session — use specified, or most recent interactive
      let deliveredToSession: string | undefined;
      const sessions = ctx.sessionManager.listRunningSessions();
      const interactiveSessions = sessions.filter(s => !s.jobSlug);

      if (targetSession) {
        const match = interactiveSessions.find(s => s.name === targetSession);
        if (match) deliveredToSession = match.name;
      } else if (interactiveSessions.length > 0) {
        // Default: most recently active interactive session
        deliveredToSession = interactiveSessions[0].name;
      }

      if (deliveredToSession) {
        // Inject notification
        const notification = ctx.pasteManager.buildNotification(paste);
        ctx.sessionManager.injectPasteNotification(deliveredToSession, notification);
        ctx.pasteManager.updateStatus(result.pasteId, 'notified');
        result.status = 'notified';
        result.sessionName = deliveredToSession;

        // Broadcast WebSocket event
        if (ctx.wsManager) {
          ctx.wsManager.broadcastEvent({
            type: 'paste_delivered',
            pasteId: result.pasteId,
            session: deliveredToSession,
            contentLength: result.contentLength,
            label,
          });
        }
      } else {
        // Queue for later delivery
        ctx.pasteManager.addPending(paste);
      }

      res.status(201).json(result);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const pasteErr = err as { statusCode: number; code: string; message: string };
        res.status(pasteErr.statusCode).json({
          ok: false,
          error: pasteErr.code,
          message: pasteErr.message,
        });
        return;
      }
      res.status(500).json({ ok: false, error: 'internal', message: err instanceof Error ? err.message : 'Unknown error' });
    }
  });

  router.get('/pastes', (_req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const pastes = ctx.pasteManager.list().map(p => ({
      pasteId: p.pasteId,
      label: p.label,
      from: p.from,
      timestamp: p.timestamp,
      status: p.status,
      targetSession: p.targetSession,
      contentLength: p.contentLength,
      expiresAt: p.expiresAt,
    }));

    res.json({ ok: true, pastes, stats: ctx.pasteManager.getStats() });
  });

  router.get('/pastes/:id', (req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const result = ctx.pasteManager.getContent(req.params.id);
    if (!result) {
      res.status(404).json({ ok: false, error: 'not_found', message: 'Paste not found' });
      return;
    }

    res.json({
      ok: true,
      pasteId: result.meta.pasteId,
      label: result.meta.label,
      from: result.meta.from,
      timestamp: result.meta.timestamp,
      status: result.meta.status,
      targetSession: result.meta.targetSession,
      contentLength: result.meta.contentLength,
      expiresAt: result.meta.expiresAt,
      content: result.content,
    });
  });

  router.delete('/pastes/:id', (req, res) => {
    if (!ctx.pasteManager) {
      res.status(503).json({ error: 'Paste system not available' });
      return;
    }

    const deleted = ctx.pasteManager.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'not_found', message: 'Paste not found' });
      return;
    }

    res.json({ ok: true, deleted: true });
  });

  // ── Prompt Gate API ─────────────────────────────────────────────

  /**
   * GET /prompt-gate/log — Audit log of prompt gate actions.
   * Returns recent auto-approve and relay events.
   */
  router.get('/prompt-gate/log', (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 500);
    const logPath = path.join(ctx.config.stateDir, 'prompt-gate-audit.jsonl');
    try {
      if (!fs.existsSync(logPath)) {
        res.json({ entries: [], total: 0 });
        return;
      }
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
      const entries = lines.slice(-limit).reverse().map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      res.json({ entries, total: lines.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to read audit log' });
    }
  });

  /**
   * GET /prompt-gate/topic/:topicId/override — Get per-topic prompt gate overrides.
   */
  router.get('/prompt-gate/topic/:topicId/override', (req, res) => {
    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
    try {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      const overrides = data.topicOverrides?.[String(topicId)] ?? { autoApproveAll: false, relayAll: false };
      res.json({ topicId, overrides });
    } catch {
      res.json({ topicId, overrides: { autoApproveAll: false, relayAll: false } });
    }
  });

  /**
   * PUT /prompt-gate/topic/:topicId/override — Set per-topic prompt gate overrides.
   * Body: { autoApproveAll?: boolean, relayAll?: boolean }
   */
  router.put('/prompt-gate/topic/:topicId/override', (req, res) => {
    const topicId = parseInt(req.params.topicId, 10);
    if (isNaN(topicId)) {
      res.status(400).json({ error: 'topicId must be a number' });
      return;
    }
    const { autoApproveAll, relayAll } = req.body ?? {};
    if (autoApproveAll !== undefined && typeof autoApproveAll !== 'boolean') {
      res.status(400).json({ error: 'autoApproveAll must be a boolean' });
      return;
    }
    if (relayAll !== undefined && typeof relayAll !== 'boolean') {
      res.status(400).json({ error: 'relayAll must be a boolean' });
      return;
    }

    const registryPath = path.join(ctx.config.stateDir, 'topic-session-registry.json');
    try {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(fs.readFileSync(registryPath, 'utf-8')); } catch { /* new file */ }

      if (!data.topicOverrides) data.topicOverrides = {};
      const overrides = (data.topicOverrides as Record<string, unknown>);
      const existing = (overrides[String(topicId)] ?? {}) as Record<string, boolean>;

      if (autoApproveAll !== undefined) existing.autoApproveAll = autoApproveAll;
      if (relayAll !== undefined) existing.relayAll = relayAll;
      overrides[String(topicId)] = existing;

      fs.writeFileSync(registryPath, JSON.stringify(data, null, 2));
      res.json({ ok: true, topicId, overrides: existing });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save override' });
    }
  });

  /**
   * GET /prompt-gate/status — Current prompt gate status for all sessions.
   * Returns which sessions have pending prompts, their type, and duration.
   */
  router.get('/prompt-gate/status', (_req, res) => {
    if (!ctx.telegram) {
      res.json({ enabled: false, sessions: [] });
      return;
    }
    // The detailed status comes from the TelegramAdapter's pendingPromptReply map
    // For now, return basic status
    const promptGateConfig = ctx.config.monitoring?.promptGate;
    res.json({
      enabled: !!promptGateConfig?.enabled,
      autoApproveEnabled: !!promptGateConfig?.autoApprove?.enabled,
      dryRun: !!promptGateConfig?.dryRun,
      ownerId: promptGateConfig?.ownerId ?? null,
    });
  });

  // ── Feature Registry (Consent & Discovery Framework) ────────────────
  //
  // Phase 1: Feature Registry — definitions, state, and summaries.

  router.get('/features', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const stateFilter = req.query.state as string | undefined;

    if (stateFilter) {
      const states = stateFilter.split(',').map(s => s.trim()) as import('../core/FeatureRegistry.js').DiscoveryState[];
      res.json({ features: ctx.featureRegistry.getFeaturesByState(states, userId) });
    } else {
      res.json({ features: ctx.featureRegistry.getAllFeatures(userId) });
    }
  });

  router.get('/features/summary', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json({ features: ctx.featureRegistry.getSummaries(userId) });
  });

  router.get('/features/events', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = req.query.userId as string | undefined;
    const featureId = req.query.featureId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const events = ctx.featureRegistry.getDiscoveryEvents({ userId, featureId, limit });
    res.json({ events });
  });

  // Phase 5: Analytics & Observability — must be before /features/:id to avoid param capture

  router.get('/features/analytics', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json(ctx.featureRegistry.getAnalytics(userId));
  });

  router.get('/features/cooldowns', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json({ cooldowns: ctx.featureRegistry.getCooldownStatuses(userId) });
  });

  router.get('/features/funnel', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    res.json({ funnel: ctx.featureRegistry.getFunnelMetrics(userId) });
  });

  router.get('/features/digest', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const thresholdDays = req.query.thresholdDays ? parseInt(req.query.thresholdDays as string, 10) : 15;
    res.json({
      changedDisabled: ctx.featureRegistry.getChangedDisabledFeatures(userId),
      unusedEnabled: ctx.featureRegistry.getUnusedEnabledFeatures(userId, thresholdDays),
    });
  });

  // Phase 3: Evaluator status — must be before /features/:id to avoid param capture
  router.get('/features/evaluator-status', (_req, res) => {
    if (!ctx.discoveryEvaluator) {
      res.status(501).json({ error: 'DiscoveryEvaluator not initialized' });
      return;
    }
    res.json(ctx.discoveryEvaluator.getStatus());
  });

  router.get('/features/:id', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const info = ctx.featureRegistry.getFeatureInfo(req.params.id, userId);
    if (!info) {
      res.status(404).json({
        error: { code: 'FEATURE_NOT_FOUND', message: `Feature '${req.params.id}' not found in registry.` },
      });
      return;
    }
    res.json({
      ...info,
      validTransitions: ctx.featureRegistry.getValidTransitions(req.params.id, userId),
    });
  });

  // ── Phase 2: State Machine, Consent, Events ─────────────────────

  router.post('/features/:id/surface', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.body?.userId as string) || 'default';
    const result = ctx.featureRegistry.recordSurface(req.params.id, userId, {
      surfacedAs: req.body?.surfacedAs,
      trigger: req.body?.trigger,
      context: req.body?.context,
    });
    if (!result.success) {
      const status = result.error?.code === 'FEATURE_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  router.post('/features/:id/transition', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const { to, userId: bodyUserId, trigger, consentRecord, context, activationChallenge } = req.body || {};
    if (!to) {
      res.status(400).json({ error: { code: 'MISSING_TARGET', message: 'Request body must include "to" (target state)' } });
      return;
    }
    const userId = (bodyUserId as string) || 'default';
    const result = ctx.featureRegistry.transition(req.params.id, userId, to, {
      trigger,
      consentRecord,
      context,
      activationChallenge,
    });
    if (!result.success) {
      const status = result.error?.code === 'FEATURE_NOT_FOUND' ? 404
        : result.error?.code === 'INVALID_TRANSITION' ? 422
        : result.error?.code === 'CONSENT_REQUIRED' ? 422
        : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  router.delete('/features/discovery-data', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.body?.userId as string) || (req.query.userId as string) || 'default';
    const forceDeleteConsent = req.body?.forceDeleteConsent === true;
    const result = ctx.featureRegistry.eraseDiscoveryData(userId, { forceDeleteConsent });
    res.json({
      erased: true,
      userId,
      stateRowsDeleted: result.deleted,
      consentRecordsPreserved: result.consentRecordsPreserved,
    });
  });

  router.get('/features/:id/consent-records', (req, res) => {
    if (!ctx.featureRegistry) {
      res.status(501).json({ error: 'FeatureRegistry not initialized' });
      return;
    }
    const userId = (req.query.userId as string) || 'default';
    const records = ctx.featureRegistry.getConsentRecordsForFeature(req.params.id, userId);
    res.json({ records });
  });

  // ── Phase 3: Context Evaluator ──────────────────────────────────

  router.post('/features/evaluate-context', async (req, res) => {
    if (!ctx.discoveryEvaluator) {
      res.status(501).json({ error: 'DiscoveryEvaluator not initialized (requires IntelligenceProvider)' });
      return;
    }

    const {
      topicCategory,
      conversationIntent,
      problemCategories,
      autonomyProfile,
      enabledFeatures,
      userId,
    } = req.body || {};

    if (!topicCategory || typeof topicCategory !== 'string') {
      res.status(400).json({ error: { code: 'MISSING_TOPIC', message: 'Request body must include "topicCategory" (string)' } });
      return;
    }

    const validIntents = ['debugging', 'configuring', 'exploring', 'building', 'asking', 'monitoring', 'unknown'];
    const intent = validIntents.includes(conversationIntent) ? conversationIntent : 'unknown';

    try {
      const result = await ctx.discoveryEvaluator.evaluate({
        topicCategory,
        conversationIntent: intent,
        problemCategories: Array.isArray(problemCategories) ? problemCategories : [],
        autonomyProfile: autonomyProfile || 'collaborative',
        enabledFeatures: Array.isArray(enabledFeatures) ? enabledFeatures : [],
        userId: userId || 'default',
      });
      res.json(result);
    } catch (err) {
      // Fail-open: return no recommendation on unexpected errors
      res.json({
        recommendation: null,
        cached: false,
        rateLimited: false,
        eligibleCount: 0,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  });

  // ── Integrated-Being shared-state ledger (v1) ─────────────────────
  //
  // Four bearer-token-gated endpoints (auth enforced globally by authMiddleware).
  // Per-IP rate limiting uses the same middleware applied elsewhere in the API.
  // When config.integratedBeing.enabled === false, all four return 503.
  //
  // Spec: docs/specs/integrated-being-ledger-v1.md §"Read path".

  const sharedStateDisabled = (_req: ExpressRequest, res: ExpressResponse): boolean => {
    const enabled = ctx.config.integratedBeing?.enabled;
    const effective = enabled === undefined ? true : enabled !== false;
    if (!effective || !ctx.sharedStateLedger) {
      res.status(503).json({ error: 'Integrated-Being ledger disabled' });
      return true;
    }
    return false;
  };

  router.get('/shared-state/recent', rateLimiter(60_000, 60), async (req, res) => {
    if (sharedStateDisabled(req, res)) return;
    try {
      const limit = req.query.limit ? Math.max(1, Math.min(200, parseInt(String(req.query.limit), 10) || 20)) : 20;
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      const cpType = typeof req.query.counterpartyType === 'string'
        ? (req.query.counterpartyType as 'user' | 'agent' | 'self' | 'system')
        : undefined;
      const entries = await ctx.sharedStateLedger!.recent({
        limit,
        since,
        counterpartyType: cpType,
      });
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/shared-state/render', rateLimiter(60_000, 60), async (req, res) => {
    if (sharedStateDisabled(req, res)) return;
    try {
      const limit = req.query.limit ? Math.max(1, Math.min(200, parseInt(String(req.query.limit), 10) || 50)) : 50;
      const rendered = await ctx.sharedStateLedger!.renderForInjection({ limit });
      res.type('text/plain').send(rendered);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/shared-state/chain/:id', rateLimiter(60_000, 60), async (req, res) => {
    if (sharedStateDisabled(req, res)) return;
    try {
      const id = String(req.params.id || '').trim();
      if (!/^[0-9a-f]{12}$/.test(id)) {
        res.status(400).json({ error: 'Invalid entry id' });
        return;
      }
      const chain = await ctx.sharedStateLedger!.walkChain(id);
      res.json({ chain });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/shared-state/stats', rateLimiter(60_000, 60), async (req, res) => {
    if (sharedStateDisabled(req, res)) return;
    try {
      const rebuild = req.query.rebuild === '1' || req.query.rebuild === 'true';
      const stats = await ctx.sharedStateLedger!.stats(rebuild);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Integrated-Being shared-state ledger (v2 — session-write surface) ─
  //
  // Slice 1 scope: session-bind + append (auth-only, no commitment logic).
  // Later slices add resolve, session-bind-interactive, session-bind-rotate,
  // mechanism-ref validation, dedup index, sweepers, and dashboard.
  //
  // All v2 endpoints are gated on config.integratedBeing.v2Enabled (default
  // false). When false, endpoints return 503 with X-Disabled: v2.
  //
  // Spec: docs/specs/integrated-being-ledger-v2.md

  const v2Disabled = (_req: ExpressRequest, res: ExpressResponse): boolean => {
    const ibConfig = ctx.config.integratedBeing ?? {};
    const masterEnabled =
      ibConfig.enabled === undefined ? true : ibConfig.enabled !== false;
    const v2Enabled = ibConfig.v2Enabled === true;
    const ready =
      masterEnabled && v2Enabled && ctx.sharedStateLedger && ctx.ledgerSessionRegistry;
    if (!ready) {
      res.setHeader('X-Disabled', 'v2');
      res.status(503).json({ error: 'Integrated-Being ledger v2 disabled' });
      return true;
    }
    return false;
  };

  // --- Log-masking helper: binding tokens + session ids must never leak. ---
  // Structural redaction via a shared helper ensures consistency across
  // handlers. The raw token and session id never land in logs / error
  // traces / degradation-reporter output. (Spec §2 Security S1.)
  const redactBindingToken = (token: string): string =>
    token.length > 0 ? '***REDACTED***' : '';
  const redactSessionId = (sid: string): string =>
    sid.length >= 8 ? `${sid.slice(0, 8)}-***` : '***';

  /**
   * POST /shared-state/session-bind
   *
   * Registers a session id in the LedgerSessionRegistry and returns a
   * plaintext binding token ONCE. Called by the session-start hook
   * (slice 2 wires the hook; for slice 1 this endpoint is callable
   * directly from tests and any authenticated caller).
   *
   * Request body: { sessionId: uuidv4, label?: string }
   * Response 200: { token, absoluteExpiresAt, idleExpiresAt, idempotentReplay }
   * Response 400: malformed sessionId
   * Response 503: v2 disabled
   *
   * Note: bearer-token auth is enforced by the global authMiddleware.
   * The open architectural concern called out in the spec's "Open
   * architectural questions" §1 (any bearer-token holder can call this)
   * is documented there as an accepted limit of v2; v2.1 addresses it
   * with privileged-channel isolation.
   */
  router.post(
    '/shared-state/session-bind',
    rateLimiter(60_000, 30),
    async (req, res) => {
      if (v2Disabled(req, res)) return;
      try {
        const body = (req.body ?? {}) as { sessionId?: unknown; label?: unknown };
        const sessionId =
          typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const label = typeof body.label === 'string' ? body.label : undefined;
        if (!sessionId) {
          res.status(400).json({
            error: 'sessionId is required (UUIDv4 format)',
          });
          return;
        }
        let result;
        try {
          result = ctx.ledgerSessionRegistry!.register(sessionId, label);
        } catch (err) {
          res.status(400).json({
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        // Mark hook-in-progress so the interactive-fallback path can
        // attest a lifecycle hook initiated this bind (spec §3).
        ctx.ledgerSessionRegistry!.markHookInProgress(sessionId);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          sessionId: result.sessionId,
          token: result.token,
          absoluteExpiresAt: result.absoluteExpiresAt,
          idleExpiresAt: result.idleExpiresAt,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * POST /shared-state/append
   *
   * Authenticated session-write to the shared-state ledger. Slice 1
   * scope: accepts 'agreement' | 'decision' | 'note' kinds only;
   * 'commitment' returns 501 (pending slice 3's mechanism-ref validator).
   * 'thread-*' kinds return 400 (reserved for server-side emitters).
   *
   * Auth: X-Instar-Session-Id + X-Instar-Session-Token. Both required.
   * The global bearer-token auth (authMiddleware) remains in front.
   *
   * Request body (SessionAppendRequest):
   *   { kind, subject, summary?, counterparty: { type, name, trustTier? },
   *     supersedes?, dedupKey }
   *
   * Response 200: { id, t } — the new entry's id and server timestamp.
   * Response 400: malformed body or forbidden kind
   * Response 401: missing / invalid session headers
   * Response 409: dedupKey collision (via v1 dedup)
   * Response 501: commitment kind (pending slice 3)
   * Response 503: v2 disabled
   */
  router.post(
    '/shared-state/append',
    rateLimiter(60_000, 60),
    async (req, res) => {
      if (v2Disabled(req, res)) return;

      // ── Session auth ──────────────────────────────────────────────
      const sessionId = String(req.header('x-instar-session-id') ?? '').trim();
      const token = String(req.header('x-instar-session-token') ?? '').trim();
      if (!sessionId || !token) {
        res
          .status(401)
          .json({ error: 'Missing X-Instar-Session-Id or X-Instar-Session-Token' });
        return;
      }
      const verify = ctx.ledgerSessionRegistry!.verify(sessionId, token);
      if (!verify.ok) {
        res.status(401).json({
          error: 'Session binding invalid',
          reason: verify.reason,
        });
        return;
      }

      // ── Forbid server-bound fields FIRST ─────────────────────────
      // Runs before schema validation so a client debugging a forbidden-
      // field error sees that failure first. `commitment` is allowed
      // ONLY when kind === 'commitment' (slice 3 opens this path).
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = typeof body.kind === 'string' ? body.kind : '';
      const forbiddenBase = ['provenance', 'emittedBy', 'source', 'id', 't'];
      const forbidden = kind === 'commitment' ? forbiddenBase : [...forbiddenBase, 'commitment'];
      for (const f of forbidden) {
        if (Object.prototype.hasOwnProperty.call(body, f)) {
          res.setHeader('X-Invalid-Field', f);
          res.status(400).json({
            error: `field '${f}' is server-bound and cannot be supplied`,
          });
          return;
        }
      }

      // ── Schema validation ─────────────────────────────────────────
      if (
        kind !== 'agreement' &&
        kind !== 'decision' &&
        kind !== 'note' &&
        kind !== 'commitment'
      ) {
        res.setHeader('X-Invalid-Field', 'kind');
        res.status(400).json({
          error: 'kind must be one of: agreement | decision | note | commitment',
        });
        return;
      }

      const subject = typeof body.subject === 'string' ? body.subject : '';
      if (!subject || subject.length > 200) {
        res.setHeader('X-Invalid-Field', 'subject');
        res.status(400).json({ error: 'subject required, max 200 chars' });
        return;
      }
      const summary =
        typeof body.summary === 'string' ? body.summary : undefined;
      if (summary !== undefined && summary.length > 400) {
        res.setHeader('X-Invalid-Field', 'summary');
        res.status(400).json({ error: 'summary max 400 chars' });
        return;
      }

      const counterparty = body.counterparty as
        | { type?: string; name?: string; trustTier?: string }
        | undefined;
      if (
        !counterparty ||
        typeof counterparty !== 'object' ||
        !counterparty.type ||
        !counterparty.name
      ) {
        res.setHeader('X-Invalid-Field', 'counterparty');
        res.status(400).json({ error: 'counterparty.type + .name required' });
        return;
      }
      if (!/^[a-zA-Z0-9\-_.:]+$/.test(counterparty.name) || counterparty.name.length > 64) {
        res.setHeader('X-Invalid-Field', 'counterparty.name');
        res.status(400).json({
          error: 'counterparty.name must be [a-zA-Z0-9-_.:], max 64 chars',
        });
        return;
      }
      if (
        counterparty.type !== 'user' &&
        counterparty.type !== 'agent' &&
        counterparty.type !== 'self' &&
        counterparty.type !== 'system'
      ) {
        res.setHeader('X-Invalid-Field', 'counterparty.type');
        res.status(400).json({
          error: 'counterparty.type must be one of: user | agent | self | system',
        });
        return;
      }

      const dedupKey = typeof body.dedupKey === 'string' ? body.dedupKey : '';
      if (!dedupKey || dedupKey.length > 200 || !/^[a-zA-Z0-9\-_.:]+$/.test(dedupKey)) {
        res.setHeader('X-Invalid-Field', 'dedupKey');
        res.status(400).json({
          error: 'dedupKey required, [a-zA-Z0-9-_.:], max 200 chars',
        });
        return;
      }

      const supersedes =
        typeof body.supersedes === 'string' && body.supersedes.length > 0
          ? body.supersedes
          : undefined;

      // ── Commitment-kind validation (slice 3) ─────────────────────
      // Only runs when kind === 'commitment'. Validates the inner
      // `commitment` object: mechanism shape, deadline sanity,
      // passive-wait-requires-deadline. Server sets refResolvedAt,
      // refStatus, status, resolution — all server-bound.
      const ibConfig = ctx.config.integratedBeing ?? {};
      let commitmentOut:
        | undefined
        | {
            mechanism: {
              type: 'scheduled-job' | 'polling-sentinel' | 'external-callback' | 'passive-wait' | 'user-driven';
              ref?: string;
              refResolvedAt: string;
              refStatus: 'valid' | 'invalid' | 'unverified';
            };
            deadline?: string;
            status: 'open';
          };
      if (kind === 'commitment') {
        const commitment = body.commitment as
          | {
              mechanism?: { type?: string; ref?: string };
              deadline?: string;
              status?: string;
              resolution?: unknown;
            }
          | undefined;
        if (!commitment || typeof commitment !== 'object') {
          res.setHeader('X-Invalid-Field', 'commitment');
          res.status(400).json({ error: 'commitment object required on commitment kind' });
          return;
        }
        if (commitment.status !== undefined && commitment.status !== 'open') {
          res.setHeader('X-Invalid-Field', 'commitment.status');
          res.status(400).json({
            error: "commitment.status must be 'open' on create; use /shared-state/resolve/:id to transition",
          });
          return;
        }
        if (commitment.resolution !== undefined) {
          res.setHeader('X-Invalid-Field', 'commitment.resolution');
          res.status(400).json({
            error: "commitment.resolution cannot be supplied on create (server-bound, set via resolve)",
          });
          return;
        }
        const mech = commitment.mechanism;
        if (!mech || typeof mech !== 'object' || typeof mech.type !== 'string') {
          res.setHeader('X-Invalid-Field', 'commitment.mechanism');
          res.status(400).json({ error: 'commitment.mechanism.type required' });
          return;
        }
        const validMechTypes = [
          'scheduled-job',
          'polling-sentinel',
          'external-callback',
          'passive-wait',
          'user-driven',
        ] as const;
        if (!validMechTypes.includes(mech.type as (typeof validMechTypes)[number])) {
          res.setHeader('X-Invalid-Field', 'commitment.mechanism.type');
          res.status(400).json({
            error: `commitment.mechanism.type must be one of: ${validMechTypes.join(' | ')}`,
          });
          return;
        }
        const mechType = mech.type as (typeof validMechTypes)[number];
        // passive-wait forbids ref; others allow optional ref with charset.
        if (mechType === 'passive-wait' && mech.ref !== undefined) {
          res.setHeader('X-Invalid-Field', 'commitment.mechanism.ref');
          res.status(400).json({
            error: "passive-wait mechanism forbids commitment.mechanism.ref",
          });
          return;
        }
        if (
          mech.ref !== undefined &&
          (typeof mech.ref !== 'string' ||
            mech.ref.length === 0 ||
            mech.ref.length > 200 ||
            !/^[a-zA-Z0-9\-_.:]+$/.test(mech.ref))
        ) {
          res.setHeader('X-Invalid-Field', 'commitment.mechanism.ref');
          res.status(400).json({
            error: 'commitment.mechanism.ref must be [a-zA-Z0-9-_.:], max 200 chars',
          });
          return;
        }
        // Deadline validation.
        const deadline =
          typeof commitment.deadline === 'string' ? commitment.deadline : undefined;
        if (mechType === 'passive-wait' && !deadline) {
          res.setHeader('X-Invalid-Field', 'commitment.deadline');
          res.status(400).json({
            error: 'passive-wait commitments require a deadline',
          });
          return;
        }
        if (deadline !== undefined) {
          const dl = Date.parse(deadline);
          if (Number.isNaN(dl)) {
            res.setHeader('X-Invalid-Field', 'commitment.deadline');
            res.status(400).json({ error: 'deadline must be ISO 8601' });
            return;
          }
          const now = Date.now();
          const minMs = now + 60 * 1000;
          const maxMs = now + 90 * 24 * 60 * 60 * 1000;
          if (dl < minMs || dl > maxMs) {
            res.setHeader('X-Invalid-Field', 'commitment.deadline');
            res.status(400).json({
              error: 'deadline must be between now+60s and now+90d',
            });
            return;
          }
        }
        // Open-commitment + passive-wait caps.
        const openLimit = Math.max(1, ibConfig.openCommitmentsPerSession ?? 20);
        const passiveLimit = Math.max(
          0,
          ibConfig.passiveWaitCommitmentsPerSession ?? 3,
        );
        const capReason = ctx.ledgerSessionRegistry!.checkOpenCommitments(
          sessionId,
          mechType,
          openLimit,
          passiveLimit,
        );
        if (capReason) {
          res.setHeader('X-Cap-Reason', capReason);
          res.status(429).json({ error: 'commitment cap exceeded', reason: capReason });
          return;
        }
        // Build server-bound commitment fields. refStatus: slice 3 sets
        // 'unverified' by default; positive verification (scheduled-job
        // lookup against scheduler registry, etc.) is a slice 5 refinement.
        commitmentOut = {
          mechanism: {
            type: mechType,
            ref: mech.ref,
            refResolvedAt: new Date().toISOString(),
            refStatus: 'unverified',
          },
          deadline,
          status: 'open',
        };
      }

      // ── Per-session write-rate check ─────────────────────────────
      // Runs after validation so a 429 doesn't block us from seeing
      // the actual schema error first.
      const writeRate = Math.max(1, ibConfig.sessionWriteRatePerMinute ?? 30);
      const rateReason = ctx.ledgerSessionRegistry!.checkWriteRate(sessionId, writeRate);
      if (rateReason) {
        res.setHeader('X-Cap-Reason', rateReason);
        res.status(429).json({ error: 'session write rate exceeded', reason: rateReason });
        return;
      }

      // ── Append ────────────────────────────────────────────────────
      try {
        const appended = await ctx.sharedStateLedger!.append({
          emittedBy: { subsystem: 'session', instance: sessionId },
          kind: kind as 'agreement' | 'decision' | 'note' | 'commitment',
          subject,
          summary,
          counterparty: {
            type: counterparty.type,
            name: counterparty.name,
            // trustTier is server-owned per spec — hardcoded 'untrusted'
            // in slice 3; slice 5 adds real resolution + discrepancy emit.
            trustTier: 'untrusted',
          },
          supersedes,
          provenance: 'session-asserted',
          dedupKey,
          ...(commitmentOut ? { commitment: commitmentOut } : {}),
        });

        if (!appended) {
          // v1 append returns null on dedup OR fail-open IO failure. The
          // client can't tell which without inspecting server logs — for
          // slice 1 we collapse to 409 (idempotent replay friendly) and
          // return 500 only if a subsequent follow-up check (future slice)
          // confirms a write failure. v1 behavior is preserved.
          res.setHeader('X-Dedup-Or-Fail', '1');
          res.status(409).json({
            error: 'duplicate dedupKey or append failed (fail-open)',
          });
          return;
        }

        ctx.ledgerSessionRegistry!.touchActivity(sessionId);
        ctx.ledgerSessionRegistry!.recordWrite(sessionId);
        if (commitmentOut) {
          ctx.ledgerSessionRegistry!.recordOpenCommitment(
            sessionId,
            commitmentOut.mechanism.type,
          );
        }
        res.json({ id: appended.id, t: appended.t });
      } catch (err) {
        console.error(
          `[shared-state/append] append failed for session=${redactSessionId(
            sessionId
          )} token=${redactBindingToken(token)}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * POST /shared-state/resolve/:id — slice 4
   *
   * Resolves a commitment by appending a new entry that supersedes
   * (for self-assert / subsystem-verify / cancel) or disputes (for
   * dispute) the original commitment entry. Tiered authorization:
   *
   * - `self-assert`: ONLY the creator session can call (session id
   *   must match the commitment's emittedBy.instance). Spec §4 A4
   *   closes "any session can hide any commitment via self-assert".
   * - `dispute`: any registered session. Rate-capped at
   *   disputesPerSessionPerHour (default 10) — spec §4 iter 2.
   * - `user-resolve`: deferred to slice 6 (requires PIN-unlock
   *   infrastructure that the dashboard surface will add).
   * - `subsystem-verify`: deferred to slice 5 (requires job-scheduler
   *   onComplete wiring).
   *
   * dedupKey is treated as an idempotency key — a retry with the same
   * key returns the same result with X-Idempotent-Replay: 1.
   */
  router.post(
    '/shared-state/resolve/:id',
    rateLimiter(60_000, 60),
    async (req, res) => {
      if (v2Disabled(req, res)) return;

      const ibConfig = ctx.config.integratedBeing ?? {};
      const resolutionEnabled = ibConfig.resolutionEnabled === true;
      if (!resolutionEnabled) {
        res.setHeader('X-Disabled', 'resolution');
        res.status(503).json({ error: 'resolution workflow disabled' });
        return;
      }

      // ── Session auth ─────────────────────────────────────────────
      const sessionId = String(req.header('x-instar-session-id') ?? '').trim();
      const token = String(req.header('x-instar-session-token') ?? '').trim();
      if (!sessionId || !token) {
        res.status(401).json({ error: 'Missing X-Instar-Session-Id or X-Instar-Session-Token' });
        return;
      }
      const vverify = ctx.ledgerSessionRegistry!.verify(sessionId, token);
      if (!vverify.ok) {
        res.status(401).json({ error: 'Session binding invalid', reason: vverify.reason });
        return;
      }

      // ── Body validation ──────────────────────────────────────────
      const commitmentId = String(req.params.id || '').trim();
      if (!/^[0-9a-f]{12}$/.test(commitmentId)) {
        res.status(400).json({ error: 'Invalid commitment id' });
        return;
      }
      const body = (req.body ?? {}) as {
        resolution?: unknown;
        outcome?: unknown;
        note?: unknown;
        evidenceRef?: unknown;
        disputeReason?: unknown;
        dedupKey?: unknown;
      };
      const resolution = typeof body.resolution === 'string' ? body.resolution : '';
      const validResolutions = ['self-assert', 'dispute', 'user-resolve', 'subsystem-verify'];
      if (!validResolutions.includes(resolution)) {
        res.setHeader('X-Invalid-Field', 'resolution');
        res.status(400).json({
          error: `resolution must be one of: ${validResolutions.join(' | ')}`,
        });
        return;
      }
      if (resolution === 'user-resolve' || resolution === 'subsystem-verify') {
        res.setHeader('X-Pending-Slice', resolution === 'user-resolve' ? '6' : '5');
        res.status(501).json({
          error: `resolution type '${resolution}' pending a later slice`,
        });
        return;
      }
      const dedupKey = typeof body.dedupKey === 'string' ? body.dedupKey : '';
      if (!dedupKey || dedupKey.length > 200 || !/^[a-zA-Z0-9\-_.:]+$/.test(dedupKey)) {
        res.setHeader('X-Invalid-Field', 'dedupKey');
        res.status(400).json({
          error: 'dedupKey required, [a-zA-Z0-9-_.:], max 200 chars',
        });
        return;
      }

      // ── Fetch commitment entry ───────────────────────────────────
      let chain;
      try {
        chain = await ctx.sharedStateLedger!.walkChain(commitmentId);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const commitmentEntry = chain[0];
      if (!commitmentEntry) {
        res.status(404).json({ error: 'commitment not found' });
        return;
      }
      if (commitmentEntry.kind !== 'commitment') {
        res.status(400).json({ error: 'target entry is not a commitment' });
        return;
      }
      const mechanismType =
        commitmentEntry.commitment?.mechanism?.type ?? 'user-driven';

      // ── Idempotency check (AFTER commitment-fetch; keyed on tuple) ─
      // Keyed on (sessionId, commitmentId, dedupKey) so a replay from
      // the SAME session against the SAME commitment returns the cached
      // result, while any cross-session / cross-commitment lookup misses
      // and re-runs authorization + write. Per-session authorization
      // still runs BEFORE the cache lookup (we've verified the session
      // binding above).
      const cached = ctx.ledgerSessionRegistry!.getIdempotent(
        sessionId,
        commitmentId,
        dedupKey,
      );
      if (cached) {
        res.setHeader('X-Idempotent-Replay', '1');
        res.json(cached);
        return;
      }

      // ── Per-resolution-type authorization + action ───────────────
      if (resolution === 'self-assert') {
        if (commitmentEntry.emittedBy.instance !== sessionId) {
          res.status(403).json({
            error: 'self-assert requires the original creator session',
            reason: 'creator-mismatch',
          });
          return;
        }
        const outcome = typeof body.outcome === 'string' ? body.outcome : '';
        if (outcome !== 'success' && outcome !== 'failure') {
          res.setHeader('X-Invalid-Field', 'outcome');
          res.status(400).json({
            error: "self-assert requires outcome: 'success' | 'failure'",
          });
          return;
        }
        const note = typeof body.note === 'string' ? body.note.slice(0, 400) : undefined;
        const evidenceRef =
          typeof body.evidenceRef === 'string' ? body.evidenceRef.slice(0, 200) : undefined;
        const subject = `${outcome === 'success' ? 'resolved' : 'cancelled'}: ${commitmentEntry.subject}`.slice(0, 200);
        const appended = await ctx.sharedStateLedger!.append({
          emittedBy: { subsystem: 'session', instance: sessionId },
          kind: 'note',
          subject,
          summary: note,
          counterparty: {
            type: commitmentEntry.counterparty.type,
            name: commitmentEntry.counterparty.name,
            trustTier: 'untrusted',
          },
          supersedes: commitmentEntry.id,
          provenance: 'session-asserted',
          dedupKey,
        });
        if (!appended) {
          res.setHeader('X-Dedup-Or-Fail', '1');
          res.status(409).json({ error: 'dedupKey collision or fail-open' });
          return;
        }
        const payload = {
          id: appended.id,
          t: appended.t,
          resolution: 'self-assert',
          outcome,
          tier: 'self-asserted',
          evidenceRef,
        };
        ctx.ledgerSessionRegistry!.recordCommitmentClosed(
          commitmentEntry.emittedBy.instance,
          mechanismType,
        );
        ctx.ledgerSessionRegistry!.rememberIdempotent(sessionId, commitmentId, dedupKey, payload);
        res.json(payload);
        return;
      }

      if (resolution === 'dispute') {
        const disputeLimit = Math.max(1, ibConfig.disputesPerSessionPerHour ?? 10);
        const capReason = ctx.ledgerSessionRegistry!.checkDisputeRate(sessionId, disputeLimit);
        if (capReason) {
          res.setHeader('X-Cap-Reason', capReason);
          res.status(429).json({ error: 'dispute rate exceeded', reason: capReason });
          return;
        }
        const disputeReason =
          typeof body.disputeReason === 'string' ? body.disputeReason.slice(0, 200) : '';
        if (!disputeReason) {
          res.setHeader('X-Invalid-Field', 'disputeReason');
          res.status(400).json({ error: 'disputeReason required for dispute resolution' });
          return;
        }
        const appended = await ctx.sharedStateLedger!.append({
          emittedBy: { subsystem: 'session', instance: sessionId },
          kind: 'note',
          subject: `disputed: ${disputeReason}`.slice(0, 200),
          counterparty: {
            type: commitmentEntry.counterparty.type,
            name: commitmentEntry.counterparty.name,
            trustTier: 'untrusted',
          },
          // disputes: separate field, NOT supersedes — avoids the depth-16
          // data-hiding vector called out in spec §4 iter 2 (Gemini).
          disputes: commitmentEntry.id,
          provenance: 'session-asserted',
          dedupKey,
        });
        if (!appended) {
          res.setHeader('X-Dedup-Or-Fail', '1');
          res.status(409).json({ error: 'dedupKey collision or fail-open' });
          return;
        }
        ctx.ledgerSessionRegistry!.recordDispute(sessionId);
        const payload = { id: appended.id, t: appended.t, resolution: 'dispute' };
        ctx.ledgerSessionRegistry!.rememberIdempotent(sessionId, commitmentId, dedupKey, payload);
        res.json(payload);
        return;
      }

      // Unreachable — all resolution types handled above.
      res.status(500).json({ error: 'unreachable resolution branch' });
    }
  );

  /**
   * GET /shared-state/sessions — slice 7
   *
   * Returns the list of registered sessions (redacted: no tokenHash,
   * no plaintext token). Bearer-token gated by the global middleware.
   * Used by the dashboard Bindings subtab.
   */
  router.get(
    '/shared-state/sessions',
    rateLimiter(60_000, 60),
    async (req, res) => {
      if (v2Disabled(req, res)) return;
      try {
        const sessions = ctx.ledgerSessionRegistry!.listSessions();
        res.json({ sessions });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  );

  /**
   * POST /shared-state/sessions/:sid/revoke — slice 7
   *
   * Marks a session's binding revoked. Requires the X-Instar-Request: 1
   * header alongside bearer auth — same convention used by other
   * user-authoritative actions (backup triggers, config edits). This
   * provides a minimal user-intent attestation without requiring full
   * PIN-unlock infrastructure (which is deferred for user-resolve but
   * not needed here — revocation is idempotent and bounded by session
   * registration, not state-shaping).
   *
   * Emits a subsystem-asserted note entry "session binding revoked:
   * <sid>" so the audit trail preserves the action.
   */
  router.post(
    '/shared-state/sessions/:sid/revoke',
    rateLimiter(60_000, 20),
    async (req, res) => {
      if (v2Disabled(req, res)) return;
      const userIntent = String(req.header('x-instar-request') ?? '').trim();
      if (userIntent !== '1') {
        res.status(403).json({
          error:
            'revocation requires X-Instar-Request: 1 header (user-intent attestation)',
          reason: 'missing-user-intent',
        });
        return;
      }
      const sid = String(req.params.sid || '').trim();
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sid)) {
        res.status(400).json({ error: 'Invalid sessionId format' });
        return;
      }
      const registry = ctx.ledgerSessionRegistry!;
      const existed = registry.revoke(sid);
      if (!existed) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      // Audit note — subsystem-asserted; visible in the dashboard
      // stream next to the session binding history.
      try {
        await ctx.sharedStateLedger!.append({
          emittedBy: {
            subsystem: 'session-manager',
            instance: ctx.config.projectName ?? 'server',
          },
          kind: 'note',
          subject: `session binding revoked: ${sid}`,
          counterparty: {
            type: 'self',
            name: 'self',
            trustTier: 'trusted',
          },
          provenance: 'subsystem-asserted',
          dedupKey: `integrated-being-v2:session-revoke:${sid}:${Date.now()}`,
        });
      } catch {
        /* audit note is best-effort; revocation itself succeeded */
      }
      res.json({ revoked: true, sessionId: sid });
    }
  );

  /**
   * POST /shared-state/session-bind-confirm
   *
   * Called by the session-start hook AFTER the file-based handoff has
   * completed (token file written with mode 0o600 + .ready marker). The
   * server clears the hook-in-progress flag, which closes the window
   * for the session-bind-interactive fallback on this session id.
   *
   * Request body: { sessionId }
   * Response 200: { confirmed: true }
   * Response 400: malformed or missing sessionId
   * Response 503: v2 disabled
   */
  router.post(
    '/shared-state/session-bind-confirm',
    rateLimiter(60_000, 30),
    async (req, res) => {
      if (v2Disabled(req, res)) return;
      const body = (req.body ?? {}) as { sessionId?: unknown };
      const sessionId =
        typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }
      ctx.ledgerSessionRegistry!.confirmHookDone(sessionId);
      res.json({ confirmed: true });
    }
  );

  /**
   * POST /shared-state/session-bind-interactive
   *
   * Attestation-gated fallback for when the file-based handoff fails
   * (e.g. filesystem mode verification error, read-only FS, race with
   * a cleanup). The session polls the `.ready` marker, times out at 5s,
   * then calls this endpoint.
   *
   * Gate conditions (spec §3 iter 2) — BOTH required:
   *   1. The session has a hook-in-progress flag set within 30s of
   *      its session-bind call.
   *   2. The session has NOT already been issued a binding token via
   *      any path (hasEverBeenBound check).
   *
   * The gate ensures a bearer-token holder cannot mint a binding
   * token without first posing as the session-start hook (requires
   * being the session's actual parent process) AND the file path
   * having failed first. The 0o600 boundary remains primary.
   *
   * Request body: { sessionId }
   * Response 200: { token, absoluteExpiresAt, idleExpiresAt }
   * Response 400: malformed or missing sessionId
   * Response 403: attestation failed (no hook-in-progress, or already-bound)
   * Response 503: v2 disabled
   */
  router.post(
    '/shared-state/session-bind-interactive',
    rateLimiter(60_000, 10),
    async (req, res) => {
      if (v2Disabled(req, res)) return;
      const body = (req.body ?? {}) as { sessionId?: unknown };
      const sessionId =
        typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }

      const registry = ctx.ledgerSessionRegistry!;
      // Attestation: the hook-in-progress flag alone is the gate. Its
      // presence means (a) a session-bind call happened in the last 30s
      // AND (b) no session-bind-confirm or prior interactive bind has
      // cleared it. Single-use is enforced by clearing the flag on
      // success — a replay attempts lands on "attestation-missing".
      if (!registry.isHookInProgress(sessionId)) {
        res.status(403).json({
          error: 'no live hook-in-progress flag for this session',
          reason: 'attestation-missing',
        });
        return;
      }

      // Re-issue the token against the existing registration (which
      // session-bind already created). Preserves anchored absolute TTL.
      const reissue = registry.reissueForInteractive(sessionId);
      if (!reissue.ok) {
        const status =
          reissue.reason === 'revoked' || reissue.reason === 'absolute-expired'
            ? 403
            : reissue.reason === 'malformed'
            ? 400
            : 404;
        res.status(status).json({
          error: 'interactive re-issue failed',
          reason: reissue.reason,
        });
        return;
      }
      // Single-use: clear the flag so replays return 403.
      registry.confirmHookDone(sessionId);

      res.setHeader('Cache-Control', 'no-store');
      res.json({
        sessionId: reissue.result.sessionId,
        token: reissue.result.token,
        absoluteExpiresAt: reissue.result.absoluteExpiresAt,
        idleExpiresAt: reissue.result.idleExpiresAt,
      });
    }
  );

  /**
   * POST /shared-state/session-bind-rotate
   *
   * Rotates a session's binding token. Requires the current valid token
   * (anti-takeover: an attacker without the current token cannot rotate).
   * The anchored absolute TTL is NOT extended — rotation refreshes idle
   * TTL only. Past absolute-TTL sessions get a 403; the caller must
   * start a fresh sessionId.
   *
   * Request body: { sessionId }
   * Headers: X-Instar-Session-Token (the CURRENT valid token)
   * Response 200: { token, absoluteExpiresAt, idleExpiresAt }
   * Response 401: invalid current token
   * Response 403: session revoked or absolute TTL exhausted
   * Response 503: v2 disabled
   */
  router.post(
    '/shared-state/session-bind-rotate',
    rateLimiter(60_000, 10),
    async (req, res) => {
      if (v2Disabled(req, res)) return;
      const body = (req.body ?? {}) as { sessionId?: unknown };
      const sessionId =
        typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const currentToken = String(req.header('x-instar-session-token') ?? '').trim();
      if (!sessionId || !currentToken) {
        res.status(400).json({
          error: 'sessionId (body) and X-Instar-Session-Token (header) required',
        });
        return;
      }
      const result = ctx.ledgerSessionRegistry!.rotate(sessionId, currentToken);
      if (!result.ok) {
        const status =
          result.reason === 'revoked' || result.reason === 'absolute-expired'
            ? 403
            : 401;
        res.status(status).json({
          error: 'rotation failed',
          reason: result.reason,
        });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        sessionId: result.result.sessionId,
        token: result.result.token,
        absoluteExpiresAt: result.result.absoluteExpiresAt,
        idleExpiresAt: result.result.idleExpiresAt,
      });
    }
  );

  // ── Provider portability v1.0.0 — Phase 5 inspection endpoints ────────
  //
  // Test-friendly handles that exercise the cost-aware routing policy,
  // cost-state tracker, and framework-model router via HTTP. These are
  // load-bearing for the test-driver-as-self pattern (see
  // .claude/scripts/run-v1-scenarios.py + .instar/scenarios/v1.0.0/).
  //
  // The endpoints construct ephemeral policy/tracker/router instances
  // per call with the parameters in the query string. They do NOT
  // depend on adapters being registered against the global Registry —
  // production-adapter registration is tracked separately.

  router.get('/providers/routing/decide', async (req, res) => {
    try {
      const mod = await import('../providers/costAwareRouting.js');
      const { CostAwareRoutingPolicy } = mod;

      const fakeUnknown = String(req.query.fakeUnknown ?? '') === '1';
      const parseNum = (v: unknown): number | null => {
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const fakeRemaining = parseNum(req.query.fakeRemainingUsd);
      const fakeTotal = parseNum(req.query.fakeTotalUsd);
      // Reject mid-call if the caller supplied non-numeric parse errors —
      // surfacing the issue beats silently routing to a degraded branch.
      if (req.query.fakeRemainingUsd != null && fakeRemaining === null) {
        res.status(400).json({ error: 'fakeRemainingUsd must be a finite number' });
        return;
      }
      if (req.query.fakeTotalUsd != null && fakeTotal === null) {
        res.status(400).json({ error: 'fakeTotalUsd must be a finite number' });
        return;
      }
      const candidatesParam = String(req.query.candidates ?? '');

      const sdkId = 'anthropic-headless';
      const subId = 'anthropic-interactive-pool';
      const fakeAdapter = (id: string) => ({
        id,
        capabilities: new Set(),
        primitive: () => null,
      });

      const candidateIds = candidatesParam
        ? candidatesParam.split(',').map((s) => s.trim()).filter(Boolean)
        : [sdkId, subId];
      const candidateAdapters = candidateIds.map((id) => fakeAdapter(id));

      const readSdkCredit = async () => {
        if (fakeUnknown) return null;
        if (fakeRemaining != null && fakeTotal != null) {
          return {
            remainingUsd: fakeRemaining,
            totalUsd: fakeTotal,
            resetsAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
            overageEnabled: false,
          };
        }
        return null;
      };

      const policy = new CostAwareRoutingPolicy({
        readSdkCredit,
        sdkCreditAdapterId: sdkId as never,
        subscriptionAdapterId: subId as never,
      });

      let decision;
      try {
        decision = await policy.decide(
          candidateAdapters as never,
          { requires: [] } as never,
        );
      } catch (err) {
        const chosen = candidateAdapters[0]?.id ?? null;
        decision = {
          chosen,
          reason: `cost-aware-policy-deferred-to-fallback: ${(err as Error).message}`,
          fallbacks: [],
        };
      }
      res.json(decision);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/providers/cost-state/diff', async (req, res) => {
    try {
      const mod = await import('../providers/costAwareRouting.js');
      const { CostStateTracker } = mod;

      const parseFiniteOr400 = (key: string, defaultVal = 0): number | null => {
        const raw = req.query[key];
        if (raw == null) return defaultVal;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      };
      const priorRemaining = parseFiniteOr400('priorRemainingUsd');
      const priorTotal = parseFiniteOr400('priorTotalUsd');
      const currentRemaining = parseFiniteOr400('currentRemainingUsd');
      const currentTotal = parseFiniteOr400('currentTotalUsd');
      if (priorRemaining === null || priorTotal === null ||
          currentRemaining === null || currentTotal === null) {
        res.status(400).json({ error: 'all *RemainingUsd / *TotalUsd query params must be finite numbers' });
        return;
      }

      // Build two ad-hoc snapshots and compare. Tracker's snapshot()
      // would re-call readSdkCredit; we shortcut by constructing the
      // CostStateSnapshot shape directly.
      const margin = 0.10;
      const mkSnap = (remaining: number, total: number) => ({
        capturedAt: new Date().toISOString(),
        agentSdkCredit: total > 0 ? {
          remainingUsd: remaining,
          totalUsd: total,
          safetyMarginUsd: margin * total,
          belowMargin: remaining <= margin * total,
          consumedFraction: 1 - remaining / total,
        } : null,
      });

      const tracker = new CostStateTracker({
        readSdkCredit: async () => null,
      });
      const reason = tracker.isMaterialShift(
        mkSnap(priorRemaining, priorTotal),
        mkSnap(currentRemaining, currentTotal),
      );
      res.json({ materialShift: reason !== null, reason });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/providers/framework-router/route', async (req, res) => {
    try {
      const taskPrompt = String(req.query.taskPrompt ?? '');
      const userId = String(req.query.userId ?? 'v1-scenario');
      if (!taskPrompt) {
        res.status(400).json({ error: 'taskPrompt is required' });
        return;
      }

      const { FrameworkModelRouter } = await import('../providers/uxConfirm/FrameworkModelRouter.js');
      const { TaskClassifier } = await import('../providers/uxConfirm/TaskClassifier.js');
      const { OverrideDetector } = await import('../providers/uxConfirm/OverrideDetector.js');
      const { TelegramConfirmer } = await import('../providers/uxConfirm/TelegramConfirmer.js');
      const { StaticCatalogProvider } = await import('../providers/uxConfirm/StaticCatalogProvider.js');
      const { CostStateTracker } = await import('../providers/costAwareRouting.js');

      // Stub IntelligenceProvider — test-mode never needs real LLM judgment.
      const stubIntelligence = {
        async evaluate(): Promise<string> { return ''; },
      };

      // In-memory PreferenceStore stub. Sidesteps the real PreferenceStore's
      // dependency on better-sqlite3, which is often a missing/mis-built
      // native module on agents that haven't run npm rebuild after a Node
      // upgrade (e.g., deep-signal as of this session). The stub satisfies
      // the same get/set/clear surface the FrameworkModelRouter consumes.
      const memStore = new Map<string, unknown>();
      const stubStore = {
        get(userId: string, taskPattern: string) {
          return (memStore.get(`${userId}::${taskPattern}`) as never) ?? null;
        },
        set(userId: string, taskPattern: string, preference: unknown) {
          memStore.set(`${userId}::${taskPattern}`, preference);
        },
        clear(userId: string, taskPattern: string) {
          memStore.delete(`${userId}::${taskPattern}`);
        },
      };

      const KNOWN_FRAMEWORKS = ['claude-code', 'codex-cli', 'gemini-cli'];
      const KNOWN_MODELS = [
        'opus-4.7', 'sonnet-4.6', 'haiku-4.5',
        'gpt-5.3-codex', 'gemini-2.5-flash', 'gemini-2.5-pro', 'deepseek-v4',
      ];

      const classifier = new TaskClassifier({ intelligence: stubIntelligence });
      const overrideDetector = new OverrideDetector({
        intelligence: stubIntelligence,
        knownFrameworks: KNOWN_FRAMEWORKS,
        knownModels: KNOWN_MODELS,
      });
      const store = stubStore;
      const catalog = new StaticCatalogProvider();
      const costStateTracker = new CostStateTracker({ readSdkCredit: async () => null });
      const noopTransport = {
        async send(): Promise<void> { /* no-op */ },
        async awaitReply(): Promise<string | null> { return null; },
      };
      const confirmer = new TelegramConfirmer({
        transport: noopTransport,
        overrideDetector,
      });

      const router2 = new FrameworkModelRouter({
        classifier,
        // Test-mode in-memory store satisfies the surface FrameworkModelRouter
        // consumes (get/set/clear); cast avoids dragging PreferenceStore's
        // internal db/schema fields into the stub.
        store: store as unknown as import('../providers/uxConfirm/PreferenceStore.js').PreferenceStore,
        confirmer,
        costStateTracker,
        catalog,
      });

      const result = await router2.route({
        userId,
        taskPrompt,
        taskDescription: taskPrompt.slice(0, 80),
        telegramTopicId: null,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message, stack: (err as Error).stack });
    }
  });
  // ─── TaskFlow registry (OpenClaw import — Phase 1) ──────────────────
  // Admin Bearer-token auth via global authMiddleware. The HTTP API exists for
  // debugging and out-of-process tooling; production controllers run
  // in-process inside the server and call the registry directly.
  // See docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md.
  {
    const taskFlowError = (
      res: ExpressResponse,
      err: unknown
    ): void => {
      const e = err as { name?: string; code?: string; message?: string; detail?: Record<string, unknown> };
      if (e?.name !== 'TaskFlowError') {
        res.status(500).json({ error: 'internal_error', message: e?.message });
        return;
      }
      const status = ({
        not_found: 404,
        revision_conflict: 409,
        already_terminal: 410,
        invalid_transition: 422,
        invalid_argument: 422,
        unauthorized_controller: 422,
        already_consumed: 422,
        wait_collision: 422,
        quota_exceeded: 429,
      } as Record<string, number>)[e.code ?? ''] ?? 500;
      // Phase 5: rate-limit responses surface Retry-After header for HTTP-compliant
      // clients in addition to the in-body retryAfterMs hint. RFC 7231 § 7.1.3
      // specifies seconds; we round UP so a sub-second retry maps to 1.
      if (status === 429 && typeof (e.detail as any)?.retryAfterMs === 'number') {
        const retryAfterMs = (e.detail as any).retryAfterMs as number;
        const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        try { res.setHeader('Retry-After', String(seconds)); } catch { /* swallow */ }
      }
      res.status(status).json({ error: e.code, ...(e.detail ?? {}), message: e.message });
    };

    router.post('/flows', async (req, res) => {
      if (!ctx.taskFlowRegistry) {
        res.status(503).json({ error: 'taskflow_not_enabled' });
        return;
      }
      try {
        const out = await ctx.taskFlowRegistry.createFlow(req.body ?? {});
        res.status(out.created ? 201 : 200).json(out.flow);
      } catch (err) {
        if (err instanceof Error) taskFlowError(res, err);
        else res.status(500).json({ error: 'internal_error' });
      }
    });

    router.get('/flows/:flowId', (req, res) => {
      if (!ctx.taskFlowRegistry) {
        res.status(503).json({ error: 'taskflow_not_enabled' });
        return;
      }
      const flow = ctx.taskFlowRegistry.getFlow(req.params.flowId);
      if (!flow) {
        res.status(404).json({ error: 'not_found', flowId: req.params.flowId });
        return;
      }
      // The owning controller may identify itself via header to receive the
      // unredacted record. Otherwise we return the redacted shape (no
      // stateJson, waitJson reduced to {kind}).
      const callerControllerId = req.header('x-taskflow-controller-id');
      if (callerControllerId && callerControllerId === flow.controllerId) {
        res.json(flow);
        return;
      }
      res.json(ctx.taskFlowRegistry.getRedactedFlow(req.params.flowId));
    });

    router.get('/flows/waiting', (req, res) => {
      if (!ctx.taskFlowRegistry) {
        res.status(503).json({ error: 'taskflow_not_enabled' });
        return;
      }
      const channel = typeof req.query.channel === 'string' ? req.query.channel : undefined;
      const threadId = typeof req.query.threadId === 'string' ? req.query.threadId : undefined;
      const peer = typeof req.query.peer === 'string' ? req.query.peer : undefined;
      const correlationId =
        typeof req.query.correlationId === 'string' ? req.query.correlationId : undefined;
      const waitKind = typeof req.query.waitKind === 'string' ? req.query.waitKind : undefined;
      if (channel && threadId && peer) {
        res.json({
          matches: ctx.taskFlowRegistry.findWaitingByReply({ channel, threadId, peer }),
        });
        return;
      }
      if (correlationId && (waitKind === 'external-call' || waitKind === 'cross-agent-callback')) {
        res.json({
          matches: ctx.taskFlowRegistry.findWaitingByCorrelation({ waitKind, correlationId }),
        });
        return;
      }
      res.status(400).json({ error: 'invalid_query', message: 'specify (channel,threadId,peer) or (correlationId,waitKind)' });
    });

    const occMutationHandler = (
      op: 'startStep' | 'setFlowWaiting' | 'resumeFlow' | 'finishFlow' | 'failFlow' | 'cancelFlow' | 'markLost'
    ) => async (req: ExpressRequest, res: ExpressResponse) => {
      if (!ctx.taskFlowRegistry) {
        res.status(503).json({ error: 'taskflow_not_enabled' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const flowId = req.params.flowId;
      const expectedRevision = Number(body.expectedRevision);
      if (!Number.isFinite(expectedRevision)) {
        res.status(422).json({ error: 'invalid_argument', field: 'expectedRevision' });
        return;
      }
      const principal = body.principal as
        | { scope: 'controller'; controllerId: string; controllerInstanceId: string }
        | { scope: 'system-waker'; wakerId: string }
        | { scope: 'admin' }
        | undefined;
      if (!principal || typeof principal !== 'object' || !('scope' in principal)) {
        res.status(422).json({ error: 'invalid_argument', field: 'principal' });
        return;
      }
      try {
        let result;
        switch (op) {
          case 'startStep':
            result = await ctx.taskFlowRegistry.startStep({
              flowId,
              expectedRevision,
              principal: principal as any,
              currentStep: String(body.currentStep ?? ''),
            });
            break;
          case 'setFlowWaiting':
            result = await ctx.taskFlowRegistry.setFlowWaiting({
              flowId,
              expectedRevision,
              principal: principal as any,
              waitJson: body.waitJson as any,
              currentStep: body.currentStep as string | undefined,
              statePatch: body.statePatch,
            });
            break;
          case 'resumeFlow':
            result = await ctx.taskFlowRegistry.resumeFlow({
              flowId,
              expectedRevision,
              principal: principal as any,
              waitInstanceId: String(body.waitInstanceId ?? ''),
              currentStep: body.currentStep as string | undefined,
              statePatch: body.statePatch,
            });
            break;
          case 'finishFlow':
            result = await ctx.taskFlowRegistry.finishFlow({
              flowId,
              expectedRevision,
              principal: principal as any,
              result: body.result,
            });
            break;
          case 'failFlow':
            result = await ctx.taskFlowRegistry.failFlow({
              flowId,
              expectedRevision,
              principal: principal as any,
              failureReason: String(body.failureReason ?? ''),
            });
            break;
          case 'cancelFlow':
            result = await ctx.taskFlowRegistry.cancelFlow({
              flowId,
              expectedRevision,
              principal: principal as any,
            });
            break;
          case 'markLost':
            result = await ctx.taskFlowRegistry.markLost({
              flowId,
              expectedRevision,
              ledgerEntryId: String(body.ledgerEntryId ?? ''),
              reason: body.reason === 'stranded' ? 'stranded' : 'lost',
            });
            break;
        }
        res.json(result);
      } catch (err) {
        if (err instanceof Error) taskFlowError(res, err);
        else res.status(500).json({ error: 'internal_error' });
      }
    };

    router.post('/flows/:flowId/start-step', occMutationHandler('startStep'));
    router.post('/flows/:flowId/wait', occMutationHandler('setFlowWaiting'));
    router.post('/flows/:flowId/resume', occMutationHandler('resumeFlow'));
    router.post('/flows/:flowId/finish', occMutationHandler('finishFlow'));
    router.post('/flows/:flowId/fail', occMutationHandler('failFlow'));
    router.post('/flows/:flowId/cancel-flow', occMutationHandler('cancelFlow'));
    router.post('/flows/:flowId/mark-lost', occMutationHandler('markLost'));

    router.post('/flows/:flowId/cancel-request', async (req, res) => {
      if (!ctx.taskFlowRegistry) {
        res.status(503).json({ error: 'taskflow_not_enabled' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const expectedRevision = Number(body.expectedRevision);
      if (!Number.isFinite(expectedRevision)) {
        res.status(422).json({ error: 'invalid_argument', field: 'expectedRevision' });
        return;
      }
      try {
        const result = await ctx.taskFlowRegistry.requestFlowCancel({
          flowId: req.params.flowId,
          expectedRevision,
          requesterOrigin: body.requesterOrigin as any,
        });
        res.json(result);
      } catch (err) {
        if (err instanceof Error) taskFlowError(res, err);
        else res.status(500).json({ error: 'internal_error' });
      }
    });

    router.post('/flows/:flowId/ping', async (req, res) => {
      if (!ctx.taskFlowRegistry) {
        res.status(503).json({ error: 'taskflow_not_enabled' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const principal = body.principal as
        | { scope: 'controller'; controllerId: string; controllerInstanceId: string }
        | undefined;
      if (!principal || principal.scope !== 'controller') {
        res.status(422).json({ error: 'invalid_argument', field: 'principal' });
        return;
      }
      try {
        const flow = await ctx.taskFlowRegistry.pingFlow({
          flowId: req.params.flowId,
          principal,
        });
        res.json(flow);
      } catch (err) {
        if (err instanceof Error) taskFlowError(res, err);
        else res.status(500).json({ error: 'internal_error' });
      }
    });
  }

  return router;
}

export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
