# Side-Effects Review — built-in hooks run from any session working directory

**Version / slug:** `hook-paths-project-dir`
**Date:** `2026-09-29`
**Author:** `echo`
**Second-pass reviewer:** `done (hook commands for gates changed; independent reviewer concurred)`

## Summary of the change

Claude Code runs a hook command from the session's working directory. Several
built-in hook commands in `.claude/settings.json` were bare relative paths
(`node .instar/hooks/instar/hook-event-reporter.js`,
`bash .instar/hooks/instar/session-start.sh`, …). On 2026-09-29 the Instar 2.0
coordinating session on the Mac Studio (tmux `echo-deepseek-harness`, topic
52075, v1.3.1299) ran with its cwd at `.instar/lanes/pipeline`. Every such hook
failed with `MODULE_NOT_FOUND` / `No such file or directory` on every tool call
and stop, so the hook-event reporter, topic context, external-operation gate,
build stop hook, session-start and permission auto-approve silently never ran.
The one command already written as `${CLAUDE_PROJECT_DIR}/…`
(`stop-gate-router.js`) worked.

Changes:

1. **Templates.** `src/data/http-hook-templates.ts` (the 9 hook-event reporter
   entries, used by both `init` and the migrator), `src/templates/hooks/settings-template.json`
   and the `/build` skill's stop-hook registration now write
   `${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/…`, the form every other
   built-in entry already uses.
2. **Migration.** `PostUpdateMigrator.anchorBuiltinHookCommandPaths()` runs at
   the end of `migrateSettings()` and rewrites any command matching
   `^(node|bash|sh) (./)?.instar/hooks/instar/` to the anchored form. Custom
   hooks (`.instar/hooks/custom/`) and anything else never match. Idempotent:
   an anchored command no longer matches.
3. **Hook scripts that read cwd-relative paths.** `build-stop-hook.sh`
   (template + inline twin, kept byte-identical) reads its state file from
   `${CLAUDE_PROJECT_DIR:-.}`; the scope-coherence collector/checkpoint and
   both claim-intercept hooks resolve `.instar/state` from
   `process.env.CLAUDE_PROJECT_DIR || '.'`; `slack-channel-context.sh` reads
   `${CLAUDE_PROJECT_DIR:-.}/.instar/config.json`. The `:-.`/`|| '.'`
   fallback keeps the old behaviour when the variable is unset.
4. **Slack hook migration parity.** `slack-channel-context.sh` is not on the
   always-overwrite track; its existing survivability migration now also
   upgrades a shipped copy that lacks the anchored config line (per-target
   `currentMarker`), once.
5. **Hook-reference validation.** `validateHookReferences()` also recognises
   the `${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/…` form, so anchoring does
   not silently drop commands out of the missing-file check.

6. **Round 3 (Astra review of PR #2093).** Two repairs:
   - *Quoted paths.* Unquoted, `${CLAUDE_PROJECT_DIR}` splits on a space in
     the home path (`/tmp/Agent Home` → `node /tmp/Agent`), which broke every
     hook where the bare form had still worked from the root. Every Claude
     settings generator (templates, `settings-template.json`, init,
     `instarSettingsHooks.ts`, the migrator's ensure blocks, the `/build` and
     `/autonomous` registration snippets) now emits
     `node "${CLAUDE_PROJECT_DIR}/…"`, keeping trailing arguments. The
     migration pass rewrites both the bare form and the unquoted anchored
     form (built-in `.instar/hooks/instar/` and the autonomous skill's stop
     hook only) to the quoted form; a quoted command no longer matches, so it
     is idempotent and never double-prefixes. `validateHookReferences()`
     accepts the leading quote. The two skill snippets also escape `\$` and
     `\"` so bash no longer expands `${CLAUDE_PROJECT_DIR}` at registration
     time. Presence detection elsewhere is filename-based, so quoting cannot
     cause a duplicate registration.
   - *Paths as data to Python.* `build-stop-hook.sh` (template + inline twin)
     and `slack-channel-context.sh` spliced the now-absolute path into
     single-quoted Python source; a home named `Justin's Agent` was a
     SyntaxError (build stop hook silently approved; Slack hook lost its
     port/token). The path now goes in as `sys.argv[1]`. The Slack upgrade
     marker changed to the argv form, so round-1 copies are upgraded once.
   - Not changed: Codex hooks (`installCodexHooks.ts`) write absolute paths
     unquoted. That is a separate config whose command strings feed Codex's
     trust/arm slots; changing them re-arms every agent. Left for its own
     change.

### Considered and dropped (Occam)

- Absolute paths baked in at install time: break when the agent home moves;
  `${CLAUDE_PROJECT_DIR}` is what Claude Code provides for exactly this and is
  already the dominant form.
- Anchoring `playbook-scripts/build-state.py` (the `/build` state writer):
  it is a dev-repo script run by the agent's Bash tool, not a hook; the brief
  scope is hook commands and hook scripts.

## Decision-point inventory

No decision logic changes. The gates (external-operation gate, build stop
hook, auto-approve) decide exactly as before; they now actually run in
subdirectory sessions.

## 1. Over-block

Gates that were silently not running in subdirectory sessions now run there:
the external-operation gate can now block an MCP call from such a session, and
the build stop hook can now hold an owning `/build` session. That is their
intended behaviour everywhere else. No new blocking logic.

## 2. Under-block

- Custom hooks with bare relative paths are left alone on purpose (agent-owned).
- The agent-facing text in hooks that tells the agent to run
  `.instar/scripts/telegram-reply.sh` is still relative. That is an
  instruction for the agent's Bash tool, not a hook command; a session in a
  subdirectory still has to run it from the project root.
- `hookParityRule`'s own `bash .claude/hooks/<event>/…` commands are bare
  too and share the cwd weakness; they live outside `.instar/hooks/instar/`
  and are not changed here.
- A hook command in an unusual shape (e.g. `cd x && node .instar/…`) is not
  rewritten; none is shipped.

## 3. Level-of-abstraction fit

Fix is at the source (the templates) plus the one migration pass that owns
`.claude/settings.json`. No new layer.

## 4. Signal vs authority compliance

Not a decision point. Path resolution only. (`docs/signal-vs-authority.md`.)

## 4b. Judgment-point check

None added.

## 5. Interactions

- The pass runs last in `migrateSettings()`, after `migrateSettingsHookPaths`
  (flat → `instar/` layout) and `ensureAutonomousStopHook` (which detects
  `.instar/hooks/instar/autonomous-stop-hook` by substring and still matches
  the anchored form).
- Presence detection elsewhere is by filename substring
  (`instarSettingsHooks`, `ensureHttpHooksExist`,
  `ensurePermissionAutoApprove`), so anchored entries are still recognised:
  no duplicates.
- `hookParityRule` compares exact desired commands, but only for its own
  `bash .claude/hooks/<event>/…` commands, which this pass never touches.
- `build-stop-hook-session-scoping.test.ts` now pins `CLAUDE_PROJECT_DIR` to
  the fixture, as Claude Code does, so it passes whether or not the test run
  inherits the variable.

## 6. External surfaces

`.claude/settings.json` on every Claude-Code agent is rewritten once on
update (only when a bare built-in command exists). No network or user-visible
message change.

## 6b. Operator-surface quality

No operator surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: `.claude/settings.json` and hook scripts are per
install, and each machine's own update applies the migration.

## 7b. Constitutional Rules touched (Instar 2.0 `docs/01-the-rules.md`)

- **Rule 116 (simplest robust route):** one prefix in the templates, one
  regex pass in the existing settings migration, and the `${VAR:-.}` fallback
  pattern the hooks already use. No new mechanism.
- **Rule 26 (verify the state, not its symbol):** the hooks looked installed
  in settings but did nothing from a subdirectory; the tests check the
  generated settings file and the migrated file on disk, and the subdirectory
  build-stop test fires the real shipped hook from `.instar/lanes/pipeline`.
- **Rule 70 (bug evidence):** the subdirectory build-stop test fails with the
  script change reverted and passes with it; the anchoring test's detector is
  shown to flag the bare form.
- **Rule 74 (side effects):** this review.
- **Rule 101 (hooks are never skipped silently):** this defect skipped guard
  hooks silently in every subdirectory session; after the fix they run, and
  a missing anchored hook is still reported by `validateHookReferences()`.

## 8. Rollback cost

Revert and ship a patch. The migrated settings (anchored commands) keep
working on the old code too: `${CLAUDE_PROJECT_DIR}` resolves to the project
root, which is where the old bare paths resolved in root-cwd sessions.

## Conclusion

Safe to ship. Hooks that silently did nothing in subdirectory sessions now
run there; root-cwd sessions behave exactly as before.

## Second-pass review

Concur with the review. Independent reviewer checked: the regex touches only
`node|bash|sh .instar/hooks/instar/` commands, keeps trailing arguments, and
is a no-op on a second run; no presence check compares these commands by
exact string (all match on filename), so nothing is duplicated or re-added;
`getBuildStopHook()` and `src/templates/hooks/build-stop-hook.sh` are
byte-identical; no hook script still reads agent-home state against the cwd.
Two wording corrections (the `hookParityRule` sentence and this header) were
applied. Side note recorded: the widened `validateHookReferences` regex now
also reports missing files for already-anchored commands, as intended.

## Evidence pointers

- `tests/unit/hook-command-project-dir-anchor.test.ts`: templates and
  init-generated settings carry no `node .instar/` / `bash .instar/` built-in
  command; the migration rewrites an old settings file once, a second run
  leaves it byte-identical, a custom hook is untouched; the validator still
  flags a missing anchored hook.
- `tests/unit/build-stop-hook-session-scoping.test.ts`: "reads build state
  from the project dir when the session runs in a subdirectory" fails on
  origin/main's hook and passes here.
- `tests/unit/secret-externalization-survivability-migrator.test.ts`: an
  auth-current `slack-channel-context.sh` with the cwd-relative config read is
  upgraded once, then left alone.

## Suite repair carried in this change

The full unit run for this change failed one unrelated test once:
`tests/integration/cutover-readiness-routes.test.ts` "a FAILED rehearsal is
409" got a 401 in 5 ms. The file passed 3/3 alone. Its server bound the wildcard
address while the test fetched `127.0.0.1`. The likely cause is that another
process's `127.0.0.1` listener on the same port answered first. The test now
binds `127.0.0.1`, as 68 other test files already do. The change is test-only.

## Class-Closure Declaration (display-only mirror)

Closes the class "built-in hook command resolved against the session cwd" for
shipped templates and deployed settings (migration). Hook scripts that read
agent-home files now resolve them from `CLAUDE_PROJECT_DIR`. No controller or
decision logic modified.

## Round 3 second-pass review

An independent reviewer checked the round-3 diff: 15 regex edge cases in
node (bare, `./`, unquoted anchored, autonomous stop hook, trailing arguments,
already-quoted, custom, `$CLAUDE_PROJECT_DIR` without braces, `sh -c`
wrappers), the skill snippets through real bash, filename-based presence
checks (no duplicate registrations), the build-stop template/twin identity,
live runs of both hooks under `/tmp/Justin's Agent X` from a subdirectory,
and the Slack upgrade marker against the round-1 and pre-PR copies.
Residual, not fixed here: already-installed `/autonomous` and `/build`
SKILL.md files keep their old registration snippets (no skill-content
migration). Those entries still work from the agent root and are re-quoted
by `migrateSettings()` at the next update; they only fail for a spaced home
or a subdirectory session in the window before that update.

Concur with the review.

## Round 4: installed skill snippets

The Astra round-2 review turned the residual above into a must-fix: an
installed pre-fix registration block, run after an update, rewrote the
quoted settings command back to the unquoted form. `PostUpdateMigrator`
now runs `migrateSkillStopHookRegistrationQuoting()` after the autonomous
skill upgrades. It replaces only the exact shipped registration line in
`.claude/skills/autonomous/SKILL.md` and `.claude/skills/build/SKILL.md`
(for `/build`, also the unreleased round-1 unquoted line) with the quoted
line, leaving every other byte alone. A skill without the shipped line
(custom or already upgraded) is not touched, so a second run is a no-op.
Over-block: none (no gate). Under-block: a user who hand-edited that one
line keeps their version; `migrateSettings()` still re-quotes the settings
entry on the next update.

## Round 4 second-pass review

Checked byte-for-byte that the migration's old literals occur exactly once in the db15e1ea2 `/autonomous` and `/build` SKILL.md files (and the round-1 `/build` line in b0932f101), and that migrating each old file yields the current bundled file exactly.
The quoted replacement strings contain none of the old strings (idempotent); only the exact line is swapped, so custom content survives, and the unit test (6 tests) passes.
The call sits after `migrateBuildSkillMethodology` and `migrateAutonomousStopHookTopicKeyed`, the two whole-file SKILL.md redeploys; no other shipped copy of these registration blocks exists in `src/` (init copies the bundled files).
Concur with the review.
