/**
 * URL Validity Reviewer — Catches fabricated or constructed URLs.
 *
 * Only receives extracted URLs and channel context (data minimization).
 * Detects URLs that appear to be guessed from project names rather than
 * retrieved from actual tool output.
 */

import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewerOptions } from '../CoherenceReviewer.js';

/** Regex to extract URLs from message text. */
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

export class UrlValidityReviewer extends CoherenceReviewer {
  constructor(options?: ReviewerOptions) {
    super('url-validity', options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    // Extract URLs from message or use pre-extracted ones
    const urls = context.extractedUrls ?? extractUrls(context.message);

    const toolContext = context.toolOutputContext
      ? `Recent tool output (for URL cross-referencing):\n${context.toolOutputContext}`
      : context.isExternalFacing
        ? 'No tool output context available. This is an EXTERNAL-FACING message — any URL not in the canonical registry that cannot be verified from tool output should be flagged with "block" severity.'
        : 'No tool output context available.';

    const canonicalContext = context.canonicalStateContext
      ? `\nCanonical registry (verified ground truth — known project URLs and deployment targets):\n${context.canonicalStateContext}\n`
      : '';

    return `${preamble}

You are a URL validity reviewer. Your job: detect URLs in agent messages that appear to be constructed/guessed rather than retrieved from actual data.

Flag when the message contains URLs where:
- The domain appears derived from the project name (project "deep-signal" \u2192 "deepsignal.xyz")
- The URL follows a plausible pattern but wasn't quoted from tool output
- Dashboard, deployment, or service URLs that could be guessed from conventions
- Any URL containing a custom domain that isn't a well-known service
- The URL contradicts known deployment targets in the canonical registry (if provided)

SAFE (do not flag):
- URLs that MATCH entries in the canonical registry (these are verified ground truth)
- Well-known domains ONLY when the URL was present in recent tool output (see context below)
- URLs that are clearly labeled as examples
- localhost URLs when channel is "direct" (flag localhost on ALL external channels \u2014 Telegram, WhatsApp, email, etc. \u2014 suggest tunnel URL instead)
- URLs the agent says it's going to visit/fetch (intent, not claim)

SUSPICIOUS (flag as warn):
- URLs on well-known domains (github.com, vercel.app, npmjs.com) that do NOT appear in recent tool output \u2014 these may be fabricated using domain conventions
- Constructed URLs that follow plausible patterns (project-name.vercel.app) without tool verification

BLOCK (use "block" severity):
- URLs for a known project that DON'T match the canonical registry's deployment targets \u2014 this is a strong signal of hallucination (e.g., agent says "deployed to projectname.com" but registry shows "projectname.vercel.app")

Channel: ${context.channel}

${toolContext}
${canonicalContext}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }

URLs extracted from message:
${this.wrapMessage(JSON.stringify(urls), boundary)}`;
  }
}

/**
 * Extract URLs from a text string.
 */
export function extractUrls(text: string): string[] {
  return Array.from(text.matchAll(URL_REGEX), (m) => m[0]);
}
