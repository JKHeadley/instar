# Jev-first prompt-detect: the plain version

## What this is

PromptGate watches agent sessions in their terminals. When a session looks quiet, it asks a model one question: "Is this session stuck at a system prompt waiting for a key press?" If the answer is yes, the operator gets a message so the session does not sit blocked forever.

That model call happens a lot. Jev is a much smaller and cheaper model. Before we ever let Jev answer instead of the normal model, we need proof, from real terminals, that Jev gets it right. This change collects that proof without changing anything PromptGate does.

## What already exists

There is already one shared "ask Jev first" route, used today by the commitment detector, in shadow mode. It knows how to ask Jev, how to scrub secrets out of what it sends, how to record each decision in the local provenance log, and how to count calls for the Jev-first summary page.

## What is new

PromptGate becomes the second user of that route, under the name `prompt-detect`. When PromptGate is about to ask its normal model, it starts that call first and, at the same time, asks Jev the exact question we tested on 12 November. The normal model's answer is the only one PromptGate acts on. Jev's answer, the normal answer and the scrubbed last 20 terminal lines are written down so a person or a grader can later check who was right.

## Safeguards

- Shadow only, and that is enforced in code: even if someone sets the config to "live", it stays shadow.
- PromptGate never waits for Jev. If Jev is slow, wrong, broken, or has no key, PromptGate behaves exactly as before.
- Only secret-scrubbed text is sent, and the model version is pinned.
- On the fleet it is off. On a development agent it is on by default, and it can be switched off live.

## What you need to decide

Nothing now. Promotion (letting Jev's confident "no" skip the bigger model) is a later code change, and it needs graded real prompts first.
