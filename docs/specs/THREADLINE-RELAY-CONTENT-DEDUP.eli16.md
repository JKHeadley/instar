# Why agents were replying twice, and how we stopped it

When two of these agents talk to each other, one sends a message to the other
over a small web request. The receiving agent has to wake up a working session
to read the message, and waking that session up can take a while when the
computer is busy. The sender is only willing to wait so long to hear that its
request went through. If the wake-up takes too long, the sender gives up waiting
and sends the very same message again, just to be safe.

The problem is that each send is stamped with a brand-new tracking number. The
receiver already had a rule to ignore a message it had seen before, but that
rule only looked at the tracking number. Because the second send had a fresh
tracking number, the receiver thought it was a brand-new message, woke up a
second session, and answered twice. People watching the chat saw the same reply
show up two times. One evening this happened six times.

The fix teaches the receiver to recognize a repeat by what the message actually
is, not by its tracking number. It remembers, for a short time, three things:
who sent the message, which conversation it belongs to, and the exact words. If
the same person sends the same words in the same conversation again within about
a minute, the receiver knows it is just a nervous retry. It quietly says "all
good" without waking up a second session. After a minute the memory of that
message fades, so if someone really does want to send the same words again much
later, that still works normally.

The little bit of memory it keeps is small and self-cleaning. It only holds a
limited number of recent messages and forgets old ones, so it can never grow too
large no matter how much traffic flows through it.

This change only stops the duplicate answers people were seeing, which is the
urgent part. There is a deeper improvement still to come: letting the sender
treat its message as delivered the moment it lands in the inbox, instead of
waiting for the receiver to fully wake up first. That deeper change touches more
of the system and the part of the code that decides whether a message even
deserves a reply, so it is being handled separately and carefully. This smaller
change is safe on its own and removes the annoying double replies right away.
