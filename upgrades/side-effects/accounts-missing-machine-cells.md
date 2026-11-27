# Side-Effects Review — Accounts page shows a machine that lacks an account, with Set up

**Version / slug:** `accounts-missing-machine-cells`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required (dashboard view-model + one button; no messaging, session-lifecycle, gate, sentinel or authority surface)`

## Summary of the change

Tier 1 (small, reversible): 4 files (`dashboard/console/accounts-model.js`, `dashboard/console/accounts.js`, `dashboard/console/console.css`, `tests/unit/console-accounts.test.ts`), about 45 lines of code and 80 of test. One build attempt, no spec review rounds (Tier 1). The console Accounts page built per-machine cells only from rows of machines that already hold an account, so a machine that was offline or rebuilt when an account was added elsewhere (the Mac Studio after its 2026-11-20 rebuild, missing four accounts) never showed the gap and offered no way to fix it from the console. Feedback fb-8c1a18ef-daf. `buildAccountsPage` now adds a `missing` cell for each machine that answered the pool read but lacks the account. Machines in `pool.failed` are left out, because their accounts are unknown, not missing. A missing cell renders as a dotted "+" chip, and the account sheet offers a quiet **Set up** button that runs the existing PIN-gated `POST /subscription-pool/matrix/start-cell` flow (the same one the legacy Subscriptions grid's "Set up" uses). If a sign-in episode is already running for that cell it shows "signing in". Missing cells never count toward "needs you", the ready/needs-sign-in counts or the "machine has no signed-in account" notice: not every account belongs on every machine.

## Decision-point inventory

No decision-point surface. The change adds a display state and a button that calls an existing PIN-gated route. The route's own operator-presence check (the dashboard PIN) is unchanged.

---

## 1. Over-block

No issue identified. Nothing is rejected; the change only adds cells.

## 2. Under-block

- A machine that holds no account at all never appears in the pool rows, so it gets no missing cells. That is acceptable: a machine with zero accounts is already shown by the machine notices elsewhere, and a new empty machine is set up through enrollment.
- A deliberate layout choice (an account kept off a machine on purpose, such as a Codex device limit) still shows as a quiet missing chip. It is deliberately not "needs you", so it adds no pressure. A per-machine "kept off on purpose" mark is not part of this change and is not required for the fix.

## 3. Level-of-abstraction fit

Right layer: the console view-model already merges the pool-scope read. The server already offers both the pool-wide row set and the start-cell orchestrator, so no server change is needed.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over agent behaviour. It renders state and calls an existing route whose PIN gate stays the authority.

## 4b. Judgment-point check

No judgment point added: "answered and lacks a row" is an enumerable fact from the pool read.

## 5. Interactions

- **Counts and notices:** `accountCounts` and `accountNotices` skip missing cells explicitly, so the header and notice spot are unchanged for an existing pool (covered by tests).
- **Actionable naming guard:** missing cells pass through the same unique-name check as other cells, so a duplicate machine or account name withholds the Set up button exactly as it withholds Sign in.
- **Episodes:** a running start-cell episode for that account/machine shows as "signing in" instead of "missing".
- **Existing sign-in sheets:** `startNeed` with `action: 'start'` is reused unchanged.

## 6. External surfaces

- Operator surface: the console Accounts page gains dotted chips and a Set up button in the account sheet. No change for pools where every machine holds every account.
- Other agents, install base: dashboard files ship with the package; no config, migration or state.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. In the account sheet's "On each machine" list, the missing machine's row carries Set up at its end, the same place Sign in sits for a cell that needs one.
2. **Zero raw internals as primary content?** Yes. The row reads "not on this machine" and the button "Set up"; no ids are shown.
3. **Destructive actions de-emphasized?** No destructive action is added.
4. **Plain language + phone width?** Yes. It reuses the existing row and button styles, already verified at phone width on this page. The chip uses a dotted border and a "+" prefix rather than colour alone.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Proxied-on-read:** the page reads `GET /subscription-pool?scope=pool` (rows merged from every machine that answered). The fix exists precisely to make multi-machine gaps visible. Machines that did not answer (`pool.failed`) are shown as unknown, never as missing. No notices, no durable state, no generated URLs. No status surface is changed.

## 8. Rollback cost

Pure dashboard change: revert the commit and ship a patch. No persistent state, no migration.

## Conclusion

Clear to ship. The review led to two design choices that went into the code: missing cells are excluded from counts and notices (so they never raise pressure), and machines that did not answer are excluded (unknown is not missing).

## Second-pass review (if required)

Not required.

## Evidence pointers

`tests/unit/console-accounts.test.ts`: five model tests (missing cell + quiet Set up, counts and notices unaffected, failed machine is unknown, running episode shows signing in, no missing cell when all machines hold it) and one DOM test (the sheet's Set up asks for the PIN and posts start-cell for the missing machine). 35/35 pass, and the neighbouring console suites pass (63/63). Live origin: the 2026-11-20 Studio rebuild case study (doc 574817a8).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a dashboard rendering gap, not a prompt, hook, config, skill or standards defect, and no self-triggered controller is added.
