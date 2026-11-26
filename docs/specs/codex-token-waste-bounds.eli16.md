# Bounding two wasteful background checks — plain-English overview

## What this change is

Instar runs a number of small background checks through Codex, the AI model service that handles its internal judgment calls. Every call costs tokens against the account's usage allowance. We measured what each check spends and found two that were paying for work and getting nothing back. This change fixes both of them. It does not change what any check decides.

## The first problem: a list that never stops growing

One check reads every new message in a conversation and keeps notes on what the conversation is establishing: its goals, its decisions, and the facts people agreed on. To do that well, it shows the AI the notes it already has, so the AI can say "this message confirms note 12" instead of writing the same note twice.

The problem is that it showed the AI *every* note the conversation had ever produced, and nothing ever removes old notes. A conversation that has run for months carries hundreds of them. The busiest one had 858. Every new message in that conversation meant re-sending all 858, and the bill grew with the conversation's age. It averaged about 42,000 tokens per message, roughly 7 million tokens a day on one machine. That made it the largest single background spender.

## What we changed for the first problem

The AI is now shown the 40 most relevant notes: the most confident ones first, and among those, the most recently confirmed. The rest stay saved exactly as before; they just aren't re-sent on every message. The ordering reuses the confidence and recency scores these notes already had, so nothing new is being judged.

What we give up is small. If a message restates a very old, low-confidence note that has dropped out of the top 40, the AI may write a fresh note instead of confirming the old one. The important notes (confident, recently confirmed) always stay inside the window, so they can still be confirmed or contradicted.

We deliberately did **not** apply the same limit to the related check that warns before the agent contradicts something already settled. That check has to see old settled decisions, or it cannot protect them.

## The second problem: a stopwatch set too short

Another check reads recent session activity and writes a short summary into the agent's long-term memory. On Codex these summaries take around 30 seconds, and the default time limit for a call is exactly 30 seconds. About half of them were cut off right at the limit. The model had already read the whole input, so the tokens were spent, and then the answer was thrown away. The failed summary was queued to try again and often got cut off again.

## What we changed for the second problem

These summary calls now get a 90-second limit. Nothing waits on them: they run in the background and don't block any message or action. A longer limit costs no one any time, and it turns thrown-away calls into finished summaries. The slowest successful call we observed took 49 seconds, well inside the new limit.

## Safeguards

- Nothing is deleted: every stored note stays saved.
- No check gains or loses the power to block anything.
- No settings or file formats change, so undoing it means reverting the code.
- Tests pin both behaviours. The cap test fails against the old code and passes against the new code.

## What you need to decide

Nothing beyond shipping it. After it rolls out, we'll check the per-check spend numbers to confirm the drop.
