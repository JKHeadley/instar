// Credential-shape check for the Conversations composer (dashboard-conversations-browser-device.md §4.8).
//
// A browser copy of the server's detectOutboundCredential (src/messaging/outbound-credential-guard.ts)
// over the hard-wall kinds of DURABLE_SECRET_PATTERNS (src/core/durableSecretScrub.ts). It is ADVICE:
// on a match the page asks the operator ("Secret Drop link, or send as written?") and never blocks
// a send. tests/unit/console-credential-shape-parity.test.ts runs this copy and the server function on
// one fixture set, so the two cannot drift apart unnoticed.
//
// Kept exactly as the server does it: only the hard-wall kinds (jwt, bearer-token and labeled-secret
// are excluded on purpose), the raw text AND the text with invisible interleave characters removed
// are both scanned, and text longer than MAX_SCAN_BYTES counts as a match.

export const MAX_SCAN_BYTES = 1_000_000;

const INVISIBLE_INTERLEAVE = /[\p{Cf}͏︀-️]/gu;

/** The hard-wall kinds, in the server's pattern order (non-global copies: no shared lastIndex). */
export const CREDENTIAL_PATTERNS = [
  { kind: 'anthropic-key', regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'stripe-key', regex: /sk_(?:live|test)_[A-Za-z0-9]{12,}/ },
  { kind: 'openai-key', regex: /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/ },
  { kind: 'openai-key', regex: /(?<![A-Za-z0-9])sk-(?:proj|svcacct|admin|None|or-v1)-[A-Za-z0-9_-]{32,}/ },
  { kind: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { kind: 'github-token', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}/ },
  { kind: 'google-api-key', regex: /\bAIza[A-Za-z0-9_-]{35}/ },
  { kind: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: 'telegram-bot-token', regex: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/ },
  { kind: 'pem-private-key', regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,8192}?-----END[A-Z ]*PRIVATE KEY-----/ },
  { kind: 'url-embedded-credential', regex: /([a-z][a-z0-9+.-]{0,63}:\/\/)[^/\s:@]+:[^/\s@]+@/ },
];

/** { detected, kind? } — the kind of credential that matched, never the matched text. */
export function detectCredentialShape(text) {
  if (typeof text !== 'string' || !text) return { detected: false };
  if (text.length > MAX_SCAN_BYTES) return { detected: true, kind: 'oversize-unscannable' };
  try {
    const stripped = text.replace(INVISIBLE_INTERLEAVE, '');
    const variants = stripped === text ? [text] : [text, stripped];
    for (const scanned of variants) {
      for (const p of CREDENTIAL_PATTERNS) if (p.regex.test(scanned)) return { detected: true, kind: p.kind };
    }
  } catch {
    return { detected: false }; // @silent-fallback-ok: advice only; the operator can still send
  }
  return { detected: false };
}

/** The question the composer asks on a match (the phone's wording, mobile-native-conversations.md §4.2). */
export const CREDENTIAL_QUESTION = 'This looks like a password or key. If you send it, it is saved in this conversation\'s history on every machine of this agent, in plain text. Send it through a Secret Drop link instead, or send as written?';
