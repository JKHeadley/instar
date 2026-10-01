# Dashboard door + model controls — plain-English overview

**What this is.** Echo can talk to you through different "doors" (Claude Code, Codex, and so on),
and each door can run different models (Opus, Fable, Sol, Astra…). Every conversation topic can
already be pinned to a door and a model, and switching a live topic keeps the conversation. But the
only way to do any of that today is to ask in chat or type `/topic`. This adds the same controls to
the dashboard's Sessions tab, so you can do it from your phone:

1. **New Session** gets two dropdowns: Door and Model. The model list only shows models that door
   can actually run here, and a door whose program isn't installed shows as greyed out with the
   reason.
2. Each session's view gets a **Door + model** button. Pick a new pair, tap Switch, and that topic
   restarts on the new door with its conversation intact. If the server refuses the switch (for
   example the topic hasn't had its first message yet), the sheet shows the server's exact message.
3. The top of the Sessions list shows **Default for dashboard-created topics** (for example
   "Claude Code · Opus 5.5"). It fills the New Session dropdowns in advance, and every topic you
   create from the dashboard from then on starts on that pair.
   Topics you start directly in Telegram are NOT covered in this version — they keep starting on
   the plain defaults, exactly as today. That half is held for a follow-up (below).

**What changed in review.** The first draft made the default a live layer that every unpinned
topic would follow, and then tried to "freeze" existing topics so they wouldn't move. Reviewers
showed that freezing would have restarted every open session at once and posted a "profile changed"
line into every topic, and that a brand-new topic can't accept a normal pin write at all (nobody
has messaged it yet, so it has no bound operator). The converged design is much simpler: the default
is read only at the moment a topic is created, and written as that topic's own starting pin. Existing
topics never look at it, so they keep whatever they had, with nothing to freeze and nothing to
restart. With no default set, nothing anywhere behaves differently from today.

**Why the Telegram half is held.** Review rounds 3 through 9 each found a real defect in the rule
that decides whether a Telegram topic is "new" when the agent runs on two machines (Echo runs on
the Studio and the Laptop). The last one showed the rule depended on timing between the machines,
which no fixed rule can close. The single-machine version of the rule needed its own ledger, a boot
backfill and corrupt-file handling — machinery Echo would never run, so it could not be proven on
real use before shipping. The standing bar is 80/20 convergence: a problem that survives three
rounds gets cut and tracked, not another round of the same approach. So Telegram-created-topic
seeding is cut from this version and designed once, properly, together with "the default follows
you across machines" (GitHub issue #2085, due by 2027-03-25).

**What it does not do (on purpose).** Slack conversations and sessions running on Echo's other
machine show a read-only badge in this version — switch those from that machine's dashboard or in
chat. Thinking depth and effort aren't in the sheet yet (the API already supports them; easy to add).
On a fleet agent where topic profiles are still dark, the door switch works but the model choice is
refused, and the screen says so rather than pretending.

**Safety in one paragraph.** No PIN anywhere in this feature — you asked for that on 27 Sep, and it
is right: the dashboard's normal login already holds the token that can move any topic onto any
door, so a PIN here guarded nothing. Two new write paths, both narrow and both audited: the default
itself, and an explicit door/model pick when creating a topic (a brand-new topic has no "owner"
yet, so this is the one place a pin lands before anyone has messaged the topic; it is named as
such rather than hidden). The creation-time seed can only set a pin on a topic that has none, never
restarts anything, and posts exactly one line into the new topic saying what it started on.
Switching an existing topic uses the exact route that exists today, with its existing "you must be
the topic's operator" rule. Rolling back: clear the default (future topics unaffected); topics
already seeded keep their pin until you clear them individually, and the spec says so plainly.
