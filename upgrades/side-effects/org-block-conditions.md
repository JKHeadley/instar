# Side-Effects Review — Block mode's EXO 3.0 conditions 2, 5 and 6 (organization never rules)

**Version / slug:** `org-block-conditions`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Three of the remaining EXO 3.0 conditions in `docs/specs/org-never-actions.md` ("Block mode: Justin's approval and its EXO 3.0 conditions"). Block mode stays unreachable (`blockingApproved` is still never set by code).

- **Condition 2, a held action reaches the person.**
  - `setOrgNotify` in `OrgActionCheck.ts`, wired in `AgentServer.raiseOrgNotice`. It raises an attention item when Telegram is connected; otherwise it adds to the local attention list and sends an app push.
  - Every held action raises one notice, keyed by its check id.
  - The Mac app shows the held action, its rule and content, and "Allow once" (Mac commit fb9a9e7).
- **Condition 5, the judge never swaps provider or account.** A new `attribution.noFailureSwap` flag in `IntelligenceRouter` skips every swap position (other doors and sibling accounts) for that call. `judgeOrgAction` sets it, so a failure is returned and the check fails closed.
- **Condition 6, budget.**
  - The judge's `onUsage` tokens are charged at fast-model rates. The fixed estimate is used only when the provider reports nothing.
  - When the budget is used up, the person is told once that day (`org/budget-notice-day`).

## Decision-point inventory

- Router swap — modify — a caller may opt out; only `OrgPolicyJudge` does.
- Notices — add — one per held action, one per day for the budget.

---

## 1. Over-block

None new. In block mode a judge failure was already held for the person; now it's held without first trying another provider.

## 2. Under-block

None.

## 3. Level-of-abstraction fit

The opt-out lives in the router, which owns swap decisions. Notices reuse the existing attention path.

## 4. Signal vs authority compliance

Unchanged: the judge decides, and a failure is "unknown", which holds in block mode.

## 4b. Judgment-point check

The same judge; this changes only where its content may go.

## 5. Interactions

- The router: every other caller is unaffected, because the flag defaults off.
- Attention: items are keyed `agent:org-check:<id>` and `agent:org-budget:<day>`.

## 6. External surfaces

None.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local, like the checks themselves.

## 8. Rollback cost

Revert: the judge may swap again, and the notices stop. No migration.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: one notice per held action, and at most one budget notice a day.

## Conclusion

Conditions 2, 5 and 6 are met. Conditions 8 (a live block-mode check) and 9 (a code re-audit) come before `blockingApproved` is set for the pilot.

## Re-audit fixes (EXO 3.0 condition 9)

The independent code re-audit of the block path found nine defects. The general ones are fixed in PR #3275. The block-only ones are fixed here:
- **A forgeable allow-once.** Pending checks and approvals now live only in the server's memory, so no file the agent can write grants or reshapes an approval. In block mode the hook also refuses agent writes (Write, Edit, MultiEdit, NotebookEdit or Bash) to `.instar/org/` and `.instar/config.json`. It is registered for those tools by the migration.
- **Proxy-flagged and relayed messages.** The block-mode message check now lives in `evaluateOutbound`, the one evaluator every send path shares. The proxy and system-template path also checks it beside the credential wall.
- **The judge's provider.** It is now pinned (`attribution.pinFramework`) to the agent's own session framework: no routing, degrade or swap, and an unavailable provider is an error that holds.
- **Late cost.** A judge call that times out is charged its reported tokens when they arrive.



**Reviewer:** second-pass subagent
**Independent read of the artifact: concur**, with three small fixes, all applied:
- `noFailureSwap` now also closes the non-gating swap path.
- The budget notice says what really happens in observe mode, where actions aren't held.
- A notice the local list refuses is logged.

One note is recorded, not changed: when the routed framework's binary is missing, the router falls back to the agent's default provider. That is still one of the agent's own configured accounts, never a swap tail.

## Re-audit round 2

- **The verdict cache** is now in memory only.
- **Membership** that this server process has seen as joined stays joined until a leave goes through the server: the app's Leave or a peer's fan-out. In block mode, a membership file changed by hand is recorded, the person is told, and the action is held.
- **The hook** now asks the server whenever any organization data exists. It no longer trusts the membership file, and the path guard compares real paths, so `./`, `//`, `..` and symlinks can't hide the target.
- **Own provider.** Only the router, which honors the pin, or a provider that says it is the agent's own framework counts as "own".
- **Proxy-flagged Telegram sends.** The pre-check is removed. The Telegram send path already runs `evaluateOutbound` for every message.

**Limit, stated plainly.** The agent runs as the same computer account as its server. A determined agent with shell access could still change state the check relies on, for example between restarts, or by obfuscating a write. The check is built for an agent that is being talked into breaking a rule, not for one trying to disable its own safeguards. Every other instar safeguard has the same limit. Separating the server's account from the agent's is the structural fix, and it is outside this PR.

## Re-audit round 3

- **Block mode implies membership.** The mode route refuses block unless the agent has joined, and leaving through the app sets the mode back to observe. So "block mode, but not joined" is treated as a membership changed outside the app: held, recorded and reported. That holds across restarts, so removing or renaming the organization folder no longer switches the check off.
- **The hook** asks the server whenever the organization folder exists or the config says block.
- **Proxy-flagged Telegram sends.** The pre-check is back, but only when the Telegram origin service isn't running; when it is, its send path already reviews every message.

## Re-audit round 4

- **The server's own record of the mode.** The server writes the mode to `org/actions-mode.json`, and that file decides it. Only the app's mode switch and every leave write it: a leave made in the app, and a leave arriving from another of the agent's machines.
- **Leave from another machine.** A leave that arrives from another of the agent's machines now sets this machine back to observe, so it no longer holds everything.
- **Config edited by hand.** If the config file says observe while the server's file says block, the config was edited outside the app. Blocking stays on, the event is recorded, and the person is told once a day. This holds after a restart.

## Second-pass review (if required)

**Reviewer:** second-pass subagent; then the EXO 3.0 re-auditor (condition 9)
**Independent read of the artifact: concur** (conditions 2, 5, 6, after three small fixes). The EXO 3.0 re-audit rounds are recorded above. Block mode stays unreachable until a re-audit pass finds nothing new, and the live check (condition 8) passes.

## Evidence pointers

- `tests/unit/org-block-conditions.test.ts`; Mac fb9a9e7.
