---
review-convergence: internal-conformance-pass-2026-05-23
approved: true
eli16-overview: docs/specs/codex-enforcement-hook-layer.eli16.md
---

# Spec: Codex Enforcement-Hook Layer

**Status:** CONVERGED (internal conformance pass §11) + APPROVED (Justin, direction + 3 decisions, 2026-05-23 ~21:16 PDT). Cross-model `/crossreview` recommended as a pre-merge (P6) gate for the PermissionRequest autonomy-safety logic.
**Author:** echo · **Date:** 2026-05-23
**Project:** `codex-harness-followups` Tier 2 (item `codex-harness-followups-2`)
**Source finding:** `D-hooks-codex-ZERO` (Codex live-test harness)

---

## 1. Problem

instar's safety gates — the external-operation gate, the response-review/coherence pipeline, grounding-before-messaging, the deferral detector, session-start identity injection — are **structurally enforced on Claude Code** via `.claude/settings.json` hooks (PreToolUse, Stop, SessionStart, UserPromptSubmit) that call scripts in `.instar/hooks/instar/`. Those scripts POST to the local instar server's framework-agnostic gate endpoints (`/operations/evaluate`, `/review/evaluate`, `/coherence/check`) and can **block** an action (exit code 2).

On **Codex agents, none of this is wired**. The gates are described in the agent's instructions (awareness — fixed in the v1.2.52 parity batch) but **nothing enforces them at runtime**. A Codex agent can take a destructive external operation, or emit a response that violates coherence/tone, with zero structural interception. This is the single biggest remaining framework-parity gap: Claude agents run with layered structural safety; Codex agents run with **structural zero**.

This violates instar's foundational principle — **Structure > Willpower**. On Codex, the gates currently rely entirely on the agent "remembering" to honor them. That is exactly the wish-not-guarantee failure the principle exists to prevent.

## 2. Verified Background (Codex CLI hook capabilities)

Verified against `developers.openai.com/codex/hooks` (2026-05-23) — **not assumed**:

- Codex CLI supports lifecycle hooks: `SessionStart`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop` (10 events).
- Hooks **can block**, Claude-compatibly: a `PreToolUse` hook returns `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}`, **or** uses **exit code 2 + stderr**. `UserPromptSubmit` can return `decision: "block"`.
- Config discovery: `hooks.json` **or** inline `[hooks]` tables in `config.toml`, at `~/.codex/` (global) or `<repo>/.codex/` (per-project). Enabled by default; disableable via `[features]`.

**Implication:** Codex's hook contract is intentionally Claude-compatible. The existing instar gate scripts (designed for Claude's exit-code-2 / JSON-decision contract) can be reused with minimal adaptation. The gap is **wiring**, not capability.

## 3. Current-state gap (verified against source)

- `installClaudeSettings()` writes `.claude/settings.json` hooks and is called only on the Claude init/refresh path (`refreshHooksAndSettings()`). **There is no `installCodexHooks()` equivalent.**
- The Codex scaffolder (`providerScaffolder.ts`) creates `.agent/openai/hooks.json` **initialized empty (`{ "hooks": [] }`)** and never populates it.
- `hookEventReceiver.ts` (`OpenAiCodexHookEventReceiver`) is an in-process event-bus stub; its `CODEX_EVENTS` lists only **5** events and under-counts the real 10 (missing `PermissionRequest`, `SubagentStart/Stop`, `Pre/PostCompact`). Nothing routes from Codex's on-disk hook system to instar's gate scripts.
- The server-side gates (`/operations/evaluate`, `/review/evaluate`, `/coherence/check`) **are framework-agnostic and already work** — they are simply never *called* on Codex because no hook invokes them.

## 4. Design

**Core move:** add a Codex hook-installer that mirrors `installClaudeSettings()`, registering instar's gate scripts into the Codex agent's per-project hook config, mapped to the equivalent Codex events.

### 4.1 Event mapping (Claude → Codex)

| instar gate | Claude event | Codex event | Block mechanism |
|---|---|---|---|
| external-operation-gate | PreToolUse | `PreToolUse` | `permissionDecision: deny` / exit 2 |
| response-review (coherence/tone) | Stop | `Stop` | exit 2 + stderr |
| grounding-before-messaging | PreToolUse | `PreToolUse` | exit 2 |
| session-start identity injection | SessionStart | `SessionStart` | (non-blocking inject) |
| telegram-topic-context | UserPromptSubmit | `UserPromptSubmit` | (context inject) |
| deferral / scope checkpoint | Stop | `Stop` | signal (no hard block) |

`PermissionRequest` (Codex-only) is wired in v1 (Justin's call). **Autonomy-preservation is a hard constraint:** Codex runs in bypass-permissions mode (`--dangerously-bypass-approvals-and-sandbox`) for full autonomy. The PermissionRequest hook must route the event to instar's **trust system** and auto-decide (allow/deny) with **NO human prompt** — it applies instar's gate, it never reintroduces a "waiting for operator approval" stall. Decision policy: trusted service/operation → auto-allow; untrusted/destructive → deny (or route to the existing show-plan path which, in autonomous mode, resolves via policy not a human block). **Design check during build:** confirm whether PermissionRequest even fires under bypass mode; if bypass suppresses it, the gating falls back to PreToolUse and PermissionRequest becomes a no-op we still register defensively. Either way: zero human-blocking prompts on the autonomous path.

### 4.1b Verified Codex hooks.json schema (from developers.openai.com/codex/hooks)

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "<script>", "timeout": 600 } ] }
    ],
    "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "<script>" } ] } ]
  }
}
```

- Top level is `{"hooks": {EventName: [ {matcher, hooks:[{type:'command', command, timeout?, statusMessage?}]} ]}}` — essentially Claude's settings.json hook shape (so the writer is a near-mirror of `installClaudeSettings`).
- `matcher`: regex (`"*"`/`""`/omit = all).
- Invocation: event JSON on **stdin** (`session_id`, `cwd`, `hook_event_name`, `turn_id`, ...), cwd = session cwd, **no args**. Block via **exit 2 + stderr** or the `permissionDecision: "deny"` JSON. This matches the existing gate scripts' Claude contract; the framework shim (P2) only bridges field-name deltas (`hook_event_name` etc.).
- TOML equivalent (`[[hooks.PreToolUse]]` + `[[hooks.PreToolUse.hooks]]`) also supported; we write `hooks.json` (easier to diff/migrate).

### 4.2 Hook config writer

- New `installCodexHooks(agentDir, opts)` writes `<repo>/.codex/hooks.json` (preferred — explicit file, easier to diff/migrate than inline TOML) registering the gate scripts to the mapped events.
- Hook command points at the **same** `.instar/hooks/instar/*` scripts (they're framework-neutral: they read stdin JSON, POST to the local server, exit 2 to block). Adaptation layer normalizes Codex's event-payload JSON shape to what the scripts expect (the contract is already close; a thin shim or a `--framework codex` flag on the scripts handles any delta).
- Called from the Codex init/refresh path alongside `renderNonClaudeIdentityShadows()`.

### 4.2c VERIFIED: Codex hook payload is Claude-identical (P2 re-scope)

Verified per-event input fields (developers.openai.com/codex/hooks, 2026-05-23):
- **PreToolUse / PermissionRequest:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`, `tool_name`, `tool_use_id`, `tool_input` (Bash/apply_patch → `tool_input.command`), `permission_mode`. PermissionRequest adds optional `tool_input.description`.
- **Stop:** `stop_hook_active`, `last_assistant_message` (+ common).
- **UserPromptSubmit:** `prompt` (+ common).

These are the **same field names Claude Code uses**. So the gate scripts' stdin parsing (`tool_name`, `tool_input`, `tool_input.command`, etc.) works on Codex **as-is** — P2 is NOT a payload-translation layer. The remaining deltas are small:
1. **`$CLAUDE_PROJECT_DIR` → `cwd` fallback:** any script that internally relies on the `CLAUDE_PROJECT_DIR` env var must fall back to the payload's `cwd` (Codex sets `cwd` in the JSON, not that env var). Audit each gate script for `CLAUDE_PROJECT_DIR` usage.
2. **PermissionRequest output:** confirm exit-2 blocks, or emit the `permissionDecision: "deny"` JSON for that event.
3. **`turn_id`** is a harmless Codex extension (ignore).

This materially shrinks P2 from "translation shim" to "small path-resolution fallback + PermissionRequest output check."

**FURTHER VERIFIED (audit of the gate-script sources in PostUpdateMigrator):** the scripts ALREADY carry the path fallback. Bash gate scripts use `${CLAUDE_PROJECT_DIR:-.}/.instar` and the JS gates use `process.env.CLAUDE_PROJECT_DIR || process.cwd()` (or `|| '.'`). Because Codex runs each hook with `cwd` = the project dir, the `:-.`/`process.cwd()` fallbacks resolve **correctly** when `CLAUDE_PROJECT_DIR` is unset. So no script edit is required for path resolution. **P2 collapses to verification, not modification:**
- (a) Confirm `PermissionRequest` honors exit-2 to block (the doc says hooks block via exit-2 + stderr OR `permissionDecision: deny`); if exit-2 alone is insufficient for PermissionRequest, add a tiny per-event emit of the `permissionDecision` JSON.
- (b) An integration test piping a Codex-shaped PreToolUse payload (CLAUDE_PROJECT_DIR unset, cwd=projectDir) into `external-operation-gate.js` → asserts correct allow/deny via the server gate.
- (c) The live codey block-test (P5) is the ultimate proof.
This means the enforcement layer is substantially closer than the spec originally assumed — the gates are near-framework-agnostic already; P1 supplied the missing registration, and P2 is mostly proving the scripts run correctly under Codex.

### 4.2d CORRECTION (deeper gate-source audit — P2 has real work after all)

The "collapses to pure verification" claim above is **too optimistic** and is corrected here (intellectual honesty over a tidy story). Two real gaps found auditing the actual gate sources:

1. **Arg-reading scripts break under Codex (stdin-only).** `dangerous-command-guard.sh` and `grounding-before-messaging.sh` read their input from a command-line **arg** (`INPUT="$1"`); Claude invokes them as `... dangerous-command-guard.sh "$TOOL_INPUT"`. **Codex passes NO args — it delivers JSON on stdin.** So under Codex these scripts receive an empty `$1` and gate nothing. **Real P2 work:** shim them to fall back to reading `tool_input.command` from stdin JSON when no arg is present (`INPUT="${1:-$(extract from stdin)}"`). (The stdin-reading JS gates like `external-operation-gate.js` are unaffected — verified §4.2c.)

2. **P1 mapping gap — shell-safety gate missing from Codex.** `external-operation-gate.js` only gates `mcp__*` tools (exits 0 for everything else). Codex's destructive class is native `shell`/`exec`/`apply_patch`, NOT `mcp__*`. Claude gates those via `dangerous-command-guard.sh` on the `Bash` matcher — but `installCodexHooks` (P1) mapped only `external-operation-gate` + `grounding` to PreToolUse, **omitting `dangerous-command-guard`**. As wired, Codex shell commands would pass ungated. **P2 fix:** add `dangerous-command-guard.sh` to the Codex PreToolUse mapping (with the stdin shim from #1), so shell/exec/apply_patch get the dangerous-command check.

**Corrected P2 scope:** (a) stdin-shim `dangerous-command-guard.sh` + `grounding-before-messaging.sh`; (b) add `dangerous-command-guard` to `buildInstarCodexHookGroups` PreToolUse; (c) confirm PermissionRequest exit-2 block; (d) integration test with a Codex shell-command payload proving a destructive command is blocked. This is the careful-verification payoff: as-wired, the layer would have looked installed but NOT gated Codex's main destructive surface — exactly the false-sense-of-safety the live E2E (P5) exists to catch.

### 4.3 Script I/O reconciliation

The gate scripts currently assume Claude's hook stdin/stdout/exit contract. Codex's is Claude-compatible but not identical (event names, `hookSpecificOutput` shape). Two options:
- **(A) Shim per framework** inside each script: detect framework from an env var the installer sets, branch the input parse + decision-emit. Keeps one script per gate.
- **(B) Codex-specific wrapper scripts** that translate Codex payload ⇄ the existing Claude script. More files, cleaner separation.

Recommendation: **(A)** — single source of truth per gate, framework-branch at the I/O edges only. Aligns with "single-funnel" patterns already in the codebase.

## 5. Signal vs Authority

This change is **wiring**, not new authority. The server-side gates remain the sole blocking authority (full-context LLM/policy decisions). The Codex hooks are brittle low-context *triggers* that merely route the event to the authority — exactly the signal-vs-authority separation instar mandates. Hooks never decide; they ask `/operations/evaluate` etc. and relay the verdict.

## 6. Migration Parity (NON-NEGOTIABLE)

- **New Codex agents:** get hooks via `installCodexHooks()` in the init path.
- **Existing Codex agents:** a `migrateCodexHooks()` in `PostUpdateMigrator` — idempotent, writes/updates `.codex/hooks.json` for codex-cli agents on every update (always-overwrite for instar-owned hook entries; never touches user-added Codex hooks). Without this, deployed Codex agents stay unenforced — a broken feature.
- **`hookEventReceiver` reconciliation:** expand `CODEX_EVENTS` to the verified 10 (or the subset instar uses) so the abstraction doesn't under-report.

## 7. Testing (all three tiers — NON-NEGOTIABLE)

- **Unit:** `installCodexHooks()` writes the correct `.codex/hooks.json` for each gate→event mapping; `migrateCodexHooks()` is idempotent and preserves user hooks; the script framework-shim parses a Codex `PreToolUse` payload and emits a correct deny.
- **Integration:** a Codex-shaped `PreToolUse` payload through the real gate script → `/operations/evaluate` → correct allow/deny relayed in Codex's expected JSON shape; `Stop` → `/review/evaluate`.
- **E2E (the critical one):** on a live Codex agent (codey or a throwaway), trigger a gated action and **observe the hook actually blocks it** — reproduce "destructive op denied," "incoherent response held." This is the "feature is actually alive on Codex" test. Must show a real block, not a mock.

## 8. Side-effects & risks

- **Over-block:** a mis-mapped hook could block legitimate Codex actions. Mitigation: the gates already default to allow on ambiguity; the E2E both-sides test covers allow + deny.
- **Codex version drift:** if a Codex CLI version changes the hook contract, the shim breaks. Mitigation: a canary/drift test asserting the live Codex payload shape (per state-detection-robustness discipline), and `[features]` detection so we degrade gracefully if hooks are disabled.
- **Double-enforcement:** ensure a Claude-only script path never runs on Codex and vice-versa (framework env var gates it).
- **Rollback:** removing the instar hook entries from `.codex/hooks.json` is a clean revert; no data migration.

## 9. Decisions (resolved by Justin, 2026-05-23 21:16 PDT)

1. **Scope of v1:** ✅ **All gates in one pass** (not a two-gate first cut).
2. **`PermissionRequest` auto-resolve:** ✅ **Yes, wire it in v1** — with the hard constraint that it must NOT hobble autonomy. Codex stays in bypass-permissions mode; the checkpoint applies instar's trust logic and auto-decides with no human prompt. See §4.1.
3. **E2E block test target:** ✅ **codey** (the live sandbox), not a throwaway agent.

## 10. Phase Plan (build tracking)

Branch `echo/codex-enforcement-hooks` off main v1.2.53. Atomic commit per phase; 3-tier tests where applicable; each behavioral commit carries an instar-dev side-effects artifact + trace.

- [x] **P1 — Codex hook config writer.** ✅ DONE (commits fb25d285 writer+6 unit tests, 54085e83 wiring into refreshHooksAndSettings + 3 wiring-integrity tests). `installCodexHooks(agentProjectDir, opts)` writes **`<agentProjectDir>/.codex/hooks.json`** mapping instar gate scripts → Codex events (PreToolUse, Stop, SessionStart, UserPromptSubmit, PermissionRequest). Wire into the Codex init/refresh path next to `renderNonClaudeIdentityShadows()`. Unit tests for the mapping + file shape.
  - **VERIFIED SCOPING DECISION (correctness-critical):** use the **per-project** `<agentProjectDir>/.codex/hooks.json`, NOT the global `~/.codex/hooks.json`. instar's existing Codex convention writes MCP config to `$CODEX_HOME || ~/.codex` (ThreadlineBootstrap.ts:474) — but that root is SHARED with the operator's personal desktop Codex app and every other Codex project on the machine. Global enforcement hooks would intercept Justin's personal Codex sessions — unacceptable. Per-project `.codex/` is a documented Codex discovery path and scopes the gates to exactly this agent's project dir. If instar sets a per-agent `CODEX_HOME`, honor it; otherwise per-project is the isolation boundary.
  - **OPEN before coding:** (a) exact `hooks.json` *registration entry* schema (event→command mapping) — the doc gave the blocking-OUTPUT shape (`permissionDecision: deny` / exit-2) but the registration entry shape still needs confirming from developers.openai.com/codex/hooks; (b) live-verify on codey that codex-cli actually discovers + fires `<projectDir>/.codex/hooks.json` (codey currently has neither `.codex/` nor `.agent/openai/` populated, and the only running codex procs are the desktop app/VSCode ext — a real codex-cli session must be exercised).
- [x] **P2 — Gate-script framework shim.** ✅ CORE DONE (commit dce9e780): stdin shim for dangerous-command-guard.sh (both copies) + grounding-before-messaging.sh; dangerous-command-guard added to the Codex PreToolUse mapping. Integration test PROVES `rm -rf /` blocks (exit 2) via Codex stdin, benign passes, Claude regression holds, garbage-safe. 9 unit + 5 integration green. (Remaining sub-item: PermissionRequest exit-2 vs permissionDecision confirmation → folded into P4.) Branch the I/O edges of `external-operation-gate.js`, `response-review.js`, `session-start.sh`, `telegram-topic-context.sh` on a framework env var the installer sets, so they parse Codex's event payload and emit Codex's deny shape (`permissionDecision: deny`) / exit-2. Unit + integration (Codex payload → server gate → correct verdict).
- [x] **P3 — Migration parity.** ✅ DONE (commit 5048b630): `PostUpdateMigrator.migrateHooks()` calls `installCodexHooks` gated on codex-cli, so existing Codex agents get `.codex/hooks.json` on update (installCodexHooks otherwise ran only via init). Idempotent, preserves user hooks, claude-only unaffected. 3 migration tests green. (`hookEventReceiver` CODEX_EVENTS expansion 5→full set: minor, deferred to a follow-up — tracked here, not orphaned.) `migrateCodexHooks()` in `PostUpdateMigrator` — idempotent, always-overwrite instar-owned entries, never touch user-added Codex hooks. Expand `hookEventReceiver` `CODEX_EVENTS` to the verified set. Migration tests.
- [ ] **P4 — PermissionRequest trust integration (autonomy-preserving).** Route PermissionRequest → trust system, auto-decide, **zero human prompts**. Verify whether it fires under bypass mode; defensive no-op register if not. Unit + integration.
- [~] **P5 — Live codey E2E (the alive test).**
  - **P5a ✅ PROVEN LIVE (2026-05-24):** rebased onto v1.2.56 (0 conflicts, 17 tests green), built, deployed dist→codey shadow-install, forced migration via `instar migrate --dir <codey>` (boot migration version-gate-skipped a same-version deploy — server.js:1928 reads state/last-migrated-version.json; a real v1.2.57 release bump triggers it in prod). Result on the LIVE codey agent: `.codex/hooks.json` registered (PreToolUse[dangerous-command-guard + external-operation-gate + grounding] + PermissionRequest/Stop/SessionStart/UserPromptSubmit, abs paths); the deployed dangerous-command-guard.sh got the stdin shim; **fed it `rm -rf /` via Codex stdin → BLOCKED (exit 2)**, benign `ls` → exit 0. So on a real Codex agent the guard installs AND blocks. (Unrelated pre-existing migrate error: free-text-guard.sh template missing from shadow-install dist — not this work.)
  - **P5b REMAINING (browser-heavy):** drive codey via Playwright Telegram (test-as-self) so CODEX'S ENGINE fires the registered hook on a real tool call (vs feeding the script directly) — closes the residual "does codex actually invoke it" risk. "Justin + codey" group -1003947546311.
    - **TELEGRAM SETUP DONE 2026-05-24 14:25 PDT (Option A — persistent browser):** `.mcp.json` playwright args now include `--user-data-dir /Users/justin/.instar/browser-profiles/echo-telegram` (persistent profile created). Justin is restarting Claude Code so Playwright relaunches with the persistent profile.
    - **POST-RESTART STEPS (do these first on resume):** (1) `mcp__playwright__browser_navigate` to https://web.telegram.org ; (2) snapshot → ask Justin to scan the QR with his phone (HIS action — never my credentials); (3) verify login (snapshot shows chat list) — session now persists in the profile for all future test-as-self; (4) open "Justin + codey" group, send codey a message inducing a blocked-pattern shell command "for a safety test", watch CODEX block it (P5b proof); (5) then P6.
- [ ] **P6 — Awareness + release.** AGENTS.md briefing (Agent Awareness) + Codex-hook-disable canary + /crossreview (PermissionRequest autonomy-safety) + NEXT.md + full suite green + PR→release (v1.2.57). HARD CONSTRAINT: P5b + crossreview before merge/publish.
  - **NOTE: autonomous-state.local.md was removed (autonomous mode ended/reset 2026-05-24); this committed spec §10 + the branch are the durable resume record. codey is currently in a test-deployed state (v1.2.56 + these hooks).**

**Restart-resume:** this spec + the branch commits + `.instar/autonomous-state.local.md` are the durable record. On a fresh session, read this Phase Plan, check which boxes are committed on `echo/codex-enforcement-hooks`, continue from the first unchecked phase.

## 11. Convergence (internal conformance pass — 2026-05-23)

Reviewed against instar's standards + recorded lessons (manual lessons-grep per the no-circular-self-approval discipline). Conformance:

- **Structure > Willpower:** ✅ core intent — replaces awareness-only gating with structural enforcement on Codex.
- **No-manual-work:** ✅ `installCodexHooks` at init + `migrateCodexHooks` on update; zero manual steps.
- **Signal vs Authority:** ✅ §5 — hooks are low-context triggers that route to the server-side authority gates; hooks never decide.
- **Migration Parity:** ✅ §6 — existing Codex agents covered via PostUpdateMigrator (idempotent, always-overwrite instar-owned, preserve user hooks).
- **3-tier testing:** ✅ §7 incl. the live-codey "is it actually alive/blocking" E2E.

**Findings folded into the build (strengthenings, not direction changes — Justin's approval stands):**
1. **Wiring-integrity test (→ P1):** add a test proving the Codex init/refresh path actually *invokes* `installCodexHooks` — not just that the function works in isolation (lesson: PR #334 shipped dead code with a false "wired" claim). The isolated unit test alone is insufficient.
2. **Codex-briefing awareness (→ P6):** reflect the enforcement layer + trust-status surface in the OpenAI-engine briefing (AGENTS.md template), consistent with the v1.2.52 shadow-capability parity guard — so the Codex briefing stays complete.
3. **Near-silence (→ P4):** PermissionRequest auto-decides and gate blocks must be logged, NOT messaged to the user (no notification spam); only genuinely action-required events reach chat.
4. **Codex-hook-disable canary (→ P4/P8):** a canary/drift check that verifies hooks are enabled + the live Codex payload shape matches expectation (state-detection-robustness: deterministic + canary + e2e), degrading gracefully (and surfacing a degradation) if Codex `[features]` disables hooks or the contract drifts.

**Recommended pre-merge (P6) rigor:** a cross-model `/crossreview` of the PermissionRequest autonomy-safety logic specifically — external reviewers catch concurrency/precision failure modes Claude-internal review misses ([[feedback_external_crossmodel_catches_what_internal_misses]]). Internal convergence + Justin's approval suffices to proceed through P1-P5; the cross-model pass gates the final merge.
