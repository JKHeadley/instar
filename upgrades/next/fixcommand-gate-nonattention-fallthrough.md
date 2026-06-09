<!-- bump: patch -->

## What Changed

Scopes the emergency "fix command" gate to the **Agent Attention topic** so it can no longer swallow ordinary messages in other topics. The gate in `wireTelegramRouting` (`src/commands/server.ts`) used to intercept any message starting with `restart`, `fix `, or `clean ` in **every** topic, hand it to `handleFixCommand`, and `return` — but `handleFixCommand` only does anything in the Agent Attention topic and returns `false` everywhere else. So in a normal topic the message was bounced back with *"I didn't recognize that command. Available fix commands: …"* (a list that even advertised "restart sessions" as valid) **and never routed to the session**. A user typing "restart sessions" to revive a stuck session in that session's own topic was hit by exactly this: the gate ate the message. The decision is now a pure, unit-tested helper `shouldInterceptFixCommand(text, topicId, attentionTopicId)` that returns true only inside the attention topic; `wireTelegramRouting` resolves the attention topic via a late-bound `getAttentionTopicId` and both call sites pass it. Outside the attention topic the message falls through to normal session routing — including plain phrases like "restart the build" or "fix the login page" that were silently eaten before.

## What to Tell Your User

If you ever messaged a session something starting with "restart", "fix", or "clean" — including trying to revive a stuck session by typing "restart sessions" — and got a confusing *"I didn't recognize that command"* reply (with a list that literally showed the command you typed), that message was being intercepted and never reached the session. That's fixed: those messages now go through to the session like any other. The "fix command" shortcuts (restart, fix auth, clean processes, …) still work — they just only apply in the Agent Attention topic, which is where I post the notifications you tap to resolve.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Fix-command shortcuts scoped to the Agent Attention topic | unchanged — tap/reply in the Attention topic; everywhere else your message reaches the session |
| Ordinary "restart/fix/clean …" messages reach the session | just send them normally in any session topic |

## Evidence

Reproduction (live, 2026-06-09, topic 21624 "initiatives and maturation check-ins"): the user typed `restart sessions` to unstick a session and got *"I didn't recognize that command. Available fix commands: … • restart sessions — Restart stuck sessions"* — the gate swallowed the message (no `restart sessions` ever appeared in the session's tmux pane) while listing the exact command as valid. Root cause traced in code: the gate's `isFixCommand` verb test ran in all topics and `return`ed after `handleFixCommand` (which guards on `topicId === agent-attention-topic` and returns `false` otherwise).

After the fix: new unit suite `tests/unit/fix-command-routing.test.ts` (17 tests) pins both sides of the boundary — in the attention topic every fix verb intercepts (and verb-lookalikes "fixture"/"cleanup" do not), while in a non-attention topic "restart sessions", "restart the build", "fix the login page", "clean up this function" all return `false` (fall through to the session); a null/undefined attention topic never intercepts. `tsc --noEmit` clean; the full set of unit tests importing `commands/server` (38 files, 364 tests) green.
