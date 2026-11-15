# Searching conversations — the plain-English version

## What this is

Justin asked for a search box for conversations in the Instar iPhone app and in the dashboard. He wants
to type a few words and find the messages that contain them, either across every conversation or inside
the one he has open. He also wants a second kind of search later that finds messages by what they mean,
not only by the exact words.

This change builds the server side of the first kind: keyword search. The phone and the dashboard will
call one new address on the agent, give it the words, and get back a list of matching messages. Each
match says which conversation it is in, when it was sent, who sent it, a short piece of the message with
the matching words highlighted, and the exact message id the app needs to jump straight to that spot in
the conversation.

## What already existed

The agent already keeps a searchable index of Telegram messages. App conversations and Slack messages are
kept in their own stores, and the app already reads history from those stores. The rules about who may
see which conversation already exist too: the owner sees everything, a team member only sees what was
shared with them, and Slack is the owner's alone.

## What is new

- One new read: search, with the words, an optional conversation to search inside, and an option to ask
  the agent's other machines as well.
- Telegram is searched through its existing index. App conversations and Slack are searched by reading the
  same recent messages the history screen shows, up to a fixed limit, because those messages are not
  reliably in the index today. If the limit is reached, the answer says some older messages were not
  searched.
- When other machines are asked, a machine that does not answer is named, and the answer says the results
  may be incomplete. The same message held on two machines appears once.
- A switch can turn search off without touching anything else.

## The safeguards in plain terms

Search never shows more than the conversation list would. Every match is checked with the same rule the
list uses, and inside an app conversation each message is checked the way the history screen checks it,
so a team member cannot use search to peek at something they were not given. Asking about a conversation
you cannot see gets the same "not found" answer as one that does not exist. Answers from other machines
are checked again here before they are shown. There are no AI calls, so search costs nothing extra.

## What is left

The meaning-based search comes in the next change, using the same address with a different mode. The
phone and dashboard screens that use this search are built separately.
