# In plain words

The previous step defined the owner record: a signed ledger of who speaks for you, and the rule for reading it. This step puts that ledger on each of your computers and keeps them in step.

Each computer keeps its own copy in a private file, separate from everything else the agent syncs. When your agent first gets the ledger, the computer in charge writes its first line. The other computers take that one and remember it, so a fake starting line can't be swapped in later. When any computer learns a new line, it passes it to the others, and each one checks the signatures itself instead of trusting the sender.

Once you've set up a phone or key to approve things, the computer remembers that for good. If the ledger file goes missing, the agent doesn't quietly fall back to the old, weaker rules: it lets you look but holds anything risky until things are fixed. A computer running a version too old to understand the ledger is simply waited for; refusing such computers outright comes in the next step.
