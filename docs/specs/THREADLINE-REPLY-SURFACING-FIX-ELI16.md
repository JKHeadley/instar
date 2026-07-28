# Threadline reply surfacing — the plain-English version

## What's broken

When you and I are talking in a topic, and I reach out to another agent (Codey) in the background, Codey's reply is supposed to come back into *our* conversation. Right now it doesn't — it lands in my filing cabinet and you never see it. We dug in and found six separate things going wrong. Two of them are actually the same root problem wearing different hats.

## The root problem (hits two things at once)

Think of each conversation thread as a folder with a sticky note on it saying "this belongs to Justin's topic #12304." When Codey's reply arrives, I check the folder for that sticky note to know where to deliver it.

The bug: before I read the sticky note, a bouncer checks whether the folder has a matching "transcript file" on disk. These topic-folders never have that file (they're tied to a *conversation topic*, not a saved transcript), so the bouncer throws the whole folder out as "expired" — and I never see the sticky note. So:
- **The reply gets dumped** as a brand-new throwaway conversation instead of going to your topic.
- **"Show me the history" comes back empty**, even though the folder is right there.

The funny part: the code *already knew* about this bouncer being too aggressive, and worked around it in one place (when I *send*) — but never fixed it for when I *receive*. We fix the bouncer to leave topic-folders alone. One fix, both symptoms gone.

## The second problem: I "hand off" the reply but don't check it landed

When your topic's session is awake, I try to slip Codey's reply directly into it, assuming I'll then pass it on to you. But "slipping it in" is unreliable — on a busy session it gets stuck at the keyboard (we literally saw it jam and retry 17 times). The code treated "I tried to slip it in" as "done and delivered," so it (a) never sent you a backup notification and (b) marked the promise as kept. Reply vanishes, promise looks fulfilled, you saw nothing.

Fix: only count it as delivered if it *actually* went through. If the hand-off jams, send you a short backup note instead. Importantly — when the hand-off *works* (the normal case), I do NOT also send a backup note, so you don't get double-pinged. And if replies come in a fast burst, I bundle them into one note instead of spamming you. (This was the big thing my reviewers caught — my first draft would have double-notified you on every single reply, which is exactly the noise we hate.)

## The sneaky one my reviewers caught

There are two roads a reply can travel: the "same computer" road (which I'd fixed) and the "across the network" road. On the across-the-network road, a trusted agent's short reply takes a shortcut that skips the whole delivery system entirely. Our live test happened to use the same-computer road, so it looked fixed — but the network road would still drop replies. We're plugging that shortcut too. (This is the same kind of "fixed one door, left the other open" bug that bit us once before, so I'm glad the review flagged it.)

## The rest

- Each agent only saves the *other* side's half of the conversation, so even after we fix "show me history," it'd show half the chat. We fix it to save both halves.
- I don't tell the other agent which topic a message came from, so they can't route *their* replies cleanly. We include that (it's a harmless little number).
- The duplicate-message flooding gets a guard.

## How we'll make sure it's actually fixed

Build it in an isolated copy, write tests for every one of these (including the tricky "did the hand-off really land?" cases and the "don't double-notify" case), then — the real proof — deploy it onto the live Codey agent and run the actual back-and-forth until your topic genuinely shows Codey's replies, both when the session is busy and when it's idle. Only then does it ship.

## What I need from you

A thumbs-up on this plan. That's instar's own rule — I'm not allowed to write the code until the design is approved (it's the guardrail that stops me from charging off and building the wrong thing). After your ok, I run the whole thing start to finish and report back when it's live, no check-ins in between.

---

_Status: approved 2026-05-25 (Justin, topic 12304); implemented in this PR with 3-tier tests + a concurring second-pass review. During build, the "first-reply always surfaces" idea was dropped (a first reply already passes the per-thread limit, and forcing it would defeat the per-topic anti-flood cap), and "delivered" was tightened to mean a confirmed live hand-off OR an actual notification — never a stalled hand-off._
