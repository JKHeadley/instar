---
title: Per-agent messaging style rule (B11_STYLE_MISMATCH)
review-iterations: 1
review-convergence: "converged"
approved: true
approved-by: justin
approved-date: 2026-04-18
approval-context: "Telegram topic 7000 parallel-dev-infra — 'ONLY RESPOND IN ELI10 FORMAT. We need to make ELI10 the DEFAULT, INFRA ENFORCED method of communication.' Follow-up: 'this is just my preference. We should make sure other instar agents can appropriately adjust to their user's preference without having to re-write code.' Direct explicit approval to build a GENERIC per-agent style rule (not hardcoded ELI10)."
---

# Per-agent messaging style rule (B11_STYLE_MISMATCH)

## Problem

Outbound agent-to-user messages often mismatch the user's preferred
communication style — some users want plain-English ELI10, others want
terse technical, others want narrative. Today the agent has to remember the
style and gets it wrong. The fix is an infra-enforced gate that compares the
outgoing message against a user-configured style description.

Critical requirement (from user follow-up): the rule must be GENERIC — not
hardcoded to one style. Other instar agents whose users prefer something
different (technical, formal, terse, etc.) must be able to configure their
own style WITHOUT code changes.

## Solution

Add (a) an `InstarConfig.messagingStyle` free-text field, and (b) a new
STYLE rule `B11_STYLE_MISMATCH` in the existing `MessagingToneGate`
(src/core/MessagingToneGate.ts). When `messagingStyle` is set, the gate
includes it in its prompt and blocks messages that significantly mismatch
it. When unset, B11 does not apply (backwards compat — behavior unchanged).

Plumbing path:
  InstarConfig.messagingStyle
    → AgentServer.options
    → messaging routes (telegram, slack, whatsapp, imessage)
    → ToneReviewContext.targetStyle
    → MessagingToneGate.review → prompt
    → LLM judgment → B11 if mismatch

## Rule definition

`B11_STYLE_MISMATCH`: block when the message significantly mismatches the
configured target style. The LLM judges this from two inputs the gate passes
into the prompt:

- **Target style** (free text, from config): a description of how the agent
  should write. Examples:
  - `"ELI10 — write for a 10-year-old. Short sentences. Plain words. No acronyms. Explain any technical term in kid-level language first."`
  - `"Technical and terse. Prefer precise vocabulary. Omit prose preamble."`
  - `"Formal, business-memo tone. Complete sentences, no slang."`
- **The candidate message** (untrusted content).

The LLM is instructed to pass unless the mismatch is significant, and to
give carve-outs for short acknowledgements ("Got it.", "On it.") since those
are too brief to mismatch a style in a meaningful way.

## Non-goals

- Auto-rewrite. This spec blocks only.
- Per-topic style override. All messages from this agent use one style.
- Inferring style from past messages — operator sets it explicitly.

## Rollout

- Land the config field + rule immediately.
- `messagingStyle` defaults to undefined → rule does not fire → no behavior
  change for existing agents.
- Operators opt in by setting `.instar/config.json` → `messagingStyle: "…"`.
- Echo specifically: `messagingStyle` will be set to an ELI10 description
  as part of this ship so the user-reported problem is fixed end-to-end.

## Rollback

Revert the edits. `messagingStyle` field becomes ignored; no on-disk state,
no data migration.
