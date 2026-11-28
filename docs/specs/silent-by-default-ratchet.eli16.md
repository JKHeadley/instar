# Keeping new notifications quiet by default (ELI16)

The agent has many parts that can send you a message. The rule is that a new part starts out quiet: its messages go into a feed you can read, and only reach your phone if someone decides they should. But nothing actually checked a new part when it was built, so a loud one could slip through if a reviewer missed it.

Now there is a short, reviewed list of every kind of message that reaches you by default, each with a reason: a disk running out of space, an answer to something you asked, a decision only you can make, and so on. A test reads the code, works out what is loud today, and compares it with the list. If a change makes something new loud, the test fails until the list is updated in that same change, so a person has to look at it and agree. Quiet new parts pass with no extra work.
