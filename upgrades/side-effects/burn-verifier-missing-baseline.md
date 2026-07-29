# Side-Effects Review — Burn-verifier missing baseline

**Version / slug:** `burn-verifier-missing-baseline`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

`BurnVerifier.runVerification()` now returns `ratio: null` and
`successfullyThrottled: null` when no finite positive pre-throttle rate exists.
Its Telegram follow-up names the result as inconclusive instead of routing the
fabricated zero ratio through the successful “Caught and contained” message.

## Decision-point inventory

- Verification evidence sufficiency — modified — a finite positive before-rate
  and a finite current rate are required for a ratio and success decision.
- Throttle success threshold — passed through — measured ratios are still
  compared with the existing configured `successRatio`.
- Throttle installation and release — passed through — no actuation changes.

## 1. Over-block

No action is blocked. The new branch affects only a read-only verification
result and its follow-up message. A real zero before-rate cannot support a
percentage reduction because it has no usable denominator.

## 2. Under-block

The verifier still accepts every finite positive before-rate, including small
values, and applies the configured threshold exactly as before. It does not
attempt to infer a missing baseline from unrelated telemetry.

## 3. Level-of-abstraction fit

Evidence sufficiency belongs beside the ratio calculation that consumes the
baseline. The follow-up renderer then maps the nullable result to a third,
explicit message. This keeps the telemetry reader, throttle runbook, and
delivery path unchanged.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The verifier is a post-action signal. It reports whether the observed rates
support a success conclusion, but it does not install, retain, release, or
override a throttle.

## 4b. Judgment-point check

No heuristic judgment is added. A ratio either has a finite positive
denominator or it is not measurable. Existing measured results retain their
configured threshold.

## 5. Interactions

- **Shadowing:** the inconclusive branch is checked before the existing success
  and failure messages, so unknown evidence cannot masquerade as either.
- **Double-fire:** one verification still produces exactly one follow-up.
- **Races:** timers, ledger reads, and shared state are unchanged.
- **Feedback loops:** the follow-up is informational and does not feed back into
  throttle authority.

## 6. External surfaces

The result interface widens `ratio` and `successfullyThrottled` to nullable
fields. Repository search finds no production consumer outside `BurnVerifier`;
the live external effect is the Telegram follow-up. The new user-visible lead
is “Slowdown verification was inconclusive.” Existing success and failure
messages are unchanged for measurable inputs.

## 6b. Operator-surface quality

The new message states what could not be measured, includes the current sample,
and avoids a recommendation or success claim. It is sent on the same topic and
cadence as the existing verifier follow-up.

## 7. Multi-machine posture

**Machine-local by design.** Token-ledger telemetry and throttles belong to the
agent host that observed the burn. No replicated state, URL, or cross-machine
authority changes.

## 8. Rollback cost

Pure code rollback: restore the zero ratio and boolean-only result fields.
There is no persistent-state migration. Rollback would reintroduce false
success messages for missing baselines.

## Conclusion

Clear to ship as a small corrective PR. It adds the missing third outcome to a
read-only verification signal and does not change throttle behavior.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; the implementation changes
only a nullable metric result and its informational renderer. It does not alter
an action, threshold, lifecycle controller, or authority boundary.

## Evidence pointers

- `tests/unit/burn-detection-phase-6.test.ts`
- Eleven focused tests pass.
- Mutation proof: restoring ratio zero makes the new null assertion fail.
- Full repository lint, including TypeScript, passes.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
