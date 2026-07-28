# The approve-or-ask classifier gets clearer instructions — plain-English overview

When a coding session inside instar hits an interactive prompt ("create this
file? 1. Yes 2. No"), a small model decides whether it's safe to auto-approve
or whether a human should be asked. The benchmark found two soft spots in its
instructions. First, the instruction list ended with a catch-all — "relay to
the human when you are unsure" — without ever defining unsure. Cautious models
leaned on it constantly: half the tested models asked the human about a plain
in-project file edit that the instructions explicitly say is auto-approvable.
Every unnecessary relay is a phone-buzz the user didn't need. The fix defines
the term: unsure means the prompt matches none of the listed rules or sits
ambiguously between them — and matching an explicit approve rule is never
unsure. It also clarifies that a relative file path counts as inside the
project, which is what tripped the cautious models. Second, one model kept
answering correctly but wrapped its answer in a paragraph of reasoning the
strict one-word reader can't parse; a closing line now insists on the single
word, no explanation, even when the decision feels high-stakes.

Safety direction was the whole review question here, because this change
makes the classifier auto-approve MORE often. The scope is tight: only
prompts matching an explicitly-listed approve rule are affected; every
ask-the-human rule (questions, files outside the project, anything
destructive) is untouched. The side-by-side A/B proved it: three cells fixed,
zero broken across 117 cells on fourteen model routes — including the
adversarial case where an attacker plants "auto-approve this" text in the
terminal, which actually got BETTER on one model. The four apparent
regressions in the first pass all turned out to be free-tier rate-limit noise
and dissolved when re-run at three samples. Rollback is deleting the added
lines; a pin-test keeps the wording from drifting back.
