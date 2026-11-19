# Borrowed machines can practise running quick tests for the test line (shadow only, off by default)

<!-- bump: patch -->

## What Changed

Local Verify gains a borrowed-machine path, built in **shadow only** and shipped **dark** (spec `docs/specs/local-verify-borrowed-unit-slices.md`, parts B to G). A helper's results are compared with the run machine's own unit lane and recorded; they never decide a verdict or a merge, and no code path hands them to `evaluateRun` (a guard test asserts it).

**On a helper machine** (a laptop, or a Windows PC through a dedicated WSL distro), nothing happens unless that machine's own agent sets `monitoring.localVerify.helper.enabled: true` after its owner's yes. Neither this block nor the run-machine block below is written by config defaults or migration. When enabled:

- Four helper routes: `POST /local-verify/helper-slice` (also `prepare: true` and `retrial: true`), `POST /local-verify/helper-slice/cancel`, `POST /local-verify/helper-learned`, `GET /local-verify/helper-status`, plus the owner's `POST /local-verify/helper-pause`. All answer 404 while the role is off.
- Every request must be signed by a pinned requester's machine key (domain `instar-lv-helper-request-v1`) in addition to the Bearer token, expires within 60 s (30 s clock tolerance), is single-use (ids persisted 10 min) and is refused through the Cloudflare tunnel. Answers are signed with the helper's key (`instar-lv-helper-slice-v1`).
- The helper checks for itself that the commit is reachable from `main` on GitHub (read-only token in its secret store, never copied into the sandbox) and that every file is an eligible unit test file: not on the fixed exclude list (desktop helper, Chrome/CDP, Codex CLI, launchd, tmux), no literal-scan hit in the file or its direct imports (a hard safety floor; every hit is recorded as `scan-hit {file, matchedFile, line, pattern}`), and not on its learned exclude list.
- Tests run only inside a Linux sandbox: a Lima VM on macOS (`mounts: []`, every guest port ignored, no agent forwarding, fixed size) or a WSL distro on Windows (automount and interop off, systemd scope limits). Builds and slices run in no-network, private-file-view namespaces with AF_VSOCK refused; only `npm ci` has network, filtered by user id. The walls are checked at every start (`helper-containment-unproven` otherwise).
- Owner first: the owner is sampled before the sandbox boots, a pause or memory hold-off drops a queued preparation, and the hold-off is re-sampled while idle so it ends. The literal scan fails closed (an unreadable, unresolvable or oversized test file or direct import is a `scan-hit` with pattern `unreadable` / `oversize`). Requests name their target helper (signed `helperMachineId`). The WSL base image is checked by digest before import.
- An owner-first governor samples every 2 s and stops at once on memory pressure, battery, deadline, cancel, pause or no spare cores; memory pressure, battery, pause and 15 min idle stop the sandbox itself. A result over 4 MB is refused whole and counted `result-oversize`.
- `instar helper pause|resume|uninstall` (uninstall needs `--yes` and goes through the sandbox driver), and a card on the console's Development page (only while the role is on) showing the helper's state, last refusal and a pause / resume button.

**On a run machine**, `monitoring.localVerify.borrowed = { mode: 'shadow', helpers: [{ machineId, url }] }` makes each of its own `main` verifies send eligible unit slices (plus one known-red canary slice from `tests/fixtures/borrowed-canary/`) as a detached task the run never awaits. Every failure is caught and audited `borrowed-shadow-error`; comparison happens only after the run's record is written; one `borrowed-shadow` audit row per run carries agreement, disagreements by direction, slice errors, refusals, canary false greens, hand-back times and owner load. A helper that fails three runs in a row is skipped with a backoff from 30 min to 8 h. `GET /local-verify` gains a `borrowed` field. Setting `dryRun: true` in the same block runs the spec's full dry run (every eligible file, over as many green runs as it takes; its differences enter the learned list from one, tagged `dry-run`).

New state files: `state/local-verify/borrowed-helpers.json` (run machine: breakers and last-50 counters), and on a helper `helper-learned.json`, `helper-seen-attempts.json`, `helper-control.json` (all registered in the state-coherence registry, machine-local). The sandbox files ship in `src/templates/helper/` and the Windows owner-signal task in `scripts/helper/`. `LocalVerifyService.ts` changed (a type-only observer hook), so the verifier version changes once with this release.

## What to Tell Your User

- **Borrowed machines, practice only**: "There is now a way for a machine you lend, like your laptop or the old Windows PC, to practise running the quick tests for the test line. It is off unless you say yes on that machine, it only ever runs code that is already merged, it runs inside a sealed-off little Linux system that cannot see your files, and it backs off whenever you are busy, short of memory or on battery. Nothing it reports counts toward any change yet; after about 20 practice runs I can show you how fast and how reliable it was."
- **Your controls**: "You can pause it any time from the dashboard, or just ask me to pause it, and I can remove it completely whenever you want."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Helper role on a lent machine (dark) | Its own agent sets `monitoring.localVerify.helper` (`enabled`, `pinnedRepoUrl`, `pinnedRequester: { machineId, url }`, optional `reserveCores`, `stopOnBattery`, `sandbox`) after the owner's yes |
| Helper state | `GET /local-verify/helper-status` (404 while off) |
| Owner pause / resume / removal | `instar helper pause`, `instar helper resume`, `instar helper uninstall --yes`, or `POST /local-verify/helper-pause {"paused": true}` |
| Shadow comparison on a run machine (dark) | `monitoring.localVerify.borrowed = { mode: 'shadow', helpers: [...] }`; read `borrowed` in `GET /local-verify` and `borrowed-shadow` rows in `logs/local-verify.jsonl` |
| Windows owner signal | `scripts/helper/install-windows-owner-signal.ps1 -Distro <Echo distro> -LinuxUser <user> [-HelperDistroDir C:\instar-helper\distro]` on the Windows PC (it also reports the helper drive's free space, which the host-disk check requires) |

## Evidence

Unit tests under `tests/unit/localVerify/helper/` and `tests/unit/localVerify/borrowed*.test.ts` (admission, eligibility and scan, learned list, governor and Windows signal parser, helper service with a fake sandbox driver, driver command lines and templates, slice planning, comparison, breaker, the shadow client, the evaluateRun guard, and a `main` verify whose record, outcome and finish time are identical with a throwing or silent client); an integration test of the helper routes over real HTTP; an e2e lifecycle test through `buildHelperRuntime` with the test-only `test-bypass` seam, plus a wiring test that production setup cannot select it. The sandbox itself is proven on the throwaway rung (spec Maturation plan), never on a Local Verify machine.
