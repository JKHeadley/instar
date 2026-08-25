# Side-Effects Review — Linux auto-start lingering (boot vs login)

**Version / slug:** `linux-autostart-lingering`
**Date:** `2026-08-25`
**Author:** `Echo`
**Second-pass reviewer:** `not run — see the Second-pass section`

## Summary of the change

`instar autostart install` on Linux writes a systemd **user** service, enables it, starts it, and the CLI reports *"Your agent will start automatically when you log in."* A per-user systemd service only runs while that user holds a login session, and does not start at boot unless **lingering** is enabled for the account. It was not, and nothing said so — on a headless host the agent came up on SSH connect and died on disconnect.

This change: after enabling the unit, `installLinuxSystemdService` calls a new `ensureLinuxLingering()`, which reads the current linger state, attempts `loginctl enable-linger <user>` when it is off, and then **re-reads the state to verify the effect** rather than trusting the exit code. The outcome (`enabled-already` / `enabled-now` / `needs-privilege` / `unavailable`) is carried to the CLI, which prints a message matching what actually happened instead of one sentence for all cases.

Files touched: `src/commands/setup.ts` (`readLingerState`, `ensureLinuxLingering`, `describeLingerOutcome`, `currentSystemdUser`, outcome carrier; one call added inside `installLinuxSystemdService`), `src/cli.ts` (the `autostart install` report), `tests/unit/linux-autostart-lingering.test.ts` (+12 tests).

## Decision-point inventory

- `installLinuxSystemdService` — **modify** — one added call after the existing enable/start. Its boolean contract is unchanged; a login-only service is still a successful install.
- `autostart install` CLI output — **modify** — the success message becomes outcome-dependent. The failure branch is untouched.
- `installAutoStart` — **pass-through** — signature and boolean semantics unchanged (four callers depend on it: `cli.ts`, `PostUpdateMigrator`, `TelegramLifeline`, and the migrator's boot-wrapper regeneration). The outcome travels via a module-level carrier read with `takeLastLingerOutcome()`, deliberately so those callers need no change.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Nothing is refused, gated, or filtered; the change adds one system call and changes what a message says.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The nearest analogue is what the change still cannot fix, stated plainly:

- **A refusal is reported, not resolved.** When polkit denies `enable-linger` (the common case when not root), the agent still starts only at login until the operator runs the named command. This is deliberate — see §4.
- **`unavailable` is genuinely unknown, not assumed good.** A container without `loginctl` gets "couldn't be determined", and no fix instruction is printed, because the instruction would not work there.
- **Nothing re-checks later.** If lingering is turned off after install, nothing notices. Out of scope for an install-time step; the guard-posture surfaces are where a standing check would belong.

---

## 3. Level-of-abstraction fit

Correct layer: the defect is that the Linux install path performs an incomplete install, so the missing step belongs in the Linux install path. No new layer, no new caller, no new subsystem.

The CLI split is deliberate. Reporting is the CLI's job and the install function's job is to install — so the install function establishes the fact and the CLI renders it. Folding lingering into `installAutoStart`'s boolean was rejected: a login-only service is a working install, and returning `false` for it would make `PostUpdateMigrator` log a spurious error and could make a migration look failed when it succeeded.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It performs one idempotent system configuration step and reports the result. It holds no authority over any agent behaviour and gates nothing.

The one authority-adjacent decision is what it does **not** do: there is no `sudo` attempt. A setup step that silently escalates privilege takes an authority the operator did not grant it; naming the command instead keeps the decision with the human. That is a deliberate design choice, not an omission.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The domain is enumerable and binary: lingering is on, off, or unreadable. There are no competing live signals to weigh — one query, one answer, and the "unreadable" case is carried explicitly rather than collapsed into either verdict.

---

## 5. Interactions

- **Shadowing:** none. The call runs after the existing `daemon-reload` / `enable` / `start` sequence and changes none of them.
- **Double-fire:** `enable-linger` is idempotent, and the `enabled-already` branch skips the call entirely, so a repeat install runs no privileged command needlessly. `PostUpdateMigrator` regenerates auto-start on update and will therefore re-check lingering on every update — a read, then a no-op.
- **Races:** none introduced. Two concurrent installs would both read, possibly both enable (idempotent), and both verify.
- **Feedback loops:** none.
- **Carrier lifetime:** `takeLastLingerOutcome()` clears on read, so a later caller cannot pick up a stale outcome from an earlier install. Null on macOS and before any install, where the CLI falls back to the original message.
- **PostUpdateMigrator:** calls `installAutoStart` but not the carrier, so it is unaffected and prints nothing new. Intentional — an update is not the moment to surface an install-time instruction.

---

## 6. External surfaces

- **Other agents on the same machine:** `enable-linger` is per-user, so enabling it for the account running instar affects every service that account owns. On a dedicated agent account this is the intent; on a shared login it means that user's other services also survive logout. Worth naming, but it is the setting the operator would run by hand anyway.
- **Install base:** Linux only. macOS is untouched and Windows already returns false.
- **External systems:** none.
- **Persistent state:** `enable-linger` writes `/var/lib/systemd/linger/<user>`, owned by systemd. Removing it is `loginctl disable-linger <user>`.
- **Timing:** one or two bounded `loginctl` calls (5s timeout) at install time only. Not on any hot path.
- **Operator surface (Mobile-Complete Operator Actions):** the change adds no operator-facing *action*. It changes an existing CLI message and, in the refusal case, hands the operator a one-line command — which is the correct surface, because the action requires root on that machine's shell and no dashboard control could perform it. No PIN-gated or approval-class route is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, approval page, or grant/revoke/secret-drop form is touched. (`src/cli.ts` is a terminal message, not a dashboard surface.)

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Lingering is a property of one account on one machine's init system; whether machine A's agent survives logout says nothing about machine B, and each machine installs its own auto-start. Replicating it would be meaningless.

- **User-facing notices:** none — the change emits no Telegram/Slack/attention output. It prints to the terminal of the person running the command. One-voice gating not applicable.
- **Durable state:** none instar-owned. The systemd linger marker is machine-local by definition and cannot strand on topic transfer.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** revert both files, ship as a patch. Pure code.
- **Data migration:** none instar-owned. Any `linger` markers already set stay set — which is the desired state anyway, and is reversible with `loginctl disable-linger <user>`.
- **Agent state repair:** none. Reverting restores the previous message; already-installed services keep working exactly as they do now.
- **User visibility:** the message reverts to the old unconditional sentence. No functional regression.

---

## Conclusion

The review produced one design change: the outcome travels to the CLI through a read-and-clear carrier rather than by widening `installAutoStart`'s return type. Widening it would have touched four callers, and `PostUpdateMigrator` treats `false` as an error — so a login-only-but-working install would have started logging spurious migration failures. The carrier keeps the blast radius to the two files that actually care.

The second design point worth recording is the refusal to call `sudo`. It makes the fix incomplete in the common non-root case, and that is the right trade: a setup step that silently escalates privilege is a worse defect than the one being fixed.

Verification is honest about its own limits: the `enabled-already` and `unavailable` paths were exercised against a real `loginctl` on the Linux host, and the two failure paths (`needs-privilege` via refusal, and via a command that exits 0 while changing nothing) are covered by injected dependencies rather than by breaking a live machine's configuration.

---

## Second-pass review (if required)

**Reviewer:** none — not spawned.
**Independent read of the artifact: NOT PERFORMED.**

Recorded rather than glossed. This change is not in the Phase-5 trigger list — no messaging block/allow, no session lifecycle, no coherence/idempotency/trust surface, and nothing named sentinel/guard/gate/watchdog. It is an install-time configuration step with no authority over agent behaviour.

A reviewer subagent was additionally not available: a standing operator instruction in the authoring session forbids delegating to subagents unless explicitly asked. The PR is the review surface. If an independent read is wanted before merge, it can be run on request.

---

## Evidence pointers

- Live reproduction (WSL2 / Ubuntu 26.04, headless): `instar autostart install` reported success and `systemctl --user is-enabled` returned `enabled`, while `loginctl show-user echo -p Linger` returned `Linger=no` — an enabled service that would not start at boot.
- 12 unit tests. Both parse directions; the unanswerable case kept distinct from "no"; the no-op-when-already-on path asserting the privileged command is *not* re-run; verification-over-exit-code (a fake enable that exits 0 and changes nothing yields `needs-privilege`); a polkit refusal; the blind-enable guard (`unavailable` never runs the command); and four message assertions including a regression guard that the old unconditional sentence is never rendered for a non-booting outcome.
- The fix was authored on macOS and the live linger paths were exercised on the Linux host that exposed the defect.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in hand-written TypeScript, not an LLM prompt, hook, config, skill, or standards text. No self-triggered controller is added or modified: the change adds no loop, monitor, sentinel, reaper, scheduler, or recovery path — it is a one-shot install-time step with no timer and no re-drive.
