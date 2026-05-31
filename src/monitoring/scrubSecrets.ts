/**
 * scrubSecrets — shared deterministic secret-redaction pass.
 *
 * Extracted from CiFailurePoller (which still re-exports it for back-compat) so
 * the Correction & Preference Learning Sentinel can apply the SAME regex on both
 * sides of its LLM hop (spec §3.3):
 *   - PRE-SCRUB: applied to captured turns BEFORE they enter the distill prompt
 *     (the egress boundary — scrubbed-but-real context reaches the provider).
 *   - POST-SCRUB: applied to the LLM's learning + scrubbed_summary BEFORE persist
 *     (LLM scrubbing is best-effort recall reduction; this regex is the guarantee).
 *
 * Best-effort, deterministic, no I/O. The regex pass is biased toward catching
 * common token SHAPES; it is the guarantee that obvious secrets never reach the
 * provider or the ledger. It is NOT a substitute for not capturing secrets in
 * the first place — but combined with the metadata-only ledger discipline it is
 * the structural privacy boundary.
 *
 * Coverage (spec §3.3 / round-2 security NEW-3): GitHub PATs (ghp_/gho_/...),
 * generic sk-/pk-/rk- keys, JWTs, key=value secret pairs, Telegram bot tokens,
 * AWS access key IDs, Slack tokens, and URLs with embedded credentials.
 */

export function scrubSecrets(text: string): string {
  return String(text)
    // GitHub personal-access / OAuth / app tokens (ghp_, gho_, ghu_, ghs_, ghr_).
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh***_REDACTED')
    // Generic provider keys: sk-/pk-/rk- prefixed.
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9]{16,}/g, '$1-REDACTED')
    // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs- + segments.
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox*-REDACTED')
    // Telegram bot tokens: <digits>:<35-char base64url-ish secret>.
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, 'TELEGRAM_BOT_TOKEN_REDACTED')
    // AWS access key IDs (AKIA/ASIA + 16 uppercase alphanumerics).
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AWS_ACCESS_KEY_REDACTED')
    // JWTs: three base64url segments.
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g, 'JWT_REDACTED')
    // URLs with embedded credentials (scheme://user:pass@host).
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]+@/gi, '$1://REDACTED:REDACTED@')
    // Generic labelled secret pairs (token=..., api_key: ..., password "...").
    .replace(/((?:token|secret|password|api[_-]?key)["'=:\s]+)[A-Za-z0-9._-]{12,}/gi, '$1REDACTED');
}
