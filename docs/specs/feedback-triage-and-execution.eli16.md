# Feedback Triage and Execution — plain-English overview

## What problem this fixes

Every Instar agent can send in bug reports and suggestions. Those reports arrive, get grouped with similar ones, and each group becomes a work item. That is where things stop today. On October 6 there were 426 work items and none had moved past step one. Every item was ranked "normal", because the only ranking rule was "5 or more reports makes it high", and almost every problem had exactly one report. No report had ever been closed, even obvious duplicates. The pile only grows.

## What changes

**1. A smart sorter.** A top model reads each item's actual reports, not just the title. It decides how serious the problem is, how many agents it affects, and roughly how big the fix is. Then it picks one of three answers: work on it, hold it for later, or ignore it. It also gives a reason, like "duplicate of another item" or "already fixed last week".

**2. Safety rules around the sorter.** The model's answer is checked by plain code. If the model is unsure, the item is held, not ignored. Anything serious, or anything that looks like security or data loss, can never be ignored automatically; it is held and flagged instead. "Duplicate" has to name the original, and "already fixed" has to point at the actual fix.

**3. Proper parking.** Ignored items leave the work list with their reason. Held items are parked and come back for another look after two weeks, or sooner if new reports arrive. Ignored items also come back if new reports arrive. Nothing is deleted, and every decision can be undone.

**4. A worker that actually does the work.** Every 30 minutes a worker takes the highest-ranked "work on it" item and starts a real build session on it: at most two at a time, six per day, and never more than four waiting for review. The build session can read the (cleaned) reports as data, but they are never part of its instructions. It runs inside an operating-system sandbox: no internet, no passwords or keys, and no access to files outside its own working copy. Before every run a quick test checks the sandbox actually holds; if it doesn't, nothing runs. The session writes a failing test and a fix. The worker's own trusted code then double-checks the test (fails before, passes after), refuses changes to build tooling or anything that looks like a secret, and only then opens the pull request, Only your GitHub approval counts (it reads the repository owner from GitHub, and refuses to run if it could act as you itself, unless you accept that once with your dashboard PIN). The worker merges it itself, and only at the exact version you approved, so anything pushed afterwards cannot sneak in. A fix only counts as truly done once it has shipped and no new matching reports arrive for 30 days. The worker never merges anything. Every pull request still needs your one-tap approval, which also protects against a malicious report steering the code. When a fix needs a new design, the session writes and reviews the design first and opens it for your approval; the build starts after you approve. If a session fails twice, the item is held with a note.

**5. One morning message.** At 8am you get one message: the top of the list, what merged, the pull requests waiting for your tap (with direct links), and anything held for you. Nothing at night.

## What you will see

A ranked list of what is being worked on, and counts of what was held or ignored and why, in the dashboard's Feedback section. Two simple read-only addresses give the same information to the agent.

## Tradeoffs

- It costs usage: the sorter is capped at 150 model calls a day, and build sessions at 2 running and 6 started per day.
- The sorter can be wrong. That is why ignoring is limited to low-risk items, every decision is logged, and a wrongly ignored problem that comes back gets counted as a mistake so we can see how accurate it is.
- It runs first on a throwaway test agent, then on Echo. Everyone else gets it only after two weeks of measured results on Echo.
