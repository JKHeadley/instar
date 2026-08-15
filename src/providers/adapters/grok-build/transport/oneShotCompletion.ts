/**
 * OneShotCompletion implementation for the grok-build adapter (spec §4.1).
 *
 * Writes the prompt to a private temp file (mode 0600), spawns the canonical
 * argv (buildGrokOneShotArgv — prompt via `--prompt-file`, never argv), and
 * parses the single JSON envelope grok emits on stdout.
 *
 * Envelope facts (PROBED, grok 1.0.4, 22 runs — spec §0.2/§6.0):
 *   - `text` — the completion text.
 *   - `stopReason` — 'end_turn' | 'cancelled' | … . LARGE inputs reliably
 *     come back 'cancelled' WITH tokens consumed and text present (19/19 in
 *     the burn test) — so 'cancelled' with non-empty text is surfaced as a
 *     result flagged `providerSpecific.grok-build.stopReason`, while
 *     'cancelled' with EMPTY text is a hard failure (exit-0-empty is a
 *     failure, never a successful empty result — review-2 finding 13).
 *   - `usage` — input_tokens / cache_read_input_tokens /
 *     cache_creation_input_tokens / output_tokens are DISJOINT and sum to
 *     total_tokens exactly; reasoning_tokens is a SUBSET of output (§6.0).
 *     NEVER add reasoning on top.
 *   - `total_cost_usd` — PLAN-RATE dollars (exactly 17.00% of grok-4.6 list;
 *     §0.2). DELIBERATELY NOT recorded as the canonical estimatedCostUsd
 *     (a basis-less field must not carry a plan-rate figure — round-5);
 *     surfaces only as providerSpecific costUsdPlanRate.
 *
 * AUTH GATE: assertGrokAuthAllowed runs BEFORE the temp file is even
 * written — key-in-env or expired session refuses the call (spec §3.1).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import type {
  OneShotCompletion,
  OneShotCompletionOptions,
  OneShotCompletionResult,
} from '../../../primitives/transport/oneShotCompletion.js';
import type { ModelTier, UsageReport } from '../../../types.js';
import { CapabilityFlag } from '../../../capabilities.js';
import { AbortError, ProviderError, UnexpectedError } from '../../../errors.js';
import { SafeFsExecutor } from '../../../../core/SafeFsExecutor.js';
import { resolveSpawnAcquireMs } from '../../../../core/hostSpawnSemaphore.js';
import type { GrokBuildConfig } from '../config.js';
import { GROK_BUILD_ID, mapExecError, scrubStderr } from '../errors.js';
import { assertGrokAuthAllowed } from '../policy.js';
import {
  buildGrokChildEnv,
  buildGrokOneShotArgv,
  spawnGrokAndWait,
} from './grokSpawn.js';

/** Abstract tiers — grok exposes few models; every tier resolves to config. */
const MODEL_TIERS: ReadonlySet<string> = new Set<ModelTier>(['fast', 'balanced', 'capable']);

function resolveGrokModel(
  selector: string | ModelTier | undefined,
  configModel: string | undefined,
): string | undefined {
  if (selector && !MODEL_TIERS.has(selector)) {
    return selector;
  }
  return configModel;
}

interface GrokUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
}

interface GrokEnvelope {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  usage?: GrokUsage;
  total_cost_usd?: number;
}

/**
 * Repair grok's envelope into VALID JSON before parsing it.
 *
 * RULE 3.1 RATIONALE (state-detection robustness; registry row:
 * `specs/provider-portability/06-state-detector-registry.md` →
 * `adapters/grok-build/transport/oneShotCompletion.ts`).
 *
 * WHAT UPSTREAM STATE IS BEING READ: grok-build's `--output-format json`
 * envelope on stdout — the reviewer's answer text plus its token counts.
 *
 * WHY A PARSE AT ALL, AND WHY IT IS ACCEPTABLE HERE: this is the vendor's only
 * machine-readable surface; there is no API we are permitted to use (the lane is
 * subscription-authed by construction, §0.5). So the parse is unavoidable, and
 * the question Rule 3 actually asks is what a WRONG answer costs. Here it costs
 * the answer and its accounting — it cannot silently corrupt spend, because
 * every billing control (env sweep, forced api-key kill switch, config-credential
 * refusal, login-policy verification) is independent of this parse and runs
 * whether or not it succeeds.
 *
 * HOW DRIFT IS CAUGHT TODAY: an envelope-sum canary asserted on EVERY parse (a
 * shape change fails loudly at call time rather than degrading), plus unit
 * fixtures captured from the real CLI covering both the single-line and
 * multi-line shapes.
 *
 * WHAT IS NOT COVERED, STATED PLAINLY: there is no CADENCED live canary, so
 * drift is detected when a caller hits it, not before. That gap is deliberate
 * rather than overlooked — grok's weekly allowance is unreadable, so a scheduled
 * live probe would spend an allowance nobody can measure, which is the one thing
 * this integration refuses to do blind. Carrier: CMT-1321.
 *
 * THE UPSTREAM IS KNOWN-UNSTABLE, WHICH IS WHY THIS ROW EXISTS AT ALL:
 *
 * ROUND-17, and the most consequential defect of the seventeen rounds: grok's
 * `--output-format json` envelope embeds RAW newlines inside its JSON string
 * values rather than escaping them as `\n`. That is invalid JSON, so
 * `JSON.parse` throws — and it throws on EVERY multi-line response, which is
 * essentially every real one. Measured on a real reviewer-shaped run: 109 raw
 * newlines inside string values, zero escaped, `JSON.parse` failing at the
 * first one.
 *
 * How this survived a live-proof: the earlier end-to-end verification used a
 * one-line reply ("Reply with exactly: OK"). A single-line envelope contains no
 * raw newline, parses cleanly, and certifies nothing about the shape the lane
 * actually carries. That is the "passing condition narrower than what it
 * certifies" class this branch spent the whole round catching — committed here
 * by the live proof itself, which is why the control below asserts BOTH shapes.
 *
 * The repair walks the text tracking string-literal state and escape state, and
 * escapes only control characters that appear INSIDE a string. Everything
 * outside a string (the structural whitespace between tokens) is untouched, and
 * an already-escaped sequence is left alone because the escape flag suppresses
 * the rewrite. So valid JSON passes through byte-identical.
 */
export function repairGrokEnvelopeJson(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out +=
          ch === '\n' ? '\\n'
          : ch === '\r' ? '\\r'
          : ch === '\t' ? '\\t'
          : `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Parse grok's stdout into its JSON envelope. Grok emits ONE JSON object;
 * a leading non-JSON banner line is tolerated by scanning for the first '{'.
 * Returns null when no parseable envelope exists.
 */
export function parseGrokEnvelope(stdout: string): GrokEnvelope | null {
  // Try the first '{'; a banner line containing a brace must not hard-fail
  // an otherwise-good (already-paid-for) run, so fall back to the last line
  // that starts with '{' (adversarial review round-3 finding 12).
  const first = stdout.indexOf('{');
  if (first >= 0) {
    try {
      return JSON.parse(repairGrokEnvelopeJson(stdout.slice(first))) as GrokEnvelope;
    } catch {
      /* fall through to line scan */
    }
  }
  // Bounded tail scan with REAL byte offsets (adversarial/scalability
  // round-4: indexOf(text) can bind to an earlier duplicate line, and an
  // unbounded scan over capped 8MiB output is O(n²) in the pathological
  // JSON-lines case). The envelope is grok's FINAL stdout object, so only
  // the last few '{'-prefixed lines can be it.
  const lines = stdout.split('\n');
  const offsets: number[] = new Array(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = pos;
    pos += lines[i]!.length + 1;
  }
  let attempts = 0;
  for (let i = lines.length - 1; i >= 0 && attempts < 8; i--) {
    const line = lines[i]!;
    const leading = line.length - line.trimStart().length;
    if (line.trim().startsWith('{')) {
      attempts++;
      try {
        return JSON.parse(repairGrokEnvelopeJson(stdout.slice(offsets[i]! + leading))) as GrokEnvelope;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/**
 * Validate + clamp envelope numerics (security/adversarial round-3: a forged
 * or drifted envelope must not poison the only burn record we have). Each
 * usage field must be a finite number >= 0 — anything else clamps to 0 with
 * the anomaly flagged. Also asserts the §6.0 disjoint-sum identity per run;
 * a violation is a FORMAT-DRIFT signal (loudly logged, never a block).
 * Returns the list of anomaly descriptions (empty = clean).
 */
export function validateEnvelopeUsage(envelope: GrokEnvelope): string[] {
  const anomalies: string[] = [];
  const u = envelope.usage;
  if (!u) return anomalies;
  /**
   * Render an INVALID field value for an anomaly string (round-13 security).
   * These strings land in a `console.warn` AND in the durable `recentRuns[].
   * anomalies` trail that §6.0a names the drift signal's consumer — so a
   * non-numeric field carrying arbitrary vendor-controlled text of any length
   * would be persisted verbatim. Sibling of `sanitizeDriftAdvisory` and
   * `classifyStopReason`; the same clamp applies here.
   */
  const renderInvalid = (v: unknown): string => {
    const raw = typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) : String(v);
    const cleaned = raw.replace(/[\u0000-\u001f\u007f`]/g, ' ').trim();
    return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
  };
  const clamp = (v: number | undefined, name: string): number => {
    if (v === undefined) return 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      anomalies.push(`${name} invalid (${renderInvalid(v)}) — clamped to 0`);
      return 0;
    }
    return v;
  };
  u.input_tokens = clamp(u.input_tokens, 'input_tokens');
  u.cache_read_input_tokens = clamp(u.cache_read_input_tokens, 'cache_read_input_tokens');
  u.cache_creation_input_tokens = clamp(u.cache_creation_input_tokens, 'cache_creation_input_tokens');
  u.output_tokens = clamp(u.output_tokens, 'output_tokens');
  u.reasoning_tokens = clamp(u.reasoning_tokens, 'reasoning_tokens');
  if (envelope.total_cost_usd !== undefined &&
      (typeof envelope.total_cost_usd !== 'number' || !Number.isFinite(envelope.total_cost_usd) || envelope.total_cost_usd < 0)) {
    anomalies.push(`total_cost_usd invalid (${renderInvalid(envelope.total_cost_usd)}) — dropped`);
    delete envelope.total_cost_usd;
  }
  // §6.0 disjoint-sum identity (verified n=3 at probe time; asserted on
  // EVERY parse from here on — envelope-version drift becomes visible).
  // total_tokens itself is validated too: a missing/non-finite total would
  // otherwise silently disarm BOTH canaries that key off it (adversarial
  // round-4) — flagged, and consumers fall back to the four-field sum.
  const sum = u.input_tokens! + u.cache_read_input_tokens! + u.cache_creation_input_tokens! + u.output_tokens!;
  if (typeof u.total_tokens !== 'number' || !Number.isFinite(u.total_tokens) || u.total_tokens < 0) {
    anomalies.push(`total_tokens invalid/missing (${renderInvalid(u.total_tokens)}) — using field sum ${sum}`);
    u.total_tokens = sum;
  } else if (sum !== u.total_tokens) {
    anomalies.push(`disjoint-sum drift: fields sum ${sum} != total_tokens ${u.total_tokens}`);
  }
  return anomalies;
}

/**
 * Map grok's usage block onto the canonical UsageReport, following INSTAR'S
 * ledger convention (lessons round-4): `cachedTokens` is the cache-read
 * SUBSET of `inputTokens` (fresh cost = tokensIn − tokensCached). Grok's
 * fields are DISJOINT, so:
 *   inputTokens    = input + cache_read + cache_creation  (total input side)
 *   cachedTokens   = cache_read ONLY                       (the subset)
 *   outputTokens   = output (reasoning is a SUBSET of output — never added)
 *   reasoningTokens= reasoning (informational subset)
 * `estimatedCostUsd` is DELIBERATELY NEVER populated (round-5: the
 * canonical field is basis-less; the plan-rate figure surfaces only as
 * providerSpecific costUsdPlanRate — see the non-assignment site below).
 */
export function usageFromEnvelope(envelope: GrokEnvelope): UsageReport | null {
  const u = envelope.usage;
  if (!u) return null;
  const input = u.input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const report: UsageReport = {
    inputTokens: input + cacheRead + cacheCreate,
    outputTokens: u.output_tokens ?? 0,
  };
  if (cacheRead > 0) report.cachedTokens = cacheRead;
  if ((u.reasoning_tokens ?? 0) > 0) report.reasoningTokens = u.reasoning_tokens!;
  // DELIBERATELY NOT set: estimatedCostUsd. Grok's total_cost_usd is
  // PLAN-RATE (17% of list — spec §0.2); the canonical cross-provider field
  // carries no basis marker, so populating it would let a generic consumer
  // silently mix bases 5.88× (adversarial round-5). The figure surfaces in
  // providerSpecific as costUsdPlanRate, where the basis is in the name.
  return report;
}

/** Prompt-size refusal bound (bytes). Reviewer prompts run ~100KB; 512KB
 *  leaves headroom while bounding worst-case spend per call. */
export const DEFAULT_MAX_PROMPT_BYTES = 512 * 1024;

/** Hard ceiling on a single call's timeout. Kept STRICTLY below the
 *  scratch-dir sweep age so a legitimately in-flight long call can never
 *  have its cwd swept out from under it by a concurrent process
 *  (scalability round-5). Louder values are clamped with a warn. */
export const MAX_CALL_TIMEOUT_MS = 30 * 60 * 1000;

/** Age past which a crash-orphaned scratch dir (containing a prompt file)
 *  is swept. INVARIANT: > MAX_CALL_TIMEOUT_MS + kill grace. */
const STALE_SCRATCH_DIR_MS = 60 * 60 * 1000;

/** The sweep is a janitor, not a per-call precondition: at most one pass
 *  per process per this interval (round-5 — a sync full-tmpdir readdir on
 *  every call is avoidable fixed cost for future server-side callers). */
const SWEEP_MIN_INTERVAL_MS = 15 * 60 * 1000;
let _lastSweepAt = 0;

/** Best-effort sweep of crash-orphaned grok-scratch-* dirs in tmpdir. */
function sweepStaleScratchDirs(): void {
  const nowMs = Date.now();
  if (nowMs - _lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  _lastSweepAt = nowMs;
  let names: string[];
  const base = os.tmpdir();
  try {
    names = fs.readdirSync(base);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_SCRATCH_DIR_MS;
  for (const name of names) {
    if (!name.startsWith('grok-scratch-')) continue;
    const full = path.join(base, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        SafeFsExecutor.safeRmSync(full, {
          recursive: true,
          force: true,
          operation: 'grok-build/oneShotCompletion:stale-scratch-sweep',
        });
      }
    } catch {
      /* best-effort */
    }
  }
}

class GrokBuildOneShotCompletion implements OneShotCompletion {
  readonly capability = CapabilityFlag.OneShotCompletion;

  constructor(private readonly config: GrokBuildConfig) {}

  async evaluate(
    prompt: string,
    options?: OneShotCompletionOptions,
  ): Promise<OneShotCompletionResult> {
    const requestedTimeoutMs = options?.timeoutMs ?? this.config.timeoutMs ?? 120_000;
    // Clamp to the ceiling that keeps in-flight calls safely inside the
    // scratch-sweep bound (round-5) — INCLUDING the spawn-slot acquire wait,
    // which elapses after the scratch dir's mtime is set (round-6: an
    // operator-raised acquireMs must not silently break the residency
    // invariant). Clamp-with-warn, not refuse.
    const KILL_GRACE_MS = 120_000;
    const residencyCeiling = Math.max(
      60_000,
      STALE_SCRATCH_DIR_MS - resolveSpawnAcquireMs() - KILL_GRACE_MS,
    );
    const timeoutMs = Math.min(requestedTimeoutMs, MAX_CALL_TIMEOUT_MS, residencyCeiling);
    if (timeoutMs < requestedTimeoutMs) {
      console.warn(
        `[grok-build] timeoutMs ${requestedTimeoutMs} clamped to ${timeoutMs} (scratch-sweep residency ceiling)`,
      );
    }
    const model = resolveGrokModel(options?.model, this.config.model);

    // BILLING GATE (spec §3.1): key-in-env or missing/expired session
    // refuses BEFORE any file is written or process spawned. The admission
    // margin covers this call's own timeout PLUS the spawn-slot acquire
    // budget (security round-5: acquire wait precedes the spawn, so the
    // true worst-case runway is acquire + timeout).
    assertGrokAuthAllowed(
      this.config,
      process.env,
      new Date(),
      timeoutMs + resolveSpawnAcquireMs(),
    );

    const abortSignal = options?.signal;
    if (abortSignal?.aborted) {
      throw new AbortError('Aborted before start', GROK_BUILD_ID);
    }

    const effectivePrompt = options?.system
      ? `${options.system}\n\n${prompt}`
      : prompt;

    // PROMPT-SIZE CAP (spec §4.1): refuse, never truncate, above the bound.
    // With the weekly pool invisible in advance, an unbounded prompt is
    // unbounded spend per call.
    const maxPromptBytes = this.config.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
    const promptBytes = Buffer.byteLength(effectivePrompt, 'utf8');
    if (promptBytes > maxPromptBytes) {
      throw new UnexpectedError(
        `grok-prompt-too-large: ${promptBytes} bytes exceeds the ${maxPromptBytes}-byte cap ` +
          `(bound the input or raise maxPromptBytes deliberately)`,
        GROK_BUILD_ID,
      );
    }

    // Every grok spawn runs in a fresh empty scratch cwd — NEVER the server's
    // project root (security round-3 finding 5). The PROMPT FILE lives INSIDE
    // this per-call scratch dir (security/adversarial round-4: a fixed-name
    // shared subdir under tmpdir is pre-creatable by another principal, and
    // 'wx' protects create-time only, not the child's read-time re-resolution
    // — mkdtempSync gives an unpredictable, per-call-owned path and the
    // existing cleanup for free). Crash-orphaned scratch dirs are swept.
    sweepStaleScratchDirs();
    const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-scratch-'));
    const promptFile = path.join(
      scratchCwd,
      `grok-prompt-${crypto.randomBytes(8).toString('hex')}.txt`,
    );
    fs.writeFileSync(promptFile, effectivePrompt, { mode: 0o600, flag: 'wx' });

    try {
      const args = buildGrokOneShotArgv(model, promptFile);
      const result = await spawnGrokAndWait(this.config.grokPath, args, {
        timeoutMs,
        env: buildGrokChildEnv(),
        cwd: scratchCwd,
        ...(abortSignal ? { signal: abortSignal } : {}),
        ...(this.config.maxOutputBytes !== undefined
          ? { maxOutputBytes: this.config.maxOutputBytes }
          : {}),
      });

      if (result.truncated) {
        // A cap-triggered kill must surface as a NAMEABLE output-cap failure,
        // never a generic exec error (scalability round-3 finding 4) — and
        // never as a stderr-regex misclassification. Only the STDOUT cap
        // kills (stderr past its cap is drained/discarded — round-5).
        throw new UnexpectedError(
          `grok-output-cap-exceeded (stdout): captured output hit the ` +
            `${this.config.maxOutputBytes ?? 'default'}-byte cap (runaway or oversized run)`,
          GROK_BUILD_ID,
        );
      }
      if (result.stderrTruncated) {
        console.warn('[grok-build] stderr hit its byte cap — diagnostics past the bound were discarded (run proceeded)');
      }
      if (result.exitCode !== 0) {
        throw mapExecError(
          new Error(`grok exited ${result.exitCode}`) as Error & { code?: number },
          result.stderr,
        );
      }

      const envelope = parseGrokEnvelope(result.stdout);
      // exit-0 with no parseable envelope, or an envelope with empty text,
      // is a HARD failure — never a successful empty result (review-2 f.13).
      if (!envelope || typeof envelope.text !== 'string' || envelope.text.trim() === '') {
        throw new UnexpectedError(
          `grok produced no usable completion (exit 0, ` +
            `${envelope ? `stopReason=${envelope.stopReason ?? 'unknown'}, empty text` : 'no JSON envelope'})` +
            (result.stderr ? `: ${scrubStderr(result.stderr).slice(0, 300)}` : ''),
          GROK_BUILD_ID,
        );
      }

      // Validate numerics + assert the §6.0 sum identity on EVERY parse —
      // envelope drift or forgery becomes a loud signal, never a silent
      // poisoning of the only burn record this framework has.
      const anomalies = validateEnvelopeUsage(envelope);
      if (!envelope.usage) {
        anomalies.push('usage MISSING on a successful call (accounting blind spot)');
      }
      const totalTokens = envelope.usage?.total_tokens ?? 0;
      const warnAt = this.config.perRunTokenWarnThreshold;
      if (warnAt !== undefined && totalTokens > warnAt) {
        anomalies.push(`per-run token threshold exceeded: ${totalTokens} > ${warnAt}`);
      }
      if (anomalies.length > 0) {
        console.warn(
          `[grok-build] accounting anomalies (model=${model ?? 'default'}): ${anomalies.join('; ')}`,
        );
      }

      return {
        text: envelope.text.trim(),
        usage: usageFromEnvelope(envelope),
        providerSpecific: {
          [GROK_BUILD_ID]: {
            model: model ?? null,
            truncated: result.truncated,
            // Surfaced, not hidden: large inputs reliably return 'cancelled'
            // with usable text (19/19 in the §0.3 burn) — callers that need
            // completion-to-the-end semantics must check this.
            stopReason: envelope.stopReason ?? null,
            sessionId: envelope.sessionId ?? null,
            usageAnomalies: anomalies.length > 0 ? anomalies : null,
            // Basis-in-the-name (spec §0.2/§6.0a): grok's reported figure is
            // plan-rate dollars, never the canonical estimatedCostUsd.
            costUsdPlanRate: envelope.total_cost_usd ?? null,
          },
        },
      };
    } catch (err) {
      // NEVER re-map an already-mapped ProviderError (adversarial round-5
      // HIGH: the exit!=0 branch throws a correctly-classified Quota/RateLimit/
      // Auth/Network error; a second mapExecError with empty stderr would
      // launder it into UnexpectedError — destroying the no-blind-retry
      // brake's branch key on the exact path a quota wall arrives).
      if (err instanceof ProviderError) throw err;
      // A capacity shed is NOT a grok failure — preserve the instar-wide
      // capacityUnavailable contract so gate seams can branch on it
      // (scalability round-4: mapExecError would strip the flag).
      if ((err as { capacityUnavailable?: unknown }).capacityUnavailable === true) {
        throw err;
      }
      const error = err as Error & { name: string };
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        throw new AbortError('Aborted during execution', GROK_BUILD_ID, err);
      }
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      throw mapExecError(
        error as unknown as Error & {
          code?: string | number;
          signal?: string;
          killed?: boolean;
          path?: string;
        },
        stderr,
      );
    } finally {
      // The prompt file lives inside scratchCwd — one removal cleans both.
      try {
        SafeFsExecutor.safeRmSync(scratchCwd, {
          recursive: true,
          force: true,
          operation: 'grok-build/oneShotCompletion:scratch-cwd-cleanup',
        });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export function createOneShotCompletion(config: GrokBuildConfig): OneShotCompletion {
  return new GrokBuildOneShotCompletion(config);
}
