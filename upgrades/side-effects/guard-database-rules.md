# Side-Effects Review — the command guard blocks database-schema destruction again after updates

**Version / slug:** `guard-database-rules`
**Date:** `2026-11-17`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 3 source files, 2 tests and 2 docs. The dangerous-command guard has three writers: the setup template, the copy every update installs (`PostUpdateMigrator.getDangerousCommandGuard`), and an inline copy in `init`. The update and `init` copies had lost the template's database-schema rules, so every updated agent stopped blocking them.

All three now carry:
- always blocked: `--accept-data-loss` and `prisma migrate reset`;
- ask first (level 1) or self-check (level 2): `prisma db push` and `prisma migrate deploy`.

Every pattern loop now uses `grep -e`. The template's `--accept-data-loss` rule had never fired: grep took the pattern as an option and exited 2, which reads as "no match".

## Decision-point inventory

- Dangerous-command guard: add rules, restoring what the template already had.

---

## 1. Over-block

- The guard reads the whole command, so a commit message or search that quotes `--accept-data-loss` or `prisma migrate reset` is blocked too. Existing catastrophic rules already work this way. These strings are rare outside Prisma repos.
- `prisma migrate deploy` in a CI script asks first at level 1, which is correct: it is a production schema push.
- `prisma generate`, `migrate dev` and `studio` are unaffected (tested).

## 2. Under-block

The template's plain-SQL ask-first rules (`DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `DELETE FROM`) are deliberately not added to the update copy:
- Updated agents have long run without them.
- Routine sqlite maintenance and searches would start blocking, a new interruption.

New agents set up from the template keep them. This difference is noted in code beside the loop; an opt-in change at the strictest level is the place to revisit it.

## 3. Level-of-abstraction fit

The same three writers as before; no new copy. A runnable test covers the two script writers, and a text check covers `init`.

## 4. Signal vs authority compliance

- [x] Pattern rules in a safety hook; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- Built-in hooks are always overwritten on update, so existing agents receive the change.
- The manifest hash is rebuilt at build time and is untracked.
- The codex canary checks wiring only.

## 6. External surfaces

None.

## 6b. Operator-surface quality

The block messages are the guard's existing ones.

## 7. Multi-machine posture

Per-machine hook files, written by each machine's update.

## 8. Rollback cost

Revert and ship a patch.

---

## Conclusion

Restores a dropped safety rule and fixes the rule that never fired. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read all three writers and their tests)

**Independent read: concur.** Its minor findings were addressed:
- `-e` added to the risky and deploy loops;
- the SQL difference is commented in code and named in the upgrade note;
- the false-positive behaviour is named in the upgrade note.

The `init` copy stays text-checked only: it is a template literal, and the runnable tests cover the identical script bodies.

---

## Evidence pointers

- `tests/unit/dangerous-command-guard-database-rules.test.ts` runs both script writers against 8 commands.
- The existing guard tests pass: flags-between, force-with-lease, gh-pr-merge-gate and pretooluse-parity, 90/90 in total.
- Before the fix, `grep -qi "--accept-data-loss"` returned "invalid option" (exit 2), and `grep -qi -e` returns 0.
