# Side-effects review — org-intent tradeoff helper (Phase 3)

Spec: `docs/specs/ORG-INTENT-TRADEOFF-HELPER-SPEC.md`
ELI16: `docs/specs/ORG-INTENT-TRADEOFF-HELPER-SPEC.eli16.md`
Phase: 3 of 4. Phase 1 shipped as v1.2.23 (PR #315). Phase 2 shipped in PR #317. Phase 4 (drift detection job) queued.

## Surface map

| Change | File | Type |
|---|---|---|
| Pure `resolveTradeoff()` function + `TradeoffResolution` type | `src/core/TradeoffResolver.ts` (new file) | Additive module |
| New `POST /intent/tradeoff-resolve` HTTP route | `src/server/routes.ts` | Additive route |
| CLAUDE.md ORG-INTENT subsection adds Phase 3 curl line | `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` | Doc + migration |
| Tier 1 unit tests (resolver + migration) | `tests/unit/TradeoffResolver.test.ts` (new), `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` (extended) | Test addition |
| Tier 2 integration tests | `tests/integration/org-intent-routes.test.ts` (extended) | Test addition |
| Tier 3 E2E test | `tests/e2e/org-intent-tradeoff-lifecycle.test.ts` (new) | Test addition |

## Over-block analysis

**Could the new helper ever block an outbound message?**

No. The resolver is pure deterministic logic with no authority over outcomes. The Coherence Gate from Phase 1 remains the only place where ORG-INTENT can block a message. Per `feedback_signal_vs_authority`, the resolver is SIGNAL — it tells callers what the hierarchy says; it never refuses anything.

**Could the route be DoS'd?**

The route reads `ORG-INTENT.md` from the agent's state dir on every request — bounded local disk read, no LLM call, no DB query. Auth middleware enforces Bearer-token gating. No new abuse surface beyond what `GET /intent/org` already exposes.

**Could the resolver return a wrong winner?**

Three risk vectors:

1. **String matching false positives** — value "speed" might substring-match "execution speed of light." The resolver's case-insensitive substring containment is permissive by design. For ambiguous cases the caller should be specific in their value strings. This is documented in the resolver's source comments.

2. **Same-entry tie** — if both values appear in the same hierarchy entry without a "X over Y" pair pattern, the resolver returns `basis: 'tie'` and `winner: null`. Caller decides what to do — typically escalates to the value-alignment reviewer.

3. **Pair-pattern misparsing** — the resolver only recognizes the six listed patterns (`over`, `before`, `above`, `trumps`, `wins over`, `beats`). Other phrasings fall through to list-order matching. This is acceptable; future iterations can extend the pattern list.

## Under-block analysis

**What does the resolver NOT catch?**

- Multi-value tradeoffs (three or more contending values). The function signature is `(valueA, valueB)`. Callers wanting to resolve a three-way race must call the resolver twice and compose. Future iteration may add `resolveTradeoffN([...])` if demand surfaces.
- Context-dependent applicability. A constraint like "customer trust over speed" may not apply in some channels (e.g. an internal status update where speed is fine). The resolver doesn't model channels; the caller decides applicability.
- Stale state. The route reads `ORG-INTENT.md` on every request, so edits propagate immediately — but if the hierarchy is changed mid-session, the agent's session-start injection (Phase 2) still shows the old version until next session.

## Level-of-abstraction fit

`TradeoffResolver` is pure logic, single file, no dependencies — the right level for a deterministic helper. The HTTP route lives next to the other `/intent/*` routes. No new abstractions introduced. The helper is intentionally NOT exposed as a class — a free function is the right shape for a stateless pure computation.

## Signal-vs-authority compliance

The resolver is **SIGNAL** — pure deterministic computation, no authority over outcomes. The Coherence Gate from Phase 1 remains **AUTHORITY** for any value-alignment block. Callers who consult the resolver are free to override its conclusion. The reviewer in the gate is also free to disagree with the resolver's `basis: 'list-order'` reading if it has better contextual reasoning.

This is exactly the signal/authority separation per `feedback_signal_vs_authority`. Future Phase 4 drift detection should follow the same pattern — emit a digest signal, never block.

## Interactions with existing systems

| System | Interaction | Risk |
|---|---|---|
| Coherence Gate (Phase 1) | None — gate's value-alignment reviewer continues using LLM-based resolution | None |
| Session-start injection (Phase 2) | None — independent surface | None |
| `GET /intent/org` | Sibling route — same source data, different output shape | None |
| `OrgIntentManager.parse()` | Resolver consumes the `tradeoffHierarchy` field | Read-only — no mutation |
| Existing routes | No conflict — `/intent/tradeoff-resolve` is a new path | None |

## Rollback cost

Low. Three options:

1. **Code revert**: `git revert <PR-merge-sha>` removes the new file, the new route, and the new test files. No data migration to roll back.
2. **Soft revert via 404**: rename the new route in `routes.ts`. The `TradeoffResolver` module remains as dead code; nothing else consumes it.
3. **Just don't call it**: the route is opt-in. No code path that existed before this PR calls the new route, so leaving it un-called is equivalent to it not existing.

## Test coverage summary

| Tier | File | Tests | Status |
|---|---|---|---|
| 1 (unit) | `tests/unit/TradeoffResolver.test.ts` | 16 | ✓ passing |
| 1 (unit) | `tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts` (extended) | 8 (1 new for Phase 3) | ✓ passing |
| 2 (integration) | `tests/integration/org-intent-routes.test.ts` (extended) | 16 (5 new for Phase 3) | ✓ passing |
| 3 (E2E lifecycle) | `tests/e2e/org-intent-tradeoff-lifecycle.test.ts` | 5 | ✓ passing |

## Open follow-ups (deferred to later phases, NOT this PR)

- Phase 4: periodic drift detection job sampling recent outbound actions vs intent.
- `resolveTradeoffN([...])` for multi-way tradeoff resolution.
- Channel/recipient scoping on constraints + tradeoffs.
- Optional LLM fallback when `basis: 'no-match'` — caller-controlled escalation path.
