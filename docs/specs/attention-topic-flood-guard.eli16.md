# Attention Topic-Flood Guard — Plain-English Overview

> The one-line version: notices from a misbehaving feature can no longer bury you in a wall of Telegram topics — past a small budget they fold into one topic and the rest go to the logs, while genuinely critical alerts always still come through on their own.

## The problem in one breath

Twice now, a background feature has spammed the chat with dozens of brand-new Telegram topics popping up out of nowhere — first the "session went quiet" watchdog (May 22), now a feature that pings other AI agents and kept announcing "can't reach that agent" over and over. Each announcement opened its own topic, forever. The user's reaction both times: this is noise I should never have to see, and it needs to stop happening for good — not get patched one feature at a time.

## What already exists

- **The Attention queue** — the system that posts important "you should look at this" items to Telegram. By design it opens a fresh topic per item so each can be acknowledged on its own. That's the right behavior for a real to-do, and the wrong behavior when a routine background feature fires hundreds of them.
- **SentinelNotifier (the May-22 fix)** — taught the session watchdogs to send their routine activity to the logs instead of Telegram, and to bundle real alerts into one system topic. It fixed *that one* feature. It did not stop the *next* feature from doing the same thing.
- **The collaboration re-drive feature** — the May-28 culprit. It nudges other agents when a shared conversation goes quiet. To nudge one it has to look up the agent's network address; when the address book is empty every lookup fails and it announced the failure as a new topic, on a loop.

## What this adds

The headline change is a **circuit breaker that sits at the single place every Telegram topic gets created**. It watches how many topics each "source" has opened recently. Past a small budget (default: 3 in 10 minutes), it stops opening new topics for that source and instead folds everything into ONE running "notices coalesced" topic, with the full detail written to a log file. The moment a source calms down, its budget refills. Because it lives at the one chokepoint, it protects against *any* feature — including ones not written yet — not just today's offender.

Two hard promises sit on top of it:
- **Critical alerts are never folded away.** Anything marked HIGH or URGENT always gets its own topic, every time.
- **Nothing is ever lost.** A folded item is still recorded and still logged; only its separate *topic* is withheld.

The actual offender (the re-drive feature) was fixed separately in PR #495, which landed on main while this was in review — it gives that feature a per-agent cooldown so it can't repeat its "can't reach" notice more than once a day. This change deliberately does NOT re-fix that feature; it adds the broader backstop above, which #495 doesn't have. The two work together: #495 calms the one feature, the breaker protects against all of them.

## The new pieces

- **AttentionTopicGuard** — the circuit breaker. It only decides *how* a non-critical notice is delivered (its own topic, or folded into a shared one). It is explicitly **not** allowed to drop a notice, block any agent action, or suppress a critical alert. It is a delivery shaper, not a gatekeeper — the same category of thing as the May-22 SentinelNotifier.

## The safeguards

- HIGH/URGENT bypass the breaker entirely, so a real emergency can never be coalesced into silence.
- Every coalesced item lands in a durable audit log (`state/attention-suppressed.jsonl`), so "where did that notice go?" always has an answer.
- The shared "notices coalesced" topic is created through the low-level topic call directly, so it can never loop back through the breaker and trigger itself.
- It ships on by default for the whole fleet with no configuration, and the back-out is a single config flag — there is no stored state to repair and no data to migrate.

## What you actually need to decide

Whether to approve shipping this to every instar agent. It changes how *noisy, non-critical* notices are delivered (folded instead of one-topic-each) while leaving critical alerts and the legitimate one-topic-per-real-to-do behavior untouched. The only judgment call baked in is the default budget — 3 non-critical topics per source per 10 minutes before folding — which is tunable per agent.
