# Searching conversations — the plain-English version

## What this is

Justin asked for a search box for conversations in the Instar iPhone app and in the dashboard. He wants
to type a few words and find the messages that contain them, either across every conversation or inside
the one he has open. He also wants a second kind of search that finds messages by what they mean, not
only by the exact words.

The first change built the server side of the first kind, keyword search; the second change, described further down, adds search by meaning. The phone and the dashboard will
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

## The second half: search by meaning

The keyword search only finds a message that uses the words you typed. The second half finds messages
that mean the same thing in other words. Ask for "rocket launch" and it also finds "the spaceship
liftoff happened at dawn". The phone asks the same address with one extra setting, and gets the same
kind of list back, best match first.

How it works, plainly. Each machine runs a small language model locally, on the machine itself. The
agent already loads this model when it starts, for its own memory, so nothing new is downloaded and no
outside AI service is called. In the background the agent reads each message once and turns it into a
list of numbers that captures what the message is about. Those numbers go into a small file on that
machine. When you search, your words are turned into numbers the same way, and the agent finds the
messages whose numbers are closest. Very short messages, like "ok thanks", are skipped. The file holds
only those numbers, never the message text: every result is read again from the real conversation, so
it shows the current text, and a message that was removed simply stops showing up.

Older messages take a while to learn. The agent works through them newest first, a few dozen at a
time, and stops whenever the machine is busy, so it never slows the agent down. On the main Mac it
costs about one twentieth of one processor core while it catches up, and nothing once it is done. Each
answer says how far along it is, so the phone can say "still learning older messages".

The same safeguards apply. Meaning search looks only inside the conversations you can see, checked
the same way as the list, before it ranks anything, so a team member cannot reach a conversation they
were not given. If the model or the file is not available, the answer says so and the phone falls back
to searching by words. A switch turns meaning search off on its own without touching keyword search.

Each machine learns the messages it holds. When the phone asks every machine, the answers are merged,
and a machine that did not answer is named.

## What is left

The phone and dashboard screens that use both kinds of search are built separately.
