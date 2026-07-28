# The tool that hands you things to approve was dropping them

## What happened

When your agent needs your approval on a design, there is one sanctioned way to send it to
you. It renders the plain-English summary as a web page, checks the link actually loads,
and messages it to you. A safety hook *blocks* the agent from sending an approval request
any other way — so this one tool is the only door.

That tool sent the message by running a small script, and it looked for that script in
whatever folder it happened to be running from. But agents are required to do their work
in a separate checkout folder, and that folder does not contain the script. So the send
failed with "file not found."

Then the tool printed: **"published — verified and delivered."**

Both lines, one after the other, in the same output. You received nothing. The agent was
told you had received it.

## Why this one is worse than it sounds

Everything else in that tool is careful. It refuses to send a broken link. It refuses if
the summary is missing or too short. It checks the page returns a real response before
handing it over.

And then it didn't check whether the message was sent.

An approval request that vanishes doesn't look like an error to anybody. To you, nothing
arrives — and nothing arriving is indistinguishable from the agent simply not asking yet.
To the agent, it's done. So a design can sit "waiting for the operator" indefinitely while
the operator was never actually asked.

## How long it was there

This exact problem was written down as a known bug **three separate times** — the 13th of
July, the 27th of July, and again today — by different investigations that each found it
fresh. Fifteen days. Nobody fixed it, because each time it was recorded as something to do
later rather than done.

It is fixed now.

## What changed

Two things, both small:

- The tool now searches upward from wherever it is until it finds the script, so it works
  from a working folder, from the agent's home, and from the older layout some installs
  still use.
- It only says "delivered" if the messaging script actually confirms it sent something. If
  it can't confirm, it says **not delivered**, prints the message so the request isn't
  lost, and exits with an error.

The second part is the real fix. The first part just removes today's cause; the second
means the next cause — whatever it is — announces itself instead of hiding.

## What you'll notice

Nothing, when it works. When it doesn't work you'll notice that your agent now says so,
rather than both of you believing a message arrived that never did.
