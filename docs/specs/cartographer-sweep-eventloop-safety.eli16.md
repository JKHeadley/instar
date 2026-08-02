# Cartographer Sweep Event-Loop Safety — the plain-English version

## What broke

The cartographer keeps a "map" of the codebase: one index card per folder and file. On my real machine that's **366,757 cards**, stored in a single **67-megabyte** file.

When I turned on the background job that fills in stale cards, the server kept dying. Every ~10–15 minutes after it started, the watchdog declared the server dead and force-restarted it — a kill-loop. The cause: before the job can fill in cards, it has to figure out *which* cards are stale. That "what's stale?" check read the whole 67MB file and looped over all 366k cards **on the server's single main thread** — the one thread that also answers "are you alive?" health checks. For ~35 seconds at a stretch the server couldn't answer anything, so the watchdog (correctly) assumed it was dead and killed it.

## Why the first fix wasn't enough

My first draft moved that one heavy check onto a separate background thread. Good — but the review process found I'd only plugged **one of six holes**. The same freeze could still happen five other ways: the health endpoint quietly rebuilds the entire map the first time anyone asks; a "double-check a few cards" step re-reads the whole 67MB file every cycle; the health endpoint's *heaviest* call wasn't even the one I'd named; the file-reading helper would actually crash on a tree this big because of a too-small buffer; and — the one buried deepest — every time the job *fills in* a card it rewrote the entire 67MB map from scratch, so authoring even 25 cards meant 25 full rewrites on the main thread. A fix that leaves five side doors open isn't a fix.

## What the converged design does

The rule is now: **nothing — not the background job, not any web endpoint — is allowed to do a whole-map-sized operation on the server's main thread, ever.** Concretely:

1. **The heavy "what's stale?" work runs on a separate worker thread** that hands back only the ~25 cards worth filling in plus the summary counts — never the full 366k list. It's bounded in *time* (gives up after a couple minutes) AND in *memory* (refuses cleanly instead of crashing the whole server if the file is pathologically huge). It only gets the secrets it actually needs (basically none), not my whole keychain.
2. **The web endpoints serve a saved snapshot** of the last good result instead of recomputing live — and they honestly tell you how old that snapshot is and whether the code has moved since.
3. **A build-time lint** makes it impossible to accidentally reintroduce a whole-map operation on a web route — so this exact bug can't sneak back in.
4. **The config knob that picks which (non-Claude, non-billed-to-you) model writes the cards now actually works** — it used to be decorative, which is part of why the bug hid for a while.

The deferred Git-listing upgrade is now complete too: the worker reads Git's NUL-separated tree records as they arrive instead of holding the entire command output in a fixed-size buffer. It accepts the result only after Git exits cleanly, and worker timeout teardown explicitly reaps the Git child. The scaffold-writer and index-storage follow-ups in #1073 remain separate items.

## What this structural-population increment adds

The map itself no longer depends on turning on the summary-writing job. Whenever
Cartographer is available, startup refreshes the folder-and-file hierarchy in
small yielding chunks, then asks the existing worker to count what is really in
that hierarchy and save the health snapshot. This is local filesystem and Git
work only: it does not select a model, enter an intelligence queue, send data to
another service, or change the summary-writing setting.

That distinction matters on a brand-new map. The health view now reports the
real number of discovered cards even while every card is still unwritten. It
also tells the truth about freshness: during the initial grace period the ratio
is unknown, and after grace it is zero. An empty or wholly unwritten map is never
reported as perfectly fresh. If summary writing is later enabled explicitly, it
waits for startup population to finish before touching the same index, so the
two writers cannot race.

## What changes for you

The structural map and its health counts populate automatically without buying
or enabling semantic-summary work. The summary-writing sweep stays **off** until
you explicitly enable it. Health and stale views continue to show last-known
numbers with an age stamp rather than recomputing the whole tree on demand — a
deliberate swap of "perfectly live" for "never freezes the server."

## What the build-time review caught

During the build, an independent second reviewer audited the finished code against the rule and caught a real leftover: the one-time **boot** step that builds the map still wrote the whole 67MB file in one unbroken go on the main thread. That write is now streamed in small pieces (with breathing room between pieces, like everything else), and a test was added that watches the server's responsiveness while the boot build runs on a large tree — so this last corner of the rule is enforced by a test, not by promises.
