/**
 * TaskFlow — types and constants.
 *
 * Imported from OpenClaw's task-flow-registry shape, trimmed for Instar v1
 * (single-writer; managed-only; no `blocked` status).
 *
 * See docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md for full design.
 */

import { z } from 'zod';
import type { PrivacyScopeType } from '../core/types.js';

export type TaskFlowStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'lost';

export const TERMINAL_STATUSES: ReadonlySet<TaskFlowStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'lost',
]);

export type WaitKind =
  | 'reply'
  | 'human-review'
  | 'external-call'
  | 'scheduled-tick'
  | 'cross-agent-callback';

export type WaitJson =
  | { kind: 'reply'; channel: string; threadId: string; peer: string }
  | { kind: 'human-review'; question: string; topicId?: number; reviewerId?: string }
  | { kind: 'external-call'; serviceId: string; correlationId: string; deadline?: number }
  | { kind: 'scheduled-tick'; dueAt: number; jobSlug?: string }
  | {
      kind: 'cross-agent-callback';
      threadId: string;
      correlationId: string;
      expectedAgentId: string;
    };

export type RequesterOrigin = {
  kind: 'user' | 'agent' | 'system' | 'job';
  id: string;
  channel?: string;
};

export type SupersededRef = {
  kind: 'ledger-note';
  ledgerEntryId: string;
  reason: 'lost' | 'stranded' | 'manual-supersede';
};

export type TaskNotifyPolicy =
  | { kind: 'silent' }
  | { kind: 'on-wait'; topicId: number }
  | { kind: 'on-terminal'; topicId: number }
  | { kind: 'on-wait-and-terminal'; topicId: number };

export interface TaskFlowRecord {
  flowId: string;
  ownerKey: string;
  requesterOrigin?: RequesterOrigin;
  controllerId: string;
  controllerInstanceId: string;
  controllerHeartbeatAt: number;
  revision: number;
  status: TaskFlowStatus;
  notifyPolicy: TaskNotifyPolicy;
  goal: string;
  currentStep?: string;
  stateJson?: unknown;
  waitJson?: WaitJson;
  waitInstanceId?: string;
  waitStartedAt?: number;
  cancelRequestedAt?: number;
  cancelRequestedBy?: RequesterOrigin;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  supersededBy?: SupersededRef;
  privacyScope?: PrivacyScopeType;
}

// ---------- size limits ----------

export const MAX_OWNER_KEY_CHARS = 256;
export const MAX_GOAL_CHARS = 1024;
export const MAX_CURRENT_STEP_CHARS = 128;
export const MAX_STATE_JSON_BYTES = 64 * 1024;
export const MAX_WAIT_JSON_BYTES = 8 * 1024;

// ---------- defaults ----------

export const DEFAULT_THRESHOLDS = {
  RUNNING_LOST_MS: 6 * 60 * 60 * 1000, // 6h
  REPLY_LOST_MS: 7 * 24 * 60 * 60 * 1000, // 7d
  HUMAN_REVIEW_LOST_MS: 30 * 24 * 60 * 60 * 1000, // 30d
  EXTERNAL_LOST_MS: 7 * 24 * 60 * 60 * 1000, // 7d
  EXTERNAL_GRACE_MS: 60 * 60 * 1000, // 1h
  XAGENT_LOST_MS: 7 * 24 * 60 * 60 * 1000, // 7d
} as const;

export const HEARTBEAT_INTERVAL_MS = 60 * 1000;
export const SWEEPER_INTERVAL_MS = 60 * 60 * 1000; // hourly
export const DUE_WAKER_INTERVAL_MS = 60 * 1000; // every minute
export const MAX_CACHE_ENTRIES = 1000;
export const MAX_BUSY_RETRIES = 5;
export const BUSY_BASE_DELAY_MS = 50;
export const BUSY_CAP_DELAY_MS = 5000;

export const RESERVED_MAINTENANCE_CONTROLLER = 'TaskFlowMaintenance';

// ---------- Phase 5: rate limits + cache cap defaults ----------
// Spec § Threat Model lines 679, 685; § Phase 5 line 650-653.

export const DEFAULT_CREATE_PER_SEC_PER_CONTROLLER = 10;
export const DEFAULT_MAX_ACTIVE_PER_CONTROLLER = 50;
export const DEFAULT_PING_PER_MIN_PER_FLOW = 60;
export const DEFAULT_CACHE_MAX_ENTRIES = MAX_CACHE_ENTRIES;

export interface RateLimitConfig {
  /** Max createFlow calls per second per controllerId. Default 10. Set Infinity to disable. */
  createPerSecPerController: number;
  /** Max non-terminal flows per controllerId. Default 50. Set Infinity to disable. */
  maxActivePerController: number;
  /** Max pingFlow calls per minute per flowId. Default 60. Set Infinity to disable. */
  pingPerMinPerFlow: number;
}

export interface CacheConfig {
  /** Cache cap; on overflow LRU eviction. Default 1000. */
  maxEntries: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  createPerSecPerController: DEFAULT_CREATE_PER_SEC_PER_CONTROLLER,
  maxActivePerController: DEFAULT_MAX_ACTIVE_PER_CONTROLLER,
  pingPerMinPerFlow: DEFAULT_PING_PER_MIN_PER_FLOW,
};

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxEntries: DEFAULT_CACHE_MAX_ENTRIES,
};

/** Active (non-terminal) flow statuses for max-active-per-controller bookkeeping. */
export const ACTIVE_STATUSES: ReadonlyArray<TaskFlowStatus> = ['queued', 'running', 'waiting'];

// ---------- error shapes ----------

export type TaskFlowErrorCode =
  | 'not_found'
  | 'revision_conflict'
  | 'already_terminal'
  | 'invalid_transition'
  | 'invalid_argument'
  | 'unauthorized_controller'
  | 'already_consumed'
  | 'wait_collision'
  | 'quota_exceeded';

export class TaskFlowError extends Error {
  code: TaskFlowErrorCode;
  detail: Record<string, unknown>;
  constructor(code: TaskFlowErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TaskFlowError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------- principal scope (auth) ----------

export type TaskFlowPrincipal =
  | { scope: 'controller'; controllerId: string; controllerInstanceId: string }
  | { scope: 'system-waker'; wakerId: string }
  | { scope: 'admin' };

// ---------- zod schemas ----------

const requesterOriginSchema = z.object({
  kind: z.enum(['user', 'agent', 'system', 'job']),
  id: z.string().min(1).max(256),
  channel: z.string().max(256).optional(),
});

const notifyPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('silent') }),
  z.object({ kind: z.literal('on-wait'), topicId: z.number().int() }),
  z.object({ kind: z.literal('on-terminal'), topicId: z.number().int() }),
  z.object({ kind: z.literal('on-wait-and-terminal'), topicId: z.number().int() }),
]);

export const waitJsonSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reply'),
    channel: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256),
    peer: z.string().min(1).max(256),
  }),
  z.object({
    kind: z.literal('human-review'),
    question: z.string().min(1).max(2000),
    topicId: z.number().int().optional(),
    reviewerId: z.string().max(256).optional(),
  }),
  z.object({
    kind: z.literal('external-call'),
    serviceId: z.string().min(1).max(256),
    correlationId: z.string().min(16).max(256),
    deadline: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal('scheduled-tick'),
    dueAt: z.number().int(),
    jobSlug: z.string().max(256).optional(),
  }),
  z.object({
    kind: z.literal('cross-agent-callback'),
    threadId: z.string().min(1).max(256),
    correlationId: z.string().min(16).max(256),
    expectedAgentId: z.string().min(1).max(256),
  }),
]);

export const createFlowInputSchema = z.object({
  ownerKey: z.string().min(1).max(MAX_OWNER_KEY_CHARS),
  controllerId: z.string().min(1).max(256),
  controllerInstanceId: z.string().min(1).max(256),
  idempotencyKey: z.string().min(8).max(256),
  goal: z.string().min(1).max(MAX_GOAL_CHARS),
  currentStep: z.string().max(MAX_CURRENT_STEP_CHARS).optional(),
  stateJson: z.unknown().optional(),
  notifyPolicy: notifyPolicySchema.optional(),
  requesterOrigin: requesterOriginSchema.optional(),
  privacyScope: z.enum(['private', 'shared-topic', 'shared-project']).optional(),
});

export type CreateFlowInput = z.infer<typeof createFlowInputSchema>;

export interface ApplyResult {
  applied: boolean;
  flow: TaskFlowRecord;
}

export interface WaitMatch {
  flowId: string;
  revision: number;
  waitInstanceId: string;
  controllerId: string;
  waitJson: WaitJson;
}

export interface SweeperEvalCounts {
  scanned: number;
  marked: number;
}

export interface TaskFlowThresholds {
  RUNNING_LOST_MS: number;
  REPLY_LOST_MS: number;
  HUMAN_REVIEW_LOST_MS: number;
  EXTERNAL_LOST_MS: number;
  EXTERNAL_GRACE_MS: number;
  XAGENT_LOST_MS: number;
}

export function jsonByteLength(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function isTerminalStatus(status: TaskFlowStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
