# Asking Justin to approve only what needs him: plain-English overview

## What happened

Justin approves one kind of change: changes to the constitution. In this repository that means two
files: the standards registry, and the file that says who owns it. GitHub enforces this itself. A pull
request that touches either file cannot merge until he approves it. Everything else, the agent merges
once its checks pass.

On November 17 a build session asked Justin to approve the GPT-6.2 model switch (pull request 3326). That
change touched neither file. The session also told him the repository needed an approval from someone
other than itself. That was false: the repository's rules require no review for that change.

## Why it happened

The message itself was not the cause. The session was following its own instructions:

- **Out-of-date build instructions.** They said the repository needs a human approval for every merge.
  That was true in August. It is not true now, and nobody updated the text.
- **Spec instructions out of step with practice.** They said approving a spec is "the user's step". In
  practice, the agent approves its own specs unless they change the constitution.
- **A helper that asks GitHub for a review.** It runs on every outgoing message, and it asks GitHub to make
  Justin a reviewer on any pull request the agent links. So GitHub itself showed him a review request
  for 3326.
- **The rule lived only in private notes.** "Only constitution changes need Justin" was in the agent's
  notes, which a newly started session does not necessarily read.

## What changes

1. **The instructions stop stating repository facts.** The build instructions no longer say what the
   repository requires. They say: run the merge tool, which reads GitHub's rules live and says
   "approval required" only when GitHub really will not merge without a review. Only then is Justin asked.
   Otherwise the agent merges and tells him what shipped. The spec instructions say the agent approves its
   own specs, except one that changes the constitution.
2. **Every session reads the rule.** A short note goes into every agent's instructions, so every session
   sees it whatever brief it started from. It is worded so each operator's own recorded wishes come first.
3. **The helper stops asking GitHub for a review nobody needs.** Before it asks GitHub to make Justin a
   reviewer, it now checks GitHub's own rules for that pull request. When they show that no approval is
   needed, it skips the request. It only does this on repositories that have said who approves what.
   Anything it cannot read for certain keeps the old behaviour. Constitution pull requests always still get
   the request.

Existing agents get the corrected instructions on their next update. Only the outdated sentences are
replaced, so anything an agent changed in its own copy is kept.

## What this does not do

It does not add a new check that blocks outgoing messages. Reviewers (three internal and one GPT-6 Astra)
agreed that fixing the instructions and the helper removes every cause found. A new blocking check would
add risk without a failure left for it to catch. If the problem comes back anyway, the evidence will show
it, and a check can be designed then.

## Safeguards

- **Nothing can merge without an approval GitHub requires.** GitHub still enforces that, and the merge
  tool still asks for the review when GitHub refuses.
- **Uncertainty keeps the old behaviour.** A rule the helper cannot read, or one it does not recognise,
  never removes a review request.
- **A switch restores the old helper behaviour** without a new release.
- **No new stored data.** Undoing it means reverting one pull request.

## What you need to decide

Nothing for this fix. It touches neither constitution file, so it needs no approval from Justin.

One related finding goes to Justin separately, for information. The 2.0 rule book says in so many words
that the operator is asked only for constitution changes. The 1.x standards registry does not say this
yet. Adding it would be a constitution change, so that is his call, and this fix does not depend on it.
