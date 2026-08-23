# Teaching the rulebook check to see your approval — plain-English overview

## The one-sentence version

When you approve a rulebook change on GitHub, the check that guards the
rulebook now recognises that approval as the ratification it is — instead of
demanding a cryptographic signature from a key that was never created.

## The problem this closes

Earlier today the process for approving rulebook changes moved from "a signed
file from a key you'd have to create and guard for years" to "you tap Approve
on the pull request" — the design was reviewed four times and the repository
settings that make it binding are live. But the old check was never taught the
new rule. It kept demanding the signature, stayed red on every rulebook change,
and our own merge safety machinery — correctly — refuses to merge anything
while a check is red. So the very first pull request ratified under the new
process was approved by you and still could not land.

## What this does

The check now asks GitHub one question: is there an approving review from the
repository owner, on exactly the version of the code being checked? If yes,
the articles that were waiting on a signature are counted as ratified, and the
check says so by name in its output. If the approval was given on an older
version, or was withdrawn, or anything about the answer is unclear, the check
stays red — an approval that cannot be verified is not an approval.

## What keeps you safe, in plain terms

The check is deliberately NOT the thing protecting the rulebook — GitHub's own
settings are: the rulebook file is registered as owned by you, changes to it
stop and wait for your review, and pushing new code after your approval
cancels the approval. None of that lives in code I can edit. This change only
makes the check's verdict agree with what those settings already enforce, so a
correctly-ratified change stops showing a false red light.

Three details worth knowing. An approval only counts on the exact version you
looked at — if I push anything afterwards, it no longer counts and you would
be asked again. A "changes requested" from you after an approval takes the
approval back. And if a signed file IS present but invalid — forged, stale,
or duplicated — your approval does not paper over that; the check stays red,
because something pretending to be a signature is worth stopping for.

## What you actually need to decide

Nothing new — this implements the decision you already made today when you
chose review-based approval over a held key. The one behavioural note: after
you approve a rulebook pull request, the red check re-runs (or is re-run) and
goes green; the merge then proceeds. Your part is still just the one tap.
