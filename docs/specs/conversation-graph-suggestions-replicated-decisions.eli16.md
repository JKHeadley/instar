# Suggestions: your decisions reach every machine (plain overview)

## What this is

On the Conversations page the agent suggests groups: "these four chats look like the same piece of work, want to group them?" You can Accept (the group gets made and the chats move into it) or Reject (the suggestion goes away and should never come back).

Today the agent remembers your Reject and Accept only on the one computer that showed you the page. Your agent often runs on more than one computer, and the page can be served by any of them. So if you reject a suggestion on the Studio and later the page is served by the other computer, that computer has never heard of your Reject and can offer the same group again. Worse, if you start an Accept on one computer and press Continue on the other, the second computer does not know about the first try and can make a second, empty group.

## What already exists

The agent already has a way to copy small records between its own computers: every computer writes its records into its own journal, and the other computers read those journals. The Work Board and the trust settings already use it. Nothing new has to be built to carry the data.

## What changes

1. Your three decisions (rejected, accepted, and "an Accept has started, here is its request number") become small records on that existing journal. Each record holds only the suggestion's id (a scrambled fingerprint of which chats were in it), the decision, the time, and for a started Accept the request number. No chat names or content.
2. When any computer shows you suggestions, it combines its own memory with every record from the other computers. A Reject anywhere hides the suggestion everywhere and keeps the agent from suggesting it again. A started Accept anywhere means Continue uses the same request number, so the same group is continued, not a new one.
3. The list of suggestions itself stays on each computer. It is advice the agent can rebuild, and keeping it local means chat names never travel just for this.
4. Decisions you made before this update are sent across once after the update, so old Rejects are honored too.

## Safeguards

- The records only hide advice. They never move, hide or send a conversation, and they never stop you from doing anything.
- If a record fails to send, your action still works on the computer you used, the failure is logged, and the agent tries again later.
- With only one computer, nothing changes at all.
- An older computer that has not updated yet will ignore these records and behave like today until it updates.
- If two computers start the very same Accept within a few seconds of each other, one extra empty group can be made. That is rare and harmless, and preventing it would need a lock across computers for something that is only a suggestion.
- There is an off switch, and turning it off or rolling back the update leaves everything as it is today; no data has to be repaired.

## What needs deciding

Whether this design is right: decisions replicate, the suggestion list stays local, and the feature is on automatically wherever the agent already shares records between its computers (with an off switch), because it only carries your own choices and restricts nothing. Approving it lets the build go ahead and closes the open promise CMT-1650.
