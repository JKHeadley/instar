# ELI16 — Three small dashboard annoyances, cleaned up

## The problem in plain words

While fixing the big "dashboard keeps saying Disconnected" bug, I noticed three smaller, pre-existing issues. None of them break the connection — they're noise and one misleading light — but they're the kind of papercut that makes a healthy system look unwell.

**1. A button that never stopped knocking.** The dashboard checks "is WhatsApp set up?" every 3 seconds by pinging a WhatsApp address. If WhatsApp *isn't* set up (the normal case here), that address politely answers "not available" — but the dashboard kept asking anyway, forever. The result was about twenty error lines a minute piling up in the browser's hidden console. Harmless, but messy, and it buries real errors in the noise.

**2. An error thrown on every page load.** Tucked at the very end of the dashboard's code was a line that tried to hook into the live connection to refresh a small "paste" panel. But it ran *too early* — before the connection actually existed — so it tried to use something that wasn't there yet and threw a "can't read a property of nothing" error each time the page loaded. Worse, because it ran at the wrong moment, the paste-refresh it was supposed to enable never actually worked.

**3. A warning light stuck on.** At the top of the dashboard there's a little health badge: green "Healthy" or orange "Degraded". It turns orange if *anything* ever reported a hiccup. The catch: those hiccup reports are never erased. So one tiny, long-recovered blip would keep the badge orange for the entire time the server was running — telling you something's wrong when everything is actually fine.

## The fix

**1.** When the WhatsApp check gets the "not available" answer, stop checking. (If WhatsApp gets set up later, a page refresh starts it again.) The console noise is gone.

**2.** Move the paste-refresh handling into the dashboard's normal message router — the place that's always listening once the connection is live. That removes the early-run error *and* makes the paste-refresh actually work, even after the connection drops and comes back.

**3.** Make the health badge only count hiccups from the last 30 minutes. A real, ongoing problem keeps reporting itself, so it stays visible — but a one-off blip that recovered quietly ages out, and the badge goes back to green like it should. To be safe, a hiccup with a missing or garbled timestamp is always kept (better to show a maybe-stale warning than to hide a real one).

## What it does and doesn't do

- It does: silence the console spam, remove the on-load error (and revive the paste-refresh), and make the "Degraded" badge tell the truth about *current* health.
- It doesn't: change anything about restarts (on this agent the badge doesn't control restarts — that's decided separately by whether the server process is actually alive), and it doesn't touch the full record of past hiccups — only the *summary badge* is time-windowed.

Low risk: two of the three are small front-end guards in the dashboard page; the third is a contained, well-tested change to which hiccups the health summary counts. A separate, deeper issue — a different "system review" panel showing data from days ago because it never re-runs — is left for a follow-up, because re-running its checks on a schedule is a bigger, cost-bearing change.
