# Slack Follow-Through Generalization — plain-English overview

When you ask me something in Slack and I reply "I'll post that in five minutes," that promise currently lives only in the memory of the one session that made it. If that session restarts before the five minutes are up, the promise vanishes and you never hear back — nobody wrote it down anywhere durable. On Telegram this doesn't happen: a tiny automatic hook watches the end of every turn, notices "that was a promise," and files it as a durable commitment that survives restarts and gets followed up by machinery that already runs. This change makes Slack work the exact same way. It is deliberately small: almost everything needed already shipped and is running. The only missing piece is the little "notice the promise and write it down" trigger on the Slack side — so that is the only thing this spec adds.

This actually happened on 2026-07-03: I promised a Slack check-in note "in about 5 minutes," delivered it on time, but never filed a durable commitment. A restart in that window would have silently dropped it. That real miss is why this exists.

## What's already done vs. what this adds

**Already built and live (do not rebuild):** Slack conversations already get a permanent internal id the moment a message arrives; a Slack session already carries a signed "you're allowed to write things down for this conversation" token; the commitment store, the follow-up beacon, and the "deliver the follow-up back into the exact Slack thread" pipe are all wired and running on the dev machine.

**What this adds (the whole change):**
1. Feed the existing end-of-turn hook the Slack conversation's id and its signed token (today it only knows Telegram ids).
2. Teach that hook's server endpoint to (a) check the token before writing anything down for a Slack conversation, and (b) also recognize time-boxed promises like "in 5 minutes / by end of day," not just tech actions like "I'll redeploy."
3. A tiny fix so "in **about** 5 minutes" is recognized (today the word "about" makes the detector miss it — the exact thing that broke on 2026-07-03).

That's it. No new storage, no new delivery path, no new AI in the loop. It reuses the Telegram model everywhere.

## How it behaves safely

- **It never blocks your message.** The promise is already sent by the time the hook looks; the hook only quietly files a reminder for me to follow through.
- **It won't double-file.** Say the same promise twice and it updates one reminder, not two. There's a cap of 5 per conversation and they auto-expire.
- **It errs on the side of staying quiet.** A *false* reminder would mean I ping your Slack thread for no reason — annoying — so when in doubt, it files nothing. The cost is that a very unusual phrasing might slip through untracked (same as today), which is the safer miss.
- **It writes down on the right machine.** The machine that fronts Slack (the Mini) is the one that files the reminder, enforced by the signed token — a different machine literally can't file it.
- **One promise files one reminder — never two.** If a message is both a tech action AND time-boxed ("I'll deploy in 10 min"), it files exactly one reminder, not one per category.
- **Slack DMs (private messages to me) aren't covered yet — on purpose.** A DM is handled by a shared session that also does other work, so it can't safely tell which conversation a promise belonged to. Rather than risk filing it against the wrong conversation (or worse, replying in the wrong place), a DM promise simply stays untracked for now — the same as today — until a follow-up adds per-message tracking. The covered case (and the real one that broke on 2026-07-03) is a promise in a Slack channel/thread, which gets its own dedicated session.
- **Nothing goes silent.** If filing is *refused* (bad token, or the delivery half is still turned off), you get a visible note about it — it's never dropped without a trace.

## Rollout & the off switch

Ships dark on the fleet, live-in-"dry-run" on the dev machine first (it decides what it *would* file and logs that, without actually filing), then a deliberate flip to real filing on dev, then the operator flips it on for the fleet after a clean soak. Off switch: `messaging.actionClaim.slack.dryRun: true` (back to watch-only) or `messaging.actionClaim.enabled: false` (the whole thing off) — read live, no restart.

## The decisions I need you to weigh in on (you don't need to open the full spec)

1. **How hard should it try to catch promises?** Right now it catches (a) tech actions ("I'll redeploy/push/restart") and (b) time-boxed promises ("in 5 min / by EOD / I'll check in") — which covers the real case that broke. Should it ALSO try to catch open-ended promises with no time attached ("I'll send you the summary")? That catches more, but risks pinging your Slack thread for things that weren't really firm promises. **My recommendation: no — ship the two safe categories first, treat "catch everything" as a separate, carefully-watched follow-up.**

2. **What counts as "the same promise" for time-boxed ones?** If you word the same promise differently the second time, it might file a second reminder (capped at 5, and they expire in 6 hours). Is that acceptable, or should it treat any promise in a short time-window as "the same one" (fewer duplicates, but risks merging two genuinely different promises)? **My recommendation: accept the small duplicate risk (cap + expiry contain it); only tighten if the dev soak shows churn.**

3. **Should this also improve Telegram?** Because Slack and Telegram share the same endpoint, teaching it to catch time-boxed promises would also start catching them on Telegram (once the fleet flag is on). That's an upgrade, not a bug — but do you want it Slack-only until Telegram gets its own soak? **My recommendation: keep it shared (one detector for both), rely on the shared dark-gate + dev soak.**

4. **Do we need a slower backup scanner?** The hook could theoretically be missing on a very old session or crash. Want a low-frequency background scan of Slack transcripts as insurance? **My recommendation: no for now — the hook auto-updates on every agent, and "catch more" is really question 1's territory. Keep this minimal.**

---

*Design-review status: the technical design is **converged** — it passed an internal multi-lens review plus two independent AI cross-model reviews (Gemini and GPT), both clean, with the biggest catch being a private-message mis-delivery seam that's now closed. It was **operator-approved** and built; it ships dev-gated dark (off for everyone until an operator turns it on after a clean soak). This work is an instance of the **Structure beats Willpower** constitutional standard — the promise gets written down by machinery, not by anyone remembering to.*
