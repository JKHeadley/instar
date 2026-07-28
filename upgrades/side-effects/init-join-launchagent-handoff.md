# Side-Effects Review — Init→Join LaunchAgent handoff (MM-Bootstrap Track C)

**Spec:** `docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md` §Track C (approved PR #465).

**Scope.** `src/commands/machine.ts` (joinMesh — add Step 6: install auto-start
for the joined home), `tests/unit/init-join-launchd-handoff.test.ts` (new).

**Problem.** `instar join` never installed an auto-start plist for the joined
home. So a joined agent had no LaunchAgent/systemd unit (operator had to
hand-start it), and — worse — a stale `ai.instar.<projectName>` plist left by a
prior `instar init` of the SAME name at a DIFFERENT home kept respawning a
server against the wrong directory, fighting the joined one for the port +
identity (observed live 2026-05-27 during the mesh bring-up).

**Fix.** joinMesh now calls `installAutoStart(projectName, joinedProjectDir,
hasTelegram)` after the gitignore step. Because the auto-start plist Label is
keyed on `projectName` (`ai.instar.<name>`), installing for the joined dir
cleanly REPLACES any stale same-name plist — one unit, pointing at the joined
home, zero orphans.

**Design note (supersedes the spec's drafted pointer-file C-2).** The spec
drafted a pointer-file (`active-home`) + plist-wrapper approach. Implementation
found that unnecessary: the Label is already keyed on projectName, so a
re-install naturally replaces. The simpler fix (join calls installAutoStart) is
less code, no new mechanism, same guarantee. Flagged to Justin via Telegram.

**Side-effects review.**
- **No change to `instar init`'s behavior** — init still installs its plist as
  before. Only join now ALSO installs (for its own home).
- **hasTelegram=false-derived-from-config for the standby** — a joined standby
  installs a server-start unit (ready to take over), not a lifeline. The shipped
  poll-ownership lease prevents dual-poll if telegram is configured on both ends,
  so even if a future config sets hasTelegram=true the 409 class can't recur.
- **Idempotent + safe** — installAutoStart overwrites the same Label; re-running
  join is harmless. The call is wrapped in try/catch (@silent-fallback-ok): a
  failed auto-start install does NOT fail the join (join still succeeds; operator
  can hand-start).
- **No new orphans** — the replace property is the whole point; verified by test.

**Test coverage.**
- Unit `tests/unit/init-join-launchd-handoff.test.ts` (2 cases, darwin-gated,
  sandboxed $HOME so it never touches the real LaunchAgents dir): (1) two installs
  same-name + different-dir → ONE plist pointing at the second (joined) dir, init
  dir gone; (2) standby install (hasTelegram=false) writes server-start args, not
  lifeline.
- E2E launchd lifecycle is quarantined per spec (INSTAR_E2E_LAUNCHD) — macOS-only,
  not run in CI.

**Deferred (own follow-up, noted not silently dropped).** The join config-creation
sub-gap (joined home lacks config.json because it's gitignored; a config.json.bak
is committed) is a SEPARATE bootstrap gap surfaced the same night. Out of Track C's
tight autostart scope; tracked for a follow-up so it isn't lost.

**Migration parity.** Server source — existing agents pick up the fix on
auto-update. New joins get the behavior immediately. Existing JOINED agents (rare,
since join didn't install autostart before) won't have a plist; the forward fix
covers all new joins, and `instar server start` self-heals an autostart install at
boot (server.ts autostart-check), so an existing joined agent gets a plist the next
time its server starts anyway.

**Rollback.** Revert the PR. join stops installing autostart (prior behavior).
No migration to reverse, no data change.
