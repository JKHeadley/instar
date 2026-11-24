# Practice-Fold Reply Capture: Review Stopped at the Cap

Status: **convergence-failed**, incomplete. No approval/convergence tag minted and no runtime source changed. Six actual Codex CLI / GPT 6.2 Astra external rounds ran; each raised DESIGN findings. Internal security/adversarial and integration/lessons reviews independently ran and concurred with the sixth-round input, but the external sixth-round findings remain unresolved. No Claude calls were made.

## What Was Established

Read the exact injected request from an arm-time transcript boundary; accept one empirically qualified text block only after the aggregate Stop summary and explicit blocking-hook ancestry checks. Bind first and send-back requests to known parent UUIDs, pin fold endpoints to the committed summary, preserve audit-time continuity, renew ownership through audit and make cancellation settle the runner itself.

Empirical producer evidence is metadata-only and retained in the sibling folder. It is not a promise that all eligible practice requests emit summaries. All raw external receipts r1-r6 are retained. Conformance was unavailable each round because the live route could not guarantee zero-Claude execution; no gate pass is claimed.

## Remaining Safety Findings at Round Six

1. **Trigger-to-arm ordering:** an individual Stop event can precede that turn's aggregate summary. The current strict pre-request contract may decline its own normal tail, possibly after injection. Proposed correction: register a bounded cancellable trigger preflight that waits for the triggering turn's committed clean summary, then takes the clean-stop snapshot. Measure availability from every eligible Stop trigger, including pre-injection declines. Test all three summary arrival positions.
2. **Endpoint mutation fencing:** setLockWindow currently checks owner identity but does not take an expected generation. A separate successful renew is not an atomic fence on that mutation. Proposed correction: add an expected-generation/epoch fence at the endpoint mutation itself, using the existing lock's coordination primitive, and refuse stale writes before sidecar/durable endpoint changes. Test ownership movement between renewal and mutation and assert no packet staging. The exact implementation must be reviewed; no unsupported atomicity claim is made here.
3. **Preflight cancellation:** boot claims inFlight before transcript.read and paneIdle, while the design currently bounds only held-phase work. Proposed correction: own cancellation from the trigger claim, race every preflight wait and check before begin; shutdown/deadline releases inFlight even for a never-resolving preflight. Late resolutions cannot begin a fold. Test both waits and shutdown races.

## Cap and Next Decision

The installed spec-converge skill requires: “At the cap, stop: if the remaining design findings are about safety, security or data loss, exit convergence-failed and ask the operator”. These findings affect ownership and what conversation work the fold excludes; accepting them as harmless wording would be dishonest. Request a bounded extension or operator-selected narrower scope, without silently resetting the review count. No seventh round, implementation or activation has been started.

## Left Behind

Precision requests in earlier rounds were incorporated where a one-line clarification sufficed, including exact assembly limits and separate missing-evidence versus malformed-record outcomes. The last safety findings above are not classified as precision or silently accepted.

## Parking Decision — 2026-11-23

Chief handoff 160b21a5-54c0-4378-921b-41dfe5fc662d explicitly parks this design. Do not extend or narrow-review it now. The pending extension request is superseded. Retain convergence-failed and all six receipts. Practice folds remain off. Any later replacement proposal must be materially smaller and introduce no new lock or lease semantics; it is not a continuation that silently resets this review cap.
