# Side-effects review — dynamic-MCP capability classification + silent-fallback ratchet

**Change:** Two CI-guardrail fixes for the dynamic-MCP PR (#1293):
- `src/server/CapabilityIndex.ts`: add `{ prefix: 'mcp', reason: ... }` to
  INTERNAL_PREFIXES — the `/mcp/*` routes are dark/experimental (503 when off), so they
  are agent-invisible in /capabilities until matured (the honest classification; the
  agent learns the feature via the CLAUDE.md awareness section).
- `tests/unit/no-silent-fallbacks.test.ts`: raise the ratchet baseline 476→488 with a
  justification — the +12 are the feature's INTENTIONAL fail-safes (fail toward full
  .mcp.json / abort, never a wrong action), documented in the spec + side-effects.

## 1. Blast radius
Zero behavior change. INTERNAL_PREFIXES classification only affects whether /mcp shows
in the /capabilities discovery list (it doesn't — correct for a dark feature). The
ratchet baseline is a test threshold, not runtime code.

## 2. Reversibility
Fully reversible — remove the prefix entry / restore the baseline number.

## 3. State / data touched
None.

## 4. Failure modes
None introduced. The classification is the deliberate "skip discovery" choice the lint
offers; the ratchet still prevents net regressions beyond 488.

## 5. Security / authority
None. Hiding a dark feature from discovery is the conservative choice (does not surface
an unavailable capability as available).

## 6. Framework generality
N/A (classification + a test threshold).

## 7. Tests
144 tests pass (capabilities-discoverability 139 + no-silent-fallbacks 5). tsc clean.
These were the only two failing tests across the #1293 CI shards (1/4 + 3/4).
