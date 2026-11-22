# Convergence Report: One wrong-PIN budget for the whole agent (SEC-170)

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external review ran on every round (6 of 6), through the agent's codex CLI. The Anthropic clean-door reviewer was not run (token pause).

## ⚠ Status: round cap reached; final-round security findings fixed but not re-reviewed

This is a Tier 2 security spec, so its cap is 6 rounds. Round 6's internal review raised no design findings. Round 6's external review raised two DESIGN findings, both about security: the split-lease bound and abused-marker membership. Both are now fixed in the spec text, and the Standards-Conformance Gate is clean on that text (102 standards, no flags, 2026-11-22 16:58 UTC). Neither fix has had a review round. Under the skill's rule for the cap, a remaining security finding means the spec has not converged, so **no convergence tag is written**. The decision whether to allow a seventh, confirmation-only round, or to accept the fixes as they stand, goes to the operator through the Chief of Staff.

## ELI10 Overview

The agent's dashboard PIN is the same on every one of its computers, but each computer counted wrong guesses on its own. So more computers meant more guesses for a stranger. This spec gives the agent one count, kept by the computer currently in charge. Every other computer asks it before checking a PIN from an unknown browser, and the try is counted first.

When computers lose touch, they never fall back to counting on their own. A computer that cannot reach the one in charge says no to unknown browsers. A computer in charge that cannot prove it is the only one in charge allows only its fair share. A planned change of the computer in charge hands the count over, and an unplanned one pauses new browsers for a little over five minutes. The owner's normal ways in never change: a browser they used before, their phone, and the computer itself.

## Original vs Converged

- **Originally,** a cut-off machine fell back to a fair share of its own. Review showed that this adds to what the lead already allows, so the agent could go past 20. **Now** there is no independent fallback. A cut-off machine refuses, and a lead that cannot prove it is the only lead uses a conserved share that every such lead respects.
- **Originally,** the caller sent the window and grants had no clear expiry. **Now** the window is the lead's own. Grants expire after 30 seconds, measured from when the request was sent, and are bound to the machine that asked.
- **Originally,** a new lead paused for one window. **Now** a planned handover seals the previous holder and hands over the exact count, live reservations and any running pause, all as durations. The seal needs a valid newer lease record and the sealed holder's own view agreeing. An unplanned handover pauses for one window plus one lease life, the bound the lease's monotonic self-fence gives.
- **Originally,** the lead's record shared the existing counter file. **Now** it lives in its own file, written atomically and flushed to disk before anything relies on it. A failed write refuses. Older builds ignore the file.
- **Added:** "alone" means never paired; abused markers count against the shared budget; a defined reserve log and per-machine counts back the graduation check; and the cut-off escrow is a tracked follow-up with a defined trigger.

## Iteration Summary

| Round | Constitution gate | Internal (combined lenses) | External (GPT) | Spec changes |
|---|---|---|---|---|
| 1 | ran (1 flag: maturation path) | design 7, precision 8 | 3 design, 1 precision | dev-gated rollout; no fallback share; reserve-before-compare; signed routes; lead resolution |
| 2 | ran (0 flags after edits; 2 intermediate flags fixed: weighed alternatives, restart proof) | design 3, precision 5 | 3 design, 1 precision | count handover; escrow trigger; restart by lease record |
| 3 | ran (0) | design 3, precision 4 | 3 design | seal design; deadline from send time; durable row |
| 4 | ran (0) | design 0, precision 4 | 2 design, 1 precision | seal check named, own-view gate; durations; alone = never paired |
| 5 | ran (0) | design 1, precision 1 | 1 design, 2 precision | pin-lead.json; fail-strict writes; full pause in tests |
| 6 | ran (0) | design 0, precision 2 | 2 design, 1 precision | split-lease conserved share; honored-marker predicate; fsync; recovery wording (not re-reviewed) |

Internal reviewers ran as one combined-lens Claude Sonnet subagent per round (security, scalability, adversarial, integration and multi-machine, decision-point classification, verify-state, decision-completeness, lessons-aware and experience fit), re-asked each round. That is a deliberate cost reduction under the standing token pause.

## Proportion

Tier 2 security spec, about 200 lines. 6 of 6 rounds used. Every round found real design defects in the leadership-transition protocol, so the effort tracks the problem's difficulty.

## Left behind

- An escrow for cut-off machines. This is a tracked follow-up, built before the fleet packet if dev-agent-live records a refused new browser outside a counted attack.
- Fixed windows still allow up to 40 guesses across a window boundary. That is the existing design, stated in §4.
- A compromised pool machine can, during a renewal lapse, seal the lead and cause a short pause for new browsers. It never gains extra guesses. Stated in §3 and §4.
- An aliased reach to the lead under unusual network shapes (a lead with no known address) is caught as a standing problem in the pool view and as a test-agent-live exit condition.

## Full Findings Catalog

Each round's findings and resolutions are summarized in the table above and in "Original vs Converged". The raw reviewer outputs are in the security session's scratchpad for this run (codex170-r1 to r6, plus the internal reviewer transcript).

## Convergence verdict

Not converged at the cap. Six rounds ran. The final round raised two security design findings, now fixed in the text and clean on the constitution gate, but not re-reviewed. The operator should decide between one confirmation round and accepting the fixes as they stand. No code is to be written until the spec is approved.
