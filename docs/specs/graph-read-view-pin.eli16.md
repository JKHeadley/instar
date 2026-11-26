# One check of the conversation graph per page load, not one per project title (ELI16)

## What this changes

To show the Conversations page, the agent builds a verified view of its conversation graph: it checks every record's signatures and unlocks the conversation details it is allowed to show. With about 550 records that takes a few seconds on a busy machine, so the agent keeps the view and reuses it until the graph changes.

While records are being saved, as during Accept all, the agent cannot reuse the view, because a save in progress could change it. That was meant to cost one rebuild per page load. But each project title on the page was looked up separately, and each lookup built the whole view again. A page with ten projects rebuilt it eleven times, in one go, freezing the server for 20 to 28 seconds on the test copy.

Now a page load builds the view once and uses that same view for every title on the page.

## What stays the same

Every page still uses a freshly verified view, built at the start of that page load. Nothing can change the graph in the middle of one page load, because building the page is one uninterrupted step. Saving is not touched at all.

## Safeguards

The shared view lasts only for that single page load; the next load builds a new one. If the view cannot be built, the page reports the problem exactly as before. Tests check that a page load uses one view for all its lookups and that the view is not kept afterwards, including when a page load fails. Undoing the one commit restores the old behaviour.

## What you need to decide

Nothing. This is part of fixing the server freezes during Accept all.
