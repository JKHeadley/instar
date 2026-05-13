/**
 * Redactor — content sanitization for normalized degradation events.
 *
 * Owns the redaction boundary that strips secrets, identifiers, and
 * absolute paths from text before it crosses any persistence, alert,
 * or LLM-prompt surface. The DegradationReporter (F-3) and downstream
 * NormalizedDegradationEvent producers route every user-visible string
 * through this module before emitting events.
 *
 * Surface (per SELF-HEALING-REMEDIATOR-V2-SPEC.md A26 / R1 carry-forward):
 *
 *   const r = new Redactor();
 *   const { text, redactions } = r.redact(raw);
 *   const safe = r.redactFields(event, ['reason', 'detail']);
 *
 * Default rules cover home-directory paths, bearer tokens, Telegram bot
 * tokens, emails, long hex strings, UUIDs, IP addresses, and long numeric
 * IDs. Custom rules can be appended via `extraRules`.
 *
 * F-2 foundation module — built before any v2 wrapper PR (W-*) so that
 * normalized events have a single redaction owner. See spec §A1.
 */

export type RedactionCategory = 'path' | 'secret' | 'pii' | 'identifier' | 'custom';

export interface RedactionRule {
  pattern: RegExp;
  replacement: string;
  category: RedactionCategory;
}

export interface RedactorOptions {
  /** Custom redaction rules to apply in addition to defaults. */
  extraRules?: RedactionRule[];
  /** Whether to redact home-directory paths (default true). */
  redactHomePath?: boolean;
}

export interface RedactionSummary {
  category: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: RedactionSummary[];
}

/**
 * Build the default rule set. Order matters: more specific patterns must
 * run before generic catch-alls (e.g., UUID before long-hex before NUM)
 * so the broader rule doesn't shadow the specific one.
 */
function buildDefaultRules(redactHomePath: boolean): RedactionRule[] {
  const rules: RedactionRule[] = [];

  if (redactHomePath) {
    // Home directory paths on macOS and Linux. Captures path after the
    // username so the entire user-anchored prefix collapses to <HOME>.
    rules.push({
      pattern: /\/(?:Users|home)\/[^/\s]+/g,
      replacement: '<HOME>',
      category: 'path',
    });
  }

  // Bearer tokens — match common Authorization-header shape.
  rules.push({
    pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g,
    replacement: 'Bearer <REDACTED>',
    category: 'secret',
  });

  // Telegram bot tokens — numeric chat-id : random suffix.
  rules.push({
    pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
    replacement: '<TELEGRAM_TOKEN>',
    category: 'secret',
  });

  // Email addresses.
  rules.push({
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '<EMAIL>',
    category: 'pii',
  });

  // UUIDs — run before generic long-hex so they keep their dash form.
  rules.push({
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: '<UUID>',
    category: 'identifier',
  });

  // Long hex strings (SHA hashes, content addresses).
  rules.push({
    pattern: /\b[0-9a-f]{32,64}\b/gi,
    replacement: '<HEX>',
    category: 'identifier',
  });

  // IPv4 addresses.
  rules.push({
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: '<IP>',
    category: 'identifier',
  });

  // IPv6 addresses — match colon-separated hextet groups. Lenient enough
  // to cover compressed forms while avoiding false positives on times.
  rules.push({
    pattern: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi,
    replacement: '<IP>',
    category: 'identifier',
  });

  // Long numeric IDs / timestamps (≥ 6 digits). Lowest priority so it
  // doesn't eat hex/UUID prefixes that already redacted above.
  rules.push({
    pattern: /\b\d{6,}\b/g,
    replacement: '<NUM>',
    category: 'identifier',
  });

  return rules;
}

export class Redactor {
  private readonly rules: RedactionRule[];

  constructor(options: RedactorOptions = {}) {
    const redactHomePath = options.redactHomePath !== false;
    const defaults = buildDefaultRules(redactHomePath);
    this.rules = [...defaults, ...(options.extraRules ?? [])];
  }

  /**
   * Apply every rule in order; tally how many substitutions each category
   * produced so callers can record a redaction summary on the event.
   */
  redact(text: string): RedactionResult {
    if (typeof text !== 'string' || text.length === 0) {
      return { text: text ?? '', redactions: [] };
    }

    const counts = new Map<string, number>();
    let current = text;

    for (const rule of this.rules) {
      // Clone the regex with the global flag so we get an accurate match
      // count without state leakage across calls.
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      const re = new RegExp(rule.pattern.source, flags);

      let matchCount = 0;
      current = current.replace(re, () => {
        matchCount += 1;
        return rule.replacement;
      });

      if (matchCount > 0) {
        counts.set(rule.category, (counts.get(rule.category) ?? 0) + matchCount);
      }
    }

    const redactions: RedactionSummary[] = Array.from(counts.entries()).map(
      ([category, count]) => ({ category, count }),
    );

    return { text: current, redactions };
  }

  /**
   * Apply `redact` to every string-valued field named in `fields`. Non-string
   * fields pass through untouched; missing fields are skipped. Returns a
   * shallow clone — does NOT mutate the caller's object.
   */
  redactFields<T extends Record<string, unknown>>(obj: T, fields: (keyof T)[]): T {
    const clone: Record<string, unknown> = { ...obj };
    for (const key of fields) {
      const value = clone[key as string];
      if (typeof value === 'string') {
        clone[key as string] = this.redact(value).text;
      }
    }
    return clone as T;
  }
}
