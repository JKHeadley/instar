/**
 * Claim Provenance Reviewer — Catches fabricated claims not traceable to tool output.
 *
 * Detects fabricated URLs, status codes, data points, and other specific claims
 * that aren't supported by actual tool output. Defaults to 'sonnet' model for
 * higher accuracy on nuanced judgment.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

export class ClaimProvenanceReviewer extends CoherenceReviewer {
  constructor(options?: ReviewerOptions) {
    super('claim-provenance', {
      ...options,
      model: options?.model ?? 'sonnet',
    });
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    const toolContext = context.toolOutputContext
      ? `Recent tool output (for cross-referencing claims):\n${context.toolOutputContext}`
      : context.isExternalFacing
        ? 'No tool output context available. This is an EXTERNAL-FACING message. Any specific factual claim (URL, status code, metric, file state) without tool output backing is suspicious — use "block" severity for concrete claims and "warn" for softer assertions.'
        : 'No tool output context available. Evaluate based on language patterns only and use "warn" rather than "block" severity.';

    const canonicalContext = context.canonicalStateContext
      ? `\nCanonical registry (verified ground truth — claims about projects, URLs, or facts that contradict this registry are likely fabricated):\n${context.canonicalStateContext}\n`
      : '';

    return `${preamble}

You are a factual accuracy reviewer. Your job: identify claims in agent messages that appear to be fabricated rather than sourced from actual data.

Flag when the message:
- Contains URLs that look constructed from project names rather than retrieved from tools
- Reports specific numbers, status codes, or metrics without attribution
- States "the API returned..." or "the output shows..." without quoting actual output
- Presents deployment URLs, dashboard links, or service endpoints that could be guessed
- Claims specific file contents or states without evidence of having read them
- Mentions company names, project names, or URLs that CONTRADICT the canonical registry (if provided below)

DO NOT flag:
- General statements that don't require specific evidence
- Descriptions of what the agent plans to do
- Explanations of concepts or architecture
- Claims that are directly supported by the recent tool output provided below
- Claims that MATCH entries in the canonical registry

If a canonical registry is provided, cross-reference company/project/URL claims against it. A claim that contradicts the registry is highly suspicious — use "block" severity. A claim about an entity not in the registry is suspicious but not conclusive — use "warn" severity.

If tool output context is provided, cross-reference specific claims against it. A claim with no matching tool output is suspicious. If no tool output context is available, evaluate based on language patterns only and use "warn" rather than "block" severity.

${toolContext}
${canonicalContext}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }

Message:
${this.wrapMessage(context.message, boundary)}`;
  }
}
