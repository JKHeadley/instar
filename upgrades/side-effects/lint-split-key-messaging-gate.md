# Side-Effects Review - Split-Key Messaging Gate Lint

**Version / slug:** `lint-split-key-messaging-gate`
**Date:** `2026-08-14`
**Author:** `Instar-codey`
**Second-pass reviewer:** `Locke`

## Summary of the change

This change strengthens `scripts/lint-no-unreachable-messaging-gate.js` so the existing unreachable default-off `messaging.*` LiveConfig lint also recognizes first-argument string literals joined with `+`, for example `liveConfig.get('messaging.' + 'actionClaim.enabled', false)`. The focused unit test file `tests/unit/lint-no-unreachable-messaging-gate.test.ts` now covers the reproduced split-key miss and the required controls. The release fragment is `upgrades/next/lint-split-key-messaging-gate.md`. Build location was a fresh worktree at `.worktrees/codey-lint-split-key-messaging-gate` on `JKHeadley/instar`, version `1.3.1146`, branched from current `origin/main`.

## Decision-point inventory

- `scripts/lint-no-unreachable-messaging-gate.js` - modify - build-time decision that flags source lines where `LiveConfig.get` uses a `messaging.*` key with literal `false` default.
- Release note internal-only classification - pass-through - this is a script/test/docs-only change with no shipped `src/` runtime surface.

---

## 1. Over-block

The main legitimate input risk is a dynamic backtick template such as `` liveConfig.get(`messaging.${featureKey}`, false) `` being treated as a constant key. The implementation rejects template expressions during literal parsing, and the unit suite includes that negative control. Second-pass review also found that the first implementation could flag a `.get(...)` example embedded inside another string literal; the scanner now only recognizes `.get` tokens outside ordinary string literal text, and a regression test covers `const example = "liveConfig.get('messaging.' + 'actionClaim.enabled', false)"`. A literal-concat non-messaging key such as `liveConfig.get('monitoring.' + 'burnDetection.enabled', false)` is explicitly covered and remains accepted. A default-true split key remains accepted because the lint is specifically about default-off gates staying unreachable.

---

## 2. Under-block

The lint still misses non-literal construction such as `liveConfig.get('messaging.' + featureKey, false)` or helper-returned keys. That is intentional for this change: widening into dataflow or general expression evaluation would raise false-positive risk and would be a different guard. The known reproduced bypass is literal-plus-literal construction, and that class is now covered.

---

## 3. Level-of-abstraction fit

This is the right layer for the fix. The problem is a static source spelling that hides an unreachable configuration key. A build lint can catch the enumerable literal shape cheaply before release. A runtime gate would be later, noisier, and would still allow dead code to ship. The implementation uses a narrow scanner rather than general JavaScript evaluation, which fits the lint's existing design.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No - this change produces a signal consumed by an existing smart gate.
- [ ] No - this change has no block/allow surface.
- [ ] Yes - but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Yes, but over a hard enumerable source invariant rather than a competing-signals judgment point.

This lint has blocking authority in the build, but it is not deciding from brittle runtime context. It enforces a concrete invariant: a literal `messaging.*` config key with literal `false` default is unreachable through the expected top-level config surface. The new part only folds literal string pieces before applying that same invariant.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The domain is enumerable source text: literal string values, `+` separators, and the literal `false` default. There are no live signals such as ownership, urgency, recency, or user intent to arbitrate.

---

## 5. Interactions

- **Shadowing:** This replaces the prior single-regex detection path inside the same lint. It does not run before another checker or suppress another result.
- **Double-fire:** One line produces one hit through `scanText`; the scanner returns line numbers as before.
- **Races:** No shared runtime state. The script reads the source tree and exits.
- **Feedback loops:** No feedback loop. The output feeds developer/build action only.

---

## 6. External surfaces

No user-facing runtime surface changes. Other agents and users only see the effect when developing Instar: split-literal unreachable messaging gates fail the lint. No external service calls, no persistent state changes, no generated URLs, no timing dependency, and no operator-facing action surface.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface - not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: this is a source-tree lint that runs in the checkout performing the build. It holds no durable agent state, emits no user-facing notices, and generates no URLs. Multi-machine coherence is handled by committing the script/tests/release notes to git so every machine receives the same lint behavior after update.

---

## 8. Rollback cost

Pure code/test/docs change. Rollback is a hot-fix revert of the lint parser and its tests plus the release fragment. No data migration, no agent state repair, and no user-visible runtime regression during rollback.

---

## Conclusion

The review narrowed the implementation to literal-only first-argument folding, added a negative test for template expressions, and resolved second-pass's string-example false-positive concern by scanning for `.get` only outside string literal text. The change is clear to ship with the known caveat that dynamic key construction remains out of scope for this lint.

---

## Second-pass review (if required)

**Reviewer:** `Locke`
**Independent read of the artifact:** `concern, resolved`

Initial concern: the first implementation scanned for `.get` across preserved string contents, so a non-executed example string such as `const example = "liveConfig.get('messaging.' + 'actionClaim.enabled', false)"` could be reported. Resolution: `lineHasUnreachableOffGate` now locates `.get` only while outside string literal text, and `tests/unit/lint-no-unreachable-messaging-gate.test.ts` includes the example-string negative control. Dynamic concatenation and template expressions remained out of scope as intended.

---

## Evidence pointers

- Shipped-lint reproduction before the fix: split key returned `hits: []`, counted as `failureCount: 1`.
- After fix direct probe: split key returns `hits: [1]`.
- Focused suite: `npx vitest run tests/unit/lint-no-unreachable-messaging-gate.test.ts` passed `15/15` after the second-pass fix.
- Real tree: `node scripts/lint-no-unreachable-messaging-gate.js` exited clean with no existing flags.
- Full lint: `npm run lint` exited clean.
- Full push suite: `npm run test:push` ran 44,154 tests; 44,121 passed, 27 skipped, 3 todo, and 3 failed. Two failures were live Gemini e2e tests requiring absent `GEMINI_API_KEY`; the third feedback-drain ordering failure reran green in isolation.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect - not applicable. This fixes a source-code lint detection gap and adds direct regression tests for the reproduced shape.
