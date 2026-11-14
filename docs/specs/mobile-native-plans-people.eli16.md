# Plans, what I've learned about you, and other agents on the phone — the plain version

## What this is

The Instar iPhone app can already show chats, the "Needs you" list, the schedule, promises, machines, accounts, spending and resource use without opening a web page. Three more parts of the web console still need the console: **Plans** (the longer projects and multi-step efforts the agent is working through), **What I've learned about you** (the preferences the agent picked up from being corrected, and the corrections it is still watching), and **Other agents** (the agents it talks to, whether each one is paired and answering, and which ways of reaching people and agents work right now).

This change adds three new read-only answers on the agent's server — `/mobile/plans`, `/mobile/learned` and `/mobile/agents` — and three phone screens that show them in plain words, under a new "Plans and people" section on the agent's page. You pull down to refresh. Nothing on these screens changes anything: you cannot approve a round, delete a preference or pair an agent from the phone.

## What already exists

- The console's Plans, What I've learned about you, and Other agents pages, which read several of the server's internal routes with the agent's private token.
- The phone's own key: every phone request is signed by a key that never leaves the phone, and the server only accepts signed requests on a short list of addresses.
- The same pattern used twice already this week for Schedule/Promises/Machines and for Accounts/Spend/Resource usage: a purpose-built, trimmed answer for the phone instead of opening up the raw internal routes.

## What's new

- Three short-list entries, only for the owner's phone, with their own small rate limit so pulling to refresh can't crowd out chats.
- Each answer is built from an explicit list of fields. It keeps what the console shows you — plan names and where they stand, the preference sentences, the correction summaries, agent names, "paired" or not, "answered 2 h ago" or "nothing back for 6 h", and "working / broken / can't tell" for each channel — and drops everything else: internal ids, file paths, agent fingerprints, invite codes, message bodies and raw error text.
- Plans and corrections are gathered from every machine of yours that answers; a machine that doesn't answer is named so a partial list never looks complete. The channel list describes only the machine you are talking to, because each machine has its own connections.

## The safeguards, plainly

- Only the owner's phone (or the agent itself) can read these. A helper's phone, a removed or revoked phone, an unsigned or tampered request, and the notification-only token are all refused.
- Text that comes from records (plan titles, preference sentences, correction summaries, agent names) goes through the same secret scrubber the other phone screens use and is cut to a fixed length. It is shown as plain text, never treated as an instruction.
- If one part can't be read, that part says "can't tell" and the rest still shows; failures are logged so they're visible on the agent's health page.

## What you need to decide

Nothing new. The request (every feature native in the app, read-only first) is Justin's from 2026-11-03. This change shows no more than the owner can already see in the console or with the agent's own token. To undo it, revert the change: the phone screens then say "update the agent to see this here", and no data needs repair.
