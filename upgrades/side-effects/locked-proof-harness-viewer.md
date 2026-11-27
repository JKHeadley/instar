# Side-Effects Review — locked-Mac proof harness: viewer auto-open, vault PIN, finalize step

**Version / slug:** `locked-proof-harness-viewer`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, test tooling only: `scripts/locked-proof/driver.mjs`, `configure-proof-agent.mjs`, `stage-proof-agents.sh`, and `tests/unit/locked-proof-driver.test.ts` (4 files, about 200 lines). No `src/` change, nothing shipped to agents. The driver now waits for an enabled `#requestButton` OR an open `#control` (desktop.js auto-opens when exactly one machine is ready), and a new `requestGrant()` clicks only when the stream is not already open; `openGrant`, `grant-other-agent` and `open-next-grant` use it. `configure-proof-agent.mjs --pin-stdin` writes a digits-only dashboard PIN read from stdin; `stage-proof-agents.sh --agent-home DIR` reads it from the operator's vault (key `locked_proof_dashboard_pin`) for the stage and finalize steps and pipes it on stdin. Each step prints the next; the driver refuses to start while a proof agent lacks a PIN or front, naming `--finalize`. The driver also maps two new viewer sentences (`tunnel-not-active`, `retained-helper-required`) back to their reasons. Effort: one build pass, no spec review rounds (Tier 1, PR is the review surface).

## Decision-point inventory

No runtime decision point. The driver's setup check (`setupGaps`) refuses a proof run; it is test tooling acting on the proof user's own config.

---

## 1. Over-block

`setupGaps` refuses a run when a proof agent's config has no string `dashboardPin` or no `remoteDesktop.frontMachineId`. A proof agent whose PIN lives in its own vault (config holds `{secret:true}`) would be refused; the proof agents are created by these scripts and keep the PIN in config, so this does not arise. `validPin` refuses non-digit PINs; the dashboard's generated PINs are digits.

## 2. Under-block

The driver still trusts that the page's `#control` visible means the stream is ours; on the proof Mac only the driver opens viewers.

## 3. Level-of-abstraction fit

Right layer: the defect was the driver's model of the page, fixed in the driver. The PIN comes from the vault (the harness's existing credential source for the proof password), not from the server, so the harness does not depend on the server PIN fix.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface in shipped code.

Test tooling only.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

`stage-proof-agents.sh` reads the vault through the agent home's own `secret-get.mjs` (as `driver.mjs` already does for the password). `configure-proof-agent.mjs` keeps its refusal of any directory outside `/Users/instarproof` before it reads stdin. No other caller.

## 6. External surfaces

None outside the proof Mac's throwaway user. The PIN is never printed (dry runs say `dashboardPin: set|absent`), never on a command line (`printf` builtin into a pipe), and never written to results. Operator surface: none (agent-run tooling).

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: the harness runs on the one proof Mac against its throwaway user; nothing is replicated or served.

## 8. Rollback cost

Revert the scripts. No persistent state beyond the proof agents' own config files on the throwaway user, which are recreated per run.

## Conclusion

Clear to ship. The three fixes are what the 2026-11-04 run needed to proceed without a hand patch.

## Evidence pointers

`tests/unit/locked-proof-driver.test.ts`: viewer readiness selector, `requestGrant` clicking only when closed, all three grant openers use it, PIN option validation, `setupGaps` naming `--finalize`, stage script refusing without `--agent-home` and with an empty vault key, PIN never echoed.
