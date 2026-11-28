# Convergence Report — Paired App First for Owner Approvals

## Cross-model review: codex-cli:gpt-6.2-astra

Six actual external reads ran. Every external read returned DESIGN findings; none is represented as a quiet external pass. At the six-read cap, the final three findings were resolved using the existing authenticated statement-replay code, an explicit pre-dispatch holder recheck, and existing acceptance-chain recovery rules. A final independent internal source review found no remaining safety blocker. The full external outputs are retained in app-first-owner-approvals-review-data.json. Final assurance is internal closure of the capped external findings, not outside approval of every final word.

## ELI10 Overview

A configured Telegram bot currently prevents an otherwise usable paired app from becoming the place an approval request goes. This repair sends the request to the app first and puts waiting requests in Needs-you. Pairing lets a device receive a request; the person still completes the existing approval setup and presence check before anything changes.

The same stuck request can change its delivery carrier without changing its identity or lifetime. A failed or uncertain chat send remains visible. A removed device does not silently turn into a chat approval.

## Original vs Converged

Review added deterministic carrier replay, setup versus approval separation, explicit non-holder behavior, uncertainty after interrupted chat sends, recovery for devices without usable biometric approval, and release of the proposal lock before network sends. The original simple transport preference change would have missed these cases.

## Iteration Summary

| Iteration | Reviewers | Design findings | Changes |
| --- | --- | --- | --- |
| 1 | Three internal reviewers covering six lenses, external Codex, constitutional signal | carrier fold, setup semantics, capacity, holder, discovery | Revised all |
| 2 | Internal six-lens recheck + external Codex | remote setup, current carrier display, interrupted sends | Explicit states and persistence |
| 3 | External Codex + internal delta review | no-Touch-ID hardware, stale holder view, removed devices | Conditional guidance and unknown availability |
| 4 | External Codex | uncertain delivery and marker-before-base replay | Separate carrier marker, no orphan row, retained historical receipts |
| 5 | External Codex + internal delta review | directory failure, network stall in lock, local key override | Explicit unknown, release-before-send, correct recovery |
| 6 | External Codex + final independent internal source check | owner retry, lease handoff, restored device without acceptance chain | Existing source-backed retry, pre-dispatch lease check, exact chain rules; internal final quiet |

Standards-Conformance Gate ran for initial, updated and final bodies; its raw outputs remain in the build evidence. Intermediate external-only delta reads did not each invoke that signal; this is disclosed rather than calling them full six-lens rounds. Relevant flags about inherited limits and attribution were addressed: no new numeric creation policy; original expiry never extended; exact operator quote and handoff id retained.

## Proportion

Tier 2, narrow delivery/discovery slice; six external reads at the cap plus three internal reviewers across six lenses and source delta checks. Review cost exceeded the intended narrow repair because it exposed replicated-state and recovery cases. No seventh broad external read was launched.

## Left behind

Platform-specific native navigation is coordinated with the Apple app session; the server page gives actual existing screen directions rather than promising a deep link. This is not a requirement for approval delivery. Broad cross-chat, pause, CLI and Secret Drop findings remain in the active parent assignment and separate decision-request design, not claimed fixed by this slice.

## Full Findings Catalog

External findings and resolutions are preserved in the review-data companion. Internal carrier-order, serialized fresh admission, setup response, holder guard and inherited-limit findings were incorporated. Final source check specifically confirmed that owner acceptance replay already resends pending cards, holder pre-dispatch suppression leaves requests visible, and reconnect alone never grants a device acceptance.

## Convergence verdict

Converged at capped review iteration 6 by independent internal closure: no remaining DESIGN safety issue after the final source-backed resolutions; no open user decision. External reviews ran and found issues; external quiet was not obtained. Ready for agent approval and implementation under that explicitly disclosed assurance.
