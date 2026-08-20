# Side-Effects Review — Testing Integrity route enforcement

**Version / slug:** `testing-integrity-route-enforcement`
**Date:** `2026-08-17`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `independent Codex reviewer (concurred after five rounds)`

## Summary of the change

This adds a blocking lint ratchet in `scripts/lint-testing-integrity.mjs`, wires it into the repository `lint` command, replaces the older presence-only pre-commit pairing call, and adds unit, integration, and real-`AgentServer` E2E evidence. Its decision point is whether an added or materially changed direct Express route has executed, route-specific Tier-3 evidence with an exact live 2xx response.

## Decision-point inventory

- `scripts/lint-testing-integrity.mjs` — add — deterministically blocks a code check when a changed route lacks executed proof or when inspection is inconclusive.
- `tests/helpers/testingIntegrity.ts#expectRouteAlive` — add — produces evidence only after an exact production-pipeline response; it does not decide repository acceptance.
- `.husky/pre-commit` / `package.json` — modify — consolidate enforcement in the canonical `npm run lint` pipeline and remove the weaker duplicate call.

## 1. Over-block

Legitimate route refactors that change an inline declaration fingerprint must carry canonical E2E evidence even when external behavior is intended to stay identical. A changed non-literal route expression is rejected as not-proven because the guard cannot derive a stable route identity. A local checkout without a canonical fleet remote and protected `main` ref cannot run the check cleanly. These are deliberate conservative behaviors for the selected proxy, but they increase the cost of those changes.

## 2. Under-block

The ratchet covers direct Express declarations in production `.ts` files. It does not certify historical routes, non-route features, Tier 1 or Tier 2 completeness, handler implementations changed behind an unchanged external identifier reference, generated JavaScript outside `src`, or semantically significant behavior that leaves the direct declaration fingerprint unchanged. It proves route liveness at the asserted matching request/status, not full endpoint semantics.

## 3. Level-of-abstraction fit

The source and evidence scanners are low-level structural detectors. The authority is a deterministic invariant evaluator over an enumerable domain: changed route identity plus executed matching production-path observation. There is no conversational or competing-signal judgment for a smarter gate to arbitrate. The implementation reuses the repository's Vitest configurations and real `AgentServer` rather than building a parallel server harness.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] This is deterministic hard-invariant validation over a derived, enumerable code population.

The check does hold blocking authority, but not over message meaning, agent intent, or conflicting contextual signals. Its policy is mechanically complete for its declared proxy: a changed direct route either emitted matching execution proof from the canonical real-server helper or it did not. This fits the documented hard-invariant exception rather than placing a brittle semantic detector in front of a smart authority.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals decision point. “Significant feature” is explicitly not judged. The enforced proxy is the enumerable invariant “added or materially changed direct HTTP route declaration has executed route-specific Tier-3 liveness evidence.”

## 5. Interactions

- **Shadowing:** the canonical `npm run lint` invocation replaces the old `check-e2e-pairing.cjs` pre-commit call; it does not leave two authorities with different outcomes.
- **Double-fire:** pre-commit calls `npm run lint` once, so the new guard runs once there. CI or pre-push may independently rerun lint, which is intentional verification rather than duplicate stateful action.
- **Races:** evidence uses a per-run temporary file and random nonce; cleanup targets only its own `mkdtempSync` directory. No shared persistent state exists.
- **Feedback loops:** none. Evidence output is ephemeral and does not alter route enumeration or source.
- **Base authority:** no CLI argument, environment variable, configured remote, magic comment, skip setting, exemption marker, or allowlist can select or waive the base. The guard queries the exact hard-coded GitHub fleet URL with Git config disabled, parses the server-advertised protected `main` SHA, ignores local tracking refs, and computes the merge base from that identity; CI's full-history checkout supplies the authenticated object.

## 6. External surfaces

Developers and agents changing routes see a new blocking lint diagnostic and may incur the runtime cost of a targeted E2E test. Production APIs, operator routes, messages, external services, persistent stores, and runtime server behavior are unchanged. No operator-facing action is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design:** each checkout evaluates its own source diff against its locally fetched fleet base and executes its local tests before commit/CI. The same committed script and tests replicate through git, while no result is persisted as cross-machine product state. It emits no user-facing notices, holds no durable agent state, and generates no URLs.

## 8. Rollback cost

Pure development-tooling change: revert the commit and ship the next patch. There is no data migration, persistent state cleanup, agent-state repair, or production API compatibility work. During rollback propagation, only contributors' route-change checks differ.

## Conclusion

The review identified the intentional over-block for changed dynamic routes and the important under-block for external handler implementations whose declaration reference is unchanged. Independent review found four concrete defects: a request path could claim evidence for another route, a request verb could claim another verb, `ALL` lacked a concrete executable verb, and non-Express literal `.get()` calls could enter the denominator. Pathway then identified caller-selected base evasion. The implementation now binds paths and verbs, supports `ALL` through a declared concrete method, validates Express receivers, rejects all caller-selected bases, and accepts only an internally derived merge base from canonical protected `main`, with negative regressions. The deterministic route-change invariant is appropriate for blocking enforcement subject to the revised independent pass and mutation controls.

## Second-pass review

**Reviewer:** independent Codex reviewer
**Round 1:** Concern raised: route identity was not bound to the concrete request; `ALL` routes could not execute; literal calls lacked Express-receiver validation. All three were corrected with regression tests.
**Round 2:** Concern raised: a non-`ALL` route could override its concrete request verb. The helper now rejects mismatched verbs, and the E2E suite asserts that no proof is emitted.
**Round 3:** Concern raised: a slug-only URL check accepted lookalike hosts, and a mutable local tracking ref could redefine `main`. The guard now queries the exact hard-coded GitHub URL with config disabled and uses the server-advertised SHA, with lookalike and forged-ref regressions.
**Round 4:** Concern raised: local Git replacement refs could reinterpret the server-advertised SHA. Every local base operation now sets `GIT_NO_REPLACE_OBJECTS=1`, with a replacement-object evasion regression.
**Round 5:** Concur with the review. The revised guard binds route identity, request path and verb, derives its base from the exact server-advertised fleet SHA, and disables local replacement-object reinterpretation with adversarial regressions covering each escape path.

## Evidence pointers

- `tests/unit/scripts/testing-integrity-enforcement.test.ts`
- `tests/integration/testing-integrity-pipeline.test.ts`
- `tests/e2e/testing-integrity-guard-lifecycle.test.ts`
- Phase B evidence report: `scratchpad/phaseB/REPORT-B1.2.md` in the dispatch repository.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This establishes a new enforcement kernel for future production route changes; it does not repair a defective prompt, config, skill, standards text, or self-triggered controller.
