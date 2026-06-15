# Peer "I can receive" advert was getting dropped — ELI16

## What broke?

Your agent can run on two machines at once — say a laptop and a Mac mini. They're meant to
share what they learn: write a learning on the laptop, and the mini should know it too. That's
"state sync."

But it never worked across machines. A learning written on the laptop never reached the mini.

## Why?

Before one machine sends a learning to another, it checks: "Can the other machine actually
RECEIVE and store this?" Each machine advertises a little capability flag that says "yes, I can
receive these 7 kinds of records." That flag is the green light for replication.

The problem: each machine could see its OWN green light, but the OTHER machine's green light was
getting thrown away in transit. So each machine looked at its peer, saw no green light, and
concluded "my peer can't receive this — if I send it, it'll just be dropped." So it refused to
send. Both machines did this to each other. Nothing ever crossed.

## Where exactly was it dropped?

The receiving machine asks its peer "what are you capable of?" and the peer answers with a full
list — including the green light. But the code that UNPACKS that answer was copying over most of
the fields and quietly forgetting the green light. It happened in two spots on the receive path
(one in the network-reply handler, one in the little component that records the peer's status),
and a third spot would have wiped it out 30 seconds later anyway: every 30 seconds each machine
writes a quick "still alive" note about its peers, and that note has no capability info — so it
was overwriting the green light with a blank.

## The fix

Three small changes, all on the receiving side:

1. Pass the green light through when unpacking the peer's answer (don't forget the field).
2. Forward it through the status-recorder component too.
3. Make the quick "still alive" note KEEP the last known green light instead of blanking it.

Plus a guard test that checks EVERY capability field survives the trip — because this exact bug
("forgot to copy one field across the wire") has now happened four times for four different
fields. The test makes the fourth time the last time: if anyone adds a new field and forgets to
pass it through, the test fails loudly.

## How do we know it's fixed?

`GET /pool` on each machine now shows its PEER with the real list of receive-capable record
kinds (instead of an empty 0). And the live proof: write a learning on the laptop, read it on the
mini.
