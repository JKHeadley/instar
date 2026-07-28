# Side-Effects Review — Subagent permission allow-rules (the "session paused" fix)

**Version / slug:** `subagent-permission-allow-rules`
**Date:** `2026-06-24`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `general-purpose reviewer subagent (Phase 5 — touches permission allow/deny surface)`

## Summary of the change

Adds `PostUpdateMigrator.ensurePermissionAllowRules()` and wires it into `migrateSettings()` so every agent's `.claude/settings.json` gains a `permissions.allow` list for the built-in tools a Task/Agent-spawned sub-agent uses (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Task`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`). Root cause: a sub-agent does NOT inherit the parent session's `--dangerously-skip-permissions` MODE — only the permission RULES from settings.json. With no allow-rules, a sub-agent's first Bash call surfaces the interactive approval dialog and an unattended autonomous session freezes on it forever (the "session paused" bug; reproduced on this agent and AI Guy). Files: `src/core/PostUpdateMigrator.ts` (new method + one call site in `migrateSettings`), `tests/unit/PostUpdateMigrator-permissionAllowRules.test.ts` (6 tests).

## Decision-point inventory

- `migrateSettings() → ensurePermissionAllowRules()` — **add** — populates `permissions.allow` for subagent tools, set-if-missing per tool name; idempotent; never touches `deny`/`ask`.
- The interactive permission PROMPT for sub-agent local-tool calls — **remove** (only the human-in-the-loop prompt; the programmatic PreToolUse guards are untouched).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No new block surface — this change only ADDS allow-rules, it never adds a deny. It cannot reject anything that worked before; the worst case direction is "allows too much," covered under §2. Over-block not applicable.

---

## 2. Under-block

**What failure modes does this still miss / does it allow too much?**

The allow-rules skip the interactive prompt for the listed local tools, so a human is no longer asked before a sub-agent runs e.g. an arbitrary Bash command. This is intentional and acceptable because the real safety is the PreToolUse guard chain (`dangerous-command-guard.sh`, `external-operation-gate.js`, `external-communication-guard.js`, `self-stop-guard.js`) which runs on EVERY tool call regardless of allow-rules — the prompt was duplicative friction, not the protective layer. Deliberately NOT covered: MCP tools (`mcp__*`) are left out of the allow list so external/network operations keep their external-operation-gate plan/approval posture. A sub-agent calling an MCP tool could still prompt — but MCP calls are not the wedge this fixes, and broadening to MCP would weaken the external-op gate's intended approval step.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `permissions.allow` in settings.json is the exact Claude Code mechanism that sub-agents inherit (per docs), so the fix lives at the layer that actually controls the behavior. The alternative — the `PermissionRequest` auto-approve hook — sits at a layer that does not reliably reach sub-agent calls, which is why it failed. Putting the rule in `migrateSettings()` (rather than only `init`) is the correct layer for Migration Parity: it reaches both new agents (init → refreshHooksAndSettings → migrateSettings) and the existing fleet (update → migrateSettings) through one code path, mirroring the established `cleanupPeriodDays` migration.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface that adds brittle blocking authority. It REMOVES a human-in-the-loop prompt while leaving every existing smart/programmatic gate (the PreToolUse guards) fully in force.

This change adds zero new decision authority. It does not inspect command content, classify, or gate — it declares static allow-rules so the existing PreToolUse authorities are the sole deciders. There is no brittle detector holding block power here.

---

## 5. Interactions

- **Shadowing:** none. Allow-rules and the PreToolUse hooks are orthogonal — an allow-rule skips the prompt; the hooks still fire and can still block (exit 2 / deny). The allow-rule cannot shadow a guard.
- **Double-fire:** the `PermissionRequest` auto-approve hook (`ensurePermissionAutoApprove`) remains in place as defense-in-depth. With allow-rules present, the prompt typically never arises, so the hook is a redundant backstop, not a conflicting one — both pushing toward "allow" is harmless.
- **Races:** none. `migrateSettings()` is a synchronous, idempotent file patch run at init/update; it shares no runtime state with live sessions. The new rules take effect only on the next session start (settings load once at spawn).
- **Feedback loops:** none.

---

## 6. External surfaces

- Other agents on the machine: unaffected at runtime — this only changes a file each agent reads at its own session start.
- Install base: every existing agent gains the allow-rules on its next update; new agents at init. This is the intended fleet-wide fix.
- External systems: none. No Telegram/Slack/GitHub/Cloudflare surface changes.
- Persistent state: writes `permissions.allow` into each agent's local `.claude/settings.json`. Idempotent, additive, reversible.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action added or changed — this is internal config plumbing. Not applicable.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — this change touches no dashboard renderer, approval page, or grant/revoke/secret-drop form. Not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** `.claude/settings.json` is a per-machine file that Claude Code reads from local disk at session start; the permission rules must exist on whichever machine actually spawns the session. There is no cross-machine state to replicate — each machine's `PostUpdateMigrator` runs the same idempotent migration locally on its own update/init, so the fleet converges to identical allow-rules without any replication path. It emits no user-facing notices (no one-voice concern), holds no durable cross-topic state (nothing strands on topic transfer), and generates no URLs.

---

## 8. Rollback cost

Pure additive config migration. Back-out: revert the code change and ship as the next patch — new/updated agents simply stop gaining the allow-rules. Already-migrated agents keep a `permissions.allow` block in their settings.json; it is harmless (it only ever skipped a prompt the operator didn't want in an unattended run) and an operator can delete it by hand if desired. No data migration, no agent-state repair, no user-visible regression during the rollback window.

---

## Conclusion

The review produced no design changes. The fix is minimal, additive, idempotent, and scoped to the exact mechanism (inherited permission rules) that controls sub-agent prompting. It preserves all real safety (the PreToolUse guard chain) and only removes the human-in-the-loop prompt that was freezing unattended autonomous runs. Clear to ship pending second-pass concurrence.

---

## Second-pass review (if required)

**Reviewer:** general-purpose reviewer subagent
**Independent read of the artifact: concur**

Concur with the review. The reviewer independently verified, against Claude Code docs, that PreToolUse hooks run BEFORE permission-rule evaluation and a hook exiting 2 blocks the call even when the tool is in `permissions.allow` — the docs describe exactly this pattern (Bash in allow + a PreToolUse guard) as the recommended architecture, so the safety argument holds. Key corroboration: the SAME `migrateSettings()` pass calls `ensureInstarBashPreToolUseHooks()` (which registers the full `INSTAR_BASH_PRETOOLUSE_HOOKS` guard chain) BEFORE `ensurePermissionAllowRules()`, so any agent that gains the allow-rules gains the blocking guards in the same migration — no race, no window where allow-rules exist without the guards. Idempotency, non-clobbering of operator deny/ask, mcp__* exclusion, and the absence of any shared-array mutation were all confirmed. Non-blocking note: the allow list is a fixed in-code array; a future new built-in subagent tool won't be covered until the list is updated — benign failure direction (it would prompt, not over-allow).

---

## Evidence pointers

- `tests/unit/PostUpdateMigrator-permissionAllowRules.test.ts` — 6 tests: adds all subagent tools when absent; includes Bash; does NOT blanket-allow MCP; preserves operator allow entries + no dupes; never touches deny/ask; idempotent on second pass. All passing.
- Adjacent regression: `tests/unit/PostUpdateMigrator-cleanupPeriodDays.test.ts` still green (same `migrateSettings` path).
- `npm run build` green on the worktree.
