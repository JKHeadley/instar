# Side-Effects Review — Independent Lifecycle Fixture Resources

Date: 2026-11-23. Author: Echo. Tier 1, four test files plus documentation, one independent review round. Full lifecycle runs exposed a shared socket-path failure in both working copies and five additional input/log/port collisions in the search working copy. The correction isolates fixture resources without changing production behavior.

## Decision-point inventory
No production decision point changes. Reply recovery and escalation assertions remain unchanged. The document assertion now names the actual bound server address, and the Python classifier still runs the same algorithm with its own input.

## 1. Over-block
No production block/allow surface. The Mac socket assertion rejects an unsupported fixture pathname before boot instead of failing later while setting socket permissions.

## 2. Under-block
No behavior assertion is skipped or relaxed. Sentinel logs must exist for genuine escalation; the added two-rig case requires the first log and subsequent write to survive the second cleanup. The document POST reaches the listener whose exact URL is advertised. Python still evaluates all positive and negative conversation cases.

## 3. Level-of-abstraction fit
Resource ownership belongs to fixture construction. Unique per-suite directories, owned cleanup and OS-assigned ports remove shared inputs without changing production algorithms or increasing timing tolerances.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. No new production authority, heuristic, filter or detector.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Socket byte length is a platform transport constraint, not a behavioral judgment.

## 5. Interactions
Python input and script now live under the suite’s unique root and execute without shell interpolation. Sentinel state and logs share a private root, and cleanup removes only that root through SafeFsExecutor. Old shared temporary paths are not claimed as owned cleanup targets. The documents fixture registers server cleanup before awaiting startup and derives its test-only origin from the actual listener. Mac reply recovery uses a short /tmp fixture root, preserving all production initialization and delivery assertions.

## 6. External surfaces
Test fixtures and documentation only. Fake Telegram delivery remains intercepted as before. No production request, persistent user state, API, standards text, installed file or user action changes.

## 7. Multi-machine posture
Each suite and working copy owns distinct resources on its own machine. Parallel local copies cannot overwrite inputs, remove a sibling log or claim the same fixed port. No status, health, capabilities, channels, notices or generated production URLs change.

## 8. Rollback cost
Revert the commit. No migration or user-state repair is required. Reverting restores the fixture collisions.

## Evidence
The parent’s 710-file lifecycle run reported one failure; the search run reported six. The shared reply fixture produced a 107-byte Mac Unix socket pathname and deterministic truncated-path ENOENT. Python failure outputs matched neighboring cases using the same fixed input file. Both sentinel rigs mapped to the same system-temp logs directory. The overlapping parent bound documents port 4987 while search reported EADDRINUSE. After correction, all 34 targeted lifecycle checks pass, including the new two-rig isolation assertion. Complete normal verification remains required before merge.

## Conclusion
The fixture resources now match their lifetime and ownership. Original production behavior boundaries remain tested; full suite completion remains pending.

## Class-Closure Declaration
No agent-authored prompt, hook, config, skill, standards-text defect or self-triggered controller change — not applicable. This repairs test fixtures only.
