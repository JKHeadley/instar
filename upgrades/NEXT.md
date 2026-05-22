# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = behavior fix, no new capability, no breaking change -->

## What Changed

**feat(tone-gate): add B15_CONTEXT_DEATH_STOP — block outbound "fresh-
session / hand-off" framing on in-flight work.**

instar's `MessagingToneGate` already runs on every outbound user
message and blocks fourteen classes of leakage (B1–B14 — CLI commands,
file paths, jargon dumps, health-alert internals, style mismatch,
etc.). This adds a fifteenth rule, **B15_CONTEXT_DEATH_STOP**, that
catches a specific failure mode of the agent: proposing to pause, stop,
or hand off the current in-flight work for a context-window /
fresh-session / end-of-session reason rather than a legitimate stop
reason.

The pattern is documented in the CLAUDE.md "Context-Death Self-Stop"
anti-pattern section, and reinforced by multiple memory entries
(`feedback_scope_hook_is_grounding_not_termination`,
`feedback_no_deferrals`, `feedback_finish_means_merge`, etc.). Despite
the documentation, the slip kept recurring. Per instar's foundational
"Structure beats willpower" principle, this needs a structural guard
that catches the language at send-time.

B15 is an LLM-gate rule (the existing tone-gate authority). It lists
literal pattern markers ("fresh session," "next session," "tail of
this session," "hand off cleanly," "pick this up later," etc.) AND
legitimate-stop carve-outs that pass unblocked (real design question
only the operator can answer, real blocker, real error, completion
report on user-requested scope). The LLM combines the markers with
conversational context and the carve-outs to make the block/pass call.

When B15 fires, the standard tone-gate UX applies: the candidate is
rejected with rule id B15, an issue summary, and a suggestion. The
agent has to either delete the handoff framing and continue working
or supply an explicit legitimate-stop reason.

## Evidence

The change is one entry added to `VALID_RULES`, one new section in
the gate's prompt, and one line updated in the response-format note
listing valid rule ids. Nine unit tests in
`tests/unit/messaging-tone-gate-b15.test.ts` verify:

1. The prompt always carries the B15 rule definition for every review.
2. The prompt carries the literal pattern markers (fresh session, next
   session, tail of this session, hand off cleanly, pick this up later).
3. The prompt documents the legitimate-stop carve-outs (completion
   report, genuine error / blocker).
4. The response-format rule list includes B15.
5. An LLM response citing B15 is accepted as a valid block (not
   fail-opened as `invalidRule`).
6. A completion-report message passes through unchanged when the LLM
   returns pass.
7. A genuine-blocker message passes through unchanged.
8. A topic-split / continuation message passes through unchanged.
9. The drift-detection still rejects unknown rule ids (no widening
   of the gate to arbitrary ids).

All 27 existing `MessagingToneGate.test.ts` tests still pass; all 8
existing `messaging-tone-gate-health-alerts.test.ts` tests still pass.
The TypeScript build is clean; lint is clean.

## What to Tell Your User

Your agent now has one more safety net on the messages it sends you.
The new check looks for moments where the agent is about to write some
version of "let me pick this up in a fresh session" or "I'll hand this
off cleanly" while the work you asked for isn't actually done yet — and
quietly blocks that message before it reaches you. The agent has to
either delete the bail-out framing and keep working, or cite a real
reason for stopping. You should notice the agent doing less of that
pattern. Nothing changes about messages where the agent has a real
question, a real blocker, a real error, or actually finished the work.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| B15 tone-gate rule catches outbound context-death stop framing | Automatic — runs on every outbound user message via MessagingToneGate |
| B15 has explicit legitimate-stop carve-outs | Automatic — real question / real blocker / real error / completion report pass unblocked |
