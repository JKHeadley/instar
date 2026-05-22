/**
 * TradeoffResolver — deterministic tie-breaker for two contending values per
 * the org's `tradeoffHierarchy` from `ORG-INTENT.md`.
 *
 * Phase 3 of the ORG-INTENT runtime project. Phase 1 wired the gate; Phase 2
 * injected the contract at session-start; Phase 3 makes the tradeoff hierarchy
 * mechanically consultable by any caller — research agents, planning paths,
 * the value-alignment reviewer itself when it sees a values collision.
 *
 * The resolver is pure logic over the parsed hierarchy. It does not make value
 * judgments; it does not call an LLM. Given two value strings (e.g. "speed" and
 * "trust") and the hierarchy list, it returns which one wins, the basis for
 * the decision, and an explanation that callers can surface to users or LLMs.
 *
 * Match strategy (in order):
 *   1. **Pair-pattern match**: hierarchy entries written as "X over Y" or
 *      "X before Y" or "X above Y" — if both arguments match X and Y, the
 *      stated winner is returned regardless of list position.
 *   2. **List-order match**: each argument is matched against hierarchy entries
 *      via case-insensitive substring containment. The argument whose match
 *      lands at the EARLIEST index wins.
 *   3. **No match**: neither argument is found in the hierarchy → null winner,
 *      basis = 'no-match'. Caller decides what to do (typically: ask the LLM,
 *      or fall back to value-alignment review).
 */

// ── Types ────────────────────────────────────────────────────────────

export interface TradeoffResolution {
  /** Which input wins. null when no hierarchy entry decides. */
  winner: 'A' | 'B' | null;
  /** Why the resolver chose that outcome. */
  basis: 'pair-pattern' | 'list-order' | 'no-match' | 'tie';
  /** Human-readable explanation. Safe to surface to users or LLMs. */
  explanation: string;
  /** Index in the hierarchy that matched A (if any). -1 if unmatched. */
  matchedIndexA: number;
  /** Index in the hierarchy that matched B (if any). -1 if unmatched. */
  matchedIndexB: number;
}

export interface TradeoffResolutionInput {
  valueA: string;
  valueB: string;
  hierarchy: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

function containsValue(entry: string, value: string): boolean {
  return normalize(entry).includes(normalize(value));
}

/**
 * Parse "X over Y" / "X before Y" / "X above Y" patterns from a hierarchy entry.
 * Returns { winner, loser } when the pattern matches, null otherwise.
 */
function parsePairPattern(entry: string): { winner: string; loser: string } | null {
  const norm = normalize(entry);
  // Match "X over Y", "X before Y", "X above Y", "X trumps Y", "X wins over Y"
  const patterns = [
    /^(.+?)\s+(?:over|before|above|trumps|wins over|beats)\s+(.+)$/,
  ];
  for (const pattern of patterns) {
    const m = norm.match(pattern);
    if (m && m[1] && m[2]) {
      return { winner: m[1].trim(), loser: m[2].trim() };
    }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Resolve a tradeoff between two values per the organizational hierarchy.
 *
 * @param input.valueA First contending value (free-text, e.g. "speed").
 * @param input.valueB Second contending value (free-text, e.g. "customer trust").
 * @param input.hierarchy Ordered list of hierarchy entries from `ORG-INTENT.md`.
 *   May be a plain ranked list (`["customer trust", "speed"]`) or use "X over Y"
 *   pair patterns (`["customer trust over speed"]`) or any mix.
 * @returns A resolution stating which input wins and why.
 */
export function resolveTradeoff(input: TradeoffResolutionInput): TradeoffResolution {
  const { valueA, valueB, hierarchy } = input;

  if (!valueA || !valueB) {
    return {
      winner: null,
      basis: 'no-match',
      explanation: 'Cannot resolve — both valueA and valueB are required.',
      matchedIndexA: -1,
      matchedIndexB: -1,
    };
  }

  if (!hierarchy || hierarchy.length === 0) {
    return {
      winner: null,
      basis: 'no-match',
      explanation: 'No tradeoff hierarchy defined — no organizational tie-breaker available.',
      matchedIndexA: -1,
      matchedIndexB: -1,
    };
  }

  const normA = normalize(valueA);
  const normB = normalize(valueB);

  // Strategy 1: pair-pattern match. Iterate hierarchy entries; if one has the
  // form "X over Y" and both values match X / Y, that entry decides.
  for (let i = 0; i < hierarchy.length; i++) {
    const pair = parsePairPattern(hierarchy[i]);
    if (!pair) continue;
    const winnerHasA = pair.winner.includes(normA);
    const winnerHasB = pair.winner.includes(normB);
    const loserHasA = pair.loser.includes(normA);
    const loserHasB = pair.loser.includes(normB);
    if (winnerHasA && loserHasB) {
      return {
        winner: 'A',
        basis: 'pair-pattern',
        explanation: `Hierarchy entry "${hierarchy[i]}" places "${valueA}" over "${valueB}".`,
        matchedIndexA: i,
        matchedIndexB: i,
      };
    }
    if (winnerHasB && loserHasA) {
      return {
        winner: 'B',
        basis: 'pair-pattern',
        explanation: `Hierarchy entry "${hierarchy[i]}" places "${valueB}" over "${valueA}".`,
        matchedIndexA: i,
        matchedIndexB: i,
      };
    }
  }

  // Strategy 2: list-order match. Find the earliest hierarchy index containing
  // each value. The earlier index wins. If both match at the same index, it is
  // a tie (rare — same entry mentions both values without a pair pattern).
  let idxA = -1;
  let idxB = -1;
  for (let i = 0; i < hierarchy.length; i++) {
    if (idxA === -1 && containsValue(hierarchy[i], valueA)) idxA = i;
    if (idxB === -1 && containsValue(hierarchy[i], valueB)) idxB = i;
    if (idxA !== -1 && idxB !== -1) break;
  }

  if (idxA !== -1 && idxB === -1) {
    return {
      winner: 'A',
      basis: 'list-order',
      explanation: `"${valueA}" appears in the hierarchy at position ${idxA + 1} ("${hierarchy[idxA]}"); "${valueB}" is not mentioned. The named value wins.`,
      matchedIndexA: idxA,
      matchedIndexB: -1,
    };
  }
  if (idxA === -1 && idxB !== -1) {
    return {
      winner: 'B',
      basis: 'list-order',
      explanation: `"${valueB}" appears in the hierarchy at position ${idxB + 1} ("${hierarchy[idxB]}"); "${valueA}" is not mentioned. The named value wins.`,
      matchedIndexA: -1,
      matchedIndexB: idxB,
    };
  }
  if (idxA !== -1 && idxB !== -1) {
    if (idxA < idxB) {
      return {
        winner: 'A',
        basis: 'list-order',
        explanation: `"${valueA}" appears earlier in the hierarchy (position ${idxA + 1}: "${hierarchy[idxA]}") than "${valueB}" (position ${idxB + 1}: "${hierarchy[idxB]}"). Earlier entry wins.`,
        matchedIndexA: idxA,
        matchedIndexB: idxB,
      };
    }
    if (idxB < idxA) {
      return {
        winner: 'B',
        basis: 'list-order',
        explanation: `"${valueB}" appears earlier in the hierarchy (position ${idxB + 1}: "${hierarchy[idxB]}") than "${valueA}" (position ${idxA + 1}: "${hierarchy[idxA]}"). Earlier entry wins.`,
        matchedIndexA: idxA,
        matchedIndexB: idxB,
      };
    }
    // Same index — both values mentioned in the same entry without a pair pattern
    return {
      winner: null,
      basis: 'tie',
      explanation: `Both values appear in the same hierarchy entry ("${hierarchy[idxA]}") without an explicit "X over Y" pattern. Resolver cannot decide; escalate to value-alignment review.`,
      matchedIndexA: idxA,
      matchedIndexB: idxB,
    };
  }

  // No match
  return {
    winner: null,
    basis: 'no-match',
    explanation: `Neither "${valueA}" nor "${valueB}" appears in the tradeoff hierarchy. The organization has not codified a preference between these two values; escalate to value-alignment review.`,
    matchedIndexA: -1,
    matchedIndexB: -1,
  };
}
