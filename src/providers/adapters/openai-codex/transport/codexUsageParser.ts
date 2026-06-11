/**
 * codexUsageParser — line-wise, shape-validated token-usage extraction from
 * the `codex exec --json` event stream (token-audit-completeness spec).
 *
 * SECURITY / INJECTION POSTURE: usage parsing operates line-wise via
 * `JSON.parse` with TOP-LEVEL shape validation; substring/regex matching over
 * the raw stream is FORBIDDEN — model content embedded inside event string
 * fields is structurally incapable of matching a top-level parse. (The
 * key-substring pre-filter below only decides whether to ATTEMPT the parse —
 * it cannot extract values, so the injection rationale is untouched.)
 *
 * Two known event shapes, with an explicit precedence rule:
 *
 *  1. Protocol shape (AUTHORITATIVE when present):
 *       {"msg":{"type":"token_count","info":{"total_token_usage":{...}}}}
 *     (also matched under a `payload` key). CUMULATIVE — the last event wins
 *     within this shape. Verified against a real codex 0.136.0 rollout:
 *     `input_tokens` includes `cached_input_tokens`;
 *     `total_tokens = input_tokens + output_tokens`.
 *
 *  2. Thread-event shape (only when NO protocol event appeared):
 *       {"type":"turn.completed","usage":{...}}
 *     PER-TURN — summed across all `turn.completed` events.
 *
 * Never mixed in one accounting. When BOTH shapes appear in one stream, the
 * protocol total is recorded and a large divergence from the thread-event sum
 * emits the drift reason `shape-divergence` — a free consistency oracle
 * against partial-cadence drift (a CLI that keeps the shape but stops
 * emitting mid-stream).
 *
 * Token fields are clamped to non-negative finite integers; a protocol sample
 * whose `total_tokens` reconciliation fails is DROPPED, not recorded — and the
 * drop counts as zero-usage for the drift tripwire (`reconciliation-failed`),
 * so systematic reconciliation failure cannot recreate silent token-blindness.
 *
 * Mapping: tokensIn = input_tokens; tokensOut = output_tokens +
 * (reasoning_output_tokens iff total_tokens reconciliation shows they are
 * additive); tokensCached = cached_input_tokens (a subset of tokensIn).
 */

export interface CodexUsageSample {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type CodexUsageDriftReason =
  | 'no-events'
  | 'empty-stream'
  | 'reconciliation-failed'
  | 'shape-divergence'
  | 'oversized-lines-discarded';

export interface CodexUsageFinalizeResult {
  /** Final recorded usage, or null when none survived validation. */
  usage: CodexUsageSample | null;
  /**
   * Drift reasons for the tripwire. Zero-usage reasons (no-events /
   * empty-stream / reconciliation-failed) only apply on a successful exit;
   * consistency reasons (shape-divergence / oversized-lines-discarded) are
   * reported whenever observed on a successful exit.
   */
  driftReasons: CodexUsageDriftReason[];
}

/**
 * Divergence threshold for the shape-divergence oracle: the protocol total
 * and the thread-event sum disagree by more than 10% of the larger AND more
 * than 1,000 tokens absolute. Small skew is expected (the cumulative protocol
 * counter can include bookkeeping the per-turn events don't); a LARGE gap
 * means one shape stopped emitting mid-stream.
 */
const DIVERGENCE_FRACTION = 0.1;
const DIVERGENCE_ABSOLUTE_FLOOR = 1_000;

/** Clamp to a non-negative finite integer; anything else → 0. */
function clamp(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.floor(v));
}

interface RawUsageFields {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** null = field absent (no reconciliation possible). */
  totalTokens: number | null;
}

function extractUsageFields(obj: Record<string, unknown>): RawUsageFields {
  return {
    inputTokens: clamp(obj.input_tokens),
    cachedTokens: clamp(obj.cached_input_tokens),
    outputTokens: clamp(obj.output_tokens),
    reasoningTokens: clamp(obj.reasoning_output_tokens),
    totalTokens:
      typeof obj.total_tokens === 'number' && Number.isFinite(obj.total_tokens)
        ? Math.max(0, Math.floor(obj.total_tokens))
        : null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Accumulates usage events from COMPLETE lines of a `codex exec --json`
 * stream. Line assembly (chunk boundaries, the carry-buffer cap) is the spawn
 * helper's job — this class assumes whole lines.
 */
export class CodexUsageAccumulator {
  private lastProtocol: RawUsageFields | null = null;
  private threadSum: { input: number; cached: number; output: number } | null = null;
  private sawAnyLine = false;
  private oversizedDiscards = 0;

  /** Feed one complete line from the event stream. Malformed lines are skipped. */
  feedLine(line: string): void {
    if (line.trim().length === 0) return;
    this.sawAnyLine = true;

    // Pre-filter: only decides whether to ATTEMPT the parse (perf). It cannot
    // extract values — extraction below is strictly top-level JSON.parse.
    if (!line.includes('token_count') && !line.includes('turn.completed')) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // malformed / truncated line — skipped
    }
    if (!isRecord(parsed)) return;

    // Protocol shape — the token_count event under `msg` or `payload`.
    const envelope = isRecord(parsed.msg)
      ? parsed.msg
      : isRecord(parsed.payload)
        ? parsed.payload
        : null;
    if (envelope && envelope.type === 'token_count' && isRecord(envelope.info)) {
      const totalUsage = envelope.info.total_token_usage;
      if (isRecord(totalUsage)) {
        // Cumulative — last event wins within this shape.
        this.lastProtocol = extractUsageFields(totalUsage);
      }
      return;
    }

    // Thread-event shape — per-turn, summed.
    if (parsed.type === 'turn.completed' && isRecord(parsed.usage)) {
      const f = extractUsageFields(parsed.usage);
      if (!this.threadSum) this.threadSum = { input: 0, cached: 0, output: 0 };
      this.threadSum.input += f.inputTokens;
      this.threadSum.cached += f.cachedTokens;
      this.threadSum.output += f.outputTokens;
    }
  }

  /**
   * Record that the spawn helper discarded an over-cap line unparsed. Usage
   * events are <1 KB so the cap cannot lose usage, but the discard is
   * surfaced to the drift tripwire.
   */
  noteOversizedDiscard(): void {
    this.oversizedDiscards++;
  }

  /**
   * Finalize accounting. `success` = the call exited 0 (drift reasons are
   * only reported for successful calls — a failed call legitimately lacks
   * usage and is visible as an error row instead).
   */
  finalize(opts: { success: boolean }): CodexUsageFinalizeResult {
    const driftReasons: CodexUsageDriftReason[] = [];
    let usage: CodexUsageSample | null = null;
    let reconciliationFailed = false;

    if (this.lastProtocol) {
      const p = this.lastProtocol;
      if (p.totalTokens === null) {
        // No total → no reconciliation possible; accept the sample WITHOUT
        // folding reasoning tokens in (the reconciliation is the only thing
        // that can prove they are additive).
        usage = { inputTokens: p.inputTokens, outputTokens: p.outputTokens, cachedTokens: p.cachedTokens };
      } else if (p.totalTokens === p.inputTokens + p.outputTokens) {
        // Verified 0.136.0 identity — reasoning tokens are already inside
        // output_tokens (or absent).
        usage = { inputTokens: p.inputTokens, outputTokens: p.outputTokens, cachedTokens: p.cachedTokens };
      } else if (p.totalTokens === p.inputTokens + p.outputTokens + p.reasoningTokens && p.reasoningTokens > 0) {
        // Reconciliation shows reasoning tokens are ADDITIVE → they are real
        // billed output and fold into tokensOut.
        usage = {
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens + p.reasoningTokens,
          cachedTokens: p.cachedTokens,
        };
      } else {
        // total_tokens reconciliation failed — drop the sample. The drop
        // counts as zero-usage drift so systematic reconciliation rot cannot
        // recreate silent token-blindness.
        reconciliationFailed = true;
      }
    } else if (this.threadSum) {
      // Thread-event shape only when no protocol event appeared.
      usage = {
        inputTokens: this.threadSum.input,
        outputTokens: this.threadSum.output,
        cachedTokens: this.threadSum.cached,
      };
    }

    // Pinned schema semantics (P18): tokensCached ⊆ tokensIn on every
    // framework. The codex contract already guarantees input_tokens includes
    // cached_input_tokens; the clamp keeps the invariant true even against a
    // pathological event.
    if (usage && usage.cachedTokens > usage.inputTokens) {
      usage = { ...usage, cachedTokens: usage.inputTokens };
    }

    if (opts.success) {
      if (usage === null) {
        if (!this.sawAnyLine) driftReasons.push('empty-stream');
        else if (reconciliationFailed) driftReasons.push('reconciliation-failed');
        else driftReasons.push('no-events');
      } else if (this.lastProtocol && this.threadSum) {
        // Both shapes in one stream: protocol recorded; large divergence from
        // the thread sum is the consistency oracle.
        const protocolTotal = usage.inputTokens + usage.outputTokens;
        const threadTotal = this.threadSum.input + this.threadSum.output;
        const diff = Math.abs(protocolTotal - threadTotal);
        const larger = Math.max(protocolTotal, threadTotal);
        if (diff > DIVERGENCE_ABSOLUTE_FLOOR && diff > larger * DIVERGENCE_FRACTION) {
          driftReasons.push('shape-divergence');
        }
      }
      if (this.oversizedDiscards > 0) driftReasons.push('oversized-lines-discarded');
    }

    return { usage, driftReasons };
  }
}
