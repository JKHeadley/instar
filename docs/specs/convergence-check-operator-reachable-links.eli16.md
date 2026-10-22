# Keeping the links your agent sends you openable — Plain-English Overview

## The problem in one breath

Your agent sent you a link you could not open, and nothing noticed.

## What already exists

Before your agent sends you a message, a script reads it and can refuse to send
— a last check for the obvious ways a message goes wrong. One of its existing
rules looks at any web address in the message and asks "is this a real place, or
did the agent invent a plausible-looking one?" It answers that by keeping a list
of addresses it trusts.

## What this adds

Two changes to that list-checking rule, both aimed at the same thing: you being
able to open what you are sent.

**First, it stops the agent sending you a Claude link.** When Claude publishes a
page, that page belongs to whichever Claude account made it. If your agent sends
you one of those links, you are being asked to sign in to an account you may not
even have, in order to read something your own agent made for you. That is a
link that looks helpful and is useless. From now on the script refuses to send a
message containing one, and tells the agent to serve the page from somewhere you
can actually reach instead.

There is a wrinkle worth knowing: the trusted-addresses list already contained
Claude's own domain, so the existing rule was *waving these through*. It was
never going to catch this on its own. That is why this needed to be its own
separate rule rather than an entry in a list.

**Second, it stops the script blocking a link that genuinely works.** Your agent
can publish a page from its own machine over something called a Tailscale
Funnel, which produces a real public address anyone can open with no sign-in.
The script did not recognise those addresses, so it refused them as suspicious.
Meanwhile, your agent's other way of publishing — a Cloudflare tunnel — was
already trusted. So the script was in the worst possible position: it allowed
the link you could not open and blocked the one you could. Both halves of that
are now corrected.

## Why this is being fixed twice

These two rules were already applied once today, by hand, to one running agent.
About an hour and a half later a routine update replaced that file with the
shipped version, and both rules vanished. Nothing announced it. The protection
you had asked for simply stopped existing, and the only reason it was noticed is
that a working link got refused again.

That is the real lesson, and it is why this change is landing in the source
rather than on one machine. A rule that lives only on one agent's disk is a rule
that survives until the next update.

## The safeguards

- **Nothing is ever deleted.** When a message is refused it goes back to the
  agent with the reason, so it can rewrite and send. Your message is not lost.
- **A test that proves itself.** The accompanying test was checked by deliberately
  removing the fix and confirming the test then fails. A test that passes whether
  or not the fix is present would protect nothing; this one was shown to catch
  the exact regression that happened today.
- **The old guard is not weakened.** Two deliberate "this should still be
  blocked" cases are kept — a made-up address, and a lookalike address designed
  to sneak past the new trust rule. Both must keep failing for the tests to pass.
- **Anthropic's documentation still works.** Only Claude's app domains are
  refused. Links to Anthropic's docs send normally.

## The honest cost

This blocks some reasonable messages. If you send your agent a Claude link and
ask what is on it, its reply cannot quote that address back at you — it has to
describe the destination instead. If the agent is researching Claude itself, it
cannot cite a Claude address as a source. That is a real inconvenience, and the
reason it is judged acceptable is that you asked for this rule in strong terms,
and the cost of the alternative — handing you links you cannot open — is worse.

It also only fixes this one case. A link to a private document somewhere else
that you happen not to have access to would fail in exactly the same way and is
not covered.

## What you actually need to decide

Nothing, to accept it — this restores the instruction you already gave and
repairs a guard that was blocking working links.

The one thing worth your opinion is the cost above: if being unable to quote a
Claude link back to you turns out to be annoying in practice, say so and the rule
can be narrowed to artifact and chat pages only, rather than the whole domain.
