# Quota pacing, step 1, in plain words

**What it is.** Every 15 minutes Instar already checks how much of each Claude and Codex account's quota has been used. Right now it throws those readings away and only remembers the last two. This change keeps them for five weeks and uses them to look ahead.

**What it answers.**
- For Claude and for Codex: will the group of accounts stay usable all week? If not, when does it get tight, and how tight?
- For each account: where will it land when its quota resets? Will a lot go unused, or will it run out early?

**Why it matters.** On 17 November one Codex account had more than half its week left 12 hours before it reset, and nothing warned us the day before. With history, that shows up a day or more ahead.

**What it does not do.** It changes nothing. It doesn't move sessions, switch models, pause jobs or send messages. It is a reading on a page that the agent can check. Later steps, each with their own spec, may act on it, with the owner's approval.

**How it stays honest.**
- A missing or old reading shows as "can't tell", never as empty or full.
- Forecasts are a range (normal pace and busiest pace), not one confident number.
- Claude and Codex are never added together, and the five-hour, weekly and Fable windows are kept apart.

**How we know it works.** After two resets per account, the forecast range should contain the real number at reset in at least 8 out of 10 cases. Until it does, no later step that acts on it starts.

**Off switch.** One setting. It is on for the development agent and off for everyone else to begin with.
