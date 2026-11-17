# Quota pacing, step 1, in plain words

**What it is.** Every 15 minutes Instar already checks how much of each Claude and Codex account's quota has been used. Right now it throws those readings away and only remembers the last two. This change keeps them for five weeks and uses them to look ahead.

**What it answers.**
- For Claude and for Codex: will the group of accounts stay usable all week? If not, when does it get tight, and how tight?
- For each account: where will it land when its quota resets? Will a lot go unused, or will it run out early?

**Why it matters.** On 17 November one Codex account had more than half its week left 12 hours before it reset, and nothing warned us the day before. With history, that shows up a day or more ahead.

**What it does not do.** It changes nothing. It doesn't move sessions, switch models, pause jobs or send messages. It is a reading on a page that the agent can check. Later steps, each with their own spec, may act on it, with the owner's approval.

**How it stays honest.**
- A missing or old reading shows as "can't tell", with the reason (signed out, checks backed off, not checked yet), never as empty or full.
- Each forecast is a best guess at the current pace, plus a range from the slowest to the fastest recent pace.
- The same account seen from several machines is counted once, matched by who it actually belongs to, not by its label. If two machines disagree about it, it shows as "machines disagree" instead of an average.
- Claude and Codex are never added together, and the five-hour, weekly and Fable windows are kept apart.
- It leads with the group ("9 of 14 accounts have room"), because one account running out early is fine as long as the group has room.

**How we know it works.** Tests prove the arithmetic. Replaying 17 November from the history has to show that Codex account as "will leave quota unused". After every reset, it also checks itself: what it would have said a day earlier against what actually happened. That record is what a later review uses to decide whether it is good enough to act on. No single number decides it.

**Off switch and rollout.** One setting. It is tried first on a throwaway test agent with replayed history, then runs on Echo for about three weeks (two resets for every account). It reaches every agent only after a review of how well it predicted. The history stays on each machine; it isn't synced or backed up, and it rebuilds itself if lost.

**Status.** Spec converged in three review rounds and approved; built in the same change, with unit, integration and end-to-end tests.
