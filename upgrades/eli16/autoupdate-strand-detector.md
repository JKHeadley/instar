# ELI16 — Notice when an update silently fell off the truck

## The problem in plain words

Instar updates itself by installing the new version into a private folder (the "shadow install") and then restarting onto it. To avoid loops, it keeps a note: "I already applied version X." On each check, if that note matches the latest version, it shrugs and says "downloaded, just waiting for a restart."

But that note is just a *memory* — it's not the same as *checking the folder*. And the version number the program reports for itself is read once when it starts up and then cached, so it never notices if the folder changes underneath it.

So here's the failure: an update installs successfully (the folder now has the new version, the note says "applied X"). Then something knocks the folder back to the OLD version — for example, a crash-loop where two copies of the program fight, or a half-finished re-install. Now the note still says "I applied X," but X isn't actually in the folder anymore. The updater believes it's up to date, refuses to re-apply, and every time it checks it cheerfully reports "downloaded, waiting for a restart" — which is a lie. The agent is quietly stuck on the old version forever, and nobody can tell from the message.

This really happened: an agent got stranded on the old version while its note insisted it had the new one. It only got unstuck when a human manually re-installed.

## The fix

Add a way to read the *live* version straight from the folder on disk (uncached), and use it. When the updater is about to print "downloaded, waiting for a restart," it now first checks the folder. If the folder doesn't actually have the version the note claims, it knows it's stranded — so instead of the misleading "waiting for a restart" it prints a loud warning and sends one honest heads-up: "an update was recorded as installed but isn't actually on disk — I'm stuck on the old version and won't auto-update until this is re-applied. Nothing's broken, but I won't pick up new versions until it's fixed."

## What it does and doesn't do

- It does: catch the stranded state immediately and tell a human (and the logs) the truth, with the exact versions involved and how to re-apply.
- It doesn't (yet): automatically fix the strand by re-installing. That auto-repair is a deliberate follow-up, because re-installing on the critical update path can loop if the folder keeps getting knocked back, so it needs a careful retry limit and proper review. This change is the safe, observe-only first step: stop hiding the problem.

Low risk: it's a new read plus a corrected message; it only triggers on the genuine strand (a normal "applied, waiting for restart" never reaches it), and it's covered by tests.
