/**
 * Internal-ID leak detector (C1+C2 "The Agent Carries the Loop" §4.3, B-IDLEAK).
 *
 * SIGNAL ONLY, and a MITIGATION — not a complete fix (the regex is evadable).
 * It flags raw instar-internal plumbing tokens in *unsolicited, agent-initiated*
 * outbound text — the "I'm not even sure what CMT is" leak the operator hit. It
 * is a JARGON-class signal: it does NOT replace the authority-level
 * guardProxyOutput / redactSecrets passes (those handle real secret/path
 * disclosure). The full-context MessagingToneGate LLM decides whether to reframe;
 * a direct answer to a user who explicitly asked for an identifier should pass.
 */

/** Internal-plumbing token patterns the user has no path to act on. */
const LEAK_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'commitment-id', re: /\bCMT-\d+\b/i },
  { name: 'action-id', re: /\bACT-\d+\b/i },
  { name: 'learning-id', re: /\bLRN-\d+\b/i },
  { name: 'dry-run-flag', re: /\bdryRun\b/ },
  { name: 'rung-internal', re: /\brung-?[0-9]\b/i },
  { name: 'beacon-internal', re: /\bpromise-beacon\b/i },
  { name: 'gate-endpoint', re: /\/(commitments|credentials|operations|coherence|attention)\/[A-Za-z0-9:_-]/ },
  { name: 'sentinel-name', re: /\b\w+Sentinel\b/ },
  { name: 'gate-name', re: /\b\w+(Gate|Watchdog|Reaper)\b/ },
];

export interface InternalIdLeakSignal {
  /** True when an internal-plumbing token is present (a SIGNAL, not a verdict). */
  leaked: boolean;
  /** Distinct pattern names that matched, bounded — for the gate's context. */
  terms: string[];
}

/**
 * Detect internal-ID / plumbing leaks. Returns `{ leaked: false, terms: [] }`
 * when none is found. Never scrubs or blocks — it only signals.
 */
export function detectInternalIdLeak(text: string): InternalIdLeakSignal {
  if (typeof text !== 'string' || !text) return { leaked: false, terms: [] };
  const terms: string[] = [];
  for (const { name, re } of LEAK_PATTERNS) {
    if (re.test(text) && !terms.includes(name)) terms.push(name);
  }
  return { leaked: terms.length > 0, terms };
}
