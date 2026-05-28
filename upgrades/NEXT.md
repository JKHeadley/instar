# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Two related groundwork increments land together:

Self-Propagation, Part 2 v1 — the **`/test-as-self` skill**: a deterministic post-deploy verifier for a throwaway agent home. Reads the Part 1 poll-ownership lease (present / fresh / well-formed / tokenHash-only security check), greps the server log for the Part 1 demote line (proves Part 1 actually fired in the live deploy — not just shipped), and tails the server + lifeline logs for the actual crash signatures (heap-OOM / `CheckIneffectiveMarkCompact` / Abort trap / libc++abi / SIGABRT — the signatures the 2026-05-27 mmtest diagnosis had wrong). Emits a single JSON report; exit 0 = all PASS; 1 = fail or crash detected.

Includes a runbook (`SKILL.md`) for the tight deploy recipe and an explicit list of what v1 does NOT do (auto-mint bot, full Playwright Telegram round-trip, one-button command — those ship in Part 2.1 under the same approved spec). Pairs with Part 1 (the structural poll-ownership lease, shipping in #446).

---

**Agent-to-agent Telegram comms primitive — receiver wiring lands.** The TelegramAdapter
now exposes a pre-dispatch hook (`setAgentMessageHook`) that the receiver side of the a2a
primitive can install. When set, the hook intercepts text messages BEFORE normal user
dispatch — if the message carries a valid `[a2a:from=… to=… role=… id=… corr=… ts=… v=1]`
marker, the hook routes it to the registered role-handler or drops it as an a2a security
event (every drop reason audited). When the hook returns "not handled" (no marker), the
existing user-message flow continues unchanged. Ships **dark** — no caller invokes
`setAgentMessageHook` yet; the mentor consumer wires it in the follow-up.

The hook composer in `installAgentMessageHook.ts` ties together: the routing decision
(from PR 1), the audit ledger and processed-id store (from PR 3a), and a per-recipient
role-handler map. Spoof defense, per-source role acceptance, replay-window, and
idempotency are all enforced by the composed flow — Stage-B forensics gets a routed +
dropped audit trail it can replay.

## What to Tell Your User

- A new test-as-self skill that runs a deterministic check on a throwaway test deploy — verifies Part 1's structural fix actually fired in practice, and captures any crash signature for you instead of you guessing from log forensics.
- Still plumbing for the agent-to-agent Telegram feature; nothing changes for your agent today. Your normal Telegram messages flow exactly as before — only text messages with a fully-formed agent tag at the top are even considered, and nothing reads them yet.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `/test-as-self` runbook + verifier | Follow the recipe in `.claude/skills/test-as-self/SKILL.md`; run `node .claude/skills/test-as-self/scripts/verify.mjs --dir <test-agent-home>` |
| TelegramAdapter `setAgentMessageHook` | Internal — pre-dispatch hook fired on text messages before `onTopicMessage`; `{handled:true}` skips normal dispatch, `{handled:false}` falls through |
| `buildAgentMessageHook` (composer) | Internal — `src/messaging/installAgentMessageHook.ts`; composes decideRoute + ledger + processed-id store + role-handler map into the hook closure |

## Evidence

- Bundled skill: `.claude/skills/test-as-self/SKILL.md` + `scripts/verify.mjs`.
- Installer: `src/commands/init.ts` (`installTestAsSelfSkill`, mirrors `installBuildSkill`; non-destructive, idempotent).
- Tests: `tests/unit/test-as-self-verify.test.ts` (20 — both sides of every check boundary; security check rejects raw-token in file).
- Spec: `docs/specs/SELF-PROPAGATION-HARNESS-SPEC.md` (approved). Side-effects: `upgrades/side-effects/self-propagation-test-as-self-skill.md`.

For the a2a receiver hook: 7 new unit tests (43 a2a-related tests total, all green) — fall-through on non-marker (no audit flood); route → handler called + routed audit row + id marked processed; idempotency (re-delivered id dropped, handler not called a 2nd time); user-spoof defense (handler not called even when from/id match); unknown-role drop; handler-error doesn't crash dispatch + id stays marked; TelegramAdapter `setAgentMessageHook` accepts + clears. `tsc --noEmit` clean. The change to Echo's primary Telegram dispatch is gated behind `if (this.agentMessageHook && ...)` and nothing calls `setAgentMessageHook` yet — the user message flow is byte-for-byte unchanged in production until the mentor consumer lands.
