# Side-Effects Review — borrowed machines run unit-test slices in a sandbox, in shadow (part B)

**Version / slug:** `lv-borrowed-helper`
**Date:** `2026-11-19`
**Author:** `echo (scaling session, topic 145097)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

This is part B of the approved spec `docs/specs/local-verify-borrowed-unit-slices.md`, approved by the Chief of Staff on 2026-11-18 at 15:08 PST with three fold-ins, all implemented. A borrowed machine (Justin's laptop, or the Windows PC through WSL) can run small slices of unit tests inside a sealed Linux sandbox. Its answers are compared with a `main` verify's own results and never count.

Everything is dark. The helper side runs only with `monitoring.localVerify.helper.enabled`; the run-machine side only with `monitoring.localVerify.borrowed.mode: 'shadow'`. Neither is written as a default.

New code:
- `src/localVerify/helper/` (16 files): the protocol, admission, seen-attempts, learned list, governor, sandbox drivers (Lima, WSL, test-bypass), the host tree export, the service, routes and wiring.
- `src/localVerify/borrowed*.ts` and `mainRunObserver.ts`: run-machine eligibility, planning, comparison, state, client, the canary, and the detached shadow task.
- Sandbox templates in `src/templates/helper/`, never executed on the build host.
- The Windows owner-signal scripts in `scripts/helper/`.
- `instar helper pause|resume|uninstall`.
- A dashboard card shown only while the role is on.
- State-registry entries.
- The awareness entry.

The ladder entry ships in the base PR #3471.

**Status:** opened as a DRAFT. Justin's 2026-11-18 17:44 feedback (too restrictive) leads to a spec amendment before this goes to Local Verify. That amendment widens the target to integration slices, gives the practice phase an end, and drops merged-only after practice. The sandbox, the owner-first governor, the routes and the signing built here are the parts the amendment keeps.

## Decision-point inventory

- **Helper request acceptance:** add. Pinned requesters, signature, expiry, single-use id, signed target helper, tunnel/loopback refusal, merged-commit check, and file eligibility with the scan as a hard floor that fails closed.
- **Sandbox wall checks:** add. They refuse to start on any failed or unrunnable check.
- **Governor stops for the owner:** add. Reserve, memory, battery, pause, idle and deadline, with a restart-loop hold-off and a host-disk margin.
- **Run-machine shadow:** add. A detached comparison only; no path to `evaluateRun`, and a guard test proves it.

## 1. Over-block

- The fail-closed scan keeps some harmless files local. A hit is recorded with its matched line, so false blocks are visible.
- Merged-only and unit-only limit what is measured. Both are set to relax in the spec amendment, per Justin's feedback.

## 2. Under-block

These are named residuals, from the spec:
- merged code executing inside the sandbox;
- `npm ci`'s filtered internet access;
- on Windows, the WSL2 kernel shared with Echo's distro (a container-level boundary);
- a flaw in the virtualization layer itself.

The Lima image and node digests are not pinned yet. Creation refuses until the throwaway rung pins them, so this fails safe.

## 3. Level-of-abstraction fit

Isolation sits at the virtual-machine layer, the standard for untrusted CI work, instead of per-file rules. Signing and key lookup reuse PR 3451's primitives. The run-machine side is a detached observer of `main` verifies, so it never sits in the verify's path.

## 4. Signal vs authority compliance

- [x] No — this change has no brittle block/allow surface over a verdict.

Shadow results never decide anything. The helper's refusals protect the owner's machine; they are exact checks that fail closed, which is the floor the spec classifies as invariant.

## 4b. Judgment-point check

The governor is a judgment within floors (reserve, memory, battery, pause), with the arbiter as measured owner load, as declared in the spec. Practice-phase defaults are named in code comments, and the 20-run report re-measures them.

## 5. Interactions

- **`LocalVerifyService.ts`:** only a type-only observer hook, called try/catch and never awaited. None of the functions PR 3455 edits are touched. It is a verifier root, so the verifier version changes once.
- **PR 3471:** this PR stacks on it (unit durations, ladder entry).
- **PR 3470:** no shared code.
- **Server boot:** the helper runtime is built only when its setting is on.

## 6. External surfaces

- **New routes:**
  - `POST /local-verify/helper-slice`, `/helper-slice/cancel`, `/helper-learned` and `/helper-pause`;
  - `GET /local-verify/helper-status`;
  - all 404 while disabled.
- **Other additions:**
  - a `borrowed` field on `GET /local-verify`;
  - new audit rows (`borrowed-shadow`, `borrowed-shadow-error`, `scan-hit`, `result-oversize`, `restart-episode`-style counters);
  - a CLI command;
  - a dashboard card.
- **Owner-machine actions:** none, until the owner enables the role after a four-part ask.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The surface is a card on the dashboard's Development page (`dashboard/console/development.js`, `helperCard`). It shows only on a machine whose helper role is on.

1. **Leads with the primary action?** Yes. The card is short: a plain title, the current state, then the one action, a "Pause practice runs" / "Resume practice runs" button. The button is visible and tappable on arrival, never folded away, and is followed by a live status line ("Paused. Current work stopped.").
2. **Zero raw internals as primary content?** Yes. Refusal codes are translated to plain words by `helperReasonWords` ("your machine was on battery", "there was not enough free disk space"); an unknown code gets "a safety rule did not allow it", never the raw code. A failed sandbox check reads "A safety check on the sealed-off sandbox did not pass, so nothing runs until it does." No ids, hashes or slugs are shown. This was fixed during this review: the first build showed raw reason codes.
3. **Destructive actions de-emphasized?** Pausing is the safe direction. It stops work on the owner's own machine and destroys nothing. Uninstall is deliberately not on the dashboard; it is CLI-only and needs `--yes`.
4. **Plain language + phone width?** The labels are everyday words ("This machine lends spare time to the test line (practice only)"; "Nothing it reports counts toward any change…"). The card uses the page's existing `need-card` layout, which stacks at phone width with full-size tap targets. `console-development` and `console-needs-first-screen` pass; the card has no test of its own.

## 7. Multi-machine posture

As declared in the spec:
- **Helper setting:** machine-local, hardware-bound.
- **Learned list:** unified by placement on the helper, read through `helper-status`.
- **Run-machine state:** machine-local by the ratified Local Verify exception.

No user-facing notices, no topic-bound state, no URLs.

## 8. Rollback cost

- **Fastest:** turn the settings off. The helper routes 404 at once and no slices are sent.
- **Code revert:** removes everything. Any sandbox already created on a helper is removed with `instar helper uninstall --yes` through its driver.
- **No migration.**

## Conclusion

The spec is fully implemented, dark, and opened as a draft, pending the relaxing amendment Justin asked for. The second pass raised seven concerns; all were fixed, with tests, and re-reviewed (below).

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (read-only; findings and re-check at `.instar/state/scaling/borrowed-helper-second-pass.md` in the agent home)
**Independent read of the artifact: concur** (after one round of fixes)

**First read raised seven concerns.** None let test code reach the owner while the walls hold; they were fail-open floors, broken owner-first stops and checks that passed when they could not run:
- the hold-off never released;
- a queued preparation bypassed pause and booted before an owner check;
- the scan failed open;
- the nft hash ignored rules with anonymous counters;
- the Windows disk margin measured the wrong disk;
- the vsock check passed without python3;
- the forward probes had no positive control, and the WSL image had no digest check.

All were fixed with tests and re-reviewed, along with four lesser notes: the first Mac sample, a no-report slice now counts as a slice error, signed target helper, and a streaming size cap.

**Remaining minor notes, accepted:**
- a preparation's owner check records a stop but leaves an already-running sandbox up until the slice path or the idle stop catches it;
- the forward-probe control shows the listener started, not that it was still up at the host's connect, within a 20 s window;
- the WSL digest is hashed and imported through two paths on the owner's own drive.

## Evidence pointers

- Unit tests (niced, at most 5 files per run): 251/251 across the 14 affected files after the fixes, plus earlier runs of `LocalVerifyService` (163), the registry, awareness, console and lint tests.
- `feature-ladders-coverage` + `MaturationLadder`: 54/54 on this branch.
- Typecheck and `npm run lint` clean.
- The integration and e2e files are typechecked; Local Verify is their first run.

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`. New self-triggered controllers: the governor's stops and the sandbox restart, the detached shadow task, and the breaker's probes.
- **closure:** `guard`.
- **guardEvidence:** ratchet `tests/unit/self-action-convergence.test.ts`.
- **howCaught.** Each controller converges:
  - **Sandbox stops.** They act once per stop condition. Restarts are braked by the memory-pressure hold-off (5 min doubling to 1 h, released only after normal samples).
  - **Shadow task.** One per `main` verify, abandoned at unit-lane end.
  - **Unreachable-helper probes.** Backoff from 30 min doubling to 8 h, reset on success.
  - **Clean-up.** Kill up to 3 times, then a sandbox restart.

  None loops without a brake.
