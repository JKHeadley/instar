/**
 * OverrideDetector — inline-phrasing detection for routing overrides.
 *
 * Per `specs/provider-portability/10-suggest-and-confirm-ux.md` §"Principle
 * 4 — Override via command OR inline phrasing", the user can change a
 * sticky pick mid-flight either by an explicit slash command (handled
 * elsewhere) or by free-text phrasing like "use Gemini for this one".
 *
 * Per the "intelligence over string matching" rule, this is an LLM call,
 * not a regex. Fast-tier (Haiku-class), narrow prompt, single-line JSON
 * output. The detector runs as a passive observer on every inbound user
 * message in topics with an active task — cost-bounded by 1 cheap LLM
 * call per message.
 *
 * The detector returns a structured result the UX layer applies:
 *
 *   { overrideRequested: false }
 *     → no override; carry on with the cached pick or whatever the
 *       gate decided.
 *
 *   { overrideRequested: true, framework?, model?, scope }
 *     → the user asked to switch. `framework` and `model` are best-
 *       effort extraction (either may be undefined if the user said
 *       "use the cheaper one" without naming a specific). `scope` is
 *       "this-task" for one-off ("for this one") or "this-pattern"
 *       for persistent ("always use X for refactors").
 */

import type { IntelligenceProvider } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverrideDetectorOptions {
  intelligence: IntelligenceProvider;
  /** Known framework slugs the user might name. e.g. ["claude-code", "codex-cli"]. */
  knownFrameworks: ReadonlyArray<string>;
  /** Known model slugs. e.g. ["opus-4.7", "gpt-5.3-codex", "gemini", "deepseek-v4"]. */
  knownModels: ReadonlyArray<string>;
  /** Optional prompt-template override (for tests / tuning). */
  promptTemplate?: string;
  /** Optional maxTokens budget. Default: 64. */
  maxTokens?: number;
}

export interface OverrideDetectInput {
  /** The user message text to classify. */
  message: string;
}

export type OverrideScope = 'this-task' | 'this-pattern';

export type OverrideDetectResult =
  | { overrideRequested: false }
  | {
      overrideRequested: true;
      framework?: string;
      model?: string;
      scope: OverrideScope;
    };

// ---------------------------------------------------------------------------
// Default prompt
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_TEMPLATE = `\
You detect whether a user message is requesting a framework / model override for the current task.

Known frameworks: {{FRAMEWORKS}}
Known models: {{MODELS}}

Reply with ONE JSON object, no markdown, no prose:
{"override": <boolean>, "framework": <string|null>, "model": <string|null>, "scope": "this-task"|"this-pattern"}

Rules:
  - "override": true ONLY when the user is asking to change the framework or model. Off-topic chat, general questions, follow-up clarifications → false.
  - "framework" / "model": the slug from the known lists if the user names one. null when they say "the cheaper one" / "whatever's free" / no specific name.
  - "scope": "this-task" for one-off ("use Gemini for this one", "try Codex just for this"). "this-pattern" for persistent ("always use X for refactors", "set Gemini as the default"). Default to "this-task" if ambiguous.

Examples:
  Message: "use Gemini for this one"
  → {"override": true, "framework": null, "model": "gemini", "scope": "this-task"}

  Message: "always use codex-cli for refactors"
  → {"override": true, "framework": "codex-cli", "model": null, "scope": "this-pattern"}

  Message: "what does that error mean"
  → {"override": false, "framework": null, "model": null, "scope": "this-task"}

  Message: "use the cheaper one"
  → {"override": true, "framework": null, "model": null, "scope": "this-task"}

Message:
{{MESSAGE}}

JSON:`;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const NO_OVERRIDE: OverrideDetectResult = { overrideRequested: false };

export class OverrideDetector {
  private readonly intelligence: IntelligenceProvider;
  private readonly promptTemplate: string;
  private readonly maxTokens: number;
  private readonly knownFrameworks: ReadonlySet<string>;
  private readonly knownModels: ReadonlySet<string>;

  constructor(options: OverrideDetectorOptions) {
    this.intelligence = options.intelligence;
    this.promptTemplate = options.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE;
    this.maxTokens = options.maxTokens ?? 64;
    this.knownFrameworks = new Set(options.knownFrameworks);
    this.knownModels = new Set(options.knownModels);
  }

  async detect(input: OverrideDetectInput): Promise<OverrideDetectResult> {
    // Cheap early exit: empty / whitespace-only messages can't be overrides.
    if (!input.message || !input.message.trim()) return NO_OVERRIDE;

    const prompt = this.buildPrompt(input.message);

    let raw: string;
    try {
      raw = await this.intelligence.evaluate(prompt, {
        model: 'fast',
        maxTokens: this.maxTokens,
        temperature: 0,
      });
    } catch {
      return NO_OVERRIDE;
    }

    return this.parseResult(raw);
  }

  private buildPrompt(message: string): string {
    return this.promptTemplate
      .replace(
        '{{FRAMEWORKS}}',
        Array.from(this.knownFrameworks).join(', ') || '(none)',
      )
      .replace(
        '{{MODELS}}',
        Array.from(this.knownModels).join(', ') || '(none)',
      )
      .replace('{{MESSAGE}}', message.length > 800 ? message.slice(0, 800) + ' …' : message);
  }

  private parseResult(raw: string): OverrideDetectResult {
    const trimmed = raw.trim();
    // Extract the first JSON object in the response. Models sometimes
    // wrap in code fences despite instructions.
    const match = trimmed.match(/\{[\s\S]*?\}/);
    if (!match) return NO_OVERRIDE;

    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return NO_OVERRIDE;
    }
    if (typeof parsed !== 'object' || parsed === null) return NO_OVERRIDE;

    const p = parsed as Record<string, unknown>;
    if (p.override !== true) return NO_OVERRIDE;

    const framework = this.normalizeNamed(p.framework, this.knownFrameworks);
    const model = this.normalizeNamed(p.model, this.knownModels);
    const scope = p.scope === 'this-pattern' ? 'this-pattern' : 'this-task';

    // Only return an override if we actually identified a change of some
    // kind. "override: true" with no framework AND no model is the
    // "the cheaper one" / unnamed case — still a valid override; the UX
    // layer interprets unnamed picks by deferring to the routing layer.
    const result: OverrideDetectResult = { overrideRequested: true, scope };
    if (framework !== undefined) result.framework = framework;
    if (model !== undefined) result.model = model;
    return result;
  }

  private normalizeNamed(raw: unknown, allowed: ReadonlySet<string>): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const lower = raw.toLowerCase().trim();
    if (!lower || lower === 'null') return undefined;
    if (allowed.has(lower)) return lower;
    // The model named something not in our list — discard rather than
    // propagate an unknown slug downstream.
    return undefined;
  }
}
