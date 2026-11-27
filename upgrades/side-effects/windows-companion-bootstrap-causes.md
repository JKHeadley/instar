# Windows companion bootstrap: name the fast failures

Tier 1. One production file (`src/core/WindowsDesktopBootstrapStatus.ts`) and its unit test. Diagnosis vocabulary only: no change to the installer, the boot path, routes, or what is stored beyond the fixed code.

## Decision and operator impact

`classifyWindowsDesktopBootstrapError` turns an installer failure into a fixed phase and code, so no installer stderr leaves the machine. Two gaps made almost every real failure read "preflight / installer-process-failed":

1. The installer uses `execFileSync`, whose errors read `spawnSync <file> ENOENT`. The `powershell-unavailable` and `wslpath-unavailable` patterns matched only `spawn <file> ENOENT`, so they could never fire. Both now accept either spelling.
2. Failures before the installer's `uncaughtException` handler exists (a module-load failure) print no phase marker and matched no pattern. Neither did kills: the installer re-runs itself under `flock -n` with a 130 s limit (below the parent's 140 s), so a slow install is normally killed by that inner limit and surfaces as `spawnSync flock ETIMEDOUT` in the outer installer's output. A busy lock (`flock -n` exits 1 with no output) also fell into the catch-all.

New codes:
- `cmd-unavailable`, `windows-command-timeout` and `windows-interop-unavailable` (exec format error, ENOEXEC, WSL vsock errors).
- `installer-module-load-failed`, placed first so an EACCES or a CS-like path segment in a load error cannot claim it.
- `installer-timeout`: from `spawnSync flock ETIMEDOUT`, or from the parent's own `ETIMEDOUT` error code.
- `installer-output-overflow`: from an inner command's ENOBUFS, or the parent's `ENOBUFS`.
- `flock-unavailable`.
- `install-lock-busy`: only when the `flock -n` failure carries no marker from a locked child.

When a locked child failed for its own reason, its marker comes first in the copied stderr, so its phase and cause still win. The parent's error code outranks output text, and a plain nonzero exit carries no code. All new codes are in the read-back allow-list. With no marker, the phase still defaults to preflight. After an inner flock kill, the phase reads "address", the outer installer's phase when it starts the locked child.

Found live: the Mama PC (WSL, 1.3.2086) recorded "preflight / installer-process-failed" at every boot on 27 Nov 2026 (12:36 and 13:42 UTC), with nothing else to go on. Its server log shows the failure about half a second after the previous boot line, which rules out the time limit for that machine.

## Verification and rollback

`tests/unit/windows-desktop-bootstrap-status.test.ts` adds five cases: each new code from a realistic stderr (including a load failure with no phase marker), the remaining spellings and alternatives, the real nested flock layout (a locked child's own failure, a flock kill, a busy lock, an unmatched child failure that must not read as a busy lock), parent time limit and overflow ahead of output text with an unrelated `code` ignored, and every new code read back from the status file. Both test files touching this module pass (10 tests). The error shapes were checked against real Node 24 `execFileSync` errors. Revert the commit to return to the old codes; a status file holding a new code is then read back as null, which only hides the diagnosis.

## Second-pass review

**Reviewer:** an independent sub-agent with no part in writing the change (read-only), 27 Nov 2026.

Round 1 objected with six findings: the flock 130 s limit pre-empts the parent's timeout, flock missing, inner ENOBUFS, both documents overstating the timeout path, test gaps (async spelling, the other alternatives, the nested flock layout, a code-less nonzero exit), and earlier patterns claiming a load failure. All six are fixed in code, tests and text, and a busy-lock code was added on the same reading. Round 2 objected with two findings: Node copies a failed child's stderr into the error message, so the marker count saw two markers and the busy-lock code could never fire, and the test helper built a message Node never produces. Both are fixed: markers are counted in stderr alone, and the helper builds the message as Node does (checked against Node 24). Round 3 approved.

## Class-Closure Declaration

The defect class is claim-vs-evidence: a status asserted a phase ("preflight") that the evidence did not establish. The test pins that a marker-less failure is named by its cause; the phase default is unchanged and stated as a default in the code.

unbounded-self-action: closure n/a (negative declaration). This is a pure classifier. It maps a finished installer error to a fixed code and triggers, retries or kills nothing; its one caller runs the installer once per boot.

## 6b. Operator-surface quality

ELI16: docs/specs/windows-companion-bootstrap-causes.eli16.md.

The codes reach the authenticated desktop diagnostics only; no user-facing wording changes.
