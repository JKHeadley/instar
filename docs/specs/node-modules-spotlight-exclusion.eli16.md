# Explain it like I'm 16: stop Spotlight from chewing on node_modules

## The setup

On a Mac, there's a built-in search system called Spotlight. It quietly reads every file on
your disk and builds an index so you can search them later. Whenever files change, it re-reads
them to keep the index fresh.

Each of our AI agents lives in its own folder, and inside each one is a `node_modules` folder —
that's where all the downloaded code libraries go. It's HUGE: on one agent it was 1.3 gigabytes
and about 25,000 files. And there's a second copy (the "shadow install") that's another ~600
megabytes. We run about ten agents. So that's roughly 20 gigabytes of library files.

## The problem

Those library folders change a LOT — every time an agent updates itself or reinstalls its
dependencies. And every time they change, Spotlight wakes up and re-reads all 20 gigabytes to
update its search index. We measured it: the Mac's two busiest programs were Spotlight's
indexer and a media-analysis helper — together eating more CPU than any of our actual agents.
That's wasted work slowing down the whole machine (and a loaded machine is part of why other
things were struggling).

Here's the kicker: you would NEVER search inside node_modules. It's machine-generated build
junk. So all that indexing is 100% pointless.

## The fix

Mac has an official "please don't index this folder" signal: you drop an empty file named
`.metadata_never_index` inside the folder, and Spotlight skips it. We already did this for one
kind of folder (throwaway "worktrees"), but we'd never done it for the big node_modules folders.

So this change teaches each agent to drop that little marker file into its `node_modules` and
its shadow-install copy, automatically, every time it updates. Spotlight then leaves those
folders alone forever, and stops burning CPU re-reading 20 gigabytes of library files nobody
searches.

## Why it's safe

The marker file does exactly one thing: tell Spotlight "skip me." It doesn't touch how the code
runs, how files are read, or how anything builds — node_modules works exactly the same, it's
just not in the search index anymore (which you never wanted it to be). On a non-Mac it does
nothing at all. And if for some reason we can't write the marker, we just shrug and move on —
the worst case is Spotlight keeps indexing like before. There's no way for this to break
anything; we also already applied it by hand across the live machine to get the relief now, and
this makes it permanent and automatic.
