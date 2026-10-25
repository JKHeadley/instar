/**
 * Bounded, fail-closed observer for Codex inbound delivery evidence.
 *
 * It never treats a successful tmux call or composer disappearance as model
 * acceptance. Acceptance is the first complete post-baseline rollout user
 * message whose normalized full-envelope HMAC matches the durable delivery;
 * response is a later assistant message carrying that same Codex turn id.
 *
 * RULE 3.1 RATIONALE
 * Criticality: critical — a false acceptance can lose an inbound message, and
 * a false response can retire ownership while work is still live.
 * Frequency: every observer sweep for every pending Codex delivery.
 * Stability: unstable private Codex rollout JSONL and TUI composer surfaces.
 * Fallback: the rollout and composer detectors are independent and fail to the
 * typed `unknown` state on malformed, clipped, ambiguous, or drifting input;
 * unknown never authorizes recovery actuation. Bounded retries, backoff, and a
 * sustained-failure notice provide the operational recovery path.
 * Verdict: deterministic fail-closed parsing plus unit/integration/E2E
 * fixtures and the signed Stage B live canary required before activation.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { DeliveryEvidence, InboundDeliveryStore, RolloutEvent, RolloutWork } from './InboundDeliveryStore.js';
import {
  observeCodexComposerFrame,
  type CodexComposerFrame,
} from './CodexComposerAdapter.js';

export interface CodexDeliveryObserverOptions {
  store: InboundDeliveryStore;
  hmacKey: string;
  resolveRolloutPath: (delivery: DeliveryEvidence) => string | null;
  resolveRolloutId: (delivery: DeliveryEvidence) => string | null;
  capturePane: (delivery: DeliveryEvidence) => CodexComposerFrame | string | null;
  capturePaneAsync?: (delivery: DeliveryEvidence) => Promise<CodexComposerFrame | string | null>;
  bindImportedSuccessor?: (delivery: DeliveryEvidence) => boolean;
  bindLocalBootstrap?: (delivery: DeliveryEvidence) => boolean;
  onSustainedFailure?: (episode: { episodeId: string; nextAttemptAt: number }) => void;
  /** Test seam for deterministic operational-failure/backoff coverage. */
  scanRolloutWorkForTesting?: typeof scanSharedRollout;
  now?: () => number;
  maxRowsPerSweep?: number;
  maxBytesPerRow?: number;
  maxAggregateBytesPerSweep?: number;
  maxSweepMs?: number;
  captureTimeoutMs?: number;
}

export type ComposerObservation = 'present' | 'cleared' | 'unknown';

export interface CodexDeliveryObserverStatus {
  backlogBytes: number;
  oldestLagMs: number;
  budgetExhaustionCount: number;
  lastSweepAt: number | null;
  lastSweepRows: number;
  lastSweepBytes: number;
  worker: { consecutiveFailures: number; nextAttemptAt: number; episodeId: string | null; notified: boolean };
}

export class CodexDeliveryObserver {
  private readonly now: () => number;
  private readonly maxRows: number;
  private readonly maxBytes: number;
  private readonly maxAggregateBytes: number;
  private readonly maxSweepMs: number;
  private readonly captureTimeoutMs: number;
  private readonly stableEmpty = new Map<string, { frame: string; at: number }>();
  private sweeping = false;
  private sweepPromise: Promise<void> | null = null;
  private captureCursor = 0;
  private metrics: CodexDeliveryObserverStatus = {
    backlogBytes: 0, oldestLagMs: 0, budgetExhaustionCount: 0,
    lastSweepAt: null, lastSweepRows: 0, lastSweepBytes: 0,
    worker: { consecutiveFailures: 0, nextAttemptAt: 0, episodeId: null, notified: false },
  };

  constructor(private readonly opts: CodexDeliveryObserverOptions) {
    this.now = opts.now ?? Date.now;
    this.maxRows = Math.max(1, Math.min(100, opts.maxRowsPerSweep ?? 20));
    this.maxBytes = Math.max(4_096, Math.min(1024 * 1024, opts.maxBytesPerRow ?? 256 * 1024));
    this.maxAggregateBytes = Math.max(this.maxBytes, opts.maxAggregateBytesPerSweep ?? 1024 * 1024);
    this.maxSweepMs = Math.max(1, opts.maxSweepMs ?? 50);
    this.captureTimeoutMs = Math.max(1, Math.min(750, opts.captureTimeoutMs ?? 750));
  }

  sweep(): Promise<void> {
    if (this.sweepPromise) return this.sweepPromise;
    this.sweeping = true;
    this.sweepPromise = this.runSweep().finally(() => {
      this.sweeping = false;
      this.sweepPromise = null;
    });
    return this.sweepPromise;
  }

  private async runSweep(): Promise<void> {
    // Yield before any filesystem work so a monitor tick never executes the
    // rollout scanner inline on its caller's stack.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.emitPendingFailureNotices();
    if (!this.opts.store.observerSweepAllowed(this.now())) return;
    const started = this.now();
    let rowsExamined = 0;
    let bytesRead = 0;
    try {
      for (const row of this.opts.store.observableDeliveries(this.maxRows)) {
        if (row.rolloutPath === null && row.transferState === 'imported') {
          this.opts.bindImportedSuccessor?.(row);
        } else if (row.rolloutPath === null && row.transferState === 'local') {
          this.opts.bindLocalBootstrap?.(row);
        }
      }
      let backlogBytes = 0;
      let oldestDeadline: number | null = null;
      const allWork = this.opts.store.rolloutWork(Number.MAX_SAFE_INTEGER);
      for (const work of allWork) {
        const pending = pendingSharedRolloutBytes(work);
        backlogBytes += pending;
        if (pending > 0) oldestDeadline = Math.min(oldestDeadline ?? work.oldestDeadline, work.oldestDeadline);
      }
      const scheduledWork: RolloutWork[] = [];
      for (const work of allWork.slice(0, this.maxRows)) {
        if (this.now() - started >= Math.min(25, this.maxSweepMs)) break;
        scheduledWork.push(work);
      }
      const perRolloutBudget = scheduledWork.length === 0 ? 0
        : Math.min(this.maxBytes, Math.max(4_096, Math.floor(this.maxAggregateBytes / scheduledWork.length)));
      let scannedWork = 0;
      for (const work of scheduledWork) {
        if (scannedWork > 0 && this.now() - started >= Math.min(25, this.maxSweepMs)) break;
        if (bytesRead >= this.maxAggregateBytes) break;
        const scan = (this.opts.scanRolloutWorkForTesting ?? scanSharedRollout)(work, this.opts.hmacKey, perRolloutBudget);
        scannedWork += 1;
        bytesRead += scan.bytesRead;
        if (scan.kind === 'unknown') this.opts.store.markRolloutUnknown(work.rolloutId, work.rolloutPath);
        else this.opts.store.applyRolloutEvents(work, scan.events, scan.observedThrough);
      }
      const candidates = this.opts.store.observableDeliveries(this.maxRows);
      const captureCount = Math.min(4, candidates.length);
      const scheduledCaptures = Array.from({ length: captureCount }, (_, index) =>
        candidates[(this.captureCursor + index) % candidates.length]);
      if (candidates.length > 0) this.captureCursor = (this.captureCursor + captureCount) % candidates.length;
      rowsExamined = scannedWork + scheduledCaptures.length;
      await mapWithConcurrency(scheduledCaptures, 4, async (row) => {
        const pane = this.opts.capturePaneAsync
          ? await withDeadline(this.opts.capturePaneAsync(row), this.captureTimeoutMs, null)
          : undefined;
        this.observeComposerOnly(row, pane);
      });
      const scheduledKeys = new Set(scheduledCaptures.map(keyFor));
      for (const row of candidates) {
        if (!scheduledKeys.has(keyFor(row)) && this.now() >= row.observationDeadline) {
          this.opts.store.markObservationUnknown(row.conversationId, row.deliveryId);
        }
      }
      const exhausted = scannedWork < allWork.length
        || candidates.length > captureCount || bytesRead >= this.maxAggregateBytes;
      this.metrics = {
        backlogBytes,
        oldestLagMs: oldestDeadline === null ? 0 : Math.max(0, this.now() - (oldestDeadline - 15 * 60_000)),
        budgetExhaustionCount: this.metrics.budgetExhaustionCount + (exhausted ? 1 : 0),
        lastSweepAt: this.now(),
        lastSweepRows: scheduledCaptures.length,
        lastSweepBytes: bytesRead,
        worker: this.opts.store.observerWorkerStatus(),
      };
      this.opts.store.recordObserverSweepSuccess({
        startedAt: started, endedAt: this.now(), rows: rowsExamined, bytes: bytesRead,
      });
    } catch (error) { // @silent-fallback-ok: failure is durably audited, backed off, self-healed, and notified below
      const errorClass = error instanceof Error ? error.name : typeof error;
      const failure = this.opts.store.recordObserverSweepFailure({
        startedAt: started, endedAt: this.now(), rows: rowsExamined, bytes: bytesRead, errorClass,
      });
      if (failure.notify) {
        this.opts.store.observerSelfHeal();
        this.emitPendingFailureNotices();
      }
    }
  }

  private emitPendingFailureNotices(): void {
    const nextAttemptAt = this.opts.store.observerWorkerStatus().nextAttemptAt;
    for (const notice of this.opts.store.pendingObserverNotices()) {
      this.opts.onSustainedFailure?.({ episodeId: notice.episodeId, nextAttemptAt });
    }
  }

  status(): CodexDeliveryObserverStatus {
    return { ...this.metrics, worker: this.opts.store.observerWorkerStatus() };
  }

  observe(row: DeliveryEvidence, byteBudget = this.maxBytes,
    capturedPane?: CodexComposerFrame | string | null): number {
    if (row.framework !== 'codex-cli') return 0;
    const rolloutPath = row.rolloutPath ?? this.opts.resolveRolloutPath(row);
    if (!rolloutPath) {
      if (this.now() >= row.observationDeadline) this.opts.store.markObservationUnknown(row.conversationId, row.deliveryId);
      return 0;
    }
    if (row.rolloutPath === null) {
      // Late binding is safe only before any bytes can be attributed. The
      // production send path normally binds before dispatch; this is a
      // restart/migration compatibility fallback.
      let size: number;
      try { size = fs.statSync(rolloutPath).size; } catch { // @silent-fallback-ok: defer a not-yet-materialized rollout only until its durable deadline
        if (this.now() >= row.observationDeadline) {
          this.opts.store.markObservationUnknown(row.conversationId, row.deliveryId);
        }
        return 0;
      }
      const bound = row.baselineOffset >= 0
        ? this.opts.store.bindImportedRolloutPath(row.conversationId, row.deliveryId, rolloutPath)
        : (() => {
          const rolloutId = this.opts.resolveRolloutId(row);
          return rolloutId !== null
            && this.opts.store.bindRolloutBaseline(row.conversationId, row.deliveryId, rolloutPath, rolloutId, size);
        })();
      if (!bound) return 0;
      row = this.opts.store.get(row.conversationId, row.deliveryId) ?? row;
    }

    const transcript = scanRollout(row, rolloutPath, this.opts.hmacKey, byteBudget);
    if (transcript.kind === 'unknown') {
      this.opts.store.markObservationUnknown(row.conversationId, row.deliveryId);
      return transcript.bytesRead;
    }
    if (transcript.kind === 'consumed' || transcript.kind === 'responded') {
      if (row.transcriptState === 'unseen') {
        this.opts.store.recordTranscriptConsumed(row.conversationId, row.deliveryId, transcript.turnId, transcript.consumedThrough);
      }
      if (transcript.kind === 'responded') {
        this.opts.store.recordResponded(row.conversationId, row.deliveryId, transcript.turnId, transcript.observedThrough);
      }
      this.stableEmpty.delete(keyFor(row));
      return transcript.bytesRead;
    }
    if (transcript.observedThrough > row.observedOffset) {
      this.opts.store.recordScanProgress(row.conversationId, row.deliveryId, transcript.observedThrough, transcript.activeTurnId);
    }

    const pane = capturedPane === undefined ? this.opts.capturePane(row) : capturedPane;
    const composer = typeof pane === 'string'
      ? observeCodexComposer(pane, row.envelopeHmac, this.opts.hmacKey)
      : observeCodexComposerFrame(pane, row.envelopeHmac, this.opts.hmacKey);
    if (composer === 'present') {
      this.opts.store.recordComposerState(row.conversationId, row.deliveryId, 'present');
      this.stableEmpty.delete(keyFor(row));
    } else if (composer === 'cleared') {
      const key = keyFor(row);
      const frame = typeof pane === 'string' ? normalizePane(pane) : composerFrameKey(pane);
      const prior = this.stableEmpty.get(key);
      if (prior && prior.frame === frame && this.now() - prior.at >= 250) {
        this.opts.store.recordComposerState(row.conversationId, row.deliveryId, 'cleared');
      } else {
        this.stableEmpty.set(key, { frame, at: this.now() });
      }
    }
    if (this.now() >= row.observationDeadline) this.opts.store.markObservationUnknown(row.conversationId, row.deliveryId);
    return transcript.bytesRead;
  }

  private observeComposerOnly(row: DeliveryEvidence,
    capturedPane?: CodexComposerFrame | string | null): void {
    const pane = capturedPane === undefined ? this.opts.capturePane(row) : capturedPane;
    const composer = typeof pane === 'string'
      ? observeCodexComposer(pane, row.envelopeHmac, this.opts.hmacKey)
      : observeCodexComposerFrame(pane, row.envelopeHmac, this.opts.hmacKey);
    if (composer === 'present') {
      this.opts.store.recordComposerState(row.conversationId, row.deliveryId, 'present');
      this.stableEmpty.delete(keyFor(row));
    } else if (composer === 'cleared') {
      const key = keyFor(row);
      const frame = typeof pane === 'string' ? normalizePane(pane) : composerFrameKey(pane);
      const prior = this.stableEmpty.get(key);
      if (prior && prior.frame === frame && this.now() - prior.at >= 250) {
        this.opts.store.recordComposerState(row.conversationId, row.deliveryId, 'cleared');
      } else this.stableEmpty.set(key, { frame, at: this.now() });
    }
    if (this.now() >= row.observationDeadline) {
      this.opts.store.markObservationUnknown(row.conversationId, row.deliveryId);
    }
  }
}

type RolloutScan =
  | { kind: 'unseen'; observedThrough: number; activeTurnId: string | null; bytesRead: number }
  | { kind: 'unknown'; bytesRead: number }
  | { kind: 'consumed'; turnId: string; consumedThrough: number; bytesRead: number }
  | { kind: 'responded'; turnId: string; consumedThrough: number; observedThrough: number; bytesRead: number };

type SharedRolloutScan =
  | { kind: 'events'; events: RolloutEvent[]; observedThrough: number; bytesRead: number }
  | { kind: 'unknown'; bytesRead: number };

export function scanSharedRollout(work: RolloutWork, hmacKey: string, maxBytes = 256 * 1024): SharedRolloutScan {
  if (!rolloutIdentityMatches(work.rolloutPath, work.rolloutId)) return { kind: 'unknown', bytesRead: 0 };
  let stat: fs.Stats;
  try { stat = fs.statSync(work.rolloutPath); } catch {
    return { kind: 'events', events: [], observedThrough: work.observedOffset, bytesRead: 0 };
  }
  if (stat.size < work.observedOffset) return { kind: 'unknown', bytesRead: 0 };
  if (stat.size === work.observedOffset) return { kind: 'events', events: [], observedThrough: work.observedOffset, bytesRead: 0 };
  const bytes = Math.min(maxBytes, stat.size - work.observedOffset);
  const fd = fs.openSync(work.rolloutPath, 'r');
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, work.observedOffset);
  } finally { fs.closeSync(fd); }
  const lastNl = buffer.lastIndexOf(0x0a);
  if (lastNl < 0) return stat.size - work.observedOffset >= maxBytes
    ? { kind: 'unknown', bytesRead: bytes }
    : { kind: 'events', events: [], observedThrough: work.observedOffset, bytesRead: bytes };
  // A budget ending exactly on a newline is a complete, safely-advancable
  // prefix, but exact alignment is not required. When a bounded read ends in
  // the middle of the next JSONL record, advance only through `lastNl`; the
  // partial tail is re-read from its beginning on the next sweep. Only a full
  // budget with no newline is terminal uncertainty (one record itself exceeds
  // the supported bound). This distinction matters on busy sessions whose
  // otherwise-valid rollout grows by >maxBytes between sweeps.
  const events: RolloutEvent[] = [];
  let activeTurn = work.activeTurnId;
  let cursor = 0;
  while (cursor <= lastNl) {
    const nl = buffer.indexOf(0x0a, cursor);
    if (nl < 0 || nl > lastNl) break;
    const line = buffer.subarray(cursor, nl).toString('utf8');
    const through = work.observedOffset + nl + 1;
    cursor = nl + 1;
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { // @silent-fallback-ok: malformed complete JSONL is typed terminal uncertainty
      return { kind: 'unknown', bytesRead: bytes };
    }
    if (KNOWN_TOP_LEVEL.has(String(event.type))) continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.type !== 'string') return { kind: 'unknown', bytesRead: bytes };
    if (event.type === 'event_msg') {
      if (payload.type === 'task_started' || payload.type === 'task_complete') {
        const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
        if (!turnId) return { kind: 'unknown', bytesRead: bytes };
        if (payload.type === 'task_started') {
          if (activeTurn !== null) return { kind: 'unknown', bytesRead: bytes };
          activeTurn = turnId;
        } else {
          if (activeTurn !== turnId) return { kind: 'unknown', bytesRead: bytes };
          activeTurn = null;
        }
        events.push({ kind: payload.type === 'task_started' ? 'task-started' : 'task-complete', turnId, through });
      } else if (!KNOWN_EVENT_MESSAGES.has(payload.type)) return { kind: 'unknown', bytesRead: bytes };
      continue;
    }
    if (event.type === 'response_item') {
      if (payload.type !== 'message') {
        if (!KNOWN_RESPONSE_ITEMS.has(payload.type)) return { kind: 'unknown', bytesRead: bytes };
        continue;
      }
      const metadataResult = responseItemTurnMetadata(payload);
      if (!activeTurn || metadataResult.kind === 'malformed'
        || (metadataResult.kind === 'present' && metadataResult.turnId !== activeTurn)) {
        return { kind: 'unknown', bytesRead: bytes };
      }
      // Codex 0.149 stopped repeating turn_id on each response_item. The
      // generation-bound task_started/task_complete envelope remains the
      // authority; when legacy metadata is present it must still agree.
      const turnId = activeTurn;
      if (payload.role === 'user') {
        const text = extractInputText(payload.content);
        if (text === null) return { kind: 'unknown', bytesRead: bytes };
        events.push({ kind: 'user-message', turnId, envelopeHmac: hmacEnvelope(text, hmacKey), through });
      } else if (payload.role === 'assistant') events.push({ kind: 'assistant-message', turnId, through });
      else if (payload.role !== 'developer' && payload.role !== 'system') return { kind: 'unknown', bytesRead: bytes };
      continue;
    }
    if (!KNOWN_TOP_LEVEL.has(String(event.type))) return { kind: 'unknown', bytesRead: bytes };
  }
  return { kind: 'events', events, observedThrough: work.observedOffset + lastNl + 1, bytesRead: bytes };
}

const KNOWN_EVENT_MESSAGES = new Set([
  'agent_message', 'agent_reasoning', 'token_count', 'turn_aborted', 'stream_error',
  'context_compacted', 'mcp_startup_update', 'mcp_startup_complete',
  'thread_settings_applied', 'item_completed',
]);
const KNOWN_RESPONSE_ITEMS = new Set([
  'reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
  'custom_tool_call_output', 'web_search_call', 'computer_tool_call', 'computer_tool_call_output',
  'agent_message', 'tool_search_call', 'tool_search_output',
]);
const KNOWN_TOP_LEVEL = new Set([
  'session_meta', 'turn_context', 'compacted', 'world_state', 'inter_agent_communication_metadata',
]);

function responseItemTurnMetadata(payload: Record<string, unknown>):
  | { kind: 'absent' }
  | { kind: 'present'; turnId: string }
  | { kind: 'malformed' } {
  if (!Object.prototype.hasOwnProperty.call(payload, 'internal_chat_message_metadata_passthrough')) {
    return { kind: 'absent' };
  }
  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { kind: 'malformed' };
  const turnId = (metadata as Record<string, unknown>).turn_id;
  return typeof turnId === 'string' && turnId.length > 0
    ? { kind: 'present', turnId }
    : { kind: 'malformed' };
}

export function scanRollout(row: DeliveryEvidence, rolloutPath: string, hmacKey: string, maxBytes = 256 * 1024): RolloutScan {
  if (!row.rolloutId || !rolloutIdentityMatches(rolloutPath, row.rolloutId)) return { kind: 'unknown', bytesRead: 0 };
  const start = row.observedOffset;
  if (!Number.isSafeInteger(start) || start < 0) return { kind: 'unknown', bytesRead: 0 };
  let stat: fs.Stats;
  try { stat = fs.statSync(rolloutPath); } catch { return { kind: 'unseen', observedThrough: start, activeTurnId: row.scanTurnId, bytesRead: 0 }; }
  if (stat.size < start) return { kind: 'unknown', bytesRead: 0 };
  if (stat.size === start) return { kind: 'unseen', observedThrough: start, activeTurnId: row.scanTurnId, bytesRead: 0 };
  const bytes = Math.min(maxBytes, stat.size - start);
  const fd = fs.openSync(rolloutPath, 'r');
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, start);
  } finally { fs.closeSync(fd); }
  const lastNl = buffer.lastIndexOf(0x0a);
  if (lastNl < 0) return stat.size - start >= maxBytes ? { kind: 'unknown', bytesRead: bytes } : { kind: 'unseen', observedThrough: start, activeTurnId: row.scanTurnId, bytesRead: bytes };
  // A complete newline at the byte cap is not schema uncertainty. Advance the
  // complete prefix and resume the remaining JSONL on the next bounded scan;
  // an incomplete tail after that newline remains unread, not malformed.

  let activeTurn: string | null = row.transcriptState === 'consumed' ? row.turnId : row.scanTurnId;
  let consumedTurn: string | null = row.turnId;
  let assistantSeen = false;
  let consumedThrough = row.observedOffset;
  let cursor = 0;
  while (cursor <= lastNl) {
    const nl = buffer.indexOf(0x0a, cursor);
    if (nl < 0 || nl > lastNl) break;
    const line = buffer.subarray(cursor, nl).toString('utf8');
    const through = start + nl + 1;
    cursor = nl + 1;
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { // @silent-fallback-ok: legacy direct scanner also fails closed
      return { kind: 'unknown', bytesRead: bytes };
    }
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.type !== 'string') continue;
    if (event.type === 'event_msg' && payload.type === 'task_started') {
      activeTurn = typeof payload.turn_id === 'string' ? payload.turn_id : null;
      if (!activeTurn) return { kind: 'unknown', bytesRead: bytes };
      continue;
    }
    if (event.type === 'event_msg' && payload.type === 'task_complete') {
      const completedTurn = typeof payload.turn_id === 'string' ? payload.turn_id : null;
      if (!completedTurn || !activeTurn || completedTurn !== activeTurn) return { kind: 'unknown', bytesRead: bytes };
      if (consumedTurn === completedTurn && assistantSeen) {
        return { kind: 'responded', turnId: completedTurn, consumedThrough, observedThrough: through, bytesRead: bytes };
      }
      activeTurn = null;
      continue;
    }
    if (event.type !== 'response_item' || payload.type !== 'message') continue;
    const metadataResult = responseItemTurnMetadata(payload);
    if (!activeTurn || metadataResult.kind === 'malformed'
      || (metadataResult.kind === 'present' && metadataResult.turnId !== activeTurn)) {
      return { kind: 'unknown', bytesRead: bytes };
    }
    const turnId = activeTurn;
    if (payload.role === 'user' && !consumedTurn) {
      const text = extractInputText(payload.content);
      if (text === null) return { kind: 'unknown', bytesRead: bytes };
      if (hmacEnvelope(text, hmacKey) === row.envelopeHmac) {
        if (!activeTurn || activeTurn !== turnId) return { kind: 'unknown', bytesRead: bytes };
        consumedTurn = turnId;
        consumedThrough = through;
      }
      continue;
    }
    if (payload.role === 'assistant' && consumedTurn === turnId) {
      if (!activeTurn || activeTurn !== turnId) return { kind: 'unknown', bytesRead: bytes };
      assistantSeen = true;
      continue;
    }
    if (payload.role !== 'user' && payload.role !== 'assistant'
      && payload.role !== 'developer' && payload.role !== 'system') {
      return { kind: 'unknown', bytesRead: bytes };
    }
  }
  return consumedTurn
    ? { kind: 'consumed', turnId: consumedTurn, consumedThrough, bytesRead: bytes }
    : { kind: 'unseen', observedThrough: start + lastNl + 1, activeTurnId: activeTurn, bytesRead: bytes };
}

function rolloutIdentityMatches(rolloutPath: string, expectedId: string): boolean {
  let fd: number | null = null;
  try {
    const size = Math.min(fs.statSync(rolloutPath).size, 256 * 1024);
    fd = fs.openSync(rolloutPath, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return false;
    const first = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
    const payload = first.payload as Record<string, unknown> | undefined;
    return first.type === 'session_meta' && payload?.id === expectedId;
  } catch { // @silent-fallback-ok: unreadable/malformed identity evidence fails closed
    return false;
  } finally { if (fd !== null) fs.closeSync(fd); }
}

export function observeCodexComposer(pane: string | null, expectedHmac: string, hmacKey: string): ComposerObservation {
  if (!pane) return 'unknown';
  const normalized = normalizePane(pane);
  const lines = normalized.split('\n');
  const promptIndexes = lines.map((line, index) => line.includes('›') ? index : -1).filter((index) => index >= 0);
  if (promptIndexes.length !== 1) return 'unknown';
  const index = promptIndexes[0];
  const prompt = lines[index];
  const after = prompt.slice(prompt.indexOf('›') + 1).trim();
  if (!after) return 'cleared';
  // Only an exact full-region HMAC can authorize keypress recovery. A clipped
  // or wrapped region is unknown, never a prefix match.
  const region = [after, ...lines.slice(index + 1).filter((line) => !/^\s*(?:•|esc |ctrl\+|shift\+)/i.test(line))]
    .join('\n').trim();
  return hmacEnvelope(region, hmacKey) === expectedHmac ? 'present' : 'unknown';
}

function extractInputText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const chunks: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const part = item as Record<string, unknown>;
    if (part.type !== 'input_text' || typeof part.text !== 'string') return null;
    chunks.push(part.text);
  }
  return chunks.join('');
}

function hmacEnvelope(text: string, key: string): string {
  return crypto.createHmac('sha256', key)
    .update(text.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\n$/, ''))
    .digest('hex');
}

function normalizePane(pane: string): string {
  return pane.replace(/\x1b\[[0-9;:?>]*[ -/]*[@-~]/g, '').replace(/\r/g, '').replace(/[ \t]+$/gm, '');
}

function keyFor(row: DeliveryEvidence): string { return `${row.conversationId}\0${row.deliveryId}`; }

function pendingSharedRolloutBytes(work: RolloutWork): number {
  try { return Math.max(0, fs.statSync(work.rolloutPath).size - work.observedOffset); } catch { // @silent-fallback-ok: unreadable rollout contributes no guessed byte count
    return 0;
  }
}

function composerFrameKey(frame: CodexComposerFrame | null): string {
  if (!frame) return '';
  return crypto.createHash('sha256').update(JSON.stringify({
    joinedViewport: frame.joinedViewport,
    cursorX: frame.cursorX, cursorY: frame.cursorY, width: frame.width, height: frame.height,
    alternateOn: frame.alternateOn, paneInMode: frame.paneInMode,
    stableMetadata: frame.stableMetadata,
  })).digest('hex');
}

async function mapWithConcurrency<T, R>(
  values: T[], concurrency: number, fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
