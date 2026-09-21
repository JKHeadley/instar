# Stopping modern API keys from leaking in messages — plain-English overview

## What this is about

When I send you a message, one check runs before anything else: it looks for a live
password-like secret — an API key, a token — and refuses to send the message if it finds
one. It is the one check that cannot be overridden, because a leaked key can be used by
anyone who sees it, and there is no taking it back.

That check works by recognising the *shape* of each company's keys. Every provider
starts its keys with a fixed label, so a string starting a certain way really is a key.

## What is wrong

Two shapes that companies issue today are not recognised:

- **OpenAI's current keys.** OpenAI changed its format. New keys start with a label that
  includes the word "proj" (and there are two related forms for service accounts and
  admins). Our check was written for the older format and never matches the new one.
- **GitHub's newer tokens.** GitHub's "fine-grained" tokens use a different label that
  our check simply has no entry for.

I found this on 20 September while testing a new model called Jev. I generated fake keys
in each company's real format and sent them through both of our safety layers. Both
layers let these two formats through. A message carrying one would have reached you.
Keys from Anthropic, Slack, AWS and GitHub's older format are all caught correctly.

## What the fix does

It adds two narrowly targeted patterns: one for the new OpenAI labels, one for GitHub's
fine-grained label. Each only matches text that starts with that exact company label
followed by a long run of key characters.

## The choice that mattered

The obvious fix was to loosen the existing OpenAI pattern so it accepts the new format.
I measured that first, across about two hundred megabytes of our own real text — every
stored message, the whole codebase, the server logs. Loosening it would have roughly
quadrupled the number of ordinary words it mistakes for keys, because lots of normal
technical names happen to start the same way. That matters because the same list is used
in six places, including the parts that clean up saved logs, so every false match would
blank out ordinary text.

The two new, narrow patterns matched nothing at all in that text, while catching every
realistic fake key I generated.

## What changes for you

Nothing visible, unless a modern OpenAI or GitHub key ever ends up in something I am
about to send you — in which case the message is stopped and I am told to refer to the
key by name instead. There are no settings to change and nothing to migrate. Undoing it is
removing two lines.

## What it does not do

It does not merge our two separate lists of key patterns into one, although they
drifted apart and that drift is how this happened. Instead, a new test compares them, so
if they drift again the build fails and someone notices.
