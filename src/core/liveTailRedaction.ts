/**
 * liveTailRedaction — versioned secret-redaction for the live tail (spec §8 G3c).
 *
 * The live tail carries the most sensitive data in the system (user messages,
 * tool outputs, incidentally-present secrets). Before any tail content leaves
 * this machine it is scrubbed of credential-shaped material. The category set
 * is a NAMED, VERSIONED enum (not an ad-hoc inline regex) so it can be extended
 * as new token/credential shapes appear — combined with carry-by-reference for
 * large tool output (§8 G3b), the tail minimizes raw sensitive bytes
 * structurally rather than relying on pattern-matching alone.
 *
 * Bump REDACTION_CATEGORY_VERSION when the category set changes, so a receiver
 * can record which version scrubbed a flush.
 */

export const REDACTION_CATEGORY_VERSION = 1;

export enum RedactionCategory {
  BearerToken = 'bearer-token',
  ApiKey = 'api-key',
  PrivateKeyBlock = 'private-key-block',
  AwsAccessKey = 'aws-access-key',
  SecretAssignment = 'secret-assignment',
  JwtLike = 'jwt-like',
}

interface CategoryRule {
  category: RedactionCategory;
  pattern: RegExp;
}

// Conservative, high-precision patterns — false positives (over-redaction) are
// cheaper than leaking a secret over the wire. Each is global + case-insensitive
// where appropriate.
const RULES: CategoryRule[] = [
  { category: RedactionCategory.PrivateKeyBlock, pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { category: RedactionCategory.BearerToken, pattern: /\bBearer\s+[A-Za-z0-9._\-]{12,}/gi },
  { category: RedactionCategory.AwsAccessKey, pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { category: RedactionCategory.JwtLike, pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g },
  // key/secret/token/password = "value" or : value
  { category: RedactionCategory.SecretAssignment, pattern: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}["']?/gi },
  // Generic long opaque api-key-ish tokens (sk-, ghp_, xoxb-, etc.)
  { category: RedactionCategory.ApiKey, pattern: /\b(?:sk|pk|rk|ghp|gho|ghs|xox[bpoa])[_-][A-Za-z0-9]{16,}\b/g },
];

const PLACEHOLDER = (c: RedactionCategory) => `[redacted:${c}]`;

export interface RedactionResult {
  text: string;
  redactedCount: number;
  categories: RedactionCategory[];
  version: number;
}

/**
 * Redact credential-shaped material from a string. Returns the scrubbed text,
 * how many redactions occurred, and which categories fired (for the flush's
 * redaction metadata).
 */
export function redactForLiveTail(input: string): RedactionResult {
  let text = input;
  let redactedCount = 0;
  const categories = new Set<RedactionCategory>();
  for (const { category, pattern } of RULES) {
    text = text.replace(pattern, () => {
      redactedCount++;
      categories.add(category);
      return PLACEHOLDER(category);
    });
  }
  return { text, redactedCount, categories: [...categories], version: REDACTION_CATEGORY_VERSION };
}
