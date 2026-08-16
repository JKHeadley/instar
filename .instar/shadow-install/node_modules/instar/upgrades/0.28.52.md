# Upgrade Guide — vNEXT (compaction-resume payload carries real context)

<!-- bump: patch -->

## What Changed

Closes the semantic half of the compaction-recovery bug surfaced on topic 6795 (2026-04-17). The earlier 0.28.51 patch fixed the **mechanical** failure — `recoverCompactedSession` was declining to re-inject because `findLastRealMessage` wasn't filtering PresenceProxy standby messages — but a screenshot from a different topic showed the deeper **semantic** failure: even when re-injection fires correctly, the prompt shipped was a single sentence asking the agent to "read the recent messages in this topic." With no actual context in front of it, the recovered agent reconstructs a plausible-sounding status summary ("Re-oriented: slices 1-7 shipped. Awaiting your cadence call — flip, defer, or park.") instead of answering the user's actual last message ("you really need to hand hold me through whatever I need to do here").

The fix introduces `src/messaging/shared/compactionResumePayload.ts`, which builds a payload that embeds the same context block the session-spawn path already ships: `topicMemory.formatContextForSession(topicId, 20)` → conversation summary + last 20 real messages + a search hint for deeper history lookup. For Slack (no SQLite summarizer) and the TopicMemory-not-ready fallback, it inlines the last 20 log entries directly with sender/timestamp/text. When the resulting payload exceeds the bracketed-paste comfort threshold (500 chars), it's written to `/tmp/instar-compaction-resume/` and the inject becomes a "read this file immediately" reference — matching the bootstrap pattern used by `spawnSessionForTopic` for large first-session context.

Both the Telegram path and the Slack path route through the same builder. The Slack path also picks up the walk-back classifier (`findLastRealMessage`) that the Telegram path already uses — previously slack only checked the single most-recent entry, so any from-agent log line newer than the user's message masked the unanswered state.

Full side-effects review: `upgrades/side-effects/NEXT.md`.

## What to Tell Your User

- **Compaction recovery actually remembers what you said**: "When my context window fills up and resets mid-conversation, I used to come back with a generic status summary — no matter what you'd just asked me. The recovery prompt was telling me to go read the thread myself, and I wasn't doing that carefully enough. Now the recovery carries my prior working memory — the conversation summary and recent messages — directly into the new session. So when I come back from compaction, I'm answering *what you asked*, not improvising a status update."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Compaction re-injection ships rich context (summary + recent messages + search hint) | automatic — fires whenever CompactionSentinel detects a compaction event on a Telegram topic or Slack channel |
| Slack compaction-recovery walk-back | automatic — now uses the same `findLastRealMessage` filter as Telegram so from-agent log lines don't mask unanswered user messages |

## Evidence

**Reproduction (pre-fix):** Topic 6795 on 2026-04-17. The 0.28.51 fix made `recoverCompactedSession` fire correctly after the user's "Please proceed here." message at 16:05:22, and the re-inject was reaching sessions. But a screenshot from a parallel topic (ledger v2 work) showed the recovered agent responding to "Okay, you really need to hand hold me through whatever I need to do here" with "Back from compaction. Re-oriented: integrated-being-ledger-v2 slices 1-7 shipped… Awaiting your cadence call — flip now, defer until slice 8, or park. No autonomous next step until you decide." The response was coherent with the *work state* but completely ignored the *user's request* — the agent reconstructed a plausible status summary because the re-inject prompt gave it nothing else to anchor on.

**Post-fix behavior:** The re-inject now embeds `topicMemory.formatContextForSession` output: conversation summary, last 20 real messages (with sender/timestamp/text), and a search hint. Large payloads (the common case) get written to `/tmp/instar-compaction-resume/resume-<id>-<ts>-<uuid>.txt` and the inject becomes "Your prior working memory — summary, recent messages, and lookup hints — has been preserved at <path>. Read that file IMMEDIATELY." The agent now has the user's last message verbatim in its context window at response time.

**Test coverage:** `tests/unit/compactionResumePayload.test.ts` (12 tests) pins down the payload shape — preamble language, inline-history formatting, file-threshold behavior, and a topic-6795-shaped integration test asserting the user's verbatim last message survives into the final payload.

**Live verification:** Will verify on next compaction event after shipping — the log line `[CompactionResume] (<trigger>) payload <N> chars > 500, wrote to /tmp/...` confirms the file-reference path is exercised.
