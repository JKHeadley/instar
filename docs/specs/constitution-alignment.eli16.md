# Keeping the two rule books together, in plain words

## What this is

Instar has two versions, 1.x and 2.0, and each has its own written copy of the rules. In October we said the 2.0 book is the master, with the 1.x book beneath it. But nothing keeps them matching. Since then the 1.x book changed three times and the 2.0 book once, and only one of those changes reached both. Justin asked for a fundamental requirement that they always stay aligned, on every update.

## What's new

**A rule, in both books.** The two books are one constitution. Every change to either one names its matching change in the other, or says why it has none: it concerns only one version, or it changes no obligation.

**A line on every change.** Any pull request touching either book has to say what its pair is. A script checks that the line is there and that the named pair really exists in the other repository and really touches the other book. Every update counts, even a small one. A change with no real rule content just says so in that line.

**A daily check.** Each day I read the history of both books. Any merged change whose pair never landed within two days counts as drift. I then draft the missing change myself and only come to you if your approval is the last step.

**A map of today's differences.** One document listing every rule and how the two books compare. It says what's different in plain words. It isn't a rule book itself.

## The wording you're approving

**New rule, in both books: One Constitution, Two Books Aligned**

> The 1.x registry and the 2.0 purpose and rule book are one constitution, and they stay aligned on every update. Every change to either book names its counterpart change in the other, or says why it has none (it concerns only that version, or it changes no obligation). Where the two differ, the alignment map says so by name, and the master governs. No difference is silent.

**How it's checked, also in the rule:**

> A script reads each pull request touching either book and flags one with no declared counterpart; the 1.x merge tool refuses it. A daily check reads both repositories' history and raises any merged change whose pair never landed. Whether two wordings carry the same obligation, and whether a stated "none" is honest, is held by the independent review of the change.

**Rule 72 in the 2.0 book, matching the Maturation Path wording you approved:**

> Every feature graduates test agent → development agent → fleet, with a declared graduation test and deadline, and with default-on for the fleet as the last rung unless a recorded user-preference decision keeps it off. Every rung has machine-checkable thresholds against the feature's own logged behaviour. A threshold met raises the feature to the recurring review, whose model decides; it never flips anything by itself. A fleet default stays a reviewed code change.

## What the machine does and doesn't do

The script only checks that a pair was named and exists. It can't tell whether two wordings mean the same thing, or whether "this has no pair" is honest. That stays with the independent review each change gets, and with your own review.

## The honest limits

In the 1.x repository, my merge tool refuses a change with no declared pair. In the 2.0 repository, a failing check only shows red, because GitHub there isn't set to block on it, and changing that setting would take your admin action. I'm not asking for that. The daily check catches anything that slips through. If it ever does catch a real slip in 2.0, I'll bring you that as the reason to change the setting.

The checks are also ones I could edit myself. What can't be bypassed is your approval on both books. These checks are there because the real failure so far has been forgetting, not cheating.

## Existing differences

A first read found about half of the 1.x rules matching, 41 differing, and 44 in one book only. Of the 41, 8 are clear conflicts and 10 depend on how you read them: for example, who may block without the model, and when an audit counts as finished. Until each is resolved, the 2.0 book wins, as it already says.

They don't get fixed in this change. An independent review of the map picks out real conflicts, where following one book would break the other. Those come to you later as one sheet of wordings. A row you decline stays listed as different. Rules that exist in only one book stay listed by name. Nothing gets called aligned just to look tidy.

## What this asks of you

Two GitHub approvals, sent together in one message once nothing can change them. One adds the new rule to 2.0 and brings rule 72 in line with the Maturation Path wording you approved. The other holds the same two rules for 1.x.

From then on, a real rule change always costs two approvals, because the books sit in two protected repositories. That's the cost of the requirement. A change with no pair costs one line and no added approval.

## How to undo it

Turn off the daily job and remove one line from the merge tool. The rule and the map are plain documents, and nothing touches running agents.
