# Convergence Report — Tell the conversation that asked for a pairing link whether the phone paired

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external review ran in every round (5 of 5), through the agent's own codex CLI. The skill's wrapper script (`cross-model-review.mjs --family codex-cli`) returned `degraded: error` with no message in round 1 (reported as feedback fb-2f6c4619-90c), while `codex exec` itself worked, so every round invoked `codex exec -s read-only` directly with the full spec text and a fixed reviewer instruction. The Anthropic clean-door family returned `degraded: override-not-frontier` in round 1 and was not used again. Gemini was not signed in.

## ELI10 Overview

When you ask an Instar agent to add itself to your phone, it sends a one-time link, and the rest happens outside the conversation: the phone, a private approval message, a tap. The conversation that asked never hears how it ended. On 14 November that gap made an agent tell Justin his pairing had failed, because it read a log line saying the approval message was delayed. The phone had actually paired.

This spec makes the agent say how it ended. When it makes a link it names the conversation. A small saved watch list follows the link, reads the phone list every few seconds, and posts one plain line in that conversation, for example: A phone named "Justin's iPhone" was paired with Echo (key ABCD-…). If it did not pair, the line says why. Every agent's instructions also gain one line: the phone list is the answer, never a log line, and the phone list now also reports each link's outcome.

The tradeoffs: the line is only posted in Telegram conversations for now (in app or Slack conversations the link is still made, and the agent is told no line will follow). A result is posted in the conversation only when the person actually wrote there in the 15 minutes before the link was made; otherwise it goes to the quiet feed, so a background job cannot use this to bypass quiet mode.

## Original vs Converged

- **Links are never refused.** The first draft refused to make a link for an app or Slack conversation. Review pointed out that this would break pairing outside Telegram, so now the link is always made and the agent is told whether a line will follow.
- **Phone names are made harmless.** At first a phone's chosen name went into the line as-is. Review showed that a name like `[Tap here](https://…)` or `evil.com` would post a working link into your chat. Names are now cut down to letters, digits, spaces, apostrophes and hyphens, shown as "a phone named …", with the key the app shows.
- **No guessing from missing data.** At first, a phone record that had disappeared, or an unreadable phone list, would have produced "not paired". Now an unreadable list decides nothing, "paired" wins whenever the agent ever saw the phone active, and an uncertain case says only "I did not see it get approved, check the phone list".
- **Joined in one step.** The link-to-phone connection is now written inside the same save that creates the phone record, so a crash cannot separate them. The moment a phone uses a link is recorded too, and the case where the approval message could not be sent at all has its own honest line.
- **Restarts and machine moves are told apart.** A restart kills the link (codes live only in memory), but a move of the Telegram role between machines does not. The first drafts confused these and would have posted false "stopped working" lines.
- **Delivery through the normal path, read carefully.** Review traced the reply path and found several ways a line could be lost while reported as sent: filed silently by quiet mode, swallowed as a duplicate, or held by the outbox. The send result is now read field by field. A send the outbox takes over is followed until the outbox says what happened. Lines are registered as fixed system templates, so the wording-review model cannot block them because of a strange phone name.
- **Quiet mode respected.** A new protected category posts the line only when it answers the person's own recent message in that conversation (checked when the link is made); otherwise it goes to the quiet feed. It never appears as a push toggle.
- **Failures reach the operator.** A line that cannot be posted ends as one attention item per conversation (worded "may not have been posted" when the outcome is uncertain), with its own retry brakes.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | all (codex, security+adversarial, scale+integration, decisions+lessons); gate 6 flags | ~22 | ~10 | §3 rewritten: never refuse the link, atomic join, strict read, system template, answer table, per-topic attention, $INSTAR_TOPIC_ID |
| 2 | codex 7, decisions+lessons 3, scale+integration 2, security 4 | ~14 | ~12 | boot-only epoch, takenAt + not-delivered, past tense, no dots in names, pairing-outcome category, structured read on GET /mobile/devices, spliced curl example, no batching |
| 3 | codex 2, decisions+lessons 2, scale+integration 1, security 3 | ~7 | ~8 | operator-message anchor, protected category set, outbox hand-off state, holds without operationId as refusals, staleness rule |
| 4 | codex 2, decisions+lessons+integration 3, security+scale 4 | ~6 | ~5 | anchor checked at mint (gate trusts the producer), outbox read backoff, quiet/pending mappings, hand-off exempt from the 1 h rule |
| 5 | (converged) codex CLEAN; six-lens internal: no design findings | 0 | 4 precision (fixed in passing) | wording only |

Standards-Conformance Gate: ran in round 1 (6 flags) and on the final spec (7 advisory flags; one, retry brakes outside the send path, was fixed in passing; the rest were weighed in rounds 1–4 and are listed below). Not re-run in rounds 2–4 (an omission, recorded here; the internal reviewers engaged each round-1 flag).

Internal reviewer model: claude-opus-5-5 (this session's model) for all rounds. Lenses were paired into three subagents per round in rounds 1–3, two in round 4 and one six-lens agent in round 5.

## Proportion

Tier 2 (user-visible messages, security surface, a quiet-mode policy exception). Spec ~200 lines; 5 rounds of a 6-round cap. ⚠ The send path through the Telegram origin layer drove most of rounds 2–4: it has several distinct answer types (quiet filing, holds, content dedup, outbox ownership) that the first draft treated as one. A signal that this path deserves a shared, documented "classify an automation reply answer" helper; queued as feedback rather than built here.

## Left behind

- Redeem crash window between taking the code and writing the device: no `await` in between, so effectively zero; documented.
- Telegram-only line delivery; app and Slack conversations get the link and a reason, no line.
- Anchor is a heuristic (latest operator message within 15 minutes); a job session in a topic where the operator just spoke would anchor to that message. Accepted: the result is a past-tense line about a link that was in fact made there.
- Standby machines (Telegram polling off) cannot anchor; Telegram-path minting already requires the serving lease.
- Tone-gate skip holds for local dispatch only; a forwarded send is reviewed on the receiving machine, and a refusal ends in the attention item.
- Peer machines' rows in `GET /mobile/devices?scope=pool` carry no `status`, and `pairingOutcomes` covers links minted on this machine only; the bullet says so.
- 40-character name cut with no truncation marker; the key fingerprint identifies the phone. (Final gate flag.)
- Watch store is machine-local (physical-credential-locality: the code exists only in the minting process). (Final gate flag; reviewed both directions in rounds 1–5.)
- One message per link rather than aggregation (Bounded Notification Surface flag): each line answers a separate request, links are capped at 10 live / 10 per hour, and batching broke replay safety in round 2.
- Agent awareness still partly depends on the CLAUDE.md line; the structured read on `GET /mobile/devices` and the `$INSTAR_TOPIC_ID` example make the required step one read and one copy. (Final gate flag.)
- Wrapper script `cross-model-review.mjs` loses the codex error message: feedback fb-2f6c4619-90c.

## Full Findings Catalog

Round-by-round findings were folded into the spec as listed in "Original vs Converged" and the Iteration Summary. Highlights by reviewer:

- **codex (GPT-5.5):** R1 crash gaps, batching vs replay id, missing rows as proof, topic authorization, untrusted names, durable escalation, expiry normalisation, pool scope, held-answer conflicts. R2 redeem gap, missing-row wording, approval snapshot, escalation durability, cross-machine replay, dots in names, present tense. R3 redeem interleaving (resolved: synchronous block), re-enable posting old outcomes (staleness rule). R4 outbox late delivery vs staleness promise (accepted, documented), registry failure blocking unrelated work (resolved). R5 clean.
- **Security + adversarial:** R1 markdown links via names, tone gate on hostile names, held counted as sent, suppressed duplicate, batching, take-time refusals, downtime pruning. R2 quiet filing on 2xx, holds always non-retryable, allowDuplicate ineffective, lease does not void links. R3 refusals report outcome `held`, outbox deadline 6 h, protected set. R4 in-memory inbound rows lost on restart (resolved by anchor-at-mint), outcome polling cost, quiet-recorded mapping, `pending` outcome.
- **Scale + integration:** R1 held mapping, batching, dead availability gate, send timeout, lease-loss cause, hot-path reads. R2 single-quoted curl example would send a literal `$INSTAR_TOPIC_ID`, lease does not void links, attention dependency. R3 category would appear as a push toggle, peers drop status, port-dependent patch, version skew, MSP exposure.
- **Decision-completeness + lessons:** R1 unreadable registry read as empty, app/Slack losing the link, manual topicId, expiry cause, 10 s owner-message cutoff (PR 3165), phone-chosen name as fact. R2 lease epoch, fast removal read as unused, agent has no structured read. R3 quiet-by-default bypass without proof (resolved by the anchor), late-delivery wording. R4 restart loses anchor rows, standby anchor, staleness vs outbox.

## Convergence verdict

Converged at round 5. The final round found nothing that changes what gets built (GPT: CLEAN; six-lens internal: no design findings); four precision items were fixed in passing and the remaining accepted limits are listed above. The spec is ready for approval and build.
