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

## What changes for you

Nothing visible day-to-day, except the server stops dying when the sweep is on. The sweep stays **off** until this ships and I can re-enable it and finally give you the real cost-per-pass numbers you're owed. The trade-off: the health/stale endpoints now show last-known numbers with an age stamp rather than always-live numbers — a deliberate swap of "perfectly live" for "never freezes the server."

## What the build-time review caught

During the build, an independent second reviewer audited the finished code against the rule and caught a real leftover: the one-time **boot** step that builds the map still wrote the whole 67MB file in one unbroken go on the main thread. That write is now streamed in small pieces (with breathing room between pieces, like everything else), and a test was added that watches the server's responsiveness while the boot build runs on a large tree — so this last corner of the rule is enforced by a test, not by promises.
