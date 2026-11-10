# Side-effects review — the fold-marker tool policy (PreToolUse `*`)

**Version / slug:** `cb-fold-marker`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §10 ("Tool use in the probe and handoff turns is governed by a fold-marker tool policy of its own (for Claude Code a PreToolUse hook), session-scoped by a marker file the owner writes at prepare or lock time (foldId, the Instar session id from `INSTAR_SESSION_ID`…), not by a server query: no marker ⇒ allow…; a malformed marker ⇒ deny; marker present ⇒ a strict command-shape allowlist, match-fail-closed…"), §9.3 (the per-session marker files are carriers keyed by `foldId`; the coordinator supplies the candidate's and answerer's `INSTAR_SESSION_ID` to the spawn call), §14 "Probe/handoff suppression". Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 8, part c; stacked on slice 7.
**Tier:** 2 (a new blocking hook on every tool call of every Claude Code session, fleet-wide settings migration). Size: ~7 files, ~560 LOC incl. ~260 test LOC.

## Summary of the change

1. **`PostUpdateMigrator.getFoldMarkerGuardHook()`** — the canonical hook body, authored in TypeScript (`String.raw`; no backtick or dollar-brace in the body, so the regexes survive; a test checks the installed copy) so this blocking decision lives where the repo's blocking-decision ratchets can see it, like the stand-down guard; installed as `.instar/hooks/instar/fold-marker-guard.js`. Decision:
   - no `INSTAR_SESSION_ID` ⇒ exit 0 before reading stdin;
   - no marker for this session ⇒ exit 0 (every other session, the lifeline's included, untouched);
   - malformed or unreadable marker ⇒ deny;
   - marker past its stamped expiry ⇒ deny while the fold record for its `foldId` is non-terminal or missing; allow (and log) once it is terminal;
   - live marker ⇒ allow ONLY a Bash command that is exactly `curl [-s|-sS|-fsS|-sf] [-H "Authorization: Bearer $AUTH"|"…$INSTAR_AUTH_TOKEN"] "http://(localhost|127.0.0.1):<THIS agent's configured port>/<lookup>[?query]"` — the URL MUST carry both double quotes (so `&`, `;`, `|` inside it are literal) and may contain no `$`, backtick, backslash or quote; `<lookup>` is `/topic/search`, `/memory/search` or `/context-layers/lookup` by prefix, with no `..`, `//` or `/./` and no `%2e`/`%2f`/`%5c` in the query; deny everything else (every file-reading tool, writes, sub-agents, web fetch, MCP tools, unknown future tools, `bash -c`, interpreters, compound commands, variables in the URL, `-X`/`-o`/data flags, non-localhost hosts, any send route).
   - Every decision under a marker is appended (0600) to `_fold-markers/<foldId>.decisions.jsonl`: the per-fold refusal and lookup counts (§10).
   - Agent-scoped paths resolve from `INSTAR_AGENT_HOME` (a worktree session's `CLAUDE_PROJECT_DIR` is the checkout, which has no state), the stand-down guard's earned lesson. Dynamic `import('node:…')`, so it runs under CJS and ESM hosts (tested with `"type": "module"`).
   - Fail direction: the hook denies only for a marker that provably exists (an `lstat` that succeeds); if existence cannot be established (no file, or an unreadable markers directory) the session is treated as unmarked and allowed. An error after that point denies.
2. **`src/monitoring/foldMarker.ts`** — the single writer of the marker (`writeFoldMarker`, 0700/0600, atomic replace, refuses unsafe ids), `listFoldMarkers`, `removeFoldMarkers` (keyed by FILENAME), and `foldMarkerCarrier` (an unattributable marker, read but unparseable or content/filename-mismatched, is listed under `TORN_MARKER_KEY` for the boot sweep; a read error is skipped, never deleted), added to `defaultFoldCarriers` so the coordinator's terminal transition and boot sweep release markers like every other carrier.
3. **Registration** — one entry in `INSTAR_WILDCARD_PRETOOLUSE_HOOKS` (`node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/fold-marker-guard.js"`, blocking, 2 s), which both init and `migrateSettings` consume (no drift between new and existing agents); the file is installed by `migrateHooks` (always overwritten) and by init.

**Phase 0 posture:** nothing writes a marker yet (the step runner is Phase 2), so on every agent the hook exits after one env read and one failed marker read.

## Decision-point inventory

- **Added:** a deterministic tool-call gate for a session that carries a fold marker. No judgment.

## 1. Over-block

- A probe or handoff turn cannot read files at all, by design (§10: the engine checkpoint, archive and layer store sit on the same disk; a read would count as retention).
- A probe turn's lookup must match the exact command shape; a legitimate lookup written differently (other curl flags, a different header variable, a quoted query with spaces) is denied. The probe prompt (Phase 2) must state the shape. <!-- tracked: CMT-1536 (Phase 2 probe prompt states the allowed lookup command shape) -->
- `/context-layers/lookup` is allowlisted ahead of its route, which the layer slices add; until then such a call simply 404s.

## 2. Under-block

- The hook resolves agent state from `INSTAR_AGENT_HOME`, falling back to `CLAUDE_PROJECT_DIR`; the confined-spawn environment allowlist sets `INSTAR_SESSION_ID` but not `INSTAR_AGENT_HOME`, and the registered command resolves the hook file from `${CLAUDE_PROJECT_DIR}` (a worktree checkout has no `.instar/hooks`, so `node` exits 1 and nothing is enforced). The stand-down guard shares this. Phase 2's fold spawns must carry `INSTAR_AGENT_HOME` and run from the agent home. <!-- tracked: CMT-1536 (Phase 2 fold spawns set INSTAR_AGENT_HOME and a resolvable hook path; verification suite asserts a marked session is enforced) -->
- The per-fold decisions log (`<foldId>.decisions.jsonl`) is written but not yet read or pruned; the sentinel/measurement slice consumes and retires it. <!-- tracked: CMT-1536 (Phase 0 task 10: sentinel reads and retires fold decision logs) -->
- Only Claude Code sessions run this hook. Codex and other engines get their own adapter in the verification suite (task 11). <!-- tracked: CMT-1536 (Phase 0 task 11: adapter verification suite covers the tool policy per engine) -->
- A session with no `INSTAR_SESSION_ID` is outside the hook's reach; every fold session is spawned by the coordinator with one (§9.3).
- An allowed lookup is a GET to a localhost route; the routes themselves must stay read-only (they are mediated and logged).

## 3. Level-of-abstraction fit

Same shape and registration as the stand-down guard (a session-scoped `*` PreToolUse guard keyed by a marker file), and the marker is a fold carrier with the record-driven lifetime the coordinator already enforces.

## 4. Signal vs authority compliance

Blocking authority, deterministic over a local file, scoped to a session the coordinator explicitly marked, match-fail-closed as the spec requires; unmarked sessions are never affected.

## 5. Interactions

- **Stand-down guard, origin guard, sign-in guard:** independent `*` hooks; any deny wins. No shared files.
- **FoldCoordinator:** markers are released with the other carriers on the terminal transition and as orphans at boot.
- **Hook cost:** runs on every tool call of every Claude Code session; steady state is a node start-up, an env read, two dynamic imports and one `lstat` that fails with ENOENT (no stdin parse, no HTTP).

## 6. External surfaces

`.claude/settings.json` gains one `*` PreToolUse entry on every agent at update; a new hook file under `.instar/hooks/instar/`. No user-visible change in Phase 0.

## 7. Multi-machine posture

Machine-local by design: a marker governs a session on the machine that runs it, and the coordinator that writes it runs on the topic's owner, where the fold's sessions live (§9.3, §10).

## 8. Rollback cost

Revert. `migrateSettings` only adds entries, so on agents that already updated the `*` entry stays, pointing at the last installed hook file, which keeps exiting 0 for every session without a marker (and no marker is ever written in Phase 0). If that file were deleted, `node` would exit 1, which Claude Code treats as a non-blocking hook error (only exit 2 or a `deny` decision blocks). A cleanup migration can remove the entry if a revert ever ships.

## Class-Closure Declaration

- `unbounded-self-action` — closure `n/a`: a per-tool-call check with no loop, timer or retry.

## Evidence

- `tests/unit/fold-marker-guard-hook.test.ts` (17): the hook installed through the real `PostUpdateMigrator.getHookContent`, run as Claude Code runs it (JSON on stdin, identity in env): byte-identical to the canonical template; no `INSTAR_SESSION_ID` ⇒ allow; no marker for this session ⇒ allow; under a live marker every file-reading, write, sub-agent, web, MCP and unknown tool is denied; only the exact quoted lookup GETs to this agent's configured port pass while 17 escape shapes are denied (send route, compound, `-X POST`, `-o`, variable port, `..` traversal, `bash -c`, `node -e`, a direct checkpoint read, the reviewer's five unquoted/half-quoted `&` shapes, another server's port, `/./`, `%2e`); a quoted `&` inside the query is literal and allowed; with no readable agent config no lookup is allowed; an unreadable markers directory never denies; a torn or mismatched marker is offered to the boot sweep and released, while a marker that merely cannot be READ is kept; malformed marker ⇒ deny; stale marker ⇒ deny while the record is open or missing, allow once terminal; marker read from `INSTAR_AGENT_HOME` even when `CLAUDE_PROJECT_DIR` is a worktree; decisions logged per fold (0600); runs under an ESM host; writer refuses unsafe ids and writes 0600.
- `tests/unit/standdown-guard-hook.test.ts` (anti-drift): the canonical wildcard set is now the four guards; the `*` matcher is created once and idempotent.
- `tests/integration/fold-marker-guard-settings.test.ts` (3): an existing agent's `migrateSettings` adds exactly one blocking `*` entry (idempotent, operator hook kept); `migrateHooks` replaces a stale hook copy; the installed hook, invoked through the migrated settings command, denies a write for a session the real writer marked and allows it after the fold carrier releases the marker.
- `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10):** "Concern raised." BLOCKING: (1) the URL's quotes were independently optional and the query class allowed `&`, so `curl http://localhost:4040/topic/search?q=a&env` (and `&&printenv`, `&ls`, `?&PATH=x&claude`, a half-quoted URL) passed and ran an argument-less command after the lookup. MINOR: (2) any marker read error other than ENOENT/ENOTDIR denied, so an unreadable markers directory would deny every Instar session; (3) the port was not bound to this agent; (4) a torn or mismatched marker was invisible to release and the boot sweep, leaving its session blocked; (5) worktree / confined-spawn sessions may not resolve the hook or the agent home; (6) artifact inaccuracies (allowed shape, cost, rollback note) and the fold-marker method orphaning the stand-down doc comment; (7) the decisions log has no reader or cleanup.

**Resolution:**
1. Fixed: the URL must carry both quotes and contains no expanding/escaping character; every reviewer string plus a wrong port, `/./` and `%2e` are now denied in the hook test (15 tests).
2. Fixed: deny only for a marker whose existence an `lstat` proves; an unreadable directory allows (test with the directory at mode 000).
3. Fixed: the port must equal this agent's configured port (test with port 4321 allowed and 4040 denied).
4. Fixed: marker files are keyed by FILENAME; an unattributable (torn or content/filename-mismatched) marker is offered to the boot sweep under `TORN_MARKER_KEY` and released loudly (test).
5. Tracked above (Phase 2 spawns), as for the stand-down guard.
6. Fixed: shape, fail direction and cost restated; the method now sits above the stand-down doc comment; the rollback note's exit-code claim was confirmed by the reviewer.
7. Tracked above.

**Reviewer re-check (same reviewer, after the fixes):** "Concur with the review." 30 hostile command shapes against the revised matcher, none passed; marker read, filename-keyed removal, embedding position and tsc confirmed. Six new MINOR notes, resolved in this commit unless stated: (1) a transient read error classed a valid marker as torn and the `_torn` release would delete it — now a read error is skipped and only a read-but-unparseable or mismatched marker is torn (test); (2) an unreadable config fell back to port 4040 — now no lookup is allowed without a known port (test); (3) Evidence counts and Summary item 2 updated; (4) the mode-000 directory test cannot prove the branch under root — noted, the read-error test skips itself under root for the same reason; (5) a redundant `markerPresent` assignment removed; (6) `/topic/search/.` is accepted (curl normalises it to the same lookup route, harmless) — the wording above says `/./` precisely.
