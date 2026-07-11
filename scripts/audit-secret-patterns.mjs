/**
 * audit-secret-patterns.mjs — the credential-pattern set for the audit-report
 * secret scan (audit-convergence-enforcement §2 item 1).
 *
 * A PLAIN-JS constant with NO compiled dependency, so both the pre-tsc precommit
 * hook AND the CI ratchet can import it without a build step (Integration-R2
 * new-2: the precommit runs before `tsc`, so it cannot import the TS scrubber
 * modules in `src/core/`). Deliberately conservative high-signal patterns — this
 * gate BLOCKS a commit, so a false positive is costly; the rule the skill teaches
 * is "reference path+line, never quote the secret material", which keeps audit
 * ledgers pattern-free in the first place.
 *
 * Each entry: { name, re }. `re` is tested against a single line (global flag
 * stripped by the caller; we match per-line so the offending line number is
 * reportable).
 */

export const AUDIT_SECRET_PATTERNS = [
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'aws-secret-access-key', re: /\baws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}\b/i },
  { name: 'github-pat', re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: 'github-oauth', re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'generic-bearer', re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/ },
];

/**
 * Scan text (a whole file's content) for credential patterns.
 * Returns [{ line, name }] — 1-indexed line numbers + the pattern that matched.
 * NEVER returns the matched secret substring (that would relocate the leak into
 * the caller's log). Empty array ⇒ clean.
 */
export function scanForSecrets(text) {
  const hits = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of AUDIT_SECRET_PATTERNS) {
      if (re.test(lines[i])) hits.push({ line: i + 1, name });
    }
  }
  return hits;
}
