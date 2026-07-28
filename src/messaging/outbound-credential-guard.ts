/**
 * outbound-credential-guard — the ONE hard wall left in the outbound path.
 *
 * Operator directive (2026-07-19, topic 33368), approving the advisory
 * migration: *"Every representation and judgment call becomes a nudge I can
 * override, with my reason recorded each time. Exactly one thing stays a hard
 * wall: an actual live credential or password appearing in a message."*
 *
 * WHY THIS IS DETERMINISTIC AND NOT AN LLM RULE
 * A judgment ("is this file path useful context or leaked internals?") is an
 * opinion, and an opinion the agent must be able to overrule — otherwise the
 * disagreement that the decision-quality meter grades can never exist. Credential
 * exposure is not an opinion: it is irreversible (the secret is burned the moment
 * it lands in a chat log), and "let me override it" is the wrong option to offer.
 * So it runs here — before the LLM authority, needing no model, no subprocess,
 * and no availability — beside the localhost-link guard, on the same reasoning.
 *
 * PRECISION OVER RECALL, DELIBERATELY. A false positive here costs the agent a
 * rephrase — the exemption clause's own test ("try again with the right
 * arguments") — but it costs it on the ONE channel the operator hears through,
 * with no override. So the bar is: a match must be a credential VALUE, not a
 * string that mentions one.
 *
 * ONLY PROVIDER-PREFIXED VALUE SHAPES QUALIFY. The admitted kinds all begin with
 * a vendor-assigned literal prefix (`sk-ant-`, `ghp_`, `AKIA`, `xoxb-`, `AIza`,
 * …) or are a structurally unambiguous block (`-----BEGIN … PRIVATE KEY-----`).
 * Three kinds from the shared list are DELIBERATELY EXCLUDED because they match
 * on a LABEL near a long word rather than on the value's own shape, and review
 * demonstrated each of them firing on ordinary technical prose:
 *
 *   - `labeled-secret` — `/(?:token|secret|password|…)["'=:\s]+([A-Za-z0-9._-]{12,})/i`
 *     matches "Disable **password authentication** in the sshd config",
 *     "I tightened the **password requirements**", "the **token** refresh_interval
 *     is 15 minutes". It is also not even a good credential detector in the
 *     direction that matters: a REAL leaked `password: hunter2` does NOT match,
 *     because the value is under the 12-char floor. It blocks English and passes
 *     the credential — the worst of both directions for an unoverridable wall.
 *   - `bearer-token` — `/Bearer\s+[A-Za-z0-9_\-.]{20,}/` matches
 *     "Use the header Authorization: Bearer YOUR_DASHBOARD_TOKEN_HERE", the exact
 *     placeholder shape this project's own docs use.
 *   - `jwt` — three dot-separated base64 runs also describe content hashes and
 *     chained digests, which instar messages legitimately carry.
 *
 * Excluding them is NOT "leaving them unguarded to nothing": they remain subject
 * to the LLM authority as an OVERRIDABLE nudge, and to `scrubForStore` at every
 * durable write. What is honestly true — and stated in the spec rather than
 * glossed — is that for credential shapes outside this list, protection is
 * WEAKER after the migration than before, because the incidental LLM catch
 * became overridable. That is the accepted trade, not a claim of strict
 * improvement.
 *
 * The pattern list is IMPORTED from `durableSecretScrub`, never re-declared: a
 * second copy of a security pattern list is a copy that drifts. `assertHardWallKindsExist`
 * + the pinning test fail the build if an upstream rename silently empties a kind.
 */

import { DURABLE_SECRET_PATTERNS, type DurableSecretKind } from '../core/durableSecretScrub.js';

/**
 * The credential kinds that constitute a hard wall. Every entry is
 * provider-prefixed or structurally unambiguous — a match is a credential, not
 * a string that resembles one.
 */
export const HARD_WALL_CREDENTIAL_KINDS: ReadonlySet<DurableSecretKind> = new Set<DurableSecretKind>([
  'anthropic-key',
  'stripe-key',
  'openai-key',
  'github-token',
  'google-api-key',
  'slack-token',
  'aws-access-key',
  'telegram-bot-token',
  'pem-private-key',
  'url-embedded-credential',
]);

/**
 * Kinds the shared list defines that this wall REFUSES to enforce, each with the
 * reason. Exported so the pinning test can assert the exclusion is deliberate
 * rather than an omission — and so a future author adding one back has to delete
 * a line that explains why it is here.
 */
export const HARD_WALL_EXCLUDED_KINDS: Readonly<Record<string, string>> = {
  'labeled-secret': 'label-proximity match — fires on "disable password authentication"; misses a real short password',
  'bearer-token': 'label-proximity match — fires on the documented "Bearer YOUR_TOKEN_HERE" placeholder shape',
  jwt: 'three dot-separated base64 runs also describe content hashes and chained digests',
};

/**
 * Fail the build if a hard-wall kind no longer exists in the shared pattern
 * list. Without this, an upstream rename silently empties part of an
 * unoverridable safety floor and every test still passes — the wall would
 * quietly stop walling. Called by the pinning unit test.
 */
export function assertHardWallKindsExist(): string[] {
  const present = new Set(DURABLE_SECRET_PATTERNS.map((p) => p.kind as string));
  return [...HARD_WALL_CREDENTIAL_KINDS].filter((k) => !present.has(k));
}

export interface OutboundCredentialDetection {
  detected: boolean;
  /**
   * The credential CLASS that matched — never the matched value itself.
   * `oversize-unscannable` is the refusal marker for input past MAX_SCAN_BYTES:
   * not a credential sighting, but a refusal to certify the message as clean.
   */
  kind?: DurableSecretKind | 'oversize-unscannable';
}

/**
 * Detect a live credential in outbound text.
 *
 * NEVER returns the matched substring. The caller writes this into an error
 * body, a log line, and an audit row; a guard that echoes the secret it caught
 * has leaked it into three more places than the message would have.
 *
 * Fails CLOSED-toward-sending on an internal error (returns not-detected): this
 * function runs in front of every outbound message, and a throwing regex must
 * not become an outage. The LLM authority downstream still reviews the message.
 */
/**
 * Input ceiling. The scan is linear (the shared list's pinned linearity
 * contract), but linear over 12 MB is still ~140 ms of synchronous event-loop
 * time, and two outbound routes have no length cap of their own.
 *
 * Over the bound the guard REFUSES rather than passing. Note this is the
 * OPPOSITE fail-direction from a detector fault below, and deliberately so: a
 * throwing regex is an internal failure the LLM authority still backstops,
 * whereas "the message is too big to scan" would otherwise be a trivial bypass
 * of the one unoverridable wall — pad past the bound and walk through.
 */
export const MAX_SCAN_BYTES = 1_000_000;

export function detectOutboundCredential(text: string): OutboundCredentialDetection {
  if (!text) return { detected: false };
  if (text.length > MAX_SCAN_BYTES) return { detected: true, kind: 'oversize-unscannable' };
  try {
    for (const pattern of DURABLE_SECRET_PATTERNS) {
      if (!HARD_WALL_CREDENTIAL_KINDS.has(pattern.kind)) continue;
      // The shared patterns carry the /g flag, so lastIndex is stateful across
      // calls on a shared RegExp object. Reset before every test.
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) {
        pattern.regex.lastIndex = 0;
        return { detected: true, kind: pattern.kind };
      }
    }
  } catch {
    // @silent-fallback-ok — a detector fault must never wedge the outbound
    // path; the LLM authority still reviews this message.
    return { detected: false };
  }
  return { detected: false };
}

/**
 * The refusal text handed back to the agent. Names the credential CLASS and the
 * remedy, never the value — and deliberately offers no override, because there
 * is none.
 */
export function credentialGuardMessage(kind: DurableSecretKind | 'oversize-unscannable'): string {
  if (kind === 'oversize-unscannable') {
    return (
      `Message blocked: it is too large to scan for credential exposure (over ${MAX_SCAN_BYTES} bytes), ` +
      `so it cannot be certified clean. Split it, or publish the bulk content as a private view and send the link.`
    );
  }
  return (
    `Message blocked: it contains what looks like a live credential (${kind}). ` +
    `This is the one outbound check with no override — a credential in a chat log is burned the moment it lands. ` +
    `Remove the value and refer to the secret by NAME instead; if the recipient needs it, route it through Secret Drop.`
  );
}
