# Salience-gating agent chatter — explained simply

## The everyday version

Say you ask your assistant to get a quote, and behind the scenes it texts a coworker to get a number.
The coworker sends back a few messages: "on it", "checking", "ok here's the number: $40." You only
care about the last one. But imagine your phone buzzed you for ALL of them, in your own chat thread,
every time. That's annoying — most of it is just the two of them talking, not something you need.

That's what was happening with Instar agents. When one agent talks to another to answer your request,
each reply could pop up as a separate notification in your chat topic — even the low-value "on it"
chatter. There IS a smart filter that labels each reply "worth showing you" or "just agent
back-and-forth"... but a logic bug meant that label was being **ignored**. Every reply to a topic
where you weren't actively chatting got posted anyway.

## What we changed

We made the filter's label actually count. Now:
- If a reply is genuinely **important** (the answer you're waiting for) → it still shows up in your
  topic.
- If it's **low-value chatter** and you're not actively in that chat → it stays quiet. It's not
  lost — it's kept in the browsable Threadline record (the dashboard's Threadline tab), so you can
  look there anytime; it just doesn't ping your topic.
- If something genuinely **failed to deliver** → you ALWAYS get told, no matter what, so a real
  reply is never silently dropped.

## Why it's safe

The reply is always written into the browsable Threadline record the moment it arrives, so "stay
quiet" never means "lost" — it just means "don't buzz your topic; it's there in the Threadline tab
when you look." And the very first reply on a new request still shows up even if the filter can't
make up its mind, so you never miss the start of an answer. We changed only the one case that was the spam — a low-value reply to a chat you'd stepped
away from — and left every other case exactly as it was. We proved it with tests covering all three
outcomes: low-value → quiet, important → shown, failed-delivery → always shown.
