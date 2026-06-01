/**
 * ThreadlineGroundingGate — "Ground Before You Assert" for OUTBOUND agent-to-agent
 * messages (the constitution's proposed Interaction principle; companion to the
 * pre-Telegram grounding gate).
 *
 * Pure, side-effect-free claim analysis: given the text an agent is about to send
 * to a peer, surface the claims that need verification BEFORE they leave — so an
 * unverified fact doesn't propagate to another agent as truth. The first concrete
 * check is URL provenance: a scheme-qualified URL to an unfamiliar host that the
 * agent has NOT confirmed this session is flagged, because that is exactly the
 * class that caused the 2026-05-31 cross-agent incoherence (a peer handed over a
 * `https://…` endpoint that 404'd, propagated as fact).
 *
 * This module is the DECISION; wiring it as a hard pre-send gate on threadline_send
 * (block / require-confirm) is a separate step. Signal-vs-Authority: the gate
 * returns structured issues; the caller chooses to block, warn, or require a
 * verification step.
 */

export interface GroundingIssue {
  kind: 'ungrounded-url' | 'malformed-url';
  detail: string;
}

export interface GroundingContext {
  /** Hosts that never need grounding (suffix-matched), in addition to the defaults. */
  knownDomains?: string[];
  /** Exact URLs the agent has confirmed resolve THIS session (e.g. curl-verified). */
  verifiedUrls?: string[];
}

export interface GroundingResult {
  /** True when no claim needs grounding. */
  allow: boolean;
  issues: GroundingIssue[];
}

/** Hosts that are part of the agent's own surface / well-known infra. */
const DEFAULT_KNOWN_DOMAINS = [
  'localhost',
  'github.com',
  'githubusercontent.com',
  'npmjs.com',
  'anthropic.com',
  'claude.com',
];

function hostIsKnown(host: string, known: Set<string>): boolean {
  for (const d of known) {
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

/**
 * Evaluate an outbound peer message for ungrounded claims. Only scheme-qualified
 * (`http(s)://`) URLs are checked — bare host references (e.g. `dawn.bot-me.ai/x`)
 * are intentionally NOT flagged, matching the convention that a bare host conveys
 * the same curl-verified info without asserting a live, fetchable endpoint.
 */
export function evaluateOutboundGrounding(message: string, ctx: GroundingContext = {}): GroundingResult {
  const known = new Set<string>([...DEFAULT_KNOWN_DOMAINS, ...(ctx.knownDomains ?? [])]);
  const verified = new Set<string>(ctx.verifiedUrls ?? []);
  const issues: GroundingIssue[] = [];

  const urls = message.match(/https?:\/\/[^\s)"'>\]]+/g) ?? [];
  for (const raw of urls) {
    const url = raw.replace(/[.,;:]+$/, ''); // trim trailing punctuation
    if (verified.has(url) || verified.has(raw)) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      issues.push({ kind: 'malformed-url', detail: `${raw} is not a parseable URL.` });
      continue;
    }
    if (!hostIsKnown(host, known)) {
      issues.push({
        kind: 'ungrounded-url',
        detail: `${url} — unfamiliar host "${host}". Verify it resolves (curl) before asserting it to a peer, ` +
          `or reference it bare (no scheme) if it carries already-verified info.`,
      });
    }
  }

  return { allow: issues.length === 0, issues };
}
