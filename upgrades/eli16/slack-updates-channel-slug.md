# Why the Slack Updates channel failed to create (and now doesn't)

## The one-sentence version
When your Slack workspace had a space or a capital letter in its name (like "SageMind Live Test"), the agent tried to make a Slack channel literally named "SageMind Live Test-sys-updates" — but Slack only allows lowercase, no-spaces channel names, so the creation crashed every time. Now the name is cleaned up first.

## Picture it
Imagine a mailroom that will only accept package labels written in lowercase with dashes instead of spaces. The agent was handing it a label that said "SageMind Live Test-sys-updates" — capital letters, spaces and all — and the mailroom kept rejecting it. The fix is a tiny label-printer that rewrites the label as "sagemind-live-test-sys-updates" before handing it over.

## What changed, precisely
- The two callers that auto-create the Slack "Updates" and "Attention" channels were passing a raw, workspace-derived name straight into channel creation.
- That raw name kept its spaces and capitals, which Slack rejects — so the channel never got made and you saw "Invalid channel name".
- Now both callers run the name through a small slugifier first (lowercase it, turn anything that isn't a-z/0-9 into a single dash, trim stray dashes, cap at Slack's 80-char limit) — exactly the same cleanup the per-session Slack channels already used.

## Why this is safe
- It only changes how the name is *built* before creation; it does not touch the channel-creation rule that other code relies on (that rule still rejects bad names — it just never sees one now).
- A name that was already valid passes through unchanged.
