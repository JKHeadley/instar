# Side-Effects Review — Shared Codex config is written only on request (`instar codex connect <agent>`)

**Version / slug:** `codex-connect-explicit`
**Date:** `2026-10-20`
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** not required (no gate / sentinel / lifecycle surface — see Phase 5 criteria)

## Summary of the change

`ThreadlineBootstrap.registerThreadlineMcp` stops writing `[mcp_servers."threadline"]` into the shared Codex user config (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`). That file is one per user, so the boot-time write was last-writer-wins across every agent on the machine and across the test suite (2026-10-20: `tests/e2e/threadline/identity-discovery-wiring.test.ts` rewrote the operator's real file to a worktree path, a `/var/folders` state dir and `--agent-name no-id-agent`). Instar-launched Codex sessions never needed the shared entry — `frameworkSessionLaunch.ts` pins each agent's own entry per spawn via `-c mcp_servers.threadline.*`. The one case the boot write served (an operator-started Codex) becomes an explicit command, `instar codex connect <agent>` (`src/commands/codex.ts`, registered in `src/cli.ts`), using the same `OpenAiCodexMcpToolRegistry` writer. `tests/vitest-setup.ts` forces `CODEX_HOME` onto a per-process temp dir; `tests/setup/hermetic-home.ts` gives every in-process `bootstrapThreadline` test a temp `HOME`; a guard test enforces both. Agent awareness: `CODEX_CONNECT_CLAUDEMD_SECTION` in `generateClaudeMd`, `migrateClaudeMd` (content-sniffed) and the framework-shadow marker list.

Files: `src/threadline/ThreadlineBootstrap.ts`, `src/commands/codex.ts`, `src/cli.ts`, `src/core/PostUpdateMigrator.ts`, `src/scaffold/templates.ts`, `tests/vitest-setup.ts`, `tests/setup/hermetic-home.ts`, 22 threadline test files (helper call), new tests (unit × 4, integration × 1, e2e × 1), `docs/specs/CODEX-MULTIAGENT-THREADLINE-SPEC.md` (resolution note), `docs/specs/codex-connect-explicit.eli16.md`, `upgrades/next/codex-connect-explicit.md`.

## Decision-point inventory

No decision point is added, modified or removed. The change removes an unconditional filesystem side effect from boot, adds an operator-invoked CLI write, and changes test-environment plumbing. No message, action, dispatch or session is gated, blocked or filtered.

- `ThreadlineBootstrap.registerThreadlineMcp` step 3 — **remove** — unconditional write to the shared Codex config at boot.
- `instar codex connect <agent>` — **add** — explicit write; refuses only on invalid name / no agent home (input validation, not a behavioral gate).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The only refusals are input validation on the new command: a name failing `validateAgentName` (path separators, `..`, NUL) or an agent with no `.instar/` state dir in either the registry-recorded path or `~/.instar/agents/<agent>`. A legitimate agent always has a state dir (it is what the MCP entry points at), so a refusal there means the agent really is not installed here.

Behavioral loss to consider honestly: an operator who relied on "boot once, hand-started Codex just works" now has to run the command once. That is the intended trade (the implicit behavior was the defect), and the agent's CLAUDE.md section makes the command discoverable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Residual leaks the change does NOT close: (a) `bootstrapThreadline` still writes the user-scope `~/.claude.json` at boot — correct in production (one entry per project dir, keyed by path, so multiple agents coexist) and now hermetic in tests via `HOME` isolation, but the guard only covers test files that import `bootstrapThreadline` directly; a test that spawns the real server would write the child's `~/.claude.json` unless it sets `HOME` in the child env (none of the 22 current callers do that without also running in-process). (b) `CODEX_HOME` forcing covers the default path; a test that sets `CODEX_HOME` to the real `~/.codex` on purpose could still write it — nothing in the repo does, and doing so would be an explicit, reviewable act.

---

## 3. Level-of-abstraction fit

Right layer. The per-spawn `-c` override (`frameworkSessionLaunch.ts`) is the correct place for "which agent does THIS Codex session talk as" — it is session-scoped, exactly matching the question's scope. The shared user config is user-scoped, so it can only ever answer "which agent does a Codex with no other instruction talk as" — a one-at-a-time operator preference, which is what an explicit command expresses. The TOML writing stays in the one existing registry module (no second writer). The test-isolation lives in the shared setup file beside the git-env and `INSTAR_*` stripping, which is the established home for "no test may act on the operator's real state".

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The change removes a side effect and adds an operator-invoked write. Nothing holds authority over agent behavior, messages or actions. The guard test is a signal to the developer (a red test naming the offending file), not a runtime authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Agent-home resolution is enumerable (registry path, then convention path, each requiring a `.instar/` dir) and is an invariant of what a connectable agent home is, not a judgment among conflicting live signals.

---

## 5. Interactions

- **Shadowing:** none. Steps 1–2 of `registerThreadlineMcp` (Claude registrations) are unchanged; step 3 is deleted, not reordered. The per-spawn `-c` override is independent of the shared file (Codex gives `-c` precedence), confirmed by the e2e test which connects agent A and builds agent B's launch argv.
- **Double-fire:** none. Previously two writers of the same table existed (boot + the registry used by the command path); now exactly one caller writes it, on request. `connect` is idempotent (remove-then-append).
- **Races:** the boot-time race between agents booting concurrently on one machine is removed with the write. The command is a single synchronous write per invocation; two operators running it at once would still be last-writer-wins, by the nature of the file, and the output says so.
- **Feedback loops:** none. One interaction found by the full suite and fixed: the shared setup file must NOT import `SafeFsExecutor` (or anything under `src/`) — setupFiles run before every test module, so the import cached the real `node:child_process` ahead of the tests' `vi.mock` and silently un-mocked it (GitSync, ProfileCompiler, server-supervisor-preflight went red). The setup's own tmpdir cleanup therefore uses raw `fs.rmSync`, allowlisted by path in `scripts/lint-no-direct-destructive.js` with the reason. Test setup: `CODEX_HOME` is set after the `INSTAR_*` strip and before test files load; the registry unit tests that override `CODEX_HOME` themselves restore the (now temp) prior value in `afterEach`, so ordering is preserved. `useHermeticHome()` swaps `HOME` in `beforeEach`, so `beforeAll` work in the two tests that run `npx tsc` still sees the real `HOME`/npm cache.

---

## 6. External surfaces

- **Other agents on the same machine:** positive — one agent's boot can no longer re-point another agent's hand-started Codex. Instar-launched sessions of every agent: unchanged.
- **Other users of the install base:** a user who hand-starts Codex and relied on the implicit boot write must run `instar codex connect <agent>` once; the CLAUDE.md section (new + migrated) tells their agent to do it for them. No automatic repair of a currently-wrong shared entry is attempted — deliberately: that file is the operator's, and the fix is one explicit command.
- **External systems:** none.
- **Persistent state:** the shared Codex config is now touched only by the command. The operator's current `~/.codex/config.toml` is NOT modified by this change (explicit instruction; also the right default).
- **Timing / runtime conditions:** none introduced.
- **Operator surface (Mobile-Complete Operator Actions):** the new action is a CLI command, but its natural operator surface is conversational — the agent runs it on request ("connect my Codex to you"), which the awareness section instructs. No PIN, no approval, no dashboard form needed: it writes a non-secret config entry the operator could type by hand.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface (no dashboard/approval/grant markup touched) — not applicable. The CLI output leads with the action taken, names the file in plain language, and states the one-agent-at-a-time caveat in a sentence.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The Codex user config is a per-machine, per-OS-user file read by a Codex process on that machine; the MCP entry it holds names a state dir on that machine's disk. Replicating it would be wrong (paths differ per machine; the hand-started Codex is on one machine). The command therefore acts on the machine it runs on and says which file it wrote. No user-facing notices are emitted (no one-voice gating needed), no durable Instar state is created (nothing to strand on topic transfer), no URLs are generated. The removed boot write was likewise machine-local; removing it has no cross-machine effect.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit. Pure code + test change; the boot write would return (with its collision), the command would disappear.
- **Data migration:** none. No persistent Instar state is introduced. Any `config.toml` the command wrote is a valid Codex entry that the old boot write would simply overwrite again.
- **Agent state repair:** the appended CLAUDE.md section would describe a command that no longer exists after a revert; a follow-up migration would need to remove it (content-sniffed, trivial). AGENTS.md shadow likewise.
- **User visibility:** none during rollback; hand-started Codex behavior returns to the implicit boot-write.

---

## Conclusion

The review confirms the change is a strict reduction of implicit side effects plus one explicit, idempotent, operator-invoked write, with the per-spawn override carrying every Instar-launched Codex session exactly as before. Design decisions made during the review: (1) keep `HOME` isolation per-test (not global) because `HOME` steers far more than one file — the guard test makes "per-test" structurally complete for the class of in-process Threadline boots; (2) do not auto-repair the operator's current shared entry — the command is the repair and it is theirs to run; (3) accept the registry-recorded path ahead of the convention path so legacy homes outside `~/.instar/agents` can be connected. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact: n/a**

Phase 5 criteria (messaging block/allow, session lifecycle, compaction/respawn, coherence/idempotency/trust gates, sentinel/guard/gate/watchdog) are not touched. The guard is a test, not a runtime guard.

---

## Evidence pointers

- `tests/unit/codex-connect-command.test.ts`, `tests/unit/threadline-codex-mcp-registration.test.ts`, `tests/unit/test-setup-hermetic-codex-home.test.ts`, `tests/unit/PostUpdateMigrator-codexConnect.test.ts`
- `tests/integration/codex-connect-cli.test.ts`
- `tests/e2e/codex-connect-lifecycle.test.ts`
- `upgrades/next/codex-connect-explicit.md` (release-note fragment)

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect was in TypeScript runtime code (an unconditional shared-file write) and test plumbing, not in a prompt, hook, config, skill or standards text; the change adds no self-triggered controller. The class-level closure for the TEST leak is the guard test `tests/unit/test-setup-hermetic-codex-home.test.ts` (fails on any new in-process Threadline boot without `HOME` isolation, and on `CODEX_HOME` ever pointing back at the real home).
