# Side-effects review — parent --framework intercept hotfix

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before (post-PR 3+4): UNDER — the flag silently fell back to claude-code
on every subcommand invocation; the install/wizard arc didn't actually
work for Codex. After: precisely correct. Subcommands receive the flag.

## 2. Level-of-abstraction fit

Fix sits exactly where the bug was — the program-level option definition
in `cli.ts`. Removed cleanly; a comment-at-call-site explains the
removal so a future editor doesn't reintroduce it.

## 3. Signal vs Authority compliance

No new authority. The bug was that Commander's program-level option
parsing was treated as an authoritative consumer of subcommand args.
Removing the program-level definition leaves subcommand parsers as the
sole authority for their own flags — which is the correct mental model.

## 4. Interactions with adjacent systems

- **PR 3+4 (`instar setup --framework`)** — fix consistent with how
  `setup` already worked. `instar setup --framework codex-cli` was always
  going to be the correct invocation; the bug just made `instar` (no
  subcommand) intercept the flag and also broke `instar init`.
- **PR 1 (`instar init --framework`)** — now actually works on the CLI
  path, not just when initProject is called directly. The PR 2 unit
  tests still pass (they bypass the CLI layer); the smoke test is now
  also green.

## 5. Rollback cost

Trivial. One option declaration removed plus a comment. `git revert`
reintroduces the bug — but the comment-at-call-site would also revert,
which is the safety net.

## 6. Backwards compatibility / drift surface

Fully backward-compatible. Users who already used `instar init
--framework codex-cli` had a broken result before; now they get the
correct codex-only install. Users who used the bareword `instar` with no
flags see no change. Users who used `instar --framework codex-cli`
(passing the flag before any subcommand) — that invocation never
actually worked because there's no `--framework` on the bareword now,
and even before this fix, bareword wouldn't have reached init/setup
with the flag.

## 7. Authorization / Trust posture

No new authority. No privilege change. No new resources accessed.

## Outcome

Ship. One-line code fix verified by smoke test on this machine. Closes
the install/wizard portability arc functionally.
