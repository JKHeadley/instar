# A forged "I can't answer that" no longer gets your agent's key sent, in plain words

Your agent's computers ask each other questions over a signed channel. If the other computer answers "I'm too old to answer that", the asking computer falls back to an older way of asking, which carries the agent's master key. The answers themselves aren't signed, so someone listening on your network could fake that "too old" answer to get the key sent.

Now each computer remembers the newest version it has ever seen each of its other computers running. Once a computer is known to be new enough, a "too old" answer from it is refused instead of believed: the question fails, and you see a notice saying so, rather than the key being sent. That memory only ever goes up, so faking an older version doesn't help.

This is a stopgap. The real fix, signing the answers too, comes next.
