# Why a ship-gate error message wasted two hours, and the one-line cure

When a developer agent finishes a change, the system makes it attach a short
"side-effects review" document plus a little record-card that lists, among other
things, a fingerprint of that document. Before letting the change be saved, a
gatekeeper recomputes the fingerprint and checks it matches the one on the
record-card. If they do not match, the gatekeeper blocks the save — because a
mismatch usually means the document was edited after the card was written.

The old block message just said "the fingerprint does not match" and stopped
there. It never told the author the new correct fingerprint. So the author would
naturally try to fix it by regenerating the side-effects document — but that
document includes today's date, and regenerating it stamps a fresh date, which
changes the document, which changes its fingerprint, which STILL does not match
the card. Round and round. One agent burned about two hours stuck in exactly
this loop. Agents built on the Codex engine fall into it most, because they tend
to rebuild documents from scratch rather than leave them frozen.

The frustrating part is that the gatekeeper already knew the correct fingerprint
at the very moment it complained — it had just computed it to do the comparison.
It simply was not showing it.

The fix makes the block message helpful. Now when the fingerprints do not match,
the message prints the exact correct fingerprint and a short recipe: put this
fingerprint on the record-card, re-stage both files, and commit fresh without
amending — and do not rebuild the document again, just leave its bytes alone.
That turns a two-hour guessing game into a ten-second copy-and-paste.

Nothing about WHAT the gatekeeper blocks changes — it still blocks exactly the
same mismatches, for exactly the same safety reasons. The only thing that
changes is that the explanation is now actionable instead of a dead end. The
fingerprint it prints is just a checksum of a public review document, so there
is nothing sensitive in showing it.
