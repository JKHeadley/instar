/**
 * LlmIntentClassifier — the JUDGMENT-BAND intent classifier (Slack permission gate,
 * Pillar 2, §6.5–6.6 / §6.6 "Layer 1 INTENT + SENSITIVITY").
 *
 * It implements the SAME `IntentClassifier` interface as `HeuristicIntentClassifier`
 * and is interchangeable with it at the gate's `classifier` slot. The difference is
 * the judgment band ABOVE the floor: an LLM call refines the sensitivity tier,
 * directedness, and a non-floor action label more accurately than keyword matching.
 *
 * ── Two invariants this class is built around ──────────────────────────────────
 *
 * 1. THE FLOOR STAYS DETERMINISTIC. This class NEVER lets the LLM decide that a
 *    floor action ISN'T one, and it never lets the LLM downgrade a heuristic-detected
 *    floor candidate. It runs the deterministic `HeuristicIntentClassifier` FIRST;
 *    when the heuristic flags a real floor action (a `floorAction`) OR the
 *    ambiguous-deploy low-confidence case (action 'ambiguous', tier 4, low
 *    confidence → the gate routes to CLARIFY), that verdict is returned AS-IS and the
 *    LLM is never consulted. The LLM can only refine the NON-floor judgment band.
 *    (Floor enumeration + role authority remain in RolePolicy / SlackPermissionGate;
 *    this class only feeds them an intent and must not be the thing that misses a
 *    floor action.)
 *
 * 2. NO SILENT DEGRADATION TO A BRITTLE — OR WIDER — FALLBACK
 *    (docs/specs/no-silent-degradation-to-brittle-fallback.md,
 *     docs/signal-vs-authority.md). On ANY LLM failure (no provider, throw, timeout,
 *    empty/unparseable response, or a response that would WIDEN access beyond the
 *    deterministic floor read) we fall back to the `HeuristicIntentClassifier`
 *    result — which itself routes ambiguity to a tier-4 low-confidence 'ambiguous'
 *    (→ the gate CLARIFIES, a safe non-allow). A classification failure must NEVER
 *    return a confident low-tier "allow"-shaped intent on what might be sensitive.
 *    The fallback is therefore at-least-as-conservative as the deterministic floor.
 *
 * The LLM is reached through instar's internal `IntelligenceProvider` (the same
 * injected-provider pattern as `TopicIntentExtractor` / `MessagingToneGate`), NOT a
 * raw API call. A `fast` model tier is used, and the call is marked `gating: true`
 * so the IntelligenceRouter will provider-swap on failure before the error
 * propagates (and we then fail closed to the heuristic).
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.5–6.6.
 */

import type { IntelligenceProvider } from '../core/types.js';
import type { RequestIntent, SensitivityTier } from './types.js';
import { HeuristicIntentClassifier, type IntentClassifier } from './IntentClassifier.js';

/** Observability hook reasons for why a classification fell back to the heuristic. */
export type LlmIntentDegradeReason =
  | 'no-intelligence' // no provider configured
  | 'error' // provider threw / timed out / circuit open
  | 'unparseable' // LLM returned something we couldn't read as a verdict
  | 'floor-deterministic' // heuristic flagged a floor candidate → LLM intentionally skipped
  | 'conversational-deterministic'; // heuristic flagged a benign conversational self-post → LLM intentionally skipped

export interface LlmIntentClassifierDeps {
  /**
   * The internal LLM provider (injected — never a direct framework import). When
   * absent, every classification degrades to the heuristic (fail-closed).
   */
  intelligence?: IntelligenceProvider;
  /**
   * The deterministic floor + fallback classifier. Defaults to a fresh
   * `HeuristicIntentClassifier`. Injectable for tests.
   */
  heuristic?: IntentClassifier;
  /** Per-call timeout for the LLM (ms). Default 8000. */
  timeoutMs?: number;
  /**
   * Optional observability hook — fires on every degrade-to-heuristic path with the
   * reason. Best-effort: it never affects the returned verdict (which is always the
   * safe heuristic result on degrade).
   */
  onDegrade?: (reason: LlmIntentDegradeReason) => void;
}

const VALID_TIERS = new Set<number>([0, 1, 2, 3, 4]);

/** Parsed shape of the LLM's JSON verdict (before validation/clamping). */
interface RawLlmVerdict {
  action?: unknown;
  tier?: unknown;
  directed?: unknown;
  confidence?: unknown;
}

export class LlmIntentClassifier implements IntentClassifier {
  private readonly intelligence?: IntelligenceProvider;
  private readonly heuristic: IntentClassifier;
  private readonly timeoutMs: number;
  private readonly onDegrade?: (reason: LlmIntentDegradeReason) => void;

  constructor(deps: LlmIntentClassifierDeps = {}) {
    this.intelligence = deps.intelligence;
    this.heuristic = deps.heuristic ?? new HeuristicIntentClassifier();
    this.timeoutMs = deps.timeoutMs ?? 8000;
    this.onDegrade = deps.onDegrade;
  }

  async classify(text: string, ctx: { directed: boolean }): Promise<RequestIntent> {
    // ── 1. Deterministic floor read FIRST (never delegated to the LLM) ──────────
    // The heuristic is the floor authority. Whatever it returns is the conservative
    // baseline we will never widen past.
    const floorRead = await this.heuristic.classify(text, ctx);

    // If the heuristic flagged a real floor action OR the ambiguous-deploy
    // possibly-floor case (tier 4, no floorAction, low confidence → the gate
    // CLARIFIES), return it AS-IS. The LLM must not get the chance to downgrade a
    // floor candidate into an allow-shaped low tier.
    if (floorRead.floorAction || floorRead.tier >= 4) {
      this.report('floor-deterministic');
      return floorRead;
    }

    // Symmetric to the floor: a recognized-benign CONVERSATIONAL self-post (a
    // note/check-in/reminder into the current conversation — deterministically
    // cleared of any floor/org-write/external/operational marker) is returned AS-IS
    // and the LLM is never consulted. This is the member-seat fix's load-bearing
    // half: reconcile() only ever ESCALATES the tier (Math.max), so without this
    // short-circuit the LLM would re-classify "post a note" up to T2 and re-refuse
    // the member. The deterministic conversational read is the authority here, just
    // as the deterministic floor read is above.
    if (floorRead.conversational) {
      this.report('conversational-deterministic');
      return floorRead;
    }

    // ── 2. No provider → fail closed to the heuristic ───────────────────────────
    if (!this.intelligence) {
      this.report('no-intelligence');
      return floorRead;
    }

    // ── 3. Judgment band: refine the NON-floor intent via the LLM ───────────────
    let raw: string;
    try {
      const { systemPrompt, userPrompt } = buildIntentPrompt(text, ctx);
      raw = await this.intelligence.evaluate(`${systemPrompt}\n\n${userPrompt}`, {
        model: 'fast',
        temperature: 0,
        maxTokens: 200,
        timeoutMs: this.timeoutMs,
        attribution: {
          component: 'LlmIntentClassifier',
          category: 'gate',
          // SAFETY-GATING: this classification feeds an authority gate, so the
          // router provider-swaps on failure before the error reaches us — and if
          // every provider is down the throw lands in the catch below and we fail
          // CLOSED to the heuristic. We never silently degrade to a wider answer.
          gating: true,
        },
      });
    } catch {
      // network/timeout/provider failure / circuit open → fail closed to the
      // deterministic heuristic (which clarifies on ambiguity). NEVER a silent allow.
      this.report('error');
      return floorRead;
    }

    const parsed = parseLlmVerdict(raw);
    if (!parsed) {
      // Unparseable LLM output is a classification FAILURE → fail closed.
      this.report('unparseable');
      return floorRead;
    }

    // ── 4. Reconcile: the LLM may only refine WITHIN the non-floor band ─────────
    return reconcile(floorRead, parsed, ctx);
  }

  private report(reason: LlmIntentDegradeReason): void {
    try {
      this.onDegrade?.(reason);
    } catch {
      /* observability is best-effort and must never affect the verdict */
    }
  }
}

/**
 * Merge the deterministic floor read with the LLM's judgment-band verdict under a
 * FAIL-CLOSED, never-widen rule:
 *
 *   - The floor read is the conservative baseline. If the LLM tries to assert a
 *     floor action OR a tier ≥ 4, that is OUT OF ITS LANE — the floor is
 *     deterministic, so we DROP the LLM result and return the (non-floor) heuristic
 *     read. (A genuine floor would already have short-circuited before the LLM ran.)
 *   - Otherwise the LLM may set the tier in [0,3], the action label, and refine
 *     directedness. Directedness can only be NARROWED (true→false), never widened:
 *     an inbound message the gate already treats as undirected must stay undirected;
 *     the LLM cannot promote overheard chatter into a directed command.
 *   - floorAction is ALWAYS dropped here (left undefined) — the only floor signal
 *     that reaches the gate comes from the deterministic short-circuit above.
 */
function reconcile(
  floorRead: RequestIntent,
  llm: { action: string; tier: SensitivityTier; directed: boolean; confidence: number },
  ctx: { directed: boolean },
): RequestIntent {
  // The LLM tried to claim a floor-level tier — not its lane. Keep the safe
  // deterministic (non-floor) read rather than trusting an LLM floor assertion.
  if (llm.tier >= 4) {
    return floorRead;
  }

  // Directedness: never widen. The caller's ctx.directed is the structural truth
  // (a mention / clear ask was detected upstream). The LLM may only confirm it or
  // narrow it to false (e.g. "this reads as overheard musing, not a command").
  const directed = ctx.directed && llm.directed;

  // Tier: NEVER widen. The LLM may only ESCALATE the heuristic's conservative tier
  // (raise sensitivity), never lower it — a LOWER tier is a WIDER gate verdict (the
  // gate has an unconditional tier-0 allow + role-ceiling checks), so an unbounded
  // llm.tier would let prompt-injected message content downgrade e.g. T3→T0 and widen
  // access (refuse→allow). Clamp to the deterministic floor read, mirroring the
  // one-way `directed` rule above. Letting the LLM CORRECT heuristic over-classification
  // downward is a separate, confidence-gated design decision — not an unbounded side
  // effect of untrusted message content. (Caught by the Phase-5 adversarial review.)
  const tier = Math.max(floorRead.tier, llm.tier) as SensitivityTier;

  return {
    action: llm.action || floorRead.action,
    tier,
    floorAction: undefined, // floor is deterministic-only; never set from the LLM
    confidence: llm.confidence,
    directed,
  };
}

/**
 * Validate + clamp the LLM's raw JSON into a safe judgment-band verdict.
 * Returns null when the payload can't be read as a verdict (→ caller fails closed).
 */
function parseLlmVerdict(
  raw: string,
): { action: string; tier: SensitivityTier; directed: boolean; confidence: number } | null {
  if (!raw || typeof raw !== 'string') return null;

  // Tolerate prose/markdown around the JSON object (some providers wrap it).
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  let obj: RawLlmVerdict;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as RawLlmVerdict;
  } catch {
    return null;
  }

  const tierNum = typeof obj.tier === 'number' ? obj.tier : Number(obj.tier);
  if (!Number.isFinite(tierNum) || !VALID_TIERS.has(tierNum)) return null;

  const action = typeof obj.action === 'string' && obj.action.trim() ? obj.action.trim() : '';
  if (!action) return null;

  let confidence = typeof obj.confidence === 'number' ? obj.confidence : Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  const directed = obj.directed === true || obj.directed === 'true';

  return { action, tier: tierNum as SensitivityTier, directed, confidence };
}

/**
 * Build the intent-classification prompt. It is explicit that the FLOOR is handled
 * elsewhere: the model is told NOT to grant/allow anything and to classify only the
 * non-floor sensitivity band, and to use tier 4 ONLY as a "this might be sensitive,
 * please clarify" signal (which the gate treats conservatively).
 */
function buildIntentPrompt(text: string, ctx: { directed: boolean }): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    'You classify a single Slack message into an INTENT for an authorization gate.',
    'You do NOT decide whether the action is allowed — a separate deterministic gate does that.',
    'Return ONLY a compact JSON object, no prose, with exactly these keys:',
    '  "action":     short verb-phrase label, e.g. "summarize", "post-note", "run-job", "discuss".',
    '  "tier":       integer sensitivity 0-4:',
    '                0 = ambient chatter / reaction, no action requested',
    '                1 = read/inform (summarize, answer, look up, draft but NOT send)',
    '                2 = low-write (post a message/doc, file a ticket, create a calendar hold)',
    '                3 = operational (run a job, modify non-production state, schedule, small spend)',
    '                4 = potentially-PRIVILEGED — use ONLY when it MIGHT touch money, a production',
    '                    deploy, credentials, destructive data ops, an external send, or granting',
    '                    authority. When unsure between 3 and 4, choose 4 (safer; the gate clarifies).',
    '  "directed":   true if the message is a request aimed AT the agent; false if it is overheard',
    '                chatter or musing not addressed to the agent.',
    '  "confidence": 0.0-1.0, your confidence in this classification. Be honest; low confidence on a',
    '                possibly-sensitive message is the correct, safe answer.',
    'Never invent authorization. Never output anything but the JSON object.',
  ].join('\n');

  const userPrompt = [
    `directed_hint: ${ctx.directed ? 'the upstream router saw a mention/clear ask' : 'no mention detected'}`,
    'message:',
    '"""',
    (text || '').slice(0, 2000),
    '"""',
  ].join('\n');

  return { systemPrompt, userPrompt };
}
