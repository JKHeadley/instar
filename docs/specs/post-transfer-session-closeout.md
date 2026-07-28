---
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
review-convergence: "rev-1 — operator-named issue implemented as a two-half design grounded in the ownership registry, the transfer handler, and the SessionReaper pipeline: an IMMEDIATE close on the user's explicit move (operator-origin, protected-skipped, silent disposition) + a STANDING reaper invariant (a topic-bound session whose topic is owned by another machine closes through the guarded terminate authority after a confirm dwell — vetoes audited and retried, never forced). Both halves test-pinned on every boundary; the sweeper is proven independent of idleness (closes a BUSY duplicate)."
approved: true
approved-by: "operator (Justin) via Telegram topic 13481 — 2026-06-05 06:51Z (\"one of the issues is that sessions don't get closed off of a machine after the topic has moved from one machine to another, which leaves duplicate sessions that do duplicate work\") under the 12h autonomous mandate for multi-machine issue resolution"
approved-at: "2026-06-05T06:51:00Z"
---

# Post-Transfer Session Closeout — no duplicate sessions after a topic moves

**Status:** Approved 2026-06-05. Implemented.
**Author:** Echo
**Companion:** post-transfer-session-closeout.eli16.md
**Trigger:** Operator-named issue (topic 13481): after a topic transfers
between machines, the OLD machine's topic-bound session stays alive — two
sessions then handle the same conversation's work in parallel.

---

## The gap

The transfer handler pins the topic + releases ownership (`ownReg.cas
release`) — and stops. Nothing closes the local session: it lingers until the
idle reaper happens to clear it (which the KEEP-guards can defer
indefinitely — an `active-process` veto keeps a busy duplicate alive
precisely BECAUSE it is doing duplicate work). Non-explicit paths (failover,
re-placement) have no closeout at all.

## The design — two halves

**Half A — immediate close on the explicit move** (`server.ts` transfer
consumer): when the plan is a real `transfer` to another machine, the local
topic session is terminated right after the ownership release.
- `origin: 'operator'` — this executes the user's direct "move this to X"
  command (arrived through the authed Telegram pipeline); the
  `terminateSession` authority doc is updated to name this second legitimate
  stamp site.
- Protected sessions are skipped BEFORE the call (the operator bypass never
  reaches them on this path).
- `disposition: 'recovery-bounce'` — silent: the user already got "Moving…",
  and the conversation continues on the target.

**Half B — the standing invariant** (`SessionReaper`): a topic-bound session
whose topic is OWNED BY ANOTHER MACHINE (ownership registry via the new
`topicOwnerElsewhere` dep) is closed after `topicMovedConfirmTicks`
consecutive observations (default 2, ~4 min) — covering failover,
re-placement, and any path that isn't the explicit move.
- Independent of the idle pipeline: a duplicate is wrong even when busy.
- Still goes through the guarded `deps.terminate` (autonomous origin): a
  KEEP-guard veto is audited (`reap-skipped-topic-moved`) and retried next
  tick — eventual closeout, never a forced kill.
- Budgets respected (`maxReapsPerTick`, hourly cap); dry-run audits
  `would-reap`; ownership churn resets the dwell.
- Inert without the dep: single-machine installs and dark pools never fire
  it. The dep late-binds the pool objects (constructed after the reaper) and
  resolves the owner's nickname for human-readable reasons.

## Config

`monitoring.sessionReaper.topicMovedCloseout` (default **true** — inert
where there is no ownership registry) and `topicMovedConfirmTicks`
(default 2).

## Observability

Every outcome lands in the reaper audit + reap-log: `reaped` with
`rule: 'topic-moved-away'` and the owning machine, `would-reap` in dry-run,
`reap-skipped-topic-moved` on a veto. The immediate half logs a
`[session-pool] post-transfer closeout` line. CLAUDE.md template (+ append
migration) tells agents the old session closes automatically so they explain
a disappeared session correctly.

## Tests

- `tests/unit/session-reaper-topic-moved.test.ts` (9): closes a BUSY
  duplicate after the dwell; owned-by-self / unowned / dep-absent /
  no-topic-binding all inert; churn resets the dwell; dry-run audits only;
  veto audited + retried; flag-off disables; per-tick budget respected.
- `tests/unit/PostUpdateMigrator-poolSessionsVisibility.test.ts` (+3):
  closeout line append / idempotency / single-shot with the scope=pool
  append.
- Reaper family regression: 65 existing tests green.

## Out of scope

- Cross-machine remote kill (machine A closing machine B's session) — each
  machine closes its OWN leftovers; the invariant runs everywhere, so both
  sides converge without remote authority.
- The `recentUserMessage` guard staying topic-keyed (not machine-aware) — the
  sweeper retries through it; the immediate half (operator origin) covers the
  prompt path.
