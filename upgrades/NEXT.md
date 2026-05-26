# Upgrade Guide — NEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

**Codex-powered agents stop reloading their full identity on every background "judgment" call.** Instar makes ~1,500+ tiny internal LLM calls per agent per day — classify this message, did that turn finish, summarize this chunk, extract the intent. On a Codex-powered agent, each of those ran `codex exec` *inside the agent's project directory*, which made Codex load the agent's entire ~26 KB `AGENTS.md` identity AND fire the project's `.codex/hooks.json` (session_start / user_prompt_submit / stop) **every single time** — just to answer one word like "normal."

This was the dominant cause of two visible problems on Codex agents: the flood of "actively working / message delivered / still working" notifications (the session_start hook firing on ~1,550 spawns/day, so the monitoring layer thought a real session was constantly starting), and intermittent "couldn't deliver — please resend" failures (a dozen of these heavyweight spawns landing in one minute saturated the machine so a real inbound message couldn't get a process slot).

The fix gives those calls a clean notepad — the Codex analog of what `ClaudeCliIntelligenceProvider` already does with `--setting-sources user`. `CodexCliIntelligenceProvider` now runs judgment calls in an empty, private (0700, unguessable-name via `mkdtempSync`) scratch directory instead of the project dir, plus `-c project_doc_max_bytes=0`. No identity load, no project hooks. Claude-powered agents are unaffected (they were already clean).

## Evidence

Reproduced live on this machine's Codex install (codex-cli 0.133.0), before/after.

**Before (production incident, 2026-05-25 rollout logs in `~/.codex/sessions/`):** 1,601
`codex exec` spawns in one day, ~1,550 of them internal judgment calls. A sampled
message-classifier rollout (21:52) re-injected the full ~26 KB `AGENTS.md` identity AND a
`SESSION START` block — firing session_start — just to output the single word `normal`.
Those rollouts ran with `cwd` = the agent's project dir and were 63–110 KB each.

**After (controlled run of the built fixed provider against the real codex binary,
2026-05-26 13:49):** called `CodexCliIntelligenceProvider.evaluate()` with a unique marker
prompt; located the exact rollout it produced
(`rollout-2026-05-26T13-49-18-…019e660c….jsonl`). Observed:
- `cwd` = `/var/folders/…/T/instar-codex-intel-scratch-AOYJWS` (the mkdtemp scratch dir) ✓
- `AGENTS.md instructions` blocks: **0** (was ≥1) ✓
- `SESSION START` blocks: **0** (was 1) ✓
- `CURRENT TIME` hook markers (user_prompt_submit): **0** ✓
- rollout size 29.6 KB (was 63–110 KB) — the residue is codex's own base prompt, not instar identity.

The identity load and the session_start/user_prompt_submit hook firing are gone for
judgment calls. The agent still returned the correct answer.

## What to Tell Your User

- **If you run a Codex-powered agent, it should get noticeably quieter and more reliable — no action needed.** The "still working" notification spam and the occasional dropped/"please resend" messages were mostly this one plumbing bug; the agent was effectively re-reading its whole identity ~1,500 times a day. Claude-powered agents won't notice anything (they were never affected).

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex judgment calls run identity-free + hook-free | Automatic. `CodexCliIntelligenceProvider` runs `codex exec` in an empty `mkdtempSync` scratch dir + `-c project_doc_max_bytes=0` instead of the project dir. |
| Hardened scratch dir | Automatic. Unguessable random name, 0700 perms, recreated if a tmp-reaper deletes it — nothing can be planted in the cwd these calls run from. |
