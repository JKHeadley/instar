# In plain English: fix the auto-repair so it actually repairs the database engine

## What this is about

Instar stores memory, summaries, and usage in small SQLite databases. To talk to
SQLite, it uses a compiled helper called better-sqlite3 — a chunk of native code
built for one specific version of Node (the JavaScript runtime). When Node gets
upgraded, that compiled helper no longer matches and SQLite goes dark: no
knowledge graph, no conversation summaries, etc. Instar has an auto-repair that
is supposed to rebuild the helper to match. This change fixes that auto-repair,
because it was failing in three ways at once.

## What went wrong (found live on the Codey agent — SQLite was dark for 16 hours)

1. **It rebuilt for the wrong Node.** The repair runs a build tool that figures
   out "which Node am I building for?" by looking at the system PATH. Codey's
   PATH had an OLD Node (22.x) listed before its REAL Node (25.x). So the repair
   "succeeded" but built the helper for the wrong Node — and the real Node still
   couldn't load it. It kept doing this, forever.

2. **It only knew how to COMPILE.** Building from scratch needs a working C++
   compiler. On a machine without one, the repair simply can't finish. But there
   was a much easier option it never tried: DOWNLOAD a ready-made (prebuilt)
   helper for the right Node. That takes about 2 seconds and needs no compiler.

3. **It deleted the old helper before trying.** The compile step wipes the old
   file first. So when the compile then failed, the agent was left with NO helper
   at all — worse than the broken-but-present one it started with.

## What's new

For both repair paths (the one at startup and the one at runtime):

1. **Build for the RIGHT Node.** The repair now forces the build tool to use the
   agent's actual Node, so it always builds (or downloads) for the correct
   version — no matter what's first on PATH.

2. **Download first, compile only if needed.** It now tries to fetch the ready-made
   prebuilt helper first (fast, no compiler). It only falls back to compiling if
   the download isn't available.

3. **Never end up worse.** The startup repair backs up the old helper first and
   puts it back if every repair attempt fails — so the agent can never be left
   with no database engine at all.

## What the reader needs to decide

Nothing to configure. This makes the SQLite auto-repair reliable for any agent
after a Node upgrade — which is what bit Codey. Tests cover all three fixes
(right-Node build, download-first, and restore-on-failure), and on the affected
machine the download path fetched a working helper in ~2 seconds where the old
compile-only path could not finish at all.
