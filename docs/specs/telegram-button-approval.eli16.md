# Telegram-button approval — plain-English overview

**The question.** Some things the agent does need the operator's say-so. Today he types a six-digit
dashboard PIN for those, and approves each code change on GitHub. He asked whether a button in Telegram
could replace the PIN, and he has said twice that he cannot be the bottleneck.

**What we found.** Neither the PIN nor a Telegram button is a real lock today.
- The agent can read the PIN: on most installs it sits in a plain settings file, on this one in a vault the
  agent opens by design, and it is posted into the Telegram chat whenever the dashboard link is sent.
- The agent can fake a button press by reading one local file and sending one request, and on this machine it
  could also press real buttons through a browser signed into the operator's Telegram account.
- Anyone who steals the agent's API key can already make the agent do anything, including read the PIN or
  fake a press. And the PIN itself is the dashboard's door: typing it hands out that same API key.

So today a button would lose nothing compared with the PIN. Both are a record that "an approval happened",
not a lock.

**Why buttons still cannot be the long-term answer.** The fix for the PIN is to move the secret off the
machine, onto the operator's phone (a passkey), where no program on the machine can produce it. Telegram has
nothing like that: it cannot prove that his own hand on his own phone pressed a button, rather than a program
logged into his account. So a button may only ever approve things that are safe even if faked and can be
undone — stop, hold, decline — never anything that grants, spends, publishes, switches off a safety check or
mutes an alert.

**What this spec ships.** The rule above, written where design reviewers will read it. (A small automatic
test that would fail whenever someone adds a new kind of button without classifying it is specified
separately, in `telegram-callback-class-map.md`; this spec does not depend on it.) Two older design documents get a dated note that their "the agent can never approve this"
promises are weaker than they sound. No new buttons are built: the messages that need him already contain a
link one tap from each approval. Everything that would change the PIN itself — stop posting it in Telegram,
close the leak this review found (the agent's own chat history hands it to anyone with the API key, filed as
ACT-113), let one dashboard unlock cover several approvals instead of re-typing the PIN each time (his actual
complaint), the phone passkey, and an honest rewrite of what the agent is told about the PIN — goes into one
follow-up spec, so it all changes once and stays consistent.

**The volume problem, and what was tried.** There are 298 work items, more keep arriving, and each code fix
still needs a real GitHub review; the executor produces about six a day. He has said a batched tap on a stream
of changes is not review — he would be signing off code he had no time to read. So the review looked hard at an
**evidence card**: one short message per fix, built only from what the system itself checked, plus the changed
lines when the change is small, so that reading them would be the review. It was rejected. The changed lines
are themselves written by the program that wrote the fix — a comment saying "harmless" would sit among the
"verified" lines; the "it reproduces the bug" check only shows that a test the program wrote failed and then
passed, not that it is the reported bug; and every fix also adds a test file, so few fixes are small enough to
judge in ten seconds. A card that sounds more certain than it is would be worse than none — it is exactly the
false confidence the review step exists to prevent. The messages already give him a link straight to each fix.

Other options weighed: a second trusted reviewer in a GitHub organisation (the real structural fix, if such a
person exists — his decision, and the recommendation; measured tonight, GitHub currently requires no review at
all for a feedback fix, and there is no way to require one only for feedback fixes without also gating every
ordinary change, so this likely means a separate repository for feedback-derived work); bundling fixes (rejected: one hostile fix could hide among nine); the agent's
own AI approving (rejected: not independent); an independent AI reviewer off the agent's machines, or a
standing "merge whatever passes" grant (both his to decide, and the second means nobody reads the code). Two
more levers are his: take his Telegram and GitHub logins off the agent's machines, and measure how many of the
298 deserve a fix at all.
