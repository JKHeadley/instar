# A timestamp that was always "now"

## What was wrong

The iMessage adapter reports a small status object: what state the connection is in, when it
connected, whether there were errors. The "when it connected" value was computed at the moment you
asked for it — literally "if we're running, the time is now".

So it never reported when the connection was established. It reported when you looked. Ask three
times over an hour, get three different connection times, none of them true.

## Why that is worse than leaving it blank

An absent value is honest: you know you don't know. A fabricated timestamp is worse in a specific
way — it looks *more* precise than everything around it.

A state like "connected" is obviously a coarse summary. A timestamp down to the millisecond invites
arithmetic: how long has this been up, is it stale, did it reconnect recently. Every one of those
calculations would have produced a confident, specific, wrong answer. And nothing about the value
would have hinted that it was made up.

## How it was found

While adding iMessage to the page that reports which channels are working. The honest choice there
was to build the verdict on the connection state and deliberately *not* on this field, with a test
that fails if anyone wires it in.

That would have left a permanent note saying "don't trust that one" beside a field that stays broken.
Fixing the field is better than routing around it forever.

## What changed

The instant is now recorded once, at the moment the connection is actually established, and cleared
when the adapter stops. An adapter that never connected reports no time at all, which is the correct
answer rather than a placeholder.

The clearing matters as much as the recording: without it, a stopped adapter would keep reporting the
time it last connected, which is the same false precision pointing the other way.
