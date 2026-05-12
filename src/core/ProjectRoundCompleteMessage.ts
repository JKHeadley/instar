/**
 * ProjectRoundCompleteMessage — tone-gated round-complete delivery
 * template + retry + idempotency for project rounds.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.8.
 *
 * Two responsibilities:
 *   1. `formatRoundCompleteMessage(input)` — pure template function
 *      that validates required-field PRESENCE (never non-emptiness)
 *      and returns a `{message, idempotencyKey}` pair. Pre-flight
 *      halts have a documented empty-default for `whatLanded` so the
 *      gate never silently rejects a legitimate halt event.
 *   2. `RoundCompleteDeliveryHelper` — bookkeeping over the
 *      idempotency key set with a `sendOnce` helper that delegates
 *      actual transport to a caller-provided sender, retries on
 *      transient failures with exponential backoff, and triggers the
 *      caller's fallback (`onPermanentFail`) when all retries fail.
 *
 * What this file is NOT responsible for:
 *   - Choosing WHEN to send a round-complete message. The autonomous
 *     run loop (next PR) decides that.
 *   - The actual Telegram transport. The caller passes a `send`
 *     function — keeping the template + retry isolated from the
 *     `TelegramAdapter` so tests don't need to spin up the adapter.
 *   - Going through the `MessagingToneGate`. The gate operates on
 *     final outbound text; the consumer is the one that calls
 *     `gate.evaluate(message)` before passing the message to a
 *     transport. We expose the formatted text so the consumer can
 *     route it through the gate.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SafeFsExecutor } from './SafeFsExecutor.js';

/** Event kind the message describes. */
export type RoundCompleteEventKind =
  | 'round-complete'
  | 'round-partially-complete'
  | 'round-halted'
  | 'round-failed';

/** Inputs to the template. Required-fields are enforced by the validator below. */
export interface RoundCompleteMessageInput {
  projectId: string;
  projectTitle: string;
  roundIndex: number;
  /** Bumped on every project record write — part of the idempotency key. */
  projectVersion: number;
  eventKind: RoundCompleteEventKind;
  /**
   * Bullet list of merged itemIds with titles. May default to
   * "No items shipped this round — halted at <step>" when the event
   * is a pre-flight halt; presence is enforced, non-emptiness is not.
   */
  whatLanded: string;
  /** Required for halt events (round-halted / round-failed). */
  whatHalted?: string;
  /**
   * Verified citations (text excerpts the dashboard renders), or PR
   * mergeCommit.oid values for shipped items. Empty array is allowed.
   */
  evidenceCited: string[];
  /**
   * Required for halt + failed events. For clean `round-complete`,
   * the default `"(none)"` is accepted by the template.
   */
  rootCauseHypothesis: string;
  /**
   * Required. Tells the user how to act:
   * `"Reply 'pause <project-id>' within 24 hours to hold"` is the
   * canonical phrasing per spec.
   */
  concreteNextStep: string;
  /** Optional dashboard deep link. */
  overrideLink?: string;
  /** Required. Canonical phrasing for the user's hold path. */
  brakeHandlePhrase: string;
}

/** Stable key keyed off `(projectId, roundIndex, eventKind, projectVersion)`. */
export function idempotencyKeyFor(input: Pick<RoundCompleteMessageInput, 'projectId' | 'roundIndex' | 'eventKind' | 'projectVersion'>): string {
  return `${input.projectId}::${input.roundIndex}::${input.eventKind}::v${input.projectVersion}`;
}

export type FormatResult =
  | { ok: true; message: string; idempotencyKey: string }
  | { ok: false; missingFields: string[] };

/**
 * Build the user-facing message. Returns `{ok:false, missingFields}`
 * when a required field is undefined / null. Returns `{ok:true, message,
 * idempotencyKey}` otherwise. Empty strings are accepted by design — the
 * template enforces *presence*, not *non-emptiness*. The empty-default
 * for `whatLanded` on pre-flight halts is the responsibility of the
 * caller (they should supply the documented default before calling
 * this function — the validator just records that the field is present).
 */
export function formatRoundCompleteMessage(input: RoundCompleteMessageInput): FormatResult {
  const missing: string[] = [];
  if (typeof input.projectId !== 'string') missing.push('projectId');
  if (typeof input.projectTitle !== 'string') missing.push('projectTitle');
  if (!Number.isInteger(input.roundIndex)) missing.push('roundIndex');
  if (!Number.isInteger(input.projectVersion)) missing.push('projectVersion');
  if (typeof input.eventKind !== 'string') missing.push('eventKind');
  if (typeof input.whatLanded !== 'string') missing.push('whatLanded');
  if (typeof input.rootCauseHypothesis !== 'string') missing.push('rootCauseHypothesis');
  if (typeof input.concreteNextStep !== 'string') missing.push('concreteNextStep');
  if (typeof input.brakeHandlePhrase !== 'string') missing.push('brakeHandlePhrase');
  if (!Array.isArray(input.evidenceCited)) missing.push('evidenceCited');
  // halt-flavor events also require whatHalted to be present (string).
  const haltLike = input.eventKind === 'round-halted' || input.eventKind === 'round-failed';
  if (haltLike && typeof input.whatHalted !== 'string') missing.push('whatHalted');
  if (missing.length > 0) {
    return { ok: false, missingFields: missing };
  }

  const lines: string[] = [];
  const headlineByKind: Record<RoundCompleteEventKind, string> = {
    'round-complete': 'Round complete',
    'round-partially-complete': 'Round partially complete',
    'round-halted': 'Round halted',
    'round-failed': 'Round failed',
  };
  lines.push(`${headlineByKind[input.eventKind]}: ${input.projectTitle} (round ${input.roundIndex}).`);
  lines.push('');
  lines.push('What landed:');
  lines.push(input.whatLanded);
  if (haltLike && input.whatHalted) {
    lines.push('');
    lines.push('What halted:');
    lines.push(input.whatHalted);
  }
  if (input.evidenceCited.length > 0) {
    lines.push('');
    lines.push('Evidence cited:');
    for (const e of input.evidenceCited.slice(0, 10)) lines.push(`• ${e}`);
  }
  if (input.rootCauseHypothesis && input.rootCauseHypothesis !== '(none)') {
    lines.push('');
    lines.push(`Root cause hypothesis: ${input.rootCauseHypothesis}`);
  }
  lines.push('');
  lines.push(`Next step: ${input.concreteNextStep}`);
  lines.push(`To hold: ${input.brakeHandlePhrase}`);
  if (input.overrideLink) {
    lines.push(`Dashboard: ${input.overrideLink}`);
  }

  return {
    ok: true,
    message: lines.join('\n'),
    idempotencyKey: idempotencyKeyFor(input),
  };
}

// ── Delivery helper ───────────────────────────────────────────────────

export type SendResult =
  | { ok: true }
  | { ok: false; transient: boolean; error: Error };

export interface SendAttempt {
  attempt: number;
  ok: boolean;
  error?: Error;
  transient?: boolean;
}

export interface DeliveryReport {
  sent: boolean;
  attempts: SendAttempt[];
  /** Set when send succeeded — null on failure. */
  idempotencyKey: string | null;
  /** Set when ALL attempts failed AND the caller's fallback ran. */
  fallbackTriggered: boolean;
}

export interface RoundCompleteDeliveryHelperConfig {
  /** Absolute path to the agent's `.instar/` directory (for the dedup file). */
  stateDir: string;
  /** Max attempts before the fallback fires. Default 3. */
  maxAttempts?: number;
  /** Backoff base in ms. Default 1000 (1s, 2s, 4s). */
  backoffBaseMs?: number;
  /** Override for tests. */
  setTimeoutFn?: (cb: () => void, ms: number) => void;
}

const DEDUP_FILE = 'round-complete-sent.json';

interface DedupState {
  sent: string[]; // recently-sent idempotency keys (bounded)
}

/** Bounded set so dedupe state doesn't grow forever. */
const DEDUP_RING_SIZE = 1000;

export class RoundCompleteDeliveryHelper {
  private stateDir: string;
  private maxAttempts: number;
  private backoffBaseMs: number;
  private setTimeoutFn: (cb: () => void, ms: number) => void;
  private sentKeys = new Set<string>();
  private loaded = false;

  constructor(config: RoundCompleteDeliveryHelperConfig) {
    this.stateDir = config.stateDir;
    this.maxAttempts = config.maxAttempts ?? 3;
    this.backoffBaseMs = config.backoffBaseMs ?? 1000;
    this.setTimeoutFn = config.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms).unref());
  }

  /**
   * Send a round-complete message, with retry + idempotency.
   *
   * On the first call for an idempotency key:
   *   - Calls `send(input, message)` up to `maxAttempts` times.
   *   - Between attempts, waits `backoffBaseMs * 2^(attempt-1)` ms.
   *   - Records the key after the first successful send.
   *
   * On subsequent calls with the same key:
   *   - Returns `{sent: false, alreadySent: true}` without calling `send`.
   *
   * On permanent failure (all attempts return non-transient or transient
   * exhausted), invokes `onPermanentFail(input, message, attempts)`.
   */
  async sendOnce(
    input: RoundCompleteMessageInput,
    send: (input: RoundCompleteMessageInput, message: string) => Promise<SendResult>,
    onPermanentFail?: (input: RoundCompleteMessageInput, message: string, attempts: SendAttempt[]) => Promise<void>
  ): Promise<DeliveryReport & { alreadySent?: boolean }> {
    this.loadIfNeeded();
    const formatted = formatRoundCompleteMessage(input);
    if (!formatted.ok) {
      return { sent: false, attempts: [], idempotencyKey: null, fallbackTriggered: false };
    }
    if (this.sentKeys.has(formatted.idempotencyKey)) {
      return {
        sent: true,
        attempts: [{ attempt: 0, ok: true }],
        idempotencyKey: formatted.idempotencyKey,
        fallbackTriggered: false,
        alreadySent: true,
      };
    }

    const attempts: SendAttempt[] = [];
    for (let i = 1; i <= this.maxAttempts; i++) {
      let result: SendResult;
      try {
        result = await send(input, formatted.message);
      } catch (err) {
        result = { ok: false, transient: true, error: err instanceof Error ? err : new Error(String(err)) };
      }
      if (result.ok) {
        attempts.push({ attempt: i, ok: true });
        this.sentKeys.add(formatted.idempotencyKey);
        this.persist();
        return {
          sent: true,
          attempts,
          idempotencyKey: formatted.idempotencyKey,
          fallbackTriggered: false,
        };
      }
      attempts.push({ attempt: i, ok: false, error: result.error, transient: result.transient });
      // Non-transient → bail immediately.
      if (!result.transient) break;
      // Transient → backoff before next attempt, unless this was the last.
      if (i < this.maxAttempts) {
        const delay = this.backoffBaseMs * Math.pow(2, i - 1);
        await new Promise<void>((resolve) => this.setTimeoutFn(resolve, delay));
      }
    }

    if (onPermanentFail) {
      try {
        await onPermanentFail(input, formatted.message, attempts);
      } catch {
        // Fallback's own failure is logged at the call site; we don't
        // double-fail the delivery report.
      }
    }
    return {
      sent: false,
      attempts,
      idempotencyKey: null,
      fallbackTriggered: !!onPermanentFail,
    };
  }

  /** Test-only: query whether a key was recorded. */
  hasSent(key: string): boolean {
    this.loadIfNeeded();
    return this.sentKeys.has(key);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private loadIfNeeded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.dedupPath(), 'utf-8');
      const obj = JSON.parse(raw) as DedupState;
      if (obj && Array.isArray(obj.sent)) {
        for (const k of obj.sent) if (typeof k === 'string') this.sentKeys.add(k);
      }
    } catch {
      // Missing or malformed dedup file — start fresh.
    }
  }

  private persist(): void {
    try {
      const dir = path.join(this.stateDir, 'local');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Cap the ring so the file doesn't grow forever.
      const list = Array.from(this.sentKeys).slice(-DEDUP_RING_SIZE);
      this.sentKeys = new Set(list);
      const tmp = this.dedupPath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ sent: list }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.dedupPath());
    } catch {
      // Best-effort persistence; in-memory set still works for the lifetime
      // of the process.
    }
  }

  private dedupPath(): string {
    return path.join(this.stateDir, 'local', DEDUP_FILE);
  }
}

/** Re-export so tests can clean up the dedup file directly. */
export { DEDUP_FILE };

/** Re-export SafeFsExecutor namespace for callers that need to clean up safely. */
export { SafeFsExecutor };
