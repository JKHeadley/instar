# Telegram callback class map — plain-English overview

**The problem.** A related spec (`telegram-button-approval.md`) decided which kinds of thing a Telegram or Slack
button may ever approve: only things that reduce what the agent does and can be undone, such as stop, hold or
decline. Anything that grants, spends, publishes, switches off a safety check or mutes an alert must stay on
the dashboard. That rule is written where design reviewers will read it. But not every change goes through
design review — automatic fixes from the feedback pipeline and ordinary small pull requests do not — so a new
button that approves too much could slip in without anyone classifying it.

**What this spec builds.** A small map file that lists every place in the code that creates a button or
handles a button press, with a label for each action it carries: safe-to-tap, re-grant, or dashboard-only.
Each such place in the code carries a short marker comment pointing at its map entry. An automatic test finds
all those places by reading the code's structure (not by searching text, so comments do not confuse it) and
fails the build when one has no marker, when a marker has no map entry, or when a dashboard-only action is
reachable from a button without a recorded, time-limited exception. Two existing button approvals (agent
pairing, tunnel backup consent) and the session-prompt buttons are recorded as exceptions that end when a
named follow-up change lands. Burn-alert buttons exist in code but nothing uses them yet; the test lets that
stand until a button or a caller appears.

**What it does not do.** The map is a file the agent itself can edit, so the test catches *forgetting* to
classify, not *misclassifying* — a human reading the change catches that, and the spec recommends making the
map a file that needs the operator's GitHub review. A brand-new way of creating buttons has to be added to the
test's own list by hand.

**Why it is separate.** The parent spec went through twelve review rounds; this test's mechanics were the only
part still changing in the last three. It is not needed for the parent to be correct — the parent ships only
documentation — so it was split out to be reviewed on its own.
