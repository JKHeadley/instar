# Native console pages: plain overview

The app can now show five more things that used to need the web console: Pace, which says whether work queues are keeping up; Maturation, the board of how each feature is doing; Development, how shipping and feedback are going; Ideas, what a weekly look at similar projects found; and Files, a read-only way to browse the agent's files.

What's new is six read-only routes for the phone. Only the owner's phone, or the agent's own token, can use them. The clever part is how each one gets its data: it asks the agent's own console route on the same machine, then trims the answer down. So the phone can never see more than the console does. If a feature is switched off, the phone says so. The file rules, like which folders are allowed and which files are never served, stay in one place.

Files gets one extra rule the console doesn't have. Anything whose name says it holds a secret, like a keys folder or an auth backup, is hidden and refused on the phone. File text is cut to a sensible length and common secrets are blanked out.

Yesterday one phone screen froze the server for eleven seconds, so this work measured itself: trimming each page takes a few milliseconds on real data, and the expensive secret scrub only ever sees short pieces of text.

These screens only read. Deciding on an idea, approving a pull request or editing a file stays in the console. If something is wrong, reverting the change takes the screens back to saying "update the agent". There is nothing to decide here.
