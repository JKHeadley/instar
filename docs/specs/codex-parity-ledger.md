# Codex ↔ Claude Code — Full Parity Ledger

**Goal:** full feature + UX parity between the Claude Code and Codex engines in
Instar, with each Codex-applicable capability **proven in the wild via
test-as-self on codey** (`/Users/justin/Documents/Projects/instar-codey`,
server :4044). Claude-only capabilities are listed with the reason they don't
port. This file is the durable scoreboard — it outlives any single session.

**Status legend:**
- ✅ **PROVEN** — works on Codex AND verified live on codey (test-as-self).
- 🟡 **WORKS-UNPROVEN** — built/wired for Codex; not yet driven on codey.
- 🔴 **BROKEN/GAP** — Codex-applicable but missing or not working.
- ⚪ **N/A** — Claude-only; no Codex equivalent (reason given).
- ❓ **UNAUDITED** — not yet assessed.

_Started 2026-05-24 (echo). Method: test-as-self (drive codey as user+dev)._

---

## 0. Foundation / blockers (must clear before test-as-self can run)

| Item | Status | Note |
|---|---|---|
| **echo** running latest instar | ✅ | 2026-05-24: was running stale v1.2.58 in-memory (patch releases don't auto-restart — only major/minor do). SIGTERM'd the server PID; supervisor respawned on v1.2.70. status:ok. **Root-cause gap logged: long-running agents drift behind on patches → Tier 0 item 1.** |
| codey has a working real codex-cli (≥0.133) on PATH | 🔴 ROOT CAUSE FOUND | **PROVEN 2026-05-24: `detectCodexPath()` returns NULL.** `detectFrameworkBinary('codex')` only checks `~/.codex/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, npm-global, nvm, then PATH — but the host's codex 0.133 lives ONLY at `~/.asdf/shims/codex` (asdf-managed), and the launchd PATH excludes asdf shims. So instar literally cannot find codex → codey can't spawn Codex sessions → test-as-self blocked. **Cross-cutting portability bug (every asdf user).** Fix = (a) immediate: set codey config `frameworkBinaryPaths['codex-cli']` to the asdf shim (gate-free); (b) durable code fix: add `~/.asdf/shims/<name>` + `asdf which <name>` to `detectFrameworkBinary` (ships under master-spec approval). <!-- tracked: codex-full-parity --> |
| codey server healthy + on latest | ✅ | 2026-05-24: restarted codey server (SIGTERM→supervisor respawn), now on v1.2.70 (was running stale 1.2.66). Healthy bar one benign git-sync conflict-handling degradation (not codex-related). |
| codey codex binaryPath wired (immediate unblock) | ✅ | 2026-05-24: set codey config `frameworkBinaryPaths['codex-cli'] = ~/.asdf/shims/codex` (gate-free config fix) + restarted. SessionManager resolves binaryPath from this field (was throwing "No binary path available" — both it and claudePath were unset). |
| **PROVING RIG ALIVE — live codex session on codey** | ✅ PROVEN 2026-05-24 | Ran `codex exec` (0.133, gpt-5.2, read-only) in codey's dir via the configured binary → launched end-to-end, replied "PARITY-RIG-LIVE", clean exit. **AND the instar hooks fired live: `SessionStart`, `UserPromptSubmit`, `Stop` all ran + Completed during the real codex session.** Foundation proven; Tier 0 essentially complete. (PreToolUse fires on a tool call — proven separately in P5c with the rm -rf block.) |
| Telegram test-as-self access (Playwright persistent profile) | ✅ | Persistent profile at `~/.instar/browser-profiles/echo-telegram`; logged into Justin's Telegram incl. "Justin + codey" group -1003947546311. |

## 1. Enforcement / safety hooks

| Capability | Status | Evidence / gap |
|---|---|---|
| dangerous-command-guard fires + blocks on Codex | ✅ | v1.2.66; live on codey — real codex 0.133 blocked `rm -rf /` (PreToolUse). |
| Guards run unprompted (no trust-prompt freeze) | ✅ | v1.2.67; `--dangerously-bypass-hook-trust`, guard still fired with no trust granted. |
| external-operation-gate (mcp__*) on PreToolUse | 🟡 mostly-OK | Trusted (pre_tool_use:0:1) so it fires. Reads `input.tool_name` + `startsWith('mcp__')`. Rollout logs confirm Codex names real MCP tools `mcp__<server>__...` (e.g. `mcp__playwright__`) → gate DOES match those. **Two gaps:** (a) Codex's NATIVE plugin tools are NOT mcp-prefixed (`browser_*`, `apply_patch`, `write_stdin`) so external browser ops pass ungated (Codex's own sandbox/approval normally covers these); (b) possible empty-action edge if tool_name is bare `mcp__playwright__` (service-extract → action='' → pass-through at line 27). Confirm with a live mcp write. |
| grounding-before-messaging on PreToolUse | ✅ Codex-aware (by inspection) 2026-05-25 | Trusted (pre_tool_use:0:2) so it fires. **Payload handling is correct for Codex**: reads `tool_input.command OR tool_input.cmd` (lines 17-25, explicit Codex comment) → matches messaging commands (telegram-reply etc.) regardless of tool_name → `exit 2` to block for grounding. Unlike deferral-detector, this one was made Codex-aware. Live trigger (drive codey to message ungrounded → see block) still worth a confirming run. |
| **response-review on Stop** | 🟡 CODE OK, blocked on trust 2026-05-25 | Payload question RESOLVED: the codex 0.133 Rust binary's embedded Stop-input schema includes `last_assistant_message` + `hook_event_name` + `stop_hook_active` — the EXACT fields response-review.js:45 reads. So the code is already Codex-correct, no payload fix needed. The only blockers were (a) it's `enabled=false` in trust state and (b) the trust-activation gap (P0). Same applies to claim-intercept-response (now correctly on the Stop trio, also reads last_assistant_message). Once P0 arms/enables it, it works. |
| **deferral-detector on Stop** | 🔴 DEAD (wrong event + Claude-only payload) 2026-05-25 | **Doubly broken.** (1) It is a *PreToolUse* hook (header: "PreToolUse hook for Bash commands"); its code requires `tool_name==='Bash'` + `tool_input.command`. Wired into **Stop** (installCodexHooks.ts:96) where there is no tool call → exits 0, does nothing. (2) Even on PreToolUse it'd miss Codex's `exec_command`/`tool_input.cmd` shape. PROVEN via live payload replay: Codex Stop payload → no output; Codex exec_command payload → no output; Claude Bash payload → full checklist. **Root cause: the Codex Stop trio wrongly substitutes deferral-detector for claim-intercept-response (see §2).** |
| **scope-coherence-checkpoint on Stop** | 🔴 NOT RUNNING 2026-05-25 | config.toml has **NO** `hooks.state[...:stop:0:2]` entry → untrusted → Codex skips it (added v1.2.70, after the trust flow ran). Plus payload-shape correctness unverified. |
| **Codex hook auto-arming (P0)** | ✅ PROVEN END-TO-END 2026-05-25 (no human) | armCodexHooks (codexHookArm.ts) + makeTmuxTrustDriver LIVE-PROVEN on a throwaway scratch agent: reset to dark (allArmed:false) → armCodexHooks drove Codex's trust flow (two-prompt state machine: dir-trust Enter + hook-trust Down/Enter, NO bypass flags) → `armed` (all 10 hooks trusted in config.toml, zero human clicks) → `codex exec "rm -rf / --no-preserve-root"` → **"ERROR Command blocked by PreToolUse hook: BLOCKED: Catastrophic command detected: rm -rf /"**. The exact "arm a fresh agent, run a disk-wipe, watch it blocked with no clicks" acceptance. Readback bug found+fixed via the proof (canonicalize project path — codex keys trust by realpath /private/tmp not /tmp). Idempotent (already-armed → no re-spawn). 15 unit tests. Scratch agent + ~/.codex restored clean after. |
| **Codex hook TRUST/ENABLEMENT mechanism** | 🔴→✅ (see auto-arming row above) 2026-05-25 | **The biggest finding.** Codex 0.133 runs ONLY hooks whose hash matches a `trusted_hash` in `~/.codex/config.toml [hooks.state]`. instar writes **NO** trusted_hash/hooks.state entries (grep: none). So hook activation depends entirely on Codex's **interactive** trust prompt — which an autonomous agent can't click. PROVEN: project-trusted probe dir with untrusted hooks → hooks did NOT fire even with `--dangerously-bypass-hook-trust`; modifying codey's (trusted) hooks.json invalidated the hashes → all hooks skipped despite the flag. So `--dangerously-bypass-hook-trust` does NOT auto-run untrusted hooks in headless `codex exec` (contradicts the v1.2.67 assumption — the guards that DO fire on codey fire because their hashes are already trusted in config.toml from a prior interactive trust action, NOT because of the flag). trusted_hash is not a plain sha256 of cmd/script/json (6 attempts failed) → can't trivially compute. **P0 CLEAN PATH FOUND 2026-05-25:** the codex 0.133 binary has a MANAGED-CONFIG layer (`LegacyManagedConfigTomlFromFile/FromMdm`, `ManagedHooksRequirementsToml`, `MdmManagedPreferences`, `SystemRequirementsToml`, `--include-managed-config`, config note "Overridden by legacy managed_config.toml"; hook sources include `mdm`/`legacy_managed_config_file` vs `project`). Managed hooks are policy-installed → auto-trusted + agent-can't-disable (the "managed hooks" ideal — no trust prompt, no enabled=false escape). If instar installs its gates as a managed-config requirement, BOTH the trust gap AND the enabled=false problem vanish structurally. Open for the cross-review: exact managed_config.toml path + ManagedHooksRequirementsToml format, and whether it can be scoped per-agent vs forced machine-wide (ties to Justin's per-agent decision). Guaranteed fallback if managed-config can't be per-agent-scoped: automate the interactive trust-all keystrokes at install (PROVEN to work). Hash-crack ruled out. **Implication: a freshly-initialized Codex agent has ALL gates dead until a human trusts them. This is the #1 autonomy-parity gap and the spine of the master spec.** (Open: does the flag work in INTERACTIVE mode? codey's main sessions are interactive; reply/spawn workers use headless `codex exec`.) **INDEPENDENTLY CORROBORATED 2026-05-25 (browser):** Codex's OWN hooks-status table (seen live in codey's interactive session via the dashboard) reads — Stop: **Installed 3, Active 1, Review 1** (only 1 of the 3 Stop hooks active!), PreToolUse 3/3 active, SessionStart/UserPromptSubmit/PostCompact/PermissionRequest 1/1 active — plus a persistent **"⚠ 1 hook needs review before it can run · Press t to trust all"** banner. Codex's own UI confirms the exact Stop-layer breakage AND the manual-trust requirement. Screenshots: codey-codex-stuck-on-hook-trust-prompt.png, codey-codex-hooks-status-table.png. |
| session-start identity injection (SessionStart) | ✅ PROVEN 2026-05-25 | Drove real `codex exec` (gpt-5.2) on codey asking "who are you?". `hook: SessionStart`/`Completed` fired AND injection did its job — codey answered "I'm Instar-codey, powered by GPT-5.2 in the Codex CLI, working in /Users/justin/Documents/Projects/instar-codey". Identity context genuinely reaches the model. (session 019e5d93) |
| telegram-topic-context on UserPromptSubmit | 🟡 | Fires live on codex 0.133 (`hook: UserPromptSubmit`/`Completed` seen same run 2026-05-25); no-op'd correctly for a non-telegram prompt. Full ✅ needs a telegram-origin prompt to confirm it injects topic context. |
| PermissionRequest → trust auto-decide (no human prompt) | 🟡 moot-under-bypass | P4 verdict: instar launches Codex with `--dangerously-bypass-approvals-and-sandbox`, which auto-approves — so PermissionRequest has nothing to gate and PreToolUse (dangerous-command-guard etc.) is the real enforcement point. Hook is trusted (permission_request:0:0) but effectively idle in autonomous mode. NOT a gap — by design. The real exposure is the trust-activation gap (above), not PermissionRequest. |
| Hook-contract drift canary | ✅ | v1.2.70; CI invariant lock + binary-schema probe. (CI-proven, not a codey runtime feature.) |
| Migration parity (existing Codex agents get hooks on update) | 🟡 | Wired (migrateHooks→installCodexHooks); proven via migration tests; live re-deploy to codey pending. |

## 2. Claude hooks NOT yet on Codex (from per-hook audit)

**Canonical Claude wiring (src/templates/hooks/settings-template.json), for parity reference:**
- **PreToolUse**: dangerous-command-guard, grounding-before-messaging, **deferral-detector**, slopcheck-guard, external-communication-guard, external-operation-gate, free-text-guard
- **Stop**: response-review, **claim-intercept-response**, scope-coherence-checkpoint

**Codex Stop-trio is WRONG**: installCodexHooks.ts wires Stop = response-review, **deferral-detector**, scope-coherence — i.e. it dropped `claim-intercept-response` and wrongly inserted `deferral-detector` (a PreToolUse hook). The canary (codexHookContractCanary.ts:140) ASSERTS this wrong trio → it locks the bug in as "correct" (classic test-encodes-the-bug). Fix: Codex Stop = response-review + claim-intercept-response + scope-coherence; move deferral-detector to Codex PreToolUse.

| Claude hook | Verdict | Plan |
|---|---|---|
| deferral-detector (anti-deferral) | 🔴 MISPLACED | Belongs on PreToolUse (it is on Claude). Currently wrongly on Codex Stop where it no-ops. Move to Codex PreToolUse AND make Codex-aware (exec_command + cmd). |
| claim-intercept-response (anti-confabulation) | 🔴 MISSING from Codex Stop | Claude has it on Stop; Codex Stop wrongly has deferral-detector instead. Wire on Codex Stop + verify Stop-payload shape. |
| slopcheck-guard (install legitimacy) | 🔴 candidate | Wire on Codex PreToolUse (exec_command surface). |
| external-communication-guard (identity grounding) | 🔴 verify→candidate | Confirm stdin-based + not Claude-tool-specific, then wire on Codex PreToolUse. |
| subagent-start-tracker (observability) | 🟡 low-pri | Codex HAS SubagentStart event. |
| free-text-guard (AskUserQuestion) | ⚪ N/A | Codex has no AskUserQuestion tool. |
| skill-usage-telemetry (Skill tool) | ⚪ N/A | Codex has no Skill tool. |
| instructions-loaded-tracker | ⚪ N/A | InstructionsLoaded not in Codex's 8-event set. |

## 3. Compaction / context lifecycle

| Capability | Status | Evidence / gap |
|---|---|---|
| Identity survives compaction | 🔴 GAP | Claude: SessionStart(source=compact). Codex: PostCompact has NO additionalContext (verified 0.133) → can't re-inject. Needs redesign (UserPromptSubmit-ride, or systemMessage investigation). |

## 4. Messaging / UX

| Capability | Status | Evidence / gap |
|---|---|---|
| Telegram spawn uses configured framework (not hardcoded Claude) | ✅ | v1.2.46; confirmed on codey. |
| Telegram reply relay from Codex sessions | ❓ | Audit: does codey relay conversational replies the same way? |
| Codex Threadline reply (agent-to-agent) | ✅ | v1.2.58 (per memory); shared config collision + headless MCP fixed, live-verified. |
| Tool/toolkit briefing parity (key-drop, commitment-tracker, publishing, attention-queue) | ✅ | Fixed + build guard fails if a tool is missing from the OpenAI briefing. |
| Safety-gate awareness in AGENTS.md | 🟡 | Shared capability sections mirror CLAUDE.md→AGENTS.md (structural). Codex-specific "guards run unprompted" note pending. |

## 4b. Dashboard / UI parity (Justin-requested 2026-05-24)

The dashboard must work correctly for a Codex agent, not just a Claude one.
Each item proven by loading codey's dashboard (via tunnel) and driving the UI.

| Capability | Status | Evidence / gap |
|---|---|---|
| Dashboard tunnel link works + UI loads for a Codex agent | ✅ PROVEN (browser) 2026-05-25 | Opened `https://codey.dawn-tunnel.dev/dashboard` via Playwright, PIN-auth succeeded, "Connected". All 15 tabs render (Sessions 2, Files, Send Content, Secrets, Jobs 27, Features, Health, Integrated-Being, PR Pipeline, Projects, Initiatives, Commitments, Tokens, Threadline, Evidence). Screenshot: codey-dashboard-model-badge-gap.png. |
| Sessions tab shows the CORRECT model for a Codex session | 🔴 GAP CONFIRMED + ROOT-CAUSED 2026-05-25 | codey's `/sessions` reports `model: "haiku"` / `"sonnet"` for its sessions — **Claude tier aliases on a Codex-only agent** (codey: `enabledFrameworks:["codex-cli"]`, `claudePath: undefined` → cannot run Claude; jobs DID run, on Codex). Root cause: `resolveModelForFramework('codex-cli', tier)` maps haiku→gpt-5.2 / sonnet→gpt-5.4-mini / opus→gpt-5.5 at LAUNCH (frameworkSessionLaunch.ts:64-66), but `SessionManager.ts:821,927` records `model: options.model` = the raw tier alias, NOT the resolved Codex model. So the dashboard badge shows the Claude alias. **Fix (master spec): record the framework-resolved model on the session (and/or carry a `framework` field) so Codex sessions show gpt-5.x.** Exactly the gap Justin flagged. **VISUALLY CONFIRMED 2026-05-25 (browser):** codey's dashboard Sessions sidebar shows badges `haiku` + `opus` for its sessions — yet codey is Codex-only and Codex's OWN TUI (same session) shows `gpt-5.5 medium`. So the engine is right; only instar's session-record label is wrong. Screenshots: codey-dashboard-model-badge-gap.png. |
| Dashboard session input → reaches the live Codex session | ✅ PROVEN LIVE (browser) 2026-05-25 | Drove codey's interactive Codex session (`instar-codey-dashboard`) THROUGH the dashboard UI: clicked the dashboard's Esc key-button → the live Codex TUI navigated (hook-detail → hooks-summary → closed → back to its `gpt-5.5` prompt) — **three observable state changes from dashboard input**. Full round-trip confirmed. Path: `POST /sessions/:name/input` → `sessionManager.sendInput()` → tmux send-keys (routes.ts:3779-3801, zero framework branching). Used only non-destructive Esc (never toggled trust); left codey's session clean. |
| Real-time terminal streaming of Codex sessions | ✅ PROVEN LIVE (browser) 2026-05-25 | The dashboard rendered codey's live Codex TUI in real time (saw the hooks-review overlay, the model line `gpt-5.5 medium`, the input box) — streaming works identically to Claude. |
| Other dashboard tabs render correctly for Codex (Files, Secrets, Threadline, etc.) | 🟡 server-side, likely-OK | Files/Secrets/Threadline tabs are server-rendered HTTP (framework-agnostic; corresponding APIs live 200 on codey). Browser sweep recommended to confirm rendering. |

_Maps to Project Tier 4 (messaging/UX) + Tier 5 (full-surface audit)._

## 5. Models / engine selection

| Capability | Status | Evidence / gap |
|---|---|---|
| Codex model tiers (gpt-5.2 light / 5.4-mini medium / 5.5 heavy) | ✅ | Established empirically; token-count optimization axis. |
| Node version selection refuses sqlite-incompatible versions | ✅ | Fixed (node-candidate constraints). |
| Memory not rebuilt on every restart (health-check fix) | ✅ | Fixed cross-agent. |

## 6. Full-surface audit (Tier 5 — classified 2026-05-25)

**Architectural principle:** most instar capabilities live in the shared Node
**server** process, not in the agent's framework (Claude/Codex) session — so they
are framework-AGNOSTIC and behave identically on Codex. Verified live on codey
(:4044) by HTTP probe (all 200 unless noted). Framework-DEPENDENT items (those that
inject into / spawn the agent session) are called out separately.

| Capability | Status | Evidence |
|---|---|---|
| TokenLedger (token observability) | ✅ PROVEN on Codex | `/tokens/summary` returns a populated `codex` block (163M tokens, 1189 sessions, usage %). `scanCodexRolloutsAsync` + `codex_token_sessions` table; server wires `codexProjectDir: process.cwd()` (AgentServer.ts:646). Real data flowing. |
| Scheduler / jobs | ✅ WORKS | 27 jobs registered (`/jobs`); a real job (`dashboard-link-refresh`) ran to `completed` on codey (Codex-only) — so jobs spawn + execute on Codex. (Caveat: session.model label = the dashboard tier-alias gap, §4b.) |
| Coherence / org-intent gate | ✅ WORKS (server-side) | `/coherence/check` (POST) 200, `/intent/org` 200. Evaluation is server-side; enforcement on the agent rides the external-operation-gate PreToolUse hook (fires on Codex, §1). |
| Private views | ✅ WORKS (server-side) | `/views` 200 — HTTP render, framework-agnostic. |
| Tunnel | ✅ WORKS (server-side) | `/tunnel` 200 — Cloudflare lifecycle in the server. |
| Trust / operations log | ✅ WORKS (server-side) | `/trust`, `/operations/log` 200. |
| Attention queue | ✅ WORKS (server-side) | `/attention` 200. |
| Commitments / PromiseBeacon | ✅ WORKS (server-side) | `/commitments` 200. |
| Secret drop | ✅ WORKS (server-side) | `/secrets/pending` 200 — one-time form + retrieval are server-side; submission notify rides Telegram (agnostic). |
| Publishing (Telegraph) | ✅ WORKS (server-side) | `/published` 200. |
| Project map | ✅ WORKS (server-side) | `/project-map` 200. |
| Autonomous-sessions API | ✅ WORKS (server-side) | `/autonomous/sessions` 200 (echo is running its own autonomous job on Claude; codey endpoint live). |
| Sentinels (presence/watchdog/delivery-failure) | 🟡 works-by-architecture | Server-side monitors over tmux sessions + Telegram relay; not framework-specific. Not independently driven on a Codex session this round. |
| Playbook context injection | 🟡 rides SessionStart | Assembly is server-side; injection into the agent rides the SessionStart hook — which is ✅ PROVEN to inject on Codex (§1). Not separately driven. |
| Backup / git-sync | 🟡 works-by-architecture | Server-side git ops; codey reported one benign git-sync conflict-handling degradation (not Codex-related). |
| Feedback system | ⚪ N/A for echo | Per memory: feedback home-base is Dawn's external infra; not an Echo-builds path. For other agents it's server-side (agnostic). |
| Evolution / dispatches | 🟡 works-by-architecture | Server-side registries; `/capabilities` 200. |
| Compaction recovery (PostCompact) | 🔴 GAP | Already logged §3: Codex PostCompact has no additionalContext channel → identity can't re-inject. Needs redesign. |

---

## Working notes
- Faithful test-as-self = drive codey via Telegram (Playwright) as the user. Where the browser is fragile, a direct interactive `codex` run in codey's dir (real 0.133, PTY) proves engine-firing; the local agent channel is the least-faithful fallback.
- Durable record: this ledger + the per-feature specs + the Project goal. On restart, read this file first.
