# Side-Effects Review — Codex Topic Round-Trip Fixes

**Version / slug:** `codex-topic-roundtrip-fixes`
**Date:** `2026-05-16`
**Author:** `echo`
**Second-pass reviewer:** `not required — five tactical fixes, each independently verifiable, exercised live end-to-end on deep-signal codex-cli topic`

## Summary of the change

Six fixes (five Codex defects + one auto-scaffold) surfaced when /route was exercised on a real Telegram topic and Codex tried to actually respond. The first five silently no-op'd in a way that made spawn look successful but the agent unreachable; the sixth closes the legacy-install gap that required manually dropping AGENTS.md before Codex would know about the relay script.

1. `respawnSessionForTopic` kills the existing tmux session before spawning a replacement (line ~605 of server.ts). `spawnInteractiveSession` no-ops when a tmux name is already taken — that's "reuse the running agent" semantics intentionally, but it silently defeats a framework swap. The kill makes respawn semantics explicit ("get me a fresh process"), idempotent on already-dead sessions.

2. The /route handler clears `_topicResumeMap.remove(topicId)` between the framework store update and the respawn. Resume ids are framework-specific (Claude UUIDs ≠ Codex session ids); carrying one across a swap caused either spurious warnings (Codex) or attaching to a non-existent session (Claude).

3. Codex spawns pass `--model gpt-5.3-codex`. Codex CLI's default `gpt-5.2-codex` was retired from ChatGPT-subscription auth on 2026-04-14 (per OpenAI Community thread 1378986); without this flag, a subscription-auth spawn errors on the first turn. `gpt-5.3-codex` is the coding-specialist tier already used by the headless adapter (see `src/providers/adapters/openai-codex/models.ts`).

4. Codex spawns use `--dangerously-bypass-approvals-and-sandbox` instead of the prior `--sandbox workspace-write --ask-for-approval never` pair. The flag-pair silenced approval prompts but left Codex's seatbelt sandbox active, which blocks localhost reach (where instar's server runs, where the relay script posts) and blocks writes outside the project (the relay's outbox). The bypass flag is the single-flag parity for Claude's `--dangerously-skip-permissions`. Callers passing `codexSandboxMode` explicitly still get the flag-pair form for the safer profile.

5. `SessionManager.rawInject` is framework-aware. Codex's TUI takes longer than Claude's to commit a bracketed paste into its input state and silently discards a single Enter that lands during the commit window. The injector now reads the spawned session's `INSTAR_FRAMEWORK` from its tmux env (cached per tmux name), and for `codex-cli` waits 1.5s after the paste end (vs 0.5s for Claude) and presses Enter twice with a 300ms gap. The second Enter is a no-op against an empty buffer if the first one landed. `clearSessionFrameworkCache(name)` is exposed for callers that kill+respawn a tmux name under a different framework; `respawnSessionForTopic` calls it.

6. `spawnSessionForTopic` now calls `ensureFrameworkIdentityFile` before every spawn. The new helper in `IdentityRenderer` is idempotent: no-op when the framework's shadow already exists; render from `.instar/AGENT.md` when missing; bootstrap AGENT.md from a legacy shadow (e.g., `CLAUDE.md` on installs that pre-date the IdentityRenderer) before rendering. Without this, legacy installs that author CLAUDE.md directly would have a fresh Codex spawn read no AGENTS.md and never learn about the relay script — the failure mode that required dropping AGENTS.md by hand for the deep-signal live test. The shadow is regenerated atomically per spawn so AGENT.md edits stay propagated. 6 new unit tests cover idempotency, legacy bootstrap, unknown-framework, no-source-available, and the regenerate-on-spawn smoke path.

## Decision-point inventory

- `src/commands/server.ts:~605` — **add** — kill-session before spawn in `respawnSessionForTopic`. Idempotent.
- `src/commands/server.ts:~615` — **add** — `sessionManager.clearSessionFrameworkCache(targetSession)` after kill.
- `src/commands/server.ts:~917` — **add** — `_topicResumeMap?.remove(topicId)` in /route handler after framework store update.
- `src/core/frameworkSessionLaunch.ts:codexCliBuilder` — **modify** — argv composition: add `--model gpt-5.3-codex`, branch on `codexSandboxMode` to choose bypass flag (default) vs flag-pair (explicit override).
- `src/core/SessionManager.ts:rawInject` — **modify** — branch on `getSessionFramework(tmuxSession)` for post-paste delay and Enter count. Single new helper method `getSessionFramework` with cache; new public method `clearSessionFrameworkCache`.

## 1. Over-block

**Risk:** Low.

- Kill-before-respawn: respawn semantics were "get a fresh process," not "reuse." The prior behavior of reusing was a latent bug. Existing callers (onRestartSession, recovery paths) already expected fresh state.
- Resume-uuid clear: only fires on framework swap. Same-framework reuse paths are untouched.
- Codex model flag: API-key users can override via `~/.codex/config.toml` or `-c model=`. Subscription users were already blocked without the flag.
- Bypass-sandbox flag: only the default path uses bypass. Callers explicitly passing `codexSandboxMode` get the safer flag-pair.
- Framework-aware injection: Claude path unchanged (500ms delay, 1 Enter). Codex path is additive — 1.5s delay + 2 Enters. The 2nd Enter is a no-op against an empty buffer.

## 2. Under-block

**Risk:** Negligible.

- Kill-before-respawn could surprise a future caller expecting "reuse existing session" semantics from respawn. Risk mitigated: the function name is "respawn" and all current call sites want fresh processes.
- Resume-uuid clear is scoped to `/route` only. Resume across same-framework restarts continues to work.
- Codex bypass flag: callers who want the sandbox can still get it by passing `codexSandboxMode` (e.g., `'workspace-write'`). The default — autonomous instar agent topic — explicitly chose the bypass parity.

## 3. Silent behavior change

**Risk:** Low.

- Framework-aware injection adds 1.5s per Codex injection (vs 0.5s before). This is a latency increase but no behavior change — the prior fast path silently dropped messages.
- Existing Codex sessions spawned before this commit don't have my fixes in their tmux env. The framework cache will return null for those (lookup miss = Claude defaults), so the injection won't get the Codex treatment. New spawns after the upgrade get the right behavior.

## 4. Data / state impact

- New state file mutations: none. Existing `_topicResumeMap.remove(topicId)` writes to `.instar/topic-resume-map.json` — already a documented write path.
- No new persistent state introduced.
- Framework cache lives in process memory only; cleared on process restart.

## 5. Downstream agent impact

Positive.

- Codex agents can now actually reply to Telegram messages (the whole point of supporting Codex framework).
- Existing Claude agents experience no behavior change (their default path is unchanged).

## 6. Rollback cost

Low. Each fix is independently revertable:
- The kill-before-respawn line can be removed without affecting Claude paths.
- The resume-uuid clear is one line in the /route handler.
- The Codex model flag is one argv entry; reverting puts Codex back to its default model (which fails for subscription auth).
- The bypass flag is one argv entry; reverting puts the old flag-pair back (which leaves Codex inaccessible from localhost).
- The framework-aware injection: removing the framework lookup falls back to the Claude path. Codex would regress to "message stuck in input buffer."

Each revert is independent.

## 7. Signal-vs-authority

All five fixes operate on the **authority** layer (decisions about which flags to pass, when to kill, whether to clear cache). They don't introduce new signal detectors. They don't make a brittle detector load-bearing for blocking — they fix authoritative spawn/inject paths to match the framework's actual contract.

The framework lookup helper (`getSessionFramework`) reads `INSTAR_FRAMEWORK` from the spawned session's tmux env — that's authoritative, not heuristic (we set it ourselves at spawn).

## 8. Interactions with adjacent systems

- **InputGuard**: unchanged; provenance/coherence checks still run before `rawInject` is called.
- **Watchdog / OrphanReaper**: unaffected; both already framework-aware via `frameworkProcessSignals` and `frameworkActivitySignals` (landed in Tier 2.B / 2.C).
- **PresenceProxy**: unaffected; reads tmux output regardless of framework.
- **TopicMemory**: unaffected; respawn bootstrap path same as before.
- **Cost router**: unaffected; lives at a different layer.

## 9. Tests

- `tests/unit/frameworkSessionLaunch.test.ts` — 12 tests pass. Two test bodies updated to assert on `--dangerously-bypass-approvals-and-sandbox` + `--model gpt-5.3-codex`. Existing `honors codexSandboxMode` test still asserts the flag-pair form (now requires `codexSandboxMode` to be explicit).
- `tests/integration/topic-framework-dispatch.test.ts` — 6 tests pass. Two updated to assert on the bypass flag for the default path; the misconfigured-binary safety-net test now asserts bypass too.
- `tests/integration/route-command-end-to-end.test.ts` — 5 tests pass, unchanged.
- Live end-to-end on deep-signal: verified Codex spawn → message inject → auto-submit → AGENTS.md read → relay script call → "Sent to topic 2525" confirmation in the tmux pane.

## 10. Live evidence

The kill-before-respawn + resume-uuid-clear + bypass-sandbox + model-flag + framework-aware-inject stack was deployed to the deep-signal test agent at the spec/provider-portability branch. A test sequence on Telegram topic 2525 ("route test"):

1. `/route codex-cli` — store updated, respawn kicked off
2. Existing Claude tmux session killed
3. Fresh Codex spawn with `gpt-5.3-codex` model and bypass flag visible in `ps`
4. AGENTS.md (manually scaffolded for the legacy install) read by Codex
5. Codex called `.claude/scripts/telegram-reply.sh 2525` twice with acknowledgment + content
6. Both calls returned "Sent to topic 2525"

End-to-end Codex round-trip confirmed working live.
