# Dashboard scoped session token: the plain version

**What this is.** When you unlock the dashboard with your PIN, the agent currently hands your browser its **master key** — the same all-powerful token that can do anything on the agent, and that never expires. Your browser keeps that master key in storage and uses it for everything it shows you. This change replaces it with a **short-lived pass** instead.

**Why that matters.** Two problems with handing over the master key:
1. If someone ever guessed your PIN (the previous fix made that hard, but not impossible), they'd walk away with the master key — full control of the agent, forever, until you rotated it.
2. If someone got into the browser or copied its storage, same thing — a permanent, all-powerful key sitting in a web page.

**What changes.** On unlock, the agent now gives your browser a **session pass** that (a) expires on its own after a while, and (b) can be switched off instantly if you ever need to. The master key is never put in the browser at all. Everything the dashboard does keeps working exactly the same — the agent simply accepts this session pass in place of the master key, on every page, on the live-updating streams, everywhere. The master key still works for the agent's own programs and command-line tools; only the browser stops getting it.

**The key idea in one line:** your browser carries a pass that expires and can be revoked, instead of a master key that does neither.

**What stays the same for you.** Nothing visible changes. You unlock with your PIN exactly as before, and the dashboard works identically. The only thing you might ever notice is that a session left open and idle for a very long time could ask for the PIN again once — ordinary "your session expired" behaviour, and safer. No new steps, no extra clicks.

**What's deliberately NOT in this change.** This makes the pass *expire and be revocable* — it does not yet narrow *what* the pass can do (the dashboard still reaches the same things it does today). Trimming the pass down to only-what-each-page-needs is a bigger, separate job; bundling it here would risk breaking the dashboard, which the "security fixes keep the experience whole" rule forbids. So this change takes the big, safe win first.

**Why it ships carefully.** Because the session pass has to be accepted on *every* dashboard call plus the live streams, it's turned on only after the whole dashboard has been driven end-to-end on the new pass and proven to work — before you're ever asked to try it. If anything were wrong, a single switch turns it back to the old behaviour.

**What a reader needs to decide.** Whether this ships on for every agent once the full dashboard proof passes. The spec says yes: it removes a permanent, all-powerful key from every dashboard browser and you notice nothing.
