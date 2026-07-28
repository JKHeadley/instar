# Side-Effects Review — scope force-with-lease protected-branch check to the push invocation

**Version / slug:** `guard-forcepush-precise`
**Date:** `2026-06-07`
**Author:** `echo`
**Second-pass reviewer:** `self-review under the Tier-1 lite lane; the does-this-widen-the-guard question addressed below`

## Summary of the change

The `dangerous-command-guard` carve-out that permits `git push --force-with-lease` to a non-protected branch previously decided "is this a protected branch?" by scanning the WHOLE command input (`$INPUT`) for `(main|master|develop|release*)`. Any unrelated text in the command — a chained heredoc status message, a redirect path, a log line mentioning "release cadence" or "main" — false-positived and blocked a legitimate PR-branch force-with-lease update (observed live 2026-06-07, topic 19437: a force-push whose accompanying report text mentioned "release cadence" was blocked). The fix extracts only the `git push …` invocation (`grep -oiE 'git +push[^|;&]*' | head -1`) and scans THAT for the protected-branch token. Applied identically to all three writers (template, PostUpdateMigrator, init.ts) plus a regression test.

## Decision-point inventory

- Protected-branch scan target — modified — `$INPUT` (whole command) → `$PUSH_INVOCATION` (extracted `git push …` segment only). No change to the regex itself.
- Carve-out semantics — unchanged — force-with-lease to a non-protected branch allowed; to main/master/develop/release* blocked; plain `--force`/`-f` blocked.
- Writers touched — all three (template `.sh`, `PostUpdateMigrator.getDangerousCommandGuard`, `init.ts` inline copy) — kept byte-consistent.

## 1. Direction-of-failure analysis

- **Old failure (live):** the guard blocked a SAFE force-with-lease to a feature branch whenever unrelated command text contained a protected-branch word → recurring friction; the agent could not update its own PR branch and resorted to workarounds.
- **New behavior:** the scan is confined to the push command. `git push --force-with-lease origin echo/feature && echo "release cadence on main"` is now ALLOWED (push targets a feature branch); `git push --force-with-lease origin main` is still BLOCKED. Both pinned by tests.
- **Trust surface NOT widened:** the change makes the protected-branch check NARROWER (fewer inputs match), never broader. A force-push to a protected branch, and plain `--force`/`-f`, remain blocked exactly as before — verified by the existing "BLOCKS force-with-lease that explicitly targets main/master" and "BLOCKS plain git push --force" tests, which still pass.

## 2. Over-permit

None. The only behavioral delta is that unrelated text outside the `git push` segment no longer triggers the protected-branch block. No new verbs, no wildcarding, no relaxation of the protected-branch set.

## 3. Scope deliberately NOT taken

- The broader text-scanning class (a `git commit` whose *message* mentions `git push --force` trips the risky-pattern loop) is a real but separate limitation of the deploy/risky-pattern scan; fixing it requires command-verb parsing across the whole guard and is out of scope for this targeted carve-out fix. Noted for a follow-up.

## 4. Migration parity

Covered. The migration writer (`PostUpdateMigrator.getDangerousCommandGuard`) is fixed, so existing agents receive the corrected guard on their next update (built-in `instar/` hooks are always-overwritten on migration). New agents get it via `init.ts`. The shipped template is fixed for completeness.

## 5. Token/cost impact

None.
