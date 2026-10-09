# An acknowledgement is never acknowledged (ELI16)

## What this is

When one agent sends another a message over the shared relay, the receiving
agent automatically sends back a short note: "Message received. Composing
response..." It is a receipt, like the "delivered" tick in a chat app.

The bug: that receipt went out looking exactly like a normal message. So the
agent that got the receipt sent a receipt for the receipt. Then the first agent
sent a receipt for that one. This went back and forth about five times each way
for every single message, until a safety limit (five receipts a minute per
sender) cut it off.

There was a second problem. If we started the conversation, the other agent's
receipt was the first thing to arrive on it. Our agent treats the first message
in a conversation as "someone is reaching out, answer them". So it started a
whole new working session just to answer a receipt.

## What already exists

- The receipt itself, and the limit of five per minute.
- A check that decides whether an incoming message deserves a reply at all. It
  treats the first message in a conversation as worth answering.
- A list of every message id an agent has accepted, with a note of what
  happened to each one.

## What changes

1. A receipt now carries a label saying it is a receipt. When an agent gets a
   message with that label, it does one thing: it notes that its own earlier
   message arrived. Then it stops. It sends nothing back, shows it to no
   session, and starts no session.
2. Older agents do not send the label yet. Their receipt is still recognised,
   but only when the whole message is exactly that one fixed sentence, word for
   word. A real message that merely begins with "Message received." is handled
   as a real message.
3. The two other ways a message can arrive get the same rule.

The "does this deserve a reply?" check itself is not changed. A receipt never
reaches it any more, so it can no longer mistake one for someone reaching out.
A real first reply from the other agent, even a very short one like "lgtm", is
still answered and still shown where the conversation was started.

The limit of five receipts a minute stays, as protection against a flood of
real messages.

## Safeguards

- An older agent that receives the new labelled receipt treats it exactly as it
  treated the old one. Nothing is dropped and nothing breaks.
- Every receipt that is set aside still leaves a trace: a log line and a row in
  the message-id list marked "no reply needed".
- Only a labelled receipt, or a message that is exactly the fixed receipt
  sentence, is set aside. Nothing is decided by guessing what a message means.

## What you need to decide

Nothing. This is a bug fix to behaviour that is always on, so it ships without
an on/off switch; a switch would leave the loop running everywhere it was off.
To undo it, the change is reverted and released.
