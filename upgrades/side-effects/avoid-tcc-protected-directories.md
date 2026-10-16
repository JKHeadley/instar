# Side-Effects Review — Avoid TCC-Protected Directories (the ~/Documents mandate)

**Version / slug:** `avoid-tcc-protected-directories`
**Date:** `2026-10-15`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (a new guard + a creation-time refusal) — response appended below`

## Summary of the change

Operator mandate (Justin, 2026-10-14): "the Documents folder on Mac is AVOIDED AT ALL COSTS." The incident: macOS TCC withdrew `~/Documents` access from the single tmux server every agent server on the laptop runs under; two agents whose project directories lived under `~/Documents/Projects` died in the same second on EPERM writing their own state files, and a third survived only because it had been moved out the day before.

The change makes that a constitutional standard enforced in code: (1) a new article in `docs/STANDARDS-REGISTRY.md`; (2) `src/core/TccProtectedPathGuard.ts` — pure classification of a path against the four macOS TCC-protected user folders (Documents, Desktop, Downloads, iCloud Drive) with symlink resolution on the longest existing prefix, the creation-time refusal, a boot-time detector that raises ONE deduped HIGH attention item (JSONL fallback without Telegram), and the `/guards` runtime getter; (3) `instar init` refuses a protected target on all three init paths before writing anything; (4) the server runs the detection once at boot, prints one loud line, registers the always-on `monitoring.tccProtectedPathGuard` manifest row; (5) `instar doctor` gains a "Project location" check; (6) `PostUpdateMigrator.migrateTccProtectedPath` re-surfaces the condition in the migration summary on every update until the agent is moved, and the CLAUDE.md awareness section reaches new (template) and existing (migrator) agents; (7) `docs/runbooks/move-agent-out-of-documents.md` documents the operator-proven move.

Files: `src/core/TccProtectedPathGuard.ts` (new), `src/commands/init.ts`, `src/commands/server.ts`, `src/commands/machine.ts`, `src/monitoring/guardManifest.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`, `docs/STANDARDS-REGISTRY.md` (+ regenerated hierarchy block and asset), `docs/runbooks/move-agent-out-of-documents.md`, tests in all three tiers.

## Decision-point inventory

- `refuseIfTccProtected` (init.ts) / `assertNotTccProtected` (guard) — **add** — the ONE blocking decision: refuse to create an agent under a protected folder on macOS. Deterministic, closed input (path containment under four fixed folders), no override.
- `runTccProtectedPathDetection` (boot) — **add** — signal-only: classify, log, raise one attention item. Never blocks the boot, never moves.
- `migrateTccProtectedPath` — **add** — signal-only: one line in the migration summary. Never blocks the update.
- `instar doctor` "Project location" — **add** — a report line; the doctor's existing `fail` exit code applies (it already exits 1 on any fail).
- Platform gate inside `classifyTccProtectedPath` — **add** — `platform !== 'darwin'` ⇒ never protected. The honesty floor for Linux.

---

## 1. Over-block

- **A legitimate agent placed under ~/Documents on purpose** (e.g. an operator who wants the folder synced by Finder) is refused at creation with no override. This is the deliberate choice: the mandate is "at all costs", a brand-new agent has nothing to move, and the sync use-case is exactly the TCC-protected class that fails. The refusal text names the safe alternatives and the runbook.
- **Desktop / Downloads / iCloud Drive** are refused alongside Documents. Justified in the standard: Apple governs the three "protected folders" by one consent class (one grant, one withdrawal), and iCloud Drive carries that class plus cloud eviction. An operator who disagrees has the standard's text to amend; the code deliberately does not carry a per-zone switch.
- **A path whose longest existing prefix resolves into a protected folder** is refused even if the final target does not exist yet — correct for `instar init <name>` run from inside ~/Documents.
- **Re-init of an EXISTING agent inside a protected folder** (`instar init --dir <existing agent>`) is refused too, because `initExistingProject` is the same path. Stated deliberately: the "nothing to move" justification does not apply there, but re-init is not how an existing agent is repaired or updated (the migrator and server boot do that, and neither is blocked), and the operator's wording is "at all costs". The refusal text points at the runbook; after the move, re-init works.
- **`instar init --standalone`** is also gated (on the computed `~/.instar/agents/<name>` path). It can only trip if `~/.instar` itself is inside a protected folder (e.g. HOME redirected into iCloud Drive) — refusing there is right, since every agent would share the fate.
- No over-block on Linux/Windows: the platform gate short-circuits before any zone comparison.

---

## 2. Under-block

- **Paths the guard is not told about.** The boot detector classifies the project and state directories (+ any `extraPaths` a caller passes). A vault, database or log an operator has pointed elsewhere by hand (a custom `logsDir`, a Playwright profile dir under ~/Downloads) is not checked unless passed in. Named honestly in the standard's "Honest scope". The standard's rule still covers them; the guard's reach is what it is.
- **The tmux server's own cwd / the instar install dir** are not checked. The incident's failure vector was the agent's state writes, which are covered; a tmux server launched from ~/Documents but with agents outside it keeps working (the grant matters at the file access, not at the server's cwd).
- **Removable and network volumes** are TCC-gated too and are not enumerated — out of scope by design (an unmount is a different failure).
- **An agent moved INTO a protected folder after boot** is caught at the next boot, not live. Acceptable: the condition is placement, not traffic; the next boot (and the next update) re-surface it.
- **Existing agents are not moved.** By constraint: nothing in this task may move or delete a directory. They are told, repeatedly, with the runbook.

---

## 3. Level-of-abstraction fit

Right layers. Refusal belongs at creation (`instar init`), the one moment the path is still a free choice — the same layer the worktree convention refuses at. Detection belongs at server boot, where every other posture check runs and the attention sink is available; the `/guards` row is the steady-state read. The migrator is the only path by which an existing agent learns anything on update. A lower layer (SafeFsExecutor refusing writes under ~/Documents) would turn a placement mistake into a live outage; a higher layer (a scheduled sweep) would add a cadence for something that only changes at placement time. The classification itself lives in one module so init, boot, doctor and the migrator cannot drift on which folders count.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — one block/allow decision (refuse at creation), and it is the carve-out case: a deterministic safety guard on a closed, enumerable input (path containment under four fixed, platform-specific folders), brittle BY DESIGN in the safe direction. No LLM, no heuristic over prose, no competing signals. The refusal cannot produce a false "protected" verdict on a non-macOS platform (platform gate first) and cannot be fooled by a symlink in either direction (realpath on the longest existing prefix).
- Everything at runtime (boot detector, guards row, attention item, doctor line, migration line) is a signal with zero blocking authority. The boot never fails on the guard; every internal error is captured into the result and surfaces as `verdictUnknown` on the row.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point. The only decision is a containment test; signals do not compete. The one design judgment (absolute vs overridable refusal) was made by the operator's wording and is recorded in the standard, the ELI16 and the module header — not re-decided at runtime.

---

## 5. Interactions

- **Worktree convention / AgentWorktreeDetector:** complementary, not overlapping. The worktree detector flags worktrees outside agent homes; this guard flags agent homes inside protected folders. Both run at boot beside each other; both aggregate to one item; different ids and source keys (`tcc-protected-path-guard` vs `agent-worktree-detector`), so the per-source flood budget sees two sources.
- **Attention store semantics (second-pass finding #2):** the boot sink is `upsertAttentionItem` (hub-only), NOT `createAttentionItem`. `create` dedupes on id for the lifetime of the store, including a RESOLVED row — so an operator who resolved the item without moving the agent would never hear from the attention layer again, and nothing would close the item after the move. The upsert reopens a resolved row when the finding is still present and is silent while the row is OPEN and unchanged (no re-post per boot, no flood); when the finding set is EMPTY the detector resolves the category's OPEN items (`updateAttentionStatus(..., 'DONE', { silent: true })`), so the item closes itself after the move. Single-alerts-topic routing keeps it in the Attention hub. JSONL fallback (no Telegram) dedupes for 24h.
- **Bounded sink (second-pass findings #6/#7):** the emit is raced against `emitTimeoutMs` (default 10 s) so a hung Telegram API cannot stall boot; on timeout OR a throwing sink the finding is written to the JSONL fallback for that boot, so it is never recorded nowhere. `createAttentionItem` durably accepts before the network call, so a timeout loses nothing on the Telegram side either.
- **GuardPostureTripwire / GuardPostureProbe:** the new row is `code-default`, always on, so it can never read `off` or `diverged`; the tripwire has nothing to compare and the probe never alerts on it. `loadBearing: true` with `soakWindowDays: 0` means that if the row ever went dark (a future regression deleting the registration) it reads as an immediate Gap — loud, by intent.
- **`instar doctor` exit code:** a protected location is a `fail`, so `instar doctor` exits 1 on such an agent. Intentional (the existing contract: any fail ⇒ exit 1). Scripts that run doctor as a health gate will go red on an agent inside ~/Documents — that is the point.
- **Migration summary (second-pass finding #3):** the finding rides `result.errors`, the migration-warnings channel. The primary UpdateChecker path already appended `Migration warnings:` from it, but the server-boot migration print and the UpdateChecker FALLBACK path showed only `upgraded` — a migration-surfaced condition vanished on those two paths. Both now surface `errors` (a yellow `Migration warnings:` boot line; the fallback summary line). Not marker-gated on purpose (Close the Loop: re-surface until closed) — it stops by itself once the agent is moved.
- **CLAUDE.md delivery-completeness test:** the new section is tracked as a behavioral-awareness section (template + migrator; no framework-shadow marker, like the retained-executable section).
- **Registry lints:** the hierarchy block and asset were regenerated; the back-reference lint required `Governed by:` headers in the three cited command files (added at the top of each, within the lint's 4000-char head window).
- **No races, no double-fire, no feedback loops:** the detector runs once per boot; nothing reads the attention item back.

---

## 6. External surfaces

- **Other agents on the machine:** none touched. The guard inspects only its own agent's directories.
- **Install base:** every macOS agent gets the boot check and the guards row on update; an agent already inside a protected folder sees a HIGH attention item, a red boot line and a migration warning. That is the intended, visible behaviour change. Linux agents see one dim "not applicable" boot line and a green row.
- **`instar init` UX:** a new refusal message on macOS for protected targets. Exit code 1, nothing written.
- **External systems:** none. No network, no GitHub, no new Telegram topic (the item routes to the existing Attention hub).
- **Timing / runtime conditions:** realpath (kernel-native, so the on-disk case is compared — second-pass finding #1) on four folders + two directories at boot — microseconds, no subprocesses. The ONE network wait is the attention upsert when a finding exists, bounded at 10 s with the JSONL fallback on timeout. `os.homedir()` is the only environment dependency (injected in tests).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** A TCC grant is per machine and per process tree; the finding is about THIS machine's disk layout. The guards row rides the existing `GET /guards?scope=pool` merge like every other row (heartbeat-fresh per machine), so the operator sees each machine's posture individually. The attention item is raised on the machine that owns the condition and routes through that machine's Attention hub (single-voice is preserved: one machine, one finding). No durable topic-scoped state is created, so nothing strands on a topic transfer; a topic moved to another machine is simply served from that machine's (separately classified) home. The runbook says explicitly that each machine's copy is moved separately.

---

## 8. Rollback cost

Code revert of the PR. No data migration (the migrator writes only a CLAUDE.md section and a summary line; the JSONL fallback is inert audit data under `<stateDir>/audit/`). The registry article, hierarchy block and asset revert with the code. No agent-state repair. There is deliberately no config switch: a safety floor that can be flipped off persists the exact risk it exists to remove (the operator's "at all costs"); if a future ruling wants a switch, that is a one-line manifest + one `if`.

---

## Simplest robust route (Occam's Razor)

The simplest route that meets the mandate's three verbs (refuse, detect, document) is: one pure classification function reused by every surface, a refusal at the one creation chokepoint, one boot-time read registered on the existing guards inventory, and the existing attention/migrator/doctor channels for surfacing. That is what shipped. Cut on purpose: a config switch, a per-zone allowlist, a live file-watcher, an auto-mover, a new route — each would add machinery for a failure the simpler route already prevents.

---

## Evidence pointers

- Incident data as given by the operator (2026-10-14 16:00:05 PDT): 28,382 denials in 22 min (Python 24,207 / git 2,872 / claude 906 / node 239); two agents dead in the same second on EPERM; recovery ~16:14; ai-guy survived because moved 2026-10-13.
- Tests: `tests/unit/tcc-protected-path-guard.test.ts` (35, incl. the case-insensitive-FS, bounded-sink, throwing-sink and auto-resolve cases from the second pass), `tests/unit/init-tcc-protected-path-refusal.test.ts` (6), `tests/unit/PostUpdateMigrator-tccProtectedPath.test.ts` (6), `tests/integration/tcc-protected-path-guards-route.test.ts` (6), `tests/e2e/tcc-protected-path-lifecycle.test.ts` (4); neighbouring suites (guards route/e2e/load-bearing, manifest lint, delivery-completeness, registry parser/asset/conformance) green; `npm run lint` chain green.

---

## Class-Closure Declaration (display-only mirror)

Not an agent-authored-artifact defect — not applicable. The defect class is "agent state placed where the OS can withdraw access from the whole process tree"; this closes the class at creation (refusal) and makes the remaining instances visible at every boot and update until each is moved. Convergence: the finding set per machine can only shrink (moves) and the detector raises nothing once it is empty.

---

## Second-pass review (independent reviewer subagent, 2026-10-15 12:35 PDT)

Audited the artifact against the code and tests; ran the guard unit file; edited nothing. Eight findings, dispositions:

1. **Case-insensitive APFS bypass** (`realpathSync` echoes the caller's case, so `~/documents/x` slipped past both the refusal and the detector) — **FIXED**: `realpathSync.native` (kernel on-disk case) + a unit case guarded by a runtime case-insensitivity probe.
2. **Attention dedupe spanned boots and swallowed a resolve** (`createAttentionItem` returns a RESOLVED row unchanged; nothing closed the item after a move; the runbook's "resolves itself" was false) — **FIXED**: the boot sink is `upsertAttentionItem` (reopens a resolved row, silent while OPEN + unchanged); an empty finding set resolves the category's OPEN items via `updateAttentionStatus`; unit tests for both directions; runbook corrected.
3. **Migration warning not surfaced** on the server-boot print and the UpdateChecker fallback path — **FIXED**: both now print/append `Migration warnings:` from `result.errors` (the primary UpdateChecker path already did).
4. **`GET /guards` never carries the finding** (`GuardRuntimeStatus` has no detail field; the row says the check ran, not what it found) — **ACCEPTED, docs corrected**: the runbook's done-criteria now name the boot line + `instar doctor` + the attention state, and say the row is on-confirmed in both states. Extending the row type is outside this change.
5. **Re-init of an existing agent inside a protected folder is refused** (the "nothing to move" justification does not hold there) — **ACCEPTED, stated in §1** with the reasoning (re-init is not the repair/update path; the mandate is "at all costs").
6. **Unbounded Telegram await at boot** — **FIXED**: `emitTimeoutMs` (default 10 s) race + JSONL fallback on timeout.
7. **Throwing sink left the finding recorded nowhere for that boot** — **FIXED**: the JSONL fallback is written on a sink error too; `result.error` still set so the row reads `verdictUnknown`.
8. **Test count in the evidence line** — fixed (now 35).

Reviewer's verdict on the first pass: "Concern raised: the artifact claims the finding re-surfaces on every boot (attention item) and every update (migration summary), but `createAttentionItem` dedupes on id across boots including after an operator resolve and neither production migration caller surfaces `result.errors`; additionally `realpathOfLongestExistingPrefix` lets a differently-cased `~/documents/...` path bypass both the refusal and the detector on case-insensitive APFS." Every item in that concern is closed by fixes 1–3 above; a re-review of the fixes is recorded below.

**Re-review (same reviewer, 2026-10-15 12:43 PDT).** Verified (a) the upsert's `unchanged` check prevents a per-boot re-post while OPEN, (b) auto-resolve is category-filtered and the category string has one producer, (c) the timeout race clears its timer and counts `emitted` once, (d) the only new writes are the attention status flip, the store save and the JSONL append — the shared Attention hub topic is never closed (hub items are not in `attentionItemToTopic`), (e) runbook, artifact and standard now match the code. Two minor notes — a sink error replaced the path-naming boot line and blinded the row although the classification succeeded, and a timeout was invisible on the line — both fixed after the re-review: a separate `emitError` field keeps the finding line (with a `[attention sink failed/timed out → JSONL]` suffix) and `verdictUnknown` is reserved for a failed classification; tests updated accordingly.

**Concur with the review.**
