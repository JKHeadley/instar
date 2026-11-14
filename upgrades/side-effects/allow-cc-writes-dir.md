# Side-Effects Review — Claude Code's own empty `.claude/.cc-writes/` no longer discards a fix

**Version / slug:** `allow-cc-writes-dir`
**Date:** `2026-10-26`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** independent Codex review (gpt-6-astra), appended below — run because this narrows a breach check.
**Tier:** `1` — two source files, ~40 source lines; a revert fully undoes it; no persisted state.
**Effort:** 0 spec rounds, 2 independent review rounds (BLOCKED → fixed → CLEAN), 1 commit.

## Summary of the change

`buildChangeSet` refused any `.claude/` in the finished session workspace as `sandbox-breach`.
Claude Code 2.1.310 (auto-installed overnight; the 2026-10-25 canaries ran on 2.1.303) creates an
empty `.claude/.cc-writes/` (mode 0700) itself whenever its sandboxed Bash runs. Reproduced with a
bare `claude -p --settings <sandbox.enabled:true> … "echo hi > out.txt"` in a fresh git folder;
without the sandbox, and in an interactive session with the confined flags but no sandbox,
nothing appears. Both of 2026-10-26's first real attempts (05:59 canary ok:true → 06:18
`sandbox-breach`) were discarded on it; their transcripts show no tool call touching `.claude/`.

`claudeDirBreach(workspace)` now passes exactly: absent; a real empty directory; or a real
directory whose only entry is a real, empty `.cc-writes` directory. Everything else is a breach:
a file anywhere under `.claude/`, any other name, a link for `.claude` or `.cc-writes`, `.claude`
as a non-directory, anything inside `.cc-writes`, an unreadable entry, or any inspection error other than ENOENT. The session canary runs
the same function as a new probe (`session-claude-dir-clean`); `CANARY_VERSION` → v3.

## Decision-point inventory

- Change-set gate (authority: discard an attempt): narrowed by one exact, content-free shape.
- Session canary (authority: pause the executor): one new must-fail probe — stricter.

## 1. Over-block

Before: every attempt on Claude Code 2.1.310 was discarded. After: none for this reason.

## 2. Under-block

Could a session use an empty `.cc-writes` to smuggle anything? It holds nothing, and the change set
walk skips `.claude/` entirely, so nothing under it is ever published. Its only possible meaning is
"the session could create a directory under `.claude/`", which Claude Code itself does; the
permission and sandbox denies on `.claude/` files are unchanged. A future Claude Code that writes a
FILE there would fail both the canary and the gate — loud, never silent.

## 3. Level-of-abstraction fit

The rule lives in the one gate that reads the workspace, and the canary imports the same function,
so the rehearsal and the real gate cannot drift.

## 4. Signal vs authority compliance

Authority unchanged in kind (deterministic effect check); one exact shape added to its pass set.

## 4b. Judgment-point check

No competing-signals decision: a fixed filesystem shape.

## 5. Interactions

- The canary's own session also leaves `.claude/.cc-writes/` in the workspace before the build
  session starts; under the new rule that is clean, and the walk never publishes it.
- `CANARY_VERSION` v3: the versioned latch (#2352) treats a v2 latch as not in force, so a new
  install runs the new canary at the next tick.

## 6. External surfaces

None.

## 6b. Operator-surface quality

The breach detail now names what was found (`not empty`, `reappeared (<name>)`, `not a directory`).

## 7. Multi-machine posture

Machine-local: the executor runs only on the canonical owner.

## Note on the silent-fallback ratchet

The two catches in `claudeDirBreach` that can look like fallbacks to `tests/unit/no-silent-fallbacks.test.ts` (its 20-line window reaches a later `return null`) carry `@silent-fallback-ok` with the reason: ENOENT is the clean case and every other error returns a breach. Neither swallows a failure.

## 8. Rollback cost

Revert. The executor then discards every attempt again on Claude Code ≥ 2.1.310.

## Conclusion

Ship.

## Second-pass review (if required)

**Codex (gpt-6-astra), round 1: BLOCKED.** [P2] the first cut caught every `lstatSync` failure as "absent", so EACCES/EPERM/EIO read as clean — and the walk skips `.claude/` unread, so nothing else would look. Rounds 1's other notes: publication and race controls hold (the workspace is renamed outside its writable path before inspection; the walk excludes `.claude/`; verification uses fresh clones; `applyChangeSet` copies no directory metadata); exact-name comparison rejects `.CC-WRITES` and lookalikes; mount points / ACLs / xattrs are not distinguished but nothing downstream publishes them.

**Author's response:** only ENOENT is clean; any other inspection error is a breach (`could not be inspected`). Tests added for EACCES/EPERM/EIO and for three name variants.

**Codex round 2: CLEAN** — P2 closed, no new regression.

## Evidence pointers

- `GET /feedback-factory/execute/status` 2026-10-26 06:18 PDT: attempts `feedback-955789fc…:a6`
  and `feedback-51dd30b3…:a5` `state: failed, reason: sandbox-breach`; canary at 05:59 ok:true
  stamp 45d2e156852450d7919152a6 on Claude Code 2.1.310.
- Reproduction (06:23 PDT): fresh folder, sandbox-enabled settings, one Bash call →
  `.claude/.cc-writes/` (empty, drwx------).
- Unit: 147/147 across `execute-units`, `execute-service`, `execute-short-attempt-tmpdir`;
  e2e `feedback-execute-lifecycle` 2/2; lint + `tsc` clean.

## Class-Closure Declaration (display-only mirror)

Class: "a framework's own bookkeeping read as a confinement breach". This closes the one observed
member and makes the canary rehearse the gate, so the next member fails loudly at canary time.
