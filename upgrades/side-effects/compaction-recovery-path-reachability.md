# Side-Effects Review — compaction recovery path reachability

**Version / slug:** `compaction-recovery-path-reachability`
**Date:** `2026-07-31`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `Codex subagent 1798_second_pass — concurred`

## Summary of the change

`PostUpdateMigrator` already installs both built-in hooks under
`.instar/hooks/instar/`, but the generated session-start hook checked and
executed compaction recovery at the obsolete flat path
`.instar/hooks/compaction-recovery.sh`. The compact branch therefore skipped
identity and conversation recovery even after a successful migration. This
change aligns the session-start executable check and `exec` with the canonical
installer path and adds a migration-level regression that reads the generated
hook, extracts both references, and proves they resolve to the executable file
the same migration wrote. It also registers the broader generated-artifact
path-contract defect class and tracks its class-level lint as ACT-245.

## Decision-point inventory

- `getSessionStartHook()` compact-event branch — **modified** — its existing
  deterministic executable-presence check now names the canonical built-in-hook
  directory. The branch's allow/skip semantics are unchanged.
- `migrateHooks()` built-in installation location — **passed through** — remains
  the authoritative writer at `hooks/instar/compaction-recovery.sh`.
- Compaction recovery content and all recovery judgments — **passed through** —
  no detection, retry, restart, or recovery policy changes.

---

## 1. Over-block

The change rejects no user input and adds no new refusal. A manually maintained
legacy recovery hook that exists only at `.instar/hooks/compaction-recovery.sh`
is no longer considered by the generated session-start hook, but that flat path
was already non-authoritative: every current migration writes and overwrites the
built-in hook under `.instar/hooks/instar/`. Custom hooks belong under
`.instar/hooks/custom/`, so preserving the stale flat lookup would reintroduce
layout ambiguity rather than legitimate compatibility.

---

## 2. Under-block

The regression closes this exact producer/consumer path mismatch for compaction
recovery. It does not yet scan every generated hook-to-helper reference in the
repository; that broader class guard is tracked as ACT-245, due 2026-09-14. A
file may still be absent after external deletion or an interrupted migration;
the existing executable check intentionally skips in that condition rather than
making session startup fail.

---

## 3. Level-of-abstraction fit

The fix sits at the generated caller that contained the wrong literal, while
the regression spans the actual migration boundary. Testing only the template
string would prove spelling but not installation reachability; testing only the
installed file would miss whether both the check and `exec` use the same path.
The migration-level test is therefore the smallest layer that proves the
end-to-end contract without introducing a second path resolver into shell.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no new block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic.

The pre-existing `-x` check is a deterministic filesystem invariant, not a
judgment over ambiguous evidence. This change corrects the invariant's operand;
it does not promote a detector into authority or alter the fail-soft startup
policy when the helper is truly missing.

---

## 4b. Judgment-point check

No new static heuristic or competing-signals decision point is added. “Does the
canonical executable installed by this migrator exist?” is an enumerable
structural invariant.

---

## 5. Interactions

- **Shadowing:** on compact events, the dedicated recovery script still replaces
  the session-start process before ordinary startup output. The corrected path
  makes the already-designed branch reachable.
- **Double-fire:** there remains exactly one compact delegate and one `exec`; the
  path correction cannot invoke both legacy and canonical copies.
- **Races:** migration writes both files synchronously before returning. The test
  exercises the completed migration state; no shared mutable runtime state is
  introduced.
- **Feedback loops:** none. The helper runs once per compact lifecycle event and
  this change adds no trigger, retry, or re-entry edge.
- **Adjacent migration behavior:** built-in hooks remain always-overwrite, so an
  existing installation receives both corrected session-start content and the
  canonical recovery helper on its next update.

---

## 6. External surfaces

Existing agents regain the intended post-compaction identity and conversation
context after update. There is no HTTP/API/schema change, no new message, no
database or ledger write, and no dependency on Telegram, Slack, GitHub, or
Cloudflare. The only timing dependency is the existing compact lifecycle event.
No operator-facing action is added.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture

**machine-local BY DESIGN** — session hooks and compaction events belong to the
specific process and checkout on each machine. The source fix replicates through
the normal software update path, after which each machine's migrator installs its
own canonical hook pair. The change emits no user-facing notice, holds no durable
state, strands nothing on topic transfer, and generates no URL.

---

## 8. Rollback cost

Pure generated-hook source change plus test and governance artifacts. A hot-fix
can revert the two corrected literals; no data migration or agent-state repair is
required. Reverting would restore the silent post-compaction context loss on
agents after their next migration, which is why rollback is safe mechanically
but undesirable behaviorally.

---

## Conclusion

The implementation is narrow and complete for #1798: both authoritative source
references now match the authoritative writer, and a fail-first integration
regression proves the contract at migration output. Because compaction is a
session-lifecycle surface, an independent second-pass review checked the
migration, compact-event execution, authority posture, and release claim and
concurred. The broader defect-class guard is honestly tracked as ACT-245 rather
than overstating this one regression as repository-wide closure.

---

## Second-pass review

**Reviewer:** Codex subagent `1798_second_pass`
**Independent read of the artifact:** concur

The reviewer independently verified that both generated references match the
canonical writer, ran the focused 7-test suite, and executed a compact event
against migrated hooks to prove recovery replaces ordinary session-start flow.
They found no added authority, persistent-state mutation, security-boundary
change, or migration hazard, and agreed that the unconfirmed novel class is
honestly recorded as a gap under ACT-245.

---

## Evidence pointers

- `tests/unit/PostUpdateMigrator-loadAssess.test.ts` — fail-first result captured:
  expected `hooks/instar/compaction-recovery.sh`, received
  `hooks/compaction-recovery.sh`; then 7/7 tests passed after the source fix.
- `src/core/PostUpdateMigrator.ts#getSessionStartHook` — both the executable check
  and `exec` now use the installed built-in-hook path.
- `src/core/PostUpdateMigrator.ts#migrateHooks` — authoritative writer remains
  `hooks/instar/compaction-recovery.sh`.
- Independent compact-event execution reached the installed recovery hook and
  replaced ordinary session-start flow.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `generated-artifact-path-contract-drift`, a novel class:
  independently generated producer and consumer artifacts can each be locally
  valid while naming different canonical paths for the same dependency. Its
  nearest existing class is `prompt-parser-contract-drift`; both are contract
  drift, but that class is restricted to prompt-output schemas rather than
  generated filesystem reachability.
- **`closure`** — `gap`. The class enters unconfirmed, so this instance test
  cannot honestly claim class-wide closure.
- **`guardEvidence`** — not applicable for gap closure.
- **`gap`** — ACT-245, “Add generated-artifact path-contract lint,” due
  2026-09-14. The regression in this change still guards the exact #1798 pair.
