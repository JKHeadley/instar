# Side-Effects Review — dashboard headless Gemini framework parity

**Version / slug:** `dashboard-headless-gemini-framework`
**Date:** `2026-06-05`
**Author:** `instar-codey`
**Second-pass reviewer:** `self-review required by session-spawn lifecycle surface; concur`

## Summary of the change

The dashboard headless session-spawn route had a stale framework allowlist that accepted Claude and Codex but rejected Gemini before `SessionManager.spawnSession` could handle the request. This change updates that route-level validation to accept the same three shipped frameworks (`claude-code`, `codex-cli`, `gemini-cli`) and makes route model validation framework-aware for Gemini by accepting the known Gemini CLI model ids exported by the Gemini adapter. Regression tests cover successful Gemini pass-through, invalid-framework error text, and Gemini model acceptance.

## Decision-point inventory

- `POST /sessions/spawn` framework validation — **modify** — widens the accepted framework values to include Gemini, matching the already-supported headless launcher surface.
- `POST /sessions/spawn` model validation — **modify** — routes Gemini requests to Gemini's known-model list instead of falling through to Claude model names.
- Session launching authority — **pass-through** — unchanged; `SessionManager` and `buildHeadlessLaunch` still own actual launch behavior.

---

## 1. Over-block

No new over-block identified. The only rejection behavior changed is that previously-rejected Gemini requests now pass route validation. Claude and Codex allowed model sets are unchanged. Invalid framework values are still rejected, but the error message now includes Gemini in the valid set.

---

## 2. Under-block

The route still rejects unknown raw Gemini model ids because it only accepts generic tiers and the adapter's current known Gemini model list. That is intentional for this route-level validator: arbitrary model-id passthrough belongs either in the Gemini adapter policy or in an explicit model-discovery change, not in a dashboard route hotfix. A Gemini request with no model remains allowed and continues to use downstream defaulting.

---

## 3. Level-of-abstraction fit

This fix is at the correct layer because the bug was route-local validation rejecting a value that the lower-level session launcher already supports. The route should validate the request envelope and then pass supported framework values through; it should not invent a narrower framework universe than `SessionManager`. Reusing `KNOWN_GEMINI_MODELS` avoids duplicating Gemini model names in a second place.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but this is deterministic schema validation at an HTTP boundary, not a brittle detector making contextual behavioral decisions.
- [ ] Yes, with brittle logic — STOP. Reshape the design.

The route has blocking authority over malformed requests, but the logic is a deterministic allowlist of shipped framework identifiers and shipped adapter model ids. It does not interpret conversation content, infer intent, or suppress agent behavior. The authority is appropriate for request schema validation.

---

## 5. Interactions

- **Shadowing:** this route validation runs before `SessionManager.spawnSession`. The old version shadowed Gemini's existing launcher support by rejecting the request too early; the new version removes that shadow for Gemini.
- **Double-fire:** no double action. Successful requests still call exactly one session-manager spawn path.
- **Races:** no shared mutable state added. The Gemini model list is a static exported constant.
- **Feedback loops:** none. The change does not alter dashboard refresh, prompt gates, degradation reporters, or launcher retry behavior.

---

## 6. External surfaces

Visible external surface: dashboard/headless API callers can now create Gemini sessions through the existing spawn route. Invalid-framework error text changes to include Gemini as a valid value. No persistent state format, config, migration, Telegram behavior, Cloudflare tunnel behavior, or session cleanup policy changes.

---

## 7. Rollback cost

Rollback is a pure code revert and patch release. No data migration or agent state repair is required. During rollback, dashboard Gemini headless spawns would return to the known-broken route rejection while lower-level Gemini session support would remain intact.

---

## Conclusion

This is a narrow route-parity fix: the dashboard route now accepts the Gemini framework and known Gemini models already supported by the headless launcher. The main risk was accidentally widening model validation too far or changing Claude/Codex validation; tests bind both the successful Gemini path and invalid-framework behavior, and the implementation keeps Claude/Codex allowlists unchanged.

---

## Second-pass review

**Reviewer:** instar-codey self-review
**Independent read of the artifact:** concur

The lifecycle surface is a session-spawn route, so I re-read the change as a reviewer after writing the artifact. The fix removes a route-local false rejection and does not add a new launcher path, lifecycle transition, or cleanup behavior. The scoped tests cover the route boundary where the regression lived.

---

## Evidence pointers

- Focused unit gate: `npx vitest run tests/unit/server.test.ts tests/unit/route-validation-edge.test.ts` — 46 tests passed.
- Original observed failure from verification: dashboard/headless spawn rejected Gemini with `"framework" must be one of: claude-code, codex-cli`.
