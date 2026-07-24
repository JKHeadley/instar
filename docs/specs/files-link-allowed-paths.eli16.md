# ELI16 — files/link honors the shared allowed-path policy

The dashboard has a Files tab, and the agent can hand you a deep link straight
to a file in it. Behind that is a safety list: which folders are allowed to be
browsed. The main file-reading code checks that list correctly — including the
convention that "./" means "the whole project".

The link-generating endpoint, though, had its own private copy of that check,
written slightly differently. The copy never understood the "./" convention —
so on a default install, where "everything in the project" is allowed, the
link endpoint rejected EVERY request as "not allowed". A feature dead under
its own default settings.

The fix removes the private copy: both places now call one shared check. Same
rules, one implementation, so they can never drift apart again. Bonus: the
shared check also rejects sneaky paths (like "../" tricks) that the private
copy quietly ignored.
