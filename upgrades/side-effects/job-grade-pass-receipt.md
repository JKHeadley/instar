# Side-Effects Review — grading job result receipt

**Version / slug:** `job-grade-pass-receipt`
**Date:** 2026-10-28
**Author:** Echo
**Second-pass reviewer:** grade_receipt_review

## Summary of the change

The grading script now sends its scheduled run ID and a random, single-run
receipt token when it calls the grade-pass endpoint. The server records the
result counts in the supervision journal before answering. The scheduler
accepts this server-owned receipt as a fresh independent signal only when the
script's reported counts match. It also includes those counts as declared
structured fields for later Jev review. This adds a verified evidence source
for the first converted script. It does not open the Jev or fixed-decision
rollout gates.

## Decision-point inventory

- Grade-pass route admission: modified to validate a registered run and its
  single-run token when a script claims a receipt.
- Job evidence sufficiency: modified to consume a matching server receipt as
  a signal. The existing supervision evidence policy remains the authority.
- Jev and fixed decision admission: passed through; both gates remain off.

## 1. Over-block

An installed older grading script that does not send a receipt remains a
successful script run but cannot present independent healthy evidence. Its
result remains visibly unchecked while triage is dark. A forged or stale
receipt returns 409 before the grading pass executes. Manual grade-pass calls
without a run header keep their prior behavior.

## 2. Under-block

The receipt proves that the endpoint completed and that the script reported
the same counts. It does not prove that the grading algorithm made correct
decisions, or certify any fixed result shape. A compromised server with access
to both ledgers could forge this signal; the existing script hash, audit and
canary controls remain relevant.

## 3. Level-of-abstraction fit

The server owns the grade-pass operation and can durably attest its own result;
the scheduler owns run registration and completion. The receipt is a narrow
signal. The existing `projectSupervisionEvidence` floor decides whether it is
fresh and independent enough for model routine closure.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`.

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic.

The 409 response enforces exact run-token integrity at an API boundary; it
does not judge the meaning of the script result. The receipt cannot itself
mark a run reviewed or routine.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic decides between competing live signals. Exact counts
and a single-run token are mechanical integrity checks. Whether the result
needs investigation remains with the existing supervised decision path.

## 5. Interactions

- **Shadowing:** The receipt is read before evidence projection. A missing
  receipt leaves evidence insufficient; it never shadows an anomaly or alert.
- **Double-fire:** A repeated call for one run is idempotent only if its counts
  match. It never starts a second scheduled fire.
- **Races:** Registration commits before the script launches. The route writes
  the receipt before responding, and the scheduler reads it after script exit.
- **Feedback loops:** The receipt is an input to evidence sufficiency, not an
  outcome grade or a fixed-shape certificate. It cannot certify itself.

## 6. External surfaces

The existing authenticated grade-pass route accepts two optional script-only
headers. The random token is not logged or returned by the triage API. The
new SQLite table and token-hash column are created idempotently on existing
agents. The token hash is cleared when the script result is recorded. The
built-in job installer updates the script and hash on upgrade.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator surface. The existing triage view continues to show the run
as unchecked while Jev is dark, with no raw token or receipt in the display.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the grade-pass endpoint, script process, run attempt,
and receipt all live on the executor machine. The pool triage read already
proxies per-machine coverage. This change sends no notice, creates no URL, and
does not move a receipt between machines. Claim transfer creates a new run
and new token.

## 8. Rollback cost

Revert the code and publish a patch. Existing receipts and token hashes are
inert; the additive database objects need no destructive cleanup. An older
script may lack corroboration until the new release is reinstalled, so the
result remains unchecked, not silently safe.

## Conclusion

The receipt is a useful independent execution signal for the one live script.
It is not sufficient to activate Jev, certify a fixed rule, or claim measured
accuracy. The change is ready for second-pass review after the three test
tiers finish.

## Second-pass review (if required)

**Reviewer:** grade_receipt_review
**Independent read of the artifact:** Concur. The receipt and structured fields
provide a bounded, run-linked signal without new authority. The reviewer
confirmed that matching counts do not prove the grading algorithm correct.

## Evidence pointers

Focused unit, route integration, and production-install lifecycle tests are
in this PR; full-suite and CI results will be attached to the PR.

## Class-Closure Declaration (display-only mirror)

No agent-authored artifact defect is fixed and no new self-triggered action is
added. The scheduler's existing fire path only passes a run-specific token.
