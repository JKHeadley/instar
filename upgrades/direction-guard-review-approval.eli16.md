# Letting the operator's approval count — Plain-English Overview

## The problem in one breath

A check is supposed to stop the agent changing its own rulebook without the operator agreeing. The only proof it accepted was a cryptographic signature from a key the operator would have to create and guard for years. Nobody made that key, so the check refused everything — including the operator's own five approved changes. A check nobody can satisfy blocks the work rather than the risk.

## What already exists

Since 17 August, any change to the rulebook has been refused for want of that signature. Nothing has slipped past it; nothing has got through it either.

As of this afternoon there is also a real lock, and it is not code: the repository now requires changes to the rulebook to be approved by the operator, enforced by GitHub against the filename. That setting needs owner rights the agent doesn't have.

## What this adds

A second accepted proof: **the operator approving the pull request**. Three taps on a phone, on an account that already has two-factor. The signature route stays exactly as it was for anyone who prefers it.

## The new pieces

When a change touches the rulebook, the pipeline asks GitHub a single question: did the owner approve *this exact version*? If yes, that counts. If no — or if the answer can't be obtained — it falls back to demanding the signature.

## The safeguards

**The approval sticks to one exact version.** Push anything afterwards and it stops counting, so nobody can get a yes on one text and land another.

**A withdrawn approval counts as withdrawn** — and a re-approval after a resolved objection counts again, so an old objection can't block forever.

**Nobody can approve their own change**, checked here as well as by GitHub, so the property doesn't depend on one platform behaviour staying as it is.

**Anything unverifiable is refused.** An API failure means "we couldn't check", never "nobody objected".

## The honest part

**This code is not the lock, and it says so.** The agent writes this check and the job that runs it, so a version of the agent that wanted around it would edit it rather than defeat it. The thing that actually stops that is the repository setting, which needs admin rights the agent doesn't have. What the code adds is legibility — it tells you which parts of the rulebook changed and whether your approval still matches them, so your three taps are informed rather than ceremonial.

**One gap left open on purpose.** The approval is tied to the version you read. If the project moves underneath while you're reading, what finally lands can differ slightly. A further setting closes that; it's recommended, not assumed.

## What ships when

This can merge on its own — it touches no rulebook text, so it doesn't need an approval to install the approval path. Once it's in, the five amendments go green and merge on the operator's tap.

## What you actually need to decide

Nothing here. The decision was made this afternoon; this is the implementation. The one open question is unrelated: whether to also require branches be up to date before merging, which would close the last gap above.
