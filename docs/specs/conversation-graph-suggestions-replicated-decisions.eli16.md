# Suggestions: your decisions reach every machine (plain overview)

## What this is

On the Conversations page the agent suggests groups: "these four chats look like the same piece of work, want to group them?" You can Accept (the group gets made and the chats move into it) or Reject (the suggestion goes away and should never come back).

Today the agent remembers your Reject and Accept only on the one computer that showed you the page. Your agent often runs on more than one computer, and the page can be served by any of them. So if you reject a suggestion on the Studio and later the page is served by the other computer, that computer has never heard of your Reject and can offer the same group again. Worse, if you start an Accept on one computer and press Continue on the other, the second computer does not know about the first try and can make a second, empty group.

## What already exists

The agent already has a way to copy small records between its own computers: every computer writes its records into its own journal, and the other computers read those journals. The Work Board and the trust settings already use it. Nothing new has to be built to carry the data.

## What changes

1. Your three decisions (rejected, accepted, and "an Accept has started") become small records on that existing journal. A record holds the suggestion's id (a scrambled fingerprint of which chats were in it), the decision and the time. A started Accept also carries the suggested group's name and which chats are in it (their ids, never their names or messages), because another computer may never have built that exact suggestion and needs it to finish the job. A finished Accept can carry what it did (which group, how many chats moved).
2. When any computer shows you suggestions, it combines its own memory with every record from the other computers. A Reject anywhere hides the suggestion everywhere and keeps the agent from suggesting it again. A started Accept anywhere shows Continue everywhere, and its chats are kept out of new suggestions until it is done.
3. Each Accept now has one request number worked out from the suggestion itself, so every browser and every computer asks for the same group and gets the same group. This alone stops the "second empty group" problem, even before any record travels.
4. The list of suggestions itself stays on each computer, as you already approved on 2026-11-11. It is advice each computer rebuilds from the same shared conversations; what matters to you (what you rejected, accepted or started) is the part that now travels.
5. Decisions you made before this update are sent across once after the update, so old Rejects are honored too.

## Safeguards

- The records only hide advice. They never move, hide or send a conversation, and they never stop you from doing anything.
- Every record is checked on arrival: a started Accept's chat list must match its fingerprint, and its request number must be the one worked out from that suggestion, so a bad record cannot steer your Continue into a different group.
- If a record fails to send, your action still works on the computer you used. The record waits in a small outbox and is sent again with your next decision, every ten minutes while it waits, and when the agent restarts.
- With only one computer, nothing travels; you still get the single request number.
- An older computer that has not updated yet will ignore these records and behave like today until it updates.
- A started Accept you no longer want ends when you tap Reject on it.
- There is an off switch. Turning it off, or rolling back the update, returns each computer to how it works today; each computer's own memory was never mixed with the others', so nothing has to be repaired.

## What needs deciding

Whether this design is right: decisions replicate, the suggestion list stays local, and the feature is on automatically wherever the agent already shares records between its computers (with an off switch), because it only carries your own choices and restricts nothing. Approving it lets the build go ahead and closes the open promise CMT-1650.
