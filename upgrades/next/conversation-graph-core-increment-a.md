<!-- bump: patch -->

# Conversations: organize chats into projects and efforts (off by default)

## What Changed

Conversations lets the owner group their chats (app, Telegram and Slack) into projects and efforts, name them, move them and undo a move. The arrangement is a signed history that the agent's member machines share, so every member shows the same arrangement and a change made on one shows up on the others.

It is off by default. It turns on only when `multiMachine.conversationGraph.storage.enabled` and `readEnabled` are set; `correctionsEnabled` adds the owner's editing actions. It also needs the coherence journal (with replication) and write admission. `genesisMembers` names which paired machines sign the graph when it is first created; leaving it out means every paired machine. Paired machines outside that list keep working for everything else and show as "not joined" in Conversations.

A member machine that is gone for good can be removed from the dashboard (Machines section) after a warning. Removal can be cancelled until its permanent step starts, and an interrupted removal can be finished later. Chat messages do not add records to the history; only organizing changes do.

`instar join <url> --dir <path>` no longer crashes when the folder does not exist yet.

When Conversations is off, its routes answer 503 `conversation-graph-off` (JSON) instead of a plain not-found page. A conversation that several machines hold (app chats, Telegram topics) is one conversation, not "unavailable". If a paired machine that is not a member is in charge, a waiting change says so. A crash during graph setup with a non-member paired now finishes on the next start.

## What to Tell Your User

Nothing changes unless Conversations is switched on. When it is on, you can group your chats into projects and efforts from the dashboard and the app, and the same arrangement shows on every machine that is a member. A machine that isn't a member yet shows as "not joined" there and keeps working normally otherwise.

## Summary of New Capabilities

- Group chats into projects and efforts, rename, move and undo, from the dashboard and the app (owner only).
- Arrangement shared across member machines as a signed history.
- Remove a lost member machine from the dashboard, with cancel and finish-later.
- Choose which paired machines start as members.

## Evidence

- Real Studio + M5 pair, signed phone client (2026-11-09, release head 988bdd7793): chat history identical from both machines; image and file downloaded through the other machine with matching sha256; a chat held by both machines moved into an effort, moved back, renamed and read through the graph history route on both; switched off, chats and media keep working and every graph route answers 503 `conversation-graph-off`; switched back on, the arrangement is intact; after revoking the phone, 18 of 18 signed requests were refused.
- Real Studio + M5 pair, 200 efforts, M5 stopped for real (release head 2ef62f2048): removal finished cleanly in about 11 minutes with history intact. For 15 minutes after, the longest server pause was 3.3 s and 11 of 11 changes saved in 9 to 21 s with no timeouts.
- Earlier real-pair results: 40-change removal after a forced restart finished in 302 s with history intact; real-browser removal at phone size 45 s.
- Full suites on the M5 at 969c81f2b0: integration 6,883 passed, 0 failed. Unit: 48 desktop-host tests fail on the M5 only, and fail the same way on main there. E2E: see the pull request.

## Known limits

- Joining a machine to an existing graph is not built yet; members are chosen when the graph is created.
- History reads for a Slack conversation held on another machine use the same peer credential as other pool reads.
- The end of a removal at about 200 records still pauses the removing machine's server for about 25 s; well inside the 60 s lease.
- Confirming a removal while the other machine is in fact alive but cut off can still remove it; the warning screen says to remove only a machine that is gone for good.
